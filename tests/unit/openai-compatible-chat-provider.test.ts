import {
  AiRuntime,
  InMemoryDiagnosticsStore,
  ProviderRegistry
} from "../../core/src";
import {
  CHAT_API_VERSION,
  CHAT_SCHEMA_VERSION,
  type ChatRequest,
  type CredentialReference,
  type CredentialStore
} from "../../contracts/src";
import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  type HttpClient,
  type HttpClientRequest,
  type HttpClientResponse,
  OpenAICompatibleChatProvider,
  OpenAICompatibleProviderError
} from "../../providers/chat/openai-compatible/src";
import {createFoundationRuntime} from "../../runtime/bootstrap/src";

function equal(actual:unknown,expected:unknown,label:string){if(actual!==expected)throw new Error(label+" expected "+String(expected)+" got "+String(actual));}
function ok(value:unknown,label:string){if(!value)throw new Error(label);}
function throwsAsync(fn:()=>Promise<unknown>,check:(error:unknown)=>boolean,label:string){
  return fn().then(()=>{throw new Error(label+" did not throw");},error=>{if(!check(error))throw new Error(label+" unexpected error: "+String(error));});
}

const credentialReference:CredentialReference={
  id:"credential.test",
  kind:"api-key",
  provider:"openai-compatible"
};

class FakeCredentialStore implements CredentialStore{
  private value:string|undefined="unit-test-secret-value";
  async getSecret(reference:CredentialReference){return reference.id===credentialReference.id?this.value:undefined;}
  async setSecret(_reference:CredentialReference,value:string){this.value=value;}
  async deleteSecret(_reference:CredentialReference){this.value=undefined;}
}

class FakeHttpClient implements HttpClient{
  requests:HttpClientRequest[]=[];
  next:HttpClientResponse|Error|(()=>Promise<HttpClientResponse>)={
    status:200,
    body:JSON.stringify({
      id:"chatcmpl-test",
      model:"openai-compatible-test-model",
      choices:[{message:{role:"assistant",content:"hello from provider"},finish_reason:"stop"}],
      usage:{prompt_tokens:3,completion_tokens:5,total_tokens:8}
    })
  };
  async request(request:HttpClientRequest):Promise<HttpClientResponse>{
    this.requests.push(request);
    if(this.next instanceof Error)throw this.next;
    if(typeof this.next==="function")return this.next();
    return this.next;
  }
}

function request(overrides:Partial<ChatRequest>={}):ChatRequest{
  return {
    apiVersion:CHAT_API_VERSION,
    schemaVersion:CHAT_SCHEMA_VERSION,
    requestId:"openai-compatible-test-request",
    providerId:OPENAI_COMPATIBLE_PROVIDER_ID,
    model:"openai-compatible-test-model",
    context:{
      conversationId:"conversation-1",
      messages:[
        {id:"system-1",role:"system",content:"system instruction"},
        {id:"user-1",role:"user",content:"first user message"},
        {id:"assistant-1",role:"assistant",content:"previous assistant message"},
        {id:"user-2",role:"user",content:"second user message"}
      ]
    },
    ...overrides
  };
}

function provider(
  http:FakeHttpClient,
  credentialStore:CredentialStore=new FakeCredentialStore(),
  timeoutMs=1000
){
  return new OpenAICompatibleChatProvider({
    baseUrl:"https://provider.example.test/v1",
    model:"openai-compatible-test-model",
    credential:credentialReference,
    timeoutMs
  },credentialStore,http);
}

async function metadataAndCapabilitiesTest(){
  const p=provider(new FakeHttpClient());
  const metadata=p.metadata();
  equal(metadata.id,OPENAI_COMPATIBLE_PROVIDER_ID,"provider metadata id");
  equal(metadata.kind,"chat","provider metadata kind");
  equal(metadata.version,"1.0.0","provider metadata version");
  const capabilities=p.capabilities();
  equal(capabilities.streaming,false,"streaming capability");
  equal(capabilities.toolCalling,false,"tool calling capability");
  equal(capabilities.structuredOutput,false,"structured output capability");
  equal(capabilities.reasoning,false,"reasoning capability");
}

async function requestMappingTest(){
  const http=new FakeHttpClient();
  const p=provider(http);
  const result=await p.chat({
    ...request(),
    generation:{temperature:0.4,maxTokens:128,topP:0.8,responseFormat:{type:"text"}}
  });
  equal(result.message.content,"hello from provider","mapped response text");
  equal(http.requests.length,1,"one HTTP request");
  const sent=JSON.parse(http.requests[0]!.body) as {
    model:string;
    messages:Array<{role:string;content:string}>;
    stream:boolean;
    temperature?:number;
    max_tokens?:number;
    top_p?:number;
    response_format?:unknown;
  };
  equal(http.requests[0]!.url,"https://provider.example.test/v1/chat/completions","chat endpoint");
  equal(http.requests[0]!.headers.Authorization,"Bearer unit-test-secret-value","authorization boundary");
  equal(sent.model,"openai-compatible-test-model","model mapping");
  equal(sent.stream,false,"non-streaming request");
  equal(sent.temperature,0.4,"temperature mapping");
  equal(sent.max_tokens,128,"max token mapping");
  equal(sent.top_p,0.8,"top p mapping");
  ok(sent.response_format===undefined,"text response format is not expanded into unsupported fields");
  equal(sent.messages[0]!.role,"system","system message mapping");
  equal(sent.messages[1]!.role,"user","user message mapping");
  equal(sent.messages[2]!.role,"assistant","assistant message mapping");
  equal(sent.messages[3]!.content,"second user message","message ordering");
}

async function successResponseMappingTest(){
  const http=new FakeHttpClient();
  const p=provider(http);
  const response=await p.chat(request());
  equal(response.requestId,"openai-compatible-test-request","request id mapping");
  equal(response.conversationId,"conversation-1","conversation id mapping");
  equal(response.providerId,OPENAI_COMPATIBLE_PROVIDER_ID,"provider id mapping");
  equal(response.model,"openai-compatible-test-model","model response mapping");
  equal(response.message.role,"assistant","assistant role mapping");
  equal(response.message.content,"hello from provider","assistant content mapping");
  equal(response.finishReason,"stop","stop finish reason");
  equal(response.usage?.promptTokens,3,"prompt usage mapping");
  equal(response.usage?.completionTokens,5,"completion usage mapping");
  equal(response.usage?.totalTokens,8,"total usage mapping");
}

async function finishReasonTest(){
  const reasons:Array<[string, "stop"|"length"|"content_filter"|"error"|"unknown"]>=[
    ["stop","stop"],["length","length"],["content_filter","content_filter"],["error","error"],["unexpected","unknown"]
  ];
  for(const [input,expected] of reasons){
    const http=new FakeHttpClient();
    http.next={status:200,body:JSON.stringify({
      model:"openai-compatible-test-model",
      choices:[{message:{role:"assistant",content:"text"},finish_reason:input}]
    })};
    equal((await provider(http).chat(request())).finishReason,expected,"finish reason "+input);
  }
}

async function malformedResponseTest(){
  const http=new FakeHttpClient();
  http.next={status:200,body:"not-json"};
  await throwsAsync(
    ()=>provider(http).chat(request()),
    error=>error instanceof OpenAICompatibleProviderError&&error.chatError.code==="INVALID_RESPONSE",
    "malformed JSON"
  );

  http.next={status:200,body:JSON.stringify({choices:[]})};
  await throwsAsync(
    ()=>provider(http).chat(request()),
    error=>error instanceof OpenAICompatibleProviderError&&error.chatError.code==="INVALID_RESPONSE",
    "missing choices"
  );

  http.next={status:200,body:JSON.stringify({choices:[{message:{role:"assistant",content:""}}]})};
  await throwsAsync(
    ()=>provider(http).chat(request()),
    error=>error instanceof OpenAICompatibleProviderError&&error.chatError.details?.category==="missing_assistant_content",
    "missing assistant content"
  );
}

async function httpStatusTest(){
  const statuses:Array<[number,string,boolean]>=[
    [400,"bad_request",false],
    [401,"authentication",false],
    [403,"authentication",false],
    [404,"endpoint",false],
    [429,"rate_limit",true],
    [500,"server",true],
    [503,"server",true]
  ];
  for(const [status,category,retryable] of statuses){
    const http=new FakeHttpClient();
    http.next={status,body:"provider error body with no secrets"};
    await throwsAsync(
      ()=>provider(http).chat(request()),
      error=>{
        if(!(error instanceof OpenAICompatibleProviderError))return false;
        const chatError=error.chatError;
        return chatError.code==="PROVIDER_ERROR"&&
          chatError.retryable===retryable&&
          chatError.details?.category===category&&
          chatError.details?.httpStatus===status;
      },
      "HTTP "+status
    );
  }
}

async function timeoutAndConnectionTest(){
  const timeoutHttp=new FakeHttpClient();
  timeoutHttp.next=()=>new Promise<HttpClientResponse>(()=>{});
  const started=Date.now();
  await throwsAsync(
    ()=>provider(timeoutHttp,new FakeCredentialStore(),25).chat(request()),
    error=>error instanceof OpenAICompatibleProviderError&&error.chatError.details?.category==="timeout",
    "request timeout"
  );
  ok(Date.now()-started<500,"timeout is bounded");

  const connectionHttp=new FakeHttpClient();
  connectionHttp.next=new Error("socket failure with unit-test-secret-value");
  await throwsAsync(
    ()=>provider(connectionHttp).chat(request()),
    error=>error instanceof OpenAICompatibleProviderError&&error.chatError.details?.category==="network",
    "connection failure"
  );
}

async function credentialAndUnsupportedTest(){
  const missingCredentials=new FakeCredentialStore();
  await missingCredentials.deleteSecret(credentialReference);
  const http=new FakeHttpClient();
  await throwsAsync(
    ()=>provider(http,missingCredentials).chat(request()),
    error=>error instanceof OpenAICompatibleProviderError&&error.chatError.code==="PROVIDER_UNAVAILABLE"&&error.chatError.details?.category==="credential",
    "missing credential"
  );

  await throwsAsync(
    ()=>provider(new FakeHttpClient()).chat({
      ...request(),
      context:{...request().context,messages:[...request().context.messages,{role:"tool",content:"tool output",toolCallId:"call-1"}]}
    }),
    error=>error instanceof OpenAICompatibleProviderError&&error.chatError.code==="UNSUPPORTED",
    "unsupported tool message"
  );

  await throwsAsync(
    ()=>provider(new FakeHttpClient()).chat({...request(),generation:{responseFormat:{type:"json",schema:{type:"object"}}}}),
    error=>error instanceof OpenAICompatibleProviderError&&error.chatError.code==="UNSUPPORTED",
    "unsupported structured output"
  );
}

async function secretSafetyTest(){
  const secret="unit-test-secret-value";
  const http=new FakeHttpClient();
  http.next={status:500,body:"Authorization: Bearer "+secret};
  try{
    await provider(http).chat(request());
    throw new Error("secret safety test did not throw");
  }catch(error){
    const serialized=JSON.stringify(error);
    equal(serialized.includes(secret),false,"secret excluded from provider error");
    if(error instanceof OpenAICompatibleProviderError){
      equal(error.chatError.message.includes(secret),false,"secret excluded from chat error");
      equal(JSON.stringify(error.chatError.details).includes(secret),false,"secret excluded from error details");
    }
  }

  const diagnostics=new InMemoryDiagnosticsStore();
  const registry=new ProviderRegistry();
  registry.register(provider(http),["chat"]);
  const runtime=new AiRuntime(registry,{diagnostics});
  try{
    await runtime.generate(request());
    throw new Error("runtime secret safety test did not throw");
  }catch(error){
    equal(JSON.stringify(error).includes(secret),false,"secret excluded from runtime error");
    equal(JSON.stringify(diagnostics.recentErrors()).includes(secret),false,"secret excluded from diagnostics");
  }
}

async function runtimeIntegrationTest(){
  const http=new FakeHttpClient();
  const registry=new ProviderRegistry();
  registry.register(provider(http),["chat"]);
  const runtime=new AiRuntime(registry);
  const response=await runtime.generate(request());
  equal(response.providerId,OPENAI_COMPATIBLE_PROVIDER_ID,"AiRuntime provider selection");
  equal(response.message.content,"hello from provider","AiRuntime response");
}

async function providerHealthAndModelsTest(){
  const store=new FakeCredentialStore();
  const p=provider(new FakeHttpClient(),store);
  equal((await p.health()).status,"healthy","provider health configured");
  equal((await p.listModels())[0]?.id,"openai-compatible-test-model","configured model listing");
  await store.deleteSecret(credentialReference);
  equal((await p.health()).status,"unavailable","provider health without credential");
  const invalid=new OpenAICompatibleChatProvider({
    baseUrl:"file:///not-allowed",
    model:"model",
    credential:credentialReference
  },new FakeCredentialStore(),new FakeHttpClient());
  equal((await invalid.health()).status,"unavailable","invalid configuration health");
  equal((await invalid.listModels()).length,0,"invalid configuration model listing");
}

async function compositionRootTest(){
  const http=new FakeHttpClient();
  const credentialStore=new FakeCredentialStore();
  const runtime=await createFoundationRuntime({
    openAICompatible:{
      config:{
        baseUrl:"https://provider.example.test/v1",
        model:"openai-compatible-test-model",
        credential:credentialReference,
        timeoutMs:250
      },
      credentialStore,
      httpClient:http
    }
  });
  try{
    const diagnostics=await runtime.diagnostics();
    const provider=diagnostics.providers.find(item=>item.id===OPENAI_COMPATIBLE_PROVIDER_ID);
    ok(provider,"Composition Root registered OpenAI-compatible provider");
    equal(provider?.health?.status,"healthy","Composition Root provider health");
    const response=await runtime.chat(request());
    equal(response.providerId,OPENAI_COMPATIBLE_PROVIDER_ID,"Composition Root provider can serve chat");
  }finally{
    await runtime.stop();
  }

  const offline=await createFoundationRuntime();
  try{
    const diagnostics=await offline.diagnostics();
    ok(!diagnostics.providers.some(item=>item.id===OPENAI_COMPATIBLE_PROVIDER_ID),"real provider remains disabled by default");
    const response=await offline.chat({
      apiVersion:CHAT_API_VERSION,
      schemaVersion:CHAT_SCHEMA_VERSION,
      requestId:"offline-request",
      model:"fake-chat",
      context:{conversationId:"offline-conversation",messages:[{role:"user",content:"hello"}]}
    });
    equal(response.providerId,"fake.chat","offline fake provider remains usable");
  }finally{
    await offline.stop();
  }
}

void (async()=>{
  for(const [name,test] of [
    ["Metadata and capabilities",metadataAndCapabilitiesTest],
    ["Request mapping",requestMappingTest],
    ["Success response mapping",successResponseMappingTest],
    ["Finish reasons",finishReasonTest],
    ["Malformed response",malformedResponseTest],
    ["HTTP status normalization",httpStatusTest],
    ["Timeout and connection",timeoutAndConnectionTest],
    ["Credential and unsupported inputs",credentialAndUnsupportedTest],
    ["Secret safety",secretSafetyTest],
    ["AiRuntime integration",runtimeIntegrationTest],
    ["Health and model listing",providerHealthAndModelsTest],
    ["Composition Root",compositionRootTest]
  ] as const){
    await test();
    console.log("PASS OpenAI-compatible "+name);
  }
  console.log("All OpenAI-compatible chat provider tests passed.");
})().catch(error=>{console.error(error);process.exitCode=1;});
