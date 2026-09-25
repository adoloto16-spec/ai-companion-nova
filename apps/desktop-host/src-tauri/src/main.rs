use serde::Serialize;
use serde_json::Value;
use std::sync::Mutex;

#[derive(Serialize)]
struct HostDiagnostics {
    status: &'static str,
    runtime: &'static str,
    capabilities: Vec<&'static str>,
}

#[derive(Default)]
struct RuntimeDiagnosticsState(Mutex<Option<Value>>);

#[cfg(feature = "tauri-app")]
#[tauri::command]
fn get_host_diagnostics() -> HostDiagnostics {
    HostDiagnostics {
        status: "ready",
        runtime: "rust-host",
        capabilities: vec!["ipc", "runtime-diagnostics"],
    }
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
fn set_runtime_diagnostics(
    diagnostics: Value,
    state: tauri::State<'_, RuntimeDiagnosticsState>,
) -> Result<(), String> {
    let object = diagnostics
        .as_object()
        .ok_or_else(|| "runtime diagnostics must be a JSON object".to_string())?;

    if object.get("schemaVersion").and_then(Value::as_str) != Some("1") {
        return Err("unsupported runtime diagnostics schemaVersion".to_string());
    }

    let encoded = serde_json::to_vec(&diagnostics)
        .map_err(|error| format!("failed to serialize diagnostics: {error}"))?;

    if encoded.len() > 256 * 1024 {
        return Err("runtime diagnostics payload exceeds 256 KiB".to_string());
    }

    let mut slot = state
        .0
        .lock()
        .map_err(|_| "runtime diagnostics state lock poisoned".to_string())?;

    *slot = Some(diagnostics);
    Ok(())
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
fn get_runtime_diagnostics(
    state: tauri::State<'_, RuntimeDiagnosticsState>,
) -> Result<Option<Value>, String> {
    let slot = state
        .0
        .lock()
        .map_err(|_| "runtime diagnostics state lock poisoned".to_string())?;

    Ok(slot.clone())
}

#[cfg(feature = "tauri-app")]
fn main() {
    tauri::Builder::default()
        .manage(RuntimeDiagnosticsState::default())
        .invoke_handler(tauri::generate_handler![
            get_host_diagnostics,
            set_runtime_diagnostics,
            get_runtime_diagnostics
        ])
        .run(tauri::generate_context!())
        .expect("Tauri runtime failed");
}

#[cfg(not(feature = "tauri-app"))]
fn main() {
    println!("Nova desktop host ready");
}
