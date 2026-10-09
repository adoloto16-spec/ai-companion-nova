import {
  SettingsManager,InMemoryDiagnosticsStore,InMemoryChatTraceStore
} from "../../core/src";
import {StandardContractValidator,DEFAULT_APP_SETTINGS,defaultAppSettings,migrateAppSettings,validateAppSettings} from "../../contracts/src";
import {IpcSettingsStore,InMemorySettingsStore} from "../../host/settings/src";

function equal(actual:unknown,expected:unknown,label:string){if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(label+" expected "+String(expected)+" got "+String(actual))}
function ok(value:unknown,label:string){if(!value)throw new Error(label)}

async function main(){
  const validator=new StandardContractValidator();
  let persistedIpc:unknown;
  const ipcStore=new IpcSettingsStore(async(command,args)=>{
    if(command==="get_app_settings")return persistedIpc??null;
    if(command==="save_app_settings"){persistedIpc=(args as {settings:unknown}).settings;return null;}
    throw new Error("unexpected settings command: "+command);
  },validator);
  const store=new InMemorySettingsStore(validator);
  const manager=new SettingsManager(store,validator);
  const defaults=await manager.initialize();
  equal(defaults,defaultAppSettings(),"missing settings resolve to deterministic defaults");
  equal(DEFAULT_APP_SETTINGS.context.availableContextTokens,4096,"default context size");
  equal(defaults.cognitiveSchedule,{mode:"adaptive",defaultIntervalMs:30000,minIntervalMs:10000,maxIntervalMs:900000,maxRequestsPerHour:120},"cognitive schedule defaults");
  const isolatedDefaults=defaultAppSettings();isolatedDefaults.cognitiveSchedule.defaultIntervalMs=45000;isolatedDefaults.proactiveChat.minMessageIntervalMs=300000;
  equal(defaultAppSettings().cognitiveSchedule.defaultIntervalMs,30000,"nested cognitive settings are deep-copied");
  equal(defaults.proactiveChat,{enabled:true,minMessageIntervalMs:120000,maxMessagesPerHour:6},"proactive chat defaults are safe and enabled");
  equal(defaultAppSettings().proactiveChat.minMessageIntervalMs,120000,"nested proactive chat defaults are deep-copied");
  ok(defaults.semanticDedup.judge.prompt.includes("In structured mode, return only:"),"default Judge prompt declares structured output");
  ok(defaults.semanticDedup.judge.prompt.includes("In plain mode, return only:"),"default Judge prompt declares plain output");
  equal(defaults.semanticDedup.judge.defaultPromptVersion,"2","default Judge prompt version");
  const custom={
    ...defaults,
    context:{...defaults.context,availableContextTokens:8192,reservedOutputTokens:2048,safetyMarginTokens:256,recentConversationMessages:4},
    memory:{...defaults.memory,candidateLimit:3},
    retrieval:{...defaults.retrieval,candidateLimit:7},
    diagnostics:{...defaults.diagnostics,logLevel:"verbose" as const,keepRecentEntries:25},
    chat:{...defaults.chat,automaticLongTermMemory:false},
    cognitiveSchedule:{mode:"fixed" as const,defaultIntervalMs:60000,minIntervalMs:10000,maxIntervalMs:300000,maxRequestsPerHour:60},
    proactiveChat:{enabled:false,minMessageIntervalMs:180000,maxMessagesPerHour:3},
    memoryAgent:{...defaults.memoryAgent,enabled:true,providerPresetId:"preset.memory",model:"memory-model",outputMode:"structured" as const,prompt:"Custom full prompt",promptBackup:"Previous prompt",defaultPromptVersion:"1"},
    semanticDedup:{
      ...defaults.semanticDedup,
      enabled:true,
      embeddingProviderPresetId:"preset.embedding",
      embeddingModel:"mistral-embed",
      candidateSimilarityThreshold:0.91,
      candidateLimit:7,
      judge:{...defaults.semanticDedup.judge,enabled:true,providerPresetId:"preset.judge",model:"judge-model",outputMode:"plain" as const,prompt:"Judge custom",promptBackup:"Judge previous",defaultPromptVersion:"2"}
    }
  };
  const errors=validateAppSettings(custom);
  equal(errors,[],"valid custom settings pass semantic validation");
  await manager.set(custom);
  await ipcStore.save(custom);
  const persistedIpcSettings=await ipcStore.load();
  equal(persistedIpcSettings?.semanticDedup.enabled,true,"IpcSettingsStore save/load preserves Semantic Dedup enabled");
  equal(persistedIpcSettings?.semanticDedup.judge.enabled,true,"IpcSettingsStore save/load preserves Judge enabled");
  equal(persistedIpcSettings?.semanticDedup.judge.providerPresetId,"preset.judge","IpcSettingsStore save/load preserves Judge preset");
  equal(persistedIpcSettings?.semanticDedup.judge.model,"judge-model","IpcSettingsStore save/load preserves Judge model");
  equal(persistedIpcSettings?.semanticDedup.judge.outputMode,"plain","IpcSettingsStore save/load preserves Judge output mode");
  equal((await manager.get()).context.availableContextTokens,8192,"custom context size persists in store");
  equal((await manager.get()).cognitiveSchedule.mode,"fixed","cognitive schedule mode persists");
  equal((await manager.get()).cognitiveSchedule.defaultIntervalMs,60000,"cognitive default interval persists");
  equal((await manager.get()).proactiveChat,{enabled:false,minMessageIntervalMs:180000,maxMessagesPerHour:3},"proactive chat settings persist through SettingsManager");
  equal(persistedIpcSettings?.proactiveChat,{enabled:false,minMessageIntervalMs:180000,maxMessagesPerHour:3},"IPC settings store saves proactive settings");
  equal(persistedIpcSettings?.cognitiveSchedule.maxRequestsPerHour,60,"IpcSettingsStore persists the cognitive hourly quota");
  equal((await manager.get()).memory.candidateLimit,3,"custom memory candidate limit persists");
  equal((await manager.get()).chat.automaticLongTermMemory,false,"custom extraction toggle persists");
  equal((await manager.get()).memoryAgent.providerPresetId,"preset.memory","agent provider preset persists");
  equal((await manager.get()).memoryAgent.model,"memory-model","agent model persists");
  equal((await manager.get()).memoryAgent.outputMode,"structured","agent output mode persists");
  equal((await manager.get()).memoryAgent.prompt,"Custom full prompt","full agent prompt persists");
  equal((await manager.get()).memoryAgent.promptBackup,"Previous prompt","agent prompt backup persists");
  equal((await manager.get()).semanticDedup.candidateSimilarityThreshold,0.91,"semantic candidate threshold persists");
  equal((await manager.get()).semanticDedup.candidateLimit,7,"semantic candidate limit persists");
  equal((await manager.get()).semanticDedup.embeddingModel,"mistral-embed","semantic embedding model persists");
  equal((await manager.get()).semanticDedup.judge.outputMode,"plain","Memory Judge output mode persists");
  equal((await manager.get()).semanticDedup.judge.prompt,"Judge custom","Memory Judge prompt persists");
  equal((await manager.get()).semanticDedup.judge.promptBackup,"Judge previous","Memory Judge prompt backup persists");
  // Schema v5 had no cognitiveSchedule; migration keeps its existing fields and supplies the v6 defaults.
  const v5=JSON.parse(JSON.stringify(defaultAppSettings())) as Record<string,unknown>;
  delete v5.cognitiveSchedule;delete v5.proactiveChat;v5.schemaVersion="5";
  v5.memoryAgent={...defaultAppSettings().memoryAgent,enabled:false,providerPresetId:"preset.memory",model:"ministral-3b-2512",outputMode:"plain",prompt:"custom prompt",promptBackup:"previous prompt",defaultPromptVersion:"7"};
  const migratedV5=migrateAppSettings(v5);
  equal(migratedV5.cognitiveSchedule,DEFAULT_APP_SETTINGS.cognitiveSchedule,"schema v5 migration inserts cognitive defaults");
  equal(migratedV5.proactiveChat,DEFAULT_APP_SETTINGS.proactiveChat,"schema v5 migration inserts proactive defaults");
  equal(migratedV5.memoryAgent.providerPresetId,"preset.memory","schema v5 migration preserves provider preset");
  equal(migratedV5.memoryAgent.model,"ministral-3b-2512","schema v5 migration preserves model");
  equal(migratedV5.memoryAgent.enabled,false,"schema v5 migration preserves enabled");
  equal(migratedV5.memoryAgent.outputMode,"plain","schema v5 migration preserves output mode");
  equal(migratedV5.memoryAgent.prompt,"custom prompt","schema v5 migration preserves prompt");
  equal(migratedV5.memoryAgent.promptBackup,"previous prompt","schema v5 migration preserves prompt backup");
  equal(migratedV5.memoryAgent.defaultPromptVersion,"7","schema v5 migration preserves prompt version");
  const v6=JSON.parse(JSON.stringify(defaultAppSettings())) as Record<string,unknown>;
  delete v6.proactiveChat;v6.schemaVersion="6";
  v6.memoryAgent={...defaultAppSettings().memoryAgent,enabled:false,providerPresetId:"preset.legacy",model:"legacy-model",outputMode:"plain",prompt:"old prompt",promptBackup:"backup",defaultPromptVersion:"9"};
  const migratedV6=migrateAppSettings(v6);
  equal(migratedV6.proactiveChat,DEFAULT_APP_SETTINGS.proactiveChat,"schema v6 migration inserts proactive defaults");
  equal(migratedV6.memoryAgent.providerPresetId,"preset.legacy","schema v6 to v7 migration preserves Memory Agent binding");
  equal(migratedV6.memoryAgent.prompt,"old prompt","schema v6 to v7 migration preserves Memory Agent prompt");
  const currentSettings={...defaultAppSettings(),memoryAgent:{...defaultAppSettings().memoryAgent,enabled:false,providerPresetId:"preset.memory",model:"ministral-3b-2512",outputMode:"plain" as const,prompt:"custom prompt",promptBackup:"previous prompt",defaultPromptVersion:"7"}};
  await manager.set(currentSettings);
  const reloadedManager=new SettingsManager(store,validator);
  const reloaded=await reloadedManager.initialize();
  equal(reloaded.memoryAgent.providerPresetId,"preset.memory","SettingsManager reload preserves provider preset");
  equal(reloaded.memoryAgent.model,"ministral-3b-2512","SettingsManager reload preserves model");
  equal(reloaded.cognitiveSchedule.mode,"adaptive","SettingsManager reload preserves default schedule");
  equal(reloaded.proactiveChat,DEFAULT_APP_SETTINGS.proactiveChat,"SettingsManager reload preserves proactive settings and defaults");
  const reset=await manager.reset();
  equal(reset,defaultAppSettings(),"reset restores defaults");
  let rejected=false;
  try{await manager.set({...defaultAppSettings(),context:{...defaultAppSettings().context,availableContextTokens:999999}} as any)}catch{rejected=true}
  ok(rejected,"unsafe values are rejected");
  const invalidSchedule={...defaultAppSettings(),cognitiveSchedule:{...defaultAppSettings().cognitiveSchedule,minIntervalMs:120000,maxIntervalMs:60000}};
  ok(validateAppSettings(invalidSchedule).some(error=>error.includes("minimum interval")),"inconsistent cognitive interval bounds are rejected");
  const invalidProactiveInterval={...defaultAppSettings(),proactiveChat:{...defaultAppSettings().proactiveChat,minMessageIntervalMs:999}};
  ok(validateAppSettings(invalidProactiveInterval).some(error=>error.includes("minimum message interval")),"unsafe proactive interval is rejected");
  const invalidProactiveHourly={...defaultAppSettings(),proactiveChat:{...defaultAppSettings().proactiveChat,maxMessagesPerHour:1000}};
  ok(validateAppSettings(invalidProactiveHourly).some(error=>error.includes("messages per hour")),"unsafe proactive hourly limit is rejected");
  const legacy=migrateAppSettings({schemaVersion:"0",contextBudget:8192,recentMessages:12,memoryCandidateLimit:5,diagnosticsLevel:"debug"});
  equal(legacy.context.availableContextTokens,8192,"legacy context budget migrates");
  equal(legacy.context.recentConversationMessages,12,"legacy recent message count migrates");
  equal(legacy.memory.candidateLimit,5,"legacy memory limit migrates");
  equal(legacy.diagnostics.logLevel,"debug","legacy diagnostics level migrates");
  const diagnostics=new InMemoryDiagnosticsStore(2);
  diagnostics.recordError("test","ONE","apiKey: secret-value");
  diagnostics.recordError("test","TWO","Authorization: Bearer abcdefghijklmnop");
  diagnostics.recordError("test","THREE","ordinary");
  equal(diagnostics.recentErrors().length,2,"diagnostics store obeys retention");
  ok(!JSON.stringify(diagnostics.recentErrors()).includes("secret-value"),"diagnostic secrets are redacted");
  const traces=new InMemoryChatTraceStore();
  traces.configure("normal",10);
  traces.start({turnId:"turn-1",requestId:"turn-1",characterId:"character.a",conversationId:"conversation.a",timestamp:"2026-10-01T00:00:00.000Z"});
  traces.update("turn-1",{status:"completed",contextBuild:{budget:{...defaultAppSettings().context,systemOverheadTokens:0},estimatedTokens:12,includedCandidates:[],omittedCandidates:[]},finalRequest:{apiVersion:"1",schemaVersion:"1",requestId:"turn-1",model:"fake",context:{conversationId:"conversation.a",messages:[{role:"user",content:"apiKey: super-secret"}]}}});
  const trace=traces.recent()[0]!;
  equal(trace.status,"completed","trace stores terminal state");
  ok(!JSON.stringify(trace).includes("super-secret"),"trace redacts sensitive message strings");
  console.log("PASS Settings and diagnostics unit tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1});
