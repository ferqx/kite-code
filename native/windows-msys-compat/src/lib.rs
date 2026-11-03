//! This DLL runs inside the original restricted child, with no broker or extra
//! privilege. Only a private MSYS runtime redirects its ntdll import to it.
//! Other exports are PE forwarders to the real system DLL. The one adapter
//! preserves logon-session access in MSYS-created IPC/default ACLs; it never
//! changes the token, directory ACLs, or an installed Git runtime.

#![cfg(windows)]

use std::{ffi::c_void, mem, ptr, sync::OnceLock};
type Handle = *mut c_void;
type AddAce = unsafe extern "system" fn(*mut c_void, u32, u32, *const c_void) -> i32;

#[link(name = "kernel32")]
extern "system" {
    fn GetCurrentProcess() -> Handle;
    fn GetModuleHandleA(name: *const u8) -> Handle;
    fn GetProcAddress(module: Handle, name: *const u8) -> *mut c_void;
    fn CloseHandle(handle: Handle) -> i32;
    fn GetLastError() -> u32;
    fn SetLastError(error: u32);
}
#[link(name = "advapi32")]
extern "system" {
    fn OpenProcessToken(process: Handle, access: u32, token: *mut Handle) -> i32;
    fn GetTokenInformation(
        token: Handle,
        kind: u32,
        data: *mut c_void,
        len: u32,
        needed: *mut u32,
    ) -> i32;
    fn EqualSid(left: *const c_void, right: *const c_void) -> i32;
}

#[repr(C)]
#[derive(Clone, Copy)]
struct SidAndAttributes {
    sid: *mut c_void,
    attributes: u32,
}
struct Token(Handle);
impl Drop for Token {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
struct Information {
    storage: Vec<usize>,
    length: usize,
}
impl Information {
    unsafe fn query(token: Handle, kind: u32) -> Option<Self> {
        let mut needed = 0;
        GetTokenInformation(token, kind, ptr::null_mut(), 0, &mut needed);
        if needed == 0 || needed > 65536 {
            return None;
        }
        let mut storage = vec![0; (needed as usize).div_ceil(mem::size_of::<usize>())];
        let capacity = storage.len() * mem::size_of::<usize>();
        if GetTokenInformation(
            token,
            kind,
            storage.as_mut_ptr().cast(),
            needed,
            &mut needed,
        ) == 0
            || needed as usize > capacity
        {
            return None;
        }
        Some(Self {
            storage,
            length: needed as usize,
        })
    }
    fn bytes(&self) -> &[u8] {
        unsafe { std::slice::from_raw_parts(self.storage.as_ptr().cast(), self.length) }
    }
    fn sid(&self, pointer: *const c_void) -> Option<&[u8]> {
        let bytes = self.bytes();
        let offset = (pointer as usize).checked_sub(bytes.as_ptr() as usize)?;
        let header = bytes.get(offset..offset.checked_add(8)?)?;
        if header[0] != 1 || header[1] > 15 {
            return None;
        }
        bytes.get(offset..offset.checked_add(8 + 4 * header[1] as usize)?)
    }
    fn groups(&self) -> Option<&[SidAndAttributes]> {
        let bytes = self.bytes();
        let count = u32::from_ne_bytes(bytes.get(..4)?.try_into().ok()?) as usize;
        let offset = mem::size_of::<usize>();
        let entries = bytes.get(
            offset..offset.checked_add(count.checked_mul(mem::size_of::<SidAndAttributes>())?)?,
        )?;
        Some(unsafe { std::slice::from_raw_parts(entries.as_ptr().cast(), count) })
    }
}

unsafe fn compatible_logon_sid() -> Option<Vec<u32>> {
    let mut handle = ptr::null_mut();
    if OpenProcessToken(GetCurrentProcess(), 8 /* TOKEN_QUERY */, &mut handle) == 0 {
        return None;
    }
    let token = Token(handle);
    let restrictions = Information::query(token.0, 11 /* TokenRestrictedSids */)?;
    let entries = restrictions.groups()?;
    if entries.is_empty() {
        return None;
    }
    let user = Information::query(token.0, 1 /* TokenUser */)?;
    if user.length < mem::size_of::<SidAndAttributes>() {
        return None;
    }
    let user_pointer = ptr::read(user.storage.as_ptr().cast::<SidAndAttributes>()).sid;
    let user_sid = user.sid(user_pointer)?;
    // Approved-filesystem tokens already include their user in the restricting
    // pass. Full has no restricting SID list. Neither needs this adaptation.
    if entries
        .iter()
        .any(|entry| restrictions.sid(entry.sid) == Some(user_sid))
    {
        return None;
    }
    let groups = Information::query(token.0, 2 /* TokenGroups */)?;
    let logon = groups
        .groups()?
        .iter()
        .find(|entry| entry.attributes & 0xc0000000 == 0xc0000000)?;
    let bytes = groups.sid(logon.sid)?;
    if !entries
        .iter()
        .any(|entry| restrictions.sid(entry.sid) == Some(bytes))
    {
        return None;
    }
    Some(
        bytes
            .chunks_exact(4)
            .map(|part| u32::from_ne_bytes(part.try_into().unwrap()))
            .collect(),
    )
}

#[no_mangle]
pub unsafe extern "system" fn RtlAddAccessAllowedAce(
    acl: *mut c_void,
    revision: u32,
    access: u32,
    sid: *const c_void,
) -> i32 {
    static ORIGINAL: OnceLock<usize> = OnceLock::new();
    let address = *ORIGINAL.get_or_init(|| {
        GetProcAddress(
            GetModuleHandleA(b"ntdll.dll\0".as_ptr()),
            b"RtlAddAccessAllowedAce\0".as_ptr(),
        ) as usize
    });
    if address == 0 {
        return 0xc000007au32 as i32;
    }
    let add: AddAce = mem::transmute(address);
    let status = add(acl, revision, access, sid);
    let error = GetLastError();
    let system_sid = [1u32 | (1 << 8), 5u32 << 24, 18u32];
    // MSYS completes these ACLs with a GENERIC_ALL SYSTEM entry. Ordinary
    // file access masks and all non-SYSTEM entries pass through unchanged.
    if status >= 0 && access == 0x10000000 && EqualSid(sid, system_sid.as_ptr().cast()) != 0 {
        if let Some(logon) = compatible_logon_sid() {
            // An incompatible/tight ACL simply remains unchanged; the original
            // token and OS access check continue to decide whether it works.
            let _ = add(acl, revision, access, logon.as_ptr().cast());
        }
    }
    SetLastError(error);
    status
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn token_information_rejects_truncated_groups_and_foreign_sid_pointers() {
        let info = Information {
            storage: vec![usize::MAX],
            length: mem::size_of::<usize>(),
        };
        assert!(info.groups().is_none());
        assert!(info.sid(ptr::null()).is_none());
        assert!(info.sid(info.storage.as_ptr().cast()).is_none());
    }
}
