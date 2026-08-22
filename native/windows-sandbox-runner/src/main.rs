use base64::Engine;
use kite_windows_runner::direct_workspace;
use kite_windows_runner::job;
use kite_windows_runner::protected_paths::protected_deny_paths;
use kite_windows_runner::protocol::*;
use kite_windows_runner::restricted_token::{self, CapabilitySid};
use kite_windows_runner::{
    build_bash_command_line, build_busybox_sh_command_line, build_isksh_command_line, sha256_file,
};
use std::io::{Read, Write};
use std::sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex};
use windows::Win32::Foundation::{CloseHandle, HANDLE};

use windows::Win32::System::SystemInformation::OSVERSIONINFOW;

const WINDOWS_10_22H2_BUILD: u32 = 19_045;

#[link(name = "ntdll")]
extern "system" {
    fn RtlGetVersion(version: *mut OSVERSIONINFOW) -> i32;
}

fn main() {
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    let exit = if arguments
        .first()
        .is_some_and(|argument| argument == "--setup-managed-network")
    {
        run_setup_managed_network(&arguments[1..])
    } else if arguments
        .first()
        .is_some_and(|argument| argument == "--managed-network-status")
    {
        run_managed_network_status(&arguments[1..])
    } else if arguments
        .first()
        .is_some_and(|argument| argument == "--install-managed-network")
    {
        run_install_managed_network(&arguments[1..])
    } else if let Some(repair_index) = arguments
        .iter()
        .position(|argument| argument == "--repair-restricted-token")
    {
        run_repair_restricted_token(&arguments[repair_index + 1..])
    } else if arguments.iter().any(|argument| argument == "--cleanup") {
        run_cleanup()
    } else {
        run()
    };
    std::process::exit(exit);
}

fn run_setup_managed_network(arguments: &[String]) -> i32 {
    if !arguments.is_empty() {
        eprintln!("kite-windows-runner: --setup-managed-network accepts no arguments");
        return 2;
    }
    println!("{{\"version\":1,\"state\":\"ready\",\"reason\":\"current_user_restricted_token\"}}");
    0
}

fn run_managed_network_status(arguments: &[String]) -> i32 {
    if !arguments.is_empty() {
        eprintln!("kite-windows-runner: --managed-network-status accepts no arguments");
        return 2;
    }
    println!("{{\"version\":1,\"state\":\"ready\",\"reason\":\"current_user_restricted_token\"}}");
    0
}

fn run_install_managed_network(_arguments: &[String]) -> i32 {
    eprintln!("kite-windows-runner: managed-network installation is retired");
    2
}

/// Explicitly restore a persistent direct-workspace capability ledger after a
/// crash or when the direct backend is being removed. This command is separate
/// from `--cleanup`: ordinary invocation cleanup intentionally keeps the
/// Workspace capability SID in place for fast subsequent launches.
fn run_repair_restricted_token(arguments: &[String]) -> i32 {
    if let Err(error) = require_windows_10_22h2_or_later() {
        eprintln!("kite-windows-runner: {error}");
        return 2;
    }
    if arguments.len() != 1 || arguments[0].is_empty() {
        eprintln!(
            "kite-windows-runner: usage: kite-windows-runner --repair-restricted-token <workspace>"
        );
        return 2;
    }
    match direct_workspace::repair_persistent_workspace_capability(&arguments[0]) {
        Ok(true) => {
            eprintln!("kite-windows-runner: restricted-token Workspace ACL ledger repaired");
            0
        }
        Ok(false) => {
            eprintln!("kite-windows-runner: no restricted-token Workspace ACL ledger exists");
            0
        }
        Err(error) => {
            eprintln!("kite-windows-runner: {error}");
            1
        }
    }
}
fn runner_debug(message: &str) {
    if std::env::var_os("KITE_WINDOWS_RUNNER_DEBUG").is_some() {
        static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
        let start = START.get_or_init(std::time::Instant::now);
        eprintln!(
            "kite-windows-runner[debug]: +{:>7.1}ms {message}",
            start.elapsed().as_secs_f64() * 1000.0
        );
    }
}
fn run() -> i32 {
    if let Err(error) = require_windows_10_22h2_or_later() {
        eprintln!("kite-windows-runner: {error}");
        return 2;
    }
    let authority_key = match read_authority_key_bootstrap() {
        Ok(key) => key,
        Err(error) => {
            eprintln!("kite-windows-runner: authority key unavailable: {error}");
            return 2;
        }
    };
    // Release the process-global stdin lock before starting the invocation so
    // the cancel watcher can consume later cancellation frames.
    let request_frame = {
        let mut stdin = std::io::stdin().lock();
        decode_frame(&mut stdin)
    };
    let request_payload = match request_frame {
        Ok(payload) => payload,
        Err(error) => {
            eprintln!("kite-windows-runner: failed to read request frame: {error}");
            return 1;
        }
    };
    let candidate_invocation_id = match serde_json::from_slice::<AuthorityFrame>(&request_payload) {
        Ok(frame) => frame.invocation_id,
        Err(error) => {
            eprintln!("kite-windows-runner: invalid request frame: {error}");
            return 1;
        }
    };
    let request_frame = match decode_authority_frame::<InvocationRequest>(
        &request_payload,
        "request",
        HOST_PEER_ID,
        &candidate_invocation_id,
        &authority_key.key_id,
        0,
        authority_key.key.as_ref().as_slice(),
    ) {
        Ok(frame) => frame,
        Err(error) => {
            eprintln!("kite-windows-runner: invalid authenticated request frame: {error}");
            return 1;
        }
    };
    let request_invocation_id = request_frame.frame.invocation_id;
    let request = request_frame.payload;
    if request_invocation_id != request.invocation_name {
        eprintln!("kite-windows-runner: request identity does not bind invocation name");
        return 2;
    }
    if request.version != PROTOCOL_VERSION {
        eprintln!(
            "kite-windows-runner: protocol version mismatch: expected {}, got {}",
            PROTOCOL_VERSION, request.version
        );
        return 2;
    }
    runner_debug("authenticated request frame decoded");

    // Verify the manifest-selected runtime before executing anything. Do not
    // probe the directory: an untrusted writable runtime root must never make
    // the runner prefer a different executable.
    let runtime_root = std::path::Path::new(&request.shell_runtime_root);
    let (shell_path, shell_kind) = match request.shell_runtime {
        ShellRuntime::Isksh => (runtime_root.join("isksh.exe"), ShellRuntime::Isksh),
        ShellRuntime::Busybox => (runtime_root.join("busybox.exe"), ShellRuntime::Busybox),
        ShellRuntime::Bash => (runtime_root.join("bash.exe"), ShellRuntime::Bash),
    };
    let actual_digest = match sha256_file(&shell_path.to_string_lossy()) {
        Ok(digest) => digest,
        Err(error) => {
            eprintln!(
                "kite-windows-runner: pinned shell runtime missing at {}: {error}",
                shell_path.display()
            );
            return 3;
        }
    };
    let expected_digest = request
        .shell_runtime_digest
        .strip_prefix("sha256:")
        .unwrap_or(&request.shell_runtime_digest);
    if actual_digest != expected_digest {
        eprintln!(
            "kite-windows-runner: vendored shell runtime digest mismatch: expected {}, got {}",
            expected_digest, actual_digest
        );
        return 4;
    }
    runner_debug("shell runtime digest verified");
    let coreutils_path = runtime_root.join("coreutils.exe");
    let actual_coreutils_digest = match sha256_file(&coreutils_path.to_string_lossy()) {
        Ok(digest) => digest,
        Err(error) => {
            eprintln!(
                "kite-windows-runner: pinned Coreutils runtime missing at {}: {error}",
                coreutils_path.display()
            );
            return 3;
        }
    };
    let expected_coreutils_digest = request
        .coreutils_digest
        .strip_prefix("sha256:")
        .unwrap_or(&request.coreutils_digest);
    if actual_coreutils_digest != expected_coreutils_digest {
        eprintln!(
            "kite-windows-runner: vendored Coreutils runtime digest mismatch: expected {}, got {}",
            expected_coreutils_digest, actual_coreutils_digest
        );
        return 4;
    }
    runner_debug("coreutils digest verified");

    if !valid_invocation_name(&request.invocation_name) {
        eprintln!("kite-windows-runner: invalid trusted invocation name");
        return 2;
    }
    let output_writer = AuthorityFrameWriter::new(&request.invocation_name, &authority_key);
    if let Err(error) = output_writer.write(
        "ready",
        &ReadyPayload {
            invocation_name: request.invocation_name.clone(),
            runtime_validated: true,
        },
    ) {
        eprintln!("kite-windows-runner: authenticated ready write failed: {error}");
        return 1;
    }
    let go_payload = {
        let mut stdin = std::io::stdin().lock();
        decode_frame(&mut stdin)
    };
    let go_payload = match go_payload {
        Ok(payload) => payload,
        Err(error) => {
            eprintln!("kite-windows-runner: failed to read authenticated GO frame: {error}");
            return 1;
        }
    };
    let go = match decode_authority_frame::<GoPayload>(
        &go_payload,
        "go",
        HOST_PEER_ID,
        &request.invocation_name,
        &authority_key.key_id,
        1,
        authority_key.key.as_ref().as_slice(),
    ) {
        Ok(frame) => frame.payload,
        Err(error) => {
            eprintln!("kite-windows-runner: invalid authenticated GO frame: {error}");
            return 1;
        }
    };
    if go.invocation_name != request.invocation_name || !go.supervisor_acknowledged {
        eprintln!("kite-windows-runner: authenticated GO did not bind supervisor acknowledgement");
        return 1;
    }
    let result = execute_restricted_token_invocation(
        &request,
        &request.invocation_name,
        &shell_path,
        &coreutils_path,
        shell_kind,
        authority_key,
        output_writer,
    );
    if let Err(error) = result {
        eprintln!("kite-windows-runner: {error}");
        return 1;
    }
    0
}

#[derive(Clone)]
struct AuthorityKey {
    key: Arc<Vec<u8>>,
    key_id: String,
}

impl Drop for AuthorityKey {
    fn drop(&mut self) {
        if let Some(key) = Arc::get_mut(&mut self.key) {
            key.fill(0);
        }
    }
}

/// Read the one-shot fixed-size key record from the real stdin child-process
/// boundary. The bootstrap is consumed before any request frame and is never
/// forwarded to the restricted command. Its temporary byte buffer is cleared
/// before returning, while the parsed key remains only in this runner's
/// process-local authority state.
fn read_authority_key_bootstrap() -> Result<AuthorityKey, String> {
    let mut stdin = std::io::stdin().lock();
    read_authority_key_bootstrap_from(&mut stdin)
}

fn read_authority_key_bootstrap_from(reader: &mut impl Read) -> Result<AuthorityKey, String> {
    let mut record = [0u8; AUTHORITY_BOOTSTRAP_BYTES];
    let result: Result<(Vec<u8>, String), String> = (|| {
        reader
            .read_exact(&mut record)
            .map_err(|error| format!("authority bootstrap is truncated: {error}"))?;
        if &record[..AUTHORITY_BOOTSTRAP_MAGIC.len()] != &AUTHORITY_BOOTSTRAP_MAGIC[..] {
            return Err("authority bootstrap magic is invalid".to_string());
        }
        let key_start = AUTHORITY_BOOTSTRAP_MAGIC.len();
        let key_end = key_start + AUTHORITY_KEY_BYTES;
        let key = record[key_start..key_end].to_vec();
        if key.iter().all(|byte| *byte == 0) {
            return Err("authority bootstrap key material is all zero".to_string());
        }
        let key_id = String::from_utf8(record[key_end..].to_vec())
            .map_err(|_| "authority bootstrap key identifier is not UTF-8".to_string())?;
        if key_id.len() != AUTHORITY_KEY_ID_BYTES {
            return Err("authority bootstrap key identifier has an invalid size".to_string());
        }
        Ok((key, key_id))
    })();
    record.fill(0);
    let (key, advertised_key_id) = result?;
    let derived_key_id = derive_authority_key_id(&key);
    if advertised_key_id != derived_key_id {
        let mut key = key;
        key.fill(0);
        return Err("authority key identifier does not match key".to_string());
    }
    Ok(AuthorityKey {
        key: Arc::new(key),
        key_id: derived_key_id,
    })
}

/// RtlGetVersion is used instead of the manifest-sensitive GetVersionEx API,
/// so Windows 10 and Windows 11 report their actual build to the fail-closed
/// compatibility check.
fn require_windows_10_22h2_or_later() -> Result<(), String> {
    let mut version = OSVERSIONINFOW {
        dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32,
        ..Default::default()
    };
    let status = unsafe { RtlGetVersion(&mut version) };
    if status < 0 {
        return Err("windows_version_query_failed".to_string());
    }
    if !version_meets_windows_10_22h2_floor(version.dwMajorVersion, version.dwBuildNumber) {
        return Err(format!(
            "unsupported_windows_version: requires Windows 10 22H2 (10.0.{WINDOWS_10_22H2_BUILD}) or later, got {}.{}.{}",
            version.dwMajorVersion, version.dwMinorVersion, version.dwBuildNumber
        ));
    }
    Ok(())
}

fn version_meets_windows_10_22h2_floor(major: u32, build: u32) -> bool {
    major >= 10 && build >= WINDOWS_10_22H2_BUILD
}

fn run_cleanup() -> i32 {
    let authority_key = match read_authority_key_bootstrap() {
        Ok(key) => key,
        Err(error) => {
            eprintln!("kite-windows-runner: cleanup authority key unavailable: {error}");
            return 2;
        }
    };
    let mut stdin = std::io::stdin().lock();
    let request_payload = match decode_frame(&mut stdin) {
        Ok(payload) => payload,
        Err(error) => {
            eprintln!("kite-windows-runner: cleanup failed to read request frame: {error}");
            return 1;
        }
    };
    let candidate_invocation_id = match serde_json::from_slice::<AuthorityFrame>(&request_payload) {
        Ok(frame) => frame.invocation_id,
        Err(error) => {
            eprintln!("kite-windows-runner: cleanup invalid request frame: {error}");
            return 1;
        }
    };
    let request_frame = match decode_authority_frame::<InvocationRequest>(
        &request_payload,
        "request",
        HOST_PEER_ID,
        &candidate_invocation_id,
        &authority_key.key_id,
        0,
        authority_key.key.as_ref().as_slice(),
    ) {
        Ok(frame) => frame,
        Err(error) => {
            eprintln!("kite-windows-runner: cleanup invalid authenticated request: {error}");
            return 1;
        }
    };
    let request_invocation_id = request_frame.frame.invocation_id;
    let request = request_frame.payload;
    if request.version != PROTOCOL_VERSION
        || request_invocation_id != request.invocation_name
        || !valid_invocation_name(&request.invocation_name)
    {
        eprintln!("kite-windows-runner: cleanup request is invalid");
        return 2;
    }
    cleanup_restricted_token_request(&request)
}

fn cleanup_restricted_token_request(request: &InvocationRequest) -> i32 {
    let config = &request.direct_workspace;
    let runtime_capability = match CapabilitySid::parse(&config.runtime_capability_sid) {
        Ok(capability) => capability,
        Err(error) => {
            eprintln!("kite-windows-runner: {error}");
            return 2;
        }
    };
    let mut failures = Vec::new();
    if std::path::Path::new(&request.runtime_root).exists() {
        if let Err(error) = kite_windows_runner::acl::revoke_access(
            &request.runtime_root,
            runtime_capability.as_psid(),
        ) {
            failures.push(error.to_string());
        }
    }
    if let Some(ephemeral_workspace_sid) = &config.ephemeral_workspace_capability_sid {
        match CapabilitySid::parse(ephemeral_workspace_sid) {
            Ok(workspace_capability) => {
                if std::path::Path::new(&request.workspace_root).exists() {
                    if let Err(error) = kite_windows_runner::acl::revoke_access(
                        &request.workspace_root,
                        workspace_capability.as_psid(),
                    ) {
                        failures.push(error.to_string());
                    }
                }
            }
            Err(error) => failures.push(error.to_string()),
        }
    }
    if failures.is_empty() {
        0
    } else {
        eprintln!(
            "kite-windows-runner: restricted_token_acl_cleanup_failed: {}",
            failures.join("; ")
        );
        1
    }
}
fn valid_invocation_name(value: &str) -> bool {
    value.starts_with("kitecode.")
        && value.len() <= 160
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'.' || byte == b'-'
        })
}
/// Owns direct-workspace resources until the restricted Job is confirmed empty.
/// The normal Workspace capability ACL is a
/// persistent per-Workspace ledger entry; this guard only revokes the
/// invocation-private runtime capability on every path.
struct DirectInvocationCleanup {
    security: Option<direct_workspace::DirectWorkspaceSecurity>,
    job: Option<HANDLE>,
    handles: Vec<HANDLE>,
    armed: bool,
}

impl DirectInvocationCleanup {
    fn new(security: direct_workspace::DirectWorkspaceSecurity) -> Self {
        Self {
            security: Some(security),
            job: None,
            handles: Vec::new(),
            armed: true,
        }
    }

    fn capabilities(&self) -> &[CapabilitySid] {
        self.security
            .as_ref()
            .expect("direct workspace security must exist before cleanup")
            .capabilities()
    }

    fn approved_filesystem_guard(&self) -> Option<&CapabilitySid> {
        self.security
            .as_ref()
            .and_then(direct_workspace::DirectWorkspaceSecurity::approved_filesystem_guard)
    }

    fn track_job(&mut self, job: HANDLE) {
        self.job = Some(job);
    }

    fn track_handles(&mut self, handles: &[HANDLE]) {
        self.handles.extend_from_slice(handles);
    }

    fn forget_handles(&mut self, handles: &[HANDLE]) {
        self.handles
            .retain(|candidate| !handles.contains(candidate));
    }

    fn forget_job(&mut self) {
        self.job = None;
    }

    fn finish_security(&mut self) -> Result<(), direct_workspace::DirectWorkspaceError> {
        match self.security.take() {
            Some(security) => security.finish(),
            None => Ok(()),
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for DirectInvocationCleanup {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        unsafe {
            if let Some(job) = self.job.take() {
                let _ = job::terminate_job_and_confirm(job, 2_000);
                let _ = CloseHandle(job);
            }
            for handle in self.handles.drain(..) {
                let _ = CloseHandle(handle);
            }
        }
        if let Some(security) = self.security.take() {
            let _ = security.finish();
        }
    }
}
fn execute_restricted_token_invocation(
    request: &InvocationRequest,
    name: &str,
    shell_path: &std::path::Path,
    coreutils_path: &std::path::Path,
    shell_kind: ShellRuntime,
    authority_key: AuthorityKey,
    output_writer: AuthorityFrameWriter,
) -> Result<(), String> {
    let direct = &request.direct_workspace;
    let network_authorized = matches!(request.network_mode, NetworkMode::AllowAll);
    let approved_filesystem = matches!(request.filesystem_scope, FilesystemScope::FullAccess);
    // Schannel needs the current interactive token, but that token has no
    // restricted-SID filesystem ceiling. Never silently widen a network-only
    // or workspace-scoped approval into the user's ambient file authority.
    if network_authorized && !approved_filesystem {
        return Err(
            "approved_network_requires_full_filesystem_scope: Windows allow_all requires an explicit full_access filesystem grant"
                .to_string(),
        );
    }

    materialize_coreutils_aliases(&request.runtime_root, coreutils_path)?;
    runner_debug("coreutils aliases materialized");
    // A startup probe owns an empty temporary Workspace and supplies a
    // capability that is revoked after the probe. It deliberately has no
    // protected-path DACL snapshots to recover after a crash. Normal commands
    // use the persistent ledger and protect only static, currently existing
    // paths; it does not claim future glob protection.
    let deny_paths = if direct.ephemeral_workspace_capability_sid.is_some() {
        Vec::new()
    } else {
        protected_deny_paths(request)
    };
    let security = direct_workspace::prepare_direct_workspace(
        &request.workspace_root,
        &request.runtime_root,
        request.filesystem_scope,
        &direct.runtime_capability_sid,
        direct.ephemeral_workspace_capability_sid.as_deref(),
        direct.approved_filesystem_guard_sid.as_deref(),
        requires_approved_filesystem_guard(request.network_mode),
        &deny_paths,
    )
    .map_err(|error| error.to_string())?;
    runner_debug("restricted-token direct workspace ACLs prepared");
    let mut cleanup = DirectInvocationCleanup::new(security);

    // Schannel rejects credentials from a restricted primary token. Once the
    // runtime has recorded both explicit allow_all and full_access grants,
    // keep the current interactive user token for that exact command; the Job
    // Object still constrains its process tree. All other commands use a
    // restricted token below.
    let token =
        if can_use_current_user_network_token(request.network_mode, request.filesystem_scope) {
            None
        } else if approved_filesystem {
            Some(
                restricted_token::create_current_user_approved_filesystem_token(
                    cleanup.approved_filesystem_guard().ok_or_else(|| {
                        "restricted_token_protected_guard_invalid: approved guard missing"
                            .to_string()
                    })?,
                )
                .map_err(|error| error.to_string())?,
            )
        } else {
            Some(
                restricted_token::create_current_user_restricted_token(cleanup.capabilities())
                    .map_err(|error| error.to_string())?,
            )
        };
    runner_debug(if token.is_some() {
        "restricted token derived"
    } else {
        "approved network keeps current-user token"
    });
    let job = job::create_job(request.max_processes).map_err(|error| error.to_string())?;
    runner_debug("job object created");
    cleanup.track_job(job);
    let (stdin_read, stdin_write, stdout_read, stdout_write, stderr_read, stderr_write) =
        create_stdio().map_err(|error| error.to_string())?;
    cleanup.track_handles(&[
        stdin_read,
        stdin_write,
        stdout_read,
        stdout_write,
        stderr_read,
        stderr_write,
    ]);

    let env_block = if matches!(request.network_mode, NetworkMode::AllowAll) {
        build_network_authorized_env_block(&request.env)
    } else {
        build_env_block(&request.env)
    };
    let command_line = match shell_kind {
        ShellRuntime::Isksh => {
            build_isksh_command_line(&shell_path.to_string_lossy(), &request.command_line)
        }
        ShellRuntime::Busybox => {
            build_busybox_sh_command_line(&shell_path.to_string_lossy(), &request.command_line)
        }
        ShellRuntime::Bash => {
            build_bash_command_line(&shell_path.to_string_lossy(), &request.command_line)
        }
    };
    let child = if let Some(token) = token.as_ref() {
        let expected_capabilities = if approved_filesystem {
            std::slice::from_ref(cleanup.approved_filesystem_guard().ok_or_else(|| {
                "restricted_token_protected_guard_invalid: approved guard missing".to_string()
            })?)
        } else {
            cleanup.capabilities()
        };
        restricted_token::spawn_restricted_in_job(
            token,
            expected_capabilities,
            job,
            &command_line,
            &request.cwd,
            &env_block,
            stdin_read,
            stdout_write,
            stderr_write,
        )
    } else {
        restricted_token::spawn_current_user_in_job(
            job,
            &command_line,
            &request.cwd,
            &env_block,
            stdin_read,
            stdout_write,
            stderr_write,
        )
    }
    .map_err(|error| error.to_string())?;
    runner_debug("restricted-token process launched");

    // The child inherited its write handles; close the parent's copies so the
    // forwarders observe EOF after the Job becomes empty.
    cleanup.forget_handles(&[stdin_read, stdin_write, stdout_write, stderr_write]);
    unsafe {
        let _ = CloseHandle(stdin_read);
        let _ = CloseHandle(stdin_write);
        let _ = CloseHandle(stdout_write);
        let _ = CloseHandle(stderr_write);
    }

    let cancel_event = job::create_cancel_event().map_err(|error| error.to_string())?;
    cleanup.track_handles(&[cancel_event]);
    let cancel_watcher = CancelWatcher::spawn(cancel_event, authority_key.clone(), name.to_string())?;
    // From this point the watcher owns the right to use cancel_event. No
    // error unwind may close it behind that thread; joined paths close it
    // explicitly, detached paths leave it to process-exit cleanup.
    cleanup.forget_handles(&[cancel_event]);

    let stdout_forwarder = drain_and_forward(
        stdout_read,
        OutboundKind::Stdout,
        output_writer.clone(),
    );
    let stderr_forwarder = drain_and_forward(
        stderr_read,
        OutboundKind::Stderr,
        output_writer.clone(),
    );
    let (timed_out, cancelled) =
        job::wait_for_process(child.process_handle(), cancel_event, request.timeout_ms)
            .map_err(|error| error.to_string())?;
    runner_debug("process wait returned");
    let cleanup_confirmed =
        job::terminate_job_and_confirm(job, 2_000).map_err(|error| error.to_string())?;
    runner_debug("job cleanup confirmed");
    let (stdout_bytes, stdout_forced_closed) =
        join_forwarder(stdout_forwarder, stdout_read, "stdout")?;
    let (stderr_bytes, stderr_forced_closed) =
        join_forwarder(stderr_forwarder, stderr_read, "stderr")?;
    let exit_code = if timed_out {
        124
    } else if cancelled {
        130
    } else {
        job::child_exit_code(child.process_handle())
    };
    let peak_processes = job::job_peak_processes(job);

    // The Job has no active children. Revoke the unique runtime ACL before
    // emitting the receipt; a failure stays fail-closed and the adapter can
    // retry `--cleanup` with the same capability SID after a runner crash.
    let acl_cleanup = cleanup.finish_security();
    runner_debug("runtime ACLs revoked");
    cleanup.forget_handles(&[stdout_read, stderr_read]);
    cleanup.forget_job();
    unsafe {
        if !stdout_forced_closed {
            let _ = CloseHandle(stdout_read);
        }
        if !stderr_forced_closed {
            let _ = CloseHandle(stderr_read);
        }
        let _ = CloseHandle(job);
    }
    drop(child);
    cleanup.disarm();

    let error = acl_cleanup
        .err()
        .map(|error| error.code.to_string())
        .or_else(|| (!cleanup_confirmed).then(|| "process_tree_cleanup_unconfirmed".to_string()))
        .or_else(|| stdout_forced_closed.then(|| "stdout_forwarder_unconfirmed".to_string()))
        .or_else(|| stderr_forced_closed.then(|| "stderr_forwarder_unconfirmed".to_string()));
    let receipt = ExecutionReceipt {
        version: PROTOCOL_VERSION,
        exit_code,
        timed_out,
        cancelled,
        stdout_bytes,
        stderr_bytes,
        peak_processes,
        active_process_limit: request.max_processes,
        cleanup_confirmed: error.is_none()
            && cleanup_confirmed
            && !stdout_forced_closed
            && !stderr_forced_closed,
        // Protocol V1 retains this historic field name. In direct mode it is
        // an adapter-generated invocation identity.
        invocation_name: name.to_string(),
        error,
    };
    output_writer.write("exit", &receipt)?;
    cancel_watcher.stop_and_join()?;
    Ok(())
}

/// The synthetic protected-path guard constrains the approved-filesystem
/// restricted token only. Network-approved execution must retain the current
/// interactive token for Schannel, which cannot carry that synthetic SID.
fn requires_approved_filesystem_guard(network_mode: NetworkMode) -> bool {
    !matches!(network_mode, NetworkMode::AllowAll)
}

fn can_use_current_user_network_token(
    network_mode: NetworkMode,
    filesystem_scope: FilesystemScope,
) -> bool {
    matches!(network_mode, NetworkMode::AllowAll)
        && matches!(filesystem_scope, FilesystemScope::FullAccess)
}
/// Microsoft Coreutils is one static multi-call executable. POSIX shells
/// resolve utilities by their command name, so materialize a private copy plus
/// hard-link aliases before the restricted child is launched. The source binary
/// has already been manifest-verified; the directory lives under the unique
/// invocation runtime and is never reused by a later invocation.
const COREUTILS_ALIASES: &[&str] = &[
    "[",
    "arch",
    "b2sum",
    "base32",
    "base64",
    "basename",
    "basenc",
    "cat",
    "cksum",
    "comm",
    "coreutils-manager",
    "cp",
    "csplit",
    "cut",
    "date",
    "df",
    "dirname",
    "du",
    "echo",
    "env",
    "expr",
    "factor",
    "false",
    "find",
    "fmt",
    "fold",
    "grep",
    "head",
    "hostname",
    "join",
    "link",
    "ln",
    "ls",
    "md5sum",
    "mkdir",
    "mktemp",
    "mv",
    "nl",
    "nproc",
    "numfmt",
    "od",
    "paste",
    "pathchk",
    "pr",
    "printenv",
    "printf",
    "ptx",
    "pwd",
    "readlink",
    "realpath",
    "rm",
    "rmdir",
    "seq",
    "sha1sum",
    "sha224sum",
    "sha256sum",
    "sha384sum",
    "sha512sum",
    "shuf",
    "sleep",
    "sort",
    "split",
    "stat",
    "sum",
    "tac",
    "tail",
    "tee",
    "test",
    "touch",
    "tr",
    "true",
    "truncate",
    "tsort",
    "unexpand",
    "uniq",
    "unlink",
    "uptime",
    "wc",
    "xargs",
    "yes",
];

fn materialize_coreutils_aliases(
    runtime_root: &str,
    verified_coreutils: &std::path::Path,
) -> Result<(), String> {
    let tools_root = std::path::Path::new(runtime_root).join("kite-coreutils");
    match std::fs::create_dir(&tools_root) {
        Ok(()) => {}
        Err(error)
            if error.kind() == std::io::ErrorKind::AlreadyExists
                && tools_root.is_dir()
                && tools_root.join("coreutils.exe").is_file()
                && COREUTILS_ALIASES
                    .iter()
                    .all(|alias| tools_root.join(format!("{alias}.exe")).is_file()) =>
        {
            return Ok(());
        }
        Err(error) => {
            return Err(format!(
                "coreutils_runtime_prepare_failed: cannot create {}: {error}",
                tools_root.display()
            ));
        }
    }
    let private_binary = tools_root.join("coreutils.exe");
    std::fs::copy(verified_coreutils, &private_binary).map_err(|error| {
        format!(
            "coreutils_runtime_prepare_failed: cannot copy {}: {error}",
            private_binary.display()
        )
    })?;
    for alias in COREUTILS_ALIASES {
        let target = tools_root.join(format!("{alias}.exe"));
        std::fs::hard_link(&private_binary, &target).map_err(|error| {
            format!(
                "coreutils_runtime_prepare_failed: cannot create {}: {error}",
                target.display()
            )
        })?;
    }
    Ok(())
}

#[derive(Clone)]
struct AuthorityFrameWriter {
    invocation_id: String,
    key_id: String,
    key: Arc<Vec<u8>>,
    next_sequence: Arc<Mutex<u64>>,
}

impl AuthorityFrameWriter {
    fn new(invocation_id: &str, key: &AuthorityKey) -> Self {
        Self {
            invocation_id: invocation_id.to_string(),
            key_id: key.key_id.clone(),
            key: Arc::clone(&key.key),
            next_sequence: Arc::new(Mutex::new(0)),
        }
    }

    fn write<T: serde::Serialize>(&self, frame_type: &str, payload: &T) -> Result<(), String> {
        let mut sequence = self
            .next_sequence
            .lock()
            .map_err(|_| "authority output sequence lock poisoned".to_string())?;
        let encoded = encode_authority_frame(
            frame_type,
            &self.invocation_id,
            RUNNER_PEER_ID,
            &self.key_id,
            *sequence,
            payload,
            self.key.as_ref().as_slice(),
        )
        .map_err(|error| error.to_string())?;
        let stdout = std::io::stdout();
        let mut output = stdout.lock();
        output
            .write_all(&encoded)
            .map_err(|error| format!("authority output write failed: {error}"))?;
        output
            .flush()
            .map_err(|error| format!("authority output flush failed: {error}"))?;
        *sequence = (*sequence).saturating_add(1);
        Ok(())
    }
}

#[derive(Clone, Copy)]
enum OutboundKind {
    Stdout,
    Stderr,
}

/// A HANDLE is not `Send` by default; the pipe handles moved into the drain
/// threads are owned by this process and only used from those threads.
struct SendHandle(HANDLE);
unsafe impl Send for SendHandle {}
const _: fn() = || {
    let _ = std::mem::size_of::<SendHandle>();
};

fn drain_and_forward(
    handle: HANDLE,
    kind: OutboundKind,
    writer: AuthorityFrameWriter,
) -> std::thread::JoinHandle<u64> {
    let wrapped = SendHandle(handle);
    std::thread::spawn(move || {
        // Move the whole Send wrapper into the closure first; a direct
        // `wrapped.0` access would disjoint-capture the HANDLE itself.
        let taken = wrapped;
        let handle = taken.0;
        let mut total = 0u64;
        let mut buffer = [0u8; 8192];
        unsafe {
            loop {
                let mut read = 0u32;
                let result = windows::Win32::Storage::FileSystem::ReadFile(
                    handle,
                    Some(&mut buffer),
                    Some(&mut read),
                    None,
                );
                if result.is_err() || read == 0 {
                    break;
                }
                let data =
                    base64::engine::general_purpose::STANDARD.encode(&buffer[..read as usize]);
                total += read as u64;
                let frame_type = match kind {
                    OutboundKind::Stdout => "stdout",
                    OutboundKind::Stderr => "stderr",
                };
                let _ = writer.write(frame_type, &OutputPayload { data });
            }
        }
        total
    })
}

/// Join a pipe forwarder without letting a malformed child retain the runner
/// forever. After the Job is empty, a blocked synchronous ReadFile is no
/// longer allowed to hold up the control plane: detach the thread, leave its
/// handle for process-exit cleanup, and deliberately downgrade the receipt.
/// This avoids relying on cross-thread CloseHandle cancellation semantics.
fn join_forwarder(
    forwarder: std::thread::JoinHandle<u64>,
    _read_handle: HANDLE,
    label: &str,
) -> Result<(u64, bool), String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while !forwarder.is_finished() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let forced_closed = !forwarder.is_finished();
    if forced_closed {
        // Dropping JoinHandle detaches. The runner exits immediately after
        // emitting an unconfirmed receipt, so Windows closes this process's
        // pipe handles and terminates the detached thread.
        drop(forwarder);
        return Ok((0, true));
    }
    let bytes = forwarder
        .join()
        .map_err(|_| format!("{label} forwarder panicked"))?;
    Ok((bytes, forced_closed))
}

struct CancelWatcher {
    stop: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
    cancel_event: Option<HANDLE>,
}

impl CancelWatcher {
    fn spawn(
        cancel_event: HANDLE,
        authority_key: AuthorityKey,
        invocation_id: String,
    ) -> Result<Self, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        // windows::HANDLE is not Send. Transfer only its stable numeric value;
        // CancelWatcher keeps the sole close owner and joins before closing it.
        let cancel_event_address = cancel_event.0 as usize;
        let handle = std::thread::Builder::new()
            .name("kite-windows-cancel-watcher".to_string())
            .spawn(move || {
                let cancel_event = HANDLE(cancel_event_address as *mut core::ffi::c_void);
                let stdin_handle = match unsafe {
                    windows::Win32::System::Console::GetStdHandle(
                        windows::Win32::System::Console::STD_INPUT_HANDLE,
                    )
                } {
                    Ok(handle) => handle,
                    Err(_) => {
                        job::signal_cancel(cancel_event);
                        return;
                    }
                };
                loop {
                    if thread_stop.load(Ordering::Acquire) {
                        return;
                    }
                    let mut available = 0u32;
                    let mut header = [0u8; 4];
                    let mut header_read = 0u32;
                    let peek = unsafe {
                        windows::Win32::System::Pipes::PeekNamedPipe(
                            stdin_handle,
                            Some(header.as_mut_ptr().cast()),
                            header.len() as u32,
                            Some(&mut header_read),
                            Some(&mut available),
                            None,
                        )
                    };
                    if peek.is_err() {
                        job::signal_cancel(cancel_event);
                        return;
                    }
                    if available < 4 || header_read < 4 {
                        std::thread::sleep(std::time::Duration::from_millis(10));
                        continue;
                    }
                    let length = u32::from_le_bytes(header);
                    if length > MAX_FRAME_BYTES as u32 {
                        job::signal_cancel(cancel_event);
                        return;
                    }
                    if available < 4u32.saturating_add(length) {
                        std::thread::sleep(std::time::Duration::from_millis(10));
                        continue;
                    }
                    let mut stdin = std::io::stdin().lock();
                    match decode_frame(&mut stdin) {
                        Ok(payload) => {
                            let _ = decode_authority_frame::<CancelPayload>(
                                &payload,
                                "cancel",
                                HOST_PEER_ID,
                                &invocation_id,
                                &authority_key.key_id,
                                2,
                                authority_key.key.as_ref().as_slice(),
                            );
                            job::signal_cancel(cancel_event);
                        }
                        Err(_) => job::signal_cancel(cancel_event),
                    }
                    return;
                }
            })
            .map_err(|error| format!("cancel watcher spawn failed: {error}"))?;
        Ok(Self {
            stop,
            handle: Some(handle),
            cancel_event: Some(cancel_event),
        })
    }

    fn stop_and_join(mut self) -> Result<(), String> {
        self.stop.store(true, Ordering::Release);
        let result = self
            .handle
            .take()
            .expect("cancel watcher handle must exist")
            .join()
            .map_err(|_| "cancel watcher panicked".to_string());
        // Drop is the sole HANDLE close owner and runs only after this join.
        result
    }
}

impl Drop for CancelWatcher {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
        if let Some(cancel_event) = self.cancel_event.take() {
            unsafe {
                let _ = CloseHandle(cancel_event);
            }
        }
    }
}

fn close_pipe_pair(pair: (HANDLE, HANDLE)) {
    unsafe {
        let _ = CloseHandle(pair.0);
        let _ = CloseHandle(pair.1);
    }
}

fn create_stdio() -> Result<(HANDLE, HANDLE, HANDLE, HANDLE, HANDLE, HANDLE), String> {
    let stdin = create_pipe_pair().map_err(|error| error.to_string())?;
    let stdin_ready = unsafe {
        windows::Win32::Foundation::SetHandleInformation(
            stdin.0,
            windows::Win32::Foundation::HANDLE_FLAG_INHERIT.0,
            windows::Win32::Foundation::HANDLE_FLAG_INHERIT,
        )
        .map_err(|error| format!("SetHandleInformation(stdin read) failed: {error}"))
        .and_then(|_| {
            windows::Win32::Foundation::SetHandleInformation(
                stdin.1,
                windows::Win32::Foundation::HANDLE_FLAG_INHERIT.0,
                windows::Win32::Foundation::HANDLE_FLAGS(0),
            )
            .map_err(|error| format!("SetHandleInformation(stdin write) failed: {error}"))
        })
    };
    if let Err(error) = stdin_ready {
        close_pipe_pair(stdin);
        return Err(error);
    }
    let stdout = match create_pipe_pair() {
        Ok(pair) => pair,
        Err(error) => {
            close_pipe_pair(stdin);
            return Err(error.to_string());
        }
    };
    let stderr = match create_pipe_pair() {
        Ok(pair) => pair,
        Err(error) => {
            close_pipe_pair(stdin);
            close_pipe_pair(stdout);
            return Err(error.to_string());
        }
    };
    Ok((stdin.0, stdin.1, stdout.0, stdout.1, stderr.0, stderr.1))
}
fn create_pipe_pair() -> Result<(HANDLE, HANDLE), String> {
    unsafe {
        let mut read = HANDLE::default();
        let mut write = HANDLE::default();
        windows::Win32::System::Pipes::CreatePipe(&mut read, &mut write, None, 0)
            .map_err(|error| format!("CreatePipe failed: {error}"))?;
        if let Err(error) = windows::Win32::Foundation::SetHandleInformation(
            read,
            windows::Win32::Foundation::HANDLE_FLAG_INHERIT.0,
            windows::Win32::Foundation::HANDLE_FLAGS(0),
        ) {
            let _ = CloseHandle(read);
            let _ = CloseHandle(write);
            return Err(format!("SetHandleInformation(pipe read) failed: {error}"));
        }
        if let Err(error) = windows::Win32::Foundation::SetHandleInformation(
            write,
            windows::Win32::Foundation::HANDLE_FLAG_INHERIT.0,
            windows::Win32::Foundation::HANDLE_FLAG_INHERIT,
        ) {
            let _ = CloseHandle(read);
            let _ = CloseHandle(write);
            return Err(format!("SetHandleInformation(pipe write) failed: {error}"));
        }
        Ok((read, write))
    }
}

/// Build a UTF-16 environment block from the allowlist. Never inherits the
/// host environment.
fn build_env_block(env: &std::collections::BTreeMap<String, String>) -> Vec<u16> {
    let mut block = Vec::new();
    for (key, value) in env {
        block.extend(key.encode_utf16());
        block.push('=' as u16);
        block.extend(value.encode_utf16());
        block.push(0);
    }
    block.push(0);
    block
}

/// An approved network command keeps only the current user's profile and
/// standard proxy variables Schannel, Win32 user-scoped stores, and user
/// configured proxies need,
/// then overlay the trusted invocation allowlist for PATH/runtime hardening.
/// Other host variables stay excluded just as they do in the normal path.
fn build_network_authorized_env_block(
    request_env: &std::collections::BTreeMap<String, String>,
) -> Vec<u16> {
    const PROFILE_KEYS: &[&str] = &[
        "APPDATA",
        "LOCALAPPDATA",
        "USERPROFILE",
        "HOMEDRIVE",
        "HOMEPATH",
        "USERNAME",
        "USERDOMAIN",
        "KITE_WINDOWS_RESTRICTED_TOKEN_STATE_DIR",
    ];
    const PROXY_KEYS: &[&str] = &["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"];
    let mut environment = std::collections::BTreeMap::new();
    for (key, value) in std::env::vars() {
        if PROFILE_KEYS
            .iter()
            .any(|candidate| key.eq_ignore_ascii_case(candidate))
        {
            environment.insert(key, value);
        }
    }
    for canonical_key in PROXY_KEYS {
        if let Some((_, value)) =
            std::env::vars().find(|(key, _)| key.eq_ignore_ascii_case(canonical_key))
        {
            environment.insert((*canonical_key).to_string(), value);
        }
    }
    build_env_block(&merge_network_authorized_environment(
        environment,
        request_env,
    ))
}

fn merge_network_authorized_environment(
    mut environment: std::collections::BTreeMap<String, String>,
    request_env: &std::collections::BTreeMap<String, String>,
) -> std::collections::BTreeMap<String, String> {
    for (key, value) in request_env {
        if let Some(existing) = environment
            .keys()
            .find(|candidate| candidate.eq_ignore_ascii_case(key))
            .cloned()
        {
            environment.remove(&existing);
        }
        environment.insert(key.clone(), value.clone());
    }
    environment
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approved_network_execution_does_not_install_an_ineffective_filesystem_guard() {
        assert!(!requires_approved_filesystem_guard(NetworkMode::AllowAll));
        assert!(requires_approved_filesystem_guard(NetworkMode::Off));
    }

    #[test]
    fn current_user_network_token_requires_an_explicit_full_filesystem_grant() {
        assert!(can_use_current_user_network_token(
            NetworkMode::AllowAll,
            FilesystemScope::FullAccess,
        ));
        assert!(!can_use_current_user_network_token(
            NetworkMode::AllowAll,
            FilesystemScope::WorkspaceWrite,
        ));
        assert!(!can_use_current_user_network_token(
            NetworkMode::AllowAll,
            FilesystemScope::ReadOnly,
        ));
        assert!(!can_use_current_user_network_token(
            NetworkMode::Off,
            FilesystemScope::FullAccess,
        ));
    }
    use kite_windows_runner::protected_paths::is_dynamic_dotenv_name;

    #[test]
    fn dynamic_dotenv_name_matches_case_insensitively_without_utf8_panics() {
        assert!(is_dynamic_dotenv_name(".env.staging"));
        assert!(is_dynamic_dotenv_name(".ENV.production.local"));
        assert!(!is_dynamic_dotenv_name(".env"));
        assert!(!is_dynamic_dotenv_name(".environment"));
        assert!(!is_dynamic_dotenv_name("é.env.staging"));
    }

    #[test]
    fn windows_10_api_floor_accepts_22h2_and_windows_11_builds() {
        assert!(version_meets_windows_10_22h2_floor(10, 19_045));
        assert!(version_meets_windows_10_22h2_floor(10, 26_200));
        assert!(!version_meets_windows_10_22h2_floor(10, 19_044));
        assert!(!version_meets_windows_10_22h2_floor(6, 9_999));
    }

    #[test]
    fn coreutils_aliases_are_private_hard_links_to_one_copy() {
        let root = std::env::temp_dir().join(format!("kite-coreutils-test-{}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        let source = root.join("source-coreutils.exe");
        std::fs::write(&source, b"fixture-coreutils").unwrap();
        materialize_coreutils_aliases(&root.to_string_lossy(), &source).unwrap();
        let tools = root.join("kite-coreutils");
        assert_eq!(
            std::fs::read(tools.join("coreutils.exe")).unwrap(),
            b"fixture-coreutils"
        );
        assert_eq!(
            std::fs::read(tools.join("cat.exe")).unwrap(),
            b"fixture-coreutils"
        );
        assert_eq!(
            std::fs::read(tools.join("sleep.exe")).unwrap(),
            b"fixture-coreutils"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn network_authorized_environment_preserves_profile_paths_and_overlays_request_values() {
        let mut profile = std::collections::BTreeMap::new();
        profile.insert(
            "LOCALAPPDATA".to_string(),
            r"C:\Users\CurrentUser\AppData\Local".to_string(),
        );
        profile.insert(
            "USERPROFILE".to_string(),
            r"C:\Users\CurrentUser".to_string(),
        );
        profile.insert(
            "KITE_WINDOWS_RESTRICTED_TOKEN_STATE_DIR".to_string(),
            r"C:\Users\CurrentUser\AppData\Local\Kite Code\sandbox".to_string(),
        );
        let mut request = std::collections::BTreeMap::new();
        request.insert("PATH".to_string(), r"C:\Kite\runtime".to_string());
        request.insert("username".to_string(), "trusted-name".to_string());
        let merged = merge_network_authorized_environment(profile, &request);
        let block = build_env_block(&merged);
        let text = String::from_utf16_lossy(&block);
        assert!(text.contains("PATH=C:\\Kite\\runtime\0"));
        assert!(text.contains("LOCALAPPDATA=C:\\Users\\CurrentUser\\AppData\\Local\0"));
        assert!(text.contains("KITE_WINDOWS_RESTRICTED_TOKEN_STATE_DIR="));
        assert!(text.contains("username=trusted-name\0"));
        assert!(text.contains("USERPROFILE=C:\\Users\\CurrentUser\0"));
        assert!(block.ends_with(&[0, 0]));
    }

    #[test]
    fn authority_bootstrap_is_fixed_size_single_use_and_key_id_bound() {
        let key = (0u8..AUTHORITY_KEY_BYTES as u8).collect::<Vec<_>>();
        let key_id = derive_authority_key_id(&key);
        assert_eq!(key_id.len(), AUTHORITY_KEY_ID_BYTES);
        let mut record = Vec::with_capacity(AUTHORITY_BOOTSTRAP_BYTES);
        record.extend_from_slice(AUTHORITY_BOOTSTRAP_MAGIC);
        record.extend_from_slice(&key);
        record.extend_from_slice(key_id.as_bytes());
        assert_eq!(record.len(), AUTHORITY_BOOTSTRAP_BYTES);
        let mut reader = std::io::Cursor::new(record.clone());
        let decoded = read_authority_key_bootstrap_from(&mut reader).expect("bootstrap");
        assert_eq!(decoded.key.as_slice(), key.as_slice());
        assert_eq!(decoded.key_id, key_id);
        assert!(
            read_authority_key_bootstrap_from(&mut std::io::Cursor::new(record.clone())).is_err()
        );

        let mut wrong_key_id = Vec::with_capacity(AUTHORITY_BOOTSTRAP_BYTES);
        wrong_key_id.extend_from_slice(AUTHORITY_BOOTSTRAP_MAGIC);
        wrong_key_id.extend_from_slice(&key);
        wrong_key_id.extend_from_slice(b"sha256:0000000000000000000000000000000000000000000000000000000000000000");
        assert_eq!(wrong_key_id.len(), AUTHORITY_BOOTSTRAP_BYTES);
        assert!(
            read_authority_key_bootstrap_from(&mut std::io::Cursor::new(wrong_key_id)).is_err()
        );

        let truncated = record[..record.len() - 1].to_vec();
        assert!(read_authority_key_bootstrap_from(&mut std::io::Cursor::new(truncated)).is_err());

        let zero_key = vec![0u8; AUTHORITY_KEY_BYTES];
        let mut zero_record = Vec::with_capacity(AUTHORITY_BOOTSTRAP_BYTES);
        zero_record.extend_from_slice(AUTHORITY_BOOTSTRAP_MAGIC);
        zero_record.extend_from_slice(&zero_key);
        zero_record.extend_from_slice(derive_authority_key_id(&zero_key).as_bytes());
        assert!(read_authority_key_bootstrap_from(&mut std::io::Cursor::new(zero_record)).is_err());
        let mut duplicate = record.clone();
        duplicate.extend_from_slice(&record);
        let mut duplicate_reader = std::io::Cursor::new(duplicate);
        let _ = read_authority_key_bootstrap_from(&mut duplicate_reader).expect("first bootstrap");
        // The duplicate begins where the request length prefix must begin and
        // therefore cannot be accepted as a valid authority request frame.
        assert!(decode_frame(&mut duplicate_reader).is_err());
    }
}
