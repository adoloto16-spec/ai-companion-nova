import {AiRuntime,AiRuntimeError,InMemoryDiagnosticsStore,InMemoryEventBus,ProviderRegistry,createChatContext} from "../../core/src";
import {FakeChatProvider,FakeStreamingChatProvider} from "../../providers/mock/src";
import {CHAT_API_VERSION,CHAT_SCHEMA_VERSION,ChatRequest,STANDARD_SCHEMAS} from "../../contracts/src";

function ok(value:unknown,label:string){if(!value)throw new Error(label);}
function equal(actual:unknown,expected:unknown,label:string){if(actual!==expected)throw new Error(label+" expected "+String(expected)+" got "+String(actual));}
const makeRequest=(providerId?:string):ChatRequest=>({
  apiVersion:CHAT_API_VERSION,schemaVersion:CHAT_SCHEMA_VERSION,requestId:"req-"+(providerId??"auto"),
  ...(providerId?{providerId}:{}),model:"fake-chat",
  context:createChatContext({conversationId:"conv-1",messages:[{role:"user",content:"hello"}]})
});
async function jsonSchemaResponseFormatRuntimeTest(){
  class CapturingProvider extends FakeChatProvider{
    request?:ChatRequest;
    override async chat(request:ChatRequest):Promise<import("../../contracts/src").ChatResponse>{
      this.request=request;
      return super.chat(request);
    }
  }
  const provider=new CapturingProvider();
  const providers=new ProviderRegistry();
  const diagnostics=new InMemoryDiagnosticsStore();
  providers.register(provider,["chat"]);
  const runtime=new AiRuntime(providers,{diagnostics});
  const request:ChatRequest={
    apiVersion:"1",
    schemaVersion:"1",
    requestId:"test",
    model:"test-model",
    context:{
      conversationId:"test",
      messages:[
        {role:"system",content:"test"},
        {role:"user",content:"test"}
      ]
    },
    generation:{
      responseFormat:{
        type:"json-schema",
        schema:STANDARD_SCHEMAS["memory-judge-decision"]!,
        name:"memory-judge-decision",
        strict:true
      }
    }
  };
  let response:import("../../contracts/src").ChatResponse|undefined;
  let runtimeError:unknown;
  try{
    response=await runtime.generate(request);
  }catch(error){
    runtimeError=error;
  }
  ok(runtimeError===undefined,"AiRuntime accepts json-schema ChatRequest before provider invocation");
  ok(response!==undefined,"json-schema ChatRequest returns a provider response");
  ok(provider.request!==undefined,"mock provider receives validated json-schema request");
  equal(provider.request?.generation?.responseFormat?.type,"json-schema","provider receives responseFormat.type json-schema");
  equal(
    provider.request?.generation?.responseFormat?.type==="json-schema"
      ? provider.request.generation.responseFormat.schema
      : undefined,
    STANDARD_SCHEMAS["memory-judge-decision"],
    "provider receives the memory Judge response schema"
  );
  equal(
    diagnostics.recentErrors().some(error=>error.code==="INVALID_REQUEST"&&error.message==="Chat request failed contract validation."),
    false,
    "json-schema request does not produce contract validation failure"
  );
}

async function main(){
  await jsonSchemaResponseFormatRuntimeTest();
  const diagnostics=new InMemoryDiagnosticsStore(),events=new InMemoryEventBus(diagnostics),providers=new ProviderRegistry();
  providers.register(new FakeChatProvider(),["chat"]);
  const seen:string[]=[];
  events.subscribe("ChatRequestStarted",e=>{seen.push("started:"+e.id);});
  events.subscribe("ChatResponseReceived",e=>{seen.push("received:"+e.id);});
  const runtime=new AiRuntime(providers,{diagnostics,events});
  const response=await runtime.generate(makeRequest());
  equal(response.providerId,"fake.chat","provider selected");
  equal(response.message.content,"fake response","successful chat");
  equal(response.finishReason,"stop","finish reason");
  equal(seen.join(","),"started:req-auto:started,received:req-auto:received","chat events");
  let unknown=false;
  try{await runtime.generate(makeRequest("missing.provider"));}catch(error){unknown=error instanceof AiRuntimeError&&error.code==="PROVIDER_NOT_FOUND";}
  ok(unknown,"unknown provider normalized");
  let invalid=false;
  try{await runtime.generate({...makeRequest(),model:""});}catch(error){invalid=error instanceof AiRuntimeError&&error.code==="INVALID_REQUEST";}
  ok(invalid,"invalid request normalized");
  class FailingProvider extends FakeChatProvider{
    override async chat(_request:ChatRequest):Promise<import("../../contracts/src").ChatResponse>{throw new Error("simulated provider failure");}
  }
  const failingRegistry=new ProviderRegistry(),failingDiagnostics=new InMemoryDiagnosticsStore();
  failingRegistry.register(new FailingProvider(),["chat"]);
  const failingRuntime=new AiRuntime(failingRegistry,{diagnostics:failingDiagnostics});
  let failed=false;
  try{await failingRuntime.generate(makeRequest());}catch(error){failed=error instanceof AiRuntimeError&&error.code==="PROVIDER_ERROR";}
  ok(failed,"provider failure normalized");
  equal((await failingRuntime.health()).status,"healthy","runtime remains healthy after provider failure");
  equal(failingDiagnostics.recentErrors()[0]?.code,"PROVIDER_ERROR","provider failure diagnostic");
  class InvalidResponseProvider extends FakeChatProvider{
    override async chat(request:ChatRequest):Promise<import("../../contracts/src").ChatResponse>{return {...(await super.chat(request)),finishReason:"bad" as never};}
  }
  const invalidRegistry=new ProviderRegistry();
  invalidRegistry.register(new InvalidResponseProvider(),["chat"]);
  const invalidRuntime=new AiRuntime(invalidRegistry,{diagnostics:new InMemoryDiagnosticsStore()});
  let normalized=false;
  try{await invalidRuntime.generate(makeRequest());}catch(error){normalized=error instanceof AiRuntimeError&&error.code==="INVALID_RESPONSE";}
  ok(normalized,"provider response validation");
  const streamingRegistry=new ProviderRegistry();
  streamingRegistry.register(new FakeStreamingChatProvider(["delta-1","delta-2","delta-3"]),["chat"]);
  const streamingRuntime=new AiRuntime(streamingRegistry);
  const streamEvents:import("../../contracts/src").ChatStreamEvent[]=[];
  const streamedResponse=await streamingRuntime.stream(makeRequest(),{onEvent:event=>{streamEvents.push(event);}});
  equal(streamEvents.filter(event=>event.type==="delta").map(event=>event.type==="delta"?event.text:"").join("|"),"delta-1|delta-2|delta-3","stream deltas reach the runtime consumer");
  equal(streamEvents.some(event=>event.type==="completed"),true,"stream completion event reaches the runtime consumer");
  equal(streamedResponse.message.content,"delta-1delta-2delta-3","AiRuntime assembles streaming deltas");
  equal(streamedResponse.finishReason,"stop","stream finish reason");

  const fallbackRegistry=new ProviderRegistry();
  fallbackRegistry.register(new FakeChatProvider(),["chat"]);
  const fallbackRuntime=new AiRuntime(fallbackRegistry);
  const fallbackEvents:import("../../contracts/src").ChatStreamEvent[]=[];
  const fallbackResponse=await fallbackRuntime.stream(makeRequest(),{onEvent:event=>{fallbackEvents.push(event);}});
  equal(fallbackResponse.message.content,"fake response","non-streaming provider uses chat fallback");
  equal(fallbackEvents.filter(event=>event.type==="delta").length,1,"fallback emits one canonical delta");
  equal(fallbackEvents.filter(event=>event.type==="completed").length,1,"fallback emits one canonical completed event");

  let lifecycleStarted=0,lifecycleReceived=0;
  const lifecycleEvents=new InMemoryEventBus(new InMemoryDiagnosticsStore());
  lifecycleEvents.subscribe("ChatRequestStarted",()=>{lifecycleStarted++;});
  lifecycleEvents.subscribe("ChatResponseReceived",()=>{lifecycleReceived++;});
  const lifecycleRuntime=new AiRuntime(fallbackRegistry,{events:lifecycleEvents});
  await lifecycleRuntime.stream(makeRequest("fake.chat"),{onEvent:()=>{}});
  equal(lifecycleStarted,1,"stream fallback emits one request-start lifecycle event");
  equal(lifecycleReceived,1,"stream fallback emits one response-received lifecycle event");

  const abortController=new AbortController();
  abortController.abort();
  let aborted=false;
  try{
    await streamingRuntime.stream(makeRequest(),{onEvent:()=>{}},{signal:abortController.signal});
  }catch(error){aborted=error instanceof Error&&error.name==="AbortError";}
  ok(aborted,"AiRuntime propagates caller abort without provider-error normalization");

  console.log("PASS AI Runtime unit tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
