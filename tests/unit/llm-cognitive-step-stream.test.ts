import {LLMCognitiveStep} from "../../core/src/llm-cognitive-step";
import type {CognitiveStepContext} from "../../core/src/mind-runtime";
import type {AssembledContext,Character,ChatMessage,ChatRequest,ChatResponse,ChatStreamHandlers,ChatStreamOptions,Conversation} from "../../contracts/src";
import {serializeNovaTurn} from "../../contracts/src";
import type {NovaTurn} from "../../contracts/src/nova-turn";

function equal(actual:unknown,expected:unknown,label:string):void{
  if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(label+" expected "+JSON.stringify(expected)+" got "+JSON.stringify(actual));
}
function ok(value:unknown,label:string):void{if(!value)throw new Error(label);}
function responseFor(request:ChatRequest,content:string):ChatResponse{
  return {apiVersion:"1",schemaVersion:"1",requestId:request.requestId,conversationId:request.context.conversationId,providerId:"fake.stream",model:request.model,message:{role:"assistant",content},finishReason:"stop"};
}
const character={id:"character.stream",name:"Nova",description:"Test character"} as Character;
const userMessage:ChatMessage={id:"user-message",role:"user",content:"Remember my preference.",metadata:{source:"conversation"}};
const conversation={id:"conversation.stream",characterId:"character.stream",messages:[userMessage]} as unknown as Conversation;
const budget={availableContextTokens:4096,reservedOutputTokens:1024,systemOverheadTokens:0,safetyMarginTokens:128};
const schedule={mode:"adaptive" as const,defaultIntervalMs:30000,minIntervalMs:3000,maxIntervalMs:300000,maxRequestsPerHour:null};
function context(onSpeechEvent:CognitiveStepContext["onSpeechEvent"]):CognitiveStepContext{
  return {characterId:character.id,state:{lifecycleState:"thinking",nextWakeAt:null,recentTrace:[]},signal:new AbortController().signal,wakeReason:"user-message",
    userTurn:{characterId:character.id,conversationId:conversation.id,userMessageId:userMessage.id,turnId:"turn.stream"},onSpeechEvent};
}
function createStep(runtime:unknown,mode:"structured"|"plain"="structured"):LLMCognitiveStep{
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
    getOutputMode:()=>mode,
    getAvailableTools:()=>[{name:"read_memory",description:"Search saved character memory",parameters:{type:"object"}}]
  });
}
function delta(request:ChatRequest,text:string){
  return {apiVersion:"1" as const,schemaVersion:"1",requestId:request.requestId,conversationId:request.context.conversationId,providerId:"fake.stream",model:request.model,type:"delta" as const,text};
}
function turnJson(speech:string):string{
  return JSON.stringify({speech,version:1,situation:"situation-private",thoughts:"thoughts-private",emotion:"emotion-private",
    tools:[{name:"read_memory",arguments:{query:"favorite color"}}],longMemory:"Prefers deep blue.",nextWakeMs:45000});
}
function taggedTurn(speech:string):string{
  return serializeNovaTurn({version:1,situation:"private situation",thoughts:"private thoughts",emotion:"private emotion",tools:[],toolResults:[],speech,longMemory:"",nextWakeMs:45000} satisfies NovaTurn);
}

async function nativeSchemaStreamsBeforeCompletion():Promise<void>{
  const payload=turnJson("The answer is arriving while the model is still generating the rest.");
  const cut=payload.indexOf("The answer is arriving")+12;
  let firstChunkSeen!:()=>void;
  const firstChunk=new Promise<void>(resolve=>{firstChunkSeen=resolve;});
  let resume!:()=>void;
  const held=new Promise<void>(resolve=>{resume=resolve;});
  const calls:ChatRequest[]=[];
  let returned=false;
  const runtime={
    getChatProviderCapabilities:()=>({structuredOutput:true,streaming:true}),
    getActiveProviderPresetId:()=>undefined,getChatModel:()=>"fake-model",
    async getChatModelForPreset(){return "unused";},
    async chat(request:ChatRequest){calls.push(request);return responseFor(request,payload);},
    async stream(request:ChatRequest,handlers:ChatStreamHandlers,_options?:ChatStreamOptions){
      calls.push(request);
      await handlers.onEvent(delta(request,payload.slice(0,cut)));
      firstChunkSeen();
      await held;
      await handlers.onEvent(delta(request,payload.slice(cut)));
      returned=true;
      return responseFor(request,payload);
    }
  };
  let visible="";
  const run=createStep(runtime).run(context(event=>{if(event.type==="delta")visible+=event.text??"";}));
  await firstChunk;
  ok(visible.length>0,"public speech is visible before stream completion");
  ok(visible.length<payload.length,"raw JSON was not sent as visible text");
  equal(returned,false,"provider stream has not returned when partial speech appears");
  equal(calls[0]?.generation?.responseFormat?.type,"json-schema","structured mode sends JSON Schema to primary provider");
  equal(calls[0]?.generation?.responseFormat?.name,"nova_turn_v1","native schema uses a stable name");
  ok(Boolean(calls[0]?.generation?.responseFormat?.type==="json-schema"&&calls[0].generation.responseFormat.schema.properties?.speech),"schema defines the canonical speech field");
  resume();
  const result=await run;
  equal(visible,"The answer is arriving while the model is still generating the rest.","streamed native output is only SPEECH and has no duplicated final text");
  equal(result.turn.situation,"situation-private","native JSON preserves situation");
  equal(result.turn.thoughts,"thoughts-private","native JSON preserves thoughts");
  equal(result.turn.emotion,"emotion-private","native JSON preserves emotion");
  equal(result.turn.longMemory,"Prefers deep blue.","native JSON preserves LONGMEMORY candidate");
  equal(result.turn.tools,[{name:"read_memory",arguments:{query:"favorite color"}}],"native JSON preserves tool requests");
  equal(result.turn.toolResults,[],"tool results are application-owned, never read from model JSON");
}
async function explicitUnsupportedUsesOnlyOneTaggedFallback():Promise<void>{
  const calls:ChatRequest[]=[];
  let count=0;
  const response=taggedTurn("Fallback speech is streamed, not parsed as JSON.");
  const runtime={
    getChatProviderCapabilities:()=>({structuredOutput:true,streaming:true}),
    getActiveProviderPresetId:()=>undefined,getChatModel:()=>"fake-model",
    async getChatModelForPreset(){return "unused";},
    async chat(request:ChatRequest){calls.push(request);return responseFor(request,response);},
    async stream(request:ChatRequest,handlers:ChatStreamHandlers,_options?:ChatStreamOptions){
      calls.push(request);count++;
      if(count===1)throw new Error("JSON Schema response format is not supported");
      for(let i=0;i<response.length;i+=13)await handlers.onEvent(delta(request,response.slice(i,i+13)));
      return responseFor(request,response);
    }
  };
  let visible="";
  const result=await createStep(runtime).run(context(event=>{if(event.type==="delta")visible+=event.text??"";}));
  equal(calls.length,2,"explicit unsupported schema causes one and only one tagged retry");
  equal(calls[0]?.generation?.responseFormat?.type,"json-schema","first request uses native JSON Schema");
  equal(calls[1]?.generation?.responseFormat?.type,"text","fallback request uses tagged text protocol");
  equal(result.turn.speech,"Fallback speech is streamed, not parsed as JSON.","tag fallback validates final protocol");
  equal(visible,result.turn.speech,"tag fallback streams only speech without final duplication");
}
async function ordinaryErrorsAndMalformedJsonNeverFallback():Promise<void>{
  for(const failure of ["timeout","network","auth","invalid-json"] as const){
    const calls:ChatRequest[]=[];
    const runtime={
      getChatProviderCapabilities:()=>({structuredOutput:true,streaming:true}),
      getActiveProviderPresetId:()=>undefined,getChatModel:()=>"fake-model",
      async getChatModelForPreset(){return "unused";},
      async chat(request:ChatRequest){calls.push(request);return responseFor(request,"");},
      async stream(request:ChatRequest,handlers:ChatStreamHandlers,_options?:ChatStreamOptions){
        calls.push(request);
        if(failure==="timeout")throw new Error("request timed out");
        if(failure==="network")throw new Error("network connection refused");
        if(failure==="auth")throw Object.assign(new Error("unauthorized"),{chatError:{message:"Unauthorized",details:{category:"authorization"}}});
        const content='{"speech":"unterminated';
        await handlers.onEvent(delta(request,content));
        return responseFor(request,content);
      }
    };
    let rejected=false;
    try{await createStep(runtime).run(context(()=>{}));}catch{rejected=true;}
    ok(rejected,failure+" failure rejects the turn");
    equal(calls.length,1,failure+" never triggers a format fallback");
    equal(calls[0]?.generation?.responseFormat?.type,"json-schema",failure+" keeps the attempted format as native JSON Schema");
  }
}
async function plainModeIsOrdinaryText():Promise<void>{
  const calls:ChatRequest[]=[];
  const text="This is plain text that includes <SPEECH> and \"quotes\" literally.";
  const runtime={
    getChatProviderCapabilities:()=>({structuredOutput:true,streaming:true}),
    getActiveProviderPresetId:()=>undefined,getChatModel:()=>"fake-model",
    async getChatModelForPreset(){return "unused";},
    async chat(request:ChatRequest){calls.push(request);return responseFor(request,text);},
    async stream(request:ChatRequest,handlers:ChatStreamHandlers,_options?:ChatStreamOptions){
      calls.push(request);await handlers.onEvent(delta(request,text));return responseFor(request,text);
    }
  };
  const result=await createStep(runtime,"plain").run(context(()=>{}));
  equal(calls.length,1,"plain mode uses one request");
  equal(calls[0]?.generation?.responseFormat,undefined,"plain mode sends no JSON Schema or mandatory text format");
  equal(result.turn.speech,text,"plain mode displays response as-is without protocol parsing");
}
async function main():Promise<void>{
  await nativeSchemaStreamsBeforeCompletion();
  await explicitUnsupportedUsesOnlyOneTaggedFallback();
  await ordinaryErrorsAndMalformedJsonNeverFallback();
  await plainModeIsOrdinaryText();
  console.log("PASS native JSON Schema, fallback, and streaming cognitive-step tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
