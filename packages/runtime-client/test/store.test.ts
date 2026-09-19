import { describe, expect, test } from 'bun:test';
import type { RuntimeNotification, RuntimeSessionProjection } from '@kite-ai/runtime-contract';
import { RuntimeSnapshotStore } from '../src/store';

describe('Runtime Snapshot Store', () => {
  test('retains background work for non-selected sessions and fences stale generations', () => {
    const store = new RuntimeSnapshotStore();
    store.setConnection({ generation: 1, status: 'active', serverInstanceId: 'server-1' });
    expect(
      store.applyBackgroundSnapshot({
        connectionGeneration: 1,
        snapshot: background('other-session', 'owner-1', 2, 'running'),
      }),
    ).toBe('applied');
    expect(store.getSnapshot().background['other-session']).toMatchObject({
      stale: false,
      snapshot: { watermark: 2, executions: [{ status: 'running' }] },
    });

    store.setConnection({ generation: 1, status: 'reconnecting' });
    expect(store.getSnapshot().background['other-session']?.stale).toBeTrue();
    store.setConnection({ generation: 2, status: 'active', serverInstanceId: 'server-1' });
    expect(store.getSnapshot().background['other-session']).toMatchObject({
      stale: true,
      snapshot: { executions: [{ status: 'running' }] },
    });
    store.setConnection({ generation: 3, status: 'active', serverInstanceId: 'server-2' });
    expect(store.getSnapshot().background['other-session']).toMatchObject({
      stale: true,
      snapshot: { executions: [{ status: 'unavailable', cleanupConfirmed: false }] },
    });
    expect(
      store.applyBackgroundSnapshot({
        connectionGeneration: 2,
        snapshot: background('other-session', 'owner-1', 3, 'completed'),
      }),
    ).toBe('ignored');
  });

  test('ignores lower background watermarks and never reverses terminal work', () => {
    const store = new RuntimeSnapshotStore();
    store.setConnection({ generation: 1, status: 'active' });
    store.applyBackgroundSnapshot({
      connectionGeneration: 1,
      snapshot: background('session-1', 'owner-1', 5, 'completed'),
    });
    expect(
      store.applyBackgroundSnapshot({
        connectionGeneration: 1,
        snapshot: background('session-1', 'owner-1', 4, 'running'),
      }),
    ).toBe('ignored');
    expect(
      store.applyBackgroundSnapshot({
        connectionGeneration: 1,
        snapshot: background('session-1', 'owner-1', 5, 'running'),
      }),
    ).toBe('ignored');
    expect(
      store.applyBackgroundSnapshot({
        connectionGeneration: 1,
        snapshot: background('session-1', 'owner-1', 6, 'running'),
      }),
    ).toBe('applied');
    expect(store.getSnapshot().background['session-1']?.snapshot.executions[0]?.status).toBe(
      'completed',
    );
    expect(
      store.applyBackgroundExecution({
        connectionGeneration: 1,
        execution: {
          ...background('session-1', 'owner-1', 7, 'completed').executions[0]!,
          revision: 7,
        },
      }),
    ).toBe('applied');
    expect(store.getSnapshot().background['session-1']?.snapshot.watermark).toBe(6);
  });
  test('orders detail refinements by item authority instead of aggregate watermark', () => {
    const store = new RuntimeSnapshotStore();
    store.setConnection({ generation: 1, status: 'active' });
    const aggregate = background('session-1', 'aggregate-owner', 50, 'running');
    store.applyBackgroundSnapshot({
      connectionGeneration: 1,
      snapshot: {
        ...aggregate,
        executions: [{ ...aggregate.executions[0]!, revision: 1 }],
      },
    });

    const listed = store.getSnapshot().background['session-1']!.snapshot.executions[0]!;
    expect(
      store.applyBackgroundExecution({
        connectionGeneration: 1,
        execution: { ...listed, revision: 2, status: 'completed' },
      }),
    ).toBe('applied');
    expect(store.getSnapshot().background['session-1']?.snapshot).toMatchObject({
      watermark: 50,
      executions: [{ ownerGeneration: listed.ownerGeneration, revision: 2, status: 'completed' }],
    });

    expect(
      store.applyBackgroundSnapshot({
        connectionGeneration: 1,
        snapshot: {
          ...aggregate,
          sessionRevision: 151,
          executions: [{ ...aggregate.executions[0]!, revision: 1, status: 'running' }],
        },
      }),
    ).toBe('applied');
    expect(store.getSnapshot().background['session-1']?.snapshot).toMatchObject({
      sessionRevision: 151,
      watermark: 50,
      executions: [{ sessionRevision: 151, revision: 2, status: 'completed' }],
    });

    expect(
      store.applyBackgroundExecution({
        connectionGeneration: 1,
        execution: { ...listed, sessionRevision: 152, revision: 2, status: 'running' },
      }),
    ).toBe('applied');
    expect(store.getSnapshot().background['session-1']?.snapshot).toMatchObject({
      sessionRevision: 152,
      executions: [{ sessionRevision: 152, revision: 2, status: 'completed' }],
    });

    expect(
      store.applyBackgroundExecution({
        connectionGeneration: 1,
        execution: { ...listed, revision: 1, status: 'running' },
      }),
    ).toBe('ignored');
    expect(store.getSnapshot().background['session-1']?.snapshot.executions[0]).toMatchObject({
      ownerGeneration: listed.ownerGeneration,
      revision: 2,
      status: 'completed',
    });
  });
  test('merges list and detail through one aggregate owner without dropping siblings', () => {
    const store = new RuntimeSnapshotStore();
    store.setConnection({ generation: 4, status: 'active', serverInstanceId: 'server-1' });
    const listed = background('session-1', 'aggregate-1', 5, 'running');
    store.applyBackgroundSnapshot({
      connectionGeneration: 4,
      snapshot: {
        ...listed,
        executions: [
          listed.executions[0]!,
          { ...listed.executions[0]!, executionId: 'task-2', kind: 'subagent' },
        ],
      },
    });
    expect(
      store.applyBackgroundExecution({
        connectionGeneration: 4,
        execution: { ...listed.executions[0]!, status: 'completed', revision: 6 },
      }),
    ).toBe('applied');
    expect(
      store
        .getSnapshot()
        .background['session-1']?.snapshot.executions.map((execution) => execution.executionId),
    ).toEqual(['task-2', 'shell-1']);
    expect(
      store.applyBackgroundExecution({
        connectionGeneration: 4,
        execution: { ...listed.executions[0]!, ownerGeneration: 'native-shell-owner', revision: 8 },
      }),
    ).toBe('ignored');
    expect(store.getSnapshot().background['session-1']?.snapshot.executions).toHaveLength(2);
    expect(
      store
        .getSnapshot()
        .background['session-1']?.snapshot.executions.find(
          (execution) => execution.executionId === 'shell-1',
        )?.ownerGeneration,
    ).toBe(listed.executions[0]!.ownerGeneration);
    expect(
      store.applyBackgroundSnapshot({
        connectionGeneration: 3,
        snapshot: background('session-1', 'aggregate-old', 99, 'running'),
      }),
    ).toBe('ignored');

    const detailOnly = new RuntimeSnapshotStore();
    detailOnly.setConnection({ generation: 1, status: 'active' });
    expect(
      detailOnly.applyBackgroundExecution({
        connectionGeneration: 1,
        execution: { ...listed.executions[0]!, status: 'completed', revision: 6 },
      }),
    ).toBe('ignored');
    expect(detailOnly.getSnapshot().background).toEqual({});
  });
  test('atomically replaces an index and removes stale sessions at reset end', () => {
    const store = new RuntimeSnapshotStore();
    store.setConnection({ generation: 1, status: 'active', serverInstanceId: 'server-old' });
    store.beginIndexReset({
      connectionGeneration: 1,
      subscriptionGeneration: 1,
      serverInstanceId: 'server-old',
      indexRevision: 1,
    });
    store.applyIndexSession({
      connectionGeneration: 1,
      subscriptionGeneration: 1,
      indexRevision: 1,
      session: projection('stale', 1),
    });
    store.endIndexReset({ connectionGeneration: 1, subscriptionGeneration: 1, indexRevision: 1 });

    store.beginIndexReset({
      connectionGeneration: 1,
      subscriptionGeneration: 2,
      serverInstanceId: 'server-new',
      indexRevision: 2,
    });
    store.applyIndexSession({
      connectionGeneration: 1,
      subscriptionGeneration: 2,
      indexRevision: 2,
      session: projection('current', 3),
    });
    expect(store.getSnapshot().sessions.stale).toBeDefined();
    store.endIndexReset({ connectionGeneration: 1, subscriptionGeneration: 2, indexRevision: 2 });

    expect(Object.keys(store.getSnapshot().sessions)).toEqual(['current']);
    expect(store.getSnapshot().serverInstanceId).toBe('server-new');
  });

  test('ignores a stale connection and fails closed on same-revision divergence', () => {
    const store = new RuntimeSnapshotStore();
    store.setConnection({ generation: 2, status: 'active' });
    expect(
      store.applySessionNotification({
        connectionGeneration: 1,
        subscriptionGeneration: 1,
        notification: durable(projection('session-1', 1)),
      }),
    ).toBe('ignored');
    expect(
      store.applySessionNotification({
        connectionGeneration: 2,
        subscriptionGeneration: 1,
        notification: durable(projection('session-1', 1, 'first')),
        reset: true,
      }),
    ).toBe('applied');
    expect(
      store.applySessionNotification({
        connectionGeneration: 2,
        subscriptionGeneration: 1,
        notification: durable(projection('session-1', 1, 'different')),
      }),
    ).toBe('resync_required');
    expect(store.getSnapshot().sessions['session-1']?.historyResyncRequired).toBeTrue();
  });

  test('accepts older parallel subscription deltas without allowing stale resets or connections', () => {
    const store = new RuntimeSnapshotStore();
    store.setConnection({ generation: 1, status: 'active' });
    expect(
      store.applySessionNotification({
        connectionGeneration: 1,
        subscriptionGeneration: 2,
        notification: durable(projection('session-1', 0)),
        reset: true,
      }),
    ).toBe('applied');
    expect(
      store.applySessionNotification({
        connectionGeneration: 1,
        subscriptionGeneration: 1,
        notification: durable(projection('session-1', 1)),
        ready: true,
      }),
    ).toBe('applied');
    expect(store.getSnapshot().sessions['session-1']).toMatchObject({
      projection: { revision: 1 },
      subscriptionGeneration: 2,
    });
    expect(
      store.applySessionNotification({
        connectionGeneration: 1,
        subscriptionGeneration: 1,
        notification: durable(projection('session-1', 0)),
        reset: true,
      }),
    ).toBe('ignored');
    expect(
      store.applySessionNotification({
        connectionGeneration: 0,
        subscriptionGeneration: 3,
        notification: durable(projection('session-1', 2)),
      }),
    ).toBe('ignored');
    expect(store.getSnapshot().sessions['session-1']?.projection.revision).toBe(1);
  });

  test('accepts same-revision lifecycle and model enrichment but rejects stable-field divergence', () => {
    const store = new RuntimeSnapshotStore();
    store.setConnection({ generation: 1, status: 'active' });
    const queued: RuntimeSessionProjection = {
      ...projection('session-1', 1),
      currentRun: {
        runId: 'run-1',
        initialTurnId: 'turn-1',
        activeTurnId: 'turn-1',
        status: 'queued',
        revision: 1,
      },
    };
    const apply = (session: RuntimeSessionProjection) =>
      store.applySessionNotification({
        connectionGeneration: 1,
        subscriptionGeneration: 1,
        notification: durable(session),
        ready: true,
      });
    expect(apply(queued)).toBe('applied');
    const running: RuntimeSessionProjection = {
      ...queued,
      currentRun: { ...queued.currentRun!, status: 'running' },
    };
    expect(
      apply({ ...running, currentRun: { ...running.currentRun!, activeTurnId: 'other-turn' } }),
    ).toBe('resync_required');
    expect(apply({ ...running, currentRun: { ...running.currentRun!, revision: 2 } })).toBe(
      'resync_required',
    );
    expect(apply(running)).toBe('applied');
    expect(store.getSnapshot().sessions['session-1']).toMatchObject({
      ready: true,
      projection: { currentRun: { status: 'running' } },
    });
    const selectedModel = { provider: 'test', name: 'model' };
    expect(apply({ ...running, model: selectedModel })).toBe('applied');
    const completed: RuntimeSessionProjection = {
      ...running,
      currentRun: { ...running.currentRun!, status: 'completed' },
    };
    expect(apply(completed)).toBe('applied');
    expect(store.getSnapshot().sessions['session-1']?.projection.model).toEqual(selectedModel);
    expect(apply(running)).toBe('resync_required');
    expect(apply({ ...completed, workspace: '/different' })).toBe('resync_required');
  });

  test('drops a prior connection projection before accepting an older replacement snapshot', () => {
    const store = new RuntimeSnapshotStore();
    store.setConnection({ generation: 1, status: 'active', serverInstanceId: 'server-old' });
    store.applySessionNotification({
      connectionGeneration: 1,
      subscriptionGeneration: 1,
      notification: durable(projection('session-1', 10)),
      reset: true,
      ready: true,
    });
    expect(store.getSnapshot().sessions['session-1']).toMatchObject({
      projection: { revision: 10 },
      ready: true,
    });

    store.setConnection({ generation: 2, status: 'reconnecting' });
    expect(store.getSnapshot().sessions).toEqual({});

    store.setConnection({
      generation: 2,
      status: 'active',
      serverInstanceId: 'server-replacement',
    });
    expect(
      store.applySessionNotification({
        connectionGeneration: 2,
        subscriptionGeneration: 1,
        notification: durable(projection('session-1', 2)),
        ready: true,
      }),
    ).toBe('applied');
    expect(store.getSnapshot().sessions['session-1']).toMatchObject({
      projection: { revision: 2 },
      subscriptionGeneration: 1,
      ready: true,
    });
  });

  test('ignores out-of-order index revisions after an atomic reset', () => {
    const store = new RuntimeSnapshotStore();
    store.setConnection({ generation: 1, status: 'active' });
    store.beginIndexReset({
      connectionGeneration: 1,
      subscriptionGeneration: 1,
      serverInstanceId: 'server-1',
      indexRevision: 5,
    });
    store.applyIndexSession({
      connectionGeneration: 1,
      subscriptionGeneration: 1,
      indexRevision: 5,
      session: projection('session-1', 2),
    });
    store.endIndexReset({ connectionGeneration: 1, subscriptionGeneration: 1, indexRevision: 5 });
    expect(
      store.applyIndexSession({
        connectionGeneration: 1,
        subscriptionGeneration: 1,
        indexRevision: 4,
        session: projection('session-1', 99),
      }),
    ).toBe('ignored');
    expect(store.getSnapshot().sessions['session-1']?.projection.revision).toBe(2);
  });

  test('deduplicates ephemeral sequences and clears streams on reset', () => {
    const store = new RuntimeSnapshotStore();
    store.setConnection({ generation: 1, status: 'active' });
    store.applySessionNotification({
      connectionGeneration: 1,
      subscriptionGeneration: 1,
      notification: durable(projection('session-1', 1)),
      reset: true,
    });
    const event = ephemeral(1);
    expect(
      store.applySessionNotification({
        connectionGeneration: 1,
        subscriptionGeneration: 1,
        notification: event,
      }),
    ).toBe('applied');
    expect(
      store.applySessionNotification({
        connectionGeneration: 1,
        subscriptionGeneration: 1,
        notification: event,
      }),
    ).toBe('ignored');
    expect(Object.keys(store.getSnapshot().streams)).toHaveLength(1);
    store.applySessionNotification({
      connectionGeneration: 1,
      subscriptionGeneration: 2,
      notification: durable(projection('session-1', 0)),
      reset: true,
    });
    expect(store.getSnapshot().streams).toEqual({});
  });

  test('fails closed on an ephemeral sequence gap without accepting the truncated packet', () => {
    const store = new RuntimeSnapshotStore();
    store.setConnection({ generation: 1, status: 'active' });
    store.applySessionNotification({
      connectionGeneration: 1,
      subscriptionGeneration: 1,
      notification: durable(projection('session-1', 1)),
      reset: true,
      ready: true,
    });
    expect(
      store.applySessionNotification({
        connectionGeneration: 1,
        subscriptionGeneration: 1,
        notification: ephemeral(1),
      }),
    ).toBe('applied');
    expect(
      store.applySessionNotification({
        connectionGeneration: 1,
        subscriptionGeneration: 1,
        notification: ephemeral(3),
      }),
    ).toBe('resync_required');
    const snapshot = store.getSnapshot();
    expect(Object.values(snapshot.streams)[0]?.sequence).toBe(1);
    expect(snapshot.sessions['session-1']).toMatchObject({
      ready: false,
      historyResyncRequired: true,
    });
  });

  test('requires sequence one when a stream composition revision changes', () => {
    const store = new RuntimeSnapshotStore();
    store.setConnection({ generation: 1, status: 'active' });
    store.applySessionNotification({
      connectionGeneration: 1,
      subscriptionGeneration: 1,
      notification: durable(projection('session-1', 1)),
      reset: true,
      ready: true,
    });
    expect(
      store.applySessionNotification({
        connectionGeneration: 1,
        subscriptionGeneration: 1,
        notification: ephemeral(1),
      }),
    ).toBe('applied');
    expect(
      store.applySessionNotification({
        connectionGeneration: 1,
        subscriptionGeneration: 1,
        notification: { ...ephemeral(2), compositionRevision: 'composition-2' },
      }),
    ).toBe('ignored');
    expect(
      store.applySessionNotification({
        connectionGeneration: 1,
        subscriptionGeneration: 1,
        notification: { ...ephemeral(1), compositionRevision: 'composition-2' },
      }),
    ).toBe('applied');
    expect(Object.values(store.getSnapshot().streams)[0]).toMatchObject({
      compositionRevision: 'composition-2',
      sequence: 1,
    });
  });

  test('fences late ephemeral packets after a durable Run terminal without fencing a successor', () => {
    const store = new RuntimeSnapshotStore();
    store.setConnection({ generation: 1, status: 'active' });
    const terminalSession: RuntimeSessionProjection = {
      ...projection('session-1', 2),
      currentRun: {
        runId: 'run-1',
        initialTurnId: 'turn-1',
        activeTurnId: 'turn-1',
        taskId: 'work-1',
        status: 'completed',
        revision: 2,
        outcome: {
          reasonCode: 'completed',
          safeRetry: false,
          recoveryEntry: 'none',
        },
      },
    };
    expect(
      store.applySessionNotification({
        connectionGeneration: 1,
        subscriptionGeneration: 1,
        notification: durable(terminalSession),
        reset: true,
        ready: true,
      }),
    ).toBe('applied');
    expect(
      store.applySessionNotification({
        connectionGeneration: 1,
        subscriptionGeneration: 1,
        notification: {
          ...ephemeral(1),
          runId: 'run-1',
          taskId: 'work-1',
        },
      }),
    ).toBe('ignored');

    const successor: RuntimeSessionProjection = {
      ...projection('session-1', 3),
      currentRun: {
        runId: 'run-2',
        initialTurnId: 'turn-2',
        activeTurnId: 'turn-2',
        taskId: 'work-2',
        status: 'running',
        revision: 3,
      },
    };
    expect(
      store.applySessionNotification({
        connectionGeneration: 1,
        subscriptionGeneration: 2,
        notification: durable(successor),
      }),
    ).toBe('applied');
    expect(
      store.applySessionNotification({
        connectionGeneration: 1,
        subscriptionGeneration: 1,
        notification: durable(terminalSession),
        reset: true,
      }),
    ).toBe('ignored');
    expect(
      store.applySessionNotification({
        connectionGeneration: 1,
        subscriptionGeneration: 1,
        notification: {
          ...ephemeral(1),
          runId: 'run-1',
          taskId: 'work-1',
        },
      }),
    ).toBe('ignored');
    expect(
      store.applySessionNotification({
        connectionGeneration: 1,
        subscriptionGeneration: 2,
        notification: {
          ...ephemeral(1),
          runId: 'run-2',
          taskId: 'work-2',
          turnId: 'turn-2',
          workId: 'work-2',
        },
      }),
    ).toBe('applied');
  });

  test('batches notifications and isolates throwing observers', async () => {
    const store = new RuntimeSnapshotStore();
    let observed = 0;
    store.subscribe(() => {
      throw new Error('observer failure');
    });
    store.subscribe(() => {
      observed += 1;
    });
    store.setConnection({ generation: 1, status: 'connecting' });
    store.setConnection({ generation: 1, status: 'active' });
    await Promise.resolve();
    expect(observed).toBe(1);
  });
});

function background(
  sessionId: string,
  aggregateGeneration: string,
  watermark: number,
  status: 'running' | 'completed',
) {
  return {
    sessionId,
    sessionRevision: watermark + 100,
    aggregateGeneration,
    watermark,
    executions: [
      {
        executionId: 'shell-1',
        sessionId,
        sessionRevision: watermark + 100,
        kind: 'shell' as const,
        status,
        ownerGeneration: `shell:${aggregateGeneration}`,
        revision: watermark,
        cleanupConfirmed: status === 'completed',
        cursor: 1,
      },
    ],
  };
}

function projection(
  sessionId: string,
  revision: number,
  displayName?: string,
): RuntimeSessionProjection {
  return {
    schema: 'kite.runtime-projection.v2',
    sessionId,
    revision,
    ...(displayName ? { displayName } : {}),
    lifecycle: 'open',
    interactionQueue: { revision, interactions: [] },
  };
}

function durable(
  session: RuntimeSessionProjection,
): Extract<RuntimeNotification, { durability: 'durable' }> {
  return {
    schema: 'kite.runtime-notification.v2',
    durability: 'durable',
    sessionId: session.sessionId,
    revision: session.revision,
    projection: { kind: 'session', session },
  };
}

function ephemeral(sequence: number): Extract<RuntimeNotification, { durability: 'ephemeral' }> {
  return {
    schema: 'kite.runtime-notification.v2',
    durability: 'ephemeral',
    sessionId: 'session-1',
    workId: 'work-1',
    turnId: 'turn-1',
    actorId: 'actor-1',
    attemptId: 'attempt-1',
    compositionRevision: 'composition-1',
    streamId: 'stream-1',
    sequence,
    event: { type: 'model.text_delta', requestId: 'request-1', text: 'hello' },
  };
}
