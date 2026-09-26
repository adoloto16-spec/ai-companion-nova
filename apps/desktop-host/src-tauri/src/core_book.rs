use serde::{Deserialize,Serialize};
use serde_json::{Map,Value};
use std::{collections::HashSet,fs,io::Write,path::PathBuf};
use tauri::Manager;

const API_VERSION:&str="1";
const SCHEMA_VERSION:&str="1";

#[derive(Debug,Deserialize,Serialize,Clone)]
#[serde(tag="kind",deny_unknown_fields)]
pub enum CoreBookActivation{
    #[serde(rename="always")]
    Always,
    #[serde(rename="keyword")]
    Keyword{
        keywords:Vec<String>,
        #[serde(rename="matchMode")]
        match_mode:String,
        #[serde(rename="caseSensitive")]
        case_sensitive:bool
    },
    #[serde(rename="regex")]
    Regex{pattern:String,flags:String},
    #[serde(rename="semantic")]
    Semantic,
    #[serde(rename="model_search")]
    ModelSearch,
}

#[derive(Debug,Deserialize,Serialize,Clone)]
#[serde(rename_all="lowercase",deny_unknown_fields)]
pub enum MutationPolicy{Locked,Suggest,Auto}

#[derive(Debug,Deserialize,Serialize,Clone)]
pub enum EntrySource{#[serde(rename="user")] User,#[serde(rename="import")] Import,#[serde(rename="system")] System,#[serde(rename="other")] Other}

#[derive(Debug,Deserialize,Serialize,Clone)]
#[serde(deny_unknown_fields)]
pub struct CoreBookEntry{
    pub id:String,
    #[serde(rename="characterId")]
    pub character_id:String,
    pub title:String,
    pub content:String,
    pub tags:Vec<String>,
    pub activation:CoreBookActivation,
    #[serde(rename="retentionPriority")]
    pub retention_priority:i64,
    #[serde(rename="placementWeight")]
    pub placement_weight:i64,
    #[serde(rename="mutationPolicy")]
    pub mutation_policy:MutationPolicy,
    pub enabled:bool,
    pub source:EntrySource,
    pub metadata:Map<String,Value>,
    #[serde(rename="createdAt")]
    pub created_at:String,
    #[serde(rename="updatedAt")]
    pub updated_at:String,
}

#[derive(Debug,Deserialize,Serialize,Clone)]
#[serde(deny_unknown_fields)]
pub struct CoreBookStoreState{
    #[serde(rename="apiVersion")]
    pub api_version:String,
    #[serde(rename="schemaVersion")]
    pub schema_version:String,
    #[serde(rename="characterId")]
    pub character_id:String,
    pub entries:Vec<CoreBookEntry>,
}

fn config_dir(app:&tauri::AppHandle)->Result<PathBuf,String>{
    let directory=app.path().app_config_dir().map_err(|e|format!("failed to resolve app config directory: {e}"))?;
    fs::create_dir_all(&directory).map_err(|e|format!("failed to create app config directory: {e}"))?;
    Ok(directory)
}

fn character_file_name(character_id:&str)->String{
    let mut encoded=String::with_capacity(character_id.len()*2);
    for byte in character_id.as_bytes(){encoded.push_str(&format!("{byte:02x}"));}
    format!("core-book-v1-{encoded}.json")
}

pub fn config_path(app:&tauri::AppHandle,character_id:&str)->Result<PathBuf,String>{
    if character_id.trim().is_empty(){return Err("character id must not be empty".to_string());}
    Ok(config_dir(app)?.join(character_file_name(character_id)))
}

fn validate_activation(activation:&CoreBookActivation)->Result<(),String>{
    match activation{
        CoreBookActivation::Always|CoreBookActivation::Semantic|CoreBookActivation::ModelSearch=>Ok(()),
        CoreBookActivation::Keyword{keywords,match_mode,case_sensitive:_}=>{
            if keywords.is_empty()||keywords.iter().any(|keyword|keyword.trim().is_empty()){return Err("keyword activation requires non-empty keywords".to_string());}
            if match_mode!="any"&&match_mode!="all"{return Err("keyword activation matchMode must be any or all".to_string());}
            Ok(())
        },
        CoreBookActivation::Regex{pattern:_,flags: _}=>Ok(())
    }
}
fn validate_entry(entry:&CoreBookEntry,character_id:&str)->Result<(),String>{
    if entry.character_id!=character_id{return Err("core book entry character scope mismatch".to_string());}
    if entry.id.trim().is_empty(){return Err("core book entry id must not be empty".to_string());}
    if entry.id.len()>200{return Err("core book entry id must not exceed 200 characters".to_string());}
    if entry.title.trim().is_empty(){return Err("core book entry title must not be empty".to_string());}
    if entry.title.len()>200{return Err("core book entry title must not exceed 200 characters".to_string());}
    if entry.retention_priority<0||entry.retention_priority>100{return Err("retentionPriority must be between 0 and 100".to_string());}
    if entry.placement_weight<0||entry.placement_weight>100{return Err("placementWeight must be between 0 and 100".to_string());}
    if entry.created_at.trim().is_empty()||entry.updated_at.trim().is_empty(){return Err("core book timestamps must not be empty".to_string());}
    validate_activation(&entry.activation)?;
    Ok(())
}
fn validate(state:&CoreBookStoreState,character_id:&str)->Result<(),String>{
    if state.api_version!=API_VERSION||state.schema_version!=SCHEMA_VERSION{return Err("unsupported core book storage version".to_string());}
    if state.character_id!=character_id{return Err("core book storage character scope mismatch".to_string());}
    let mut ids=HashSet::new();
    for entry in &state.entries{
        validate_entry(entry,character_id)?;
        if !ids.insert(entry.id.clone()){return Err("core book storage contains duplicate entry ids".to_string());}
    }
    Ok(())
}

pub fn load(app:&tauri::AppHandle,character_id:&str)->Result<Option<CoreBookStoreState>,String>{
    let path=config_path(app,character_id)?;
    if !path.exists(){return Ok(None);}
    let bytes=fs::read(&path).map_err(|e|format!("failed to read core book storage: {e}"))?;
    let state:CoreBookStoreState=serde_json::from_slice(&bytes).map_err(|e|format!("invalid core book storage file: {e}"))?;
    validate(&state,character_id)?;
    Ok(Some(state))
}

pub fn save(app:&tauri::AppHandle,state:&CoreBookStoreState)->Result<(),String>{
    validate(state,&state.character_id)?;
    let path=config_path(app,&state.character_id)?;
    let tmp=path.with_extension("json.tmp");
    let encoded=serde_json::to_vec_pretty(state).map_err(|e|format!("failed to serialize core book storage: {e}"))?;
    let mut file=fs::File::create(&tmp).map_err(|e|format!("failed to create core book storage temp file: {e}"))?;
    file.write_all(&encoded).map_err(|e|format!("failed to write core book storage: {e}"))?;
    file.sync_all().map_err(|e|format!("failed to flush core book storage: {e}"))?;
    drop(file);
    if path.exists(){fs::remove_file(&path).map_err(|e|format!("failed to replace core book storage: {e}"))?;}
    fs::rename(&tmp,&path).map_err(|e|format!("failed to commit core book storage: {e}"))?;
    Ok(())
}
