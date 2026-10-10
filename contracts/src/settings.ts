import {DEFAULT_PROMPT_TEXTS,PROMPT_REGISTRY,resolvePromptText,type PromptId,type PromptOverrides} from "./prompts";
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
export const APP_SETTINGS_SCHEMA_VERSION:"12"="12";
export const DEFAULT_MEMORY_JUDGE_PROMPT_VERSION="2";
export const DEFAULT_MEMORY_JUDGE_PROMPT=DEFAULT_PROMPT_TEXTS["memory-judge.system"];
const LEGACY_MEMORY_JUDGE_PROMPT="You are a memory deduplication judge.\n\nCompare NEW MEMORY with CANDIDATES.\n\nKeep the most complete and informative record.\n\nIf NEW MEMORY is less informative because its information is contained in a candidate, return NEW.\n\nIf a candidate contains all meaningful information from NEW MEMORY and adds useful information, return that candidate number.\n\nIf two records contain essentially the same information, return one of them.\n\nIf records contain different useful information, return NO_ARCHIVE.\n\nReturn only:\nNO_ARCHIVE,\nNEW,\nor candidate numbers, one per line.\n\nNever return explanations or text.\nNever invent candidate numbers.";

export interface AppSettings{
  apiVersion:"1";
  schemaVersion:"12";
  cognitiveSchedule:CognitiveScheduleSettings;
  chat:{
    automaticLongTermMemory:boolean;
    responseMode:"structured"|"plain";
  };
  prompts:{overrides:PromptOverrides};
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
  prompts:{overrides:{}},
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
    prompts:{overrides:{...DEFAULT_APP_SETTINGS.prompts.overrides}},
    semanticDedup:{...DEFAULT_APP_SETTINGS.semanticDedup,judge:{...DEFAULT_APP_SETTINGS.semanticDedup.judge}},
    context:{...DEFAULT_APP_SETTINGS.context},
    memory:{...DEFAULT_APP_SETTINGS.memory},
    retrieval:{...DEFAULT_APP_SETTINGS.retrieval},
    diagnostics:{...DEFAULT_APP_SETTINGS.diagnostics},
    ui:{...DEFAULT_APP_SETTINGS.ui}
  };
}


export function applyPromptOverride(settings:AppSettings,id:PromptId,text:string):AppSettings{
  const overrides:PromptOverrides={...settings.prompts.overrides};
  if(typeof text==="string"&&text.trim().length>0)overrides[id]=text;
  else delete overrides[id];
  const prompts={overrides};
  const judgePrompt=resolvePromptText(prompts,"memory-judge.system");
  return {
    ...settings,
    prompts,
    semanticDedup:{
      ...settings.semanticDedup,
      judge:{...settings.semanticDedup.judge,prompt:judgePrompt}
    }
  };
}

export function restorePromptDefault(settings:AppSettings,id:PromptId):AppSettings{
  return applyPromptOverride(settings,id,"");
}

export function restoreAllPromptDefaults(settings:AppSettings):AppSettings{
  return {
    ...settings,
    prompts:{overrides:{}},
    semanticDedup:{
      ...settings.semanticDedup,
      judge:{...settings.semanticDedup.judge,prompt:DEFAULT_PROMPT_TEXTS["memory-judge.system"]}
    }
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
  if(input.schemaVersion!==undefined&&!["0","1","2","3","4","5","6","7","8","9","10","11","12"].includes(String(input.schemaVersion)))throw new Error("Unsupported AppSettings schemaVersion.");
  const root=value as Record<string,any>;
  const context=root.context&&typeof root.context==="object"?root.context:{};
  const memory=root.memory&&typeof root.memory==="object"?root.memory:{};
  const retrieval=root.retrieval&&typeof root.retrieval==="object"?root.retrieval:{};
  const diagnostics=root.diagnostics&&typeof root.diagnostics==="object"?root.diagnostics:{};
  const chat=root.chat&&typeof root.chat==="object"?root.chat:{};
  const ui=root.ui&&typeof root.ui==="object"?root.ui:{};
  const cognitiveSchedule=root.cognitiveSchedule&&typeof root.cognitiveSchedule==="object"?root.cognitiveSchedule:{};
  const semanticDedup=root.semanticDedup&&typeof root.semanticDedup==="object"?root.semanticDedup:{};
  const semanticJudge=semanticDedup.judge&&typeof semanticDedup.judge==="object"?semanticDedup.judge:{};
  const migratedMinimumInterval=String(input.schemaVersion)!=="10"&&String(input.schemaVersion)!=="11"&&String(input.schemaVersion)!=="12"&&cognitiveSchedule.minIntervalMs===10_000
    ?defaults.cognitiveSchedule.minIntervalMs
    :(typeof cognitiveSchedule.minIntervalMs==="number"?cognitiveSchedule.minIntervalMs:defaults.cognitiveSchedule.minIntervalMs);
  const migratedMaximumInterval=String(input.schemaVersion)!=="10"&&String(input.schemaVersion)!=="11"&&String(input.schemaVersion)!=="12"&&cognitiveSchedule.maxIntervalMs===900_000
    ?defaults.cognitiveSchedule.maxIntervalMs
    :(typeof cognitiveSchedule.maxIntervalMs==="number"?cognitiveSchedule.maxIntervalMs:defaults.cognitiveSchedule.maxIntervalMs);
  const legacyContextBudget=typeof root.contextBudget==="number"?root.contextBudget:undefined;
  const legacyRecent=typeof root.recentMessages==="number"?root.recentMessages:undefined;
  const legacyMemory=typeof root.memoryCandidateLimit==="number"?root.memoryCandidateLimit:undefined;
  const legacyLog=typeof root.diagnosticsLevel==="string"?root.diagnosticsLevel:undefined;
  const logLevelValue=(typeof diagnostics.logLevel==="string"?diagnostics.logLevel:legacyLog)??defaults.diagnostics.logLevel;
  if(!["off","errors","normal","verbose","debug"].includes(logLevelValue))throw new Error("Unsupported diagnostics log level.");
  const legacyEnabled=typeof chat.automaticLongTermMemory==="boolean"?chat.automaticLongTermMemory:defaults.chat.automaticLongTermMemory;
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
  const storedSemanticJudgePrompt=typeof semanticJudge.prompt==="string"?semanticJudge.prompt:"";
  const semanticJudgePromptIsLegacyDefault=storedSemanticJudgePrompt===LEGACY_MEMORY_JUDGE_PROMPT&&semanticJudge.defaultPromptVersion==="1";
  const promptSettings=root.prompts&&typeof root.prompts==="object"?root.prompts:{};
  const rawPromptOverrides=promptSettings.overrides&&typeof promptSettings.overrides==="object"&&!Array.isArray(promptSettings.overrides)?promptSettings.overrides as Record<string,unknown>:{};
  const promptOverrides:PromptOverrides={};
  for(const [key,rawText] of Object.entries(rawPromptOverrides)){
    if(!PROMPT_REGISTRY.some(definition=>definition.id===key))throw new Error("Unsupported prompt id: "+key+".");
    if(typeof rawText!=="string"||rawText.length>12000)throw new Error("Prompt override must be a string up to 12000 characters.");
    if(rawText.trim().length>0)(promptOverrides as Record<string,string>)[key]=rawText;
  }
  const migratedLegacyJudgePrompt=semanticJudgePromptIsLegacyDefault
    ?DEFAULT_MEMORY_JUDGE_PROMPT
    :(storedSemanticJudgePrompt.trim()||semanticJudgeLegacyPrompt||DEFAULT_MEMORY_JUDGE_PROMPT);
  const hasCentralPromptSettings=Object.prototype.hasOwnProperty.call(root,"prompts");
  if(!hasCentralPromptSettings&&!promptOverrides["memory-judge.system"]&&migratedLegacyJudgePrompt!==DEFAULT_MEMORY_JUDGE_PROMPT){
    promptOverrides["memory-judge.system"]=migratedLegacyJudgePrompt;
  }
  const semanticJudgePrompt=resolvePromptText({overrides:promptOverrides},"memory-judge.system");
  const semanticJudgeBackup=typeof semanticJudge.promptBackup==="string"&&semanticJudge.promptBackup.length>0?semanticJudge.promptBackup:null;
  const semanticJudgeVersion=semanticJudgePromptIsLegacyDefault?DEFAULT_MEMORY_JUDGE_PROMPT_VERSION:(typeof semanticJudge.defaultPromptVersion==="string"&&semanticJudge.defaultPromptVersion.trim()?semanticJudge.defaultPromptVersion.trim():DEFAULT_MEMORY_JUDGE_PROMPT_VERSION);
  const next:AppSettings={
    apiVersion:"1",schemaVersion:"11",
    cognitiveSchedule:{
      mode:typeof cognitiveSchedule.mode==="string"?cognitiveSchedule.mode as CognitiveScheduleMode:defaults.cognitiveSchedule.mode,
      defaultIntervalMs:typeof cognitiveSchedule.defaultIntervalMs==="number"?cognitiveSchedule.defaultIntervalMs:defaults.cognitiveSchedule.defaultIntervalMs,
      minIntervalMs:migratedMinimumInterval,
      maxIntervalMs:migratedMaximumInterval,
      maxRequestsPerHour:typeof cognitiveSchedule.maxRequestsPerHour==="number"?(String(input.schemaVersion)!=="10"&&String(input.schemaVersion)!=="11"&&cognitiveSchedule.maxRequestsPerHour===120?null:cognitiveSchedule.maxRequestsPerHour):null
    },
    chat:{automaticLongTermMemory:legacyEnabled,responseMode:chat.responseMode==="plain"?"plain":"structured"},
    prompts:{overrides:promptOverrides},
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
