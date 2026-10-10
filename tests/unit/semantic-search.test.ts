import type {AppSettings,CharacterId,Conversation,CoreBookEntry,EmbeddingProvider,HealthStatus,MemoryItem,MemorySemanticVectorRecord,ProviderCapabilities} from "../../contracts/src/index";
import {defaultAppSettings} from "../../contracts/src/index";
import {deterministicContentHash,InMemoryEventBus,InMemoryDiagnosticsStore,SemanticSearchService} from "../../core/src/index";
import {InMemoryMemorySemanticIndexStore} from "../../host/memory/src/index";
function ok(v:unknown,label:string){if(!v)throw new Error(label)}
function equal(a:unknown,b:unknown,label:string){if(JSON.stringify(a)!==JSON.stringify(b))throw new Error(label+" expected "+JSON.stringify(b)+" got "+JSON.stringify(a))}
const stamp="2026-10-01T10:00:00.000Z";
class TestEmbeddings implements EmbeddingProvider{
 readonly id="test.russian-embeddings";calls:string[][]=[];fail=false;
 constructor(private readonly version=1){}
 capabilities():ProviderCapabilities{return {embeddings:true}} dimensions(){return this.version===1?3:4}
 async embed(texts:string[]):Promise<number[][]>{
  this.calls.push([...texts]);if(this.fail)throw new Error("intentional provider failure");
  if(texts.length>4)throw new Error("simulated batch size limit");

  return texts.map(text=>{const v=text.toLocaleLowerCase("ru-RU");
   if(/квантов|затмен/.test(v))return this.version===1?[1,1,1]:[1,1,1,1];
   if(/крыша|ремонт/.test(v))return this.version===1?[0,1,0]:[0,1,0,0];
   if(/сосед/.test(v))return this.version===1?[.8,.6,0]:[.8,.6,0,0];
   if(/риг|прожива|город|lease|rental|home|квартир|жиль|дом|адрес|съём|аренд/.test(v))return this.version===1?[1,0,0]:[1,0,0,0];
   return this.version===1?[0,0,1]:[0,0,0,1];
  });
 }
 async health():Promise<HealthStatus>{return {status:"healthy",capabilities:["embeddings"]}}
}
function book(id:string,c:CharacterId,title:string,content:string,activation:CoreBookEntry["activation"]={kind:"always"}):CoreBookEntry{
 return {id,characterId:c,title,content,tags:[],activation,retentionPriority:80,placementWeight:50,mutationPolicy:"locked",enabled:true,source:"user",role:"user",metadata:{},createdAt:stamp,updatedAt:stamp}
}
function memory(id:string,c:CharacterId,content:string,status:MemoryItem["status"]="active"):MemoryItem{
 return {id,characterId:c,originConversationId:null,type:"fact",content,tags:[],importance:80,confidence:90,createdAt:stamp,updatedAt:stamp,validFrom:null,validUntil:null,source:"user",sourceReference:null,mutationPolicy:"locked",status,archiveReason:status==="archived"?"manual":null,metadata:{}}
}
function conv(id:string,c:CharacterId,messages:Conversation["messages"]):Conversation{return {apiVersion:"1",schemaVersion:"2",id,characterId:c,title:id,messages,createdAt:stamp,updatedAt:stamp}}
function makeSettings():AppSettings{const s=defaultAppSettings();s.retrieval.semanticSearchEnabled=true;s.retrieval.semanticSimilarityThreshold=.7;s.retrieval.semanticResultLimit=10;return s}
async function main(){
 const a="character.a",b="character.b";
 const longThoughts="The saved note says the user has a long-term rental in Riga. ".repeat(70);
 const fullTurn='<NOVA_TURN version="1"><SITUATION>Continuation.</SITUATION><THOUGHTS>'+longThoughts+'</THOUGHTS><EMOTION>Calm</EMOTION><TOOLS></TOOLS><TOOL_RESULTS></TOOL_RESULTS><SPEECH>Everything is fine.</SPEECH><LONGMEMORY>Apartment lease in Riga.</LONGMEMORY><NEXT_WAKE_MS>30000</NEXT_WAKE_MS></NOVA_TURN>';
 const books=[book("home",a,"Home","Пользователь постоянно проживает в Риге."),book("roof",a,"Repair","Ремонт крыши в соседнем доме."),book("partial",a,"Neighbour","Новый дом по соседству."),book("model-search",a,"Model search","Пользователь проживает в Риге через model_search.",{kind:"model_search"}),book("other",b,"Other","The user rents a house in Riga.")];
 for(let i=0;i<58;i++)books.push(book("batch-"+i,a,"Batch document","Notes about astronomy and public events "+i));
 const memories=[memory("memory-home",a,"Пользователь возвращается домой в Ригу по выходным."),memory("archived",a,"Пользователь снимал жильё в Риге.","archived"),memory("memory-other",b,"Пользователь живёт в Риге.")];
 const conversations=[conv("old-chat",a,[{id:"old-user",role:"user",content:"Я ищу жильё на длительный срок."},{id:"old-nova",role:"assistant",content:fullTurn}]),conv("other-chat",b,[{id:"other-user",role:"user",content:"I rent in Riga."}])];
 const index=new InMemoryMemorySemanticIndexStore();
 const dedup:MemorySemanticVectorRecord={memoryId:"memory-home",characterId:a,contentHash:deterministicContentHash(memories[0]!.content),embeddingProviderId:"test.russian-embeddings",embeddingModel:"ru-v1",dimensions:3,vector:[1,0,0],updatedAt:stamp};
 await index.save({apiVersion:"1",schemaVersion:"1",characterId:a,records:[dedup]});
 const events=new InMemoryEventBus(),diagnostics=new InMemoryDiagnosticsStore(200);
 let model="ru-v1",provider=new TestEmbeddings();
 const makeService=()=>new SemanticSearchService({settings:makeSettings,indexStore:index,embeddingConfiguration:async()=>({provider,model}),
  listCharacterIds:async()=>[a,b],coreBook:{listCoreBookEntries:async c=>books.filter(x=>x.characterId===c)},
  memory:{list:async c=>memories.filter(x=>x.characterId===c)},conversations:{listConversations:async c=>conversations.filter(x=>x.characterId===c)},
  events,diagnostics,clock:{now:()=>stamp}});
 const service=makeService();service.start();await service.rebuildAll();
 equal(service.getStatus().status,"ready","initial index status");equal(service.getStatus().processed,68,"every current source document is processed across multiple batches");
 ok((await index.load(a))?.records.some(r=>r.memoryId==="memory-home"),"semantic indexing preserves the existing memory-dedup vector");
 ok(provider.calls.some(call=>call.length>4),"oversized embedding batches were split and recovered");
 const calls=provider.calls.length;await service.rebuildAll();equal(provider.calls.length,calls,"unchanged documents are not embedded again");
 const hits=await service.search({characterId:a,query:"Где найти квартиру для себя?",limit:10,threshold:.7});
 ok(hits.some(h=>h.source==="core_book"&&h.sourceId==="home"),"Russian semantic search retrieves Core Book without exact phrases");
 ok(hits.some(h=>h.source==="core_book"&&h.sourceId==="model-search"),"explicit search can find enabled model_search entries");
 ok(hits.some(h=>h.source==="memory"&&h.sourceId==="memory-home"),"Character Memory participates");
 const full=hits.find(h=>h.source==="conversation"&&h.sourceId==="old-nova");ok(full,"old assistant turn outside current context is indexed");
 equal(full?.content,fullTurn,"complete NOVA_TURN, including all fields, is one document");
 ok(hits.some(h=>h.source==="conversation"&&h.sourceId==="old-user"),"user history message is a separate document");
 equal(hits.some(h=>h.sourceId==="archived"),false,"archived Memory excluded");
 equal(hits.some(h=>["other","memory-other","other-user"].includes(h.sourceId)),false,"character isolation enforced");
 const roof=await service.search({characterId:a,query:"Как отремонтировать протекающую крышу?",limit:10,threshold:.7});
 ok(roof.some(h=>h.sourceId==="roof"),"Russian repair query finds matching topic");
 equal(roof.some(h=>h.sourceId==="home"),false,"shared generic context does not bypass semantic similarity");
 const strict=await service.search({characterId:a,query:"Где найти квартиру для себя?",limit:10,threshold:.99});
 equal(strict.some(h=>h.sourceId==="partial"),false,"cosine threshold excludes a weaker vector match");
 equal(await service.search({characterId:a,query:"   "}),[],"empty query returns empty results");
 equal(await service.search({characterId:a,query:"Расскажи о квантовой механике",limit:10,threshold:.99}),[],"unrelated Russian semantic query has no above-threshold matches");
 memories[memories.findIndex(m=>m.id==="memory-home")!]=memory("memory-home",a,"Пользователь обсуждает протекающую крышу.");
 await events.publish({id:"update",type:"MemoryUpdated",timestamp:stamp,source:"test",schemaVersion:"1",payload:{characterId:a,memoryId:"memory-home",status:"active",updatedAt:stamp}});
 await service.rebuildAll();
 equal((await service.search({characterId:a,query:"Где найти квартиру для себя?",limit:10,threshold:.7})).some(h=>h.source==="memory"&&h.sourceId==="memory-home"),false,"updated document cannot return stale content vectors");
 memories.splice(memories.findIndex(m=>m.id==="memory-home"),1);
 await events.publish({id:"delete",type:"MemoryDeleted",timestamp:stamp,source:"test",schemaVersion:"1",payload:{characterId:a,memoryId:"memory-home"}});
 await service.rebuildAll();
 ok(!(await index.load(a))?.records.some(r=>r.memoryId.startsWith("semantic-search:memory:")),"deleted Memory leaves no semantic document");
 const restarted=makeService();await restarted.rebuildAll();
 ok((await restarted.search({characterId:a,query:"Где найти квартиру?",limit:10,threshold:.7})).length>0,"persistent index survives service re-instantiation");
 model="ru-v2";provider=new TestEmbeddings(2);await restarted.rebuildAll();
 ok((await index.load(a))?.records.filter(r=>r.memoryId.startsWith("semantic-search:")).every(r=>r.embeddingModel===model),"model/dimension change rebuilds a compatible semantic partition");
 const unchangedCalls=provider.calls.length;await restarted.rebuildAll();equal(provider.calls.length,unchangedCalls,"second pass with same model is idempotent");
 provider.fail=true;equal(await restarted.search({characterId:a,query:"Где найти квартиру?",limit:5}),[],"embedding errors fail closed to empty results");
 ok(diagnostics.recentErrors().some(e=>e.code==="SEMANTIC_SEARCH_QUERY_FAILED"),"embedding failure produces diagnostics without source contents");
 restarted.stop();service.stop();console.log("semantic search unit tests passed");
}
void main().catch(error=>{console.error(error);throw error});
