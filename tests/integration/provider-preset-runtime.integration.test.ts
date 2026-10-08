import {createFoundationRuntime} from "../../runtime/bootstrap/src";
import type {ChatRequest,CredentialReference,CredentialStore,ProviderPreset} from "../../contracts/src";
import type {HttpClient,HttpClientRequest,HttpClientResponse} from "../../providers/chat/openai-compatible/src";

function equal(actual:unknown,expected:unknown,label:string){if(actual!==expected)throw new Error(label+" expected "+String(expected)+" got "+String(actual));}
function ok(value:unknown,label:string){if(!value)throw new Error(label);}

class FakeCredentialStore implements CredentialStore{
  private readonly secrets=new Map<string,string>([
    ["cred-primary","primary-secret"],
    ["cred-backup","backup-secret"],
    ["cred-gemini","gemini-secret"]
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
  sources:[
    source("primary","openai-compatible","https://primary.example/v1","cred-primary","primary-model"),
    source("backup","openai-compatible","https://backup.example/v1","cred-backup","backup-model")
  ],
  activeSourceId:"primary",
  createdAt:"2026-10-08T00:00:00Z",
  updatedAt:"2026-10-08T00:00:00Z"
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
    providerPresetPools:[preset],
    activeProviderPresetId:"preset-pool",
    onProviderPresetPoolStateChange:updated=>{persisted=updated;}
  });
  try{
    const response=await runtime.chat(request,"preset-pool");
    equal(response.message.content,"backup response","runtime routes providerPresetId through pool failover");
    equal(response.providerId,"openai-compatible","canonical response preserves concrete provider id");
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
    equal(result.providerId,"gemini","Gemini source remains the concrete provider");
  }finally{
    await geminiRuntime.stop();
  }

  console.log("PASS provider pool runtime integration tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1});
