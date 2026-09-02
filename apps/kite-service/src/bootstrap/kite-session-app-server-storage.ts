import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { RuntimeStorage } from '@kite-ai/runtime-host/storage';
import type {
  KiteSessionExecutionAuthorityRecord,
  KiteSessionExecutionHandle,
  KiteSessionRuntimeStorageOwner,
} from '@kite-ai/runtime-storage-sqlite';
import type { AdmittedWorkspace } from '../runtime-application';
import type { RuntimeEvent, RuntimeState } from './runtime/state-runtime';

const DEFAULT_EXECUTION_LEASE_MS = 30_000;
const DEFAULT_RENEW_INTERVAL_MS = 10_000;

export type KiteAppServerSessionErrorCode =
  | 'session_busy'
  | 'recovery_required'
  | 'session_unavailable'
  | 'storage_closed';

export class KiteAppServerSessionError extends Error {
  readonly code: KiteAppServerSessionErrorCode;

  constructor(code: KiteAppServerSessionErrorCode, message: string) {
    super(message);
    this.name = 'KiteAppServerSessionError';
    this.code = code;
  }
}

export interface KiteSessionAppServerStorageOwner extends AsyncDisposable {
  readonly storage: RuntimeStorage<RuntimeEvent, RuntimeState>;
  readonly artifactStore: KiteSessionRuntimeStorageOwner<
    RuntimeEvent,
    RuntimeState
  >['artifactStore'];
  readonly directory: KiteSessionRuntimeStorageOwner<RuntimeEvent, RuntimeState>['directory'];
  admitWorkspace(workspace: AdmittedWorkspace): void;
  listCurrentSessions(
    query?: string,
    limit?: number,
  ): ReturnType<RuntimeStorage<RuntimeEvent, RuntimeState>['sessions']['listSessions']>;
  loadCurrentSnapshot(sessionId: string): RuntimeState | null;
  getCurrentSessionModelRoute(
    sessionId: string,
  ): ReturnType<RuntimeStorage<RuntimeEvent, RuntimeState>['sessions']['getSessionModelRoute']>;
  runWithSessionExecution<Result>(sessionId: string, operation: () => Result): Result;
  readSnapshot<Result>(operation: () => Result): Result;
  ownsSessionExecution(sessionId: string): boolean;
  readonly recovery: KiteSessionRuntimeStorageOwner<RuntimeEvent, RuntimeState>['recovery'];
  ownedSessionIds(): readonly string[];
  releaseExecutions(cleanupConfirmed: boolean): void;
  disposeStorage(): void;
  close(): void;
}

interface OwnedExecution {
  record: KiteSessionExecutionAuthorityRecord;
  readonly handle: KiteSessionExecutionHandle;
}

export function createKiteSessionAppServerStorage(input: {
  readonly target: KiteSessionRuntimeStorageOwner<RuntimeEvent, RuntimeState>;
  readonly hostInstanceId: string;
  readonly clientId?: string;
  readonly connectionGeneration?: number;
  readonly executionLeaseMs?: number;
  readonly renewIntervalMs?: number;
  readonly now?: () => number;
}): KiteSessionAppServerStorageOwner {
  assertIdentity(input.hostInstanceId, 'Host instance');
  const clientId = input.clientId ?? `parent-${input.hostInstanceId}`;
  const connectionGeneration = input.connectionGeneration ?? 1;
  assertIdentity(clientId, 'Client');
  assertPositive(connectionGeneration, 'Connection generation');
  const executionLeaseMs = input.executionLeaseMs ?? DEFAULT_EXECUTION_LEASE_MS;
  const renewIntervalMs = input.renewIntervalMs ?? DEFAULT_RENEW_INTERVAL_MS;
  assertPositive(executionLeaseMs, 'Execution lease duration');
  assertPositive(renewIntervalMs, 'Execution renewal interval');
  if (renewIntervalMs >= executionLeaseMs) {
    throw new TypeError('Execution renewal interval must be shorter than the lease duration.');
  }
  const now = input.now ?? Date.now;
  const target = input.target;
  const owned = new Map<string, OwnedExecution>();
  const pendingRecoveryIdentities = new Map<string, string>();
  let hostClosed = false;
  let closed = false;

  const leaseUntil = (): number => {
    const value = now() + executionLeaseMs;
    if (!Number.isSafeInteger(value)) throw new Error('Session execution lease overflowed.');
    return value;
  };

  const bind = (record: KiteSessionExecutionAuthorityRecord): OwnedExecution => {
    const existing = owned.get(record.sessionId);
    if (existing) {
      target.refreshExecution(existing.handle, record);
      existing.record = record;
      return existing;
    }
    const execution = { record, handle: target.bindExecution(record) };
    owned.set(record.sessionId, execution);
    return execution;
  };

  const ensureExecution = (sessionId: string): OwnedExecution => {
    assertOpen();
    const current = target.authority.read(sessionId);
    if (
      current.status === 'active' &&
      current.hostInstanceId === input.hostInstanceId &&
      current.clientId === clientId &&
      current.connectionGeneration === connectionGeneration
    ) {
      if (current.leaseUntilMs === null || current.leaseUntilMs <= now()) {
        throw new KiteAppServerSessionError(
          'recovery_required',
          'Session execution lease expired before renewal.',
        );
      }
      return bind(current);
    }
    if (current.status === 'recovery_required') {
      throw new KiteAppServerSessionError(
        'recovery_required',
        'Session requires explicit effect reconciliation before resume.',
      );
    }
    const acquired = target.authority.acquire({
      sessionId,
      expectedRevision: current.revision,
      hostInstanceId: input.hostInstanceId,
      clientId,
      connectionGeneration,
      leaseUntilMs: leaseUntil(),
    });
    if (acquired.status === 'recovery_required') {
      throw new KiteAppServerSessionError(
        'recovery_required',
        'Session requires explicit effect reconciliation before resume.',
      );
    }
    if (acquired.status === 'busy') {
      throw new KiteAppServerSessionError(
        'session_busy',
        'Session execution is owned by another App Server.',
      );
    }
    return bind(acquired.authority);
  };

  const runWithSessionExecution = <Result>(sessionId: string, operation: () => Result): Result => {
    const execution = ensureExecution(sessionId);
    return target.runWithExecution(execution.handle, operation);
  };

  const renewTimer = setInterval(() => {
    if (closed || hostClosed) return;
    for (const [sessionId, execution] of owned) {
      try {
        const current = target.authority.read(sessionId);
        if (
          current.status !== 'active' ||
          current.hostInstanceId !== input.hostInstanceId ||
          current.clientId !== clientId ||
          current.connectionGeneration !== connectionGeneration
        ) {
          owned.delete(sessionId);
          continue;
        }
        const renewed = target.authority.renew({
          sessionId,
          expectedRevision: current.revision,
          controllerGeneration: current.controllerGeneration,
          hostInstanceId: input.hostInstanceId,
          leaseUntilMs: leaseUntil(),
        });
        if (renewed.status !== 'acquired') {
          owned.delete(sessionId);
          continue;
        }
        execution.record = renewed.authority;
        target.refreshExecution(execution.handle, renewed.authority);
      } catch {
        owned.delete(sessionId);
      }
    }
  }, renewIntervalMs);
  renewTimer.unref?.();

  const commit = (
    channel: keyof RuntimeStorage<RuntimeEvent, RuntimeState>['transactions'],
    transaction: Parameters<
      RuntimeStorage<RuntimeEvent, RuntimeState>['transactions']['commitDecision']
    >[0],
  ): void => {
    if (target.storage.sessions.loadSnapshotRecord(transaction.sessionId)) {
      target.storage.transactions[channel](transaction);
      return;
    }
    if (channel !== 'commitDecision' || !transaction.commandReceipt) {
      throw new KiteAppServerSessionError(
        'session_unavailable',
        'Only a receipt-bearing create decision may initialize a Session.',
      );
    }
    const workspace = workspaceFromState(transaction.snapshot);
    admitWorkspace(workspace);
    const recoveryIdentity = pendingRecoveryIdentities.get(transaction.sessionId);
    if (!recoveryIdentity) {
      throw new KiteAppServerSessionError(
        'session_unavailable',
        'Initial Session recovery identity was not allocated.',
      );
    }
    const result = target.sessionCreationForWorkspace(workspaceIdFor(workspace)).create({
      runtime: transaction,
      controller: {
        sessionId: transaction.sessionId,
        requestId: transaction.commandReceipt.commandId,
        requestDigest: transaction.commandReceipt.requestDigest,
        clientId,
        connectionGeneration,
        workerInstanceId: input.hostInstanceId,
        resumeSecret: createHash('sha256')
          .update(`kite.app-server.initial-resume.v1\0${transaction.commandReceipt.commandId}`)
          .digest('base64url'),
        resumeExpiresAtMs: leaseUntil(),
        executionLeaseUntilMs: leaseUntil(),
      },
      recoveryIdentity,
    });
    pendingRecoveryIdentities.delete(transaction.sessionId);
    bind(target.authority.read(transaction.sessionId));
    if (result.runtimeReceipt.committedRevision !== transaction.commandReceipt.committedRevision) {
      throw new Error('Initial Session receipt revision changed after commit.');
    }
  };

  const transactions = Object.freeze({
    commitDecision: (transaction) => commit('commitDecision', transaction),
    commitAttemptStart: (transaction) => commit('commitAttemptStart', transaction),
    commitReceiptEvidence: (transaction) => commit('commitReceiptEvidence', transaction),
    commitTerminalRecovery: (transaction) => commit('commitTerminalRecovery', transaction),
  } satisfies RuntimeStorage<RuntimeEvent, RuntimeState>['transactions']);

  const recoveryIdentities = Object.freeze({
    read(sessionId) {
      return (
        pendingRecoveryIdentities.get(sessionId) ??
        target.storage.recoveryIdentities.read(sessionId)
      );
    },
    getOrCreate(sessionId, allocate) {
      if (target.storage.sessions.loadSnapshotRecord(sessionId)) {
        return target.storage.recoveryIdentities.getOrCreate(sessionId, allocate);
      }
      const existing = pendingRecoveryIdentities.get(sessionId);
      if (existing) return existing;
      const value = allocate();
      if (!/^[a-f0-9]{64}$/u.test(value)) {
        throw new Error('Initial Session recovery identity is invalid.');
      }
      pendingRecoveryIdentities.set(sessionId, value);
      return value;
    },
    remove(sessionId) {
      if (pendingRecoveryIdentities.delete(sessionId)) return;
      target.storage.recoveryIdentities.remove(sessionId);
    },
  } satisfies RuntimeStorage<RuntimeEvent, RuntimeState>['recoveryIdentities']);

  const storage: RuntimeStorage<RuntimeEvent, RuntimeState> = Object.freeze({
    ...target.storage,
    transactions,
    recoveryIdentities,
    close: () => {
      hostClosed = true;
    },
  });

  function admitWorkspace(workspace: AdmittedWorkspace): void {
    const digest = workspaceIdentityDigest(workspace);
    target.admissions.admit({
      workspaceId: workspaceIdFor(workspace),
      canonicalPath: workspace.canonicalPath,
      workspaceIdentityDigest: digest,
      projectId: workspace.projectId,
      workspaceDigest: workspace.workspaceDigest,
      displayName: basename(workspace.canonicalPath),
    });
  }

  function assertOpen(): void {
    if (closed || hostClosed) {
      throw new KiteAppServerSessionError('storage_closed', 'App Server storage is closed.');
    }
  }

  const releaseExecutions = (cleanupConfirmed: boolean): void => {
    clearInterval(renewTimer);
    for (const [sessionId, execution] of owned) {
      try {
        const current = target.authority.read(sessionId);
        if (
          current.status !== 'active' ||
          current.hostInstanceId !== input.hostInstanceId ||
          current.controllerGeneration !== execution.record.controllerGeneration
        ) {
          continue;
        }
        target.authority.release({
          sessionId,
          expectedRevision: current.revision,
          controllerGeneration: current.controllerGeneration,
          hostInstanceId: input.hostInstanceId,
          cleanupConfirmed,
        });
      } catch {
        if (!cleanupConfirmed) continue;
        const current = target.authority.read(sessionId);
        if (current.status !== 'active' || current.hostInstanceId !== input.hostInstanceId)
          continue;
        target.authority.release({
          sessionId,
          expectedRevision: current.revision,
          controllerGeneration: current.controllerGeneration,
          hostInstanceId: input.hostInstanceId,
          cleanupConfirmed: false,
        });
      }
    }
    owned.clear();
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    hostClosed = true;
    clearInterval(renewTimer);
    pendingRecoveryIdentities.clear();
    target.close();
  };

  return Object.freeze({
    storage,
    artifactStore: target.artifactStore,
    directory: target.directory,
    admitWorkspace,
    listCurrentSessions: (query = '', limit = 50) => storage.sessions.listSessions(query, limit),
    loadCurrentSnapshot: (sessionId) => storage.sessions.loadSnapshot<RuntimeState>(sessionId),
    getCurrentSessionModelRoute: (sessionId) => storage.sessions.getSessionModelRoute(sessionId),
    runWithSessionExecution,
    readSnapshot: target.readSnapshot,
    ownsSessionExecution: (sessionId) => owned.has(sessionId),
    recovery: target.recovery,
    ownedSessionIds: () => Object.freeze([...owned.keys()]),
    releaseExecutions,
    disposeStorage: close,
    close,
    [Symbol.asyncDispose]: async () => close(),
  } satisfies KiteSessionAppServerStorageOwner);
}

function workspaceFromState(state: RuntimeState): AdmittedWorkspace {
  const canonicalPath = state.session.workspace;
  const projectId = state.session.projectId;
  const workspaceDigest = state.session.canonicalWorkspaceDigest;
  assertIdentity(canonicalPath, 'Workspace path');
  assertIdentity(projectId, 'Project');
  if (typeof workspaceDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(workspaceDigest)) {
    throw new TypeError('Workspace digest identity is invalid.');
  }
  const workspace: AdmittedWorkspace = {
    canonicalPath,
    projectId,
    workspaceDigest: workspaceDigest as `sha256:${string}`,
  };
  return Object.freeze(workspace);
}

function workspaceIdentityDigest(workspace: AdmittedWorkspace): string {
  const material = JSON.stringify({
    canonicalPath: workspace.canonicalPath,
    projectId: workspace.projectId,
    workspaceDigest: workspace.workspaceDigest,
  });
  return `sha256:${createHash('sha256').update(`kite.workspace-identity.v1\0${material}`).digest('hex')}`;
}

function workspaceIdFor(workspace: AdmittedWorkspace): string {
  return `workspace_${workspaceIdentityDigest(workspace).slice('sha256:'.length)}`;
}

function assertIdentity(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > 512 || /\p{Cc}/u.test(value)) {
    throw new TypeError(`${label} identity is invalid.`);
  }
}

function assertPositive(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} is invalid.`);
}
