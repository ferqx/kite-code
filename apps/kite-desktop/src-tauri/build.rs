fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "pick_workspace",
            "list_projects",
            "activate_workspace",
            "check_workspace",
            "query_workspace_branch",
            "switch_workspace_branch",
            "runtime_open",
            "runtime_status",
            "runtime_send",
            "runtime_receive",
            "runtime_close",
            "runtime_detach",
            "open_editor",
        ]),
    ))
    .expect("Tauri build failed");
}
