import type {ActionInvocation,ActionTarget,ActionTargetResolver,ActorIdentity,RuntimeDiagnostics,ToolDefinition,ActionDriver,ActionTarget as Target} from "../../../contracts/src/index";
import {FOUNDATION_SCHEMA_VERSION} from "../../../contracts/src/index";
import {
  InMemoryDiagnosticsStore,InMemoryEventBus,InMemoryStateStore,ModuleManager,ProviderRegistry,
  InMemoryPermissionService,InMemoryAuditService,InMemoryToolRegistry,DefaultActionBroker,
  DefaultConfirmationService,DefaultRiskPolicy,BrowserTargetResolver,ScopedCapabilityContext,createMemoryConfig
} from "../../../core/src/index";
import {MinimalJsonSchemaValidator} from "../../../contracts/src/schema-validator";
import {FakeBrowserModule,FakeCharacterModule,FakeMemoryModule} from "../../../modules/mock/src/index";
import {FakeChatProvider,FakeTTSProvider,FakeSTTProvider,FakeEmbeddingProvider,FakeVisionProvider} from "../../../providers/mock/src/index";
import {objectSchema} from "../../../core/src/tools";

export interface FoundationRuntime{
  start():Promise<void>;
  stop():Promise<void>;
  diagnostics():Promise<RuntimeDiagnostics>;
  invoke(invocation:ActionInvocation):Promise<import("../../../contracts/src/index").ActionResult>;
}

export async function createFoundationRuntime():Promise<FoundationRuntime>{
  const diagnosticsStore=new InMemoryDiagnosticsStore();
  const logger={debug(){},info(){},warn(){},error(){}};
  const events=new InMemoryEventBus(diagnosticsStore,logger);
  const _state=new InMemoryStateStore(diagnosticsStore,logger);
  const providers=new ProviderRegistry();
  const audit=new InMemoryAuditService();
  const permissions=new InMemoryPermissionService();
  const tools=new InMemoryToolRegistry();
  const targetResolvers=new Map<string,ActionTargetResolver>();
  const browser=new FakeBrowserModule();

  providers.register(new FakeChatProvider(),["chat"]);
  providers.register(new FakeTTSProvider(),["tts"]);
  providers.register(new FakeSTTProvider(),["stt"]);
  providers.register(new FakeEmbeddingProvider(),["embeddings"]);
  providers.register(new FakeVisionProvider(),["vision"]);

  const moduleCapabilities:Record<string,readonly string[]>={
    "character.fake":["character.expression","character.speech"],
    "memory.fake":["memory.search","memory.write"],
    "browser.fake":["browser.search","browser.navigate"]
  };
  const moduleManager=new ModuleManager(
    manifest=>({
      moduleId:manifest.id,
      events,
      logger,
      config:createMemoryConfig(),
      clock:{now:()=>new Date().toISOString()},
      capabilities:new ScopedCapabilityContext(new Set(moduleCapabilities[manifest.id]??[]))
    }),
    diagnosticsStore
  );
  moduleManager.register(browser);
  moduleManager.register(new FakeCharacterModule());
  moduleManager.register(new FakeMemoryModule());

  const browserResolver=new BrowserTargetResolver("browser.url");
  targetResolvers.set(browserResolver.id,browserResolver);

  const navigateDefinition:ToolDefinition={
    id:"browser.navigate",
    version:"1.0.0",
    schemaVersion:FOUNDATION_SCHEMA_VERSION,
    name:"browser.navigate",
    description:"Navigate the controlled browser to an explicitly targeted URL.",
    risk:"low",
    requiredCapabilities:["browser.navigate"],
    resourceType:"domain",
    action:"browser.navigate",
    targetResolverId:browserResolver.id,
    confirmation:"never",
    parameters:objectSchema({url:{type:"string",minLength:8}},["url"])
  };
  const browserDriver:ActionDriver={
    id:"fake-browser-driver",
    async execute(_request,target:Target){
      if(target.kind!=="domain")throw new Error("browser driver received non-domain target");
      await browser.open(target.url);
      return {url:target.url};
    }
  };
  tools.register(navigateDefinition,browserDriver);
  permissions.add({
    id:"character-browser-youtube",
    schemaVersion:FOUNDATION_SCHEMA_VERSION,
    subject:"character",
    resourceType:"domain",
    action:"browser.navigate",
    effect:"allow",
    scope:{domains:["youtube.com","wikipedia.org"]}
  });

  const foreground={async verify(){return {allowed:true,reason:"Foundation foreground policy allows mock runtime."};}};
  const confirmation=new DefaultConfirmationService(async()=>false);
  const broker=new DefaultActionBroker({
    toolRegistry:tools,permissions,foreground,riskPolicy:new DefaultRiskPolicy(),confirmation,audit,
    schemaValidator:new MinimalJsonSchemaValidator(),diagnostics:diagnosticsStore,targetResolvers
  });

  let runtimeStatus:RuntimeDiagnostics["runtimeStatus"]="starting";
  const snapshot=async():Promise<RuntimeDiagnostics>=>{
    const moduleHealth=await moduleManager.health().catch(()=>({}));
    const modules=moduleManager.list().map(item=>({
      ...item,
      health:(moduleHealth as Record<string,{status:"healthy"|"degraded"|"unavailable"|"error"}|undefined>)[item.id]
    }));
    const providerDiagnostics=await providers.diagnostics();
    const degraded=modules.some(item=>item.state==="error"||item.state==="degraded")||
      providerDiagnostics.some(item=>item.health?.status!=="healthy");
    const capabilities=new Set<string>();
    for(const item of modules){
      if(item.health?.capabilities)for(const capability of item.health.capabilities)capabilities.add("module."+capability);
    }
    for(const item of providerDiagnostics){
      for(const [key,value] of Object.entries(item.capabilities))if(value)capabilities.add("provider."+item.id+"."+key);
    }
    return {
      schemaVersion:FOUNDATION_SCHEMA_VERSION,
      timestamp:new Date().toISOString(),
      runtimeStatus:runtimeStatus==="running"&&degraded?"degraded":runtimeStatus,
      coreStatus:runtimeStatus==="running"&&degraded?"degraded":runtimeStatus,
      modules,
      providers:providerDiagnostics,
      recentErrors:diagnosticsStore.recentErrors(),
      capabilities:[...capabilities]
    };
  };

  return {
    async start(){await moduleManager.initializeAll();await moduleManager.startAll();runtimeStatus="running";},
    async stop(){try{await moduleManager.stopAll();}finally{runtimeStatus="stopped";}},
    diagnostics:snapshot,
    invoke:invocation=>broker.execute(invocation)
  };
}
export async function startFoundationRuntime(){const runtime=await createFoundationRuntime();await runtime.start();return runtime;}
export type {RuntimeDiagnostics,ActorIdentity};
