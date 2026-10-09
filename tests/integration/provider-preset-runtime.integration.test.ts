import {createFoundationRuntime} from "../../runtime/bootstrap/src";
import type {ChatRequest,CredentialReference,CredentialStore,ProviderPreset} from "../../contracts/src";
import type {HttpClient,HttpClientRequest,HttpClientResponse} from "../../providers/chat/openai-compatible/src";

function equal(actual:unknown,expected:unknown,label:string){if(actual!==expected)throw new Error(label+" expected "+String(expected)+" got "+String(actual));}
function ok(value:unknown,label:string){if(!value)throw new Error(label);}

class FakeCredentialStore implements CredentialStore{
  private readonly secrets=new Map<string,string>([
    ["cred-primary","primary-secret"],
    ["cred-backup","backup-secret"],
    ["cred-gemini","gemini-secret"],
    ["cred-single","single-secret"],
    ["cred-single-fail","single-fail-secret"]
  ]);
  async getSecret(reference:CredentialReference){return this.secrets.get(reference.id);}
  async setSecret(reference:CredentialReference,secret:string){this.secrets.set(reference.id,secret);}
  async deleteSecret(reference:CredentialReference){this.secrets.delete(reference.id);}
}
class FakeHttpClient implements HttpClient{
  readonly requests:HttpClientRequest[]=[];
  private primaryAttempts=0;
  async request(request:HttpClientRequest):Promise<HttpClientResponse>{
    this.requests.push(request);
    const url=request.url;
    if(request.method==="GET"){
      return {status:200,body:JSON.stringify({data:[{id:"discovered-model",displayName:"Discovered Model"}]})};
    }
    if(url.includes("single-fail.example")){
      return {status:401,body:JSON.stringify({error:{message:"invalid API key"}})};
    }
    if(url.includes("single.example")){
      return {status:200,body:JSON.stringify({
        id:"single-response",
        model:"single-model",
        choices:[{message:{role:"assistant",content:"single response"},finish_reason:"stop"}]
      })};
    }
    if(url.includes("primary.example")){
      this.primaryAttempts+=1;
      return {status:429,body:JSON.stringify({error:{message:"rate limit"}})};
    }
    if(url.includes("backup.example")){
      return {status:200,body:JSON.stringify({
        id:"backup-response",
        model:"backup-model",
        choices:[{message:{role:"assistant",content:"backup response"},finish_reason:"stop"}]
      })};
    }
    if(url.includes("gemini")){
      return {status:200,body:JSON.stringify({
        candidates:[{content:{role:"model",parts:[{text:"gemini response"}]},finishReason:"STOP"}],
        modelVersion:"gemini-test-model"
      })};
    }
    return {status:500,body:"unexpected"};
  }
}

const source=(id:string,providerId:string,baseUrl:string,credentialId:string,model:string)=>({
  id,
  name:id,
  providerId,
  baseUrl,
  model,
  credentialReference:{id:credentialId,kind:"api-key",provider:providerId,version:"1"},
  enabled:true,
  health:"healthy" as const,
  failureCount:0,
  cooldownUntil:null,
  timeoutMs:1000,
  createdAt:"2026-10-08T00:00:00Z",
  updatedAt:"2026-10-08T00:00:00Z"
});
const preset:ProviderPreset={
  id:"preset-pool",
  name:"Pool",
  type:"pool",
  sources:[
    source("primary","openai-compatible","https://primary.example/v1","cred-primary","primary-model"),
    source("backup","openai-compatible","https://backup.example/v1","cred-backup","backup-model")
  ],
  activeSourceId:"primary",
  createdAt:"2026-10-08T00:00:00Z",
  updatedAt:"2026-10-08T00:00:00Z"
};
const singlePreset:ProviderPreset={
  id:"preset-single",name:"Single",type:"single",sources:[],activeSourceId:null,
  providerId:"openai-compatible",baseUrl:"https://single.example/v1",model:"single-model",
  credentialReference:{id:"cred-single",kind:"api-key",provider:"openai-compatible",version:"1"},
  enabled:true,timeoutMs:1000,createdAt:"2026-10-08T00:00:00Z",updatedAt:"2026-10-08T00:00:00Z"
};
const failingSinglePreset:ProviderPreset={
  ...singlePreset,id:"preset-single-failed",name:"Single failing API",
  baseUrl:"https://single-fail.example/v1",
  credentialReference:{id:"cred-single-fail",kind:"api-key",provider:"openai-compatible",version:"1"}
};
const request:ChatRequest={
  apiVersion:"1",schemaVersion:"1",requestId:"pool-runtime-test",model:"caller-model",
  context:{conversationId:"conversation-1",messages:[{role:"user",content:"hello"}]}
};

async function main(){
  const http=new FakeHttpClient();
  const credentialStore=new FakeCredentialStore();
  let persisted:ProviderPreset|undefined;
  const runtime=await createFoundationRuntime({
    credentialStore,
    httpClient:http,
    providerPresetPools:[preset,singlePreset,failingSinglePreset],
    activeProviderPresetId:"preset-pool",
    onProviderPresetPoolStateChange:updated=>{persisted=updated;}
  });
  try{
    const response=await runtime.chat(request,"preset-pool");
    equal(response.message.content,"backup response","runtime routes providerPresetId through pool failover");
    equal(response.providerId,"provider-pool:preset-pool","canonical response exposes the stable provider pool id");
    ok(http.requests.some(item=>item.url==="https://primary.example/v1/chat/completions"),"primary source was attempted first");
    ok(http.requests.some(item=>item.url==="https://backup.example/v1/chat/completions"),"backup source was attempted after primary 429");

    const diagnostics=runtime.getChatProviderDiagnostics("preset-pool");
    equal(diagnostics.sourceId,"backup","successful backup becomes active source");
    equal(diagnostics.providerId,"openai-compatible","diagnostics identify concrete provider");
    equal(persisted?.activeSourceId,"backup","pool state callback exposes persisted active source");
    equal(persisted?.sources.find(source=>source.id==="primary")?.health,"cooldown","429 leaves primary source in cooldown");

    const before=http.requests.length;
    const second=await runtime.chat({...request,requestId:"pool-runtime-test-2"},"preset-pool");
    equal(second.message.content,"backup response","next request starts from the new active source");
    equal(http.requests.length,before+1,"active backup source handles next request without reusing primary");

    const beforeSingle=http.requests.length;
    const singleResponse=await runtime.chat({...request,requestId:"single-runtime-test"},"preset-single");
    equal(singleResponse.message.content,"single response","single preset routes to its only API configuration");
    equal(singleResponse.providerId,"openai-compatible","single response is not wrapped by ProviderPoolChatProvider");
    const singleRequests=http.requests.slice(beforeSingle);
    equal(singleRequests.filter(item=>item.method==="POST").length,1,"single preset makes one provider request");
    ok(singleRequests.every(item=>item.url.includes("single.example")),"single preset never calls pool sources or another API");
    const serializedSingle=JSON.stringify(singlePreset);
    ok(!serializedSingle.includes("single-secret"),"single preset configuration persists only the credential reference");
    const singleDiagnostics=JSON.stringify(runtime.getChatProviderDiagnostics("preset-single"));
    ok(!singleDiagnostics.includes("single-secret"),"single preset diagnostics do not expose credential values");

    const beforeFailure=http.requests.length;
    let singleFailureThrown=false;
    try{await runtime.chat({...request,requestId:"single-failure-test"},"preset-single-failed");}catch{singleFailureThrown=true;}
    ok(singleFailureThrown,"single-provider authentication failure is returned as an ordinary error");
    const failingRequests=http.requests.slice(beforeFailure).filter(item=>item.method==="POST");
    equal(failingRequests.length,1,"single failure is not retried against another API");
    ok(failingRequests.every(item=>item.url.includes("single-fail.example")),"single failure never switches to primary/backup pool sources");

    const model=await runtime.getChatModelForPreset("preset-pool");
    equal(model,"backup-model","pool model discovery resolves the active source model");
  }finally{
    await runtime.stop();
  }

  const geminiPreset:ProviderPreset={
    ...preset,
    id:"preset-mixed",
    name:"Mixed",
    sources:[
      source("gemini","gemini","https://generativelanguage.googleapis.com/v1beta","cred-gemini","gemini-test-model"),
      source("backup-openai","openai-compatible","https://backup.example/v1","cred-backup","backup-model")
    ],
    activeSourceId:"gemini"
  };
  const geminiRuntime=await createFoundationRuntime({
    credentialStore:new FakeCredentialStore(),
    httpClient:new FakeHttpClient(),
    providerPresetPools:[geminiPreset],
    activeProviderPresetId:"preset-mixed"
  });
  try{
    const result=await geminiRuntime.chat({...request,requestId:"mixed-provider"},"preset-mixed");
    equal(result.message.content,"gemini response","mixed provider pool can select Gemini");
    equal(result.providerId,"provider-pool:preset-mixed","mixed-provider response exposes the stable pool id");
  }finally{
    await geminiRuntime.stop();
  }

  console.log("PASS provider pool runtime integration tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1});
