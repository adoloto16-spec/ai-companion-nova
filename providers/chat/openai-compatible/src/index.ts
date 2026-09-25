import type {
  ChatError,
  ChatMessage,
  ChatProvider,
  ChatRequest,
  ChatResponse,
  ChatUsage,
  CredentialReference,
  CredentialStore,
  HealthStatus,
  ModelInfo,
  ProviderCapabilities
} from "../../../../contracts/src/index";

export const OPENAI_COMPATIBLE_PROVIDER_ID="openai-compatible";
const DEFAULT_TIMEOUT_MS=30000;

export interface HttpClientRequest{
  url:string;
  method:"POST";
  headers:Readonly<Record<string,string>>;
  body:string;
  signal?:AbortSignal;
}

export interface HttpClientResponse{
  status:number;
  body:string;
}

export interface HttpClient{
  request(request:HttpClientRequest):Promise<HttpClientResponse>;
}

export class FetchHttpClient implements HttpClient{
  async request(request:HttpClientRequest):Promise<HttpClientResponse>{
    const response=await fetch(request.url,{
      method:request.method,
      headers:request.headers,
      body:request.body,
      signal:request.signal
    });
    return {status:response.status,body:await response.text()};
  }
}

export interface OpenAICompatibleProviderConfig{
  baseUrl:string;
  model:string;
  credential:CredentialReference;
  timeoutMs?:number;
}

export class OpenAICompatibleProviderError extends Error{
  readonly chatError:ChatError;
  constructor(chatError:ChatError){
    super(chatError.message);
    this.name="OpenAICompatibleProviderError";
    this.chatError=chatError;
  }
}

interface OpenAIChatMessage{
  role:"system"|"user"|"assistant";
  content:string;
}

function safeConfigError(message:string,request?:ChatRequest):OpenAICompatibleProviderError{
  return new OpenAICompatibleProviderError({
    apiVersion:"1",
    schemaVersion:"1",
    code:"PROVIDER_UNAVAILABLE",
    message,
    ...(request?{requestId:request.requestId,providerId:OPENAI_COMPATIBLE_PROVIDER_ID}:{}),
    retryable:false,
    details:{category:"configuration"}
  });
}

export class OpenAICompatibleChatProvider implements ChatProvider{
  readonly id=OPENAI_COMPATIBLE_PROVIDER_ID;
  private readonly config:OpenAICompatibleProviderConfig;
  private readonly credentialStore:CredentialStore;
  private readonly httpClient:HttpClient;

  constructor(
    config:OpenAICompatibleProviderConfig,
    credentialStore:CredentialStore,
    httpClient:HttpClient=new FetchHttpClient()
  ){
    this.config=config;
    this.credentialStore=credentialStore;
    this.httpClient=httpClient;
  }

  metadata(){
    return {
      id:this.id,
      kind:"chat" as const,
      displayName:"OpenAI-Compatible Chat Provider",
      version:"1.0.0",
      description:"Synchronous OpenAI-compatible Chat Completions adapter."
    };
  }

  capabilities():ProviderCapabilities{
    return {
      streaming:false,
      toolCalling:false,
      structuredOutput:false,
      reasoning:false
    };
  }

  async listModels():Promise<ModelInfo[]>{
    if(!this.validConfig())return [];
    return [{
      id:this.config.model,
      displayName:this.config.model,
      capabilities:this.capabilities()
    }];
  }

  async health():Promise<HealthStatus>{
    const configError=this.configError();
    if(configError)return {status:"unavailable",message:configError.message,capabilities:["chat"]};
    try{
      const secret=await this.credentialStore.getSecret(this.config.credential);
      if(!secret)return {status:"unavailable",message:"Chat provider credential is not configured.",capabilities:["chat"]};
      return {status:"healthy",capabilities:["chat"]};
    }catch{
      return {status:"unavailable",message:"Chat provider credential is unavailable.",capabilities:["chat"]};
    }
  }

  async chat(request:ChatRequest):Promise<ChatResponse>{
    this.ensureConfig(request);
    if(request.model!==this.config.model){
      throw this.failure({
        code:"INVALID_REQUEST",
        message:"Requested model is not configured for this provider.",
        request,
        retryable:false,
        details:{category:"configuration"}
      });
    }
    if(request.generation?.responseFormat?.type==="json"){
      throw this.failure({
        code:"UNSUPPORTED",
        message:"Structured output is not supported by this provider.",
        request,
        retryable:false,
        details:{category:"capability"}
      });
    }

    const messages=this.mapMessages(request.context.messages,request);
    const secret=await this.resolveCredential(request);
    const body=JSON.stringify(this.mapRequest(request,messages));
    const started=Date.now();

    let response:HttpClientResponse;
    try{
      response=await this.requestWithTimeout({
        url:this.chatCompletionsUrl(),
        method:"POST",
        headers:{
          Accept:"application/json",
          "Content-Type":"application/json",
          Authorization:"Bearer "+secret
        },
        body
      },this.timeoutMs(),request);
    }catch(error){
      if(error instanceof OpenAICompatibleProviderError)throw error;
      const durationMs=Date.now()-started;
      throw this.failure({
        code:"PROVIDER_UNAVAILABLE",
        message:"OpenAI-compatible provider request could not be completed.",
        request,
        retryable:true,
        details:{category:"network",durationMs}
      });
    }

    const durationMs=Date.now()-started;
    if(response.status<200||response.status>=300){
      throw this.httpFailure(response.status,request,durationMs);
    }

    let payload:unknown;
    try{
      payload=JSON.parse(response.body);
    }catch{
      throw this.failure({
        code:"INVALID_RESPONSE",
        message:"OpenAI-compatible provider returned malformed JSON.",
        request,
        retryable:false,
        details:{category:"malformed_response",durationMs}
      });
    }

    return this.mapResponse(payload,request,durationMs);
  }

  private validConfig():boolean{return this.configError()===undefined;}

  private configError():OpenAICompatibleProviderError|undefined{
    try{
      const url=new URL(this.config.baseUrl);
      if(url.protocol!=="http:"&&url.protocol!=="https:")return safeConfigError("Provider base URL must use HTTP or HTTPS.");
      if(url.username||url.password)return safeConfigError("Provider base URL must not contain credentials.");
      if(url.search||url.hash)return safeConfigError("Provider base URL must not contain query or fragment components.");
    }catch{
      return safeConfigError("Provider base URL is invalid.");
    }
    if(!this.config.model.trim())return safeConfigError("Provider model is not configured.");
    if(!this.config.credential.id.trim())return safeConfigError("Provider credential reference is not configured.");
    if(this.config.timeoutMs!==undefined&&(!Number.isFinite(this.config.timeoutMs)||this.config.timeoutMs<=0)){
      return safeConfigError("Provider timeout must be a finite positive number.");
    }
    return undefined;
  }

  private ensureConfig(request:ChatRequest):void{
    const error=this.configError();
    if(error){
      const chatError={...error.chatError,requestId:request.requestId,providerId:this.id};
      throw new OpenAICompatibleProviderError(chatError);
    }
  }

  private timeoutMs():number{return this.config.timeoutMs??DEFAULT_TIMEOUT_MS;}

  private chatCompletionsUrl():string{
    const base=this.config.baseUrl.replace(/\\/+$/,"");
    return base+"/chat/completions";
  }

  private mapMessages(messages:readonly ChatMessage[],request:ChatRequest):OpenAIChatMessage[]{
    return messages.map(message=>{
      if(message.role==="tool"){
        throw this.failure({
          code:"UNSUPPORTED",
          message:"Tool messages are not supported by this provider.",
          request,
          retryable:false,
          details:{category:"unsupported_message",role:"tool"}
        });
      }
      if(message.toolCallId){
        throw this.failure({
          code:"UNSUPPORTED",
          message:"Tool-call metadata is not supported by this provider.",
          request,
          retryable:false,
          details:{category:"unsupported_message",role:message.role}
        });
      }
      return {role:message.role,content:message.content};
    });
  }

  private mapRequest(request:ChatRequest,messages:readonly OpenAIChatMessage[]){
    const generation=request.generation;
    const payload:{
      model:string;
      messages:OpenAIChatMessage[];
      stream:false;
      temperature?:number;
      max_tokens?:number;
      top_p?:number;
    }={
      model:request.model,
      messages:[...messages],
      stream:false
    };
    if(generation?.temperature!==undefined)payload.temperature=generation.temperature;
    if(generation?.maxTokens!==undefined)payload.max_tokens=generation.maxTokens;
    if(generation?.topP!==undefined)payload.top_p=generation.topP;
    return payload;
  }

  private async resolveCredential(request:ChatRequest):Promise<string>{
    try{
      const secret=await this.credentialStore.getSecret(this.config.credential);
      if(!secret){
        throw this.failure({
          code:"PROVIDER_UNAVAILABLE",
          message:"Chat provider credential is not configured.",
          request,
          retryable:false,
          details:{category:"credential"}
        });
      }
      return secret;
    }catch(error){
      if(error instanceof OpenAICompatibleProviderError)throw error;
      throw this.failure({
        code:"PROVIDER_UNAVAILABLE",
        message:"Chat provider credential is unavailable.",
        request,
        retryable:false,
        details:{category:"credential"}
      });
    }
  }

  private async requestWithTimeout(
    request:HttpClientRequest,
    timeoutMs:number,
    chatRequest:ChatRequest
  ):Promise<HttpClientResponse>{
    const controller=new AbortController();
    let timer:ReturnType<typeof setTimeout>|undefined;
    let timedOut=false;
    const timeoutPromise=new Promise<never>((_,reject)=>{
      timer=setTimeout(()=>{
        timedOut=true;
        controller.abort();
        reject(this.failure({
          code:"PROVIDER_ERROR",
          message:"OpenAI-compatible provider request timed out.",
          request:chatRequest,
          retryable:true,
          details:{category:"timeout",durationMs:timeoutMs}
        }));
      },timeoutMs);
    });
    try{
      return await Promise.race([
        this.httpClient.request({...request,signal:controller.signal}),
        timeoutPromise
      ]);
    }catch(error){
      if(error instanceof OpenAICompatibleProviderError)throw error;
      if(timedOut)throw error;
      const abortName=error&&typeof error==="object"&&"name" in error?(error as {name?:unknown}).name:undefined;
      if(abortName==="AbortError"){
        throw this.failure({
          code:"PROVIDER_UNAVAILABLE",
          message:"OpenAI-compatible provider request was aborted.",
          request:chatRequest,
          retryable:true,
          details:{category:"network"}
        });
      }
      throw error;
    }finally{
      if(timer)clearTimeout(timer);
      controller.abort();
    }
  }

  private httpFailure(status:number,request:ChatRequest,durationMs:number):OpenAICompatibleProviderError{
    if(status===400)return this.failure({code:"PROVIDER_ERROR",message:"OpenAI-compatible provider rejected the chat request.",request,retryable:false,details:{category:"bad_request",httpStatus:status,durationMs}});
    if(status===401||status===403)return this.failure({code:"PROVIDER_ERROR",message:"OpenAI-compatible provider rejected authentication.",request,retryable:false,details:{category:"authentication",httpStatus:status,durationMs}});
    if(status===404)return this.failure({code:"PROVIDER_ERROR",message:"OpenAI-compatible chat endpoint was not found.",request,retryable:false,details:{category:"endpoint",httpStatus:status,durationMs}});
    if(status===429)return this.failure({code:"PROVIDER_ERROR",message:"OpenAI-compatible provider rate limit was reached.",request,retryable:true,details:{category:"rate_limit",httpStatus:status,durationMs}});
    if(status>=500)return this.failure({code:"PROVIDER_ERROR",message:"OpenAI-compatible provider returned a server error.",request,retryable:true,details:{category:"server",httpStatus:status,durationMs}});
    return this.failure({code:"PROVIDER_ERROR",message:"OpenAI-compatible provider returned an unexpected HTTP status.",request,retryable:false,details:{category:"http",httpStatus:status,durationMs}});
  }

  private mapResponse(payload:unknown,request:ChatRequest,durationMs:number):ChatResponse{
    if(!payload||typeof payload!=="object"||Array.isArray(payload)){
      throw this.failure({code:"INVALID_RESPONSE",message:"OpenAI-compatible provider returned an invalid response object.",request,retryable:false,details:{category:"malformed_response",durationMs}});
    }
    const object=payload as Record<string,unknown>;
    const choices=object.choices;
    if(!Array.isArray(choices)||choices.length===0){
      throw this.failure({code:"INVALID_RESPONSE",message:"OpenAI-compatible provider response contains no choices.",request,retryable:false,details:{category:"malformed_response",durationMs}});
    }
    const first=choices[0];
    if(!first||typeof first!=="object"||Array.isArray(first)){
      throw this.failure({code:"INVALID_RESPONSE",message:"OpenAI-compatible provider response contains an invalid first choice.",request,retryable:false,details:{category:"malformed_response",durationMs}});
    }
    const choice=first as Record<string,unknown>;
    const providerMessage=choice.message;
    if(!providerMessage||typeof providerMessage!=="object"||Array.isArray(providerMessage)){
      throw this.failure({code:"INVALID_RESPONSE",message:"OpenAI-compatible provider response is missing the assistant message.",request,retryable:false,details:{category:"missing_assistant_message",durationMs}});
    }
    const message=providerMessage as Record<string,unknown>;
    if(message.role!==undefined&&message.role!=="assistant"){
      throw this.failure({code:"INVALID_RESPONSE",message:"OpenAI-compatible provider returned a non-assistant message.",request,retryable:false,details:{category:"invalid_assistant_message",durationMs}});
    }
    if(typeof message.content!=="string"||message.content.length===0){
      throw this.failure({code:"INVALID_RESPONSE",message:"OpenAI-compatible provider response is missing assistant text content.",request,retryable:false,details:{category:"missing_assistant_content",durationMs}});
    }

    const usage=this.mapUsage(object.usage,request,durationMs);
    const model=typeof object.model==="string"&&object.model.length>0?object.model:request.model;
    const finishReason=this.mapFinishReason(choice.finish_reason);
    const id=typeof object.id==="string"&&object.id.length>0?object.id:request.requestId+":assistant";

    return {
      apiVersion:request.apiVersion,
      schemaVersion:request.schemaVersion,
      requestId:request.requestId,
      conversationId:request.context.conversationId,
      providerId:this.id,
      model,
      message:{id,role:"assistant",content:message.content},
      finishReason,
      ...(usage?{usage}:{}),
      metadata:{durationMs}
    };
  }

  private mapUsage(value:unknown,request:ChatRequest,durationMs:number):ChatUsage|undefined{
    if(value===undefined||value===null)return undefined;
    if(!value||typeof value!=="object"||Array.isArray(value)){
      throw this.failure({code:"INVALID_RESPONSE",message:"OpenAI-compatible provider returned malformed usage data.",request,retryable:false,details:{category:"malformed_usage",durationMs}});
    }
    const usage=value as Record<string,unknown>;
    const promptTokens=this.optionalNonNegativeInteger(usage.prompt_tokens);
    const completionTokens=this.optionalNonNegativeInteger(usage.completion_tokens);
    const totalTokens=this.optionalNonNegativeInteger(usage.total_tokens);
    if((usage.prompt_tokens!==undefined&&promptTokens===undefined)||
      (usage.completion_tokens!==undefined&&completionTokens===undefined)||
      (usage.total_tokens!==undefined&&totalTokens===undefined)){
      throw this.failure({code:"INVALID_RESPONSE",message:"OpenAI-compatible provider returned invalid usage values.",request,retryable:false,details:{category:"malformed_usage",durationMs}});
    }
    return {
      ...(promptTokens===undefined?{}:{promptTokens}),
      ...(completionTokens===undefined?{}:{completionTokens}),
      ...(totalTokens===undefined?{}:{totalTokens})
    };
  }

  private optionalNonNegativeInteger(value:unknown):number|undefined{
    return typeof value==="number"&&Number.isInteger(value)&&value>=0?value:undefined;
  }

  private mapFinishReason(value:unknown):ChatResponse["finishReason"]{
    switch(value){
      case "stop":return "stop";
      case "length":return "length";
      case "content_filter":return "content_filter";
      case "error":return "error";
      default:return "unknown";
    }
  }

  private failure(input:{
    code:ChatError["code"];
    message:string;
    request:ChatRequest;
    retryable:boolean;
    details:Record<string,unknown>;
  }):OpenAICompatibleProviderError{
    return new OpenAICompatibleProviderError({
      apiVersion:input.request.apiVersion,
      schemaVersion:input.request.schemaVersion,
      code:input.code,
      message:input.message,
      requestId:input.request.requestId,
      providerId:this.id,
      retryable:input.retryable,
      details:input.details
    });
  }
}

export const OPENAI_COMPATIBLE_DEFAULT_TIMEOUT_MS=DEFAULT_TIMEOUT_MS;
