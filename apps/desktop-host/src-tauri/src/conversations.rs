use serde::{Deserialize,Serialize};
use serde_json::{Map,Value};
use std::{collections::{HashMap,HashSet},fs,io::Write,path::{Path,PathBuf}};
use tauri::Manager;

const API_VERSION:&str="1";
const SCHEMA_VERSION:&str="2";
const LEGACY_SCHEMA_VERSION:&str="1";

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
    pub title:String,
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
    #[serde(rename="activeConversationIds")]
    pub active_conversation_ids:HashMap<String,String>,
}

#[derive(Debug,Deserialize,Clone)]
#[serde(deny_unknown_fields)]
struct LegacyConversation{
    #[serde(rename="apiVersion")]
    api_version:String,
    #[serde(rename="schemaVersion")]
    schema_version:String,
    id:String,
    #[serde(rename="characterId")]
    character_id:String,
    messages:Vec<ChatMessage>,
    #[serde(rename="createdAt")]
    created_at:String,
    #[serde(rename="updatedAt")]
    updated_at:String,
}

#[derive(Debug,Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyConversationStoreState{
    #[serde(rename="apiVersion")]
    api_version:String,
    #[serde(rename="schemaVersion")]
    schema_version:String,
    conversations:Vec<LegacyConversation>,
}

fn config_dir(app:&tauri::AppHandle)->Result<PathBuf,String>{
    let directory=app.path().app_config_dir().map_err(|e|format!("failed to resolve app config directory: {e}"))?;
    fs::create_dir_all(&directory).map_err(|e|format!("failed to create app config directory: {e}"))?;
    Ok(directory)
}

pub fn config_path(app:&tauri::AppHandle)->Result<PathBuf,String>{
    Ok(config_dir(app)?.join("conversations-v2.json"))
}

fn legacy_config_path(app:&tauri::AppHandle)->Result<PathBuf,String>{
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
    if conversation.title.trim().is_empty(){return Err("conversation title must not be empty".to_string());}
    if conversation.title.len()>200{return Err("conversation title must not exceed 200 characters".to_string());}
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
    for conversation in &state.conversations{
        validate_conversation(conversation)?;
        if !ids.insert(conversation.id.clone()){return Err("conversation storage contains duplicate conversation ids".to_string());}
    }
    for (character_id,conversation_id) in &state.active_conversation_ids{
        if character_id.trim().is_empty()||conversation_id.trim().is_empty(){
            return Err("conversation active mapping must not contain empty ids".to_string());
        }
        let Some(conversation)=state.conversations.iter().find(|item|item.id==*conversation_id) else{
            return Err("conversation active mapping references a missing conversation".to_string());
        };
        if conversation.character_id!=*character_id{return Err("conversation active mapping character scope mismatch".to_string());}
    }
    Ok(())
}

fn decode_v2(bytes:&[u8])->Result<ConversationStoreState,String>{
    let state:ConversationStoreState=serde_json::from_slice(bytes).map_err(|e|format!("invalid conversation v2 storage file: {e}"))?;
    validate_state(&state)?;
    Ok(state)
}

fn migrate_legacy(bytes:&[u8])->Result<ConversationStoreState,String>{
    let state:LegacyConversationStoreState=serde_json::from_slice(bytes).map_err(|e|format!("invalid conversation v1 storage file: {e}"))?;
    if state.api_version!=API_VERSION||state.schema_version!=LEGACY_SCHEMA_VERSION{
        return Err("unsupported legacy conversation storage version".to_string());
    }
    let mut ids=HashSet::new();
    let mut conversations=Vec::new();
    let mut active=HashMap::new();
    for legacy in state.conversations{
        if legacy.id.trim().is_empty()||legacy.character_id.trim().is_empty(){
            return Err("legacy conversation id and character scope are required".to_string());
        }
        if !ids.insert(legacy.id.clone()){return Err("legacy conversation storage contains duplicate conversation ids".to_string());}
        let conversation=Conversation{
            api_version:API_VERSION.to_string(),
            schema_version:SCHEMA_VERSION.to_string(),
            id:legacy.id.clone(),
            character_id:legacy.character_id.clone(),
            title:"Main".to_string(),
            messages:legacy.messages,
            created_at:legacy.created_at,
            updated_at:legacy.updated_at,
        };
        validate_conversation(&conversation)?;
        active.insert(conversation.character_id.clone(),conversation.id.clone());
        conversations.push(conversation);
    }
    let state=ConversationStoreState{
        api_version:API_VERSION.to_string(),
        schema_version:SCHEMA_VERSION.to_string(),
        conversations,
        active_conversation_ids:active,
    };
    validate_state(&state)?;
    Ok(state)
}

fn invalid_backup_path(path:&Path)->PathBuf{
    let name=path.file_name().and_then(|value|value.to_str()).unwrap_or("conversations.json");
    let invalid_name=name.replace(".json",".invalid.json");
    path.with_file_name(invalid_name)
}

fn quarantine_invalid_storage(path:&Path)->Result<(),String>{
    let backup=invalid_backup_path(path);
    if backup.exists(){
        return Err("invalid conversation storage was detected, but the existing recovery backup prevents another automatic quarantine.".to_string());
    }
    fs::rename(path,&backup).map_err(|e|format!("failed to quarantine invalid conversation storage: {e}"))?;
    Ok(())
}

fn load_state_from_path(path:&Path)->Result<Option<ConversationStoreState>,String>{
    if !path.exists(){return Ok(None);}
    let bytes=fs::read(path).map_err(|e|format!("failed to read conversation storage: {e}"))?;
    match decode_v2(&bytes){
        Ok(state)=>Ok(Some(state)),
        Err(reason)=>{
            let backup=invalid_backup_path(path);
            if backup.exists(){
                return Ok(None);
            }
            quarantine_invalid_storage(path)?;
            let _=reason;
            Ok(None)
        }
    }
}

fn load_state(app:&tauri::AppHandle)->Result<Option<ConversationStoreState>,String>{
    let path=config_path(app)?;
    if path.exists(){return load_state_from_path(&path);}

    let legacy_path=legacy_config_path(app)?;
    if !legacy_path.exists(){return Ok(None);}
    let bytes=fs::read(&legacy_path).map_err(|e|format!("failed to read legacy conversation storage: {e}"))?;
    match migrate_legacy(&bytes){
        Ok(state)=>{
            save_to_path(&path,&state)?;
            Ok(Some(state))
        },
        Err(_reason)=>{
            let backup=invalid_backup_path(&legacy_path);
            if !backup.exists(){quarantine_invalid_storage(&legacy_path)?;}
            Ok(None)
        }
    }
}

fn save_to_path(path:&Path,state:&ConversationStoreState)->Result<(),String>{
    validate_state(state)?;
    if let Some(parent)=path.parent(){fs::create_dir_all(parent).map_err(|e|format!("failed to create conversation storage directory: {e}"))?;}
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

fn ensure_state(app:&tauri::AppHandle)->Result<(PathBuf,ConversationStoreState),String>{
    let path=config_path(app)?;
    let state=load_state(app)?.unwrap_or(ConversationStoreState{
        api_version:API_VERSION.to_string(),
        schema_version:SCHEMA_VERSION.to_string(),
        conversations:Vec::new(),
        active_conversation_ids:HashMap::new()
    });
    Ok((path,state))
}

fn compare_conversations(a:&Conversation,b:&Conversation)->std::cmp::Ordering{
    b.updated_at.cmp(&a.updated_at).then_with(||b.created_at.cmp(&a.created_at)).then_with(||a.id.cmp(&b.id))
}

fn default_conversation(character_id:&str)->Conversation{
    let now=chrono_free_now();
    Conversation{
        api_version:API_VERSION.to_string(),
        schema_version:SCHEMA_VERSION.to_string(),
        id:format!("conversation:{character_id}:default.v2"),
        character_id:character_id.to_string(),
        title:"Main".to_string(),
        messages:Vec::new(),
        created_at:now.clone(),
        updated_at:now,
    }
}

fn chrono_free_now()->String{
    use std::time::{SystemTime,UNIX_EPOCH};
    let millis=SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis();
    format!("runtime-{millis}")
}

pub fn list(app:&tauri::AppHandle,character_id:&str)->Result<Vec<Conversation>,String>{
    if character_id.trim().is_empty(){return Err("character id must not be empty".to_string());}
    let Some(state)=load_state(app)? else{return Ok(Vec::new());};
    let mut result=state.conversations.into_iter().filter(|conversation|conversation.character_id==character_id).collect::<Vec<_>>();
    result.sort_by(compare_conversations);
    Ok(result)
}

pub fn get(app:&tauri::AppHandle,character_id:&str,conversation_id:&str)->Result<Option<Conversation>,String>{
    if character_id.trim().is_empty()||conversation_id.trim().is_empty(){return Err("conversation lookup requires character and conversation ids".to_string());}
    let Some(state)=load_state(app)? else{return Ok(None);};
    let Some(conversation)=state.conversations.into_iter().find(|item|item.id==conversation_id) else{return Ok(None);};
    if conversation.character_id!=character_id{return Err("conversation character scope mismatch".to_string());}
    Ok(Some(conversation))
}

pub fn save(app:&tauri::AppHandle,conversation:&Conversation)->Result<(),String>{
    validate_conversation(conversation)?;
    let (path,mut state)=ensure_state(app)?;
    if let Some(existing)=state.conversations.iter().find(|item|item.id==conversation.id){
        if existing.character_id!=conversation.character_id{return Err("conversation id is owned by another Character".to_string());}
    }
    state.conversations.retain(|item|item.id!=conversation.id);
    state.conversations.push(conversation.clone());
    state.active_conversation_ids.entry(conversation.character_id.clone()).or_insert_with(||conversation.id.clone());
    save_to_path(&path,&state)
}

pub fn delete(app:&tauri::AppHandle,character_id:&str,conversation_id:&str)->Result<(),String>{
    if character_id.trim().is_empty()||conversation_id.trim().is_empty(){return Err("conversation deletion requires character and conversation ids".to_string());}
    let (path,mut state)=ensure_state(app)?;
    let Some(existing)=state.conversations.iter().find(|item|item.id==conversation_id).cloned() else{return Ok(());};
    if existing.character_id!=character_id{return Err("conversation character scope mismatch".to_string());}
    state.conversations.retain(|item|item.id!=conversation_id);

    if state.active_conversation_ids.get(character_id).map(String::as_str)==Some(conversation_id){
        let mut remaining=state.conversations.iter().filter(|item|item.character_id==character_id).cloned().collect::<Vec<_>>();
        remaining.sort_by(compare_conversations);
        if let Some(next)=remaining.first(){
            state.active_conversation_ids.insert(character_id.to_string(),next.id.clone());
        }else{
            let replacement=default_conversation(character_id);
            state.conversations.push(replacement.clone());
            state.active_conversation_ids.insert(character_id.to_string(),replacement.id);
        }
    }
    save_to_path(&path,&state)
}

pub fn set_active(app:&tauri::AppHandle,character_id:&str,conversation_id:&str)->Result<(),String>{
    if character_id.trim().is_empty()||conversation_id.trim().is_empty(){return Err("active conversation requires character and conversation ids".to_string());}
    let (path,mut state)=ensure_state(app)?;
    let Some(conversation)=state.conversations.iter().find(|item|item.id==conversation_id) else{return Err("conversation was not found".to_string());};
    if conversation.character_id!=character_id{return Err("conversation character scope mismatch".to_string());}
    state.active_conversation_ids.insert(character_id.to_string(),conversation_id.to_string());
    save_to_path(&path,&state)
}

pub fn get_active(app:&tauri::AppHandle,character_id:&str)->Result<Option<Conversation>,String>{
    if character_id.trim().is_empty(){return Err("character id must not be empty".to_string());}
    let Some(state)=load_state(app)? else{return Ok(None);};
    let Some(conversation_id)=state.active_conversation_ids.get(character_id) else{return Ok(None);};
    let Some(conversation)=state.conversations.iter().find(|item|item.id==*conversation_id) else{return Ok(None);};
    if conversation.character_id!=character_id{return Err("conversation active scope mismatch".to_string());}
    Ok(Some(conversation.clone()))
}

pub fn clear(app:&tauri::AppHandle,character_id:&str,conversation_id:&str)->Result<(),String>{
    let Some(mut conversation)=get(app,character_id,conversation_id)? else{return Ok(());};
    conversation.messages.clear();
    let mut state=load_state(app)?.ok_or_else(||"conversation storage is unavailable".to_string())?;
    if let Some(existing)=state.conversations.iter_mut().find(|item|item.id==conversation.id){
        existing.messages.clear();
        existing.updated_at=chrono_free_now();
    }
    save_to_path(&config_path(app)?,&state)
}

#[cfg(test)]
mod tests{
    use super::*;

    fn valid_conversation(id:&str,character_id:&str,content:&str)->Conversation{
        Conversation{
            api_version:API_VERSION.to_string(),schema_version:SCHEMA_VERSION.to_string(),
            id:id.to_string(),character_id:character_id.to_string(),title:"Main".to_string(),
            messages:vec![
                ChatMessage{id:Some("u1".to_string()),role:ChatMessageRole::User,content:content.to_string(),tool_call_id:None,metadata:None},
                ChatMessage{id:Some("a1".to_string()),role:ChatMessageRole::Assistant,content:"response".to_string(),tool_call_id:None,metadata:None}
            ],
            created_at:"2026-09-28T00:00:00.000Z".to_string(),updated_at:"2026-09-28T00:00:01.000Z".to_string()
        }
    }

    fn valid_state()->ConversationStoreState{
        let nova=valid_conversation("conversation:nova:default.v2","character.nova.default.v1","hello");
        let mut active=HashMap::new();
        active.insert(nova.character_id.clone(),nova.id.clone());
        ConversationStoreState{
            api_version:API_VERSION.to_string(),schema_version:SCHEMA_VERSION.to_string(),
            conversations:vec![nova],active_conversation_ids:active
        }
    }

    #[test]
    fn accepts_valid_state(){
        let encoded=serde_json::to_vec(&valid_state()).expect("encode");
        assert!(decode_v2(&encoded).is_ok());
    }

    #[test]
    fn rejects_malformed_state(){assert!(decode_v2(br#"{"conversations":["#).is_err());}

    #[test]
    fn rejects_incompatible_state(){
        let mut state=valid_state();state.schema_version="0".to_string();
        assert!(decode_v2(&serde_json::to_vec(&state).expect("encode")).is_err());
    }

    #[test]
    fn rejects_duplicate_conversation_ids(){
        let mut state=valid_state();
        state.conversations.push(valid_conversation("conversation:nova:default.v2","character.gm.v1","gm"));
        assert!(decode_v2(&serde_json::to_vec(&state).expect("encode")).is_err());
    }

    #[test]
    fn accepts_multiple_conversations_for_one_character(){
        let mut state=valid_state();
        let second=Conversation{
            id:"conversation:nova:second.v2".to_string(),
            title:"Second".to_string(),
            created_at:"2026-09-28T00:00:02.000Z".to_string(),
            updated_at:"2026-09-28T00:00:03.000Z".to_string(),
            messages:Vec::new(),
            ..state.conversations[0].clone()
        };
        state.conversations.push(second.clone());
        state.active_conversation_ids.insert("character.nova.default.v1".to_string(),second.id.clone());
        assert!(decode_v2(&serde_json::to_vec(&state).expect("encode")).is_ok());
    }

    #[test]
    fn quarantines_invalid_v2_and_returns_empty_state_for_recovery(){
        let path=temp_path("v2-quarantine");
        fs::write(&path,br#"{"bad":true}"#).expect("write");
        assert!(load_state_from_path(&path).expect("recovery read").is_none());
        assert!(!path.exists());
        assert_eq!(fs::read(invalid_backup_path(&path)).expect("backup"),br#"{"bad":true}"#);
        fs::remove_dir_all(path.parent().expect("directory")).expect("cleanup");
    }

    #[test]
    fn rejects_active_scope_mismatch(){
        let mut state=valid_state();
        state.active_conversation_ids.insert("character.gm.v1".to_string(),"conversation:nova:default.v2".to_string());
        assert!(decode_v2(&serde_json::to_vec(&state).expect("encode")).is_err());
    }

    #[test]
    fn migrates_legacy_one_per_character(){
        let legacy=LegacyConversationStoreState{
            api_version:API_VERSION.to_string(),schema_version:LEGACY_SCHEMA_VERSION.to_string(),
            conversations:vec![LegacyConversation{
                api_version:API_VERSION.to_string(),schema_version:LEGACY_SCHEMA_VERSION.to_string(),
                id:"conversation:character.nova.default.v1:default.v1".to_string(),
                character_id:"character.nova.default.v1".to_string(),
                messages:vec![ChatMessage{id:Some("u1".to_string()),role:ChatMessageRole::User,content:"legacy".to_string(),tool_call_id:None,metadata:None}],
                created_at:"2026-09-28T00:00:00.000Z".to_string(),updated_at:"2026-09-28T00:00:01.000Z".to_string()
            }]
        };
        let migrated=migrate_legacy(&serde_json::to_vec(&legacy).expect("encode")).expect("migration");
        assert_eq!(migrated.conversations.len(),1);
        assert_eq!(migrated.conversations[0].id,legacy.conversations[0].id);
        assert_eq!(migrated.conversations[0].title,"Main");
        assert_eq!(migrated.active_conversation_ids["character.nova.default.v1"],legacy.conversations[0].id);
        assert_eq!(migrated.conversations[0].messages[0].content,"legacy");
    }

    #[test]
    fn rejects_legacy_duplicate_ids(){
        let first=LegacyConversation{
            api_version:API_VERSION.to_string(),schema_version:LEGACY_SCHEMA_VERSION.to_string(),
            id:"same".to_string(),character_id:"character.a".to_string(),messages:Vec::new(),
            created_at:"x".to_string(),updated_at:"y".to_string()
        };
        let second=LegacyConversation{character_id:"character.b".to_string(),..first.clone()};
        let legacy=LegacyConversationStoreState{api_version:API_VERSION.to_string(),schema_version:LEGACY_SCHEMA_VERSION.to_string(),conversations:vec![first,second]};
        assert!(migrate_legacy(&serde_json::to_vec(&legacy).expect("encode")).is_err());
    }
}
