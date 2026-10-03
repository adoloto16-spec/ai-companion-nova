import {
  SettingsManager,InMemoryDiagnosticsStore,InMemoryChatTraceStore
} from "../../core/src";
import {StandardContractValidator,DEFAULT_APP_SETTINGS,defaultAppSettings,migrateAppSettings,validateAppSettings} from "../../contracts/src";
import {InMemorySettingsStore} from "../../host/settings/src";

function equal(actual:unknown,expected:unknown,label:string){if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(label+" expected "+String(expected)+" got "+String(actual))}
function ok(value:unknown,label:string){if(!value)throw new Error(label)}

async function main(){
  const validator=new StandardContractValidator();
  const store=new InMemorySettingsStore(validator);
  const manager=new SettingsManager(store,validator);
  const defaults=await manager.initialize();
  equal(defaults,defaultAppSettings(),"missing settings resolve to deterministic defaults");
  equal(DEFAULT_APP_SETTINGS.context.availableContextTokens,4096,"default context size");
  equal(defaults.memoryAgent.enabled,true,"Automatic Memory Agent defaults enabled");
  equal(defaults.memoryAgent.providerPresetId,null,"Automatic Memory Agent has no implicit provider binding");
  const custom={
    ...defaults,
    context:{...defaults.context,availableContextTokens:8192,reservedOutputTokens:2048,safetyMarginTokens:256,recentConversationMessages:4},
    memory:{...defaults.memory,candidateLimit:3},
    retrieval:{...defaults.retrieval,candidateLimit:7},
    diagnostics:{...defaults.diagnostics,logLevel:"verbose" as const,keepRecentEntries:25},
    chat:{...defaults.chat,automaticLongTermMemory:false}
  };
  const errors=validateAppSettings(custom);
  equal(errors,[],"valid custom settings pass semantic validation");
  await manager.set(custom);
  equal((await manager.get()).context.availableContextTokens,8192,"custom context size persists in store");
  equal((await manager.get()).memory.candidateLimit,3,"custom memory candidate limit persists");
  equal((await manager.get()).chat.automaticLongTermMemory,false,"legacy automatic memory toggle persists for compatibility");
  const reset=await manager.reset();
  equal(reset,defaultAppSettings(),"reset restores defaults");
  let rejected=false;
  try{await manager.set({...defaultAppSettings(),context:{...defaultAppSettings().context,availableContextTokens:999999}} as any)}catch{rejected=true}
  ok(rejected,"unsafe values are rejected");
  const legacy=migrateAppSettings({schemaVersion:"0",contextBudget:8192,recentMessages:12,memoryCandidateLimit:5,diagnosticsLevel:"debug"});
  equal(legacy.context.availableContextTokens,8192,"legacy context budget migrates");
  equal(legacy.context.recentConversationMessages,12,"legacy recent message count migrates");
  equal(legacy.memory.candidateLimit,5,"legacy memory limit migrates");
  equal(legacy.diagnostics.logLevel,"debug","legacy diagnostics level migrates");
  equal(legacy.schemaVersion,"2","legacy settings migrate to schema v2");
  equal(legacy.memoryAgent.enabled,true,"legacy automatic memory flag migrates to memoryAgent");
  const previous=migrateAppSettings({...defaultAppSettings(),schemaVersion:"1",chat:{automaticLongTermMemory:false}} as any);
  equal(previous.memoryAgent.enabled,false,"schema v1 automaticLongTermMemory migrates to memoryAgent");
  const explicit=migrateAppSettings({...defaultAppSettings(),schemaVersion:"2",chat:{automaticLongTermMemory:false},memoryAgent:{enabled:true,providerPresetId:"preset.memory",model:"memory-model"}} as any);
  equal(explicit.memoryAgent.enabled,true,"explicit memoryAgent setting overrides legacy boolean");
  equal(explicit.memoryAgent.providerPresetId,"preset.memory","memory agent provider binding migrates");

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
