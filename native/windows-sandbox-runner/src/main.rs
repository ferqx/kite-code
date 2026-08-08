use base64::Engine;
use kite_windows_runner::direct_workspace;
use kite_windows_runner::job;
use kite_windows_runner::managed_identity;
use kite_windows_runner::managed_launcher;
use kite_windows_runner::protected_paths::protected_deny_paths;
use kite_windows_runner::protocol::*;
use kite_windows_runner::restricted_token::{self, CapabilitySid};
use kite_windows_runner::{
    build_bash_command_line, build_busybox_sh_command_line, build_isksh_command_line, sha256_file,
};
use serde::Deserialize;
use std::io::Write;
use windows::Win32::Foundation::{CloseHandle, HANDLE};

use windows::Win32::System::SystemInformation::OSVERSIONINFOW;

const WINDOWS_10_22H2_BUILD: u32 = 19_045;

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum RunnerInboundFrame {
    Cancel,
}

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
    } else if arguments
        .first()
        .is_some_and(|argument| argument == "--managed-online-child")
    {
        match managed_launcher::configure_child_stdio(&arguments[1..]) {
            Ok(()) => run(true),
            Err(error) => {
                eprintln!("kite-windows-runner: {error}");
                1
            }
        }
    } else if let Some(repair_index) = arguments
        .iter()
        .position(|argument| argument == "--repair-restricted-token")
    {
        run_repair_restricted_token(&arguments[repair_index + 1..])
    } else if arguments.iter().any(|argument| argument == "--cleanup") {
        run_cleanup()
    } else {
        run(false)
    };
    std::process::exit(exit);
}

fn run_setup_managed_network(arguments: &[String]) -> i32 {
    if !arguments.is_empty() {
        eprintln!("kite-windows-runner: --setup-managed-network accepts no arguments");
        return 2;
    }
    if let Err(error) = require_windows_10_22h2_or_later() {
        eprintln!("kite-windows-runner: {error}");
        return 2;
    }
    match managed_identity::run_setup_orchestrator() {
        Ok(()) => {
            println!("{{\"version\":1,\"state\":\"ready\",\"reason\":\"managed_network_ready\"}}");
            0
        }
        Err(error) => {
            eprintln!("kite-windows-runner: {error}");
            1
        }
    }
}

fn run_managed_network_status(arguments: &[String]) -> i32 {
    if !arguments.is_empty() {
        eprintln!("kite-windows-runner: --managed-network-status accepts no arguments");
        return 2;
    }
    match serde_json::to_string(&managed_identity::managed_setup_status()) {
        Ok(status) => {
            println!("{status}");
            0
        }
        Err(error) => {
            eprintln!("kite-windows-runner: cannot serialize managed-network status: {error}");
            1
        }
    }
}

fn run_install_managed_network(arguments: &[String]) -> i32 {
    if let Err(error) = require_windows_10_22h2_or_later() {
        eprintln!("kite-windows-runner: {error}");
        return 2;
    }
    match managed_identity::run_elevated_install(arguments) {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("kite-windows-runner: {error}");
            1
        }
    }
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
fn run(managed_online_child: bool) -> i32 {
    if let Err(error) = require_windows_10_22h2_or_later() {
        eprintln!("kite-windows-runner: {error}");
        return 2;
    }
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
    let request: InvocationRequest = match serde_json::from_slice(&request_payload) {
        Ok(request) => request,
        Err(error) => {
            eprintln!("kite-windows-runner: invalid request json: {error}");
            return 1;
        }
    };
    if request.version != PROTOCOL_VERSION {
        eprintln!(
            "kite-windows-runner: protocol version mismatch: expected {}, got {}",
            PROTOCOL_VERSION, request.version
        );
        return 2;
    }
    runner_debug("request frame decoded");

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
    if !managed_online_child && requires_managed_online_identity(request.network_mode) {
        return match managed_launcher::run_online(&request) {
            Ok(exit_code) => exit_code as i32,
            Err(error) => {
                eprintln!("kite-windows-runner: {error}");
                1
            }
        };
    }
    let result = execute_restricted_token_invocation(
        &request,
        &request.invocation_name,
        &shell_path,
        &coreutils_path,
        shell_kind,
        managed_online_child,
    );
    if let Err(error) = result {
        eprintln!("kite-windows-runner: {error}");
        return 1;
    }
    0
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
    let mut stdin = std::io::stdin().lock();
    let request_payload = match decode_frame(&mut stdin) {
        Ok(payload) => payload,
        Err(error) => {
            eprintln!("kite-windows-runner: cleanup failed to read request frame: {error}");
            return 1;
        }
    };
    let request: InvocationRequest = match serde_json::from_slice(&request_payload) {
        Ok(request) => request,
        Err(error) => {
            eprintln!("kite-windows-runner: cleanup invalid request json: {error}");
            return 1;
        }
    };
    if request.version != PROTOCOL_VERSION || !valid_invocation_name(&request.invocation_name) {
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

    fn without_security() -> Self {
        Self {
            security: None,
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
    managed_online_child: bool,
) -> Result<(), String> {
    let direct = &request.direct_workspace;

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
    // The managed Online child already runs inside the parent's invocation
    // ACL lease. Preparing the restricted-token capability ledger here would
    // both be redundant and fail after protected paths have intentionally
    // removed access for the Online identity.
    let mut cleanup = if managed_online_child {
        runner_debug("managed Online ACL lease already prepared");
        DirectInvocationCleanup::without_security()
    } else {
        let security = direct_workspace::prepare_direct_workspace(
            &request.workspace_root,
            &request.runtime_root,
            request.filesystem_scope,
            &direct.runtime_capability_sid,
            direct.ephemeral_workspace_capability_sid.as_deref(),
            &deny_paths,
        )
        .map_err(|error| error.to_string())?;
        runner_debug("restricted-token direct workspace ACLs prepared");
        DirectInvocationCleanup::new(security)
    };

    let token = if managed_online_child {
        None
    } else {
        Some(
            restricted_token::create_current_user_restricted_token(cleanup.capabilities())
                .map_err(|error| error.to_string())?,
        )
    };
    runner_debug("restricted token derived");
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

    let env_block = build_env_block(&request.env);
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
        restricted_token::spawn_restricted_in_job(
            token,
            cleanup.capabilities(),
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
    runner_debug(if managed_online_child {
        "managed non-admin process launched"
    } else {
        "restricted-token process launched"
    });

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
    spawn_cancel_watcher(cancel_event);

    let stdout_forwarder = drain_and_forward(stdout_read, OutboundKind::Stdout);
    let stderr_forwarder = drain_and_forward(stderr_read, OutboundKind::Stderr);
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
    cleanup.forget_handles(&[cancel_event, stdout_read, stderr_read]);
    cleanup.forget_job();
    unsafe {
        let _ = CloseHandle(cancel_event);
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
    let encoded =
        encode_frame(&OutboundFrame::Exit { receipt }).map_err(|error| error.to_string())?;
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    out.write_all(&encoded).map_err(|error| error.to_string())?;
    out.flush().map_err(|error| error.to_string())?;
    Ok(())
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

fn drain_and_forward(handle: HANDLE, kind: OutboundKind) -> std::thread::JoinHandle<u64> {
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
                let frame = match kind {
                    OutboundKind::Stdout => OutboundFrame::Stdout { data },
                    OutboundKind::Stderr => OutboundFrame::Stderr { data },
                };
                if let Ok(encoded) = encode_frame(&frame) {
                    let mut out = std::io::stdout().lock();
                    let _ = out.write_all(&encoded);
                    let _ = out.flush();
                }
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

fn spawn_cancel_watcher(cancel_event: HANDLE) -> std::thread::JoinHandle<()> {
    let wrapped = SendHandle(cancel_event);
    std::thread::spawn(move || {
        let taken = wrapped;
        let cancel_event = taken.0;
        let mut stdin = std::io::stdin().lock();
        match decode_frame(&mut stdin) {
            Ok(payload) => match serde_json::from_slice::<RunnerInboundFrame>(&payload) {
                Ok(RunnerInboundFrame::Cancel) | Err(_) => {
                    job::signal_cancel(cancel_event);
                }
            },
            // EOF on stdin means the adapter is gone (crash or close). The
            // Job Object KILL_ON_JOB_CLOSE backstop then terminates the
            // tree after we exit; signaling cancel here makes the shutdown
            // deterministic instead of waiting out the timeout.
            Err(_) => {
                job::signal_cancel(cancel_event);
            }
        }
    })
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
        let _ = windows::Win32::Foundation::SetHandleInformation(
            read,
            windows::Win32::Foundation::HANDLE_FLAG_INHERIT.0,
            windows::Win32::Foundation::HANDLE_FLAGS(0),
        );
        let _ = windows::Win32::Foundation::SetHandleInformation(
            write,
            windows::Win32::Foundation::HANDLE_FLAG_INHERIT.0,
            windows::Win32::Foundation::HANDLE_FLAG_INHERIT,
        );
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

#[cfg(test)]
mod tests {
    use super::*;
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
}
