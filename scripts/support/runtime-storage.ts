/** Root-only composition of the current Host State codec and SQLite Store. */

import { createHash } from 'node:crypto';
import type { AgentState, RuntimeEvent } from '@kite/agent-kernel';
import {
  createRuntimeHostStateInitialState,
  createRuntimeHostStateStorageBinding,
} from '@kite/runtime-host';
import type {
  RuntimeSessionStoragePort,
  RuntimeSnapshotCodec,
  RuntimeStorage,
} from '@kite/runtime-host/storage';
import {
  createSqliteRuntimeStorage,
  type SqliteRuntimeStorageOptions,
  sqliteRuntimeStorePath,
} from '@kite/runtime-storage-sqlite';

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

/** Open the production State/Store adapter with root-test-only key custody. */
export function openStateStoreForTest(
  databasePath: string,
  input: StateStoreTestOptions = {},
): RuntimeSessionStoragePort<RuntimeEvent, unknown> {
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
  return createFlatRuntimeStoreView(
    storage as RuntimeStorage<RuntimeEvent, unknown>,
    input.bootstrapMissingSessions ?? false,
  );
}

function createFlatRuntimeStoreView(
  storage: RuntimeStorage<RuntimeEvent, unknown>,
  bootstrapMissingSessions: boolean,
): RuntimeSessionStoragePort<RuntimeEvent, unknown> {
  let closed = false;
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
      }),
    );
  };
  const stateAtEventPosition = (
    sessionId: string,
    state: unknown,
    eventPosition?: number,
  ): unknown => {
    if (!bootstrapMissingSessions || !state || typeof state !== 'object' || Array.isArray(state)) {
      return state;
    }
    return {
      ...(state as Readonly<Record<string, unknown>>),
      revision: eventPosition ?? storage.sessions.getLastEventPosition(sessionId),
    };
  };
  return {
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
