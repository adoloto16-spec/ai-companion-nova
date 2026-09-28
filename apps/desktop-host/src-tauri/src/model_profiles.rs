use serde::{Deserialize,Serialize};
use serde_json::{Map,Value};
use std::{collections::HashSet,fs,io::Write,path::{Path,PathBuf}};
use tauri::Manager;

const API_VERSION:&str="1";
const SCHEMA_VERSION:&str="2";

#[derive(Debug,Deserialize,Serialize,Clone)]
#[serde(rename_all="lowercase")]
pub enum ResponseFormatType{Text,Json}

#[derive(Debug,Deserialize,Serialize,Clone)]
#[serde(deny_unknown_fields)]
pub struct ResponseFormat{
    #[serde(rename="type")]
    pub format_type:ResponseFormatType,
    #[serde(skip_serializing_if="Option::is_none")]
    pub schema:Option<Map<String,Value>>,
}

#[derive(Debug,Deserialize,Serialize,Clone)]
#[serde(deny_unknown_fields)]
pub struct ChatGenerationOptions{
    #[serde(skip_serializing_if="Option::is_none")]
    pub temperature:Option<f64>,
    #[serde(rename="maxTokens",skip_serializing_if="Option::is_none")]
    pub max_tokens:Option<i64>,
    #[serde(rename="topP",skip_serializing_if="Option::is_none")]
    pub top_p:Option<f64>,
    #[serde(rename="responseFormat",skip_serializing_if="Option::is_none")]
    pub response_format:Option<ResponseFormat>,
}

#[derive(Debug,Deserialize,Serialize,Clone)]
#[serde(deny_unknown_fields)]
pub struct ModelProfile{
    #[serde(rename="apiVersion")]
    pub api_version:String,
    #[serde(rename="schemaVersion")]
    pub schema_version:String,
    pub id:String,
    #[serde(rename="characterId")]
    pub character_id:String,
    #[serde(rename="providerId",skip_serializing_if="Option::is_none")]
    pub provider_id:Option<String>,
    #[serde(rename="providerPresetId",skip_serializing_if="Option::is_none")]
    pub provider_preset_id:Option<String>,
    #[serde(skip_serializing_if="Option::is_none")]
    pub model:Option<String>,
    pub generation:ChatGenerationOptions,
    #[serde(rename="createdAt")]
    pub created_at:String,
    #[serde(rename="updatedAt")]
    pub updated_at:String,
}

#[derive(Debug,Deserialize,Serialize,Clone)]
#[serde(deny_unknown_fields)]
pub struct ModelProfileStoreState{
    #[serde(rename="apiVersion")]
    pub api_version:String,
    #[serde(rename="schemaVersion")]
    pub schema_version:String,
    pub profiles:Vec<ModelProfile>,
}

fn config_dir(app:&tauri::AppHandle)->Result<PathBuf,String>{
    let directory=app.path().app_config_dir().map_err(|e|format!("failed to resolve app config directory: {e}"))?;
    fs::create_dir_all(&directory).map_err(|e|format!("failed to create app config directory: {e}"))?;
    Ok(directory)
}

pub fn config_path(app:&tauri::AppHandle)->Result<PathBuf,String>{
    Ok(config_dir(app)?.join("model-profiles-v1.json"))
}

fn validate_generation(generation:&ChatGenerationOptions)->Result<(),String>{
    if let Some(value)=generation.temperature{
        if !(0.0..=2.0).contains(&value){return Err("temperature must be between 0 and 2".to_string());}
    }
    if let Some(value)=generation.top_p{
        if !(0.0..=1.0).contains(&value){return Err("topP must be between 0 and 1".to_string());}
    }
    if let Some(value)=generation.max_tokens{
        if value<1{return Err("maxTokens must be at least 1".to_string());}
    }
    Ok(())
}

fn validate_profile(profile:&ModelProfile)->Result<(),String>{
    if profile.api_version!=API_VERSION||profile.schema_version!=SCHEMA_VERSION{return Err("unsupported model profile version".to_string());}
    if profile.id.trim().is_empty(){return Err("model profile id must not be empty".to_string());}
    if profile.id.len()>200{return Err("model profile id must not exceed 200 characters".to_string());}
    if profile.character_id.trim().is_empty(){return Err("model profile character id must not be empty".to_string());}
    if let Some(provider_id)=&profile.provider_id{
        if provider_id.trim().is_empty(){return Err("model profile providerId must not be empty".to_string());}
    }
    if let Some(provider_preset_id)=&profile.provider_preset_id{
        if provider_preset_id.trim().is_empty(){return Err("model profile providerPresetId must not be empty".to_string());}
    }
    if let Some(model)=&profile.model{
        if model.trim().is_empty(){return Err("model profile model must not be empty".to_string());}
    }
    if profile.created_at.trim().is_empty()||profile.updated_at.trim().is_empty(){return Err("model profile timestamps must not be empty".to_string());}
    validate_generation(&profile.generation)
}

fn validate_state(state:&ModelProfileStoreState)->Result<(),String>{
    if state.api_version!=API_VERSION||state.schema_version!=SCHEMA_VERSION{return Err("unsupported model profile storage version".to_string());}
    let mut ids=HashSet::new();
    let mut character_ids=HashSet::new();
    for profile in &state.profiles{
        validate_profile(profile)?;
        if !ids.insert(profile.id.clone()){return Err("model profile storage contains duplicate ids".to_string());}
        if !character_ids.insert(profile.character_id.clone()){return Err("model profile storage contains multiple profiles for one character".to_string());}
    }
    Ok(())
}

fn decode(bytes:&[u8])->Result<ModelProfileStoreState,String>{
    let value:Value=serde_json::from_slice(bytes).map_err(|e|format!("invalid model profile storage file: {e}"))?;
    let legacy=value.get("schemaVersion").and_then(Value::as_str)==Some("1");
    let mut state:ModelProfileStoreState=serde_json::from_value(value).map_err(|e|format!("invalid model profile storage file: {e}"))?;
    if legacy{
        state.schema_version=SCHEMA_VERSION.to_string();
        for profile in &mut state.profiles{profile.schema_version=SCHEMA_VERSION.to_string();}
    }
    validate_state(&state)?;
    Ok(state)
}

fn invalid_backup_path(path:&Path)->PathBuf{
    path.with_file_name("model-profiles-v1.invalid.json")
}

fn quarantine_invalid_storage(path:&Path)->Result<(),String>{
    let backup=invalid_backup_path(path);
    if backup.exists(){
        return Err("invalid model profile storage was detected, but the existing recovery backup prevents another automatic quarantine.".to_string());
    }
    fs::rename(path,&backup).map_err(|e|format!("failed to quarantine invalid model profile storage: {e}"))?;
    Ok(())
}

fn load_from_path(path:&Path)->Result<Option<ModelProfileStoreState>,String>{
    if !path.exists(){return Ok(None);}
    let bytes=fs::read(path).map_err(|e|format!("failed to read model profile storage: {e}"))?;
    match decode(&bytes){
        Ok(state)=>Ok(Some(state)),
        Err(reason)=>{
            quarantine_invalid_storage(path)?;
            Err(format!("model profile storage was quarantined after validation failed: {reason}"))
        }
    }
}

fn save_to_path(path:&Path,state:&ModelProfileStoreState)->Result<(),String>{
    validate_state(state)?;
    let tmp=path.with_extension("json.tmp");
    let encoded=serde_json::to_vec_pretty(state).map_err(|e|format!("failed to serialize model profile storage: {e}"))?;
    let mut file=fs::File::create(&tmp).map_err(|e|format!("failed to create model profile storage temp file: {e}"))?;
    file.write_all(&encoded).map_err(|e|format!("failed to write model profile storage: {e}"))?;
    file.sync_all().map_err(|e|format!("failed to flush model profile storage: {e}"))?;
    drop(file);
    if path.exists(){fs::remove_file(path).map_err(|e|format!("failed to replace model profile storage: {e}"))?;}
    fs::rename(&tmp,path).map_err(|e|format!("failed to commit model profile storage: {e}"))?;
    Ok(())
}

pub fn load(app:&tauri::AppHandle,character_id:&str)->Result<Option<ModelProfile>,String>{
    if character_id.trim().is_empty(){return Err("character id must not be empty".to_string());}
    let path=config_path(app)?;
    let Some(state)=load_from_path(&path)? else{return Ok(None);};
    Ok(state.profiles.into_iter().find(|profile|profile.character_id==character_id))
}

pub fn save(app:&tauri::AppHandle,profile:&ModelProfile)->Result<(),String>{
    validate_profile(profile)?;
    let path=config_path(app)?;
    let mut state=match load_from_path(&path)?{
        Some(state)=>state,
        None=>ModelProfileStoreState{api_version:API_VERSION.to_string(),schema_version:SCHEMA_VERSION.to_string(),profiles:Vec::new()}
    };
    state.profiles.retain(|item|item.character_id!=profile.character_id && item.id!=profile.id);
    state.profiles.push(profile.clone());
    save_to_path(&path,&state)
}

pub fn delete(app:&tauri::AppHandle,character_id:&str)->Result<(),String>{
    if character_id.trim().is_empty(){return Err("character id must not be empty".to_string());}
    let path=config_path(app)?;
    let Some(mut state)=load_from_path(&path)? else{return Ok(());};
    state.profiles.retain(|profile|profile.character_id!=character_id);
    if state.profiles.is_empty(){
        if path.exists(){fs::remove_file(&path).map_err(|e|format!("failed to remove empty model profile storage: {e}"))?;}
        Ok(())
    }else{save_to_path(&path,&state)}
}

#[cfg(test)]
mod tests{
    use super::*;
    use std::{fs,time::{SystemTime,UNIX_EPOCH}};

    fn valid_profile(id:&str,character_id:&str)->ModelProfile{
        ModelProfile{
            api_version:API_VERSION.to_string(),
            schema_version:SCHEMA_VERSION.to_string(),
            id:id.to_string(),
            character_id:character_id.to_string(),
            provider_id:Some("fake.chat".to_string()),
            provider_preset_id:None,
            model:Some("fake-chat".to_string()),
            generation:ChatGenerationOptions{temperature:Some(0.7),max_tokens:Some(200),top_p:Some(0.9),response_format:None},
            created_at:"2026-09-28T10:00:00.000Z".to_string(),
            updated_at:"2026-09-28T10:00:01.000Z".to_string()
        }
    }

    fn valid_state()->ModelProfileStoreState{
        ModelProfileStoreState{
            api_version:API_VERSION.to_string(),
            schema_version:SCHEMA_VERSION.to_string(),
            profiles:vec![valid_profile("model-profile:nova:default.v1","character.nova.default.v1")]
        }
    }

    fn temp_path(test_name:&str)->PathBuf{
        let stamp=SystemTime::now().duration_since(UNIX_EPOCH).expect("clock").as_nanos();
        let directory=std::env::temp_dir().join(format!("ai-companion-nova-model-profiles-{test_name}-{}-{stamp}",std::process::id()));
        fs::create_dir_all(&directory).expect("create temp directory");
        directory.join("model-profiles-v1.json")
    }

    #[test]
    fn canonical_generation_json_names_round_trip(){ 
        let mut schema=Map::new();
        schema.insert("kind".to_string(),Value::String("example".to_string()));
        let generation=ChatGenerationOptions{
            temperature:Some(0.55),
            max_tokens:Some(321),
            top_p:Some(0.75),
            response_format:Some(ResponseFormat{format_type:ResponseFormatType::Json,schema:Some(schema)})
        };
        let value=serde_json::to_value(&generation).expect("serialize");
        let object=value.as_object().expect("object");
        assert_eq!(object.get("temperature").and_then(Value::as_f64),Some(0.55));
        assert_eq!(object.get("maxTokens").and_then(Value::as_i64),Some(321));
        assert_eq!(object.get("topP").and_then(Value::as_f64),Some(0.75));
        assert!(object.get("responseFormat").is_some());
        assert!(object.get("top_p").is_none());
        assert!(object.get("max_tokens").is_none());
        assert!(object.get("response_format").is_none());
        let decoded:ChatGenerationOptions=serde_json::from_value(value).expect("deserialize");
        assert_eq!(decoded.temperature,Some(0.55));
        assert_eq!(decoded.max_tokens,Some(321));
        assert_eq!(decoded.top_p,Some(0.75));
        assert!(decoded.response_format.is_some());
    }

    #[test]
    fn accepts_canonical_tauri_save_payload(){ 
        let payload=serde_json::json!({
            "apiVersion":"1",
            "schemaVersion":"1",
            "id":"model-profile:nova:default.v1",
            "characterId":"character.nova.default.v1",
            "providerId":"fake.chat",
            "model":"nova-model",
            "generation":{
                "temperature":0.55,
                "maxTokens":321,
                "topP":0.75,
                "responseFormat":{"type":"json","schema":{"kind":"example"}}
            },
            "createdAt":"2026-09-28T10:00:00.000Z",
            "updatedAt":"2026-09-28T10:01:00.000Z"
        });
        let profile:ModelProfile=serde_json::from_value(payload).expect("canonical Tauri payload must deserialize");
        assert_eq!(profile.provider_id.as_deref(),Some("fake.chat"));
        assert_eq!(profile.model.as_deref(),Some("nova-model"));
        assert_eq!(profile.generation.temperature,Some(0.55));
        assert_eq!(profile.generation.max_tokens,Some(321));
        assert_eq!(profile.generation.top_p,Some(0.75));
        assert!(profile.generation.response_format.is_some());
        assert!(validate_profile(&profile).is_ok());
    }

    #[test]
    fn model_profile_file_round_trip_preserves_canonical_fields(){
        let path=temp_path("round-trip");
        let profile=valid_profile("model-profile:nova:default.v1","character.nova.default.v1");
        let state=ModelProfileStoreState{
            api_version:API_VERSION.to_string(),
            schema_version:SCHEMA_VERSION.to_string(),
            profiles:vec![profile.clone()]
        };
        save_to_path(&path,&state).expect("save");
        let raw=fs::read_to_string(&path).expect("read");
        assert!(raw.contains("\"providerId\""));
        assert!(raw.contains("\"maxTokens\""));
        assert!(raw.contains("\"topP\""));
        assert!(!raw.contains("\"top_p\""));
        let loaded=load_from_path(&path).expect("load").expect("state");
        let restored=&loaded.profiles[0];
        assert_eq!(restored.api_version,profile.api_version);
        assert_eq!(restored.schema_version,profile.schema_version);
        assert_eq!(restored.id,profile.id);
        assert_eq!(restored.character_id,profile.character_id);
        assert_eq!(restored.provider_id,profile.provider_id);
        assert_eq!(restored.provider_preset_id,profile.provider_preset_id);
        assert_eq!(restored.model,profile.model);
        assert_eq!(restored.generation.temperature,profile.generation.temperature);
        assert_eq!(restored.generation.max_tokens,profile.generation.max_tokens);
        assert_eq!(restored.generation.top_p,profile.generation.top_p);
        assert_eq!(restored.created_at,profile.created_at);
        assert_eq!(restored.updated_at,profile.updated_at);
        assert_eq!(
            serde_json::to_value(&restored.generation.response_format).expect("restored responseFormat"),
            serde_json::to_value(&profile.generation.response_format).expect("expected responseFormat")
        );
        fs::remove_dir_all(path.parent().expect("directory")).expect("cleanup");
    #[test]
    fn migrates_schema_v1_to_v2(){
        let payload=serde_json::json!({
            "apiVersion":"1",
            "schemaVersion":"1",
            "profiles":[{
                "apiVersion":"1",
                "schemaVersion":"1",
                "id":"model-profile:nova:default.v1",
                "characterId":"character.nova.default.v1",
                "providerId":"openai-compatible",
                "model":"legacy-model",
                "generation":{},
                "createdAt":"2026-09-28T10:00:00.000Z",
                "updatedAt":"2026-09-28T10:00:00.000Z"
            }]
        });
        let state=decode(&serde_json::to_vec(&payload).expect("encode")).expect("legacy profile should migrate");
        assert_eq!(state.schema_version,"2");
        assert_eq!(state.profiles[0].schema_version,"2");
        assert_eq!(state.profiles[0].provider_id.as_deref(),Some("openai-compatible"));
        assert_eq!(state.profiles[0].provider_preset_id,None);
    }

    }

  #[test]
    fn accepts_valid_state(){
        assert!(decode(&serde_json::to_vec(&valid_state()).expect("encode")).is_ok());
    }

    #[test]
    fn rejects_malformed_state(){
        assert!(decode(br#"{"profiles":["#).is_err());
    }

    #[test]
    fn rejects_incompatible_state(){
        let mut state=valid_state();
        state.schema_version="0".to_string();
        assert!(decode(&serde_json::to_vec(&state).expect("encode")).is_err());
    }

    #[test]
    fn rejects_duplicate_profiles_for_character(){
        let mut state=valid_state();
        state.profiles.push(valid_profile("model-profile:nova:second.v1","character.nova.default.v1"));
        assert!(decode(&serde_json::to_vec(&state).expect("encode")).is_err());
    }

    #[test]
    fn rejects_invalid_generation_values(){
        let mut profile=valid_profile("model-profile:nova:default.v1","character.nova.default.v1");
        profile.generation.temperature=Some(3.0);
        assert!(validate_profile(&profile).is_err());
    }

    #[test]
    fn quarantines_invalid_storage_without_data_loss(){
        let path=temp_path("quarantine");
        let original=br#"{"legacy":true}"#;
        fs::write(&path,original).expect("write");
        let result=load_from_path(&path).expect_err("invalid state should be quarantined and reported");
        assert!(result.contains("quarantined"));
        assert!(!path.exists());
        assert_eq!(fs::read(invalid_backup_path(&path)).expect("backup"),original);
        fs::remove_dir_all(path.parent().expect("directory")).expect("cleanup");
    }

    #[test]
    fn refuses_second_quarantine_when_backup_exists(){
        let path=temp_path("duplicate-backup");
        let backup=invalid_backup_path(&path);
        let original=br#"{"first":true}"#;
        fs::write(&path,original).expect("write");
        fs::write(&backup,b"preserved").expect("backup");
        assert!(load_from_path(&path).is_err());
        assert_eq!(fs::read(&path).expect("source preserved"),original);
        assert_eq!(fs::read(&backup).expect("backup preserved"),b"preserved");
        fs::remove_dir_all(path.parent().expect("directory")).expect("cleanup");
    }

    #[test]
    fn preserves_character_isolation(){
        let mut state=valid_state();
        state.profiles.push(valid_profile("model-profile:gm:default.v1","character.gm.v1"));
        let path=temp_path("isolation");
        save_to_path(&path,&state).expect("save");
        let loaded=load_from_path(&path).expect("load").expect("state");
        let nova=loaded.profiles.iter().find(|item|item.character_id=="character.nova.default.v1").expect("nova");
        let gm=loaded.profiles.iter().find(|item|item.character_id=="character.gm.v1").expect("gm");
        assert_eq!(nova.model.as_deref(),Some("fake-chat"));
        assert_eq!(gm.character_id,"character.gm.v1");
        fs::remove_dir_all(path.parent().expect("directory")).expect("cleanup");
    }

    #[test]
    fn delete_removes_selected_character_profile(){
        let mut state=valid_state();
        state.profiles.push(valid_profile("model-profile:gm:default.v1","character.gm.v1"));
        let path=temp_path("delete");
        save_to_path(&path,&state).expect("save");
        let mut loaded=load_from_path(&path).expect("load").expect("state");
        loaded.profiles.retain(|profile|profile.character_id!="character.gm.v1");
        save_to_path(&path,&loaded).expect("save after delete");
        let result=load_from_path(&path).expect("reload").expect("state");
        assert_eq!(result.profiles.len(),1);
        assert_eq!(result.profiles[0].character_id,"character.nova.default.v1");
        fs::remove_dir_all(path.parent().expect("directory")).expect("cleanup");
    }
}
