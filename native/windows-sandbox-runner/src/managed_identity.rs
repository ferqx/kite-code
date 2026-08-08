//! Codex-style one-time provisioning for the Windows managed network identity.
//!
//! Provisioning is an explicit control-plane action, never part of a Shell
//! invocation. The elevated helper creates or refreshes the dedicated local
//! account, protects its password with machine-scope DPAPI, locks the state
//! directory to the initiating user plus Administrators/SYSTEM, and commits a
//! readiness marker last. Normal commands only consume a complete setup.

use crate::acl;
use crate::job::{GENERIC_EXECUTE, GENERIC_READ};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::ffi::c_void;
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{
    CloseHandle, GetLastError, LocalFree, ERROR_INSUFFICIENT_BUFFER, HANDLE, HLOCAL,
    WAIT_ABANDONED, WAIT_FAILED, WAIT_OBJECT_0,
};
use windows::Win32::NetworkManagement::NetManagement::{
    NERR_Success, NERR_UserExists, NetLocalGroupAddMembers, NetUserAdd, NetUserSetInfo,
    LOCALGROUP_MEMBERS_INFO_3, UF_DONT_EXPIRE_PASSWD, UF_SCRIPT, USER_INFO_1, USER_INFO_1003,
    USER_PRIV_USER,
};
use windows::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
    ConvertStringSidToSidW, SDDL_REVISION_1,
};
use windows::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPTPROTECT_LOCAL_MACHINE, CRYPTPROTECT_UI_FORBIDDEN,
    CRYPT_INTEGER_BLOB,
};
use windows::Win32::Security::{
    CheckTokenMembership, DuplicateToken, GetTokenInformation, IsValidSid, LogonUserW,
    LookupAccountNameW, LookupAccountSidW, SecurityIdentification, SetFileSecurityW, TokenUser,
    DACL_SECURITY_INFORMATION, LOGON32_LOGON_INTERACTIVE, LOGON32_PROVIDER_DEFAULT,
    PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SID_NAME_USE, TOKEN_QUERY,
    TOKEN_USER,
};
use windows::Win32::Storage::FileSystem::{
    MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
};
use windows::Win32::System::Threading::{
    CreateMutexW, GetCurrentProcess, GetExitCodeProcess, OpenProcessToken, ReleaseMutex,
    WaitForSingleObject, INFINITE,
};
use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;

const STATE_VERSION: u32 = 3;
const SETUP_PAYLOAD_VERSION: u32 = 2;
const STATUS_VERSION: u32 = 1;
const ONLINE_USERNAME: &str = "KiteSandboxOnline";
const BUILTIN_USERS_SID: &str = "S-1-5-32-545";
const BUILTIN_ADMINISTRATORS_SID: &str = "S-1-5-32-544";
const INSTALL_ARGUMENT: &str = "--install-managed-network";
const SETUP_PAYLOAD_PREFIX: &str = "--setup-payload=";
const STATE_FILENAME: &str = "online.json";
const MARKER_FILENAME: &str = "setup-marker.json";
const ERROR_FILENAME: &str = "setup-error.json";
const FILE_ATTRIBUTE_REPARSE_POINT_VALUE: u32 = 0x0000_0400;
const SETUP_MUTEX_NAME: &str = "Global\\KiteCodeManagedNetworkSetupV1";
const USERPROFILE_ROOT_EXCLUSIONS: &[&str] = &[
    ".ssh",
    ".tsh",
    ".brev",
    ".gnupg",
    ".aws",
    ".azure",
    ".kube",
    ".docker",
    ".config",
    ".npm",
    ".pki",
    ".terraform.d",
];

#[derive(Debug)]
pub struct ManagedIdentityError {
    pub code: &'static str,
    pub message: String,
}

impl std::fmt::Display for ManagedIdentityError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ManagedIdentityError {}

type Result<T> = std::result::Result<T, ManagedIdentityError>;

fn error(code: &'static str, message: impl Into<String>) -> ManagedIdentityError {
    ManagedIdentityError {
        code,
        message: message.into(),
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedOnlineCredentials {
    pub username: String,
    pub password: String,
    pub sid: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagedIdentityState {
    version: u32,
    username: String,
    sid: String,
    protected_password: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagedSetupMarker {
    version: u32,
    username: String,
    sid: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagedSetupPayload {
    version: u32,
    state_root: PathBuf,
    owner_sid: String,
    read_roots: Vec<PathBuf>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagedSetupErrorReport {
    code: String,
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedSetupStatus {
    pub version: u32,
    pub state: &'static str,
    pub reason: &'static str,
}

fn wide(value: impl AsRef<std::ffi::OsStr>) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    value
        .as_ref()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

fn state_root() -> Result<PathBuf> {
    let local_app_data = std::env::var_os("LOCALAPPDATA").ok_or_else(|| {
        error(
            "managed_network_state_unavailable",
            "LOCALAPPDATA is unavailable",
        )
    })?;
    Ok(PathBuf::from(local_app_data)
        .join("kite-code")
        .join("managed-network"))
}

pub fn runner_state_root() -> Result<PathBuf> {
    let root = state_root()?
        .parent()
        .expect("managed-network has a parent")
        .join("managed-runner-state");
    std::fs::create_dir_all(&root).map_err(|source| {
        error(
            "managed_network_state_unavailable",
            format!("cannot create {}: {source}", root.display()),
        )
    })?;
    Ok(root)
}

fn state_path_for(root: &Path) -> PathBuf {
    root.join(STATE_FILENAME)
}

fn marker_path_for(root: &Path) -> PathBuf {
    root.join(MARKER_FILENAME)
}

fn error_path_for(root: &Path) -> PathBuf {
    root.join(ERROR_FILENAME)
}

fn state_path() -> Result<PathBuf> {
    Ok(state_path_for(&state_root()?))
}

fn marker_path() -> Result<PathBuf> {
    Ok(marker_path_for(&state_root()?))
}

pub fn managed_setup_status() -> ManagedSetupStatus {
    match load_validated_identity() {
        Ok(Some(_)) => ManagedSetupStatus {
            version: STATUS_VERSION,
            state: "ready",
            reason: "managed_network_ready",
        },
        Ok(None) => ManagedSetupStatus {
            version: STATUS_VERSION,
            state: "missing",
            reason: "managed_network_setup_required",
        },
        Err(_) => ManagedSetupStatus {
            version: STATUS_VERSION,
            state: "invalid",
            reason: "managed_network_setup_invalid",
        },
    }
}

/// Explicit setup command invoked by onboarding or an installer. It is the
/// only normal entry point allowed to display a Windows UAC prompt.
pub fn run_setup_orchestrator() -> Result<()> {
    if managed_setup_status().state == "ready" {
        return Ok(());
    }
    let root = state_root()?;
    std::fs::create_dir_all(&root).map_err(|source| {
        error(
            "managed_network_state_write_failed",
            format!("cannot create {}: {source}", root.display()),
        )
    })?;
    let _ = std::fs::remove_file(error_path_for(&root));
    let payload = ManagedSetupPayload {
        version: SETUP_PAYLOAD_VERSION,
        state_root: root.clone(),
        owner_sid: current_process_user_sid()?,
        read_roots: managed_read_roots()?,
    };
    run_elevated_installer(&payload)?;
    match load_validated_identity()? {
        Some(_) => Ok(()),
        None => Err(error(
            "managed_network_setup_incomplete",
            "elevated setup exited without a valid readiness marker",
        )),
    }
}

fn run_elevated_installer(payload: &ManagedSetupPayload) -> Result<()> {
    let executable = std::env::current_exe().map_err(|source| {
        error(
            "managed_network_setup_launch_failed",
            format!("cannot resolve runner executable: {source}"),
        )
    })?;
    let encoded = serde_json::to_vec(payload)
        .map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes))
        .map_err(|source| error("managed_network_setup_payload_invalid", source.to_string()))?;
    let arguments = format!(
        "{} {}",
        INSTALL_ARGUMENT,
        crate::quote_argument(&format!("{SETUP_PAYLOAD_PREFIX}{encoded}"))
    );
    let executable_w = wide(executable.as_os_str());
    let verb_w = wide("runas");
    let arguments_w = wide(arguments);
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS,
        lpVerb: PCWSTR(verb_w.as_ptr()),
        lpFile: PCWSTR(executable_w.as_ptr()),
        lpParameters: PCWSTR(arguments_w.as_ptr()),
        nShow: SW_HIDE.0,
        ..Default::default()
    };
    let exit_code = unsafe {
        ShellExecuteExW(&mut info).map_err(|source| {
            error(
                "managed_network_setup_cancelled",
                format!("elevated setup was not started: {source}"),
            )
        })?;
        if info.hProcess.is_invalid() {
            return Err(error(
                "managed_network_setup_launch_failed",
                "ShellExecuteExW returned no process handle",
            ));
        }
        let wait = WaitForSingleObject(info.hProcess, INFINITE);
        if wait == WAIT_FAILED {
            let _ = CloseHandle(info.hProcess);
            return Err(error(
                "managed_network_setup_launch_failed",
                format!("waiting for elevated setup failed: {wait:?}"),
            ));
        }
        let mut exit_code = 1u32;
        let result = GetExitCodeProcess(info.hProcess, &mut exit_code);
        let _ = CloseHandle(info.hProcess);
        result.map_err(|source| {
            error(
                "managed_network_setup_launch_failed",
                format!("cannot read elevated setup exit code: {source}"),
            )
        })?;
        exit_code
    };
    if exit_code == 0 {
        let _ = std::fs::remove_file(error_path_for(&payload.state_root));
        return Ok(());
    }
    if let Ok(bytes) = std::fs::read(error_path_for(&payload.state_root)) {
        if let Ok(report) = serde_json::from_slice::<ManagedSetupErrorReport>(&bytes) {
            return Err(error(
                "managed_network_setup_failed",
                format!("{}: {}", report.code, report.message),
            ));
        }
    }
    Err(error(
        "managed_network_setup_failed",
        format!("elevated setup exited with code {exit_code}"),
    ))
}

/// Elevated helper entry point. The setup payload contains no credentials;
/// credentials are generated, machine-protected, and persisted by this helper.
pub fn run_elevated_install(arguments: &[String]) -> Result<()> {
    if arguments.len() != 1 {
        return Err(error(
            "managed_network_setup_arguments_invalid",
            "elevated setup requires exactly one payload",
        ));
    }
    let encoded = argument_value(arguments, SETUP_PAYLOAD_PREFIX).ok_or_else(|| {
        error(
            "managed_network_setup_arguments_invalid",
            "missing or duplicate setup payload",
        )
    })?;
    let payload_bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|source| error("managed_network_setup_payload_invalid", source.to_string()))?;
    let payload: ManagedSetupPayload = serde_json::from_slice(&payload_bytes)
        .map_err(|source| error("managed_network_setup_payload_invalid", source.to_string()))?;
    validate_setup_payload(&payload)?;
    let _setup_lock = SetupLock::acquire()?;
    let result = install_online_identity(&payload);
    if let Err(source) = &result {
        let _ = write_setup_error(&payload, source);
    }
    result
}

struct SetupLock(HANDLE);

impl SetupLock {
    fn acquire() -> Result<Self> {
        let name = wide(SETUP_MUTEX_NAME);
        let mutex = unsafe { CreateMutexW(None, false, PCWSTR(name.as_ptr())) }
            .map_err(|source| error("managed_network_setup_lock_failed", source.to_string()))?;
        let wait = unsafe { WaitForSingleObject(mutex, 300_000) };
        if wait == WAIT_OBJECT_0 || wait == WAIT_ABANDONED {
            Ok(Self(mutex))
        } else {
            unsafe {
                let _ = CloseHandle(mutex);
            }
            Err(error(
                "managed_network_setup_lock_timeout",
                "another managed network setup is still running",
            ))
        }
    }
}

impl Drop for SetupLock {
    fn drop(&mut self) {
        unsafe {
            let _ = ReleaseMutex(self.0);
            let _ = CloseHandle(self.0);
        }
    }
}

fn validate_setup_payload(payload: &ManagedSetupPayload) -> Result<()> {
    if payload.version != SETUP_PAYLOAD_VERSION
        || !payload.state_root.is_absolute()
        || payload
            .state_root
            .file_name()
            .and_then(|name| name.to_str())
            != Some("managed-network")
        || payload
            .state_root
            .parent()
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            != Some("kite-code")
    {
        return Err(error(
            "managed_network_setup_payload_invalid",
            "setup target is not a Kite managed-network directory",
        ));
    }
    validate_sid_text(&payload.owner_sid)?;
    let user_profile = std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .ok_or_else(|| {
            error(
                "managed_network_setup_payload_invalid",
                "USERPROFILE is unavailable",
            )
        })?;
    for read_root in &payload.read_roots {
        if !read_root.is_absolute() || !read_root.starts_with(&user_profile) {
            return Err(error(
                "managed_network_setup_payload_invalid",
                format!("read root is outside USERPROFILE: {}", read_root.display()),
            ));
        }
        let metadata = std::fs::symlink_metadata(read_root).map_err(|source| {
            error(
                "managed_network_setup_payload_invalid",
                format!("cannot inspect read root {}: {source}", read_root.display()),
            )
        })?;
        if !metadata.is_dir()
            || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT_VALUE != 0
        {
            return Err(error(
                "managed_network_setup_payload_invalid",
                format!("read root {} must be a real directory", read_root.display()),
            ));
        }
    }
    for candidate in [
        payload.state_root.as_path(),
        payload.state_root.parent().expect("validated parent"),
    ] {
        let metadata = std::fs::symlink_metadata(candidate).map_err(|source| {
            error(
                "managed_network_setup_payload_invalid",
                format!(
                    "cannot inspect setup target {}: {source}",
                    candidate.display()
                ),
            )
        })?;
        if !metadata.is_dir()
            || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT_VALUE != 0
        {
            return Err(error(
                "managed_network_setup_payload_invalid",
                format!(
                    "setup target {} must be a real directory",
                    candidate.display()
                ),
            ));
        }
    }
    Ok(())
}

fn install_online_identity(payload: &ManagedSetupPayload) -> Result<()> {
    std::fs::create_dir_all(&payload.state_root).map_err(|source| {
        error(
            "managed_network_state_write_failed",
            format!("cannot create {}: {source}", payload.state_root.display()),
        )
    })?;
    apply_secure_state_dacl(&payload.state_root, &payload.owner_sid)?;
    // A setup in progress is never consumable. The marker is committed again
    // only after account rotation, DPAPI state, SID and logon validation finish.
    let _ = std::fs::remove_file(marker_path_for(&payload.state_root));
    let password = random_password()?;
    ensure_local_user(ONLINE_USERNAME, &password)?;
    ensure_builtin_users_membership(ONLINE_USERNAME)?;
    let sid = resolve_account_sid(ONLINE_USERNAME)?;
    validate_non_admin_logon(ONLINE_USERNAME, &password)?;
    grant_managed_read_roots(&payload.read_roots, &sid)?;
    let protected_password = protect_password_machine(password.as_bytes())?;
    let state = ManagedIdentityState {
        version: STATE_VERSION,
        username: ONLINE_USERNAME.to_string(),
        sid: sid.clone(),
        protected_password: base64::engine::general_purpose::STANDARD.encode(protected_password),
    };
    write_json_atomically(&state_path_for(&payload.state_root), &state)?;
    let marker = ManagedSetupMarker {
        version: STATE_VERSION,
        username: ONLINE_USERNAME.to_string(),
        sid,
    };
    // The marker is the commit record and must be written last.
    write_json_atomically(&marker_path_for(&payload.state_root), &marker)?;
    let _ = std::fs::remove_file(error_path_for(&payload.state_root));
    Ok(())
}

fn managed_read_roots() -> Result<Vec<PathBuf>> {
    let profile = std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .ok_or_else(|| {
            error(
                "managed_network_read_roots_unavailable",
                "USERPROFILE is unavailable",
            )
        })?;
    let entries = std::fs::read_dir(&profile).map_err(|source| {
        error(
            "managed_network_read_roots_unavailable",
            format!("cannot enumerate {}: {source}", profile.display()),
        )
    })?;
    let mut roots = entries
        .filter_map(std::result::Result::ok)
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            !USERPROFILE_ROOT_EXCLUSIONS
                .iter()
                .any(|excluded| name.eq_ignore_ascii_case(excluded))
        })
        .filter_map(|entry| {
            let metadata = std::fs::symlink_metadata(entry.path()).ok()?;
            (metadata.is_dir()
                && metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT_VALUE == 0)
                .then(|| entry.path())
        })
        .collect::<Vec<_>>();
    roots.sort_by_key(|path| path.to_string_lossy().to_ascii_lowercase());
    Ok(roots)
}

fn grant_managed_read_roots(read_roots: &[PathBuf], sid_text: &str) -> Result<()> {
    let sid_w = wide(sid_text);
    let mut sid = PSID::default();
    unsafe {
        ConvertStringSidToSidW(PCWSTR(sid_w.as_ptr()), &mut sid)
            .map_err(|source| error("managed_network_read_acl_failed", source.to_string()))?;
    }
    let result = read_roots.iter().try_for_each(|path| {
        acl::grant_access(&path.to_string_lossy(), sid, GENERIC_READ | GENERIC_EXECUTE)
            .map_err(|source| error("managed_network_read_acl_failed", source.to_string()))
    });
    unsafe {
        let _ = LocalFree(HLOCAL(sid.0));
    }
    result
}

fn write_setup_error(payload: &ManagedSetupPayload, source: &ManagedIdentityError) -> Result<()> {
    std::fs::create_dir_all(&payload.state_root).map_err(|error_source| {
        error(
            "managed_network_setup_error_write_failed",
            error_source.to_string(),
        )
    })?;
    let _ = apply_secure_state_dacl(&payload.state_root, &payload.owner_sid);
    write_json_atomically(
        &error_path_for(&payload.state_root),
        &ManagedSetupErrorReport {
            code: source.code.to_string(),
            message: source.message.clone(),
        },
    )
}

fn apply_secure_state_dacl(root: &Path, owner_sid: &str) -> Result<()> {
    validate_sid_text(owner_sid)?;
    let descriptor_text = wide(format!(
        "D:P(A;OICI;GA;;;SY)(A;OICI;GA;;;BA)(A;OICI;GA;;;{owner_sid})"
    ));
    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            PCWSTR(descriptor_text.as_ptr()),
            SDDL_REVISION_1,
            &mut descriptor,
            None,
        )
        .map_err(|source| error("managed_network_state_acl_failed", source.to_string()))?;
        let result = SetFileSecurityW(
            PCWSTR(wide(root.as_os_str()).as_ptr()),
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            descriptor,
        );
        let _ = LocalFree(HLOCAL(descriptor.0));
        result
            .ok()
            .map_err(|source| error("managed_network_state_acl_failed", source.to_string()))
    }
}

fn validate_sid_text(sid_text: &str) -> Result<()> {
    let sid_w = wide(sid_text);
    let mut sid = PSID::default();
    unsafe {
        ConvertStringSidToSidW(PCWSTR(sid_w.as_ptr()), &mut sid)
            .map_err(|source| error("managed_network_owner_sid_invalid", source.to_string()))?;
        let valid = IsValidSid(sid).as_bool();
        let _ = LocalFree(HLOCAL(sid.0));
        if valid {
            Ok(())
        } else {
            Err(error(
                "managed_network_owner_sid_invalid",
                "owner SID is invalid",
            ))
        }
    }
}

fn current_process_user_sid() -> Result<String> {
    let mut token = HANDLE::default();
    unsafe {
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token)
            .map_err(|source| error("managed_network_owner_lookup_failed", source.to_string()))?;
    }
    let mut bytes = 0u32;
    let _ = unsafe { GetTokenInformation(token, TokenUser, None, 0, &mut bytes) };
    if unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER || bytes == 0 {
        unsafe {
            let _ = CloseHandle(token);
        }
        return Err(error(
            "managed_network_owner_lookup_failed",
            "GetTokenInformation sizing failed",
        ));
    }
    let mut buffer = vec![0u8; bytes as usize];
    let result = unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            Some(buffer.as_mut_ptr().cast::<c_void>()),
            bytes,
            &mut bytes,
        )
    };
    unsafe {
        let _ = CloseHandle(token);
    }
    result.map_err(|source| error("managed_network_owner_lookup_failed", source.to_string()))?;
    let user = unsafe { &*(buffer.as_ptr().cast::<TOKEN_USER>()) };
    sid_to_string(user.User.Sid)
}

fn load_validated_identity() -> Result<Option<ManagedOnlineCredentials>> {
    let marker_bytes = match std::fs::read(marker_path()?) {
        Ok(bytes) => bytes,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(source) => {
            return Err(error(
                "managed_network_marker_read_failed",
                source.to_string(),
            ));
        }
    };
    let marker: ManagedSetupMarker = serde_json::from_slice(&marker_bytes)
        .map_err(|source| error("managed_network_marker_invalid", source.to_string()))?;
    if marker.version != STATE_VERSION || marker.username != ONLINE_USERNAME {
        return Err(error(
            "managed_network_marker_invalid",
            "setup marker version or username is invalid",
        ));
    }
    let credentials = load_online_identity()?.ok_or_else(|| {
        error(
            "managed_network_state_invalid",
            "setup marker exists without credentials",
        )
    })?;
    if !credentials.sid.eq_ignore_ascii_case(&marker.sid) {
        return Err(error(
            "managed_network_state_invalid",
            "setup marker and credential SID differ",
        ));
    }
    validate_non_admin_logon(&credentials.username, &credentials.password)?;
    Ok(Some(credentials))
}

pub fn load_online_identity() -> Result<Option<ManagedOnlineCredentials>> {
    let path = state_path()?;
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(source) => {
            return Err(error(
                "managed_network_state_read_failed",
                format!("cannot read {}: {source}", path.display()),
            ));
        }
    };
    let state: ManagedIdentityState = serde_json::from_slice(&bytes).map_err(|source| {
        error(
            "managed_network_state_invalid",
            format!("cannot parse {}: {source}", path.display()),
        )
    })?;
    if state.version != STATE_VERSION || state.username != ONLINE_USERNAME {
        return Ok(None);
    }
    let actual_sid = resolve_account_sid(&state.username)?;
    if !actual_sid.eq_ignore_ascii_case(&state.sid) {
        return Ok(None);
    }
    let protected = base64::engine::general_purpose::STANDARD
        .decode(&state.protected_password)
        .map_err(|source| error("managed_network_state_invalid", source.to_string()))?;
    let clear = unprotect_password_machine(&protected)?;
    let password = String::from_utf8(clear)
        .map_err(|source| error("managed_network_state_invalid", source.to_string()))?;
    Ok(Some(ManagedOnlineCredentials {
        username: state.username,
        password,
        sid: state.sid,
    }))
}

/// Command execution is deliberately side-effect free with respect to setup.
pub fn ensure_online_identity() -> Result<ManagedOnlineCredentials> {
    load_validated_identity()?.ok_or_else(|| {
        error(
            "managed_network_setup_required",
            "run the explicit Windows sandbox setup before approved network commands",
        )
    })
}

fn argument_value(arguments: &[String], prefix: &str) -> Option<String> {
    let mut matches = arguments
        .iter()
        .filter_map(|argument| argument.strip_prefix(prefix));
    let value = matches.next()?;
    if value.is_empty() || matches.next().is_some() {
        return None;
    }
    Some(value.to_string())
}

fn ensure_local_user(name: &str, password: &str) -> Result<()> {
    let mut name_w = wide(name);
    let mut password_w = wide(password);
    let mut info = USER_INFO_1 {
        usri1_name: PWSTR(name_w.as_mut_ptr()),
        usri1_password: PWSTR(password_w.as_mut_ptr()),
        usri1_priv: USER_PRIV_USER,
        usri1_flags: UF_SCRIPT | UF_DONT_EXPIRE_PASSWD,
        ..Default::default()
    };
    let mut parameter_error = 0u32;
    let status = unsafe {
        NetUserAdd(
            PCWSTR::null(),
            1,
            (&mut info as *mut USER_INFO_1).cast::<u8>(),
            Some(&mut parameter_error),
        )
    };
    if status == NERR_Success {
        return Ok(());
    }
    if status != NERR_UserExists {
        return Err(error(
            "managed_network_user_setup_failed",
            format!("NetUserAdd failed with code {status}, parameter {parameter_error}"),
        ));
    }
    let mut update = USER_INFO_1003 {
        usri1003_password: PWSTR(password_w.as_mut_ptr()),
    };
    let update_status = unsafe {
        NetUserSetInfo(
            PCWSTR::null(),
            PCWSTR(name_w.as_ptr()),
            1003,
            (&mut update as *mut USER_INFO_1003).cast::<u8>(),
            Some(&mut parameter_error),
        )
    };
    if update_status == NERR_Success {
        Ok(())
    } else {
        Err(error(
            "managed_network_user_setup_failed",
            format!("NetUserSetInfo failed with code {update_status}, parameter {parameter_error}"),
        ))
    }
}

fn validate_logon(username: &str, password: &str) -> Result<HANDLE> {
    let username_w = wide(username);
    let password_w = wide(password);
    let domain_w = wide(".");
    let mut token = HANDLE::default();
    unsafe {
        LogonUserW(
            PCWSTR(username_w.as_ptr()),
            PCWSTR(domain_w.as_ptr()),
            PCWSTR(password_w.as_ptr()),
            LOGON32_LOGON_INTERACTIVE,
            LOGON32_PROVIDER_DEFAULT,
            &mut token,
        )
        .map_err(|source| error("managed_network_logon_failed", source.to_string()))?;
    }
    Ok(token)
}

fn validate_non_admin_logon(username: &str, password: &str) -> Result<()> {
    let token = validate_logon(username, password)?;
    let is_administrator = token_is_administrator(token);
    unsafe {
        let _ = CloseHandle(token);
    }
    if is_administrator? {
        return Err(error(
            "managed_network_user_is_administrator",
            "refusing to use a managed network identity that is an administrator",
        ));
    }
    Ok(())
}

fn token_is_administrator(primary_token: HANDLE) -> Result<bool> {
    // LogonUserW returns a primary token. CheckTokenMembership requires an
    // impersonation token when a handle is supplied, otherwise it fails with
    // ERROR_NO_IMPERSONATION_TOKEN (0x51D) even though the logon succeeded.
    let mut membership_token = HANDLE::default();
    unsafe {
        DuplicateToken(primary_token, SecurityIdentification, &mut membership_token).map_err(
            |source| error("managed_network_user_validation_failed", source.to_string()),
        )?;
    }
    let sid_w = wide(BUILTIN_ADMINISTRATORS_SID);
    let mut administrators = PSID::default();
    if let Err(source) =
        unsafe { ConvertStringSidToSidW(PCWSTR(sid_w.as_ptr()), &mut administrators) }
    {
        unsafe {
            let _ = CloseHandle(membership_token);
        }
        return Err(error(
            "managed_network_user_validation_failed",
            source.to_string(),
        ));
    }
    let mut is_member = false.into();
    let membership =
        unsafe { CheckTokenMembership(membership_token, administrators, &mut is_member) };
    unsafe {
        let _ = LocalFree(HLOCAL(administrators.0));
        let _ = CloseHandle(membership_token);
    }
    membership
        .map_err(|source| error("managed_network_user_validation_failed", source.to_string()))?;
    Ok(is_member.as_bool())
}

fn ensure_builtin_users_membership(username: &str) -> Result<()> {
    let users_group = account_name_for_sid(BUILTIN_USERS_SID)?;
    let mut group_w = wide(users_group);
    let mut member_w = wide(username);
    let member = LOCALGROUP_MEMBERS_INFO_3 {
        lgrmi3_domainandname: PWSTR(member_w.as_mut_ptr()),
    };
    let status = unsafe {
        NetLocalGroupAddMembers(
            PCWSTR::null(),
            PCWSTR(group_w.as_mut_ptr()),
            3,
            (&member as *const LOCALGROUP_MEMBERS_INFO_3).cast::<u8>(),
            1,
        )
    };
    if status == NERR_Success || status == 1378 {
        Ok(())
    } else {
        Err(error(
            "managed_network_user_setup_failed",
            format!("NetLocalGroupAddMembers failed with code {status}"),
        ))
    }
}

fn resolve_account_sid(account: &str) -> Result<String> {
    let account_w = wide(account);
    let mut sid_bytes = 0u32;
    let mut domain_chars = 0u32;
    let mut sid_use = SID_NAME_USE::default();
    let _ = unsafe {
        LookupAccountNameW(
            PCWSTR::null(),
            PCWSTR(account_w.as_ptr()),
            PSID::default(),
            &mut sid_bytes,
            PWSTR::null(),
            &mut domain_chars,
            &mut sid_use,
        )
    };
    if unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER || sid_bytes == 0 {
        return Err(error(
            "managed_network_user_lookup_failed",
            format!("LookupAccountNameW sizing failed for {account}"),
        ));
    }
    let mut sid = vec![0u8; sid_bytes as usize];
    let mut domain = vec![0u16; domain_chars.max(1) as usize];
    unsafe {
        LookupAccountNameW(
            PCWSTR::null(),
            PCWSTR(account_w.as_ptr()),
            PSID(sid.as_mut_ptr().cast::<c_void>()),
            &mut sid_bytes,
            PWSTR(domain.as_mut_ptr()),
            &mut domain_chars,
            &mut sid_use,
        )
        .map_err(|source| error("managed_network_user_lookup_failed", source.to_string()))?;
    }
    sid_to_string(PSID(sid.as_mut_ptr().cast::<c_void>()))
}

fn account_name_for_sid(sid_text: &str) -> Result<String> {
    let sid_w = wide(sid_text);
    let mut sid = PSID::default();
    unsafe {
        ConvertStringSidToSidW(PCWSTR(sid_w.as_ptr()), &mut sid)
            .map_err(|source| error("managed_network_user_lookup_failed", source.to_string()))?;
    }
    let mut name_chars = 0u32;
    let mut domain_chars = 0u32;
    let mut sid_use = SID_NAME_USE::default();
    let _ = unsafe {
        LookupAccountSidW(
            PCWSTR::null(),
            sid,
            PWSTR::null(),
            &mut name_chars,
            PWSTR::null(),
            &mut domain_chars,
            &mut sid_use,
        )
    };
    if unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER || name_chars == 0 {
        unsafe {
            let _ = LocalFree(HLOCAL(sid.0));
        }
        return Err(error(
            "managed_network_user_lookup_failed",
            format!("LookupAccountSidW sizing failed for {sid_text}"),
        ));
    }
    let mut name = vec![0u16; name_chars as usize];
    let mut domain = vec![0u16; domain_chars.max(1) as usize];
    let result = unsafe {
        LookupAccountSidW(
            PCWSTR::null(),
            sid,
            PWSTR(name.as_mut_ptr()),
            &mut name_chars,
            PWSTR(domain.as_mut_ptr()),
            &mut domain_chars,
            &mut sid_use,
        )
    };
    unsafe {
        let _ = LocalFree(HLOCAL(sid.0));
    }
    result.map_err(|source| error("managed_network_user_lookup_failed", source.to_string()))?;
    let length = name
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(name.len());
    Ok(String::from_utf16_lossy(&name[..length]))
}

fn sid_to_string(sid: PSID) -> Result<String> {
    let mut output = PWSTR::null();
    unsafe {
        ConvertSidToStringSidW(sid, &mut output)
            .map_err(|source| error("managed_network_user_lookup_failed", source.to_string()))?;
        let mut length = 0usize;
        while *output.0.add(length) != 0 {
            length += 1;
        }
        let value = String::from_utf16_lossy(std::slice::from_raw_parts(output.0, length));
        let _ = LocalFree(HLOCAL(output.0.cast::<c_void>()));
        Ok(value)
    }
}

fn protect_password_machine(clear: &[u8]) -> Result<Vec<u8>> {
    let input = CRYPT_INTEGER_BLOB {
        cbData: clear.len() as u32,
        pbData: clear.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(
            &input,
            PCWSTR::null(),
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN | CRYPTPROTECT_LOCAL_MACHINE,
            &mut output,
        )
        .map_err(|source| error("managed_network_dpapi_failed", source.to_string()))?;
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(HLOCAL(output.pbData.cast::<c_void>()));
        Ok(bytes)
    }
}

fn unprotect_password_machine(protected: &[u8]) -> Result<Vec<u8>> {
    let input = CRYPT_INTEGER_BLOB {
        cbData: protected.len() as u32,
        pbData: protected.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(
            &input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN | CRYPTPROTECT_LOCAL_MACHINE,
            &mut output,
        )
        .map_err(|source| error("managed_network_dpapi_failed", source.to_string()))?;
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(HLOCAL(output.pbData.cast::<c_void>()));
        Ok(bytes)
    }
}

fn random_password() -> Result<String> {
    const UPPER: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const LOWER: &[u8] = b"abcdefghijklmnopqrstuvwxyz";
    const DIGIT: &[u8] = b"0123456789";
    const SYMBOL: &[u8] = b"!@#$%^&*()-_=+";
    const ALPHABET: &[u8] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()-_=+";
    let mut random = [0u8; 32];
    getrandom::getrandom(&mut random)
        .map_err(|source| error("managed_network_random_failed", source.to_string()))?;
    let mut password = Vec::with_capacity(random.len());
    for (index, byte) in random.iter().enumerate() {
        let alphabet = match index {
            0 => UPPER,
            1 => LOWER,
            2 => DIGIT,
            3 => SYMBOL,
            _ => ALPHABET,
        };
        password.push(alphabet[*byte as usize % alphabet.len()]);
    }
    Ok(String::from_utf8(password).expect("password alphabet is ASCII"))
}

fn write_json_atomically(path: &Path, value: &impl Serialize) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|source| error("managed_network_state_write_failed", source.to_string()))?;
    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
    std::fs::write(&temporary, bytes).map_err(|source| {
        error(
            "managed_network_state_write_failed",
            format!("cannot write {}: {source}", temporary.display()),
        )
    })?;
    let temporary_w = wide(temporary.as_os_str());
    let path_w = wide(path.as_os_str());
    unsafe {
        MoveFileExW(
            PCWSTR(temporary_w.as_ptr()),
            PCWSTR(path_w.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
        .map_err(|source| {
            error(
                "managed_network_state_write_failed",
                format!("cannot replace {}: {source}", path.display()),
            )
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_password_is_long_and_uses_the_fixed_alphabet() {
        let password = random_password().expect("password");
        assert_eq!(password.len(), 32);
        assert!(password.bytes().all(|byte| {
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()-_=+"
                .contains(&byte)
        }));
        assert!(password.bytes().any(|byte| byte.is_ascii_uppercase()));
        assert!(password.bytes().any(|byte| byte.is_ascii_lowercase()));
        assert!(password.bytes().any(|byte| byte.is_ascii_digit()));
        assert!(password
            .bytes()
            .any(|byte| b"!@#$%^&*()-_=+".contains(&byte)));
    }

    #[test]
    fn elevated_install_requires_one_setup_payload_before_mutating_accounts() {
        let missing = run_elevated_install(&[]).unwrap_err();
        assert_eq!(missing.code, "managed_network_setup_arguments_invalid");
        let duplicate = vec![
            format!("{SETUP_PAYLOAD_PREFIX}one"),
            format!("{SETUP_PAYLOAD_PREFIX}two"),
        ];
        let duplicate = run_elevated_install(&duplicate).unwrap_err();
        assert_eq!(duplicate.code, "managed_network_setup_arguments_invalid");
        let extra = vec![format!("{SETUP_PAYLOAD_PREFIX}one"), "extra".to_string()];
        let extra = run_elevated_install(&extra).unwrap_err();
        assert_eq!(extra.code, "managed_network_setup_arguments_invalid");
    }

    #[test]
    fn setup_payload_rejects_non_kite_state_roots() {
        let payload = ManagedSetupPayload {
            version: SETUP_PAYLOAD_VERSION,
            state_root: PathBuf::from(r"C:\Temp\other"),
            owner_sid: "S-1-5-18".to_string(),
            read_roots: Vec::new(),
        };
        assert_eq!(
            validate_setup_payload(&payload).unwrap_err().code,
            "managed_network_setup_payload_invalid"
        );
    }

    #[test]
    fn administrator_membership_check_accepts_a_primary_token() {
        let mut token = HANDLE::default();
        unsafe {
            OpenProcessToken(
                GetCurrentProcess(),
                TOKEN_QUERY | windows::Win32::Security::TOKEN_DUPLICATE,
                &mut token,
            )
            .expect("open current primary token");
        }
        let result = token_is_administrator(token);
        unsafe {
            let _ = CloseHandle(token);
        }
        assert!(result.is_ok(), "membership validation failed: {result:?}");
    }
}
