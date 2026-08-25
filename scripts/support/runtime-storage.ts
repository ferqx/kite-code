/** Root-only composition of the current Host State codec and SQLite Store. */

import { createHash } from 'node:crypto';
import type { AgentState, RuntimeEvent } from '@kite-ai/agent-kernel';
import {
  createRuntimeHostStateStorageBinding,
  type RuntimeHostLeasePort,
  type RuntimeHostTransactionPort,
} from '@kite-ai/runtime-host';
import { createRuntimeHostStateInitialState } from '@kite-ai/runtime-host/kernel-adapter';
import type {
  ArtifactPort,
  CheckpointPort,
  EffectLeasePort,
  RuntimeEffectLeaseExpectation,
  RuntimeEventMetadata,
  RuntimeRecoveryIdentityPort,
  RuntimeRestoreBoundary,
  RuntimeSnapshotCodec,
  RuntimeSnapshotMetadata,
  RuntimeStorage,
  RuntimeStorageBoundary,
  RuntimeTransactionInput,
  SessionStore,
} from '@kite-ai/runtime-host/storage';
import {
  createSqliteRuntimeStorage,
  type SqliteRuntimeStorageOptions,
  sqliteRuntimeStorePath,
} from '@kite-ai/runtime-storage-sqlite';

const CURRENT_STORAGE_BINDING_ = createRuntimeHostStateStorageBinding();

/**
 * Give root-only State fixtures a deterministic Project identity.
 *
 * Production never calls this helper. The projection keeps old root fixtures
 * honest while they exercise the real Store codec, DDL and reopen rules.
 */
export function withTestStateProjectIdentity<State>(state: State): State {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return state;
  const record = state as Readonly<Record<string, unknown>>;
  const session = record.session;
  if (!session || typeof session !== 'object' || Array.isArray(session)) return state;
  const sessionRecord = session as Readonly<Record<string, unknown>>;
  if (
    typeof sessionRecord.projectId === 'string' &&
    sessionRecord.projectId.startsWith('project_') &&
    typeof sessionRecord.canonicalWorkspaceDigest === 'string' &&
    /^sha256:[a-f0-9]{64}$/u.test(sessionRecord.canonicalWorkspaceDigest)
  ) {
    return state;
  }
  const workspace =
    typeof sessionRecord.workspace === 'string' ? sessionRecord.workspace : 'root-test-workspace';
  const identity = testStateProjectIdentityForWorkspace(workspace);
  return {
    ...record,
    session: {
      ...sessionRecord,
      ...identity,
    },
  } as State;
}

export function testStateProjectIdentityForWorkspace(workspace: string): {
  readonly projectId: string;
  readonly canonicalWorkspaceDigest: `sha256:${string}`;
} {
  const digest = createHash('sha256').update(workspace).digest('hex');
  return Object.freeze({
    projectId: 'project_test_runtime_agent',
    canonicalWorkspaceDigest: `sha256:${digest}`,
  });
}

/** Root-test-only access to the current full Store adapter. */
export function createStateStorageForTest<Event = unknown, State = unknown>(
  input: Parameters<typeof createSqliteRuntimeStorage<Event, State>>[0],
): RuntimeStorage<Event, State> {
  return createSqliteRuntimeStorage<Event, State>(input);
}

/** Resolve the current Store sidecar path for a test checkpoint path. */
export function stateStorePathForTest(checkpointPath: string): string {
  return sqliteRuntimeStorePath(checkpointPath);
}

export interface StateStoreTestOptions {
  readonly sessionId?: string;
  readonly options?: SqliteRuntimeStorageOptions;
  readonly bootstrapMissingSessions?: boolean;
}

/** Root-test projection retained only for fixture ergonomics; production uses nested ports. */
export interface TestRuntimeStore<Event = unknown, State = unknown>
  extends RuntimeStorageBoundary,
    SessionStore<Event, State>,
    EffectLeasePort,
    CheckpointPort<State> {
  readonly sessions: SessionStore<Event, State>;
  readonly transactions: RuntimeHostTransactionPort<Event, State>;
  readonly effects: RuntimeHostLeasePort;
  readonly checkpoints: CheckpointPort<State>;
  readonly artifacts: ArtifactPort;
  readonly recoveryIdentities: RuntimeRecoveryIdentityPort;
  appendEventsAndSnapshot(
    sessionId: string,
    events: readonly Event[],
    nextState: State,
    metadata?: readonly RuntimeEventMetadata[],
    snapshotMetadata?: RuntimeSnapshotMetadata,
    expectedRestoreBoundary?: RuntimeRestoreBoundary,
    requiredEffectLease?: RuntimeEffectLeaseExpectation,
  ): void;
  close(): void;
}

/** Open the production State/Store adapter with root-test-only key custody. */
export function openStateStoreForTest(
  databasePath: string,
  input: StateStoreTestOptions = {},
): TestRuntimeStore<RuntimeEvent, AgentState> {
  const targetCodec: RuntimeSnapshotCodec<RuntimeEvent, AgentState> = Object.freeze({
    ...CURRENT_STORAGE_BINDING_.codec,
    encodeState: (state: AgentState) =>
      CURRENT_STORAGE_BINDING_.codec.encodeState(withTestStateProjectIdentity(state)),
    decodeState: <T = unknown>(json: string) =>
      withTestStateProjectIdentity(CURRENT_STORAGE_BINDING_.codec.decodeState<T>(json)),
    snapshotMetadata: (state: AgentState) =>
      CURRENT_STORAGE_BINDING_.codec.snapshotMetadata(withTestStateProjectIdentity(state)),
    sessionIdentity: (state: AgentState) =>
      CURRENT_STORAGE_BINDING_.codec.sessionIdentity!(withTestStateProjectIdentity(state)),
    recoveryIdentity: (state: AgentState) =>
      CURRENT_STORAGE_BINDING_.codec.recoveryIdentity!(withTestStateProjectIdentity(state)),
    validateSnapshot: (
      input: Parameters<NonNullable<typeof CURRENT_STORAGE_BINDING_.codec.validateSnapshot>>[0],
    ) =>
      CURRENT_STORAGE_BINDING_.codec.validateSnapshot!({
        ...input,
        state: withTestStateProjectIdentity(input.state),
      }),
    rebindForkState: (
      state: AgentState,
      targetSessionId: string,
      targetRecoveryIdentityKey: string,
    ) =>
      withTestStateProjectIdentity(
        CURRENT_STORAGE_BINDING_.codec.rebindForkState(
          withTestStateProjectIdentity(state),
          targetSessionId,
          targetRecoveryIdentityKey,
        ),
      ),
    canFork: (state: AgentState) =>
      CURRENT_STORAGE_BINDING_.codec.canFork!(withTestStateProjectIdentity(state)),
    isCurrentPendingInteractionRequest: (state: AgentState, event: RuntimeEvent) =>
      CURRENT_STORAGE_BINDING_.codec.isCurrentPendingInteractionRequest!(
        withTestStateProjectIdentity(state),
        event,
      ),
  });
  const storage = createSqliteRuntimeStorage<RuntimeEvent, AgentState>({
    databasePath,
    codec: targetCodec,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.options ? { options: input.options } : {}),
  });
  return createTestRuntimeStore(storage, input.bootstrapMissingSessions ?? false);
}

function createTestRuntimeStore<State>(
  storage: RuntimeStorage<RuntimeEvent, State>,
  bootstrapMissingSessions: boolean,
): TestRuntimeStore<RuntimeEvent, State> {
  let closed = false;
  const leaseOwners = new Map<string, string>();
  const transactions: RuntimeHostTransactionPort<RuntimeEvent, State> = Object.freeze({
    commit: (
      acknowledgement: 'decision' | 'attempt_start' | 'receipt_evidence' | 'terminal_recovery',
      input: RuntimeTransactionInput<RuntimeEvent, State>,
      requiredLease?: {
        readonly sessionId: string;
        readonly effectId: string;
        readonly ownerId: string;
      },
    ) => {
      const guardedInput = requiredLease
        ? {
            ...input,
            requiredEffectLease: {
              effectId: requiredLease.effectId,
              ownerId: requiredLease.ownerId,
              observedAtMs: Date.now(),
            },
          }
        : input;
      switch (acknowledgement) {
        case 'decision':
          storage.transactions.commitDecision(guardedInput);
          return;
        case 'attempt_start':
          storage.transactions.commitAttemptStart(guardedInput);
          return;
        case 'receipt_evidence':
          storage.transactions.commitReceiptEvidence(guardedInput);
          return;
        case 'terminal_recovery':
          storage.transactions.commitTerminalRecovery(guardedInput);
          return;
      }
    },
  });
  const effects: RuntimeHostLeasePort = Object.freeze({
    tryAcquire: (sessionId: string, effectId: string, ownerId: string, expiresAtMs: number) => {
      const acquired = storage.effects.tryAcquireEffectLease(
        sessionId,
        effectId,
        ownerId,
        expiresAtMs,
      );
      if (acquired) leaseOwners.set(`${sessionId}\u0000${effectId}`, ownerId);
      return acquired;
    },
    renew: (sessionId: string, effectId: string, ownerId: string, expiresAtMs: number) =>
      leaseOwners.get(`${sessionId}\u0000${effectId}`) === ownerId &&
      storage.effects.renewEffectLease(sessionId, effectId, ownerId, expiresAtMs),
    release: (sessionId: string, effectId: string, ownerId: string) => {
      storage.effects.releaseEffectLease(sessionId, effectId, ownerId);
      leaseOwners.delete(`${sessionId}\u0000${effectId}`);
    },
    hasClaim: (sessionId: string, effectId: string) =>
      leaseOwners.has(`${sessionId}\u0000${effectId}`),
  });
  const ensureTestSession = (sessionId: string): void => {
    if (!bootstrapMissingSessions || storage.sessions.loadSnapshot(sessionId)) return;
    const workspace = '/workspace';
    storage.sessions.saveSnapshot(
      sessionId,
      createRuntimeHostStateInitialState({
        threadId: sessionId,
        userId: 'root-test-user',
        workspace,
        ...testStateProjectIdentityForWorkspace(workspace),
        recoveryIdentityKey: createHash('sha256')
          .update(`root-test-recovery:${sessionId}`)
          .digest('hex'),
      }) as unknown as State,
    );
  };
  const stateAtEventPosition = (sessionId: string, state: State, eventPosition?: number): State => {
    if (!bootstrapMissingSessions || !state || typeof state !== 'object' || Array.isArray(state)) {
      return state;
    }
    return {
      ...(state as Readonly<Record<string, unknown>>),
      revision: eventPosition ?? storage.sessions.getLastEventPosition(sessionId),
    } as State;
  };
  return {
    adapterId: storage.adapterId,
    stateSchemaVersion: storage.stateSchemaVersion,
    storeSchemaVersion: storage.storeSchemaVersion,
    formatEpoch: storage.formatEpoch,
    sessions: storage.sessions,
    transactions,
    effects,
    checkpoints: storage.checkpoints,
    artifacts: storage.artifacts,
    recoveryIdentities: storage.recoveryIdentities,
    appendEvents: (threadId, events, metadata) => {
      if (events.length > 0) ensureTestSession(threadId);
      storage.sessions.appendEvents(threadId, events, metadata);
    },
    appendEventsAndSnapshot: (
      threadId,
      events,
      nextState,
      metadata,
      snapshotMetadata,
      expectedRestoreBoundary,
      requiredEffectLease,
    ) =>
      storage.transactions.commitDecision({
        sessionId: threadId,
        events,
        snapshot: nextState,
        ...(metadata ? { metadata } : {}),
        ...(snapshotMetadata ? { snapshotMetadata } : {}),
        ...(expectedRestoreBoundary ? { expectedRestoreBoundary } : {}),
        ...(requiredEffectLease ? { requiredEffectLease } : {}),
      }),
    loadEventsStrict: (threadId, since) => storage.sessions.loadEventsStrict(threadId, since),
    saveSnapshot: (threadId, state) =>
      storage.sessions.saveSnapshot(threadId, stateAtEventPosition(threadId, state)),
    loadSnapshot: <T = unknown>(threadId: string) => storage.sessions.loadSnapshot<T>(threadId),
    loadSnapshotRecord: <T = unknown>(threadId: string) =>
      storage.sessions.loadSnapshotRecord<T>(threadId),
    saveNamedSnapshot: (threadId, name, state, eventPosition) =>
      storage.checkpoints.saveNamedSnapshot(
        threadId,
        name,
        stateAtEventPosition(threadId, state, eventPosition),
        eventPosition,
      ),
    loadNamedSnapshot: <T = unknown>(threadId: string, name: string) =>
      storage.checkpoints.loadNamedSnapshot<T>(threadId, name),
    getLastEventPosition: (threadId) => storage.sessions.getLastEventPosition(threadId),
    listSessions: (query, limit) => storage.sessions.listSessions(query, limit),
    setSessionName: (threadId, name) => {
      ensureTestSession(threadId);
      storage.sessions.setSessionName(threadId, name);
    },
    getSessionModelRoute: (threadId) => storage.sessions.getSessionModelRoute(threadId),
    setSessionModelRoute: (threadId, route) => {
      ensureTestSession(threadId);
      storage.sessions.setSessionModelRoute(threadId, route);
    },
    deleteSession: (threadId) => storage.sessions.deleteSession(threadId),
    tryAcquireEffectLease: (threadId, effectId, ownerId, expiresAtMs) =>
      storage.effects.tryAcquireEffectLease(threadId, effectId, ownerId, expiresAtMs),
    renewEffectLease: (threadId, effectId, ownerId, expiresAtMs) =>
      storage.effects.renewEffectLease(threadId, effectId, ownerId, expiresAtMs),
    releaseEffectLease: (threadId, effectId, ownerId) =>
      storage.effects.releaseEffectLease(threadId, effectId, ownerId),
    listNamedSnapshots: (threadId) => storage.checkpoints.listNamedSnapshots(threadId),
    restoreNamedSnapshot: (threadId, snapshotId) =>
      storage.checkpoints.restoreNamedSnapshot(threadId, snapshotId),
    forkSession: (sourceThreadId, snapshotId, targetThreadId, targetRecoveryIdentityKey) =>
      targetRecoveryIdentityKey !== undefined &&
      storage.checkpoints.forkSession(
        sourceThreadId,
        snapshotId,
        targetThreadId,
        targetRecoveryIdentityKey,
      ),
    forkCurrentSession: (sourceThreadId, targetThreadId, targetRecoveryIdentityKey) =>
      targetRecoveryIdentityKey !== undefined &&
      storage.checkpoints.forkCurrentSession(
        sourceThreadId,
        targetThreadId,
        targetRecoveryIdentityKey,
      ),
    getNamedSnapshotEntry: (threadId, snapshotId) =>
      storage.checkpoints.getNamedSnapshotEntry(threadId, snapshotId),
    recordFilePreimage: (threadId, path, content, existed) =>
      storage.checkpoints.recordFilePreimage(threadId, path, content, existed),
    recordFilePostimage: (threadId, path, contentHash, existed) =>
      storage.checkpoints.recordFilePostimage(threadId, path, contentHash, existed),
    fileRestorePlan: (threadId, eventPosition) =>
      storage.checkpoints.fileRestorePlan(threadId, eventPosition),
    close: () => {
      if (closed) return;
      closed = true;
      storage.close();
    },
  };
}
