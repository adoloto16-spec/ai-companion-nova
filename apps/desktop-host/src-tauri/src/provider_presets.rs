use serde::{Deserialize,Serialize};
use std::{collections::HashSet,fs,io::Write,path::{Path,PathBuf}};
use tauri::Manager;

const API_VERSION:&str="1";
const SCHEMA_VERSION:&str="1";

#[derive(Debug,Deserialize,Serialize,Clone)]
#[serde(deny_unknown_fields)]
pub struct ProviderPreset{
    pub id:String,
    pub name:String,
    #[serde(rename="providerId")]
    pub provider_id:String,
    #[serde(rename="baseUrl")]
    pub base_url:String,
    #[serde(rename="credentialProfileId",skip_serializing_if="Option::is_none")]
    pub credential_profile_id:Option<String>,
    #[serde(skip_serializing_if="Option::is_none")]
    pub model:Option<String>,
    #[serde(rename="timeoutMs",skip_serializing_if="Option::is_none")]
    pub timeout_ms:Option<f64>,
    #[serde(rename="createdAt")]
    pub created_at:String,
    #[serde(rename="updatedAt")]
    pub updated_at:String,
}
#[derive(Debug,Deserialize,Serialize,Clone)]
#[serde(deny_unknown_fields)]
pub struct ProviderPresetStoreState{
    #[serde(rename="apiVersion")]
    pub api_version:String,
    #[serde(rename="schemaVersion")]
    pub schema_version:String,
    pub presets:Vec<ProviderPreset>,
    #[serde(rename="activePresetId")]
    pub active_preset_id:Option<String>,
}
fn config_dir(app:&tauri::AppHandle)->Result<PathBuf,String>{
    let directory=app.path().app_config_dir().map_err(|e|format!("failed to resolve app config directory: {e}"))?;
    fs::create_dir_all(&directory).map_err(|e|format!("failed to create app config directory: {e}"))?;
    Ok(directory)
}
pub fn config_path(app:&tauri::AppHandle)->Result<PathBuf,String>{Ok(config_dir(app)?.join("provider-presets-v1.json"))}
fn invalid_backup_path(path:&std::path::Path)->PathBuf{path.with_file_name("provider-presets-v1.invalid.json")}
fn validate_preset(preset:&ProviderPreset)->Result<(),String>{
    if preset.id.trim().is_empty()||preset.id.len()>200{return Err("provider preset id is invalid".to_string());}
    if preset.name.trim().is_empty()||preset.name.len()>200{return Err("provider preset name is invalid".to_string());}
    if preset.provider_id!="openai-compatible"{return Err("unsupported provider preset provider".to_string());}
    if preset.base_url.trim()!=preset.base_url{return Err("provider preset base URL must not have surrounding whitespace".to_string());}
    let url=url::Url::parse(&preset.base_url).map_err(|_|"provider preset base URL is invalid".to_string())?;
    if url.scheme()!="http"&&url.scheme()!="https"{return Err("provider preset base URL must use HTTP or HTTPS".to_string());}
    if !url.username().is_empty()||url.password().is_some(){return Err("provider preset base URL must not contain credentials".to_string());}
    if url.query().is_some()||url.fragment().is_some(){return Err("provider preset base URL must not contain query or fragment".to_string());}
    if let Some(id)=&preset.credential_profile_id{if id.trim().is_empty(){return Err("provider preset credentialProfileId must not be empty".to_string());}}
    if let Some(model)=&preset.model{if model.trim().is_empty(){return Err("provider preset model must not be empty".to_string());}}
    if let Some(timeout)=preset.timeout_ms{if !timeout.is_finite()||timeout<=0.0{return Err("provider preset timeout must be finite and positive".to_string());}}
    if preset.created_at.trim().is_empty()||preset.updated_at.trim().is_empty(){return Err("provider preset timestamps must not be empty".to_string());}
    Ok(())
}
fn validate_state(state:&ProviderPresetStoreState)->Result<(),String>{
    if state.api_version!=API_VERSION||state.schema_version!=SCHEMA_VERSION{return Err("unsupported provider preset storage version".to_string());}
    let mut ids=HashSet::new();
    for preset in &state.presets{validate_preset(preset)?;if !ids.insert(preset.id.clone()){return Err("provider preset storage contains duplicate ids".to_string());}}
    if let Some(active)=&state.active_preset_id{
      if !state.presets.iter().any(|preset|&preset.id==active){return Err("activePresetId must reference an existing provider preset".to_string());}
    }
    Ok(())
}
fn decode(bytes:&[u8])->Result<ProviderPresetStoreState,String>{let state:ProviderPresetStoreState=serde_json::from_slice(bytes).map_err(|e|format!("invalid provider preset storage file: {e}"))?;validate_state(&state)?;Ok(state)}
fn quarantine(path:&Path)->Result<(),String>{let backup=invalid_backup_path(path);if backup.exists(){return Err("invalid provider preset storage was detected, but the existing recovery backup prevents another automatic quarantine.".to_string());}fs::rename(path,&backup).map_err(|e|format!("failed to quarantine invalid provider preset storage: {e}"))?;Ok(())}
fn load_from_path(path:&Path)->Result<Option<ProviderPresetStoreState>,String>{if !path.exists(){return Ok(None)}let bytes=fs::read(path).map_err(|e|format!("failed to read provider preset storage: {e}"))?;match decode(&bytes){Ok(state)=>Ok(Some(state)),Err(reason)=>{quarantine(path)?;Err(format!("provider preset storage was quarantined after validation failed: {reason}"))}}}
fn save_to_path(path:&Path,state:&ProviderPresetStoreState)->Result<(),String>{validate_state(state)?;let tmp=path.with_extension("json.tmp");let encoded=serde_json::to_vec_pretty(state).map_err(|e|format!("failed to serialize provider preset storage: {e}"))?;let mut file=fs::File::create(&tmp).map_err(|e|format!("failed to create provider preset temp file: {e}"))?;file.write_all(&encoded).map_err(|e|format!("failed to write provider preset storage: {e}"))?;file.sync_all().map_err(|e|format!("failed to flush provider preset storage: {e}"))?;drop(file);if path.exists(){fs::remove_file(path).map_err(|e|format!("failed to replace provider preset storage: {e}"))?;}fs::rename(&tmp,path).map_err(|e|format!("failed to commit provider preset storage: {e}"))?;Ok(())}
pub fn load(app:&tauri::AppHandle)->Result<Option<ProviderPresetStoreState>,String>{load_from_path(&config_path(app)?)}
pub fn save(app:&tauri::AppHandle,state:&ProviderPresetStoreState)->Result<(),String>{save_to_path(&config_path(app)?,state)}
pub fn delete(app:&tauri::AppHandle,id:&str)->Result<(),String>{if id.trim().is_empty(){return Err("provider preset id must not be empty".to_string());}let path=config_path(app)?;let Some(mut state)=load_from_path(&path)? else{return Ok(())};state.presets.retain(|preset|preset.id!=id);if state.active_preset_id.as_deref()==Some(id){state.active_preset_id=state.presets.first().map(|preset|preset.id.clone());}if state.presets.is_empty(){if path.exists(){fs::remove_file(path).map_err(|e|format!("failed to remove empty provider preset storage: {e}"))?;}Ok(())}else{save_to_path(&path,&state)}}
#[cfg(test)]
mod tests{
use super::*;use std::{fs,time::{SystemTime,UNIX_EPOCH}};
fn preset(id:&str)->ProviderPreset{ProviderPreset{id:id.to_string(),name:id.to_string(),provider_id:"openai-compatible".to_string(),base_url:"https://api.openai.com/v1".to_string(),credential_profile_id:Some("credential-profile:a".to_string()),model:Some("gpt-test".to_string()),timeout_ms:Some(30000.0),created_at:"2026-09-28T00:00:00Z".to_string(),updated_at:"2026-09-28T00:00:00Z".to_string()}}
fn state()->ProviderPresetStoreState{ProviderPresetStoreState{api_version:API_VERSION.to_string(),schema_version:SCHEMA_VERSION.to_string(),presets:vec![preset("preset-a")],active_preset_id:Some("preset-a".to_string())}}
fn temp(name:&str)->PathBuf{let stamp=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();let dir=std::env::temp_dir().join(format!("nova-provider-presets-{name}-{stamp}"));fs::create_dir_all(&dir).unwrap();dir.join("provider-presets-v1.json")}
#[test]fn rejects_unknown_fields(){let value=serde_json::json!({"id":"x","name":"X","providerId":"openai-compatible","baseUrl":"https://example.com/v1","secret":"bad","createdAt":"x","updatedAt":"x"});assert!(serde_json::from_value::<ProviderPreset>(value).is_err());}
#[test]fn persists_and_restores_active(){let path=temp("roundtrip");save_to_path(&path,&state()).unwrap();let loaded=load_from_path(&path).unwrap().unwrap();assert_eq!(loaded.active_preset_id.as_deref(),Some("preset-a"));assert_eq!(loaded.presets[0].credential_profile_id.as_deref(),Some("credential-profile:a"));let raw=fs::read_to_string(&path).unwrap();assert!(!raw.contains("apiKey"));assert!(!raw.contains("secret"));fs::remove_dir_all(path.parent().unwrap()).unwrap();}
#[test]fn rejects_invalid_active_preset(){let mut s=state();s.active_preset_id=Some("missing".to_string());assert!(validate_state(&s).is_err());}
#[test]fn rejects_query_in_base_url(){let mut s=state();s.presets[0].base_url.push_str("?key=secret");assert!(validate_state(&s).is_err());}
}
