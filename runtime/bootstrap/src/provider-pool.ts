import type {
  ChatError,
  ChatFinishReason,
  ChatProvider,
  ChatRequest,
  ChatResponse,
  ChatStreamHandlers,
  ChatStreamOptions,
  ProviderPreset,
  ProviderPresetSource,
  ProviderCapabilities,
  CredentialStore,
  DiagnosticsStore,
  HealthStatus,
  ModelInfo
} from "../../../contracts/src/index";

const TEMPORARY_COOLDOWN_MS=5000;
const RATE_LIMIT_COOLDOWN_MS=30000;

export interface ProviderPoolSourceDiagnostics{
  providerPresetId:string;
  sourceId:string;
  providerId:string;
  baseUrlHost?:string;
  model:string;
  health:ProviderPresetSource["health"];
  failureCount:number;
  cooldownUntil:string|null;
}

export interface ProviderPoolOptions{
  preset:ProviderPreset;
  credentialStore:CredentialStore;
  diagnostics?:DiagnosticsStore;
  createProvider:(source:ProviderPresetSource,diagnostics?:DiagnosticsStore)=>ChatProvider|undefined;
  onStateChanged?:(preset:ProviderPreset)=>void|Promise<void>;
}

export class ProviderPoolError extends Error{
  readonly chatError:ChatError;
  constructor(chatError:ChatError){
    super(chatError.message);
    this.name="ProviderPoolError";
    this.chatError=chatError;
  }
}

function isAbortError(error:unknown):boolean{
  return error instanceof Error&&error.name==="AbortError";
}

function readChatError(error:unknown):ChatError|undefined{
  if(error&&typeof error==="object"&&"chatError" in error){
    const value=(error as {chatError?:unknown}).chatError;
    if(value&&typeof value==="object")return value as ChatError;
  }
  return undefined;
}

function failureCategory(error:unknown):string|undefined{
  const details=readChatError(error)?.details;
  return typeof details?.category==="string"?details.category:undefined;
}

function isFailoverEligible(error:unknown):boolean{
  if(isAbortError(error))return false;
  const category=failureCategory(error);
  return category==="network"||
    category==="timeout"||
    category==="authentication"||
    category==="rate_limit"||
    category==="server"||
    category==="transport";
}

function cooldownFor(category:string|undefined):number{
  return category==="rate_limit"?RATE_LIMIT_COOLDOWN_MS:TEMPORARY_COOLDOWN_MS;
}

function now():string{return new Date().toISOString();}

function isSourceCoolingDown(source:ProviderPresetSource,at=Date.now()):boolean{
  return Boolean(source.cooldownUntil&&Date.parse(source.cooldownUntil)>at);
}

function cloneSource(source:ProviderPresetSource):ProviderPresetSource{
  return {...source,credentialReference:source.credentialReference?{...source.credentialReference}:null};
}

function clonePreset(preset:ProviderPreset):ProviderPreset{
  return {...preset,sources:preset.sources.map(cloneSource)};
}

function safeBaseUrlHost(source:ProviderPresetSource):string|undefined{
  try{return new URL(source.baseUrl).host||undefined}catch{return undefined}
}

function failureReason(error:unknown):{
  category:string;
  providerId?:string;
  httpStatus?:number;
  durationMs?:number;
}{
  const chatError=readChatError(error);
  const details=chatError?.details;
  return {
    category:typeof details?.category==="string"?details.category:"transport",
    ...(typeof chatError?.providerId==="string"?{providerId:chatError.providerId}:{}),
    ...(typeof details?.httpStatus==="number"?{httpStatus:details.httpStatus}:{}),
    ...(typeof details?.durationMs==="number"?{durationMs:details.durationMs}:{})
  };
}

export class ProviderPoolChatProvider implements ChatProvider{
  readonly id:string;
  private preset:ProviderPreset;
  private readonly options:ProviderPoolOptions;
  private stateLock=Promise.resolve();

  constructor(options:ProviderPoolOptions){
    this.options=options;
    this.preset=clonePreset(options.preset);
    this.id="provider-pool:"+this.preset.id;
  }

  metadata(){return {
    id:this.id,
    kind:"chat" as const,
    displayName:"Provider Pool",
    version:"2.0.0",
    description:"ProviderPreset source pool with deterministic failover"
  };}

  capabilities():ProviderCapabilities{
    const source=this.selectSource(new Set());
    if(!source)return {};
    const provider=this.options.createProvider(source,this.options.diagnostics);
    return provider?.capabilities()??{};
  }

  async health():Promise<HealthStatus>{
    const source=this.selectSource(new Set());
    if(!source)return {status:"unavailable",message:"No enabled provider source is currently available.",capabilities:["chat"]};
    const provider=this.options.createProvider(source,this.options.diagnostics);
    if(!provider)return {status:"unavailable",message:"The active provider source is not configured.",capabilities:["chat"]};
    const health=await provider.health();
    return health;
  }

  async listModels():Promise<ModelInfo[]>{
    const attempted=new Set<string>();
    let lastError:unknown;
    while(true){
      const source=this.selectSource(attempted);
      if(!source)break;
      attempted.add(source.id);
      const provider=this.options.createProvider(source,this.options.diagnostics);
      if(!provider){
        await this.markFailure(source,"configuration");
        continue;
      }
      try{
        const models=await provider.listModels();
        await this.markSuccess(source);
        return models;
      }catch(error){
        lastError=error;
        if(!isFailoverEligible(error))throw error;
        await this.markFailure(source,failureCategory(error));
      }
    }
    throw this.aggregateError(undefined,lastError,attempted);
  }

  async chat(request:ChatRequest):Promise<ChatResponse>{
    const attempted=new Set<string>();
    let lastError:unknown;
    while(true){
      const source=this.selectSource(attempted);
      if(!source)break;
      attempted.add(source.id);
      const provider=this.options.createProvider(source,this.options.diagnostics);
      if(!provider){
        await this.markFailure(source,"configuration");
        continue;
      }
      const sourceRequest={...request,providerId:source.providerId,model:source.model};
      try{
        const response=await provider.chat(sourceRequest);
        await this.markSuccess(source);
        return response;
      }catch(error){
        lastError=error;
        if(!isFailoverEligible(error))throw error;
        await this.markFailure(source,failureCategory(error));
        this.recordFailoverFailure(source,error);
      }
    }
    throw this.aggregateError(request,lastError,attempted);
  }

  async stream(request:ChatRequest,handlers:ChatStreamHandlers,options:ChatStreamOptions={}):Promise<ChatResponse>{
    const attempted=new Set<string>();
    let lastError:unknown;
    while(true){
      if(options.signal?.aborted)throw new DOMException("The operation was aborted.","AbortError");
      const source=this.selectSource(attempted);
      if(!source)break;
      attempted.add(source.id);
      const provider=this.options.createProvider(source,this.options.diagnostics);
      if(!provider){
        await this.markFailure(source,"configuration");
        continue;
      }
      const sourceRequest={...request,providerId:source.providerId,model:source.model};
      try{
        if(provider.stream){
          const response=await provider.stream(sourceRequest,handlers,options);
          await this.markSuccess(source);
          return response;
        }
        const response=await provider.chat(sourceRequest);
        if(options.signal?.aborted)throw new DOMException("The operation was aborted.","AbortError");
        await handlers.onEvent({
          apiVersion:request.apiVersion,
          schemaVersion:"1",
          requestId:request.requestId,
          conversationId:request.context.conversationId,
          providerId:response.providerId,
          model:response.model,
          type:"delta",
          text:response.message.content
        });
        await handlers.onEvent({
          apiVersion:request.apiVersion,
          schemaVersion:"1",
          requestId:request.requestId,
          conversationId:request.context.conversationId,
          providerId:response.providerId,
          model:response.model,
          type:"completed",
          finishReason:response.finishReason,
          ...(response.usage?{usage:response.usage}: {})
        });
        await this.markSuccess(source);
        return response;
      }catch(error){
        lastError=error;
        if(isAbortError(error))throw error;
        if(!isFailoverEligible(error))throw error;
        await this.markFailure(source,failureCategory(error));
        this.recordFailoverFailure(source,error);
      }
    }
    throw this.aggregateError(request,lastError,attempted);
  }

  getModel():string{
    return this.selectSource(new Set())?.model??"";
  }

  getDiagnostics():ProviderPoolSourceDiagnostics{
    const source=this.selectSource(new Set())??this.preset.sources[0];
    if(!source){
      return {providerPresetId:this.preset.id,sourceId:"",providerId:"",model:"",health:"unavailable",failureCount:0,cooldownUntil:null};
    }
    return {
      providerPresetId:this.preset.id,
      sourceId:source.id,
      providerId:source.providerId,
      ...(safeBaseUrlHost(source)?{baseUrlHost:safeBaseUrlHost(source)}:{}),
      model:source.model,
      health:source.health,
      failureCount:source.failureCount,
      cooldownUntil:source.cooldownUntil
    };
  }

  getPreset():ProviderPreset{return clonePreset(this.preset);}

  private selectSource(attempted:Set<string>):ProviderPresetSource|undefined{
    const sources=this.preset.sources;
    const activeIndex=this.preset.activeSourceId?Math.max(0,sources.findIndex(source=>source.id===this.preset.activeSourceId)):0;
    for(let offset=0;offset<sources.length;offset+=1){
      const source=sources[(activeIndex+offset)%sources.length];
      if(!source||attempted.has(source.id)||!source.enabled)continue;
      if(source.health==="unavailable")continue;
      if(isSourceCoolingDown(source))continue;
      return source;
    }
    return undefined;
  }

  private async withStateLock<T>(operation:()=>Promise<T>|T):Promise<T>{
    const previous=this.stateLock;
    let release:()=>void=()=>{};
    this.stateLock=new Promise<void>(resolve=>{release=resolve});
    await previous;
    try{return await operation();}finally{release();}
  }

  private async markSuccess(source:ProviderPresetSource):Promise<void>{
    await this.withStateLock(async()=>{
      const current=this.preset.sources.find(item=>item.id===source.id);
      if(!current)return;
      current.health="healthy";
      current.failureCount=0;
      current.cooldownUntil=null;
      current.updatedAt=now();
      this.preset.activeSourceId=current.id;
      await this.persistState();
      this.options.diagnostics?.recordError("provider-pool","PROVIDER_SOURCE_RECOVERED","Provider pool source recovered",{
        providerPresetId:this.preset.id,
        sourceId:current.id,
        providerId:current.providerId,
        ...(safeBaseUrlHost(current)?{baseUrlHost:safeBaseUrlHost(current)}:{}),
        model:current.model,
        health:current.health,
        failureCount:current.failureCount
      });
    });
  }

  private async markFailure(source:ProviderPresetSource,category?:string):Promise<void>{
    await this.withStateLock(async()=>{
      const current=this.preset.sources.find(item=>item.id===source.id);
      if(!current)return;
      current.failureCount+=1;
      current.updatedAt=now();
      if(category==="authentication"){
        current.health="unavailable";
        current.cooldownUntil=null;
      }else if(category==="configuration"){
        current.health="unavailable";
        current.cooldownUntil=null;
      }else{
        current.health="cooldown";
        current.cooldownUntil=new Date(Date.now()+cooldownFor(category)).toISOString();
      }
      const next=this.nextEnabledSource(current.id);
      if(this.preset.activeSourceId===current.id&&next)this.preset.activeSourceId=next.id;
      await this.persistState();
    });
  }

  private nextEnabledSource(sourceId:string):ProviderPresetSource|undefined{
    const sources=this.preset.sources;
    const currentIndex=sources.findIndex(source=>source.id===sourceId);
    for(let offset=1;offset<=sources.length;offset+=1){
      const source=sources[(currentIndex+offset)%sources.length];
      if(source?.enabled&&source.health!=="unavailable"&&!isSourceCoolingDown(source))return source;
    }
    return undefined;
  }

  private async persistState():Promise<void>{
    try{await this.options.onStateChanged?.(clonePreset(this.preset));}catch(error){
      this.options.diagnostics?.recordError("provider-pool","PROVIDER_POOL_STATE_PERSIST_FAILED","Provider pool state could not be persisted");
    }
  }

  private recordFailoverFailure(source:ProviderPresetSource,error:unknown):void{
    const reason=failureReason(error);
    this.options.diagnostics?.recordError("provider-pool","PROVIDER_SOURCE_FAILED","Provider pool source failed; failover considered",{
      providerPresetId:this.preset.id,
      sourceId:source.id,
      providerId:source.providerId,
      ...(safeBaseUrlHost(source)?{baseUrlHost:safeBaseUrlHost(source)}:{}),
      model:source.model,
      health:source.health,
      failureCount:source.failureCount,
      category:reason.category,
      ...(reason.httpStatus===undefined?{}:{httpStatus:reason.httpStatus}),
      ...(reason.durationMs===undefined?{}:{durationMs:reason.durationMs})
    });
  }

  private aggregateError(request:ChatRequest|undefined,lastError:unknown,attempted:Set<string>):ProviderPoolError{
    const lastChatError=readChatError(lastError);
    const attempts=[...attempted].map(sourceId=>{
      const source=this.preset.sources.find(item=>item.id===sourceId);
      return source?{
        sourceId,
        providerId:source.providerId,
        health:source.health,
        failureCount:source.failureCount
      }:undefined;
    }).filter(Boolean);
    return new ProviderPoolError({
      apiVersion:request?.apiVersion??"1",
      schemaVersion:request?.schemaVersion??"1",
      code:lastChatError?.code==="PROVIDER_ERROR"?"PROVIDER_ERROR":"PROVIDER_UNAVAILABLE",
      message:"All available provider sources failed.",
      requestId:request?.requestId,
      providerId:lastChatError?.providerId,
      retryable:attempts.length>0,
      details:{category:"provider_pool_exhausted",attempts}
    });
  }
}
