import {DEFAULT_PROMPT_TEXTS,PROMPT_REGISTRY,clonePromptConfiguration,createDefaultPromptConfiguration,createDefaultPromptPreset,resolvePromptText,type PromptId,type PromptOverrides,type PromptPreset,type PromptConfiguration} from "./prompts";
import {DEFAULT_TTS_SETTINGS} from "./tts";
import type {TtsPreset,TtsSettings} from "./tts";
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
export const APP_SETTINGS_SCHEMA_VERSION:"15"="15";
export const DEFAULT_MEMORY_JUDGE_PROMPT_VERSION="2";
export const DEFAULT_AUTOMATIC_MEMORY_PROMPT_VERSION="1";
export const DEFAULT_AUTOMATIC_MEMORY_INSTRUCTIONS="You are a long-term memory agent.\nDecide whether the exchange contains durable information worth remembering after this conversation ends.\nReturn only the requested output.\nGood memories are brief, self-contained, durable, and understandable without the original conversation.\nDo not invent ids or metadata; the application supplies all internal state.";
export const DEFAULT_MEMORY_JUDGE_PROMPT=DEFAULT_PROMPT_TEXTS["memory-judge.system"];
const LEGACY_MEMORY_JUDGE_PROMPT="You are a memory deduplication judge.\n\nCompare NEW MEMORY with CANDIDATES.\n\nKeep the most complete and informative record.\n\nIf NEW MEMORY is less informative because its information is contained in a candidate, return NEW.\n\nIf a candidate contains all meaningful information from NEW MEMORY and adds useful information, return that candidate number.\n\nIf two records contain essentially the same information, return one of them.\n\nIf records contain different useful information, return NO_ARCHIVE.\n\nReturn only:\nNO_ARCHIVE,\nNEW,\nor candidate numbers, one per line.\n\nNever return explanations or text.\nNever invent candidate numbers.";

export interface AutomaticMemoryAgentSettings{
  enabled:boolean;
  providerPresetId:string|null;
  model:string;
  outputMode:"auto"|"structured"|"plain";
  prompt:string;
  promptBackup:string|null;
  defaultPromptVersion:string;
}
export interface AppSettings{
  apiVersion:"1";
  schemaVersion:"15";
  cognitiveSchedule:CognitiveScheduleSettings;
  chat:{
    automaticLongTermMemory:boolean;
    responseMode:"structured"|"plain";
    reasoningMode:"provider-default"|"enabled"|"disabled";
    reasoningEffort:"provider-default"|"low"|"medium"|"high";
  };
  memoryAgent:AutomaticMemoryAgentSettings;
  prompts:PromptConfiguration;
  tts:TtsSettings;
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
    showReasoningInDiagnostics:boolean;
  };
}

function cloneTtsSettings(settings:TtsSettings):TtsSettings{return {enabled:settings.enabled,activePresetId:settings.activePresetId,finishTimeoutMs:settings.finishTimeoutMs??DEFAULT_TTS_SETTINGS.finishTimeoutMs,startTimeoutMs:settings.startTimeoutMs??DEFAULT_TTS_SETTINGS.startTimeoutMs,segmentGapMs:settings.segmentGapMs??DEFAULT_TTS_SETTINGS.segmentGapMs,presets:settings.presets.map(preset=>({...preset,credentialReference:preset.credentialReference?{...preset.credentialReference}:null,providerOptions:{...preset.providerOptions}}))};}

export const DEFAULT_APP_SETTINGS:AppSettings={
  apiVersion:APP_SETTINGS_API_VERSION,
  schemaVersion:APP_SETTINGS_SCHEMA_VERSION,
  cognitiveSchedule:{...DEFAULT_COGNITIVE_SCHEDULE},
  chat:{automaticLongTermMemory:true,responseMode:"structured",reasoningMode:"provider-default",reasoningEffort:"low"},
  memoryAgent:{enabled:true,providerPresetId:null,model:"",outputMode:"auto",prompt:DEFAULT_AUTOMATIC_MEMORY_INSTRUCTIONS,promptBackup:null,defaultPromptVersion:DEFAULT_AUTOMATIC_MEMORY_PROMPT_VERSION},
  prompts:createDefaultPromptConfiguration(),
  tts:cloneTtsSettings(DEFAULT_TTS_SETTINGS),
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
  ui:{showDiagnosticsInChat:true,showReasoningInDiagnostics:false}
};

export function defaultAppSettings():AppSettings{
  return {
    apiVersion:DEFAULT_APP_SETTINGS.apiVersion,
    schemaVersion:DEFAULT_APP_SETTINGS.schemaVersion,
    cognitiveSchedule:{...DEFAULT_APP_SETTINGS.cognitiveSchedule},
    chat:{...DEFAULT_APP_SETTINGS.chat},
    memoryAgent:{...DEFAULT_APP_SETTINGS.memoryAgent},
    prompts:clonePromptConfiguration(DEFAULT_APP_SETTINGS.prompts),
    tts:cloneTtsSettings(DEFAULT_APP_SETTINGS.tts),
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
  if(typeof text==="string"&&text.trim().length>0)overrides[id]=text;else delete overrides[id];
  const replacement=typeof text==="string"&&text.trim().length>0?text:DEFAULT_PROMPT_TEXTS[id];
  const presets=settings.prompts.presets.map(preset=>preset.id!==settings.prompts.activePresetId?preset:{
    ...preset,version:preset.version+1,prompts:preset.prompts.map(prompt=>prompt.legacyId===id?{...prompt,text:replacement}:prompt)
  });
  const prompts={...settings.prompts,overrides,presets};
  const active=presets.find(preset=>preset.id===settings.prompts.activePresetId);
  const effective=(legacyId:PromptId)=>active?.prompts.find(prompt=>prompt.legacyId===legacyId)?.text??"";
  return {...settings,prompts,memoryAgent:{...settings.memoryAgent,prompt:effective("memory-agent.system")},
    semanticDedup:{...settings.semanticDedup,judge:{...settings.semanticDedup.judge,prompt:effective("memory-judge.system")}}};
}

export function restorePromptDefault(settings:AppSettings,id:PromptId):AppSettings{
  return applyPromptOverride(settings,id,"");
}

export function restoreAllPromptDefaults(settings:AppSettings):AppSettings{
  return {
    ...settings,
    prompts:{
      ...settings.prompts,
      overrides:{},
      presets:[...settings.prompts.presets.filter(preset=>preset.id!=="default"),createDefaultPromptPreset()],
      activePresetId:"default"
    },
    memoryAgent:{...settings.memoryAgent,prompt:DEFAULT_AUTOMATIC_MEMORY_INSTRUCTIONS},
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


function normalizeTtsSettings(value:unknown):TtsSettings{
  if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("TTS settings must be an object.");
  const root=value as Record<string,unknown>;
  if(Object.keys(root).some(key=>!["enabled","activePresetId","presets","finishTimeoutMs","startTimeoutMs","segmentGapMs"].includes(key)))throw new Error("Unsupported TTS settings field.");
  if(typeof root.enabled!=="boolean")throw new Error("TTS enabled state must be boolean.");
  if(root.activePresetId!==null&&typeof root.activePresetId!=="string")throw new Error("TTS active preset id must be a string or null.");
  if(!Array.isArray(root.presets)||root.presets.length>32)throw new Error("TTS presets must be an array with at most 32 entries.");
  const presets:TtsPreset[]=root.presets.map((value,index)=>{
    if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("TTS preset "+index+" must be an object.");
    const preset=value as Record<string,unknown>;
    const allowed=["id","name","providerId","baseUrl","voiceProfileId","language","speed","credentialReference","providerOptions"];
    if(Object.keys(preset).some(key=>!allowed.includes(key)))throw new Error("Unsupported field in TTS preset "+index+".");
    let credentialReference:TtsPreset["credentialReference"]=null;
    if(preset.credentialReference!==null){
      if(!preset.credentialReference||typeof preset.credentialReference!=="object"||Array.isArray(preset.credentialReference))throw new Error("TTS credential reference must be an object or null.");
      const ref=preset.credentialReference as Record<string,unknown>;
      if(Object.keys(ref).some(key=>!["id","kind","provider","version"].includes(key)))throw new Error("Unsupported TTS credential reference field.");
      credentialReference={id:ref.id as string,kind:ref.kind as string,...(ref.provider===undefined?{}:{provider:ref.provider as string}),...(ref.version===undefined?{}:{version:ref.version as string})};
    }
    if(!preset.providerOptions||typeof preset.providerOptions!=="object"||Array.isArray(preset.providerOptions))throw new Error("TTS provider options must be an object.");
    return {id:preset.id as string,name:preset.name as string,providerId:preset.providerId as string,baseUrl:preset.baseUrl as string,voiceProfileId:preset.voiceProfileId as string,language:preset.language as string,speed:preset.speed as number,credentialReference,providerOptions:{...(preset.providerOptions as Record<string,unknown>)}};
  });
  return {
    enabled:root.enabled as boolean,
    activePresetId:root.activePresetId as string|null,
    finishTimeoutMs:typeof root.finishTimeoutMs==="number"?root.finishTimeoutMs:DEFAULT_TTS_SETTINGS.finishTimeoutMs,
    startTimeoutMs:typeof root.startTimeoutMs==="number"?root.startTimeoutMs:DEFAULT_TTS_SETTINGS.startTimeoutMs,
    segmentGapMs:typeof root.segmentGapMs==="number"?root.segmentGapMs:DEFAULT_TTS_SETTINGS.segmentGapMs,
    presets
  };
}

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
  if(!settings.prompts||typeof settings.prompts!=="object"||!settings.prompts.overrides||typeof settings.prompts.overrides!=="object"||Array.isArray(settings.prompts.overrides))errors.push("Prompt overrides must be an object.");
  else for(const [id,text] of Object.entries(settings.prompts.overrides)){
    if(!PROMPT_REGISTRY.some(definition=>definition.id===id))errors.push("Unsupported prompt id: "+id+".");
    if(typeof text!=="string"||Array.from(text).length>12000)errors.push("Prompt overrides must contain strings up to 12000 characters.");
  }
  if(!Array.isArray(settings.prompts?.presets)||settings.prompts.presets.length>64)errors.push("Prompt presets must be an array with at most 64 entries.");
  else {
    const presetIds=new Set<string>(); let foundBuiltin=false;
    for(const [presetIndex,preset] of settings.prompts.presets.entries()){
      if(!preset||typeof preset!=="object"||Array.isArray(preset)){errors.push("Prompt preset "+presetIndex+" must be an object.");continue;}
      if(typeof preset.id!=="string"||!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(preset.id))errors.push("Prompt preset id is invalid.");
      else if(presetIds.has(preset.id))errors.push("Prompt preset ids must be unique.");else presetIds.add(preset.id);
      if(typeof preset.name!=="string"||!preset.name.trim()||preset.name.length>100)errors.push("Prompt preset name must contain 1 to 100 characters.");
      if(typeof preset.description!=="string"||preset.description.length>2000)errors.push("Prompt preset description must be a string up to 2000 characters.");
      if(!Number.isInteger(preset.schemaVersion)||preset.schemaVersion<1)errors.push("Prompt preset schemaVersion must be a positive integer.");
      if(!Number.isInteger(preset.version)||preset.version<1)errors.push("Prompt preset version must be a positive integer.");
      if(typeof preset.isBuiltIn!=="boolean")errors.push("Prompt preset isBuiltIn must be boolean.");
      if(preset.id==="default"&&preset.isBuiltIn===true)foundBuiltin=true;
      if(preset.id==="default"&&preset.isBuiltIn!==true)errors.push("The Default prompt preset must remain marked built-in.");
      if(!Array.isArray(preset.prompts)||preset.prompts.length>128){errors.push("Prompt preset "+preset.id+" must contain at most 128 prompt records.");continue;}
      const promptIds=new Set<string>();
      for(const [promptIndex,prompt] of preset.prompts.entries()){
        if(!prompt||typeof prompt!=="object"||Array.isArray(prompt)){errors.push("Prompt record "+promptIndex+" in "+preset.id+" must be an object.");continue;}
        if(typeof prompt.id!=="string"||!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(prompt.id))errors.push("Prompt record id is invalid in "+preset.id+".");
        else if(promptIds.has(prompt.id))errors.push("Prompt record ids must be unique within "+preset.id+".");else promptIds.add(prompt.id);
        if(typeof prompt.title!=="string"||!prompt.title.trim()||prompt.title.length>120)errors.push("Prompt record title must contain 1 to 120 characters.");
        if(typeof prompt.text!=="string"||Array.from(prompt.text).length>12000)errors.push("Prompt record text must be a string up to 12000 characters.");
        if(typeof prompt.agentId!=="string"||!/^[a-z][a-z0-9._-]{0,79}$/.test(prompt.agentId))errors.push("Prompt record agentId must be a stable lowercase identifier.");
        if(typeof prompt.enabled!=="boolean")errors.push("Prompt record enabled must be boolean.");
        if(!Number.isInteger(prompt.order)||prompt.order < -100000||prompt.order > 100000)errors.push("Prompt record order must be an integer between -100000 and 100000.");
        if(prompt.category!==undefined&&(typeof prompt.category!=="string"||prompt.category.length>120))errors.push("Prompt record category must be a string up to 120 characters.");
        if(prompt.conditions!==undefined&&(!prompt.conditions||typeof prompt.conditions!=="object"||Array.isArray(prompt.conditions)))errors.push("Prompt record conditions must be an object.");
        else if(prompt.conditions?.scenarios!==undefined&&(!Array.isArray(prompt.conditions.scenarios)||prompt.conditions.scenarios.some((item:unknown)=>typeof item!=="string"||!item.trim()||item.length>80)))errors.push("Prompt record scenarios must be non-empty strings up to 80 characters.");
      }
    }
    if(!foundBuiltin)errors.push("The built-in Default prompt preset is required.");
    if(typeof settings.prompts.activePresetId!=="string"||!presetIds.has(settings.prompts.activePresetId))errors.push("The active prompt preset must reference an existing preset.");
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
  if(typeof settings.semanticDedup.judge.prompt!=="string"||Array.from(settings.semanticDedup.judge.prompt).length>12000)errors.push("Memory Judge prompt must be a string up to 12000 characters.");
  if(settings.semanticDedup.judge.promptBackup!==null&&(typeof settings.semanticDedup.judge.promptBackup!=="string"||Array.from(settings.semanticDedup.judge.promptBackup).length>12000))errors.push("Memory Judge prompt backup must be null or a string up to 12000 characters.");
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
  if(!["provider-default","enabled","disabled"].includes(settings.chat.reasoningMode))errors.push("Unsupported reasoning mode.");
  if(!["provider-default","low","medium","high"].includes(settings.chat.reasoningEffort))errors.push("Unsupported reasoning effort.");
  if(!["structured","plain"].includes(settings.chat.responseMode))errors.push("Unsupported Chat response mode.");
  if(!settings.memoryAgent||typeof settings.memoryAgent!="object")errors.push("Automatic Memory Agent settings must be an object.");
  else{
    const agent=settings.memoryAgent;
    if(typeof agent.enabled!=="boolean")errors.push("Automatic Memory Agent enabled state must be boolean.");
    if(agent.providerPresetId!==null&&(typeof agent.providerPresetId!=="string"||!agent.providerPresetId.trim()||agent.providerPresetId.length>200))errors.push("Automatic Memory Agent provider preset must be empty or a bounded id.");
    if(typeof agent.model!=="string"||agent.model.length>200)errors.push("Automatic Memory Agent model must be a string up to 200 characters.");
    if(!["auto","structured","plain"].includes(agent.outputMode))errors.push("Unsupported Automatic Memory Agent output mode.");
    if(typeof agent.prompt!=="string"||Array.from(agent.prompt).length>12000)errors.push("Automatic Memory Agent prompt must be a string up to 12000 characters.");
    if(agent.promptBackup!==null&&(typeof agent.promptBackup!=="string"||Array.from(agent.promptBackup).length>12000))errors.push("Automatic Memory Agent prompt backup must be null or a string up to 12000 characters.");
    if(typeof agent.defaultPromptVersion!=="string"||!agent.defaultPromptVersion.trim())errors.push("Automatic Memory Agent prompt version must be a non-empty string.");
  }
  if(typeof settings.ui.showDiagnosticsInChat!=="boolean")errors.push("Chat diagnostics visibility must be boolean.");
  if(typeof settings.ui.showReasoningInDiagnostics!=="boolean")errors.push("Reasoning diagnostics visibility must be boolean.");

  const tts=settings.tts;
  if(!tts||typeof tts!=="object"||!Array.isArray(tts.presets))errors.push("TTS settings must contain a preset array.");
  else{
    if(typeof tts.enabled!=="boolean")errors.push("TTS enabled state must be boolean.");
    integer(tts.finishTimeoutMs,"TTS maximum turn duration",10_000,600_000);
    integer(tts.startTimeoutMs,"TTS initial audio timeout",1_000,60_000);
    integer(tts.segmentGapMs,"TTS segment gap",0,5_000);
    if(tts.presets.length>32)errors.push("At most 32 TTS presets are allowed.");
    const ids=new Set<string>();
    for(const [index,preset] of tts.presets.entries()){
      if(!preset||typeof preset!=="object"){errors.push("TTS preset "+index+" must be an object.");continue;}
      if(typeof preset.id!=="string"||!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(preset.id))errors.push("TTS preset id is invalid.");
      else if(ids.has(preset.id))errors.push("TTS preset ids must be unique."); else ids.add(preset.id);
      if(typeof preset.name!=="string"||preset.name.trim().length===0||preset.name.length>100)errors.push("TTS preset name must contain 1 to 100 characters.");
      if(typeof preset.providerId!=="string"||!/^[a-z][a-z0-9-]{0,79}$/.test(preset.providerId))errors.push("TTS provider id is invalid.");
      if(typeof preset.baseUrl!=="string"||preset.baseUrl.length>1024)errors.push("TTS base URL must be a string up to 1024 characters.");
      if(typeof preset.voiceProfileId!=="string"||preset.voiceProfileId.length>256)errors.push("TTS voice/profile id must be a string up to 256 characters.");
      if(typeof preset.language!=="string"||!/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(preset.language))errors.push("TTS language must be a language tag.");
      if(typeof preset.speed!=="number"||!Number.isFinite(preset.speed)||preset.speed<0.5||preset.speed>2)errors.push("TTS speed must be between 0.5 and 2.");
      const credential=preset.credentialReference;
      if(credential!==null){
        if(!credential||typeof credential!=="object"||typeof credential.id!=="string"||!credential.id.trim()||credential.id.length>200||typeof credential.kind!=="string"||!credential.kind.trim()||credential.kind.length>80)errors.push("TTS credential references must use non-empty bounded ids and kinds.");
        if(credential&&typeof credential==="object"&&Object.keys(credential).some(key=>!["id","kind","provider","version"].includes(key)))errors.push("Unsupported TTS credential reference field.");
      }
      const options=preset.providerOptions;
      if(!options||typeof options!=="object"||Array.isArray(options)||Object.keys(options).length>32)errors.push("TTS provider options must be an object with at most 32 fields.");
      else for(const [key,value] of Object.entries(options)){
        if(!/^[a-zA-Z][a-zA-Z0-9._-]{0,79}$/.test(key)||/(secret|token|password|api.?key|credential)/i.test(key))errors.push("TTS provider options must not contain secrets or invalid keys.");
        if(value!==null&&!["string","number","boolean"].includes(typeof value))errors.push("TTS provider option values must be scalar.");
        if(typeof value==="string"&&value.length>1000)errors.push("TTS provider option values are limited to 1000 characters.");
        if(typeof value==="number"&&!Number.isFinite(value))errors.push("TTS provider option numbers must be finite.");
      }
    }
    if(tts.activePresetId!==null&&(typeof tts.activePresetId!=="string"||!ids.has(tts.activePresetId)))errors.push("TTS active preset must reference an existing preset or be null.");
  }

  return errors;
}

export function migrateAppSettings(value:unknown):AppSettings{
  const defaults=defaultAppSettings();
  if(!value||typeof value!=="object")return defaults;
  const input=value as Record<string,unknown>;
  const legacy=input.schemaVersion==="0"||input.schemaVersion===undefined||input.schemaVersion==="1";
  if(input.apiVersion!==undefined&&input.apiVersion!=="1"&&!legacy)throw new Error("Unsupported AppSettings apiVersion.");
  if(input.schemaVersion!==undefined&&!["0","1","2","3","4","5","6","7","8","9","10","11","12","13","14","15"].includes(String(input.schemaVersion)))throw new Error("Unsupported AppSettings schemaVersion.");
  const root=value as Record<string,any>;
  const context=root.context&&typeof root.context==="object"?root.context:{};
  const memory=root.memory&&typeof root.memory==="object"?root.memory:{};
  const retrieval=root.retrieval&&typeof root.retrieval==="object"?root.retrieval:{};
  const diagnostics=root.diagnostics&&typeof root.diagnostics==="object"?root.diagnostics:{};
  const chat=root.chat&&typeof root.chat==="object"?root.chat:{};
  const storedMemoryAgent=root.memoryAgent&&typeof root.memoryAgent==="object"?root.memoryAgent:{};
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
  const memoryAgentEnabled=typeof storedMemoryAgent.enabled==="boolean"?storedMemoryAgent.enabled:legacyEnabled;
  // Preserve the legacy global memory-save gate independently of the dedicated agent flag.
  // This prevents migration from silently re-enabling memory saving when the user disabled it.
  const chatAutomaticMemoryEnabled=legacyEnabled;
  const memoryAgentPreset=typeof storedMemoryAgent.providerPresetId==="string"&&storedMemoryAgent.providerPresetId.trim()?storedMemoryAgent.providerPresetId.trim():null;
  const memoryAgentModel=typeof storedMemoryAgent.model==="string"?storedMemoryAgent.model.trim():"";
  const memoryAgentOutputMode=["auto","structured","plain"].includes(storedMemoryAgent.outputMode)?storedMemoryAgent.outputMode:defaults.memoryAgent.outputMode;
  const memoryAgentPromptRaw=typeof storedMemoryAgent.prompt==="string"?storedMemoryAgent.prompt:(typeof storedMemoryAgent.instructions==="string"?storedMemoryAgent.instructions:defaults.memoryAgent.prompt);
  const memoryAgentPrompt=memoryAgentPromptRaw.trim()?memoryAgentPromptRaw.slice(0,12000):defaults.memoryAgent.prompt;
  const memoryAgentBackup=typeof storedMemoryAgent.promptBackup==="string"&&storedMemoryAgent.promptBackup.length?storedMemoryAgent.promptBackup.slice(0,12000):null;
  const memoryAgentPromptVersion=typeof storedMemoryAgent.defaultPromptVersion==="string"&&storedMemoryAgent.defaultPromptVersion.trim()?storedMemoryAgent.defaultPromptVersion.trim():DEFAULT_AUTOMATIC_MEMORY_PROMPT_VERSION;
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
  const previousBuiltInJudgePrompt="You are a memory deduplication judge.\n\nCompare NEW MEMORY with CANDIDATES.\n\nKeep the most complete and informative record.\n\nIf NEW MEMORY is less informative because its information is contained in a candidate, archive NEW.\n\nIf a candidate is less informative because its information is contained in NEW MEMORY, archive that candidate number.\n\nIf records contain essentially the same information, archive one duplicate.\n\nIf records contain different useful information, archive nothing.\n\nYour decision is the list of archive targets.\n\nIn structured mode, return only:\n{\"archive\":[\"NEW\",\"1\",\"2\"]}\n\nIn plain mode, return only:\nNO_ARCHIVE\nor NEW / candidate numbers, one per line.\n\nNever return explanations.\nNever invent candidate numbers.";
  const semanticJudgePromptIsLegacyDefault=(storedSemanticJudgePrompt===LEGACY_MEMORY_JUDGE_PROMPT&&semanticJudge.defaultPromptVersion==="1")||(storedSemanticJudgePrompt===previousBuiltInJudgePrompt&&semanticJudge.defaultPromptVersion==="2");
  const promptSettings=root.prompts&&typeof root.prompts==="object"?root.prompts:{};
  const rawPromptOverrides=promptSettings.overrides&&typeof promptSettings.overrides==="object"&&!Array.isArray(promptSettings.overrides)?promptSettings.overrides as Record<string,unknown>:{};
  const hadPresetConfiguration=String(input.schemaVersion)==="15"&&Array.isArray(promptSettings.presets);
  const promptOverrides:PromptOverrides={};
  for(const [key,rawText] of Object.entries(rawPromptOverrides)){
    if(!PROMPT_REGISTRY.some(definition=>definition.id===key))throw new Error("Unsupported prompt id: "+key+".");
    if(typeof rawText!=="string"||Array.from(rawText).length>12000)throw new Error("Prompt override must be a string up to 12000 characters.");
    if(rawText.trim().length>0)(promptOverrides as Record<string,string>)[key]=rawText;
  }
  const migratedLegacyJudgePrompt=semanticJudgePromptIsLegacyDefault
    ?DEFAULT_MEMORY_JUDGE_PROMPT
    :(storedSemanticJudgePrompt.trim()||semanticJudgeLegacyPrompt||DEFAULT_MEMORY_JUDGE_PROMPT);
  const hasJudgeOverrideSetting=Object.prototype.hasOwnProperty.call(rawPromptOverrides,"memory-judge.system");
  if(!hadPresetConfiguration&&!hasJudgeOverrideSetting&&!promptOverrides["memory-judge.system"]&&migratedLegacyJudgePrompt!==DEFAULT_MEMORY_JUDGE_PROMPT){
    promptOverrides["memory-judge.system"]=migratedLegacyJudgePrompt;
  }
  const semanticJudgePrompt=resolvePromptText({overrides:promptOverrides},"memory-judge.system");
  const semanticJudgeBackup=typeof semanticJudge.promptBackup==="string"&&semanticJudge.promptBackup.length>0?semanticJudge.promptBackup:null;
  const semanticJudgeVersion=semanticJudgePromptIsLegacyDefault?DEFAULT_MEMORY_JUDGE_PROMPT_VERSION:(typeof semanticJudge.defaultPromptVersion==="string"&&semanticJudge.defaultPromptVersion.trim()?semanticJudge.defaultPromptVersion.trim():DEFAULT_MEMORY_JUDGE_PROMPT_VERSION);
  const hasMemoryAgentPromptOverride=Object.prototype.hasOwnProperty.call(rawPromptOverrides,"memory-agent.system");
  if(!hadPresetConfiguration&&!hasMemoryAgentPromptOverride&&memoryAgentPrompt!==DEFAULT_AUTOMATIC_MEMORY_INSTRUCTIONS){
    promptOverrides["memory-agent.system"]=memoryAgentPrompt;
  }
  const effectiveMemoryAgentPrompt=resolvePromptText({overrides:promptOverrides},"memory-agent.system");
  const rawPresetValues=Array.isArray(promptSettings.presets)?promptSettings.presets as PromptPreset[]:[];
  let presets:PromptPreset[]=rawPresetValues.length?rawPresetValues.slice():[createDefaultPromptConfiguration(promptOverrides).presets[0]!];
  const builtinDefault=presets.find(preset=>preset.id==="default"&&preset.isBuiltIn===true&&Array.isArray(preset.prompts));
  if(!builtinDefault){presets=presets.filter(preset=>preset.id!=="default");presets.unshift(createDefaultPromptPreset());}
  const activePresetValue=typeof promptSettings.activePresetId==="string"?promptSettings.activePresetId:"default";
  const activePresetId=presets.some(preset=>preset.id===activePresetValue)?activePresetValue:"default";
  const normalizedPrompts:PromptConfiguration={...promptSettings,overrides:promptOverrides,presets,activePresetId};
  const next:AppSettings={
    apiVersion:"1",schemaVersion:"15",
    cognitiveSchedule:{
      mode:typeof cognitiveSchedule.mode==="string"?cognitiveSchedule.mode as CognitiveScheduleMode:defaults.cognitiveSchedule.mode,
      defaultIntervalMs:typeof cognitiveSchedule.defaultIntervalMs==="number"?cognitiveSchedule.defaultIntervalMs:defaults.cognitiveSchedule.defaultIntervalMs,
      minIntervalMs:migratedMinimumInterval,
      maxIntervalMs:migratedMaximumInterval,
      maxRequestsPerHour:typeof cognitiveSchedule.maxRequestsPerHour==="number"?(String(input.schemaVersion)!=="10"&&String(input.schemaVersion)!=="11"&&String(input.schemaVersion)!=="12"&&cognitiveSchedule.maxRequestsPerHour===120?null:cognitiveSchedule.maxRequestsPerHour):null
    },
    chat:{automaticLongTermMemory:chatAutomaticMemoryEnabled,responseMode:chat.responseMode==="plain"?"plain":"structured",reasoningMode:["provider-default","enabled","disabled"].includes(chat.reasoningMode)?chat.reasoningMode:defaults.chat.reasoningMode,reasoningEffort:["provider-default","low","medium","high"].includes(chat.reasoningEffort)?chat.reasoningEffort:"provider-default"},
    memoryAgent:{enabled:memoryAgentEnabled,providerPresetId:memoryAgentPreset,model:memoryAgentModel,outputMode:memoryAgentOutputMode,prompt:effectiveMemoryAgentPrompt,promptBackup:memoryAgentBackup,defaultPromptVersion:memoryAgentPromptVersion},
    prompts:normalizedPrompts,
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
    ui:{showDiagnosticsInChat:typeof ui.showDiagnosticsInChat==="boolean"?ui.showDiagnosticsInChat:defaults.ui.showDiagnosticsInChat,showReasoningInDiagnostics:typeof ui.showReasoningInDiagnostics==="boolean"?ui.showReasoningInDiagnostics:defaults.ui.showReasoningInDiagnostics},
    tts:["13","14","15"].includes(String(input.schemaVersion))?normalizeTtsSettings(root.tts):cloneTtsSettings(defaults.tts)
  };
  const errors=validateAppSettings(next);
  if(errors.length>0)throw new Error("Invalid AppSettings: "+errors.join(" "));
  return next;
}

export interface AppSettingsStore{
  load():Promise<AppSettings|undefined>;
  save(settings:AppSettings):Promise<void>;
}
