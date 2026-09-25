import type {
  ChatProvider,EmbeddingProvider,HealthStatus,ProviderCapabilities,ProviderDiagnostic,ProviderKind,RerankerProvider,STTProvider,TTSProvider,VisionProvider
} from "../../contracts/src/index";
type AnyProvider=ChatProvider|STTProvider|TTSProvider|EmbeddingProvider|RerankerProvider|VisionProvider;
export interface ProviderRegistration<T extends AnyProvider=AnyProvider>{provider:T;roles:readonly ProviderKind[]}
export class ProviderRegistry{
  private readonly providers=new Map<string,ProviderRegistration>();
  register<T extends AnyProvider>(provider:T,roles:readonly ProviderKind[]){if(this.providers.has(provider.id))throw new Error("Provider already registered: "+provider.id);this.providers.set(provider.id,{provider,roles});}
  unregister(id:string){this.providers.delete(id);}
  get<T extends AnyProvider>(id:string){return this.providers.get(id)?.provider as T|undefined;}
  list(role?:ProviderKind){const all=[...this.providers.values()];return role?all.filter(item=>item.roles.includes(role)):all;}
  findByCapabilities(role:ProviderKind,required:(keyof ProviderCapabilities)[]){return this.list(role).filter(item=>required.every(key=>item.provider.capabilities()[key]===true));}
  async health(){const out:Record<string,HealthStatus|undefined>={};for(const [id,item] of this.providers){try{out[id]=await item.provider.health();}catch(error){out[id]={status:"error",message:String(error)};}}return out;}
  async diagnostics():Promise<ProviderDiagnostic[]>{
    const result:ProviderDiagnostic[]=[];
    for(const item of this.providers.values()){
      let health:HealthStatus;
      try{health=await item.provider.health();}catch(error){health={status:"error",message:String(error)};}
      result.push({id:item.provider.id,roles:item.roles,capabilities:item.provider.capabilities(),health});
    }
    return result;
  }
}
