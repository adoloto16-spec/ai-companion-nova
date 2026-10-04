export type DiagnosticsLogLevel="off"|"errors"|"normal"|"verbose"|"debug";

export const APP_SETTINGS_API_VERSION:"1"="1";
export const APP_SETTINGS_SCHEMA_VERSION:"3"="3";
export const DEFAULT_AUTOMATIC_MEMORY_INSTRUCTIONS="Review the relevant conversation context, user message, and assistant response.\nDecide whether there is durable information worth remembering after this conversation ends.\nKeep information only when it is useful beyond the current turn.\nExamples: stable user preferences, persistent user facts, important relationships, long-term goals, commitments or decisions, durable instructions, meaningful experiences, and important assistant commitments or decisions.";

export interface AppSettings{
  apiVersion:"1";
  schemaVersion:"3";
  chat:{
    automaticLongTermMemory:boolean;
  };
  memoryAgent:{
    enabled:boolean;
    providerPresetId:string|null;
    model:string;
    instructions:string;
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
  chat:{automaticLongTermMemory:true},
  memoryAgent:{enabled:true,providerPresetId:null,model:"",instructions:DEFAULT_AUTOMATIC_MEMORY_INSTRUCTIONS},
  context:{
    availableContextTokens:4096,
    reservedOutputTokens:1024,
    safetyMarginTokens:128,
    recentConversationMessages:8
  },
  memory:{candidateLimit:8},
  retrieval:{candidateLimit:32},
  diagnostics:{logLevel:"normal",keepRecentEntries:100},
  ui:{showDiagnosticsInChat:true}
};

export function defaultAppSettings():AppSettings{
  return {
    apiVersion:DEFAULT_APP_SETTINGS.apiVersion,
    schemaVersion:DEFAULT_APP_SETTINGS.schemaVersion,
    chat:{...DEFAULT_APP_SETTINGS.chat},
    memoryAgent:{...DEFAULT_APP_SETTINGS.memoryAgent},
    context:{...DEFAULT_APP_SETTINGS.context},
    memory:{...DEFAULT_APP_SETTINGS.memory},
    retrieval:{...DEFAULT_APP_SETTINGS.retrieval},
    diagnostics:{...DEFAULT_APP_SETTINGS.diagnostics},
    ui:{...DEFAULT_APP_SETTINGS.ui}
  };
}

const SECURITY_MAX={
  availableContextTokens:32768,
  reservedOutputTokens:16384,
  safetyMarginTokens:4096,
  recentConversationMessages:100,
  memoryCandidateLimit:100,
  retrievalCandidateLimit:100,
  diagnosticsEntries:500
} as const;

export function validateAppSettings(settings:AppSettings):string[]{
  const errors:string[]=[];
  const integer=(value:number,label:string,min:number,max:number)=>{
    if(!Number.isInteger(value)||value<min||value>max)errors.push(label+" must be an integer between "+min+" and "+max+".");
  };
  if(settings.apiVersion!==APP_SETTINGS_API_VERSION)errors.push("Unsupported AppSettings apiVersion.");
  if(settings.schemaVersion!==APP_SETTINGS_SCHEMA_VERSION)errors.push("Unsupported AppSettings schemaVersion.");
  if(typeof settings.memoryAgent.enabled!=="boolean")errors.push("Automatic Memory Agent enabled must be boolean.");
  if(settings.memoryAgent.providerPresetId!==null&&(typeof settings.memoryAgent.providerPresetId!=="string"||settings.memoryAgent.providerPresetId.trim().length===0))errors.push("Automatic Memory Agent provider preset must be empty or a non-empty string.");
  if(typeof settings.memoryAgent.model!=="string")errors.push("Automatic Memory Agent model must be a string.");
  if(typeof settings.memoryAgent.instructions!=="string"||settings.memoryAgent.instructions.length>12000)errors.push("Automatic Memory Agent instructions must be a string up to 12000 characters.");
  integer(settings.context.availableContextTokens,"Context size",256,SECURITY_MAX.availableContextTokens);
  integer(settings.context.reservedOutputTokens,"Reserved response tokens",0,SECURITY_MAX.reservedOutputTokens);
  integer(settings.context.safetyMarginTokens,"Safety margin",0,SECURITY_MAX.safetyMarginTokens);
  integer(settings.context.recentConversationMessages,"Recent messages",1,SECURITY_MAX.recentConversationMessages);
  integer(settings.memory.candidateLimit,"Memory items",1,SECURITY_MAX.memoryCandidateLimit);
  integer(settings.retrieval.candidateLimit,"Retrieval candidates",1,SECURITY_MAX.retrievalCandidateLimit);
  if(!["off","errors","normal","verbose","debug"].includes(settings.diagnostics.logLevel))errors.push("Unsupported diagnostics log level.");
  integer(settings.diagnostics.keepRecentEntries,"Recent diagnostic entries",1,SECURITY_MAX.diagnosticsEntries);
  if(typeof settings.chat.automaticLongTermMemory!=="boolean")errors.push("Automatic long-term memory must be boolean.");
  if(typeof settings.ui.showDiagnosticsInChat!=="boolean")errors.push("Chat diagnostics visibility must be boolean.");
  return errors;
}

export function migrateAppSettings(value:unknown):AppSettings{
  const defaults=defaultAppSettings();
  if(!value||typeof value!=="object")return defaults;
  const input=value as Record<string,unknown>;
  const legacy=input.schemaVersion==="0"||input.schemaVersion===undefined||input.schemaVersion==="1";
  if(input.apiVersion!==undefined&&input.apiVersion!=="1"&&!legacy)throw new Error("Unsupported AppSettings apiVersion.");
  if(input.schemaVersion!==undefined&&!["0","1","2","3"].includes(String(input.schemaVersion)))throw new Error("Unsupported AppSettings schemaVersion.");
  const root=value as Record<string,any>;
  const context=root.context&&typeof root.context==="object"?root.context:{};
  const memory=root.memory&&typeof root.memory==="object"?root.memory:{};
  const diagnostics=root.diagnostics&&typeof root.diagnostics==="object"?root.diagnostics:{};
  const chat=root.chat&&typeof root.chat==="object"?root.chat:{};
  const memoryAgent=root.memoryAgent&&typeof root.memoryAgent==="object"?root.memoryAgent:{};
  const ui=root.ui&&typeof root.ui==="object"?root.ui:{};
  const legacyContextBudget=typeof root.contextBudget==="number"?root.contextBudget:undefined;
  const legacyRecent=typeof root.recentMessages==="number"?root.recentMessages:undefined;
  const legacyMemory=typeof root.memoryCandidateLimit==="number"?root.memoryCandidateLimit:undefined;
  const legacyLog=typeof root.diagnosticsLevel==="string"?root.diagnosticsLevel:undefined;
  const logLevelValue=(typeof diagnostics.logLevel==="string"?diagnostics.logLevel:legacyLog)??defaults.diagnostics.logLevel;
  if(!["off","errors","normal","verbose","debug"].includes(logLevelValue))throw new Error("Unsupported diagnostics log level.");
  const legacyEnabled=typeof chat.automaticLongTermMemory==="boolean"?chat.automaticLongTermMemory:defaults.chat.automaticLongTermMemory;
  const currentSchema=input.schemaVersion==="3";
  const previousSchema=input.schemaVersion==="2";
  const memoryAgentEnabled=(currentSchema||previousSchema)&&typeof memoryAgent.enabled==="boolean"?memoryAgent.enabled:legacyEnabled;
  const memoryAgentPreset=(currentSchema||previousSchema)&&typeof memoryAgent.providerPresetId==="string"&&memoryAgent.providerPresetId.trim()?memoryAgent.providerPresetId.trim():null;
  const memoryAgentModel=(currentSchema||previousSchema)&&typeof memoryAgent.model==="string"?memoryAgent.model.trim():"";
  const memoryAgentInstructions=currentSchema&&typeof memoryAgent.instructions==="string"&&memoryAgent.instructions.trim()
    ?memoryAgent.instructions.trim()
    :DEFAULT_AUTOMATIC_MEMORY_INSTRUCTIONS;
  const next:AppSettings={
    apiVersion:"1",schemaVersion:"3",
    chat:{automaticLongTermMemory:legacyEnabled},
    memoryAgent:{enabled:memoryAgentEnabled,providerPresetId:memoryAgentPreset,model:memoryAgentModel,instructions:memoryAgentInstructions},
    context:{
      availableContextTokens:typeof context.availableContextTokens==="number"?context.availableContextTokens:(legacyContextBudget??defaults.context.availableContextTokens),
      reservedOutputTokens:typeof context.reservedOutputTokens==="number"?context.reservedOutputTokens:defaults.context.reservedOutputTokens,
      safetyMarginTokens:typeof context.safetyMarginTokens==="number"?context.safetyMarginTokens:defaults.context.safetyMarginTokens,
      recentConversationMessages:typeof context.recentConversationMessages==="number"?context.recentConversationMessages:(legacyRecent??defaults.context.recentConversationMessages)
    },
    memory:{
      candidateLimit:typeof memory.candidateLimit==="number"?memory.candidateLimit:(legacyMemory??defaults.memory.candidateLimit)
    },
    retrieval:{candidateLimit:typeof (root.retrieval as any)?.candidateLimit==="number"?(root.retrieval as any).candidateLimit:defaults.retrieval.candidateLimit},
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
