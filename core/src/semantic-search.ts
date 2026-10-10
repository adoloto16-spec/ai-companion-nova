import type {
  AppSettings,CharacterId,ChatMessage,Conversation,CoreBookEntry,DiagnosticsStore,EmbeddingProvider,EventBus,
  EventPayloadMap,MemoryBroker,MemoryItem,MemorySemanticIndexState,MemorySemanticIndexStore,MemorySemanticVectorRecord
} from "../../contracts/src/index";
import {MEMORY_SEMANTIC_INDEX_API_VERSION,MEMORY_SEMANTIC_INDEX_SCHEMA_VERSION} from "../../contracts/src/index";
import {cosineSimilarity,deterministicContentHash} from "./semantic-memory-dedup";
import {SEMANTIC_SEARCH_RECORD_PREFIX,withMemorySemanticIndexLock} from "./semantic-index-lock";

export type SemanticSearchSource="core_book"|"memory"|"conversation";
export interface SemanticSearchDocument{
  id:string; characterId:CharacterId; source:SemanticSearchSource; sourceId:string;
  conversationId?:string; title:string; content:string; tags:readonly string[]; status?:string; type?:string;
  role?:"user"|"assistant"; updatedAt:string;
}
export interface SemanticSearchHit extends SemanticSearchDocument{similarity:number}
export interface SemanticEmbeddingConfiguration{provider:EmbeddingProvider;model:string}
export interface SemanticSearchStatus{
  status:"idle"|"indexing"|"ready"|"degraded"|"unconfigured";
  model:string; processed:number; total:number; pending:number; failed:number; updatedAt:string;
}
export interface SemanticSearchRequest{characterId:CharacterId;query:string;limit?:number;threshold?:number}
export interface SemanticSearchOptions{
  settings:()=>AppSettings; indexStore:MemorySemanticIndexStore;
  embeddingConfiguration:()=>Promise<SemanticEmbeddingConfiguration|undefined>;
  listCharacterIds:()=>Promise<readonly CharacterId[]>;
  coreBook:{listCoreBookEntries(characterId:CharacterId):Promise<readonly CoreBookEntry[]>};
  memory:Pick<MemoryBroker,"list">;
  conversations:{listConversations(characterId:CharacterId):Promise<readonly Conversation[]>};
  events:EventBus; diagnostics?:DiagnosticsStore; clock?:{now():string};
}
const MAX_EMBEDDING_CHARS=2400, EMBEDDING_OVERLAP_CHARS=120, EMBEDDING_BATCH_SIZE=32, DOCUMENT_BATCH_SIZE=16, MAX_RESULTS=20;
const DEFAULT_COSINE_THRESHOLD=0.35, MAX_QUERY_INPUT_CHARS=48_000;
function emptyIndex(characterId:CharacterId):MemorySemanticIndexState{return{apiVersion:MEMORY_SEMANTIC_INDEX_API_VERSION,schemaVersion:MEMORY_SEMANTIC_INDEX_SCHEMA_VERSION,characterId,records:[]}}
function isVector(value:unknown):value is readonly number[]{return Array.isArray(value)&&value.length>0&&value.every(item=>typeof item==="number"&&Number.isFinite(item))}
function validCurrentMemory(memory:MemoryItem,now:number):boolean{
  if(memory.status!=="active"||!memory.content.trim())return false;
  if(memory.validFrom){const from=Date.parse(memory.validFrom);if(Number.isFinite(from)&&from>now)return false}
  if(memory.validUntil){const until=Date.parse(memory.validUntil);if(Number.isFinite(until)&&until<=now)return false}
  return true;
}
function stableKey(value:string):string{return deterministicContentHash(value)}
function recordId(document:SemanticSearchDocument):string{
  return SEMANTIC_SEARCH_RECORD_PREFIX+document.source+":"+stableKey([document.characterId,document.source,document.conversationId??"",document.sourceId].join("\u0000"));
}
function embeddingText(document:SemanticSearchDocument):string{return document.content}
function chunkLongInput(text:string):string[]{
  // No tokenizer is bundled with this OpenAI-compatible provider. Conservatively chunk at 2,400 Unicode
  // code points with overlap for embedding only; canonical full document text is never truncated.
  const chars=Array.from(text);
  if(chars.length<=MAX_EMBEDDING_CHARS)return [text];
  const result:string[]=[],step=MAX_EMBEDDING_CHARS-EMBEDDING_OVERLAP_CHARS;
  for(let offset=0;offset<chars.length;offset+=step){
    const chunk=chars.slice(offset,offset+MAX_EMBEDDING_CHARS).join("");
    if(chunk.trim())result.push(chunk);
    if(offset+MAX_EMBEDDING_CHARS>=chars.length)break;
  }
  return result;
}
function averageVectors(vectors:readonly (readonly number[])[]):number[]{
  if(vectors.length===0||!isVector(vectors[0]))throw new Error("Embedding provider returned no usable vectors.");
  const dimensions=vectors[0]!.length;
  if(vectors.some(vector=>!isVector(vector)||vector.length!==dimensions))throw new Error("Embedding provider returned inconsistent vector dimensions.");
  const result=Array.from({length:dimensions},()=>0);
  for(const vector of vectors)for(let i=0;i<dimensions;i++)result[i]!+=vector[i]!;
  for(let i=0;i<dimensions;i++)result[i]!/=vectors.length;
  const norm=Math.sqrt(result.reduce((sum,value)=>sum+value*value,0));
  if(!Number.isFinite(norm)||norm<=0)throw new Error("Embedding provider returned a zero vector.");
  return result.map(value=>value/norm);
}
async function embedBatchWithRecovery(provider:EmbeddingProvider,texts:readonly string[],singleRetries=2):Promise<number[][]>{
  try{
    const vectors=await provider.embed([...texts]);
    if(vectors.length!==texts.length||vectors.some(vector=>!isVector(vector)))throw new Error("Invalid embedding batch.");
    const dimensions=vectors[0]?.length??0;
    if(dimensions<=0||vectors.some(vector=>vector.length!==dimensions))throw new Error("Inconsistent embedding dimensions.");
    return vectors.map(vector=>[...vector]);
  }catch(error){
    if(texts.length>1){
      const middle=Math.floor(texts.length/2);
      return [...await embedBatchWithRecovery(provider,texts.slice(0,middle),singleRetries),...await embedBatchWithRecovery(provider,texts.slice(middle),singleRetries)];
    }
    if(singleRetries>0)return embedBatchWithRecovery(provider,texts,singleRetries-1);
    throw error;
  }
}
async function embedBatchTolerant(provider:EmbeddingProvider,texts:readonly string[],singleRetries=2):Promise<readonly (readonly number[]|undefined)[]>{
  if(texts.length===0)return [];
  try{
    const vectors=await provider.embed([...texts]);
    const dimensions=vectors[0]?.length??0;
    if(vectors.length!==texts.length||dimensions<=0||vectors.some(vector=>!isVector(vector)||vector.length!==dimensions)){
      throw new Error("Embedding provider returned an invalid batch.");
    }
    return vectors;
  }catch{
    if(texts.length>1){
      const middle=Math.floor(texts.length/2);
      const left=await embedBatchTolerant(provider,texts.slice(0,middle),singleRetries);
      const right=await embedBatchTolerant(provider,texts.slice(middle),singleRetries);
      return [...left,...right];
    }
    for(let attempt=0;attempt<singleRetries;attempt++){
      try{
        const vectors=await provider.embed([texts[0]!]);
        if(vectors.length===1&&isVector(vectors[0]))return [vectors[0]!];
      }catch{/* bounded retry; diagnostics record the failed canonical document, never its content */}
    }
    return [undefined];
  }
}
async function embedCompleteText(provider:EmbeddingProvider,text:string):Promise<number[]>{
  const chunks=chunkLongInput(text),vectors:number[][]=[];
  for(let offset=0;offset<chunks.length;offset+=EMBEDDING_BATCH_SIZE){
    vectors.push(...await embedBatchWithRecovery(provider,chunks.slice(offset,offset+EMBEDDING_BATCH_SIZE)));
  }
  return averageVectors(vectors);
}
function isActiveDocument(record:MemorySemanticVectorRecord,document:SemanticSearchDocument,provider:EmbeddingProvider,model:string):boolean{
  return record.characterId===document.characterId&&record.contentHash===deterministicContentHash(embeddingText(document))
    &&record.embeddingProviderId===provider.id&&record.embeddingModel===model
    &&isVector(record.vector)&&record.dimensions===record.vector.length;
}
function timeValue(value:string):number{const parsed=Date.parse(value);return Number.isFinite(parsed)?parsed:0}
function errorCode(_error:unknown):string{return "embedding_request_failed"}

export class SemanticSearchService{
  private readonly unsubs:Array<()=>void>=[];
  private readonly characterQueues=new Map<CharacterId,Promise<void>>();
  private rebuildPromise:Promise<void>|undefined;
  private started=false;
  private statusValue:SemanticSearchStatus={status:"idle",model:"unconfigured",processed:0,total:0,pending:0,failed:0,updatedAt:""};
  constructor(private readonly options:SemanticSearchOptions){}
  getStatus():SemanticSearchStatus{return{...this.statusValue}}
  start():void{
    if(this.started)return;
    this.started=true;
    const {events}=this.options,refresh=(characterId:string)=>this.enqueueRefresh(characterId);
    this.unsubs.push(
      events.subscribe<EventPayloadMap["CoreBookEntryCreated"]>("CoreBookEntryCreated",event=>refresh(event.payload.characterId)),
      events.subscribe<EventPayloadMap["CoreBookEntryUpdated"]>("CoreBookEntryUpdated",event=>refresh(event.payload.characterId)),
      events.subscribe<EventPayloadMap["CoreBookEntryDeleted"]>("CoreBookEntryDeleted",event=>refresh(event.payload.characterId)),
      events.subscribe<EventPayloadMap["CoreBookEntryEnabledChanged"]>("CoreBookEntryEnabledChanged",event=>refresh(event.payload.characterId)),
      events.subscribe<EventPayloadMap["MemoryCreated"]>("MemoryCreated",event=>refresh(event.payload.characterId)),
      events.subscribe<EventPayloadMap["MemoryUpdated"]>("MemoryUpdated",event=>refresh(event.payload.characterId)),
      events.subscribe<EventPayloadMap["MemorySuperseded"]>("MemorySuperseded",event=>refresh(event.payload.characterId)),
      events.subscribe<EventPayloadMap["MemoryArchived"]>("MemoryArchived",event=>refresh(event.payload.characterId)),
      events.subscribe<EventPayloadMap["MemoryRestored"]>("MemoryRestored",event=>refresh(event.payload.characterId)),
      events.subscribe<EventPayloadMap["MemoryDeleted"]>("MemoryDeleted",event=>refresh(event.payload.characterId)),
      events.subscribe<EventPayloadMap["ConversationCreated"]>("ConversationCreated",event=>refresh(event.payload.characterId)),
      events.subscribe<EventPayloadMap["ConversationUpdated"]>("ConversationUpdated",event=>refresh(event.payload.characterId)),
      events.subscribe<EventPayloadMap["ConversationDeleted"]>("ConversationDeleted",event=>refresh(event.payload.characterId)),
      events.subscribe<EventPayloadMap["CharacterDeleted"]>("CharacterDeleted",event=>{void this.clearCharacter(event.payload.characterId)})
    );
    // Initial backfill is detached from UI and chat startup; its progress is available in diagnostics.
    void this.rebuildAll().catch(()=>this.record("SEMANTIC_SEARCH_INDEX_FAILED","Initial semantic index backfill failed.",{status:"degraded"}));
  }
  stop():void{for(const unsubscribe of this.unsubs.splice(0))unsubscribe();this.started=false}
  async rebuildAll():Promise<void>{
    if(this.rebuildPromise)return this.rebuildPromise;
    this.rebuildPromise=this.doRebuildAll().finally(()=>{this.rebuildPromise=undefined});
    return this.rebuildPromise;
  }
  async search(request:SemanticSearchRequest):Promise<readonly SemanticSearchHit[]>{
    const query=request.query.trim();
    if(!query||query.length>MAX_QUERY_INPUT_CHARS)return [];
    const settings=this.options.settings().retrieval;
    const threshold=request.threshold??settings.semanticSimilarityThreshold??DEFAULT_COSINE_THRESHOLD;
    const limit=Math.max(1,Math.min(MAX_RESULTS,Math.floor(request.limit??settings.semanticResultLimit??5)));
    if(!Number.isFinite(threshold)||threshold<0||threshold>1)return [];
    const configuration=await this.options.embeddingConfiguration().catch(()=>undefined);
    if(!configuration){
      this.record("SEMANTIC_SEARCH_PROVIDER_UNAVAILABLE","Semantic search is waiting for an embedding preset and model.",{characterId:request.characterId,pending:this.statusValue.pending});
      return [];
    }
    try{
      const documents=await this.collectDocuments(request.characterId);
      const queryVector=await embedCompleteText(configuration.provider,query);
      const state=await this.loadIndex(request.characterId);
      const records=new Map(state.records.filter(record=>record.memoryId.startsWith(SEMANTIC_SEARCH_RECORD_PREFIX)).map(record=>[record.memoryId,record] as const));
      const hits:SemanticSearchHit[]=[];
      for(const document of documents){
        const record=records.get(recordId(document));
        if(!record||!isActiveDocument(record,document,configuration.provider,configuration.model)||record.dimensions!==queryVector.length)continue;
        const similarity=cosineSimilarity(queryVector,record.vector);
        if(similarity!==undefined&&similarity>=threshold)hits.push({...document,similarity});
      }
      const sourcePriority:Record<SemanticSearchSource,number>={core_book:0,memory:1,conversation:2};
      hits.sort((a,b)=>b.similarity-a.similarity||sourcePriority[a.source]-sourcePriority[b.source]||timeValue(b.updatedAt)-timeValue(a.updatedAt)||a.id.localeCompare(b.id));
      return hits.slice(0,limit);
    }catch(error){
      this.record("SEMANTIC_SEARCH_QUERY_FAILED","Semantic search returned no results because vector retrieval failed.",{characterId:request.characterId,errorCode:errorCode(error)});
      return [];
    }
  }
  private async doRebuildAll():Promise<void>{
    const configuration=await this.options.embeddingConfiguration().catch(()=>undefined);
    const characterIds=await this.options.listCharacterIds();
    const all=await Promise.all(characterIds.map(async characterId=>({characterId,documents:await this.collectDocuments(characterId)})));
    const total=all.reduce((sum,entry)=>sum+entry.documents.length,0);
    this.statusValue={status:configuration?"indexing":"unconfigured",model:configuration?configuration.provider.id+":"+configuration.model:"unconfigured",processed:0,total,pending:total,failed:0,updatedAt:this.now()};
    this.reportProgress();
    if(!configuration){
      this.record("SEMANTIC_SEARCH_INDEX_UNCONFIGURED","Semantic index is waiting for an embedding preset and model.",{total,pending:total});
      return;
    }
    for(const entry of all){
      const activeIds=new Set(entry.documents.map(recordId));
      await this.queueCharacter(entry.characterId,async()=>{
        for(let offset=0;offset<entry.documents.length;offset+=DOCUMENT_BATCH_SIZE){
          const batch=entry.documents.slice(offset,offset+DOCUMENT_BATCH_SIZE);
          let failed:readonly SemanticSearchDocument[]=[];
          try{failed=await this.ensureIndexedBatch(batch,configuration)}catch{failed=batch}
          const failedIds=new Set(failed.map(document=>document.id));
          for(const document of batch){
            if(failedIds.has(document.id)){this.statusValue.failed++;this.recordIndexFailure(document,configuration)}
            this.statusValue.processed++;
            this.statusValue.pending=Math.max(0,this.statusValue.total-this.statusValue.processed+this.statusValue.failed);
          }
          this.statusValue.updatedAt=this.now();
          this.reportProgress();
        }
        await this.removeStaleDocuments(entry.characterId,activeIds,configuration);
      });
    }
    this.statusValue.status=this.statusValue.failed===0?"ready":"degraded";
    this.statusValue.pending=this.statusValue.failed;
    this.statusValue.updatedAt=this.now();
    this.reportProgress();
  }
  private enqueueRefresh(characterId:string):void{
    void this.queueCharacter(characterId,async()=>{
      const [configuration,documents]=await Promise.all([this.options.embeddingConfiguration().catch(()=>undefined),this.collectDocuments(characterId)]);
      if(!configuration){
        this.statusValue.status="unconfigured";this.statusValue.total=documents.length;this.statusValue.pending=documents.length;
        this.statusValue.model="unconfigured";this.statusValue.updatedAt=this.now();this.reportProgress();return;
      }
      let failed=0;
      for(let offset=0;offset<documents.length;offset+=DOCUMENT_BATCH_SIZE){
        const batch=documents.slice(offset,offset+DOCUMENT_BATCH_SIZE);
        let failedDocuments:readonly SemanticSearchDocument[]=[];
        try{failedDocuments=await this.ensureIndexedBatch(batch,configuration)}catch{failedDocuments=batch}
        for(const document of failedDocuments){failed++;this.recordIndexFailure(document,configuration)}
      }
      await this.removeStaleDocuments(characterId,new Set(documents.map(recordId)),configuration);
      this.statusValue.status=failed===0?"ready":"degraded";this.statusValue.model=configuration.provider.id+":"+configuration.model;
      this.statusValue.total=documents.length;this.statusValue.processed=documents.length-failed;this.statusValue.failed=failed;
      this.statusValue.pending=failed;this.statusValue.updatedAt=this.now();this.reportProgress();
    }).catch(()=>this.record("SEMANTIC_SEARCH_REFRESH_FAILED","Semantic index refresh failed.",{characterId}));
  }
  private queueCharacter<T>(characterId:CharacterId,operation:()=>Promise<T>):Promise<T>{
    const previous=this.characterQueues.get(characterId)??Promise.resolve();
    const current=previous.catch(()=>{}).then(operation);
    const tail=current.then(()=>undefined,()=>undefined);
    this.characterQueues.set(characterId,tail);
    void tail.then(()=>{if(this.characterQueues.get(characterId)===tail)this.characterQueues.delete(characterId)});
    return current;
  }
  private async collectDocuments(characterId:CharacterId):Promise<SemanticSearchDocument[]>{
    const [entries,memories,conversations]=await Promise.all([
      this.options.coreBook.listCoreBookEntries(characterId),this.options.memory.list(characterId),this.options.conversations.listConversations(characterId)
    ]);
    const documents:SemanticSearchDocument[]=[];
    for(const entry of entries){
      if(entry.characterId!==characterId||!entry.enabled||!entry.content.trim())continue;
      documents.push({id:"core_book:"+entry.id,characterId,source:"core_book",sourceId:entry.id,title:entry.title,content:entry.content,tags:[...entry.tags],status:"enabled",updatedAt:entry.updatedAt});
    }
    const now=Date.now();
    for(const item of memories){
      if(item.characterId!==characterId||!validCurrentMemory(item,now))continue;
      documents.push({id:"memory:"+item.id,characterId,source:"memory",sourceId:item.id,...(item.originConversationId?{conversationId:item.originConversationId}:{}),title:"Character Memory",content:item.content,tags:[...item.tags],status:item.status,type:item.type,updatedAt:item.updatedAt});
    }
    for(const conversation of conversations){
      if(conversation.characterId!==characterId)continue;
      conversation.messages.forEach((message:ChatMessage,index:number)=>{
        if((message.role!=="user"&&message.role!=="assistant")||!message.content.trim())return;
        const sourceId=message.id?.trim()||("message-"+index+"-"+stableKey(message.role+"\u0000"+message.content));
        documents.push({id:"conversation:"+conversation.id+":"+sourceId,characterId,source:"conversation",sourceId,conversationId:conversation.id,
          title:message.role==="user"?"User message":"Nova response",content:message.content,tags:[],role:message.role,status:"saved",updatedAt:conversation.updatedAt});
      });
    }
    return documents;
  }
  private async ensureIndexedBatch(documents:readonly SemanticSearchDocument[],configuration:SemanticEmbeddingConfiguration):Promise<readonly SemanticSearchDocument[]>{
    if(documents.length===0)return [];
    const failed=new Set<string>();
    await withMemorySemanticIndexLock(this.options.indexStore,async()=>{
      const characterId=documents[0]!.characterId;
      if(documents.some(document=>document.characterId!==characterId))throw new Error("Semantic document batch must be scoped to one character.");
      const state=await this.loadIndex(characterId);
      let records=[...state.records];
      const ready:Array<{document:SemanticSearchDocument;vector:readonly number[]}>=[];
      const work:Array<{document:SemanticSearchDocument;id:string;chunks:readonly string[]}>=[];
      for(const document of documents){
        const id=recordId(document);
        const existing=records.find(record=>record.memoryId===id);
        if(existing&&isActiveDocument(existing,document,configuration.provider,configuration.model))continue;
        const cachedMemoryVector=document.source==="memory"
          ?records.find(record=>record.memoryId===document.sourceId&&record.contentHash===deterministicContentHash(document.content)
            &&record.embeddingProviderId===configuration.provider.id&&record.embeddingModel===configuration.model
            &&isVector(record.vector)&&record.dimensions===record.vector.length)
          :undefined;
        if(cachedMemoryVector){ready.push({document,vector:[...cachedMemoryVector.vector]});continue}
        work.push({document,id,chunks:chunkLongInput(embeddingText(document))});
      }
      const flatTexts=work.flatMap(item=>item.chunks);
      const flatVectors=await embedBatchTolerant(configuration.provider,flatTexts);
      let vectorOffset=0;
      for(const item of work){
        const embedded=flatVectors.slice(vectorOffset,vectorOffset+item.chunks.length);
        vectorOffset+=item.chunks.length;
        if(embedded.length!==item.chunks.length||embedded.some(vector=>!vector||!isVector(vector))){
          failed.add(item.document.id);continue;
        }
        try{ready.push({document:item.document,vector:averageVectors(embedded as readonly (readonly number[])[])});}
        catch{failed.add(item.document.id)}
      }
      const dimensions=ready[0]?.vector.length;
      if(dimensions&&ready.some(item=>item.vector.length!==dimensions)){
        for(const item of ready)failed.add(item.document.id);
        ready.splice(0,ready.length);
      }
      if(ready.length===0)return;
      const sameModel=records.filter(record=>record.memoryId.startsWith(SEMANTIC_SEARCH_RECORD_PREFIX)
        &&record.embeddingProviderId===configuration.provider.id&&record.embeddingModel===configuration.model);
      if(sameModel.some(record=>record.dimensions!==dimensions)){
        records=records.filter(record=>!(record.memoryId.startsWith(SEMANTIC_SEARCH_RECORD_PREFIX)
          &&record.embeddingProviderId===configuration.provider.id&&record.embeddingModel===configuration.model));
        this.record("SEMANTIC_SEARCH_DIMENSIONS_CHANGED","Embedding dimensions changed; rebuilding vectors for the active model.",{
          characterId,model:configuration.provider.id+":"+configuration.model,dimensions
        });
      }
      for(const item of ready){
        const id=recordId(item.document);
        records=records.filter(record=>record.memoryId!==id);
        records.push({memoryId:id,characterId,contentHash:deterministicContentHash(embeddingText(item.document)),
          embeddingProviderId:configuration.provider.id,embeddingModel:configuration.model,dimensions:item.vector.length,
          vector:[...item.vector],updatedAt:this.now()});
      }
      await this.options.indexStore.save({...state,records:records.sort((a,b)=>a.memoryId.localeCompare(b.memoryId))});
    });
    return documents.filter(document=>failed.has(document.id));
  }
  private async removeStaleDocuments(characterId:CharacterId,activeIds:ReadonlySet<string>,configuration?:SemanticEmbeddingConfiguration):Promise<void>{
    await withMemorySemanticIndexLock(this.options.indexStore,async()=>{
      const state=await this.loadIndex(characterId);
      const records=state.records.filter(record=>{
        if(!record.memoryId.startsWith(SEMANTIC_SEARCH_RECORD_PREFIX))return true;
        if(!activeIds.has(record.memoryId))return false;
        if(configuration&&(record.embeddingProviderId!==configuration.provider.id||record.embeddingModel!==configuration.model))return false;
        return true;
      });
      if(records.length!==state.records.length)await this.options.indexStore.save({...state,records});
    });
  }
  private async clearCharacter(characterId:CharacterId):Promise<void>{
    try{await withMemorySemanticIndexLock(this.options.indexStore,async()=>{
      const state=await this.loadIndex(characterId);
      await this.options.indexStore.save({...state,records:state.records.filter(record=>!record.memoryId.startsWith(SEMANTIC_SEARCH_RECORD_PREFIX))});
    })}catch{this.record("SEMANTIC_SEARCH_INDEX_CLEANUP_FAILED","Could not clear semantic index for a deleted character.",{characterId})}
  }
  private async loadIndex(characterId:CharacterId):Promise<MemorySemanticIndexState>{
    const state=await this.options.indexStore.load(characterId);
    if(!state)return emptyIndex(characterId);
    if(state.characterId!==characterId||state.apiVersion!==MEMORY_SEMANTIC_INDEX_API_VERSION||state.schemaVersion!==MEMORY_SEMANTIC_INDEX_SCHEMA_VERSION)throw new Error("Semantic index version or character scope mismatch.");
    return state;
  }
  private recordIndexFailure(document:SemanticSearchDocument,configuration:SemanticEmbeddingConfiguration):void{
    this.record("SEMANTIC_SEARCH_DOCUMENT_FAILED","Embedding failed for one document; it remains pending for retry.",{
      characterId:document.characterId,source:document.source,sourceId:document.sourceId,model:configuration.provider.id+":"+configuration.model,errorCode:"embedding_request_failed"
    });
  }
  private reportProgress():void{
    this.record("SEMANTIC_SEARCH_INDEX_PROGRESS","Semantic index progress updated",{
      status:this.statusValue.status,model:this.statusValue.model,processed:this.statusValue.processed,total:this.statusValue.total,
      pending:this.statusValue.pending,failed:this.statusValue.failed,updatedAt:this.statusValue.updatedAt
    });
  }
  private record(code:string,message:string,metadata:Record<string,unknown>):void{this.options.diagnostics?.recordError("semantic-search",code,message,metadata)}
  private now():string{return this.options.clock?.now()??new Date().toISOString()}
}
