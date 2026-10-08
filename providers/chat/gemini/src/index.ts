import type {
  ChatError,
  ChatFinishReason,
  ChatMessage,
  ChatProvider,
  ChatRequest,
  ChatResponse,
  ChatUsage,
  CredentialReference,
  CredentialStore,
  HealthStatus,
  ModelInfo,
  ProviderCapabilities,
  DiagnosticsStore
} from "../../../../contracts/src/index";

export const GEMINI_PROVIDER_ID="gemini";
export const GEMINI_DEFAULT_BASE_URL="https://generativelanguage.googleapis.com/v1beta";
export const GEMINI_DEFAULT_TIMEOUT_MS=30000;

export interface HttpClientRequest{
  url:string;
  method:"GET"|"POST";
  headers:Readonly<Record<string,string>>;
  body?:string;
  signal?:AbortSignal;
}
export interface HttpClientResponse{status:number;body:string}
export interface HttpClient{
  request(request:HttpClientRequest):Promise<HttpClientResponse>;
}
export class FetchHttpClient implements HttpClient{
  async request(request:HttpClientRequest):Promise<HttpClientResponse>{
    const response=await fetch(request.url,{
      method:request.method,
      headers:request.headers,
      ...(request.body===undefined?{}:{body:request.body}),
      signal:request.signal
    });
    return {status:response.status,body:await response.text()};
  }
}

export interface GeminiProviderConfig{
  baseUrl:string;
  model:string;
  credential?:CredentialReference|null;
  timeoutMs?:number;
  diagnostics?:DiagnosticsStore;
  providerPresetId?:string;
}

export class GeminiProviderError extends Error{
  readonly chatError:ChatError;
  constructor(chatError:ChatError){
    super(chatError.message);
    this.name="GeminiProviderError";
    this.chatError=chatError;
  }
}

function redact(value:string):string{
  return value
    .replace(/x-goog-api-key\s*[:=]\s*\S+/gi,"x-goog-api-key=[REDACTED]")
    .replace(/api[_ -]?key\s*[:=]\s*\S+/gi,"api-key=[REDACTED]")
    .replace(/authorization\s*[:=]\s*\S+/gi,"Authorization=[REDACTED]")
    .replace(/secret\s*[:=]\s*\S+/gi,"secret=[REDACTED]");
}

function captureProviderResponse(body?:string):unknown{
  if(!body)return undefined;
  const trimmed=body.trim();
  if(!trimmed)return undefined;
  try{
    const payload=JSON.parse(trimmed) as unknown;
    if(payload&&typeof payload==="object"&&!Array.isArray(payload)){
      const root=payload as Record<string,unknown>;
      const error=root.error;
      if(error&&typeof error==="object"&&!Array.isArray(error)){
        const safe=error as Record<string,unknown>;
        return {
          ...(typeof safe.code==="number"?{code:safe.code}:{}),
          ...(typeof safe.status==="string"?{status:safe.status}:{}),
          ...(typeof safe.message==="string"?{message:redact(safe.message).slice(0,1000)}:{})
        };
      }
    }
  }catch{}
  return redact(trimmed).slice(0,2000);
}

function withProviderResponse(details:Record<string,unknown>,body?:string):Record<string,unknown>{
  const providerResponse=captureProviderResponse(body);
  return providerResponse===undefined?details:{...details,providerResponse};
}

function createAbortError():Error{
  const error=new Error("Gemini provider request aborted.");
  error.name="AbortError";
  return error;
}

function normalizeModelName(value:string):string{
  return value.startsWith("models/")?value.slice("models/".length):value;
}

export function validateGeminiProviderConfig(config:GeminiProviderConfig,options:{allowEmptyModel?:boolean}={}):string[]{
  const errors:string[]=[];
  try{
    const url=new URL(config.baseUrl);
    if(url.protocol!=="http:"&&url.protocol!=="https:")errors.push("Gemini base URL must use HTTP or HTTPS.");
    if(url.username||url.password)errors.push("Gemini base URL must not contain credentials.");
    if(url.search||url.hash)errors.push("Gemini base URL must not contain query or fragment components.");
  }catch{errors.push("Gemini base URL is invalid.");}
  if(!options.allowEmptyModel&&(!config.model||config.model.trim().length===0))errors.push("Gemini model is not configured.");
  if(config.credential!==undefined&&config.credential!==null&&(!config.credential.id||config.credential.id.trim().length===0))errors.push("Gemini credential reference is not configured.");
  if(config.timeoutMs!==undefined&&(!Number.isFinite(config.timeoutMs)||config.timeoutMs<=0))errors.push("Gemini timeout must be a finite positive number.");
  return errors;
}

export class GeminiChatProvider implements ChatProvider{
  readonly id=GEMINI_PROVIDER_ID;
  private readonly config:GeminiProviderConfig;
  private readonly credentialStore:CredentialStore;
  private readonly httpClient:HttpClient;

  constructor(config:GeminiProviderConfig,credentialStore:CredentialStore,httpClient:HttpClient=new FetchHttpClient()){
    this.config=config;
    this.credentialStore=credentialStore;
    this.httpClient=httpClient;
  }

  metadata(){return {id:this.id,kind:"chat" as const,displayName:"Gemini",version:"1.0.0",description:"Native Gemini REST chat provider"};}
  capabilities():ProviderCapabilities{return {streaming:false,toolCalling:false,structuredOutput:false,reasoning:false};}

  async health():Promise<HealthStatus>{
    const configError=this.configError(true);
    if(configError)return {status:"unavailable",message:configError.message,capabilities:["chat"]};
    if(!this.config.credential)return {status:"unavailable",message:"Gemini API credential is not configured.",capabilities:["chat"]};
    try{
      const secret=await this.credentialStore.getSecret(this.config.credential);
      return secret
        ?{status:"healthy",capabilities:["chat"]}
        :{status:"unavailable",message:"Gemini API credential is not configured.",capabilities:["chat"]};
    }catch{
      return {status:"unavailable",message:"Gemini API credential is unavailable.",capabilities:["chat"]};
    }
  }

  async listModels():Promise<ModelInfo[]>{
    const configError=this.configError(true);
    if(configError)return [];
    const secret=await this.resolveCredentialOptional();
    if(!secret)return [];
    const models:ModelInfo[]=[];
    let pageToken:string|undefined;
    for(let page=0;page<20;page+=1){
      const url=this.modelsUrl(pageToken);
      const response=await this.requestWithTimeout({
        url,
        method:"GET",
        headers:{
          Accept:"application/json",
          "x-goog-api-key":secret
        }
      },this.timeoutMs());
      if(response.status<200||response.status>=300){
        throw this.httpFailure(response.status,"model discovery",response.body);
      }
      let payload:unknown;
      try{payload=JSON.parse(response.body)}catch{throw this.failure({code:"INVALID_RESPONSE",message:"Gemini model list returned malformed JSON.",retryable:false,details:{category:"malformed_response"}});}
      if(!payload||typeof payload!=="object"||Array.isArray(payload))throw this.failure({code:"INVALID_RESPONSE",message:"Gemini model list returned an invalid response object.",retryable:false,details:{category:"malformed_response"}});
      const object=payload as Record<string,unknown>;
      const pageModels=object.models;
      if(Array.isArray(pageModels)){
        for(const item of pageModels){
          if(!item||typeof item!=="object"||Array.isArray(item))continue;
          const model=item as Record<string,unknown>;
          const supported=model.supportedGenerationMethods;
          const canGenerate=Array.isArray(supported)?supported.includes("generateContent"):true;
          const name=typeof model.name==="string"?normalizeModelName(model.name):"";
          if(!canGenerate||!name)continue;
          models.push({
            id:name,
            ...(typeof model.displayName==="string"&&model.displayName.trim()?{displayName:model.displayName}:{}),
            capabilities:this.capabilities()
          });
        }
      }
      pageToken=typeof object.nextPageToken==="string"&&object.nextPageToken.trim()?object.nextPageToken:undefined;
      if(!pageToken)break;
    }
    return models;
  }

  async chat(request:ChatRequest):Promise<ChatResponse>{
    this.ensureConfig(request);
    if(request.generation?.responseFormat&&request.generation.responseFormat.type!=="text"){
      throw this.failure({code:"UNSUPPORTED",message:"Gemini provider does not support the requested response format in this version.",request,retryable:false,details:{category:"capability"}});
    }
    const secret=await this.resolveCredential(request);
    const started=Date.now();
    const mapped=this.mapMessages(request.context.messages,request);
    const body=JSON.stringify({
      ...(mapped.systemInstruction?{systemInstruction:mapped.systemInstruction}:{}),
      contents:mapped.contents,
      ...(request.generation&&Object.keys(request.generation).length>0?{generationConfig:this.mapGeneration(request)}:{})
    });
    this.recordDiagnostic(request,"GEMINI_REQUEST_STARTED",{});
    let response:HttpClientResponse;
    try{
      response=await this.requestWithTimeout({
        url:this.generateContentUrl(request.model),
        method:"POST",
        headers:{
          Accept:"application/json",
          "Content-Type":"application/json",
          "x-goog-api-key":secret
        },
        body
      },this.timeoutMs());
    }catch(error){
      if(error instanceof GeminiProviderError)throw error;
      if(error instanceof Error&&error.name==="AbortError")throw error;
      throw this.failure({
        code:"PROVIDER_UNAVAILABLE",
        message:"Gemini provider request could not be completed.",
        request,
        retryable:true,
        details:{category:"network",durationMs:Date.now()-started}
      });
    }
    const durationMs=Date.now()-started;
    this.recordDiagnostic(request,"GEMINI_HTTP_RESPONSE",{httpStatus:response.status,durationMs});
    if(response.status<200||response.status>=300)throw this.httpFailure(response.status,"chat",response.body,request,durationMs);
    let payload:unknown;
    try{payload=JSON.parse(response.body)}catch{throw this.failure({code:"INVALID_RESPONSE",message:"Gemini provider returned malformed JSON.",request,retryable:false,details:{category:"malformed_response",durationMs}});}
    return this.mapResponse(payload,request,durationMs);
  }

  private mapMessages(messages:readonly ChatMessage[],request:ChatRequest):{
    contents:Record<string,unknown>[];
    systemInstruction?:Record<string,unknown>;
  }{
    const contents:Record<string,unknown>[]=[];
    const systemParts:Record<string,unknown>[]=[];
    for(const message of messages){
      if(message.role==="system"){
        if(message.toolCallId)throw this.failure({code:"UNSUPPORTED",message:"Gemini does not support tool metadata in system messages.",request,retryable:false,details:{category:"unsupported_message"}});
        if(message.content)systemParts.push({text:message.content});
        continue;
      }
      if(message.role==="tool"||message.toolCallId){
        throw this.failure({code:"UNSUPPORTED",message:"Gemini tool messages are not supported by this provider.",request,retryable:false,details:{category:"unsupported_message"}});
      }
      const role=message.role==="assistant"?"model":"user";
      contents.push({role,parts:[{text:message.content}]});
    }
    if(contents.length===0)throw this.failure({code:"INVALID_REQUEST",message:"Gemini request requires at least one user or assistant message.",request,retryable:false,details:{category:"configuration"}});
    return {
      contents,
      ...(systemParts.length>0?{systemInstruction:{parts:systemParts}}:{})
    };
  }

  private mapGeneration(request:ChatRequest):Record<string,unknown>{
    const generation=request.generation;
    if(!generation)return {};
    return {
      ...(generation.temperature===undefined?{}:{temperature:generation.temperature}),
      ...(generation.maxTokens===undefined?{}:{maxOutputTokens:generation.maxTokens}),
      ...(generation.topP===undefined?{}:{topP:generation.topP})
    };
  }

  private mapResponse(payload:unknown,request:ChatRequest,durationMs:number):ChatResponse{
    if(!payload||typeof payload!=="object"||Array.isArray(payload))throw this.failure({code:"INVALID_RESPONSE",message:"Gemini provider returned an invalid response object.",request,retryable:false,details:{category:"malformed_response",durationMs}});
    const object=payload as Record<string,unknown>;
    const candidates=object.candidates;
    if(!Array.isArray(candidates)||candidates.length===0)throw this.failure({code:"INVALID_RESPONSE",message:"Gemini provider response contains no candidates.",request,retryable:false,details:{category:"missing_candidate",durationMs}});
    const first=candidates[0];
    if(!first||typeof first!=="object"||Array.isArray(first))throw this.failure({code:"INVALID_RESPONSE",message:"Gemini provider response contains an invalid candidate.",request,retryable:false,details:{category:"malformed_response",durationMs}});
    const candidate=first as Record<string,unknown>;
    const content=candidate.content;
    if(!content||typeof content!=="object"||Array.isArray(content))throw this.failure({code:"INVALID_RESPONSE",message:"Gemini provider response is missing candidate content.",request,retryable:false,details:{category:"missing_assistant_message",durationMs}});
    const parts=(content as Record<string,unknown>).parts;
    const text=Array.isArray(parts)
      ?parts.map(part=>part&&typeof part==="object"&&!Array.isArray(part)&&typeof (part as Record<string,unknown>).text==="string"?(part as Record<string,unknown>).text:"").join("")
      :"";
    if(!text)throw this.failure({code:"INVALID_RESPONSE",message:"Gemini provider response is missing assistant text content.",request,retryable:false,details:{category:"missing_assistant_content",durationMs}});
    return {
      apiVersion:request.apiVersion,
      schemaVersion:request.schemaVersion,
      requestId:request.requestId,
      conversationId:request.context.conversationId,
      providerId:this.id,
      model:typeof object.modelVersion==="string"&&object.modelVersion?normalizeModelName(object.modelVersion):request.model,
      message:{id:request.requestId+":assistant",role:"assistant",content:text},
      finishReason:this.mapFinishReason(candidate.finishReason),
      ...(this.mapUsage(object.usageMetadata)?{usage:this.mapUsage(object.usageMetadata)!}:{}),
      metadata:{durationMs}
    };
  }

  private mapUsage(value:unknown):ChatUsage|undefined{
    if(!value||typeof value!=="object"||Array.isArray(value))return undefined;
    const usage=value as Record<string,unknown>;
    const promptTokens=typeof usage.promptTokenCount==="number"&&Number.isInteger(usage.promptTokenCount)&&usage.promptTokenCount>=0?usage.promptTokenCount:undefined;
    const completionTokens=typeof usage.candidatesTokenCount==="number"&&Number.isInteger(usage.candidatesTokenCount)&&usage.candidatesTokenCount>=0?usage.candidatesTokenCount:undefined;
    const totalTokens=typeof usage.totalTokenCount==="number"&&Number.isInteger(usage.totalTokenCount)&&usage.totalTokenCount>=0?usage.totalTokenCount:undefined;
    return promptTokens===undefined&&completionTokens===undefined&&totalTokens===undefined?undefined:{
      ...(promptTokens===undefined?{}:{promptTokens}),
      ...(completionTokens===undefined?{}:{completionTokens}),
      ...(totalTokens===undefined?{}:{totalTokens})
    };
  }

  private mapFinishReason(value:unknown):ChatFinishReason{
    switch(value){
      case "STOP":return "stop";
      case "MAX_TOKENS":return "length";
      case "SAFETY":
      case "RECITATION":return "content_filter";
      default:return "unknown";
    }
  }

  private configError(allowEmptyModel=false):GeminiProviderError|undefined{
    const error=validateGeminiProviderConfig(this.config,{allowEmptyModel})[0];
    return error?this.failure({code:"INVALID_REQUEST",message:error,retryable:false,details:{category:"configuration"}}):undefined;
  }

  private ensureConfig(request:ChatRequest):void{
    const error=this.configError();
    if(error)throw new GeminiProviderError({...error.chatError,requestId:request.requestId,providerId:this.id});
  }

  private timeoutMs():number{return this.config.timeoutMs??GEMINI_DEFAULT_TIMEOUT_MS;}
  private baseUrl():string{return this.config.baseUrl.replace(/\/+$/,"");}
  private generateContentUrl(model:string):string{
    const normalized=normalizeModelName(model.trim());
    return this.baseUrl()+"/models/"+encodeURIComponent(normalized)+":generateContent";
  }
  private modelsUrl(pageToken?:string):string{
    const base=this.baseUrl()+"/models?pageSize=1000";
    return pageToken?base+"&pageToken="+encodeURIComponent(pageToken):base;
  }

  private async resolveCredential(request:ChatRequest):Promise<string>{
    if(!this.config.credential)throw this.failure({code:"PROVIDER_UNAVAILABLE",message:"Gemini API credential is not configured.",request,retryable:false,details:{category:"credential"}});
    try{
      const secret=await this.credentialStore.getSecret(this.config.credential);
      if(!secret)throw new Error("missing credential");
      return secret;
    }catch{
      throw this.failure({code:"PROVIDER_UNAVAILABLE",message:"Gemini API credential is unavailable.",request,retryable:false,details:{category:"credential"}});
    }
  }

  private async resolveCredentialOptional():Promise<string|undefined>{
    if(!this.config.credential)return undefined;
    try{return await this.credentialStore.getSecret(this.config.credential)||undefined}catch{return undefined}
  }

  private async requestWithTimeout(request:HttpClientRequest,timeoutMs:number):Promise<HttpClientResponse>{
    const controller=new AbortController();
    let timer:ReturnType<typeof setTimeout>|undefined;
    let timedOut=false;
    const timeoutPromise=new Promise<never>((_,reject)=>{
      timer=setTimeout(()=>{
        timedOut=true;
        controller.abort();
        const error=new Error("Gemini provider request timed out.");
        error.name="AbortError";
        reject(error);
      },timeoutMs);
    });
    try{
      return await Promise.race([
        this.httpClient.request({...request,signal:controller.signal}),
        timeoutPromise
      ]);
    }catch(error){
      if(timedOut)throw this.failure({
        code:"PROVIDER_ERROR",
        message:"Gemini provider request timed out.",
        retryable:true,
        details:{category:"timeout",timeoutMs}
      });
      const name=error&&typeof error==="object"&&"name" in error?(error as {name?:unknown}).name:undefined;
      if(name==="AbortError")throw createAbortError();
      if(error instanceof GeminiProviderError)throw error;
      throw error;
    }finally{
      if(timer)clearTimeout(timer);
      controller.abort();
    }
  }

  private httpFailure(status:number,operation:string,body:string|undefined,request?:ChatRequest,durationMs?:number):GeminiProviderError{
    const details={
      category:status===401||status===403?"authentication":status===429?"rate_limit":status>=500?"server":"http",
      httpStatus:status,
      ...(durationMs===undefined?{}:{durationMs}),
      operation
    };
    if(status===401||status===403)return this.failure({code:"PROVIDER_ERROR",message:"Gemini provider rejected authentication.",request,retryable:false,details:withProviderResponse(details,body)});
    if(status===429)return this.failure({code:"PROVIDER_ERROR",message:"Gemini provider rate limit was reached.",request,retryable:true,details:withProviderResponse(details,body)});
    if(status>=500)return this.failure({code:"PROVIDER_ERROR",message:"Gemini provider returned a server error.",request,retryable:true,details:withProviderResponse(details,body)});
    if(status===400)return this.failure({code:"PROVIDER_ERROR",message:"Gemini provider rejected the request.",request,retryable:false,details:withProviderResponse(details,body)});
    return this.failure({code:"PROVIDER_ERROR",message:"Gemini provider returned an HTTP error.",request,retryable:false,details:withProviderResponse(details,body)});
  }

  private recordDiagnostic(request:ChatRequest,code:string,metadata:Record<string,unknown>):void{
    this.config.diagnostics?.recordError("chat-provider",code,"Gemini provider request event",{
      requestId:request.requestId,
      providerId:this.id,
      ...(this.config.providerPresetId?{providerPresetId:this.config.providerPresetId}:{}),
      model:request.model,
      baseUrlHost:this.safeBaseUrlHost(),
      ...metadata
    });
  }

  private safeBaseUrlHost():string|undefined{
    try{return new URL(this.config.baseUrl).host||undefined}catch{return undefined}
  }

  private failure(input:{
    code:ChatError["code"];
    message:string;
    retryable:boolean;
    details:Record<string,unknown>;
    request?:ChatRequest;
  }):GeminiProviderError{
    return new GeminiProviderError({
      apiVersion:input.request?.apiVersion??"1",
      schemaVersion:input.request?.schemaVersion??"1",
      code:input.code,
      message:input.message,
      requestId:input.request?.requestId,
      providerId:this.id,
      retryable:input.retryable,
      details:input.details
    });
  }
}
