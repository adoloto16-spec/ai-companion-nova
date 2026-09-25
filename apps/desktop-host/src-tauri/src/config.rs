use serde::{Deserialize,Serialize};
use std::{fs,io::Write,path::PathBuf};
use tauri::Manager;

#[derive(Debug,Deserialize,Serialize,Clone)]
#[serde(deny_unknown_fields)]
pub struct ProviderConfiguration{
    #[serde(rename="apiVersion")]
    pub api_version:String,
    #[serde(rename="schemaVersion")]
    pub schema_version:String,
    #[serde(rename="providerId")]
    pub provider_id:String,
    pub enabled:bool,
    #[serde(rename="baseUrl")]
    pub base_url:String,
    pub model:String,
    #[serde(rename="credentialReference")]
    pub credential_reference:Option<super::windows_credentials::CredentialReference>,
    #[serde(rename="timeoutMs")]
    pub timeout_ms:Option<f64>,
}

fn config_dir(app:&tauri::AppHandle)->Result<PathBuf,String>{
    let directory=app.path().app_config_dir().map_err(|e|format!("failed to resolve app config directory: {e}"))?;
    fs::create_dir_all(&directory).map_err(|e|format!("failed to create app config directory: {e}"))?;
    Ok(directory)
}

pub fn config_path(app:&tauri::AppHandle)->Result<PathBuf,String>{
    Ok(config_dir(app)?.join("provider-configuration-v1.json"))
}

fn validate(configuration:&ProviderConfiguration)->Result<(),String>{
    if configuration.api_version!="1"||configuration.schema_version!="1"{return Err("unsupported provider configuration version".to_string());}
    if configuration.provider_id!="openai-compatible"{return Err("unsupported provider id".to_string());}
    if configuration.base_url.trim()!=configuration.base_url{return Err("provider base URL must not have surrounding whitespace".to_string());}
    let url=url::Url::parse(&configuration.base_url).map_err(|_|"provider base URL is invalid".to_string())?;
    if url.scheme()!="http"&&url.scheme()!="https"{return Err("provider base URL must use HTTP or HTTPS".to_string());}
    if !url.username().is_empty()||url.password().is_some(){return Err("provider base URL must not contain credentials".to_string());}
    if url.query().is_some()||url.fragment().is_some(){return Err("provider base URL must not contain query or fragment".to_string());}
    if configuration.model.trim()!=configuration.model||configuration.model.is_empty(){return Err("provider model must be a non-empty trimmed string".to_string());}
    if let Some(timeout)=configuration.timeout_ms{
        if !timeout.is_finite()||timeout<=0.0{return Err("provider timeout must be finite and positive".to_string());}
    }
    if let Some(reference)=&configuration.credential_reference{
        if reference.kind!="api-key"||reference.provider.as_deref()!=Some("openai-compatible"){return Err("invalid provider credential reference".to_string());}
    }
    if configuration.enabled&&configuration.credential_reference.is_none(){return Err("enabled provider requires a credential reference".to_string());}
    Ok(())
}

pub fn load(app:&tauri::AppHandle)->Result<Option<ProviderConfiguration>,String>{
    let path=config_path(app)?;
    if !path.exists(){return Ok(None);}
    let bytes=fs::read(&path).map_err(|e|format!("failed to read provider configuration: {e}"))?;
    let configuration:ProviderConfiguration=serde_json::from_slice(&bytes).map_err(|e|format!("invalid provider configuration file: {e}"))?;
    validate(&configuration)?;
    Ok(Some(configuration))
}

pub fn save(app:&tauri::AppHandle,configuration:&ProviderConfiguration)->Result<(),String>{
    validate(configuration)?;
    let path=config_path(app)?;
    let tmp=path.with_extension("json.tmp");
    let encoded=serde_json::to_vec_pretty(configuration).map_err(|e|format!("failed to serialize provider configuration: {e}"))?;
    let mut file=fs::File::create(&tmp).map_err(|e|format!("failed to create provider configuration temp file: {e}"))?;
    file.write_all(&encoded).map_err(|e|format!("failed to write provider configuration: {e}"))?;
    file.sync_all().map_err(|e|format!("failed to flush provider configuration: {e}"))?;
    drop(file);
    if path.exists(){fs::remove_file(&path).map_err(|e|format!("failed to replace provider configuration: {e}"))?;}
    fs::rename(&tmp,&path).map_err(|e|format!("failed to commit provider configuration: {e}"))?;
    Ok(())
}

pub fn clear(app:&tauri::AppHandle)->Result<(),String>{
    let path=config_path(app)?;
    if path.exists(){fs::remove_file(path).map_err(|e|format!("failed to remove provider configuration: {e}"))?;}
    Ok(())
}
