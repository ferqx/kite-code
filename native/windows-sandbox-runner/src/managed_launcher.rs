//! Relaunch an approved network invocation inside the provisioned online
//! Windows login session, then let that non-administrator runner create the
//! actual command child inside the outer Job and invocation ACL lease.

use crate::acl;
use crate::coreutils_runtime::materialize_coreutils_aliases;
use crate::job::{self, GENERIC_ALL, GENERIC_EXECUTE, GENERIC_READ};
use crate::managed_identity::{
    ensure_online_identity, runner_state_root, ManagedOnlineCredentials,
};
use crate::protected_paths::protected_deny_paths;
use crate::protocol::{decode_frame, encode_frame, InvocationRequest, OutboundFrame};
use crate::quote_argument;
use crate::sha256_file;
use crate::user_proxy::current_user_loopback_proxy_env;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::ffi::c_void;
use std::fs::File;
use std::io::Write;
use std::os::windows::io::FromRawHandle;
use std::path::Path;
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{
    CloseHandle, GetLastError, LocalFree, ERROR_PIPE_CONNECTED, GENERIC_READ as FILE_GENERIC_READ,
    GENERIC_WRITE as FILE_GENERIC_WRITE, HANDLE, HLOCAL, WAIT_ABANDONED, WAIT_OBJECT_0,
};
use windows::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, ConvertStringSidToSidW, SDDL_REVISION_1,
};
use windows::Win32::Security::{PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_MODE, OPEN_EXISTING, PIPE_ACCESS_INBOUND,
    PIPE_ACCESS_OUTBOUND,
};
use windows::Win32::System::Console::{
    SetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
};
use windows::Win32::System::JobObjects::AssignProcessToJobObject;
use windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT,
};
use windows::Win32::System::Threading::{
    CreateMutexW, CreateProcessWithLogonW, GetExitCodeProcess, ReleaseMutex, WaitForSingleObject,
    CREATE_NO_WINDOW, CREATE_UNICODE_ENVIRONMENT, INFINITE, LOGON_WITH_PROFILE,
    PROCESS_INFORMATION, STARTUPINFOW,
};

const CHILD_ARGUMENT: &str = "--managed-online-child";
const PIPE_INPUT_PREFIX: &str = "--pipe-in=";
const PIPE_OUTPUT_PREFIX: &str = "--pipe-out=";
const PIPE_ERROR_PREFIX: &str = "--pipe-error=";
const STATE_DIR_ENV: &str = "KITE_WINDOWS_RESTRICTED_TOKEN_STATE_DIR";
const LEASE_MUTEX_NAME: &str = "Local\\KiteCodeManagedNetworkAclLeaseV1";
const LEASE_JOURNAL: &str = "online-acl-lease.json";

#[derive(Debug)]
pub struct ManagedLaunchError {
    pub code: &'static str,
    pub message: String,
}

impl std::fmt::Display for ManagedLaunchError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ManagedLaunchError {}

type Result<T> = std::result::Result<T, ManagedLaunchError>;

fn error(code: &'static str, message: impl Into<String>) -> ManagedLaunchError {
    ManagedLaunchError {
        code,
        message: message.into(),
    }
}

fn wide(value: impl AsRef<std::ffi::OsStr>) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    value
        .as_ref()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AclLeaseJournal {
    version: u32,
    sid: String,
    paths: Vec<String>,
}

struct AclLease {
    mutex: HANDLE,
    sid: PSID,
    sid_storage: HLOCAL,
    paths: Vec<String>,
    journal_path: std::path::PathBuf,
    finished: bool,
}

impl AclLease {
    fn acquire(
        request: &InvocationRequest,
        credentials: &ManagedOnlineCredentials,
        runner_binary_root: &Path,
    ) -> Result<Self> {
        let mutex_name = wide(LEASE_MUTEX_NAME);
        let mutex = unsafe { CreateMutexW(None, false, PCWSTR(mutex_name.as_ptr())) }
            .map_err(|source| error("managed_network_acl_lock_failed", source.to_string()))?;
        let wait = unsafe { WaitForSingleObject(mutex, 30_000) };
        if wait != WAIT_OBJECT_0 && wait != WAIT_ABANDONED {
            unsafe {
                let _ = CloseHandle(mutex);
            }
            return Err(error(
                "managed_network_acl_lock_timeout",
                "managed network ACL lease is busy",
            ));
        }

        let sid_w = wide(&credentials.sid);
        let mut sid = PSID::default();
        if let Err(source) = unsafe { ConvertStringSidToSidW(PCWSTR(sid_w.as_ptr()), &mut sid) } {
            unsafe {
                let _ = ReleaseMutex(mutex);
                let _ = CloseHandle(mutex);
            }
            return Err(error("managed_network_sid_invalid", source.to_string()));
        }

        let state_root = runner_state_root()
            .map_err(|source| error("managed_network_acl_prepare_failed", source.to_string()))?;
        let journal_path = state_root.join(LEASE_JOURNAL);
        let mut lease = Self {
            mutex,
            sid,
            sid_storage: HLOCAL(sid.0),
            paths: Vec::new(),
            journal_path,
            finished: false,
        };
        lease.recover_stale_lease()?;

        let mut grant_paths = vec![
            request.workspace_root.clone(),
            request.runtime_root.clone(),
            request.shell_runtime_root.clone(),
            runner_binary_root.to_string_lossy().to_string(),
        ];
        grant_paths.sort_by_key(|path| path.to_ascii_lowercase());
        grant_paths.dedup_by(|left, right| left.eq_ignore_ascii_case(right));
        let mut deny_paths = protected_deny_paths(request)
            .into_iter()
            .filter(|path| Path::new(path).exists())
            .collect::<Vec<_>>();
        deny_paths.sort_by_key(|path| path.to_ascii_lowercase());
        deny_paths.dedup_by(|left, right| left.eq_ignore_ascii_case(right));
        lease.paths = grant_paths
            .iter()
            .chain(deny_paths.iter())
            .cloned()
            .collect();
        lease.paths.sort_by_key(|path| path.to_ascii_lowercase());
        lease
            .paths
            .dedup_by(|left, right| left.eq_ignore_ascii_case(right));
        lease.persist_journal(&credentials.sid)?;

        let grant_result = (|| -> Result<()> {
            for path in &grant_paths {
                let access = if path.eq_ignore_ascii_case(&request.shell_runtime_root)
                    || path.eq_ignore_ascii_case(&runner_binary_root.to_string_lossy())
                {
                    GENERIC_READ | GENERIC_EXECUTE
                } else {
                    GENERIC_ALL
                };
                acl::grant_access(path, lease.sid, access).map_err(|source| {
                    error("managed_network_acl_prepare_failed", source.to_string())
                })?;
            }
            for path in &deny_paths {
                acl::deny_identity_access(path, lease.sid, GENERIC_ALL).map_err(|source| {
                    error("managed_network_acl_prepare_failed", source.to_string())
                })?;
            }
            Ok(())
        })();
        if let Err(source) = grant_result {
            let _ = lease.finish();
            return Err(source);
        }
        Ok(lease)
    }

    fn recover_stale_lease(&self) -> Result<()> {
        let bytes = match std::fs::read(&self.journal_path) {
            Ok(bytes) => bytes,
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(source) => {
                return Err(error(
                    "managed_network_acl_recovery_failed",
                    source.to_string(),
                ));
            }
        };
        let journal: AclLeaseJournal = serde_json::from_slice(&bytes)
            .map_err(|source| error("managed_network_acl_recovery_failed", source.to_string()))?;
        if journal.version != 1 {
            return Err(error(
                "managed_network_acl_recovery_failed",
                "unsupported ACL lease journal version",
            ));
        }
        let journal_sid_w = wide(&journal.sid);
        let mut journal_sid = PSID::default();
        unsafe {
            ConvertStringSidToSidW(PCWSTR(journal_sid_w.as_ptr()), &mut journal_sid).map_err(
                |source| error("managed_network_acl_recovery_failed", source.to_string()),
            )?;
        }
        for path in &journal.paths {
            if Path::new(path).exists() {
                if let Err(source) = acl::revoke_access(path, journal_sid) {
                    unsafe {
                        let _ = LocalFree(HLOCAL(journal_sid.0));
                    }
                    return Err(error(
                        "managed_network_acl_recovery_failed",
                        source.to_string(),
                    ));
                }
            }
        }
        unsafe {
            let _ = LocalFree(HLOCAL(journal_sid.0));
        }
        std::fs::remove_file(&self.journal_path)
            .map_err(|source| error("managed_network_acl_recovery_failed", source.to_string()))?;
        Ok(())
    }

    fn persist_journal(&self, sid: &str) -> Result<()> {
        let journal = AclLeaseJournal {
            version: 1,
            sid: sid.to_string(),
            paths: self.paths.clone(),
        };
        let bytes = serde_json::to_vec_pretty(&journal)
            .map_err(|source| error("managed_network_acl_journal_failed", source.to_string()))?;
        let temporary = self
            .journal_path
            .with_extension(format!("{}.tmp", std::process::id()));
        std::fs::write(&temporary, bytes)
            .and_then(|_| std::fs::rename(&temporary, &self.journal_path))
            .map_err(|source| error("managed_network_acl_journal_failed", source.to_string()))
    }

    fn finish(&mut self) -> Result<()> {
        if self.finished {
            return Ok(());
        }
        let mut failures = Vec::new();
        for path in &self.paths {
            if let Err(source) = acl::revoke_access(path, self.sid) {
                failures.push(source.to_string());
            }
        }
        if failures.is_empty() {
            if let Err(source) = std::fs::remove_file(&self.journal_path) {
                if source.kind() != std::io::ErrorKind::NotFound {
                    failures.push(source.to_string());
                }
            }
        }
        self.finished = failures.is_empty();
        if failures.is_empty() {
            Ok(())
        } else {
            Err(error(
                "managed_network_acl_cleanup_failed",
                failures.join("; "),
            ))
        }
    }
}

impl Drop for AclLease {
    fn drop(&mut self) {
        if !self.finished {
            let _ = self.finish();
        }
        unsafe {
            let _ = LocalFree(self.sid_storage);
            let _ = ReleaseMutex(self.mutex);
            let _ = CloseHandle(self.mutex);
        }
    }
}

struct PipeSecurity {
    descriptor: HLOCAL,
    attributes: SECURITY_ATTRIBUTES,
}

impl PipeSecurity {
    fn for_sid(sid: &str) -> Result<Self> {
        let descriptor_text = wide(format!("D:P(A;;GA;;;{sid})(A;;GA;;;SY)(A;;GA;;;BA)"));
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                PCWSTR(descriptor_text.as_ptr()),
                SDDL_REVISION_1,
                &mut descriptor,
                None,
            )
            .map_err(|source| error("managed_network_pipe_security_failed", source.to_string()))?;
        }
        Ok(Self {
            descriptor: HLOCAL(descriptor.0),
            attributes: SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: descriptor.0,
                bInheritHandle: false.into(),
            },
        })
    }
}

impl Drop for PipeSecurity {
    fn drop(&mut self) {
        unsafe {
            let _ = LocalFree(self.descriptor);
        }
    }
}

struct ManagedPipes {
    input: HANDLE,
    output: HANDLE,
    error: HANDLE,
    input_name: String,
    output_name: String,
    error_name: String,
}

impl ManagedPipes {
    fn create(sid: &str) -> Result<Self> {
        let nonce = format!("{}-{}", std::process::id(), random_hex()?);
        let input_name = format!(r"\\.\pipe\kite-managed-in-{nonce}");
        let output_name = format!(r"\\.\pipe\kite-managed-out-{nonce}");
        let error_name = format!(r"\\.\pipe\kite-managed-err-{nonce}");
        let security = PipeSecurity::for_sid(sid)?;
        let input = create_pipe(&input_name, PIPE_ACCESS_OUTBOUND, &security.attributes)?;
        let output = match create_pipe(&output_name, PIPE_ACCESS_INBOUND, &security.attributes) {
            Ok(handle) => handle,
            Err(source) => {
                unsafe {
                    let _ = CloseHandle(input);
                }
                return Err(source);
            }
        };
        let error_handle = match create_pipe(&error_name, PIPE_ACCESS_INBOUND, &security.attributes)
        {
            Ok(handle) => handle,
            Err(source) => {
                unsafe {
                    let _ = CloseHandle(input);
                    let _ = CloseHandle(output);
                }
                return Err(source);
            }
        };
        Ok(Self {
            input,
            output,
            error: error_handle,
            input_name,
            output_name,
            error_name,
        })
    }

    fn connect(&self) -> Result<()> {
        connect_pipe(self.input)?;
        connect_pipe(self.output)?;
        connect_pipe(self.error)
    }
}

fn create_pipe(
    name: &str,
    access: windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES,
    security: &SECURITY_ATTRIBUTES,
) -> Result<HANDLE> {
    let name_w = wide(name);
    let handle = unsafe {
        CreateNamedPipeW(
            PCWSTR(name_w.as_ptr()),
            access,
            PIPE_TYPE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            1,
            65_536,
            65_536,
            0,
            Some(security),
        )
    };
    if handle.is_invalid() {
        Err(error(
            "managed_network_pipe_create_failed",
            format!("CreateNamedPipeW failed: {}", unsafe { GetLastError() }.0),
        ))
    } else {
        Ok(handle)
    }
}

fn connect_pipe(handle: HANDLE) -> Result<()> {
    match unsafe { ConnectNamedPipe(handle, None) } {
        Ok(()) => Ok(()),
        Err(_source) if unsafe { GetLastError() } == ERROR_PIPE_CONNECTED => Ok(()),
        Err(source) => Err(error(
            "managed_network_pipe_connect_failed",
            source.to_string(),
        )),
    }
}

pub fn run_online(input_request: &InvocationRequest) -> Result<u32> {
    let mut request = input_request.clone();
    request.env.extend(current_user_loopback_proxy_env());
    let credentials =
        ensure_online_identity().map_err(|source| error(source.code, source.message))?;
    let source_executable = std::env::current_exe()
        .map_err(|source| error("managed_network_runner_launch_failed", source.to_string()))?;
    let state_root = runner_state_root()
        .map_err(|source| error("managed_network_runner_launch_failed", source.to_string()))?;
    let runner_binary_root = state_root
        .parent()
        .expect("managed runner state has a parent")
        .join("managed-runner-bin");
    std::fs::create_dir_all(&runner_binary_root).map_err(|source| {
        error(
            "managed_network_runner_materialize_failed",
            source.to_string(),
        )
    })?;
    // Materialize runner-managed files as the initiating user before granting
    // the Online identity access. Files created by a secondary logon can carry
    // a default DACL that the initiating user cannot remove during cleanup.
    let coreutils_binary = Path::new(&request.shell_runtime_root).join("coreutils.exe");
    materialize_coreutils_aliases(&request.runtime_root, &coreutils_binary)
        .map_err(|source| error("managed_network_runtime_prepare_failed", source))?;
    let executable = materialize_managed_runner(&source_executable, &runner_binary_root)?;
    let mut lease = AclLease::acquire(&request, &credentials, &runner_binary_root)?;
    let pipes = ManagedPipes::create(&credentials.sid)?;
    let command_line = [
        quote_argument(&executable.to_string_lossy()),
        CHILD_ARGUMENT.to_string(),
        quote_argument(&format!("{PIPE_INPUT_PREFIX}{}", pipes.input_name)),
        quote_argument(&format!("{PIPE_OUTPUT_PREFIX}{}", pipes.output_name)),
        quote_argument(&format!("{PIPE_ERROR_PREFIX}{}", pipes.error_name)),
    ]
    .join(" ");
    let mut command_w = wide(command_line);
    let executable_w = wide(executable.as_os_str());
    let username_w = wide(&credentials.username);
    let password_w = wide(&credentials.password);
    let domain_w = wide(".");
    let cwd_w = wide(&request.cwd);
    let environment = managed_child_environment(&state_root);
    let startup = STARTUPINFOW {
        cb: std::mem::size_of::<STARTUPINFOW>() as u32,
        ..Default::default()
    };
    let mut process = PROCESS_INFORMATION::default();
    unsafe {
        CreateProcessWithLogonW(
            PCWSTR(username_w.as_ptr()),
            PCWSTR(domain_w.as_ptr()),
            PCWSTR(password_w.as_ptr()),
            LOGON_WITH_PROFILE,
            PCWSTR(executable_w.as_ptr()),
            PWSTR(command_w.as_mut_ptr()),
            CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
            Some(environment.as_ptr().cast::<c_void>()),
            PCWSTR(cwd_w.as_ptr()),
            &startup,
            &mut process,
        )
        .map_err(|source| error("managed_network_runner_launch_failed", source.to_string()))?;
    }

    let outer_job = job::create_job(request.max_processes.saturating_add(1))
        .map_err(|source| error("managed_network_job_failed", source.to_string()))?;
    if let Err(source) = unsafe { AssignProcessToJobObject(outer_job, process.hProcess) } {
        unsafe {
            let _ = windows::Win32::System::Threading::TerminateProcess(process.hProcess, 1);
            let _ = CloseHandle(process.hThread);
            let _ = CloseHandle(process.hProcess);
            let _ = CloseHandle(outer_job);
        }
        return Err(error("managed_network_job_failed", source.to_string()));
    }
    unsafe {
        let _ = CloseHandle(process.hThread);
    }

    if let Err(source) = pipes.connect() {
        unsafe {
            let _ = windows::Win32::System::Threading::TerminateProcess(process.hProcess, 1);
            let _ = CloseHandle(process.hProcess);
            let _ = CloseHandle(outer_job);
        }
        return Err(source);
    }

    let mut input_file = unsafe { File::from_raw_handle(pipes.input.0) };
    let mut output_file = unsafe { File::from_raw_handle(pipes.output.0) };
    let mut error_file = unsafe { File::from_raw_handle(pipes.error.0) };
    let request_frame = encode_frame(&request)
        .map_err(|source| error("managed_network_pipe_write_failed", source.to_string()))?;
    input_file
        .write_all(&request_frame)
        .and_then(|_| input_file.flush())
        .map_err(|source| error("managed_network_pipe_write_failed", source.to_string()))?;

    let input_forwarder = std::thread::spawn(move || {
        let mut stdin = std::io::stdin().lock();
        let _ = std::io::copy(&mut stdin, &mut input_file);
    });
    drop(input_forwarder);
    let error_forwarder = std::thread::spawn(move || {
        let mut stderr = std::io::stderr().lock();
        let _ = std::io::copy(&mut error_file, &mut stderr);
        let _ = stderr.flush();
    });
    let mut exit_receipt = None;
    {
        let mut stdout = std::io::stdout().lock();
        loop {
            let payload = match decode_frame(&mut output_file) {
                Ok(payload) => payload,
                Err(source) if source.kind() == std::io::ErrorKind::UnexpectedEof => break,
                Err(source) => {
                    return Err(error(
                        "managed_network_pipe_read_failed",
                        source.to_string(),
                    ));
                }
            };
            let frame: OutboundFrame = serde_json::from_slice(&payload)
                .map_err(|source| error("managed_network_pipe_read_failed", source.to_string()))?;
            match frame {
                OutboundFrame::Exit { receipt } => {
                    exit_receipt = Some(receipt);
                    break;
                }
                other => {
                    let encoded = encode_frame(&other).map_err(|source| {
                        error("managed_network_pipe_read_failed", source.to_string())
                    })?;
                    stdout.write_all(&encoded).map_err(|source| {
                        error("managed_network_pipe_read_failed", source.to_string())
                    })?;
                    stdout.flush().map_err(|source| {
                        error("managed_network_pipe_read_failed", source.to_string())
                    })?;
                }
            }
        }
    }
    let _ = error_forwarder.join();
    unsafe {
        let _ = WaitForSingleObject(process.hProcess, INFINITE);
    }
    let mut exit_code = 1u32;
    unsafe {
        GetExitCodeProcess(process.hProcess, &mut exit_code)
            .map_err(|source| error("managed_network_runner_wait_failed", source.to_string()))?;
        let _ = CloseHandle(process.hProcess);
        let _ = CloseHandle(outer_job);
    }
    let lease_result = lease.finish();
    if let Err(source) = &lease_result {
        eprintln!("kite-windows-runner: {source}");
    }
    if let Some(mut receipt) = exit_receipt {
        if lease_result.is_err() {
            receipt.cleanup_confirmed = false;
            receipt.error = Some("managed_network_acl_cleanup_failed".to_string());
        }
        let encoded = encode_frame(&OutboundFrame::Exit { receipt })
            .map_err(|source| error("managed_network_pipe_write_failed", source.to_string()))?;
        let mut stdout = std::io::stdout().lock();
        stdout
            .write_all(&encoded)
            .and_then(|_| stdout.flush())
            .map_err(|source| error("managed_network_pipe_write_failed", source.to_string()))?;
    }
    match lease_result {
        Ok(()) => Ok(exit_code),
        Err(_) => Ok(1),
    }
}

fn managed_child_environment(state_root: &Path) -> Vec<u16> {
    let mut values = BTreeMap::new();
    for key in ["SystemRoot", "WINDIR", "TEMP", "TMP", "LOCALAPPDATA"] {
        if let Some(value) = std::env::var_os(key) {
            values.insert(key.to_string(), value.to_string_lossy().to_string());
        }
    }
    values.insert(
        STATE_DIR_ENV.to_string(),
        state_root.to_string_lossy().to_string(),
    );
    let mut block = Vec::new();
    for (key, value) in values {
        block.extend(key.encode_utf16());
        block.push('=' as u16);
        block.extend(value.encode_utf16());
        block.push(0);
    }
    block.push(0);
    block
}

fn materialize_managed_runner(source: &Path, state_root: &Path) -> Result<std::path::PathBuf> {
    let destination = state_root.join("kite-windows-runner-managed.exe");
    let temporary = state_root.join(format!(
        "kite-windows-runner-managed-{}.tmp",
        std::process::id()
    ));
    std::fs::copy(source, &temporary).map_err(|source| {
        error(
            "managed_network_runner_materialize_failed",
            source.to_string(),
        )
    })?;
    if destination.exists() {
        std::fs::remove_file(&destination).map_err(|source| {
            error(
                "managed_network_runner_materialize_failed",
                source.to_string(),
            )
        })?;
    }
    std::fs::rename(&temporary, &destination).map_err(|source| {
        error(
            "managed_network_runner_materialize_failed",
            source.to_string(),
        )
    })?;
    let source_digest = sha256_file(&source.to_string_lossy()).map_err(|source| {
        error(
            "managed_network_runner_materialize_failed",
            source.to_string(),
        )
    })?;
    let destination_digest = sha256_file(&destination.to_string_lossy()).map_err(|source| {
        error(
            "managed_network_runner_materialize_failed",
            source.to_string(),
        )
    })?;
    if source_digest != destination_digest {
        return Err(error(
            "managed_network_runner_materialize_failed",
            "managed runner copy digest mismatch",
        ));
    }
    Ok(destination)
}

pub fn configure_child_stdio(arguments: &[String]) -> Result<()> {
    let input = argument_value(arguments, PIPE_INPUT_PREFIX)?;
    let output = argument_value(arguments, PIPE_OUTPUT_PREFIX)?;
    let error_pipe = argument_value(arguments, PIPE_ERROR_PREFIX)?;
    let input_handle = open_pipe(&input, FILE_GENERIC_READ)?;
    let output_handle = open_pipe(&output, FILE_GENERIC_WRITE)?;
    let error_handle = open_pipe(&error_pipe, FILE_GENERIC_WRITE)?;
    unsafe {
        SetStdHandle(STD_INPUT_HANDLE, input_handle)
            .and_then(|_| SetStdHandle(STD_OUTPUT_HANDLE, output_handle))
            .and_then(|_| SetStdHandle(STD_ERROR_HANDLE, error_handle))
            .map_err(|source| error("managed_network_pipe_stdio_failed", source.to_string()))?;
    }
    // The process standard-handle table now owns these handles for the
    // remainder of the short-lived managed runner process.
    Ok(())
}

fn argument_value(arguments: &[String], prefix: &str) -> Result<String> {
    arguments
        .iter()
        .find_map(|argument| argument.strip_prefix(prefix).map(str::to_string))
        .filter(|value| value.starts_with(r"\\.\pipe\kite-managed-"))
        .ok_or_else(|| {
            error(
                "managed_network_child_arguments_invalid",
                format!("missing or invalid {prefix} argument"),
            )
        })
}

fn open_pipe(
    name: &str,
    access: windows::Win32::Foundation::GENERIC_ACCESS_RIGHTS,
) -> Result<HANDLE> {
    let name_w = wide(name);
    unsafe {
        CreateFileW(
            PCWSTR(name_w.as_ptr()),
            access.0,
            FILE_SHARE_MODE(0),
            None,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            None,
        )
        .map_err(|source| error("managed_network_pipe_open_failed", source.to_string()))
    }
}

fn random_hex() -> Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes)
        .map_err(|source| error("managed_network_random_failed", source.to_string()))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn child_pipe_arguments_reject_non_kite_pipe_names() {
        let arguments = vec!["--pipe-in=\\\\.\\pipe\\other".to_string()];
        assert!(argument_value(&arguments, PIPE_INPUT_PREFIX).is_err());
    }

    #[test]
    fn managed_child_environment_is_double_nul_terminated() {
        let block = managed_child_environment(Path::new(r"C:\state"));
        assert!(block.ends_with(&[0, 0]));
    }
}
