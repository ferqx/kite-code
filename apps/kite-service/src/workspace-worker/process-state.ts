import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { assertCoordinatorJsonValue } from '@kite-ai/kite-local-runtime/coordinator';
import type { KiteHomeIdentity } from '@kite-ai/kite-local-runtime/service';
import {
  ensurePrivateKiteHomeDirectory,
  secureWindowsStatePath,
  verifyWindowsStatePath,
} from '@kite-ai/kite-local-runtime/service';
/** Private, path-free Worker process state owned by the Coordinator home. */
export const WORKSPACE_WORKER_PROCESS_STATE_LIMITS = Object.freeze({
  descriptorBytes: 64 * 1024,
  credentialBytes: 256,
  temporaryNameBytes: 128,
} as const);

export const WORKSPACE_WORKER_PROCESS_STATE_SCHEMA_ =
  'kite.workspace-worker-process-state.v1' as const;

export interface WorkspaceWorkerProcessStatePaths {
  readonly root: string;
  descriptorForScope(workerScopeId: string): string;
  controlCredentialForScope(workerScopeId: string): string;
}

export interface WorkspaceWorkerProcessStatePort {
  readonly paths?: WorkspaceWorkerProcessStatePaths;
  read(workerScopeId: string): Promise<unknown | undefined>;
  readControlCredential(workerScopeId: string): Promise<string | undefined>;
  /** Enumerate only validated descriptor records for Coordinator restart reconciliation. */
  listDescriptors?(): Promise<readonly unknown[]>;
  publish(value: unknown): Promise<void>;
  /** Publish the launch marker atomically; an existing marker is never overwritten. */
  publishControlCredential(workerScopeId: string, value: string): Promise<string>;
  clear(value: unknown): Promise<void>;
  clearControlCredential(workerScopeId: string, expected: string): Promise<void>;
  preserveFailure(): Promise<void>;
}

export class WorkspaceWorkerProcessStateError extends Error {
  readonly code: 'invalid_path' | 'missing' | 'busy' | 'corrupt' | 'permission' | 'io';

  constructor(
    code: 'invalid_path' | 'missing' | 'busy' | 'corrupt' | 'permission' | 'io',
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceWorkerProcessStateError';
    this.code = code;
  }
}

const WORKSPACE_WORKER_STATE_SEGMENTS = Object.freeze(['workspace-worker', 'v1'] as const);
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const OWNER_MASK = 0o077;
const FILE_MODE = 0o600;
const CONTROL_CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

interface WorkspaceWorkerStateStat {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly nlink: number;
  readonly size: number;
  readonly uid?: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

/** Ensure the fixed process-state root beneath an already validated Kite home. */
export function ensureWorkspaceWorkerProcessStateRoot(
  identity: KiteHomeIdentity,
): WorkspaceWorkerProcessStatePaths {
  return resolveWorkspaceWorkerProcessStatePaths(
    ensurePrivateKiteHomeDirectory(identity, WORKSPACE_WORKER_STATE_SEGMENTS),
  );
}

/** Derive state filenames without embedding the caller's scope or Workspace path. */
export function resolveWorkspaceWorkerProcessStatePaths(
  root: string,
): WorkspaceWorkerProcessStatePaths {
  if (!isAbsolute(root))
    throw new WorkspaceWorkerProcessStateError('invalid_path', 'State root must be absolute.');
  const stateRoot = resolve(root);
  return Object.freeze({
    root: stateRoot,
    descriptorForScope: (workerScopeId: string) =>
      scopedPath(stateRoot, workerScopeId, 'descriptor.json'),
    controlCredentialForScope: (workerScopeId: string) =>
      scopedPath(stateRoot, workerScopeId, 'control.token'),
  });
}

/** Native no-follow/owner-only implementation used by Coordinator restart recovery. */
export function createWorkspaceWorkerProcessStatePort(
  identity: KiteHomeIdentity,
): WorkspaceWorkerProcessStatePort & { readonly paths: WorkspaceWorkerProcessStatePaths } {
  const paths = ensureWorkspaceWorkerProcessStateRoot(identity);
  assertStateRoot(paths.root);
  return Object.freeze({
    paths,
    async read(workerScopeId: string) {
      const bytes = readRegularFile(
        paths.descriptorForScope(workerScopeId),
        WORKSPACE_WORKER_PROCESS_STATE_LIMITS.descriptorBytes,
        'Worker process descriptor',
      );
      return bytes === undefined ? undefined : parseJson(bytes, 'Worker process descriptor');
    },
    async readControlCredential(workerScopeId: string) {
      const bytes = readRegularFile(
        paths.controlCredentialForScope(workerScopeId),
        WORKSPACE_WORKER_PROCESS_STATE_LIMITS.credentialBytes,
        'Worker control credential',
      );
      if (bytes === undefined) return undefined;
      const value = bytes.toString('utf8');
      if (!CONTROL_CREDENTIAL_PATTERN.test(value)) {
        fail('corrupt', 'Worker control credential is invalid.');
      }
      return value;
    },
    async listDescriptors() {
      assertStateRoot(paths.root);
      const names = readdirSync(paths.root).filter((name) =>
        /^[a-f0-9]{64}\.descriptor\.json$/u.test(name),
      );
      if (names.length > 10_000) {
        fail('corrupt', 'Worker process descriptor set is oversized.');
      }
      return Object.freeze(
        names.sort().map((name) => {
          const bytes = readRegularFile(
            join(paths.root, name),
            WORKSPACE_WORKER_PROCESS_STATE_LIMITS.descriptorBytes,
            'Worker process descriptor',
          );
          if (bytes === undefined) fail('corrupt', 'Worker process descriptor disappeared.');
          return parseJson(bytes, 'Worker process descriptor');
        }),
      );
    },
    async publish(value: unknown) {
      const encoded = encodeJson(value, 'Worker process descriptor');
      const scope = scopeFromDescriptor(value);
      publishFile(paths.descriptorForScope(scope), encoded, 'Worker process descriptor');
    },
    async publishControlCredential(workerScopeId: string, value: string) {
      assertScope(workerScopeId);
      if (!CONTROL_CREDENTIAL_PATTERN.test(value)) {
        throw new WorkspaceWorkerProcessStateError(
          'corrupt',
          'Worker control credential is invalid.',
        );
      }
      const path = paths.controlCredentialForScope(workerScopeId);
      writeExclusiveFile(path, Buffer.from(value, 'utf8'), 'Worker control credential');
      return value;
    },
    async clear(value: unknown) {
      const scope = scopeFromDescriptor(value);
      removeFile(
        paths.descriptorForScope(scope),
        encodeJson(value, 'Worker process descriptor'),
        'Worker process descriptor',
      );
    },
    async clearControlCredential(workerScopeId: string, expected: string) {
      assertScope(workerScopeId);
      if (!CONTROL_CREDENTIAL_PATTERN.test(expected)) {
        throw new WorkspaceWorkerProcessStateError(
          'corrupt',
          'Worker control credential is invalid.',
        );
      }
      removeBytes(
        paths.controlCredentialForScope(workerScopeId),
        Buffer.from(expected, 'utf8'),
        'Worker control credential',
      );
    },
    async preserveFailure() {
      // Existing descriptor/credential files are recovery evidence. Never rewrite uncertain state.
    },
  });
}

function scopedPath(root: string, workerScopeId: string, suffix: string): string {
  assertScope(workerScopeId);
  const digest = createHash('sha256')
    .update(`kite.workspace-worker-scope.v1\0${workerScopeId}`, 'utf8')
    .digest('hex');
  return join(root, `${digest}.${suffix}`);
}

function assertScope(workerScopeId: string): void {
  if (
    typeof workerScopeId !== 'string' ||
    workerScopeId.length === 0 ||
    workerScopeId.length > 512 ||
    workerScopeId.includes('\0') ||
    [...workerScopeId].some((character) => /\p{Cc}/u.test(character))
  ) {
    fail('invalid_path', 'Worker scope identity is invalid.');
  }
}

function readStat(path: string): WorkspaceWorkerStateStat {
  return lstatSync(path) as unknown as WorkspaceWorkerStateStat;
}

function fail(
  code: ConstructorParameters<typeof WorkspaceWorkerProcessStateError>[0],
  message: string,
): never {
  throw new WorkspaceWorkerProcessStateError(code, message);
}

function nativeError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function assertOwnerOnly(path: string, stat: WorkspaceWorkerStateStat, label: string): void {
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
    fail('corrupt', `${label} is not a private state entry.`);
  }
  if (process.platform !== 'win32' && (stat.mode & OWNER_MASK) !== 0) {
    fail('permission', `${label} is not owner-only.`);
  }
  if (
    process.platform !== 'win32' &&
    typeof process.getuid === 'function' &&
    stat.uid !== undefined &&
    stat.uid !== process.getuid()
  ) {
    fail('permission', `${label} is not owned by the current user.`);
  }
  if (process.platform === 'win32') {
    try {
      verifyWindowsStatePath(path, stat.isDirectory() ? 'directory' : 'file');
    } catch {
      fail('permission', `${label} does not have a verified owner-only ACL.`);
    }
  }
}

function assertStateRoot(root: string): void {
  let stat: WorkspaceWorkerStateStat;
  try {
    stat = readStat(root);
  } catch {
    fail('missing', 'Worker process state root is missing.');
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail('corrupt', 'Worker process state root is invalid.');
  }
  assertOwnerOnly(root, stat, 'Worker process state root');
}

function readRegularFile(path: string, maxBytes: number, label: string): Buffer | undefined {
  let stat: WorkspaceWorkerStateStat;
  try {
    stat = readStat(path);
  } catch (error) {
    if (nativeError(error, 'ENOENT')) return undefined;
    fail('io', `${label} could not be inspected.`);
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    fail('corrupt', `${label} is not a private regular file.`);
  }
  assertOwnerOnly(path, stat, label);
  if (stat.size > maxBytes) fail('corrupt', `${label} is oversized.`);
  try {
    const bytes = readFileSync(path);
    if (bytes.byteLength > maxBytes) fail('corrupt', `${label} is oversized.`);
    return bytes;
  } catch {
    fail('io', `${label} could not be read.`);
  }
}

function parseJson(bytes: Buffer, label: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8')) as unknown;
    assertCoordinatorJsonValue(value);
  } catch {
    fail('corrupt', `${label} is not valid Coordinator JSON.`);
  }
  return value;
}

function encodeJson(value: unknown, label: string): Buffer {
  try {
    assertCoordinatorJsonValue(value);
    const encoded = Buffer.from(JSON.stringify(value), 'utf8');
    if (encoded.byteLength > WORKSPACE_WORKER_PROCESS_STATE_LIMITS.descriptorBytes) {
      fail('corrupt', `${label} is oversized.`);
    }
    return encoded;
  } catch (error) {
    if (error instanceof WorkspaceWorkerProcessStateError) throw error;
    fail('corrupt', `${label} is not Coordinator JSON.`);
  }
}

function scopeFromDescriptor(value: unknown): string {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !('identity' in value) ||
    typeof value.identity !== 'object' ||
    value.identity === null ||
    Array.isArray(value.identity) ||
    !('workerScopeId' in value.identity) ||
    typeof value.identity.workerScopeId !== 'string'
  ) {
    fail('corrupt', 'Worker process descriptor identity is invalid.');
  }
  assertScope(value.identity.workerScopeId);
  return value.identity.workerScopeId;
}

function temporaryPath(target: string): string {
  const name = `.${target.split(/[\\/]/u).at(-1) ?? 'state'}-${createHash('sha256')
    .update(`${process.pid}\0${target}\0${Date.now()}`)
    .digest('hex')
    .slice(0, 32)}.tmp`;
  if (Buffer.byteLength(name, 'utf8') > WORKSPACE_WORKER_PROCESS_STATE_LIMITS.temporaryNameBytes) {
    fail('invalid_path', 'Worker temporary state name is oversized.');
  }
  return join(dirname(target), name);
}

function syncDirectory(path: string): void {
  if (process.platform === 'win32') return;
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | NO_FOLLOW);
    fsyncSync(fd);
  } catch {
    fail('io', 'Worker process state directory could not be flushed.');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function publishFile(target: string, bytes: Buffer, label: string): void {
  const root = dirname(target);
  assertStateRoot(root);
  let existing: WorkspaceWorkerStateStat | undefined;
  try {
    existing = readStat(target);
  } catch (error) {
    if (!nativeError(error, 'ENOENT')) fail('io', `${label} could not be inspected.`);
  }
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1) {
      fail('corrupt', `${label} is not a private regular file.`);
    }
    assertOwnerOnly(target, existing, label);
  }
  const temporary = temporaryPath(target);
  let fd: number | undefined;
  let published = false;
  try {
    fd = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NO_FOLLOW,
      FILE_MODE,
    );
    writeFileSync(fd, bytes);
    if (process.platform !== 'win32') fchmodSync(fd, FILE_MODE);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    secureCreatedWindowsEntry(temporary, 'file');
    renameSync(temporary, target);
    published = true;
    syncDirectory(root);
    const after = readStat(target);
    if (after.isSymbolicLink() || !after.isFile() || after.nlink !== 1) {
      fail('corrupt', `${label} changed during publication.`);
    }
    assertOwnerOnly(target, after, label);
  } catch (error) {
    if (error instanceof WorkspaceWorkerProcessStateError) throw error;
    fail('io', `${label} could not be published.`);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (!published) {
      try {
        unlinkSync(temporary);
      } catch {
        // This attempt's uniquely named temporary entry is the only path eligible for cleanup.
      }
    }
  }
}

function writeExclusiveFile(target: string, bytes: Buffer, label: string): void {
  assertStateRoot(dirname(target));
  let fd: number | undefined;
  try {
    fd = openSync(
      target,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NO_FOLLOW,
      FILE_MODE,
    );
    writeFileSync(fd, bytes);
    if (process.platform !== 'win32') fchmodSync(fd, FILE_MODE);
    fsyncSync(fd);
    secureCreatedWindowsEntry(target, 'file');
    syncDirectory(dirname(target));
  } catch (error) {
    if (error instanceof WorkspaceWorkerProcessStateError) throw error;
    if (nativeError(error, 'EEXIST')) fail('busy', `${label} already exists.`);
    fail('io', `${label} could not be published.`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const stat = readStat(target);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    fail('corrupt', `${label} changed during publication.`);
  }
  assertOwnerOnly(target, stat, label);
}

function removeFile(target: string, expected: Buffer, label: string): void {
  removeBytes(target, expected, label);
}

function removeBytes(target: string, expected: Buffer, label: string): void {
  assertStateRoot(dirname(target));
  let before: WorkspaceWorkerStateStat;
  try {
    before = readStat(target);
  } catch (error) {
    if (nativeError(error, 'ENOENT')) return;
    fail('io', `${label} could not be inspected.`);
  }
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
    fail('corrupt', `${label} is not a private regular file.`);
  }
  assertOwnerOnly(target, before, label);
  const bytes = readFileSync(target);
  if (!bytes.equals(expected)) fail('corrupt', `${label} does not match cleanup identity.`);
  const current = readStat(target);
  if (current.dev !== before.dev || current.ino !== before.ino) {
    fail('corrupt', `${label} changed during cleanup.`);
  }
  unlinkSync(target);
  syncDirectory(dirname(target));
}

function secureCreatedWindowsEntry(path: string, kind: 'directory' | 'file'): void {
  if (process.platform !== 'win32') return;
  try {
    secureWindowsStatePath(path, kind, { allowOwnerInitialization: true });
  } catch {
    fail('permission', 'Worker process state entry could not be secured.');
  }
}
