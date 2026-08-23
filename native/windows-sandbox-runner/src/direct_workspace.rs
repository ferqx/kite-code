//! Persistent capability-SID ACL state for the unelevated direct-workspace backend.
//!
//! The direct backend deliberately keeps its Workspace capability ACL across
//! invocations: removing and re-adding an inheritable root ACE per command is
//! slow and is unsafe when commands overlap or the runner crashes.  A small
//! user-owned ledger records the random capability SID and every protected-path
//! DACL snapshot before it is changed, so a later explicit repair can restore
//! the original ACLs without guessing.

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, WAIT_ABANDONED, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows::Win32::Storage::FileSystem::{
    MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
};
use windows::Win32::System::Threading::{CreateMutexW, ReleaseMutex, WaitForSingleObject};

use crate::acl;
use crate::job::{GENERIC_ALL, RUNTIME_ALLOW, WORKSPACE_ALLOW};
use crate::protocol::FilesystemScope;
use crate::restricted_token::CapabilitySid;
use crate::sha256_hex;

const LEDGER_VERSION: u32 = 2;
const MUTEX_WAIT_MS: u32 = 30_000;
const STATE_DIR_ENV: &str = "KITE_WINDOWS_RESTRICTED_TOKEN_STATE_DIR";

#[derive(Debug)]
pub struct DirectWorkspaceError {
    pub code: &'static str,
    pub message: String,
}

impl std::fmt::Display for DirectWorkspaceError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for DirectWorkspaceError {}

type Result<T> = std::result::Result<T, DirectWorkspaceError>;

fn error(code: &'static str, message: impl Into<String>) -> DirectWorkspaceError {
    DirectWorkspaceError {
        code,
        message: message.into(),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredDaclSnapshot {
    path: String,
    descriptor_base64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceCapabilityLedger {
    version: u32,
    workspace_root: String,
    capability_sid: String,
    #[serde(default)]
    protected_dacl_snapshots: Vec<StoredDaclSnapshot>,
    #[serde(default)]
    protected_paths_digest: String,
    #[serde(default)]
    setup_complete: bool,
}

/// The live ACL capability set for one invocation.  `finish()` must run after
/// the Job is empty; persistent Workspace grants intentionally remain, while
/// the invocation-private runtime grant is always removed.
pub struct DirectWorkspaceSecurity {
    capabilities: Vec<CapabilitySid>,
    workspace_root: String,
    runtime_root: String,
    runtime_capability_index: usize,
    ephemeral_workspace_capability_index: Option<usize>,
    ephemeral_snapshots: Vec<acl::DaclSnapshot>,
    approved_filesystem_guard_index: Option<usize>,
    approved_filesystem_guard_paths: Vec<String>,
}

impl DirectWorkspaceSecurity {
    pub fn capabilities(&self) -> &[CapabilitySid] {
        &self.capabilities
    }

    pub fn approved_filesystem_guard(&self) -> Option<&CapabilitySid> {
        self.approved_filesystem_guard_index
            .and_then(|index| self.capabilities.get(index))
    }

    /// Remove every per-invocation ACL grant.  The normal workspace capability
    /// is persistent by design; only the temporary probe capability is revoked.
    pub fn finish(&self) -> Result<()> {
        let mut failures = Vec::new();
        let runtime_capability = &self.capabilities[self.runtime_capability_index];
        if let Err(err) = acl::revoke_access(&self.runtime_root, runtime_capability.as_psid()) {
            failures.push(err.to_string());
        }
        if let Some(index) = self.ephemeral_workspace_capability_index {
            for snapshot in self.ephemeral_snapshots.iter().rev() {
                if let Err(err) = acl::restore_dacl_snapshot(snapshot) {
                    failures.push(err.to_string());
                }
            }
            if let Err(err) =
                acl::revoke_access(&self.workspace_root, self.capabilities[index].as_psid())
            {
                failures.push(err.to_string());
            }
        }
        if let Some(index) = self.approved_filesystem_guard_index {
            for path in self.approved_filesystem_guard_paths.iter().rev() {
                if let Err(err) = acl::revoke_access(path, self.capabilities[index].as_psid()) {
                    failures.push(err.to_string());
                }
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(error(
                "restricted_token_acl_cleanup_failed",
                failures.join("; "),
            ))
        }
    }
}

/// Prepare the ACL capabilities used by a restricted token.
///
/// In normal execution `ephemeral_workspace_capability_sid` is `None`: a
/// capability SID is loaded/created per canonical Workspace and its root grant
/// remains in place.  Startup probes pass an explicit temporary SID, which is
/// fully removed by [`DirectWorkspaceSecurity::finish`].
pub fn prepare_direct_workspace(
    workspace_root: &str,
    runtime_root: &str,
    filesystem_scope: FilesystemScope,
    runtime_capability_sid: &str,
    ephemeral_workspace_capability_sid: Option<&str>,
    approved_filesystem_guard_sid: Option<&str>,
    enforce_approved_filesystem_guard: bool,
    protected_paths: &[String],
) -> Result<DirectWorkspaceSecurity> {
    let workspace_root = canonical_directory(workspace_root, "workspace")?;
    let runtime_root = canonical_directory(runtime_root, "runtime")?;
    if path_equal(&workspace_root, &runtime_root) || is_child_path(&workspace_root, &runtime_root) {
        return Err(error(
            "restricted_token_workspace_invalid",
            "runtime root must be outside the Workspace",
        ));
    }
    let rollback_runtime_root = runtime_root.clone();
    let runtime_capability = CapabilitySid::parse(runtime_capability_sid).map_err(|source| {
        error(
            "restricted_token_runtime_capability_invalid",
            source.to_string(),
        )
    })?;

    // The runtime ACL must be removed after every invocation.  If later setup
    // fails, best-effort rollback below prevents a unique capability ACE from
    // accumulating in the temp directory.
    acl::grant_access(&runtime_root, runtime_capability.as_psid(), RUNTIME_ALLOW)
        .map_err(|source| error("restricted_token_acl_grant_failed", source.to_string()))?;

    let prepared = (|| -> Result<DirectWorkspaceSecurity> {
        let mut capabilities = Vec::new();
        let mut ephemeral_workspace_capability_index = None;
        let mut ephemeral_snapshots = Vec::new();
        let mut approved_filesystem_guard_index = None;
        let mut approved_filesystem_guard_paths: Vec<String> = Vec::new();

        if matches!(filesystem_scope, FilesystemScope::WorkspaceWrite) {
            if let Some(ephemeral_sid) = ephemeral_workspace_capability_sid {
                let workspace_capability =
                    CapabilitySid::parse(ephemeral_sid).map_err(|source| {
                        error(
                            "restricted_token_workspace_capability_invalid",
                            source.to_string(),
                        )
                    })?;
                acl::grant_access(
                    &workspace_root,
                    workspace_capability.as_psid(),
                    WORKSPACE_ALLOW,
                )
                .map_err(|source| error("restricted_token_acl_grant_failed", source.to_string()))?;
                for path in existing_workspace_protected_paths(&workspace_root, protected_paths) {
                    let snapshot = acl::snapshot_dacl(&path).map_err(|source| {
                        error("restricted_token_acl_snapshot_failed", source.to_string())
                    })?;
                    acl::deny_access(&path, workspace_capability.as_psid(), 0).map_err(
                        |source| error("restricted_token_acl_protect_failed", source.to_string()),
                    )?;
                    ephemeral_snapshots.push(snapshot);
                }
                ephemeral_workspace_capability_index = Some(capabilities.len());
                capabilities.push(workspace_capability);
            } else {
                let workspace_capability =
                    ensure_persistent_workspace_capability(&workspace_root, protected_paths)?;
                capabilities.push(workspace_capability);
            }
        }

        // An approved-network invocation runs under the interactive user's
        // primary token so Schannel can access that user's credential store.
        // That token cannot carry the synthetic guard SID, so writing a guard
        // ACE would neither constrain the child nor be safe as a filesystem
        // boundary. Skip the lease entirely instead of rewriting every
        // protected profile path for no effect.
        if matches!(filesystem_scope, FilesystemScope::FullAccess)
            && enforce_approved_filesystem_guard
        {
            let guard_sid = approved_filesystem_guard_sid.ok_or_else(|| {
                error(
                    "restricted_token_protected_guard_invalid",
                    "full_access requires an invocation protected-path guard SID",
                )
            })?;
            let guard = CapabilitySid::parse(guard_sid).map_err(|source| {
                error(
                    "restricted_token_protected_guard_invalid",
                    source.to_string(),
                )
            })?;
            for path in existing_protected_paths(protected_paths) {
                if let Err(source) = acl::deny_identity_access(&path, guard.as_psid(), GENERIC_ALL)
                {
                    for guarded_path in approved_filesystem_guard_paths.iter().rev() {
                        let _ = acl::revoke_access(guarded_path, guard.as_psid());
                    }
                    return Err(error(
                        "restricted_token_acl_protect_failed",
                        source.to_string(),
                    ));
                }
                approved_filesystem_guard_paths.push(path);
            }
            approved_filesystem_guard_index = Some(capabilities.len());
            capabilities.push(guard);
        }

        let runtime_capability_index = capabilities.len();
        capabilities.push(runtime_capability);
        Ok(DirectWorkspaceSecurity {
            capabilities,
            workspace_root,
            runtime_root,
            runtime_capability_index,
            ephemeral_workspace_capability_index,
            ephemeral_snapshots,
            approved_filesystem_guard_index,
            approved_filesystem_guard_paths,
        })
    })();

    if prepared.is_err() {
        if let Ok(runtime_capability) = CapabilitySid::parse(runtime_capability_sid) {
            let _ = acl::revoke_access(&rollback_runtime_root, runtime_capability.as_psid());
        }
    }
    prepared
}

/// Explicit repair/uninstall primitive.  It is intentionally not run as an
/// ordinary command cleanup because persistent ACLs are the normal direct
/// backend state.  Recovery restores protected-path snapshots before removing
/// the Workspace root capability ACE and ledger.
pub fn repair_persistent_workspace_capability(workspace_root: &str) -> Result<bool> {
    let workspace_root = canonical_directory(workspace_root, "workspace")?;
    with_workspace_lock(&workspace_root, || {
        let path = ledger_path(&workspace_root)?;
        if !path.exists() {
            return Ok(false);
        }
        let ledger = load_ledger(&path, &workspace_root)?;
        let capability = CapabilitySid::parse(&ledger.capability_sid)
            .map_err(|source| error("restricted_token_ledger_invalid", source.to_string()))?;
        let mut failures = Vec::new();
        for stored in ledger.protected_dacl_snapshots.iter().rev() {
            if !is_workspace_member_path(&workspace_root, &stored.path) {
                return Err(error(
                    "restricted_token_ledger_invalid",
                    "stored protected path is outside the Workspace",
                ));
            }
            let snapshot = decode_snapshot(stored)?;
            if Path::new(&snapshot.path).exists() {
                if let Err(source) = acl::restore_dacl_snapshot(&snapshot) {
                    failures.push(source.to_string());
                }
            }
        }
        if let Err(source) = acl::revoke_access(&workspace_root, capability.as_psid()) {
            failures.push(source.to_string());
        }
        if !failures.is_empty() {
            return Err(error(
                "restricted_token_acl_repair_failed",
                failures.join("; "),
            ));
        }
        fs::remove_file(&path)
            .map_err(|source| error("restricted_token_ledger_remove_failed", source.to_string()))?;
        Ok(true)
    })
}

fn ensure_persistent_workspace_capability(
    workspace_root: &str,
    protected_paths: &[String],
) -> Result<CapabilitySid> {
    with_workspace_lock(workspace_root, || {
        let path = ledger_path(workspace_root)?;
        // A Workspace capability has no allow ACE outside this Workspace, so
        // external protected paths are already unavailable in its restricted
        // write pass. Never mutate or persist those paths in a per-Workspace
        // ledger: repair intentionally refuses to trust out-of-scope targets.
        let existing_paths = existing_workspace_protected_paths(workspace_root, protected_paths);
        let paths_digest = protected_paths_digest(&existing_paths);
        let mut ledger = if path.exists() {
            load_ledger(&path, workspace_root)?
        } else {
            let capability = CapabilitySid::generate().map_err(|source| {
                error(
                    "restricted_token_capability_create_failed",
                    source.to_string(),
                )
            })?;
            let ledger = WorkspaceCapabilityLedger {
                version: LEDGER_VERSION,
                workspace_root: workspace_root.to_string(),
                capability_sid: capability.to_string(),
                protected_dacl_snapshots: Vec::new(),
                protected_paths_digest: paths_digest.clone(),
                setup_complete: false,
            };
            // Persist the intended capability before mutating the DACL.  A
            // crash after this point is recovered by idempotently applying the
            // same grant on the next prepare rather than inventing a new SID.
            write_ledger(&path, &ledger)?;
            ledger
        };
        let setup_matches = ledger_setup_matches(&ledger, &paths_digest);
        if !setup_matches {
            // Persist an incomplete marker before any ACL mutation. A crash leaves
            // the next invocation with an unambiguous instruction to revalidate
            // and finish setup under the same per-Workspace mutex.
            ledger.version = LEDGER_VERSION;
            ledger.protected_paths_digest = paths_digest.clone();
            ledger.setup_complete = false;
            write_ledger(&path, &ledger)?;
        }

        let capability = CapabilitySid::parse(&ledger.capability_sid)
            .map_err(|source| error("restricted_token_ledger_invalid", source.to_string()))?;
        let workspace_grant_present = acl::has_ace_for_sid(
            workspace_root,
            capability.as_psid(),
            acl::ACCESS_ALLOWED_ACE_TYPE,
        )
        .map_err(|source| error("restricted_token_acl_grant_failed", source.to_string()))?;
        if !workspace_grant_present {
            ledger.setup_complete = false;
            write_ledger(&path, &ledger)?;
            acl::grant_access(workspace_root, capability.as_psid(), WORKSPACE_ALLOW)
                .map_err(|source| error("restricted_token_acl_grant_failed", source.to_string()))?;
        }

        for protected_path in existing_paths {
            let deny_present = acl::has_ace_for_sid(
                &protected_path,
                capability.as_psid(),
                acl::ACCESS_DENIED_ACE_TYPE,
            )
            .map_err(|source| error("restricted_token_acl_protect_failed", source.to_string()))?;
            if !deny_present {
                let snapshot = acl::snapshot_dacl(&protected_path).map_err(|source| {
                    error("restricted_token_acl_snapshot_failed", source.to_string())
                })?;
                let stored = encode_snapshot(&snapshot);
                if let Some(existing) = ledger
                    .protected_dacl_snapshots
                    .iter_mut()
                    .find(|existing| path_equal(&existing.path, &protected_path))
                {
                    *existing = stored;
                } else {
                    ledger.protected_dacl_snapshots.push(stored);
                }
                // The snapshot must be durable before the DACL changes, so an
                // interrupted setup or a host-side atomic file replacement can
                // be repaired without applying a stale object's descriptor.
                ledger.setup_complete = false;
                write_ledger(&path, &ledger)?;
                acl::deny_access(&protected_path, capability.as_psid(), 0).map_err(|source| {
                    error("restricted_token_acl_protect_failed", source.to_string())
                })?;
            }
        }
        if !ledger.setup_complete {
            ledger.setup_complete = true;
            write_ledger(&path, &ledger)?;
        }
        Ok(capability)
    })
}

fn ledger_setup_matches(ledger: &WorkspaceCapabilityLedger, paths_digest: &str) -> bool {
    ledger.version == LEDGER_VERSION
        && ledger.setup_complete
        && ledger.protected_paths_digest == paths_digest
}

fn protected_paths_digest(paths: &[String]) -> String {
    let canonical = paths
        .iter()
        .map(|path| path.to_ascii_lowercase())
        .collect::<Vec<_>>()
        .join("\0");
    sha256_hex(canonical.as_bytes())
}

fn existing_protected_paths(paths: &[String]) -> Vec<String> {
    let mut result = paths
        .iter()
        .filter(|path| Path::new(path).exists())
        .map(|path| path.trim_end_matches(['\\', '/']).to_string())
        .collect::<Vec<_>>();
    result.sort_by_key(|left| left.to_ascii_lowercase());
    result.dedup_by(|left, right| path_equal(left, right));
    result
}

fn existing_workspace_protected_paths(workspace_root: &str, paths: &[String]) -> Vec<String> {
    workspace_member_protected_paths(workspace_root, existing_protected_paths(paths))
}

fn workspace_member_protected_paths(workspace_root: &str, paths: Vec<String>) -> Vec<String> {
    paths
        .into_iter()
        .filter(|path| is_workspace_member_path(workspace_root, path))
        .collect()
}

fn canonical_directory(value: &str, kind: &'static str) -> Result<String> {
    let path = Path::new(value);
    let metadata = fs::metadata(path)
        .map_err(|source| error("restricted_token_path_invalid", format!("{kind}: {source}")))?;
    if !metadata.is_dir() {
        return Err(error(
            "restricted_token_path_invalid",
            format!("{kind} root is not a directory"),
        ));
    }
    fs::canonicalize(path)
        .map_err(|source| error("restricted_token_path_invalid", format!("{kind}: {source}")))
        .map(|path| path.to_string_lossy().to_string())
}

fn path_equal(left: &str, right: &str) -> bool {
    normalized_windows_path(left).eq_ignore_ascii_case(normalized_windows_path(right))
}

fn is_workspace_member_path(workspace_root: &str, candidate: &str) -> bool {
    if !path_equal(workspace_root, candidate) && !is_child_path(workspace_root, candidate) {
        return false;
    }
    let path = Path::new(candidate);
    if !path.exists() {
        return true;
    }
    match fs::canonicalize(path) {
        Ok(canonical) => {
            let canonical = canonical.to_string_lossy();
            path_equal(workspace_root, &canonical) || is_child_path(workspace_root, &canonical)
        }
        Err(_) => false,
    }
}

fn is_child_path(parent: &str, child: &str) -> bool {
    let parent = normalized_windows_path(parent).trim_end_matches(['\\', '/']);
    let child = normalized_windows_path(child).trim_end_matches(['\\', '/']);
    child.len() > parent.len()
        && child[..parent.len()].eq_ignore_ascii_case(parent)
        && child
            .as_bytes()
            .get(parent.len())
            .is_some_and(|byte| *byte == b'\\' || *byte == b'/')
}

fn normalized_windows_path(path: &str) -> &str {
    path.strip_prefix(r"\\?\").unwrap_or(path)
}

fn store_root() -> Result<PathBuf> {
    if let Some(explicit) = std::env::var_os(STATE_DIR_ENV) {
        let root = PathBuf::from(explicit);
        fs::create_dir_all(&root).map_err(|source| {
            error(
                "restricted_token_ledger_unavailable",
                format!("cannot create {}: {source}", root.display()),
            )
        })?;
        return Ok(root);
    }
    let base = std::env::var_os("LOCALAPPDATA").ok_or_else(|| {
        error(
            "restricted_token_ledger_unavailable",
            "LOCALAPPDATA is unavailable",
        )
    })?;
    Ok(PathBuf::from(base)
        .join("Kite Code")
        .join("sandbox")
        .join("restricted-token"))
}

fn ledger_path(workspace_root: &str) -> Result<PathBuf> {
    let key = sha256_hex(workspace_root.to_ascii_lowercase().as_bytes());
    Ok(store_root()?.join(format!("{key}.json")))
}

fn load_ledger(path: &Path, workspace_root: &str) -> Result<WorkspaceCapabilityLedger> {
    let text = fs::read_to_string(path)
        .map_err(|source| error("restricted_token_ledger_read_failed", source.to_string()))?;
    let ledger: WorkspaceCapabilityLedger = serde_json::from_str(&text)
        .map_err(|source| error("restricted_token_ledger_invalid", source.to_string()))?;
    if ledger.version != LEDGER_VERSION || !path_equal(&ledger.workspace_root, workspace_root) {
        return Err(error(
            "restricted_token_ledger_invalid",
            "ledger version or Workspace identity does not match",
        ));
    }
    Ok(ledger)
}

fn write_ledger(path: &Path, ledger: &WorkspaceCapabilityLedger) -> Result<()> {
    let parent = path.parent().ok_or_else(|| {
        error(
            "restricted_token_ledger_write_failed",
            "ledger has no parent",
        )
    })?;
    fs::create_dir_all(parent)
        .map_err(|source| error("restricted_token_ledger_write_failed", source.to_string()))?;
    let temp = path.with_extension(format!("tmp-{}", std::process::id()));
    // A prior process can crash after creating this PID-named temporary file.
    // The per-Workspace mutex makes removing that stale leaf safe; a directory
    // or other unexpected object fails closed instead of being removed.
    if temp.exists() {
        fs::remove_file(&temp)
            .map_err(|source| error("restricted_token_ledger_write_failed", source.to_string()))?;
    }
    let bytes = serde_json::to_vec(ledger)
        .map_err(|source| error("restricted_token_ledger_write_failed", source.to_string()))?;
    let result = (|| -> Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|source| error("restricted_token_ledger_write_failed", source.to_string()))?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|source| error("restricted_token_ledger_write_failed", source.to_string()))?;
        let source = wide_path(&temp)?;
        let destination = wide_path(path)?;
        unsafe {
            MoveFileExW(
                PCWSTR(source.as_ptr()),
                PCWSTR(destination.as_ptr()),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
            .map_err(|source| error("restricted_token_ledger_write_failed", source.to_string()))?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn encode_snapshot(snapshot: &acl::DaclSnapshot) -> StoredDaclSnapshot {
    StoredDaclSnapshot {
        path: snapshot.path.clone(),
        descriptor_base64: base64::engine::general_purpose::STANDARD.encode(&snapshot.descriptor),
    }
}

fn decode_snapshot(snapshot: &StoredDaclSnapshot) -> Result<acl::DaclSnapshot> {
    let descriptor = base64::engine::general_purpose::STANDARD
        .decode(&snapshot.descriptor_base64)
        .map_err(|source| error("restricted_token_ledger_invalid", source.to_string()))?;
    if descriptor.is_empty() {
        return Err(error(
            "restricted_token_ledger_invalid",
            "stored ACL descriptor is empty",
        ));
    }
    Ok(acl::DaclSnapshot {
        path: snapshot.path.clone(),
        descriptor,
    })
}

fn wide_path(path: &Path) -> Result<Vec<u16>> {
    let value = path.to_string_lossy();
    if value.encode_utf16().any(|unit| unit == 0) {
        return Err(error(
            "restricted_token_ledger_write_failed",
            "path contains NUL",
        ));
    }
    Ok(value.encode_utf16().chain(std::iter::once(0)).collect())
}

fn with_workspace_lock<T>(workspace_root: &str, action: impl FnOnce() -> Result<T>) -> Result<T> {
    let name = format!(
        "Local\\KiteCode.RestrictedToken.{}",
        sha256_hex(workspace_root.to_ascii_lowercase().as_bytes())
    );
    let name = wide_path(Path::new(&name))?;
    let mutex = unsafe {
        CreateMutexW(None, false, PCWSTR(name.as_ptr()))
            .map_err(|source| error("restricted_token_ledger_lock_failed", source.to_string()))?
    };
    let wait = unsafe { WaitForSingleObject(mutex, MUTEX_WAIT_MS) };
    if wait != WAIT_OBJECT_0 && wait != WAIT_ABANDONED {
        unsafe {
            let _ = CloseHandle(mutex);
        }
        let code = if wait == WAIT_TIMEOUT {
            "restricted_token_ledger_lock_timeout"
        } else {
            "restricted_token_ledger_lock_failed"
        };
        return Err(error(code, "workspace capability ledger is busy"));
    }
    let result = action();
    unsafe {
        let _ = ReleaseMutex(mutex);
        let _ = CloseHandle(mutex);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::thread;
    use std::time::{Duration, Instant};

    #[test]
    fn path_child_check_is_segment_aware() {
        assert!(is_child_path("C:\\Work", "C:\\Work\\runtime"));
        assert!(is_child_path(r"\\?\C:\Work", r"C:\Work\runtime"));
        assert!(path_equal(r"\\?\C:\Work", r"C:\Work"));
        assert!(!is_child_path("C:\\Work", "C:\\Workspace"));
        assert!(!is_child_path("C:\\Work", "C:\\Work"));
    }

    #[test]
    fn persistent_protected_paths_never_escape_the_workspace() {
        let paths = vec![
            "C:\\Work\\.env".to_string(),
            "C:\\Users\\runneradmin\\.npmrc".to_string(),
        ];
        assert_eq!(
            workspace_member_protected_paths("C:\\Work", paths),
            vec!["C:\\Work\\.env".to_string()]
        );
    }

    #[test]
    fn snapshots_round_trip_without_losing_bytes() {
        let snapshot = acl::DaclSnapshot {
            path: "C:\\Work\\.env".to_string(),
            descriptor: vec![0, 1, 2, 255],
        };
        let decoded = decode_snapshot(&encode_snapshot(&snapshot)).expect("round trip");
        assert_eq!(decoded.path, snapshot.path);
        assert_eq!(decoded.descriptor, snapshot.descriptor);
    }

    #[test]
    fn only_a_complete_current_ledger_has_a_matching_setup_marker() {
        let digest =
            protected_paths_digest(&["C:\\Work\\.git".to_string(), "C:\\Work\\.env".to_string()]);
        let mut ledger = WorkspaceCapabilityLedger {
            version: LEDGER_VERSION,
            workspace_root: "C:\\Work".to_string(),
            capability_sid: "S-1-15-3-1".to_string(),
            protected_dacl_snapshots: Vec::new(),
            protected_paths_digest: digest.clone(),
            setup_complete: true,
        };

        assert!(ledger_setup_matches(&ledger, &digest));
        ledger.setup_complete = false;
        assert!(!ledger_setup_matches(&ledger, &digest));
        ledger.setup_complete = true;
        ledger.version = 0;
        assert!(!ledger_setup_matches(&ledger, &digest));
        ledger.version = LEDGER_VERSION;
        assert!(!ledger_setup_matches(&ledger, "different"));
    }

    #[test]
    fn protected_path_digest_is_case_insensitive_but_order_sensitive() {
        let first =
            protected_paths_digest(&["C:\\Work\\.env".to_string(), "C:\\Work\\.git".to_string()]);
        let same_case_folded =
            protected_paths_digest(&["c:\\work\\.ENV".to_string(), "c:\\work\\.GIT".to_string()]);
        let reversed =
            protected_paths_digest(&["C:\\Work\\.git".to_string(), "C:\\Work\\.env".to_string()]);

        assert_eq!(first, same_case_folded);
        assert_ne!(first, reversed);
    }

    #[test]
    fn overlapping_workspace_setup_waits_for_the_current_ledger_writer() {
        let workspace = format!(
            "C:\\KiteCodeLockTest\\{}-{:?}",
            std::process::id(),
            thread::current().id()
        );
        let holder_workspace = workspace.clone();
        let (acquired_sender, acquired_receiver) = mpsc::channel();
        let holder = thread::spawn(move || {
            with_workspace_lock(&holder_workspace, || {
                acquired_sender.send(()).expect("signal lock acquisition");
                thread::sleep(Duration::from_millis(2_500));
                Ok(())
            })
            .expect("holder lock");
        });
        acquired_receiver.recv().expect("holder acquired lock");
        let started = Instant::now();
        with_workspace_lock(&workspace, || Ok(())).expect("waiter lock");
        assert!(started.elapsed() >= Duration::from_millis(2_000));
        holder.join().expect("holder thread");
    }
}
