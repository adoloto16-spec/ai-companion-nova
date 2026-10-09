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
  equal(defaults.chat.responseMode,"structured","Chat response mode defaults to structured protocol");
  equal(DEFAULT_APP_SETTINGS.context.availableContextTokens,4096,"default context size");
  equal(defaults.cognitiveSchedule,{mode:"adaptive",defaultIntervalMs:30000,minIntervalMs:3000,maxIntervalMs:300000,maxRequestsPerHour:null},"NovaTurn schedule defaults have 3000/300000 ms bounds and no quota");
  const isolatedDefaults=defaultAppSettings();isolatedDefaults.cognitiveSchedule.defaultIntervalMs=45000;
  equal(defaultAppSettings().cognitiveSchedule.defaultIntervalMs,30000,"nested cognitive settings are deep-copied");
  ok(defaults.semanticDedup.judge.prompt.includes("In structured mode, return only:"),"default Judge prompt declares structured output");
  ok(defaults.semanticDedup.judge.prompt.includes("In plain mode, return only:"),"default Judge prompt declares plain output");
  equal(defaults.semanticDedup.judge.defaultPromptVersion,"2","default Judge prompt version");
  const custom={
    ...defaults,
    context:{...defaults.context,availableContextTokens:8192,reservedOutputTokens:2048,safetyMarginTokens:256,recentConversationMessages:4},
    memory:{...defaults.memory,candidateLimit:3},
    retrieval:{...defaults.retrieval,candidateLimit:7},
    diagnostics:{...defaults.diagnostics,logLevel:"verbose" as const,keepRecentEntries:25},
    chat:{...defaults.chat,automaticLongTermMemory:false,responseMode:"plain" as const},
    cognitiveSchedule:{mode:"fixed" as const,defaultIntervalMs:60000,minIntervalMs:10000,maxIntervalMs:300000,maxRequestsPerHour:60},
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
  equal(persistedIpcSettings?.cognitiveSchedule.maxRequestsPerHour,60,"IpcSettingsStore persists the cognitive hourly quota");
  equal((await manager.get()).memory.candidateLimit,3,"custom memory candidate limit persists");
  equal((await manager.get()).chat.automaticLongTermMemory,false,"custom extraction toggle persists");
  equal((await manager.get()).chat.responseMode,"plain","Chat response mode persists");
  equal(persistedIpcSettings?.chat.responseMode,"plain","IPC settings store persists Chat response mode");
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
  delete v5.cognitiveSchedule;v5.schemaVersion="5";
  v5.memoryAgent={...defaultAppSettings().memoryAgent,enabled:false,providerPresetId:"preset.memory",model:"ministral-3b-2512",outputMode:"plain",prompt:"custom prompt",promptBackup:"previous prompt",defaultPromptVersion:"7"};
  const migratedV5=migrateAppSettings(v5);
  equal(migratedV5.cognitiveSchedule,DEFAULT_APP_SETTINGS.cognitiveSchedule,"schema v5 migration inserts cognitive defaults");
  equal(migratedV5.memoryAgent.providerPresetId,"preset.memory","schema v5 migration preserves provider preset");
  equal(migratedV5.memoryAgent.model,"ministral-3b-2512","schema v5 migration preserves model");
  equal(migratedV5.memoryAgent.enabled,false,"schema v5 migration preserves enabled");
  equal(migratedV5.memoryAgent.outputMode,"plain","schema v5 migration preserves output mode");
  equal(migratedV5.memoryAgent.prompt,"custom prompt","schema v5 migration preserves prompt");
  equal(migratedV5.memoryAgent.promptBackup,"previous prompt","schema v5 migration preserves prompt backup");
  equal(migratedV5.memoryAgent.defaultPromptVersion,"7","schema v5 migration preserves prompt version");
  const oldDefaultV8=JSON.parse(JSON.stringify(defaultAppSettings())) as Record<string,any>;
  oldDefaultV8.schemaVersion="8";
  oldDefaultV8.cognitiveSchedule={...defaultAppSettings().cognitiveSchedule,minIntervalMs:10000,maxIntervalMs:900000,maxRequestsPerHour:120};
  const migratedOldDefaults=migrateAppSettings(oldDefaultV8);
  equal(migratedOldDefaults.cognitiveSchedule.minIntervalMs,3000,"legacy built-in minimum interval migrates to 3000 ms");
  equal(migratedOldDefaults.cognitiveSchedule.maxIntervalMs,300000,"legacy built-in maximum interval migrates to 300000 ms");
  equal(migratedOldDefaults.cognitiveSchedule.maxRequestsPerHour,null,"legacy built-in hourly quota is disabled");
  // Pre-v9 default quota is migrated to an explicitly disabled quota; customized quotas survive.
  const v8=JSON.parse(JSON.stringify(defaultAppSettings())) as Record<string,any>;
  v8.schemaVersion="8";
  v8.cognitiveSchedule={...defaultAppSettings().cognitiveSchedule,maxRequestsPerHour:120,minIntervalMs:12000,maxIntervalMs:500000};
  const migratedV8=migrateAppSettings(v8);
  equal(migratedV8.cognitiveSchedule.maxRequestsPerHour,null,"legacy built-in hourly quota migrates to disabled");
  equal(migratedV8.cognitiveSchedule.minIntervalMs,12000,"custom minimum interval survives migration");
  equal(migratedV8.cognitiveSchedule.maxIntervalMs,500000,"custom maximum interval survives migration");
  v8.cognitiveSchedule={...v8.cognitiveSchedule,maxRequestsPerHour:42};
  const migratedV8Custom=migrateAppSettings(v8);
  equal(migratedV8Custom.cognitiveSchedule.maxRequestsPerHour,42,"custom hourly quota survives migration");
  const v9={...v8,schemaVersion:"9",chat:{automaticLongTermMemory:false},cognitiveSchedule:{...v8.cognitiveSchedule,maxRequestsPerHour:120}};
  const migratedV9=migrateAppSettings(v9);
  equal(migratedV9.chat.automaticLongTermMemory,false,"schema v9 migration preserves automatic long-term memory");
  equal(migratedV9.chat.responseMode,"structured","legacy Chat settings migrate to structured output mode");
  equal(migratedV9.cognitiveSchedule.maxRequestsPerHour,null,"schema v9 default quota migrates to disabled");
  const v10={...v9,schemaVersion:"10",chat:{automaticLongTermMemory:false,responseMode:"plain"}};
  equal(migrateAppSettings(v10).chat.responseMode,"plain","schema v10 persists the selected Chat response mode");
  equal(migrateAppSettings(v10).cognitiveSchedule.maxRequestsPerHour,120,"explicit quota in the new schema is preserved");
  const v6=JSON.parse(JSON.stringify(defaultAppSettings())) as Record<string,unknown>;
  v6.schemaVersion="6";
  v6.memoryAgent={...defaultAppSettings().memoryAgent,enabled:false,providerPresetId:"preset.legacy",model:"legacy-model",outputMode:"plain",prompt:"old prompt",promptBackup:"backup",defaultPromptVersion:"9"};
  const migratedV6=migrateAppSettings(v6);
  equal(migratedV6.memoryAgent.providerPresetId,"preset.legacy","schema v6 to v7 migration preserves Memory Agent binding");
  equal(migratedV6.memoryAgent.prompt,"old prompt","schema v6 to v7 migration preserves Memory Agent prompt");
  const currentSettings={...defaultAppSettings(),chat:{...defaultAppSettings().chat,automaticLongTermMemory:false,responseMode:"plain" as const},memoryAgent:{...defaultAppSettings().memoryAgent,enabled:false,providerPresetId:"preset.memory",model:"ministral-3b-2512",outputMode:"plain" as const,prompt:"custom prompt",promptBackup:"previous prompt",defaultPromptVersion:"7"}};
  await manager.set(currentSettings);
  const reloadedManager=new SettingsManager(store,validator);
  const reloaded=await reloadedManager.initialize();
  equal(reloaded.memoryAgent.providerPresetId,"preset.memory","SettingsManager reload preserves provider preset");
  equal(reloaded.memoryAgent.model,"ministral-3b-2512","SettingsManager reload preserves model");
  equal(reloaded.cognitiveSchedule.mode,"adaptive","SettingsManager reload preserves default schedule");
  equal(reloaded.chat.responseMode,"plain","SettingsManager reload preserves Chat response mode");
  equal(reloaded.chat.automaticLongTermMemory,false,"SettingsManager reload preserves automatic long-term memory");
  const reset=await manager.reset();
  equal(reset,defaultAppSettings(),"reset restores defaults");
  let rejected=false;
  try{await manager.set({...defaultAppSettings(),context:{...defaultAppSettings().context,availableContextTokens:999999}} as any)}catch{rejected=true}
  ok(rejected,"unsafe values are rejected");
  const invalidSchedule={...defaultAppSettings(),cognitiveSchedule:{...defaultAppSettings().cognitiveSchedule,minIntervalMs:120000,maxIntervalMs:60000}};
  ok(validateAppSettings(invalidSchedule).some(error=>error.includes("minimum interval")),"inconsistent cognitive interval bounds are rejected");
  const invalidHourly={...defaultAppSettings(),cognitiveSchedule:{...defaultAppSettings().cognitiveSchedule,maxRequestsPerHour:4000}};
  ok(validateAppSettings(invalidHourly).some(error=>error.includes("Cognitive requests per hour")),"unsafe configured quota is rejected");
  const disabledHourly={...defaultAppSettings(),cognitiveSchedule:{...defaultAppSettings().cognitiveSchedule,maxRequestsPerHour:null}};
  equal(validateAppSettings(disabledHourly),[],"null quota disables hourly throttling");
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
