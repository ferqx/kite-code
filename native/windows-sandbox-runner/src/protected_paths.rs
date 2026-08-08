use crate::protocol::InvocationRequest;

/// Protected paths relative to the Workspace root, resolved to full paths.
pub fn protected_deny_paths(request: &InvocationRequest) -> Vec<String> {
    const PROTECTED_DIRECTORIES: &[&str] = &[
        ".git",
        ".ssh",
        ".aws",
        ".docker",
        ".gnupg",
        ".kube",
        ".direnv",
        ".agents",
        ".claude",
        ".codex",
        ".kite-code",
        ".openpx",
        ".vscode",
        ".idea",
        ".config/fish",
        ".config/gh",
        ".config/gcloud",
        ".config/openpx",
        ".config/mcp",
        ".config/systemd/user",
        ".config/autostart",
        "Library/LaunchAgents",
        "Library/LaunchDaemons",
    ];
    const PROTECTED_FILES: &[&str] = &[
        ".bashrc",
        ".bash_profile",
        ".bash_logout",
        ".zshrc",
        ".zprofile",
        ".zlogout",
        ".profile",
        ".cshrc",
        ".tcshrc",
        ".kshrc",
        ".envrc",
        ".npmrc",
        ".yarnrc",
        ".pypirc",
        ".netrc",
        ".git-credentials",
        ".gitmodules",
        ".env",
        ".env.local",
        ".env.production",
        ".mcp.json",
        "mcp.json",
    ];
    let workspace = request
        .workspace_root
        .trim_end_matches('\\')
        .trim_end_matches('/');
    let mut paths = Vec::new();
    for directory in PROTECTED_DIRECTORIES {
        paths.push(format!("{workspace}\\{directory}"));
        paths.push(format!("{workspace}\\{directory}\\"));
    }
    for file in PROTECTED_FILES {
        paths.push(format!("{workspace}\\{file}"));
    }
    if let Ok(entries) = std::fs::read_dir(workspace) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if is_dynamic_dotenv_name(&name) {
                paths.push(entry.path().to_string_lossy().to_string());
            }
        }
    }
    paths.sort();
    paths.dedup();
    paths
}

pub fn is_dynamic_dotenv_name(name: &str) -> bool {
    name.len() > 5
        && name
            .get(..5)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case(".env."))
}
