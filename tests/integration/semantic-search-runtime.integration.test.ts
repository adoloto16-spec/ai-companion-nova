import type {AppSettings,ChatRequest,EmbeddingProvider,HealthStatus,ProviderCapabilities} from "../../contracts/src/index";
import {defaultAppSettings,StandardContractValidator} from "../../contracts/src/index";
import {ChatSessionController,ConversationSession,InMemoryCharacterStore} from "../../core/src/index";
import {createFoundationRuntime} from "../../runtime/bootstrap/src/index";
import {InMemoryCoreBookStore} from "../../host/core-book/src/index";
import {InMemoryMemoryStore,InMemoryMemorySemanticIndexStore} from "../../host/memory/src/index";
import {InMemoryConversationStore} from "../../host/conversations/src/index";
import {InMemorySettingsStore} from "../../host/settings/src/index";
function ok(v:unknown,label:string){if(!v)throw new Error(label)}
function eq(a:unknown,b:unknown,label:string){if(JSON.stringify(a)!==JSON.stringify(b))throw new Error(label+" expected "+JSON.stringify(b)+" got "+JSON.stringify(a))}
class Embeddings implements EmbeddingProvider{
 readonly id="test.semantic.integration";capabilities():ProviderCapabilities{return {embeddings:true}} dimensions(){return 3}
 async embed(texts:string[]):Promise<number[][]>{return texts.map(t=>/long-term lease|older conversation/i.test(t)?[0,0,1]:/квартир|где|дом|риг|прожив|housing|riga|home|lease/i.test(t)?[1,0,0]:/крыша|ремонт/i.test(t)?[0,1,0]:[0,0,1])}
 async health():Promise<HealthStatus>{return {status:"healthy",capabilities:["embeddings"]}}
}
async function main(){
 const s:AppSettings=defaultAppSettings();s.retrieval.semanticSearchEnabled=true;s.retrieval.semanticSimilarityThreshold=.7;s.retrieval.semanticResultLimit=20;
 const settingsStore=new InMemorySettingsStore(new StandardContractValidator());await settingsStore.save(s);
 const characterStore=new InMemoryCharacterStore(),coreBookStore=new InMemoryCoreBookStore(),memoryStore=new InMemoryMemoryStore();
 const conversationStore=new InMemoryConversationStore(),semanticIndexStore=new InMemoryMemorySemanticIndexStore();
 const runtime=await createFoundationRuntime({characterStore,coreBookStore,memoryStore,conversationStore,semanticIndexStore,settingsStore,
  semanticEmbeddingConfiguration:async()=>({provider:new Embeddings(),model:"test-semantic-v1"})});
 await runtime.start();
 try{
  const character=await runtime.getActiveCharacter(),active=await runtime.getActiveConversation((await runtime.getActiveCharacter()).id);
  const oldTurn='<NOVA_TURN version="1"><SITUATION>Old home facts.</SITUATION><THOUGHTS>The saved conversation says the user has a long-term lease and lives in Riga.</THOUGHTS><EMOTION>Calm</EMOTION><TOOLS></TOOLS><TOOL_RESULTS></TOOL_RESULTS><SPEECH>Hello.</SPEECH><LONGMEMORY>The user lives in Riga.</LONGMEMORY><NEXT_WAKE_MS>30000</NEXT_WAKE_MS></NOVA_TURN>';
  const old=await runtime.createConversation(character.id,{id:"old-chat.integration",title:"Old chat"});
  await runtime.updateConversation(character.id,old.id,{messages:[{id:"old-user.integration",role:"user",content:"My previous housing search."},{id:"old-turn.integration",role:"assistant",content:oldTurn}]});
  const home=await runtime.createCoreBookEntry(character.id,{title:"Home city",content:"Пользователь постоянно проживает в Риге.",activation:{kind:"semantic"},source:"user",role:"system"});
  const modelSearch=await runtime.createCoreBookEntry(character.id,{title:"Tool-only retrieval",content:"Пользователь проживает в Риге в съёмной квартире.",activation:{kind:"model_search"},source:"user",role:"user"});
  const mem=await runtime.createMemory(character.id,{id:"memory.integration.home",conversationId:active.id,type:"fact",content:"Пользователь возвращается домой в Ригу.",tags:["home"],importance:90,confidence:90,source:"user",mutationPolicy:"locked"});
  await runtime.rebuildSemanticSearchIndex();eq(runtime.getSemanticSearchStatus().status,"ready","live runtime exposes indexing status");
  let captured:ChatRequest|undefined;
  const controller=new ChatSessionController(new ConversationSession(active.id,character.id),{async chat(request){captured=request;return runtime.chat(request)}},
   {requestIdFactory:()=>"semantic-context-test",contextBuilder:{buildContext:request=>runtime.buildContext(request)},
    contextBudget:{availableContextTokens:2048,reservedOutputTokens:256,systemOverheadTokens:0,safetyMarginTokens:64}});
  eq((await controller.submit("Где найти квартиру для себя?",runtime.getActiveChatModel())).status,"sent","real ChatSessionController submits successfully");
  ok(captured,"final ChatRequest was captured");
  const semantic=captured!.context.messages.filter(m=>m.metadata?.contextSource==="semantic_search");
  ok(semantic.length>0,"semantic search results are present in final ChatRequest");
  ok(semantic.some(m=>m.content.includes(home.content)),"semantic Core Book activation is materialized into ChatRequest");
  ok(!semantic.some(m=>m.content.includes(modelSearch.content)),"automatic context preserves model_search activation rules");
  ok(semantic.some(m=>m.content.includes(mem.content)),"Character Memory payload is materialized into ChatRequest");
  ok(semantic.some(m=>m.content.includes(oldTurn)),"whole NOVA_TURN from an old conversation is materialized into ChatRequest");
  ok(semantic.some(m=>m.metadata?.contextReferenceId==="old-turn.integration"),"provenance survives into ChatRequest");
  const action=await runtime.invoke({id:"memory-search.integration",schemaVersion:"1",tool:"MEMORY_SEARCH",
   arguments:{query:"Где найти квартиру для себя?"},metadata:{characterId:character.id,conversationId:active.id,turnId:"tool-turn",callId:"tool-call"}});
  eq(action.status,"success","MEMORY_SEARCH dispatched through the production Tool Registry and Action Broker");
  if(action.status!=="success")throw new Error("MEMORY_SEARCH action failed: "+action.error.code);
  const output=JSON.stringify(action.output);
  ok(output.includes("core_book")&&output.includes("memory")&&output.includes("conversation"),"MEMORY_SEARCH returns results across the three source families");
  ok(output.includes(modelSearch.id),"explicit MEMORY_SEARCH can find model_search Core Book entries");
  const historicalAction=await runtime.invoke({id:"memory-search-historical.integration",schemaVersion:"1",tool:"MEMORY_SEARCH",
   arguments:{query:"Which detail was saved about the long-term lease in my older conversation?"},metadata:{characterId:character.id,conversationId:active.id,turnId:"tool-turn-historical",callId:"tool-call-historical"}});
  eq(historicalAction.status,"success","MEMORY_SEARCH supports a focused historical query");
  if(historicalAction.status!=="success")throw new Error("Historical MEMORY_SEARCH failed: "+historicalAction.error.code);
  const historicalOutput=JSON.stringify(historicalAction.output);
  ok(historicalOutput.includes("old-turn.integration"),"MEMORY_SEARCH returns historical NOVA_TURN by source ID");
  ok(historicalOutput.includes(oldTurn.slice(0,60)),"MEMORY_SEARCH returns intact historical NOVA_TURN content");
 }finally{await runtime.stop()}
 console.log("semantic search runtime integration tests passed");
}
void main().catch(error=>{console.error(error);throw error});
