fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(
                tauri_build::AppManifest::new().commands(&[
                    "get_host_diagnostics",
                    "set_runtime_diagnostics",
                    "get_runtime_diagnostics",
                ]),
            ),
    )
    .expect("failed to build Tauri application metadata");
}
