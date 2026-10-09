use serde::{Deserialize,Serialize};
use std::{collections::HashSet,fs,io::Write,path::{Path,PathBuf}};
use tauri::Manager;

const API_VERSION:&str="1";
const SCHEMA_VERSION:&str="3";
const V2_SCHEMA_VERSION:&str="2";
const LEGACY_SCHEMA_VERSION:&str="1";

fn default_preset_type()->String{"pool".to_string()}

#[derive(Debug,Deserialize,Serialize,Clone)]
#[serde(deny_unknown_fields)]
pub struct CredentialReference{
    pub id:String,
    pub kind:String,
    pub provider:Option<String>,
    pub version:Option<String>,
}

#[derive(Debug,Deserialize,Serialize,Clone)]
#[serde(deny_unknown_fields)]
pub struct ProviderPresetSource{
    pub id:String,
    pub name:String,
    #[serde(rename="providerId")]
    pub provider_id:String,
    #[serde(rename="baseUrl")]
    pub base_url:String,
    pub model:String,
    #[serde(rename="credentialReference")]
    pub credential_reference:Option<CredentialReference>,
    pub enabled:bool,
    pub health:String,
    #[serde(rename="failureCount")]
    pub failure_count:u32,
    #[serde(rename="cooldownUntil")]
    pub cooldown_until:Option<String>,
    #[serde(rename="timeoutMs",skip_serializing_if="Option::is_none")]
    pub timeout_ms:Option<f64>,
    #[serde(rename="createdAt")]
    pub created_at:String,
    #[serde(rename="updatedAt")]
    pub updated_at:String,
}

#[derive(Debug,Deserialize,Serialize,Clone)]
#[serde(deny_unknown_fields)]
pub struct ProviderPreset{
    pub id:String,
    pub name:String,
    #[serde(rename="type",default="default_preset_type")]
    pub preset_type:String,
    pub sources:Vec<ProviderPresetSource>,
    #[serde(rename="activeSourceId")]
    pub active_source_id:Option<String>,
    #[serde(rename="providerId")]
    pub provider_id:Option<String>,
    #[serde(rename="baseUrl")]
    pub base_url:Option<String>,
    pub model:Option<String>,
    #[serde(rename="credentialReference")]
    pub credential_reference:Option<CredentialReference>,
    pub enabled:Option<bool>,
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

#[derive(Debug,Deserialize,Serialize,Clone)]
#[serde(deny_unknown_fields)]
struct LegacyProviderPreset{
    pub id:String,
    pub name:String,
    #[serde(rename="providerId")]
    pub provider_id:String,
    #[serde(rename="baseUrl")]
    pub base_url:String,
    #[serde(rename="credentialProfileId")]
    pub credential_profile_id:Option<String>,
    pub model:Option<String>,
    #[serde(rename="timeoutMs")]
    pub timeout_ms:Option<f64>,
    #[serde(rename="createdAt")]
    pub created_at:String,
    #[serde(rename="updatedAt")]
    pub updated_at:String,
}

#[derive(Debug,Deserialize,Serialize,Clone)]
#[serde(deny_unknown_fields)]
struct LegacyProviderPresetStoreState{
    #[serde(rename="apiVersion")]
    pub api_version:String,
    #[serde(rename="schemaVersion")]
    pub schema_version:String,
    pub presets:Vec<LegacyProviderPreset>,
    #[serde(rename="activePresetId")]
    pub active_preset_id:Option<String>,
}

fn config_dir(app:&tauri::AppHandle)->Result<PathBuf,String>{
    let directory=app.path().app_config_dir().map_err(|e|format!("failed to resolve app config directory: {e}"))?;
    fs::create_dir_all(&directory).map_err(|e|format!("failed to create app config directory: {e}"))?;
    Ok(directory)
}
pub fn config_path(app:&tauri::AppHandle)->Result<PathBuf,String>{Ok(config_dir(app)?.join("provider-presets-v1.json"))}
fn invalid_backup_path(path:&Path)->PathBuf{path.with_file_name("provider-presets-v1.invalid.json")}

fn validate_reference(reference:&CredentialReference,provider_id:&str)->Result<(),String>{
    if reference.id.trim().is_empty()||reference.id.len()>200{return Err("provider preset credential reference id is invalid".to_string());}
    if reference.kind!="api-key"{return Err("provider preset credential reference kind must be api-key".to_string());}
    if let Some(provider)=&reference.provider{
        if provider!=provider_id{return Err("provider preset credential reference provider does not match source provider".to_string());}
    }
    Ok(())
}

fn validate_source(source:&ProviderPresetSource)->Result<(),String>{
    if source.id.trim().is_empty()||source.id.len()>200{return Err("provider preset source id is invalid".to_string());}
    if source.name.trim().is_empty()||source.name.len()>200{return Err("provider preset source name is invalid".to_string());}
    if source.provider_id.trim().is_empty()||source.provider_id.len()>100{return Err("provider preset source provider id is invalid".to_string());}
    if source.base_url.trim()!=source.base_url{return Err("provider preset source base URL must not have surrounding whitespace".to_string());}
    let url=url::Url::parse(&source.base_url).map_err(|_|"provider preset source base URL is invalid".to_string())?;
    if url.scheme()!="http"&&url.scheme()!="https"{return Err("provider preset source base URL must use HTTP or HTTPS".to_string());}
    if !url.username().is_empty()||url.password().is_some(){return Err("provider preset source base URL must not contain credentials".to_string());}
    if url.query().is_some()||url.fragment().is_some(){return Err("provider preset source base URL must not contain query or fragment".to_string());}
    if source.model.trim().is_empty()||source.model.len()>200{return Err("provider preset source model is invalid".to_string());}
    if let Some(reference)=&source.credential_reference{validate_reference(reference,&source.provider_id)?;}
    if !matches!(source.health.as_str(),"healthy"|"cooldown"|"unavailable"){return Err("unsupported provider preset source health state".to_string());}
    if let Some(timeout)=source.timeout_ms{if !timeout.is_finite()||timeout<=0.0{return Err("provider preset source timeout must be finite and positive".to_string());}}
    if source.created_at.trim().is_empty()||source.updated_at.trim().is_empty(){return Err("provider preset source timestamps must not be empty".to_string());}
    Ok(())
}

fn validate_preset(preset:&ProviderPreset)->Result<(),String>{
    if preset.id.trim().is_empty()||preset.id.len()>200{return Err("provider preset id is invalid".to_string());}
    if preset.name.trim().is_empty()||preset.name.len()>200{return Err("provider preset name is invalid".to_string());}
    if preset.created_at.trim().is_empty()||preset.updated_at.trim().is_empty(){return Err("provider preset timestamps must not be empty".to_string());}
    let mut source_ids=HashSet::new();
    for source in &preset.sources{
        validate_source(source)?;
        if !source_ids.insert(source.id.clone()){return Err("provider preset contains duplicate source ids".to_string());}
    }
    match preset.preset_type.as_str(){
        "pool"=>{
            if preset.sources.is_empty(){return Err("pool preset must contain at least one source".to_string());}
            if preset.provider_id.is_some()||preset.base_url.is_some()||preset.model.is_some()||preset.credential_reference.is_some()||preset.enabled.is_some()||preset.timeout_ms.is_some(){
                return Err("pool preset must not contain direct single-provider configuration fields".to_string());
            }
            if let Some(active)=&preset.active_source_id{
                if !preset.sources.iter().any(|source|&source.id==active){return Err("activeSourceId must reference an existing provider source".to_string());}
            }
        },
        "single"=>{
            if !preset.sources.is_empty(){return Err("single preset must not contain pool sources".to_string());}
            if preset.active_source_id.is_some(){return Err("single preset activeSourceId must be null".to_string());}
            let provider=preset.provider_id.as_deref().ok_or_else(||"single preset providerId is required".to_string())?;
            if provider!="openai-compatible"&&provider!="gemini"{return Err("single preset providerId is unsupported".to_string());}
            let base=preset.base_url.as_deref().ok_or_else(||"single preset baseUrl is required".to_string())?;
            if base.trim()!=base{return Err("single preset base URL must not have surrounding whitespace".to_string());}
            let url=url::Url::parse(base).map_err(|_|"single preset base URL is invalid".to_string())?;
            if url.scheme()!="http"&&url.scheme()!="https"{return Err("single preset base URL must use HTTP or HTTPS".to_string());}
            if !url.username().is_empty()||url.password().is_some(){return Err("single preset base URL must not contain credentials".to_string());}
            if url.query().is_some()||url.fragment().is_some(){return Err("single preset base URL must not contain query or fragment".to_string());}
            let model=preset.model.as_deref().ok_or_else(||"single preset model is required".to_string())?;
            if model.trim().is_empty()||model.len()>200{return Err("single preset model is invalid".to_string());}
            let reference=preset.credential_reference.as_ref().ok_or_else(||"single preset credentialReference is required".to_string())?;
            if reference.provider.as_deref()!=Some(provider){return Err("single preset credentialReference provider must match providerId".to_string());}
            validate_reference(reference,provider)?;
            if preset.enabled.is_none(){return Err("single preset enabled state is required".to_string());}
            if let Some(timeout)=preset.timeout_ms{if !timeout.is_finite()||timeout<=0.0{return Err("single preset timeout must be finite and positive".to_string());}}
        },
        _=>return Err("unsupported provider preset type".to_string())
    }
    Ok(())
}

fn validate_state(state:&ProviderPresetStoreState)->Result<(),String>{
    if state.api_version!=API_VERSION||state.schema_version!=SCHEMA_VERSION{return Err("unsupported provider preset storage version".to_string());}
    let mut ids=HashSet::new();
    for preset in &state.presets{
        validate_preset(preset)?;
        if !ids.insert(preset.id.clone()){return Err("provider preset storage contains duplicate ids".to_string());}
    }
    if let Some(active)=&state.active_preset_id{
      if !state.presets.iter().any(|preset|&preset.id==active){return Err("activePresetId must reference an existing provider preset".to_string());}
    }
    Ok(())
}

fn validate_legacy_state(state:&LegacyProviderPresetStoreState)->Result<(),String>{
    if state.api_version!=API_VERSION||state.schema_version!=LEGACY_SCHEMA_VERSION{return Err("unsupported legacy provider preset storage version".to_string());}
    let mut ids=HashSet::new();
    for preset in &state.presets{
        if preset.id.trim().is_empty()||preset.name.trim().is_empty(){return Err("legacy provider preset contains invalid identifiers".to_string());}
        if !ids.insert(preset.id.clone()){return Err("legacy provider preset storage contains duplicate ids".to_string());}
    }
    if let Some(active)=&state.active_preset_id{
        if !state.presets.iter().any(|preset|&preset.id==active){return Err("legacy activePresetId must reference an existing provider preset".to_string());}
    }
    Ok(())
}

fn migrate_legacy_state(
    state:LegacyProviderPresetStoreState,
    credential_state:Option<&super::credential_profiles::CredentialProfileStoreState>
)->Result<ProviderPresetStoreState,String>{
    validate_legacy_state(&state)?;
    let presets=state.presets.into_iter().map(|preset|{
        let reference=preset.credential_profile_id.as_ref().and_then(|profile_id|
            credential_state.and_then(|profiles|profiles.profiles.iter().find(|profile|profile.id==*profile_id))
        ).map(|profile|CredentialReference{
            id:profile.credential_reference.id.clone(),
            kind:profile.credential_reference.kind.clone(),
            provider:profile.credential_reference.provider.clone(),
            version:profile.credential_reference.version.clone()
        });
        let source_id=format!("source:{}:primary",preset.id);
        let enabled=preset.model.as_deref().map(|value|!value.trim().is_empty()).unwrap_or(false);
        let model=preset.model.unwrap_or_else(||"unconfigured".to_string());
        let source=ProviderPresetSource{
            id:source_id.clone(),
            name:if preset.name.trim().is_empty(){"Primary".to_string()}else{preset.name.clone()},
            provider_id:preset.provider_id,
            base_url:preset.base_url,
            model,
            credential_reference:reference,
            enabled,
            health:"healthy".to_string(),
            failure_count:0,
            cooldown_until:None,
            timeout_ms:preset.timeout_ms,
            created_at:preset.created_at.clone(),
            updated_at:preset.updated_at.clone(),
        };
        ProviderPreset{
            id:preset.id,
            name:preset.name,
            preset_type:"pool".to_string(),
            sources:vec![source],
            active_source_id:Some(source_id),
            provider_id:None,
            base_url:None,
            model:None,
            credential_reference:None,
            enabled:None,
            timeout_ms:None,
            created_at:preset.created_at,
            updated_at:preset.updated_at,
        }
    }).collect();
    let migrated=ProviderPresetStoreState{
        api_version:API_VERSION.to_string(),
        schema_version:SCHEMA_VERSION.to_string(),
        presets,
        active_preset_id:state.active_preset_id,
    };
    validate_state(&migrated)?;
    Ok(migrated)
}

enum DecodedProviderPresetState{
    Current(ProviderPresetStoreState),
    Version2(ProviderPresetStoreState),
    Legacy(LegacyProviderPresetStoreState),
}
fn decode(bytes:&[u8])->Result<DecodedProviderPresetState,String>{
    let value:serde_json::Value=serde_json::from_slice(bytes).map_err(|e|format!("invalid provider preset storage file: {e}"))?;
    let schema=value.get("schemaVersion").and_then(serde_json::Value::as_str).unwrap_or_default();
    if schema==SCHEMA_VERSION{
        let presets=value.get("presets").and_then(serde_json::Value::as_array)
            .ok_or_else(||"invalid provider preset storage: presets must be an array".to_string())?;
        if presets.iter().any(|preset|preset.get("type").and_then(serde_json::Value::as_str).is_none()){
            return Err("provider preset type is required for schema v3".to_string());
        }
        let state:ProviderPresetStoreState=serde_json::from_value(value).map_err(|e|format!("invalid provider preset storage file: {e}"))?;
        validate_state(&state)?;
        Ok(DecodedProviderPresetState::Current(state))
    }else if schema==V2_SCHEMA_VERSION{
        let mut state:ProviderPresetStoreState=serde_json::from_value(value).map_err(|e|format!("invalid v2 provider preset storage file: {e}"))?;
        state.schema_version=SCHEMA_VERSION.to_string();
        // The serde default maps a missing discriminator to the legacy pool type. All source
        // ordering, activeSourceId and CredentialStore references remain untouched.
        validate_state(&state)?;
        Ok(DecodedProviderPresetState::Version2(state))
    }else if schema==LEGACY_SCHEMA_VERSION{
        let state:LegacyProviderPresetStoreState=serde_json::from_value(value).map_err(|e|format!("invalid legacy provider preset storage file: {e}"))?;
        Ok(DecodedProviderPresetState::Legacy(state))
    }else{
        Err("unsupported provider preset storage version".to_string())
    }
}

fn quarantine(path:&Path)->Result<(),String>{
    let backup=invalid_backup_path(path);
    if backup.exists(){return Err("invalid provider preset storage was detected, but the existing recovery backup prevents another automatic quarantine.".to_string());}
    fs::rename(path,&backup).map_err(|e|format!("failed to quarantine invalid provider preset storage: {e}"))?;
    Ok(())
}

fn load_from_path(path:&Path,credential_state:Option<&super::credential_profiles::CredentialProfileStoreState>)->Result<Option<ProviderPresetStoreState>,String>{
    if !path.exists(){return Ok(None);}
    let bytes=fs::read(path).map_err(|e|format!("failed to read provider preset storage: {e}"))?;
    match decode(&bytes){
        Ok(DecodedProviderPresetState::Current(state))=>Ok(Some(state)),
        Ok(DecodedProviderPresetState::Version2(state))=>{
            save_to_path(path,&state)?;
            Ok(Some(state))
        },
        Ok(DecodedProviderPresetState::Legacy(legacy))=>{
            let state=migrate_legacy_state(legacy,credential_state)?;
            save_to_path(path,&state)?;
            Ok(Some(state))
        },
        Err(reason)=>{quarantine(path)?;Err(format!("provider preset storage was quarantined after validation failed: {reason}"))}
    }
}

fn save_to_path(path:&Path,state:&ProviderPresetStoreState)->Result<(),String>{
    validate_state(state)?;
    let tmp=path.with_extension("json.tmp");
    let encoded=serde_json::to_vec_pretty(state).map_err(|e|format!("failed to serialize provider preset storage: {e}"))?;
    let mut file=fs::File::create(&tmp).map_err(|e|format!("failed to create provider preset temp file: {e}"))?;
    file.write_all(&encoded).map_err(|e|format!("failed to write provider preset storage: {e}"))?;
    file.sync_all().map_err(|e|format!("failed to flush provider preset storage: {e}"))?;
    drop(file);
    if path.exists(){fs::remove_file(path).map_err(|e|format!("failed to replace provider preset storage: {e}"))?;}
    fs::rename(&tmp,path).map_err(|e|format!("failed to commit provider preset storage: {e}"))?;
    Ok(())
}

pub fn load(app:&tauri::AppHandle)->Result<Option<ProviderPresetStoreState>,String>{
    let credential_state=super::credential_profiles::load(app)?;
    load_from_path(&config_path(app)?,credential_state.as_ref())
}
pub fn save(app:&tauri::AppHandle,state:&ProviderPresetStoreState)->Result<(),String>{save_to_path(&config_path(app)?,state)}
pub fn delete(app:&tauri::AppHandle,id:&str)->Result<(),String>{
    if id.trim().is_empty(){return Err("provider preset id must not be empty".to_string());}
    let path=config_path(app)?;
    let credential_state=super::credential_profiles::load(app)?;
    let Some(mut state)=load_from_path(&path,credential_state.as_ref())? else{return Ok(())};
    state.presets.retain(|preset|preset.id!=id);
    if state.active_preset_id.as_deref()==Some(id){state.active_preset_id=state.presets.first().map(|preset|preset.id.clone());}
    if state.presets.is_empty(){if path.exists(){fs::remove_file(path).map_err(|e|format!("failed to remove empty provider preset storage: {e}"))?;}Ok(())}else{save_to_path(&path,&state)}
}

#[cfg(test)]
mod tests{
use super::*;
use std::{fs,time::{SystemTime,UNIX_EPOCH}};

fn reference(id:&str,provider:&str)->CredentialReference{CredentialReference{id:id.to_string(),kind:"api-key".to_string(),provider:Some(provider.to_string()),version:Some("1".to_string())}}
fn legacy_preset(id:&str)->LegacyProviderPreset{LegacyProviderPreset{id:id.to_string(),name:id.to_string(),provider_id:"openai-compatible".to_string(),base_url:"https://api.example.test/v1".to_string(),credential_profile_id:Some("credential-profile:a".to_string()),model:Some("model".to_string()),timeout_ms:Some(30000.0),created_at:"2026-09-28T00:00:00Z".to_string(),updated_at:"2026-09-28T00:00:00Z".to_string()}}
fn legacy_state()->LegacyProviderPresetStoreState{LegacyProviderPresetStoreState{api_version:API_VERSION.to_string(),schema_version:LEGACY_SCHEMA_VERSION.to_string(),presets:vec![legacy_preset("preset-a")],active_preset_id:Some("preset-a".to_string())}}
fn credential_state()->super::super::credential_profiles::CredentialProfileStoreState{
    super::super::credential_profiles::CredentialProfileStoreState{
      api_version:"1".to_string(),
      schema_version:"1".to_string(),
      profiles:vec![
        super::super::credential_profiles::CredentialProfile{
          id:"credential-profile:a".to_string(),
          label:"Main".to_string(),
          provider_id:"openai-compatible".to_string(),
          credential_reference:super::super::windows_credentials::CredentialReference{id:"credential-a".to_string(),kind:"api-key".to_string(),provider:Some("openai-compatible".to_string()),version:Some("1".to_string())},
          created_at:"2026-09-28T00:00:00Z".to_string(),
          updated_at:"2026-09-28T00:00:00Z".to_string()
        }
      ]
    }
}
fn source(id:&str)->ProviderPresetSource{ProviderPresetSource{id:id.to_string(),name:"Main".to_string(),provider_id:"openai-compatible".to_string(),base_url:"https://api.example.test/v1".to_string(),model:"model".to_string(),credential_reference:Some(reference("credential-a","openai-compatible")),enabled:true,health:"healthy".to_string(),failure_count:0,cooldown_until:None,timeout_ms:Some(30000.0),created_at:"2026-09-28T00:00:00Z".to_string(),updated_at:"2026-09-28T00:00:00Z".to_string()}}
fn preset(id:&str)->ProviderPreset{let source_id=format!("source:{}:primary",id);ProviderPreset{id:id.to_string(),name:id.to_string(),preset_type:"pool".to_string(),sources:vec![source(&source_id)],active_source_id:Some(source_id),provider_id:None,base_url:None,model:None,credential_reference:None,enabled:None,timeout_ms:None,created_at:"2026-09-28T00:00:00Z".to_string(),updated_at:"2026-09-28T00:00:00Z".to_string()}}
fn state()->ProviderPresetStoreState{ProviderPresetStoreState{api_version:API_VERSION.to_string(),schema_version:SCHEMA_VERSION.to_string(),presets:vec![preset("preset-a")],active_preset_id:Some("preset-a".to_string())}}
fn single_preset(id:&str)->ProviderPreset{ProviderPreset{id:id.to_string(),name:id.to_string(),preset_type:"single".to_string(),sources:vec![],active_source_id:None,provider_id:Some("openai-compatible".to_string()),base_url:Some("https://single.example/v1".to_string()),model:Some("single-model".to_string()),credential_reference:Some(reference("single-credential","openai-compatible")),enabled:Some(true),timeout_ms:Some(15000.0),created_at:"2026-09-28T00:00:00Z".to_string(),updated_at:"2026-09-28T00:00:00Z".to_string()}}

#[test]fn rejects_unknown_fields(){
 let value=serde_json::json!({"id":"x","name":"X","sources":[],"activeSourceId":null,"createdAt":"x","updatedAt":"x","secret":"bad"});
 assert!(serde_json::from_value::<ProviderPreset>(value).is_err());
}
#[test]fn persists_and_restores_active(){
 let path=temp("roundtrip");save_to_path(&path,&state()).unwrap();let loaded=load_from_path(&path,None).unwrap().unwrap();
 assert_eq!(loaded.active_preset_id.as_deref(),Some("preset-a"));
 assert_eq!(loaded.presets[0].sources[0].credential_reference.as_ref().unwrap().id,"credential-a");
 let raw=fs::read_to_string(&path).unwrap();
 assert!(!raw.contains("apiKey"));assert!(!raw.contains("secret"));
 fs::remove_dir_all(path.parent().unwrap()).unwrap();
}
#[test]fn migrates_legacy_preset_and_preserves_credential_reference(){
 let migrated=migrate_legacy_state(legacy_state(),Some(&credential_state())).unwrap();
 let source=&migrated.presets[0].sources[0];
 assert_eq!(migrated.schema_version,SCHEMA_VERSION);
 assert_eq!(source.id,"source:preset-a:primary");
 assert_eq!(source.credential_reference.as_ref().unwrap().id,"credential-a");
 assert_eq!(source.model,"model");
 assert_eq!(source.timeout_ms,Some(30000.0));
}
#[test]fn legacy_missing_model_becomes_unconfigured_and_disabled(){
 let mut legacy=legacy_state();legacy.presets[0].model=None;
 let migrated=migrate_legacy_state(legacy,None).unwrap();
 assert_eq!(migrated.presets[0].sources[0].model,"unconfigured");
 assert!(!migrated.presets[0].sources[0].enabled);
}
#[test]fn migrates_v2_presets_without_discriminator_to_pool_and_preserves_sources(){
 let path=temp("v2-migration");
 let mut old=state();
 old.schema_version=V2_SCHEMA_VERSION.to_string();
 old.presets[0].sources=vec![source("source-first"),source("source-backup")];
 old.presets[0].active_source_id=Some("source-backup".to_string());
 let mut value=serde_json::to_value(old).unwrap();
 value["schemaVersion"]=serde_json::Value::String(V2_SCHEMA_VERSION.to_string());
 for preset_value in value["presets"].as_array_mut().unwrap(){
  let object=preset_value.as_object_mut().unwrap();
  object.remove("type");object.remove("providerId");object.remove("baseUrl");object.remove("model");
  object.remove("credentialReference");object.remove("enabled");object.remove("timeoutMs");
 }
 fs::write(&path,serde_json::to_vec(&value).unwrap()).unwrap();
 let migrated=load_from_path(&path,None).unwrap().unwrap();
 assert_eq!(migrated.schema_version,SCHEMA_VERSION);
 assert_eq!(migrated.presets[0].preset_type,"pool");
 assert_eq!(migrated.presets[0].sources.iter().map(|item|item.id.as_str()).collect::<Vec<_>>(),vec!["source-first","source-backup"]);
 assert_eq!(migrated.presets[0].active_source_id.as_deref(),Some("source-backup"));
 assert_eq!(migrated.presets[0].sources[0].credential_reference.as_ref().unwrap().id,"credential-a");
 let saved:serde_json::Value=serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
 assert_eq!(saved["schemaVersion"],"3");
 assert_eq!(saved["presets"][0]["type"],"pool");
 fs::remove_dir_all(path.parent().unwrap()).unwrap();
}
#[test]fn accepts_valid_single_api_configuration(){
 let mut s=state();s.presets=vec![single_preset("single-a")];s.active_preset_id=Some("single-a".to_string());
 assert!(validate_state(&s).is_ok());
}
#[test]fn rejects_single_preset_with_pool_sources_or_missing_credential(){
 let mut s=state();s.presets=vec![single_preset("single-a")];s.active_preset_id=Some("single-a".to_string());
 s.presets[0].sources=vec![source("unexpected-pool-source")];
 assert!(validate_state(&s).is_err());
 s.presets[0].sources.clear();s.presets[0].credential_reference=None;
 assert!(validate_state(&s).is_err());
}
#[test]fn rejects_invalid_active_source(){
 let mut s=state();s.presets[0].active_source_id=Some("missing".to_string());assert!(validate_state(&s).is_err());
}
#[test]fn rejects_query_in_base_url(){
 let mut s=state();s.presets[0].sources[0].base_url.push_str("?key=secret");assert!(validate_state(&s).is_err());
}
fn temp(name:&str)->PathBuf{let stamp=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();let dir=std::env::temp_dir().join(format!("nova-provider-presets-{name}-{stamp}"));fs::create_dir_all(&dir).unwrap();dir.join("provider-presets-v1.json")}
}
