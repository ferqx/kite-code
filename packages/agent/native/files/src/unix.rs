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
#[cfg(test)]
thread_local! {
    static FAIL_CLOSE: std::cell::Cell<i32> = const { std::cell::Cell::new(-1) };
    static FAIL_NEXT_CLOSE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static CLOSE_ATTEMPTS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}
fn close_object(fd: i32) -> bool {
    #[cfg(test)]
    {
        CLOSE_ATTEMPTS.with(|n| n.set(n.get() + 1));
        if FAIL_CLOSE.with(|target| target.get() == fd)
            || FAIL_NEXT_CLOSE.with(|value| value.replace(false))
        {
            return false;
        }
    }
    unsafe { libc::close(fd) == 0 }
}
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
        #[cfg(target_os = "linux")]
        if matches!(&self.entry(id)?.object, Object::Directory(_)) {
            // cap-std directory capabilities use O_PATH on Linux, which cannot be fsynced.
            // Reopen only "." under the original capability, never its ambient pathname.
            self.verify_root()?;
            let identity = self.stat(id)?.identity();
            let probe = self
                .serial
                .checked_add(1)
                .ok_or_else(|| fail("file_io_failed"))?;
            let mut options = OpenOptions::new();
            options
                .read(true)
                .follow(FollowSymlinks::No)
                .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC);
            let file = self
                .entry(id)?
                .object
                .dir()?
                .open_with(".", &options)
                .map_err(io_error)?;
            // add registers before metadata checks. Even if those checks fail, close this
            // exact registered FD; an uncertain close takes precedence and retains the owner.
            let result = self
                .add(
                    Object::Directory(ManuallyDrop::new(Dir::from_std_file(file.into_std()))),
                    false,
                )
                .and_then(|opened| {
                    let actual = self.stat(opened)?;
                    if actual.kind != "directory" || actual.identity() != identity {
                        return Err(fail("file_changed"));
                    }
                    self.verify_root()?;
                    if unsafe { libc::fsync(self.entry(opened)?.object.raw()) } != 0 {
                        return Err(io_error(std::io::Error::last_os_error()));
                    }
                    Ok(())
                });
            self.close_id(probe)?;
            return result;
        }
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
        // Any unknown resource pins the whole original owner, including relative parents.
        if self.uncertain {
            return Err(fail("file_close_unknown"));
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn root(label: &str) -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("kite-files-{label}-{}-{nonce}", std::process::id()));
        fs::create_dir(&root).unwrap();
        fs::canonicalize(root).unwrap()
    }

    #[test]
    fn nested_close_unknown_retains_entire_owner_through_disposal() {
        let root = root("nested-close");
        let mut owner = Owner::new(root.to_string_lossy().into(), vec![], false).unwrap();
        let parent = owner
            .open_at(
                owner.root(),
                "parent".into(),
                "create-directory".into(),
                true,
            )
            .unwrap();
        let child = owner
            .open_at(parent, "child".into(), "create-directory".into(), true)
            .unwrap();
        let id = owner
            .open_at(child, "temporary".into(), "temporary".into(), false)
            .unwrap();
        let fd = owner.entry(id).unwrap().object.raw();
        FAIL_CLOSE.with(|value| value.set(fd));
        assert_eq!(
            owner.close_handle(id).unwrap_err().reason,
            "file_close_unknown"
        );
        let attempts = CLOSE_ATTEMPTS.with(|n| n.get());
        for ancestor in [child, parent] {
            assert_eq!(
                owner.close_handle(ancestor).unwrap_err().reason,
                "file_close_unknown"
            );
            assert!(owner.entries.contains_key(&ancestor));
        }
        assert_eq!(owner.close().unwrap_err().reason, "file_close_unknown");
        drop(owner);
        assert_eq!(CLOSE_ATTEMPTS.with(|n| n.get()), attempts);
        let mut owner = {
            let mut retained = RETAINED.lock().unwrap();
            let index = retained
                .iter()
                .position(|owner| owner.path == root)
                .unwrap();
            retained.remove(index)
        };
        for original in [owner.root(), parent, child, id] {
            let entry = owner.entries.get(&original).unwrap();
            assert_ne!(
                unsafe { libc::fcntl(entry.object.raw(), libc::F_GETFD) },
                -1
            );
        }
        // Only this test confirms the injected still-live FD; production has no reset port.
        FAIL_CLOSE.with(|value| value.set(-1));
        assert_eq!(unsafe { libc::close(fd) }, 0);
        unsafe {
            owner.entries.get_mut(&id).unwrap().object.forget();
        }
        owner.entries.remove(&id);
        owner.uncertain = false;
        owner.close().unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn directory_sync_uses_original_root_and_nested_capabilities() {
        let root = root("directory-sync");
        let mut owner = Owner::new(root.to_string_lossy().into(), vec![], false).unwrap();
        owner.sync(owner.root()).unwrap();
        assert_eq!(owner.entries.len(), 1);
        let parent = owner
            .open_at(
                owner.root(),
                "parent".into(),
                "create-directory".into(),
                true,
            )
            .unwrap();
        let child = owner
            .open_at(parent, "child".into(), "create-directory".into(), true)
            .unwrap();
        let original = owner.stat(child).unwrap().identity();
        fs::rename(root.join("parent/child"), root.join("parent/moved")).unwrap();
        fs::create_dir(root.join("parent/child")).unwrap();
        for directory in [owner.root(), parent, child] {
            owner.sync(directory).unwrap();
            assert_eq!(owner.entries.len(), 3);
        }
        assert_eq!(owner.stat(child).unwrap().identity(), original);
        let replacement = owner
            .open_at(parent, "child".into(), "directory".into(), true)
            .unwrap();
        assert_ne!(owner.stat(replacement).unwrap().identity(), original);
        let file = owner
            .open_at(child, "temporary".into(), "temporary".into(), false)
            .unwrap();
        owner.write(file, b"original capability").unwrap();
        owner.sync(file).unwrap();
        owner.close().unwrap();
        assert_eq!(
            fs::read(root.join("parent/moved/temporary")).unwrap(),
            b"original capability"
        );
        assert!(!root.join("parent/child/temporary").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn directory_sync_close_unknown_retains_probe_and_original_chain() {
        let root = root("directory-sync-close");
        let mut owner = Owner::new(root.to_string_lossy().into(), vec![], false).unwrap();
        let parent = owner
            .open_at(
                owner.root(),
                "parent".into(),
                "create-directory".into(),
                true,
            )
            .unwrap();
        let child = owner
            .open_at(parent, "child".into(), "create-directory".into(), true)
            .unwrap();
        FAIL_NEXT_CLOSE.with(|value| value.set(true));
        assert_eq!(owner.sync(child).unwrap_err().reason, "file_close_unknown");
        let probe = owner.serial;
        let fd = owner.entries.get(&probe).unwrap().object.raw();
        let attempts = CLOSE_ATTEMPTS.with(|n| n.get());
        assert_eq!(
            owner.close_handle(child).unwrap_err().reason,
            "file_close_unknown"
        );
        assert_eq!(
            owner.close_handle(parent).unwrap_err().reason,
            "file_close_unknown"
        );
        assert_eq!(owner.close().unwrap_err().reason, "file_close_unknown");
        drop(owner);
        assert_eq!(CLOSE_ATTEMPTS.with(|n| n.get()), attempts);
        let mut owner = {
            let mut retained = RETAINED.lock().unwrap();
            let index = retained
                .iter()
                .position(|owner| owner.path == root)
                .unwrap();
            retained.remove(index)
        };
        for original in [owner.root(), parent, child, probe] {
            assert_ne!(
                unsafe {
                    libc::fcntl(
                        owner.entries.get(&original).unwrap().object.raw(),
                        libc::F_GETFD,
                    )
                },
                -1
            );
        }
        // Only this test resolves the injected still-live sync FD.
        assert_eq!(unsafe { libc::close(fd) }, 0);
        unsafe {
            owner.entries.get_mut(&probe).unwrap().object.forget();
        }
        owner.entries.remove(&probe);
        owner.uncertain = false;
        owner.close().unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}
