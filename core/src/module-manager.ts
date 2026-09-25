import type {CompanionModule,DiagnosticsStore,HealthStatus,ModuleContext,ModuleManifest,ModuleState} from "../../contracts/src/index";

type Entry={module:CompanionModule;state:ModuleState;health?:HealthStatus;error?:string};
const ALLOWED:Record<ModuleState,readonly ModuleState[]>={
  installed:["loading","disabled"],
  loading:["ready","error","disabled"],
  ready:["running","disabled","loading","error"],
  running:["ready","degraded","error","disabled"],
  degraded:["running","ready","error","disabled"],
  error:["installed","disabled","loading"],
  disabled:["installed"]
};

export type ModuleContextFactory=(manifest:ModuleManifest)=>ModuleContext;

export class ModuleManager{
  private readonly modules=new Map<string,Entry>();

  constructor(private readonly contextFactory:ModuleContextFactory,private readonly diagnostics?:DiagnosticsStore){}

  register(module:CompanionModule):void{
    if(this.modules.has(module.manifest.id))throw new Error("Module already registered: "+module.manifest.id);
    this.modules.set(module.manifest.id,{module,state:"installed"});
  }

  async initializeAll():Promise<void>{
    let fatal:unknown;
    for(const entry of this.modules.values()){
      try{await this.initialize(entry);}catch(error){fatal??=error;}
    }
    if(fatal)throw fatal;
  }

  async startAll():Promise<void>{
    let fatal:unknown;
    for(const entry of this.modules.values()){
      if(entry.state!=="ready")continue;
      try{await this.start(entry);}catch(error){fatal??=error;}
    }
    if(fatal)throw fatal;
  }

  async stopAll():Promise<void>{
    let fatal:unknown;
    for(const entry of [...this.modules.values()].reverse()){
      if(!this.isStoppableState(entry.state))continue;
      try{
        await entry.module.stop();
        this.transition(entry,"ready");
      }catch(error){
        entry.error=String(error);
        this.transition(entry,"error");
        this.report("MODULE_STOP_FAILED",entry,error);
        fatal??=error;
      }
    }
    if(fatal)throw fatal;
  }

  async restart(id:string):Promise<void>{
    const entry=this.require(id);
    if(entry.state==="disabled")throw new Error("Cannot restart disabled module: "+id);

    if(entry.state==="running"||entry.state==="degraded"){
      try{
        await entry.module.stop();
        this.transition(entry,"ready");
      }catch(error){
        entry.error=String(error);
        this.transition(entry,"error");
        this.report("MODULE_STOP_FAILED",entry,error);
      }
    }

    if(entry.state==="error")this.transition(entry,"installed");
    if(entry.state==="installed"){
      const nextState=await this.initialize(entry);
      if(nextState==="ready")await this.start(entry);
    }
  }

  async enable(id:string):Promise<void>{
    const entry=this.require(id);
    if(entry.state!=="disabled")throw new Error("Only disabled modules can be enabled: "+id);

    this.transition(entry,"installed");
    const nextState=await this.initialize(entry);
    if(nextState==="ready")await this.start(entry);
  }

  async disable(id:string):Promise<void>{
    const entry=this.require(id);

    switch(entry.state){
      case "disabled":
        return;
      case "running":
      case "degraded":
      case "ready":
        try{await entry.module.stop();}
        catch(error){
          entry.error=String(error);
          this.report("MODULE_STOP_FAILED",entry,error);
        }
        break;
      case "installed":
      case "loading":
      case "error":
        break;
    }

    this.transition(entry,"disabled");
  }

  getState(id:string):ModuleState{return this.require(id).state;}

  list(){
    return [...this.modules.values()].map(entry=>({
      id:entry.module.manifest.id,
      state:entry.state,
      health:entry.health,
      error:entry.error
    }));
  }

  async health(id?:string):Promise<HealthStatus|Record<string,HealthStatus|undefined>>{
    if(id)return this.refreshHealth(this.require(id));

    const out:Record<string,HealthStatus|undefined>={};
    for(const [key,entry] of this.modules){
      try{out[key]=await this.refreshHealth(entry);}
      catch(error){out[key]={status:"error",message:String(error)};}
    }
    return out;
  }

  private async refreshHealth(entry:Entry):Promise<HealthStatus>{
    try{
      entry.health=await entry.module.health();
      if(entry.state==="running"&&entry.health.status==="degraded")this.transition(entry,"degraded");
      if(entry.state==="degraded"&&entry.health.status==="healthy")this.transition(entry,"running");
      return entry.health;
    }catch(error){
      entry.error=String(error);
      if(entry.state==="running"||entry.state==="degraded")this.transition(entry,"degraded");
      else if(entry.state!=="disabled")this.transition(entry,"error");
      this.report("MODULE_HEALTH_FAILED",entry,error);
      return {status:"degraded",message:String(error)};
    }
  }

  private async initialize(entry:Entry):Promise<ModuleState>{
    if(entry.state!=="installed")return entry.state;
    this.transition(entry,"loading");
    try{
      await entry.module.initialize(this.contextFactory(entry.module.manifest));
      entry.error=undefined;
      this.transition(entry,"ready");
    }catch(error){
      entry.error=String(error);
      this.transition(entry,"error");
      this.report("MODULE_INITIALIZE_FAILED",entry,error);
      if(!entry.module.manifest.optional)throw error;
    }
    return this.currentState(entry);
  }

  private async start(entry:Entry):Promise<void>{
    if(entry.state!=="ready")throw new Error("Module cannot start from state "+entry.state);
    try{
      await entry.module.start();
      entry.error=undefined;
      this.transition(entry,"running");
    }catch(error){
      entry.error=String(error);
      this.transition(entry,"error");
      this.report("MODULE_START_FAILED",entry,error);
      if(!entry.module.manifest.optional)throw error;
    }
  }

  private isStoppableState(state:ModuleState):state is "running"|"degraded"|"ready"{
    return state==="running"||state==="degraded"||state==="ready";
  }

  private currentState(entry:Entry):ModuleState{
    return entry.state;
  }

  private transition(entry:Entry,next:ModuleState):void{
    if(entry.state===next)return;
    if(!ALLOWED[entry.state].includes(next))throw new Error("Invalid module transition: "+entry.state+" -> "+next);
    entry.state=next;
  }

  private report(code:string,entry:Entry,error:unknown):void{
    this.diagnostics?.recordError(
      "module-manager",
      code,
      error instanceof Error?error.message:String(error),
      {moduleId:entry.module.manifest.id}
    );
  }

  private require(id:string):Entry{
    const entry=this.modules.get(id);
    if(!entry)throw new Error("Unknown module: "+id);
    return entry;
  }
}
