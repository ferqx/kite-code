fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "select_workspace",
            "runtime_open",
            "runtime_send",
            "runtime_receive",
            "runtime_close",
            "open_editor",
        ]),
    ))
    .expect("Tauri build failed");
}
