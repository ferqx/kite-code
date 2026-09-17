import { dlopen, type Pointer, ptr } from 'bun:ffi';
import { closeSync, constants, fstatSync, lstatSync, openSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { assertCanonicalKiteDatabasePath } from './kite-home-runtime-file';
import { KiteSessionStoreOpenError } from './kite-session-runtime-file';
import { assertNoFollowDatabasePath } from './preflight';

const LOCK_SHARED = 1;
const LOCK_EXCLUSIVE = 2;
const LOCK_NONBLOCKING = 4;
const WINDOWS_GENERIC_READ = 0x8000_0000;
const WINDOWS_GENERIC_WRITE = 0x4000_0000;
const WINDOWS_FILE_SHARE_READ = 1;
const WINDOWS_FILE_SHARE_WRITE = 2;
const WINDOWS_OPEN_ALWAYS = 4;
const WINDOWS_FILE_ATTRIBUTE_NORMAL = 0x80;
const WINDOWS_FILE_ATTRIBUTE_DIRECTORY = 0x10;
const WINDOWS_FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
const WINDOWS_FILE_FLAG_OPEN_REPARSE_POINT = 0x0020_0000;
const WINDOWS_LOCKFILE_FAIL_IMMEDIATELY = 1;
const WINDOWS_LOCKFILE_EXCLUSIVE_LOCK = 2;
const WINDOWS_ERROR_SHARING_VIOLATION = 32;
const WINDOWS_ERROR_LOCK_VIOLATION = 33;
const WINDOWS_ERROR_IO_PENDING = 997;

export type KiteSessionMaintenanceMode = 'shared' | 'exclusive';

export interface KiteSessionMaintenanceLock {
  readonly path: string;
  readonly mode: KiteSessionMaintenanceMode;
  release(): void;
}

// A live token can be borrowed by a nested backup without reacquiring flock.
// WeakMap identity prevents callers from fabricating a structural lock object.
const liveMaintenanceLocks = new WeakMap<KiteSessionMaintenanceLock, () => void>();

export function assertKiteSessionExclusiveMaintenance(
  lock: KiteSessionMaintenanceLock,
  databasePath: string,
): void {
  if (lock.mode !== 'exclusive' || lock.path !== `${databasePath}.maintenance.lock`) {
    throw new Error('Recovery backup requires exclusive maintenance for its source.');
  }
  const verify = liveMaintenanceLocks.get(lock);
  if (!verify) throw new Error('Kite Session maintenance token is not active.');
  verify();
}

/** Supplied by the service's existing Windows owner-only ACL authority. */
export interface KiteSessionWindowsPathSecurity {
  verifyDirectory(path: string): void;
  secureFile(path: string): void;
  verifyFile(path: string): void;
}

export interface KiteSessionMaintenanceOptions {
  readonly windowsPathSecurity?: KiteSessionWindowsPathSecurity;
}

/** A persistent inode beside the canonical Store; never unlink it after release. */
export function acquireKiteSessionStoreMaintenance(
  databasePath: string,
  mode: KiteSessionMaintenanceMode,
  options: KiteSessionMaintenanceOptions = {},
): KiteSessionMaintenanceLock {
  if (mode !== 'shared' && mode !== 'exclusive') {
    throw new TypeError('Kite Session maintenance mode must be shared or exclusive.');
  }
  const canonicalDatabasePath = assertCanonicalKiteDatabasePath(
    databasePath,
    basename(databasePath) === 'kite.sqlite' ? 'kite.sqlite' : 'kite-session.sqlite',
  );
  assertNoFollowDatabasePath(canonicalDatabasePath);
  const parent = lstatSync(dirname(canonicalDatabasePath));
  if (process.platform !== 'win32' && (parent.mode & 0o077) !== 0) {
    throw new Error('Kite Session maintenance parent permissions are not owner-only.');
  }
  const path = `${canonicalDatabasePath}.maintenance.lock`;
  if (process.platform === 'win32') {
    if (!options.windowsPathSecurity) {
      throw new Error('Kite Session maintenance locking on Windows requires path security.');
    }
    options.windowsPathSecurity.verifyDirectory(dirname(path));
    return acquireWindowsMaintenance(path, mode, options.windowsPathSecurity);
  }
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new Error(`Kite Session maintenance locking is unsupported on ${process.platform}.`);
  }

  const fd = openSync(
    path,
    constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    assertStablePrivateLock(path, fd);
    const operation = (mode === 'shared' ? LOCK_SHARED : LOCK_EXCLUSIVE) | LOCK_NONBLOCKING;
    if (flock(fd, operation) !== 0) {
      throw new KiteSessionStoreOpenError(
        'store_busy',
        'Kite Session maintenance lock is busy or unavailable.',
      );
    }
    // An attacker must not be able to replace the pathname after the lock was acquired.
    assertStablePrivateLock(path, fd);
    let released = false;
    const lock: KiteSessionMaintenanceLock = Object.freeze({
      path,
      mode,
      release() {
        if (released) return;
        released = true;
        liveMaintenanceLocks.delete(lock);
        closeSync(fd);
      },
    });
    liveMaintenanceLocks.set(lock, () => assertStablePrivateLock(path, fd));
    return lock;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function acquireWindowsMaintenance(
  path: string,
  mode: KiteSessionMaintenanceMode,
  security: KiteSessionWindowsPathSecurity,
): KiteSessionMaintenanceLock {
  const api = windowsMaintenanceApi();
  const widePath = Buffer.from(`${path}\0`, 'utf16le');
  const handle = api.CreateFileW(
    ptr(widePath),
    WINDOWS_GENERIC_READ | WINDOWS_GENERIC_WRITE,
    WINDOWS_FILE_SHARE_READ | WINDOWS_FILE_SHARE_WRITE,
    null,
    WINDOWS_OPEN_ALWAYS,
    WINDOWS_FILE_ATTRIBUTE_NORMAL | WINDOWS_FILE_FLAG_OPEN_REPARSE_POINT,
    0,
  );
  if (invalidWindowsHandle(handle)) {
    const error = api.GetLastError();
    if (error === WINDOWS_ERROR_SHARING_VIOLATION) {
      throw new KiteSessionStoreOpenError('store_busy', 'Kite Session maintenance lock is busy.');
    }
    throw new Error(`Kite Session maintenance lock could not be opened (Windows error ${error}).`);
  }
  try {
    assertWindowsLockFile(api, handle);
    security.secureFile(path);
    security.verifyFile(path);
    assertWindowsLockFile(api, handle);
    // The synchronous handle and FAIL_IMMEDIATELY make this a nonblocking lock.
    const overlapped = new Uint8Array(process.arch === 'ia32' ? 20 : 32);
    const flags =
      WINDOWS_LOCKFILE_FAIL_IMMEDIATELY |
      (mode === 'exclusive' ? WINDOWS_LOCKFILE_EXCLUSIVE_LOCK : 0);
    if (!api.LockFileEx(handle, flags, 0, 1, 0, ptr(overlapped))) {
      const error = api.GetLastError();
      if (error === WINDOWS_ERROR_LOCK_VIOLATION || error === WINDOWS_ERROR_IO_PENDING) {
        throw new KiteSessionStoreOpenError('store_busy', 'Kite Session maintenance lock is busy.');
      }
      throw new Error(`Kite Session maintenance lock failed (Windows error ${error}).`);
    }
    let released = false;
    const lock: KiteSessionMaintenanceLock = Object.freeze({
      path,
      mode,
      release() {
        if (released) return;
        released = true;
        liveMaintenanceLocks.delete(lock);
        const unlocked = api.UnlockFileEx(handle, 0, 1, 0, ptr(overlapped));
        const error = unlocked ? 0 : api.GetLastError();
        const closed = api.CloseHandle(handle);
        if (!unlocked || !closed) {
          throw new Error(
            `Kite Session maintenance lock release failed (Windows error ${error || api.GetLastError()}).`,
          );
        }
      },
    });
    liveMaintenanceLocks.set(lock, () => {
      assertWindowsLockFile(api, handle);
      security.verifyFile(path);
    });
    return lock;
  } catch (error) {
    api.CloseHandle(handle);
    throw error;
  }
}

interface WindowsMaintenanceApi {
  CreateFileW(
    path: Pointer,
    access: number,
    shareMode: number,
    securityAttributes: Pointer | null,
    disposition: number,
    flags: number,
    template: number | bigint,
  ): number | bigint;
  GetFileInformationByHandle(handle: number | bigint, information: Pointer): boolean;
  LockFileEx(
    handle: number | bigint,
    flags: number,
    reserved: number,
    lengthLow: number,
    lengthHigh: number,
    overlapped: Pointer,
  ): boolean;
  UnlockFileEx(
    handle: number | bigint,
    reserved: number,
    lengthLow: number,
    lengthHigh: number,
    overlapped: Pointer,
  ): boolean;
  CloseHandle(handle: number | bigint): boolean;
  GetLastError(): number;
}

let cachedWindowsMaintenanceApi: WindowsMaintenanceApi | undefined;

function windowsMaintenanceApi(): WindowsMaintenanceApi {
  cachedWindowsMaintenanceApi ??= dlopen('kernel32.dll', {
    CreateFileW: { args: ['ptr', 'u32', 'u32', 'ptr', 'u32', 'u32', 'u64'], returns: 'u64' },
    GetFileInformationByHandle: { args: ['u64', 'ptr'], returns: 'bool' },
    LockFileEx: { args: ['u64', 'u32', 'u32', 'u32', 'u32', 'ptr'], returns: 'bool' },
    UnlockFileEx: { args: ['u64', 'u32', 'u32', 'u32', 'ptr'], returns: 'bool' },
    CloseHandle: { args: ['u64'], returns: 'bool' },
    GetLastError: { args: [], returns: 'u32' },
  }).symbols;
  return cachedWindowsMaintenanceApi;
}

function invalidWindowsHandle(handle: number | bigint): boolean {
  return handle === 0 || handle === -1 || handle === BigInt('18446744073709551615');
}

function assertWindowsLockFile(api: WindowsMaintenanceApi, handle: number | bigint): void {
  const information = new Uint8Array(64);
  if (!api.GetFileInformationByHandle(handle, ptr(information))) {
    throw new Error(
      `Kite Session maintenance lock metadata unavailable (Windows error ${api.GetLastError()}).`,
    );
  }
  const view = new DataView(information.buffer);
  const attributes = view.getUint32(0, true);
  const links = view.getUint32(40, true);
  if (
    (attributes & (WINDOWS_FILE_ATTRIBUTE_DIRECTORY | WINDOWS_FILE_ATTRIBUTE_REPARSE_POINT)) !==
      0 ||
    links !== 1
  ) {
    throw new Error('Kite Session maintenance lock must be one regular non-reparse file.');
  }
}

function assertStablePrivateLock(path: string, fd: number): void {
  const target = lstatSync(path);
  const opened = fstatSync(fd);
  if (
    target.isSymbolicLink() ||
    !target.isFile() ||
    !opened.isFile() ||
    target.nlink !== 1 ||
    opened.nlink !== 1 ||
    target.dev !== opened.dev ||
    target.ino !== opened.ino
  ) {
    throw new Error('Kite Session maintenance lock must be one stable regular file.');
  }
  if (
    typeof process.getuid === 'function' &&
    (target.uid !== process.getuid() || opened.uid !== process.getuid())
  ) {
    throw new Error('Kite Session maintenance lock owner is invalid.');
  }
  if ((target.mode & 0o077) !== 0 || (opened.mode & 0o077) !== 0) {
    throw new Error('Kite Session maintenance lock permissions are not owner-only.');
  }
}

let cachedFlock: ((fd: number, operation: number) => number) | undefined;

function flock(fd: number, operation: number): number {
  cachedFlock ??= dlopen(
    process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6',
    { flock: { args: ['i32', 'i32'], returns: 'i32' } },
  ).symbols.flock;
  return cachedFlock(fd, operation);
}
