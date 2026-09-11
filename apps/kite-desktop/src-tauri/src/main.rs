#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod editor;
mod git;
#[cfg(target_os = "macos")]
mod macos;
mod process;
mod projects;
mod renderer;

use process::ServiceProcess;
use renderer::RendererConnection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tauri::{Manager, RunEvent, State, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tokio::sync::Mutex;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ServiceManifest {
    build_id: String,
    executable_sha256: String,
    expected_server_version: String,
    environment_keys: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Opened {
    connection_id: u64,
    workspace: String,
    expected_server_version: String,
}

#[derive(Default)]
struct DesktopState {
    inner: Mutex<DesktopInner>,
    quitting: AtomicBool,
    exit_allowed: AtomicBool,
    exit_prompt: AtomicBool,
}
#[derive(Default)]
struct DesktopInner {
    workspace: Option<PathBuf>,
    generation: u64,
    process: Option<Arc<RendererConnection>>,
}

#[tauri::command]
async fn pick_workspace(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, DesktopState>,
) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_parent(&window)
        .pick_folder(move |folder| {
            let _ = tx.send(folder);
        });
    let Some(folder) = rx.await.map_err(|_| "文件夹选择未完成。")? else {
        return Ok(None);
    };
    let path = folder
        .into_path()
        .map_err(|_| "请选择本地目录。")?
        .canonicalize()
        .map_err(|_| "目录不可用。")?;
    if !path.is_dir() {
        return Err("请选择目录。".into());
    }
    let text = path
        .to_str()
        .ok_or("目录路径不是有效 Unicode。")?
        .to_string();
    let _inner = state.inner.lock().await;
    projects::remember(
        &app.path()
            .app_data_dir()
            .map_err(|_| "应用数据目录不可用。")?,
        &path,
    )?;
    Ok(Some(text))
}

#[tauri::command]
async fn list_projects(app: tauri::AppHandle) -> Result<Vec<projects::ProjectDisplay>, String> {
    projects::read_display(
        &app.path()
            .app_data_dir()
            .map_err(|_| "应用数据目录不可用。")?,
    )
}

#[tauri::command]
async fn activate_workspace(
    app: tauri::AppHandle,
    state: State<'_, DesktopState>,
    path: String,
) -> Result<String, String> {
    let mut inner = state.inner.lock().await;
    if inner.process.is_some() || state.quitting.load(Ordering::SeqCst) {
        return Err("请先等待当前连接清理完成。".into());
    }
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|_| "应用数据目录不可用。")?;
    let path = projects::known(&directory, &path)?;
    projects::remember(&directory, &path)?;
    let text = path.to_str().ok_or("项目路径不可用。")?.to_string();
    inner.workspace = Some(path);
    Ok(text)
}

#[tauri::command]
async fn check_workspace(app: tauri::AppHandle, path: String) -> Result<(), String> {
    projects::known(
        &app.path()
            .app_data_dir()
            .map_err(|_| "应用数据目录不可用。")?,
        &path,
    )?;
    Ok(())
}

#[tauri::command]
async fn query_workspace_branch(
    app: tauri::AppHandle,
    workspace: String,
) -> Result<git::Snapshot, String> {
    // Read-only Git inspection must not hold the transport/process lock.
    let path = projects::known(
        &app.path()
            .app_data_dir()
            .map_err(|_| "应用数据目录不可用。")?,
        &workspace,
    )?;
    git::snapshot(&path).await
}

#[tauri::command]
async fn switch_workspace_branch(
    state: State<'_, DesktopState>,
    expected: git::Snapshot,
    branch: String,
) -> Result<git::Snapshot, String> {
    let inner = state.inner.lock().await;
    if inner.process.is_some() || state.quitting.load(Ordering::SeqCst) {
        return Err("请先关闭项目服务并等待清理完成。".into());
    }
    let path = inner.workspace.as_ref().ok_or("请先选择项目。")?;
    if path.to_str() != Some(expected.workspace.as_str()) {
        return Err("项目已切换，请重新读取分支。".into());
    }
    git::switch(path, &branch, &expected).await
}

#[tauri::command]
async fn open_editor(
    state: State<'_, DesktopState>,
    connection_id: u64,
    path: String,
    editor: editor::Editor,
) -> Result<(), String> {
    let inner = state.inner.lock().await;
    if inner.generation != connection_id
        || inner.process.is_none()
        || state.quitting.load(Ordering::SeqCst)
    {
        return Err("文件所属项目连接已改变，请重新查看。".into());
    }
    let workspace = inner.workspace.as_ref().ok_or("请先连接项目。")?;
    let target = editor::file_target(workspace, &path)?;
    editor::open(editor, &target).await
}

#[tauri::command]
async fn runtime_status(state: State<'_, DesktopState>) -> Result<RuntimeStatus, String> {
    let inner = state.inner.lock().await;
    Ok(RuntimeStatus {
        workspace: inner
            .workspace
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned()),
        connection_id: inner.process.as_ref().map(|_| inner.generation),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeStatus {
    workspace: Option<String>,
    connection_id: Option<u64>,
}

#[tauri::command]
async fn runtime_open(
    app: tauri::AppHandle,
    state: State<'_, DesktopState>,
) -> Result<Opened, String> {
    let mut inner = state.inner.lock().await;
    if state.quitting.load(Ordering::SeqCst) {
        return Err("应用正在退出。".into());
    }
    if inner.workspace.is_none() {
        // Saved paths select the initial execution context, but need not exist to read history.
        inner.workspace = projects::read(
            &app.path()
                .app_data_dir()
                .map_err(|_| "应用数据目录不可用。")?,
        )
        .ok()
        .and_then(|projects| projects.first().map(|project| PathBuf::from(&project.path)));
    }
    let workspace = inner.workspace.clone().unwrap_or_default();
    if inner
        .process
        .as_ref()
        .is_some_and(|process| process.finished())
    {
        inner.process = None;
    }
    if let Some(process) = inner.process.clone() {
        inner.generation += 1;
        process.attach(inner.generation).await?;
        return Ok(Opened {
            connection_id: inner.generation,
            workspace: workspace.to_string_lossy().into(),
            expected_server_version: process.server_version.clone(),
        });
    }
    let resource = app
        .path()
        .resource_dir()
        .map_err(|_| "安装资源不可用。")?
        .join("service");
    let manifest: ServiceManifest = serde_json::from_str(include_str!("../service/desktop.json"))
        .map_err(|_| "服务制品清单无效。")?;
    let executable = resource.join(if cfg!(windows) {
        "kite-service.exe"
    } else {
        "kite-service"
    });
    let metadata = std::fs::symlink_metadata(&executable).map_err(|_| "配套服务缺失。")?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("服务制品必须是普通文件。".into());
    }
    let bytes = std::fs::read(&executable).map_err(|_| "服务制品无法读取。")?;
    if format!("{:x}", Sha256::digest(&bytes)) != manifest.executable_sha256 {
        return Err("服务制品校验失败，请重新安装。".into());
    }
    if format!(
        "kite-app-server-v1-{:x}",
        Sha256::digest(manifest.build_id.as_bytes())
    ) != manifest.expected_server_version
    {
        return Err("服务版本清单不一致。".into());
    }
    let home = app
        .path()
        .home_dir()
        .map_err(|_| "用户目录不可用。")?
        .canonicalize()
        .map_err(|_| "用户目录不可用。")?;
    let config_root = home.join(".kite-code");
    ensure_private_directory(&config_root, &home)?;
    let runtime_root = if cfg!(debug_assertions) {
        let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .canonicalize()
            .map_err(|_| "源码工作区不可用。")?;
        let canonical_config = config_root.canonicalize().map_err(|_| "配置目录不可用。")?;
        let digest = Sha256::digest(
            format!(
                "kite-source-runtime-profile\0{}\0{}",
                canonical_config.display(),
                repository.display()
            )
            .as_bytes(),
        );
        let parent = canonical_config.join("source-profiles");
        ensure_private_directory(&parent, &home)?;
        let runtime = parent.join(&format!("{digest:x}")[..32]);
        ensure_private_directory(&runtime, &home)?;
        runtime
    } else {
        config_root
    };
    let service = ServiceProcess::spawn(
        &executable,
        &workspace,
        &home,
        &runtime_root,
        &manifest.build_id,
        &manifest.environment_keys,
    )?;
    let process = Arc::new(RendererConnection::new(
        service,
        manifest.expected_server_version.clone(),
    ));
    inner.generation += 1;
    process.attach(inner.generation).await?;
    inner.process = Some(process);
    Ok(Opened {
        connection_id: inner.generation,
        workspace: workspace.to_string_lossy().into(),
        expected_server_version: manifest.expected_server_version,
    })
}

fn ensure_private_directory(path: &std::path::Path, home: &std::path::Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
        match std::fs::DirBuilder::new().mode(0o700).create(path) {
            Ok(()) => (),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
            Err(_) => return Err("无法创建本机私有数据目录。".into()),
        }
        let metadata = std::fs::symlink_metadata(path).map_err(|_| "无法验证本机数据目录。")?;
        let owner = std::fs::metadata(home)
            .map_err(|_| "无法验证用户目录。")?
            .uid();
        if !metadata.is_dir() || metadata.file_type().is_symlink() || metadata.uid() != owner {
            return Err("本机数据目录的类型或所有者不符合要求。".into());
        }
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "无法保护本机数据目录。".to_string())
    }
    #[cfg(not(unix))]
    {
        let _ = (path, home);
        Err("此平台的桌面数据目录保护尚未实现。".into())
    }
}

async fn connection(state: &DesktopState, id: u64) -> Result<Arc<RendererConnection>, String> {
    let inner = state.inner.lock().await;
    if id != inner.generation {
        return Err("连接已被替换。".into());
    }
    inner.process.clone().ok_or_else(|| "连接已关闭。".into())
}

#[tauri::command]
async fn runtime_send(
    state: State<'_, DesktopState>,
    connection_id: u64,
    frame: String,
) -> Result<(), String> {
    connection(&state, connection_id)
        .await?
        .send(connection_id, frame)
        .await
}
#[tauri::command]
async fn runtime_receive(
    state: State<'_, DesktopState>,
    connection_id: u64,
) -> Result<String, String> {
    connection(&state, connection_id)
        .await?
        .receive(connection_id)
        .await
}
#[tauri::command]
async fn runtime_close(state: State<'_, DesktopState>, connection_id: u64) -> Result<(), String> {
    let mut inner = state.inner.lock().await;
    if inner.generation != connection_id {
        return Err("连接已被替换。".into());
    }
    let result = if let Some(process) = &inner.process {
        process.close().await
    } else {
        Ok(())
    };
    inner.process = None;
    result
}

#[tauri::command]
async fn runtime_detach(state: State<'_, DesktopState>, connection_id: u64) -> Result<(), String> {
    let inner = state.inner.lock().await;
    if inner.generation != connection_id {
        return Ok(());
    }
    if let Some(process) = &inner.process {
        process.attach(0).await?;
    }
    Ok(())
}

#[tauri::command]
fn animated_toggle_maximize(window: tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        macos::animated_toggle_maximize(window)
    }
    #[cfg(not(target_os = "macos"))]
    {
        if window.is_maximized().map_err(|error| error.to_string())? {
            window.unmaximize().map_err(|error| error.to_string())
        } else {
            window.maximize().map_err(|error| error.to_string())
        }
    }
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(DesktopState::default())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            macos::install(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pick_workspace,
            list_projects,
            activate_workspace,
            check_workspace,
            query_workspace_branch,
            switch_workspace_branch,
            runtime_open,
            runtime_status,
            runtime_send,
            runtime_receive,
            runtime_close,
            runtime_detach,
            open_editor,
            animated_toggle_maximize
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("无法初始化 Kite Code");
    app.run(|app, event| match event {
        RunEvent::ExitRequested { api, .. } => {
            let state = app.state::<DesktopState>();
            if state.exit_allowed.load(Ordering::SeqCst) {
                return;
            }
            api.prevent_exit();
            if state.quitting.load(Ordering::SeqCst) {
                return;
            }
            if state.exit_prompt.swap(true, Ordering::SeqCst) {
                return;
            }
            let handle = app.clone();
            let Some(window) = app.get_webview_window("main") else {
                state.exit_prompt.store(false, Ordering::SeqCst);
                return;
            };
            let _ = window.show();
            let _ = window.set_focus();
            app.dialog()
                .message("退出会停止此应用中的任务，并等待服务清理。已经发生的修改不会撤销。")
                .title("退出 Kite Code？")
                .parent(&window)
                .buttons(MessageDialogButtons::OkCancelCustom(
                    "停止并退出".into(),
                    "返回".into(),
                ))
                .show(move |confirmed| {
                    let state = handle.state::<DesktopState>();
                    if !confirmed {
                        state.exit_prompt.store(false, Ordering::SeqCst);
                        return;
                    }
                    state.quitting.store(true, Ordering::SeqCst);
                    state.exit_prompt.store(false, Ordering::SeqCst);
                    tauri::async_runtime::spawn(async move {
                        let state = handle.state::<DesktopState>();
                        let mut inner = state.inner.lock().await;
                        let result = if let Some(process) = inner.process.take() {
                            process.close().await
                        } else {
                            Ok(())
                        };
                        drop(inner);
                        if let Err(error) = result {
                            state.quitting.store(false, Ordering::SeqCst);
                            if let Some(window) = handle.get_webview_window("main") {
                                let _ = window.show();
                                handle
                                    .dialog()
                                    .message(error)
                                    .title("服务收尾未正常完成")
                                    .parent(&window)
                                    .show(|_| {});
                            }
                        } else {
                            state.exit_allowed.store(true, Ordering::SeqCst);
                            handle.exit(0);
                        }
                    });
                });
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        _ => {}
    });
}

#[cfg(all(test, unix))]
mod tests {
    use super::ensure_private_directory;
    use std::{
        fs,
        os::unix::fs::{symlink, PermissionsExt},
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn data_directory_rejects_links_and_protects_new_directory() {
        let root = std::env::temp_dir().join(format!(
            "kite-desktop-paths-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        let target = root.join("target");
        fs::create_dir(&target).unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o755)).unwrap();
        let linked = root.join("linked");
        symlink(&target, &linked).unwrap();
        assert!(ensure_private_directory(&linked, &root).is_err());
        assert_eq!(
            fs::metadata(&target).unwrap().permissions().mode() & 0o777,
            0o755
        );
        let private = root.join("private");
        ensure_private_directory(&private, &root).unwrap();
        assert_eq!(
            fs::metadata(private).unwrap().permissions().mode() & 0o777,
            0o700
        );
        fs::remove_dir_all(root).unwrap();
    }
}
