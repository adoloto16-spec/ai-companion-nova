import type {ActionInvocation,ActionTarget,ActionTargetResolver,ActorIdentity,RuntimeDiagnostics,ToolDefinition,ActionDriver,ActionTarget as Target,ChatRequest,ChatResponse,CredentialStore,ProviderConfiguration,Character,CharacterId,CharacterStore,CoreBookEntry,CoreBookEntryId,CoreBookStore,ContextBuildRequest,AssembledContext,ContextEngine,MemoryBroker,MemoryCreateInput,MemoryItem,MemoryItemId,MemoryMutationAuthority,MemorySearchQuery,MemoryStore,MemoryUpdateInput} from "../../../contracts/src/index";
import {FOUNDATION_SCHEMA_VERSION} from "../../../contracts/src/index";
import type {HealthStatus} from "../../../contracts/src/index";
import {
  AiRuntime,CharacterManager,CoreBookManager,MemoryBrokerImpl,InMemoryCharacterStore,InMemoryDiagnosticsStore,InMemoryEventBus,InMemoryStateStore,ModuleManager,ProviderRegistry,createDeterministicContextEngine,
  InMemoryPermissionService,InMemoryAuditService,InMemoryToolRegistry,DefaultActionBroker,
  DefaultConfirmationService,DefaultRiskPolicy,BrowserTargetResolver,ScopedCapabilityContext,
  InMemoryActorIdentityResolver,createMemoryConfig
} from "../../../core/src/index";
import {StandardContractValidator} from "../../../contracts/src/index";
import {FakeBrowserModule,FakeCharacterModule,FakeMemoryModule} from "../../../modules/mock/src/index";
import {FakeChatProvider,FakeTTSProvider,FakeSTTProvider,FakeEmbeddingProvider,FakeVisionProvider} from "../../../providers/mock/src/index";
import {
  OpenAICompatibleChatProvider,
  type HttpClient,
  type OpenAICompatibleProviderConfig
} from "../../../providers/chat/openai-compatible/src/index";
import {objectSchema} from "../../../core/src/tools";
import {InMemoryCredentialStore} from "../../../host/credentials/src/index";
import {InMemoryCoreBookStore} from "../../../host/core-book/src/index";
import {InMemoryMemoryStore} from "../../../host/memory/src/index";
import type {CoreBookCreateInput,CoreBookUpdateInput} from "../../../core/src/core-book-manager";
import {activeProviderId,buildConfiguredProvider,testProviderConfiguration} from "./provider-configuration";

export interface OpenAICompatibleRuntimeConfig{
  config:OpenAICompatibleProviderConfig;
  credentialStore:CredentialStore;
  httpClient?:HttpClient;
}

export interface FoundationRuntimeOptions{
  providerConfiguration?:ProviderConfiguration;
  credentialStore?:CredentialStore;
  characterStore?:CharacterStore;
  coreBookStore?:CoreBookStore;
  memoryStore?:MemoryStore;
  httpClient?:HttpClient;
  openAICompatible?:OpenAICompatibleRuntimeConfig;
  contextEngine?:ContextEngine;
}

export interface FoundationRuntime{
  start():Promise<void>;
  stop():Promise<void>;
  diagnostics():Promise<RuntimeDiagnostics>;
  invoke(request:import("../../../contracts/src/index").ActionRequest):Promise<import("../../../contracts/src/index").ActionResult>;
  chat(request:ChatRequest):Promise<ChatResponse>;
  aiRuntimeHealth():Promise<HealthStatus>;
  getProviderConfiguration():ProviderConfiguration|undefined;
  getActiveChatModel():string;
  applyProviderConfiguration(configuration:ProviderConfiguration|undefined):Promise<void>;
  testConfiguredProvider():Promise<import("../../../contracts/src/index").ProviderConnectionTestResult>;
  listCharacters():Promise<readonly Character[]>;
  getCharacter(id:CharacterId):Promise<Character|undefined>;
  createCharacter(input:import("../../../core/src/index").CharacterCreateInput):Promise<Character>;
  updateCharacter(id:CharacterId,input:import("../../../core/src/index").CharacterUpdateInput):Promise<Character>;
  deleteCharacter(id:CharacterId):Promise<void>;
  getActiveCharacter():Promise<Character>;
  setActiveCharacter(id:CharacterId):Promise<Character>;
  listCoreBookEntries(characterId:CharacterId):Promise<readonly CoreBookEntry[]>;
  getCoreBookEntry(characterId:CharacterId,entryId:CoreBookEntryId):Promise<CoreBookEntry|undefined>;
  createCoreBookEntry(characterId:CharacterId,input:CoreBookCreateInput):Promise<CoreBookEntry>;
  updateCoreBookEntry(characterId:CharacterId,entryId:CoreBookEntryId,input:CoreBookUpdateInput):Promise<CoreBookEntry>;
  deleteCoreBookEntry(characterId:CharacterId,entryId:CoreBookEntryId):Promise<void>;
  setCoreBookEntryEnabled(characterId:CharacterId,entryId:CoreBookEntryId,enabled:boolean):Promise<CoreBookEntry>;
  buildContext(request:ContextBuildRequest):Promise<AssembledContext>;
  getMemory(characterId:CharacterId,memoryId:MemoryItemId):Promise<MemoryItem|undefined>;
  searchMemory(query:MemorySearchQuery):Promise<readonly MemoryItem[]>;
  createMemory(characterId:CharacterId,input:MemoryCreateInput):Promise<MemoryItem>;
  updateMemory(characterId:CharacterId,memoryId:MemoryItemId,input:MemoryUpdateInput):Promise<MemoryItem>;
  supersedeMemory(characterId:CharacterId,memoryId:MemoryItemId,input:MemoryCreateInput):Promise<MemoryItem>;
  archiveMemory(characterId:CharacterId,memoryId:MemoryItemId):Promise<MemoryItem>;
}

export async function createFoundationRuntime(options:FoundationRuntimeOptions={}):Promise<FoundationRuntime>{
  const diagnosticsStore=new InMemoryDiagnosticsStore();
  const logger={debug(){},info(){},warn(){},error(){}};
  const events=new InMemoryEventBus(diagnosticsStore,logger);
  const _state=new InMemoryStateStore(diagnosticsStore,logger);
  const providers=new ProviderRegistry();
  const characterStore=options.characterStore??new InMemoryCharacterStore();
  const characterManager=new CharacterManager(characterStore,{events,clock:{now:()=>new Date().toISOString()}});
  const coreBookStore=options.coreBookStore??new InMemoryCoreBookStore();
  const coreBookManager=new CoreBookManager(coreBookStore,{events,clock:{now:()=>new Date().toISOString()},characterExists:async characterId=>Boolean(await characterManager.getCharacter(characterId))});
  const memoryStore=options.memoryStore??new InMemoryMemoryStore();
  const credentialStore=options.credentialStore??options.openAICompatible?.credentialStore??new InMemoryCredentialStore();
  let providerConfiguration=options.providerConfiguration;
  const contractValidator=new StandardContractValidator();
  const audit=new InMemoryAuditService();
  const memoryBroker:MemoryBroker=new MemoryBrokerImpl({
    store:memoryStore,
    validator:contractValidator,
    audit,
    events,
    clock:{now:()=>new Date().toISOString()},
    characterExists:async characterId=>Boolean(await characterManager.getCharacter(characterId))
  });
  const userMemoryAuthority:MemoryMutationAuthority={
    actorId:"local-user",
    actorType:"user",
    trusted:true,
    capabilities:[]
  };
  const contextEngine=options.contextEngine??createDeterministicContextEngine(
    {listCoreBookEntries:characterId=>coreBookManager.listCoreBookEntries(characterId)},
    {memoryBroker}
  );
  const permissions=new InMemoryPermissionService();
  const actorResolver=new InMemoryActorIdentityResolver();
  const tools=new InMemoryToolRegistry();
  const targetResolvers=new Map<string,ActionTargetResolver>();
  const browser=new FakeBrowserModule();
  const characterCredential={token:"foundation-character-opaque"};
  actorResolver.register(characterCredential,{
    actorId:"character",
    actorType:"module",
    moduleId:"character.fake",
    trusted:true,
    capabilities:["browser.navigate","browser.control","character.expression","memory.search"]
  });

  providers.register(new FakeChatProvider(),["chat"]);
  const applyProvider=async(configuration:ProviderConfiguration|undefined)=>{
    providerConfiguration=configuration;
    providers.unregister("openai-compatible");
    const configured=configuration?buildConfiguredProvider(configuration,credentialStore,options.httpClient):undefined;
    if(configured)providers.register(configured,["chat"]);
  };
  if(options.openAICompatible){
    providers.register(new OpenAICompatibleChatProvider(options.openAICompatible.config,options.openAICompatible.credentialStore,options.openAICompatible.httpClient),["chat"]);
  }else{
    await applyProvider(providerConfiguration);
  }
  providers.register(new FakeTTSProvider(),["tts"]);
  providers.register(new FakeSTTProvider(),["stt"]);
  providers.register(new FakeEmbeddingProvider(),["embeddings"]);
  providers.register(new FakeVisionProvider(),["vision"]);

  const aiRuntime=new AiRuntime(providers,{validator:contractValidator,diagnostics:diagnosticsStore,events,clock:()=>new Date().toISOString()});

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
    schemaValidator:new StandardContractValidator(),diagnostics:diagnosticsStore,targetResolvers,actorResolver
  });

  let runtimeStatus:RuntimeDiagnostics["runtimeStatus"]="starting";
  const snapshot=async():Promise<RuntimeDiagnostics>=>{
    const moduleHealth=await moduleManager.health().catch(()=>({}));
    const modules=moduleManager.list().map(item=>({
      ...item,
      health:(moduleHealth as Record<string,HealthStatus|undefined>)[item.id]
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
    async start(){await characterManager.initialize();await moduleManager.initializeAll();await moduleManager.startAll();runtimeStatus="running";},
    async stop(){try{await moduleManager.stopAll();}finally{runtimeStatus="stopped";}},
    diagnostics:snapshot,
    invoke:request=>broker.execute({request,credential:characterCredential}),
    chat:request=>aiRuntime.generate(request.providerId?request:{...request,providerId:activeProviderId(providerConfiguration)}),
    aiRuntimeHealth:()=>aiRuntime.health(),
    getProviderConfiguration:()=>providerConfiguration,
    getActiveChatModel:()=>activeProviderId(providerConfiguration)==="openai-compatible"&&providerConfiguration?providerConfiguration.model:"fake-chat",
    applyProviderConfiguration:async(configuration)=>{await applyProvider(configuration);},
    listCharacters:()=>characterManager.listCharacters(),
    getCharacter:id=>characterManager.getCharacter(id),
    createCharacter:input=>characterManager.createCharacter(input),
    updateCharacter:(id,input)=>characterManager.updateCharacter(id,input),
    deleteCharacter:id=>characterManager.deleteCharacter(id),
    getActiveCharacter:()=>characterManager.getActiveCharacter(),
    setActiveCharacter:id=>characterManager.setActiveCharacter(id),
    listCoreBookEntries:characterId=>coreBookManager.listCoreBookEntries(characterId),
    getCoreBookEntry:(characterId,entryId)=>coreBookManager.getCoreBookEntry(characterId,entryId),
    createCoreBookEntry:(characterId,input)=>coreBookManager.createCoreBookEntry(characterId,input),
    updateCoreBookEntry:(characterId,entryId,input)=>coreBookManager.updateCoreBookEntry(characterId,entryId,input),
    deleteCoreBookEntry:(characterId,entryId)=>coreBookManager.deleteCoreBookEntry(characterId,entryId),
    setCoreBookEntryEnabled:(characterId,entryId,enabled)=>coreBookManager.setCoreBookEntryEnabled(characterId,entryId,enabled),
    buildContext:request=>contextEngine.build(request),
    getMemory:(characterId,memoryId)=>memoryBroker.get(characterId,memoryId),
    searchMemory:query=>memoryBroker.search(query),
    createMemory:(characterId,input)=>memoryBroker.create(characterId,input,userMemoryAuthority),
    updateMemory:(characterId,memoryId,input)=>memoryBroker.update(characterId,memoryId,input,userMemoryAuthority),
    supersedeMemory:(characterId,memoryId,input)=>memoryBroker.supersede(characterId,memoryId,input,userMemoryAuthority),
    archiveMemory:(characterId,memoryId)=>memoryBroker.archive(characterId,memoryId,userMemoryAuthority),
    testConfiguredProvider:async()=>{
      if(!providerConfiguration)return {apiVersion:"1",schemaVersion:"1",status:"configuration_error",providerId:"openai-compatible",message:"No provider configuration is saved."};
      return testProviderConfiguration(providerConfiguration,credentialStore,options.httpClient);
    }
  };
}
export {activeProviderId,buildConfiguredProvider,testProviderConfiguration,validateProviderConfiguration} from "./provider-configuration";

export async function startFoundationRuntime(options:FoundationRuntimeOptions={}){
  const runtime=await createFoundationRuntime(options);
  await runtime.start();
  return runtime;
}
export type {RuntimeDiagnostics,ActorIdentity};
