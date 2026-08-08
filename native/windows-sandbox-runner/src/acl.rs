//! NTFS DACL manipulation for Windows sandbox filesystem enforcement.

use windows::core::PCWSTR;
use windows::Win32::Foundation::{LocalFree, HLOCAL, WIN32_ERROR};
use windows::Win32::Security::Authorization::{
    GetNamedSecurityInfoW, SetNamedSecurityInfoW, SE_FILE_OBJECT,
};
use windows::Win32::Security::{
    AclSizeInformation, AddAccessAllowedAceEx, AddAccessDeniedAceEx, AddAce, GetAce,
    GetAclInformation, GetLengthSid, GetSecurityDescriptorLength, InitializeAcl, IsValidAcl,
    IsValidSid, SetFileSecurityW, ACE_FLAGS, ACL, ACL_REVISION, ACL_SIZE_INFORMATION,
    CONTAINER_INHERIT_ACE, DACL_SECURITY_INFORMATION, OBJECT_INHERIT_ACE,
    PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID,
};

pub const ACCESS_ALLOWED_ACE_TYPE: u8 = 0x00;
pub const ACCESS_DENIED_ACE_TYPE: u8 = 0x01;

pub const CONTAINER_AND_OBJECT_INHERIT: u32 = CONTAINER_INHERIT_ACE.0 | OBJECT_INHERIT_ACE.0;

#[derive(Debug)]
pub struct AclError {
    pub path: String,
    pub message: String,
}

impl std::fmt::Display for AclError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "ACL error on '{}': {}", self.path, self.message)
    }
}

impl std::error::Error for AclError {}

#[derive(Debug, Clone)]
pub struct DaclSnapshot {
    pub path: String,
    pub descriptor: Vec<u8>,
}

fn wide(path: &str) -> Vec<u16> {
    path.encode_utf16().chain(std::iter::once(0)).collect()
}

fn win32_ok(result: WIN32_ERROR, operation: &str, path: &str) -> Result<(), AclError> {
    if result.0 == 0 {
        Ok(())
    } else {
        Err(AclError {
            path: path.to_string(),
            message: format!("{operation} failed with Win32 error {}", result.0),
        })
    }
}

/// Read the ACE `AceSize` field (u16 at offset 2) from a raw ACE pointer.
fn ace_size_bytes(ace: *const core::ffi::c_void) -> usize {
    unsafe {
        let bytes = ace as *const u8;
        u16::from_le_bytes([*bytes.add(2), *bytes.add(3)]) as usize
    }
}

/// Byte representation of a SID (canonical SIDs compare byte-for-byte).
fn sid_bytes(sid: PSID) -> Vec<u8> {
    unsafe {
        let length = GetLengthSid(sid) as usize;
        let mut bytes = vec![0u8; length];
        std::ptr::copy_nonoverlapping(sid.0 as *const u8, bytes.as_mut_ptr(), length);
        bytes
    }
}

/// Extract the SID bytes from a variable-length ACE whose header+mask are
/// both 4 bytes (ACCESS_ALLOWED_ACE / ACCESS_DENIED_ACE).
fn ace_sid_bytes(ace: &[u8]) -> Option<Vec<u8>> {
    let ace_size = u16::from_le_bytes([ace[2], ace[3]]) as usize;
    if ace.len() < ace_size || ace_size < 8 {
        return None;
    }
    Some(ace[8..ace_size].to_vec())
}

fn ace_matches_sid_and_type(ace: &[u8], target_sid: &[u8], ace_type: u8) -> bool {
    ace.len() >= 8
        && ace[0] == ace_type
        && ace_sid_bytes(ace)
            .map(|bytes| bytes == target_sid)
            .unwrap_or(false)
}

#[derive(Debug, Default)]
struct DaclState {
    ace_count: u32,
    acl_bytes_in_use: u32,
}

fn read_dacl_state(dacl: *const ACL) -> Option<DaclState> {
    unsafe {
        if dacl.is_null() || !IsValidAcl(dacl).as_bool() {
            return None;
        }
        let mut info = ACL_SIZE_INFORMATION::default();
        if GetAclInformation(
            dacl,
            &mut info as *mut ACL_SIZE_INFORMATION as *mut core::ffi::c_void,
            std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
            AclSizeInformation,
        )
        .is_err()
        {
            return None;
        }
        Some(DaclState {
            ace_count: info.AceCount,
            acl_bytes_in_use: info.AclBytesInUse,
        })
    }
}

/// Fetch the current DACL for a filesystem path. Returns the DACL pointer,
/// the owner/group pointers, and the security descriptor (all freed with
/// `LocalFree`).
unsafe fn get_path_dacl(path: &str) -> Result<(*mut ACL, PSID, PSID, HLOCAL), AclError> {
    let path_wide = wide(path);
    let mut owner: PSID = PSID(std::ptr::null_mut());
    let mut group: PSID = PSID(std::ptr::null_mut());
    let mut dacl: *mut ACL = std::ptr::null_mut();
    let mut sacl: *mut ACL = std::ptr::null_mut();
    let mut descriptor: PSECURITY_DESCRIPTOR = PSECURITY_DESCRIPTOR(std::ptr::null_mut());
    let result = GetNamedSecurityInfoW(
        PCWSTR(path_wide.as_ptr()),
        SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION,
        Some(&mut owner),
        Some(&mut group),
        Some(&mut dacl),
        Some(&mut sacl),
        &mut descriptor,
    );
    win32_ok(result, "GetNamedSecurityInfoW", path)?;
    Ok((dacl, owner, group, HLOCAL(descriptor.0)))
}

pub fn snapshot_dacl(path: &str) -> Result<DaclSnapshot, AclError> {
    unsafe {
        let (_, _, _, descriptor) = get_path_dacl(path)?;
        let source = PSECURITY_DESCRIPTOR(descriptor.0);
        let length = GetSecurityDescriptorLength(source) as usize;
        if length == 0 {
            let _ = LocalFree(descriptor);
            return Err(AclError {
                path: path.to_string(),
                message: "security descriptor has zero length".to_string(),
            });
        }
        let mut bytes = vec![0u8; length];
        std::ptr::copy_nonoverlapping(descriptor.0 as *const u8, bytes.as_mut_ptr(), length);
        let _ = LocalFree(descriptor);
        Ok(DaclSnapshot {
            path: path.to_string(),
            descriptor: bytes,
        })
    }
}

pub fn restore_dacl_snapshot(snapshot: &DaclSnapshot) -> Result<(), AclError> {
    unsafe {
        SetFileSecurityW(
            PCWSTR(wide(&snapshot.path).as_ptr()),
            DACL_SECURITY_INFORMATION,
            PSECURITY_DESCRIPTOR(snapshot.descriptor.as_ptr() as *mut core::ffi::c_void),
        )
        .ok()
        .map_err(|error| AclError {
            path: snapshot.path.clone(),
            message: format!("SetFileSecurityW restore failed: {error}"),
        })
    }
}

/// Check whether the current DACL contains an ACE of the requested type for
/// this ledger-owned synthetic SID. Windows can canonicalize one inheritable
/// directory grant into separate effective and inherit-only ACEs, so matching
/// the pre-canonicalization mask/flags would cause every invocation to rewrite
/// the whole Workspace DACL. This is an idempotency marker for crash recovery,
/// not a host-tamper detector: the ledger is marked ready only after the atomic
/// DACL writes complete, and ACL edits made later by the trusted host require
/// explicit repair/reinitialization.
pub fn has_ace_for_sid(path: &str, sid: PSID, ace_type: u8) -> Result<bool, AclError> {
    unsafe {
        let (dacl, _, _, descriptor) = get_path_dacl(path)?;
        if dacl.is_null() {
            let _ = LocalFree(descriptor);
            return Err(AclError {
                path: path.to_string(),
                message: "refusing to inspect a NULL DACL; sandbox setup fails closed".to_string(),
            });
        }
        let result = (|| -> Result<bool, AclError> {
            let count = read_dacl_state(dacl)
                .ok_or_else(|| AclError {
                    path: path.to_string(),
                    message: "unable to read DACL state".to_string(),
                })?
                .ace_count;
            let target_sid = sid_bytes(sid);
            for index in 0..count {
                let mut ace: *mut core::ffi::c_void = std::ptr::null_mut();
                GetAce(dacl, index, &mut ace).map_err(|error| AclError {
                    path: path.to_string(),
                    message: format!("GetAce failed: {error}"),
                })?;
                let bytes = std::slice::from_raw_parts(ace as *const u8, ace_size_bytes(ace));
                if ace_matches_sid_and_type(bytes, &target_sid, ace_type) {
                    return Ok(true);
                }
            }
            Ok(false)
        })();
        let _ = LocalFree(descriptor);
        result
    }
}

fn align4(value: usize) -> u32 {
    ((value + 3) & !3) as u32
}

/// Append an existing ACE through the Windows ACL API. Writing the bytes into
/// the buffer directly leaves `AclSize`/`AceCount` at the empty values set by
/// `InitializeAcl`, so subsequent AddAccess* calls overwrite the copied data.
fn append_ace(
    dacl: *mut ACL,
    ace: *const core::ffi::c_void,
    ace_size: usize,
    path: &str,
) -> Result<(), AclError> {
    unsafe {
        AddAce(dacl, ACL_REVISION, u32::MAX, ace, ace_size as u32).map_err(|error| AclError {
            path: path.to_string(),
            message: format!("AddAce failed: {error}"),
        })
    }
}

/// Rewrite `path`'s DACL as the existing ACEs minus any ACE referencing `sid`,
/// plus one new allow/deny ACE. Idempotent: re-grants cannot accumulate.
fn write_dacl_with_ace(
    path: &str,
    sid: PSID,
    access: u32,
    flags: u32,
    ace_type: u8,
    security_information: windows::Win32::Security::OBJECT_SECURITY_INFORMATION,
) -> Result<(), AclError> {
    unsafe {
        let (existing_dacl, owner, group, descriptor) = get_path_dacl(path)?;
        if existing_dacl.is_null() {
            let _ = LocalFree(descriptor);
            return Err(AclError {
                path: path.to_string(),
                message: "refusing to modify a NULL DACL; sandbox setup fails closed".to_string(),
            });
        }
        let state = read_dacl_state(existing_dacl).unwrap_or_default();
        let sid_length = GetLengthSid(sid) as usize;
        let new_ace_size = 8 + align4(sid_length) as usize;
        let total_size =
            state.acl_bytes_in_use as usize + new_ace_size + std::mem::size_of::<ACL>();
        let mut buffer = vec![0u8; total_size];
        let new_dacl = buffer.as_mut_ptr() as *mut ACL;
        if let Err(error) = InitializeAcl(new_dacl, total_size as u32, ACL_REVISION) {
            let _ = LocalFree(descriptor);
            return Err(AclError {
                path: path.to_string(),
                message: format!("InitializeAcl failed: {error}"),
            });
        }

        if ace_type == ACCESS_DENIED_ACE_TYPE {
            if let Err(error) =
                AddAccessDeniedAceEx(new_dacl, ACL_REVISION, ACE_FLAGS(flags), access, sid)
            {
                let _ = LocalFree(descriptor);
                return Err(AclError {
                    path: path.to_string(),
                    message: format!("AddAccessDeniedAceEx failed: {error}"),
                });
            }
        }

        let target_sid = sid_bytes(sid);
        if !existing_dacl.is_null() {
            let count = read_dacl_state(existing_dacl)
                .map(|state| state.ace_count)
                .unwrap_or(0);
            for index in 0..count {
                let mut ace: *mut core::ffi::c_void = std::ptr::null_mut();
                if GetAce(existing_dacl, index, &mut ace).is_err() {
                    continue;
                }
                let ace_bytes = std::slice::from_raw_parts(ace as *const u8, ace_size_bytes(ace));
                let matches = ace_sid_bytes(ace_bytes)
                    .map(|bytes| bytes == target_sid)
                    .unwrap_or(false);
                // The invocation SID is unique; remove any stale ACE for it
                // before adding the one canonical grant below.
                if matches {
                    continue;
                }
                append_ace(new_dacl, ace, ace_bytes.len(), path)?;
            }
        }

        let result = if ace_type == ACCESS_ALLOWED_ACE_TYPE {
            AddAccessAllowedAceEx(new_dacl, ACL_REVISION, ACE_FLAGS(flags), access, sid)
        } else {
            Ok(())
        };
        if let Err(error) = result {
            let _ = LocalFree(descriptor);
            let operation = if ace_type == ACCESS_ALLOWED_ACE_TYPE {
                "AddAccessAllowedAceEx"
            } else {
                "AddAccessDeniedAceEx"
            };
            return Err(AclError {
                path: path.to_string(),
                message: format!("{operation} failed: {error}"),
            });
        }

        let set_result = SetNamedSecurityInfoW(
            PCWSTR(wide(path).as_ptr()),
            SE_FILE_OBJECT,
            security_information,
            owner,
            group,
            Some(new_dacl as *const ACL),
            None,
        );
        let _ = LocalFree(descriptor);
        win32_ok(set_result, "SetNamedSecurityInfoW", path)
    }
}

/// Grant a sandbox capability SID `access` on `path` (idempotent allow).
pub fn grant_access(path: &str, sid: PSID, access: u32) -> Result<(), AclError> {
    write_dacl_with_ace(
        path,
        sid,
        access,
        CONTAINER_AND_OBJECT_INHERIT,
        ACCESS_ALLOWED_ACE_TYPE,
        DACL_SECURITY_INFORMATION,
    )
}

/// Grant a normal identity access to one path without propagating the ACE to
/// descendants. This is used for directory traversal along an invocation's
/// already-authorized roots.
pub fn grant_identity_access(path: &str, sid: PSID, access: u32) -> Result<(), AclError> {
    write_dacl_with_ace(
        path,
        sid,
        access,
        0,
        ACCESS_ALLOWED_ACE_TYPE,
        DACL_SECURITY_INFORMATION,
    )
}

/// Exclude a sandbox capability SID from a protected path's effective DACL.
///
/// The restricted token retains the caller's normal user groups as well as
/// a restricted capability SID. A deny ACE for only the restricted SID does
/// not reliably override an inherited parent allow through the restricted
/// access check. Instead, protect the DACL, remove the inherited invocation
/// SID grant, and add a zero-mask deny marker. The marker is access-neutral
/// but lets cleanup distinguish our protected DACL from a pre-existing one.
pub fn deny_access(path: &str, sid: PSID, access: u32) -> Result<(), AclError> {
    let _ = access;
    write_dacl_with_ace(
        path,
        sid,
        0,
        0,
        ACCESS_DENIED_ACE_TYPE,
        DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
    )
}

/// Deny a normal user SID `access` on `path` without changing inheritance.
///
/// The managed Online account is the primary identity used by the access
/// check. An explicit deny ACE therefore
/// reliably overrides inherited group grants, and removing that one ACE at
/// lease cleanup restores the original inherited DACL shape.
pub fn deny_identity_access(path: &str, sid: PSID, access: u32) -> Result<(), AclError> {
    write_dacl_with_ace(
        path,
        sid,
        access,
        0,
        ACCESS_DENIED_ACE_TYPE,
        DACL_SECURITY_INFORMATION,
    )
}

/// Remove every ACE referencing `sid` from `path`'s DACL and restore it.
pub fn revoke_access(path: &str, sid: PSID) -> Result<(), AclError> {
    unsafe {
        let (existing_dacl, owner, group, descriptor) = get_path_dacl(path)?;
        if existing_dacl.is_null() {
            let _ = LocalFree(descriptor);
            return Err(AclError {
                path: path.to_string(),
                message: "refusing to rewrite a NULL DACL during cleanup".to_string(),
            });
        }
        let state = read_dacl_state(existing_dacl).unwrap_or_default();
        let total_size = state.acl_bytes_in_use as usize + std::mem::size_of::<ACL>();
        let mut buffer = vec![0u8; total_size];
        let new_dacl = buffer.as_mut_ptr() as *mut ACL;
        if let Err(error) = InitializeAcl(new_dacl, total_size as u32, ACL_REVISION) {
            let _ = LocalFree(descriptor);
            return Err(AclError {
                path: path.to_string(),
                message: format!("InitializeAcl failed: {error}"),
            });
        }

        let target_sid = sid_bytes(sid);
        let mut removed_any = false;
        if !existing_dacl.is_null() {
            let count = read_dacl_state(existing_dacl)
                .map(|state| state.ace_count)
                .unwrap_or(0);
            for index in 0..count {
                let mut ace: *mut core::ffi::c_void = std::ptr::null_mut();
                if GetAce(existing_dacl, index, &mut ace).is_err() {
                    continue;
                }
                let ace_size = ace_size_bytes(ace);
                let ace_bytes = std::slice::from_raw_parts(ace as *const u8, ace_size);
                let matches = ace_sid_bytes(ace_bytes)
                    .map(|bytes| bytes == target_sid)
                    .unwrap_or(false);
                if matches {
                    removed_any = true;
                    continue;
                }
                append_ace(new_dacl, ace, ace_size, path)?;
            }
        }

        // A crash-recovery retry must not rewrite a host DACL when this
        // invocation never reached the corresponding grant step.
        if !removed_any {
            let _ = LocalFree(descriptor);
            return Ok(());
        }

        let set_result = SetNamedSecurityInfoW(
            PCWSTR(wide(path).as_ptr()),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            owner,
            group,
            Some(new_dacl as *const ACL),
            None,
        );
        let _ = LocalFree(descriptor);
        win32_ok(set_result, "SetNamedSecurityInfoW", path)
    }
}

/// Verify a SID pointer is valid (safety net before writing it into a DACL).
pub fn validate_sid(sid: PSID) -> bool {
    unsafe { !sid.0.is_null() && IsValidSid(sid).as_bool() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ace_sid_bytes_extracts_after_header_and_mask() {
        let sid = [9u8, 1, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 1, 2, 3, 4];
        let mut ace = Vec::new();
        ace.push(ACCESS_ALLOWED_ACE_TYPE);
        ace.push(0);
        ace.extend_from_slice(&((8 + sid.len()) as u16).to_le_bytes());
        ace.extend_from_slice(&[0u8; 4]);
        ace.extend_from_slice(&sid);
        assert_eq!(ace_sid_bytes(&ace).unwrap(), sid);
    }

    #[test]
    fn ace_matching_checks_type_and_ledger_owned_sid() {
        let sid = [1u8, 2, 3, 4];
        let mut ace = vec![ACCESS_ALLOWED_ACE_TYPE, 3];
        ace.extend_from_slice(&((8 + sid.len()) as u16).to_le_bytes());
        ace.extend_from_slice(&0x1234_5678u32.to_le_bytes());
        ace.extend_from_slice(&sid);
        assert!(ace_matches_sid_and_type(
            &ace,
            &sid,
            ACCESS_ALLOWED_ACE_TYPE
        ));
        assert!(!ace_matches_sid_and_type(
            &ace,
            &sid,
            ACCESS_DENIED_ACE_TYPE
        ));
        assert!(!ace_matches_sid_and_type(
            &ace,
            &[9, 9, 9, 9],
            ACCESS_ALLOWED_ACE_TYPE
        ));
    }

    #[test]
    fn align4_rounds_up() {
        assert_eq!(align4(0), 0);
        assert_eq!(align4(1), 4);
        assert_eq!(align4(4), 4);
        assert_eq!(align4(5), 8);
    }
}
