import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  ensurePrivateKiteHomeDirectory,
  type KiteHomeIdentity,
} from '@kite-ai/kite-local-runtime/service';
import { readProcessStartIdentity } from '../session-logger/active-session-lease';
import {
  claimWorkspaceReservation,
  type WorkspaceReservationChildClaim,
  type WorkspaceReservationChildLease,
} from './reservation';
import type {
  WorkspaceWorkerIdentity,
  WorkspaceWorkerOwnerLock,
  WorkspaceWorkerOwnerLockPort,
} from './worker';

const LOCK_SCHEMA = 'kite.workspace-owner-lock.v1' as const;
const MAX_LOCK_BYTES = 16 * 1024;

interface WorkspaceOwnerRecord {
  readonly schema: typeof LOCK_SCHEMA;
  readonly workspaceDigest: string;
  readonly workerScopeId: string;
  readonly workerInstanceId: string;
  readonly pid: number;
  readonly processStartIdentity: string;
  readonly nonce: string;
}

export type WorkspaceOwnerProcessState = 'alive' | 'dead' | 'uncertain';

export interface NativeWorkspaceOwnerLockOptions {
  /** Fixed OS-user coordination home, shared by every explicit Kite home. */
  readonly coordinationHome: KiteHomeIdentity;
  readonly processState?: (pid: number, processStartIdentity: string) => WorkspaceOwnerProcessState;
  readonly currentProcessIdentity?: () => string | undefined;
  readonly randomBytes?: (size: number) => Uint8Array;
  /** Manager-issued reservation proof consumed before Store 7 opens. */
  readonly childReservation?: Omit<
    WorkspaceReservationChildClaim,
    'workerPid' | 'workerProcessStartIdentity'
  >;
}

/**
 * OS-user Workspace owner lock. Its filename is the canonical Workspace
 * digest, so two explicit Kite homes still contend for one writer. Existing
 * malformed or unverifiable owners fail closed; only a positively dead exact
 * record is removed and retried once.
 */
export function createNativeWorkspaceOwnerLockPort(
  options: NativeWorkspaceOwnerLockOptions,
): WorkspaceWorkerOwnerLockPort {
  const root = ensurePrivateKiteHomeDirectory(options.coordinationHome, ['workspace-owners', 'v1']);
  const processState = options.processState ?? inspectNativeProcess;
  const currentProcessIdentity =
    options.currentProcessIdentity ?? (() => readProcessStartIdentity(process.pid));
  const random = options.randomBytes ?? randomBytes;

  return Object.freeze({
    async acquire(identity: WorkspaceWorkerIdentity): Promise<WorkspaceWorkerOwnerLock> {
      const digest = workspaceDigest(identity);
      const path = join(root, `${digest}.lock`);
      const processIdentity = currentProcessIdentity();
      if (!processIdentity) throw new Error('Workspace owner process identity is unavailable.');
      let childReservation: WorkspaceReservationChildLease | undefined;
      try {
        childReservation = options.childReservation
          ? claimWorkspaceReservation({
              ...options.childReservation,
              workerPid: process.pid,
              workerProcessStartIdentity: processIdentity,
            })
          : undefined;
        const bytes = random(24);
        if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 24) {
          throw new Error('Workspace owner lock nonce source is invalid.');
        }
        const nonce = Buffer.from(bytes).toString('base64url');
        bytes.fill(0);
        const record: WorkspaceOwnerRecord = {
          schema: LOCK_SCHEMA,
          workspaceDigest: identity.workspace.workspaceDigest,
          workerScopeId: identity.workerScopeId,
          workerInstanceId: identity.workerInstanceId,
          pid: process.pid,
          processStartIdentity: processIdentity,
          nonce,
        };
        const acquired = acquireExact(path, record);
        if (acquired) return lease(identity, path, record, acquired, childReservation);

        const existing = readRecord(path);
        if (!existing) throw new Error('Workspace owner lock is busy or unverifiable.');
        if (processState(existing.pid, existing.processStartIdentity) !== 'dead') {
          throw new Error('Workspace owner lock is busy or unverifiable.');
        }
        removeExact(path, existing);
        const retried = acquireExact(path, record);
        if (!retried) throw new Error('Workspace owner lock changed during stale recovery.');
        return lease(identity, path, record, retried, childReservation);
      } catch (error) {
        try {
          await childReservation?.release();
        } catch {
          // Preserve the first lock/claim failure; an uncertain reservation remains a fence.
        }
        throw error;
      }
    },
  });
}

function lease(
  identity: WorkspaceWorkerIdentity,
  path: string,
  record: WorkspaceOwnerRecord,
  fileIdentity: Readonly<{ dev: number; ino: number }>,
  childReservation?: WorkspaceReservationChildLease,
): WorkspaceWorkerOwnerLock {
  let released = false;
  return Object.freeze({
    identity,
    async [Symbol.asyncDispose]() {
      if (released) return;
      const stat = lstatSync(path);
      const current = readRecord(path);
      if (
        stat.isSymbolicLink() ||
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.dev !== fileIdentity.dev ||
        stat.ino !== fileIdentity.ino ||
        current?.nonce !== record.nonce
      ) {
        throw new Error('Workspace owner lock is no longer owned by this Worker.');
      }
      unlinkSync(path);
      syncParent(path);
      try {
        await childReservation?.release();
      } finally {
        released = true;
      }
    },
  });
}

function acquireExact(
  path: string,
  record: WorkspaceOwnerRecord,
): Readonly<{ dev: number; ino: number }> | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const encoded = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(encoded) > MAX_LOCK_BYTES) {
      throw new Error('Workspace owner lock record exceeds its bound.');
    }
    writeFileSync(descriptor, encoded, 'utf8');
    fsyncSync(descriptor);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error('Workspace owner lock is not a private regular file.');
    }
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      throw new Error('Workspace owner lock permissions are not owner-only.');
    }
    syncParent(path);
    return { dev: stat.dev, ino: stat.ino };
  } catch (error) {
    if (isCode(error, 'EEXIST')) return undefined;
    if (descriptor !== undefined) {
      try {
        const stat = fstatSync(descriptor);
        const current = lstatSync(path);
        if (stat.dev === current.dev && stat.ino === current.ino) unlinkSync(path);
      } catch {
        // Preserve an identity that cannot be proven to belong to this attempt.
      }
    }
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readRecord(path: string): WorkspaceOwnerRecord | undefined {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.size > MAX_LOCK_BYTES) {
      return undefined;
    }
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) return undefined;
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<WorkspaceOwnerRecord>;
    if (
      value.schema !== LOCK_SCHEMA ||
      !/^sha256:[a-f0-9]{64}$/u.test(value.workspaceDigest ?? '') ||
      !safeId(value.workerScopeId) ||
      !safeId(value.workerInstanceId) ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid ?? 0) < 1 ||
      !safeId(value.processStartIdentity) ||
      !/^[A-Za-z0-9_-]{32}$/u.test(value.nonce ?? '')
    ) {
      return undefined;
    }
    return value as WorkspaceOwnerRecord;
  } catch {
    return undefined;
  }
}

function removeExact(path: string, expected: WorkspaceOwnerRecord): void {
  const before = lstatSync(path);
  const current = readRecord(path);
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    current?.nonce !== expected.nonce ||
    current.processStartIdentity !== expected.processStartIdentity
  ) {
    throw new Error('Workspace owner stale record changed during recovery.');
  }
  const after = lstatSync(path);
  if (before.dev !== after.dev || before.ino !== after.ino) {
    throw new Error('Workspace owner stale record was replaced during recovery.');
  }
  unlinkSync(path);
  syncParent(path);
}

function workspaceDigest(identity: WorkspaceWorkerIdentity): string {
  const match = /^sha256:([a-f0-9]{64})$/u.exec(identity.workspace.workspaceDigest);
  if (!match?.[1]) throw new TypeError('Workspace owner identity has an invalid digest.');
  return match[1];
}

function inspectNativeProcess(pid: number, expectedStart: string): WorkspaceOwnerProcessState {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return isCode(error, 'ESRCH') ? 'dead' : 'uncertain';
  }
  const actual = readProcessStartIdentity(pid);
  return actual === expectedStart ? 'alive' : 'uncertain';
}

function safeId(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= 512 && !/\p{Cc}/u.test(value)
  );
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function syncParent(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(dirname(path), constants.O_RDONLY);
    fsyncSync(descriptor);
  } catch (error) {
    if (process.platform !== 'win32') throw error;
    // Windows does not provide a portable directory fsync through Node. The
    // owner-only parent and exclusive file create remain the lock authority.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
