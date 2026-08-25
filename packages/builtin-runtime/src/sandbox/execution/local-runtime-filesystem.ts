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
import { directoryNamesAt, removeDirectoryTreeAt } from './descriptor-relative-cleanup';

/** Deterministic Provider allocation recoverable from a durable preparation intent. */
export function sandboxRuntimeDirForPreparation(
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

export interface PosixSandboxRuntimeRoots {
  readonly controlRoot: string;
  readonly dataRoot: string;
}

/** Host-only control state and sandbox-writable data are disjoint identities. */
export function sandboxRuntimeRootsForPreparation(
  workspace: string,
  preparationDigest: string,
): PosixSandboxRuntimeRoots {
  const dataRoot = sandboxRuntimeDirForPreparation(workspace, preparationDigest);
  const allocationKey = basename(dataRoot);
  return Object.freeze({
    controlRoot: join(tmpdir(), 'openpx-sandbox-control', allocationKey),
    dataRoot,
  });
}

export function createPosixSandboxRuntimeRootsForPreparation(
  workspace: string,
  preparationDigest: string,
): PosixSandboxRuntimeRoots {
  const roots = sandboxRuntimeRootsForPreparation(workspace, preparationDigest);
  ensurePrivateDirectory(dirname(roots.controlRoot), true);
  ensurePrivateDirectory(dirname(roots.dataRoot), true);
  mkdirSync(roots.controlRoot, { mode: 0o700 });
  hardenAndVerifyDirectory(roots.controlRoot);
  mkdirSync(roots.dataRoot, { mode: 0o700 });
  hardenAndVerifyDirectory(roots.dataRoot);
  return roots;
}

/** Descendant exit must already be proven. Remove writable data before host control state. */
export function cleanupPosixSandboxRuntimeRootsNoSpawn(
  roots: Readonly<PosixSandboxRuntimeRoots>,
): boolean {
  const controlBase = resolve(tmpdir(), 'openpx-sandbox-control');
  const dataBase = resolve(tmpdir(), 'openpx-sandbox-runtime');
  const controlKey = basename(roots.controlRoot);
  const dataKey = basename(roots.dataRoot);
  if (
    dirname(resolve(roots.controlRoot)) !== controlBase ||
    dirname(resolve(roots.dataRoot)) !== dataBase ||
    controlKey !== dataKey ||
    !/^[0-9a-f]{16}-.+/.test(controlKey)
  ) {
    return false;
  }
  try {
    // Darwin exposes no descriptor-relative chflags API. Clear flags only on
    // the two already-validated runtime roots, verify every entry before and
    // after the operation, then let the descriptor-relative remover perform
    // the authoritative traversal and unlink.
    if (process.platform === 'darwin') {
      if (!prepareDarwinTreeForDescriptorCleanup(roots.dataRoot)) return false;
      if (!prepareDarwinTreeForDescriptorCleanup(roots.controlRoot)) return false;
    }
    // Writable sandbox data is always reclaimed before host-only control state.
    if (!removeRuntimeTreeAtPrivateBase(dataBase, dataKey)) return false;
    removeEmptyRuntimeBase(dataBase);
    if (!removeRuntimeTreeAtPrivateBase(controlBase, controlKey)) return false;
    removeEmptyRuntimeBase(controlBase);
    return true;
  } catch {
    return false;
  }
}

function removeRuntimeTreeAtPrivateBase(base: string, name: string): boolean {
  // Preparation can fail before creating either private base. Exact absence
  // proves that this side has no allocation to reconcile.
  if (lstatOrNull(base) === null) return true;
  const baseFd = openVerified(
    base,
    constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const names = directoryNamesAt(baseFd);
    if (!names) return false;
    if (!names.includes(name)) return true;
    return removeDirectoryTreeAt(baseFd, name);
  } finally {
    closeSync(baseFd);
  }
}

function prepareDarwinTreeForDescriptorCleanup(path: string): boolean {
  const before = lstatOrNull(path);
  if (!before) return true;
  const currentUid = process.getuid?.();
  if (typeof currentUid === 'number' && before.uid !== currentUid) return false;
  if (before.isSymbolicLink()) {
    clearDarwinFileFlagsAtPath(path);
    const after = lstatOrNull(path);
    return Boolean(after?.isSymbolicLink() && before.dev === after.dev && before.ino === after.ino);
  }
  if (before.isFile()) {
    if (before.nlink !== 1) return true;
    clearDarwinFileFlagsAtPath(path);
    chmodSync(path, 0o600);
    const after = lstatOrNull(path);
    return Boolean(after?.isFile() && before.dev === after.dev && before.ino === after.ino);
  }
  if (!before.isDirectory()) return true;
  clearDarwinFileFlagsAtPath(path);
  chmodSync(path, 0o700);
  const pinned = openVerified(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    for (const child of readdirSync(path)) {
      if (!prepareDarwinTreeForDescriptorCleanup(join(path, child))) return false;
    }
    const after = fstatSync(pinned);
    return before.dev === after.dev && before.ino === after.ino;
  } finally {
    closeSync(pinned);
  }
}

export function createSandboxRuntimeDirForPreparation(
  workspace: string,
  preparationDigest: string,
): string {
  const target = sandboxRuntimeDirForPreparation(workspace, preparationDigest);
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
export function createWindowsSandboxRuntimeDirForPreparation(
  workspace: string,
  preparationDigest: string,
): string {
  const target = sandboxRuntimeDirForPreparation(workspace, preparationDigest);
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
export function cleanupWindowsSandboxRuntimeDirNoSpawn(runtimeDir: string): boolean {
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
export function cleanupSandboxRuntimeDirNoSpawn(
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
    clearDarwinFileFlagsAtPath(path);
    unlinkSync(path);
    return;
  }
  if (!entry.isDirectory()) {
    restoreEntryModeAtPinnedParent(path, 0o600);
    const fd = openVerified(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    clearDarwinFileFlagsAtFd(fd);
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
    restoreEntryModeAtPinnedParent(path, 0o700);
    const fd = openVerified(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0),
    );
    clearDarwinFileFlagsAtFd(fd);
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
function restoreEntryModeAtPinnedParent(path: string, mode: number): void {
  clearDarwinFileFlagsAtPath(path);
  const parentFd = openVerified(
    dirname(path),
    constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const result = posixRuntimeApi().fchmodat(
      parentFd,
      ptr(Buffer.from(`${basename(path)}\0`)),
      mode,
      AT_SYMLINK_NOFOLLOW_,
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
  const trustedSharedTempRoot =
    resolve(path) === resolve(tmpdir()) &&
    before.isDirectory() &&
    before.uid === 0 &&
    (before.mode & 0o1000) !== 0;
  if (typeof currentUid === 'number' && before.uid !== currentUid && !trustedSharedTempRoot) {
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

interface DarwinFileFlagsApi {
  fchmodat(parentFd: number, path: Pointer, mode: number, flags: number): number;
  fchflags(fd: number, flags: number): number;
  lchflags(path: Pointer, flags: number): number;
}

const AT_SYMLINK_NOFOLLOW_ = process.platform === 'darwin' ? 0x20 : 0x100;
let posixRuntimeApiCache: DarwinFileFlagsApi | undefined;

/** Clear user immutable/append flags without spawning a cleanup process. */
function clearDarwinFileFlagsAtFd(fd: number): void {
  if (process.platform !== 'darwin') return;
  const result = posixRuntimeApi().fchflags(fd, 0);
  if (result !== 0) throw new Error('Sandbox runtime flags could not be cleared.');
}

/** Clear flags on a symlink itself; this call deliberately does not follow it. */
function clearDarwinFileFlagsAtPath(path: string): void {
  if (process.platform !== 'darwin') return;
  const result = posixRuntimeApi().lchflags(ptr(Buffer.from(`${path}\0`)), 0);
  if (result !== 0) throw new Error('Sandbox runtime link flags could not be cleared.');
}

function posixRuntimeApi(): DarwinFileFlagsApi {
  if (posixRuntimeApiCache) return posixRuntimeApiCache;
  if (process.platform === 'darwin') {
    posixRuntimeApiCache = dlopen('/usr/lib/libSystem.B.dylib', {
      fchmodat: { args: ['i32', 'ptr', 'u32', 'i32'], returns: 'i32' },
      fchflags: { args: ['i32', 'u32'], returns: 'i32' },
      lchflags: { args: ['ptr', 'u32'], returns: 'i32' },
    }).symbols as unknown as DarwinFileFlagsApi;
  } else {
    posixRuntimeApiCache = dlopen('libc.so.6', {
      fchmodat: { args: ['i32', 'ptr', 'u32', 'i32'], returns: 'i32' },
    }).symbols as unknown as DarwinFileFlagsApi;
  }
  return posixRuntimeApiCache;
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
