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
  type HttpClientStreamResponse,
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
  lastStreamSignal?:AbortSignal;
  lastRequestSignal?:AbortSignal;
  next:HttpClientResponse|Error|(()=>Promise<HttpClientResponse>)={
    status:200,
    body:JSON.stringify({
      id:"chatcmpl-test",
      model:"openai-compatible-test-model",
      choices:[{message:{role:"assistant",content:"hello from provider"},finish_reason:"stop"}],
      usage:{prompt_tokens:3,completion_tokens:5,total_tokens:8}
    })
  };
  streamNext:HttpClientStreamResponse|Error|(()=>Promise<HttpClientStreamResponse>)={
    status:200,
    headers:{"content-type":"text/event-stream"},
    body:streamChunks((()=>{
      const first="data: "+JSON.stringify({id:"chunk-1",model:"openai-compatible-test-model",choices:[{delta:{content:"hello "},finish_reason:null}]});
      const second="data: "+JSON.stringify({choices:[{delta:{content:"from stream"},finish_reason:"stop"}]});
      return [first.slice(0,18),first.slice(18)+"\r\n", "\r\n"+second.slice(0,12),second.slice(12)+"\n\n", "data: [DONE]\n\n"];
    })())
  };
  async request(request:HttpClientRequest):Promise<HttpClientResponse>{
    this.requests.push(request);
    this.lastRequestSignal=request.signal;
    if(this.next instanceof Error)throw this.next;
    if(typeof this.next==="function")return this.next();
    return this.next;
  }
  async stream(request:HttpClientRequest):Promise<HttpClientStreamResponse>{
    this.requests.push(request);
    this.lastStreamSignal=request.signal;
    if(this.streamNext instanceof Error)throw this.streamNext;
    if(typeof this.streamNext==="function")return this.streamNext();
    return this.streamNext;
  }
}
async function* streamChunks(parts:readonly string[]):AsyncIterable<string>{
  for(const part of parts){
    await Promise.resolve();
    yield part;
  }
}
async function* delayedStreamChunks(parts:readonly string[],delayMs:number):AsyncIterable<string>{
  for(const part of parts){await new Promise(resolve=>setTimeout(resolve,delayMs));yield part;}
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
  equal(capabilities.streaming,true,"streaming capability");
  equal(capabilities.toolCalling,true,"standard native tool calling capability");
  equal(capabilities.structuredOutput,true,"structured output adapter capability");
  equal(capabilities.reasoning,true,"reasoning controls are mapped into the provider request");
}

async function reasoningModesMapToExplicitProviderPayloads(){
  const disabledHttp=new FakeHttpClient();
  await provider(disabledHttp).chat({...request(),reasoning:{mode:"disabled"},generation:{maxTokens:211}});
  const disabledBody=JSON.parse(disabledHttp.requests[0]!.body!) as Record<string,unknown>;
  equal(disabledBody.reasoning_effort,"none","disabled reasoning sends explicit reasoning_effort:none");
  equal(disabledBody.max_tokens,211,"generation limit stays in the same provider request");

  const disabledResponseHttp=new FakeHttpClient();
  disabledResponseHttp.next={
    status:200,
    body:JSON.stringify({
      id:"disabled-reasoning-response",
      model:"openai-compatible-test-model",
      choices:[{message:{role:"assistant",content:"Public answer",reasoning_content:"this must stay hidden"},finish_reason:"stop"}]
    })
  };
  const disabledResponse=await provider(disabledResponseHttp).chat({...request(),reasoning:{mode:"disabled"}});
  equal(disabledResponse.message.content,"Public answer","disabled mode still returns public assistant content");
  equal(disabledResponse.reasoning,undefined,"non-stream provider reasoning is never surfaced when disabled");

  const enabledHttp=new FakeHttpClient();
  await provider(enabledHttp).chat({...request(),reasoning:{mode:"enabled",effort:"high"}});
  const enabledBody=JSON.parse(enabledHttp.requests[0]!.body!) as Record<string,unknown>;
  equal(enabledBody.reasoning_effort,"high","enabled reasoning uses requested effort");

  const defaultHttp=new FakeHttpClient();
  await provider(defaultHttp).chat({...request(),reasoning:{mode:"provider-default",effort:"high"}});
  const defaultBody=JSON.parse(defaultHttp.requests[0]!.body!) as Record<string,unknown>;
  equal(defaultBody.reasoning_effort,undefined,"provider-default does not become explicit low/high just because an effort preference is persisted");
}

async function imageAttachmentsUseTheNormalOpenAICompatibleChatRequest(){
  const http=new FakeHttpClient();
  const p=provider(http);
  await p.chat({
    ...request(),
    context:{conversationId:"openai-image-conversation",messages:[{
      role:"user",content:"What is shown?",images:[{mimeType:"image/jpeg",dataBase64:"aGVsbG8=",alt:"screenshot"}]
    }]}
  });
  equal(http.requests.length,1,"a screenshot does not trigger a separate inference request");
  const sent=JSON.parse(http.requests[0]!.body!) as {messages:Array<{role:string;content:string|Array<{type:string;text?:string;image_url?:{url:string}}>}>};
  const message=sent.messages[0]!;
  equal(message.role,"user","attachment stays on the user message");
  if(!Array.isArray(message.content))throw new Error("multimodal content must use content parts");
  equal(message.content[0]?.text,"What is shown?","text and screenshot share one message");
  equal(message.content[1]?.image_url?.url,"data:image/jpeg;base64,aGVsbG8=","OpenAI-compatible image data URL mapping");
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
  const requestBody=http.requests[0]!.body;
  if(requestBody===undefined)throw new Error("expected POST request body");
  const sent=JSON.parse(requestBody) as {
    model:string;
    messages:Array<{role:string;content:string}>;
    stream:boolean;
    temperature?:number;
    max_tokens?:number;
    top_p?:number;
    response_format?:unknown;
  };
  equal(http.requests[0]!.url,"https://provider.example.test/v1/chat/completions","chat endpoint");
  equal(String(http.requests[0]!.headers.Authorization??"") ,"Bearer unit-test-secret-value","authorization boundary");
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

async function cognitionAssistantRoleRegressionTest(){
  const http=new FakeHttpClient();
  const p=provider(http);
  await p.chat({
    ...request(),
    context:{
      conversationId:"cognition-role-regression",
      messages:[
        {id:"system-1",role:"system",content:"cognition system"},
        {id:"user-1",role:"user",content:"hello"},
        {id:"assistant-1",role:"assistant",content:"previous reply"}
      ]
    }
  });
  const body=http.requests[0]?.body;
  if(body===undefined)throw new Error("expected cognition role regression body");
  const sent=JSON.parse(body) as {messages:Array<{role:string;content:string}>};
  equal(sent.messages.map(message=>message.role).join("|"),"system|user|assistant","OpenAI-compatible adapter preserves system user assistant roles");
  equal(sent.messages.map(message=>message.content).join("|"),"cognition system|hello|previous reply","OpenAI-compatible adapter preserves cognition message order");
}
async function structuredRequestMappingTest(){
  const http=new FakeHttpClient();
  const p=provider(http);
  const schema={
    type:"object",
    additionalProperties:false,
    properties:{decision:{enum:["remember","no_memory"]},content:{type:"string"}},
    required:["decision","content"]
  };
  await p.chat({...request(),generation:{responseFormat:{type:"json-schema",schema,name:"memory_agent_decision",strict:true}}});
  const body=http.requests[0]?.body;
  if(body===undefined)throw new Error("expected structured request body");
  const sent=JSON.parse(body) as {model:string;stream:boolean;response_format?:{type:string;json_schema?:{name:string;strict:boolean;schema:unknown}}};
  equal(sent.model,"openai-compatible-test-model","structured model mapping");
  equal(sent.stream,false,"structured request is non-streaming");
  equal(sent.response_format?.type,"json_schema","structured response_format type");
  equal(sent.response_format?.json_schema?.name,"memory_agent_decision","structured schema name");
  equal(sent.response_format?.json_schema?.strict,true,"structured schema strict");
  equal(JSON.stringify(sent.response_format?.json_schema?.schema),JSON.stringify(schema),"structured schema mapping");
}
async function structuredMistralLikeSuccessTest(){
  const http=new FakeHttpClient();
  http.next={
    status:200,
    body:JSON.stringify({
      model:"codestral-latest",
      choices:[{
        message:{
          role:"assistant",
          content:"{\"archive\":[\"2\"]}"
        },
        finish_reason:"stop"
      }]
    })
  };
  const schema={
    type:"object",
    additionalProperties:false,
    properties:{archive:{type:"array",items:{type:"string"}}},
    required:["archive"]
  };
  const response=await provider(http).chat({
    ...request(),
    model:"codestral-latest",
    generation:{responseFormat:{type:"json-schema",name:"memory-judge-decision",strict:true,schema}}
  });
  equal(response.model,"codestral-latest","structured response model");
  equal(response.message.content,'{"archive":["2"]}',"structured response content reaches caller");
}

async function plainRequestOmitsResponseFormatTest(){
  const http=new FakeHttpClient();
  await provider(http).chat({...request(),generation:{temperature:0.2,responseFormat:{type:"text"}}});
  const body=http.requests[0]?.body;
  if(body===undefined)throw new Error("expected plain request body");
  const sent=JSON.parse(body) as {response_format?:unknown};
  equal(sent.response_format,undefined,"plain request has no response_format");
}
async function http400ResponseBodyPropagationTest(){
  const http=new FakeHttpClient();
  http.next={
    status:400,
    body:JSON.stringify({
      message:"Invalid JSON schema: keyword pattern is not supported",
      type:"invalid_request",
      code:"invalid_request_json_schema",
      param:"response_format",
      internalSecret:"unit-test-secret-value"
    })
  };
  await throwsAsync(
    ()=>provider(http).chat({...request(),generation:{responseFormat:{type:"json-schema",schema:{type:"object",properties:{value:{type:"string"}},required:["value"],additionalProperties:false}}}}),
    error=>{
      if(!(error instanceof OpenAICompatibleProviderError))return false;
      const details=error.chatError.details;
      const response=details?.providerResponse;
      return error.chatError.code==="UNSUPPORTED"&&
        details?.category==="capability"&&
        details?.httpStatus===400&&
        typeof details?.durationMs==="number"&&
        !!response&&
        JSON.stringify(response).includes("invalid_request_json_schema")&&
        JSON.stringify(response).includes("pattern is not supported")&&
        !JSON.stringify(response).includes("unit-test-secret-value")&&
        !JSON.stringify(response).includes("internalSecret");
    },
    "HTTP 400 preserves safe provider response details"
  );
}

async function structuredUnsupportedClassificationTest(){
  const http=new FakeHttpClient();
  http.next={status:400,body:'{"error":{"message":"response_format json_schema is not supported"}}'};
  await throwsAsync(
    ()=>provider(http).chat({...request(),generation:{responseFormat:{type:"json-schema",schema:{type:"object"}}}}),
    error=>error instanceof OpenAICompatibleProviderError&&error.chatError.code==="UNSUPPORTED"&&error.chatError.details?.category==="capability",
    "structured unsupported is classified as capability"
  );
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

async function nativeToolCallResponseTest(){
  const http=new FakeHttpClient();
  http.next={status:200,body:JSON.stringify({
    id:"chatcmpl-tool",model:"openai-compatible-test-model",
    choices:[{message:{role:"assistant",content:null,tool_calls:[{id:"call-native-1",type:"function",function:{name:"memory.search",arguments:"{\"query\":\"tea\"}"}}]},finish_reason:"tool_calls"}]
  })};
  const definition={name:"memory.search",description:"Search active character memories",parameters:{type:"object",properties:{query:{type:"string"}},required:["query"]}};
  const response=await provider(http).chat({...request(),tools:[definition]});
  equal(response.message.content,"","tool-only response has no invented speech");
  equal(response.message.toolCalls?.length,1,"native tool call is parsed");
  equal(response.message.toolCalls?.[0]?.id,"call-native-1","native tool call id is preserved");
  equal(response.message.toolCalls?.[0]?.name,"memory.search","native tool name is preserved");
  equal(response.message.toolCalls?.[0]?.arguments.query,"tea","native tool arguments are parsed as JSON");
  equal(response.finishReason,"stop","native tool_calls finish reason is normalized");
}

async function nativeStreamingToolCallTest(){
  const http=new FakeHttpClient();
  const first={choices:[{delta:{tool_calls:[{index:0,id:"call-stream-1",type:"function",function:{name:"memory.",arguments:"{\"query\":"}}]},finish_reason:null}]};
  const second={choices:[{delta:{tool_calls:[{index:0,type:"function",function:{name:"search",arguments:"\"tea\"}"}}]},finish_reason:null}]};
  const done={choices:[{delta:{},finish_reason:"tool_calls"}]};
  http.streamNext={status:200,headers:{"content-type":"text/event-stream"},body:streamChunks([
    "data: "+JSON.stringify(first)+"\n\n",
    "data: "+JSON.stringify(second)+"\n\n",
    "data: "+JSON.stringify(done)+"\n\n",
    "data: [DONE]\n\n"
  ])};
  const tool={name:"memory.search",description:"Search character memories",parameters:{type:"object",properties:{query:{type:"string"}},required:["query"]}};
  const response=await provider(http).stream({...request(),tools:[tool]},{onEvent(){}});
  equal(response.message.toolCalls?.length,1,"fragmented native tool call is assembled once");
  equal(response.message.toolCalls?.[0]?.name,"memory.search","fragmented function name is assembled");
  equal(response.message.toolCalls?.[0]?.arguments.query,"tea","fragmented function arguments are parsed");
  equal(response.message.content,"","tool-only stream does not fabricate user-facing text");
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

async function chatAbortTest(){
  const http=new FakeHttpClient();
  http.next=()=>new Promise<HttpClientResponse>(()=>{});
  const signalController=new AbortController();
  const pending=provider(http).chat(request(),{signal:signalController.signal});
  for(let attempt=0;attempt<30&&http.lastRequestSignal===undefined;attempt++)await new Promise(resolve=>setTimeout(resolve,1));
  const httpSignal=http.lastRequestSignal;
  if(!httpSignal)throw new Error("provider must pass a caller-cancellable AbortSignal to HTTP chat transport");
  signalController.abort();
  await throwsAsync(
    ()=>pending,
    error=>error instanceof Error&&error.name==="AbortError",
    "caller abort cancels HTTP chat generation"
  );
  equal(httpSignal.aborted,true,"caller cancellation reaches the HTTP request signal");
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

  const toolHttp=new FakeHttpClient();
  await provider(toolHttp).chat({
    ...request(),
    tools:[{name:"memory.search",description:"Search active character memories",parameters:{type:"object",properties:{query:{type:"string"}},required:["query"]}}],
    context:{...request().context,messages:[...request().context.messages,
      {role:"assistant",content:"",toolCalls:[{id:"call-1",name:"memory.search",arguments:{query:"tea"}}]},
      {role:"tool",content:"{\"matches\":[]}",toolCallId:"call-1",toolName:"memory.search"}
    ]}
  });
  const toolBody=JSON.parse(toolHttp.requests[0]!.body!) as {tools:Array<{function:{name:string}}>;messages:Array<{role:string;tool_call_id?:string;name?:string}>};
  equal(toolBody.tools[0]!.function.name,"memory.search","native function schema is advertised");
  equal(toolBody.messages.at(-2)?.role,"assistant","native assistant tool-call history is preserved");
  equal(toolBody.messages.at(-1)?.role,"tool","native tool result role is supported");
  equal(toolBody.messages.at(-1)?.tool_call_id,"call-1","native tool result preserves call id");
  equal(toolBody.messages.at(-1)?.name,"memory.search","native tool result preserves tool name");

  const jsonModeHttp=new FakeHttpClient();
  await provider(jsonModeHttp).chat({...request(),generation:{responseFormat:{type:"json",schema:{type:"object"}}}});
  const jsonModeBody=jsonModeHttp.requests[0]?.body;
  if(jsonModeBody===undefined)throw new Error("JSON mode request body missing");
  equal((JSON.parse(jsonModeBody) as {response_format?:{type:string}}).response_format?.type,"json_object","legacy JSON mode mapping");
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

async function streamingTest(){
  const http=new FakeHttpClient();
  const providerInstance=provider(http);
  const events:import("../../contracts/src").ChatStreamEvent[]=[];
  const response=await providerInstance.stream(request(),{onEvent:event=>{events.push(event);}});
  equal(events.filter(event=>event.type==="delta").map(event=>event.type==="delta"?event.text:"").join("|"),"hello |from stream","SSE deltas are emitted incrementally");
  equal(events.filter(event=>event.type==="completed").length,1,"SSE emits one completion");
  equal(events.find(event=>event.type==="completed"&&event.type==="completed")?.finishReason,"stop","SSE finish reason");
  equal(response.providerId,OPENAI_COMPATIBLE_PROVIDER_ID,"stream response provider");
  equal(response.message.content,"hello from stream","stream response retains the content for subsequent native tool rounds");
  equal(http.requests.length,1,"stream uses one POST");
  equal(http.requests[0]!.method,"POST","stream request method");
  equal(http.requests[0]!.url,"https://provider.example.test/v1/chat/completions","stream endpoint");
  equal(http.requests[0]!.headers.Accept,"text/event-stream","SSE accept header");
  const body=http.requests[0]!.body;
  if(body===undefined)throw new Error("stream request body missing");
  equal((JSON.parse(body) as {stream:boolean}).stream,true,"stream request body sets stream=true");
}


async function streamingTimeoutStageTest(){
  const http=new FakeHttpClient();
  http.streamNext={
    status:200,
    headers:{"content-type":"text/event-stream"},
    body:{
      async *[Symbol.asyncIterator](){
        await new Promise<void>(()=>{});
      }
    }
  };
  const diagnostics=new InMemoryDiagnosticsStore();
  const providerInstance=new OpenAICompatibleChatProvider({
    baseUrl:"https://provider.example.test/v1",
    model:"openai-compatible-test-model",
    credential:credentialReference,
    timeoutMs:25,
    diagnostics,
    providerPresetId:"preset.main"
  },new FakeCredentialStore(),http);
  const started=Date.now();
  await throwsAsync(
    ()=>providerInstance.stream(request(),{onEvent:()=>{}}),
    error=>error instanceof OpenAICompatibleProviderError&&
      error.chatError.details?.category==="timeout"&&
      error.chatError.details?.stage==="stream_body"&&
      error.chatError.details?.timeoutMs===25&&
      typeof error.chatError.details?.durationMs==="number"&&
      error.chatError.details?.durationMs>=20,
    "stream body timeout exposes stage and configured timeout"
  );
  ok(Date.now()-started<500,"stream body timeout is bounded");
  const timeoutDiagnostic=diagnostics.recentErrors().find(entry=>entry.code==="CHAT_PROVIDER_TIMEOUT");
  ok(timeoutDiagnostic,"stream timeout diagnostic is recorded");
  equal(timeoutDiagnostic?.metadata?.providerPresetId,"preset.main","stream timeout diagnostic records provider preset");
  equal(timeoutDiagnostic?.metadata?.stage,"stream_body","stream timeout diagnostic records body stage");
  equal(timeoutDiagnostic?.metadata?.timeoutMs,25,"stream timeout diagnostic records configured timeout");
}

async function streamingTimeoutIsInactivityDeadlineTest(){
  const http=new FakeHttpClient();
  const frames=[
    "data: "+JSON.stringify({choices:[{delta:{content:"still "},finish_reason:null}]})+"\n\n",
    "data: "+JSON.stringify({choices:[{delta:{content:"streaming "},finish_reason:null}]})+"\n\n",
    "data: "+JSON.stringify({choices:[{delta:{content:"after thirty seconds in total"},finish_reason:"stop"}]})+"\n\n",
    "data: [DONE]\n\n"
  ];
  http.streamNext={status:200,headers:{"content-type":"text/event-stream"},body:delayedStreamChunks(frames,15)};
  let streamed="";
  const response=await provider(http,new FakeCredentialStore(),25).stream(request(),{onEvent:event=>{if(event.type==="delta")streamed+=event.text;}});
  equal(streamed,"still streaming after thirty seconds in total","OpenAI-compatible stream emits all speech across multiple inactivity windows");
  equal(response.message.content,streamed,"completed stream also returns its assembled content for the next native tool round");
}
async function streamingUsageTest(){
  const http=new FakeHttpClient();
  http.streamNext={
    status:200,
    headers:{"content-type":"text/event-stream"},
    body:streamChunks([
      "data: "+JSON.stringify({choices:[{delta:{content:"answer"},finish_reason:"stop"}],usage:{prompt_tokens:7,completion_tokens:4,total_tokens:11}})+"\n\n",
      "data: [DONE]\n\n"
    ])
  };
  const events:import("../../contracts/src").ChatStreamEvent[]=[];
  const response=await provider(http).stream(request(),{onEvent:event=>{events.push(event);}});
  const usageEvent=events.find(event=>event.type==="usage");
  equal(usageEvent?.type==="usage"?usageEvent.usage.totalTokens:undefined,11,"stream usage event");
  equal(response.usage?.totalTokens,11,"stream response usage");
}

async function malformedStreamingEventTest(){
  const http=new FakeHttpClient();
  http.streamNext={status:200,headers:{"content-type":"text/event-stream"},body:streamChunks(["data: not-json\n\n"])};
  await throwsAsync(
    ()=>provider(http).stream(request(),{onEvent:()=>{}}),
    error=>error instanceof OpenAICompatibleProviderError&&error.chatError.code==="INVALID_RESPONSE",
    "malformed SSE JSON"
  );
}

async function streamingAbortTest(){
  const http=new FakeHttpClient();
  const signalController=new AbortController();
  let httpSignal:AbortSignal|undefined;
  http.streamNext=async()=>({
    status:200,
    headers:{"content-type":"text/event-stream"},
    body:{
      async *[Symbol.asyncIterator](){
            while(true){
          if(httpSignal?.aborted)throw new Error("aborted by fake transport");
          await new Promise(resolve=>setTimeout(resolve,5));
          if(httpSignal?.aborted)throw new Error("aborted by fake transport");
          yield "data: "+JSON.stringify({choices:[{delta:{content:"x"}}]})+"\n\n";
        }
      }
    }
  });
  const pending=provider(http).stream(request(),{onEvent:()=>{}},{signal:signalController.signal});
  for(let attempt=0;attempt<20&&http.lastStreamSignal===undefined;attempt++)await new Promise(resolve=>setTimeout(resolve,1));
  httpSignal=http.lastStreamSignal;
  setTimeout(()=>signalController.abort(),15);
  await throwsAsync(
    ()=>pending,
    error=>error instanceof Error&&error.name==="AbortError",
    "caller abort propagates as AbortError"
  );
  if(!httpSignal)throw new Error("provider must pass an AbortSignal to HTTP streaming transport");
  equal(httpSignal.aborted,true,"caller abort is linked to HTTP stream");
}

async function modelDiscoveryTest(){
  const http=new FakeHttpClient();
  http.next={status:200,body:JSON.stringify({data:[
    {id:"discovered-model-a",display_name:"Ignored Name"},
    {id:"discovered-model-b",displayName:"Discovered B"},
    {id:17}
  ]})};
  const models=await provider(http).listModels();
  equal(http.requests.length,1,"one discovery request");
  equal(http.requests[0]!.method,"GET","model discovery uses GET");
  equal(http.requests[0]!.url,"https://provider.example.test/v1/models","model discovery endpoint");
  equal(http.requests[0]!.headers.Authorization,"Bearer unit-test-secret-value","model discovery authorization");
  equal(models[0]?.id,"discovered-model-a","first discovered model id");
  equal(models[1]?.displayName,"Discovered B","discovered displayName");
  equal(models.length,2,"malformed model items are ignored");

  http.next={status:405,body:""};
  const unsupported=await provider(http).listModels();
  equal(unsupported.length,0,"unsupported discovery switches to manual model mode");

  http.next={status:200,body:"malformed"};
  const malformed=await provider(http).listModels();
  equal(malformed.length,0,"malformed discovery returns manual mode without provider failure");
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
  const http=new FakeHttpClient();
  http.next={status:200,body:JSON.stringify({data:[{id:"openai-compatible-test-model",displayName:"Configured Model"}]})};
  const p=provider(http,store);
  equal((await p.health()).status,"healthy","provider health configured");
  equal((await p.listModels())[0]?.id,"openai-compatible-test-model","configured model discovery listing");
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
    ["Reasoning mode payloads",reasoningModesMapToExplicitProviderPayloads],
    ["Image attachments use the normal chat request",imageAttachmentsUseTheNormalOpenAICompatibleChatRequest],
    ["Request mapping",requestMappingTest],
    ["Cognition assistant role mapping",cognitionAssistantRoleRegressionTest],
    ["Structured request mapping",structuredRequestMappingTest],
    ["Structured Mistral-like success",structuredMistralLikeSuccessTest],
    ["Plain request mapping",plainRequestOmitsResponseFormatTest],
    ["Structured unsupported classification",structuredUnsupportedClassificationTest],
    ["Success response mapping",successResponseMappingTest],
    ["Native tool call response",nativeToolCallResponseTest],
    ["Streaming native tool call fragments",nativeStreamingToolCallTest],
    ["Finish reasons",finishReasonTest],
    ["Malformed response",malformedResponseTest],
    ["HTTP status normalization",httpStatusTest],
    ["HTTP 400 provider response diagnostics",http400ResponseBodyPropagationTest],
    ["Timeout and connection",timeoutAndConnectionTest],
    ["Chat abort",chatAbortTest],
    ["Credential and unsupported inputs",credentialAndUnsupportedTest],
    ["Secret safety",secretSafetyTest],
    ["Streaming",streamingTest],
    ["Streaming timeout stage",streamingTimeoutStageTest],
    ["Streaming timeout is an inactivity deadline",streamingTimeoutIsInactivityDeadlineTest],
    ["Streaming usage",streamingUsageTest],
    ["Malformed streaming event",malformedStreamingEventTest],
    ["Streaming abort",streamingAbortTest],
    ["Model discovery",modelDiscoveryTest],
    ["AiRuntime integration",runtimeIntegrationTest],
    ["Health and model listing",providerHealthAndModelsTest],
    ["Composition Root",compositionRootTest]
  ] as const){
    await test();
    console.log("PASS OpenAI-compatible "+name);
  }
  console.log("All OpenAI-compatible chat provider tests passed.");
})().catch(error=>{console.error(error);process.exitCode=1;});
