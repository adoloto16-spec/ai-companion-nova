use serde::{Deserialize,Serialize};
use serde_json::Value;
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
    #[serde(rename="timeoutMs",default)]
    pub timeout_ms:Option<f64>,
    #[serde(rename="numCtx",default,skip_serializing_if="Option::is_none")]
    pub num_ctx:Option<u32>,
    #[serde(rename="numPredict",default,skip_serializing_if="Option::is_none")]
    pub num_predict:Option<u32>,
    #[serde(rename="keepAlive",default,skip_serializing_if="Option::is_none")]
    pub keep_alive:Option<Value>,
}

fn config_dir(app:&tauri::AppHandle)->Result<PathBuf,String>{
    let directory=app.path().app_config_dir().map_err(|e|format!("failed to resolve app config directory: {e}"))?;
    fs::create_dir_all(&directory).map_err(|e|format!("failed to create app config directory: {e}"))?;
    Ok(directory)
}

pub fn config_path(app:&tauri::AppHandle)->Result<PathBuf,String>{
    Ok(config_dir(app)?.join("provider-configuration-v1.json"))
}

fn normalize_legacy_provider_configuration(value:&mut Value)->bool{
    let Some(reference)=value.get_mut("credentialReference").and_then(Value::as_object_mut) else{return false};
    let Some(Value::Number(version))=reference.get("version").cloned() else{return false};
    reference.insert("version".to_string(),Value::String(version.to_string()));
    true
}

fn decode_provider_configuration(bytes:&[u8])->Result<(ProviderConfiguration,bool),String>{
    let mut value:Value=serde_json::from_slice(bytes).map_err(|e|format!("invalid provider configuration file: {e}"))?;
    let migrated=normalize_legacy_provider_configuration(&mut value);
    let configuration:ProviderConfiguration=serde_json::from_value(value).map_err(|e|format!("invalid provider configuration file: {e}"))?;
    validate(&configuration)?;
    Ok((configuration,migrated))
}

fn validate(configuration:&ProviderConfiguration)->Result<(),String>{
    if configuration.api_version!="1"||configuration.schema_version!="1"{return Err("unsupported provider configuration version".to_string());}
    if configuration.provider_id!="openai-compatible"&&configuration.provider_id!="ollama"{return Err("unsupported provider id".to_string());}
    if configuration.base_url.trim()!=configuration.base_url{return Err("provider base URL must not have surrounding whitespace".to_string());}
    let url=url::Url::parse(&configuration.base_url).map_err(|_|"provider base URL is invalid".to_string())?;
    if url.scheme()!="http"&&url.scheme()!="https"{return Err("provider base URL must use HTTP or HTTPS".to_string());}
    if !url.username().is_empty()||url.password().is_some(){return Err("provider base URL must not contain credentials".to_string());}
    if url.query().is_some()||url.fragment().is_some(){return Err("provider base URL must not contain query or fragment".to_string());}
    if configuration.provider_id=="ollama"{
        let host=url.host_str().ok_or_else(||"Ollama base URL has no host".to_string())?;
        let host=host.strip_prefix('[').and_then(|value|value.strip_suffix(']')).unwrap_or(host);
        let loopback=host.eq_ignore_ascii_case("localhost")||host.parse::<std::net::IpAddr>().map(|ip|ip.is_loopback()).unwrap_or(false);
        if url.scheme()!="http"||!loopback||url.path()!="/"{
            return Err("Ollama base URL must use HTTP on localhost, 127.0.0.1, or ::1 without an API path".to_string());
        }
        if configuration.credential_reference.is_some(){return Err("Ollama configuration must not contain an API credential".to_string());}
    }
    if configuration.model.trim()!=configuration.model||configuration.model.is_empty(){return Err("provider model must be a non-empty trimmed string".to_string());}
    if let Some(timeout)=configuration.timeout_ms{
        if !timeout.is_finite()||timeout<=0.0{return Err("provider timeout must be finite and positive".to_string());}
    }
    if let Some(reference)=&configuration.credential_reference{
        if configuration.provider_id!="openai-compatible"||reference.kind!="api-key"||reference.provider.as_deref()!=Some("openai-compatible"){return Err("invalid provider credential reference".to_string());}
    }
    if configuration.enabled&&configuration.credential_reference.is_none()&&configuration.provider_id!="ollama"{return Err("enabled provider requires a credential reference".to_string());}
    if configuration.provider_id!="ollama"&&(configuration.num_ctx.is_some()||configuration.num_predict.is_some()||configuration.keep_alive.is_some()){
        return Err("Ollama generation settings may only be used with the Ollama provider".to_string());
    }
    if configuration.num_ctx==Some(0)||configuration.num_predict==Some(0){return Err("Ollama numCtx and numPredict must be positive integers".to_string());}
    if let Some(value)=&configuration.keep_alive{
        let valid=match value{
            Value::String(duration)=>!duration.trim().is_empty(),
            Value::Number(number)=>number.as_f64().map(|number|number.is_finite()&&number>=0.0).unwrap_or(false),
            _=>false
        };
        if !valid{return Err("Ollama keepAlive must be a non-empty duration string or a non-negative number".to_string());}
    }
    Ok(())
}

pub fn load(app:&tauri::AppHandle)->Result<Option<ProviderConfiguration>,String>{
    let path=config_path(app)?;
    if !path.exists(){return Ok(None);}
    let bytes=fs::read(&path).map_err(|e|format!("failed to read provider configuration: {e}"))?;
    let (configuration,migrated)=decode_provider_configuration(&bytes)?;
    if migrated{save(app,&configuration)?;}
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


#[cfg(test)]
mod tests{
    use super::*;

    fn config_json(version:&str)->String{
        format!(r#"{{"apiVersion":"1","schemaVersion":"1","providerId":"openai-compatible","enabled":false,"baseUrl":"https://api.openai.com/v1","model":"test-model","credentialReference":{{"id":"provider.openai-compatible.default","kind":"api-key","provider":"openai-compatible","version":{version}}}}}"#)
    }

    #[test]
    fn migrates_legacy_numeric_version(){
        let bytes=config_json("1").into_bytes();
        let (configuration,migrated)=decode_provider_configuration(&bytes).expect("legacy configuration should load");
        assert!(migrated);
        assert_eq!(configuration.credential_reference.as_ref().and_then(|reference|reference.version.as_deref()),Some("1"));
    }

    #[test]
    fn preserves_current_string_version(){
        let bytes=config_json(r#""1""#).into_bytes();
        let (configuration,migrated)=decode_provider_configuration(&bytes).expect("current configuration should load");
        assert!(!migrated);
        assert_eq!(configuration.credential_reference.as_ref().and_then(|reference|reference.version.as_deref()),Some("1"));
    }

    #[test]
    fn preserves_missing_version(){
        let bytes=br#"{"apiVersion":"1","schemaVersion":"1","providerId":"openai-compatible","enabled":false,"baseUrl":"https://api.openai.com/v1","model":"test-model","credentialReference":{"id":"provider.openai-compatible.default","kind":"api-key","provider":"openai-compatible"}}"#;
        let (configuration,migrated)=decode_provider_configuration(bytes).expect("configuration without version should load");
        assert!(!migrated);
        assert_eq!(configuration.credential_reference.as_ref().and_then(|reference|reference.version.as_deref()),None);
    }

    #[test]
    fn preserves_null_credential_reference(){
        let bytes=br#"{"apiVersion":"1","schemaVersion":"1","providerId":"openai-compatible","enabled":false,"baseUrl":"https://api.openai.com/v1","model":"test-model","credentialReference":null}"#;
        let (configuration,migrated)=decode_provider_configuration(bytes).expect("null credential reference should load");
        assert!(!migrated);
        assert!(configuration.credential_reference.is_none());
    }

    #[test]
    fn rejects_invalid_version_type(){
        let bytes=config_json("true").into_bytes();
        let error=decode_provider_configuration(&bytes).expect_err("boolean version must be rejected");
        assert!(error.contains("invalid provider configuration file"));
    }

    #[test]
    fn migration_emits_canonical_string_representation(){
        let bytes=config_json("1").into_bytes();
        let (configuration,migrated)=decode_provider_configuration(&bytes).expect("legacy configuration should load");
        assert!(migrated);
        let encoded=serde_json::to_value(configuration).expect("configuration serializes");
        assert_eq!(encoded["credentialReference"]["version"],"1");
    }
}
