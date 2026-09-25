fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(
                tauri_build::AppManifest::new().commands(&[
                    "get_host_diagnostics",
                    "set_runtime_diagnostics",
                    "get_runtime_diagnostics",
                    "save_credential",
                    "get_credential",
                    "delete_credential",
                    "credential_exists",
                    "get_provider_configuration",
                    "save_provider_configuration",
                    "delete_provider_configuration",
                ]),
            ),
    )
    .expect("failed to build Tauri application metadata");
}
