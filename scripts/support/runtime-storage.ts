/**
 * Root-only Store 4 composition for tests and fixtures.
 *
 * This module is deliberately outside every production package. It wires the
 * one Host State25 codec to the one SQLite Store 4 adapter and exposes the
 * temporary flat view still consumed by root test seams. The
 * view owns no database and contains no persistence, codec, receipt, or fork
 * implementation of its own.
 */

import type { RuntimeEvent } from '@kite/agent-kernel';
import { assertCurrentRuntimeEvent } from '@kite/agent-kernel';
import { createRuntimeHostState25StorageBindingV1 } from '@kite/runtime-host';
import type {
  RuntimeSessionStoragePortV1,
  RuntimeSnapshotCodecV1,
  RuntimeStorage,
} from '@kite/runtime-host/storage';
import {
  createSqliteRuntimeStorage,
  type SqliteRuntimeStorageOptionsV1,
  sqliteRuntimeStorePathForV1,
} from '@kite/runtime-storage-sqlite';

const STATE25_STORAGE_BINDING_V1 = createRuntimeHostState25StorageBindingV1();
const STATE25_CODEC = createState25CodecForTestV1(STATE25_STORAGE_BINDING_V1.codec);

/** Bind an opaque Host codec only when its complete State25 contract is present. */
export function createState25CodecForTestV1(
  codec: RuntimeSnapshotCodecV1<unknown, unknown>,
): RuntimeSnapshotCodecV1<RuntimeEvent, unknown> {
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
    throw new Error('State25 test storage requires the complete Host codec contract.');
  }
  return Object.freeze({
    encodeEvent: (event: RuntimeEvent) => codec.encodeEvent(event),
    decodeEvent: (json: string): RuntimeEvent => {
      const event = codec.decodeEvent(json);
      assertState25RuntimeEvent(event);
      return event;
    },
    encodeState: (state: unknown) => codec.encodeState(state),
    decodeState: <T = unknown>(json: string) => codec.decodeState<T>(json),
    eventSummary: (event: RuntimeEvent) => eventSummary(event),
    snapshotMetadata: (state: unknown) => codec.snapshotMetadata(state),
    recoveryIdentity: (state: unknown) => recoveryIdentity(state),
    validateSnapshot: (input: Parameters<typeof validateSnapshot>[0]) => validateSnapshot(input),
    rebindForkState: (state: unknown, targetSessionId: string, targetRecoveryIdentityKey: string) =>
      codec.rebindForkState(state, targetSessionId, targetRecoveryIdentityKey),
    canFork: (state: unknown) => canFork(state),
    isCurrentPendingInteractionRequest: (state: unknown, event: RuntimeEvent) =>
      isCurrentPendingInteractionRequest(state, event),
  });
}

function assertState25RuntimeEvent(value: unknown): asserts value is RuntimeEvent {
  assertCurrentRuntimeEvent(value);
}

/** Resolve the Store 4 sidecar path for a test checkpoint path. */
export function state25Store4PathForTestV1(checkpointPath: string): string {
  return sqliteRuntimeStorePathForV1(checkpointPath);
}

export interface State25Store4TestOptionsV1 {
  readonly sessionId?: string;
  readonly options?: SqliteRuntimeStorageOptionsV1;
}

/**
 * Open one State25/Store4 adapter for a root test or fixture.
 *
 * The returned flat view is only a compatibility projection. The SQLite
 * adapter is the sole owner and is closed exactly once by the view.
 */
export function openState25Store4ForTestV1(
  databasePath: string,
  input: State25Store4TestOptionsV1 = {},
): RuntimeSessionStoragePortV1<RuntimeEvent, unknown> {
  const storage = createSqliteRuntimeStorage<RuntimeEvent, unknown>({
    databasePath,
    codec: STATE25_CODEC,
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
