import type {DiagnosticsStore,Logger,StateStore,Unsubscribe} from "../../contracts/src/index";

export class InMemoryStateStore implements StateStore {
  private readonly values=new Map<string,unknown>();
  private readonly listeners=new Map<string,Set<(value:unknown)=>void>>();
  constructor(private readonly diagnostics?:DiagnosticsStore,private readonly logger?:Logger){}
  get<T>(key:string):T|undefined{return this.values.get(key) as T|undefined;}
  async set<T>(key:string,value:T):Promise<void>{
    this.values.set(key,value);
    for(const listener of [...(this.listeners.get(key)??[])]){
      try{listener(value);}
      catch(error){
        const message=error instanceof Error?error.message:String(error);
        this.diagnostics?.recordError("state-store","STATE_OBSERVER_FAILED",message,{key});
        this.logger?.error("State observer failed",{key,error:message});
      }
    }
  }
  async delete(key:string):Promise<void>{this.values.delete(key);}
  subscribe<T>(key:string,handler:(value:T)=>void):Unsubscribe{
    const set=this.listeners.get(key)??new Set<(value:unknown)=>void>();
    set.add(handler as (value:unknown)=>void);this.listeners.set(key,set);
    return ()=>{
      set.delete(handler as (value:unknown)=>void);
      if(set.size===0)this.listeners.delete(key);
    };
  }
}
