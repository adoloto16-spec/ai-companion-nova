import type {ActionInvocation,ActionTarget,ActionTargetResolver,ActorIdentity,RuntimeDiagnostics,ToolDefinition,ActionDriver,ActionTarget as Target,ChatRequest,ChatRequestOptions,ChatResponse,CredentialStore,ProviderConfiguration,ProviderPreset,Character,CharacterId,CharacterStore,CoreBookEntry,CoreBookEntryId,CoreBookStore,ContextBuildRequest,AssembledContext,ContextEngine,MemoryBroker,MemoryCreateInput,MemoryArchiveReason,MemoryItem,MemoryItemId,MemoryMutationAuthority,MemorySearchQuery,MemoryStore,MemoryUpdateInput,MemorySemanticIndexStore,RetrievalIndexWriter,RetrievalQuery,RetrievalResult,Retriever,ChatProvider} from "../../../contracts/src/index";
import {FOUNDATION_SCHEMA_VERSION} from "../../../contracts/src/index";
import type {HealthStatus,AppSettings,AppSettingsStore,ChatTraceStore} from "../../../contracts/src/index";
import type {Conversation,ConversationCreateInput,ConversationId,ConversationStore,ConversationUpdateInput} from "../../../contracts/src/index";
import {
  AiRuntime,AutomaticMemoryAgent,CharacterManager,ConversationManager,CoreBookManager,InProcessMemoryRetriever,MemoryBrokerImpl,MemorySemanticDeduplicator,InMemoryCharacterStore,InMemoryDiagnosticsStore,InMemoryEventBus,InMemoryStateStore,ModuleManager,ProviderRegistry,createDeterministicContextEngine,MindRuntime,LLMCognitiveStep,
  InMemoryPermissionService,InMemoryAuditService,InMemoryToolRegistry,DefaultActionBroker,
  DefaultConfirmationService,DefaultRiskPolicy,BrowserTargetResolver,ScopedCapabilityContext,
  InMemoryActorIdentityResolver,createMemoryConfig,SettingsManager,InMemoryChatTraceStore
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
import {InMemoryConversationStore} from "../../../host/conversations/src/index";
import {InMemorySettingsStore} from "../../../host/settings/src/index";
import {InMemoryCoreBookStore} from "../../../host/core-book/src/index";
import {InMemoryMemorySemanticIndexStore,InMemoryMemoryStore} from "../../../host/memory/src/index";
import type {CoreBookCreateInput,CoreBookUpdateInput} from "../../../core/src/core-book-manager";
import {activeProviderId,buildConfiguredProvider,buildEmbeddingProviderForPreset,buildProviderForDiscovery,buildProviderForPreset,buildChatProviderForSource,testProviderConfiguration} from "./provider-configuration";
import {ProviderPoolChatProvider} from "./provider-pool";
import {RetrievalEventIndexer} from "../../../core/src/retrieval-indexer";


export interface OpenAICompatibleRuntimeConfig{
  config:OpenAICompatibleProviderConfig;
  credentialStore:CredentialStore;
  httpClient?:HttpClient;
}

export interface FoundationRuntimeOptions{
  providerConfiguration?:ProviderConfiguration;
  settingsStore?:AppSettingsStore;
  credentialStore?:CredentialStore;
  characterStore?:CharacterStore;
  coreBookStore?:CoreBookStore;
  memoryStore?:MemoryStore;
  conversationStore?:ConversationStore;
  httpClient?:HttpClient;
  openAICompatible?:OpenAICompatibleRuntimeConfig;
  contextEngine?:ContextEngine;
  retriever?:Retriever;
  retrievalIndexWriter?:RetrievalIndexWriter;
  semanticIndexStore?:MemorySemanticIndexStore;
  embeddingHttpClient?:import("../../../providers/embeddings/openai-compatible/src").EmbeddingHttpClient;
  providerPresetConfigurations?:readonly {presetId:string;configuration:ProviderConfiguration}[];
  providerPresetPools?:readonly ProviderPreset[];
  onProviderPresetPoolStateChange?:(preset:ProviderPreset)=>void|Promise<void>;
  activeProviderPresetId?:string;
}

export interface FoundationRuntime{
  start():Promise<void>;
  stop():Promise<void>;
  diagnostics():Promise<RuntimeDiagnostics>;
  recordDiagnosticError(source:string,code:string,message:string,metadata?:Record<string,unknown>):void;
  invoke(request:import("../../../contracts/src/index").ActionRequest):Promise<import("../../../contracts/src/index").ActionResult>;
  chat(request:ChatRequest,providerPresetId?:string):Promise<ChatResponse>;
  stream(request:ChatRequest,handlers:import("../../../contracts/src/index").ChatStreamHandlers,options?:import("../../../contracts/src/index").ChatStreamOptions,providerPresetId?:string):Promise<ChatResponse>;
  aiRuntimeHealth():Promise<HealthStatus>;
  getProviderConfiguration():ProviderConfiguration|undefined;
  getActiveChatModel():string;
  getChatModel(providerId?:string):Promise<string>;
  getChatModelForPreset(providerPresetId:string):Promise<string>;
  getActiveProviderPresetId():string|undefined;
  startLife():Promise<void>;
  stopLife():Promise<void>;
  getMindState():import("../../../contracts/src/index").MindState;
  subscribeMindState(listener:(state:import("../../../contracts/src/index").MindState)=>void):import("../../../contracts/src/index").Unsubscribe;
  subscribeThoughts(listener:(thought:import("../../../contracts/src/index").Thought)=>void):import("../../../contracts/src/index").Unsubscribe;
  deleteThought(thoughtId:string):boolean;
  clearCurrentThoughts():void;
  clearAllThoughts():void;
  getChatProviderDiagnostics(providerPresetId?:string):{
    providerPresetId?:string;
    providerId:string;
    baseUrlHost?:string;
    timeoutMs?:number;
    sourceId?:string;
    health?:import("../../../contracts/src/index").ProviderSourceHealth;
    failureCount?:number;
    cooldownUntil?:string|null;
  };
  applyProviderConfiguration(configuration:ProviderConfiguration|undefined):Promise<void>;
  testConfiguredProvider():Promise<import("../../../contracts/src/index").ProviderConnectionTestResult>;
  getSettings():AppSettings;
  updateSettings(settings:AppSettings):Promise<AppSettings>;
  resetSettings():Promise<AppSettings>;
  getChatTraceStore():ChatTraceStore;
  listChatTraces(limit?:number):readonly import("../../../contracts/src/index").ChatTurnTrace[];
  clearChatTraces():void;
  setProviderPresetConfigurations(configurations:readonly {presetId:string;configuration:ProviderConfiguration}[],activePresetId?:string):void;
  setProviderPresetPools(presets:readonly ProviderPreset[],activePresetId?:string):void;
  listCharacters():Promise<readonly Character[]>;
  getCharacter(id:CharacterId):Promise<Character|undefined>;
  createCharacter(input:import("../../../core/src/index").CharacterCreateInput):Promise<Character>;
  updateCharacter(id:CharacterId,input:import("../../../core/src/index").CharacterUpdateInput):Promise<Character>;
  deleteCharacter(id:CharacterId):Promise<void>;
  getActiveCharacter():Promise<Character>;
  setActiveCharacter(id:CharacterId):Promise<Character>;
  createConversation(characterId:CharacterId,input?:ConversationCreateInput):Promise<Conversation>;
  listConversations(characterId:CharacterId):Promise<readonly Conversation[]>;
  getConversation(characterId:CharacterId,conversationId:ConversationId):Promise<Conversation|undefined>;
  updateConversation(characterId:CharacterId,conversationId:ConversationId,input:ConversationUpdateInput):Promise<Conversation>;
  deleteConversation(characterId:CharacterId,conversationId:ConversationId):Promise<Conversation>;
  setActiveConversation(characterId:CharacterId,conversationId:ConversationId):Promise<Conversation>;
  getActiveConversation(characterId:CharacterId):Promise<Conversation>;
  clearConversation(characterId:CharacterId,conversationId:ConversationId):Promise<Conversation>;
  listCoreBookEntries(characterId:CharacterId):Promise<readonly CoreBookEntry[]>;
  getCoreBookEntry(characterId:CharacterId,entryId:CoreBookEntryId):Promise<CoreBookEntry|undefined>;
  createCoreBookEntry(characterId:CharacterId,input:CoreBookCreateInput):Promise<CoreBookEntry>;
  updateCoreBookEntry(characterId:CharacterId,entryId:CoreBookEntryId,input:CoreBookUpdateInput):Promise<CoreBookEntry>;
  deleteCoreBookEntry(characterId:CharacterId,entryId:CoreBookEntryId):Promise<void>;
  setCoreBookEntryEnabled(characterId:CharacterId,entryId:CoreBookEntryId,enabled:boolean):Promise<CoreBookEntry>;
  buildContext(request:ContextBuildRequest):Promise<AssembledContext>;
  extractMemory(request:import("../../../contracts/src/index").MemoryExtractionRequest):Promise<readonly MemoryItem[]>;
  getMemory(characterId:CharacterId,memoryId:MemoryItemId):Promise<MemoryItem|undefined>;
  /** @deprecated Legacy conversation argument is provenance only. */
  getMemory(characterId:CharacterId,conversationId:ConversationId,memoryId:MemoryItemId):Promise<MemoryItem|undefined>;
  searchMemory(query:MemorySearchQuery):Promise<readonly MemoryItem[]>;
  listMemory(characterId:CharacterId):Promise<readonly MemoryItem[]>;
  createMemory(characterId:CharacterId,input:MemoryCreateInput):Promise<MemoryItem>;
  updateMemory(characterId:CharacterId,memoryId:MemoryItemId,input:MemoryUpdateInput):Promise<MemoryItem>;
  /** @deprecated Legacy conversation argument is provenance only. */
  updateMemory(characterId:CharacterId,conversationId:ConversationId,memoryId:MemoryItemId,input:MemoryUpdateInput):Promise<MemoryItem>;
  supersedeMemory(characterId:CharacterId,conversationId:ConversationId,memoryId:MemoryItemId,input:MemoryCreateInput):Promise<MemoryItem>;
  archiveMemory(characterId:CharacterId,memoryId:MemoryItemId,reason?:import("../../../contracts/src/index").MemoryArchiveReason):Promise<MemoryItem>;
  /** @deprecated Legacy conversation argument is provenance only. */
  archiveMemory(characterId:CharacterId,conversationId:ConversationId,memoryId:MemoryItemId,reason?:import("../../../contracts/src/index").MemoryArchiveReason):Promise<MemoryItem>;
  restoreMemory(characterId:CharacterId,memoryId:MemoryItemId):Promise<MemoryItem>;
  deleteMemory(characterId:CharacterId,memoryId:MemoryItemId):Promise<void>;
  searchRetrieval(query:RetrievalQuery):Promise<RetrievalResult>;
  rebuildRetrieval(characterId:CharacterId):Promise<void>;
  rebuildAllRetrieval():Promise<void>;
}

function safeBaseUrlHost(baseUrl:string):string|undefined{
  try{return new URL(baseUrl).host||undefined}catch{return undefined}
}

function safeProviderConfigMetadata(configuration:ProviderConfiguration|undefined):Record<string,unknown>|undefined{
  if(!configuration)return undefined;
  return {
    providerId:configuration.providerId,
    ...(safeBaseUrlHost(configuration.baseUrl)?{baseUrlHost:safeBaseUrlHost(configuration.baseUrl)}:{}),
    ...(configuration.timeoutMs!==undefined?{timeoutMs:configuration.timeoutMs}:{}),
  };
}

function recordChatProviderFailure(
  diagnostics:InMemoryDiagnosticsStore,
  error:unknown,
  request:ChatRequest,
  providerPresetId:string|undefined,
  chatTransport:"stream"|"chat"
):void{
  const chatError=error&&typeof error==="object"&&"chatError" in error
    ?(error as {chatError?:{providerId?:unknown;details?:Record<string,unknown>}}).chatError
    :undefined;
  const details=chatError?.details;
  diagnostics.recordError("chat-provider","CHAT_PROVIDER_REQUEST_FAILED","Chat provider request failed",{
    requestId:request.requestId,
    ...(typeof chatError?.providerId==="string"?{providerId:chatError.providerId}:{}),
    ...(providerPresetId?{providerPresetId}:{}),
    model:request.model,
    ...(typeof details?.category==="string"?{category:details.category}:{}),
    ...(typeof details?.httpStatus==="number"?{httpStatus:details.httpStatus}:{}),
    ...(typeof details?.durationMs==="number"?{durationMs:details.durationMs}:{}),
    ...(typeof details?.timeoutMs==="number"?{timeoutMs:details.timeoutMs}:{}),
    ...(details?.providerResponse!==undefined?{providerResponse:details.providerResponse}:{}),
    chatTransport,
  });
}

export async function createFoundationRuntime(options:FoundationRuntimeOptions={}):Promise<FoundationRuntime>{
  const contractValidator=new StandardContractValidator();
  const settingsStore=options.settingsStore??new InMemorySettingsStore(contractValidator);
  const settingsManager=new SettingsManager(settingsStore,contractValidator);
  const appSettings=await settingsManager.initialize();
  const diagnosticsStore=new InMemoryDiagnosticsStore(appSettings.diagnostics.keepRecentEntries);
  const traceStore=new InMemoryChatTraceStore();
  traceStore.configure(appSettings.diagnostics.logLevel,appSettings.diagnostics.keepRecentEntries);
  const logger={debug(){},info(){},warn(){},error(){}};
  const events=new InMemoryEventBus(diagnosticsStore,logger);
  const _state=new InMemoryStateStore(diagnosticsStore,logger);
  const providers=new ProviderRegistry();
  const characterStore=options.characterStore??new InMemoryCharacterStore();
  const characterManager=new CharacterManager(characterStore,{events,clock:{now:()=>new Date().toISOString()}});
  const coreBookStore=options.coreBookStore??new InMemoryCoreBookStore();
  const coreBookManager=new CoreBookManager(coreBookStore,{events,clock:{now:()=>new Date().toISOString()},characterExists:async characterId=>Boolean(await characterManager.getCharacter(characterId))});
  const memoryStore=options.memoryStore??new InMemoryMemoryStore();
  const semanticIndexStore=options.semanticIndexStore??new InMemoryMemorySemanticIndexStore();

  const conversationStore=options.conversationStore??new InMemoryConversationStore();
  const conversationManager=new ConversationManager(conversationStore,{characterExists:async characterId=>Boolean(await characterManager.getCharacter(characterId)),events,clock:{now:()=>new Date().toISOString()}});
  const credentialStore=options.credentialStore??options.openAICompatible?.credentialStore??new InMemoryCredentialStore();
  let providerPresetConfigurations=new Map((options.providerPresetConfigurations??[]).map(item=>[item.presetId,item.configuration]));
  let providerPresetPools=new Map((options.providerPresetPools??[]).map(preset=>[preset.id,preset]));
  let activeProviderPresetId=options.activeProviderPresetId??options.providerPresetPools?.[0]?.id??options.providerPresetConfigurations?.[0]?.presetId;
  let providerConfiguration=options.providerConfiguration;
  const audit=new InMemoryAuditService();
  let retrievalDegraded=false;
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
  const memoryRetriever=new InProcessMemoryRetriever(memoryBroker,{diagnostics:diagnosticsStore});
  const contextEngine=options.contextEngine??createDeterministicContextEngine(
    {listCoreBookEntries:characterId=>coreBookManager.listCoreBookEntries(characterId)},
    {memoryBroker,memoryRetriever,retriever:options.retriever,recentMessageCount:()=>settingsManager.get().context.recentConversationMessages,memoryCandidateLimit:()=>settingsManager.get().memory.candidateLimit,retrievalCandidateLimit:()=>settingsManager.get().retrieval.candidateLimit,diagnostics:diagnosticsStore}
  );
  const retrievalIndexer=options.retrievalIndexWriter
    ? new RetrievalEventIndexer({events,coreBook:coreBookManager,memory:memoryBroker,writer:options.retrievalIndexWriter})
    : undefined;
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
    providers.unregister("gemini");
    const configured=configuration?buildConfiguredProvider(configuration,credentialStore,options.httpClient,diagnosticsStore,activeProviderPresetId):undefined;
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

  const providerPoolProviders=new Map<string,ProviderPoolChatProvider>();
  const createPoolProvider=(preset:ProviderPreset):ProviderPoolChatProvider=>new ProviderPoolChatProvider({
    preset,
    credentialStore,
    diagnostics:diagnosticsStore,
    createProvider:(source,diagnostics)=>buildChatProviderForSource(source,credentialStore,options.httpClient,diagnostics,preset.id),
    onStateChanged:async updated=>{
      providerPresetPools.set(updated.id,updated);
      const source=updated.sources.find(item=>item.id===updated.activeSourceId)??updated.sources[0];
      if(source){
        providerPresetConfigurations.set(updated.id,{
          apiVersion:"1",
          schemaVersion:"1",
          providerId:source.providerId,
          enabled:source.enabled&&source.model.trim().length>0,
          baseUrl:source.baseUrl,
          model:source.model,
          credentialReference:source.credentialReference?{...source.credentialReference}:null,
          ...(source.timeoutMs===undefined?{}:{timeoutMs:source.timeoutMs})
        });
      }
      await options.onProviderPresetPoolStateChange?.(updated);
    }
  });
  const getPoolProvider=(providerPresetId:string):ProviderPoolChatProvider|undefined=>{
    const preset=providerPresetPools.get(providerPresetId);
    if(!preset)return undefined;
    const existing=providerPoolProviders.get(providerPresetId);
    if(existing)return existing;
    const created=createPoolProvider(preset);
    providerPoolProviders.set(providerPresetId,created);
    return created;
  };
  const aiRuntime=new AiRuntime(providers,{validator:contractValidator,diagnostics:diagnosticsStore,events,clock:()=>new Date().toISOString()});
  const extractionChatRuntime={
    chat:async (request:ChatRequest,providerPresetId?:string,chatOptions:ChatRequestOptions={}):Promise<ChatResponse>=>{
      if(providerPresetId){
        const pool=getPoolProvider(providerPresetId);
        if(pool){
          const scopedProviders=new ProviderRegistry();
          scopedProviders.register(pool,["chat"]);
          const scopedRuntime=new AiRuntime(scopedProviders,{validator:contractValidator,diagnostics:diagnosticsStore,events,clock:()=>new Date().toISOString()});
          return scopedRuntime.generate({...request,providerId:pool.id},chatOptions);
        }
        const configuration=providerPresetConfigurations.get(providerPresetId);
        const effectiveConfiguration=configuration?{...configuration,model:request.model}:undefined;
        const scopedProviders=new ProviderRegistry();
        if(effectiveConfiguration){
          const configured=buildProviderForPreset(effectiveConfiguration,credentialStore,options.httpClient);
          if(configured)scopedProviders.register(configured,["chat"]);
        }
        const scopedRuntime=new AiRuntime(scopedProviders,{validator:contractValidator,diagnostics:diagnosticsStore,events,clock:()=>new Date().toISOString()});
        return scopedRuntime.generate({...request,providerId:effectiveConfiguration?.providerId??request.providerId},chatOptions);
      }
      return aiRuntime.generate(request.providerId?request:{...request,providerId:activeProviderId(providerConfiguration)},chatOptions);
    }
  };
  const resolveChatModelForPreset=async(providerPresetId:string):Promise<string>=>{
    const configuration=providerPresetConfigurations.get(providerPresetId);
    if(!configuration)return "fake-chat";
    const provider=buildProviderForDiscovery(configuration,credentialStore,options.httpClient);
    if(!provider)return configuration.model||"fake-chat";
    try{
      const models=await provider.listModels();
      return models[0]?.id??(configuration.model||"fake-chat");
    }catch{
      return configuration.model||"fake-chat";
    }
  };
  const getChatModelForPreset=async(providerPresetId:string):Promise<string>=>{
    const pool=getPoolProvider(providerPresetId);
    return pool?.getModel()??resolveChatModelForPreset(providerPresetId);
  };

  const mindRuntime=new MindRuntime({
    cognitiveStep:new LLMCognitiveStep({
      runtime:extractionChatRuntime,
      getCharacter:characterId=>characterManager.getCharacter(characterId),
      getActiveConversation:characterId=>conversationManager.getActiveConversation(characterId),
      buildContext:request=>contextEngine.build(request),
      getContextBudget:()=>{
        const settings=settingsManager.get();
        return {availableContextTokens:settings.context.availableContextTokens,reservedOutputTokens:settings.context.reservedOutputTokens,systemOverheadTokens:0,safetyMarginTokens:settings.context.safetyMarginTokens};
      },
      getActiveProviderPresetId:()=>activeProviderPresetId,
      getChatModel:()=>activeProviderId(providerConfiguration)==="openai-compatible"&&providerConfiguration?providerConfiguration.model:"fake-chat",
      getChatModelForPreset,
      getCognitiveSchedule:()=>settingsManager.get().cognitiveSchedule,
      clock:()=>new Date().toISOString()
    }),
    schedule:settingsManager.get().cognitiveSchedule,
    recentThoughtLimit:50,
    onError:error=>{
      const chatError=error&&typeof error==="object"&&"chatError" in error
        ?(error as {chatError?:{requestId?:unknown;code?:unknown;message?:unknown;providerId?:unknown;details?:Record<string,unknown>}}).chatError
        :undefined;
      const details=chatError?.details;
      const diagnosedPresetId=typeof details?.providerPresetId==="string"?details.providerPresetId:activeProviderPresetId;
      const poolDiagnostics=diagnosedPresetId?getPoolProvider(diagnosedPresetId)?.getDiagnostics():undefined;
      diagnosticsStore.recordError("mind-runtime","COGNITIVE_STEP_FAILED",typeof chatError?.message==="string"?chatError.message:error instanceof Error?error.message:String(error),{
        ...(typeof chatError?.requestId==="string"?{requestId:chatError.requestId}:{}),
        ...(typeof chatError?.code==="string"?{chatErrorCode:chatError.code}:{}),
        ...(diagnosedPresetId?{providerPresetId:diagnosedPresetId}:{}),
        ...(typeof details?.sourceId==="string"?{sourceId:details.sourceId}:poolDiagnostics?.sourceId?{sourceId:poolDiagnostics.sourceId}:{}),
        ...(typeof chatError?.providerId==="string"?{providerId:chatError.providerId}:poolDiagnostics?.providerId?{providerId:poolDiagnostics.providerId}:{}),
        ...(typeof details?.model==="string"?{model:details.model}:poolDiagnostics?.model?{model:poolDiagnostics.model}:{}),
        ...(poolDiagnostics?.baseUrlHost?{baseUrlHost:poolDiagnostics.baseUrlHost}:{}),
        ...(typeof details?.category==="string"?{category:details.category}:{}),
        ...(typeof details?.httpStatus==="number"?{httpStatus:details.httpStatus}:{}),
        ...(typeof details?.durationMs==="number"?{durationMs:details.durationMs}:{}),
        ...(typeof details?.providerResponse!=="undefined"?{providerResponse:details.providerResponse}:{})
      });
    }
  });

  const automaticMemoryAgent=new AutomaticMemoryAgent({
    settings:()=>settingsManager.get(),
    broker:memoryBroker,
    runtime:{chat:extractionChatRuntime.chat,getChatModelForPreset},
    validator:contractValidator,
    diagnostics:diagnosticsStore,
    traceStore
  });

  const semanticMemoryDeduplicator=new MemorySemanticDeduplicator({
    settings:()=>settingsManager.get(),
    broker:memoryBroker,
    indexStore:semanticIndexStore,
    embeddingProvider:async()=>{
      const semanticSettings=settingsManager.get().semanticDedup;
      const presetId=semanticSettings.embeddingProviderPresetId?.trim()??"";
      const configuration=presetId?providerPresetConfigurations.get(presetId):undefined;
      if(!configuration)return undefined;
      return buildEmbeddingProviderForPreset(configuration,semanticSettings.embeddingModel,credentialStore,options.embeddingHttpClient);
    },
    judgeRuntime:extractionChatRuntime,
    getChatModelForPreset,
    validator:contractValidator,
    diagnostics:diagnosticsStore,
    events,
    listCharacterIds:async()=> (await characterManager.listCharacters()).map(character=>character.id),
    clock:{now:()=>new Date().toISOString()},
    source:"memory-semantic-deduplication"
  });
  semanticMemoryDeduplicator.start();
  // Record the effective production wiring and settings so disabled or unwired dedup is observable without exposing secrets.
  diagnosticsStore.recordError("memory-semantic-deduplication","SEMANTIC_DEDUP_RUNTIME_READY","semantic memory deduplication runtime ready",{
    semanticDedupEnabled:appSettings.semanticDedup.enabled,
    judgeEnabled:appSettings.semanticDedup.judge.enabled,
    judgeProviderPresetId:appSettings.semanticDedup.judge.providerPresetId??null,
    judgeModel:appSettings.semanticDedup.judge.model,
    judgeOutputMode:appSettings.semanticDedup.judge.outputMode,
    memoryCreatedSubscribers:events.subscriberCount("MemoryCreated")
  });

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
    const degraded=retrievalDegraded||modules.some(item=>item.state==="error"||item.state==="degraded")||
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
    async start(){
      await characterManager.initialize();
      const initialCharacter=await characterManager.getActiveCharacter();
      mindRuntime.setActiveCharacter(initialCharacter.id);
      try{await conversationManager.getActiveConversation(await characterManager.getActiveCharacter().then(character=>character.id));}
      catch(error){diagnosticsStore.recordError("conversation-storage","LOAD_FAILED",error instanceof Error?error.message:String(error));}
      retrievalIndexer?.start();
      try{await semanticMemoryDeduplicator.rebuildAll();}
      catch(error){diagnosticsStore.recordError("memory-semantic-deduplication","STARTUP_REBUILD_FAILED",error instanceof Error?error.message:String(error));}
      if(options.retriever){
        try{await options.retriever.rebuildAll();retrievalDegraded=false}
        catch(error){retrievalDegraded=true;diagnosticsStore.recordError("retrieval","REBUILD_FAILED",error instanceof Error?error.message:String(error))}
      }
      await moduleManager.initializeAll();
      await moduleManager.startAll();
      runtimeStatus="running";
    },
    async stop(){try{await mindRuntime.stop();semanticMemoryDeduplicator.stop();retrievalIndexer?.stop();await moduleManager.stopAll();}finally{runtimeStatus="stopped";}},
    diagnostics:snapshot,
    recordDiagnosticError:(source,code,message,metadata)=>diagnosticsStore.recordError(source,code,message,metadata),
    invoke:request=>broker.execute({request,credential:characterCredential}),
    stream:async(request,handlers,streamOptions={},providerPresetId)=>{
      if(providerPresetId){
        const pool=getPoolProvider(providerPresetId);
        if(pool){
          const scopedProviders=new ProviderRegistry();
          scopedProviders.register(pool,["chat"]);
          const scopedRuntime=new AiRuntime(scopedProviders,{validator:contractValidator,diagnostics:diagnosticsStore,events,clock:()=>new Date().toISOString()});
          return scopedRuntime.stream({...request,providerId:pool.id},handlers,streamOptions);
        }
        const configuration=providerPresetConfigurations.get(providerPresetId);
        const effectiveConfiguration=configuration?{...configuration,model:request.model}:undefined;
        const scopedProviders=new ProviderRegistry();
        if(effectiveConfiguration){
          const configured=buildProviderForPreset(effectiveConfiguration,credentialStore,options.httpClient,diagnosticsStore,providerPresetId);
          if(configured)scopedProviders.register(configured,["chat"]);
        }
        diagnosticsStore.recordError("chat-provider","CHAT_PROVIDER_REQUEST_STARTED","Chat provider stream request started",{
          requestId:request.requestId,providerId:effectiveConfiguration?.providerId??request.providerId??"unknown",providerPresetId,model:request.model,
          ...(safeProviderConfigMetadata(effectiveConfiguration)?{...safeProviderConfigMetadata(effectiveConfiguration)}:{}),
          chatTransport:"stream"
        });
        const scopedRuntime=new AiRuntime(scopedProviders,{validator:contractValidator,diagnostics:diagnosticsStore,events,clock:()=>new Date().toISOString()});
        try{
          return await scopedRuntime.stream({...request,providerId:effectiveConfiguration?.providerId??request.providerId},handlers,streamOptions);
        }catch(error){
          recordChatProviderFailure(diagnosticsStore,error,request,providerPresetId,"stream");
          throw error;
        }
      }
      diagnosticsStore.recordError("chat-provider","CHAT_PROVIDER_REQUEST_STARTED","Chat provider stream request started",{
        requestId:request.requestId,providerId:request.providerId??activeProviderId(providerConfiguration),model:request.model,
        ...(safeProviderConfigMetadata(providerConfiguration)?{...safeProviderConfigMetadata(providerConfiguration)}:{}),
        chatTransport:"stream"
      });
      try{
        return await aiRuntime.stream(request,handlers,streamOptions);
      }catch(error){
        recordChatProviderFailure(diagnosticsStore,error,request,undefined,"stream");
        throw error;
      }
    },
    chat:async(request:ChatRequest,providerPresetId?:string,chatOptions:ChatRequestOptions={})=>{
      if(providerPresetId){
        const pool=getPoolProvider(providerPresetId);
        if(pool){
          const scopedProviders=new ProviderRegistry();
          scopedProviders.register(pool,["chat"]);
          const scopedRuntime=new AiRuntime(scopedProviders,{validator:contractValidator,diagnostics:diagnosticsStore,events,clock:()=>new Date().toISOString()});
          return scopedRuntime.generate({...request,providerId:pool.id},chatOptions);
        }
        const configuration=providerPresetConfigurations.get(providerPresetId);
        const effectiveConfiguration=configuration?{...configuration,model:request.model}:undefined;
        const scopedProviders=new ProviderRegistry();
        if(effectiveConfiguration){
          const configured=buildProviderForPreset(effectiveConfiguration,credentialStore,options.httpClient);
          if(configured)scopedProviders.register(configured,["chat"]);
        }
        const scopedRuntime=new AiRuntime(scopedProviders,{validator:contractValidator,diagnostics:diagnosticsStore,events,clock:()=>new Date().toISOString()});
        return scopedRuntime.generate({...request,providerId:effectiveConfiguration?.providerId??request.providerId},chatOptions);
      }
      return aiRuntime.generate(request.providerId?request:{...request,providerId:activeProviderId(providerConfiguration)},chatOptions);
    },
    aiRuntimeHealth:()=>aiRuntime.health(),
    getProviderConfiguration:()=>providerConfiguration,
    getActiveChatModel:()=>activeProviderId(providerConfiguration)==="openai-compatible"&&providerConfiguration?providerConfiguration.model:"fake-chat",
    getChatModel:async(providerId)=>{
      if(!providerId)return activeProviderId(providerConfiguration)==="openai-compatible"&&providerConfiguration?providerConfiguration.model:"fake-chat";
      const provider=providers.get<ChatProvider>(providerId);
      if(!provider)return activeProviderId(providerConfiguration)==="openai-compatible"&&providerConfiguration?providerConfiguration.model:"fake-chat";
      try{
        const models=await provider.listModels();
        return models[0]?.id??(activeProviderId(providerConfiguration)==="openai-compatible"&&providerConfiguration?providerConfiguration.model:"fake-chat");
      }catch{
        return activeProviderId(providerConfiguration)==="openai-compatible"&&providerConfiguration?providerConfiguration.model:"fake-chat";
      }
    },
    getActiveProviderPresetId:()=>activeProviderPresetId,
    startLife:()=>mindRuntime.start(),
    stopLife:()=>mindRuntime.stop(),
    getMindState:()=>mindRuntime.getState(),
    wakeMind:()=>mindRuntime.wake("user-message"),
    subscribeMindState:listener=>mindRuntime.subscribe(listener),
    subscribeThoughts:listener=>mindRuntime.subscribeThoughts(listener),
    deleteThought:thoughtId=>mindRuntime.deleteThought(thoughtId),
    clearCurrentThoughts:()=>mindRuntime.clearCurrentThoughts(),
    clearAllThoughts:()=>mindRuntime.clearAllThoughts(),
    getChatProviderDiagnostics:providerPresetId=>{
      const effectiveId=providerPresetId??activeProviderPresetId;
      if(effectiveId){
        const pool=getPoolProvider(effectiveId);
        if(pool){
          const poolDiagnostics=pool.getDiagnostics();
          const activeSource=providerPresetPools.get(effectiveId)?.sources.find(source=>source.id===poolDiagnostics.sourceId);
          return {
            ...poolDiagnostics,
            providerPresetId:effectiveId,
            providerId:poolDiagnostics.providerId||activeSource?.providerId||"unknown",
            ...(activeSource?{timeoutMs:activeSource.timeoutMs??30000}:{}),
            ...(poolDiagnostics.sourceId?{sourceId:poolDiagnostics.sourceId}:{}),
          };
        }
      }
      const configuration=effectiveId?providerPresetConfigurations.get(effectiveId):providerConfiguration;
      return {
        providerPresetId:effectiveId,
        providerId:configuration?.providerId??activeProviderId(providerConfiguration),
        ...(configuration?{baseUrlHost:safeBaseUrlHost(configuration.baseUrl)}:{}),
        ...(configuration?{timeoutMs:configuration.timeoutMs??30000}:{}),
        sourceId:""
      };
    },
    getChatModelForPreset,
    applyProviderConfiguration:async(configuration)=>{await applyProvider(configuration);},
    getSettings:()=>settingsManager.get(),
    updateSettings:async(settings)=>{
      const next=await settingsManager.set(settings);
      mindRuntime.updateSchedule(next.cognitiveSchedule);
      diagnosticsStore.setMaxEntries(next.diagnostics.keepRecentEntries);
      traceStore.configure(next.diagnostics.logLevel,next.diagnostics.keepRecentEntries);
      // Record the values the already-running runtime will use after a Settings Save.
      diagnosticsStore.recordError("memory-semantic-deduplication","SEMANTIC_DEDUP_SETTINGS_APPLIED","semantic memory deduplication settings applied",{
        semanticDedupEnabled:next.semanticDedup.enabled,
        judgeEnabled:next.semanticDedup.judge.enabled,
        judgeProviderPresetId:next.semanticDedup.judge.providerPresetId??null,
        judgeModel:next.semanticDedup.judge.model,
        judgeOutputMode:next.semanticDedup.judge.outputMode
      });
      return next;
    },
    resetSettings:async()=>{
      const next=await settingsManager.reset();
      mindRuntime.updateSchedule(next.cognitiveSchedule);
      diagnosticsStore.setMaxEntries(next.diagnostics.keepRecentEntries);
      traceStore.configure(next.diagnostics.logLevel,next.diagnostics.keepRecentEntries);
      return next;
    },
    getChatTraceStore:()=>traceStore,
    listChatTraces:limit=>traceStore.recent(limit),
    clearChatTraces:()=>traceStore.clear(),
    setProviderPresetConfigurations:(configurations,activePresetId)=>{providerPresetConfigurations=new Map(configurations.map(item=>[item.presetId,item.configuration])); activeProviderPresetId=activePresetId??configurations[0]?.presetId;},
    setProviderPresetPools:(presets,activePresetId)=>{
      const next=new Map(presets.map(preset=>[preset.id,preset]));
      for(const id of providerPoolProviders.keys())if(!next.has(id))providerPoolProviders.delete(id);
      for(const preset of presets){
        providerPresetPools.set(preset.id,preset);
        providerPoolProviders.delete(preset.id);
      }
      providerPresetPools=next;
      activeProviderPresetId=activePresetId??presets[0]?.id??activeProviderPresetId;
    },
    listCharacters:()=>characterManager.listCharacters(),
    getCharacter:id=>characterManager.getCharacter(id),
    createCharacter:async input=>{
      const character=await characterManager.createCharacter(input);
      await conversationManager.getActiveConversation(character.id);
      return character;
    },
    updateCharacter:(id,input)=>characterManager.updateCharacter(id,input),
    deleteCharacter:async id=>{
      await characterManager.deleteCharacter(id);
      const active=await characterManager.getActiveCharacter();
      await conversationManager.getActiveConversation(active.id);
      mindRuntime.setActiveCharacter(active.id);
    },
    getActiveCharacter:()=>characterManager.getActiveCharacter(),
    setActiveCharacter:async id=>{
      const character=await characterManager.setActiveCharacter(id);
      await conversationManager.getActiveConversation(character.id);
      mindRuntime.setActiveCharacter(character.id);
      return character;
    },
    createConversation:(characterId,input)=>conversationManager.createConversation(characterId,input),
    listConversations:characterId=>conversationManager.listConversations(characterId),
    getConversation:(characterId,conversationId)=>conversationManager.getConversation(characterId,conversationId),
    updateConversation:(characterId,conversationId,input)=>conversationManager.updateConversation(characterId,conversationId,input),
    deleteConversation:(characterId,conversationId)=>conversationManager.deleteConversation(characterId,conversationId),
    setActiveConversation:(characterId,conversationId)=>conversationManager.setActiveConversation(characterId,conversationId),
    getActiveConversation:characterId=>conversationManager.getActiveConversation(characterId),
    clearConversation:(characterId,conversationId)=>conversationManager.clearConversation(characterId,conversationId),
    listCoreBookEntries:characterId=>coreBookManager.listCoreBookEntries(characterId),
    getCoreBookEntry:(characterId,entryId)=>coreBookManager.getCoreBookEntry(characterId,entryId),
    createCoreBookEntry:(characterId,input)=>coreBookManager.createCoreBookEntry(characterId,input),
    updateCoreBookEntry:(characterId,entryId,input)=>coreBookManager.updateCoreBookEntry(characterId,entryId,input),
    deleteCoreBookEntry:(characterId,entryId)=>coreBookManager.deleteCoreBookEntry(characterId,entryId),
    setCoreBookEntryEnabled:(characterId,entryId,enabled)=>coreBookManager.setCoreBookEntryEnabled(characterId,entryId,enabled),
    buildContext:request=>contextEngine.build(request),
    extractMemory:async request=>{const item=await automaticMemoryAgent.process(request);return item?[item]:[]},
    getMemory:(characterId,memoryOrConversationId,memoryId?)=>memoryId===undefined?memoryBroker.get(characterId,memoryOrConversationId):memoryBroker.get(characterId,memoryOrConversationId as MemoryItemId,memoryId as MemoryItemId),
    searchMemory:query=>memoryBroker.search(query),
    listMemory:characterId=>memoryBroker.list(characterId),
    createMemory:(characterId,input)=>memoryBroker.create(characterId,input,userMemoryAuthority),
    updateMemory:(characterId,memoryOrConversationId,idOrInput,input?)=>typeof idOrInput==="string" ? memoryBroker.update(characterId,idOrInput,input as MemoryUpdateInput,userMemoryAuthority) : memoryBroker.update(characterId,memoryOrConversationId,idOrInput as MemoryUpdateInput,userMemoryAuthority),
    supersedeMemory:(characterId,conversationId,memoryId,input)=>memoryBroker.supersede(characterId,conversationId,memoryId,input,userMemoryAuthority),
    archiveMemory:(characterId,memoryOrConversationId,memoryIdOrReason?,maybeReason?)=>typeof memoryIdOrReason==="string" ? memoryBroker.archive(characterId,memoryIdOrReason,userMemoryAuthority,maybeReason as MemoryArchiveReason|undefined) : memoryBroker.archive(characterId,memoryOrConversationId,userMemoryAuthority,memoryIdOrReason as MemoryArchiveReason|undefined),
    restoreMemory:(characterId,memoryId)=>memoryBroker.restore(characterId,memoryId,userMemoryAuthority),
    deleteMemory:(characterId,memoryId)=>memoryBroker.delete(characterId,memoryId,userMemoryAuthority),
    searchRetrieval:query=>{if(!options.retriever)throw new Error("Retrieval runtime is not configured.");const effective={...query,limit:query.limit??settingsManager.get().retrieval.candidateLimit};return options.retriever.search(effective);},
    rebuildRetrieval:characterId=>{if(!options.retriever)throw new Error("Retrieval runtime is not configured.");return options.retriever.rebuild(characterId);},
    rebuildAllRetrieval:()=>{if(!options.retriever)throw new Error("Retrieval runtime is not configured.");return options.retriever.rebuildAll();},
    testConfiguredProvider:async()=>{
      if(!providerConfiguration)return {apiVersion:"1",schemaVersion:"1",status:"configuration_error",providerId:"openai-compatible",message:"No provider configuration is saved."};
      return testProviderConfiguration(providerConfiguration,credentialStore,options.httpClient);
    }
  };
}
export async function startFoundationRuntime(options:FoundationRuntimeOptions={}){
  const runtime=await createFoundationRuntime(options);
  await runtime.start();
  return runtime;
}
export type {RuntimeDiagnostics,ActorIdentity};

export {activeProviderId,buildConfiguredProvider,buildProviderForDiscovery,testProviderConfiguration,testProviderPresetConfiguration,validateProviderConfiguration,listProviderModels} from "./provider-configuration";
