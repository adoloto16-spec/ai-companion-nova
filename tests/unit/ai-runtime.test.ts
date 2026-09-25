import {AiRuntime,AiRuntimeError,InMemoryDiagnosticsStore,InMemoryEventBus,ProviderRegistry,createChatContext} from "../../core/src";
import {FakeChatProvider} from "../../providers/mock/src";
import {CHAT_API_VERSION,CHAT_SCHEMA_VERSION,ChatRequest} from "../../contracts/src";

function ok(value:unknown,label:string){if(!value)throw new Error(label);}
function equal(actual:unknown,expected:unknown,label:string){if(actual!==expected)throw new Error(label+" expected "+String(expected)+" got "+String(actual));}
const makeRequest=(providerId?:string):ChatRequest=>({
  apiVersion:CHAT_API_VERSION,schemaVersion:CHAT_SCHEMA_VERSION,requestId:"req-"+(providerId??"auto"),
  ...(providerId?{providerId}:{}),model:"fake-chat",
  context:createChatContext({conversationId:"conv-1",messages:[{role:"user",content:"hello"}]})
});
async function main(){
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
  console.log("PASS AI Runtime unit tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
