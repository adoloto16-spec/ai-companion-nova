import {LLMCognitiveStep,type LLMCognitiveStepOptions} from "../../core/src/llm-cognitive-step";
import type {CognitiveStepContext} from "../../core/src/mind-runtime";
import type {AssembledContext,Character,ChatMessage,ChatRequest,ChatResponse,ChatStreamHandlers,ChatStreamOptions,Conversation,ChatStreamEvent} from "../../contracts/src";

function equal(actual:unknown,expected:unknown,label:string):void{
  if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(label+" expected "+JSON.stringify(expected)+" got "+JSON.stringify(actual));
}
function ok(value:unknown,label:string):void{if(!value)throw new Error(label);}
function responseFor(request:ChatRequest,content:string):ChatResponse{
  return {apiVersion:"1",schemaVersion:"1",requestId:request.requestId,conversationId:request.context.conversationId,providerId:"fake.stream",model:request.model??"fake-model",message:{role:"assistant",content},finishReason:"stop"};
}
const character={id:"character.stream",name:"Nova",description:"Test character"} as Character;
const userMessage:ChatMessage={id:"user-message",role:"user",content:"Remember my preference.",metadata:{source:"conversation"}};
const conversation={id:"conversation.stream",characterId:"character.stream",messages:[userMessage]} as unknown as Conversation;
const budget={availableContextTokens:4096,reservedOutputTokens:1024,systemOverheadTokens:0,safetyMarginTokens:128};
const schedule={mode:"adaptive" as const,defaultIntervalMs:30000,minIntervalMs:3000,maxIntervalMs:300000,maxRequestsPerHour:null};
function context(onSpeechEvent:CognitiveStepContext["onSpeechEvent"]):CognitiveStepContext{
  return {characterId:character.id,state:{lifecycleState:"thinking",nextWakeAt:null,recentTrace:[]},signal:new AbortController().signal,wakeReason:"user-message",
    userTurn:{characterId:character.id,conversationId:conversation.id,userMessageId:userMessage.id!,turnId:"turn.stream"},onSpeechEvent};
}
function createStep(runtime:unknown,getPrompt?:(id:import("../../contracts/src").PromptId)=>string,overrides:Partial<Pick<LLMCognitiveStepOptions,"getAvailableTools"|"executeTool"|"getReasoningOptions"|"getShowReasoningInDiagnostics">>={}):LLMCognitiveStep{
  return new LLMCognitiveStep({
    runtime:runtime as never,
    getCharacter:async()=>character,
    getActiveConversation:async()=>conversation,
    buildContext:async(request)=>({apiVersion:"1",schemaVersion:"1",characterId:request.characterId,conversationId:request.conversationId,messages:request.messages,includedCandidates:[],omittedCandidates:[],budget:request.budget,estimatedTokens:100} as AssembledContext),
    getContextBudget:()=>budget,
    getActiveProviderPresetId:()=>undefined,
    getChatModel:()=>"fake-model",
    getChatModelForPreset:async()=>"unused",
    getCognitiveSchedule:()=>schedule,
    getAvailableTools:()=>[{name:"read_memory",description:"Search saved character memory",parameters:{type:"object"}}],
    getReasoningOptions:()=>({mode:"provider-default"}),
    getShowReasoningInDiagnostics:()=>true,
    ...overrides,
    ...(getPrompt?{getPrompt}:{}),
  });
}
function event(request:ChatRequest,type:"delta"|"reasoning",text:string):ChatStreamEvent{
  return {apiVersion:"1",schemaVersion:"1",requestId:request.requestId,conversationId:request.context.conversationId,providerId:"fake.stream",model:request.model,type,text} as ChatStreamEvent;
}

async function ordinaryTextStreamsSeparatelyFromReasoning():Promise<void>{
  const text="The answer is arriving while the model is still generating the rest.";
  const cut=23;
  let firstChunkSeen!:()=>void;
  const firstChunk=new Promise<void>(resolve=>{firstChunkSeen=resolve;});
  let resume!:()=>void;
  const held=new Promise<void>(resolve=>{resume=resolve;});
  const calls:ChatRequest[]=[];
  let returned=false;
  const runtime={
    getChatProviderCapabilities:()=>({toolCalling:false,streaming:true}),
    getActiveProviderPresetId:()=>undefined,getChatModel:()=>"fake-model",
    async getChatModelForPreset(){return "unused";},
    async chat(request:ChatRequest){calls.push(request);return responseFor(request,text);},
    async stream(request:ChatRequest,handlers:ChatStreamHandlers,_options?:ChatStreamOptions){
      calls.push(request);
      await handlers.onEvent(event(request,"reasoning","Provider-only reasoning"));
      await handlers.onEvent(event(request,"delta",text.slice(0,cut)));
      firstChunkSeen();
      await held;
      await handlers.onEvent(event(request,"delta",text.slice(cut)));
      returned=true;
      return responseFor(request,text);
    }
  };
  let visible="";
  const speechEvents:Array<{type:string;text?:string}>=[];
  const run=createStep(runtime,id=>"CUSTOM PROMPT: "+id).run(context(item=>{
    speechEvents.push({type:item.type,...(item.text===undefined?{}:{text:item.text})});
    if(item.type==="delta")visible+=item.text??"";
  }));
  await firstChunk;
  ok(visible.length>0,"ordinary provider text is visible before stream completion");
  ok(visible.length<text.length,"text continues to stream incrementally");
  equal(returned,false,"provider stream is still open when the first speech delta arrives");
  equal(calls[0]?.generation?.responseFormat,undefined,"native cognition does not request mandatory JSON Schema");
  equal(calls[0]?.context.messages.find(message=>message.role==="system")?.content,"CUSTOM PROMPT: nova-system-plain","native cognition uses the ordinary-text system prompt");
  equal(calls[0]?.context.messages.find(message=>message.id?.endsWith(":user-cue"))?.content,"CUSTOM PROMPT: nova-cue-reactive-plain","native cognition uses the ordinary reactive cue");
  ok(!speechEvents.some(item=>item.text?.includes("Provider-only reasoning")),"provider reasoning is never forwarded to speech or TTS events");
  resume();
  const result=await run;
  equal(visible,text,"streamed assistant content has no duplicate final append");
  equal(result.turn.speech,text,"ordinary provider content is the canonical user-facing reply");
  equal(result.turn.situation,"","native reply does not require legacy situation");
  equal(result.turn.thoughts,"","native reply does not fabricate private thoughts");
  equal(result.turn.emotion,"","emotion remains optional and is not inferred from reasoning");
  equal(result.turn.longMemory,undefined,"long-term memory is not extracted from the model's text");
  equal(result.reasoning,"Provider-only reasoning","reasoning is returned separately for opt-in technical diagnostics");
}

async function nativeToolRoundsReturnResultsBeforeFinalSpeech():Promise<void>{
  const calls:ChatRequest[]=[];
  const executed:string[]=[];
  const runtime={
    getChatProviderCapabilities:()=>({toolCalling:true,streaming:true}),
    getActiveProviderPresetId:()=>undefined,getChatModel:()=>"fake-model",
    async getChatModelForPreset(){return "unused";},
    async chat(request:ChatRequest){calls.push(request);return responseFor(request,"unexpected non-stream response");},
    async stream(request:ChatRequest,handlers:ChatStreamHandlers,_options?:ChatStreamOptions){
      calls.push(request);
      if(calls.length===1){
        await handlers.onEvent(event(request,"reasoning","Selecting a memory lookup"));
        return {...responseFor(request,""),message:{role:"assistant",content:"",toolCalls:[{id:"memory-call-1",name:"read_memory",arguments:{query:"favorite color"}}]}};
      }
      const text="I found the saved preference: deep blue.";
      await handlers.onEvent(event(request,"reasoning","Summarizing the retrieved result"));
      for(let i=0;i<text.length;i+=7)await handlers.onEvent(event(request,"delta",text.slice(i,i+7)));
      return responseFor(request,text);
    }
  };
  const step=createStep(runtime,undefined,{
    getAvailableTools:()=>[{name:"read_memory",description:"Search saved character memory",parameters:{type:"object",properties:{query:{type:"string"}},required:["query"]}}],
    executeTool:async(call,toolContext)=>{
      executed.push(call.name);
      return {callId:toolContext.callId,name:call.name,status:"success" as const,output:{matches:["Prefers deep blue."]}};
    }
  });
  let visible="";
  const result=await step.run(context(item=>{if(item.type==="delta")visible+=item.text??"";}));
  equal(calls.length,2,"runtime requests a continuation after native tool execution");
  equal(calls[0]?.tools?.map(tool=>tool.name),["read_memory"],"only registered tools are advertised to the model");
  equal(calls[0]?.generation?.responseFormat,undefined,"tool-capable request still uses the native provider response format");
  equal(executed,["read_memory"],"registered native function executes exactly once");
  ok(calls[1]?.context.messages.some(message=>message.role==="assistant"&&message.toolCalls?.[0]?.id==="memory-call-1"),"assistant tool call is preserved in provider history");
  ok(calls[1]?.context.messages.some(message=>message.role==="tool"&&message.toolCallId==="memory-call-1"&&message.toolName==="read_memory"&&message.content.includes("Prefers deep blue.")),"tool output returns to the model in a separate role=tool message");
  equal(visible,"I found the saved preference: deep blue.","only final assistant text becomes user-facing speech");
  equal(result.turn.speech,visible,"final speech exactly matches streamed output");
  equal(result.reasoning,"Selecting a memory lookupSummarizing the retrieved result","provider reasoning from each round is kept separate");
}

async function plainContentIsNeverParsedAsCommands():Promise<void>{
  const calls:ChatRequest[]=[];
  const text='This is literal text containing <browser.navigate>{"url":"https://example.invalid"}</browser.navigate> and {"thoughts":"not a field"}.';
  const runtime={
    getChatProviderCapabilities:()=>({toolCalling:false,streaming:true}),
    getActiveProviderPresetId:()=>undefined,getChatModel:()=>"fake-model",
    async getChatModelForPreset(){return "unused";},
    async chat(request:ChatRequest){calls.push(request);return responseFor(request,text);},
    async stream(request:ChatRequest,handlers:ChatStreamHandlers,_options?:ChatStreamOptions){
      calls.push(request);await handlers.onEvent(event(request,"delta",text));return responseFor(request,text);
    }
  };
  const result=await createStep(runtime).run(context(()=>{}));
  equal(calls.length,1,"ordinary reply requires one native request");
  equal(result.turn.speech,text,"model content is shown verbatim without tagged-JSON parsing");
  equal(result.turn.tools,[],"tool-like text is never executable");
  equal(result.turn.thoughts,"","private thoughts are not extracted from user-visible text");
  equal(calls[0]?.generation?.responseFormat,undefined,"no structured protocol is mandatory");
}

async function failuresDoNotTriggerFormatFallback():Promise<void>{
  let calls=0;
  const runtime={
    getChatProviderCapabilities:()=>({toolCalling:false,streaming:true}),
    getActiveProviderPresetId:()=>undefined,getChatModel:()=>"fake-model",
    async getChatModelForPreset(){return "unused";},
    async chat(request:ChatRequest){calls++;return responseFor(request,"");},
    async stream(_request:ChatRequest,_handlers:ChatStreamHandlers,_options?:ChatStreamOptions){calls++;throw new Error("network connection refused");}
  };
  let rejected=false;
  try{await createStep(runtime).run(context(()=>{}));}catch{rejected=true;}
  equal(rejected,true,"provider network failure rejects the cognitive turn");
  equal(calls,1,"failed native request is not retried with a different generated protocol");
}

async function backgroundStepMayReturnNoSpeech():Promise<void>{
  const requestList:ChatRequest[]=[];
  const runtime={
    getChatProviderCapabilities:()=>({toolCalling:false,streaming:true}),
    getActiveProviderPresetId:()=>undefined,getChatModel:()=>"fake-model",
    async getChatModelForPreset(){return "unused";},
    async chat(request:ChatRequest){requestList.push(request);return responseFor(request,"");},
    async stream(request:ChatRequest,handlers:ChatStreamHandlers,_options?:ChatStreamOptions){requestList.push(request);return responseFor(request,"");}
  };
  const base=context(()=>{});
  const background={characterId:base.characterId,state:base.state,signal:base.signal,wakeReason:"life-start" as const};
  const result=await createStep(runtime).run(background);
  equal(result.turn.speech,"","background step may complete without inventing a user-facing message");
  equal(result.turn.nextWakeMs,30000,"background wake uses the configured bounded default interval");
  equal(requestList[0]?.generation?.responseFormat,undefined,"background requests use the same native plain response contract");
  equal(requestList[0]?.context.messages.find(message=>message.id?.endsWith(":user-cue"))?.content.includes("Do not invent a reason to speak"),true,"background prompt explicitly permits silence");
}

async function main():Promise<void>{
  await ordinaryTextStreamsSeparatelyFromReasoning();
  await nativeToolRoundsReturnResultsBeforeFinalSpeech();
  await plainContentIsNeverParsedAsCommands();
  await failuresDoNotTriggerFormatFallback();
  await backgroundStepMayReturnNoSpeech();
  console.log("PASS native cognitive text, tool-call, reasoning, and streaming tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
