#[cfg(feature="tauri-app")]
mod config;
#[cfg(feature="tauri-app")]
mod characters;
#[cfg(feature="tauri-app")]
mod core_book;
#[cfg(feature="tauri-app")]
mod memory;
#[cfg(feature="tauri-app")]
mod retrieval;
mod windows_credentials;

use serde::Serialize;
use serde_json::Value;
use std::sync::Mutex;
use windows_credentials::{CredentialReference,WindowsCredentialStore};

#[derive(Serialize)]
struct HostDiagnostics{
    status:&'static str,
    runtime:&'static str,
    capabilities:Vec<&'static str>,
}

#[cfg(feature="tauri-app")]
#[tauri::command]
fn get_host_diagnostics()->HostDiagnostics{
    HostDiagnostics{
        status:"ready",
        runtime:"rust-host",
        capabilities:vec![
            "ipc",
            "runtime-diagnostics",
            "credential-store",
            "provider-configuration",
            "character-storage",
            "core-book-storage",
            "dynamic-memory-storage"
        ],
    }
}

#[cfg(feature="tauri-app")]
#[tauri::command]
fn set_runtime_diagnostics(
    diagnostics:Value,
    state:tauri::State<'_,RuntimeDiagnosticsState>,
)->Result<(),String>{
    let object=diagnostics.as_object().ok_or_else(||"runtime diagnostics must be a JSON object".to_string())?;
    if object.get("schemaVersion").and_then(Value::as_str)!=Some("1"){return Err("unsupported runtime diagnostics schemaVersion".to_string());}
    let encoded=serde_json::to_vec(&diagnostics).map_err(|e|format!("failed to serialize diagnostics: {e}"))?;
    if encoded.len()>256*1024{return Err("runtime diagnostics payload exceeds 256 KiB".to_string());}
    let mut slot=state.0.lock().map_err(|_|"runtime diagnostics state lock poisoned".to_string())?;
    *slot=Some(diagnostics);
    Ok(())
}

#[cfg(feature="tauri-app")]
#[tauri::command]
fn get_runtime_diagnostics(state:tauri::State<'_,RuntimeDiagnosticsState>)->Result<Option<Value>,String>{
    let slot=state.0.lock().map_err(|_|"runtime diagnostics state lock poisoned".to_string())?;
    Ok(slot.clone())
}

#[cfg(feature="tauri-app")]
#[tauri::command]
fn save_credential(reference:CredentialReference,secret:String)->Result<(),String>{
    WindowsCredentialStore.set_secret(&reference,&secret)
}

#[cfg(feature="tauri-app")]
#[tauri::command]
fn get_credential(reference:CredentialReference)->Result<Option<String>,String>{
    WindowsCredentialStore.get_secret(&reference)
}

#[cfg(feature="tauri-app")]
#[tauri::command]
fn delete_credential(reference:CredentialReference)->Result<(),String>{
    WindowsCredentialStore.delete_secret(&reference)
}

#[cfg(feature="tauri-app")]
#[tauri::command]
fn credential_exists(reference:CredentialReference)->Result<bool,String>{
    WindowsCredentialStore.exists(&reference)
}

#[cfg(feature="tauri-app")]
#[tauri::command]
fn get_provider_configuration(app:tauri::AppHandle)->Result<Option<config::ProviderConfiguration>,String>{
    config::load(&app)
}

#[cfg(feature="tauri-app")]
#[tauri::command]
fn save_provider_configuration(app:tauri::AppHandle,configuration:config::ProviderConfiguration)->Result<(),String>{
    config::save(&app,&configuration)
}

#[cfg(feature="tauri-app")]
#[tauri::command]
fn delete_provider_configuration(app:tauri::AppHandle)->Result<(),String>{
    config::clear(&app)
}

#[cfg(feature="tauri-app")]
#[tauri::command]
fn get_characters(app:tauri::AppHandle)->Result<Option<characters::CharacterStoreState>,String>{
    characters::load(&app)
}

#[cfg(feature="tauri-app")]
#[tauri::command]
fn save_characters(app:tauri::AppHandle,state:characters::CharacterStoreState)->Result<(),String>{
    characters::save(&app,&state)
}

#[cfg(feature="tauri-app")]
#[tauri::command]
fn get_core_book_entries(app:tauri::AppHandle,character_id:String)->Result<Option<core_book::CoreBookStoreState>,String>{
    core_book::load(&app,&character_id)
}

#[cfg(feature="tauri-app")]
#[tauri::command]
fn save_core_book_entries(app:tauri::AppHandle,state:core_book::CoreBookStoreState)->Result<(),String>{
    core_book::save(&app,&state)
}

#[cfg(feature="tauri-app")]
#[tauri::command]
fn get_memory_state(app:tauri::AppHandle,character_id:String,state:tauri::State<'_,memory::MemoryWriteLock>)->Result<Option<memory::MemoryStoreState>,String>{
    memory::load(&app,&character_id,&state)
}

#[cfg(feature="tauri-app")]
#[tauri::command]
fn save_memory_state(app:tauri::AppHandle,state_value:memory::MemoryStoreState,state:tauri::State<'_,memory::MemoryWriteLock>)->Result<(),String>{
    memory::save(&app,&state_value,&state)
}

#[cfg(feature="tauri-app")]
#[tauri::command]
fn supersede_memory(
    app:tauri::AppHandle,
    character_id:String,
    previous_memory_id:String,
    replacement:memory::MemoryItem,
    state:tauri::State<'_,memory::MemoryWriteLock>,
)->Result<memory::MemoryItem,String>{
    memory::supersede(&app,&character_id,&previous_memory_id,replacement,&state)
}

#[cfg(feature="tauri-app")]
#[tauri::command]
fn search_retrieval_index(app:tauri::AppHandle,query:retrieval::RetrievalQuery,state:tauri::State<'_,retrieval::RetrievalIndexLock>)->Result<retrieval::RetrievalResult,String>{retrieval::search(&app,&query,&state)}
#[cfg(feature="tauri-app")]
#[tauri::command]
fn rebuild_retrieval_index(app:tauri::AppHandle,character_id:String,retrieval_state:tauri::State<'_,retrieval::RetrievalIndexLock>,memory_state:tauri::State<'_,memory::MemoryWriteLock>)->Result<(),String>{retrieval::rebuild_character(&app,&character_id,&retrieval_state,&memory_state)}
#[cfg(feature="tauri-app")]
#[tauri::command]
fn rebuild_all_retrieval_index(app:tauri::AppHandle,retrieval_state:tauri::State<'_,retrieval::RetrievalIndexLock>,memory_state:tauri::State<'_,memory::MemoryWriteLock>)->Result<(),String>{retrieval::rebuild_all(&app,&retrieval_state,&memory_state)}
#[cfg(feature="tauri-app")]
#[tauri::command]
fn upsert_retrieval_document(app:tauri::AppHandle,document:retrieval::RetrievalIndexDocument,state:tauri::State<'_,retrieval::RetrievalIndexLock>)->Result<(),String>{retrieval::upsert(&app,&document,&state)}
#[cfg(feature="tauri-app")]
#[tauri::command]
fn remove_retrieval_document(app:tauri::AppHandle,character_id:String,source:retrieval::RetrievalSource,source_id:String,state:tauri::State<'_,retrieval::RetrievalIndexLock>)->Result<(),String>{retrieval::remove(&app,&character_id,&source,&source_id,&state)}
#[cfg(feature="tauri-app")]
#[tauri::command]
fn remove_retrieval_character(app:tauri::AppHandle,character_id:String,state:tauri::State<'_,retrieval::RetrievalIndexLock>)->Result<(),String>{retrieval::remove_character(&app,&character_id,&state)}

#[derive(Default)]
struct RuntimeDiagnosticsState(Mutex<Option<Value>>);

#[cfg(feature="tauri-app")]
fn main(){
    tauri::Builder::default()
        .manage(RuntimeDiagnosticsState::default())
        .manage(memory::MemoryWriteLock::default())
        .manage(retrieval::RetrievalIndexLock::default())
        .invoke_handler(tauri::generate_handler![
            get_host_diagnostics,
            set_runtime_diagnostics,
            get_runtime_diagnostics,
            save_credential,
            get_credential,
            delete_credential,
            credential_exists,
            get_provider_configuration,
            save_provider_configuration,
            delete_provider_configuration,
            get_characters,
            save_characters,
            get_core_book_entries,
            save_core_book_entries,
            get_memory_state,
            save_memory_state,
            supersede_memory,
            search_retrieval_index,
            rebuild_retrieval_index,
            rebuild_all_retrieval_index,
            upsert_retrieval_document,
            remove_retrieval_document,
            remove_retrieval_character
        ])
        .run(tauri::generate_context!())
        .expect("Tauri runtime failed");
}

#[cfg(not(feature="tauri-app"))]
fn main(){println!("Nova desktop host ready");}
