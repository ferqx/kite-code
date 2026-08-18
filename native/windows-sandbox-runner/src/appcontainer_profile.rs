//! Lifecycle ownership for the strict Windows AppContainer candidate.
//!
//! A profile is an AppContainer security identity, never a Windows login
//! account. The strict backend creates one random profile for one invocation,
//! waits for its Job to be empty elsewhere, and then lets this owner delete
//! the profile. This module deliberately does not expose a process launch API
//! until the ACL and `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` paths have
//! native negative conformance coverage.

use std::ffi::c_void;
use std::ptr;

use windows::core::PCWSTR;
use windows::Win32::Security::Isolation::{CreateAppContainerProfile, DeleteAppContainerProfile};
use windows::Win32::Security::{
    CreateWellKnownSid, FreeSid, IsValidSid, WinCapabilityInternetClientSid, PSID,
    SECURITY_MAX_SID_SIZE, SID_AND_ATTRIBUTES,
};

use crate::acl;
use crate::job::{GENERIC_EXECUTE, GENERIC_READ, RUNTIME_ALLOW, WORKSPACE_ALLOW};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StrictAppContainerNetwork {
    Off,
    AllowAll,
}

/// The immutable identity plan is data-only so TypeScript transport decoding
/// can later bind it to the same invocation name before any native launch.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StrictAppContainerProfilePlan {
    pub name: String,
    pub network: StrictAppContainerNetwork,
}

pub fn strict_profile_plan(
    invocation_name: &str,
    network: StrictAppContainerNetwork,
) -> Result<StrictAppContainerProfilePlan, String> {
    if !valid_invocation_name(invocation_name) {
        return Err("strict_appcontainer_invocation_name_invalid".to_string());
    }
    let network_suffix = match network {
        StrictAppContainerNetwork::Off => "offline",
        StrictAppContainerNetwork::AllowAll => "online",
    };
    let invocation_suffix = invocation_name
        .strip_prefix("kitecode.")
        .expect("validated invocation name has prefix");
    Ok(StrictAppContainerProfilePlan {
        // AppContainer profile names have a short platform limit. The full
        // invocation identity remains in the framed request; this native
        // name only carries its unique 128-bit suffix and profile class.
        name: format!("KiteStrict-{network_suffix}-{invocation_suffix}"),
        network,
    })
}

/// Owns an AppContainer profile and its allocated SID. Dropping this value
/// deletes only the random invocation profile; cleanup callers must retain it
/// until the process Job, filesystem ACEs, and named handles are already gone.
pub struct TransientStrictAppContainerProfile {
    plan: StrictAppContainerProfilePlan,
    sid: PSID,
}

impl TransientStrictAppContainerProfile {
    pub fn create(plan: StrictAppContainerProfilePlan) -> Result<Self, String> {
        let name = wide(&plan.name);
        let display_name = wide("Kite Code strict shell invocation");
        let description = wide("Transient Kite Code AppContainer profile");
        let internet_capability = match plan.network {
            StrictAppContainerNetwork::Off => None,
            StrictAppContainerNetwork::AllowAll => Some(WellKnownSid::internet_client()?),
        };
        let capabilities = internet_capability.as_ref().map(|capability| {
            vec![SID_AND_ATTRIBUTES {
                Sid: capability.sid,
                Attributes: 0,
            }]
        });
        let sid = unsafe {
            CreateAppContainerProfile(
                PCWSTR(name.as_ptr()),
                PCWSTR(display_name.as_ptr()),
                PCWSTR(description.as_ptr()),
                capabilities.as_deref(),
            )
        }
        .map_err(|error| format!("strict_appcontainer_profile_create_failed: {error}"))?;
        if sid.0.is_null() || unsafe { !IsValidSid(sid).as_bool() } {
            if !sid.0.is_null() {
                unsafe {
                    let _ = FreeSid(sid);
                }
            }
            return Err("strict_appcontainer_profile_create_failed: invalid SID".to_string());
        }
        Ok(Self { plan, sid })
    }

    pub fn name(&self) -> &str {
        &self.plan.name
    }

    pub fn sid(&self) -> PSID {
        self.sid
    }

    pub fn network(&self) -> StrictAppContainerNetwork {
        self.plan.network
    }
}

impl Drop for TransientStrictAppContainerProfile {
    fn drop(&mut self) {
        let name = wide(&self.plan.name);
        unsafe {
            let _ = DeleteAppContainerProfile(PCWSTR(name.as_ptr()));
            if !self.sid.0.is_null() {
                let _ = FreeSid(self.sid);
                self.sid = PSID(ptr::null_mut());
            }
        }
    }
}

/// Invocation-scoped direct-Workspace ACL grants for the strict profile.
/// The profile is never retained beyond this lease. Callers must drop the
/// lease only after the AppContainer Job has confirmed zero active processes.
pub struct StrictAppContainerAclLease {
    sid: PSID,
    granted: Vec<String>,
}

impl StrictAppContainerAclLease {
    pub fn acquire(
        profile: &TransientStrictAppContainerProfile,
        workspace_root: &str,
        runtime_root: &str,
        shell_runtime_root: &str,
    ) -> Result<Self, String> {
        let mut lease = Self {
            sid: profile.sid(),
            granted: Vec::new(),
        };
        for (path, access) in [
            (workspace_root, WORKSPACE_ALLOW),
            (runtime_root, RUNTIME_ALLOW),
            (shell_runtime_root, GENERIC_READ | GENERIC_EXECUTE),
        ] {
            if let Err(error) = acl::grant_access(path, lease.sid, access) {
                let cleanup = lease.finish();
                return Err(match cleanup {
                    Ok(()) => format!("strict_appcontainer_acl_grant_failed: {error}"),
                    Err(cleanup_error) => format!(
                        "strict_appcontainer_acl_grant_failed: {error}; cleanup failed: {cleanup_error}"
                    ),
                });
            }
            lease.granted.push(path.to_string());
        }
        Ok(lease)
    }

    pub fn finish(&mut self) -> Result<(), String> {
        let mut failures = Vec::new();
        for path in self.granted.drain(..).rev() {
            if let Err(error) = acl::revoke_access(&path, self.sid) {
                failures.push(error.to_string());
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "strict_appcontainer_acl_cleanup_failed: {}",
                failures.join("; ")
            ))
        }
    }
}

impl Drop for StrictAppContainerAclLease {
    fn drop(&mut self) {
        let _ = self.finish();
    }
}

struct WellKnownSid {
    _storage: Vec<usize>,
    sid: PSID,
}

impl WellKnownSid {
    fn internet_client() -> Result<Self, String> {
        let bytes = SECURITY_MAX_SID_SIZE as usize;
        let mut storage = vec![0usize; bytes.div_ceil(std::mem::size_of::<usize>())];
        let sid = PSID(storage.as_mut_ptr().cast::<c_void>());
        let mut written = bytes as u32;
        unsafe {
            CreateWellKnownSid(
                WinCapabilityInternetClientSid,
                PSID(ptr::null_mut()),
                sid,
                &mut written,
            )
        }
        .map_err(|error| format!("strict_appcontainer_capability_sid_failed: {error}"))?;
        if written == 0 || written as usize > bytes || unsafe { !IsValidSid(sid).as_bool() } {
            return Err("strict_appcontainer_capability_sid_failed: invalid SID".to_string());
        }
        Ok(Self {
            _storage: storage,
            sid,
        })
    }
}

fn valid_invocation_name(value: &str) -> bool {
    let suffix = value.strip_prefix("kitecode.").unwrap_or("");
    suffix.len() == 32 && suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::c_void;
    use std::fs::{create_dir_all, remove_dir_all};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, GetLastError, HANDLE};
    use windows::Win32::Security::{
        GetTokenInformation, TokenCapabilities, TokenIsAppContainer, SECURITY_CAPABILITIES,
        TOKEN_GROUPS, TOKEN_QUERY,
    };
    use windows::Win32::System::JobObjects::AssignProcessToJobObject;
    use windows::Win32::System::Threading::{
        CreateProcessW, DeleteProcThreadAttributeList, InitializeProcThreadAttributeList,
        OpenProcessToken, ResumeThread, UpdateProcThreadAttribute, WaitForSingleObject,
        CREATE_SUSPENDED, EXTENDED_STARTUPINFO_PRESENT, INFINITE, LPPROC_THREAD_ATTRIBUTE_LIST,
        PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, STARTUPINFOEXW,
    };

    #[test]
    fn plans_distinct_offline_and_approved_network_profiles() {
        let invocation = "kitecode.0123456789abcdef0123456789abcdef";
        let offline = strict_profile_plan(invocation, StrictAppContainerNetwork::Off).unwrap();
        let online = strict_profile_plan(invocation, StrictAppContainerNetwork::AllowAll).unwrap();
        assert_ne!(offline.name, online.name);
        assert_ne!(offline.network, online.network);
    }

    #[test]
    fn rejects_unbound_or_noncanonical_profile_names() {
        assert!(strict_profile_plan("kitecode.short", StrictAppContainerNetwork::Off).is_err());
        assert!(strict_profile_plan(
            "other.0123456789abcdef0123456789abcdef",
            StrictAppContainerNetwork::Off
        )
        .is_err());
    }

    #[test]
    fn creates_and_deletes_an_offline_appcontainer_profile_without_a_login_account() {
        let invocation = format!("kitecode.{:032x}", unique_test_suffix());
        let plan = strict_profile_plan(&invocation, StrictAppContainerNetwork::Off).unwrap();
        let name = plan.name.clone();
        let profile = TransientStrictAppContainerProfile::create(plan).unwrap();
        assert_eq!(profile.name(), name);
        assert_eq!(profile.network(), StrictAppContainerNetwork::Off);
        assert!(!profile.sid().0.is_null());
        drop(profile);
    }

    #[test]
    fn lease_grants_and_revokes_only_invocation_directories() {
        let invocation = format!("kitecode.{:032x}", unique_test_suffix());
        let profile = TransientStrictAppContainerProfile::create(
            strict_profile_plan(&invocation, StrictAppContainerNetwork::Off).unwrap(),
        )
        .unwrap();
        let root = std::env::temp_dir().join(format!("kite-strict-acl-{}", unique_test_suffix()));
        let workspace = root.join("workspace");
        let runtime = root.join("runtime");
        let shell = root.join("shell");
        create_dir_all(&workspace).unwrap();
        create_dir_all(&runtime).unwrap();
        create_dir_all(&shell).unwrap();
        let mut lease = StrictAppContainerAclLease::acquire(
            &profile,
            &path_string(&workspace),
            &path_string(&runtime),
            &path_string(&shell),
        )
        .unwrap();
        lease.finish().unwrap();
        drop(lease);
        drop(profile);
        remove_dir_all(root).unwrap();
    }

    #[test]
    fn starts_a_process_with_the_offline_appcontainer_security_capability() {
        let invocation = format!("kitecode.{:032x}", unique_test_suffix());
        let plan = strict_profile_plan(&invocation, StrictAppContainerNetwork::Off).unwrap();
        let profile = TransientStrictAppContainerProfile::create(plan).unwrap();
        let system_root = std::env::var("SystemRoot").expect("SystemRoot is available on Windows");
        let executable = format!(r"{system_root}\System32\cmd.exe");
        let command = format!(r#""{executable}" /d /c exit 0"#);
        let mut command_w = wide(&command);
        let mut bytes = 0usize;
        unsafe {
            let _ = InitializeProcThreadAttributeList(
                LPPROC_THREAD_ATTRIBUTE_LIST(ptr::null_mut()),
                1,
                0,
                &mut bytes,
            );
        }
        assert!(bytes > 0, "attribute-list size query failed: {}", unsafe {
            GetLastError().0
        });
        let mut storage = vec![0u8; bytes];
        let attributes = LPPROC_THREAD_ATTRIBUTE_LIST(storage.as_mut_ptr().cast::<c_void>());
        unsafe { InitializeProcThreadAttributeList(attributes, 1, 0, &mut bytes) }
            .expect("initialize attribute list");
        let mut capabilities = SECURITY_CAPABILITIES {
            AppContainerSid: profile.sid(),
            Capabilities: ptr::null_mut(),
            CapabilityCount: 0,
            Reserved: 0,
        };
        unsafe {
            UpdateProcThreadAttribute(
                attributes,
                0,
                PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
                Some((&mut capabilities as *mut SECURITY_CAPABILITIES).cast::<c_void>()),
                std::mem::size_of::<SECURITY_CAPABILITIES>(),
                None,
                None,
            )
        }
        .expect("set AppContainer security capability");
        let startup = STARTUPINFOEXW {
            StartupInfo: Default::default(),
            lpAttributeList: attributes,
        };
        let mut startup = startup;
        startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        let mut process = PROCESS_INFORMATION::default();
        let created = unsafe {
            CreateProcessW(
                None,
                PWSTR(command_w.as_mut_ptr()),
                None,
                None,
                false,
                CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT,
                None,
                PCWSTR::null(),
                &startup.StartupInfo,
                &mut process,
            )
        };
        unsafe {
            DeleteProcThreadAttributeList(attributes);
        }
        created.expect("create offline AppContainer process");
        assert_ne!(process.hProcess, HANDLE::default());
        assert_ne!(process.hThread, HANDLE::default());
        let mut token = HANDLE::default();
        unsafe { OpenProcessToken(process.hProcess, TOKEN_QUERY, &mut token) }
            .expect("open AppContainer child token");
        let mut is_appcontainer = 0u32;
        let mut returned = 0u32;
        unsafe {
            GetTokenInformation(
                token,
                TokenIsAppContainer,
                Some((&mut is_appcontainer as *mut u32).cast::<c_void>()),
                std::mem::size_of::<u32>() as u32,
                &mut returned,
            )
        }
        .expect("query AppContainer child token");
        let mut capability_storage = vec![0u8; std::mem::size_of::<TOKEN_GROUPS>()];
        unsafe {
            GetTokenInformation(
                token,
                TokenCapabilities,
                Some(capability_storage.as_mut_ptr().cast::<c_void>()),
                capability_storage.len() as u32,
                &mut returned,
            )
        }
        .expect("query offline AppContainer capabilities");
        let capability_groups = unsafe { &*(capability_storage.as_ptr().cast::<TOKEN_GROUPS>()) };
        assert_eq!(
            capability_groups.GroupCount, 0,
            "offline AppContainer child must carry no network capability",
        );
        unsafe {
            let _ = CloseHandle(token);
        }
        assert_ne!(is_appcontainer, 0, "child must carry an AppContainer token");
        let job = crate::job::create_job(1).expect("create strict AppContainer Job");
        unsafe { AssignProcessToJobObject(job, process.hProcess) }
            .expect("assign AppContainer child to Job before resume");
        assert_ne!(unsafe { ResumeThread(process.hThread) }, u32::MAX);
        assert_eq!(
            unsafe { WaitForSingleObject(process.hProcess, INFINITE) }.0,
            0
        );
        unsafe {
            let _ = CloseHandle(process.hThread);
            let _ = CloseHandle(process.hProcess);
            let _ = CloseHandle(job);
        }
        drop(profile);
    }

    fn unique_test_suffix() -> u128 {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock after Unix epoch")
            .as_nanos();
        nanos ^ u128::from(std::process::id()) ^ u128::from(COUNTER.fetch_add(1, Ordering::Relaxed))
    }

    fn path_string(path: &PathBuf) -> String {
        path.to_string_lossy().to_string()
    }
}
