//! Job Object lifecycle and cancellation primitives shared by Windows sandbox invocations.

use windows::Win32::Foundation::{CloseHandle, GetLastError, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows::Win32::System::JobObjects::{
    CreateJobObjectW, JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation,
    QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_ACTIVE_PROCESS, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows::Win32::System::Threading::{
    CreateEventW, GetExitCodeProcess, SetEvent, WaitForMultipleObjects,
};

pub const GENERIC_READ: u32 = 0x8000_0000;
pub const GENERIC_WRITE: u32 = 0x4000_0000;
pub const GENERIC_EXECUTE: u32 = 0x2000_0000;
pub const GENERIC_ALL: u32 = 0x1000_0000;
pub const DELETE: u32 = 0x0001_0000;
pub const WORKSPACE_ALLOW: u32 = GENERIC_READ | GENERIC_WRITE | GENERIC_EXECUTE | DELETE;
pub const WORKSPACE_READ_ONLY: u32 = GENERIC_READ | GENERIC_EXECUTE;
pub const RUNTIME_ALLOW: u32 = GENERIC_ALL;

#[derive(Debug)]
pub struct JobError {
    pub code: String,
    pub message: String,
}

impl std::fmt::Display for JobError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for JobError {}

fn error(code: &str, message: impl Into<String>) -> JobError {
    JobError {
        code: code.to_string(),
        message: message.into(),
    }
}

pub fn create_job(max_processes: u32) -> Result<HANDLE, JobError> {
    if max_processes == 0 {
        return Err(error(
            "job_create_failed",
            "max process count must be positive",
        ));
    }
    unsafe {
        let job = CreateJobObjectW(None, None)
            .map_err(|source| error("job_create_failed", source.to_string()))?;
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        info.BasicLimitInformation.ActiveProcessLimit = max_processes;
        if let Err(source) = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION as *const core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ) {
            let _ = CloseHandle(job);
            return Err(error("job_create_failed", source.to_string()));
        }
        Ok(job)
    }
}

pub fn create_cancel_event() -> Result<HANDLE, JobError> {
    unsafe {
        CreateEventW(None, true, false, None)
            .map_err(|source| error("cancel_event_failed", source.to_string()))
    }
}

pub fn signal_cancel(event: HANDLE) {
    unsafe {
        let _ = SetEvent(event);
    }
}

pub fn wait_for_process(
    process: HANDLE,
    cancel: HANDLE,
    timeout_ms: Option<u64>,
) -> Result<(bool, bool), JobError> {
    unsafe {
        let deadline = timeout_ms
            .map(|timeout| std::time::Instant::now() + std::time::Duration::from_millis(timeout));
        loop {
            let wait_ms = deadline.map_or(u32::MAX, |deadline| {
                let remaining = deadline.saturating_duration_since(std::time::Instant::now());
                remaining.as_millis().min((u32::MAX - 1) as u128) as u32
            });
            let result = WaitForMultipleObjects(&[process, cancel], false, wait_ms);
            if result == WAIT_OBJECT_0 {
                return Ok((false, false));
            }
            if result.0 == WAIT_OBJECT_0.0 + 1 {
                return Ok((false, true));
            }
            if result == WAIT_TIMEOUT {
                if deadline.is_some_and(|deadline| std::time::Instant::now() >= deadline) {
                    return Ok((true, false));
                }
                continue;
            }
            return Err(error(
                "wait_failed",
                format!(
                    "WaitForMultipleObjects failed with Win32 error {}",
                    GetLastError().0
                ),
            ));
        }
    }
}

pub struct JobTermination {
    pub active_before: Option<u32>,
    pub active_after: Option<u32>,
    pub initial_query_error: Option<i32>,
    pub terminate_error: Option<i32>,
    pub last_query_error: Option<i32>,
}

impl JobTermination {
    pub fn confirmed(&self) -> bool {
        self.active_after == Some(0)
    }
}

fn query_job_accounting(job: HANDLE) -> Result<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, i32> {
    let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
    unsafe {
        QueryInformationJobObject(
            job,
            JobObjectBasicAccountingInformation,
            (&mut accounting as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
            std::mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
            None,
        )
    }
    .map_err(|error| error.code().0)?;
    Ok(accounting)
}

pub fn terminate_job_and_confirm(job: HANDLE, timeout_ms: u32) -> JobTermination {
    let initial = query_job_accounting(job);
    let mut result = JobTermination {
        active_before: initial.as_ref().ok().map(|value| value.ActiveProcesses),
        active_after: None,
        initial_query_error: initial.err(),
        terminate_error: unsafe { TerminateJobObject(job, 0) }
            .err()
            .map(|error| error.code().0),
        last_query_error: None,
    };
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms as u64);
    loop {
        result.active_after = match query_job_accounting(job) {
            Ok(accounting) => Some(accounting.ActiveProcesses),
            Err(error) => {
                result.last_query_error = Some(error);
                None
            }
        };
        // A successful termination request alone cannot prove the tree is empty.
        if result.confirmed() || std::time::Instant::now() >= deadline {
            return result;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

pub fn job_peak_processes(job: HANDLE) -> u32 {
    query_job_accounting(job).map_or(0, |accounting| accounting.TotalProcesses)
}

pub fn child_exit_code(process: HANDLE) -> Result<u32, i32> {
    let mut code = 0;
    unsafe { GetExitCodeProcess(process, &mut code) }.map_err(|error| error.code().0)?;
    Ok(code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constants_are_declared() {
        assert_ne!(JOB_OBJECT_LIMIT_ACTIVE_PROCESS.0, 0);
        assert_ne!(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.0, 0);
    }

    #[test]
    fn wrong_object_type_does_not_prove_an_empty_job() {
        // A null Job handle would query the enclosing Job on Windows.
        let event = create_cancel_event().unwrap();
        let result = terminate_job_and_confirm(event, 0);
        unsafe { CloseHandle(event) }.unwrap();
        assert_eq!(result.active_before, None);
        assert_eq!(result.active_after, None);
        assert!(result.initial_query_error.is_some());
        assert!(result.terminate_error.is_some());
        assert!(result.last_query_error.is_some());
        assert!(!result.confirmed());
    }

    #[test]
    fn exit_code_query_preserves_access_denied() {
        use windows::Win32::Foundation::ERROR_ACCESS_DENIED;
        use windows::Win32::System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE};

        let process =
            unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, std::process::id()) }.unwrap();
        let exit = child_exit_code(process);
        unsafe { CloseHandle(process) }.unwrap();
        assert_eq!(exit, Err(ERROR_ACCESS_DENIED.to_hresult().0));
    }
}
