import type {AppSettings,ChatRequest,ChatResponse,EmbeddingProvider,HealthStatus,MindTurnExecutionContext,MindTurnSink,NovaTurn,ProviderCapabilities} from "../../contracts/src/index";
import {defaultAppSettings,StandardContractValidator} from "../../contracts/src/index";
import {ChatSessionController,ConversationSession,InMemoryCharacterStore,LLMCognitiveStep,MindRuntime} from "../../core/src/index";
import {createFoundationRuntime} from "../../runtime/bootstrap/src/index";
import {InMemoryCoreBookStore} from "../../host/core-book/src/index";
import {InMemoryMemoryStore,InMemoryMemorySemanticIndexStore} from "../../host/memory/src/index";
import {InMemoryConversationStore} from "../../host/conversations/src/index";
import {InMemorySettingsStore} from "../../host/settings/src/index";
function ok(v:unknown,label:string){if(!v)throw new Error(label)}
function eq(a:unknown,b:unknown,label:string){if(JSON.stringify(a)!==JSON.stringify(b))throw new Error(label+" expected "+JSON.stringify(b)+" got "+JSON.stringify(a))}
class Embeddings implements EmbeddingProvider{
 readonly id="test.semantic.integration";capabilities():ProviderCapabilities{return {embeddings:true}} dimensions(){return 3}
 async embed(texts:string[]):Promise<number[][]>{return texts.map(t=>/long-term lease/i.test(t)&&/riga/i.test(t)?[1,0,1]:/крыша|ремонт/i.test(t)?[0,1,0]:/квартир|где|риг|прожив|housing|riga|home|lease/i.test(t)?[1,0,0]:[0,1,0])}
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
  // A strict raw-cosine threshold isolates the exact historical vector for full-document assertions,
  // instead of making an assertion depend on the tool's bounded multi-result payload budget.
  const strictSearchSettings=runtime.getSettings();
  strictSearchSettings.retrieval.semanticSimilarityThreshold=0.99;
  await runtime.updateSettings(strictSearchSettings);
  const historicalAction=await runtime.invoke({id:"memory-search-historical.integration",schemaVersion:"1",tool:"MEMORY_SEARCH",
   arguments:{query:"Which detail about the long-term lease in Riga was saved in my older conversation?"},metadata:{characterId:character.id,conversationId:active.id,turnId:"tool-turn-historical",callId:"tool-call-historical"}});
  eq(historicalAction.status,"success","MEMORY_SEARCH supports a focused historical query");
  if(historicalAction.status!=="success")throw new Error("Historical MEMORY_SEARCH failed: "+historicalAction.error.code);
  const historicalOutput=JSON.stringify(historicalAction.output);
  ok(historicalOutput.includes("old-turn.integration"),"MEMORY_SEARCH returns historical NOVA_TURN by source ID");
  ok(historicalOutput.includes(JSON.stringify(oldTurn.slice(0,60)).slice(1,-1)),"MEMORY_SEARCH returns intact historical NOVA_TURN content");
  // Exercise the complete production cognitive loop: the model emits a native MEMORY_SEARCH call,
  // the existing Tool Registry and Action Broker execute it, and the provider receives a role=tool result.
  const loopConversation=await runtime.createConversation(character.id,{id:"semantic-tool-loop.integration",title:"Semantic tool loop"});
  const modelRequests:ChatRequest[]=[];
  const loopCommits:Array<{turn:NovaTurn;context:MindTurnExecutionContext}>=[];
  const nativeToolCalls:string[]=[];
  let nextModelSawToolResult=false;
  const finalSpeech="The earlier conversation recorded a long-term lease and that you live in Riga.";
  const scriptedChat={
    getChatProviderCapabilities:()=>({toolCalling:true}),
    async chat(request:ChatRequest):Promise<ChatResponse>{
      modelRequests.push(request);
      if(modelRequests.length===1){
        return {apiVersion:request.apiVersion,schemaVersion:request.schemaVersion,requestId:request.requestId,
          conversationId:request.context.conversationId,providerId:"test.scripted-chat",model:request.model,
          message:{role:"assistant",content:""},finishReason:"stop"};
      }
      if(modelRequests.length===2){
        return {apiVersion:request.apiVersion,schemaVersion:request.schemaVersion,requestId:request.requestId,
          conversationId:request.context.conversationId,providerId:"test.scripted-chat",model:request.model,
          message:{role:"assistant",content:"",toolCalls:[{id:"semantic-search-call",name:"MEMORY_SEARCH",
            arguments:{query:"Which detail about the long-term lease in Riga was saved in my older conversation?"}}]},
          finishReason:"stop"};
      }
      nextModelSawToolResult=request.context.messages.some(message=>message.role==="tool"&&message.toolCallId==="semantic-search-call"
        &&message.toolName==="MEMORY_SEARCH"&&message.content.includes("old-turn.integration")&&message.content.includes("long-term lease"));
      return {apiVersion:request.apiVersion,schemaVersion:request.schemaVersion,requestId:request.requestId,
        conversationId:request.context.conversationId,providerId:"test.scripted-chat",model:request.model,
        message:{role:"assistant",content:finalSpeech},finishReason:"stop"};
    }
  };
  const turnSink:MindTurnSink={async commit(turn,context){
    loopCommits.push({turn,context});
    if(!turn.speech.trim())return;
    const current=await runtime.getConversation(context.characterId,context.conversationId);
    if(!current)throw new Error("The canonical Conversation disappeared during native tool-loop persistence.");
    await runtime.updateConversation(context.characterId,context.conversationId,{messages:[
      ...current.messages,
      {id:"nova-turn:"+context.turnId+":"+current.messages.length,role:"assistant",content:turn.speech,
       metadata:{novaTurnProtocolVersion:2,source:"nova-life",novaTurnId:context.turnId}}
    ]});
  }};
  const cognitiveStep=new LLMCognitiveStep({
    runtime:scriptedChat,getCharacter:id=>runtime.getCharacter(id),
    getActiveConversation:async id=>runtime.getConversation(id,loopConversation.id),
    buildContext:request=>runtime.buildContext(request),
    getContextBudget:()=>({availableContextTokens:4096,reservedOutputTokens:512,systemOverheadTokens:0,safetyMarginTokens:128}),
    getActiveProviderPresetId:()=>undefined,getChatModel:()=>"test-scripted-model",
    getChatModelForPreset:async()=>"test-scripted-model",getCognitiveSchedule:()=>runtime.getSettings().cognitiveSchedule,
    getAvailableTools:()=>[{name:"MEMORY_SEARCH",description:"Read-only semantic search of saved memory and conversation history.",
      parameters:{type:"object",properties:{query:{type:"string",minLength:1,maxLength:1000}},required:["query"]}}],
    executeTool:async(call,context)=>{
      nativeToolCalls.push(call.name);
      const result=await runtime.invoke({id:context.callId,schemaVersion:"1",tool:call.name,arguments:call.arguments,
        metadata:{characterId:context.characterId,conversationId:context.conversationId,turnId:context.turnId,
          callId:context.callId,requestId:context.requestId}});
      if(result.status==="success")return {callId:context.callId,name:call.name,status:"success" as const,output:result.output};
      return {callId:context.callId,name:call.name,status:"error" as const,error:"Action Broker rejected the native tool call: "+result.error.code};
    }
  });
  const loopRuntime=new MindRuntime({cognitiveStep,schedule:{mode:"adaptive",defaultIntervalMs:30000,minIntervalMs:1,maxIntervalMs:60000,maxRequestsPerHour:null},
    turnSink,
    toolExecutor:{async execute(call,context){
      const result=await runtime.invoke({id:context.callId,schemaVersion:"1",tool:call.name,arguments:call.arguments,
        metadata:{characterId:context.characterId,conversationId:context.conversationId,turnId:context.turnId,callId:context.callId,requestId:context.requestId}});
      if(result.status==="success")return {callId:context.callId,name:call.name,status:"success",output:result.output};
      return {callId:context.callId,name:call.name,status:"error",error:"Tool dispatch did not return success."};
    }}
  });
  const waitFor=async(predicate:()=>boolean,label:string)=>{
    const deadline=Date.now()+8000;
    while(Date.now()<deadline){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10))}
    throw new Error("Timed out waiting for "+label+".");
  };
  loopRuntime.setActiveCharacter(character.id);
  try{
    await loopRuntime.start();
    await waitFor(()=>modelRequests.length>=1&&loopCommits.length>=1&&loopRuntime.getState().lifecycleState==="waiting","initial background cognitive turn");
    const latest=await runtime.getConversation(character.id,loopConversation.id);
    if(!latest)throw new Error("The native tool-loop Conversation is unavailable.");
    await runtime.updateConversation(character.id,loopConversation.id,{messages:[
      ...latest.messages,{id:"semantic-loop-user",role:"user",content:"Please find my saved lease details."}
    ]});
    ok(loopRuntime.wakeForUserMessage({characterId:character.id,conversationId:loopConversation.id,
      userMessageId:"semantic-loop-user",turnId:"semantic-loop-turn"}),"the persisted user turn schedules a real cognitive wake");
    await waitFor(()=>modelRequests.length>=3&&loopCommits.length>=2&&loopRuntime.getState().lifecycleState==="waiting","native tool result and final provider response");
    eq(modelRequests[1]?.tools?.map(tool=>tool.name),["MEMORY_SEARCH"],"only the existing registered search tool is advertised");
    eq(nativeToolCalls,["MEMORY_SEARCH"],"the native tool call is executed exactly once");
    ok(nextModelSawToolResult,"the provider receives the real Action Broker output in a separate role=tool message");
    ok(modelRequests[2]?.context.messages.some(message=>message.role==="tool"&&message.content.includes("old-turn.integration")
      &&message.content.includes("long-term lease")),"historical conversation retrieval reaches the next model request as native tool output");
    eq(loopCommits[1]?.turn.speech,finalSpeech,"final cognitive turn contains ordinary provider speech");
    eq(loopCommits[1]?.turn.tools,[],"native calls are not copied into the legacy turn tool list");
    eq(loopCommits[1]?.turn.toolResults,[],"native tool result history is not re-serialized into legacy protocol fields");
    const persisted=await runtime.getConversation(character.id,loopConversation.id);
    ok(persisted?.messages.some(message=>message.role==="assistant"&&message.content===finalSpeech
      &&message.metadata?.novaTurnProtocolVersion===2),"new cognitive speech is persisted as an ordinary assistant message");
  }finally{await loopRuntime.stop()}
 }finally{await runtime.stop()}
 console.log("semantic search runtime integration tests passed");
}
void main().catch(error=>{console.error(error);throw error});
