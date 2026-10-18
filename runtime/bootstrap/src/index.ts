import type {ActionInvocation,ActionTarget,ActionTargetResolver,ActorIdentity,RuntimeDiagnostics,ToolDefinition,ActionDriver,ActionTarget as Target,ChatRequest,ChatRequestOptions,ChatResponse,ChatReasoningOptions,CredentialStore,ProviderConfiguration,ProviderPreset,Character,CharacterId,CharacterStore,CoreBookEntry,CoreBookEntryId,CoreBookStore,ContextBuildRequest,AssembledContext,ContextEngine,MemoryBroker,MemoryCreateInput,MemoryArchiveReason,MemoryItem,MemoryItemId,MemoryMutationAuthority,MemorySearchQuery,MemoryStore,MemoryUpdateInput,MemorySemanticIndexStore,RetrievalIndexWriter,RetrievalQuery,RetrievalResult,Retriever,ChatProvider,MindToolExecutor,MemoryExtractionRequest} from "../../../contracts/src/index";
import {FOUNDATION_SCHEMA_VERSION} from "../../../contracts/src/index";
import type {HealthStatus,AppSettings,AppSettingsStore,ChatTraceStore,MindReactiveTurn,MindTurnExecutionContext,MindTurnSink,MindToolExecutionContext,NovaToolCall,NovaToolResult,PromptId} from "../../../contracts/src/index";
import type {Conversation,ConversationCreateInput,ConversationId,ConversationStore,ConversationUpdateInput} from "../../../contracts/src/index";
import {
  AiRuntime,CharacterManager,ConversationManager,CoreBookManager,InProcessMemoryRetriever,MemoryBrokerImpl,MemorySemanticDeduplicator,InMemoryCharacterStore,InMemoryDiagnosticsStore,InMemoryEventBus,InMemoryStateStore,ModuleManager,ProviderRegistry,createDeterministicContextEngine,MindRuntime,LLMCognitiveStep,AutomaticMemoryAgent,
  InMemoryPermissionService,InMemoryAuditService,InMemoryToolRegistry,DefaultActionBroker,
  DefaultConfirmationService,DefaultRiskPolicy,BrowserTargetResolver,ScopedCapabilityContext,
  InMemoryActorIdentityResolver,createMemoryConfig,SettingsManager,InMemoryChatTraceStore
} from "../../../core/src/index";
import {StandardContractValidator,resolvePromptText} from "../../../contracts/src/index";
import {FakeBrowserModule,FakeCharacterModule,FakeMemoryModule} from "../../../modules/mock/src/index";
import {FakeChatProvider,FakeSTTProvider,FakeEmbeddingProvider,FakeVisionProvider} from "../../../providers/mock/src/index";
import {TtsProviderRegistry} from "../../../providers/tts/registry/src";
import {VoiceStudioTtsProvider} from "../../../providers/tts/voice-studio/src";
import {SileroTtsProvider} from "../../../providers/tts/silero/src";
import type {SileroFetch} from "../../../providers/tts/silero/src";
import type {TtsProvider,TtsProviderDescriptor} from "../../../contracts/src/tts";
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
import {SemanticSearchService,type SemanticEmbeddingConfiguration,type SemanticSearchStatus} from "../../../core/src/semantic-search";


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
  /** Optional native local transport; omitted by tests and non-desktop runtimes. */
  sileroFetch?:SileroFetch;
  openAICompatible?:OpenAICompatibleRuntimeConfig;
  contextEngine?:ContextEngine;
  retriever?:Retriever;
  retrievalIndexWriter?:RetrievalIndexWriter;
  semanticIndexStore?:MemorySemanticIndexStore;
  semanticEmbeddingConfiguration?:()=>Promise<SemanticEmbeddingConfiguration|undefined>;
  embeddingHttpClient?:import("../../../providers/embeddings/openai-compatible/src").EmbeddingHttpClient;
  providerPresetConfigurations?:readonly {presetId:string;configuration:ProviderConfiguration}[];
  providerPresetPools?:readonly ProviderPreset[];
  onProviderPresetPoolStateChange?:(preset:ProviderPreset)=>void|Promise<void>;
  activeProviderPresetId?:string;
}

export interface FoundationRuntime{
  start():Promise<void>;
  setActiveModelProfile(profile:import("../../../contracts/src/index").ModelProfile|undefined):void;
  stop():Promise<void>;
  diagnostics(options?:{skipProviderHealthFor?:readonly string[]}):Promise<RuntimeDiagnostics>;
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
  setNovaTurnSink(sink:MindTurnSink|undefined):void;
  wakeMind():void;
  wakeMindForUserMessage(turn:MindReactiveTurn):boolean;
  subscribeMindState(listener:(state:import("../../../contracts/src/index").MindState)=>void):import("../../../contracts/src/index").Unsubscribe;
  getTtsProvider(providerId:string):TtsProvider|undefined;
  listTtsProviders():TtsProviderDescriptor[];
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
  /** Current background semantic-index state; only counts and model identity are returned. */
  getSemanticSearchStatus():SemanticSearchStatus;
  /** Retry the idempotent full indexing pass and stale-record cleanup. */
  rebuildSemanticSearchIndex():Promise<void>;
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
  const ttsProviders=new TtsProviderRegistry();
  // Concrete TTS adapters are registered only at the composition root.
  ttsProviders.register(()=>new VoiceStudioTtsProvider());
  ttsProviders.register(()=>new SileroTtsProvider({fetch:options.sileroFetch}));
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
  const initialPresets=options.providerPresetPools??[];
  for(const preset of initialPresets){
    if(preset.type!=="single"||!preset.providerId||!preset.baseUrl||!preset.model||preset.enabled===undefined||preset.enabled===null)continue;
    providerPresetConfigurations.set(preset.id,{
      apiVersion:"1",schemaVersion:"1",providerId:preset.providerId,baseUrl:preset.baseUrl,model:preset.model,
      enabled:preset.enabled,credentialReference:preset.credentialReference?{...preset.credentialReference}:null,
      ...(preset.timeoutMs==null?{}:{timeoutMs:preset.timeoutMs}),
      ...(preset.temperature==null?{}:{temperature:preset.temperature}),
      ...(preset.topP==null?{}:{topP:preset.topP}),
      ...(preset.numCtx==null?{}:{numCtx:preset.numCtx}),
      ...(preset.numPredict==null?{}:{numPredict:preset.numPredict}),
      ...(preset.keepAlive==null?{}:{keepAlive:preset.keepAlive})
    });
  }
  let providerPresetPools=new Map(initialPresets.filter(preset=>preset.type!=="single").map(preset=>[preset.id,preset]));
  let activeProviderPresetId=options.activeProviderPresetId??initialPresets[0]?.id??options.providerPresetConfigurations?.[0]?.presetId;
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
  const semanticSearch=new SemanticSearchService({
    settings:()=>settingsManager.get(),
    indexStore:semanticIndexStore,
    embeddingConfiguration:async()=>{
      if(options.semanticEmbeddingConfiguration)return options.semanticEmbeddingConfiguration();
      const settings=settingsManager.get().semanticDedup;
      if(!settings.embeddingProviderPresetId||!settings.embeddingModel.trim())return undefined;
      const configuration=providerPresetConfigurations.get(settings.embeddingProviderPresetId);
      if(!configuration)return undefined;
      const provider=buildEmbeddingProviderForPreset(configuration,settings.embeddingModel.trim(),credentialStore,options.embeddingHttpClient);
      return provider?{provider,model:settings.embeddingModel.trim()}:undefined;
    },
    listCharacterIds:async()=>(await characterManager.listCharacters()).map(character=>character.id),
    coreBook:{listCoreBookEntries:characterId=>coreBookManager.listCoreBookEntries(characterId)},
    memory:memoryBroker,
    conversations:{listConversations:characterId=>conversationManager.listConversations(characterId)},
    events,diagnostics:diagnosticsStore
  });
  const contextEngine=options.contextEngine??createDeterministicContextEngine(
    {listCoreBookEntries:characterId=>coreBookManager.listCoreBookEntries(characterId)},
    {memoryBroker,memoryRetriever,retriever:options.retriever,
      recentMessageCount:()=>settingsManager.get().context.recentConversationMessages,
      memoryCandidateLimit:()=>settingsManager.get().memory.candidateLimit,
      retrievalCandidateLimit:()=>settingsManager.get().retrieval.candidateLimit,
      semanticSearch,semanticSearchSettings:()=>settingsManager.get().retrieval,diagnostics:diagnosticsStore}
  );
  const retrievalIndexer=options.retrievalIndexWriter
    ? new RetrievalEventIndexer({events,coreBook:coreBookManager,memory:memoryBroker,writer:options.retrievalIndexWriter})
    : undefined;
  const permissions=new InMemoryPermissionService();
  const actorResolver=new InMemoryActorIdentityResolver();
  const tools=new InMemoryToolRegistry();
  const pendingWakeIntervalRequests=new Map<string,number>();
  const targetResolvers=new Map<string,ActionTargetResolver>();
  const browser=new FakeBrowserModule();
  const characterCredential={token:"foundation-character-opaque"};
  actorResolver.register(characterCredential,{
    actorId:"character",
    actorType:"module",
    moduleId:"character.fake",
    trusted:true,
    capabilities:["browser.navigate","browser.control","character.expression","memory.search","memory.create","scheduler.wake"]
  });

  providers.register(new FakeChatProvider(),["chat"]);
  const applyProvider=async(configuration:ProviderConfiguration|undefined)=>{
    providerConfiguration=configuration;
    providers.unregister("openai-compatible");
    providers.unregister("gemini");
    providers.unregister("ollama");
    const configured=configuration?buildConfiguredProvider(configuration,credentialStore,options.httpClient,diagnosticsStore,activeProviderPresetId):undefined;
    if(configured)providers.register(configured,["chat"]);
  };
  if(options.openAICompatible){
    providers.register(new OpenAICompatibleChatProvider(options.openAICompatible.config,options.openAICompatible.credentialStore,options.openAICompatible.httpClient),["chat"]);
  }else{
    await applyProvider(providerConfiguration);
  }
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
          ...(source.timeoutMs===undefined?{}:{timeoutMs:source.timeoutMs}),
          ...(source.temperature===undefined?{}:{temperature:source.temperature}),
          ...(source.topP===undefined?{}:{topP:source.topP}),
          ...(source.numCtx===undefined?{}:{numCtx:source.numCtx}),
          ...(source.numPredict===undefined?{}:{numPredict:source.numPredict}),
          ...(source.keepAlive===undefined?{}:{keepAlive:source.keepAlive})
        });
      }
      await options.onProviderPresetPoolStateChange?.(updated);
    }
  });
  const getPoolProvider=(providerPresetId:string):ProviderPoolChatProvider|undefined=>{
    const preset=providerPresetPools.get(providerPresetId);
    if(!preset||preset.type==="single")return undefined;
    const existing=providerPoolProviders.get(providerPresetId);
    if(existing)return existing;
    const created=createPoolProvider(preset);
    providerPoolProviders.set(providerPresetId,created);
    return created;
  };
  const aiRuntime=new AiRuntime(providers,{validator:contractValidator,diagnostics:diagnosticsStore,events,clock:()=>new Date().toISOString()});
  const extractionChatRuntime={
    getChatProviderCapabilities:(providerPresetId?:string):import("../../../contracts/src/index").ProviderCapabilities=>{
      if(providerPresetId){
        const pool=getPoolProvider(providerPresetId);
        if(pool)return pool.capabilities();
        const configuration=providerPresetConfigurations.get(providerPresetId);
        if(!configuration)return {};
        try{return buildProviderForPreset(configuration,credentialStore,options.httpClient,diagnosticsStore,providerPresetId)?.capabilities()??{};}catch{return {};}
      }
      return providers.get<ChatProvider>(activeProviderId(providerConfiguration))?.capabilities()??{};
    },
    stream:async(request:ChatRequest,handlers:import("../../../contracts/src/index").ChatStreamHandlers,chatOptions:ChatRequestOptions={},providerPresetId?:string):Promise<ChatResponse>=>{
      if(providerPresetId){
        const pool=getPoolProvider(providerPresetId);
        if(pool){
          const scopedProviders=new ProviderRegistry();scopedProviders.register(pool,["chat"]);
          const scopedRuntime=new AiRuntime(scopedProviders,{validator:contractValidator,diagnostics:diagnosticsStore,events,clock:()=>new Date().toISOString()});
          return scopedRuntime.stream({...request,providerId:pool.id},handlers,chatOptions);
        }
        const configuration=providerPresetConfigurations.get(providerPresetId);
        const effectiveConfiguration=configuration?{...configuration,model:request.model}:undefined;
        const scopedProviders=new ProviderRegistry();
        if(effectiveConfiguration){
          const configured=buildProviderForPreset(effectiveConfiguration,credentialStore,options.httpClient,diagnosticsStore,providerPresetId);
          if(configured)scopedProviders.register(configured,["chat"]);
        }
        const scopedRuntime=new AiRuntime(scopedProviders,{validator:contractValidator,diagnostics:diagnosticsStore,events,clock:()=>new Date().toISOString()});
        return scopedRuntime.stream({...request,providerId:effectiveConfiguration?.providerId??request.providerId},handlers,chatOptions);
      }
      return aiRuntime.stream(request.providerId?request:{...request,providerId:activeProviderId(providerConfiguration)},handlers,chatOptions);
    },
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
  const automaticMemoryAgent=new AutomaticMemoryAgent({
    settings:()=>settingsManager.get(),
    broker:memoryBroker,
    runtime:{
      chat:(request,providerPresetId)=>extractionChatRuntime.chat(request,providerPresetId),
      getChatModelForPreset,
      getChatProviderCapabilities:providerPresetId=>extractionChatRuntime.getChatProviderCapabilities(providerPresetId)
    },
    diagnostics:diagnosticsStore
  });

  let activeModelProfile:import("../../../contracts/src/index").ModelProfile|undefined;
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
      getActiveProviderPresetId:()=>activeModelProfile?.providerPresetId?.trim()||activeProviderPresetId,
      getChatModel:()=>activeModelProfile?.model?.trim()||(providerConfiguration?.enabled?providerConfiguration.model:"fake-chat"),
      getChatModelForPreset:async(providerPresetId)=>{
        if(activeModelProfile?.model?.trim()&&(!activeModelProfile.providerPresetId||activeModelProfile.providerPresetId===providerPresetId))return activeModelProfile.model.trim();
        return getChatModelForPreset(providerPresetId);
      },
      getCognitiveSchedule:()=>settingsManager.get().cognitiveSchedule,
      getPrompt:(id:PromptId)=>resolvePromptText(settingsManager.get().prompts,id),
      getAvailableTools:()=>tools.list().map(tool=>({name:tool.name,description:tool.description,parameters:tool.parameters})),
      executeTool:executeRegisteredTool,
      getReasoningOptions:()=>{
        const chat=settingsManager.get().chat;
        return {mode:chat.reasoningMode,...(chat.reasoningEffort!=="provider-default"?{effort:chat.reasoningEffort}:{})} as ChatReasoningOptions;
      },
      getGenerationOptions:()=>activeModelProfile?.generation,
      getShowReasoningInDiagnostics:()=>settingsManager.get().ui.showReasoningInDiagnostics,
      getProviderIdForPreset:providerPresetId=>{
        if(!providerPresetId)return providerConfiguration?.enabled?providerConfiguration.providerId:undefined;
        const configured=providerPresetConfigurations.get(providerPresetId);
        if(configured)return configured.providerId;
        const pool=getPoolProvider(providerPresetId);
        if(pool)return pool.getDiagnostics().providerId??pool.id;
        const preset=providerPresetPools.get(providerPresetId);
        return preset?.sources.find(source=>source.id===preset.activeSourceId)?.providerId??preset?.sources[0]?.providerId;
      },
      onDiagnostic:(code,message,metadata)=>diagnosticsStore.recordError("mind-runtime",code,message,metadata),
      consumeRequestedWakeInterval:turnId=>{const interval=pendingWakeIntervalRequests.get(turnId);pendingWakeIntervalRequests.delete(turnId);return interval;},
      clock:()=>new Date().toISOString()
    }),
    schedule:settingsManager.get().cognitiveSchedule,
    onDiagnostic:(code,detail,metadata)=>diagnosticsStore.recordError("mind-runtime",code,detail,metadata),
    onTurnCommitted:async(turn,context)=>{
      if(!context.userMessageId||!settingsManager.get().memoryAgent.enabled)return;
      try{
        const conversation=await conversationManager.getConversation(context.characterId,context.conversationId);
        if(!conversation){
          diagnosticsStore.recordError("automatic-memory-agent","LIFE_CONVERSATION_MISSING","Completed Nova Life conversation was not available for memory extraction.",{
            characterId:context.characterId,conversationId:context.conversationId,turnId:context.turnId
          });
          return;
        }
        const userIndex=conversation.messages.findIndex(message=>message.id===context.userMessageId&&message.role==="user");
        if(userIndex<0){
          diagnosticsStore.recordError("automatic-memory-agent","LIFE_USER_MESSAGE_MISSING","Completed Nova Life user message was not available for memory extraction.",{
            characterId:context.characterId,conversationId:context.conversationId,turnId:context.turnId
          });
          return;
        }
        const userMessage=conversation.messages[userIndex]!;
        const assistantMessage=conversation.messages.find(message=>message.id==="nova-turn:"+context.turnId&&message.role==="assistant")??{
          id:"nova-turn:"+context.turnId,role:"assistant" as const,content:turn.speech,metadata:{novaTurnVersion:turn.version}
        };
        const request:MemoryExtractionRequest={
          apiVersion:"1",schemaVersion:"1",
          characterId:context.characterId,conversationId:context.conversationId,turnId:context.turnId,
          model:context.model??"unknown",
          ...(context.providerId?{providerId:context.providerId}:{}),
          ...(context.providerPresetId?{providerPresetId:context.providerPresetId}:{}),
          userMessage,assistantMessage,
          contextMessages:conversation.messages.slice(Math.max(0,userIndex-12),userIndex).filter(message=>message.role==="user"||message.role==="assistant")
        };
        await automaticMemoryAgent.process(request);
      }catch(error){
        diagnosticsStore.recordError("automatic-memory-agent","LIFE_TURN_TRIGGER_FAILED","Automatic Memory Agent failed while evaluating a completed Nova Life turn.",{
          characterId:context.characterId,conversationId:context.conversationId,turnId:context.turnId,
          reason:error instanceof Error?error.message:"Unknown Automatic Memory Agent error"
        });
      }
    },
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

  const memoryResolver:ActionTargetResolver={
    id:"memory.search-query",
    async resolve(request){
      const query=request.arguments?.query;
      if(typeof query!=="string"||!query.trim())throw new Error("read_memory requires a non-empty search query.");
      return {kind:"resource",resource:query.trim()};
    }
  };
  targetResolvers.set(memoryResolver.id,memoryResolver);
  const readMemoryDefinition:ToolDefinition={
    id:"memory.search",
    version:"1.0.0",
    schemaVersion:FOUNDATION_SCHEMA_VERSION,
    name:"read_memory",
    description:"Search Nova's existing long-term memory for relevant stored facts.",
    risk:"low",
    requiredCapabilities:["memory.search"],
    resourceType:"resource",
    action:"memory.search",
    targetResolverId:memoryResolver.id,
    confirmation:"never",
    parameters:objectSchema({query:{type:"string",minLength:1,maxLength:500}},["query"])
  };
  const readMemoryDriver:ActionDriver={
    id:"memory-search-driver",
    async execute(request,target){
      if(target.kind!=="resource")throw new Error("read_memory requires a resource query target.");
      const characterId=request.metadata?.characterId;
      if(typeof characterId!=="string"||!characterId.trim())throw new Error("read_memory is missing its character scope.");
      const matches=await memoryBroker.search({characterId,query:target.resource,limit:8});
      return matches.map(item=>({
        id:item.id,type:item.type,content:item.content,tags:item.tags,
        importance:item.importance,confidence:item.confidence
      }));
    }
  };
  tools.register(readMemoryDefinition,readMemoryDriver);
  const semanticMemoryResolver:ActionTargetResolver={
    id:"memory.semantic-search-query",
    async resolve(request){
      const query=request.arguments?.query;
      if(typeof query!=="string"||!query.trim())throw new Error("MEMORY_SEARCH requires a non-empty natural-language query.");
      if(query.length>1000)throw new Error("MEMORY_SEARCH query exceeds 1000 characters.");
      return {kind:"resource",resource:query.trim()};
    }
  };
  targetResolvers.set(semanticMemoryResolver.id,semanticMemoryResolver);
  const semanticMemoryDefinition:ToolDefinition={
    id:"memory.semantic-search",version:"1.0.0",schemaVersion:FOUNDATION_SCHEMA_VERSION,name:"MEMORY_SEARCH",
    description:"Semantically search active Core Book entries, active Character Memory, and saved user/Nova messages from all conversations available to this character. Returns full-source provenance and bounded excerpts. Read-only.",
    risk:"low",requiredCapabilities:["memory.search"],resourceType:"resource",action:"memory.search",
    targetResolverId:semanticMemoryResolver.id,confirmation:"never",
    parameters:objectSchema({query:{type:"string",minLength:1,maxLength:1000}},["query"])
  };
  const semanticMemoryDriver:ActionDriver={
    id:"memory-semantic-search-driver",
    async execute(request,target){
      if(target.kind!=="resource")throw new Error("MEMORY_SEARCH requires a resource query target.");
      const characterId=request.metadata?.characterId;
      if(typeof characterId!=="string"||!characterId.trim())throw new Error("MEMORY_SEARCH is missing its character scope.");
      const settings=settingsManager.get().retrieval;
      const hits=await semanticSearch.search({characterId,query:target.resource,limit:Math.min(20,settings.semanticResultLimit),threshold:settings.semanticSimilarityThreshold});
      let remaining=3000;
      const results=hits.map((hit,index)=>{
        // Share the remaining output budget across the remaining ranked hits. Avoid starving
        // lower-ranked documents to a few characters just because earlier hits used 900 each.
        const remainingDocuments=hits.length-index;
        const fairShare=remainingDocuments>0?Math.floor(remaining/remainingDocuments):0;
        const budget=Math.max(0,Math.min(900,fairShare));
        const content=hit.content.slice(0,budget);
        remaining-=content.length;
        return {id:hit.sourceId,source:hit.source,characterId:hit.characterId,
          ...(hit.conversationId?{conversationId:hit.conversationId}:{}),title:hit.title,
          ...(hit.role?{role:hit.role}:{}),...(hit.type?{type:hit.type}:{}),...(hit.status?{status:hit.status}:{}),
          tags:hit.tags,cosineSimilarity:hit.similarity,content,contentTruncated:content.length<hit.content.length};
      }).filter(result=>result.content.length>0);
      return {query:target.resource,resultCount:results.length,results};
    }
  };
  tools.register(semanticMemoryDefinition,semanticMemoryDriver);
  permissions.add({
    id:"character-memory-search",
    schemaVersion:FOUNDATION_SCHEMA_VERSION,
    subject:"character",
    resourceType:"resource",
    action:"memory.search",
    effect:"allow"
  });
  const memorySaveResolver:ActionTargetResolver={
    id:"memory.save-candidate",
    async resolve(request){
      const content=request.arguments?.content;
      if(typeof content!=="string"||!content.trim())throw new Error("memory.save requires non-empty content.");
      const value={
        content:content.trim(),
        type:typeof request.arguments.type==="string"?request.arguments.type:"observation",
        tags:Array.isArray(request.arguments.tags)?request.arguments.tags:[],
        importance:typeof request.arguments.importance==="number"?request.arguments.importance:70,
        confidence:typeof request.arguments.confidence==="number"?request.arguments.confidence:80,
      };
      return {kind:"resource",resource:JSON.stringify(value)};
    }
  };
  targetResolvers.set(memorySaveResolver.id,memorySaveResolver);
  const memorySaveDefinition:ToolDefinition={
    id:"memory.save",version:"1.0.0",schemaVersion:FOUNDATION_SCHEMA_VERSION,name:"memory.save",
    description:"Save a concise, durable fact to the active character's existing long-term memory. Call only when the fact is likely to be useful later; do not save private reasoning or secrets.",
    risk:"low",requiredCapabilities:["memory.create"],resourceType:"resource",action:"memory.create",
    targetResolverId:memorySaveResolver.id,confirmation:"never",
    parameters:objectSchema({
      content:{type:"string",minLength:1,maxLength:2000},
      type:{type:"string",enum:["fact","preference","relationship","event","experience","goal","instruction","observation"]},
      tags:{type:"array",maxItems:12,items:{type:"string",minLength:1,maxLength:64}},
      importance:{type:"integer",minimum:0,maximum:100},
      confidence:{type:"integer",minimum:0,maximum:100}
    },["content"])
  };
  const memorySaveDriver:ActionDriver={
    id:"memory-save-driver",
    async execute(request,target){
      if(target.kind!=="resource")throw new Error("memory.save requires a resource target.");
      if(!settingsManager.get().chat.automaticLongTermMemory)throw new Error("Long-term memory saving is disabled in Settings.");
      const characterId=request.metadata?.characterId,conversationId=request.metadata?.conversationId,turnId=request.metadata?.turnId;
      if(typeof characterId!=="string"||!characterId.trim()||typeof conversationId!=="string"||!conversationId.trim()||typeof turnId!=="string"||!turnId.trim())throw new Error("memory.save is missing character or conversation scope.");
      let candidate:unknown;
      try{candidate=JSON.parse(target.resource);}catch{throw new Error("memory.save received invalid arguments.");}
      if(!candidate||typeof candidate!=="object"||Array.isArray(candidate))throw new Error("memory.save received invalid arguments.");
      const value=candidate as Record<string,unknown>,content=typeof value.content==="string"?value.content.trim():"";
      if(!content||content.length>2000)throw new Error("Memory content must contain 1 to 2000 characters.");
      if(/authorization\s*:\s*bearer\s+\S+|\bbearer\s+[A-Za-z0-9._-]{16,}\b|\bsk-[A-Za-z0-9_-]{16,}\b|api[_ -]?key\s*[:=]\s*\S+|password\s*[:=]\s*\S+|secret\s*[:=]\s*\S+/i.test(content))throw new Error("Memory save rejected content that appears to contain a secret.");
      const existing=await memoryBroker.list(characterId);
      const normalize=(text:string)=>text.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g," ").trim();
      const duplicate=existing.find(item=>item.status==="active"&&normalize(item.content)===normalize(content));
      if(duplicate){
        diagnosticsStore.recordError("native-memory-save","DUPLICATE_SKIPPED","Native memory save matched an existing active character memory.",{characterId,conversationId,turnId,memoryId:duplicate.id});
        return {saved:false,reason:"duplicate",memoryId:duplicate.id};
      }
      const types=["fact","preference","relationship","event","experience","goal","instruction","observation"];
      const tags=Array.isArray(value.tags)?value.tags.filter((tag):tag is string=>typeof tag==="string"&&tag.trim().length>0&&tag.length<=64).slice(0,12):[];
      const type=typeof value.type==="string"&&types.includes(value.type)?value.type as MemoryItem["type"]:"observation";
      const importance=typeof value.importance==="number"&&Number.isInteger(value.importance)?Math.max(0,Math.min(100,value.importance)):70;
      const confidence=typeof value.confidence==="number"&&Number.isInteger(value.confidence)?Math.max(0,Math.min(100,value.confidence)):80;
      const authority:MemoryMutationAuthority={actorId:"nova-native-memory-save",actorType:"system",trusted:true,capabilities:["memory.create","memory.write.auto"],moduleId:"nova-life"};
      const item=await memoryBroker.create(characterId,{
        originConversationId:conversationId,type,content,tags,importance,confidence,source:"tool",sourceReference:turnId,
        mutationPolicy:"auto",metadata:{origin:"native-tool-call",turnId}
      },authority);
      if(!settingsManager.get().semanticDedup.enabled){
        const judged=await semanticMemoryDeduplicator.deduplicateMemory(item.id,characterId,{forceJudge:true});
        if(judged.status==="failed"){
          diagnosticsStore.recordError("native-memory-save","MEMORY_JUDGE_FAILED","Memory was stored, but the existing Memory Judge failed.",{characterId,conversationId,turnId,memoryId:item.id});
          throw new Error("Memory was stored but deduplication review failed; do not assume the save completed cleanly.");
        }
      }
      diagnosticsStore.recordError("native-memory-save","MEMORY_SAVED","Native memory tool saved a fact through MemoryBroker.",{characterId,conversationId,turnId,memoryId:item.id});
      return {saved:true,memoryId:item.id,type:item.type};
    }
  };
  tools.register(memorySaveDefinition,memorySaveDriver);
  permissions.add({id:"character-memory-create",schemaVersion:FOUNDATION_SCHEMA_VERSION,subject:"character",resourceType:"resource",action:"memory.create",effect:"allow"});

  const schedulerResolver:ActionTargetResolver={
    id:"scheduler.next-wake-interval",
    async resolve(request){
      const interval=request.arguments?.intervalMs;
      if(typeof interval!=="number"||!Number.isSafeInteger(interval))throw new Error("scheduler.set_next_wake requires an integer intervalMs.");
      return {kind:"resource",resource:String(interval)};
    }
  };
  targetResolvers.set(schedulerResolver.id,schedulerResolver);
  const schedulerDefinition:ToolDefinition={
    id:"scheduler.set-next-wake",version:"1.0.0",schemaVersion:FOUNDATION_SCHEMA_VERSION,name:"scheduler.set_next_wake",
    description:"Request a different interval before the next autonomous wake. Optional; do not call on every turn. The runtime owns scheduling and enforces configured bounds.",
    risk:"low",requiredCapabilities:["scheduler.wake"],resourceType:"resource",action:"scheduler.request",
    targetResolverId:schedulerResolver.id,confirmation:"never",
    parameters:objectSchema({intervalMs:{type:"integer",minimum:1000,maximum:3600000}},["intervalMs"])
  };
  const schedulerDriver:ActionDriver={
    id:"scheduler-set-next-wake-driver",
    async execute(request,target){
      if(target.kind!=="resource")throw new Error("scheduler.set_next_wake requires a resource target.");
      const turnId=request.metadata?.turnId;
      if(typeof turnId!=="string"||!turnId.trim())throw new Error("Scheduler request is missing its turn scope.");
      const current=settingsManager.get().cognitiveSchedule;
      const intervalMs=Number(target.resource);
      if(!Number.isSafeInteger(intervalMs)||intervalMs<1000||intervalMs>3600000)throw new Error("Requested wake interval must be between 1000 and 3600000 ms.");
      if(current.mode==="fixed")return {accepted:false,reason:"The current schedule is fixed; the runtime will keep its configured default interval."};
      pendingWakeIntervalRequests.set(turnId,intervalMs);
      return {accepted:true,requestedIntervalMs:intervalMs,minIntervalMs:current.minIntervalMs,maxIntervalMs:current.maxIntervalMs,appliedBy:"MindRuntime"};
    }
  };
  tools.register(schedulerDefinition,schedulerDriver);
  permissions.add({id:"character-scheduler-wake",schemaVersion:FOUNDATION_SCHEMA_VERSION,subject:"character",resourceType:"resource",action:"scheduler.request",effect:"allow"});

  async function executeRegisteredTool(call:NovaToolCall,context:MindToolExecutionContext):Promise<NovaToolResult>{
    if(context.signal.aborted){const error=new Error("Tool execution was cancelled.");error.name="AbortError";throw error;}
    if(!tools.get(call.name))return {callId:context.callId,name:call.name,status:"unknown-tool",error:"Tool is not registered: "+call.name};
    const result=await broker.execute({
      request:{
        id:context.callId,schemaVersion:FOUNDATION_SCHEMA_VERSION,tool:call.name,arguments:call.arguments,
        metadata:{characterId:context.characterId,conversationId:context.conversationId,turnId:context.turnId,callId:context.callId}
      },
      credential:characterCredential
    });
    if(result.status==="success")return {callId:context.callId,name:call.name,status:"success",output:result.output};
    return {callId:context.callId,name:call.name,status:"error",error:result.error.message};
  }
  mindRuntime.setToolExecutor({execute:executeRegisteredTool});

  let runtimeStatus:RuntimeDiagnostics["runtimeStatus"]="starting";
  const snapshot=async(options:{skipProviderHealthFor?:readonly string[]}={}):Promise<RuntimeDiagnostics>=>{
    const moduleHealth=await moduleManager.health().catch(()=>({}));
    const modules=moduleManager.list().map(item=>({
      ...item,
      health:(moduleHealth as Record<string,HealthStatus|undefined>)[item.id]
    }));
    const providerDiagnostics=await providers.diagnostics({skipHealthFor:options.skipProviderHealthFor});
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
      semanticSearch.start();
      if(options.retriever){
        try{await options.retriever.rebuildAll();retrievalDegraded=false}
        catch(error){retrievalDegraded=true;diagnosticsStore.recordError("retrieval","REBUILD_FAILED",error instanceof Error?error.message:String(error))}
      }
      await moduleManager.initializeAll();
      await moduleManager.startAll();
      runtimeStatus="running";
    },
    async stop(){try{await mindRuntime.stop();semanticSearch.stop();semanticMemoryDeduplicator.stop();retrievalIndexer?.stop();await moduleManager.stopAll();}finally{runtimeStatus="stopped";}},
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
    setNovaTurnSink:sink=>mindRuntime.setNovaTurnSink(sink),
    wakeMind:()=>mindRuntime.wake("scheduled"),
    wakeMindForUserMessage:turn=>mindRuntime.wakeForUserMessage(turn),
    subscribeMindState:listener=>mindRuntime.subscribe(listener),
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
    setActiveModelProfile:profile=>{activeModelProfile=profile?{...profile,generation:{...profile.generation}}:undefined;},
    getTtsProvider:providerId=>ttsProviders.get(providerId),
    listTtsProviders:()=>ttsProviders.list(),
    getSemanticSearchStatus:()=>semanticSearch.getStatus(),
    rebuildSemanticSearchIndex:()=>semanticSearch.rebuildAll(),
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
      const nextConfigurations=new Map(providerPresetConfigurations);
      for(const preset of presets){
        if(preset.type==="single"&&preset.providerId&&preset.baseUrl&&preset.model&&preset.enabled!==undefined&&preset.enabled!==null){
          nextConfigurations.set(preset.id,{
            apiVersion:"1",schemaVersion:"1",providerId:preset.providerId,baseUrl:preset.baseUrl,model:preset.model,
            enabled:preset.enabled,credentialReference:preset.credentialReference?{...preset.credentialReference}:null,
            ...(preset.timeoutMs==null?{}:{timeoutMs:preset.timeoutMs}),
            ...(preset.temperature==null?{}:{temperature:preset.temperature}),
            ...(preset.topP==null?{}:{topP:preset.topP}),
            ...(preset.numCtx==null?{}:{numCtx:preset.numCtx}),
            ...(preset.numPredict==null?{}:{numPredict:preset.numPredict}),
            ...(preset.keepAlive==null?{}:{keepAlive:preset.keepAlive})
          });
        }else if(preset.type!=="single"){
          const source=preset.sources.find(item=>item.id===preset.activeSourceId)??preset.sources[0];
          if(source)nextConfigurations.set(preset.id,{
            apiVersion:"1",schemaVersion:"1",providerId:source.providerId,baseUrl:source.baseUrl,model:source.model,
            enabled:source.enabled&&source.model.trim().length>0,
            credentialReference:source.credentialReference?{...source.credentialReference}:null,
            ...(source.timeoutMs===undefined?{}:{timeoutMs:source.timeoutMs}),
            ...(source.temperature===undefined?{}:{temperature:source.temperature}),
            ...(source.topP===undefined?{}:{topP:source.topP}),
            ...(source.numCtx===undefined?{}:{numCtx:source.numCtx}),
            ...(source.numPredict===undefined?{}:{numPredict:source.numPredict}),
            ...(source.keepAlive===undefined?{}:{keepAlive:source.keepAlive})
          });
        }
      }
      const next=new Map(presets.filter(preset=>preset.type!=="single").map(preset=>[preset.id,preset]));
      for(const id of providerPoolProviders.keys())if(!next.has(id))providerPoolProviders.delete(id);
      for(const preset of next.values())providerPoolProviders.delete(preset.id);
      providerPresetPools=next;
      providerPresetConfigurations=nextConfigurations;
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
    extractMemory:async request=>{
      if(request.assistantMessage.metadata?.novaTurnLongMemoryCandidate===true){
        if(!settingsManager.get().chat.automaticLongTermMemory)return [];
        const candidate=request.assistantMessage.content.normalize("NFKC").trim();
        const signal=request.assistantMessage.metadata?.longMemoryAbortSignal as AbortSignal|undefined;
        const source="nova-life-longmemory";
        if(!candidate||signal?.aborted)return [];
        const containsSecret=/authorization\s*:\s*bearer\s+\S+|\bbearer\s+[A-Za-z0-9._-]{16,}\b|\bsk-[A-Za-z0-9_-]{16,}\b|api[_ -]?key\s*[:=]\s*\S+|password\s*[:=]\s*\S+|secret\s*[:=]\s*\S+/i.test(candidate);
        if(containsSecret){
          diagnosticsStore.recordError(source,"SECRET_REJECTED","LONGMEMORY candidate was rejected because it contained sensitive material.",{characterId:request.characterId,conversationId:request.conversationId,turnId:request.turnId});
          return [];
        }
        if(candidate.length>32768){
          diagnosticsStore.recordError(source,"CANDIDATE_TOO_LARGE","LONGMEMORY candidate exceeded the existing memory content limit.",{characterId:request.characterId,conversationId:request.conversationId,turnId:request.turnId});
          return [];
        }
        try{
          const existing=await memoryBroker.list(request.characterId);
          if(signal?.aborted)return [];
          const normalized=candidate.toLocaleLowerCase().replace(/\s+/g," ").trim();
          const duplicate=existing.find(item=>item.status==="active"&&item.content.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g," ").trim()===normalized);
          if(duplicate){
            diagnosticsStore.recordError(source,"DUPLICATE_SKIPPED","LONGMEMORY candidate matched existing active character memory.",{characterId:request.characterId,conversationId:request.conversationId,turnId:request.turnId,memoryId:duplicate.id});
            return [];
          }
          if(signal?.aborted)return [];
          const authority:MemoryMutationAuthority={actorId:"nova-life-longmemory",actorType:"system",trusted:true,capabilities:["memory.create","memory.write.auto"],moduleId:"nova-life"};
          const item=await memoryBroker.create(request.characterId,{
            originConversationId:request.conversationId,
            type:"observation",
            content:candidate,
            tags:[],
            importance:70,
            confidence:80,
            source:"conversation",
            sourceReference:request.turnId,
            mutationPolicy:"auto",
            metadata:{origin:"nova-life-longmemory",turnId:request.turnId}
          },authority);
          // Keep the existing Judge active for deterministic lexical candidates even when the optional
          // embedding/semantic-index feature is disabled. The MemoryCreated subscriber handles enabled mode.
          if(!settingsManager.get().semanticDedup.enabled){
            const judgeResult=await semanticMemoryDeduplicator.deduplicateMemory(item.id,request.characterId,{forceJudge:true});
            if(judgeResult.status==="failed"){
              diagnosticsStore.recordError(source,"MEMORY_JUDGE_FAILED","LONGMEMORY was stored but the existing Memory Judge failed.",{characterId:request.characterId,conversationId:request.conversationId,turnId:request.turnId,memoryId:item.id});
            }
          }
          diagnosticsStore.recordError(source,"CANDIDATE_CREATED","LONGMEMORY candidate was passed to the existing MemoryBroker.",{characterId:request.characterId,conversationId:request.conversationId,turnId:request.turnId,memoryId:item.id});
          // MemoryBroker publishes MemoryCreated; the existing Memory Judge/dedup subscriber owns review.
          return [item];
        }catch(error){
          diagnosticsStore.recordError(source,"PERSIST_FAILED","LONGMEMORY candidate could not be stored.",{characterId:request.characterId,conversationId:request.conversationId,turnId:request.turnId,reason:error instanceof Error?error.message:"Unknown memory persistence error"});
          return [];
        }
      }
      // Native NovaTurn responses do not carry the historical LONGMEMORY field. The dedicated
      // agent evaluates the real user/assistant exchange and only persists a durable fact when useful.
      if(!settingsManager.get().memoryAgent.enabled)return [];
      const memory=await automaticMemoryAgent.process(request);
      return memory?[memory]:[];
    },
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
