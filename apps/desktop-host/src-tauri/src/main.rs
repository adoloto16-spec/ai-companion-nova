use serde::Serialize;

#[derive(Serialize)]
struct HostDiagnostics {
    status: &'static str,
    runtime: &'static str,
    capabilities: Vec<&'static str>,
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
fn get_host_diagnostics() -> HostDiagnostics {
    HostDiagnostics {
        status: "ready",
        runtime: "rust-host",
        capabilities: vec!["ipc"],
    }
}

#[cfg(feature = "tauri-app")]
fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![get_host_diagnostics])
        .run(tauri::generate_context!())
        .expect("Tauri runtime failed");
}

#[cfg(not(feature = "tauri-app"))]
fn main() {
    println!("Nova desktop host ready");
}
