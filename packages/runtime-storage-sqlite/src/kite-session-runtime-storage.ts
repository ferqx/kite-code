import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type {
  ArtifactPort,
  RuntimeStorage,
  RuntimeTransactionInput,
} from '@kite-ai/runtime-host/storage';
import {
  SQLITE_WORKSPACE_CONTROLLER_RECEIPT_SCHEMA,
  type SqliteWorkspaceControllerOperationResult,
  type SqliteWorkspaceInitialControllerInput,
} from './authority';
import type { KiteHomeArtifactStore } from './kite-home-artifacts';
import type { KiteHomeDirectoryQueryPort } from './kite-home-directory';
import {
  createKiteHomeRuntimeStorageForConnection,
  type KiteHomeRuntimeStorageOwner,
} from './kite-home-runtime-storage';
import { assertKiteSessionStoreSchema, KITE_SESSION_STORE_SCHEMA_VERSION } from './kite-home-store';
import type { KiteHomeWorkspaceAdmissionPort } from './kite-home-workspaces';
import {
  createKiteHomeWriteTransactionPort,
  type KiteHomeWriteTransactionPort,
} from './kite-home-write';
import { createKiteSessionEffectPort, type KiteSessionEffectRecord } from './kite-session-effects';
import {
  createKiteSessionExecutionAuthority,
  type KiteSessionExecutionAuthority,
  type KiteSessionExecutionAuthorityRecord,
} from './kite-session-execution-authority';
import {
  createKiteSessionMutationPort,
  type KiteSessionMutationInput,
} from './kite-session-mutation';
import { openKiteSessionStoreDatabase } from './kite-session-runtime-file';
import type { SqliteRuntimeSnapshotCodec } from './preflight';
import type {
  InitialControllerTransactionPort,
  SqliteWorkspaceSessionCreationPort,
} from './transaction';

export class KiteSessionRuntimeStorageError extends Error {
  readonly code:
    | 'execution_scope_required'
    | 'foreign_execution_handle'
    | 'stale_execution_handle'
    | 'unsupported_mutation';

  constructor(code: KiteSessionRuntimeStorageError['code'], message: string) {
    super(message);
    this.name = 'KiteSessionRuntimeStorageError';
    this.code = code;
  }
}

export interface KiteSessionExecutionHandle {
  readonly sessionId: string;
  snapshot(): KiteSessionMutationInput;
}

export type KiteSessionExecutionControl = Pick<
  KiteSessionExecutionAuthority,
  'read' | 'acquire' | 'renew' | 'detach' | 'release'
>;

export interface KiteSessionRecoveryPort {
  inspect(sessionId: string): Readonly<{
    authority: KiteSessionExecutionAuthorityRecord;
    pendingEffects: readonly KiteSessionEffectRecord[];
  }>;
  reconcile(input: {
    readonly sessionId: string;
    readonly expectedAuthorityRevision: number;
  }): Readonly<{
    authority: KiteSessionExecutionAuthorityRecord;
    unknownEffects: readonly KiteSessionEffectRecord[];
  }>;
}

export interface KiteSessionRuntimeStorageOwner<Event, State> extends AsyncDisposable {
  readonly storage: RuntimeStorage<Event, State> & {
    readonly runs: NonNullable<RuntimeStorage<Event, State>['runs']>;
  };
  readonly admissions: KiteHomeWorkspaceAdmissionPort;
  readonly directory: KiteHomeDirectoryQueryPort;
  readonly artifactStore: KiteHomeArtifactStore;
  readonly authority: KiteSessionExecutionControl;
  readonly recovery: KiteSessionRecoveryPort;
  sessionCreationForWorkspace(
    workspaceId: string,
  ): SqliteWorkspaceSessionCreationPort<Event, State>;
  bindExecution(authority: KiteSessionExecutionAuthorityRecord): KiteSessionExecutionHandle;
  refreshExecution(
    handle: KiteSessionExecutionHandle,
    authority: KiteSessionExecutionAuthorityRecord,
  ): void;
  runWithExecution<Result>(handle: KiteSessionExecutionHandle, operation: () => Result): Result;
  close(): void;
}

interface ExecutionHandleState {
  current: KiteSessionMutationInput;
  leaseUntilMs: number;
  deleted: boolean;
}

/**
 * Opens one WAL connection without a Workspace process lock. Every exposed Session/Run/checkpoint
 * or Artifact write requires a bound execution scope and enters the durable sessionMutation fence.
 */
export function openKiteSessionRuntimeStorage<Event, State>(input: {
  readonly databasePath: string;
  readonly codec: SqliteRuntimeSnapshotCodec<Event, State>;
  readonly stateSchemaVersion: number;
  readonly formatEpoch: string;
  readonly artifacts?: ArtifactPort;
  readonly now?: () => number;
}): KiteSessionRuntimeStorageOwner<Event, State> {
  const database = openKiteSessionStoreDatabase(input.databasePath);
  const rawWriter = createKiteHomeWriteTransactionPort(database, assertKiteSessionStoreSchema);
  const authority = createKiteSessionExecutionAuthority({
    database,
    writer: rawWriter,
    ...(input.now ? { nowMs: input.now } : {}),
  });
  const mutations = createKiteSessionMutationPort({ database, writer: rawWriter, authority });
  const effectPort = createKiteSessionEffectPort({
    database,
    mutations,
    authority,
    writer: rawWriter,
    ...(input.now ? { nowMs: input.now } : {}),
  });
  const scope = new AsyncLocalStorage<KiteSessionExecutionHandle>();
  const handles = new WeakMap<object, ExecutionHandleState>();
  const effectLeaseRevisions = new Map<string, number>();
  const selectRevision = database.query<{ revision: number }, [string]>(
    'SELECT revision FROM runtime_sessions WHERE session_id = ? LIMIT 1',
  );

  const executionControl: KiteSessionExecutionControl = Object.freeze({
    read: authority.read,
    acquire: authority.acquire,
    renew: authority.renew,
    detach: authority.detach,
    release: (request) =>
      rawWriter.run(() => {
        if (!request.cleanupConfirmed) {
          effectPort.markGenerationUnknownInTransaction({
            sessionId: request.sessionId,
            controllerGeneration: request.controllerGeneration,
          });
        } else if (effectPort.listPrepared(request.sessionId).length > 0) {
          throw new KiteSessionRuntimeStorageError(
            'stale_execution_handle',
            'Clean Session release requires every prepared effect to be settled.',
          );
        }
        return authority.releaseInTransaction(request);
      }),
  });

  const recovery: KiteSessionRecoveryPort = Object.freeze({
    inspect: (sessionId: string) =>
      Object.freeze({
        authority: authority.read(sessionId),
        pendingEffects: effectPort.listPrepared(sessionId),
      }),
    reconcile: (request: Parameters<KiteSessionRecoveryPort['reconcile']>[0]) =>
      rawWriter.run(() => {
        const current = authority.read(request.sessionId);
        if (
          current.status !== 'recovery_required' ||
          current.revision !== request.expectedAuthorityRevision ||
          current.controllerGeneration < 2
        ) {
          throw new KiteSessionRuntimeStorageError(
            'stale_execution_handle',
            'Session recovery authority has changed or is not awaiting reconciliation.',
          );
        }
        const unknownEffects = effectPort.markGenerationUnknownInTransaction({
          sessionId: request.sessionId,
          controllerGeneration: current.controllerGeneration - 1,
        });
        const reconciled = authority.confirmRecoveryCleanupInTransaction({
          sessionId: request.sessionId,
          expectedRevision: current.revision,
        });
        return Object.freeze({ authority: reconciled, unknownEffects });
      }),
  });

  const currentHandle = (): ExecutionHandleState => {
    const handle = scope.getStore();
    if (!handle) {
      throw new KiteSessionRuntimeStorageError(
        'execution_scope_required',
        'Session mutation requires an active execution scope.',
      );
    }
    const state = handles.get(handle);
    if (!state || state.deleted) {
      throw new KiteSessionRuntimeStorageError(
        'stale_execution_handle',
        'Session execution handle no longer has durable facts.',
      );
    }
    return state;
  };

  const sessionWriter: KiteHomeWriteTransactionPort = Object.freeze({
    get inTransaction() {
      return rawWriter.inTransaction;
    },
    run<Result>(write: () => Result): Result {
      const handle = currentHandle();
      const result = mutations.run(handle.current, write);
      const row = selectRevision.get(handle.current.sessionId);
      if (!row) {
        handle.deleted = true;
      } else {
        handle.current = Object.freeze({
          ...handle.current,
          expectedSessionRevision: row.revision,
        });
      }
      return result;
    },
  });

  const activeEffect = (sessionId: string, effectId: string, ownerId: string) => {
    const handle = currentHandle();
    if (handle.current.sessionId !== sessionId) {
      throw new KiteSessionRuntimeStorageError(
        'foreign_execution_handle',
        'Effect Session does not match the active execution scope.',
      );
    }
    const key = effectKey(sessionId, effectId, ownerId);
    const revision = effectLeaseRevisions.get(key);
    return { handle, key, revision };
  };

  const runtimeEffects: RuntimeStorage<Event, State>['effects'] = Object.freeze({
    tryAcquireEffectLease(
      sessionId: string,
      effectId: string,
      ownerId: string,
      expiresAtMs: number,
    ) {
      const { handle, key } = activeEffect(sessionId, effectId, ownerId);
      const prepared = effectPort.prepare({
        ...handle.current,
        effectId,
        ownerId,
        expiresAtMs,
      });
      if (prepared.status !== 'prepared') return false;
      effectLeaseRevisions.set(key, prepared.effect.leaseRevision);
      return true;
    },
    renewEffectLease(sessionId: string, effectId: string, ownerId: string, expiresAtMs: number) {
      const { handle, key, revision } = activeEffect(sessionId, effectId, ownerId);
      if (revision === undefined) return false;
      try {
        const renewed = effectPort.renew({
          ...handle.current,
          effectId,
          ownerId,
          expectedLeaseRevision: revision,
          expiresAtMs,
        });
        effectLeaseRevisions.set(key, renewed.leaseRevision);
        return true;
      } catch {
        return false;
      }
    },
    releaseEffectLease(sessionId: string, effectId: string, ownerId: string) {
      const { handle, key, revision } = activeEffect(sessionId, effectId, ownerId);
      if (revision === undefined) return;
      try {
        const current = effectPort.inspect(sessionId, effectId);
        if (current?.state === 'prepared') {
          effectPort.markOutcomeUnknown({
            ...handle.current,
            effectId,
            ownerId,
            expectedLeaseRevision: revision,
          });
        }
      } finally {
        effectLeaseRevisions.delete(key);
      }
    },
  });

  const hasEffectLease = (
    sessionId: string,
    effectId: string,
    ownerId: string,
    _observedAtMs: number,
  ): boolean => {
    try {
      const { handle, revision } = activeEffect(sessionId, effectId, ownerId);
      if (revision === undefined) return false;
      effectPort.assertDispatchable({
        ...handle.current,
        effectId,
        ownerId,
        expectedLeaseRevision: revision,
      });
      return true;
    } catch {
      return false;
    }
  };

  const afterPersistInTransaction = (
    channel: 'decision' | 'attempt_start' | 'receipt_evidence' | 'terminal_recovery',
    transaction: Parameters<RuntimeStorage<Event, State>['transactions']['commitDecision']>[0],
  ): void => {
    const lease = transaction.requiredEffectLease;
    if (!lease || (channel !== 'receipt_evidence' && channel !== 'terminal_recovery')) return;
    const { handle, revision } = activeEffect(transaction.sessionId, lease.effectId, lease.ownerId);
    if (revision === undefined) {
      throw new KiteSessionRuntimeStorageError(
        'stale_execution_handle',
        'Effect receipt has no current lease revision.',
      );
    }
    effectPort.commitTerminalInTransaction({
      ...handle.current,
      effectId: lease.effectId,
      ownerId: lease.ownerId,
      expectedLeaseRevision: revision,
      terminalDigest: effectTerminalDigest(transaction, input.codec),
    });
  };

  const initialController: InitialControllerTransactionPort = Object.freeze({
    create(request: SqliteWorkspaceInitialControllerInput, mode: 'create' | 'replay') {
      const leaseUntilMs = request.executionLeaseUntilMs;
      if (!Number.isSafeInteger(leaseUntilMs) || (leaseUntilMs ?? 0) <= (input.now ?? Date.now)()) {
        throw new KiteSessionRuntimeStorageError(
          'stale_execution_handle',
          'Initial Session execution lease is missing or expired.',
        );
      }
      if (mode === 'create') {
        const record = authority.acquireInitialInTransaction({
          sessionId: request.sessionId,
          hostInstanceId: request.workerInstanceId,
          clientId: request.clientId,
          connectionGeneration: request.connectionGeneration,
          leaseUntilMs: leaseUntilMs!,
        });
        return initialControllerResult(request, record, 'applied');
      }
      const record = authority.read(request.sessionId);
      if (
        record.status !== 'active' ||
        record.hostInstanceId !== request.workerInstanceId ||
        record.clientId !== request.clientId ||
        record.connectionGeneration !== request.connectionGeneration
      ) {
        return initialControllerRejected(request, record);
      }
      return initialControllerResult(request, record, 'replay');
    },
  });

  let base: KiteHomeRuntimeStorageOwner<Event, State>;
  try {
    base = createKiteHomeRuntimeStorageForConnection({
      database,
      assertStoreSchema: assertKiteSessionStoreSchema,
      storeSchemaVersion: KITE_SESSION_STORE_SCHEMA_VERSION,
      writer: rawWriter,
      sessionWriter,
      removeSessionAuthorityInTransaction: () => {
        const handle = currentHandle();
        authority.removeInTransaction(handle.current);
      },
      createForkTargetAuthorityInTransaction: (targetSessionId) => {
        const handle = currentHandle();
        authority.acquireInitialInTransaction({
          sessionId: targetSessionId,
          hostInstanceId: handle.current.hostInstanceId,
          clientId: handle.current.clientId,
          connectionGeneration: handle.current.connectionGeneration,
          leaseUntilMs: handle.leaseUntilMs,
        });
      },
      hasEffectLease,
      afterPersistInTransaction,
      initialController,
      runCreateTransaction: (write) => rawWriter.run(write),
      codec: input.codec,
      stateSchemaVersion: input.stateSchemaVersion,
      formatEpoch: input.formatEpoch,
      ownsDatabase: true,
      ...(input.artifacts ? { artifacts: input.artifacts } : {}),
      ...(input.now ? { now: input.now } : {}),
    });
  } catch (error) {
    database.close(false);
    throw error;
  }

  const runs = Object.freeze({
    ...base.storage.runs,
    forkSession: () => unsupported('Cross-Session Run fork requires atomic target authority.'),
  });
  const storage = Object.freeze({
    ...base.storage,
    effects: runtimeEffects,
    runs,
  });
  const artifactStore = disableArtifactGarbageCollection(base.artifactStore);

  const assertHandle = (handle: KiteSessionExecutionHandle): ExecutionHandleState => {
    const state = typeof handle === 'object' && handle !== null ? handles.get(handle) : undefined;
    if (!state) {
      throw new KiteSessionRuntimeStorageError(
        'foreign_execution_handle',
        'Session execution handle belongs to another Store connection.',
      );
    }
    return state;
  };

  const bindExecution = (
    record: KiteSessionExecutionAuthorityRecord,
  ): KiteSessionExecutionHandle => {
    const binding = mutationInput(record, selectRevision);
    authority.assertActive(binding);
    const state: ExecutionHandleState = {
      current: binding,
      leaseUntilMs: requiredLeaseUntil(record),
      deleted: false,
    };
    const handle: KiteSessionExecutionHandle = {
      sessionId: record.sessionId,
      snapshot() {
        if (state.deleted) {
          throw new KiteSessionRuntimeStorageError(
            'stale_execution_handle',
            'Session execution handle no longer has durable facts.',
          );
        }
        return state.current;
      },
    };
    const frozen = Object.freeze(handle);
    handles.set(frozen, state);
    return frozen;
  };

  const refreshExecution = (
    external: KiteSessionExecutionHandle,
    record: KiteSessionExecutionAuthorityRecord,
  ): void => {
    const handle = assertHandle(external);
    if (handle.current.sessionId !== record.sessionId || handle.deleted) {
      throw new KiteSessionRuntimeStorageError(
        'stale_execution_handle',
        'Session execution handle cannot be rebound.',
      );
    }
    const next = mutationInput(record, selectRevision);
    authority.assertActive(next);
    handle.current = next;
    handle.leaseUntilMs = requiredLeaseUntil(record);
  };

  const runWithExecution = <Result>(
    external: KiteSessionExecutionHandle,
    operation: () => Result,
  ): Result => {
    assertHandle(external);
    const nested = scope.getStore();
    if (nested && nested !== external) {
      throw new KiteSessionRuntimeStorageError(
        'foreign_execution_handle',
        'Nested Session execution scopes must use the same handle.',
      );
    }
    return nested ? operation() : scope.run(external, operation);
  };

  const owner: KiteSessionRuntimeStorageOwner<Event, State> = {
    storage,
    admissions: base.admissions,
    directory: base.directory,
    artifactStore,
    authority: executionControl,
    recovery,
    sessionCreationForWorkspace: (workspaceId) => base.sessionCreationForWorkspace(workspaceId),
    bindExecution,
    refreshExecution,
    runWithExecution,
    close: () => base.close(),
    [Symbol.asyncDispose]: async () => base.close(),
  };
  return Object.freeze(owner);
}

function initialControllerResult(
  request: SqliteWorkspaceInitialControllerInput,
  record: KiteSessionExecutionAuthorityRecord,
  status: 'applied' | 'replay',
): SqliteWorkspaceControllerOperationResult {
  return {
    status,
    receipt: initialControllerReceipt(request, record, 'acquired'),
    lease: {
      sessionId: record.sessionId,
      clientId: request.clientId,
      connectionGeneration: record.connectionGeneration,
      controllerGeneration: record.controllerGeneration,
      workerInstanceId: request.workerInstanceId,
      status: 'active',
    },
  };
}

function initialControllerRejected(
  request: SqliteWorkspaceInitialControllerInput,
  record: KiteSessionExecutionAuthorityRecord,
): SqliteWorkspaceControllerOperationResult {
  return {
    status: 'rejected',
    receipt: initialControllerReceipt(request, record, 'stale_lease', 'rejected'),
  };
}

function initialControllerReceipt(
  request: SqliteWorkspaceInitialControllerInput,
  record: KiteSessionExecutionAuthorityRecord,
  code: 'acquired' | 'stale_lease',
  status: 'applied' | 'rejected' = 'applied',
) {
  return {
    schema: SQLITE_WORKSPACE_CONTROLLER_RECEIPT_SCHEMA,
    sessionId: request.sessionId,
    requestId: request.requestId,
    requestDigest: request.requestDigest,
    operation: 'request_control' as const,
    status,
    code,
    controllerGeneration: record.controllerGeneration,
    connectionGeneration: record.connectionGeneration,
    interactionGeneration: record.interactionGeneration,
    clientId: record.clientId,
    workerInstanceId: record.hostInstanceId,
    completedAt: record.updatedAt,
  };
}

function mutationInput(
  record: KiteSessionExecutionAuthorityRecord,
  selectRevision: { get(sessionId: string): { revision: number } | null },
): KiteSessionMutationInput {
  if (
    record.status !== 'active' ||
    !record.hostInstanceId ||
    record.leaseUntilMs === null ||
    record.cleanupConfirmed
  ) {
    throw new KiteSessionRuntimeStorageError(
      'stale_execution_handle',
      'Session execution authority is not active.',
    );
  }
  const session = selectRevision.get(record.sessionId);
  if (!session) {
    throw new KiteSessionRuntimeStorageError(
      'stale_execution_handle',
      'Session execution authority has no durable Session.',
    );
  }
  return Object.freeze({
    sessionId: record.sessionId,
    controllerGeneration: record.controllerGeneration,
    hostInstanceId: record.hostInstanceId,
    clientId: record.clientId,
    connectionGeneration: record.connectionGeneration,
    expectedAuthorityRevision: record.revision,
    expectedSessionRevision: session.revision,
  });
}

function disableArtifactGarbageCollection(store: KiteHomeArtifactStore): KiteHomeArtifactStore {
  const disabled = () => unsupported('Artifact garbage collection is disabled for KASD.');
  return Object.freeze({
    ...store,
    collectModelGarbage: disabled,
    collectPlanGarbage: disabled,
    collectCapabilityGarbage: disabled,
    collectFilesystemPreimageGarbage: disabled,
    collectSandboxPreparationGarbage: disabled,
    collectSubagentTaskGarbage: disabled,
    collectSubagentLifecycleGarbage: disabled,
    collectSubagentContinuationGarbage: disabled,
  });
}

function requiredLeaseUntil(record: KiteSessionExecutionAuthorityRecord): number {
  if (record.status !== 'active' || record.leaseUntilMs === null) {
    throw new KiteSessionRuntimeStorageError(
      'stale_execution_handle',
      'Session execution authority has no active lease.',
    );
  }
  return record.leaseUntilMs;
}

function effectKey(sessionId: string, effectId: string, ownerId: string): string {
  return `${sessionId}\0${effectId}\0${ownerId}`;
}

function effectTerminalDigest<Event, State>(
  transaction: RuntimeTransactionInput<Event, State>,
  codec: SqliteRuntimeSnapshotCodec<Event, State>,
): string {
  const digest = createHash('sha256').update('kite-session-effect-terminal-v1\0');
  digest.update(transaction.sessionId).update('\0');
  for (const event of transaction.events) {
    digest.update(codec.encodeEvent(event)).update('\0');
  }
  digest.update(codec.encodeState(transaction.snapshot));
  return digest.digest('hex');
}

function unsupported(message: string): never {
  throw new KiteSessionRuntimeStorageError('unsupported_mutation', message);
}
