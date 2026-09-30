use serde::{Deserialize,Serialize};
use serde_json::{Map,Value};
use std::{collections::HashSet,fs,io::Write,path::PathBuf,sync::Mutex};
use tauri::Manager;

const API_VERSION:&str="1";
const SCHEMA_VERSION:&str="2";
const LEGACY_SCHEMA_VERSION:&str="1";
const MAX_CONTENT:usize=32768;
const MAX_TAGS:usize=32;
const MAX_TAG:usize=64;
const MAX_SOURCE_REFERENCE:usize=500;
const MAX_METADATA_KEYS:usize=64;
const MAX_METADATA_SIZE:usize=16384;

#[derive(Debug,Deserialize,Serialize,Clone)]
#[serde(rename_all="lowercase",deny_unknown_fields)]
pub enum MemoryType{Fact,Preference,Relationship,Event,Experience,Goal,Instruction,Observation}
#[derive(Debug,Deserialize,Serialize,Clone)]
#[serde(rename_all="lowercase",deny_unknown_fields)]
pub enum MemoryStatus{Active,Superseded,Archived}
#[derive(Debug,Deserialize,Serialize,Clone)]
#[serde(rename_all="lowercase",deny_unknown_fields)]
pub enum MemorySource{User,Conversation,File,Tool,Model,System}
#[derive(Debug,Deserialize,Serialize,Clone)]
#[serde(rename_all="lowercase",deny_unknown_fields)]
pub enum MutationPolicy{Locked,Suggest,Auto}

#[derive(Debug,Deserialize,Serialize,Clone)]
#[serde(deny_unknown_fields)]
pub struct MemoryItem{
    pub id:String,
    #[serde(rename="characterId")]
    pub character_id:String,
    #[serde(rename="conversationId")]
    pub conversation_id:String,
    #[serde(rename="type")]
    pub memory_type:MemoryType,
    pub content:String,
    pub tags:Vec<String>,
    pub importance:i64,
    pub confidence:i64,
    #[serde(rename="createdAt")]
    pub created_at:String,
    #[serde(rename="updatedAt")]
    pub updated_at:String,
    #[serde(rename="validFrom")]
    pub valid_from:Option<String>,
    #[serde(rename="validUntil")]
    pub valid_until:Option<String>,
    pub source:MemorySource,
    #[serde(rename="sourceReference")]
    pub source_reference:Option<String>,
    #[serde(rename="mutationPolicy")]
    pub mutation_policy:MutationPolicy,
    pub status:MemoryStatus,
    pub metadata:Map<String,Value>,
}

#[derive(Debug,Deserialize,Serialize,Clone)]
#[serde(deny_unknown_fields)]
pub struct MemoryStoreState{
    #[serde(rename="apiVersion")]
    pub api_version:String,
    #[serde(rename="schemaVersion")]
    pub schema_version:String,
    #[serde(rename="characterId")]
    pub character_id:String,
    pub items:Vec<MemoryItem>,
}

#[derive(Debug,Deserialize,Clone)]
#[serde(deny_unknown_fields)]
struct LegacyMemoryItemV1{
    id:String,
    #[serde(rename="characterId")]
    character_id:String,
    #[serde(rename="type")]
    memory_type:MemoryType,
    content:String,
    tags:Vec<String>,
    importance:i64,
    confidence:i64,
    #[serde(rename="createdAt")]
    created_at:String,
    #[serde(rename="updatedAt")]
    updated_at:String,
    #[serde(rename="validFrom")]
    valid_from:Option<String>,
    #[serde(rename="validUntil")]
    valid_until:Option<String>,
    source:MemorySource,
    #[serde(rename="sourceReference")]
    source_reference:Option<String>,
    #[serde(rename="mutationPolicy")]
    mutation_policy:MutationPolicy,
    status:MemoryStatus,
    metadata:Map<String,Value>,
}
#[derive(Debug,Deserialize,Clone)]
#[serde(deny_unknown_fields)]
struct LegacyMemoryStoreStateV1{
    #[serde(rename="apiVersion")]
    api_version:String,
    #[serde(rename="schemaVersion")]
    schema_version:String,
    #[serde(rename="characterId")]
    character_id:String,
    items:Vec<LegacyMemoryItemV1>,
}

#[derive(Default)]
pub struct MemoryWriteLock(pub Mutex<()>);

fn config_dir(app:&tauri::AppHandle)->Result<PathBuf,String>{
    let directory=app.path().app_config_dir().map_err(|e|format!("failed to resolve app config directory: {e}"))?;
    fs::create_dir_all(&directory).map_err(|e|format!("failed to create app config directory: {e}"))?;
    Ok(directory)
}
fn memory_file_name(character_id:&str)->String{
    let mut encoded=String::with_capacity(character_id.len()*2);
    for byte in character_id.as_bytes(){encoded.push_str(&format!("{byte:02x}"));}
    format!("dynamic-memory-v1-{encoded}.json")
}
pub fn config_path(app:&tauri::AppHandle,character_id:&str)->Result<PathBuf,String>{
    let scope=character_id.trim();
    if scope.is_empty(){return Err("character id must not be empty".to_string());}
    Ok(config_dir(app)?.join(memory_file_name(scope)))
}
fn default_conversation_id(character_id:&str)->String{format!("conversation:{character_id}:default.v2")}

fn validate_item(item:&MemoryItem,character_id:&str)->Result<(),String>{
    if item.character_id!=character_id{return Err("memory item character scope mismatch".to_string());}
    if item.conversation_id.trim().is_empty()||item.conversation_id.len()>200{return Err("memory conversationId is invalid".to_string());}
    if item.id.trim().is_empty()||item.id.len()>200{return Err("memory id must be non-empty and at most 200 characters".to_string());}
    if item.content.trim().is_empty()||item.content.len()>MAX_CONTENT{return Err("memory content exceeds the v2 input limits".to_string());}
    if item.tags.len()>MAX_TAGS{return Err("memory tags exceed the v2 input limit".to_string());}
    if item.tags.iter().any(|tag|tag.trim().is_empty()||tag.len()>MAX_TAG){return Err("memory tag exceeds the v2 input limits".to_string());}
    if !(0..=100).contains(&item.importance){return Err("importance must be between 0 and 100".to_string());}
    if !(0..=100).contains(&item.confidence){return Err("confidence must be between 0 and 100".to_string());}
    if item.created_at.trim().is_empty()||item.updated_at.trim().is_empty(){return Err("memory timestamps must not be empty".to_string());}
    if let Some(value)=&item.valid_from{if value.trim().is_empty(){return Err("validFrom must not be empty when present".to_string());}}
    if let Some(value)=&item.valid_until{if value.trim().is_empty(){return Err("validUntil must not be empty when present".to_string());}}
    if let Some(reference)=&item.source_reference{if reference.len()>MAX_SOURCE_REFERENCE{return Err("memory sourceReference exceeds the v2 input limit".to_string());}}
    match item.source{
        MemorySource::Conversation|MemorySource::File|MemorySource::Tool|MemorySource::Model=>{
            if item.source_reference.as_ref().map(|value|value.trim().is_empty()).unwrap_or(true){return Err("memory sourceReference is required for this provenance".to_string());}
        }
        MemorySource::User|MemorySource::System=>{}
    }
    if item.metadata.len()>MAX_METADATA_KEYS{return Err("memory metadata exceeds the v2 key limit".to_string());}
    let encoded=serde_json::to_vec(&item.metadata).map_err(|e|format!("failed to encode memory metadata: {e}"))?;
    if encoded.len()>MAX_METADATA_SIZE{return Err("memory metadata exceeds the v2 size limit".to_string());}
    Ok(())
}
fn validate(state:&MemoryStoreState,character_id:&str)->Result<(),String>{
    if state.api_version!=API_VERSION||state.schema_version!=SCHEMA_VERSION{return Err("unsupported dynamic memory storage version".to_string());}
    if state.character_id!=character_id{return Err("dynamic memory storage character scope mismatch".to_string());}
    let mut ids=HashSet::new();
    for item in &state.items{
        validate_item(item,character_id)?;
        if !ids.insert(item.id.clone()){return Err("dynamic memory storage contains duplicate ids".to_string());}
    }
    Ok(())
}
fn migrate_legacy(legacy:LegacyMemoryStoreStateV1,character_id:&str,conversation_id:&str)->Result<MemoryStoreState,String>{
    if legacy.api_version!=API_VERSION||legacy.schema_version!=LEGACY_SCHEMA_VERSION{return Err("unsupported legacy dynamic memory storage version".to_string());}
    if legacy.character_id!=character_id{return Err("legacy dynamic memory storage character scope mismatch".to_string());}
    let target=conversation_id.trim();
    if target.is_empty(){return Err("migration conversationId must not be empty".to_string());}
    let items=legacy.items.into_iter().map(|item|MemoryItem{
        id:item.id,character_id:item.character_id,conversation_id:target.to_string(),memory_type:item.memory_type,content:item.content,tags:item.tags,
        importance:item.importance,confidence:item.confidence,created_at:item.created_at,updated_at:item.updated_at,valid_from:item.valid_from,
        valid_until:item.valid_until,source:item.source,source_reference:item.source_reference,mutation_policy:item.mutation_policy,status:item.status,metadata:item.metadata
    }).collect();
    let state=MemoryStoreState{api_version:API_VERSION.to_string(),schema_version:SCHEMA_VERSION.to_string(),character_id:character_id.to_string(),items};
    validate(&state,character_id)?;
    Ok(state)
}

fn load_unlocked(app:&tauri::AppHandle,character_id:&str,migration_conversation_id:Option<&str>)->Result<Option<MemoryStoreState>,String>{
    let path=config_path(app,character_id)?;
    if !path.exists(){return Ok(None);}
    let bytes=fs::read(&path).map_err(|e|format!("failed to read dynamic memory storage: {e}"))?;
    let probe:Value=serde_json::from_slice(&bytes).map_err(|e|format!("invalid dynamic memory storage file: {e}"))?;
    let version=probe.get("schemaVersion").and_then(Value::as_str).unwrap_or_default();
    if version==SCHEMA_VERSION{
        let state:MemoryStoreState=serde_json::from_value(probe).map_err(|e|format!("invalid dynamic memory storage state: {e}"))?;
        validate(&state,character_id)?;
        return Ok(Some(state));
    }
    if version!=LEGACY_SCHEMA_VERSION{return Err("unsupported dynamic memory storage version".to_string());}
    let legacy:LegacyMemoryStoreStateV1=serde_json::from_value(probe).map_err(|e|format!("invalid legacy dynamic memory storage: {e}"))?;
    let target=migration_conversation_id.filter(|value|!value.trim().is_empty()).map(str::to_string).unwrap_or_else(||default_conversation_id(character_id));
    let migrated=migrate_legacy(legacy,character_id,&target)?;
    save_unlocked(app,&migrated)?;
    Ok(Some(migrated))
}
fn save_unlocked(app:&tauri::AppHandle,state:&MemoryStoreState)->Result<(),String>{
    validate(state,&state.character_id)?;
    let path=config_path(app,&state.character_id)?;
    let tmp=path.with_extension("json.tmp");
    let encoded=serde_json::to_vec_pretty(state).map_err(|e|format!("failed to serialize dynamic memory storage: {e}"))?;
    let mut file=fs::File::create(&tmp).map_err(|e|format!("failed to create dynamic memory temp file: {e}"))?;
    file.write_all(&encoded).map_err(|e|format!("failed to write dynamic memory storage: {e}"))?;
    file.sync_all().map_err(|e|format!("failed to flush dynamic memory storage: {e}"))?;
    drop(file);
    if path.exists(){fs::remove_file(&path).map_err(|e|format!("failed to replace dynamic memory storage: {e}"))?;}
    fs::rename(&tmp,&path).map_err(|e|format!("failed to commit dynamic memory storage: {e}"))?;
    Ok(())
}
pub fn load(app:&tauri::AppHandle,character_id:&str,migration_conversation_id:Option<&str>,lock:&MemoryWriteLock)->Result<Option<MemoryStoreState>,String>{
    let _guard=lock.0.lock().map_err(|_|"dynamic memory storage lock poisoned".to_string())?;
    load_unlocked(app,character_id,migration_conversation_id)
}
pub fn save(app:&tauri::AppHandle,state:&MemoryStoreState,lock:&MemoryWriteLock)->Result<(),String>{
    let _guard=lock.0.lock().map_err(|_|"dynamic memory storage lock poisoned".to_string())?;
    save_unlocked(app,state)
}
pub fn supersede(app:&tauri::AppHandle,character_id:&str,conversation_id:&str,previous_memory_id:&str,replacement:MemoryItem,lock:&MemoryWriteLock)->Result<MemoryItem,String>{
    let _guard=lock.0.lock().map_err(|_|"dynamic memory storage lock poisoned".to_string())?;
    let mut state=load_unlocked(app,character_id,Some(conversation_id))?.unwrap_or_else(||MemoryStoreState{
        api_version:API_VERSION.to_string(),schema_version:SCHEMA_VERSION.to_string(),character_id:character_id.to_string(),items:Vec::new()
    });
    let index=state.items.iter().position(|item|item.id==previous_memory_id&&item.conversation_id==conversation_id).ok_or_else(||"memory item was not found in requested conversation".to_string())?;
    if !matches!(state.items[index].status,MemoryStatus::Active){return Err("only active memory items can be superseded".to_string());}
    if replacement.character_id!=character_id||replacement.conversation_id!=conversation_id{return Err("replacement memory scope mismatch".to_string());}
    if state.items.iter().any(|item|item.id==replacement.id){return Err("memory id already exists".to_string());}
    validate_item(&replacement,character_id)?;
    let updated_at=replacement.updated_at.clone();
    state.items[index].status=MemoryStatus::Superseded;
    state.items[index].updated_at=updated_at;
    state.items.push(replacement.clone());
    save_unlocked(app,&state)?;
    Ok(replacement)
}

#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn legacy_migration_assigns_requested_conversation(){
        let legacy=LegacyMemoryStoreStateV1{api_version:"1".into(),schema_version:"1".into(),character_id:"nova".into(),items:vec![
            LegacyMemoryItemV1{id:"m1".into(),character_id:"nova".into(),memory_type:MemoryType::Fact,content:"A fact".into(),tags:vec![],importance:50,confidence:80,
                created_at:"2026-09-01T00:00:00.000Z".into(),updated_at:"2026-09-01T00:00:00.000Z".into(),valid_from:None,valid_until:None,
                source:MemorySource::User,source_reference:None,mutation_policy:MutationPolicy::Locked,status:MemoryStatus::Active,metadata:Map::new()}
        ]};
        let migrated=migrate_legacy(legacy,"nova","conversation:nova:custom").unwrap();
        assert_eq!(migrated.schema_version,"2");
        assert_eq!(migrated.items[0].conversation_id,"conversation:nova:custom");
        assert_eq!(migrated.items.len(),1);
    }
    #[test]
    fn legacy_migration_rejects_character_mismatch(){
        let legacy=LegacyMemoryStoreStateV1{api_version:"1".into(),schema_version:"1".into(),character_id:"gm".into(),items:vec![]};
        assert!(migrate_legacy(legacy,"nova","conversation:nova:default.v2").is_err());
    }
}
