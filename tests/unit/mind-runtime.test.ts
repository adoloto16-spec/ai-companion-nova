import {LLMCognitiveStep,MindRuntime,type CognitiveStep,type CognitiveStepContext} from "../../core/src";
import type {AssembledContext,Character,ChatMessage,ChatRequest,ChatResponse,Conversation,MindReactiveTurn,MindTraceEntry,MindTurnExecutionContext,MindTurnSink,MindToolExecutor,NovaTurn} from "../../contracts/src";
import {serializeNovaTurn} from "../../contracts/src";

function equal(actual:unknown,expected:unknown,label:string){if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(label+" expected "+JSON.stringify(expected)+" got "+JSON.stringify(actual));}
function ok(value:unknown,label:string){if(!value)throw new Error(label);}
async function waitFor(predicate:()=>boolean,timeoutMs=1500):Promise<void>{const end=Date.now()+timeoutMs;while(!predicate()){if(Date.now()>=end)throw new Error("Timed out waiting for condition.");await new Promise(resolve=>setTimeout(resolve,2));}}
function makeTurn(speech:string,nextWakeMs=20,tools:NovaTurn["tools"]=[]):NovaTurn{return {version:1,situation:"Current situation and initiative",thoughts:"private internal note",emotion:"focused",tools,toolResults:[],speech,nextWakeMs};}
function schedule(){return {mode:"adaptive" as const,defaultIntervalMs:20,minIntervalMs:10,maxIntervalMs:40,maxRequestsPerHour:null};}
function responseFor(request:ChatRequest,content:string):ChatResponse{return {apiVersion:"1",schemaVersion:"1",requestId:request.requestId,conversationId:request.context.conversationId,providerId:"fake.cognitive",model:request.model,message:{role:"assistant",content},finishReason:"stop"};}
function abortWait(signal:AbortSignal):Promise<never>{return new Promise((_,reject)=>{const abort=()=>{const error=new Error("aborted");error.name="AbortError";reject(error);};if(signal.aborted)abort();else signal.addEventListener("abort",abort,{once:true});});}
function sinkFixture(){const committed:{turn:NovaTurn;context:MindTurnExecutionContext}[]=[];const failed:{turn:MindReactiveTurn;reason:string}[]=[];const streamed:{type:string;turnId:string;text?:string}[]=[];const sink:MindTurnSink={async commit(turn,context){committed.push({turn,context});},streamSpeech(event){streamed.push({type:event.type,turnId:event.turnId,...(event.text===undefined?{}:{text:event.text})});},fail(turn,reason){failed.push({turn,reason});}};return {sink,committed,failed,streamed};}

async function backgroundSchedulingAndSerializationTest(){
 let active=0,maxActive=0,calls=0;const fixture=sinkFixture();
 const step:CognitiveStep={async run(context:CognitiveStepContext){active++;maxActive=Math.max(maxActive,active);try{calls++;await new Promise(resolve=>setTimeout(resolve,4));return {turn:makeTurn("background-"+calls,15),conversationId:"conversation.runtime"};}finally{active--;}}};
 const runtime=new MindRuntime({cognitiveStep:step,schedule:schedule(),turnSink:fixture.sink});
 runtime.setActiveCharacter("character.runtime");
 try{await runtime.start();await waitFor(()=>fixture.committed.length>=2&&runtime.getState().lifecycleState==="waiting");}
 finally{await runtime.stop();}
 equal(maxActive,1,"one serialized runtime never overlaps model requests");
 ok(fixture.committed.length>=2,"planned timer continues writing complete background NovaTurn records");
 equal(fixture.committed[0]?.turn.thoughts,"private internal note","private thoughts remain in the complete persisted turn");
 equal(fixture.committed[0]?.context.characterId,"character.runtime","turn commit preserves character scope");
 equal(runtime.getState().lifecycleState,"off","Life OFF cancels the plan timer");
 ok((runtime.getState().recentTrace??[]).some((entry:MindTraceEntry)=>entry.result==="success"&&entry.appliedIntervalMs===15),"runtime trace records the actual model-selected wake interval");
}

async function userPriorityAndStaleCancellationTest(){
 const fixture=sinkFixture();let starts=0,running=0,maxRunning=0;const seen:MindReactiveTurn[]=[];
 const step:CognitiveStep={async run(context){
  starts++;running++;maxRunning=Math.max(maxRunning,running);
  try{
   if(!context.userTurn&&starts===1){
    await context.onSpeechEvent?.({type:"start",conversationId:"conversation.runtime"});
    await context.onSpeechEvent?.({type:"delta",conversationId:"conversation.runtime",text:"stale background speech"});
    await abortWait(context.signal);
   }
   if(context.userTurn){seen.push({...context.userTurn});return {turn:makeTurn("reply to exact user",20),conversationId:context.userTurn.conversationId};}
   return {turn:makeTurn("must be cancelled",20),conversationId:"conversation.runtime"};
  }finally{running--;}
 }};
 const runtime=new MindRuntime({cognitiveStep:step,schedule:schedule(),turnSink:fixture.sink});
 runtime.setActiveCharacter("character.runtime");
 try{
  await runtime.start();await waitFor(()=>fixture.streamed.some(event=>event.type==="delta"&&event.text==="stale background speech"));
  const staleStreamTurnId=fixture.streamed.find(event=>event.type==="delta"&&event.text==="stale background speech")?.turnId;
  ok(staleStreamTurnId,"the superseded background turn streamed public speech before cancellation");
  const userTurn:MindReactiveTurn={characterId:"character.runtime",conversationId:"conversation.reactive",userMessageId:"user-message-17",turnId:"turn-17"};
  ok(runtime.wakeForUserMessage(userTurn),"a newly persisted user turn queues and supersedes stale background cognition");
  await waitFor(()=>fixture.committed.some(item=>item.context.turnId==="turn-17"));
  equal(maxRunning,1,"user priority does not overlap the cancelled request");
  equal(fixture.committed.length,1,"cancelled stale background result is never committed");
  equal(fixture.streamed.some(event=>event.type==="clear"&&event.turnId===staleStreamTurnId),true,"stale background speech is cleared when a newer user turn supersedes it");
  equal(fixture.committed[0]?.turn.speech,"reply to exact user","reactive speech is committed directly from the returned NovaTurn");
  equal(fixture.committed[0]?.context.userMessageId,"user-message-17","commit remains tied to the exact persisted user message");
  equal(fixture.committed[0]?.context.conversationId,"conversation.reactive","commit remains tied to the exact Conversation");
  equal(seen[0]?.turnId,"turn-17","runtime passes through the stable user turn id");
  equal(runtime.wakeForUserMessage(userTurn),false,"a completed reactive turn cannot be answered twice");
 }finally{await runtime.stop();}
}

async function reactiveSpeechFailureAndRetryTest(){
 const fixture=sinkFixture();let reactiveCalls=0;
 const step:CognitiveStep={async run(context){if(context.userTurn){reactiveCalls++;return {turn:makeTurn(reactiveCalls===1?"":"retry succeeded"),conversationId:context.userTurn.conversationId};}
  return {turn:makeTurn("background",20),conversationId:"conversation.retry"};}};
 const runtime=new MindRuntime({cognitiveStep:step,schedule:schedule(),turnSink:fixture.sink});
 runtime.setActiveCharacter("character.retry");
 const turn:MindReactiveTurn={characterId:"character.retry",conversationId:"conversation.retry",userMessageId:"user-retry",turnId:"turn-retry"};
 try{
  await runtime.start();await waitFor(()=>fixture.committed.length>0&&runtime.getState().lifecycleState==="waiting");
  ok(runtime.wakeForUserMessage(turn),"reactive request is accepted");
  await waitFor(()=>fixture.failed.length===1);
  equal(fixture.failed[0]?.reason,"REACTIVE_SPEECH_REQUIRED","empty required speech surfaces a specific failure");
  equal(fixture.committed.some(item=>item.context.turnId===turn.turnId),false,"invalid reactive speech is not committed as a successful assistant answer");
  ok(runtime.wakeForUserMessage(turn),"failed turn remains eligible for retry");
  await waitFor(()=>fixture.committed.some(item=>item.context.turnId===turn.turnId));
  equal(fixture.committed.find(item=>item.context.turnId===turn.turnId)?.turn.speech,"retry succeeded","retry commits the corrected reply");
  equal(reactiveCalls,2,"retry repeats only the failed reactive cognitive request");
 }finally{await runtime.stop();}
}

async function failedReactiveFinalizationPreservesSpeechForRetryTest(){
 const fixture=sinkFixture();const errors:unknown[]=[];let reactiveCalls=0;
 const userTurn:MindReactiveTurn={characterId:"character.finalization",conversationId:"conversation.finalization",userMessageId:"user-finalization",turnId:"turn-finalization"};
 const step:CognitiveStep={async run(context){
  if(context.userTurn){
   reactiveCalls++;
   await context.onSpeechEvent?.({type:"start",conversationId:context.userTurn.conversationId});
   await context.onSpeechEvent?.({type:"delta",conversationId:context.userTurn.conversationId,text:reactiveCalls===1?"Привет, я Тоня.":"Повторный ответ."});
   return {turn:makeTurn(reactiveCalls===1?"Привет, я Тоня.":"Повторный ответ."),conversationId:context.userTurn.conversationId};
  }
  return {turn:makeTurn("background",1000),conversationId:"conversation.finalization"};
 }};
 const sink:MindTurnSink={
  async commit(turn,context){
   if(context.userMessageId&&reactiveCalls===1)throw new Error("controlled persist failure");
   fixture.committed.push({turn,context});
  },
  streamSpeech(event){fixture.streamed.push({type:event.type,turnId:event.turnId,...(event.text===undefined?{}:{text:event.text})});},
  fail(turn,reason){fixture.failed.push({turn,reason});}
 };
 const runtime=new MindRuntime({cognitiveStep:step,schedule:{mode:"adaptive",defaultIntervalMs:1000,minIntervalMs:1000,maxIntervalMs:2000,maxRequestsPerHour:null},turnSink:sink,onError:error=>errors.push(error)});
 runtime.setActiveCharacter(userTurn.characterId);
 try{
  await runtime.start();await waitFor(()=>runtime.getState().lifecycleState==="waiting");
  ok(runtime.wakeForUserMessage(userTurn),"failed-finalization fixture accepts a user turn");
  await waitFor(()=>fixture.failed.length===1&&runtime.getState().lifecycleState==="waiting");
  equal(fixture.failed[0]?.reason,"Error","persistence failure remains an explicit reactive-turn failure");
  equal((errors[0] as Error|undefined)?.message,"controlled persist failure","finalization cause is reported to diagnostics");
  ok(fixture.streamed.some(event=>event.type==="delta"&&event.turnId===userTurn.turnId&&event.text==="Привет, я Тоня."),"public speech is streamed before persistence fails");
  equal(fixture.streamed.some(event=>event.type==="clear"&&event.turnId===userTurn.turnId),false,"failed finalization preserves its public stream instead of clearing it");
  ok(runtime.wakeForUserMessage(userTurn),"the failed turn remains eligible for retry");
  await waitFor(()=>fixture.committed.some(item=>item.context.turnId===userTurn.turnId));
  equal(reactiveCalls,2,"retry actually runs the cognitive step again");
  equal(fixture.committed.filter(item=>item.context.turnId===userTurn.turnId).length,1,"only the successful retry is committed");
  equal(fixture.streamed.filter(event=>event.type==="clear"&&event.turnId===userTurn.turnId).length,1,"the successful retry clears its provisional stream after commit");
  equal(errors.length,1,"ordinary UI remains healthy while the persistence failure is diagnosed");
 }finally{await runtime.stop();}
}

async function toolsAndToolResultWakeTest(){
 const fixture=sinkFixture();let toolExecutions=0;const reasons:string[]=[];let modelCalls=0;
 const executor:MindToolExecutor={async execute(call,context){toolExecutions++;return {callId:context.callId,name:call.name,status:"success",output:{matches:["real result"]}};}};
 const step:CognitiveStep={async run(context){modelCalls++;reasons.push(context.wakeReason);return {turn:makeTurn(modelCalls===1?"I will check memory.":"The stored result is available.",20,modelCalls===1?[{name:"read_memory",arguments:{query:"preferences"}}]:[]),conversationId:"conversation.tools"};}};
 const runtime=new MindRuntime({cognitiveStep:step,schedule:schedule(),turnSink:fixture.sink,toolExecutor:executor});
 runtime.setActiveCharacter("character.tools");
 try{await runtime.start();await waitFor(()=>fixture.committed.length>=2);}
 finally{await runtime.stop();}
 equal(toolExecutions,1,"registered tool executes exactly once for one stable call id");
 equal(fixture.committed[0]?.turn.toolResults[0]?.status,"success","actual tool result is included in the saved NovaTurn");
 equal(fixture.committed[0]?.turn.toolResults[0]?.output,{matches:["real result"]},"tool output is preserved in the technical record");
 ok(reasons.includes("tool-result"),"a completed tool triggers a tool-result wake");
 equal(fixture.committed[0]?.context.turnId.startsWith("nova-turn-"),true,"background tool calls are tied to a unique cognitive turn");
}

async function lifeOffRejectsLateResponsesTest(){
 const fixture=sinkFixture();let release:((value:{turn:NovaTurn;conversationId:string})=>void)|undefined;let started=0;
 const step:CognitiveStep={run:async()=>{started++;return new Promise(resolve=>{release=resolve;});}};
 const runtime=new MindRuntime({cognitiveStep:step,schedule:schedule(),turnSink:fixture.sink});
 runtime.setActiveCharacter("character.late");
 await runtime.start();await waitFor(()=>started===1);
 await runtime.stop();
 release?.({turn:makeTurn("late response"),conversationId:"conversation.late"});
 await new Promise(resolve=>setTimeout(resolve,10));
 equal(runtime.getState().lifecycleState,"off","stop finishes in the off state");
 equal(fixture.committed.length,0,"late model output after Life OFF does not change Conversation history");
 equal(runtime.getState().nextWakeAt,null,"Life OFF leaves no scheduled timer");
}

async function llmUsesNativeProtocolAndPreservesContextTest(){
 const rawPrevious=serializeNovaTurn(makeTurn("previous public speech"));
 const messages:ChatMessage[]=[
  {id:"previous-turn",role:"assistant",content:rawPrevious,metadata:{novaTurnVersion:1,novaTurnId:"previous-turn"}},
  {id:"latest-user",role:"user",content:"What do you remember about my preference?",metadata:{source:"conversation"}}
 ];
 const conversation={id:"conversation.llm",characterId:"character.llm",messages} as unknown as Conversation;
 const character={id:"character.llm",name:"Nova",description:"A careful companion"} as Character;
 const calls:ChatRequest[]=[];
 let requestNumber=0;
 const runtime={
  async chat(request:ChatRequest):Promise<ChatResponse>{
   calls.push(request);
   if(requestNumber++===0)return {
    ...responseFor(request,""),
    message:{role:"assistant",content:"",toolCalls:[
      {id:"tool-memory",name:"read_memory",arguments:{query:"user preference"}},
      {id:"tool-browser",name:"browser.navigate",arguments:{url:"https://wikipedia.org/"}}
    ]},
    reasoning:"Provider supplied reasoning for tool selection"
   };
   return {...responseFor(request,"I checked the saved preference."),reasoning:"Provider supplied final reasoning"};
  },
  getChatProviderCapabilities:()=>({toolCalling:true}),
  getActiveProviderPresetId:()=>undefined,
  getChatModel:()=>"fake-model",
  async getChatModelForPreset(){return "unused";}
 };
 const budget={availableContextTokens:4096,reservedOutputTokens:1024,systemOverheadTokens:0,safetyMarginTokens:128};
 const executed:Array<{name:string;arguments:Record<string,unknown>}>=[]; 
 const step=new LLMCognitiveStep({
  runtime,
  getCharacter:async()=>character,
  getActiveConversation:async()=>conversation,
  buildContext:async(request)=>({apiVersion:"1",schemaVersion:"1",characterId:request.characterId,conversationId:request.conversationId,messages:request.messages,includedCandidates:[],omittedCandidates:[],budget:request.budget,estimatedTokens:100} as AssembledContext),
  getContextBudget:()=>budget,
  getActiveProviderPresetId:()=>undefined,
  getChatModel:()=>"fake-model",
  getChatModelForPreset:async()=>"unused",
  getCognitiveSchedule:()=>schedule(),
  getAvailableTools:()=>[
    {name:"read_memory",description:"Search saved character memory",parameters:{type:"object",properties:{query:{type:"string"}},required:["query"]}},
    {name:"browser.navigate",description:"Navigate to a permitted web page",parameters:{type:"object",properties:{url:{type:"string"}},required:["url"]}}
  ],
  executeTool:async(call,toolContext)=>{
   executed.push({name:call.name,arguments:call.arguments});
   return {callId:toolContext.callId,name:call.name,status:"success" as const,output:call.name==="read_memory"?{matches:["prefers tea"]}:{opened:true}};
  },
  getReasoningOptions:()=>({mode:"enabled"}),
  getShowReasoningInDiagnostics:()=>true,
  consumeRequestedWakeInterval:()=>45000
 });
 const context:CognitiveStepContext={characterId:"character.llm",state:{lifecycleState:"thinking",nextWakeAt:null,recentTrace:[]},signal:new AbortController().signal,wakeReason:"user-message",userTurn:{characterId:"character.llm",conversationId:"conversation.llm",userMessageId:"latest-user",turnId:"turn-llm"}};
 const result=await step.run(context);
 equal(calls.length,2,"native tool calls are executed and returned to the model before final speech");
 equal(calls[0]?.generation?.responseFormat,undefined,"native cognition does not request a mandatory JSON response format");
 equal(calls[0]?.tools?.map(tool=>tool.name),["read_memory","browser.navigate"],"only registered tools are advertised");
 ok(!calls[0]?.context.messages[0]?.content.includes("NOVA_TURN protocol version 1"),"new cognition does not demand the legacy structured protocol");
 ok(calls[0]?.context.messages.some(message=>message.content==="previous public speech"),"historical NovaTurn is normalized to its original user-facing speech");
 ok(!calls[0]?.context.messages.some(message=>message.content===rawPrevious),"serialized historical NovaTurn is not reused as the new generation contract");
 equal(executed.map(call=>call.name),["read_memory","browser.navigate"],"native calls are executed in provider order");
 const followUp=calls[1]!;
 const assistantCallMessage=followUp.context.messages.find(message=>message.role==="assistant"&&message.toolCalls?.length);
 ok(assistantCallMessage,"assistant tool calls are returned as structured history, not chat text");
 equal(followUp.context.messages.filter(message=>message.role==="tool").map(message=>message.toolCallId),["tool-memory","tool-browser"],"each native tool result retains its call id");
 equal(followUp.context.messages.filter(message=>message.role==="tool").map(message=>message.toolName),["read_memory","browser.navigate"],"tool results retain the tool names");
 ok(followUp.context.messages.some(message=>message.role==="tool"&&message.content.includes("prefers tea")),"real memory-search output is returned to the model in a tool message");
 equal(result.turn.speech,"I checked the saved preference.","final user-facing speech is taken from ordinary provider content");
 equal(result.turn.situation,"","legacy situation is not required");
 equal(result.turn.thoughts,"","legacy thoughts are not fabricated");
 equal(result.turn.emotion,"","emotion is optional and not extracted from reasoning");
 equal(result.turn.tools,[],"native calls are not copied into the legacy turn fields");
 equal(result.turn.nextWakeMs,45000,"runtime scheduling tool result may override the default wake interval");
 equal(result.reasoning,"Provider supplied reasoning for tool selectionProvider supplied final reasoning","provider reasoning is kept separate from the user-facing answer");
}

async function main(){
 await backgroundSchedulingAndSerializationTest();
 await userPriorityAndStaleCancellationTest();
 await reactiveSpeechFailureAndRetryTest();
 await failedReactiveFinalizationPreservesSpeechForRetryTest();
 await toolsAndToolResultWakeTest();
 await lifeOffRejectsLateResponsesTest();
 await llmUsesNativeProtocolAndPreservesContextTest();
 console.log("PASS unified NovaTurn runtime + LLM protocol tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
