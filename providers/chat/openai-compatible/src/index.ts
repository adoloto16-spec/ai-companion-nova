import type {
  ChatError,
  ChatFinishReason,
  ChatMessage,
  ChatProvider,
  ChatRequest,
  ChatResponse,
  ChatStreamDone,
  ChatStreamHandlers,
  ChatStreamOptions,
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
  method:"GET"|"POST";
  headers:Readonly<Record<string,string>>;
  body?:string;
  signal?:AbortSignal;
}

export interface HttpClientResponse{
  status:number;
  body:string;
}
export interface HttpClientStreamResponse{
  status:number;
  body:AsyncIterable<string>;
  headers?:Readonly<Record<string,string>>;
}
export interface HttpClient{
  request(request:HttpClientRequest):Promise<HttpClientResponse>;
  stream?(request:HttpClientRequest):Promise<HttpClientStreamResponse>;
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

  async stream(request:HttpClientRequest):Promise<HttpClientStreamResponse>{
    const response=await fetch(request.url,{
      method:request.method,
      headers:request.headers,
      ...(request.body===undefined?{}:{body:request.body}),
      signal:request.signal
    });
    const body=response.body;
    if(!body)throw new Error("Streaming response body is unavailable.");
    const reader=body.getReader();
    const headers=Object.fromEntries(response.headers.entries());
    const iterable:AsyncIterable<string>={
      async *[Symbol.asyncIterator](){
        const decoder=new TextDecoder();
        try{
          while(true){
            const next=await reader.read();
            if(next.done)break;
            if(next.value){
              const text=decoder.decode(next.value,{stream:true});
              if(text)yield text;
            }
          }
          const tail=decoder.decode();
          if(tail)yield tail;
        }finally{
          reader.releaseLock();
        }
      }
    };
    return {status:response.status,headers,body:iterable};
  }
}

export interface OpenAICompatibleProviderConfig{
  baseUrl:string;
  model:string;
  credential?:CredentialReference|null;
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

export function validateOpenAICompatibleProviderConfig(config:OpenAICompatibleProviderConfig,options:{allowEmptyModel?:boolean}={}):string[]{
  const errors:string[]=[];
  try{
    const url=new URL(config.baseUrl);
    if(url.protocol!=="http:"&&url.protocol!=="https:")errors.push("Provider base URL must use HTTP or HTTPS.");
    if(url.username||url.password)errors.push("Provider base URL must not contain credentials.");
    if(url.search||url.hash)errors.push("Provider base URL must not contain query or fragment components.");
  }catch{errors.push("Provider base URL is invalid.");}
  if(!options.allowEmptyModel&&(!config.model||config.model.trim().length===0))errors.push("Provider model is not configured.");
  if(config.credential!==undefined&&config.credential!==null&&(!config.credential.id||config.credential.id.trim().length===0))errors.push("Provider credential reference is not configured.");
  if(config.timeoutMs!==undefined&&(!Number.isFinite(config.timeoutMs)||config.timeoutMs<=0))errors.push("Provider timeout must be a finite positive number.");
  return errors;
}

function createAbortError():Error{
  const error=new Error("The operation was aborted.");
  error.name="AbortError";
  return error;
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
  private modelsCache:{expiresAt:number;models:ModelInfo[]}|undefined;

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
      description:"OpenAI-compatible Chat Completions adapter with synchronous and SSE streaming paths."
    };
  }

  capabilities():ProviderCapabilities{
    return {
      streaming:true,
      toolCalling:false,
      structuredOutput:true,
      reasoning:false
    };
  }

  async listModels():Promise<ModelInfo[]>{
    if(!this.validConfig(true))return [];
    const now=Date.now();
    if(this.modelsCache&&this.modelsCache.expiresAt>now)return this.modelsCache.models.map(model=>({...model}));
    try{
      const secret=await this.resolveCredentialOptional();
      const response=await this.requestWithTimeoutRaw({
        url:this.modelsUrl(),
        method:"GET",
        headers:{
          Accept:"application/json",
          ...(secret?{Authorization:"Bearer "+secret}:{}),
        }
      },this.timeoutMs());
      if(response.status<200||response.status>=300)return [];
      const payload:unknown=JSON.parse(response.body);
      const items:unknown[]=Array.isArray(payload)
        ?payload as unknown[]
        :payload&&typeof payload==="object"&&Array.isArray((payload as Record<string,unknown>).data)
          ?(payload as Record<string,unknown>).data as unknown[]
          :[];
      const models=items.flatMap((item:unknown)=>{
        if(!item||typeof item!=="object"||Array.isArray(item))return [];
        const record=item as Record<string,unknown>;
        if(typeof record.id!=="string"||!record.id.trim())return [];
        const displayName=typeof record.displayName==="string"?record.displayName:typeof record.name==="string"?record.name:record.id;
        return [{id:record.id,displayName,capabilities:this.capabilities()}];
      });
      if(models.length===0)return [];
      this.modelsCache={expiresAt:now+60_000,models};
      return models.map(model=>({...model}));
    }catch{
      return [];
    }
  }

  async stream(request:ChatRequest,handlers:ChatStreamHandlers,options:ChatStreamOptions={}):Promise<ChatResponse>{
    this.ensureConfig(request);
    if(!request.model.trim()){
      throw this.failure({code:"INVALID_REQUEST",message:"Requested model is not configured for this provider.",request,retryable:false,details:{category:"configuration"}});
    }
    const messages=this.mapMessages(request.context.messages,request);
    const secret=await this.resolveCredential(request);
    const body=JSON.stringify(this.mapRequest(request,messages,true));
    const started=Date.now();
    const controller=new AbortController();
    let timedOut=false;
    let timer:ReturnType<typeof setTimeout>|undefined;
    const callerSignal=options.signal;
    const callerAbort=()=>controller.abort();
    if(callerSignal){
      if(callerSignal.aborted)throw createAbortError();
      callerSignal.addEventListener("abort",callerAbort,{once:true});
    }
    timer=setTimeout(()=>{timedOut=true;controller.abort();},this.timeoutMs());

    try{
      if(!this.httpClient.stream)throw this.failure({
        code:"UNSUPPORTED",
        message:"Streaming is not supported by this HTTP transport.",
        request,
        retryable:false,
        details:{category:"transport"}
      });

      const response=await this.httpClient.stream({
        url:this.chatCompletionsUrl(),
        method:"POST",
        headers:{
          Accept:"text/event-stream",
          "Content-Type":"application/json",
          ...(secret?{Authorization:"Bearer "+secret}:{}),
        },
        body,
        signal:controller.signal
      });

      const durationMs=Date.now()-started;
      if(response.status<200||response.status>=300)throw this.httpFailure(response.status,request,durationMs);

      let buffer="";
      let finishReason:ChatResponse["finishReason"]="unknown";
      let model=request.model;
      let usage:ChatUsage|undefined;
      let completed=false;

      const emitCompleted=async()=>{
        if(completed)return;
        completed=true;
        const event:ChatStreamDone={
          apiVersion:"1",
          schemaVersion:"1",
          requestId:request.requestId,
          conversationId:request.context.conversationId,
          providerId:this.id,
          model,
          type:"completed",
          finishReason,
          ...(usage?{usage}: {})
        };
        await handlers.onEvent(event);
      };

      const processEvent=async(data:string)=>{
        const trimmed=data.trim();
        if(!trimmed)return;
        if(trimmed==="[DONE]"){
          finishReason=finishReason==="unknown"?"stop":finishReason;
          await emitCompleted();
          return;
        }

        let payload:unknown;
        try{payload=JSON.parse(trimmed);}catch{
          throw this.failure({
            code:"INVALID_RESPONSE",
            message:"OpenAI-compatible provider returned malformed streaming JSON.",
            request,
            retryable:false,
            details:{category:"malformed_stream_event",durationMs:Date.now()-started}
          });
        }
        if(!payload||typeof payload!=="object"||Array.isArray(payload)){
          throw this.failure({
            code:"INVALID_RESPONSE",
            message:"OpenAI-compatible provider returned an invalid streaming event.",
            request,
            retryable:false,
            details:{category:"malformed_stream_event",durationMs:Date.now()-started}
          });
        }

        const record=payload as Record<string,unknown>;
        if(typeof record.model==="string"&&record.model.trim())model=record.model;
        if(record.usage!==undefined&&record.usage!==null){
          usage=this.mapUsage(record.usage,request,Date.now()-started);
          if(usage)await handlers.onEvent({
            apiVersion:"1",
            schemaVersion:"1",
            requestId:request.requestId,
            conversationId:request.context.conversationId,
            providerId:this.id,
            model,
            type:"usage",
            usage
          });
        }

        const choices=record.choices;
        if(!Array.isArray(choices)||choices.length===0)return;
        const first=choices[0];
        if(!first||typeof first!=="object"||Array.isArray(first)){
          throw this.failure({
            code:"INVALID_RESPONSE",
            message:"OpenAI-compatible provider returned an invalid streaming choice.",
            request,
            retryable:false,
            details:{category:"malformed_stream_choice",durationMs:Date.now()-started}
          });
        }
        const choice=first as Record<string,unknown>;
        if(typeof choice.finish_reason==="string")finishReason=this.mapFinishReason(choice.finish_reason);

        const delta=choice.delta;
        if(delta&&typeof delta==="object"&&!Array.isArray(delta)){
          const content=(delta as Record<string,unknown>).content;
          if(content!==undefined&&typeof content!=="string"){
            throw this.failure({
              code:"INVALID_RESPONSE",
              message:"OpenAI-compatible provider returned non-text streaming content.",
              request,
              retryable:false,
              details:{category:"malformed_stream_delta",durationMs:Date.now()-started}
            });
          }
          if(typeof content==="string"&&content.length>0){
            await handlers.onEvent({
              apiVersion:"1",
              schemaVersion:"1",
              requestId:request.requestId,
              conversationId:request.context.conversationId,
              providerId:this.id,
              model,
              type:"delta",
              text:content
            });
          }
        }
      };

      const iterator=response.body[Symbol.asyncIterator]();
      let resolveAbort:(value:never)=>void=()=>{};
      let rejectAbort:(reason:unknown)=>void=()=>{};
      const abortPromise=new Promise<never>((_,reject)=>{
        rejectAbort=reject;
        resolveAbort=()=>{};
      });
      const abortListener=()=>{
        rejectAbort(createAbortError());
      };
      const listenSignal=controller.signal;
      if(listenSignal.aborted)throw createAbortError();
      listenSignal.addEventListener("abort",abortListener,{once:true});

      try{
        while(true){
          let next:IteratorResult<string>;
          try{
            next=await Promise.race([iterator.next(),abortPromise]);
          }catch(error){
            if(callerSignal?.aborted)throw createAbortError();
            if(timedOut)throw this.failure({
              code:"PROVIDER_ERROR",
              message:"OpenAI-compatible provider streaming request timed out.",
              request,
              retryable:true,
              details:{category:"timeout",durationMs:this.timeoutMs()}
            });
            throw error;
          }
          if(next.done)break;
          buffer+=next.value;
          while(true){
            const match=/\r\n\r\n|\n\n|\r\r/.exec(buffer);
            if(!match||match.index===undefined)break;
            const eventText=buffer.slice(0,match.index);
            buffer=buffer.slice(match.index+match[0].length);
            const dataLines=eventText
              .split(/\r\n|\n|\r/)
              .filter(line=>line.startsWith("data:"))
              .map(line=>line.slice(5).startsWith(" ")?line.slice(6):line.slice(5));
            if(dataLines.length>0){
              await processEvent(dataLines.join("\n"));
              if(completed){buffer="";break;}
            }
          }
          if(completed)break;
        }

        if(buffer.trim()&&!completed){
          const dataLines=buffer
            .split(/\r\n|\n|\r/)
            .filter(line=>line.startsWith("data:"))
            .map(line=>line.slice(5).startsWith(" ")?line.slice(6):line.slice(5));
          if(dataLines.length>0)await processEvent(dataLines.join("\n"));
        }

        if(!completed){
          if(finishReason==="unknown"){
            throw this.failure({
              code:"INVALID_RESPONSE",
              message:"OpenAI-compatible provider stream ended without a completion event.",
              request,
              retryable:true,
              details:{category:"incomplete_stream",durationMs:Date.now()-started}
            });
          }
          await emitCompleted();
        }

        return {
          apiVersion:request.apiVersion,
          schemaVersion:request.schemaVersion,
          requestId:request.requestId,
          conversationId:request.context.conversationId,
          providerId:this.id,
          model,
          message:{id:request.requestId+":assistant",role:"assistant",content:""},
          finishReason,
          ...(usage?{usage}: {}),
          metadata:{streaming:true,durationMs:Date.now()-started}
        };
      }finally{
        listenSignal.removeEventListener("abort",abortListener);
      }
    }catch(error){
      if(callerSignal?.aborted)throw createAbortError();
      if(timedOut){
        throw this.failure({
          code:"PROVIDER_ERROR",
          message:"OpenAI-compatible provider streaming request timed out.",
          request,
          retryable:true,
          details:{category:"timeout",durationMs:this.timeoutMs()}
        });
      }
      if(error instanceof OpenAICompatibleProviderError)throw error;
      const durationMs=Date.now()-started;
      throw this.failure({
        code:"PROVIDER_UNAVAILABLE",
        message:"OpenAI-compatible provider streaming request could not be completed.",
        request,
        retryable:true,
        details:{category:"network",durationMs}
      });
    }finally{
      if(timer)clearTimeout(timer);
      callerSignal?.removeEventListener("abort",callerAbort);
      controller.abort();
    }
  }

  async health():Promise<HealthStatus>{
    const configError=this.configError();
    if(configError)return {status:"unavailable",message:configError.message,capabilities:["chat","streaming"]};
    if(!this.config.credential)return {status:"unavailable",message:"Chat provider credential is not configured.",capabilities:["chat","streaming"]};
    try{
      const secret=await this.credentialStore.getSecret(this.config.credential);
      if(!secret)return {status:"unavailable",message:"Chat provider credential is not configured.",capabilities:["chat","streaming"]};
      return {status:"healthy",capabilities:["chat","streaming"]};
    }catch{
      return {status:"unavailable",message:"Chat provider credential is unavailable.",capabilities:["chat","streaming"]};
    }
  }

  async chat(request:ChatRequest):Promise<ChatResponse>{
    this.ensureConfig(request);
    if(!request.model.trim()){
      throw this.failure({code:"INVALID_REQUEST",message:"Requested model is not configured for this provider.",request,retryable:false,details:{category:"configuration"}});
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
          ...(secret?{Authorization:"Bearer "+secret}:{}),
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

  private validConfig(allowEmptyModel=false):boolean{return this.configError(allowEmptyModel)===undefined;}

  private configError(allowEmptyModel=false):OpenAICompatibleProviderError|undefined{
    const errors=validateOpenAICompatibleProviderConfig(this.config,{allowEmptyModel});
    return errors.length>0?safeConfigError(errors[0]!):undefined;
  }

  private ensureConfig(request:ChatRequest):void{
    const error=this.configError();
    if(error){
      const chatError={...error.chatError,requestId:request.requestId,providerId:this.id};
      throw new OpenAICompatibleProviderError(chatError);
    }
  }

  private timeoutMs():number{return this.config.timeoutMs??DEFAULT_TIMEOUT_MS;}

  private modelsUrl():string{
    const base=this.config.baseUrl.replace(/\/+$/,"");
    return base+"/models";
  }

  private chatCompletionsUrl():string{
    const base=this.config.baseUrl.replace(/\/+$/,"");
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

  private isStructuredUnsupportedResponse(body?:string):boolean{
    if(!body)return false;
    const normalized=body.toLocaleLowerCase();
    const mentionsFormat=normalized.includes("response_format")||normalized.includes("json_schema")||normalized.includes("structured output")||normalized.includes("structured_output");
    const mentionsUnsupported=normalized.includes("unsupported")||normalized.includes("not supported")||normalized.includes("does not support")||normalized.includes("unknown parameter")||normalized.includes("unrecognized parameter");
    return mentionsFormat&&mentionsUnsupported;
  }

  private mapRequest(request:ChatRequest,messages:readonly OpenAIChatMessage[],stream=false){
    const generation=request.generation;
    const payload:{
      model:string;
      messages:OpenAIChatMessage[];
      stream:boolean;
      temperature?:number;
      max_tokens?:number;
      top_p?:number;
      response_format?:Record<string,unknown>;
    }={
      model:request.model,
      messages:[...messages],
      stream
    };
    if(generation?.temperature!==undefined)payload.temperature=generation.temperature;
    if(generation?.maxTokens!==undefined)payload.max_tokens=generation.maxTokens;
    if(generation?.topP!==undefined)payload.top_p=generation.topP;
    const responseFormat=generation?.responseFormat;
    if(responseFormat?.type==="json"){
      payload.response_format={type:"json_object"};
    }else if(responseFormat?.type==="json-schema"){
      payload.response_format={
        type:"json_schema",
        json_schema:{
          name:responseFormat.name??"structured_output",
          strict:responseFormat.strict??true,
          schema:responseFormat.schema
        }
      };
    }
    return payload;
  }

  private async resolveCredential(request:ChatRequest):Promise<string|undefined>{
    if(!this.config.credential){
      return undefined;
    }
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

  private async resolveCredentialOptional():Promise<string|undefined>{
    if(!this.config.credential)return undefined;
    try{return await this.credentialStore.getSecret(this.config.credential)||undefined;}catch{return undefined;}
  }

  private async requestWithTimeoutRaw(request:HttpClientRequest,timeoutMs:number):Promise<HttpClientResponse>{
    const controller=new AbortController();
    let timer:ReturnType<typeof setTimeout>|undefined;
    const timeoutPromise=new Promise<never>((_,reject)=>{
      timer=setTimeout(()=>{controller.abort();reject(new Error("request timeout"));},timeoutMs);
    });
    try{return await Promise.race([this.httpClient.request({...request,signal:controller.signal}),timeoutPromise]);}
    finally{if(timer)clearTimeout(timer);controller.abort();}
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

  private httpFailure(status:number,request:ChatRequest,durationMs:number,body?:string):OpenAICompatibleProviderError{
    if((status===400||status===422)&&request.generation?.responseFormat?.type==="json-schema"&&this.isStructuredUnsupportedResponse(body)){
      return this.failure({code:"UNSUPPORTED",message:"OpenAI-compatible provider does not support the requested structured output.",request,retryable:false,details:{category:"capability",httpStatus:status,durationMs}});
    }
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
