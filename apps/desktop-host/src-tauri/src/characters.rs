use serde::{Deserialize,Serialize};
use std::{collections::HashSet,fs,io::Write,path::{Path,PathBuf}};
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
fn decode(bytes:&[u8])->Result<CharacterStoreState,String>{
    let state:CharacterStoreState=serde_json::from_slice(bytes).map_err(|e|format!("invalid character storage file: {e}"))?;
    validate(&state)?;
    Ok(state)
}
fn invalid_backup_path(path:&Path)->PathBuf{
    path.with_file_name("characters-v1.invalid.json")
}
fn quarantine_invalid_storage(path:&Path)->Result<(),String>{
    let backup=invalid_backup_path(path);
    if backup.exists(){
        return Err("invalid character storage was detected, but the existing recovery backup prevents another automatic quarantine.".to_string());
    }
    fs::rename(path,&backup).map_err(|e|format!("failed to quarantine invalid character storage: {e}"))?;
    Ok(())
}
fn load_from_path(path:&Path)->Result<Option<CharacterStoreState>,String>{
    if !path.exists(){return Ok(None);}
    let bytes=fs::read(path).map_err(|e|format!("failed to read character storage: {e}"))?;
    match decode(&bytes){
        Ok(state)=>Ok(Some(state)),
        Err(_reason)=>{
            quarantine_invalid_storage(path)?;
            Ok(None)
        }
    }
}
pub fn load(app:&tauri::AppHandle)->Result<Option<CharacterStoreState>,String>{
    let path=config_path(app)?;
    load_from_path(&path)
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


#[cfg(test)]
mod tests{
    use super::*;
    use std::{fs,time::{SystemTime,UNIX_EPOCH}};

    fn valid_state()->CharacterStoreState{
        CharacterStoreState{
            api_version:"1".to_string(),
            schema_version:"1".to_string(),
            characters:vec![Character{
                id:"character.nova.default.v1".to_string(),
                name:"Nova".to_string(),
                description:"".to_string(),
                created_at:"2026-09-26T00:00:00.000Z".to_string(),
                updated_at:"2026-09-26T00:00:00.000Z".to_string(),
                enabled:true
            }],
            active_character_id:"character.nova.default.v1".to_string()
        }
    }

    fn temp_path(test_name:&str)->PathBuf{
        let stamp=SystemTime::now().duration_since(UNIX_EPOCH).expect("clock").as_nanos();
        let directory=std::env::temp_dir().join(format!("ai-companion-nova-characters-{test_name}-{}-{stamp}",std::process::id()));
        fs::create_dir_all(&directory).expect("create temp directory");
        directory.join("characters-v1.json")
    }

    #[test]
    fn accepts_valid_character_state(){
        let encoded=serde_json::to_vec(&valid_state()).expect("encode valid state");
        assert!(decode(&encoded).is_ok());
    }

    #[test]
    fn rejects_malformed_character_state(){
        assert!(decode(br#"{"characters":["#).is_err());
    }

    #[test]
    fn rejects_incompatible_character_state(){
        let mut state=valid_state();
        state.schema_version="0".to_string();
        let encoded=serde_json::to_vec(&state).expect("encode state");
        assert!(decode(&encoded).is_err());
    }

    #[test]
    fn rejects_empty_character_state(){
        let mut state=valid_state();
        state.characters.clear();
        let encoded=serde_json::to_vec(&state).expect("encode state");
        assert!(decode(&encoded).is_err());
    }

    #[test]
    fn rejects_duplicate_character_ids(){
        let mut state=valid_state();
        state.characters.push(state.characters[0].clone());
        let encoded=serde_json::to_vec(&state).expect("encode state");
        assert!(decode(&encoded).is_err());
    }

    #[test]
    fn rejects_unknown_active_character(){
        let mut state=valid_state();
        state.active_character_id="character.missing".to_string();
        let encoded=serde_json::to_vec(&state).expect("encode state");
        assert!(decode(&encoded).is_err());
    }

    #[test]
    fn quarantines_invalid_storage_without_data_loss(){
        let path=temp_path("quarantine");
        let original=br#"{"legacy":true}"#;
        fs::write(&path,original).expect("write invalid state");
        let result=load_from_path(&path).expect("invalid state should recover");
        assert!(result.is_none());
        assert!(!path.exists());
        let backup=invalid_backup_path(&path);
        assert_eq!(fs::read(&backup).expect("read recovery backup"),original);
        fs::remove_dir_all(path.parent().expect("temp directory")).expect("cleanup");
    }

    #[test]
    fn refuses_second_quarantine_when_backup_already_exists(){
        let path=temp_path("duplicate-backup");
        let backup=invalid_backup_path(&path);
        let original=br#"{"first":true}"#;
        fs::write(&path,original).expect("write invalid state");
        fs::write(&backup,b"preserved").expect("write existing backup");
        assert!(load_from_path(&path).is_err());
        assert_eq!(fs::read(&path).expect("current file preserved"),original);
        assert_eq!(fs::read(&backup).expect("backup preserved"),b"preserved");
        fs::remove_dir_all(path.parent().expect("temp directory")).expect("cleanup");
    }
}
