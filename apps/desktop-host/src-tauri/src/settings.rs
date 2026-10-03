use serde::{Deserialize,Serialize};
use serde_json::Value;
use std::{fs,io::Write,path::{Path,PathBuf}};
use tauri::Manager;

const API_VERSION:&str="1";
const SCHEMA_VERSION:&str="3";
const FILE_NAME:&str="app-settings-v1.json";
const LEGACY_SCHEMA_VERSION:&str="0";
const PREVIOUS_SCHEMA_VERSION:&str="2";
const LEGACY_PREVIOUS_SCHEMA_VERSION:&str="1";
const MAX_CONTEXT_TOKENS:i64=32768;
const MAX_RESERVED_OUTPUT:i64=16384;
const MAX_SAFETY_MARGIN:i64=4096;
const MAX_RECENT_MESSAGES:i64=100;
const MAX_MEMORY_CANDIDATES:i64=100;
const MAX_RETRIEVAL_CANDIDATES:i64=100;
const MAX_DIAGNOSTICS_ENTRIES:i64=500;
const MAX_MEMORY_AGENT_INSTRUCTIONS:usize=12000;
const DEFAULT_AUTOMATIC_MEMORY_INSTRUCTIONS:&str="Review the relevant conversation context, user message, and assistant response.\nDecide whether there is durable information worth remembering after this conversation ends.\nKeep information only when it is useful beyond the current turn.\nExamples: stable user preferences, persistent user facts, important relationships, long-term goals, commitments or decisions, durable instructions, meaningful experiences, and important assistant commitments or decisions.";

#[derive(Debug,Deserialize,Serialize,Clone)]
#[serde(deny_unknown_fields)]
pub struct ChatSettings{
    #[serde(rename="automaticLongTermMemory")]
    pub automatic_long_term_memory:bool
}
#[derive(Debug,Deserialize,Serialize,Clone)]
#[serde(deny_unknown_fields)]
pub struct MemoryAgentSettings{
    pub enabled:bool,
    #[serde(rename="providerPresetId")]
    pub provider_preset_id:Option<String>,
    pub model:String,
    pub instructions:String
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
    pub candidate_limit:i64
}
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
    pub chat:ChatSettings,
    #[serde(rename="memoryAgent")]
    pub memory_agent:MemoryAgentSettings,
    pub context:ContextSettings,
    pub memory:MemorySettings,
    pub retrieval:RetrievalSettings,
    pub diagnostics:DiagnosticsSettings,
    pub ui:UiSettings
}

fn default_settings()->AppSettings{
    AppSettings{
        api_version:API_VERSION.into(),schema_version:SCHEMA_VERSION.into(),
        chat:ChatSettings{automatic_long_term_memory:true},
        memory_agent:MemoryAgentSettings{enabled:true,provider_preset_id:None,model:DEFAULT_AUTOMATIC_MEMORY_INSTRUCTIONS.to_string()},
        context:ContextSettings{available_context_tokens:4096,reserved_output_tokens:1024,safety_margin_tokens:128,recent_conversation_messages:8},
        memory:MemorySettings{candidate_limit:8},
        retrieval:RetrievalSettings{candidate_limit:32},
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
    if settings.api_version!=API_VERSION||settings.schema_version!=SCHEMA_VERSION{return Err("unsupported AppSettings version".into());}
    valid_integer(settings.context.available_context_tokens,256,MAX_CONTEXT_TOKENS,"Context size")?;
    valid_integer(settings.context.reserved_output_tokens,0,MAX_RESERVED_OUTPUT,"Reserved response tokens")?;
    valid_integer(settings.context.safety_margin_tokens,0,MAX_SAFETY_MARGIN,"Safety margin")?;
    valid_integer(settings.context.recent_conversation_messages,1,MAX_RECENT_MESSAGES,"Recent messages")?;
    valid_integer(settings.memory.candidate_limit,1,MAX_MEMORY_CANDIDATES,"Memory items")?;
    valid_integer(settings.retrieval.candidate_limit,1,MAX_RETRIEVAL_CANDIDATES,"Retrieval candidates")?;
    if !matches!(settings.diagnostics.log_level.as_str(),"off"|"errors"|"normal"|"verbose"|"debug"){return Err("Unsupported diagnostics log level".into());}
    valid_integer(settings.diagnostics.keep_recent_entries,1,MAX_DIAGNOSTICS_ENTRIES,"Recent diagnostic entries")?;
    if settings.memory_agent.instructions.len()>MAX_MEMORY_AGENT_INSTRUCTIONS{return Err("Automatic Memory Agent instructions exceed the 12000 character limit.".into());}
    Ok(())
}

fn migrate(value:Value)->Result<(AppSettings,bool),String>{
    let schema=value.get("schemaVersion").and_then(Value::as_str);
    let legacy=schema.map(|v|v==LEGACY_SCHEMA_VERSION).unwrap_or(true);
    let previous=schema==Some(PREVIOUS_SCHEMA_VERSION)||schema==Some(LEGACY_PREVIOUS_SCHEMA_VERSION);
    if schema==Some(PREVIOUS_SCHEMA_VERSION){
        let mut result=default_settings();
        let settings:AppSettings=serde_json::from_value(value.clone()).map_err(|e|format!("invalid AppSettings schema v2: {e}"))?;
        result=settings;
        result.schema_version=SCHEMA_VERSION.into();
        if result.memory_agent.instructions.trim().is_empty(){result.memory_agent.instructions=DEFAULT_AUTOMATIC_MEMORY_INSTRUCTIONS.into();}
        validate(&result)?;
        return Ok((result,true));
    }
    if !legacy && !previous{
        let settings:AppSettings=serde_json::from_value(value).map_err(|e|format!("invalid AppSettings: {e}"))?;
        validate(&settings)?;
        return Ok((settings,false));
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
        if schema==Some(PREVIOUS_SCHEMA_VERSION) || schema==Some(LEGACY_PREVIOUS_SCHEMA_VERSION){
            if let Some(v)=memory_agent.get("instructions").and_then(Value::as_str){result.memory_agent.instructions=v.to_string();}
        }
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
    #[test]fn migrates_previous_schema_memory_agent(){let value=serde_json::json!({"schemaVersion":"1","apiVersion":"1","chat":{"automaticLongTermMemory":false},"context":{"availableContextTokens":4096,"reservedOutputTokens":1024,"safetyMarginTokens":128,"recentConversationMessages":8},"memory":{"candidateLimit":8},"retrieval":{"candidateLimit":32},"diagnostics":{"logLevel":"normal","keepRecentEntries":100},"ui":{"showDiagnosticsInChat":true}});let (settings,migrated)=migrate(value).expect("schema v1 should migrate");assert!(migrated);assert!(!settings.memory_agent.enabled);assert_eq!(settings.memory_agent.instructions,DEFAULT_AUTOMATIC_MEMORY_INSTRUCTIONS);assert_eq!(settings.schema_version,SCHEMA_VERSION);}
    #[test]fn migrates_schema_v2_instructions_and_preserves_binding(){let value=serde_json::json!({"schemaVersion":"2","apiVersion":"1","chat":{"automaticLongTermMemory":true},"memoryAgent":{"enabled":false,"providerPresetId":"preset.memory","model":"memory-model"},"context":{"availableContextTokens":4096,"reservedOutputTokens":1024,"safetyMarginTokens":128,"recentConversationMessages":8},"memory":{"candidateLimit":8},"retrieval":{"candidateLimit":32},"diagnostics":{"logLevel":"normal","keepRecentEntries":100},"ui":{"showDiagnosticsInChat":true}});let (settings,migrated)=migrate(value).expect("schema v2 should migrate");assert!(migrated);assert!(!settings.memory_agent.enabled);assert_eq!(settings.memory_agent.provider_preset_id.as_deref(),Some("preset.memory"));assert_eq!(settings.memory_agent.model,"memory-model");assert_eq!(settings.memory_agent.instructions,DEFAULT_AUTOMATIC_MEMORY_INSTRUCTIONS);assert_eq!(settings.schema_version,SCHEMA_VERSION);}
}
