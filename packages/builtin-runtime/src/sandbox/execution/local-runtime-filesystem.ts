import { dlopen, type Pointer, ptr } from 'bun:ffi';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import {
  directoryNamesAtV1,
  openDirectoryAtV1,
  removeDirectoryTreeAtV1,
  removeEmptyDirectoryAtV1,
} from './descriptor-relative-cleanup';

/** Deterministic Provider allocation recoverable from a durable preparation intent. */
export function sandboxRuntimeDirForPreparationV1(
  workspace: string,
  preparationDigest: string,
): string {
  const workspaceRoot = realpathSync.native(resolve(workspace));
  const workspaceKey = createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 16);
  const preparationKey = createHash('sha256')
    .update('kite.sandbox-preparation-runtime.v1\0')
    .update(preparationDigest)
    .digest('hex')
    .slice(0, 32);
  return join(tmpdir(), 'openpx-sandbox-runtime', `${workspaceKey}-${preparationKey}`);
}

export interface PosixSandboxRuntimeRootsV1 {
  readonly controlRoot: string;
  readonly dataRoot: string;
}

/** Host-only control state and sandbox-writable data are disjoint identities. */
export function sandboxRuntimeRootsForPreparationV1(
  workspace: string,
  preparationDigest: string,
): PosixSandboxRuntimeRootsV1 {
  const allocationRoot = sandboxRuntimeDirForPreparationV1(workspace, preparationDigest);
  return Object.freeze({
    controlRoot: join(allocationRoot, 'control'),
    dataRoot: join(allocationRoot, 'data'),
  });
}

export function createPosixSandboxRuntimeRootsForPreparationV1(
  workspace: string,
  preparationDigest: string,
): PosixSandboxRuntimeRootsV1 {
  const roots = sandboxRuntimeRootsForPreparationV1(workspace, preparationDigest);
  const allocationRoot = dirname(roots.controlRoot);
  const base = dirname(allocationRoot);
  ensurePrivateDirectory(base, true);
  mkdirSync(allocationRoot, { mode: 0o700 });
  hardenAndVerifyDirectory(allocationRoot);
  mkdirSync(roots.controlRoot, { mode: 0o700 });
  hardenAndVerifyDirectory(roots.controlRoot);
  mkdirSync(roots.dataRoot, { mode: 0o700 });
  hardenAndVerifyDirectory(roots.dataRoot);
  return roots;
}

/** Descendant exit must already be proven. Remove writable data before host control state. */
export function cleanupPosixSandboxRuntimeRootsNoSpawnV1(
  roots: Readonly<PosixSandboxRuntimeRootsV1>,
): boolean {
  if (dirname(roots.controlRoot) !== dirname(roots.dataRoot)) return false;
  const allocationRoot = dirname(roots.controlRoot);
  const base = dirname(allocationRoot);
  if (base !== resolve(tmpdir(), 'openpx-sandbox-runtime')) return false;
  if (basename(roots.controlRoot) !== 'control' || basename(roots.dataRoot) !== 'data')
    return false;
  if (!/^[0-9a-f]{16}-.+/.test(basename(allocationRoot))) return false;
  let baseFd: number | undefined;
  let allocationFd: number | undefined;
  try {
    // An allocating preparation may fail before it creates even the private
    // runtime base. Exact absence at that point proves that there is no
    // allocation to reconcile; every non-ENOENT identity failure below still
    // fails closed.
    if (lstatOrNull(base) === null) return true;
    baseFd = openVerified(
      base,
      constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0),
    );
    const baseNames = directoryNamesAtV1(baseFd);
    if (!baseNames) return false;
    if (!baseNames.includes(basename(allocationRoot))) return true;
    allocationFd = openDirectoryAtV1(baseFd, basename(allocationRoot));
    if (allocationFd < 0) return false;
    // Writable sandbox data is always reclaimed before host-only control state.
    if (!removeDirectoryTreeAtV1(allocationFd, 'data')) return false;
    if (!removeDirectoryTreeAtV1(allocationFd, 'control')) return false;
    if (directoryNamesAtV1(allocationFd)?.length !== 0) return false;
    closeSync(allocationFd);
    allocationFd = undefined;
    return removeEmptyDirectoryAtV1(baseFd, basename(allocationRoot));
  } catch {
    return false;
  } finally {
    if (allocationFd !== undefined && allocationFd >= 0) closeSync(allocationFd);
    if (baseFd !== undefined) closeSync(baseFd);
  }
}

export function createSandboxRuntimeDirForPreparationV1(
  workspace: string,
  preparationDigest: string,
): string {
  const target = sandboxRuntimeDirForPreparationV1(workspace, preparationDigest);
  const base = dirname(target);
  ensurePrivateDirectory(base, true);
  mkdirSync(target, { mode: 0o700 });
  hardenAndVerifyDirectory(target);
  return target;
}

/**
 * Windows has no POSIX descriptor-relative directory API in Bun. The runtime
 * name is derived from the durable preparation digest, created exclusively,
 * and rejected on every unexpected existing identity so recovery can address
 * exactly one invocation without scanning the shared temp root.
 */
export function createWindowsSandboxRuntimeDirForPreparationV1(
  workspace: string,
  preparationDigest: string,
): string {
  const target = sandboxRuntimeDirForPreparationV1(workspace, preparationDigest);
  const base = dirname(target);
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const baseEntry = lstatSync(base);
  if (baseEntry.isSymbolicLink() || !baseEntry.isDirectory()) {
    throw new Error('Windows sandbox runtime base is not a real directory.');
  }
  mkdirSync(target, { mode: 0o700 });
  const entry = lstatSync(target);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error('Windows sandbox runtime identity is not a real directory.');
  }
  return realpathSync.native(target);
}

/** Windows no-spawn cleanup constrained to the exact digest-addressed runtime entry. */
export function cleanupWindowsSandboxRuntimeDirNoSpawnV1(runtimeDir: string): boolean {
  const configuredBase = resolve(tmpdir(), 'openpx-sandbox-runtime');
  const requestedTarget = resolve(runtimeDir);
  try {
    const configuredBaseEntry = lstatOrNull(configuredBase);
    if (configuredBaseEntry?.isSymbolicLink()) return false;
    const base = canonicalizePathWithMissingTail(configuredBase);
    const target = canonicalizePathWithMissingTail(requestedTarget);
    const rel = relative(base, target);
    if (
      !rel ||
      rel.startsWith(`..${sep}`) ||
      rel.includes(sep) ||
      dirname(target) !== base ||
      !/^[0-9a-f]{16}-.+/.test(basename(target))
    ) {
      return false;
    }
    // Resolve through the nearest extant ancestors before comparing: the
    // allocator returns a real path, while macOS may spell the same TMPDIR as
    // /var or /private/var. Missing tails keep post-executor cleanup
    // idempotent after the last allocation has removed the empty base.
    removeWindowsRuntimeEntryNoFollow(target);
    if (lstatOrNull(target) !== null) return false;
    removeEmptyRuntimeBase(base);
    return true;
  } catch {
    return false;
  }
}

/** Provider-safe no-follow cleanup. This dependency closure never spawns. */
export function cleanupSandboxRuntimeDirNoSpawnV1(
  runtimeDir: string,
  allowAllocationChild = false,
): boolean {
  const base = resolve(tmpdir(), 'openpx-sandbox-runtime');
  const target = resolve(runtimeDir);
  const rel = relative(base, target);
  const parts = rel.split(sep);
  if (
    !rel ||
    rel.startsWith(`..${sep}`) ||
    (allowAllocationChild
      ? parts.length !== 2 || !['control', 'data'].includes(parts[1]!)
      : parts.length !== 1) ||
    (allowAllocationChild ? dirname(dirname(target)) !== base : dirname(target) !== base)
  ) {
    return false;
  }
  const allocationName = allowAllocationChild ? basename(dirname(target)) : basename(target);
  if (!/^[0-9a-f]{16}-.+/.test(allocationName)) return false;
  try {
    const pinned = hardenAndVerifyDirectory(target, false);
    if (pinned !== null) closeSync(pinned);
    restoreAndRemovePhysicalEntryNoFollow(target);
    if (lstatOrNull(target) !== null) return false;
    removeEmptyRuntimeBase(base);
    return true;
  } catch {
    return false;
  }
}

function restoreAndRemovePhysicalEntryNoFollow(path: string): void {
  const entry = lstatOrNull(path);
  if (!entry) return;
  if (entry.isSymbolicLink()) {
    clearDarwinFileFlagsAtPathV1(path);
    unlinkSync(path);
    return;
  }
  if (!entry.isDirectory()) {
    restoreEntryModeAtPinnedParentV1(path, 0o600);
    const fd = openVerified(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    clearDarwinFileFlagsAtFdV1(fd);
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    closeSync(fd);
    unlinkSync(path);
    return;
  }
  const directoryFd = hardenAndVerifyDirectory(path);
  closeSync(directoryFd!);
  for (const child of readdirSync(path)) restoreAndRemovePhysicalEntryNoFollow(join(path, child));
  rmdirSync(path);
}

function removeWindowsRuntimeEntryNoFollow(path: string): void {
  const entry = lstatOrNull(path);
  if (!entry) return;
  if (entry.isSymbolicLink()) {
    unlinkSync(path);
    return;
  }
  if (!entry.isDirectory()) {
    chmodSync(path, 0o600);
    unlinkSync(path);
    return;
  }
  chmodSync(path, 0o700);
  for (const child of readdirSync(path)) {
    removeWindowsRuntimeEntryNoFollow(join(path, child));
  }
  rmdirSync(path);
}

function ensurePrivateDirectory(path: string, allowExisting: boolean): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (!allowExisting || !(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
      throw error;
    }
  }
  const fd = hardenAndVerifyDirectory(path);
  closeSync(fd!);
}

function hardenAndVerifyDirectory(path: string, required = true): number | null {
  const entry = lstatOrNull(path);
  if (entry === null) {
    if (!required) return null;
    throw new Error('Sandbox runtime directory is missing.');
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    if (!required) return null;
    throw new Error('Sandbox runtime identity is not a directory.');
  }
  try {
    restoreEntryModeAtPinnedParentV1(path, 0o700);
    const fd = openVerified(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0),
    );
    clearDarwinFileFlagsAtFdV1(fd);
    fchmodSync(fd, 0o700);
    fsyncSync(fd);
    return fd;
  } catch (error) {
    if (!required && error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/** Restore an entry mode through its pinned parent before opening it. */
function restoreEntryModeAtPinnedParentV1(path: string, mode: number): void {
  clearDarwinFileFlagsAtPathV1(path);
  const parentFd = openVerified(
    dirname(path),
    constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const result = posixRuntimeApiV1().fchmodat(
      parentFd,
      ptr(Buffer.from(`${basename(path)}\0`)),
      mode,
      AT_SYMLINK_NOFOLLOW_V1,
    );
    if (result !== 0) throw new Error('Sandbox runtime directory mode could not be restored.');
  } finally {
    closeSync(parentFd);
  }
}

function openVerified(path: string, flags: number): number {
  const before = lstatSync(path);
  if (
    before.isSymbolicLink() ||
    (!before.isDirectory() && !before.isFile()) ||
    (before.isFile() && before.nlink !== 1)
  ) {
    throw new Error('Sandbox runtime identity is not a single no-follow entry.');
  }
  const currentUid = process.getuid?.();
  if (typeof currentUid === 'number' && before.uid !== currentUid) {
    throw new Error('Sandbox runtime identity is not owned by this user.');
  }
  const fd = openSync(path, flags);
  const after = fstatSync(fd);
  if (before.dev !== after.dev || before.ino !== after.ino) {
    closeSync(fd);
    throw new Error('Sandbox runtime identity changed while opening its descriptor.');
  }
  return fd;
}

function removeEmptyRuntimeBase(base: string): void {
  try {
    const entry = lstatSync(base);
    if (entry.isSymbolicLink() || !entry.isDirectory()) return;
    rmdirSync(base);
  } catch {
    // Missing and non-empty bases are both valid cleanup outcomes.
  }
}

function lstatOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

interface DarwinFileFlagsApiV1 {
  fchmodat(parentFd: number, path: Pointer, mode: number, flags: number): number;
  fchflags(fd: number, flags: number): number;
  lchflags(path: Pointer, flags: number): number;
}

const AT_SYMLINK_NOFOLLOW_V1 = process.platform === 'darwin' ? 0x20 : 0x100;
let posixRuntimeApiV1Cache: DarwinFileFlagsApiV1 | undefined;

/** Clear user immutable/append flags without spawning a cleanup process. */
function clearDarwinFileFlagsAtFdV1(fd: number): void {
  if (process.platform !== 'darwin') return;
  const result = posixRuntimeApiV1().fchflags(fd, 0);
  if (result !== 0) throw new Error('Sandbox runtime flags could not be cleared.');
}

/** Clear flags on a symlink itself; this call deliberately does not follow it. */
function clearDarwinFileFlagsAtPathV1(path: string): void {
  if (process.platform !== 'darwin') return;
  const result = posixRuntimeApiV1().lchflags(ptr(Buffer.from(`${path}\0`)), 0);
  if (result !== 0) throw new Error('Sandbox runtime link flags could not be cleared.');
}

function posixRuntimeApiV1(): DarwinFileFlagsApiV1 {
  if (posixRuntimeApiV1Cache) return posixRuntimeApiV1Cache;
  if (process.platform === 'darwin') {
    posixRuntimeApiV1Cache = dlopen('/usr/lib/libSystem.B.dylib', {
      fchmodat: { args: ['i32', 'ptr', 'u32', 'i32'], returns: 'i32' },
      fchflags: { args: ['i32', 'u32'], returns: 'i32' },
      lchflags: { args: ['ptr', 'u32'], returns: 'i32' },
    }).symbols as unknown as DarwinFileFlagsApiV1;
  } else {
    posixRuntimeApiV1Cache = dlopen('libc.so.6', {
      fchmodat: { args: ['i32', 'ptr', 'u32', 'i32'], returns: 'i32' },
    }).symbols as unknown as DarwinFileFlagsApiV1;
  }
  return posixRuntimeApiV1Cache;
}

/** Canonicalize aliases without requiring a just-cleaned runtime tail to exist. */
function canonicalizePathWithMissingTail(path: string): string {
  const missingTail: string[] = [];
  let existing = path;
  while (lstatOrNull(existing) === null) {
    const parent = dirname(existing);
    if (parent === existing) throw new Error('Sandbox runtime path has no existing ancestor.');
    missingTail.unshift(basename(existing));
    existing = parent;
  }
  return join(realpathSync.native(existing), ...missingTail);
}
