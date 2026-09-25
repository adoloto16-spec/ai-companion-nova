import type {
  ActionDriver, ActionRequest, ActionResult, ActionRisk, ActionBroker as IActionBroker,
  AuditService, ConfirmationService, CompanionModule, Event, EventBus, EventHandler,
  ForegroundCheck, HealthStatus, ModuleContext, ModuleManifest, ModuleState,
  PermissionService, PermissionDecision, PostconditionChecker, ProviderCapabilities,
  ProviderKind, ToolDefinition, ChatProvider, STTProvider, TTSProvider, EmbeddingProvider,
  RerankerProvider, VisionProvider, StateStore, Unsubscribe
} from "../../contracts/src/index";

export class InMemoryEventBus implements EventBus {
  private handlers=new Map<string,Set<EventHandler<unknown>>>();
  subscribe<T>(eventType:string,handler:EventHandler<T>):Unsubscribe{
    const set=this.handlers.get(eventType)??new Set<EventHandler<unknown>>();
    set.add(handler as EventHandler<unknown>);this.handlers.set(eventType,set);
    return ()=>{set.delete(handler as EventHandler<unknown>);if(!set.size)this.handlers.delete(eventType);};
  }
  async publish<T>(event:Event<T>):Promise<void>{
    for(const handler of [...(this.handlers.get(event.type)??[])])await handler(event);
  }
  subscriberCount(type?:string){return type?(this.handlers.get(type)?.size??0):[...this.handlers.values()].reduce((n,s)=>n+s.size,0);}
}

export class InMemoryStateStore implements StateStore{
  private values=new Map<string,unknown>();private listeners=new Map<string,Set<(v:unknown)=>void>>();
  get<T>(key:string){return this.values.get(key) as T|undefined;}
  async set<T>(key:string,value:T){this.values.set(key,value);for(const h of [...(this.listeners.get(key)??[])])h(value);}
  async delete(key:string){this.values.delete(key);}
  subscribe<T>(key:string,handler:(v:T)=>void):Unsubscribe{
    const set=this.listeners.get(key)??new Set<(v:unknown)=>void>();set.add(handler as (v:unknown)=>void);this.listeners.set(key,set);
    return ()=>{set.delete(handler as (v:unknown)=>void);if(!set.size)this.listeners.delete(key);};
  }
}

export type ModuleContextFactory=(manifest:ModuleManifest)=>ModuleContext;
type Entry={module:CompanionModule;state:ModuleState;health?:HealthStatus;error?:string};

export class ModuleManager{
  private modules=new Map<string,Entry>();
  constructor(private readonly contextFactory:ModuleContextFactory){}
  register(module:CompanionModule){if(this.modules.has(module.manifest.id))throw new Error("Module already registered: "+module.manifest.id);this.modules.set(module.manifest.id,{module,state:"installed"});}
  async initializeAll(){for(const entry of this.modules.values())await this.initialize(entry);}
  async startAll(){for(const entry of this.modules.values())if(entry.state==="ready")await this.start(entry);}
  async stopAll(){for(const entry of [...this.modules.values()].reverse())if(entry.state==="running"||entry.state==="degraded"){await entry.module.stop();entry.state="ready";}}
  async restart(id:string){const e=this.require(id);if(e.state==="running"||e.state==="degraded")await e.module.stop();await this.start(e);}
  async enable(id:string){const e=this.require(id);if(e.state==="disabled")e.state="installed";await this.initialize(e);await this.start(e);}
  async disable(id:string){const e=this.require(id);if(e.state==="running"||e.state==="degraded")await e.module.stop();e.state="disabled";}
  getState(id:string){return this.require(id).state;}
  list(){return [...this.modules.values()].map(({module,state,health,error})=>({manifest:module.manifest,state,health,error}));}
  async health(id?:string):Promise<HealthStatus|Record<string,HealthStatus|undefined>>{
    if(id){const e=this.require(id);e.health=await e.module.health();return e.health;}
    const out:Record<string,HealthStatus|undefined>={};
    for(const [key,e] of this.modules){try{e.health=await e.module.health();out[key]=e.health;}catch(err){e.state="error";e.error=String(err);out[key]={status:"error",message:String(err)};}}
    return out;
  }
  private async initialize(e:Entry){
    if(e.state==="disabled"||e.state==="error")return;e.state="loading";
    try{await e.module.initialize(this.contextFactory(e.module.manifest));e.state="ready";e.error=undefined;}
    catch(err){e.state="error";e.error=String(err);if(!e.module.manifest.optional)throw err;}
  }
  private async start(e:Entry){
    try{await e.module.start();e.state="running";e.error=undefined;}
    catch(err){e.state="error";e.error=String(err);if(!e.module.manifest.optional)throw err;}
  }
  private require(id:string){const e=this.modules.get(id);if(!e)throw new Error("Unknown module: "+id);return e;}
}

type AnyProvider=ChatProvider|STTProvider|TTSProvider|EmbeddingProvider|RerankerProvider|VisionProvider;
export interface ProviderRegistration<T extends AnyProvider=AnyProvider>{provider:T;roles:readonly ProviderKind[];}
export class ProviderRegistry{
  private providers=new Map<string,ProviderRegistration>();
  register<T extends AnyProvider>(provider:T,roles:readonly ProviderKind[]){if(this.providers.has(provider.id))throw new Error("Provider already registered: "+provider.id);this.providers.set(provider.id,{provider,roles});}
  unregister(id:string){this.providers.delete(id);}
  get<T extends AnyProvider>(id:string){return this.providers.get(id)?.provider as T|undefined;}
  list(role?:ProviderKind){const all=[...this.providers.values()];return role?all.filter(x=>x.roles.includes(role)):all;}
  findByCapabilities(role:ProviderKind,required:(keyof ProviderCapabilities)[]){return this.list(role).filter(x=>required.every(k=>x.provider.capabilities()[k]===true));}
  async health(){const out:Record<string,HealthStatus>={};for(const [id,x] of this.providers)out[id]=await x.provider.health();return out;}
}

export interface RegisteredTool{definition:ToolDefinition;driver:ActionDriver;postcondition?:PostconditionChecker;}
export class InMemoryToolRegistry{
  private tools=new Map<string,RegisteredTool>();
  register(definition:ToolDefinition,driver:ActionDriver,postcondition?:PostconditionChecker){this.tools.set(definition.name,{definition,driver,postcondition});}
  get(name:string){return this.tools.get(name);}
  list(){return [...this.tools.values()].map(x=>x.definition);}
}

export class InMemoryPermissionService implements PermissionService{
  private rules:{id:string;subject:string;resource:string;action:string;effect:"allow"|"deny";scope?:{domains?:readonly string[];roots?:readonly string[];applications?:readonly string[]}}[]=[];
  add(rule:typeof this.rules[number]){this.rules.push(rule);}
  async check(req:ActionRequest,tool:ToolDefinition):Promise<PermissionDecision>{
    const resource=req.resource??tool.name,action=req.action??tool.name;
    const matches=this.rules.filter(x=>x.subject===req.requestedBy&&x.resource===resource&&x.action===action);
    for(const rule of [...matches].reverse()){if(!this.matchScope(rule.scope,req.scope))continue;return rule.effect==="allow"?{allowed:true,reason:"Permission allowlisted.",scopeMatched:true}:{allowed:false,reason:"Permission explicitly denied.",scopeMatched:true};}
    return {allowed:false,reason:"No matching permission rule.",scopeMatched:false};
  }
  private matchScope(a:NonNullable<typeof this.rules[number]["scope"]>|undefined,b:ActionRequest["scope"]){if(!a)return true;if(!b)return false;
    const list=(allowed:readonly string[]|undefined,actual:readonly string[]|undefined)=>!allowed||!!actual&&actual.every(x=>allowed.includes(x));
    return list(a.domains,b.domains)&&list(a.roots,b.roots)&&list(a.applications,b.applications);
  }
}

export class InMemoryAuditService implements AuditService{
  entries:Parameters<AuditService["record"]>[0][]=[];
  async record(entry:Parameters<AuditService["record"]>[0]){this.entries.push(entry);}
}

export interface ActionBrokerDependencies{
  toolRegistry:InMemoryToolRegistry;permissions:PermissionService;foreground:ForegroundCheck;
  confirmation:ConfirmationService;audit:AuditService;
}

export class DefaultActionBroker implements IActionBroker{
  constructor(private readonly deps:ActionBrokerDependencies){}
  async execute(req:ActionRequest):Promise<ActionResult>{
    const start=Date.now();
    const audit=async(result:ActionResult,reason?:string)=>{await this.deps.audit.record({
      timestamp:new Date().toISOString(),actor:req.requestedBy,action:req.action??req.tool,resource:req.resource,
      argumentsMetadata:{keys:Object.keys(req.arguments)},result,status:result.status,durationMs:result.durationMs,
      allowed:result.status==="success",reason
    });return result;};
    if(typeof req.id!=="string"||typeof req.tool!=="string"||!req.arguments||typeof req.arguments!=="object"||!req.requestedBy)
      return audit({id:req.id,status:"denied",error:{code:"INVALID_REQUEST",message:"Invalid action request."},durationMs:Date.now()-start});
    const tool=this.deps.toolRegistry.get(req.tool);
    if(!tool)return audit({id:req.id,status:"denied",error:{code:"TOOL_NOT_FOUND",message:"Tool not found: "+req.tool},durationMs:Date.now()-start});
    const permission=await this.deps.permissions.check(req,tool.definition);
    if(!permission.allowed)return audit({id:req.id,status:"denied",error:{code:"PERMISSION_DENIED",message:permission.reason},durationMs:Date.now()-start},permission.reason);
    const foreground=await this.deps.foreground.verify(req,tool.definition);
    if(!foreground.allowed)return audit({id:req.id,status:"denied",error:{code:"FOREGROUND_DENIED",message:foreground.reason},durationMs:Date.now()-start},foreground.reason);
    if(req.risk!=="low"&&!await this.deps.confirmation.confirm(req,tool.definition))
      return audit({id:req.id,status:"denied",error:{code:"CONFIRMATION_REQUIRED",message:"Confirmation was not granted."},durationMs:Date.now()-start});
    try{
      const output=await tool.driver.execute(req);
      if(tool.postcondition&&!await tool.postcondition.verify(req,output))
        return audit({id:req.id,status:"error",error:{code:"POSTCONDITION_FAILED",message:"Postcondition failed."},durationMs:Date.now()-start});
      return audit({id:req.id,status:"success",output,durationMs:Date.now()-start});
    }catch(err){
      return audit({id:req.id,status:"error",error:{code:"DRIVER_ERROR",message:String(err)},durationMs:Date.now()-start});
    }
  }
}

export class BasicAiRuntime{
  constructor(private readonly chat:ChatProvider,private readonly events:EventBus){}
  async *chatStream(request:Parameters<ChatProvider["chat"]>[0]){
    for await(const event of this.chat.chat(request))yield event;
  }
}

export const createConsoleLogger=()=>({debug(){},info(){},warn(){},error(){}});
export const createMemoryConfig=():ModuleContext["config"]=>{const values=new Map<string,unknown>();return {get:k=>values.get(k),set:async(k,v)=>{values.set(k,v);}};};

export { type ActionRisk, type Unsubscribe };
