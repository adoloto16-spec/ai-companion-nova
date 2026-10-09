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
function sinkFixture(){const committed:{turn:NovaTurn;context:MindTurnExecutionContext}[]=[];const failed:{turn:MindReactiveTurn;reason:string}[]=[];const sink:MindTurnSink={async commit(turn,context){committed.push({turn,context});},fail(turn,reason){failed.push({turn,reason});}};return {sink,committed,failed};}

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
   if(!context.userTurn&&starts===1)await abortWait(context.signal);
   if(context.userTurn){seen.push({...context.userTurn});return {turn:makeTurn("reply to exact user",20),conversationId:context.userTurn.conversationId};}
   return {turn:makeTurn("must be cancelled",20),conversationId:"conversation.runtime"};
  }finally{running--;}
 }};
 const runtime=new MindRuntime({cognitiveStep:step,schedule:schedule(),turnSink:fixture.sink});
 runtime.setActiveCharacter("character.runtime");
 try{
  await runtime.start();await waitFor(()=>starts===1);
  const userTurn:MindReactiveTurn={characterId:"character.runtime",conversationId:"conversation.reactive",userMessageId:"user-message-17",turnId:"turn-17"};
  ok(runtime.wakeForUserMessage(userTurn),"a newly persisted user turn queues and supersedes stale background cognition");
  await waitFor(()=>fixture.committed.some(item=>item.context.turnId==="turn-17"));
  equal(maxRunning,1,"user priority does not overlap the cancelled request");
  equal(fixture.committed.length,1,"cancelled stale background result is never committed");
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

async function llmUsesTaggedProtocolAndPreservesContextTest(){
 const rawPrevious=serializeNovaTurn(makeTurn("previous public speech"));
 const messages:ChatMessage[]=[
  {id:"previous-turn",role:"assistant",content:rawPrevious,metadata:{novaTurnVersion:1,novaTurnId:"previous-turn"}},
  {id:"latest-user",role:"user",content:"What do you remember about my preference?",metadata:{source:"conversation"}}
 ];
 const conversation={id:"conversation.llm",characterId:"character.llm",messages} as unknown as Conversation;
 const character={id:"character.llm",name:"Nova",description:"A careful companion"} as Character;
 let outputMode:"structured"|"plain"="structured";const calls:ChatRequest[]=[];let responseContent='<NOVA_TURN version="1"><SITUATION>Use real memory results before concluding.</SITUATION><THOUGHTS>Keep private notes private.</THOUGHTS><EMOTION>Focused.</EMOTION><TOOLS><read_memory>{"query":"user preference"}</read_memory><browser.navigate>{"url":"https://wikipedia.org/"}</browser.navigate></TOOLS><SPEECH>I’ll check what was saved before answering.</SPEECH><NEXT_WAKE_MS>45000</NEXT_WAKE_MS></NOVA_TURN>';
 const runtime={async chat(request:ChatRequest){calls.push(request);return responseFor(request,responseContent);},getActiveProviderPresetId:()=>undefined,getChatModel:()=>"fake-model",async getChatModelForPreset(){return "unused";}};
 const budget={availableContextTokens:4096,reservedOutputTokens:1024,systemOverheadTokens:0,safetyMarginTokens:128};
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
  getOutputMode:()=>outputMode,
  getAvailableTools:()=>[{name:"read_memory",description:"Search saved memory",parameters:{type:"object"}},{name:"browser.navigate",description:"Open controlled domain",parameters:{type:"object"}}]
 });
 const context:CognitiveStepContext={characterId:"character.llm",state:{lifecycleState:"thinking",nextWakeAt:null,recentTrace:[]},signal:new AbortController().signal,wakeReason:"user-message",userTurn:{characterId:"character.llm",conversationId:"conversation.llm",userMessageId:"latest-user",turnId:"turn-llm"}};
 const result=await step.run(context);
 equal(calls.length,1,"all cognitive fields come from exactly one LLM request");
 equal(calls[0]?.generation?.responseFormat?.type,"text","tagged protocol uses provider-neutral text, not JSON Schema mode");
 equal(calls[0]?.context.messages.at(-1)?.role,"user","Mistral-compatible synthetic cue is the final user message");
 ok(calls[0]?.context.messages.at(-1)?.content.includes("SPEECH must be non-empty"),"reactive user cue requires public speech");
 ok(calls[0]?.context.messages.some(message=>message.content===rawPrevious),"complete prior NovaTurn remains in the model context");
 ok(!calls[0]?.context.messages.some(message=>message.content.includes("INTERNAL THOUGHT HISTORY")),"retired parallel Thought history is absent");
 ok(calls[0]?.context.messages.some(message=>message.content.includes("read_memory")&&message.content.includes("browser.navigate")),"prompt lists registered tools and supports multiple calls in one response");
 equal(result.turn.situation,"Use real memory results before concluding.","situation is parsed independently");
 equal(result.turn.thoughts,"Keep private notes private.","thoughts are parsed independently");
 equal(result.turn.emotion,"Focused.","emotion is parsed independently");
 equal(result.turn.tools.map(call=>call.name),["read_memory","browser.navigate"],"multiple tool calls are parsed independently of speech");
 equal(result.turn.speech,"I’ll check what was saved before answering.","speech is the ready-to-send public answer");
 equal(result.turn.nextWakeMs,45000,"model-selected wake interval is an integer field");
 outputMode="plain";
 responseContent='<browser.navigate>{"url":"https://example.invalid"}</browser.navigate> This is literal plain text.';
 const plain=await step.run({...context,wakeReason:"scheduled",userTurn:undefined});
 const plainRequest=calls.at(-1)!;
 ok(plainRequest.context.messages[0]?.content.includes("ordinary plain text"),"plain mode uses a distinct plain-text hidden system prompt");
 ok(!plainRequest.context.messages[0]?.content.includes("NOVA_TURN protocol version 1"),"plain mode does not reuse the structured protocol prompt");
 ok(plainRequest.context.messages.at(-1)?.content.includes("[[NOVA_SILENT]]"),"plain background cue defines the exact silence sentinel");
 ok(!plainRequest.context.messages[2]?.content.includes("[REGISTERED TOOLS]"),"plain mode omits the model tool catalogue");
 equal(plain.turn.speech,responseContent,"plain mode returns provider response as user-facing speech without parsing tool-like tags");
 equal(plain.turn.tools,[],"tool-like tags in plain text never become executable tool calls");
 equal(plain.turn.situation,"","plain mode does not fabricate situation");
 equal(plain.turn.thoughts,"","plain mode does not fabricate private thoughts");
 equal(plain.turn.emotion,"","plain mode does not fabricate emotion");
 equal(plain.turn.toolResults,[],"plain mode does not fabricate tool results");
 equal(plain.turn.nextWakeMs,20,"plain mode uses the configured default interval clamped to schedule bounds");
 const savedMessagesBefore=JSON.stringify(messages);
 responseContent="[[NOVA_SILENT]]";
 const silent=await step.run({...context,wakeReason:"scheduled",userTurn:undefined});
 equal(silent.turn.speech,"","exact background sentinel becomes empty speech and is not displayed");
 equal(silent.turn.nextWakeMs,20,"silent turn also uses the bounded configured default interval");
 let reactiveSilentRejected=false;
 try{await step.run(context);}catch{reactiveSilentRejected=true;}
 equal(reactiveSilentRejected,true,"plain silent sentinel fails instead of satisfying a reactive user turn");
 equal(JSON.stringify(messages),savedMessagesBefore,"output mode changes do not mutate saved conversation messages");
 outputMode="structured";
 responseContent="free text must not become speech";
 const invalidStep=new LLMCognitiveStep({
  runtime:{...runtime,async chat(request:ChatRequest){return responseFor(request,responseContent);}},
  getCharacter:async()=>character,getActiveConversation:async()=>conversation,
  buildContext:async(request)=>({apiVersion:"1",schemaVersion:"1",characterId:request.characterId,conversationId:request.conversationId,messages:request.messages,includedCandidates:[],omittedCandidates:[],budget:request.budget,estimatedTokens:100} as AssembledContext),
  getContextBudget:()=>budget,getActiveProviderPresetId:()=>undefined,getChatModel:()=>"fake-model",getChatModelForPreset:async()=>"unused"
 });
 let rejected=false;try{await invalidStep.run({...context,wakeReason:"scheduled",userTurn:undefined});}catch{rejected=true;}
 equal(rejected,true,"structured mode rejects untagged text rather than exposing it as speech");
}

async function main(){
 await backgroundSchedulingAndSerializationTest();
 await userPriorityAndStaleCancellationTest();
 await reactiveSpeechFailureAndRetryTest();
 await toolsAndToolResultWakeTest();
 await lifeOffRejectsLateResponsesTest();
 await llmUsesTaggedProtocolAndPreservesContextTest();
 console.log("PASS unified NovaTurn runtime + LLM protocol tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
