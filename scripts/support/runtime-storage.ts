/**
 * Root-only Store 4 composition for tests and fixtures.
 *
 * This module is deliberately outside every production package. It wires the
 * one Host State26 codec to the one SQLite Store 4 adapter and exposes the
 * temporary flat view still consumed by root test seams. The
 * view owns no database and contains no persistence, codec, receipt, or fork
 * implementation of its own.
 */

import { createHash } from 'node:crypto';
import type { AgentState, RuntimeEvent } from '@kite/agent-kernel';
import { assertCurrentRuntimeEvent } from '@kite/agent-kernel';
import {
  createRuntimeHostState26StorageBindingV1,
  createRuntimePersistedAuthorityCodecV1,
} from '@kite/runtime-host';
import type {
  RuntimeSessionStoragePortV1,
  RuntimeSnapshotCodecV1,
  RuntimeStorage,
} from '@kite/runtime-host/storage';
import {
  createSqliteRuntimeStorageV5,
  type SqliteRuntimeStorageOptionsV1,
  sqliteRuntimeStorePathForV2,
} from '@kite/runtime-storage-sqlite';
import {
  assertSqliteRuntimeStorageCanOpen,
  createSqliteRuntimeStorage,
  sqliteRuntimeStorePathForV1,
} from '../../packages/runtime-storage-sqlite/src/sqlite-store';

const STATE25_STORAGE_BINDING_V1 = createRuntimeHostState26StorageBindingV1();
const STATE25_CODEC = createState25CodecForTestV1(STATE25_STORAGE_BINDING_V1.codec);
const LEGACY_STATE25_SCHEMA_VERSION_V1 = 25;
const LEGACY_STATE25_FORMAT_EPOCH_V1 = 'kite-runtime-2026-08-18';

/**
 * Give root-only State26 fixtures a deterministic Project identity.
 *
 * Production never calls this helper: App composition must use a Host-issued
 * ProjectHandle. The projection only keeps old root fixtures honest while
 * they exercise the real Store5 codec, DDL, authenticity, and reopen rules.
 */
export function withTestState26ProjectIdentityV1<State>(state: State): State {
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
  const identity = testState26ProjectIdentityForWorkspaceV1(workspace);
  return {
    ...record,
    session: {
      ...sessionRecord,
      ...identity,
    },
  } as State;
}

export function testState26ProjectIdentityForWorkspaceV1(workspace: string): {
  readonly projectId: string;
  readonly canonicalWorkspaceDigest: `sha256:${string}`;
} {
  const digest = createHash('sha256').update(workspace).digest('hex');
  return Object.freeze({
    projectId: 'project_test_runtime_agent',
    canonicalWorkspaceDigest: `sha256:${digest}`,
  });
}

/** Bind an opaque Host codec only when its complete State26 contract is present. */
export function createState25CodecForTestV1<State = unknown>(
  codec: RuntimeSnapshotCodecV1<unknown, State>,
): RuntimeSnapshotCodecV1<RuntimeEvent, State> {
  const eventSummary = codec.eventSummary;
  const recoveryIdentity = codec.recoveryIdentity;
  const validateSnapshot = codec.validateSnapshot;
  const canFork = codec.canFork;
  const isCurrentPendingInteractionRequest = codec.isCurrentPendingInteractionRequest;
  if (
    !eventSummary ||
    !recoveryIdentity ||
    !validateSnapshot ||
    !canFork ||
    !isCurrentPendingInteractionRequest
  ) {
    throw new Error('State26 test storage requires the complete Host codec contract.');
  }
  return Object.freeze({
    encodeEvent: (event: RuntimeEvent) => codec.encodeEvent(event),
    decodeEvent: (json: string): RuntimeEvent => {
      const event = codec.decodeEvent(json);
      assertState26RuntimeEvent(event);
      return event;
    },
    encodeState: (state: State) =>
      JSON.stringify(
        projectTestStateFormatV1(
          JSON.parse(codec.encodeState(state)) as Readonly<Record<string, unknown>>,
          LEGACY_STATE25_SCHEMA_VERSION_V1,
          LEGACY_STATE25_FORMAT_EPOCH_V1,
        ),
      ),
    decodeState: <T = State>(json: string) => {
      const parsed = JSON.parse(json) as Readonly<Record<string, unknown>>;
      return codec.decodeState<T>(
        JSON.stringify(
          projectTestStateFormatV1(parsed, 26, 'kite-runtime-modularization-v1-2026-08-19'),
        ),
      );
    },
    eventSummary: (event: RuntimeEvent) => eventSummary(event),
    snapshotMetadata: (state: State) => ({
      ...codec.snapshotMetadata(state),
      schemaVersion: LEGACY_STATE25_SCHEMA_VERSION_V1,
    }),
    recoveryIdentity: (state: State) => recoveryIdentity(state),
    validateSnapshot: (input: Parameters<typeof validateSnapshot>[0]) =>
      validateSnapshot({ ...input, schemaVersion: 26 }),
    rebindForkState: (state: State, targetSessionId: string, targetRecoveryIdentityKey: string) =>
      codec.rebindForkState(state, targetSessionId, targetRecoveryIdentityKey),
    canFork: (state: State) => canFork(state),
    isCurrentPendingInteractionRequest: (state: State, event: RuntimeEvent) =>
      isCurrentPendingInteractionRequest(state, event),
  });
}

function projectTestStateFormatV1(
  state: Readonly<Record<string, unknown>>,
  schemaVersion: number,
  formatEpoch: string,
): Readonly<Record<string, unknown>> {
  return { ...state, schemaVersion, formatEpoch };
}

function assertState26RuntimeEvent(value: unknown): asserts value is RuntimeEvent {
  assertCurrentRuntimeEvent(value);
}

/** Resolve the Store 4 sidecar path for a test checkpoint path. */
export function state25Store4PathForTestV1(checkpointPath: string): string {
  return sqliteRuntimeStorePathForV1(checkpointPath);
}

export const assertState25Store4CanOpenForTestV1 = assertSqliteRuntimeStorageCanOpen;

/** Root-test-only access to the retired full Store4 adapter. */
export function createState25Store4StorageForTestV1<Event = unknown, State = unknown>(
  input: Parameters<typeof createSqliteRuntimeStorage<Event, State>>[0],
): RuntimeStorage<Event, State> {
  return createSqliteRuntimeStorage<Event, State>(input);
}

/** Resolve the current Store5 sidecar path for a test checkpoint path. */
export function state26Store5PathForTestV1(checkpointPath: string): string {
  return sqliteRuntimeStorePathForV2(checkpointPath);
}

export interface State25Store4TestOptionsV1 {
  readonly sessionId?: string;
  readonly options?: SqliteRuntimeStorageOptionsV1;
}

/**
 * Open one State26/Store4 adapter for a root test or fixture.
 *
 * The returned flat view is only a compatibility projection. The SQLite
 * adapter is the sole owner and is closed exactly once by the view.
 */
export function openState25Store4ForTestV1(
  databasePath: string,
  input: State25Store4TestOptionsV1 = {},
): RuntimeSessionStoragePortV1<RuntimeEvent, unknown> {
  const storage = createState25Store4StorageForTestV1<RuntimeEvent, unknown>({
    databasePath,
    codec: STATE25_CODEC,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.options ? { options: input.options } : {}),
    uniqueReceiptForEvent: STATE25_STORAGE_BINDING_V1.uniqueReceiptForEvent,
  });
  return createFlatRuntimeStoreView(storage);
}

/** Open the production State26/Store5 adapter with root-test-only key custody. */
export function openState26Store5ForTestV1(
  databasePath: string,
  input: State25Store4TestOptionsV1 = {},
): RuntimeSessionStoragePortV1<RuntimeEvent, AgentState> {
  const targetCodec: RuntimeSnapshotCodecV1<RuntimeEvent, AgentState> = Object.freeze({
    ...STATE25_STORAGE_BINDING_V1.codec,
    encodeState: (state: AgentState) =>
      STATE25_STORAGE_BINDING_V1.codec.encodeState(withTestState26ProjectIdentityV1(state)),
    decodeState: <T = unknown>(json: string) =>
      withTestState26ProjectIdentityV1(STATE25_STORAGE_BINDING_V1.codec.decodeState<T>(json)),
    snapshotMetadata: (state: AgentState) =>
      STATE25_STORAGE_BINDING_V1.codec.snapshotMetadata(withTestState26ProjectIdentityV1(state)),
    sessionIdentity: (state: AgentState) =>
      STATE25_STORAGE_BINDING_V1.codec.sessionIdentity!(withTestState26ProjectIdentityV1(state)),
    recoveryIdentity: (state: AgentState) =>
      STATE25_STORAGE_BINDING_V1.codec.recoveryIdentity!(withTestState26ProjectIdentityV1(state)),
    validateSnapshot: (
      input: Parameters<NonNullable<typeof STATE25_STORAGE_BINDING_V1.codec.validateSnapshot>>[0],
    ) =>
      STATE25_STORAGE_BINDING_V1.codec.validateSnapshot!({
        ...input,
        state: withTestState26ProjectIdentityV1(input.state),
      }),
    rebindForkState: (
      state: AgentState,
      targetSessionId: string,
      targetRecoveryIdentityKey: string,
    ) =>
      withTestState26ProjectIdentityV1(
        STATE25_STORAGE_BINDING_V1.codec.rebindForkState(
          withTestState26ProjectIdentityV1(state),
          targetSessionId,
          targetRecoveryIdentityKey,
        ),
      ),
    canFork: (state: AgentState) =>
      STATE25_STORAGE_BINDING_V1.codec.canFork!(withTestState26ProjectIdentityV1(state)),
    isCurrentPendingInteractionRequest: (state: AgentState, event: RuntimeEvent) =>
      STATE25_STORAGE_BINDING_V1.codec.isCurrentPendingInteractionRequest!(
        withTestState26ProjectIdentityV1(state),
        event,
      ),
  });
  const storage = createSqliteRuntimeStorageV5<RuntimeEvent, AgentState>({
    databasePath,
    codec: targetCodec,
    persistedAuthority: createRuntimePersistedAuthorityCodecV1({
      issuer: 'kite-root-test-runtime-host',
      currentKey: {
        keyId: 'kite-root-test-store5-key-v1',
        key: new Uint8Array(32).fill(0x5a),
      },
    }),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.options ? { options: input.options } : {}),
    uniqueReceiptForEvent: STATE25_STORAGE_BINDING_V1.uniqueReceiptForEvent,
  });
  return createFlatRuntimeStoreView(storage);
}

function createFlatRuntimeStoreView(
  storage: RuntimeStorage<RuntimeEvent, unknown>,
): RuntimeSessionStoragePortV1<RuntimeEvent, unknown> {
  let closed = false;
  return {
    appendEvents: (threadId, events, metadata) =>
      storage.sessions.appendEvents(threadId, events, metadata),
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
    saveSnapshot: (threadId, state) => storage.sessions.saveSnapshot(threadId, state),
    loadSnapshot: <T = unknown>(threadId: string) => storage.sessions.loadSnapshot<T>(threadId),
    loadSnapshotRecord: <T = unknown>(threadId: string) =>
      storage.sessions.loadSnapshotRecord<T>(threadId),
    saveNamedSnapshot: (threadId, name, state, eventPosition) =>
      storage.checkpoints.saveNamedSnapshot(threadId, name, state, eventPosition),
    loadNamedSnapshot: <T = unknown>(threadId: string, name: string) =>
      storage.checkpoints.loadNamedSnapshot<T>(threadId, name),
    getLastEventPosition: (threadId) => storage.sessions.getLastEventPosition(threadId),
    listSessions: (query, limit) => storage.sessions.listSessions(query, limit),
    setSessionName: (threadId, name) => storage.sessions.setSessionName(threadId, name),
    getSessionModelRoute: (threadId) => storage.sessions.getSessionModelRoute(threadId),
    setSessionModelRoute: (threadId, route) =>
      storage.sessions.setSessionModelRoute(threadId, route),
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
