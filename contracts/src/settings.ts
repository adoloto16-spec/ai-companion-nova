export type DiagnosticsLogLevel="off"|"errors"|"normal"|"verbose"|"debug";
export type CognitiveScheduleMode="adaptive"|"fixed";
export interface CognitiveScheduleSettings{
  mode:CognitiveScheduleMode;
  defaultIntervalMs:number;
  minIntervalMs:number;
  maxIntervalMs:number;
  maxRequestsPerHour:number|null;
}
export const DEFAULT_COGNITIVE_SCHEDULE:CognitiveScheduleSettings={
  mode:"adaptive",
  defaultIntervalMs:30_000,
  minIntervalMs:3_000,
  maxIntervalMs:300_000,
  maxRequestsPerHour:null
};
export const APP_SETTINGS_API_VERSION:"1"="1";
export const APP_SETTINGS_SCHEMA_VERSION:"10"="10";
export const DEFAULT_MEMORY_AGENT_PROMPT_VERSION="1";
export const DEFAULT_AUTOMATIC_MEMORY_PROMPT="You are a long-term memory agent.\nDecide whether the exchange contains durable information worth remembering after this conversation ends.\nReturn only the requested output.\nGood memories are brief, self-contained, durable, and understandable without the original conversation.\nDo not invent ids or metadata; the application supplies all internal state.";
export const DEFAULT_MEMORY_JUDGE_PROMPT_VERSION="2";
export const DEFAULT_MEMORY_JUDGE_PROMPT="You are a memory deduplication judge.\n\nCompare NEW MEMORY with CANDIDATES.\n\nKeep the most complete and informative record.\n\nIf NEW MEMORY is less informative because its information is contained in a candidate, archive NEW.\n\nIf a candidate is less informative because its information is contained in NEW MEMORY, archive that candidate number.\n\nIf records contain essentially the same information, archive one duplicate.\n\nIf records contain different useful information, archive nothing.\n\nYour decision is the list of archive targets.\n\nIn structured mode, return only:\n{\"archive\":[\"NEW\",\"1\",\"2\"]}\n\nIn plain mode, return only:\nNO_ARCHIVE\nor NEW / candidate numbers, one per line.\n\nNever return explanations.\nNever invent candidate numbers.";

const LEGACY_MEMORY_JUDGE_PROMPT="You are a memory deduplication judge.\n\nCompare NEW MEMORY with CANDIDATES.\n\nKeep the most complete and informative record.\n\nIf NEW MEMORY is less informative because its information is contained in a candidate, return NEW.\n\nIf a candidate contains all meaningful information from NEW MEMORY and adds useful information, return that candidate number.\n\nIf two records contain essentially the same information, return one of them.\n\nIf records contain different useful information, return NO_ARCHIVE.\n\nReturn only:\nNO_ARCHIVE,\nNEW,\nor candidate numbers, one per line.\n\nNever return explanations or text.\nNever invent candidate numbers.";

export interface AppSettings{
  apiVersion:"1";
  schemaVersion:"10";
  cognitiveSchedule:CognitiveScheduleSettings;
  chat:{
    automaticLongTermMemory:boolean;
    responseMode:"structured"|"plain";
  };
  memoryAgent:{
    enabled:boolean;
    providerPresetId:string|null;
    model:string;
    outputMode:"auto"|"structured"|"plain";
    prompt:string;
    promptBackup:string|null;
    defaultPromptVersion:string;
  };
  semanticDedup:{
    enabled:boolean;
    embeddingProviderPresetId:string|null;
    embeddingModel:string;
    candidateSimilarityThreshold:number;
    candidateLimit:number;
    judge:{
      enabled:boolean;
      providerPresetId:string|null;
      model:string;
      outputMode:"auto"|"structured"|"plain";
      prompt:string;
      promptBackup:string|null;
      defaultPromptVersion:string;
    };
  };
  context:{
    availableContextTokens:number;
    reservedOutputTokens:number;
    safetyMarginTokens:number;
    recentConversationMessages:number;
  };
  memory:{
    candidateLimit:number;
  };
  retrieval:{
    candidateLimit:number;
    semanticSearchEnabled:boolean;
    semanticSimilarityThreshold:number;
    semanticResultLimit:number;
  };
  diagnostics:{
    logLevel:DiagnosticsLogLevel;
    keepRecentEntries:number;
  };
  ui:{
    showDiagnosticsInChat:boolean;
  };
}

export const DEFAULT_APP_SETTINGS:AppSettings={
  apiVersion:APP_SETTINGS_API_VERSION,
  schemaVersion:APP_SETTINGS_SCHEMA_VERSION,
  cognitiveSchedule:{...DEFAULT_COGNITIVE_SCHEDULE},
  chat:{automaticLongTermMemory:true,responseMode:"structured"},
  memoryAgent:{enabled:true,providerPresetId:null,model:"",outputMode:"auto",prompt:DEFAULT_AUTOMATIC_MEMORY_PROMPT,promptBackup:null,defaultPromptVersion:DEFAULT_MEMORY_AGENT_PROMPT_VERSION},
  semanticDedup:{enabled:false,embeddingProviderPresetId:null,embeddingModel:"",candidateSimilarityThreshold:0.88,candidateLimit:5,judge:{enabled:true,providerPresetId:null,model:"",outputMode:"auto",prompt:DEFAULT_MEMORY_JUDGE_PROMPT,promptBackup:null,defaultPromptVersion:DEFAULT_MEMORY_JUDGE_PROMPT_VERSION}},
  context:{
    availableContextTokens:4096,
    reservedOutputTokens:1024,
    safetyMarginTokens:128,
    recentConversationMessages:8
  },
  memory:{candidateLimit:8},
  retrieval:{candidateLimit:32,semanticSearchEnabled:false,semanticSimilarityThreshold:0.35,semanticResultLimit:5},
  diagnostics:{logLevel:"normal",keepRecentEntries:100},
  ui:{showDiagnosticsInChat:true}
};

export function defaultAppSettings():AppSettings{
  return {
    apiVersion:DEFAULT_APP_SETTINGS.apiVersion,
    schemaVersion:DEFAULT_APP_SETTINGS.schemaVersion,
    cognitiveSchedule:{...DEFAULT_APP_SETTINGS.cognitiveSchedule},
    chat:{...DEFAULT_APP_SETTINGS.chat},
    memoryAgent:{...DEFAULT_APP_SETTINGS.memoryAgent},
    semanticDedup:{...DEFAULT_APP_SETTINGS.semanticDedup,judge:{...DEFAULT_APP_SETTINGS.semanticDedup.judge}},
    context:{...DEFAULT_APP_SETTINGS.context},
    memory:{...DEFAULT_APP_SETTINGS.memory},
    retrieval:{...DEFAULT_APP_SETTINGS.retrieval},
    diagnostics:{...DEFAULT_APP_SETTINGS.diagnostics},
    ui:{...DEFAULT_APP_SETTINGS.ui}
  };
}

const SECURITY_MAX={
  cognitiveIntervalMs:3_600_000,
  cognitiveRequestsPerHour:3_600,
  availableContextTokens:32768,
  reservedOutputTokens:16384,
  safetyMarginTokens:4096,
  recentConversationMessages:100,
  memoryCandidateLimit:100,
  retrievalCandidateLimit:100,
  semanticResultLimit:20,
  semanticCandidateLimit:100,
  diagnosticsEntries:500,
} as const;

export function validateAppSettings(settings:AppSettings):string[]{
  const errors:string[]=[];
  const integer=(value:number,label:string,min:number,max:number)=>{
    if(!Number.isInteger(value)||value<min||value>max)errors.push(label+" must be an integer between "+min+" and "+max+".");
  };
  if(settings.apiVersion!==APP_SETTINGS_API_VERSION)errors.push("Unsupported AppSettings apiVersion.");
  if(settings.schemaVersion!==APP_SETTINGS_SCHEMA_VERSION)errors.push("Unsupported AppSettings schemaVersion.");
  const schedule=settings.cognitiveSchedule;
  if(!schedule||typeof schedule!=="object"){
    errors.push("Cognitive schedule settings must be an object.");
  }else{
    if(!["adaptive","fixed"].includes(schedule.mode))errors.push("Unsupported cognitive schedule mode.");
    integer(schedule.defaultIntervalMs,"Cognitive default interval",1_000,SECURITY_MAX.cognitiveIntervalMs);
    integer(schedule.minIntervalMs,"Cognitive minimum interval",1_000,SECURITY_MAX.cognitiveIntervalMs);
    integer(schedule.maxIntervalMs,"Cognitive maximum interval",1_000,SECURITY_MAX.cognitiveIntervalMs);
    if(schedule.maxRequestsPerHour!==null)integer(schedule.maxRequestsPerHour,"Cognitive requests per hour",1,SECURITY_MAX.cognitiveRequestsPerHour);
    if(Number.isInteger(schedule.minIntervalMs)&&Number.isInteger(schedule.defaultIntervalMs)&&schedule.defaultIntervalMs<schedule.minIntervalMs)errors.push("Cognitive default interval must not be below the minimum interval.");
    if(Number.isInteger(schedule.minIntervalMs)&&Number.isInteger(schedule.maxIntervalMs)&&schedule.minIntervalMs>schedule.maxIntervalMs)errors.push("Cognitive minimum interval must not exceed the maximum interval.");
    if(Number.isInteger(schedule.defaultIntervalMs)&&Number.isInteger(schedule.maxIntervalMs)&&schedule.defaultIntervalMs>schedule.maxIntervalMs)errors.push("Cognitive default interval must not exceed the maximum interval.");
  }
  if(typeof settings.memoryAgent.enabled!=="boolean")errors.push("Automatic Memory Agent enabled must be boolean.");
  if(settings.memoryAgent.providerPresetId!==null&&(typeof settings.memoryAgent.providerPresetId!=="string"||settings.memoryAgent.providerPresetId.trim().length===0))errors.push("Automatic Memory Agent provider preset must be empty or a non-empty string.");
  if(typeof settings.memoryAgent.model!=="string")errors.push("Automatic Memory Agent model must be a string.");
  if(!["auto","structured","plain"].includes(settings.memoryAgent.outputMode))errors.push("Unsupported Automatic Memory Agent output mode.");
  if(typeof settings.memoryAgent.prompt!=="string"||settings.memoryAgent.prompt.length>12000)errors.push("Automatic Memory Agent prompt must be a string up to 12000 characters.");
  if(settings.memoryAgent.promptBackup!==null&&(typeof settings.memoryAgent.promptBackup!=="string"||settings.memoryAgent.promptBackup.length>12000))errors.push("Automatic Memory Agent prompt backup must be null or a string up to 12000 characters.");
  if(typeof settings.memoryAgent.defaultPromptVersion!=="string"||settings.memoryAgent.defaultPromptVersion.trim().length===0)errors.push("Automatic Memory Agent default prompt version must be a non-empty string.");
  if(typeof settings.semanticDedup.enabled!=="boolean")errors.push("Semantic Memory Deduplication enabled must be boolean.");
  if(settings.semanticDedup.embeddingProviderPresetId!==null&&(typeof settings.semanticDedup.embeddingProviderPresetId!=="string"||settings.semanticDedup.embeddingProviderPresetId.trim().length===0))errors.push("Semantic embedding provider preset must be empty or a non-empty string.");
  if(typeof settings.semanticDedup.embeddingModel!=="string"||settings.semanticDedup.embeddingModel.length>200)errors.push("Semantic embedding model must be a string up to 200 characters.");
  if(!Number.isFinite(settings.semanticDedup.candidateSimilarityThreshold)||settings.semanticDedup.candidateSimilarityThreshold<0||settings.semanticDedup.candidateSimilarityThreshold>1)errors.push("Semantic candidate similarity threshold must be between 0 and 1.");
  integer(settings.semanticDedup.candidateLimit,"Semantic candidate items",1,SECURITY_MAX.semanticCandidateLimit);
  if(typeof settings.semanticDedup.judge.enabled!=="boolean")errors.push("Memory Judge enabled must be boolean.");
  if(settings.semanticDedup.judge.providerPresetId!==null&&(typeof settings.semanticDedup.judge.providerPresetId!=="string"||settings.semanticDedup.judge.providerPresetId.trim().length===0))errors.push("Memory Judge provider preset must be empty or a non-empty string.");
  if(typeof settings.semanticDedup.judge.model!=="string"||settings.semanticDedup.judge.model.length>200)errors.push("Memory Judge model must be a string up to 200 characters.");
  if(!["auto","structured","plain"].includes(settings.semanticDedup.judge.outputMode))errors.push("Unsupported Memory Judge output mode.");
  if(typeof settings.semanticDedup.judge.prompt!=="string"||settings.semanticDedup.judge.prompt.length>12000)errors.push("Memory Judge prompt must be a string up to 12000 characters.");
  if(settings.semanticDedup.judge.promptBackup!==null&&(typeof settings.semanticDedup.judge.promptBackup!=="string"||settings.semanticDedup.judge.promptBackup.length>12000))errors.push("Memory Judge prompt backup must be null or a string up to 12000 characters.");
  if(typeof settings.semanticDedup.judge.defaultPromptVersion!=="string"||settings.semanticDedup.judge.defaultPromptVersion.trim().length===0)errors.push("Memory Judge default prompt version must be a non-empty string.");
  integer(settings.context.availableContextTokens,"Context size",256,SECURITY_MAX.availableContextTokens);
  integer(settings.context.reservedOutputTokens,"Reserved response tokens",0,SECURITY_MAX.reservedOutputTokens);
  integer(settings.context.safetyMarginTokens,"Safety margin",0,SECURITY_MAX.safetyMarginTokens);
  integer(settings.context.recentConversationMessages,"Recent messages",1,SECURITY_MAX.recentConversationMessages);
  integer(settings.memory.candidateLimit,"Memory items",1,SECURITY_MAX.memoryCandidateLimit);
  integer(settings.retrieval.candidateLimit,"Retrieval candidates",1,SECURITY_MAX.retrievalCandidateLimit);
  if(typeof settings.retrieval.semanticSearchEnabled!=="boolean")errors.push("Automatic semantic search enabled must be boolean.");
  if(!Number.isFinite(settings.retrieval.semanticSimilarityThreshold)||settings.retrieval.semanticSimilarityThreshold<0||settings.retrieval.semanticSimilarityThreshold>1)errors.push("Semantic cosine similarity threshold must be between 0 and 1.");
  integer(settings.retrieval.semanticResultLimit,"Semantic search result limit",1,SECURITY_MAX.semanticResultLimit);
  if(!["off","errors","normal","verbose","debug"].includes(settings.diagnostics.logLevel))errors.push("Unsupported diagnostics log level.");
  integer(settings.diagnostics.keepRecentEntries,"Recent diagnostic entries",1,SECURITY_MAX.diagnosticsEntries);
  if(typeof settings.chat.automaticLongTermMemory!=="boolean")errors.push("Automatic long-term memory must be boolean.");
  if(!["structured","plain"].includes(settings.chat.responseMode))errors.push("Unsupported Chat response mode.");
  if(typeof settings.ui.showDiagnosticsInChat!=="boolean")errors.push("Chat diagnostics visibility must be boolean.");
  return errors;
}

export function migrateAppSettings(value:unknown):AppSettings{
  const defaults=defaultAppSettings();
  if(!value||typeof value!=="object")return defaults;
  const input=value as Record<string,unknown>;
  const legacy=input.schemaVersion==="0"||input.schemaVersion===undefined||input.schemaVersion==="1";
  if(input.apiVersion!==undefined&&input.apiVersion!=="1"&&!legacy)throw new Error("Unsupported AppSettings apiVersion.");
  if(input.schemaVersion!==undefined&&!["0","1","2","3","4","5","6","7","8","9","10"].includes(String(input.schemaVersion)))throw new Error("Unsupported AppSettings schemaVersion.");
  const root=value as Record<string,any>;
  const context=root.context&&typeof root.context==="object"?root.context:{};
  const memory=root.memory&&typeof root.memory==="object"?root.memory:{};
  const retrieval=root.retrieval&&typeof root.retrieval==="object"?root.retrieval:{};
  const diagnostics=root.diagnostics&&typeof root.diagnostics==="object"?root.diagnostics:{};
  const chat=root.chat&&typeof root.chat==="object"?root.chat:{};
  const memoryAgent=root.memoryAgent&&typeof root.memoryAgent==="object"?root.memoryAgent:{};
  const ui=root.ui&&typeof root.ui==="object"?root.ui:{};
  const cognitiveSchedule=root.cognitiveSchedule&&typeof root.cognitiveSchedule==="object"?root.cognitiveSchedule:{};
  const semanticDedup=root.semanticDedup&&typeof root.semanticDedup==="object"?root.semanticDedup:{};
  const semanticJudge=semanticDedup.judge&&typeof semanticDedup.judge==="object"?semanticDedup.judge:{};
  const migratedMinimumInterval=String(input.schemaVersion)!=="10"&&cognitiveSchedule.minIntervalMs===10_000
    ?defaults.cognitiveSchedule.minIntervalMs
    :(typeof cognitiveSchedule.minIntervalMs==="number"?cognitiveSchedule.minIntervalMs:defaults.cognitiveSchedule.minIntervalMs);
  const migratedMaximumInterval=String(input.schemaVersion)!=="10"&&cognitiveSchedule.maxIntervalMs===900_000
    ?defaults.cognitiveSchedule.maxIntervalMs
    :(typeof cognitiveSchedule.maxIntervalMs==="number"?cognitiveSchedule.maxIntervalMs:defaults.cognitiveSchedule.maxIntervalMs);
  const legacyContextBudget=typeof root.contextBudget==="number"?root.contextBudget:undefined;
  const legacyRecent=typeof root.recentMessages==="number"?root.recentMessages:undefined;
  const legacyMemory=typeof root.memoryCandidateLimit==="number"?root.memoryCandidateLimit:undefined;
  const legacyLog=typeof root.diagnosticsLevel==="string"?root.diagnosticsLevel:undefined;
  const logLevelValue=(typeof diagnostics.logLevel==="string"?diagnostics.logLevel:legacyLog)??defaults.diagnostics.logLevel;
  if(!["off","errors","normal","verbose","debug"].includes(logLevelValue))throw new Error("Unsupported diagnostics log level.");
  const legacyEnabled=typeof chat.automaticLongTermMemory==="boolean"?chat.automaticLongTermMemory:defaults.chat.automaticLongTermMemory;
  // Schema v5 is canonical, so Memory Agent persistence fields must survive migration unchanged; legacy schemas keep their historical gates.
  const preservesMemoryAgentBinding=["2","3","4","5","6","7","8","9","10"].includes(String(input.schemaVersion));
  const previousSchema=input.schemaVersion==="2";
  const memoryAgentEnabled=preservesMemoryAgentBinding&&typeof memoryAgent.enabled==="boolean"?memoryAgent.enabled:legacyEnabled;
  const memoryAgentPreset=preservesMemoryAgentBinding&&typeof memoryAgent.providerPresetId==="string"&&memoryAgent.providerPresetId.trim()?memoryAgent.providerPresetId.trim():null;
  const memoryAgentModel=preservesMemoryAgentBinding&&typeof memoryAgent.model==="string"?memoryAgent.model.trim():"";
  const legacyPrompt=typeof memoryAgent.instructions==="string"?memoryAgent.instructions.trim():"";
  const currentPrompt=typeof memoryAgent.prompt==="string"&&memoryAgent.prompt.trim()?memoryAgent.prompt.trim():(legacyPrompt||DEFAULT_AUTOMATIC_MEMORY_PROMPT);
  const currentBackup=typeof memoryAgent.promptBackup==="string"&&memoryAgent.promptBackup.length>0?memoryAgent.promptBackup:null;
  const outputMode=memoryAgent.outputMode==="structured"||memoryAgent.outputMode==="plain"||memoryAgent.outputMode==="auto"?memoryAgent.outputMode:"auto";
  const defaultPromptVersion=typeof memoryAgent.defaultPromptVersion==="string"&&memoryAgent.defaultPromptVersion.trim()?memoryAgent.defaultPromptVersion.trim():DEFAULT_MEMORY_AGENT_PROMPT_VERSION;
  const semanticDedupEnabled=typeof semanticDedup.enabled==="boolean"?semanticDedup.enabled:defaults.semanticDedup.enabled;
  const semanticEmbeddingPreset=typeof semanticDedup.embeddingProviderPresetId==="string"&&semanticDedup.embeddingProviderPresetId.trim()?semanticDedup.embeddingProviderPresetId.trim():null;
  const semanticEmbeddingModel=typeof semanticDedup.embeddingModel==="string"?semanticDedup.embeddingModel.trim():"";
  const semanticThreshold=typeof semanticDedup.candidateSimilarityThreshold==="number"?semanticDedup.candidateSimilarityThreshold:defaults.semanticDedup.candidateSimilarityThreshold;
  const semanticLimit=typeof semanticDedup.candidateLimit==="number"?semanticDedup.candidateLimit:defaults.semanticDedup.candidateLimit;
  const semanticJudgeEnabled=typeof semanticJudge.enabled==="boolean"?semanticJudge.enabled:defaults.semanticDedup.judge.enabled;
  const semanticJudgePreset=typeof semanticJudge.providerPresetId==="string"&&semanticJudge.providerPresetId.trim()?semanticJudge.providerPresetId.trim():null;
  const semanticJudgeModel=typeof semanticJudge.model==="string"?semanticJudge.model.trim():"";
  const semanticJudgeOutputMode=semanticJudge.outputMode==="structured"||semanticJudge.outputMode==="plain"||semanticJudge.outputMode==="auto"?semanticJudge.outputMode:"auto";
  const semanticJudgeLegacyPrompt=typeof semanticJudge.instructions==="string"?semanticJudge.instructions.trim():"";
  const storedSemanticJudgePrompt=typeof semanticJudge.prompt==="string"&&semanticJudge.prompt.trim()?semanticJudge.prompt.trim():"";
  const semanticJudgePromptIsLegacyDefault=storedSemanticJudgePrompt===LEGACY_MEMORY_JUDGE_PROMPT&&semanticJudge.defaultPromptVersion==="1";
  const semanticJudgePrompt=semanticJudgePromptIsLegacyDefault?DEFAULT_MEMORY_JUDGE_PROMPT:(storedSemanticJudgePrompt||semanticJudgeLegacyPrompt||DEFAULT_MEMORY_JUDGE_PROMPT);
  const semanticJudgeBackup=typeof semanticJudge.promptBackup==="string"&&semanticJudge.promptBackup.length>0?semanticJudge.promptBackup:null;
  const semanticJudgeVersion=semanticJudgePromptIsLegacyDefault?DEFAULT_MEMORY_JUDGE_PROMPT_VERSION:(typeof semanticJudge.defaultPromptVersion==="string"&&semanticJudge.defaultPromptVersion.trim()?semanticJudge.defaultPromptVersion.trim():DEFAULT_MEMORY_JUDGE_PROMPT_VERSION);
  const next:AppSettings={
    apiVersion:"1",schemaVersion:"10",
    cognitiveSchedule:{
      mode:typeof cognitiveSchedule.mode==="string"?cognitiveSchedule.mode as CognitiveScheduleMode:defaults.cognitiveSchedule.mode,
      defaultIntervalMs:typeof cognitiveSchedule.defaultIntervalMs==="number"?cognitiveSchedule.defaultIntervalMs:defaults.cognitiveSchedule.defaultIntervalMs,
      minIntervalMs:migratedMinimumInterval,
      maxIntervalMs:migratedMaximumInterval,
      maxRequestsPerHour:typeof cognitiveSchedule.maxRequestsPerHour==="number"?(String(input.schemaVersion)!=="10"&&cognitiveSchedule.maxRequestsPerHour===120?null:cognitiveSchedule.maxRequestsPerHour):null
    },
    chat:{automaticLongTermMemory:legacyEnabled,responseMode:chat.responseMode==="plain"?"plain":"structured"},
    memoryAgent:{enabled:memoryAgentEnabled,providerPresetId:memoryAgentPreset,model:memoryAgentModel,outputMode,prompt:currentPrompt,promptBackup:currentBackup,defaultPromptVersion},
    semanticDedup:{
      enabled:semanticDedupEnabled,
      embeddingProviderPresetId:semanticEmbeddingPreset,
      embeddingModel:semanticEmbeddingModel,
      candidateSimilarityThreshold:semanticThreshold,
      candidateLimit:semanticLimit,
      judge:{
        enabled:semanticJudgeEnabled,
        providerPresetId:semanticJudgePreset,
        model:semanticJudgeModel,
        outputMode:semanticJudgeOutputMode,
        prompt:semanticJudgePrompt,
        promptBackup:semanticJudgeBackup,
        defaultPromptVersion:semanticJudgeVersion
      }
    },
    context:{
      availableContextTokens:typeof context.availableContextTokens==="number"?context.availableContextTokens:(legacyContextBudget??defaults.context.availableContextTokens),
      reservedOutputTokens:typeof context.reservedOutputTokens==="number"?context.reservedOutputTokens:defaults.context.reservedOutputTokens,
      safetyMarginTokens:typeof context.safetyMarginTokens==="number"?context.safetyMarginTokens:defaults.context.safetyMarginTokens,
      recentConversationMessages:typeof context.recentConversationMessages==="number"?context.recentConversationMessages:(legacyRecent??defaults.context.recentConversationMessages)
    },
    memory:{
      candidateLimit:typeof memory.candidateLimit==="number"?memory.candidateLimit:(legacyMemory??defaults.memory.candidateLimit)
    },
    retrieval:{
      candidateLimit:typeof retrieval.candidateLimit==="number"?retrieval.candidateLimit:defaults.retrieval.candidateLimit,
      semanticSearchEnabled:typeof retrieval.semanticSearchEnabled==="boolean"?retrieval.semanticSearchEnabled:defaults.retrieval.semanticSearchEnabled,
      semanticSimilarityThreshold:typeof retrieval.semanticSimilarityThreshold==="number"?retrieval.semanticSimilarityThreshold:defaults.retrieval.semanticSimilarityThreshold,
      semanticResultLimit:typeof retrieval.semanticResultLimit==="number"?retrieval.semanticResultLimit:defaults.retrieval.semanticResultLimit
    },
    diagnostics:{
      logLevel:logLevelValue as DiagnosticsLogLevel,
      keepRecentEntries:typeof diagnostics.keepRecentEntries==="number"?diagnostics.keepRecentEntries:defaults.diagnostics.keepRecentEntries
    },
    ui:{showDiagnosticsInChat:typeof ui.showDiagnosticsInChat==="boolean"?ui.showDiagnosticsInChat:defaults.ui.showDiagnosticsInChat}
  };
  const errors=validateAppSettings(next);
  if(errors.length>0)throw new Error("Invalid AppSettings: "+errors.join(" "));
  return next;
}

export interface AppSettingsStore{
  load():Promise<AppSettings|undefined>;
  save(settings:AppSettings):Promise<void>;
}
