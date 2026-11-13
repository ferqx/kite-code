use napi::{
    Error, Result, Status,
    bindgen_prelude::{Buffer, Uint8Array},
};
use napi_derive::napi;

#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;
#[cfg(unix)]
use unix::Owner;
#[cfg(windows)]
use windows::Owner;

pub(crate) fn fail(code: &str) -> Error {
    Error::new(Status::GenericFailure, code.to_string())
}
#[cfg(test)]
thread_local! {
    static DIRECTORY_ENTRY_VISITS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}
/// Count encountered entries, including protected entries omitted from the result.
pub(crate) fn consume_directory_entry(remaining: &mut Option<u32>) -> Result<()> {
    #[cfg(test)]
    DIRECTORY_ENTRY_VISITS.with(|visits| visits.set(visits.get() + 1));
    if let Some(remaining) = remaining {
        if *remaining == 0 {
            return Err(fail("file_directory_entry_limit"));
        }
        *remaining -= 1;
    }
    Ok(())
}
pub(crate) fn io_error(error: std::io::Error) -> Error {
    let code = match error.kind() {
        std::io::ErrorKind::NotFound => "ENOENT",
        std::io::ErrorKind::AlreadyExists => "EEXIST",
        std::io::ErrorKind::NotADirectory => "ENOTDIR",
        std::io::ErrorKind::PermissionDenied => "EACCES",
        _ => "file_io_failed",
    };
    fail(&format!("{code}:{}", error.raw_os_error().unwrap_or(0)))
}

#[napi(object)]
pub struct FileStat {
    pub dev: String,
    pub ino: String,
    pub size: String,
    pub mtime_ns: String,
    pub ctime_ns: String,
    pub nlink: String,
    pub owner: String,
    pub kind: String,
}
impl FileStat {
    fn identity(&self) -> String {
        format!("{}:{}", self.dev, self.ino)
    }
}
#[napi(object)]
pub struct DirectoryEntry {
    pub name: String,
    pub kind: String,
}

/// Live resources belong to this object; no native handle or fd crosses Node-API.
#[napi]
pub struct NativeFiles {
    owner: Owner,
}

#[napi]
impl NativeFiles {
    #[napi(constructor)]
    pub fn new(root: String, protected: Vec<String>, protect_reads: bool) -> Result<Self> {
        Ok(Self {
            owner: Owner::new(root, protected, protect_reads)?,
        })
    }
    #[napi(getter)]
    pub fn root(&self) -> u32 {
        self.owner.root()
    }
    #[napi]
    pub fn verify_root(&mut self) -> Result<()> {
        self.owner.verify_root()
    }
    #[napi]
    pub fn stat(&mut self, id: u32) -> Result<FileStat> {
        self.owner.stat(id)
    }
    #[napi]
    pub fn verify_owner(&mut self, id: u32) -> Result<()> {
        self.owner.verify_owner(id)
    }
    #[napi]
    pub fn open_at(
        &mut self,
        parent: u32,
        name: String,
        kind: String,
        strict: bool,
    ) -> Result<u32> {
        self.owner.open_at(parent, name, kind, strict)
    }
    #[napi]
    pub fn read(&mut self, id: u32, length: u32) -> Result<Buffer> {
        if length == 0 || length > 65536 {
            return Err(fail("file_io_invalid"));
        }
        let mut bytes = vec![0; length as usize];
        let count = self.owner.read(id, &mut bytes)?;
        bytes.truncate(count as usize);
        Ok(bytes.into())
    }
    #[napi]
    pub fn write(&mut self, id: u32, bytes: Uint8Array) -> Result<()> {
        self.owner.write(id, &bytes)
    }
    #[napi]
    pub fn sync(&mut self, id: u32) -> Result<()> {
        self.owner.sync(id)
    }
    #[napi]
    pub fn publish_at(
        &mut self,
        parent: u32,
        temp: String,
        target: String,
        create_only: bool,
    ) -> Result<()> {
        self.owner.publish_at(parent, temp, target, create_only)
    }
    #[napi]
    pub fn unlink_at(&mut self, parent: u32, name: String, strict: bool) -> Result<()> {
        self.owner.unlink_at(parent, name, strict)
    }
    #[napi]
    pub fn list_at(&mut self, parent: u32) -> Result<Vec<DirectoryEntry>> {
        self.owner.list_at(parent, None)
    }
    #[napi]
    pub fn list_at_bounded(
        &mut self,
        parent: u32,
        max_entries: u32,
    ) -> Result<Vec<DirectoryEntry>> {
        self.owner.list_at(parent, Some(max_entries))
    }
    #[napi]
    pub fn close_handle(&mut self, id: u32) -> Result<()> {
        self.owner.close_handle(id)
    }
    #[napi]
    pub fn close(&mut self) -> Result<()> {
        self.owner.close()
    }
}

#[napi]
pub fn backend_version() -> &'static str {
    "kite-files:2/cap-std:4.0.3"
}

#[cfg(test)]
mod directory_tests {
    use super::*;
    use std::{fs, path::PathBuf};

    fn root(label: &str) -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "kite-files-list-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir(&path).unwrap();
        let path = fs::canonicalize(path).unwrap();
        #[cfg(windows)]
        let path = PathBuf::from(path.to_string_lossy().strip_prefix("\\\\?\\").unwrap());
        path
    }

    #[test]
    fn bounded_list_accepts_exact_budget_and_preserves_unlimited_calls() {
        let root = root("boundary");
        let mut files = NativeFiles::new(root.to_string_lossy().into(), vec![], true).unwrap();
        assert!(files.list_at_bounded(files.root(), 0).unwrap().is_empty());
        for name in ["one", "two", "three"] {
            fs::write(root.join(name), b"").unwrap();
        }
        assert_eq!(files.list_at_bounded(files.root(), 3).unwrap().len(), 3);
        assert_eq!(
            files.list_at_bounded(files.root(), 2).err().unwrap().reason,
            "file_directory_entry_limit"
        );
        assert_eq!(files.list_at(files.root()).unwrap().len(), 3);
        files.close().unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn bounded_list_counts_protected_entries_before_filtering() {
        let root = root("protected");
        for name in ["one", "two", "three"] {
            fs::write(root.join(name), b"").unwrap();
        }
        let mut files = NativeFiles::new(
            root.to_string_lossy().into(),
            vec!["one".into(), "two".into(), "three".into()],
            true,
        )
        .unwrap();
        assert!(files.list_at_bounded(files.root(), 3).unwrap().is_empty());
        DIRECTORY_ENTRY_VISITS.with(|visits| visits.set(0));
        assert_eq!(
            files.list_at_bounded(files.root(), 1).err().unwrap().reason,
            "file_directory_entry_limit"
        );
        assert_eq!(DIRECTORY_ENTRY_VISITS.with(|visits| visits.get()), 2);
        assert!(files.list_at(files.root()).unwrap().is_empty());
        files.close().unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn huge_directory_stops_at_the_first_excess_entry() {
        let root = root("huge");
        for index in 0..10_000 {
            fs::write(root.join(format!("entry-{index}")), b"").unwrap();
        }
        let mut files = NativeFiles::new(root.to_string_lossy().into(), vec![], true).unwrap();
        DIRECTORY_ENTRY_VISITS.with(|visits| visits.set(0));
        assert_eq!(
            files
                .list_at_bounded(files.root(), 1000)
                .err()
                .unwrap()
                .reason,
            "file_directory_entry_limit"
        );
        assert_eq!(DIRECTORY_ENTRY_VISITS.with(|visits| visits.get()), 1001);
        files.close().unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn bounded_list_uses_the_original_held_directory() {
        let root = root("held");
        fs::create_dir(root.join("parent")).unwrap();
        fs::write(root.join("parent/original"), b"").unwrap();
        let mut files = NativeFiles::new(root.to_string_lossy().into(), vec![], true).unwrap();
        let parent = files
            .open_at(files.root(), "parent".into(), "directory".into(), true)
            .unwrap();
        #[cfg(unix)]
        {
            fs::rename(root.join("parent"), root.join("moved")).unwrap();
            fs::create_dir(root.join("parent")).unwrap();
            fs::write(root.join("parent/replacement"), b"").unwrap();
        }
        #[cfg(windows)]
        assert!(fs::rename(root.join("parent"), root.join("moved")).is_err());
        let entries = files.list_at_bounded(parent, 1).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "original");
        assert_eq!(
            files.list_at_bounded(parent, 0).err().unwrap().reason,
            "file_directory_entry_limit"
        );
        assert_eq!(
            files.list_at_bounded(parent, 1).unwrap()[0].name,
            "original"
        );
        files.close().unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}
