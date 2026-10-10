import type {
  ChatProvider,EmbeddingProvider,HealthStatus,ProviderCapabilities,ProviderDiagnostic,ProviderKind,RerankerProvider,STTProvider,TTSProvider,VisionProvider
} from "../../contracts/src/index";
type AnyProvider=ChatProvider|STTProvider|TTSProvider|EmbeddingProvider|RerankerProvider|VisionProvider;
export interface ProviderRegistration<T extends AnyProvider=AnyProvider>{provider:T;roles:readonly ProviderKind[]}
export interface ProviderDiagnosticsOptions{skipHealthFor?:readonly string[]}
export class ProviderRegistry{
  private readonly providers=new Map<string,ProviderRegistration>();
  private readonly healthCache=new Map<string,HealthStatus>();
  register<T extends AnyProvider>(provider:T,roles:readonly ProviderKind[]){if(this.providers.has(provider.id))throw new Error("Provider already registered: "+provider.id);this.healthCache.delete(provider.id);this.providers.set(provider.id,{provider,roles});}
  unregister(id:string){this.providers.delete(id);this.healthCache.delete(id);}
  get<T extends AnyProvider>(id:string){return this.providers.get(id)?.provider as T|undefined;}
  list(role?:ProviderKind){const all=[...this.providers.values()];return role?all.filter(item=>item.roles.includes(role)):all;}
  findByCapabilities(role:ProviderKind,required:(keyof ProviderCapabilities)[]){return this.list(role).filter(item=>required.every(key=>item.provider.capabilities()[key]===true));}
  async health(){const out:Record<string,HealthStatus|undefined>={};for(const [id,item] of this.providers){try{const health=await item.provider.health();this.healthCache.set(id,health);out[id]=health;}catch(error){const health={status:"error" as const,message:String(error)};this.healthCache.set(id,health);out[id]=health;}}return out;}
  async diagnostics(options:ProviderDiagnosticsOptions={}):Promise<ProviderDiagnostic[]>{
    const result:ProviderDiagnostic[]=[];
    for(const item of this.providers.values()){
      let health=this.healthCache.get(item.provider.id);
      if(!health||!options.skipHealthFor?.includes(item.provider.id)){
        try{health=await item.provider.health();}catch(error){health={status:"error",message:String(error)};}
        this.healthCache.set(item.provider.id,health);
      }
      result.push({id:item.provider.id,roles:item.roles,capabilities:item.provider.capabilities(),health});
    }
    return result;
  }
}
