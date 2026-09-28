import {createFoundationRuntime} from "../../runtime/bootstrap/src";
import type {CredentialReference,CredentialStore,HttpClientResponse,ProviderConfiguration} from "../../contracts/src";
import {OPENAI_COMPATIBLE_PROVIDER_ID,type HttpClient,HttpClientRequest} from "../../providers/chat/openai-compatible/src";

function equal(actual:unknown,expected:unknown,label:string){if(actual!==expected)throw new Error(label+" expected "+String(expected)+" got "+String(actual));}
function ok(value:unknown,label:string){if(!value)throw new Error(label);}

class FakeCredentialStore implements CredentialStore{
  private readonly secrets=new Map<string,string>([["cred-mistral","mistral-secret"],["cred-groq","groq-secret"]]);
  async getSecret(reference:CredentialReference){return this.secrets.get(reference.id);}
  async setSecret(reference:CredentialReference,secret:string){this.secrets.set(reference.id,secret);}
  async deleteSecret(reference:CredentialReference){this.secrets.delete(reference.id);}
  async exists(reference:CredentialReference){return this.secrets.has(reference.id);}
}
class FakeHttpClient implements HttpClient{
  readonly requests:HttpClientRequest[]=[];
  async request(request:HttpClientRequest):Promise<HttpClientResponse>{
    this.requests.push(request);
    if(request.method==="GET")return {status:200,body:JSON.stringify({data:[{id:"discovered-a",displayName:"Discovered A"},{id:"discovered-b"}]})};
    const url=request.url;
    return {status:200,body:JSON.stringify({id:"chat",model:url.includes("groq")?"groq-model":"mistral-model",choices:[{message:{role:"assistant",content:url.includes("groq")?"groq response":"mistral response"},finish_reason:"stop"}]})};
  }
}
const credential=(id:string):CredentialReference=>({id,kind:"api-key",provider:"openai-compatible",version:"1"});
const config=(baseUrl:string,model:string,credentialId:string):ProviderConfiguration=>({
  apiVersion:"1",schemaVersion:"1",providerId:OPENAI_COMPATIBLE_PROVIDER_ID,enabled:true,baseUrl,model,credentialReference:credential(credentialId),timeoutMs:1000
});

async function main(){
  const http=new FakeHttpClient();
  const credentialStore=new FakeCredentialStore();
  const runtime=await createFoundationRuntime({
    credentialStore,
    httpClient:http,
    providerPresetConfigurations:[
      {presetId:"mistral",configuration:config("https://mistral.example/v1","mistral-model","cred-mistral")},
      {presetId:"groq",configuration:config("https://groq.example/openai/v1","groq-model","cred-groq")}
    ],
    activeProviderPresetId:"mistral"
  });
  const baseRequest={
    apiVersion:"1",schemaVersion:"1",requestId:"preset-runtime-test",model:"mistral-model",
    context:{conversationId:"conversation-1",messages:[{role:"user" as const,content:"hello"}]}
  };
  try{
    const mistral=await runtime.chat(baseRequest,"mistral");
    equal(mistral.providerId,OPENAI_COMPATIBLE_PROVIDER_ID,"Mistral preset uses existing OpenAI-compatible provider");
    equal(mistral.message.content,"mistral response","Mistral preset routes to its connection");

    const groq=await runtime.chat({...baseRequest,requestId:"preset-runtime-groq",model:"custom-groq-model"},"groq");
    equal(groq.message.content,"groq response","Groq preset routes without changing ProviderRegistry");

    equal(await runtime.getChatModelForPreset("mistral"),"discovered-a","model discovery uses GET /models");
    equal(await runtime.getChatModelForPreset("groq"),"discovered-a","model discovery works for second preset");
    ok(http.requests.some(request=>request.method==="GET"&&request.url==="https://mistral.example/v1/models"),"GET /models emitted for Mistral");
    ok(http.requests.some(request=>request.method==="GET"&&request.url==="https://groq.example/openai/v1/models"),"GET /models emitted for Groq");

    const active=runtime.getActiveProviderPresetId();
    equal(active,"mistral","active preset is exposed to chat composition");

  }finally{await runtime.stop();}
  console.log("PASS provider preset runtime switching and discovery tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1});
