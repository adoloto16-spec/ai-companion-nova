use serde::{Deserialize,Serialize};
use std::{collections::HashSet,fs,io::Write,path::PathBuf};
use tauri::Manager;

const SCHEMA_VERSION:&str="1";

#[derive(Debug,Deserialize,Serialize,Clone)]
#[serde(deny_unknown_fields)]
pub struct Character{
    pub id:String,
    pub name:String,
    pub description:String,
    #[serde(rename="createdAt")]
    pub created_at:String,
    #[serde(rename="updatedAt")]
    pub updated_at:String,
    pub enabled:bool,
}

#[derive(Debug,Deserialize,Serialize,Clone)]
#[serde(deny_unknown_fields)]
pub struct CharacterStoreState{
    #[serde(rename="apiVersion")]
    pub api_version:String,
    #[serde(rename="schemaVersion")]
    pub schema_version:String,
    pub characters:Vec<Character>,
    #[serde(rename="activeCharacterId")]
    pub active_character_id:String,
}

fn config_dir(app:&tauri::AppHandle)->Result<PathBuf,String>{
    let directory=app.path().app_config_dir().map_err(|e|format!("failed to resolve app config directory: {e}"))?;
    fs::create_dir_all(&directory).map_err(|e|format!("failed to create app config directory: {e}"))?;
    Ok(directory)
}
pub fn config_path(app:&tauri::AppHandle)->Result<PathBuf,String>{
    Ok(config_dir(app)?.join("characters-v1.json"))
}
fn validate_character(character:&Character)->Result<(),String>{
    if character.id.trim().is_empty(){return Err("character id must not be empty".to_string());}
    if character.name.trim().is_empty(){return Err("character name must not be empty".to_string());}
    if character.name.len()>120{return Err("character name must not exceed 120 characters".to_string());}
    if character.description.len()>4096{return Err("character description must not exceed 4096 characters".to_string());}
    if character.created_at.trim().is_empty()||character.updated_at.trim().is_empty(){return Err("character timestamps must not be empty".to_string());}
    Ok(())
}
fn validate(state:&CharacterStoreState)->Result<(),String>{
    if state.api_version!="1"||state.schema_version!=SCHEMA_VERSION{return Err("unsupported character storage version".to_string());}
    if state.characters.is_empty(){return Err("character storage must contain at least one character".to_string());}
    let mut ids=HashSet::new();
    for character in &state.characters{
        validate_character(character)?;
        if !ids.insert(character.id.clone()){return Err("character storage contains duplicate ids".to_string());}
    }
    if !ids.contains(&state.active_character_id){return Err("active character id is missing from storage".to_string());}
    Ok(())
}
pub fn load(app:&tauri::AppHandle)->Result<Option<CharacterStoreState>,String>{
    let path=config_path(app)?;
    if !path.exists(){return Ok(None);}
    let bytes=fs::read(&path).map_err(|e|format!("failed to read character storage: {e}"))?;
    let state:CharacterStoreState=serde_json::from_slice(&bytes).map_err(|e|format!("invalid character storage file: {e}"))?;
    validate(&state)?;
    Ok(Some(state))
}
pub fn save(app:&tauri::AppHandle,state:&CharacterStoreState)->Result<(),String>{
    validate(state)?;
    let path=config_path(app)?;
    let tmp=path.with_extension("json.tmp");
    let encoded=serde_json::to_vec_pretty(state).map_err(|e|format!("failed to serialize character storage: {e}"))?;
    let mut file=fs::File::create(&tmp).map_err(|e|format!("failed to create character storage temp file: {e}"))?;
    file.write_all(&encoded).map_err(|e|format!("failed to write character storage: {e}"))?;
    file.sync_all().map_err(|e|format!("failed to flush character storage: {e}"))?;
    drop(file);
    if path.exists(){fs::remove_file(&path).map_err(|e|format!("failed to replace character storage: {e}"))?;}
    fs::rename(&tmp,&path).map_err(|e|format!("failed to commit character storage: {e}"))?;
    Ok(())
}
