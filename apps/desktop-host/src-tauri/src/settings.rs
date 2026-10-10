use serde::{Deserialize,Serialize};
use std::collections::BTreeMap;
use serde_json::Value;
use std::{fs,io::Write,path::{Path,PathBuf}};
use tauri::Manager;

const API_VERSION:&str="1";
const SCHEMA_VERSION:&str="12";
const FILE_NAME:&str="app-settings-v1.json";
const LEGACY_SCHEMA_VERSION:&str="0";
const PREVIOUS_SCHEMA_VERSION:&str="3";
const LEGACY_MEMORY_AGENT_SCHEMA_VERSION:&str="2";
const LEGACY_PREVIOUS_SCHEMA_VERSION:&str="1";
const MAX_CONTEXT_TOKENS:i64=32768;
const MAX_RESERVED_OUTPUT:i64=16384;
const MAX_SAFETY_MARGIN:i64=4096;
const MAX_RECENT_MESSAGES:i64=100;
const MAX_MEMORY_CANDIDATES:i64=100;
const MAX_RETRIEVAL_CANDIDATES:i64=100;
const MAX_SEMANTIC_CANDIDATES:i64=100;
const MAX_SEMANTIC_SEARCH_RESULTS:i64=20;
const MAX_SEMANTIC_PROMPT:usize=12000;
const MAX_DIAGNOSTICS_ENTRIES:i64=500;
const MAX_MEMORY_AGENT_PROMPT:usize=12000;
const DEFAULT_MEMORY_AGENT_PROMPT_VERSION:&str="1";
const DEFAULT_AUTOMATIC_MEMORY_INSTRUCTIONS:&str="You are a long-term memory agent.\nDecide whether the exchange contains durable information worth remembering after this conversation ends.\nReturn only the requested output.\nGood memories are brief, self-contained, durable, and understandable without the original conversation.\nDo not invent ids or metadata; the application supplies all internal state.";
const DEFAULT_MEMORY_JUDGE_PROMPT_VERSION:&str="2";
const DEFAULT_MEMORY_JUDGE_INSTRUCTIONS:&str="You are a memory deduplication judge.\n\nCompare NEW MEMORY with CANDIDATES.\n\nKeep the most complete and informative record.\n\nIf NEW MEMORY is less informative because its information is contained in a candidate, archive NEW.\n\nIf a candidate is less informative because its information is contained in NEW MEMORY, archive that candidate number.\n\nIf records contain essentially the same information, archive one duplicate.\n\nIf records contain different useful information, archive nothing.\n\nYour decision is the list of archive targets.\n\nIn structured mode, return only:\n{\"archive\":[\"NEW\",\"1\",\"2\"]}\n\nIn plain mode, return only:\nNO_ARCHIVE\nor NEW / candidate numbers, one per line.\n\nNever return explanations.\nNever invent candidate numbers.";
const LEGACY_MEMORY_JUDGE_INSTRUCTIONS:&str="You are a memory deduplication judge.\n\nCompare NEW MEMORY with CANDIDATES.\n\nKeep the most complete and informative record.\n\nIf NEW MEMORY is less informative because its information is contained in a candidate, return NEW.\n\nIf a candidate contains all meaningful information from NEW MEMORY and adds useful information, return that candidate number.\n\nIf two records contain essentially the same information, return one of them.\n\nIf records contain different useful information, return NO_ARCHIVE.\n\nReturn only:\nNO_ARCHIVE,\nNEW,\nor candidate numbers, one per line.\n\nNever return explanations or text.\nNever invent candidate numbers.";

fn default_response_mode()->String{"structured".into()}
#[derive(Debug,Deserialize,Serialize,Clone)]
#[serde(deny_unknown_fields)]
pub struct ChatSettings{
    #[serde(rename="automaticLongTermMemory")]
    pub automatic_long_term_memory:bool,
    #[serde(rename="responseMode",default="default_response_mode")]
    pub response_mode:String
}
fn default_cognitive_schedule()->CognitiveScheduleSettings{
    CognitiveScheduleSettings{mode:"adaptive".into(),default_interval_ms:30000,min_interval_ms:3000,max_interval_ms:300000,max_requests_per_hour:None}
}
#[derive(Debug,Deserialize,Serialize,Clone)]
#[serde(deny_unknown_fields)]
pub struct CognitiveScheduleSettings{
    pub mode:String,
    #[serde(rename="defaultIntervalMs")]
    pub default_interval_ms:i64,
    #[serde(rename="minIntervalMs")]
    pub min_interval_ms:i64,
    #[serde(rename="maxIntervalMs")]
    pub max_interval_ms:i64,
    #[serde(rename="maxRequestsPerHour",default)]
    pub max_requests_per_hour:Option<i64>
}
#[derive(Debug,Deserialize,Serialize,Clone)]
#[serde(deny_unknown_fields)]
pub struct MemoryAgentSettings{
    pub enabled:bool,
    #[serde(rename="providerPresetId")]
    pub provider_preset_id:Option<String>,
    pub model:String,
    #[serde(rename="outputMode")]
    pub output_mode:String,
    pub prompt:String,
    #[serde(rename="promptBackup")]
    pub prompt_backup:Option<String>,
    #[serde(rename="defaultPromptVersion")]
    pub default_prompt_version:String
}
fn default_memory_agent_settings()->MemoryAgentSettings{
    MemoryAgentSettings{enabled:true,provider_preset_id:None,model:String::new(),output_mode:"auto".into(),prompt:DEFAULT_AUTOMATIC_MEMORY_INSTRUCTIONS.to_string(),prompt_backup:None,default_prompt_version:DEFAULT_MEMORY_AGENT_PROMPT_VERSION.into()}
}
#[derive(Debug,Deserialize,Serialize,Clone,Default)]
#[serde(deny_unknown_fields)]
pub struct PromptSettings{
    #[serde(default)]
    pub overrides:BTreeMap<String,String>
}
#[derive(Debug,Deserialize,Serialize,Clone)]
#[serde(deny_unknown_fields)]
pub struct MemoryJudgeSettings{
    pub enabled:bool,
    #[serde(rename="providerPresetId")]
    pub provider_preset_id:Option<String>,
    pub model:String,
    #[serde(rename="outputMode")]
    pub output_mode:String,
    pub prompt:String,
    #[serde(rename="promptBackup")]
    pub prompt_backup:Option<String>,
    #[serde(rename="defaultPromptVersion")]
    pub default_prompt_version:String
}
#[derive(Debug,Deserialize,Serialize,Clone)]
#[serde(deny_unknown_fields)]
pub struct SemanticDedupSettings{
    pub enabled:bool,
    #[serde(rename="embeddingProviderPresetId")]
    pub embedding_provider_preset_id:Option<String>,
    #[serde(rename="embeddingModel")]
    pub embedding_model:String,
    #[serde(rename="candidateSimilarityThreshold")]
    pub candidate_similarity_threshold:f64,
    #[serde(rename="candidateLimit")]
    pub candidate_limit:i64,
    pub judge:MemoryJudgeSettings
}
#[derive(Debug,Deserialize,Serialize,Clone)]
#[serde(deny_unknown_fields)]
pub struct ContextSettings{
    #[serde(rename="availableContextTokens")]
    pub available_context_tokens:i64,
    #[serde(rename="reservedOutputTokens")]
    pub reserved_output_tokens:i64,
    #[serde(rename="safetyMarginTokens")]
    pub safety_margin_tokens:i64,
    #[serde(rename="recentConversationMessages")]
    pub recent_conversation_messages:i64
}
#[derive(Debug,Deserialize,Serialize,Clone)]
#[serde(deny_unknown_fields)]
pub struct MemorySettings{
    #[serde(rename="candidateLimit")]
    pub candidate_limit:i64
}
#[derive(Debug,Deserialize,Serialize,Clone)]
#[serde(deny_unknown_fields)]
pub struct RetrievalSettings{
    #[serde(rename="candidateLimit")]
    pub candidate_limit:i64,
    #[serde(rename="semanticSearchEnabled",default)]
    pub semantic_search_enabled:bool,
    #[serde(rename="semanticSimilarityThreshold",default="default_semantic_similarity_threshold")]
    pub semantic_similarity_threshold:f64,
    #[serde(rename="semanticResultLimit",default="default_semantic_result_limit")]
    pub semantic_result_limit:i64
}
fn default_semantic_similarity_threshold()->f64{0.35}
fn default_semantic_result_limit()->i64{5}
#[derive(Debug,Deserialize,Serialize,Clone)]
#[serde(deny_unknown_fields)]
pub struct DiagnosticsSettings{
    #[serde(rename="logLevel")]
    pub log_level:String,
    #[serde(rename="keepRecentEntries")]
    pub keep_recent_entries:i64
}
#[derive(Debug,Deserialize,Serialize,Clone)]
#[serde(deny_unknown_fields)]
pub struct UiSettings{
    #[serde(rename="showDiagnosticsInChat")]
    pub show_diagnostics_in_chat:bool
}
#[derive(Debug,Deserialize,Serialize,Clone)]
#[serde(deny_unknown_fields)]
pub struct AppSettings{
    #[serde(rename="apiVersion")]
    pub api_version:String,
    #[serde(rename="schemaVersion")]
    pub schema_version:String,
    #[serde(rename="cognitiveSchedule",default="default_cognitive_schedule")]
    pub cognitive_schedule:CognitiveScheduleSettings,
    pub chat:ChatSettings,
    #[serde(rename="memoryAgent",default="default_memory_agent_settings")]
    pub memory_agent:MemoryAgentSettings,
    #[serde(default)]
    pub prompts:PromptSettings,
    #[serde(rename="semanticDedup")]
    pub semantic_dedup:SemanticDedupSettings,
    pub context:ContextSettings,
    pub memory:MemorySettings,
    pub retrieval:RetrievalSettings,
    pub diagnostics:DiagnosticsSettings,
    pub ui:UiSettings
}

fn default_settings()->AppSettings{
    AppSettings{
        api_version:API_VERSION.into(),schema_version:SCHEMA_VERSION.into(),
        cognitive_schedule:default_cognitive_schedule(),
        chat:ChatSettings{automatic_long_term_memory:true,response_mode:default_response_mode()},
        prompts:PromptSettings::default(),
        memory_agent:MemoryAgentSettings{enabled:true,provider_preset_id:None,model:String::new(),output_mode:"auto".into(),prompt:DEFAULT_AUTOMATIC_MEMORY_INSTRUCTIONS.to_string(),prompt_backup:None,default_prompt_version:DEFAULT_MEMORY_AGENT_PROMPT_VERSION.into()},
        semantic_dedup:SemanticDedupSettings{
            enabled:false,embedding_provider_preset_id:None,embedding_model:String::new(),
            candidate_similarity_threshold:0.88,candidate_limit:5,
            judge:MemoryJudgeSettings{
                enabled:true,provider_preset_id:None,model:String::new(),output_mode:"auto".into(),
                prompt:DEFAULT_MEMORY_JUDGE_INSTRUCTIONS.to_string(),prompt_backup:None,default_prompt_version:DEFAULT_MEMORY_JUDGE_PROMPT_VERSION.into()
            }
        },
        context:ContextSettings{available_context_tokens:4096,reserved_output_tokens:1024,safety_margin_tokens:128,recent_conversation_messages:8},
        memory:MemorySettings{candidate_limit:8},
        retrieval:RetrievalSettings{candidate_limit:32,semantic_search_enabled:false,semantic_similarity_threshold:0.35,semantic_result_limit:5},
        diagnostics:DiagnosticsSettings{log_level:"normal".into(),keep_recent_entries:100},
        ui:UiSettings{show_diagnostics_in_chat:true}
    }
}

fn config_dir(app:&tauri::AppHandle)->Result<PathBuf,String>{
    let directory=app.path().app_config_dir().map_err(|e|format!("failed to resolve app config directory: {e}"))?;
    fs::create_dir_all(&directory).map_err(|e|format!("failed to create app config directory: {e}"))?;
    Ok(directory)
}
pub fn config_path(app:&tauri::AppHandle)->Result<PathBuf,String>{Ok(config_dir(app)?.join(FILE_NAME))}
fn valid_integer(value:i64,min:i64,max:i64,label:&str)->Result<(),String>{
    if value<min||value>max{return Err(format!("{label} must be between {min} and {max}."));}
    Ok(())
}
fn validate(settings:&AppSettings)->Result<(),String>{
    if settings.api_version!=API_VERSION||!(settings.schema_version==SCHEMA_VERSION||matches!(settings.schema_version.as_str(),"5"|"6"|"7"|"8"|"9"|"10"|"11")){return Err("unsupported AppSettings version".into());}
    if !matches!(settings.cognitive_schedule.mode.as_str(),"adaptive"|"fixed"){return Err("Unsupported cognitive schedule mode.".into());}
    valid_integer(settings.cognitive_schedule.default_interval_ms,1000,3_600_000,"Cognitive schedule interval")?;
    valid_integer(settings.cognitive_schedule.min_interval_ms,1000,3_600_000,"Minimum cognitive interval")?;
    valid_integer(settings.cognitive_schedule.max_interval_ms,1000,3_600_000,"Maximum cognitive interval")?;
    if settings.cognitive_schedule.min_interval_ms>settings.cognitive_schedule.default_interval_ms||settings.cognitive_schedule.default_interval_ms>settings.cognitive_schedule.max_interval_ms{return Err("Cognitive schedule interval bounds are inconsistent.".into());}
    if let Some(limit)=settings.cognitive_schedule.max_requests_per_hour{valid_integer(limit,1,3_600,"Cognitive requests per hour")?;}
    if !matches!(settings.chat.response_mode.as_str(),"structured"|"plain"){return Err("Unsupported Chat response mode.".into());}
    valid_integer(settings.context.available_context_tokens,256,MAX_CONTEXT_TOKENS,"Context size")?;
    valid_integer(settings.context.reserved_output_tokens,0,MAX_RESERVED_OUTPUT,"Reserved response tokens")?;
    valid_integer(settings.context.safety_margin_tokens,0,MAX_SAFETY_MARGIN,"Safety margin")?;
    valid_integer(settings.context.recent_conversation_messages,1,MAX_RECENT_MESSAGES,"Recent messages")?;
    valid_integer(settings.memory.candidate_limit,1,MAX_MEMORY_CANDIDATES,"Memory items")?;
    valid_integer(settings.retrieval.candidate_limit,1,MAX_RETRIEVAL_CANDIDATES,"Retrieval candidates")?;
    valid_integer(settings.retrieval.semantic_result_limit,1,MAX_SEMANTIC_SEARCH_RESULTS,"Semantic search results")?;
    if !settings.retrieval.semantic_similarity_threshold.is_finite()||!(0.0..=1.0).contains(&settings.retrieval.semantic_similarity_threshold){return Err("Semantic cosine similarity threshold must be between 0 and 1.".into());}
    valid_integer(settings.semantic_dedup.candidate_limit,1,MAX_SEMANTIC_CANDIDATES,"Semantic candidate items")?;
    if !settings.semantic_dedup.candidate_similarity_threshold.is_finite()||!(0.0..=1.0).contains(&settings.semantic_dedup.candidate_similarity_threshold){return Err("Semantic candidate similarity threshold must be between 0 and 1.".into());}
    if settings.semantic_dedup.embedding_model.len()>200{return Err("Semantic embedding model exceeds the 200 character limit.".into());}
    if !matches!(settings.semantic_dedup.judge.output_mode.as_str(),"auto"|"structured"|"plain"){return Err("Unsupported Memory Judge output mode".into());}
    if settings.semantic_dedup.judge.prompt.chars().count()>MAX_SEMANTIC_PROMPT{return Err("Memory Judge prompt exceeds the 12000 character limit.".into());}
    if settings.semantic_dedup.judge.prompt_backup.as_ref().map(|value|value.chars().count()>MAX_SEMANTIC_PROMPT).unwrap_or(false){return Err("Memory Judge prompt backup exceeds the 12000 character limit.".into());}
    if settings.semantic_dedup.judge.default_prompt_version.trim().is_empty(){return Err("Memory Judge default prompt version must not be empty.".into());}
    const PROMPT_IDS:[&str;13]=["nova-system-json","nova-system-tagged","nova-system-plain","nova-cue-reactive-json","nova-cue-background-json","nova-cue-reactive-tagged","nova-cue-background-tagged","nova-cue-reactive-plain","nova-cue-background-plain","nova-schedule-structured","nova-schedule-plain","nova-tools-allowlist","memory-judge.system"];
    for (id,prompt) in &settings.prompts.overrides{
        if !PROMPT_IDS.contains(&id.as_str()){return Err(format!("Unsupported prompt id: {id}."));}
        if prompt.chars().count()>MAX_SEMANTIC_PROMPT{return Err(format!("Prompt override {id} exceeds the 12000 character limit."));}
    }
    if !matches!(settings.diagnostics.log_level.as_str(),"off"|"errors"|"normal"|"verbose"|"debug"){return Err("Unsupported diagnostics log level".into());}
    valid_integer(settings.diagnostics.keep_recent_entries,1,MAX_DIAGNOSTICS_ENTRIES,"Recent diagnostic entries")?;
    if !matches!(settings.memory_agent.output_mode.as_str(),"auto"|"structured"|"plain"){return Err("Unsupported Automatic Memory Agent output mode".into());}
    if settings.memory_agent.prompt.chars().count()>MAX_MEMORY_AGENT_PROMPT{return Err("Automatic Memory Agent prompt exceeds the 12000 character limit.".into());}
    if settings.memory_agent.prompt_backup.as_ref().map(|value|value.chars().count()>MAX_MEMORY_AGENT_PROMPT).unwrap_or(false){return Err("Automatic Memory Agent prompt backup exceeds the 12000 character limit.".into());}
    if settings.memory_agent.default_prompt_version.trim().is_empty(){return Err("Automatic Memory Agent default prompt version must not be empty.".into());}
    Ok(())
}

// Migrate only the persisted v5 built-in Judge prompt; custom prompts remain untouched.
fn migrate_memory_judge_default_prompt(root:&mut serde_json::Map<String,Value>)->bool{
    let Some(semantic_dedup)=root.get_mut("semanticDedup").and_then(Value::as_object_mut) else{return false};
    let Some(judge)=semantic_dedup.get_mut("judge").and_then(Value::as_object_mut) else{return false};
    let is_legacy=judge.get("prompt").and_then(Value::as_str)==Some(LEGACY_MEMORY_JUDGE_INSTRUCTIONS)
        &&judge.get("defaultPromptVersion").and_then(Value::as_str)==Some("1");
    if !is_legacy{return false}
    judge.insert("prompt".into(),Value::String(DEFAULT_MEMORY_JUDGE_INSTRUCTIONS.into()));
    judge.insert("defaultPromptVersion".into(),Value::String(DEFAULT_MEMORY_JUDGE_PROMPT_VERSION.into()));
    true
}

fn legacy_memory_agent_enabled(root:&serde_json::Map<String,Value>)->bool{
    root.get("chat").and_then(Value::as_object)
        .and_then(|chat|chat.get("automaticLongTermMemory")).and_then(Value::as_bool).unwrap_or(true)
}
fn legacy_memory_agent_value(enabled:bool)->Value{
    serde_json::json!({
        "enabled":enabled,
        "providerPresetId":null,
        "model":"",
        "outputMode":"auto",
        "prompt":DEFAULT_AUTOMATIC_MEMORY_INSTRUCTIONS,
        "promptBackup":null,
        "defaultPromptVersion":DEFAULT_MEMORY_AGENT_PROMPT_VERSION
    })
}
fn migrate_memory_agent_object(root:&mut serde_json::Map<String,Value>){
    if let Some(memory_agent)=root.get_mut("memoryAgent").and_then(Value::as_object_mut){
        if memory_agent.get("prompt").is_none(){
            if let Some(instructions)=memory_agent.remove("instructions"){
                memory_agent.insert("prompt".into(),instructions);
            }else{
                memory_agent.insert("prompt".into(),Value::String(DEFAULT_AUTOMATIC_MEMORY_INSTRUCTIONS.into()));
            }
        }else{memory_agent.remove("instructions");}
        memory_agent.entry("promptBackup").or_insert(Value::Null);
        memory_agent.entry("defaultPromptVersion").or_insert_with(||Value::String(DEFAULT_MEMORY_AGENT_PROMPT_VERSION.into()));
        memory_agent.entry("outputMode").or_insert_with(||Value::String("auto".into()));
    }
}

fn migrate(value:Value)->Result<(AppSettings,bool),String>{
    let schema=value.get("schemaVersion").and_then(Value::as_str);
    let legacy=schema.map(|v|v==LEGACY_SCHEMA_VERSION).unwrap_or(true);
    if schema==Some("1"){
        let defaults=default_settings();
        let mut normalized=value.clone();
        if let Some(root)=normalized.as_object_mut(){
            root.insert("schemaVersion".into(),Value::String(SCHEMA_VERSION.into()));
            root.entry("semanticDedup".into()).or_insert(serde_json::to_value(&defaults.semantic_dedup).map_err(|e|format!("failed to encode semantic dedup defaults: {e}"))?);
            root.entry("cognitiveSchedule".into()).or_insert(serde_json::to_value(&defaults.cognitive_schedule).map_err(|e|format!("failed to encode cognitive schedule defaults: {e}"))?);
            if root.get("memoryAgent").is_none(){
                root.insert("memoryAgent".into(),legacy_memory_agent_value(legacy_memory_agent_enabled(root)));
            }else{
                migrate_memory_agent_object(root);
            }
            root.entry("prompts".into()).or_insert_with(||serde_json::json!({"overrides":{}}));
        }
        let settings:AppSettings=serde_json::from_value(normalized).map_err(|e|format!("invalid AppSettings schema v1: {e}"))?;
        validate(&settings)?;
        return Ok((settings,true));
    }
    if schema==Some("4"){
        let mut normalized=value.clone();
        if let Some(root)=normalized.as_object_mut(){
            root.insert("schemaVersion".into(),Value::String(SCHEMA_VERSION.into()));
            root.insert("semanticDedup".into(),serde_json::to_value(&default_settings().semantic_dedup).map_err(|e|format!("failed to encode semantic dedup defaults: {e}"))?);
        }
        let settings:AppSettings=serde_json::from_value(normalized).map_err(|e|format!("invalid AppSettings schema v4: {e}"))?;
        validate(&settings)?;
        return Ok((settings,true));
    }
    if schema==Some("3"){
        let mut normalized=value.clone();
        if let Some(root)=normalized.as_object_mut(){
            root.insert("schemaVersion".into(),Value::String(SCHEMA_VERSION.into()));
            migrate_memory_agent_object(root);
            if !root.contains_key("semanticDedup"){
                root.insert("semanticDedup".into(),serde_json::to_value(&default_settings().semantic_dedup).map_err(|e|format!("failed to encode semantic dedup defaults: {e}"))?);
            }
        }
        let settings:AppSettings=serde_json::from_value(normalized).map_err(|e|format!("invalid AppSettings schema v3: {e}"))?;
        validate(&settings)?;
        return Ok((settings,true));
    }
    if schema==Some(PREVIOUS_SCHEMA_VERSION)||schema==Some(LEGACY_MEMORY_AGENT_SCHEMA_VERSION){
        let defaults=default_settings();
        let mut normalized=value.clone();
        if let Some(root)=normalized.as_object_mut(){
            root.insert("schemaVersion".into(),Value::String(SCHEMA_VERSION.into()));
            if root.get("memoryAgent").is_none(){
                let enabled=legacy_memory_agent_enabled(root);
                root.insert("memoryAgent".into(),legacy_memory_agent_value(enabled));
            }else{
                migrate_memory_agent_object(root);
            }
            if !root.contains_key("semanticDedup"){
                root.insert("semanticDedup".into(),serde_json::to_value(&defaults.semantic_dedup).map_err(|e|format!("failed to encode semantic dedup defaults: {e}"))?);
            }
        }
        let mut settings:AppSettings=serde_json::from_value(normalized).map_err(|e|format!("invalid AppSettings legacy schema: {e}"))?;
        if settings.memory_agent.prompt.is_empty(){settings.memory_agent.prompt=defaults.memory_agent.prompt;}
        validate(&settings)?;
        return Ok((settings,true));
    }
    if !legacy{
        let mut normalized=value.clone();
        let mut migrated=false;
        if let Some(root)=normalized.as_object_mut(){
            migrated=migrate_memory_judge_default_prompt(root);
            let old_schema=root.get("schemaVersion").and_then(Value::as_str).unwrap_or_default().to_string();
            if old_schema!=SCHEMA_VERSION && matches!(old_schema.as_str(),"5"|"6"|"7"|"8"|"9"|"10"|"11"){
                root.insert("schemaVersion".into(),Value::String(SCHEMA_VERSION.to_string()));
                migrated=true;
            }
            let custom_judge_prompt=root.get("semanticDedup").and_then(Value::as_object)
                .and_then(|semantic|semantic.get("judge")).and_then(Value::as_object)
                .and_then(|judge|judge.get("prompt")).and_then(Value::as_str).map(str::to_string);
            let has_judge_override=root.get("prompts").and_then(Value::as_object)
                .and_then(|prompts|prompts.get("overrides")).and_then(Value::as_object)
                .map(|overrides|overrides.contains_key("memory-judge.system")).unwrap_or(false);
            if !has_judge_override {
                if let Some(prompt)=custom_judge_prompt.as_deref(){
                    if !prompt.trim().is_empty() && prompt!=DEFAULT_MEMORY_JUDGE_INSTRUCTIONS{
                        let prompts=root.entry("prompts").or_insert_with(||serde_json::json!({"overrides":{}}));
                        if !prompts.is_object(){*prompts=serde_json::json!({"overrides":{}});}
                        let prompt_settings=prompts.as_object_mut().expect("prompt settings object");
                        let overrides=prompt_settings.entry("overrides").or_insert_with(||Value::Object(serde_json::Map::new()));
                        if !overrides.is_object(){*overrides=Value::Object(serde_json::Map::new());}
                        overrides.as_object_mut().expect("prompt overrides object").insert("memory-judge.system".into(),Value::String(prompt.into()));
                        migrated=true;
                    }
                }
            }
            if !root.contains_key("prompts"){
                root.insert("prompts".into(),serde_json::json!({"overrides":{}}));
                migrated=true;
            }
            let effective_judge_prompt=root.get("prompts").and_then(Value::as_object)
                .and_then(|prompts|prompts.get("overrides")).and_then(Value::as_object)
                .and_then(|overrides|overrides.get("memory-judge.system")).and_then(Value::as_str)
                .filter(|prompt|!prompt.trim().is_empty())
                .unwrap_or(DEFAULT_MEMORY_JUDGE_INSTRUCTIONS).to_string();
            if let Some(judge)=root.get_mut("semanticDedup").and_then(Value::as_object_mut)
                .and_then(|semantic|semantic.get_mut("judge")).and_then(Value::as_object_mut){
                if judge.get("prompt").and_then(Value::as_str)!=Some(effective_judge_prompt.as_str()){migrated=true;}
                judge.insert("prompt".into(),Value::String(effective_judge_prompt));
            }
        }
        let settings:AppSettings=serde_json::from_value(normalized).map_err(|e|format!("invalid AppSettings: {e}"))?;
        validate(&settings)?;
        return Ok((settings,migrated));
    }
    let defaults=default_settings();
    let mut result=defaults.clone();
    if let Some(v)=value.get("contextBudget").and_then(Value::as_i64){result.context.available_context_tokens=v;}
    if let Some(v)=value.get("recentMessages").and_then(Value::as_i64){result.context.recent_conversation_messages=v;}
    if let Some(v)=value.get("memoryCandidateLimit").and_then(Value::as_i64){result.memory.candidate_limit=v;}
    if let Some(v)=value.get("diagnosticsLevel").and_then(Value::as_str){result.diagnostics.log_level=v.to_string();}
    if let Some(context)=value.get("context").and_then(Value::as_object){
        if let Some(v)=context.get("availableContextTokens").and_then(Value::as_i64){result.context.available_context_tokens=v;}
        if let Some(v)=context.get("reservedOutputTokens").and_then(Value::as_i64){result.context.reserved_output_tokens=v;}
        if let Some(v)=context.get("safetyMarginTokens").and_then(Value::as_i64){result.context.safety_margin_tokens=v;}
        if let Some(v)=context.get("recentConversationMessages").and_then(Value::as_i64){result.context.recent_conversation_messages=v;}
    }
    if let Some(memory)=value.get("memory").and_then(Value::as_object){
        if let Some(v)=memory.get("candidateLimit").and_then(Value::as_i64){result.memory.candidate_limit=v;}
    }
    if let Some(diagnostics)=value.get("diagnostics").and_then(Value::as_object){
        if let Some(v)=diagnostics.get("logLevel").and_then(Value::as_str){result.diagnostics.log_level=v.to_string();}
        if let Some(v)=diagnostics.get("keepRecentEntries").and_then(Value::as_i64){result.diagnostics.keep_recent_entries=v;}
    }
    if let Some(chat)=value.get("chat").and_then(Value::as_object){
        if let Some(v)=chat.get("automaticLongTermMemory").and_then(Value::as_bool){result.chat.automatic_long_term_memory=v;}
    }
    if let Some(memory_agent)=value.get("memoryAgent").and_then(Value::as_object){
        if let Some(v)=memory_agent.get("enabled").and_then(Value::as_bool){result.memory_agent.enabled=v;}
        if let Some(v)=memory_agent.get("providerPresetId").and_then(Value::as_str){result.memory_agent.provider_preset_id=Some(v.to_string());}
        if let Some(v)=memory_agent.get("model").and_then(Value::as_str){result.memory_agent.model=v.to_string();}
        if let Some(v)=memory_agent.get("instructions").and_then(Value::as_str){result.memory_agent.prompt=v.to_string();}
    }
    validate(&result)?;
    Ok((result,true))
}

fn invalid_backup_path(path:&Path)->PathBuf{
    path.with_file_name("app-settings-v1.invalid.json")
}
fn load_from_path(path:&Path)->Result<Option<AppSettings>,String>{
    if !path.exists(){return Ok(None);}
    let bytes=fs::read(path).map_err(|e|format!("failed to read AppSettings: {e}"))?;
    let value:Value=serde_json::from_slice(&bytes).map_err(|e|format!("invalid AppSettings JSON: {e}"))?;
    match migrate(value){
        Ok((settings,migrated))=>{
            if migrated{save_to_path(path,&settings)?;}
            Ok(Some(settings))
        }
        Err(reason)=>{
            let backup=invalid_backup_path(path);
            if !backup.exists(){fs::rename(path,&backup).map_err(|e|format!("failed to quarantine invalid AppSettings: {e}"))?;}
            let _=reason;
            Ok(None)
        }
    }
}
fn save_to_path(path:&Path,settings:&AppSettings)->Result<(),String>{
    validate(settings)?;
    let tmp=path.with_extension("json.tmp");
    let encoded=serde_json::to_vec_pretty(settings).map_err(|e|format!("failed to serialize AppSettings: {e}"))?;
    let mut file=fs::File::create(&tmp).map_err(|e|format!("failed to create AppSettings temp file: {e}"))?;
    file.write_all(&encoded).map_err(|e|format!("failed to write AppSettings: {e}"))?;
    file.sync_all().map_err(|e|format!("failed to flush AppSettings: {e}"))?;
    drop(file);
    if path.exists(){fs::remove_file(path).map_err(|e|format!("failed to replace AppSettings: {e}"))?;}
    fs::rename(&tmp,path).map_err(|e|format!("failed to commit AppSettings: {e}"))?;
    Ok(())
}
pub fn load(app:&tauri::AppHandle)->Result<Option<AppSettings>,String>{load_from_path(&config_path(app)?)}
pub fn save(app:&tauri::AppHandle,settings:&AppSettings)->Result<(),String>{save_to_path(&config_path(app)?,settings)}

#[cfg(test)]
mod tests{
    use super::*;
    #[test]fn defaults_validate(){assert!(validate(&default_settings()).is_ok());}
    #[test]fn migrates_legacy_values(){
        let value=serde_json::json!({"schemaVersion":"0","contextBudget":8192,"recentMessages":12,"memoryCandidateLimit":5,"diagnosticsLevel":"verbose"});
        let (settings,migrated)=migrate(value).expect("legacy settings should migrate");
        assert!(migrated);
        assert_eq!(settings.context.available_context_tokens,8192);
        assert_eq!(settings.context.recent_conversation_messages,12);
        assert_eq!(settings.memory.candidate_limit,5);
        assert_eq!(settings.diagnostics.log_level,"verbose");
        assert_eq!(settings.schema_version,SCHEMA_VERSION);
    }
    #[test]fn rejects_security_bound_excess(){
        let mut settings=default_settings();settings.context.available_context_tokens=MAX_CONTEXT_TOKENS+1;
        assert!(validate(&settings).is_err());
    }
    #[test]fn preserves_canonical_round_trip(){let settings=default_settings();let encoded=serde_json::to_vec(&settings).expect("encode");let (restored,migrated)=migrate(serde_json::from_slice(&encoded).expect("json")).expect("canonical settings should round-trip");assert!(!migrated);assert_eq!(restored.memory_agent.enabled,settings.memory_agent.enabled);}
    #[test]fn migrates_previous_schema_memory_agent(){let value=serde_json::json!({"schemaVersion":"1","apiVersion":"1","chat":{"automaticLongTermMemory":false},"context":{"availableContextTokens":4096,"reservedOutputTokens":1024,"safetyMarginTokens":128,"recentConversationMessages":8},"memory":{"candidateLimit":8},"retrieval":{"candidateLimit":32},"diagnostics":{"logLevel":"normal","keepRecentEntries":100},"ui":{"showDiagnosticsInChat":true}});let (settings,migrated)=migrate(value).expect("schema v1 should migrate");assert!(migrated);assert!(!settings.memory_agent.enabled);assert_eq!(settings.memory_agent.prompt,DEFAULT_AUTOMATIC_MEMORY_INSTRUCTIONS);assert_eq!(settings.schema_version,SCHEMA_VERSION);}
    #[test]fn migrates_schema_v2_instructions_and_preserves_binding(){let value=serde_json::json!({"schemaVersion":"2","apiVersion":"1","chat":{"automaticLongTermMemory":true},"memoryAgent":{"enabled":false,"providerPresetId":"preset.memory","model":"memory-model"},"context":{"availableContextTokens":4096,"reservedOutputTokens":1024,"safetyMarginTokens":128,"recentConversationMessages":8},"memory":{"candidateLimit":8},"retrieval":{"candidateLimit":32},"diagnostics":{"logLevel":"normal","keepRecentEntries":100},"ui":{"showDiagnosticsInChat":true}});let (settings,migrated)=migrate(value).expect("schema v2 should migrate");assert!(migrated);assert!(!settings.memory_agent.enabled);assert_eq!(settings.memory_agent.provider_preset_id.as_deref(),Some("preset.memory"));assert_eq!(settings.memory_agent.model,"memory-model");assert_eq!(settings.memory_agent.prompt,DEFAULT_AUTOMATIC_MEMORY_INSTRUCTIONS);assert_eq!(settings.schema_version,SCHEMA_VERSION);}
    #[test]fn migrates_schema_v3_prompt_fields(){
        let value=serde_json::json!({
            "schemaVersion":"3","apiVersion":"1",
            "chat":{"automaticLongTermMemory":true},
            "memoryAgent":{"enabled":true,"providerPresetId":"preset.memory","model":"memory-model","instructions":"legacy custom prompt"},
            "context":{"availableContextTokens":4096,"reservedOutputTokens":1024,"safetyMarginTokens":128,"recentConversationMessages":8},
            "memory":{"candidateLimit":8},"retrieval":{"candidateLimit":32},
            "diagnostics":{"logLevel":"normal","keepRecentEntries":100},"ui":{"showDiagnosticsInChat":true}
        });
        let (settings,migrated)=migrate(value).expect("schema v3 should migrate");
        assert!(migrated);
        assert_eq!(settings.schema_version,SCHEMA_VERSION);
        assert_eq!(settings.memory_agent.prompt,"legacy custom prompt");
        assert_eq!(settings.memory_agent.output_mode,"auto");
        assert!(settings.memory_agent.prompt_backup.is_none());
        assert_eq!(settings.memory_agent.default_prompt_version,DEFAULT_MEMORY_AGENT_PROMPT_VERSION);
    }
    #[test]fn migrates_schema_v4_prompt_backup(){
        let value=serde_json::json!({
            "schemaVersion":"4","apiVersion":"1",
            "chat":{"automaticLongTermMemory":true},
            "memoryAgent":{"enabled":true,"providerPresetId":"preset.memory","model":"memory-model","outputMode":"structured","prompt":"custom","promptBackup":"previous","defaultPromptVersion":"1"},
            "context":{"availableContextTokens":4096,"reservedOutputTokens":1024,"safetyMarginTokens":128,"recentConversationMessages":8},
            "memory":{"candidateLimit":8},"retrieval":{"candidateLimit":32},
            "diagnostics":{"logLevel":"normal","keepRecentEntries":100},"ui":{"showDiagnosticsInChat":true}
        });
        let (settings,migrated)=migrate(value).expect("schema v4 should round-trip");
        assert!(migrated);
        assert_eq!(settings.memory_agent.output_mode,"structured");
        assert_eq!(settings.memory_agent.prompt,"custom");
        assert_eq!(settings.memory_agent.prompt_backup.as_deref(),Some("previous"));
        assert_eq!(settings.semantic_dedup.candidate_limit,5);
        assert_eq!(settings.schema_version,SCHEMA_VERSION);
    }
    #[test]fn migrates_schema_v5_legacy_judge_default_prompt(){
        let mut value=serde_json::to_value(default_settings()).expect("encode defaults");
        if let Some(root)=value.as_object_mut(){
            if let Some(semantic)=root.get_mut("semanticDedup").and_then(Value::as_object_mut){
                if let Some(judge)=semantic.get_mut("judge").and_then(Value::as_object_mut){
                    judge.insert("prompt".into(),Value::String(LEGACY_MEMORY_JUDGE_INSTRUCTIONS.into()));
                    judge.insert("defaultPromptVersion".into(),Value::String("1".into()));
                }
            }
        }
        let (restored,migrated)=migrate(value).expect("schema v5 legacy Judge default should migrate");
        assert!(migrated);
        assert_eq!(restored.semantic_dedup.judge.prompt,DEFAULT_MEMORY_JUDGE_INSTRUCTIONS);
        assert_eq!(restored.semantic_dedup.judge.default_prompt_version,DEFAULT_MEMORY_JUDGE_PROMPT_VERSION);
    }

#[test]fn migrates_custom_judge_prompt_to_central_registry_and_preserves_settings(){
        let mut value=serde_json::to_value(default_settings()).expect("encode defaults");
        if let Some(root)=value.as_object_mut(){
            root.insert("schemaVersion".into(),Value::String("11".into()));
            root.remove("prompts");
            root.insert("context".into(),serde_json::json!({"availableContextTokens":6144,"reservedOutputTokens":1024,"safetyMarginTokens":128,"recentConversationMessages":9}));
            if let Some(semantic)=root.get_mut("semanticDedup").and_then(Value::as_object_mut){
                semantic.insert("embeddingProviderPresetId".into(),Value::String("embedding-preset".into()));
                semantic.insert("embeddingModel".into(),Value::String("embedding-model".into()));
                if let Some(judge)=semantic.get_mut("judge").and_then(Value::as_object_mut){
                    judge.insert("prompt".into(),Value::String("custom legacy Judge prompt".into()));
                    judge.insert("providerPresetId".into(),Value::String("judge-preset".into()));
                    judge.insert("model".into(),Value::String("judge-model".into()));
                }
            }
        }
        let (settings,migrated)=migrate(value).expect("previous settings version should migrate");
        assert!(migrated);
        assert_eq!(settings.schema_version,SCHEMA_VERSION);
        assert_eq!(settings.prompts.overrides.get("memory-judge.system").map(String::as_str),Some("custom legacy Judge prompt"));
        assert_eq!(settings.semantic_dedup.judge.prompt,"custom legacy Judge prompt");
        assert_eq!(settings.semantic_dedup.judge.provider_preset_id.as_deref(),Some("judge-preset"));
        assert_eq!(settings.semantic_dedup.judge.model,"judge-model");
        assert_eq!(settings.semantic_dedup.embedding_provider_preset_id.as_deref(),Some("embedding-preset"));
        assert_eq!(settings.semantic_dedup.embedding_model,"embedding-model");
        assert_eq!(settings.context.available_context_tokens,6144);
        assert_eq!(settings.context.recent_conversation_messages,9);
    }

    #[test]fn validates_prompt_override_ids_and_lengths(){
        let mut settings=default_settings();
        settings.prompts.overrides.insert("unknown".into(),"custom".into());
        assert!(validate(&settings).is_err());
        settings.prompts.overrides.clear();
        settings.prompts.overrides.insert("nova-system-json".into(),"x".repeat(MAX_SEMANTIC_PROMPT+1));
        assert!(validate(&settings).is_err());
    }

    #[test]fn prompt_override_round_trips_without_resetting_other_settings(){
        let mut settings=default_settings();
        settings.prompts.overrides.insert("nova-system-json".into(),"custom native JSON prompt".into());
        settings.context.available_context_tokens=8192;
        let encoded=serde_json::to_vec(&settings).expect("encode");
        let (restored,migrated)=migrate(serde_json::from_slice(&encoded).expect("json")).expect("v12 settings should round-trip");
        assert!(!migrated);
        assert_eq!(restored.prompts.overrides.get("nova-system-json").map(String::as_str),Some("custom native JSON prompt"));
        assert_eq!(restored.context.available_context_tokens,8192);
    }

    #[test]fn preserves_schema_v5_semantic_settings(){
        let settings=default_settings();
        let encoded=serde_json::to_vec(&settings).expect("encode");
        let (restored,migrated)=migrate(serde_json::from_slice(&encoded).expect("json")).expect("schema v5 should round-trip");
        assert!(!migrated);
        assert_eq!(restored.semantic_dedup.candidate_similarity_threshold,0.88);
        assert_eq!(restored.semantic_dedup.judge.default_prompt_version,DEFAULT_MEMORY_JUDGE_PROMPT_VERSION);
        assert_eq!(restored.semantic_dedup.judge.prompt,DEFAULT_MEMORY_JUDGE_INSTRUCTIONS);
    }

}
