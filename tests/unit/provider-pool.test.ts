import {ProviderPoolChatProvider} from "../../runtime/bootstrap/src/provider-pool";
import type {ChatProvider,ChatRequest,ChatResponse,CredentialReference,ProviderCapabilities,ProviderPreset,ProviderPresetSource,CredentialStore,DiagnosticsStore,HealthStatus,ChatError,ModelInfo} from "../../contracts/src";

function equal(actual:unknown,expected:unknown,label:string){if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(label+" expected "+JSON.stringify(expected)+" got "+JSON.stringify(actual));}
function ok(value:unknown,label:string){if(!value)throw new Error(label);}

class PoolFailure extends Error{
  readonly chatError:ChatError;
  constructor(category:"network"|"timeout"|"authentication"|"rate_limit"|"server"|"transport",httpStatus?:number){
    super("provider failure");
    this.chatError={apiVersion:"1",schemaVersion:"1",code:"PROVIDER_ERROR",message:"provider failure",retryable:true,details:{category,...(httpStatus===undefined?{}:{httpStatus})}};
  }
}
class FakeProvider implements ChatProvider{
  readonly id:string;
  readonly calls:{request:ChatRequest}[]=[];
  constructor(id:string,private readonly outcomes:readonly (ChatResponse|Error)[]){
    this.id=id;
  }
  metadata(){return {id:this.id,kind:"chat" as const,displayName:this.id,version:"test"};}
  capabilities():ProviderCapabilities{return {streaming:false,toolCalling:false,structuredOutput:false,reasoning:false};}
  async health():Promise<HealthStatus>{return {status:"healthy"};}
  async listModels():Promise<ModelInfo[]>{return [{id:this.id+"-model"}];}
  async chat(request:ChatRequest):Promise<ChatResponse>{
    this.calls.push({request});
    const outcome=this.outcomes[Math.min(this.calls.length-1,this.outcomes.length-1)];
    if(outcome instanceof Error)throw outcome;
    const base=outcome as ChatResponse;
    return {
      ...base,
      apiVersion:base.apiVersion??"1",
      schemaVersion:base.schemaVersion??"1",
      requestId:request.requestId,
      conversationId:request.context.conversationId,
      providerId:this.id,
      model:request.model,
      message:base.message??{role:"assistant",content:""},
      finishReason:base.finishReason??"stop"
    };
  }
}
class FakeCredentialStore implements CredentialStore{
  async getSecret(reference:CredentialReference){return "secret:"+reference.id;}
  async setSecret():Promise<void>{}
  async deleteSecret():Promise<void>{}
}
class FakeDiagnostics implements DiagnosticsStore{
  readonly entries:readonly unknown[]=[];
  recordError(_source:string,_code:string,_message:string,_metadata?:Record<string,unknown>):void{}
  recentErrors():readonly never[]{return [];}
}
const credential=(id:string,provider="openai-compatible"):CredentialReference=>({id,kind:"api-key",provider,version:"1"});
const source=(id:string,providerId="openai-compatible",enabled=true):ProviderPresetSource=>({
  id,name:id,providerId,baseUrl:"https://"+id+".example/v1",model:id+"-model",
  credentialReference:credential("cred-"+id,providerId),enabled,health:"healthy",failureCount:0,cooldownUntil:null,createdAt:"2026-10-08T00:00:00Z",updatedAt:"2026-10-08T00:00:00Z"
});
const preset=(sources:readonly ProviderPresetSource[],activeSourceId=sources[0]?.id??null):ProviderPreset=>({
  id:"pool-test",name:"Pool Test",sources,activeSourceId,createdAt:"2026-10-08T00:00:00Z",updatedAt:"2026-10-08T00:00:00Z"
});
const request=():ChatRequest=>({
  apiVersion:"1",schemaVersion:"1",requestId:"pool-request",model:"caller-model",
  context:{conversationId:"conversation-1",messages:[{role:"user",content:"hello"}]}
});
const response=(text:string):ChatResponse=>({
  apiVersion:"1",schemaVersion:"1",requestId:"x",conversationId:"conversation-1",providerId:"unused",model:"model",
  message:{role:"assistant",content:text},finishReason:"stop"
});

async function build(options:{sources:ProviderPresetSource[];activeSourceId?:string}){
  const providers=new Map<string,FakeProvider>();
  const state:ProviderPreset[]=[];
  const pool=new ProviderPoolChatProvider({
    preset:preset(options.sources,options.activeSourceId),
    credentialStore:new FakeCredentialStore(),
    diagnostics:new FakeDiagnostics(),
    createProvider:(source)=>{
      return providers.get(source.id);
    },
    onStateChanged:updated=>{state.push(updated);}
  });
  return {pool,providers,state};
}

async function main(){
  {
    const first=new FakeProvider("source-a",[response("a")]);
    const {pool,providers}=await build({sources:[source("source-a")]});
    providers.set("source-a",first);
    const result=await pool.chat(request());
    equal(result.message.content,"a","single source serves successfully");
    equal(first.calls[0]?.request.providerId,"openai-compatible","source provider id reaches provider");
  }

  {
    const first=new FakeProvider("source-a",[response("a")]);
    const second=new FakeProvider("source-b",[response("b")]);
    const {pool,providers}=await build({sources:[source("source-a"),source("source-b")]});
    providers.set("source-a",first);providers.set("source-b",second);
    const result=await pool.chat(request());
    equal(result.message.content,"a","two sources of the same provider are independently routable");
    equal(first.calls.length,1,"first source used once");
    equal(second.calls.length,0,"backup source is not used after success");
  }

  {
    const first=new FakeProvider("gemini-a",[response("gemini")]);
    const second=new FakeProvider("source-b",[response("openai")]);
    const {pool,providers}=await build({sources:[source("gemini-a","gemini"),source("source-b","openai-compatible")]});
    providers.set("gemini-a",first);providers.set("source-b",second);
    const result=await pool.chat(request());
    equal(result.message.content,"gemini","mixed-provider pool routes to its active provider");
  }

  for(const [category,status] of [["rate_limit",429],["server",500],["timeout",undefined],["authentication",401]] as const){
    const firstError=new PoolFailure(category,status);
    const first=new FakeProvider("source-a",[firstError]);
    const second=new FakeProvider("source-b",[response("backup")]);
    const {pool,providers}=await build({sources:[source("source-a"),source("source-b")]});
    providers.set("source-a",first);providers.set("source-b",second);
    const result=await pool.chat(request());
    equal(result.message.content,"backup",category+" source failure triggers failover");
    equal(second.calls.length,1,category+" uses next source");
  }

  {
    let captured:ProviderPreset|undefined;
    const first=new FakeProvider("source-a",[new PoolFailure("server",500)]);
    const second=new FakeProvider("source-b",[response("backup")]);
    const {pool,providers}=await build({sources:[source("source-a"),source("source-b")]});
    providers.set("source-a",first);providers.set("source-b",second);
    (pool as unknown as {options:{onStateChanged?:(preset:ProviderPreset)=>void}}).options.onStateChanged=updated=>{captured=updated;};
    const result=await pool.chat(request());
    equal(result.message.content,"backup","successful backup response is returned");
    equal(captured?.activeSourceId,"source-b","successful failover source becomes active");
    equal(captured?.sources.find(s=>s.id==="source-a")?.health,"cooldown","temporary failure enters cooldown");
  }

  {
    let calls=0;
    const first=new FakeProvider("source-a",[new PoolFailure("server",500)]);
    const second=new FakeProvider("source-b",[response("backup")]);
    const {pool,providers}=await build({sources:[source("source-a"),source("source-b")]});
    providers.set("source-a",first);providers.set("source-b",second);
    const response1=await pool.chat(request());
    const response2=await pool.chat({...request(),requestId:"pool-request-2"});
    calls=first.calls.length+second.calls.length;
    equal(response1.message.content,"backup","first request failover result");
    equal(response2.message.content,"backup","next request starts with new active source");
    equal(first.calls.length,1,"new active source prevents retrying the failed source");
    equal(calls,3,"each request uses one source after active source changes");
  }

  {
    const failing=new FakeProvider("source-a",[new PoolFailure("server",500)]);
    const {pool,providers}=await build({sources:[source("source-a"),source("source-b")]});
    providers.set("source-a",failing);
    let failed=false;
    try{await pool.chat(request());}catch(error){failed=error instanceof Error&&JSON.stringify(error).includes("provider_pool_exhausted");}
    ok(failed,"exhausted pool returns an aggregated error");
    equal(failing.calls.length,1,"one failing source is never retried within one request");
  }

  {
    const disabled=new FakeProvider("source-disabled",[response("disabled")]);
    const enabled=new FakeProvider("source-enabled",[response("enabled")]);
    const {pool,providers}=await build({sources:[source("source-disabled","openai-compatible",false),source("source-enabled")]});
    providers.set("source-disabled",disabled);providers.set("source-enabled",enabled);
    const result=await pool.chat(request());
    equal(result.message.content,"enabled","disabled source is skipped");
    equal(disabled.calls.length,0,"disabled source is never invoked");
  }

  {
    const first=new FakeProvider("source-a",[new PoolFailure("server",500),new PoolFailure("server",500)]);
    const second=new FakeProvider("source-b",[response("backup"),response("backup")]);
    const {pool,providers}=await build({sources:[source("source-a"),source("source-b")]});
    providers.set("source-a",first);providers.set("source-b",second);
    const [a,b]=await Promise.all([
      pool.chat({...request(),requestId:"parallel-a"}),
      pool.chat({...request(),requestId:"parallel-b"})
    ]);
    equal(a.message.content,"backup","parallel request A succeeds through failover");
    equal(b.message.content,"backup","parallel request B succeeds through failover");
    equal(first.calls.length,2,"parallel requests may independently use the same source");
    equal(second.calls.length,2,"parallel requests safely share the backup source");
    equal(pool.getPreset().activeSourceId,"source-b","concurrent failover keeps a valid active source");
  }

  {
    const first=new FakeProvider("source-a",[new PoolFailure("server",500)]);
    const second=new FakeProvider("source-b",[response("secret-safe")]);
    let persisted:ProviderPreset|undefined;
    const diagnostics=new FakeDiagnostics();
    const pool=new ProviderPoolChatProvider({
      preset:preset([source("source-a"),source("source-b")]),
      credentialStore:new FakeCredentialStore(),
      diagnostics,
      createProvider:source=>source.id==="source-a"?first:second,
      onStateChanged:updated=>{persisted=updated;}
    });
    await pool.chat(request());
    const serialized=JSON.stringify(persisted);
    ok(!serialized.includes("secret"),"persisted pool state contains no API secret");
  }

  {
    const provider=new FakeProvider("source-a",[new PoolFailure("authentication",401)]);
    const {pool,providers}=await build({sources:[source("source-a")]});
    providers.set("source-a",provider);
    let error:unknown;
    try{await pool.chat(request());}catch(value){error=value;}
    ok(error!==undefined,"authentication failure produces an aggregate error when pool is exhausted");
    equal(pool.getPreset().sources[0]?.health,"unavailable","401 marks source unavailable");
    equal(pool.getPreset().sources[0]?.cooldownUntil,null,"401 does not use cooldown retry");
  }

  console.log("PASS provider pool unit tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1});
