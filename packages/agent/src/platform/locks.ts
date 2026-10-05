import { dlopen, ptr } from 'bun:ffi';
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync } from 'node:fs';
import { defaultWindowsPathSecurity } from './windows-path-security';

export interface FileLock {
  readonly path: string;
  readonly mode: 'shared' | 'exclusive';
  release(): void;
}
export interface WindowsPathSecurity {
  verifyDirectory(path: string): void;
  secureFile(path: string): void;
  verifyFile(path: string): void;
}
export class LockBusyError extends Error {
  readonly code = 'owner_busy';
}
const live = new WeakSet<FileLock>();
const validators = new WeakMap<FileLock, () => void>();
const children = new WeakMap<FileLock, Set<FileLock>>();
const parents = new WeakMap<FileLock, FileLock>();
const attachments = new WeakMap<FileLock, { verify(): void; release(): void }>();
/** Internal resource ownership; preserves the actual FileLock authority object. */
export function attachLockResource(
  lock: FileLock,
  resource: { verify(): void; release(): void },
): void {
  if (process.platform !== 'win32' || !live.has(lock) || attachments.has(lock))
    throw Error('Invalid lock resource attachment.');
  resource.verify();
  const original = validators.get(lock)!;
  validators.set(lock, () => {
    original();
    resource.verify();
  });
  attachments.set(lock, resource);
}
/** Internal fixed capability composition. A child must close before its original owner. */
export function retainLockOwner(owner: FileLock, child: FileLock): void {
  if (!live.has(owner) || !live.has(child) || parents.has(child))
    throw Error('Invalid lock lifetime.');
  const owned = children.get(owner) ?? new Set<FileLock>();
  owned.add(child);
  children.set(owner, owned);
  parents.set(child, owner);
}
function beforeRelease(lock: FileLock): void {
  if (children.get(lock)?.size) throw Error('profile_data_lock_in_use');
}
function afterRelease(lock: FileLock): void {
  const parent = parents.get(lock);
  if (parent) children.get(parent)?.delete(lock);
  parents.delete(lock);
}
export function assertLiveLock(lock: FileLock, path: string, mode: FileLock['mode']): void {
  if (!live.has(lock) || lock.path !== path || lock.mode !== mode)
    throw new Error('Invalid or released lock authority.');
  validators.get(lock)?.();
}
export function acquireFileLock(
  path: string,
  mode: FileLock['mode'],
  security?: WindowsPathSecurity,
): FileLock {
  if (process.platform === 'win32')
    return acquireWindowsLock(path, mode, security ?? defaultWindowsPathSecurity());
  if (process.platform !== 'darwin' && process.platform !== 'linux')
    throw new Error('Unsupported lock platform.');
  const fd = openSync(
    path,
    constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  return acquirePosixFd(path, fd, mode);
}
/** Trusted one-shot helper owns only this inherited descriptor copy. Never unlock the shared description. */
export function acquireInheritedSharedFileLock(path: string, fd: number): FileLock {
  if (!Number.isSafeInteger(fd) || fd < 0) throw new Error('Invalid inherited lock descriptor.');
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    closeSync(fd);
    throw new Error('Inherited profile locks require POSIX.');
  }
  return acquirePosixFd(path, fd, 'shared');
}
function acquirePosixFd(path: string, fd: number, mode: FileLock['mode']): FileLock {
  try {
    verify(path, fd);
    if (posixFlock(fd, (mode === 'shared' ? 1 : 2) | 4) !== 0)
      throw new LockBusyError('Lock is busy.');
    verify(path, fd);
    let released = false;
    const lock: FileLock = Object.freeze({
      path,
      mode,
      release() {
        if (released) return;
        beforeRelease(lock);
        closeSync(fd);
        released = true;
        live.delete(lock);
        afterRelease(lock);
      },
    });
    validators.set(lock, () => verify(path, fd));
    live.add(lock);
    return lock;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}
function verify(path: string, fd: number): void {
  const target = lstatSync(path);
  const opened = fstatSync(fd);
  if (
    !target.isFile() ||
    target.isSymbolicLink() ||
    !opened.isFile() ||
    target.nlink !== 1 ||
    opened.nlink !== 1 ||
    target.dev !== opened.dev ||
    target.ino !== opened.ino ||
    (target.mode & 0o077) !== 0 ||
    (opened.mode & 0o077) !== 0 ||
    (process.getuid && (target.uid !== process.getuid() || opened.uid !== process.getuid()))
  )
    throw new Error('Lock is not a stable private regular file.');
}
let flock: ((fd: number, operation: number) => number) | undefined;
function posixFlock(fd: number, operation: number): number {
  flock ??= dlopen(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
    flock: { args: ['i32', 'i32'], returns: 'i32' },
  }).symbols.flock;
  return flock(fd, operation);
}
function acquireWindowsLock(
  path: string,
  mode: FileLock['mode'],
  security?: WindowsPathSecurity,
): FileLock {
  if (!security) throw new Error('Windows locking requires verified path security.');
  const native = defaultWindowsPathSecurity()!;
  native.verifyPath(path);
  if (!existsSync(path)) native.createFile(path);
  security.verifyFile(path);
  const api = dlopen('kernel32.dll', {
    CreateFileW: { args: ['ptr', 'u32', 'u32', 'ptr', 'u32', 'u32', 'u64'], returns: 'u64' },
    GetFileInformationByHandle: { args: ['u64', 'ptr'], returns: 'bool' },
    LockFileEx: { args: ['u64', 'u32', 'u32', 'u32', 'u32', 'ptr'], returns: 'bool' },
    UnlockFileEx: { args: ['u64', 'u32', 'u32', 'u32', 'ptr'], returns: 'bool' },
    CloseHandle: { args: ['u64'], returns: 'bool' },
  });
  const handle = api.symbols.CreateFileW(
    ptr(Buffer.from(`${path}\0`, 'utf16le')),
    0xc0000000,
    3,
    null,
    3,
    0x00200080,
    0,
  );
  if (!handle || handle === BigInt('18446744073709551615')) {
    api.close();
    throw new Error('Lock file cannot be opened.');
  }
  try {
    const info = new Uint8Array(64);
    if (!api.symbols.GetFileInformationByHandle(handle, ptr(info)))
      throw new Error('Lock metadata unavailable.');
    const view = new DataView(info.buffer);
    if ((view.getUint32(0, true) & 0x410) !== 0 || view.getUint32(40, true) !== 1)
      throw new Error('Lock must be a non-reparse regular file.');
    native.verifyHandle(handle, path, false);
    security.verifyFile(path);
    const overlapped = new Uint8Array(process.arch === 'ia32' ? 20 : 32);
    if (
      !api.symbols.LockFileEx(handle, 1 | (mode === 'exclusive' ? 2 : 0), 0, 1, 0, ptr(overlapped))
    )
      throw new LockBusyError('Lock is busy.');
    let released = false;
    let nativeClosed = false;
    let apiClosed = false;
    const lock: FileLock = Object.freeze({
      path,
      mode,
      release() {
        if (released) return;
        beforeRelease(lock);
        if (!attachments.has(lock)) {
          const unlocked = api.symbols.UnlockFileEx(handle, 0, 1, 0, ptr(overlapped));
          const closed = api.symbols.CloseHandle(handle);
          api.close();
          if (!unlocked || !closed) throw new Error('Lock release failed.');
          released = true;
          live.delete(lock);
          afterRelease(lock);
          return;
        }
        let unlockFailed = false;
        if (!nativeClosed) {
          const unlocked = api.symbols.UnlockFileEx(handle, 0, 1, 0, ptr(overlapped));
          const closed = api.symbols.CloseHandle(handle);
          if (!closed) throw new Error('Lock release failed.');
          nativeClosed = true;
          unlockFailed = !unlocked;
        }
        if (!apiClosed) {
          api.close();
          apiClosed = true;
        }
        // Native close releases the region even if explicit Unlock failed. Scope cleanup is
        // retryable; a failed directory close never reports a fully released lifetime.
        attachments.get(lock)?.release();
        attachments.delete(lock);
        released = true;
        live.delete(lock);
        afterRelease(lock);
        if (unlockFailed) throw new Error('Lock release failed.');
      },
    });
    validators.set(lock, () => {
      native.verifyHandle(handle, path, false);
      security.verifyFile(path);
    });
    live.add(lock);
    return lock;
  } catch (error) {
    api.symbols.CloseHandle(handle);
    api.close();
    throw error;
  }
}
