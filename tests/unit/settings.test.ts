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
    ui:{...defaults.ui,showReasoningInDiagnostics:true},
    chat:{...defaults.chat,automaticLongTermMemory:false,responseMode:"plain" as const,reasoningMode:"enabled" as const},
    memoryAgent:{...defaults.memoryAgent,enabled:false},
    memoryAgent:{...defaults.memoryAgent,enabled:false},
    cognitiveSchedule:{mode:"fixed" as const,defaultIntervalMs:60000,minIntervalMs:10000,maxIntervalMs:300000,maxRequestsPerHour:60},
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
  equal((await manager.get()).chat.reasoningMode,"enabled","provider reasoning setting persists");
  equal((await manager.get()).chat.reasoningEffort,"low","low reasoning effort setting persists");
  equal((await manager.get()).memoryAgent.prompt,DEFAULT_APP_SETTINGS.memoryAgent.prompt,"Memory Agent default prompt is stored in settings");
  equal((await manager.get()).ui.showReasoningInDiagnostics,true,"reasoning diagnostics preference persists");
  equal(persistedIpcSettings?.chat.responseMode,"plain","IPC settings store persists Chat response mode");
  equal((await manager.get()).semanticDedup.candidateSimilarityThreshold,0.91,"semantic candidate threshold persists");
  equal((await manager.get()).semanticDedup.candidateLimit,7,"semantic candidate limit persists");
  equal((await manager.get()).semanticDedup.embeddingModel,"mistral-embed","semantic embedding model persists");
  equal((await manager.get()).semanticDedup.judge.outputMode,"plain","Memory Judge output mode persists");
  equal((await manager.get()).semanticDedup.judge.prompt,"Judge custom","Memory Judge prompt persists");
  equal((await manager.get()).semanticDedup.judge.promptBackup,"Judge previous","Memory Judge prompt backup persists");
  // Schema v5 had no cognitiveSchedule; migration keeps its existing fields and supplies the v6 defaults.
  const v5=JSON.parse(JSON.stringify(defaultAppSettings())) as Record<string,unknown>;
  delete v5.cognitiveSchedule;v5.schemaVersion="5";
  v5.memoryAgent={enabled:false,providerPresetId:"preset.memory",model:"ministral-3b-2512",outputMode:"plain",prompt:"custom prompt",promptBackup:"previous prompt",defaultPromptVersion:"7"};
  v5.chat={automaticLongTermMemory:false,responseMode:"structured"};
  const migratedV5=migrateAppSettings(v5);
  equal(migratedV5.cognitiveSchedule,DEFAULT_APP_SETTINGS.cognitiveSchedule,"schema v5 migration inserts cognitive defaults");
  equal(migratedV5.schemaVersion,"14","legacy AppSettings migrate to the current schema");
  equal(migratedV5.chat.automaticLongTermMemory,false,"legacy automatic memory setting remains a save gate");
  equal(migratedV5.memoryAgent.enabled,false,"schema v5 preserves the Memory Agent enable flag");
  equal(migratedV5.memoryAgent.providerPresetId,"preset.memory","schema v5 preserves the Memory Agent provider selection");
  equal(migratedV5.memoryAgent.prompt,"custom prompt","schema v5 preserves custom Memory Agent prompt text");
  equal(migratedV5.memoryAgent.promptBackup,"previous prompt","schema v5 preserves Memory Agent prompt backup");
  equal(migratedV5.memoryAgent.defaultPromptVersion,"7","schema v5 preserves Memory Agent prompt version");
  const oldDefaultV8=JSON.parse(JSON.stringify(defaultAppSettings())) as Record<string,any>;
  delete oldDefaultV8.memoryAgent;
  oldDefaultV8.schemaVersion="8";
  oldDefaultV8.cognitiveSchedule={...defaultAppSettings().cognitiveSchedule,minIntervalMs:10000,maxIntervalMs:900000,maxRequestsPerHour:120};
  const migratedOldDefaults=migrateAppSettings(oldDefaultV8);
  equal(migratedOldDefaults.cognitiveSchedule.minIntervalMs,3000,"legacy built-in minimum interval migrates to 3000 ms");
  equal(migratedOldDefaults.cognitiveSchedule.maxIntervalMs,300000,"legacy built-in maximum interval migrates to 300000 ms");
  equal(migratedOldDefaults.cognitiveSchedule.maxRequestsPerHour,null,"legacy built-in hourly quota is disabled");
  // Pre-v9 default quota is migrated to an explicitly disabled quota; customized quotas survive.
  const v8=JSON.parse(JSON.stringify(defaultAppSettings())) as Record<string,any>;
  delete v8.memoryAgent;
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
  const v10={...v9,schemaVersion:"10",chat:{automaticLongTermMemory:false,responseMode:"plain"},memoryAgent:{enabled:true,providerPresetId:"old-agent-preset",model:"legacy-model",outputMode:"plain",prompt:"old prompt",promptBackup:"backup",defaultPromptVersion:"9"}};
  const migratedV10=migrateAppSettings(v10);
  equal(migratedV10.chat.responseMode,"plain","schema v10 persists the selected Chat response mode");
  equal(migratedV10.cognitiveSchedule.maxRequestsPerHour,120,"explicit quota in the old schema is preserved");
  equal(migratedV10.schemaVersion,"14","schema v10 upgrades to schema v14");
  equal(migratedV10.memoryAgent.enabled,true,"schema v10 preserves explicit Memory Agent configuration over the legacy chat gate");
  equal(migratedV10.memoryAgent.providerPresetId,"old-agent-preset","schema v10 preserves the Memory Agent provider preset");
  equal(migratedV10.memoryAgent.prompt,"old prompt","schema v10 preserves the Memory Agent prompt");
  equal(migratedV10.chat.automaticLongTermMemory,true,"Memory Agent enabled state becomes the compatibility gate");
  const v6=JSON.parse(JSON.stringify(defaultAppSettings())) as Record<string,unknown>;
  v6.schemaVersion="6";
  v6.memoryAgent={enabled:false,providerPresetId:"preset.legacy",model:"legacy-model",outputMode:"plain",prompt:"old prompt",promptBackup:"backup",defaultPromptVersion:"9"};
  const migratedV6=migrateAppSettings(v6);
  equal(migratedV6.schemaVersion,"14","older settings schemas migrate to current AppSettings");
  equal(migratedV6.memoryAgent.enabled,false,"schema v6 preserves the disabled Memory Agent setting");
  equal(migratedV6.memoryAgent.providerPresetId,"preset.legacy","schema v6 preserves the configured Memory Agent preset");
  const currentSettings={...defaultAppSettings(),chat:{...defaultAppSettings().chat,automaticLongTermMemory:false,responseMode:"plain" as const}};
  await manager.set(currentSettings);
  const reloadedManager=new SettingsManager(store,validator);
  const reloaded=await reloadedManager.initialize();
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

  const v12=JSON.parse(JSON.stringify(defaultAppSettings())) as Record<string,any>;
  delete v12.chat.reasoningEffort;
  v12.schemaVersion="12";
  delete v12.tts;
  v12.context.availableContextTokens=6144;
  v12.chat.responseMode="plain";
  v12.prompts.overrides={"nova-system-json":"preserved v12 prompt override"};
  const migratedV12=migrateAppSettings(v12);
  equal(migratedV12.schemaVersion,"14","schema v12 migrates to v14");
  equal(migratedV12.context.availableContextTokens,6144,"v12 migration preserves the existing context settings");
  equal(migratedV12.chat.responseMode,"plain","v12 migration preserves the existing chat settings");
  equal(migratedV12.chat.reasoningMode,"provider-default","v12 migration defaults unsupported reasoning settings safely");
  equal(migratedV12.chat.reasoningEffort,"provider-default","existing profiles receive a non-invasive migrated reasoning default");
  equal(migratedV12.ui.showReasoningInDiagnostics,false,"reasoning visibility defaults off");
  equal(migratedV12.prompts.overrides["nova-system-json"],"preserved v12 prompt override","v12 migration preserves prompt registry overrides");
  equal(migratedV12.tts.enabled,false,"v12 migration leaves TTS disabled");
  equal(migratedV12.tts.presets[0]?.baseUrl,"http://127.0.0.1:3900","v12 migration uses safe loopback TTS defaults");
  const invalidTtsSecret={...defaultAppSettings(),tts:{...defaultAppSettings().tts,presets:[{...defaultAppSettings().tts.presets[0]!,providerOptions:{apiKey:"should-not-be-persisted"}}]}};
  ok(validateAppSettings(invalidTtsSecret).some(error=>error.toLowerCase().includes("secret")),"TTS settings reject secret-bearing provider option keys");
  let rejectedUnknownTts=false;
  try{migrateAppSettings({...defaultAppSettings(),tts:{...defaultAppSettings().tts,unknown:true} as any});}catch{rejectedUnknownTts=true;}
  ok(rejectedUnknownTts,"TTS settings reject unknown schema fields");
  const alteredTts={...defaultAppSettings(),tts:{...defaultAppSettings().tts,enabled:true}};
  await manager.set(alteredTts);
  const ttsReload=await new SettingsManager(store,validator).initialize();
  equal(ttsReload.tts.enabled,true,"TTS enabled setting survives settings storage reload");
  const ttsReset=await manager.reset();
  equal(ttsReset.tts.enabled,false,"settings reset turns TTS off");
  console.log("PASS Settings and diagnostics unit tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1});
