import { describe, expect, test } from 'bun:test';
import { type AgentState, createInitialAgentState, type KernelEvent } from '@kite-ai/agent-kernel';
import {
  type RuntimeHostExecutionServices,
  restoreRuntimeHostStateSession,
} from '@kite-ai/runtime-host';
import type {
  CheckpointPort,
  RuntimeSnapshotMetadata,
  SessionStore,
  StoredRuntimeEvent,
} from '@kite-ai/runtime-host/storage';

const RECOVERY_KEY = 'a'.repeat(64);
const SNAPSHOT_METADATA: RuntimeSnapshotMetadata = {
  eventPosition: 0,
  stateRevision: 0,
  stateChecksum: 'checksum',
  schemaVersion: 27,
};

function state(overrides: Partial<AgentState> = {}): AgentState {
  return {
    ...createInitialAgentState({
      threadId: 'session-1',
      userId: 'user-1',
      workspace: '/workspace',
      turnId: 'turn-1',
      recoveryIdentityKey: RECOVERY_KEY,
    }),
    ...overrides,
  };
}

function services(
  input: {
    readonly snapshot?: { readonly state: unknown; readonly metadata: RuntimeSnapshotMetadata };
    readonly lastEventPosition?: number;
    readonly tail?: readonly StoredRuntimeEvent<KernelEvent>[];
  } = {},
): RuntimeHostExecutionServices<KernelEvent, AgentState> {
  const sessions: SessionStore<KernelEvent, AgentState> = {
    appendEvents: () => undefined,
    loadEventsStrict: () => [...(input.tail ?? [])],
    saveSnapshot: () => undefined,
    loadSnapshot: () => null,
    loadSnapshotRecord: <T = AgentState>() =>
      input.snapshot
        ? { state: input.snapshot.state as T, metadata: input.snapshot.metadata }
        : null,
    getLastEventPosition: () => input.lastEventPosition ?? 0,
    listSessions: () => [],
    setSessionName: () => undefined,
    getSessionModelRoute: () => null,
    setSessionModelRoute: () => undefined,
    deleteSession: () => undefined,
  };
  return {
    sessions,
    transactions: { commit: () => undefined },
    leases: {
      tryAcquire: () => true,
      renew: () => true,
      release: () => undefined,
      hasClaim: () => true,
    },
    checkpoints: checkpointPort(),
    recoveryIdentities: {
      read: () => RECOVERY_KEY,
      getOrCreate: () => RECOVERY_KEY,
      remove: () => undefined,
    },
  };
}

function checkpointPort(): CheckpointPort<AgentState> {
  return {
    saveNamedSnapshot: () => undefined,
    loadNamedSnapshot: () => null,
    listNamedSnapshots: () => [],
    getNamedSnapshotEntry: () => null,
    restoreNamedSnapshot: () => false,
    forkSession: () => false,
    forkCurrentSession: () => false,
    recordFilePreimage: () => undefined,
    recordFilePostimage: () => undefined,
    fileRestorePlan: () => [],
  };
}

function restore(
  runtimeServices: RuntimeHostExecutionServices<KernelEvent, AgentState>,
  extra: Partial<
    Pick<Parameters<typeof restoreRuntimeHostStateSession>[0], 'validateRestoredState'>
  > = {},
) {
  return restoreRuntimeHostStateSession({
    sessions: runtimeServices.sessions,
    sessionId: 'session-1',
    userId: 'user-1',
    workspace: '/workspace',
    turnId: 'fresh-turn',
    recoveryIdentityKey: RECOVERY_KEY,
    ...extra,
  });
}

describe('Runtime Host State restore', () => {
  test('creates only the exact fresh State format when storage is empty', () => {
    const result = restore(services());
    expect(result.source).toBe('fresh');
    expect(result.state.schemaVersion).toBe(27);
    expect(result.state.formatEpoch).toBe('kite-runtime-saq-v1-2026-08-25');
    expect(result.state.turn.turnId).toBe('fresh-turn');
    expect(result.restoreBoundary).toEqual({ snapshot: null, lastEventPosition: 0 });
  });

  test('fails closed for events without snapshot and incompatible format', () => {
    const missing = restore(services({ lastEventPosition: 1 }));
    expect(missing.source).toBe('corrupted');
    expect(missing.state.recoveryState.kind).toBe('corrupted');

    const incompatible = restore(
      services({
        snapshot: {
          state: { ...state(), schemaVersion: 26, formatEpoch: 'future' },
          metadata: { ...SNAPSHOT_METADATA, schemaVersion: 26 },
        },
      }),
    );
    expect(incompatible.source).toBe('incompatible');
    expect(incompatible.state.recoveryState.kind).toBe('incompatible');
  });

  test('replays a strict tail and retains exact revision identity', () => {
    const result = restore(
      services({
        snapshot: { state: state(), metadata: SNAPSHOT_METADATA },
        lastEventPosition: 1,
        tail: [
          {
            id: 1,
            thread_id: 'session-1',
            event: {
              type: 'task.started',
              taskId: 'task-1',
              userGoal: 'Task',
              turnId: 'turn-1',
            },
            created_at: 0,
            event_id: 'event-1',
            revision: 1,
            occurred_at: '2026-08-21T00:00:00.000Z',
          },
        ],
      }),
    );
    expect(result.source).toBe('restored');
    expect(result.state.revision).toBe(1);
    expect(result.state.lastAppliedEventId).toBe('event-1');
    expect(result.state.activeTaskId).toBe('task-1');
  });

  test('rejects recovery identity, metadata, and tail revision drift as corrupted', () => {
    const wrongIdentity = state({
      toolRecovery: { ...state().toolRecovery, identityKey: 'b'.repeat(64) },
    });
    expect(
      restore(services({ snapshot: { state: wrongIdentity, metadata: SNAPSHOT_METADATA } })).source,
    ).toBe('corrupted');

    expect(
      restore(
        services({
          snapshot: {
            state: state(),
            metadata: { ...SNAPSHOT_METADATA, stateRevision: 1 },
          },
        }),
      ).source,
    ).toBe('corrupted');

    expect(
      restore(
        services({
          snapshot: { state: state(), metadata: SNAPSHOT_METADATA },
          lastEventPosition: 1,
          tail: [
            {
              id: 1,
              thread_id: 'session-1',
              event: {
                type: 'task.started',
                taskId: 'task-1',
                userGoal: 'Task',
                turnId: 'turn-1',
              },
              created_at: 0,
              event_id: 'event-1',
              revision: 2,
              occurred_at: '2026-08-21T00:00:00.000Z',
            },
          ],
        }),
      ).source,
    ).toBe('corrupted');
  });

  test('runs composed evidence validation without giving Host artifact semantics', () => {
    let calls = 0;
    const result = restore(
      services({ snapshot: { state: state(), metadata: SNAPSHOT_METADATA } }),
      {
        validateRestoredState: () => {
          calls += 1;
          throw new Error('artifact evidence mismatch');
        },
      },
    );
    expect(calls).toBe(1);
    expect(result.source).toBe('corrupted');
    expect(result.state.recoveryState).toEqual({
      kind: 'corrupted',
      reason: 'artifact evidence mismatch',
    });
  });
});
