use serde::{Deserialize, Serialize};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{io::AsyncReadExt, process::Command, time::timeout};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub workspace: String,
    pub repository: bool,
    pub root: Option<String>,
    pub current: Option<String>,
    pub head: Option<String>,
    pub branches: Vec<String>,
    pub dirty: bool,
    pub can_switch: bool,
}

async fn run(path: &Path, args: &[&str]) -> Result<(bool, String), String> {
    let mut command = Command::new("git");
    command
        .current_dir(path)
        .env_clear()
        .env(
            "PATH",
            std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".into()),
        )
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .args([
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.fsmonitor=false",
        ])
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|_| "无法启动 Git，请检查是否已安装。")?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or("Git 输出不可用。")?
        .take(1_048_577);
    let mut stderr = child
        .stderr
        .take()
        .ok_or("Git 错误输出不可用。")?
        .take(1_048_577);
    let mut output = vec![];
    let mut errors = vec![];
    let (status, _, _) = timeout(Duration::from_secs(15), async {
        tokio::try_join!(
            child.wait(),
            stdout.read_to_end(&mut output),
            stderr.read_to_end(&mut errors)
        )
    })
    .await
    .map_err(|_| "Git 操作超时，请刷新分支确认实际状态。")?
    .map_err(|_| "Git 操作未完成，请刷新分支。")?;
    if output.len() > 1_048_576 || errors.len() > 1_048_576 {
        return Err("Git 输出过大，无法确认项目状态。".into());
    }
    let output = String::from_utf8(output).map_err(|_| "Git 输出编码不可用。")?;
    Ok((status.success(), output))
}

pub async fn snapshot(path: &Path) -> Result<Snapshot, String> {
    let workspace = path.to_str().ok_or("项目路径不可用。")?.to_string();
    if path.canonicalize().map_err(|_| "项目目录不可用。")? != path {
        return Err("项目路径已改变，请重新添加项目。".into());
    }
    // Ordinary work directories do not require Git to be installed or invoked.
    if !path.ancestors().any(|parent| parent.join(".git").exists()) {
        return Ok(Snapshot {
            workspace,
            repository: false,
            root: None,
            current: None,
            head: None,
            branches: vec![],
            dirty: false,
            can_switch: false,
        });
    }
    let (repository, root) = run(path, &["rev-parse", "--show-toplevel"]).await?;
    if !repository {
        // A damaged repository must not be silently treated as an ordinary directory.
        if path.ancestors().any(|parent| parent.join(".git").exists()) {
            return Err("Git 仓库状态无法读取，请检查仓库后重试。".into());
        }
        return Ok(Snapshot {
            workspace,
            repository: false,
            root: None,
            current: None,
            head: None,
            branches: vec![],
            dirty: false,
            can_switch: false,
        });
    }
    let root = root.trim_end().to_string();
    let (has_branch, branch) = run(path, &["symbolic-ref", "--quiet", "--short", "HEAD"]).await?;
    let (has_head, head) = run(path, &["rev-parse", "--verify", "HEAD"]).await?;
    let (refs_ok, refs) = run(
        path,
        &["for-each-ref", "--format=%(refname:short)", "refs/heads"],
    )
    .await?;
    let (status_ok, status) = run(
        path,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )
    .await?;
    if !refs_ok || !status_ok {
        return Err("无法确认 Git 分支或工作区改动。".into());
    }
    Ok(Snapshot {
        can_switch: Path::new(&root).canonicalize().ok().as_deref() == Some(path),
        workspace,
        repository: true,
        root: Some(root),
        current: has_branch.then(|| branch.trim_end().to_string()),
        head: has_head.then(|| head.trim_end().to_string()),
        branches: refs.lines().map(str::to_string).collect(),
        dirty: !status.is_empty(),
    })
}

pub async fn switch(path: &Path, branch: &str, expected: &Snapshot) -> Result<Snapshot, String> {
    let current = snapshot(path).await?;
    if current.workspace != expected.workspace
        || current.root != expected.root
        || current.current != expected.current
        || current.head != expected.head
    {
        return Err("项目或分支已改变，请刷新后重新选择。".into());
    }
    if current.current.as_deref() == Some(branch) {
        return Ok(current);
    }
    if !current.can_switch {
        return Err("请打开 Git 仓库根目录后切换分支。".into());
    }
    if current.dirty {
        return Err("工作区有未提交或未跟踪的改动，请先处理后再切换分支。".into());
    }
    if !current.branches.iter().any(|item| item == branch) {
        return Err("所选本地分支已不存在，请刷新后重试。".into());
    }
    let (ok, _) = run(path, &["switch", "--no-guess", "--", branch]).await?;
    if !ok {
        return Err("Git 未能切换分支，可能被其他工作目录占用；请刷新确认实际状态。".into());
    }
    let actual = snapshot(path).await?;
    if actual.current.as_deref() != Some(branch) {
        return Err("无法确认分支切换结果，请刷新检查。".into());
    }
    Ok(actual)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    struct Repo(PathBuf);
    static NEXT_REPO: AtomicU64 = AtomicU64::new(0);
    impl Repo {
        async fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "kite-branches-{}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT_REPO.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            let repo = Self(path.canonicalize().unwrap());
            assert!(!snapshot(&repo.0).await.unwrap().repository);
            assert!(
                run(&repo.0, &["init", "--initial-branch=main"])
                    .await
                    .unwrap()
                    .0
            );
            repo
        }
        async fn commit(&self) {
            fs::write(self.0.join("file.txt"), "main\n").unwrap();
            assert!(run(&self.0, &["add", "file.txt"]).await.unwrap().0);
            assert!(
                run(
                    &self.0,
                    &[
                        "-c",
                        "user.name=Test",
                        "-c",
                        "user.email=test@example.invalid",
                        "commit",
                        "-m",
                        "initial"
                    ]
                )
                .await
                .unwrap()
                .0
            );
            assert!(run(&self.0, &["branch", "feature"]).await.unwrap().0);
        }
    }
    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[tokio::test]
    async fn ordinary_work_directory_does_not_require_git() {
        if std::env::var_os("KITE_TEST_NO_GIT").is_none() {
            let status = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "git::tests::ordinary_work_directory_does_not_require_git",
                ])
                .env("KITE_TEST_NO_GIT", "1")
                .env("PATH", "")
                .status()
                .unwrap();
            assert!(status.success());
            return;
        }
        let path = std::env::temp_dir().join(format!("kite-no-git-{}", std::process::id()));
        fs::create_dir(&path).unwrap();
        let path = path.canonicalize().unwrap();
        assert!(run(&path, &["--version"]).await.is_err());
        let result = snapshot(&path).await.unwrap();
        assert!(!result.repository);
        assert!(!result.can_switch);
        fs::remove_dir(path).unwrap();
    }

    #[tokio::test]
    async fn switches_existing_branches_and_handles_unborn_detached_and_invalid_targets() {
        let repo = Repo::new().await;
        let unborn = snapshot(&repo.0).await.unwrap();
        assert_eq!(unborn.current.as_deref(), Some("main"));
        assert!(unborn.head.is_none());
        assert!(unborn.branches.is_empty());
        repo.commit().await;
        let before = snapshot(&repo.0).await.unwrap();
        assert!(switch(&repo.0, "missing", &before).await.is_err());
        assert!(switch(&repo.0, "--detach", &before).await.is_err());
        let changed = switch(&repo.0, "feature", &before).await.unwrap();
        assert_eq!(changed.current.as_deref(), Some("feature"));
        assert!(switch(&repo.0, "main", &before).await.is_err());
        assert!(
            run(&repo.0, &["switch", "--detach", "HEAD"])
                .await
                .unwrap()
                .0
        );
        let detached = snapshot(&repo.0).await.unwrap();
        assert!(detached.current.is_none());
        assert!(detached.head.is_some());
        assert_eq!(
            switch(&repo.0, "main", &detached)
                .await
                .unwrap()
                .current
                .as_deref(),
            Some("main")
        );
    }

    #[tokio::test]
    async fn dirty_staged_untracked_and_parent_repository_changes_are_not_overwritten() {
        let repo = Repo::new().await;
        repo.commit().await;
        for staged in [false, true] {
            fs::write(repo.0.join("file.txt"), "keep my edit\n").unwrap();
            if staged {
                assert!(run(&repo.0, &["add", "file.txt"]).await.unwrap().0);
            }
            let state = snapshot(&repo.0).await.unwrap();
            assert!(switch(&repo.0, "feature", &state)
                .await
                .unwrap_err()
                .contains("改动"));
            assert_eq!(
                switch(&repo.0, "main", &state)
                    .await
                    .unwrap()
                    .current
                    .as_deref(),
                Some("main")
            );
            assert_eq!(
                fs::read_to_string(repo.0.join("file.txt")).unwrap(),
                "keep my edit\n"
            );
            assert!(
                run(&repo.0, &["restore", "--staged", "file.txt"])
                    .await
                    .unwrap()
                    .0
            );
            assert!(run(&repo.0, &["restore", "file.txt"]).await.unwrap().0);
        }
        fs::write(repo.0.join("untracked.txt"), "keep").unwrap();
        let state = snapshot(&repo.0).await.unwrap();
        assert!(switch(&repo.0, "feature", &state).await.is_err());
        fs::remove_file(repo.0.join("untracked.txt")).unwrap();
        fs::create_dir(repo.0.join("nested")).unwrap();
        let nested = snapshot(&repo.0.join("nested")).await.unwrap();
        assert!(!nested.can_switch);
        assert!(switch(&repo.0.join("nested"), "feature", &nested)
            .await
            .is_err());
    }
}
