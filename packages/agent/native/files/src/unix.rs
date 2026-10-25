use crate::{DirectoryEntry, FileStat, fail, io_error};
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{
    Dir, DirBuilder, DirBuilderExt, File, Metadata, MetadataExt, OpenOptions, OpenOptionsExt,
};
use napi::Result;
use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::mem::ManuallyDrop;
use std::os::fd::{AsRawFd, IntoRawFd};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

static RETAINED: Mutex<Vec<Owner>> = Mutex::new(Vec::new());
fn component(value: &str) -> Result<()> {
    if value.is_empty()
        || value == "."
        || value == ".."
        || value.len() > 255
        || value.contains(['/', '\\', '\0'])
    {
        return Err(fail("file_path_invalid"));
    }
    Ok(())
}
fn facts(value: Metadata) -> FileStat {
    FileStat {
        dev: value.dev().to_string(),
        ino: value.ino().to_string(),
        size: value.len().to_string(),
        mtime_ns: (value.mtime() as i128 * 1_000_000_000 + value.mtime_nsec() as i128).to_string(),
        ctime_ns: (value.ctime() as i128 * 1_000_000_000 + value.ctime_nsec() as i128).to_string(),
        nlink: value.nlink().to_string(),
        owner: value.uid().to_string(),
        kind: if value.is_file() {
            "file"
        } else if value.is_dir() {
            "directory"
        } else {
            "other"
        }
        .into(),
    }
}
enum Object {
    Directory(ManuallyDrop<Dir>),
    File(ManuallyDrop<File>),
}
impl Object {
    fn raw(&self) -> i32 {
        match self {
            Self::Directory(v) => v.as_raw_fd(),
            Self::File(v) => v.as_raw_fd(),
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
    fn stat(&self) -> Result<FileStat> {
        Ok(facts(
            match self {
                Self::Directory(v) => v.dir_metadata(),
                Self::File(v) => v.metadata(),
            }
            .map_err(io_error)?,
        ))
    }
    unsafe fn forget(&mut self) {
        match self {
            Self::Directory(v) => {
                let _ = unsafe { ManuallyDrop::take(v) }
                    .into_std_file()
                    .into_raw_fd();
            }
            Self::File(v) => {
                let _ = unsafe { ManuallyDrop::take(v) }.into_std().into_raw_fd();
            }
        }
    }
}
struct Entry {
    object: Object,
    identity: String,
    temporary: bool,
    uncertain: bool,
}
pub struct Owner {
    entries: BTreeMap<u32, Entry>,
    root: u32,
    serial: u32,
    path: PathBuf,
    denied: Vec<PathBuf>,
    protect_reads: bool,
    uid: String,
    closed: bool,
    uncertain: bool,
}
impl Owner {
    pub fn new(root: String, protected: Vec<String>, protect_reads: bool) -> Result<Self> {
        let path = Path::new(&root);
        if !path.is_absolute() || root.contains(['\\', '\0']) {
            return Err(fail("file_path_invalid"));
        }
        let mut denied = Vec::new();
        for path in protected {
            let mut logical = PathBuf::new();
            let parts: Vec<_> = path.split('/').filter(|s| !s.is_empty()).collect();
            if parts.is_empty() {
                return Err(fail("file_path_invalid"));
            }
            for name in parts {
                component(name)?;
                logical.push(name);
            }
            denied.push(logical);
        }
        let mut current = PathBuf::from("/");
        for part in path.components() {
            match part {
                Component::RootDir => (),
                Component::Normal(name) => {
                    current.push(name);
                    if fs::symlink_metadata(&current)
                        .map_err(io_error)?
                        .is_symlink()
                    {
                        return Err(fail("file_symlink"));
                    }
                }
                _ => return Err(fail("file_path_invalid")),
            }
        }
        if fs::canonicalize(path).map_err(io_error)? != path {
            return Err(fail("file_root_invalid"));
        }
        let dir = Dir::open_ambient_dir(path, cap_std::ambient_authority()).map_err(io_error)?;
        let mut value = Self {
            entries: BTreeMap::new(),
            root: 0,
            serial: 0,
            path: path.into(),
            denied,
            protect_reads,
            uid: unsafe { libc::getuid() }.to_string(),
            closed: false,
            uncertain: false,
        };
        value.root = value.add(Object::Directory(ManuallyDrop::new(dir)), false)?;
        value.verify_root()?;
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
        self.entries
            .get(&id)
            .filter(|e| !e.uncertain)
            .ok_or_else(|| fail("file_closed"))
    }
    fn add(&mut self, object: Object, temporary: bool) -> Result<u32> {
        self.serial = self
            .serial
            .checked_add(1)
            .ok_or_else(|| fail("file_io_failed"))?;
        let id = self.serial;
        self.entries.insert(
            id,
            Entry {
                object,
                identity: String::new(),
                temporary,
                uncertain: false,
            },
        );
        let identity = self.entry(id)?.object.stat()?.identity();
        self.entries.get_mut(&id).unwrap().identity = identity;
        Ok(id)
    }
    pub fn verify_root(&mut self) -> Result<()> {
        let original = self.entry(self.root)?.object.stat()?;
        let current = fs::symlink_metadata(&self.path).map_err(io_error)?;
        use std::os::unix::fs::MetadataExt;
        if current.is_symlink()
            || !current.is_dir()
            || current.dev().to_string() != original.dev
            || current.ino().to_string() != original.ino
            || fs::canonicalize(&self.path).map_err(io_error)? != self.path
        {
            return Err(fail("file_root_changed"));
        }
        Ok(())
    }
    pub fn stat(&mut self, id: u32) -> Result<FileStat> {
        let entry = self.entry(id)?;
        let stat = entry.object.stat()?;
        if stat.identity() != entry.identity {
            return Err(fail("file_changed"));
        }
        Ok(stat)
    }
    pub fn verify_owner(&mut self, id: u32) -> Result<()> {
        if self.stat(id)?.owner != self.uid {
            return Err(fail("file_owner_invalid"));
        }
        Ok(())
    }
    fn protected(&self, parent: u32, name: &str) -> Result<bool> {
        // The engine supplies one validated component at a time; compare actual directory identity.
        let dir = self.entry(parent)?.object.dir()?;
        for path in &self.denied {
            if let Some(leaf) = path.file_name() {
                if leaf != name {
                    continue;
                }
                let base = path.parent().unwrap_or(Path::new(""));
                let root = self.entry(self.root)?.object.dir()?;
                let expected = root.open_dir_nofollow(if base.as_os_str().is_empty() {
                    Path::new(".")
                } else {
                    base
                });
                if let Ok(expected) = expected {
                    let a = facts(expected.dir_metadata().map_err(io_error)?);
                    let b = facts(dir.dir_metadata().map_err(io_error)?);
                    if a.identity() == b.identity() {
                        return Ok(true);
                    }
                }
            }
        }
        Ok(false)
    }
    pub fn open_at(
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
        if (strict || self.protect_reads || kind == "create-directory")
            && self.protected(parent, &name)?
        {
            return Err(fail("file_path_protected"));
        }
        if kind == "create-directory" {
            // One component under the retained parent; never ambient mkdir_all or a followed link.
            self.verify_owner(parent)?;
            let mut builder = DirBuilder::new();
            builder.mode(0o700);
            self.entry(parent)?
                .object
                .dir()?
                .create_dir_with(&name, &builder)
                .map_err(io_error)?;
        }
        let dir = self.entry(parent)?.object.dir()?;
        let object = if kind == "directory" || kind == "create-directory" {
            Object::Directory(ManuallyDrop::new(
                dir.open_dir_nofollow(&name).map_err(io_error)?,
            ))
        } else {
            let mut options = OpenOptions::new();
            options
                .follow(FollowSymlinks::No)
                .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK);
            match kind.as_str() {
                "read" => {
                    options.read(true);
                }
                "temporary" => {
                    options.write(true).create_new(true).mode(0o600);
                }
                _ => return Err(fail("file_io_invalid")),
            }
            Object::File(ManuallyDrop::new(
                dir.open_with(&name, &options).map_err(io_error)?,
            ))
        };
        self.add(object, kind == "temporary")
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
        if unsafe { libc::fsync(self.entry(id)?.object.raw()) } != 0 {
            return Err(io_error(std::io::Error::last_os_error()));
        }
        Ok(())
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
        if self.protect_reads && self.protected(parent, &target)? {
            return Err(fail("file_path_protected"));
        }
        let dir = self.entry(parent)?.object.dir()?;
        if create_only {
            dir.hard_link(temp, dir, target).map_err(io_error)
        } else {
            dir.rename(temp, dir, target).map_err(io_error)
        }
    }
    pub fn unlink_at(&mut self, parent: u32, name: String, strict: bool) -> Result<()> {
        self.verify_root()?;
        component(&name)?;
        if (strict || self.protect_reads) && self.protected(parent, &name)? {
            return Err(fail("file_path_protected"));
        }
        self.entry(parent)?
            .object
            .dir()?
            .remove_file(name)
            .map_err(io_error)
    }
    pub fn list_at(&mut self, parent: u32) -> Result<Vec<DirectoryEntry>> {
        self.verify_root()?;
        let mut entries = Vec::new();
        for entry in self
            .entry(parent)?
            .object
            .dir()?
            .entries()
            .map_err(io_error)?
        {
            let entry = entry.map_err(io_error)?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| fail("file_directory_encoding_invalid"))?;
            component(&name)?;
            if self.protect_reads && self.protected(parent, &name)? {
                continue;
            }
            let kind = entry.file_type().map_err(io_error)?;
            entries.push(DirectoryEntry {
                name,
                kind: if kind.is_symlink() {
                    "symlink"
                } else if kind.is_dir() {
                    "directory"
                } else if kind.is_file() {
                    "file"
                } else {
                    "other"
                }
                .into(),
            });
        }
        self.verify_root()?;
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
        if unsafe { libc::close(entry.object.raw()) } != 0 {
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
        if id == self.root {
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
            .filter(|id| *id != self.root)
            .collect();
        for id in ids {
            self.close_id(id)?;
        }
        if self.uncertain {
            return Err(fail("file_close_unknown"));
        }
        if self.entries.contains_key(&self.root) {
            self.close_id(self.root)?;
        }
        self.closed = true;
        Ok(())
    }
}
impl Drop for Owner {
    fn drop(&mut self) {
        if self.close().is_err() {
            let retained = Self {
                entries: std::mem::take(&mut self.entries),
                root: self.root,
                serial: self.serial,
                path: std::mem::take(&mut self.path),
                denied: std::mem::take(&mut self.denied),
                protect_reads: self.protect_reads,
                uid: std::mem::take(&mut self.uid),
                closed: false,
                uncertain: true,
            };
            self.closed = true;
            RETAINED.lock().unwrap().push(retained);
        }
    }
}
