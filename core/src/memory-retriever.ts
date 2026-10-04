import type {
  CharacterId,Clock,DiagnosticsStore,MemoryBroker,MemoryItem,MemoryRetrievalCandidate,MemoryRetrievalQuery,MemoryRetrievalResult,MemoryRetriever
} from "../../contracts/src/index";

const DEFAULT_LIMIT=8;
const MAX_LIMIT=100;

function normalize(value:string):string{
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu," ").trim().replace(/\s+/g," ");
}
function tokens(value:string):string[]{return normalize(value).split(" ").filter(Boolean)}
function related(a:string,b:string):boolean{
  if(a===b)return true;
  if(a.length<4||b.length<4)return false;
  return a.startsWith(b)||b.startsWith(a);
}
function bigrams(values:readonly string[]):string[]{
  const result:string[]=[];
  for(let i=0;i+1<values.length;i++)result.push(values[i]+" "+values[i+1]);
  return result;
}
function overlap(queryTokens:readonly string[],itemTokens:readonly string[]):number{
  if(queryTokens.length===0)return 0;
  let matched=0;
  for(const queryToken of queryTokens)if(itemTokens.some(itemToken=>related(queryToken,itemToken)))matched++;
  return matched/queryTokens.length;
}
function phraseOverlap(queryTokens:readonly string[],itemTokens:readonly string[]):number{
  const queryPhrases=bigrams(queryTokens);
  if(queryPhrases.length===0)return 0;
  const itemPhrases=bigrams(itemTokens);
  const matched=queryPhrases.filter(phrase=>itemPhrases.includes(phrase)).length;
  return matched/queryPhrases.length;
}
function tagOverlap(queryTokens:readonly string[],tags:readonly string[]):number{
  if(queryTokens.length===0||tags.length===0)return 0;
  const tagTokens=tags.flatMap(tokens);
  return overlap(queryTokens,tagTokens);
}
function validNow(item:MemoryItem,now:number):boolean{
  if(item.validFrom!==null&&Date.parse(item.validFrom)>now)return false;
  if(item.validUntil!==null&&Date.parse(item.validUntil)<=now)return false;
  return true;
}
function score(item:MemoryItem,queryTokens:readonly string[]):MemoryRetrievalCandidate{
  const lexical=overlap(queryTokens,tokens(item.content));
  const phrase=phraseOverlap(queryTokens,tokens(item.content));
  const tags=tagOverlap(queryTokens,item.tags);
  const total=Math.round(lexical*60+phrase*15+tags*10+item.importance*0.1+item.confidence*0.05);
  return {
    memoryId:item.id,
    score:total,
    lexicalRelevance:Math.round(lexical*100),
    phraseRelevance:Math.round(phrase*100),
    tagRelevance:Math.round(tags*100)
  };
}
function compare(
  a:MemoryRetrievalCandidate & {item:MemoryItem},
  b:MemoryRetrievalCandidate & {item:MemoryItem}
):number{
  return b.score-a.score
    ||b.lexicalRelevance-a.lexicalRelevance
    ||b.phraseRelevance-a.phraseRelevance
    ||b.tagRelevance-a.tagRelevance
    ||b.item.importance-a.item.importance
    ||b.item.confidence-a.item.confidence
    ||b.item.updatedAt.localeCompare(a.item.updatedAt)
    ||a.item.id.localeCompare(b.item.id);
}

export interface InProcessMemoryRetrieverOptions{
  clock?:Clock;
  diagnostics?:DiagnosticsStore;
  source?:string;
}

export class InProcessMemoryRetriever implements MemoryRetriever{
  private readonly clock:Clock;
  private readonly diagnostics?:DiagnosticsStore;
  private readonly source:string;

  constructor(private readonly broker:Pick<MemoryBroker,"list">,options:InProcessMemoryRetrieverOptions={}){
    this.clock=options.clock??{now:()=>new Date().toISOString()};
    this.diagnostics=options.diagnostics;
    this.source=options.source??"memory-retriever";
  }

  async search(query:MemoryRetrievalQuery):Promise<MemoryRetrievalResult>{
    const started=Date.now();
    const characterId=query.characterId.trim();
    const normalizedQuery=normalize(query.query);
    if(!characterId)throw new Error("Memory search characterId must not be empty.");
    if(query.query.length>256)throw new Error("Memory search query exceeds the v3 input limit.");
    const limit=Math.min(Math.max(1,query.limit??DEFAULT_LIMIT),MAX_LIMIT);
    this.diagnostics?.recordError(this.source,"MEMORY_SEARCH_STARTED","Memory search started",{characterId,queryLength:query.query.length});
    try{
      const items=await this.broker.list(characterId);
      const typeSet=new Set(query.types??[]);
      const requiredTags=(query.tags??[]).map(tag=>normalize(tag)).filter(Boolean);
      const now=Date.parse(this.clock.now());
      const current=Number.isFinite(now)?now:Date.now();
      const ranked=items
        .filter(item=>item.characterId===characterId)
        .filter(item=>item.status===(query.status??"active"))
        .filter(item=>validNow(item,current))
        .filter(item=>typeSet.size===0||typeSet.has(item.type))
        .filter(item=>requiredTags.every(tag=>item.tags.some(itemTag=>normalize(itemTag)===tag)))
        .filter(item=>!query.originConversationId||item.originConversationId===query.originConversationId)
        .map(item=>({...score(item,normalizedQuery.split(" ").filter(Boolean)),item}))
        .filter(candidate=>normalizedQuery.length===0 || candidate.lexicalRelevance>0 || candidate.phraseRelevance>0 || candidate.tagRelevance>0)
        .sort(compare)
        .slice(0,limit);
      this.diagnostics?.recordError(this.source,"MEMORY_CANDIDATES_FOUND","Memory candidates found",{characterId,count:ranked.length,durationMs:Date.now()-started});
      return {characterId,query:query.query,candidates:ranked.map(({item,...candidate})=>candidate)};
    }catch(error){
      const message=error instanceof Error?error.message:"Memory search failed.";
      this.diagnostics?.recordError(this.source,"MEMORY_RETRIEVAL_FAILED","Memory retrieval failure",{characterId,error:message,durationMs:Date.now()-started});
      throw error;
    }
  }
}
