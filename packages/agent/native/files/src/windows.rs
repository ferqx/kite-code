use crate::{DirectoryEntry, FileStat, fail, io_error};
use cap_std::fs::{Dir, File};
use napi::Result;
use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::mem::{ManuallyDrop, offset_of, size_of, zeroed};
use std::os::windows::io::{AsRawHandle, FromRawHandle, IntoRawHandle};
use std::ptr::{null, null_mut};
use std::sync::Mutex;
use windows_sys::Wdk::Foundation::OBJECT_ATTRIBUTES;
use windows_sys::Wdk::Storage::FileSystem::{
    FILE_CREATE, FILE_DIRECTORY_FILE, FILE_NON_DIRECTORY_FILE, FILE_OPEN, FILE_OPEN_REPARSE_POINT,
    FILE_RENAME_INFORMATION, FILE_SYNCHRONOUS_IO_NONALERT, FileRenameInformation, NtCreateFile,
    NtSetInformationFile,
};
use windows_sys::Win32::Foundation::{
    CloseHandle, HANDLE, LocalFree, OBJ_CASE_INSENSITIVE, RtlNtStatusToDosError, UNICODE_STRING,
};
use windows_sys::Win32::Globalization::{CSTR_EQUAL, CompareStringOrdinal};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, GetSecurityInfo,
    SE_FILE_OBJECT,
};
use windows_sys::Win32::Security::{
    GetTokenInformation, OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, TOKEN_QUERY,
    TOKEN_USER, TokenUser,
};
use windows_sys::Win32::Storage::FileSystem::*;
use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

// A failed close never reconstructs or retries a HANDLE. Its complete owner is retained.
static RETAINED: Mutex<Vec<Owner>> = Mutex::new(Vec::new());
static UNRELEASED: Mutex<Vec<usize>> = Mutex::new(Vec::new());
#[cfg(test)]
thread_local! {
    static FAIL_CLOSE: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    static CLOSE_ATTEMPTS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    static FAIL_AFTER_PUBLISH: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static FAIL_OPEN_CONFIRMATION: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}
fn close_object(handle: HANDLE) -> bool {
    #[cfg(test)]
    {
        CLOSE_ATTEMPTS.with(|n| n.set(n.get() + 1));
        if FAIL_CLOSE.with(|target| target.get() == handle as usize) {
            return false;
        }
    }
    unsafe { CloseHandle(handle) != 0 }
}

fn os_error() -> napi::Error {
    io_error(std::io::Error::last_os_error())
}
fn check(value: i32) -> Result<()> {
    if value == 0 { Err(os_error()) } else { Ok(()) }
}
fn nt_status(status: i32) -> Result<()> {
    if status < 0 {
        Err(io_error(std::io::Error::from_raw_os_error(
            unsafe { RtlNtStatusToDosError(status) } as i32,
        )))
    } else if status != 0 {
        Err(fail("file_io_failed"))
    } else {
        Ok(())
    }
}
fn equal(a: &str, b: &str) -> bool {
    let a: Vec<u16> = a.encode_utf16().collect();
    let b: Vec<u16> = b.encode_utf16().collect();
    unsafe {
        CompareStringOrdinal(a.as_ptr(), a.len() as i32, b.as_ptr(), b.len() as i32, 1)
            == CSTR_EQUAL
    }
}
fn component(value: &str) -> Result<()> {
    let stem = value.split('.').next().unwrap_or("").to_uppercase();
    let device = ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
        || ["COM", "LPT"].iter().any(|prefix| {
            stem.strip_prefix(prefix)
                .is_some_and(|n| n.chars().count() == 1 && "123456789¹²³".contains(n))
        });
    if value.is_empty()
        || value == "."
        || value == ".."
        || value.len() > 255
        || value.ends_with(['.', ' '])
        || device
        || value.chars().any(|c| c < ' ' || "\\/:*?\"<>|".contains(c))
    {
        return Err(fail("file_path_invalid"));
    }
    Ok(())
}
fn absolute(value: &str) -> Result<()> {
    let bytes = value.as_bytes();
    if bytes.len() < 3
        || bytes.len() > 32760
        || !bytes[0].is_ascii_alphabetic()
        || bytes[1] != b':'
        || bytes[2] != b'\\'
    {
        return Err(fail("file_path_invalid"));
    }
    for part in value[3..].split('\\').filter(|s| !s.is_empty()) {
        component(part)?;
    }
    Ok(())
}
fn child(parent: &str, name: &str) -> String {
    format!("{}\\{name}", parent.trim_end_matches('\\'))
}
fn free(pointer: *mut std::ffi::c_void) -> Result<()> {
    if !pointer.is_null() && !unsafe { LocalFree(pointer) }.is_null() {
        UNRELEASED.lock().unwrap().push(pointer as usize);
        return Err(fail("file_close_unknown"));
    }
    Ok(())
}
fn sid_text(sid: PSID) -> Result<String> {
    let mut text = null_mut();
    check(unsafe { ConvertSidToStringSidW(sid, &mut text) })?;
    let result = (|| {
        let mut length = 0;
        while length < 1024 && unsafe { *text.add(length) } != 0 {
            length += 1;
        }
        if length == 1024 {
            return Err(fail("file_owner_invalid"));
        }
        String::from_utf16(unsafe { std::slice::from_raw_parts(text, length) })
            .map_err(|_| fail("file_owner_invalid"))
    })();
    free(text.cast())?;
    result
}
fn current_sid() -> Result<String> {
    let mut token = null_mut();
    check(unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) })?;
    let result = (|| {
        let mut length = 0;
        unsafe {
            GetTokenInformation(token, TokenUser, null_mut(), 0, &mut length);
        }
        if length == 0 || length > 65536 {
            return Err(fail("file_owner_invalid"));
        }
        let mut bytes = vec![0u64; (length as usize).div_ceil(8)];
        check(unsafe {
            GetTokenInformation(
                token,
                TokenUser,
                bytes.as_mut_ptr().cast(),
                length,
                &mut length,
            )
        })?;
        sid_text(unsafe { (*(bytes.as_ptr() as *const TOKEN_USER)).User.Sid })
    })();
    if unsafe { CloseHandle(token) } == 0 {
        UNRELEASED.lock().unwrap().push(token as usize);
        return Err(fail("file_close_unknown"));
    }
    result
}
fn owner(handle: HANDLE) -> Result<String> {
    let mut sid = null_mut();
    let mut descriptor = null_mut();
    let status = unsafe {
        GetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION,
            &mut sid,
            null_mut(),
            null_mut(),
            null_mut(),
            &mut descriptor,
        )
    };
    let result = if status == 0 {
        sid_text(sid)
    } else {
        Err(io_error(std::io::Error::from_raw_os_error(status as i32)))
    };
    free(descriptor.cast())?;
    result
}
fn query<T>(handle: HANDLE, class: FILE_INFO_BY_HANDLE_CLASS) -> Result<T> {
    let mut data: T = unsafe { zeroed() };
    check(unsafe {
        GetFileInformationByHandleEx(
            handle,
            class,
            (&mut data as *mut T).cast(),
            size_of::<T>() as u32,
        )
    })?;
    Ok(data)
}
fn facts(handle: HANDLE) -> Result<FileStat> {
    if unsafe { GetFileType(handle) } != FILE_TYPE_DISK {
        return Err(fail("file_not_regular"));
    }
    let id: FILE_ID_INFO = query(handle, FileIdInfo)?;
    let basic: FILE_BASIC_INFO = query(handle, FileBasicInfo)?;
    let standard: FILE_STANDARD_INFO = query(handle, FileStandardInfo)?;
    if basic.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(fail("file_path_invalid"));
    }
    if standard.DeletePending
        || standard.EndOfFile < 0
        || (basic.FileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0) != standard.Directory
    {
        return Err(fail("file_changed"));
    }
    Ok(FileStat {
        dev: id.VolumeSerialNumber.to_string(),
        ino: u128::from_le_bytes(id.FileId.Identifier).to_string(),
        size: standard.EndOfFile.to_string(),
        mtime_ns: (basic.LastWriteTime as i128 * 100).to_string(),
        ctime_ns: (basic.ChangeTime as i128 * 100).to_string(),
        nlink: standard.NumberOfLinks.to_string(),
        owner: owner(handle)?,
        kind: if standard.Directory {
            "directory"
        } else {
            "file"
        }
        .into(),
    })
}
fn final_path(handle: HANDLE) -> Result<String> {
    let mut bytes = vec![0u16; 32768];
    let length =
        unsafe { GetFinalPathNameByHandleW(handle, bytes.as_mut_ptr(), bytes.len() as u32, 0) };
    if length == 0 || length as usize >= bytes.len() {
        return Err(os_error());
    }
    let path =
        String::from_utf16(&bytes[..length as usize]).map_err(|_| fail("file_path_invalid"))?;
    let path = path
        .strip_prefix("\\\\?\\")
        .ok_or_else(|| fail("file_path_invalid"))?
        .to_owned();
    absolute(&path)?;
    Ok(path)
}

enum Object {
    Directory(ManuallyDrop<Dir>),
    File(ManuallyDrop<File>),
}
impl Object {
    fn raw(&self) -> HANDLE {
        match self {
            Self::Directory(v) => v.as_raw_handle().cast(),
            Self::File(v) => v.as_raw_handle().cast(),
        }
    }
    fn dir(&self) -> Result<&Dir> {
        match self {
            Self::Directory(v) => Ok(v),
            _ => Err(fail("ENOTDIR")),
        }
    }
    fn file(&self) -> Result<&File> {
        match self {
            Self::File(v) => Ok(v),
            _ => Err(fail("file_io_invalid")),
        }
    }
    // Called only after the OS confirms closure. Consume Rust ownership without a second close.
    unsafe fn forget(&mut self) {
        match self {
            Self::Directory(v) => {
                let _ = unsafe { ManuallyDrop::take(v) }
                    .into_std_file()
                    .into_raw_handle();
            }
            Self::File(v) => {
                let _ = unsafe { ManuallyDrop::take(v) }
                    .into_std()
                    .into_raw_handle();
            }
        }
    }
}
struct Entry {
    object: Object,
    path: String,
    identity: String,
    temporary: bool,
    uncertain: bool,
}
pub struct Owner {
    entries: BTreeMap<u32, Entry>,
    ancestors: Vec<u32>,
    root: u32,
    serial: u32,
    denied: Vec<String>,
    protect_reads: bool,
    sid: String,
    closed: bool,
    uncertain: bool,
}
impl Owner {
    pub fn new(root: String, protected: Vec<String>, protect_reads: bool) -> Result<Self> {
        absolute(&root)?;
        let mut denied = Vec::new();
        for path in &protected {
            if path.contains('\\') {
                return Err(fail("file_path_invalid"));
            }
            let parts: Vec<_> = path.split('/').filter(|s| !s.is_empty()).collect();
            if parts.is_empty() {
                return Err(fail("file_path_invalid"));
            }
            for part in &parts {
                component(part)?;
            }
            denied.push(child(&root, &parts.join("\\")));
        }
        let mut value = Self {
            entries: BTreeMap::new(),
            ancestors: Vec::new(),
            root: 0,
            serial: 0,
            denied,
            protect_reads,
            sid: current_sid()?,
            closed: false,
            uncertain: false,
        };
        let result: Result<()> = (|| {
            let drive = &root[..3];
            let dir = Dir::from_std_file(native_open(
                null_mut(),
                &format!("\\??\\{drive}"),
                0x1200a1,
                Some(true),
                null_mut(),
                false,
            )?);
            let mut id = value.add(
                Object::Directory(ManuallyDrop::new(dir)),
                drive.into(),
                false,
            )?;
            value.ancestors.push(id);
            for name in root[3..].split('\\').filter(|s| !s.is_empty()) {
                let parent = value.entry(id)?;
                let path = child(&parent.path, name);
                let dir = Dir::from_std_file(native_open(
                    parent.object.raw(),
                    name,
                    0x1200a1,
                    Some(true),
                    null_mut(),
                    false,
                )?);
                id = value.add(Object::Directory(ManuallyDrop::new(dir)), path, false)?;
                value.ancestors.push(id);
            }
            value.root = id;
            value.ancestors.pop();
            for path in protected {
                let mut probes = Vec::new();
                let mut parent = id;
                let result = (|| {
                    for name in path.split('/').filter(|s| !s.is_empty()) {
                        let entry = value.entry(parent)?;
                        let target = child(&entry.path, name);
                        let file = match native_open(
                            entry.object.raw(),
                            name,
                            0x120080,
                            None,
                            null_mut(),
                            false,
                        ) {
                            Ok(file) => file,
                            Err(error) if error.reason.starts_with("ENOENT:") => break,
                            Err(error) => return Err(error),
                        };
                        parent = value.add(
                            Object::File(ManuallyDrop::new(File::from_std(file))),
                            target,
                            false,
                        )?;
                        probes.push(parent);
                    }
                    Ok(())
                })();
                for probe in probes.into_iter().rev() {
                    value.close_id(probe)?;
                }
                result?;
            }
            Ok(())
        })();
        if result
            .as_ref()
            .is_err_and(|e| e.reason == "file_close_unknown")
        {
            value.uncertain = true;
        }
        result?;
        Ok(value)
    }
    pub fn root(&self) -> u32 {
        self.root
    }
    fn entry(&self, id: u32) -> Result<&Entry> {
        if self.uncertain {
            return Err(fail("file_close_unknown"));
        }
        if self.closed {
            return Err(fail("file_closed"));
        }
        let entry = self.entries.get(&id).ok_or_else(|| fail("file_closed"))?;
        if entry.uncertain {
            return Err(fail("file_close_unknown"));
        }
        Ok(entry)
    }
    fn facts(&mut self, handle: HANDLE) -> Result<FileStat> {
        let result = facts(handle);
        if result
            .as_ref()
            .is_err_and(|e| e.reason == "file_close_unknown")
        {
            self.uncertain = true;
        }
        result
    }
    fn add(&mut self, object: Object, path: String, temporary: bool) -> Result<u32> {
        self.serial = self
            .serial
            .checked_add(1)
            .ok_or_else(|| fail("file_io_failed"))?;
        let id = self.serial;
        self.entries.insert(
            id,
            Entry {
                object,
                path: path.clone(),
                identity: String::new(),
                temporary,
                uncertain: false,
            },
        );
        let handle = self.entry(id)?.object.raw();
        let stat = self.facts(handle)?;
        let actual = final_path(handle)?;
        if !equal(&actual, &path) {
            return Err(fail("file_path_invalid"));
        }
        let entry = self.entries.get_mut(&id).unwrap();
        entry.path = actual;
        entry.identity = stat.identity();
        Ok(id)
    }
    fn verify(&mut self, id: u32) -> Result<FileStat> {
        let entry = self.entry(id)?;
        let (handle, path, identity) = (
            entry.object.raw(),
            entry.path.clone(),
            entry.identity.clone(),
        );
        let stat = self.facts(handle)?;
        if stat.identity() != identity || !equal(&final_path(handle)?, &path) {
            return Err(fail("file_root_changed"));
        }
        Ok(stat)
    }
    pub fn verify_root(&mut self) -> Result<()> {
        let ids: Vec<_> = self.ancestors.iter().copied().chain([self.root]).collect();
        for id in ids {
            self.verify(id)?;
        }
        Ok(())
    }
    pub fn stat(&mut self, id: u32) -> Result<FileStat> {
        self.verify(id)
    }
    pub fn verify_owner(&mut self, id: u32) -> Result<()> {
        let stat = self.verify(id)?;
        if stat.owner != self.sid || (stat.kind == "file" && stat.nlink != "1") {
            return Err(fail("file_owner_invalid"));
        }
        Ok(())
    }
    fn protected(&self, path: &str) -> bool {
        self.denied.iter().any(|denied| {
            equal(path, denied)
                || path
                    .get(..denied.len())
                    .is_some_and(|prefix| equal(prefix, denied))
                    && path.as_bytes().get(denied.len()) == Some(&b'\\')
        })
    }
    pub fn open_at(
        &mut self,
        parent: u32,
        name: String,
        kind: String,
        strict: bool,
    ) -> Result<u32> {
        let result = self.open_checked(parent, name, kind, strict);
        if result
            .as_ref()
            .is_err_and(|e| e.reason == "file_close_unknown")
        {
            self.uncertain = true;
        }
        result
    }
    fn open_checked(
        &mut self,
        parent: u32,
        name: String,
        kind: String,
        strict: bool,
    ) -> Result<u32> {
        self.verify_root()?;
        if name != "." || kind != "directory" {
            component(&name)?;
        }
        self.verify(parent)?;
        if kind == "create-directory" {
            self.verify_owner(parent)?;
        }
        let entry = self.entry(parent)?;
        let path = if name == "." {
            entry.path.clone()
        } else {
            child(&entry.path, &name)
        };
        if (strict || self.protect_reads || kind == "create-directory") && self.protected(&path) {
            return Err(fail("file_path_protected"));
        }
        entry.object.dir()?;
        let object = match kind.as_str() {
            "directory" => Object::Directory(ManuallyDrop::new(Dir::from_std_file(native_open(
                entry.object.raw(),
                &name,
                0x1200a1,
                Some(true),
                null_mut(),
                false,
            )?))),
            "read" => Object::File(ManuallyDrop::new(File::from_std(native_open(
                entry.object.raw(),
                &name,
                0x120089,
                Some(false),
                null_mut(),
                false,
            )?))),
            "temporary" | "create-directory" => {
                let text: Vec<u16> = format!(
                    "O:{}D:P(A;{};FA;;;{})\0",
                    self.sid,
                    if kind == "create-directory" {
                        "OICI"
                    } else {
                        ""
                    },
                    self.sid
                )
                .encode_utf16()
                .collect();
                let mut descriptor = null_mut();
                check(unsafe {
                    ConvertStringSecurityDescriptorToSecurityDescriptorW(
                        text.as_ptr(),
                        1,
                        &mut descriptor,
                        null_mut(),
                    )
                })?;
                let result = native_open(
                    entry.object.raw(),
                    &name,
                    0x13019f,
                    Some(kind == "create-directory"),
                    descriptor,
                    true,
                );
                // Register the actual created resource before any further fallible check.
                let result = result.and_then(|file| {
                    self.add(
                        if kind == "create-directory" {
                            Object::Directory(ManuallyDrop::new(Dir::from_std_file(file)))
                        } else {
                            Object::File(ManuallyDrop::new(File::from_std(file)))
                        },
                        path.clone(),
                        kind == "temporary",
                    )
                });
                if let Err(error) = free(descriptor.cast()) {
                    self.uncertain = true;
                    return Err(error);
                }
                return result;
            }
            _ => return Err(fail("file_io_invalid")),
        };
        let id = self.add(object, path, false)?;
        if (kind == "directory") != (self.stat(id)?.kind == "directory") {
            return Err(fail("file_not_regular"));
        }
        Ok(id)
    }
    pub fn read(&mut self, id: u32, bytes: &mut [u8]) -> Result<u32> {
        if bytes.is_empty() || bytes.len() > 65536 {
            return Err(fail("file_io_invalid"));
        }
        let mut file = self.entry(id)?.object.file()?;
        Ok(file.read(bytes).map_err(io_error)? as u32)
    }
    pub fn write(&mut self, id: u32, bytes: &[u8]) -> Result<()> {
        let entry = self.entry(id)?;
        if !entry.temporary {
            return Err(fail("file_io_invalid"));
        }
        let mut file = entry.object.file()?;
        file.write_all(bytes).map_err(io_error)
    }
    pub fn sync(&mut self, id: u32) -> Result<()> {
        let stat = self.verify(id)?;
        if stat.kind == "directory" {
            return Ok(());
        }
        self.entry(id)?.object.file()?.sync_all().map_err(io_error)
    }
    pub fn publish_at(
        &mut self,
        parent: u32,
        temp: String,
        target: String,
        create_only: bool,
    ) -> Result<()> {
        self.verify_root()?;
        component(&temp)?;
        component(&target)?;
        self.verify(parent)?;
        let directory = self.entry(parent)?;
        let (parent_handle, from, to) = (
            directory.object.raw(),
            child(&directory.path, &temp),
            child(&directory.path, &target),
        );
        if self.protect_reads && self.protected(&to) {
            return Err(fail("file_path_protected"));
        }
        let id = self
            .entries
            .iter()
            .find(|(_, e)| e.temporary && equal(&e.path, &from))
            .map(|(id, _)| *id)
            .ok_or_else(|| fail("file_io_invalid"))?;
        self.verify(id)?;
        let handle = self.entry(id)?.object.raw();
        let name: Vec<u16> = target.encode_utf16().collect();
        let bytes = offset_of!(FILE_RENAME_INFORMATION, FileName) + name.len() * 2;
        let mut storage = vec![0u64; bytes.max(size_of::<FILE_RENAME_INFORMATION>()).div_ceil(8)];
        let info = storage.as_mut_ptr().cast::<FILE_RENAME_INFORMATION>();
        unsafe {
            (*info).Anonymous.ReplaceIfExists = !create_only;
            (*info).RootDirectory = parent_handle;
            (*info).FileNameLength = (name.len() * 2) as u32;
            std::ptr::copy_nonoverlapping(
                name.as_ptr(),
                std::ptr::addr_of_mut!((*info).FileName).cast(),
                name.len(),
            );
        }
        let mut iosb: IO_STATUS_BLOCK = unsafe { zeroed() };
        let status = unsafe {
            NtSetInformationFile(
                handle,
                &mut iosb,
                info.cast(),
                bytes as u32,
                FileRenameInformation,
            )
        };
        if status < 0 {
            nt_status(status)?;
        }
        if status != 0 || unsafe { iosb.Anonymous.Status } != 0 {
            return Err(fail("file_publish_outcome_unknown"));
        }
        self.entries.get_mut(&id).unwrap().path = to;
        #[cfg(test)]
        if FAIL_AFTER_PUBLISH.with(|value| value.get()) {
            return Err(fail("file_publish_outcome_unknown"));
        }
        self.verify(id)
            .and_then(|_| self.verify_root())
            .and_then(|_| self.verify(parent).map(|_| ()))
            .map_err(|_| fail("file_publish_outcome_unknown"))
    }
    pub fn unlink_at(&mut self, parent: u32, name: String, strict: bool) -> Result<()> {
        self.verify_root()?;
        component(&name)?;
        self.verify(parent)?;
        let directory = self.entry(parent)?;
        let (parent_handle, path) = (directory.object.raw(), child(&directory.path, &name));
        if (strict || self.protect_reads) && self.protected(&path) {
            return Err(fail("file_path_protected"));
        }
        let file = native_open(
            parent_handle,
            &name,
            0x130089,
            Some(false),
            null_mut(),
            false,
        )?;
        let id = self.add(
            Object::File(ManuallyDrop::new(File::from_std(file))),
            path,
            false,
        )?;
        let result = (|| {
            if strict {
                self.verify_owner(id)?;
            }
            let info = FILE_DISPOSITION_INFO { DeleteFile: true };
            check(unsafe {
                SetFileInformationByHandle(
                    self.entry(id)?.object.raw(),
                    FileDispositionInfo,
                    (&info as *const FILE_DISPOSITION_INFO).cast(),
                    size_of::<FILE_DISPOSITION_INFO>() as u32,
                )
            })
        })();
        if let Err(error) = result {
            self.close_id(id)?;
            return Err(error);
        }
        let confirm = (|| {
            self.close_id(id)?;
            match native_open(
                parent_handle,
                &name,
                0x120089,
                Some(false),
                null_mut(),
                false,
            ) {
                Err(error) if error.reason.starts_with("ENOENT:") => self.verify_root(),
                Err(error) => Err(error),
                Ok(file) => {
                    let probe = self.add(
                        Object::File(ManuallyDrop::new(File::from_std(file))),
                        child(&self.entry(parent)?.path, &name),
                        false,
                    )?;
                    self.close_id(probe)?;
                    Err(fail("file_publication_changed"))
                }
            }
        })();
        confirm.map_err(|_| fail("file_publish_outcome_unknown"))
    }
    pub fn list_at(&mut self, parent: u32) -> Result<Vec<DirectoryEntry>> {
        self.verify_root()?;
        self.verify(parent)?;
        let directory = self.entry(parent)?;
        directory.object.dir()?;
        let mut buffer = vec![0u64; 8192];
        let mut restart = true;
        let mut entries = Vec::new();
        loop {
            let class = if restart {
                FileIdBothDirectoryRestartInfo
            } else {
                FileIdBothDirectoryInfo
            };
            restart = false;
            if unsafe {
                GetFileInformationByHandleEx(
                    directory.object.raw(),
                    class,
                    buffer.as_mut_ptr().cast(),
                    65536,
                )
            } == 0
            {
                if std::io::Error::last_os_error().raw_os_error() == Some(18) {
                    break;
                }
                return Err(os_error());
            }
            let mut offset = 0usize;
            loop {
                if offset + size_of::<FILE_ID_BOTH_DIR_INFO>() > 65536 {
                    return Err(fail("file_directory_invalid"));
                }
                let info = unsafe {
                    &*(buffer
                        .as_ptr()
                        .cast::<u8>()
                        .add(offset)
                        .cast::<FILE_ID_BOTH_DIR_INFO>())
                };
                let length = info.FileNameLength as usize;
                let start = offset + offset_of!(FILE_ID_BOTH_DIR_INFO, FileName);
                let next = info.NextEntryOffset as usize;
                if length < 2
                    || length % 2 != 0
                    || start + length > 65536
                    || (next != 0
                        && (next % 8 != 0
                            || offset + next < start + length
                            || offset + next >= 65536))
                {
                    return Err(fail("file_directory_invalid"));
                }
                let name = String::from_utf16(unsafe {
                    std::slice::from_raw_parts(
                        buffer.as_ptr().cast::<u8>().add(start).cast::<u16>(),
                        length / 2,
                    )
                })
                .map_err(|_| fail("file_directory_encoding_invalid"))?;
                if name != "." && name != ".." {
                    component(&name)?;
                    if !self.protect_reads || !self.protected(&child(&directory.path, &name)) {
                        entries.push(DirectoryEntry {
                            name,
                            kind: if info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                                "symlink"
                            } else if info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0 {
                                "directory"
                            } else {
                                "file"
                            }
                            .into(),
                        });
                    }
                }
                if next == 0 {
                    break;
                }
                offset += next;
            }
        }
        self.verify_root()?;
        self.verify(parent)?;
        Ok(entries)
    }
    fn close_id(&mut self, id: u32) -> Result<()> {
        let entry = self
            .entries
            .get_mut(&id)
            .ok_or_else(|| fail("file_closed"))?;
        if entry.uncertain {
            return Err(fail("file_close_unknown"));
        }
        if !close_object(entry.object.raw()) {
            entry.uncertain = true;
            self.uncertain = true;
            return Err(fail("file_close_unknown"));
        }
        unsafe {
            entry.object.forget();
        }
        self.entries.remove(&id);
        Ok(())
    }
    pub fn close_handle(&mut self, id: u32) -> Result<()> {
        if id == self.root || self.ancestors.contains(&id) {
            return Err(fail("file_io_invalid"));
        }
        self.close_id(id)
    }
    pub fn close(&mut self) -> Result<()> {
        if self.closed {
            return Ok(());
        }
        let ids: Vec<_> = self
            .entries
            .keys()
            .rev()
            .copied()
            .filter(|id| *id != self.root && !self.ancestors.contains(id))
            .collect();
        for id in ids {
            self.close_id(id)?;
        }
        if self.uncertain {
            return Err(fail("file_close_unknown"));
        }
        for id in std::iter::once(self.root)
            .chain(self.ancestors.iter().rev().copied())
            .collect::<Vec<_>>()
        {
            if self.entries.contains_key(&id) {
                self.close_id(id)?;
            }
        }
        self.closed = true;
        Ok(())
    }
}
impl Drop for Owner {
    fn drop(&mut self) {
        if self.close().is_err() {
            let entries = std::mem::take(&mut self.entries);
            let retained = Self {
                entries,
                ancestors: std::mem::take(&mut self.ancestors),
                root: self.root,
                serial: self.serial,
                denied: std::mem::take(&mut self.denied),
                sid: std::mem::take(&mut self.sid),
                protect_reads: self.protect_reads,
                closed: false,
                uncertain: true,
            };
            self.closed = true;
            RETAINED.lock().unwrap().push(retained);
        }
    }
}

// All HANDLE acquisition is registered before metadata validation. Upstream path helpers can
// close rejected probes implicitly; that cannot prove our explicit close/unknown contract.
// The generated SDK supplies ABI types; cap-std owns capabilities and stream IO.
fn native_open(
    parent: HANDLE,
    name: &str,
    access: u32,
    directory: Option<bool>,
    descriptor: PSECURITY_DESCRIPTOR,
    create: bool,
) -> Result<fs::File> {
    let mut name: Vec<u16> = name.encode_utf16().collect();
    let mut unicode = UNICODE_STRING {
        Length: (name.len() * 2) as u16,
        MaximumLength: (name.len() * 2) as u16,
        Buffer: name.as_mut_ptr(),
    };
    let attributes = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: parent,
        ObjectName: &mut unicode,
        Attributes: OBJ_CASE_INSENSITIVE,
        SecurityDescriptor: descriptor.cast(),
        SecurityQualityOfService: null_mut(),
    };
    let mut iosb: IO_STATUS_BLOCK = unsafe { zeroed() };
    let mut handle = null_mut();
    let options = FILE_OPEN_REPARSE_POINT
        | FILE_SYNCHRONOUS_IO_NONALERT
        | match directory {
            Some(true) => FILE_DIRECTORY_FILE,
            Some(false) => FILE_NON_DIRECTORY_FILE,
            None => 0,
        };
    let status = unsafe {
        NtCreateFile(
            &mut handle,
            access,
            &attributes,
            &mut iosb,
            null(),
            FILE_ATTRIBUTE_NORMAL,
            if directory != Some(false) || create {
                3
            } else {
                7
            },
            if create { FILE_CREATE } else { FILE_OPEN },
            options,
            null(),
            0,
        )
    };
    if status != 0 && !handle.is_null() {
        UNRELEASED.lock().unwrap().push(handle as usize);
        return Err(fail("file_close_unknown"));
    }
    nt_status(status)?;
    if handle.is_null() {
        return Err(fail("file_io_failed"));
    }
    #[cfg(test)]
    if FAIL_OPEN_CONFIRMATION.with(|flag| flag.replace(false)) {
        UNRELEASED.lock().unwrap().push(handle as usize);
        return Err(fail("file_close_unknown"));
    }
    Ok(unsafe { fs::File::from_raw_handle(handle.cast()) })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn root(label: &str) -> std::path::PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("kite-files-{label}-{}-{nonce}", std::process::id()));
        fs::create_dir(&root).unwrap();
        fs::canonicalize(root)
            .unwrap()
            .to_string_lossy()
            .strip_prefix("\\\\?\\")
            .unwrap()
            .into()
    }
    #[test]
    fn close_unknown_keeps_parents_and_never_retries_the_uncertain_original() {
        let root = root("close");
        let mut owner = Owner::new(root.to_string_lossy().into(), vec![], false).unwrap();
        let id = owner
            .open_at(owner.root(), "temporary".into(), "temporary".into(), false)
            .unwrap();
        let handle = owner.entry(id).unwrap().object.raw();
        FAIL_CLOSE.with(|value| value.set(handle as usize));
        assert_eq!(
            owner.close_handle(id).unwrap_err().reason,
            "file_close_unknown"
        );
        let attempts = CLOSE_ATTEMPTS.with(|n| n.get());
        assert_eq!(owner.close().unwrap_err().reason, "file_close_unknown");
        assert_eq!(CLOSE_ATTEMPTS.with(|n| n.get()), attempts);
        assert!(owner.entries.contains_key(&owner.root()));
        assert!(
            owner
                .ancestors
                .iter()
                .all(|id| owner.entries.contains_key(id))
        );
        assert!(fs::rename(&root, root.with_extension("moved")).is_err());
        // Test-only cleanup confirms the still-live original; production has no reset/retry port.
        FAIL_CLOSE.with(|value| value.set(0));
        assert_ne!(unsafe { CloseHandle(handle) }, 0);
        unsafe {
            owner.entries.get_mut(&id).unwrap().object.forget();
        }
        owner.entries.remove(&id);
        owner.uncertain = false;
        owner.close().unwrap();
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn unconfirmed_directory_creation_retains_ancestors_and_is_not_retried() {
        let root = root("directory-open");
        let mut owner = Owner::new(root.to_string_lossy().into(), vec![], false).unwrap();
        FAIL_OPEN_CONFIRMATION.with(|value| value.set(true));
        let error = owner
            .open_at(
                owner.root(),
                "created".into(),
                "create-directory".into(),
                true,
            )
            .unwrap_err();
        assert_eq!(error.reason, "file_close_unknown");
        assert!(root.join("created").is_dir());
        let attempts = CLOSE_ATTEMPTS.with(|n| n.get());
        assert_eq!(owner.close().unwrap_err().reason, "file_close_unknown");
        assert_eq!(CLOSE_ATTEMPTS.with(|n| n.get()), attempts);
        assert!(owner.entries.contains_key(&owner.root()));
        assert!(fs::rename(&root, root.with_extension("moved")).is_err());
        // Only this test resolves the injected uncertainty using its original HANDLE.
        let handle = UNRELEASED.lock().unwrap().pop().unwrap() as HANDLE;
        assert_ne!(unsafe { CloseHandle(handle) }, 0);
        owner.uncertain = false;
        owner.close().unwrap();
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn unconfirmed_open_retains_original_ancestors_without_retrying_the_handle() {
        let root = root("open");
        fs::write(root.join("original"), b"original").unwrap();
        let mut owner = Owner::new(root.to_string_lossy().into(), vec![], false).unwrap();
        FAIL_OPEN_CONFIRMATION.with(|value| value.set(true));
        let error = owner
            .open_at(owner.root(), "original".into(), "read".into(), true)
            .unwrap_err();
        assert_eq!(error.reason, "file_close_unknown");
        let attempts = CLOSE_ATTEMPTS.with(|n| n.get());
        assert_eq!(owner.close().unwrap_err().reason, "file_close_unknown");
        assert_eq!(CLOSE_ATTEMPTS.with(|n| n.get()), attempts);
        assert!(owner.entries.contains_key(&owner.root()));
        assert!(
            owner
                .ancestors
                .iter()
                .all(|id| owner.entries.contains_key(id))
        );
        assert!(fs::rename(&root, root.with_extension("moved")).is_err());
        // The injected uncertainty is resolved only by this test's original HANDLE.
        let handle = UNRELEASED.lock().unwrap().pop().unwrap() as HANDLE;
        assert_ne!(unsafe { CloseHandle(handle) }, 0);
        owner.uncertain = false;
        owner.close().unwrap();
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn actual_publication_followed_by_failed_confirmation_retains_unknown() {
        let root = root("publish");
        let mut owner = Owner::new(root.to_string_lossy().into(), vec![], false).unwrap();
        let id = owner
            .open_at(owner.root(), "temporary".into(), "temporary".into(), false)
            .unwrap();
        owner.write(id, b"actual published bytes").unwrap();
        owner.sync(id).unwrap();
        FAIL_AFTER_PUBLISH.with(|value| value.set(true));
        let result = owner.publish_at(owner.root(), "temporary".into(), "actual".into(), true);
        FAIL_AFTER_PUBLISH.with(|value| value.set(false));
        assert_eq!(result.unwrap_err().reason, "file_publish_outcome_unknown");
        assert_eq!(
            fs::read(root.join("actual")).unwrap(),
            b"actual published bytes"
        );
        owner.close().unwrap();
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn actual_windows_short_name_never_acquires_a_root_capability() {
        let long = std::env::var("ProgramFiles").unwrap();
        let encoded: Vec<u16> = format!("{long}\0").encode_utf16().collect();
        let mut short = vec![0; 32768];
        let length =
            unsafe { GetShortPathNameW(encoded.as_ptr(), short.as_mut_ptr(), short.len() as u32) };
        assert!(length > 0 && (length as usize) < short.len());
        let short = String::from_utf16(&short[..length as usize]).unwrap();
        assert!(
            !equal(&long, &short),
            "this filesystem has no actual 8.3 alias; qualification unavailable"
        );
        let error = Owner::new(short, vec![], false)
            .err()
            .expect("short alias was accepted");
        assert_eq!(error.reason, "file_path_invalid");
    }
}
