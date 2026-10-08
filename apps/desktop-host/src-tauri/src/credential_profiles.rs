use serde::{Deserialize,Serialize};
use std::{collections::HashSet,fs,io::Write,path::{Path,PathBuf}};
use tauri::Manager;

const API_VERSION:&str="1";
const SCHEMA_VERSION:&str="1";

#[derive(Debug,Deserialize,Serialize,Clone)]
#[serde(deny_unknown_fields)]
pub struct CredentialProfile{
    pub id:String,
    pub label:String,
    #[serde(rename="providerId")]
    pub provider_id:String,
    #[serde(rename="credentialReference")]
    pub credential_reference:super::windows_credentials::CredentialReference,
    #[serde(rename="createdAt")]
    pub created_at:String,
    #[serde(rename="updatedAt")]
    pub updated_at:String,
}
#[derive(Debug,Deserialize,Serialize,Clone)]
#[serde(deny_unknown_fields)]
pub struct CredentialProfileStoreState{
    #[serde(rename="apiVersion")]
    pub api_version:String,
    #[serde(rename="schemaVersion")]
    pub schema_version:String,
    pub profiles:Vec<CredentialProfile>,
}
fn config_dir(app:&tauri::AppHandle)->Result<PathBuf,String>{
    let directory=app.path().app_config_dir().map_err(|e|format!("failed to resolve app config directory: {e}"))?;
    fs::create_dir_all(&directory).map_err(|e|format!("failed to create app config directory: {e}"))?;
    Ok(directory)
}
pub fn config_path(app:&tauri::AppHandle)->Result<PathBuf,String>{Ok(config_dir(app)?.join("credential-profiles-v1.json"))}
fn invalid_backup_path(path:&std::path::Path)->PathBuf{path.with_file_name("credential-profiles-v1.invalid.json")}
fn validate_profile(profile:&CredentialProfile)->Result<(),String>{
    if profile.id.trim().is_empty()||profile.id.len()>200{return Err("credential profile id is invalid".to_string());}
    if profile.label.trim().is_empty()||profile.label.len()>200{return Err("credential profile label is invalid".to_string());}
    if profile.provider_id.trim().is_empty()||profile.provider_id.len()>100{return Err("credential profile provider is invalid".to_string());}
    if profile.created_at.trim().is_empty()||profile.updated_at.trim().is_empty(){return Err("credential profile timestamps must not be empty".to_string());}
    if profile.credential_reference.kind!="api-key"{return Err("credential profile credential kind must be api-key".to_string());}
    if profile.credential_reference.provider.as_deref()!=Some(profile.provider_id.as_str()){return Err("credential profile credential provider does not match providerId".to_string());}
    Ok(())
}
fn validate_state(state:&CredentialProfileStoreState)->Result<(),String>{
    if state.api_version!=API_VERSION||state.schema_version!=SCHEMA_VERSION{return Err("unsupported credential profile storage version".to_string());}
    let mut ids=HashSet::new();
    for profile in &state.profiles{
        validate_profile(profile)?;
        if !ids.insert(profile.id.clone()){return Err("credential profile storage contains duplicate ids".to_string());}
        if state.profiles.iter().filter(|item|item.credential_reference.id==profile.credential_reference.id).count()>1{
            return Err("credential profile storage contains duplicate credential references".to_string());
        }
    }
    Ok(())
}
fn decode(bytes:&[u8])->Result<CredentialProfileStoreState,String>{
    let state:CredentialProfileStoreState=serde_json::from_slice(bytes).map_err(|e|format!("invalid credential profile storage file: {e}"))?;
    validate_state(&state)?;
    Ok(state)
}
fn quarantine(path:&Path)->Result<(),String>{
    let backup=invalid_backup_path(path);
    if backup.exists(){return Err("invalid credential profile storage was detected, but the existing recovery backup prevents another automatic quarantine.".to_string());}
    fs::rename(path,&backup).map_err(|e|format!("failed to quarantine invalid credential profile storage: {e}"))?;
    Ok(())
}
fn load_from_path(path:&Path)->Result<Option<CredentialProfileStoreState>,String>{
    if !path.exists(){return Ok(None);}
    let bytes=fs::read(path).map_err(|e|format!("failed to read credential profile storage: {e}"))?;
    match decode(&bytes){
        Ok(state)=>Ok(Some(state)),
        Err(reason)=>{quarantine(path)?;Err(format!("credential profile storage was quarantined after validation failed: {reason}"))}
    }
}
fn save_to_path(path:&Path,state:&CredentialProfileStoreState)->Result<(),String>{
    validate_state(state)?;
    let tmp=path.with_extension("json.tmp");
    let encoded=serde_json::to_vec_pretty(state).map_err(|e|format!("failed to serialize credential profile storage: {e}"))?;
    let mut file=fs::File::create(&tmp).map_err(|e|format!("failed to create credential profile temp file: {e}"))?;
    file.write_all(&encoded).map_err(|e|format!("failed to write credential profile storage: {e}"))?;
    file.sync_all().map_err(|e|format!("failed to flush credential profile storage: {e}"))?;
    drop(file);
    if path.exists(){fs::remove_file(path).map_err(|e|format!("failed to replace credential profile storage: {e}"))?;}
    fs::rename(&tmp,path).map_err(|e|format!("failed to commit credential profile storage: {e}"))?;
    Ok(())
}
pub fn load(app:&tauri::AppHandle)->Result<Option<CredentialProfileStoreState>,String>{load_from_path(&config_path(app)?)}
pub fn save(app:&tauri::AppHandle,state:&CredentialProfileStoreState)->Result<(),String>{save_to_path(&config_path(app)?,state)}
pub fn delete(app:&tauri::AppHandle,id:&str)->Result<(),String>{
    if id.trim().is_empty(){return Err("credential profile id must not be empty".to_string());}
    let path=config_path(app)?;
    let Some(mut state)=load_from_path(&path)? else{return Ok(());};
    state.profiles.retain(|profile|profile.id!=id);
    if state.profiles.is_empty(){if path.exists(){fs::remove_file(path).map_err(|e|format!("failed to remove empty credential profile storage: {e}"))?;}Ok(())}else{save_to_path(&path,&state)}
}
#[cfg(test)]
mod tests{
    use super::*;
    use std::{fs,time::{SystemTime,UNIX_EPOCH}};
    fn reference(id:&str)->super::super::windows_credentials::CredentialReference{
      super::super::windows_credentials::CredentialReference{id:id.to_string(),kind:"api-key".to_string(),provider:Some("openai-compatible".to_string()),version:Some("1".to_string())}
    }
    fn profile(id:&str,ref_id:&str)->CredentialProfile{CredentialProfile{id:id.to_string(),label:"Main".to_string(),provider_id:"openai-compatible".to_string(),credential_reference:reference(ref_id),created_at:"2026-09-28T00:00:00Z".to_string(),updated_at:"2026-09-28T00:00:00Z".to_string()}}
    fn state()->CredentialProfileStoreState{CredentialProfileStoreState{api_version:API_VERSION.to_string(),schema_version:SCHEMA_VERSION.to_string(),profiles:vec![profile("credential-profile:a","credential-a")]}}
    fn temp(name:&str)->PathBuf{let stamp=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();let dir=std::env::temp_dir().join(format!("nova-credential-profiles-{name}-{stamp}"));fs::create_dir_all(&dir).unwrap();dir.join("credential-profiles-v1.json")}
    #[test]fn rejects_unknown_fields(){let value=serde_json::json!({"id":"x","label":"X","providerId":"openai-compatible","credentialReference":{"id":"x","kind":"api-key","provider":"openai-compatible","secret":"nope"},"createdAt":"x","updatedAt":"x"});assert!(serde_json::from_value::<CredentialProfile>(value).is_err());}
    #[test]fn persists_metadata_without_secret(){let path=temp("roundtrip");save_to_path(&path,&state()).unwrap();let raw=fs::read_to_string(&path).unwrap();assert!(!raw.contains("secret"));assert!(raw.contains("credentialReference"));let loaded=load_from_path(&path).unwrap().unwrap();assert_eq!(loaded.profiles[0].credential_reference.id,"credential-a");fs::remove_dir_all(path.parent().unwrap()).unwrap();}
    #[test]fn rejects_duplicate_reference(){let mut s=state();s.profiles.push(profile("credential-profile:b","credential-a"));assert!(validate_state(&s).is_err());}
}
