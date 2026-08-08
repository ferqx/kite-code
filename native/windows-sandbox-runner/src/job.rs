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
    timeout_ms: u64,
) -> Result<(bool, bool), JobError> {
    unsafe {
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            let wait_ms = remaining.as_millis().min(u32::MAX as u128) as u32;
            let result = WaitForMultipleObjects(&[process, cancel], false, wait_ms);
            if result == WAIT_OBJECT_0 {
                return Ok((false, false));
            }
            if result.0 == WAIT_OBJECT_0.0 + 1 {
                return Ok((false, true));
            }
            if result == WAIT_TIMEOUT {
                if std::time::Instant::now() >= deadline {
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

pub fn terminate_job_and_confirm(job: HANDLE, timeout_ms: u32) -> Result<bool, JobError> {
    unsafe {
        let _ = TerminateJobObject(job, 0);
        let deadline =
            std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms as u64);
        loop {
            let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
            if QueryInformationJobObject(
                job,
                JobObjectBasicAccountingInformation,
                &mut accounting as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
                    as *mut core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                None,
            )
            .is_ok()
                && accounting.ActiveProcesses == 0
            {
                return Ok(true);
            }
            if std::time::Instant::now() >= deadline {
                return Ok(false);
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }
}

pub fn job_peak_processes(job: HANDLE) -> u32 {
    unsafe {
        let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        if QueryInformationJobObject(
            job,
            JobObjectBasicAccountingInformation,
            &mut accounting as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
                as *mut core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
            None,
        )
        .is_ok()
        {
            accounting.TotalProcesses
        } else {
            0
        }
    }
}

pub fn child_exit_code(process: HANDLE) -> u32 {
    unsafe {
        let mut code = 0;
        if GetExitCodeProcess(process, &mut code).is_ok() {
            code
        } else {
            0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constants_are_declared() {
        assert_ne!(JOB_OBJECT_LIMIT_ACTIVE_PROCESS.0, 0);
        assert_ne!(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.0, 0);
    }
}
