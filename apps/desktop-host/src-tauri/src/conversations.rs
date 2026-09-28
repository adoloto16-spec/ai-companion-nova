use serde::{Deserialize,Serialize};
use serde_json::{Map,Value};
use std::{collections::HashSet,fs,io::Write,path::{Path,PathBuf}};
use tauri::Manager;

const API_VERSION:&str="1";
const SCHEMA_VERSION:&str="1";

#[derive(Debug,Deserialize,Serialize,Clone)]
#[serde(rename_all="lowercase")]
pub enum ChatMessageRole{System,User,Assistant,Tool}

#[derive(Debug,Deserialize,Serialize,Clone)]
#[serde(deny_unknown_fields)]
pub struct ChatMessage{
    #[serde(skip_serializing_if="Option::is_none")]
    pub id:Option<String>,
    pub role:ChatMessageRole,
    pub content:String,
    #[serde(rename="toolCallId",skip_serializing_if="Option::is_none")]
    pub tool_call_id:Option<String>,
    #[serde(skip_serializing_if="Option::is_none")]
    pub metadata:Option<Map<String,Value>>,
}

#[derive(Debug,Deserialize,Serialize,Clone)]
#[serde(deny_unknown_fields)]
pub struct Conversation{
    #[serde(rename="apiVersion")]
    pub api_version:String,
    #[serde(rename="schemaVersion")]
    pub schema_version:String,
    pub id:String,
    #[serde(rename="characterId")]
    pub character_id:String,
    pub messages:Vec<ChatMessage>,
    #[serde(rename="createdAt")]
    pub created_at:String,
    #[serde(rename="updatedAt")]
    pub updated_at:String,
}

#[derive(Debug,Deserialize,Serialize,Clone)]
#[serde(deny_unknown_fields)]
pub struct ConversationStoreState{
    #[serde(rename="apiVersion")]
    pub api_version:String,
    #[serde(rename="schemaVersion")]
    pub schema_version:String,
    pub conversations:Vec<Conversation>,
}

fn config_dir(app:&tauri::AppHandle)->Result<PathBuf,String>{
    let directory=app.path().app_config_dir().map_err(|e|format!("failed to resolve app config directory: {e}"))?;
    fs::create_dir_all(&directory).map_err(|e|format!("failed to create app config directory: {e}"))?;
    Ok(directory)
}

pub fn config_path(app:&tauri::AppHandle)->Result<PathBuf,String>{
    Ok(config_dir(app)?.join("conversations-v1.json"))
}

fn validate_message(message:&ChatMessage)->Result<(),String>{
    if let Some(id)=&message.id{
        if id.trim().is_empty(){return Err("conversation message id must not be empty".to_string());}
        if id.len()>200{return Err("conversation message id must not exceed 200 characters".to_string());}
    }
    Ok(())
}

fn validate_conversation(conversation:&Conversation)->Result<(),String>{
    if conversation.api_version!=API_VERSION||conversation.schema_version!=SCHEMA_VERSION{
        return Err("unsupported conversation version".to_string());
    }
    if conversation.id.trim().is_empty(){return Err("conversation id must not be empty".to_string());}
    if conversation.id.len()>200{return Err("conversation id must not exceed 200 characters".to_string());}
    if conversation.character_id.trim().is_empty(){return Err("conversation character id must not be empty".to_string());}
    if conversation.created_at.trim().is_empty()||conversation.updated_at.trim().is_empty(){
        return Err("conversation timestamps must not be empty".to_string());
    }
    for message in &conversation.messages{validate_message(message)?;}
    Ok(())
}

fn validate_state(state:&ConversationStoreState)->Result<(),String>{
    if state.api_version!=API_VERSION||state.schema_version!=SCHEMA_VERSION{
        return Err("unsupported conversation storage version".to_string());
    }
    let mut ids=HashSet::new();
    let mut character_ids=HashSet::new();
    for conversation in &state.conversations{
        validate_conversation(conversation)?;
        if !ids.insert(conversation.id.clone()){return Err("conversation storage contains duplicate conversation ids".to_string());}
        if !character_ids.insert(conversation.character_id.clone()){
            return Err("conversation storage contains multiple conversations for one character".to_string());
        }
    }
    Ok(())
}

fn decode(bytes:&[u8])->Result<ConversationStoreState,String>{
    let state:ConversationStoreState=serde_json::from_slice(bytes).map_err(|e|format!("invalid conversation storage file: {e}"))?;
    validate_state(&state)?;
    Ok(state)
}

fn invalid_backup_path(path:&Path)->PathBuf{
    path.with_file_name("conversations-v1.invalid.json")
}

fn quarantine_invalid_storage(path:&Path)->Result<(),String>{
    let backup=invalid_backup_path(path);
    if backup.exists(){
        return Err("invalid conversation storage was detected, but the existing recovery backup prevents another automatic quarantine.".to_string());
    }
    fs::rename(path,&backup).map_err(|e|format!("failed to quarantine invalid conversation storage: {e}"))?;
    Ok(())
}

fn load_from_path(path:&Path)->Result<Option<ConversationStoreState>,String>{
    if !path.exists(){return Ok(None);}
    let bytes=fs::read(path).map_err(|e|format!("failed to read conversation storage: {e}"))?;
    match decode(&bytes){
        Ok(state)=>Ok(Some(state)),
        Err(reason)=>{
            quarantine_invalid_storage(path)?;
            Err(format!("conversation storage was quarantined after validation failed: {reason}"))
        }
    }
}

fn save_to_path(path:&Path,state:&ConversationStoreState)->Result<(),String>{
    validate_state(state)?;
    let tmp=path.with_extension("json.tmp");
    let encoded=serde_json::to_vec_pretty(state).map_err(|e|format!("failed to serialize conversation storage: {e}"))?;
    let mut file=fs::File::create(&tmp).map_err(|e|format!("failed to create conversation storage temp file: {e}"))?;
    file.write_all(&encoded).map_err(|e|format!("failed to write conversation storage: {e}"))?;
    file.sync_all().map_err(|e|format!("failed to flush conversation storage: {e}"))?;
    drop(file);
    if path.exists(){fs::remove_file(path).map_err(|e|format!("failed to replace conversation storage: {e}"))?;}
    fs::rename(&tmp,path).map_err(|e|format!("failed to commit conversation storage: {e}"))?;
    Ok(())
}

pub fn load(app:&tauri::AppHandle,character_id:&str)->Result<Option<Conversation>,String>{
    if character_id.trim().is_empty(){return Err("character id must not be empty".to_string());}
    let path=config_path(app)?;
    let Some(state)=load_from_path(&path)? else{return Ok(None);};
    Ok(state.conversations.into_iter().find(|conversation|conversation.character_id==character_id))
}

pub fn save(app:&tauri::AppHandle,conversation:&Conversation)->Result<(),String>{
    validate_conversation(conversation)?;
    let path=config_path(app)?;
    let mut state=match load_from_path(&path)?{
        Some(state)=>state,
        None=>ConversationStoreState{api_version:API_VERSION.to_string(),schema_version:SCHEMA_VERSION.to_string(),conversations:Vec::new()}
    };
    state.conversations.retain(|item|item.character_id!=conversation.character_id && item.id!=conversation.id);
    state.conversations.push(conversation.clone());
    save_to_path(&path,&state)
}

pub fn clear(app:&tauri::AppHandle,character_id:&str)->Result<(),String>{
    if character_id.trim().is_empty(){return Err("character id must not be empty".to_string());}
    let path=config_path(app)?;
    let Some(mut state)=load_from_path(&path)? else{return Ok(());};
    state.conversations.retain(|conversation|conversation.character_id!=character_id);
    if state.conversations.is_empty(){
        if path.exists(){fs::remove_file(&path).map_err(|e|format!("failed to remove empty conversation storage: {e}"))?;}
        Ok(())
    }else{
        save_to_path(&path,&state)
    }
}

#[cfg(test)]
mod tests{
    use super::*;
    use std::{fs,time::{SystemTime,UNIX_EPOCH}};

    fn valid_conversation(id:&str,character_id:&str,content:&str)->Conversation{
        Conversation{
            api_version:API_VERSION.to_string(),
            schema_version:SCHEMA_VERSION.to_string(),
            id:id.to_string(),
            character_id:character_id.to_string(),
            messages:vec![
                ChatMessage{id:Some("u1".to_string()),role:ChatMessageRole::User,content:content.to_string(),tool_call_id:None,metadata:None},
                ChatMessage{id:Some("a1".to_string()),role:ChatMessageRole::Assistant,content:"response".to_string(),tool_call_id:None,metadata:None}
            ],
            created_at:"2026-09-28T00:00:00.000Z".to_string(),
            updated_at:"2026-09-28T00:00:01.000Z".to_string()
        }
    }

    fn valid_state()->ConversationStoreState{
        ConversationStoreState{api_version:API_VERSION.to_string(),schema_version:SCHEMA_VERSION.to_string(),conversations:vec![
            valid_conversation("conversation:nova:default.v1","character.nova.default.v1","hello")
        ]}
    }

    fn temp_path(test_name:&str)->PathBuf{
        let stamp=SystemTime::now().duration_since(UNIX_EPOCH).expect("clock").as_nanos();
        let directory=std::env::temp_dir().join(format!("ai-companion-nova-conversations-{test_name}-{}-{stamp}",std::process::id()));
        fs::create_dir_all(&directory).expect("create temp directory");
        directory.join("conversations-v1.json")
    }

    #[test]
    fn accepts_valid_state(){
        let encoded=serde_json::to_vec(&valid_state()).expect("encode");
        assert!(decode(&encoded).is_ok());
    }

    #[test]
    fn rejects_malformed_state(){
        assert!(decode(br#"{"conversations":["#).is_err());
    }

    #[test]
    fn rejects_incompatible_state(){
        let mut state=valid_state();
        state.schema_version="0".to_string();
        let encoded=serde_json::to_vec(&state).expect("encode");
        assert!(decode(&encoded).is_err());
    }

    #[test]
    fn rejects_duplicate_conversation_ids(){
        let mut state=valid_state();
        state.conversations.push(valid_conversation("conversation:nova:default.v1","character.gm.v1","gm"));
        assert!(decode(&serde_json::to_vec(&state).expect("encode")).is_err());
    }

    #[test]
    fn rejects_multiple_conversations_for_character(){
        let mut state=valid_state();
        state.conversations.push(valid_conversation("conversation:nova:second.v1","character.nova.default.v1","second"));
        assert!(decode(&serde_json::to_vec(&state).expect("encode")).is_err());
    }

    #[test]
    fn quarantines_invalid_storage_without_data_loss(){
        let path=temp_path("quarantine");
        let original=br#"{"legacy":true}"#;
        fs::write(&path,original).expect("write");
        let error=load_from_path(&path).expect_err("invalid state should report recoverable failure");
        assert!(error.contains("quarantined"));
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
        state.conversations.push(valid_conversation("conversation:gm:default.v1","character.gm.v1","gm"));
        let path=temp_path("isolation");
        save_to_path(&path,&state).expect("save");
        let loaded=load_from_path(&path).expect("load").expect("state");
        let nova=loaded.conversations.iter().find(|item|item.character_id=="character.nova.default.v1").expect("nova");
        let gm=loaded.conversations.iter().find(|item|item.character_id=="character.gm.v1").expect("gm");
        assert_eq!(nova.messages[0].content,"hello");
        assert_eq!(gm.messages[0].content,"gm");
        fs::remove_dir_all(path.parent().expect("directory")).expect("cleanup");
    }

    #[test]
    fn clear_from_file_removes_only_selected_character(){
        let mut state=valid_state();
        state.conversations.push(valid_conversation("conversation:gm:default.v1","character.gm.v1","gm"));
        let path=temp_path("clear");
        save_to_path(&path,&state).expect("save");
        let mut loaded=load_from_path(&path).expect("load").expect("state");
        loaded.conversations.retain(|item|item.character_id!="character.gm.v1");
        save_to_path(&path,&loaded).expect("save after clear");
        let result=load_from_path(&path).expect("reload").expect("state");
        assert_eq!(result.conversations.len(),1);
        assert_eq!(result.conversations[0].character_id,"character.nova.default.v1");
        fs::remove_dir_all(path.parent().expect("directory")).expect("cleanup");
    }
}
