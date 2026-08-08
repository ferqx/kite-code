//! Codex-style, unelevated restricted-token primitives for the direct-workspace
//! Windows backend.
//!
//! This module deliberately does not select a backend or alter filesystem ACLs.
//! Its narrow contract is to create a `WRITE_RESTRICTED` primary token carrying
//! caller-owned capability SIDs, prove that a suspended child received that
//! token, and then resume it only after it joins the caller's Job Object.
//!
//! A write-restricted token does not make the current user's ordinary read
//! access disappear. The caller still has to grant
//! the capability SID only to explicitly allowed write roots and apply any
//! required protected-path policy before spawning the child.

use std::ffi::c_void;
use std::fmt;
use std::mem::{offset_of, size_of};
use std::ptr;

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{
    CloseHandle, GetLastError, LocalFree, SetLastError, HANDLE, HLOCAL, INVALID_HANDLE_VALUE, LUID,
    WIN32_ERROR,
};
use windows::Win32::Security::Authorization::{
    SetEntriesInAclW, EXPLICIT_ACCESS_W, GRANT_ACCESS, TRUSTEE_IS_SID, TRUSTEE_IS_UNKNOWN,
    TRUSTEE_W,
};
use windows::Win32::Security::{
    AdjustTokenPrivileges, AllocateAndInitializeSid, CreateRestrictedToken, CreateWellKnownSid,
    FreeSid, GetTokenInformation, IsValidSid, LookupPrivilegeValueW, SetTokenInformation,
    TokenDefaultDacl, TokenIsRestricted, TokenLogonSid, TokenRestrictedSids, WinWorldSid,
    CREATE_RESTRICTED_TOKEN_FLAGS, DISABLE_MAX_PRIVILEGE, LUA_TOKEN, LUID_AND_ATTRIBUTES, PSID,
    SECURITY_MAX_SID_SIZE, SECURITY_NT_AUTHORITY, SE_PRIVILEGE_ENABLED, SID_AND_ATTRIBUTES,
    TOKEN_ADJUST_DEFAULT, TOKEN_ADJUST_PRIVILEGES, TOKEN_ASSIGN_PRIMARY, TOKEN_DEFAULT_DACL,
    TOKEN_DUPLICATE, TOKEN_PRIVILEGES, TOKEN_QUERY, WRITE_RESTRICTED,
};
use windows::Win32::System::JobObjects::AssignProcessToJobObject;
use windows::Win32::System::Threading::{
    CreateProcessAsUserW, CreateProcessW, DeleteProcThreadAttributeList, GetCurrentProcess,
    InitializeProcThreadAttributeList, OpenProcessToken, ResumeThread, TerminateProcess,
    UpdateProcThreadAttribute, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT,
    EXTENDED_STARTUPINFO_PRESENT, LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION,
    PROC_THREAD_ATTRIBUTE_HANDLE_LIST, STARTF_USESTDHANDLES, STARTUPINFOEXW, STARTUPINFOW,
};

const BCRYPT_USE_SYSTEM_PREFERRED_RNG: u32 = 0x0000_0002;
const MAX_TOKEN_INFORMATION_BYTES: usize = 1024 * 1024;

#[link(name = "bcrypt")]
extern "system" {
    fn BCryptGenRandom(algorithm: *mut c_void, buffer: *mut u8, buffer_len: u32, flags: u32)
        -> i32;
}

#[derive(Debug)]
pub struct RestrictedTokenError {
    pub code: &'static str,
    pub message: String,
}

impl fmt::Display for RestrictedTokenError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for RestrictedTokenError {}

pub type RestrictedTokenResult<T> = Result<T, RestrictedTokenError>;

fn error(code: &'static str, message: impl Into<String>) -> RestrictedTokenError {
    RestrictedTokenError {
        code,
        message: message.into(),
    }
}

fn wide(value: &str) -> RestrictedTokenResult<Vec<u16>> {
    if value.encode_utf16().any(|unit| unit == 0) {
        return Err(error(
            "restricted_process_input_invalid",
            "Windows command line and working directory cannot contain NUL",
        ));
    }
    Ok(value.encode_utf16().chain(std::iter::once(0)).collect())
}

fn usable_handle(handle: HANDLE) -> bool {
    !handle.0.is_null() && handle != INVALID_HANDLE_VALUE
}

fn words_for_bytes(bytes: usize) -> usize {
    bytes.div_ceil(size_of::<usize>())
}

/// A caller-owned synthetic SID in the `S-1-5-21-a-b-c-d` namespace.
///
/// The namespace is intentionally syntactic: it is not a Windows account and
/// therefore receives filesystem access only where the host explicitly grants
/// an ACL ACE for it. The SID is intended to be persisted per workspace by the
/// integration layer rather than generated for every command.
pub struct CapabilitySid {
    components: [u32; 4],
    sid: PSID,
}

impl CapabilitySid {
    /// Parse exactly the synthetic SID form used for workspace capabilities.
    pub fn parse(value: &str) -> RestrictedTokenResult<Self> {
        let parts = value.split('-').collect::<Vec<_>>();
        if parts.len() != 8
            || parts[0] != "S"
            || parts[1] != "1"
            || parts[2] != "5"
            || parts[3] != "21"
        {
            return Err(error("capability_sid_invalid", "expected S-1-5-21-a-b-c-d"));
        }
        let mut components = [0u32; 4];
        for (index, component) in components.iter_mut().enumerate() {
            *component = parts[index + 4].parse::<u32>().map_err(|_| {
                error(
                    "capability_sid_invalid",
                    "capability SID subauthorities must be unsigned 32-bit integers",
                )
            })?;
        }
        Self::from_components(components)
    }

    /// Create a capability SID from its four persisted random subauthorities.
    pub fn from_components(components: [u32; 4]) -> RestrictedTokenResult<Self> {
        let mut sid = PSID(ptr::null_mut());
        unsafe {
            AllocateAndInitializeSid(
                &SECURITY_NT_AUTHORITY,
                5,
                21,
                components[0],
                components[1],
                components[2],
                components[3],
                0,
                0,
                0,
                &mut sid,
            )
            .map_err(|windows_error| {
                error(
                    "capability_sid_create_failed",
                    format!("AllocateAndInitializeSid failed: {windows_error}"),
                )
            })?;
        }
        if sid.0.is_null() || unsafe { !IsValidSid(sid).as_bool() } {
            if !sid.0.is_null() {
                unsafe {
                    let _ = FreeSid(sid);
                }
            }
            return Err(error(
                "capability_sid_create_failed",
                "AllocateAndInitializeSid returned an invalid SID",
            ));
        }
        Ok(Self { components, sid })
    }

    /// Generate a cryptographically random capability SID using Windows CNG.
    pub fn generate() -> RestrictedTokenResult<Self> {
        let mut bytes = [0u8; 16];
        let status = unsafe {
            BCryptGenRandom(
                ptr::null_mut(),
                bytes.as_mut_ptr(),
                bytes.len() as u32,
                BCRYPT_USE_SYSTEM_PREFERRED_RNG,
            )
        };
        if status < 0 {
            return Err(error(
                "capability_sid_random_failed",
                format!(
                    "BCryptGenRandom failed with NTSTATUS 0x{:08x}",
                    status as u32
                ),
            ));
        }
        let mut components = [0u32; 4];
        for (index, chunk) in bytes.chunks_exact(4).enumerate() {
            components[index] = u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
        }
        // Keep an all-zero SID out of the persisted capability space even
        // though Windows would consider it structurally valid.
        if components.iter().all(|component| *component == 0) {
            return Self::generate();
        }
        Self::from_components(components)
    }

    pub fn components(&self) -> [u32; 4] {
        self.components
    }

    pub fn as_psid(&self) -> PSID {
        self.sid
    }
}

impl fmt::Display for CapabilitySid {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "S-1-5-21-{}-{}-{}-{}",
            self.components[0], self.components[1], self.components[2], self.components[3]
        )
    }
}

impl fmt::Debug for CapabilitySid {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("CapabilitySid")
            .field(&self.to_string())
            .finish()
    }
}

impl Drop for CapabilitySid {
    fn drop(&mut self) {
        if !self.sid.0.is_null() {
            unsafe {
                let _ = FreeSid(self.sid);
            }
            self.sid = PSID(ptr::null_mut());
        }
    }
}

/// The process-creation flags that establish the intended restricted token.
pub const UNELEVATED_RESTRICTED_TOKEN_FLAGS: CREATE_RESTRICTED_TOKEN_FLAGS =
    CREATE_RESTRICTED_TOKEN_FLAGS(DISABLE_MAX_PRIVILEGE.0 | LUA_TOKEN.0 | WRITE_RESTRICTED.0);

/// Owns a primary token created by `CreateRestrictedToken`.
pub struct RestrictedToken {
    handle: HANDLE,
}

impl RestrictedToken {
    pub fn handle(&self) -> HANDLE {
        self.handle
    }
}

impl Drop for RestrictedToken {
    fn drop(&mut self) {
        if usable_handle(self.handle) {
            unsafe {
                let _ = CloseHandle(self.handle);
            }
            self.handle = HANDLE::default();
        }
    }
}

struct StableSidBuffer {
    _storage: Vec<usize>,
    sid: PSID,
}

impl StableSidBuffer {
    fn world() -> RestrictedTokenResult<Self> {
        let size = SECURITY_MAX_SID_SIZE as usize;
        let mut storage = vec![0usize; words_for_bytes(size)];
        let sid = PSID(storage.as_mut_ptr().cast::<c_void>());
        let mut written = size as u32;
        unsafe {
            CreateWellKnownSid(WinWorldSid, PSID(ptr::null_mut()), sid, &mut written).map_err(
                |windows_error| {
                    error(
                        "restricted_token_create_failed",
                        format!("CreateWellKnownSid(WinWorldSid) failed: {windows_error}"),
                    )
                },
            )?;
        }
        if written == 0 || written as usize > size || unsafe { !IsValidSid(sid).as_bool() } {
            return Err(error(
                "restricted_token_create_failed",
                "CreateWellKnownSid(WinWorldSid) returned an invalid SID",
            ));
        }
        Ok(Self {
            _storage: storage,
            sid,
        })
    }
}

struct TokenInformation {
    storage: Vec<usize>,
    byte_len: usize,
}

impl TokenInformation {
    fn as_ptr(&self) -> *const u8 {
        self.storage.as_ptr().cast::<u8>()
    }

    fn len(&self) -> usize {
        self.byte_len
    }
}

fn query_token_information(
    token: HANDLE,
    class: windows::Win32::Security::TOKEN_INFORMATION_CLASS,
) -> RestrictedTokenResult<TokenInformation> {
    let mut required = 0u32;
    unsafe {
        // A zero-length probe is expected to report insufficient buffer. Only
        // the length is authoritative; a zero length is never valid for the
        // token classes this module requests.
        let _ = GetTokenInformation(token, class, None, 0, &mut required);
    }
    if required == 0 || required as usize > MAX_TOKEN_INFORMATION_BYTES {
        return Err(error(
            "restricted_token_verify_failed",
            "GetTokenInformation returned an invalid buffer length",
        ));
    }
    let mut storage = vec![0usize; words_for_bytes(required as usize)];
    unsafe {
        GetTokenInformation(
            token,
            class,
            Some(storage.as_mut_ptr().cast::<c_void>()),
            required,
            &mut required,
        )
        .map_err(|windows_error| {
            error(
                "restricted_token_verify_failed",
                format!("GetTokenInformation failed: {windows_error}"),
            )
        })?;
    }
    if required == 0 || required as usize > storage.len() * size_of::<usize>() {
        return Err(error(
            "restricted_token_verify_failed",
            "GetTokenInformation returned an invalid final buffer length",
        ));
    }
    Ok(TokenInformation {
        storage,
        byte_len: required as usize,
    })
}

fn token_group_entries(
    information: &TokenInformation,
) -> RestrictedTokenResult<Vec<SID_AND_ATTRIBUTES>> {
    let groups_offset = offset_of!(windows::Win32::Security::TOKEN_GROUPS, Groups);
    if information.len() < groups_offset {
        return Err(error(
            "restricted_token_verify_failed",
            "TOKEN_GROUPS buffer is truncated",
        ));
    }
    let count = unsafe { ptr::read_unaligned(information.as_ptr().cast::<u32>()) } as usize;
    let entry_size = size_of::<SID_AND_ATTRIBUTES>();
    let entries_bytes = count.checked_mul(entry_size).ok_or_else(|| {
        error(
            "restricted_token_verify_failed",
            "TOKEN_GROUPS entry count overflows",
        )
    })?;
    let needed = groups_offset.checked_add(entries_bytes).ok_or_else(|| {
        error(
            "restricted_token_verify_failed",
            "TOKEN_GROUPS size overflows",
        )
    })?;
    if needed > information.len() {
        return Err(error(
            "restricted_token_verify_failed",
            "TOKEN_GROUPS entries are truncated",
        ));
    }
    let mut entries = Vec::with_capacity(count);
    for index in 0..count {
        let offset = groups_offset + index * entry_size;
        let entry = unsafe {
            ptr::read_unaligned(
                information
                    .as_ptr()
                    .add(offset)
                    .cast::<SID_AND_ATTRIBUTES>(),
            )
        };
        if entry.Sid.0.is_null() || unsafe { !IsValidSid(entry.Sid).as_bool() } {
            return Err(error(
                "restricted_token_verify_failed",
                "TOKEN_GROUPS contains an invalid SID",
            ));
        }
        entries.push(entry);
    }
    Ok(entries)
}

fn logon_sid(token: HANDLE) -> RestrictedTokenResult<StableSidBuffer> {
    let information = query_token_information(token, TokenLogonSid)?;
    let entries = token_group_entries(&information)?;
    if entries.len() != 1 {
        return Err(error(
            "restricted_token_create_failed",
            "TokenLogonSid did not return exactly one logon SID",
        ));
    }
    let sid = entries[0].Sid;
    let length = unsafe { windows::Win32::Security::GetLengthSid(sid) as usize };
    if length == 0 || length > SECURITY_MAX_SID_SIZE as usize {
        return Err(error(
            "restricted_token_create_failed",
            "TokenLogonSid returned an invalid SID length",
        ));
    }
    let mut storage = vec![0usize; words_for_bytes(length)];
    unsafe {
        ptr::copy_nonoverlapping(
            sid.0.cast::<u8>(),
            storage.as_mut_ptr().cast::<u8>(),
            length,
        );
    }
    let copied_sid = PSID(storage.as_mut_ptr().cast::<c_void>());
    if unsafe { !IsValidSid(copied_sid).as_bool() } {
        return Err(error(
            "restricted_token_create_failed",
            "copied logon SID is invalid",
        ));
    }
    Ok(StableSidBuffer {
        _storage: storage,
        sid: copied_sid,
    })
}

fn sid_equal(left: PSID, right: PSID) -> bool {
    if left.0.is_null()
        || right.0.is_null()
        || unsafe { !IsValidSid(left).as_bool() }
        || unsafe { !IsValidSid(right).as_bool() }
    {
        return false;
    }
    let left_len = unsafe { windows::Win32::Security::GetLengthSid(left) as usize };
    let right_len = unsafe { windows::Win32::Security::GetLengthSid(right) as usize };
    if left_len == 0 || left_len != right_len {
        return false;
    }
    unsafe {
        std::slice::from_raw_parts(left.0.cast::<u8>(), left_len)
            == std::slice::from_raw_parts(right.0.cast::<u8>(), right_len)
    }
}

/// Check that a token is restricted and contains every expected capability in
/// its *restricted* SID list. The normal SID list is deliberately not used as
/// proof because `WRITE_RESTRICTED` enforcement depends on restricted SIDs.
pub fn verify_restricted_token_handle(
    token: HANDLE,
    capabilities: &[CapabilitySid],
) -> RestrictedTokenResult<()> {
    if !usable_handle(token) || capabilities.is_empty() {
        return Err(error(
            "restricted_token_verify_failed",
            "a token and at least one capability SID are required",
        ));
    }
    let mut is_restricted = 0u32;
    let mut returned = 0u32;
    unsafe {
        GetTokenInformation(
            token,
            TokenIsRestricted,
            Some((&mut is_restricted as *mut u32).cast::<c_void>()),
            size_of::<u32>() as u32,
            &mut returned,
        )
        .map_err(|windows_error| {
            error(
                "restricted_token_verify_failed",
                format!("GetTokenInformation(TokenIsRestricted) failed: {windows_error}"),
            )
        })?;
    }
    if is_restricted == 0 {
        return Err(error(
            "restricted_token_verify_failed",
            "token is not restricted",
        ));
    }
    let information = query_token_information(token, TokenRestrictedSids)?;
    let entries = token_group_entries(&information)?;
    for capability in capabilities {
        if !entries
            .iter()
            .any(|entry| sid_equal(entry.Sid, capability.as_psid()))
        {
            return Err(error(
                "restricted_token_verify_failed",
                format!("restricted token is missing capability SID {capability}"),
            ));
        }
    }
    Ok(())
}

/// Mirror Codex's token initialization so shells can create child pipes and
/// traverse their normal working paths after `DISABLE_MAX_PRIVILEGE`. The
/// default DACL is scoped to the token's capabilities, logon SID, and World;
/// it never grants a route/network identity.
fn set_compatible_default_dacl(
    token: HANDLE,
    capabilities: &[CapabilitySid],
    logon_sid: PSID,
    world_sid: PSID,
) -> RestrictedTokenResult<()> {
    let mut sids = Vec::with_capacity(capabilities.len() + 2);
    sids.push(logon_sid);
    sids.push(world_sid);
    sids.extend(capabilities.iter().map(CapabilitySid::as_psid));
    let entries = sids
        .into_iter()
        .map(|sid| EXPLICIT_ACCESS_W {
            grfAccessPermissions: 0x1000_0000, // GENERIC_ALL
            grfAccessMode: GRANT_ACCESS,
            grfInheritance: Default::default(),
            Trustee: TRUSTEE_W {
                pMultipleTrustee: std::ptr::null_mut(),
                MultipleTrusteeOperation: Default::default(),
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_UNKNOWN,
                ptstrName: PWSTR(sid.0.cast()),
            },
        })
        .collect::<Vec<_>>();
    let mut dacl = std::ptr::null_mut();
    let status = unsafe { SetEntriesInAclW(Some(&entries), None, &mut dacl) };
    if status != WIN32_ERROR(0) || dacl.is_null() {
        return Err(error(
            "restricted_token_default_dacl_failed",
            format!("SetEntriesInAclW failed with Win32 error {}", status.0),
        ));
    }
    let mut default_dacl = TOKEN_DEFAULT_DACL { DefaultDacl: dacl };
    let result = unsafe {
        SetTokenInformation(
            token,
            TokenDefaultDacl,
            &mut default_dacl as *mut TOKEN_DEFAULT_DACL as *const c_void,
            size_of::<TOKEN_DEFAULT_DACL>() as u32,
        )
    }
    .map_err(|windows_error| {
        error(
            "restricted_token_default_dacl_failed",
            format!("SetTokenInformation(TokenDefaultDacl) failed: {windows_error}"),
        )
    });
    unsafe {
        let _ = LocalFree(HLOCAL(dacl.cast()));
    }
    result
}

fn enable_traverse_privilege(token: HANDLE) -> RestrictedTokenResult<()> {
    let name = wide("SeChangeNotifyPrivilege")?;
    let mut luid = LUID::default();
    unsafe {
        LookupPrivilegeValueW(PCWSTR::null(), PCWSTR(name.as_ptr()), &mut luid).map_err(
            |windows_error| {
                error(
                    "restricted_token_privilege_enable_failed",
                    format!(
                        "LookupPrivilegeValueW(SeChangeNotifyPrivilege) failed: {windows_error}"
                    ),
                )
            },
        )?;
    }
    let privileges = TOKEN_PRIVILEGES {
        PrivilegeCount: 1,
        Privileges: [LUID_AND_ATTRIBUTES {
            Luid: luid,
            Attributes: SE_PRIVILEGE_ENABLED,
        }],
    };
    unsafe {
        SetLastError(WIN32_ERROR(0));
        AdjustTokenPrivileges(token, false, Some(&privileges), 0, None, None).map_err(
            |windows_error| {
                error(
                    "restricted_token_privilege_enable_failed",
                    format!("AdjustTokenPrivileges failed: {windows_error}"),
                )
            },
        )?;
        let last_error = GetLastError();
        if last_error != WIN32_ERROR(0) {
            return Err(error(
                "restricted_token_privilege_enable_failed",
                format!(
                    "AdjustTokenPrivileges returned Win32 error {}",
                    last_error.0
                ),
            ));
        }
    }
    Ok(())
}
/// Build the direct-workspace restricted token from an already-open primary
/// token. `base_token` must grant `TOKEN_DUPLICATE`; the returned handle owns
/// the `CreateRestrictedToken` result and is suitable for `CreateProcessAsUserW`.
pub fn create_unelevated_restricted_token(
    base_token: HANDLE,
    capabilities: &[CapabilitySid],
) -> RestrictedTokenResult<RestrictedToken> {
    if !usable_handle(base_token) || capabilities.is_empty() {
        return Err(error(
            "restricted_token_create_failed",
            "a base token and at least one capability SID are required",
        ));
    }
    for capability in capabilities {
        if capability.as_psid().0.is_null()
            || unsafe { !IsValidSid(capability.as_psid()).as_bool() }
        {
            return Err(error(
                "restricted_token_create_failed",
                "capability SID is invalid",
            ));
        }
    }

    // This is the same authorization shape used by Codex's unelevated mode:
    // workspace capability SIDs followed by the caller's logon SID and World.
    // The latter two preserve the standard restricted-token access semantics;
    // the capability SID is the ACL gate for write-restricted access.
    let logon = logon_sid(base_token)?;
    let world = StableSidBuffer::world()?;
    let mut restricted_sids = Vec::with_capacity(capabilities.len() + 2);
    restricted_sids.extend(capabilities.iter().map(|capability| SID_AND_ATTRIBUTES {
        Sid: capability.as_psid(),
        Attributes: 0,
    }));
    restricted_sids.push(SID_AND_ATTRIBUTES {
        Sid: logon.sid,
        Attributes: 0,
    });
    restricted_sids.push(SID_AND_ATTRIBUTES {
        Sid: world.sid,
        Attributes: 0,
    });

    let mut handle = HANDLE::default();
    unsafe {
        CreateRestrictedToken(
            base_token,
            UNELEVATED_RESTRICTED_TOKEN_FLAGS,
            None,
            None,
            Some(restricted_sids.as_slice()),
            &mut handle,
        )
        .map_err(|windows_error| {
            error(
                "restricted_token_create_failed",
                format!("CreateRestrictedToken failed: {windows_error}"),
            )
        })?;
    }
    if !usable_handle(handle) {
        return Err(error(
            "restricted_token_create_failed",
            "CreateRestrictedToken returned an invalid handle",
        ));
    }
    let token = RestrictedToken { handle };
    verify_restricted_token_handle(token.handle, capabilities)?;
    set_compatible_default_dacl(token.handle, capabilities, logon.sid, world.sid)?;
    enable_traverse_privilege(token.handle)?;
    Ok(token)
}

/// Open the current process's primary token and derive an unelevated
/// restricted token. No elevation or account creation is involved.
pub fn create_current_user_restricted_token(
    capabilities: &[CapabilitySid],
) -> RestrictedTokenResult<RestrictedToken> {
    let mut base_token = HANDLE::default();
    unsafe {
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_DUPLICATE
                | TOKEN_QUERY
                | TOKEN_ASSIGN_PRIMARY
                | TOKEN_ADJUST_DEFAULT
                | TOKEN_ADJUST_PRIVILEGES,
            &mut base_token,
        )
        .map_err(|windows_error| {
            error(
                "restricted_token_open_failed",
                format!("OpenProcessToken(current process) failed: {windows_error}"),
            )
        })?;
    }
    if !usable_handle(base_token) {
        return Err(error(
            "restricted_token_open_failed",
            "OpenProcessToken returned an invalid handle",
        ));
    }
    let mut is_restricted = 0u32;
    let mut returned = 0u32;
    unsafe {
        GetTokenInformation(
            base_token,
            TokenIsRestricted,
            Some((&mut is_restricted as *mut u32).cast::<c_void>()),
            size_of::<u32>() as u32,
            &mut returned,
        )
        .map_err(|windows_error| {
            error(
                "restricted_token_open_failed",
                format!("GetTokenInformation(TokenIsRestricted) failed: {windows_error}"),
            )
        })?;
    }
    if is_restricted != 0 {
        unsafe {
            let _ = CloseHandle(base_token);
        }
        return Err(error(
            "restricted_token_parent_already_restricted",
            "the current process already runs with a restricted token",
        ));
    }
    let result = create_unelevated_restricted_token(base_token, capabilities);
    unsafe {
        let _ = CloseHandle(base_token);
    }
    result
}

#[cfg(test)]
fn current_process_token_is_restricted() -> RestrictedTokenResult<bool> {
    let mut token = HANDLE::default();
    unsafe {
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).map_err(
            |windows_error| {
                error(
                    "restricted_token_open_failed",
                    format!("OpenProcessToken(current process) failed: {windows_error}"),
                )
            },
        )?;
    }
    let mut is_restricted = 0u32;
    let mut returned = 0u32;
    let result = unsafe {
        GetTokenInformation(
            token,
            TokenIsRestricted,
            Some((&mut is_restricted as *mut u32).cast::<c_void>()),
            size_of::<u32>() as u32,
            &mut returned,
        )
        .map(|_| is_restricted != 0)
        .map_err(|windows_error| {
            error(
                "restricted_token_open_failed",
                format!("GetTokenInformation(TokenIsRestricted) failed: {windows_error}"),
            )
        })
    };
    unsafe {
        let _ = CloseHandle(token);
    }
    result
}

struct AttributeList {
    _storage: Vec<u8>,
    raw: LPPROC_THREAD_ATTRIBUTE_LIST,
}

impl AttributeList {
    fn new(attribute_count: u32) -> RestrictedTokenResult<Self> {
        let mut bytes = 0usize;
        unsafe {
            let _ = InitializeProcThreadAttributeList(
                LPPROC_THREAD_ATTRIBUTE_LIST(ptr::null_mut()),
                attribute_count,
                0,
                &mut bytes,
            );
        }
        if bytes == 0 {
            return Err(error(
                "restricted_process_create_failed",
                format!(
                    "InitializeProcThreadAttributeList size query failed with Win32 error {}",
                    unsafe { GetLastError().0 }
                ),
            ));
        }
        let mut storage = vec![0u8; bytes];
        let raw = LPPROC_THREAD_ATTRIBUTE_LIST(storage.as_mut_ptr().cast::<c_void>());
        unsafe {
            InitializeProcThreadAttributeList(raw, attribute_count, 0, &mut bytes).map_err(
                |windows_error| {
                    error(
                        "restricted_process_create_failed",
                        format!("InitializeProcThreadAttributeList failed: {windows_error}"),
                    )
                },
            )?;
        }
        Ok(Self {
            _storage: storage,
            raw,
        })
    }
}

impl Drop for AttributeList {
    fn drop(&mut self) {
        unsafe {
            DeleteProcThreadAttributeList(self.raw);
        }
    }
}

/// A child created suspended under a verified restricted token.
///
/// Dropping a still-suspended child terminates it, which prevents an orphaned
/// process if Job assignment fails. Once resumed, normal lifetime control is
/// delegated to the owning Job Object.
pub struct RestrictedProcess {
    process: HANDLE,
    thread: HANDLE,
    resumed: bool,
}

impl RestrictedProcess {
    pub fn process_handle(&self) -> HANDLE {
        self.process
    }

    pub fn thread_handle(&self) -> HANDLE {
        self.thread
    }

    /// Resume only after the caller has assigned `process_handle()` to its Job.
    pub fn resume(&mut self) -> RestrictedTokenResult<()> {
        if self.resumed {
            return Ok(());
        }
        let result = unsafe { ResumeThread(self.thread) };
        if result == u32::MAX {
            return Err(error(
                "restricted_process_resume_failed",
                format!("ResumeThread failed with Win32 error {}", unsafe {
                    GetLastError().0
                }),
            ));
        }
        self.resumed = true;
        Ok(())
    }

    pub fn terminate(&self, exit_code: u32) {
        if usable_handle(self.process) {
            unsafe {
                let _ = TerminateProcess(self.process, exit_code);
            }
        }
    }
}

impl Drop for RestrictedProcess {
    fn drop(&mut self) {
        if !self.resumed {
            self.terminate(1);
        }
        if usable_handle(self.thread) {
            unsafe {
                let _ = CloseHandle(self.thread);
            }
        }
        if usable_handle(self.process) {
            unsafe {
                let _ = CloseHandle(self.process);
            }
        }
    }
}

fn validate_stdio_handles(handles: &[HANDLE; 3]) -> RestrictedTokenResult<()> {
    if handles.iter().all(|handle| usable_handle(*handle)) {
        Ok(())
    } else {
        Err(error(
            "restricted_process_input_invalid",
            "stdin, stdout, and stderr handles must be valid",
        ))
    }
}

fn validate_environment_block(block: &[u16]) -> RestrictedTokenResult<()> {
    if block.is_empty() {
        return Ok(());
    }
    if block.len() < 2 || block[block.len() - 1] != 0 || block[block.len() - 2] != 0 {
        return Err(error(
            "restricted_process_input_invalid",
            "a Unicode environment block must end in two NUL code units",
        ));
    }
    Ok(())
}

/// Create the child with `CreateProcessAsUserW`, keep it suspended, and prove
/// its primary token is restricted before any user instruction can execute.
///
/// The caller must assign the returned process to a kill-on-close Job before
/// calling `resume`. Prefer [`spawn_restricted_in_job`] when a Job is available.
#[allow(clippy::too_many_arguments)]
pub fn spawn_restricted_suspended_verified(
    token: &RestrictedToken,
    capabilities: &[CapabilitySid],
    command_line: &str,
    cwd: &str,
    env_block: &[u16],
    stdin_read: HANDLE,
    stdout_write: HANDLE,
    stderr_write: HANDLE,
) -> RestrictedTokenResult<RestrictedProcess> {
    if capabilities.is_empty() || !usable_handle(token.handle) {
        return Err(error(
            "restricted_process_input_invalid",
            "a restricted token and at least one capability SID are required",
        ));
    }
    let mut command = wide(command_line)?;
    let cwd = wide(cwd)?;
    validate_environment_block(env_block)?;
    let mut handles = [stdin_read, stdout_write, stderr_write];
    validate_stdio_handles(&handles)?;

    let attributes = AttributeList::new(1)?;
    unsafe {
        UpdateProcThreadAttribute(
            attributes.raw,
            0,
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
            Some(handles.as_mut_ptr().cast::<c_void>()),
            size_of::<[HANDLE; 3]>(),
            None,
            None,
        )
        .map_err(|windows_error| {
            error(
                "restricted_process_create_failed",
                format!("UpdateProcThreadAttribute(handle list) failed: {windows_error}"),
            )
        })?;
    }

    let startup = STARTUPINFOEXW {
        StartupInfo: STARTUPINFOW {
            cb: size_of::<STARTUPINFOEXW>() as u32,
            dwFlags: STARTF_USESTDHANDLES,
            hStdInput: stdin_read,
            hStdOutput: stdout_write,
            hStdError: stderr_write,
            ..Default::default()
        },
        lpAttributeList: attributes.raw,
    };
    let mut process_info = PROCESS_INFORMATION::default();
    let environment = (!env_block.is_empty()).then_some(env_block.as_ptr().cast::<c_void>());
    unsafe {
        CreateProcessAsUserW(
            token.handle,
            None,
            PWSTR(command.as_mut_ptr()),
            None,
            None,
            true,
            CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
            environment,
            PCWSTR(cwd.as_ptr()),
            &startup.StartupInfo,
            &mut process_info,
        )
        .map_err(|windows_error| {
            error(
                "restricted_process_create_failed",
                format!("CreateProcessAsUserW failed: {windows_error}"),
            )
        })?;
    }
    let process = RestrictedProcess {
        process: process_info.hProcess,
        thread: process_info.hThread,
        resumed: false,
    };
    if !usable_handle(process.process) || !usable_handle(process.thread) {
        return Err(error(
            "restricted_process_create_failed",
            "CreateProcessAsUserW returned invalid process handles",
        ));
    }
    if let Err(verification_error) = verify_restricted_process(process.process, capabilities) {
        process.terminate(1);
        return Err(verification_error);
    }
    Ok(process)
}

/// Verify a child process's primary token while it is still suspended.
pub fn verify_restricted_process(
    process: HANDLE,
    capabilities: &[CapabilitySid],
) -> RestrictedTokenResult<()> {
    if !usable_handle(process) {
        return Err(error(
            "restricted_process_verify_failed",
            "process handle is invalid",
        ));
    }
    let mut child_token = HANDLE::default();
    unsafe {
        OpenProcessToken(process, TOKEN_QUERY, &mut child_token).map_err(|windows_error| {
            error(
                "restricted_process_verify_failed",
                format!("OpenProcessToken(child) failed: {windows_error}"),
            )
        })?;
    }
    if !usable_handle(child_token) {
        return Err(error(
            "restricted_process_verify_failed",
            "OpenProcessToken(child) returned an invalid token handle",
        ));
    }
    let result = verify_restricted_token_handle(child_token, capabilities).map_err(|source| {
        error(
            "restricted_process_verify_failed",
            format!("child token verification failed: {source}"),
        )
    });
    unsafe {
        let _ = CloseHandle(child_token);
    }
    result
}

/// Spawn, verify, assign to the given Job, then resume. No child code runs
/// until both token verification and Job assignment have succeeded.
#[allow(clippy::too_many_arguments)]
pub fn spawn_restricted_in_job(
    token: &RestrictedToken,
    capabilities: &[CapabilitySid],
    job: HANDLE,
    command_line: &str,
    cwd: &str,
    env_block: &[u16],
    stdin_read: HANDLE,
    stdout_write: HANDLE,
    stderr_write: HANDLE,
) -> RestrictedTokenResult<RestrictedProcess> {
    if !usable_handle(job) {
        return Err(error(
            "restricted_process_job_assign_failed",
            "Job handle is invalid",
        ));
    }
    let mut process = spawn_restricted_suspended_verified(
        token,
        capabilities,
        command_line,
        cwd,
        env_block,
        stdin_read,
        stdout_write,
        stderr_write,
    )?;
    unsafe {
        AssignProcessToJobObject(job, process.process).map_err(|windows_error| {
            error(
                "restricted_process_job_assign_failed",
                format!("AssignProcessToJobObject failed: {windows_error}"),
            )
        })?;
    }
    process.resume()?;
    Ok(process)
}

/// Spawn a child under the current process's already-validated non-admin
/// identity, assign it to the Job while suspended, then resume it. This path
/// is used only by the managed Online runner: Windows Schannel deliberately
/// refuses outbound credentials from a restricted token, while the dedicated
/// account's temporary ACL lease remains the filesystem write boundary.
#[allow(clippy::too_many_arguments)]
pub fn spawn_current_user_in_job(
    job: HANDLE,
    command_line: &str,
    cwd: &str,
    env_block: &[u16],
    stdin_read: HANDLE,
    stdout_write: HANDLE,
    stderr_write: HANDLE,
) -> RestrictedTokenResult<RestrictedProcess> {
    if !usable_handle(job) {
        return Err(error(
            "managed_process_job_assign_failed",
            "Job handle is invalid",
        ));
    }
    let mut command = wide(command_line)?;
    let cwd = wide(cwd)?;
    validate_environment_block(env_block)?;
    let mut handles = [stdin_read, stdout_write, stderr_write];
    validate_stdio_handles(&handles)?;
    let attributes = AttributeList::new(1)?;
    unsafe {
        UpdateProcThreadAttribute(
            attributes.raw,
            0,
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
            Some(handles.as_mut_ptr().cast::<c_void>()),
            size_of::<[HANDLE; 3]>(),
            None,
            None,
        )
        .map_err(|windows_error| {
            error(
                "managed_process_create_failed",
                format!("UpdateProcThreadAttribute(handle list) failed: {windows_error}"),
            )
        })?;
    }
    let startup = STARTUPINFOEXW {
        StartupInfo: STARTUPINFOW {
            cb: size_of::<STARTUPINFOEXW>() as u32,
            dwFlags: STARTF_USESTDHANDLES,
            hStdInput: stdin_read,
            hStdOutput: stdout_write,
            hStdError: stderr_write,
            ..Default::default()
        },
        lpAttributeList: attributes.raw,
    };
    let mut process_info = PROCESS_INFORMATION::default();
    let environment = (!env_block.is_empty()).then_some(env_block.as_ptr().cast::<c_void>());
    unsafe {
        CreateProcessW(
            None,
            PWSTR(command.as_mut_ptr()),
            None,
            None,
            true,
            CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
            environment,
            PCWSTR(cwd.as_ptr()),
            &startup.StartupInfo,
            &mut process_info,
        )
        .map_err(|windows_error| {
            error(
                "managed_process_create_failed",
                format!("CreateProcessW failed: {windows_error}"),
            )
        })?;
    }
    let mut process = RestrictedProcess {
        process: process_info.hProcess,
        thread: process_info.hThread,
        resumed: false,
    };
    if !usable_handle(process.process) || !usable_handle(process.thread) {
        return Err(error(
            "managed_process_create_failed",
            "CreateProcessW returned invalid process handles",
        ));
    }
    unsafe {
        AssignProcessToJobObject(job, process.process).map_err(|windows_error| {
            error(
                "managed_process_job_assign_failed",
                format!("AssignProcessToJobObject failed: {windows_error}"),
            )
        })?;
    }
    process.resume()?;
    Ok(process)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_formats_capability_sid() {
        let sid = CapabilitySid::parse("S-1-5-21-1-2-3-4").expect("parse capability SID");
        assert_eq!(sid.components(), [1, 2, 3, 4]);
        assert_eq!(sid.to_string(), "S-1-5-21-1-2-3-4");
    }

    #[test]
    fn rejects_non_capability_sid_forms() {
        for invalid in [
            "S-1-5-20-1-2-3-4",
            "S-1-5-21-1-2-3",
            "S-1-5-21-1-2-3-4294967296",
            "s-1-5-21-1-2-3-4",
        ] {
            assert!(CapabilitySid::parse(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn generated_capability_sid_has_expected_shape() {
        let sid = CapabilitySid::generate().expect("generate capability SID");
        assert!(sid.to_string().starts_with("S-1-5-21-"));
        assert_ne!(sid.components(), [0, 0, 0, 0]);
    }

    #[test]
    fn current_user_token_is_restricted_and_carries_capability() {
        if current_process_token_is_restricted().expect("inspect current token") {
            return;
        }
        let capabilities = [CapabilitySid::parse("S-1-5-21-11-22-33-44").expect("capability")];
        let token = create_current_user_restricted_token(&capabilities).expect("restricted token");
        verify_restricted_token_handle(token.handle(), &capabilities)
            .expect("token should retain its capability SID");
    }
}
