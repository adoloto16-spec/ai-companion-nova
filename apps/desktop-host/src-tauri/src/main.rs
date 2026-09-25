use serde::Serialize;

#[derive(Serialize)]
struct ModuleStatus{ id:&'static str,state:&'static str,health:&'static str }
#[derive(Serialize)]
struct Diagnostics{ status:&'static str,runtime:&'static str,modules:Vec<ModuleStatus> }

fn diagnostics()->Diagnostics{
  Diagnostics{status:"ready",runtime:"rust host",modules:vec![
    ModuleStatus{id:"character.fake",state:"running",health:"healthy"},
    ModuleStatus{id:"memory.fake",state:"running",health:"healthy"},
    ModuleStatus{id:"browser.fake",state:"running",health:"healthy"}]}
}

#[cfg(feature="tauri-app")]
#[tauri::command]
fn get_diagnostics()->Diagnostics{diagnostics()}

#[cfg(feature="tauri-app")]
fn main(){
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![get_diagnostics])
    .run(tauri::generate_context!())
    .expect("Tauri runtime failed");
}

#[cfg(not(feature="tauri-app"))]
fn main(){println!("Nova desktop host ready");}
