use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Project {
    pub path: String,
    pub last_opened_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDisplay {
    #[serde(flatten)]
    pub project: Project,
    pub directory_missing: bool,
}

pub fn read_display(directory: &Path) -> Result<Vec<ProjectDisplay>, String> {
    Ok(read(directory)?
        .into_iter()
        .map(|project| {
            let directory_missing = match fs::metadata(&project.path) {
                Ok(metadata) => !metadata.is_dir(),
                Err(error) => error.kind() == std::io::ErrorKind::NotFound,
            };
            ProjectDisplay {
                project,
                directory_missing,
            }
        })
        .collect())
}

pub fn canonical_project(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value)
        .canonicalize()
        .map_err(|_| "项目目录已不存在或无法访问。")?;
    if !path.is_dir() || path.to_str().is_none() {
        return Err("请选择有效的本地项目目录。".into());
    }
    Ok(path)
}

pub fn read(directory: &Path) -> Result<Vec<Project>, String> {
    let file = directory.join("projects.json");
    let metadata = match fs::symlink_metadata(&file) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(_) => return Err("无法读取已打开项目列表。".into()),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 1_048_576 {
        return Err("项目列表文件无效。".into());
    }
    serde_json::from_slice(&fs::read(file).map_err(|_| "无法读取项目列表。")?)
        .map_err(|_| "项目列表格式无效，请检查应用数据目录中的 projects.json。".into())
}

pub fn remember(directory: &Path, path: &Path) -> Result<Vec<Project>, String> {
    let mut projects = read(directory)?;
    let path = path.to_str().ok_or("项目路径不可用。")?.to_string();
    projects.retain(|project| project.path != path);
    projects.insert(
        0,
        Project {
            path,
            last_opened_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| "系统时间无效。")?
                .as_millis() as u64,
        },
    );
    fs::create_dir_all(directory).map_err(|_| "无法创建应用数据目录。")?;
    let temp = directory.join(format!(
        "projects-{}-{}.tmp",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "系统时间无效。")?
            .as_nanos()
    ));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp).map_err(|_| "无法保存项目列表。")?;
        file.write_all(&serde_json::to_vec(&projects).map_err(|_| "项目列表无法编码。")?)
            .map_err(|_| "无法写入项目列表。")?;
        file.sync_all().map_err(|_| "无法保存项目列表。")?;
        fs::rename(&temp, directory.join("projects.json")).map_err(|_| "无法更新项目列表。")
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result?;
    Ok(projects)
}

pub fn known(directory: &Path, value: &str) -> Result<PathBuf, String> {
    let path = canonical_project(value)?;
    if path.to_str() != Some(value) || !read(directory)?.iter().any(|p| p.path == value) {
        return Err("项目路径已改变或未通过目录选择器添加，请重新添加项目。".into());
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recent_projects_are_explicit_canonical_deduplicated_and_persistent() {
        let root = std::env::temp_dir().join(format!(
            "kite-projects-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(root.join("a")).unwrap();
        fs::create_dir_all(root.join("b")).unwrap();
        let a = root.join("a").canonicalize().unwrap();
        let b = root.join("b").canonicalize().unwrap();
        let data = root.join("data");
        assert!(read(&data).unwrap().is_empty());
        assert!(!data.exists());
        assert!(known(&data, a.to_str().unwrap()).is_err());
        remember(&data, &a).unwrap();
        remember(&data, &b).unwrap();
        remember(&data, &a).unwrap();
        let projects = read(&data).unwrap();
        assert_eq!(projects.len(), 2);
        assert_eq!(projects[0].path, a.to_str().unwrap());
        assert_eq!(known(&data, a.to_str().unwrap()).unwrap(), a);
        fs::remove_dir(&b).unwrap();
        assert!(known(&data, b.to_str().unwrap()).is_err());
        assert_eq!(read(&data).unwrap().len(), 2);
        let display = read_display(&data).unwrap();
        assert!(!display[0].directory_missing);
        assert!(display[1].directory_missing);
        assert!(!fs::read_to_string(data.join("projects.json"))
            .unwrap()
            .contains("directoryMissing"));
        fs::create_dir(&b).unwrap();
        assert!(!read_display(&data).unwrap()[1].directory_missing);
        fs::remove_dir_all(root).unwrap();
    }
}
