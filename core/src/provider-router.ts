import type {
  ChatProvider,ChatRequest,ChatResponse,ChatRequestOptions,ChatStreamHandlers,ChatStreamOptions,
  HealthStatus,ModelInfo,ProviderCapabilities,ProviderCredentialHealth,ProviderPresetCredential,DiagnosticsStore
} from "../../contracts/src/index";

type CredentialRuntime={
  credential:ProviderPresetCredential;
  provider:ChatProvider;
  cooldownUntilMs:number;
  disabledUntilMs:number;
};

function timestampNow(){return Date.now();}
function errorDetails(error:unknown){return (error as any)?.chatError?.details as Record<string,unknown>|undefined;}
function httpStatus(error:unknown){const value=errorDetails(error)?.httpStatus;return typeof value==="number"?value:undefined;}
function category(error:unknown){const value=errorDetails(error)?.category;return typeof value==="string"?value:undefined;}
function retryAfterMs(error:unknown){const value=errorDetails(error)?.retryAfterMs;return typeof value==="number"&&value>=0?Math.min(600000,value):undefined;}

export interface ProviderCredentialRouterOptions{
  presetId:string;
  credentials:readonly ProviderPresetCredential[];
  createProvider:(credential:ProviderPresetCredential)=>ChatProvider;
  diagnostics?:DiagnosticsStore;
  clock?:()=>number;
}

export class ProviderCredentialRouter implements ChatProvider{
  readonly id:string;
  private readonly clock:()=>number;
  private readonly runtime:CredentialRuntime[];
  private capabilityNames():readonly string[]{
    const capabilities=this.capabilities();
    return Object.entries(capabilities).filter(([,value])=>value).map(([key])=>key);
  }

  constructor(private readonly options:ProviderCredentialRouterOptions){
    if(options.credentials.length===0)throw new Error("Provider credential router requires at least one credential.");
    this.clock=options.clock??timestampNow;
    this.runtime=options.credentials.map(credential=>({
      credential:{...credential,health:credential.health??"healthy",failureCount:credential.failureCount??0},
      provider:options.createProvider(credential),
      cooldownUntilMs:Date.parse(credential.cooldownUntil??"")||0,
      disabledUntilMs:Date.parse(credential.temporarilyDisabledUntil??"")||0
    }));
    this.id=this.runtime[0]!.provider.id;
  }

  metadata(){return this.runtime[0]!.provider.metadata();}

  capabilities(){
    return this.runtime.reduce<ProviderCapabilities>((merged,item)=>{
      for(const [key,value] of Object.entries(item.provider.capabilities()))if(value)merged[key]=true;
      return merged;
    },{});
  }

  async listModels():Promise<ModelInfo[]>{
    return this.withFailover(provider=>provider.listModels());
  }

  async chat(request:ChatRequest,options:ChatRequestOptions={}):Promise<ChatResponse>{
    return this.withFailover(provider=>provider.chat(request,options));
  }

  async stream(request:ChatRequest,handlers:ChatStreamHandlers,options:ChatStreamOptions={}):Promise<ChatResponse>{
    const item=this.choose(this.clock());
    if(!item)throw this.unavailableError();
    if(!item.provider.stream)throw new Error("Selected provider credential does not support streaming.");
    return item.provider.stream(request,handlers,options);
  }

  async health():Promise<HealthStatus>{
    const available=this.runtime.filter(item=>this.available(item,this.clock()));
    if(available.length===0)return {status:"unavailable",message:"All provider credentials are temporarily unavailable.",capabilities:this.capabilityNames()};
    const results=await Promise.all(available.map(item=>item.provider.health().catch(()=>({status:"unavailable" as const,message:"Credential health check failed.",capabilities:this.capabilityNames()}))));
    const healthy=results.some(result=>result.status==="healthy");
    return {status:healthy?"healthy":"degraded",message:healthy?"At least one provider credential is healthy.":"Provider credentials are degraded.",capabilities:this.capabilities()};
  }

  getCredentialState():readonly ProviderPresetCredential[]{
    return this.runtime.map(item=>({
      ...item.credential,
      health:this.effectiveHealth(item),
      cooldownUntil:item.cooldownUntilMs>0?new Date(item.cooldownUntilMs).toISOString():null,
      temporarilyDisabledUntil:item.disabledUntilMs>0?new Date(item.disabledUntilMs).toISOString():null
    }));
  }

  private async withFailover<T>(execute:(provider:ChatProvider)=>Promise<T>):Promise<T>{
    const attempted=new Set<string>();
    let lastError:unknown;
    while(attempted.size<this.runtime.length){
      const item=this.choose(this.clock(),attempted);
      if(!item)break;
      attempted.add(item.credential.id);
      try{
        const result=await execute(item.provider);
        this.recordSuccess(item);
        return result;
      }catch(error){
        lastError=error;
        this.recordFailure(item,error);
        if(!this.shouldFailover(error))throw error;
      }
    }
    if(lastError)throw lastError;
    throw this.unavailableError();
  }

  private choose(at:number,attempted?:ReadonlySet<string>){
    return this.runtime
      .filter(item=>!attempted?.has(item.credential.id)&&this.available(item,at))
      .sort((a,b)=>this.score(b)-this.score(a))[0];
  }

  private available(item:CredentialRuntime,at:number){
    if(item.credential.health==="disabled")return false;
    if(item.disabledUntilMs>at)return false;
    if(item.credential.health==="unhealthy"&&item.disabledUntilMs===0)return false;
    return item.cooldownUntilMs<=at;
  }

  private score(item:CredentialRuntime){return -item.credential.failureCount;}

  private shouldFailover(error:unknown){
    const status=httpStatus(error);
    const cat=category(error);
    if(status===401||status===403||status===429)return true;
    if(status!==undefined&&status>=500)return true;
    return cat==="authentication"||cat==="network"||cat==="timeout"||cat==="server"||cat==="rate_limit";
  }

  private recordSuccess(item:CredentialRuntime){
    const now=new Date(this.clock()).toISOString();
    item.credential={...item.credential,health:"healthy",lastSuccessAt:now,failureCount:0,cooldownUntil:null,temporarilyDisabledUntil:null};
    item.cooldownUntilMs=0;item.disabledUntilMs=0;
  }

  private recordFailure(item:CredentialRuntime,error:unknown){
    const at=this.clock();
    const status=httpStatus(error);
    const cat=category(error);
    const failureCount=item.credential.failureCount+1;
    const retryAfter=retryAfterMs(error);
    const cooldown=retryAfter??(
      status===429?30000:
      status!==undefined&&status>=500?Math.min(120000,1000*Math.pow(2,Math.min(6,failureCount-1))):
      cat==="network"||cat==="timeout"?Math.min(60000,1000*Math.pow(2,Math.min(5,failureCount-1))):0
    );
    const authentication=status===401||status===403||cat==="authentication";
    const health:ProviderCredentialHealth=authentication?"unhealthy":cooldown>0?"degraded":"unhealthy";
    item.credential={...item.credential,health,lastFailureAt:new Date(at).toISOString(),failureCount,
      ...(cooldown>0?{cooldownUntil:new Date(at+cooldown).toISOString()}:{cooldownUntil:null}),
      ...(authentication?{temporarilyDisabledUntil:new Date(at+3600000).toISOString()}:{})
    };
    item.cooldownUntilMs=cooldown>0?at+cooldown:0;
    item.disabledUntilMs=authentication?at+3600000:0;
    this.options.diagnostics?.recordError("provider-router","PROVIDER_CREDENTIAL_STATE_CHANGED","Provider credential health state changed.",{
      presetId:this.options.presetId,credentialId:item.credential.id,httpStatus:status??null,category:cat??null,cooldownMs:cooldown
    });
  }

  private effectiveHealth(item:CredentialRuntime):ProviderCredentialHealth{
    const at=this.clock();
    if(item.credential.health==="disabled")return "disabled";
    if(item.disabledUntilMs>at)return "unhealthy";
    if(item.cooldownUntilMs>at)return "degraded";
    return "healthy";
  }

  private unavailableError(){
    const error=new Error("All provider credentials are temporarily unavailable.");
    (error as any).chatError={retryable:true,details:{category:"credential_pool_unavailable",presetId:this.options.presetId}};
    return error;
  }
}
