import { dlopen } from 'bun:ffi';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';

const LOCK_SHARED = 1;
const LOCK_EXCLUSIVE = 2;
const LOCK_NONBLOCKING = 4;
export const MANAGED_STORE_MAINTENANCE_MARKER = '.store-maintenance-contract';
export const MANAGED_STORE_MAINTENANCE_SCRATCH = '.store-maintenance-contract.next';
const MARKER_CONTENT = 'managed-release-selection-v1\n';

export type ManagedReleaseSelectionMode = 'shared' | 'exclusive';
export interface ManagedReleaseSelectionLock {
  readonly path: string;
  readonly mode: ManagedReleaseSelectionMode;
  revalidate(): void;
  release(): void;
}

/** Record that this install root now requires maintenance-aware selected candidates. */
export function declareManagedStoreMaintenanceContract(lock: ManagedReleaseSelectionLock): void {
  if (lock.mode !== 'exclusive')
    throw new Error('Store maintenance declaration requires exclusive release selection.');
  lock.revalidate();
  const root = lock.path.slice(0, -'/.release-selection.lock'.length);
  const path = join(root, MANAGED_STORE_MAINTENANCE_MARKER);
  if (lstatSync(path, { throwIfNoEntry: false })) {
    assertManagedStoreMaintenanceContract(root);
    return;
  }
  recoverManagedStoreMaintenanceScratch(lock);
  const scratch = join(root, MANAGED_STORE_MAINTENANCE_SCRATCH);
  const fd = openSync(
    scratch,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    try {
      if (writeSync(fd, MARKER_CONTENT) !== Buffer.byteLength(MARKER_CONTENT))
        throw new Error('Store maintenance marker write was incomplete.');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(scratch, path);
    syncDirectory(root);
    assertManagedStoreMaintenanceContract(root);
    lock.revalidate();
  } catch (error) {
    // Only this exact scratch name was created while holding the exclusive root lock.
    recoverManagedStoreMaintenanceScratch(lock);
    throw error;
  }
}

/** Recover an interrupted declaration only while no installer or other declarer can race. */
export function recoverManagedStoreMaintenanceScratch(lock: ManagedReleaseSelectionLock): void {
  if (lock.mode !== 'exclusive')
    throw new Error('Store maintenance scratch recovery requires exclusive release selection.');
  lock.revalidate();
  const root = lock.path.slice(0, -'/.release-selection.lock'.length);
  const scratch = join(root, MANAGED_STORE_MAINTENANCE_SCRATCH);
  const stat = lstatSync(scratch, { throwIfNoEntry: false });
  if (!stat) return;
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error('Store maintenance scratch path is unsafe.');
  rmSync(scratch, { force: false });
  syncDirectory(root);
  lock.revalidate();
}

function syncDirectory(root: string): void {
  const directory = openSync(root, constants.O_RDONLY);
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

export function assertManagedStoreMaintenanceContract(root: string): void {
  const path = join(root, MANAGED_STORE_MAINTENANCE_MARKER);
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0 ||
    readFileSync(path, 'utf8') !== MARKER_CONTENT
  )
    throw new Error('Managed Store maintenance contract marker is invalid.');
}

/**
 * A stable, private install-root inode. The installer holds exclusive while changing active;
 * migration holds shared from distribution review through Store publication.
 */
export function acquireManagedReleaseSelectionLock(
  installRoot: string,
  mode: ManagedReleaseSelectionMode,
): ManagedReleaseSelectionLock {
  if (process.platform !== 'darwin' && process.platform !== 'linux')
    throw new Error('Managed release selection locking is not qualified on this platform.');
  if (!isAbsolute(installRoot)) throw new Error('Managed install root must be absolute.');
  const directory = lstatSync(installRoot);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    directory.uid !== process.getuid?.() ||
    (directory.mode & 0o077) !== 0
  )
    throw new Error('Managed install root is not a private owner directory.');
  const path = join(installRoot, '.release-selection.lock');
  const fd = openSync(
    path,
    constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    const revalidate = () => {
      const named = lstatSync(path);
      const opened = fstatSync(fd);
      if (
        !named.isFile() ||
        named.isSymbolicLink() ||
        named.nlink !== 1 ||
        named.uid !== directory.uid ||
        (named.mode & 0o077) !== 0 ||
        named.dev !== opened.dev ||
        named.ino !== opened.ino
      )
        throw new Error('Managed release selection lock path changed.');
    };
    revalidate();
    const operation = (mode === 'shared' ? LOCK_SHARED : LOCK_EXCLUSIVE) | LOCK_NONBLOCKING;
    if (flock(fd, operation) !== 0) throw new Error('Managed release selection is busy.');
    revalidate();
    let released = false;
    return Object.freeze({
      path,
      mode,
      revalidate() {
        if (released) throw new Error('Managed release selection lock was released.');
        revalidate();
      },
      release() {
        if (released) return;
        released = true;
        closeSync(fd);
      },
    });
  } catch (error) {
    closeSync(fd);
    throw error;
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
