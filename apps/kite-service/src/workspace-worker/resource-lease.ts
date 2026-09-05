import { createHash, randomBytes } from 'node:crypto';
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
import type {
  WorkspaceEffectAttempt,
  WorkspaceResourceLease,
  WorkspaceResourceLeasePort,
} from './effect-gate';

const RESOURCE_LEASE_SCHEMA = 'kite.workspace-resource-lease.v1' as const;
const MAX_RESOURCE_LEASE_BYTES = 32 * 1024;

interface ResourceLeaseRecord {
  readonly schema: typeof RESOURCE_LEASE_SCHEMA;
  readonly sessionId: string;
  readonly commandId: string | null;
  readonly invocationId: string;
  readonly clientId: string;
  readonly connectionGeneration: number;
  readonly controllerGeneration: number;
  readonly workerInstanceId: string;
  readonly ownerId: string;
  readonly resourceId: string;
  readonly workerScopeId: string;
  readonly workspaceDigest: string;
  readonly attemptId: string;
  readonly requestDigest: string;
  readonly expiresAtMs: number;
  readonly kind: WorkspaceEffectAttempt['kind'];
  readonly pid: number;
  readonly processStartIdentity: string;
  readonly nonce: string;
}

export type WorkspaceResourceOwnerProcessState = 'alive' | 'dead' | 'uncertain';

export interface NativeWorkspaceResourceLeaseOptions {
  /** Fixed OS-user coordination home shared by every explicit Kite home. */
  readonly coordinationHome: KiteHomeIdentity;
  readonly processState?: (
    pid: number,
    processStartIdentity: string,
  ) => WorkspaceResourceOwnerProcessState;
  readonly currentProcessIdentity?: () => string | undefined;
  readonly randomBytes?: (size: number) => Uint8Array;
}

/**
 * Cross-Workspace shared-resource lease. The durable effect evidence remains
 * in the owning Workspace Store; this primitive only prevents two live
 * Workers from mutating the same canonical resource identity concurrently.
 */
export function createNativeWorkspaceResourceLeasePort(
  options: NativeWorkspaceResourceLeaseOptions,
): WorkspaceResourceLeasePort {
  const root = ensurePrivateKiteHomeDirectory(options.coordinationHome, [
    'workspace-resource-leases',
    'v1',
  ]);
  const processState = options.processState ?? inspectNativeProcess;
  const currentProcessIdentity =
    options.currentProcessIdentity ?? (() => readProcessStartIdentity(process.pid));
  const random = options.randomBytes ?? randomBytes;

  return Object.freeze({
    async acquire(attempt: WorkspaceEffectAttempt): Promise<WorkspaceResourceLease> {
      assertAttempt(attempt);
      const processIdentity = currentProcessIdentity();
      if (!processIdentity) throw new Error('Workspace resource owner identity is unavailable.');
      const material = random(24);
      if (!(material instanceof Uint8Array) || material.byteLength !== 24) {
        throw new Error('Workspace resource lease nonce source is invalid.');
      }
      const nonce = Buffer.from(material).toString('base64url');
      material.fill(0);
      const record: ResourceLeaseRecord = {
        schema: RESOURCE_LEASE_SCHEMA,
        sessionId: attempt.sessionId,
        commandId: attempt.commandId,
        invocationId: attempt.invocationId,
        clientId: attempt.clientId,
        connectionGeneration: attempt.connectionGeneration,
        controllerGeneration: attempt.controllerGeneration,
        workerInstanceId: attempt.workerInstanceId,
        ownerId: attempt.ownerId,
        resourceId: attempt.resourceId,
        workerScopeId: attempt.workerScopeId,
        workspaceDigest: attempt.workspaceDigest,
        attemptId: attempt.attemptId,
        requestDigest: attempt.requestDigest,
        expiresAtMs: attempt.expiresAtMs,
        kind: attempt.kind,
        pid: process.pid,
        processStartIdentity: processIdentity,
        nonce,
      };
      const path = join(root, `${resourceDigest(attempt.resourceId)}.lease`);
      const acquired = acquireExact(path, record);
      if (acquired) return lease(attempt.resourceId, path, record, acquired);

      const existing = readRecord(path);
      if (!existing || existing.resourceId !== attempt.resourceId) {
        throw new Error('Workspace resource lease is busy or unverifiable.');
      }
      if (processState(existing.pid, existing.processStartIdentity) !== 'dead') {
        throw new Error('Workspace resource lease is busy or unverifiable.');
      }
      removeExact(path, existing);
      const retried = acquireExact(path, record);
      if (!retried) throw new Error('Workspace resource lease changed during stale recovery.');
      return lease(attempt.resourceId, path, record, retried);
    },
  });
}

function lease(
  resourceId: string,
  path: string,
  record: ResourceLeaseRecord,
  fileIdentity: Readonly<{ dev: number; ino: number }>,
): WorkspaceResourceLease {
  let released = false;
  return Object.freeze({
    resourceId,
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
        throw new Error('Workspace resource lease is no longer owned by this Worker.');
      }
      unlinkSync(path);
      syncParent(path);
      released = true;
    },
  });
}

function acquireExact(
  path: string,
  record: ResourceLeaseRecord,
): Readonly<{ dev: number; ino: number }> | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const encoded = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(encoded) > MAX_RESOURCE_LEASE_BYTES) {
      throw new Error('Workspace resource lease record exceeds its bound.');
    }
    writeFileSync(descriptor, encoded, 'utf8');
    fsyncSync(descriptor);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error('Workspace resource lease is not a private regular file.');
    }
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      throw new Error('Workspace resource lease permissions are not owner-only.');
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

function readRecord(path: string): ResourceLeaseRecord | undefined {
  try {
    const stat = lstatSync(path);
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > MAX_RESOURCE_LEASE_BYTES
    ) {
      return undefined;
    }
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) return undefined;
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<ResourceLeaseRecord>;
    if (
      value.schema !== RESOURCE_LEASE_SCHEMA ||
      !safeId(value.sessionId) ||
      (value.commandId !== null && !safeId(value.commandId)) ||
      !safeId(value.invocationId) ||
      !safeId(value.clientId) ||
      !Number.isSafeInteger(value.connectionGeneration) ||
      (value.connectionGeneration ?? 0) < 1 ||
      !Number.isSafeInteger(value.controllerGeneration) ||
      (value.controllerGeneration ?? 0) < 1 ||
      !safeId(value.workerInstanceId) ||
      !safeId(value.ownerId) ||
      !safeId(value.resourceId) ||
      !safeId(value.workerScopeId) ||
      !/^sha256:[a-f0-9]{64}$/u.test(value.workspaceDigest ?? '') ||
      !safeId(value.attemptId) ||
      !/^[a-f0-9]{64}$/u.test(value.requestDigest ?? '') ||
      !Number.isSafeInteger(value.expiresAtMs) ||
      (value.expiresAtMs ?? 0) <= 0 ||
      !isMutationKind(value.kind) ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid ?? 0) < 1 ||
      !safeId(value.processStartIdentity) ||
      !/^[A-Za-z0-9_-]{32}$/u.test(value.nonce ?? '')
    ) {
      return undefined;
    }
    return value as ResourceLeaseRecord;
  } catch {
    return undefined;
  }
}

function removeExact(path: string, expected: ResourceLeaseRecord): void {
  const before = lstatSync(path);
  const current = readRecord(path);
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    current?.nonce !== expected.nonce ||
    current.processStartIdentity !== expected.processStartIdentity ||
    current.resourceId !== expected.resourceId
  ) {
    throw new Error('Workspace resource stale record changed during recovery.');
  }
  const after = lstatSync(path);
  if (before.dev !== after.dev || before.ino !== after.ino) {
    throw new Error('Workspace resource stale record was replaced during recovery.');
  }
  unlinkSync(path);
  syncParent(path);
}

function assertAttempt(attempt: WorkspaceEffectAttempt): void {
  if (
    !safeId(attempt.sessionId) ||
    (attempt.commandId !== null && !safeId(attempt.commandId)) ||
    !safeId(attempt.invocationId) ||
    !safeId(attempt.clientId) ||
    !Number.isSafeInteger(attempt.connectionGeneration) ||
    attempt.connectionGeneration < 1 ||
    !Number.isSafeInteger(attempt.controllerGeneration) ||
    attempt.controllerGeneration < 1 ||
    !safeId(attempt.workerInstanceId) ||
    !safeId(attempt.ownerId) ||
    !safeId(attempt.resourceId) ||
    !safeId(attempt.workerScopeId) ||
    !/^sha256:[a-f0-9]{64}$/u.test(attempt.workspaceDigest) ||
    !safeId(attempt.attemptId) ||
    !/^[a-f0-9]{64}$/u.test(attempt.requestDigest) ||
    !Number.isSafeInteger(attempt.expiresAtMs) ||
    attempt.expiresAtMs <= 0 ||
    !isMutationKind(attempt.kind)
  ) {
    throw new TypeError('Workspace resource lease attempt is invalid.');
  }
}

function resourceDigest(resourceId: string): string {
  return createHash('sha256').update(resourceId, 'utf8').digest('hex');
}

function isMutationKind(value: unknown): value is WorkspaceEffectAttempt['kind'] {
  return (
    value === 'filesystem' ||
    value === 'shell' ||
    value === 'git' ||
    value === 'workspace_config' ||
    value === 'mcp_project' ||
    value === 'sandbox_external'
  );
}

function inspectNativeProcess(
  pid: number,
  expectedStart: string,
): WorkspaceResourceOwnerProcessState {
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
    typeof value === 'string' && value.length > 0 && value.length <= 4_096 && !/\p{Cc}/u.test(value)
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
    // Windows directory fsync has no portable Node primitive. The protected
    // directory and exclusive regular-file create remain the lease authority.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
