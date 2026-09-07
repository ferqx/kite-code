use serde::Deserialize;
use std::path::{Component, Path, PathBuf};

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Editor {
    Vscode,
    Zed,
    Textedit,
}

pub fn file_target(workspace: &Path, supplied: &str) -> Result<PathBuf, String> {
    if supplied.is_empty() || supplied.len() > 8192 || supplied.chars().any(char::is_control) {
        return Err("文件目标无效。".into());
    }
    let root = workspace.canonicalize().map_err(|_| "项目已不可用。")?;
    if root != workspace {
        return Err("项目路径发生变化，请重新连接。".into());
    }
    let path = Path::new(supplied);
    if path
        .components()
        .any(|part| matches!(part, Component::ParentDir))
    {
        return Err("文件目标不能包含上级目录。".into());
    }
    let target = if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    };
    let target = target
        .canonicalize()
        .map_err(|_| "文件不存在或已不可用。")?;
    if !target.starts_with(&root) || !target.is_file() {
        return Err("只能打开当前项目内的普通文件。".into());
    }
    Ok(target)
}

pub async fn open(editor: Editor, target: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let application = match editor {
            Editor::Vscode => "Visual Studio Code",
            Editor::Zed => "Zed",
            Editor::Textedit => "TextEdit",
        };
        let mut command = tokio::process::Command::new("/usr/bin/open");
        command
            .args(["-a", application, "--"])
            .arg(target)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        let status = tokio::time::timeout(std::time::Duration::from_secs(10), command.status())
            .await
            .map_err(|_| "打开编辑器超时。")?
            .map_err(|_| "无法启动编辑器。")?;
        if !status.success() {
            return Err("无法打开文件，请确认所选编辑器已安装。".into());
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (editor, target);
        Err("外部编辑器跳转尚未在此平台验证。".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_existing_workspace_files_are_opened() {
        let directory = std::env::temp_dir().join(format!("kite-editor-{}", std::process::id()));
        std::fs::create_dir_all(directory.join("workspace")).unwrap();
        let root = directory.join("workspace").canonicalize().unwrap();
        std::fs::write(root.join("hello world.ts"), "export {};").unwrap();
        std::fs::write(directory.join("outside.ts"), "private").unwrap();
        assert_eq!(
            file_target(&root, "hello world.ts").unwrap(),
            root.join("hello world.ts")
        );
        assert!(file_target(&root, "../outside.ts").is_err());
        assert!(file_target(&root, directory.join("outside.ts").to_str().unwrap()).is_err());
        assert!(file_target(&root, "missing.ts").is_err());
        assert!(file_target(&root, ".").is_err());
        assert!(file_target(&root, "hello\nworld.ts").is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(directory.join("outside.ts"), root.join("escape.ts"))
                .unwrap();
            assert!(file_target(&root, "escape.ts").is_err());
        }
        std::fs::remove_dir_all(directory).unwrap();
    }
}
