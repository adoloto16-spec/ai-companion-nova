import {GeminiChatProvider,GEMINI_PROVIDER_ID,type HttpClient,HttpClientRequest,HttpClientResponse} from "../../providers/chat/gemini/src";
import type {ChatRequest,CredentialReference,CredentialStore,ProviderCapabilities} from "../../contracts/src";

function equal(actual:unknown,expected:unknown,label:string){if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(label+" expected "+JSON.stringify(expected)+" got "+JSON.stringify(actual));}
function ok(value:unknown,label:string){if(!value)throw new Error(label);}

class FakeCredentialStore implements CredentialStore{
  readonly secret="gemini-test-secret";
  async getSecret(reference:CredentialReference){return reference.id==="gemini-credential"?this.secret:undefined;}
  async setSecret():Promise<void>{}
  async deleteSecret():Promise<void>{}
}
class FakeHttpClient implements HttpClient{
  readonly requests:HttpClientRequest[]=[];
  readonly responses:HttpClientResponse[];
  constructor(responses:HttpClientResponse[]){this.responses=responses;}
  async request(request:HttpClientRequest):Promise<HttpClientResponse>{
    this.requests.push(request);
    const next=this.responses.shift();
    if(!next)throw new Error("No fake HTTP response configured.");
    return next;
  }
}
const credential:CredentialReference={id:"gemini-credential",kind:"api-key",provider:"gemini",version:"1"};
const request:ChatRequest={
  apiVersion:"1",schemaVersion:"1",requestId:"gemini-request",model:"gemini-test-model",
  context:{
    conversationId:"conversation-gemini",
    messages:[
      {role:"system",content:"You are Nova."},
      {role:"user",content:"Hello."},
      {role:"assistant",content:"Hi."},
      {role:"user",content:"Continue."}
    ]
  },
  generation:{temperature:0.7,maxTokens:128,topP:0.9}
};

async function main(){
  {
    const http=new FakeHttpClient([{status:200,body:JSON.stringify({
      candidates:[{
        content:{role:"model",parts:[{text:"Gemini response"}]},
        finishReason:"STOP"
      }],
      modelVersion:"gemini-test-model",
      usageMetadata:{promptTokenCount:10,candidatesTokenCount:5,totalTokenCount:15}
    })}]);
    const provider=new GeminiChatProvider({
      baseUrl:"https://generativelanguage.googleapis.com/v1beta",
      model:"gemini-test-model",
      credential,
      timeoutMs:1000
    },new FakeCredentialStore(),http);
    const response=await provider.chat(request);
    equal(response.providerId,GEMINI_PROVIDER_ID,"Gemini response provider id is canonical");
    equal(response.message.content,"Gemini response","Gemini response text is mapped");
    equal(response.finishReason,"stop","Gemini STOP finish reason maps to canonical stop");
    equal(response.usage?.totalTokens,15,"Gemini usage metadata maps to canonical usage");
    const sent=http.requests[0]!;
    ok(sent.url.endsWith("/models/gemini-test-model:generateContent"),"Gemini generateContent endpoint is correct");
    equal(sent.headers["x-goog-api-key"],"gemini-test-secret","Gemini API key uses x-goog-api-key");
    ok(!sent.url.includes("gemini-test-secret"),"Gemini secret is never placed in URL");
    const body=JSON.parse(sent.body??"{}") as Record<string,unknown>;
    const systemInstruction=body.systemInstruction as {parts:Array<{text:string}>};
    equal(systemInstruction.parts[0]?.text,"You are Nova.","system message maps to systemInstruction");
    const contents=body.contents as Array<{role:string;parts:Array<{text:string}>}>;
    equal(contents.map(item=>item.role).join(","),"user,model,user","user/assistant history maps to user/model roles");
    const generationConfig=body.generationConfig as Record<string,unknown>;
    equal(generationConfig.temperature,0.7,"temperature maps to Gemini generationConfig");
    equal(generationConfig.maxOutputTokens,128,"maxTokens maps to maxOutputTokens");
    equal(generationConfig.topP,0.9,"topP maps to Gemini generationConfig");
  }

  {
    const http=new FakeHttpClient([{status:401,body:JSON.stringify({error:{code:401,status:"UNAUTHENTICATED",message:"bad api key"}})}]);
    const provider=new GeminiChatProvider({
      baseUrl:"https://generativelanguage.googleapis.com/v1beta",
      model:"gemini-test-model",
      credential
    },new FakeCredentialStore(),http);
    let failed=false;
    try{await provider.chat(request);}catch(error){
      failed=error&&typeof error==="object"&&"chatError" in error&&JSON.stringify(error).includes("authentication");
      ok(!JSON.stringify(error).includes("gemini-test-secret"),"Gemini provider error does not expose secret");
    }
    ok(Boolean(failed),"Gemini HTTP auth error becomes canonical provider error");
  }

  {
    const first={status:200,body:JSON.stringify({models:[{name:"models/gemini-a",displayName:"Gemini A",supportedGenerationMethods:["generateContent"]}],nextPageToken:"page-2"})};
    const second={status:200,body:JSON.stringify({models:[{name:"models/gemini-b",displayName:"Gemini B",supportedGenerationMethods:["generateContent"]},{name:"models/embedding-only",supportedGenerationMethods:["embedContent"]}]})};
    const http=new FakeHttpClient([first,second]);
    const provider=new GeminiChatProvider({
      baseUrl:"https://generativelanguage.googleapis.com/v1beta",
      model:"",
      credential
    },new FakeCredentialStore(),http);
    const models=await provider.listModels();
    equal(models.map(model=>model.id).join(","),"gemini-a,gemini-b","Gemini model discovery supports pagination and normalizes ids");
    equal(http.requests.length,2,"Gemini model discovery requests every required page");
    ok(http.requests[1]!.url.includes("pageToken=page-2"),"Gemini model discovery follows nextPageToken");
    equal(models[0]?.displayName,"Gemini A","Gemini discovery preserves display name");
  }

  {
    const http=new FakeHttpClient([]);
    const provider=new GeminiChatProvider({
      baseUrl:"https://generativelanguage.googleapis.com/v1beta",
      model:"gemini-test-model",
      credential
    },new FakeCredentialStore(),http);
    const capabilities=provider.capabilities();
    equal(capabilities.streaming,false,"Gemini streaming is explicitly unsupported");
    equal(capabilities.toolCalling,false,"Gemini tool calling is not claimed");
    equal(capabilities.structuredOutput,false,"Gemini structured output is not claimed");
    equal(capabilities.reasoning,false,"Gemini reasoning is not claimed");
    equal((await provider.health()).status,"healthy","Gemini credential health is available without network request");
  }

  {
    const http=new FakeHttpClient([{status:200,body:JSON.stringify({
      candidates:[{content:{role:"model",parts:[{text:"text response"}]},finishReason:"STOP"}]
    })}]);
    const provider=new GeminiChatProvider({
      baseUrl:"https://generativelanguage.googleapis.com/v1beta",
      model:"gemini-test-model",
      credential
    },new FakeCredentialStore(),http);
    const response=await provider.chat({...request,generation:{responseFormat:{type:"text"}}});
    equal(response.message.content,"text response","plain text response format remains supported");
    let unsupported=false;
    try{await provider.chat({...request,generation:{responseFormat:{type:"json-schema",schema:{type:"object"}}}} as ChatRequest);}catch(error){
      unsupported=JSON.stringify(error).includes("UNSUPPORTED")||JSON.stringify(error).includes("requested response format");
    }
    ok(unsupported,"unsupported structured output is rejected without advertising support");
  }

  console.log("PASS Gemini provider unit tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1});
