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
pub(crate) fn io_error(error: std::io::Error) -> Error {
    let code = match error.kind() {
        std::io::ErrorKind::NotFound => "ENOENT",
        std::io::ErrorKind::AlreadyExists => "EEXIST",
        std::io::ErrorKind::NotADirectory => "ENOTDIR",
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
        self.owner.list_at(parent)
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
    "kite-files:1/cap-std:4.0.3"
}
