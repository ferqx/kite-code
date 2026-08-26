import { describe, expect, test } from 'bun:test';
import {
  RUNTIME_NOTIFICATION_SCHEMA_,
  RUNTIME_PROJECTION_SCHEMA_,
  type RuntimeNotification,
  type RuntimeSessionProjection,
} from '@kite-ai/runtime-contract';
import {
  NotificationProjector,
  RUNTIME_HOST_SUBSCRIBER_QUEUE_LIMIT,
} from '../src/host/notification-projector';
import { SessionRegistry } from '../src/host/session-registry';

describe('NotificationProjector durable subscriptions', () => {
  test('replays continuous deltas and uses a full snapshot after a retained-history gap', async () => {
    const registry = new SessionRegistry();
    const projector = new NotificationProjector(registry);
    projector.publish(durable('continuous', 1));
    projector.publish(durable('continuous', 2));
    const continuous = projector
      .subscribe({ spec: { scope: 'session', sessionId: 'continuous', afterRevision: 0 } })
      [Symbol.asyncIterator]();
    expect((await continuous.next()).value).toMatchObject({ revision: 1 });
    expect((await continuous.next()).value).toMatchObject({ revision: 2 });

    for (let revision = 1; revision <= 260; revision += 1) {
      projector.publish(durable('gap', revision));
    }
    const gap = projector
      .subscribe({ spec: { scope: 'session', sessionId: 'gap', afterRevision: 0 } })
      [Symbol.asyncIterator]();
    expect((await gap.next()).value).toMatchObject({
      revision: 260,
      projection: { kind: 'snapshot', session: { revision: 260 } },
    });
    await continuous.return?.();
    await gap.return?.();
    projector.close();
  });

  test('uses a snapshot when durable history does not reach the latest committed projection', async () => {
    const registry = new SessionRegistry();
    const projector = new NotificationProjector(registry);
    projector.publish(durable('session-1', 1));
    projector.publish(durable('session-1', 2));
    registry.commitProjection(sessionProjection('session-1', 3));
    const iterator = projector
      .subscribe({ spec: { scope: 'session', sessionId: 'session-1', afterRevision: 0 } })
      [Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({
      revision: 3,
      projection: { kind: 'snapshot' },
    });
    await iterator.return?.();
    projector.close();
  });

  test('return and AbortSignal close only their subscriber', async () => {
    const registry = new SessionRegistry();
    const projector = new NotificationProjector(registry);
    const controller = new AbortController();
    const first = projector
      .subscribe({ spec: { scope: 'session', sessionId: 'session-1' } })
      [Symbol.asyncIterator]();
    const second = projector
      .subscribe({ spec: { scope: 'session', sessionId: 'session-1' }, signal: controller.signal })
      [Symbol.asyncIterator]();
    await first.return?.();
    controller.abort();
    expect(await second.next()).toEqual({ done: true, value: undefined });

    const remaining = projector
      .subscribe({ spec: { scope: 'session', sessionId: 'session-1' } })
      [Symbol.asyncIterator]();
    projector.publish(durable('session-1', 1));
    expect((await remaining.next()).value).toMatchObject({ revision: 1 });
    await remaining.return?.();
    projector.close();
  });

  test('disconnects a slow subscriber whose queue contains only durable facts', async () => {
    const registry = new SessionRegistry();
    const projector = new NotificationProjector(registry);
    const iterator = projector
      .subscribe({ spec: { scope: 'session', sessionId: 'session-1', afterRevision: 0 } })
      [Symbol.asyncIterator]();
    for (let revision = 1; revision <= RUNTIME_HOST_SUBSCRIBER_QUEUE_LIMIT + 1; revision += 1) {
      projector.publish(durable('session-1', revision));
    }
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    projector.close();
  });
});

describe('NotificationProjector session index subscriptions', () => {
  test('seeds one atomic reset boundary, then emits monotonic live upserts and tombstones', async () => {
    const registry = new SessionRegistry();
    const projector = new NotificationProjector(registry, { serverInstanceId: 'server-test-1' });
    projector.publish(durable('session-a', 1));
    projector.publish(durable('session-b', 1));

    const iterator = projector.subscribe({ spec: { scope: 'sessions' } })[Symbol.asyncIterator]();
    const resetBegin = await iterator.next();
    const first = await iterator.next();
    const second = await iterator.next();
    const resetEnd = await iterator.next();
    expect([
      resetBegin.value?.type,
      first.value?.type,
      second.value?.type,
      resetEnd.value?.type,
    ]).toEqual(['index_reset_begin', 'session_upsert', 'session_upsert', 'index_reset_end']);
    expect([resetBegin.value, first.value, second.value, resetEnd.value]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          serverInstanceId: 'server-test-1',
          generation: 1,
          indexRevision: 2,
        }),
      ]),
    );

    projector.publish(durable('session-a', 2));
    expect((await iterator.next()).value).toMatchObject({
      type: 'session_upsert',
      serverInstanceId: 'server-test-1',
      generation: 1,
      indexRevision: 3,
      session: { sessionId: 'session-a', revision: 2 },
    });
    expect(projector.removeSession('session-b')).toBe(true);
    expect((await iterator.next()).value).toMatchObject({
      type: 'session_remove',
      serverInstanceId: 'server-test-1',
      generation: 1,
      indexRevision: 4,
      sessionId: 'session-b',
    });
    await iterator.return?.();
    projector.close();
  });

  test('gives each index subscription a fresh generation and cleans it up on AbortSignal', async () => {
    const registry = new SessionRegistry();
    const projector = new NotificationProjector(registry, { serverInstanceId: 'server-test-2' });
    const first = projector.subscribe({ spec: { scope: 'sessions' } })[Symbol.asyncIterator]();
    expect((await first.next()).value).toMatchObject({ type: 'index_reset_begin', generation: 1 });
    await first.return?.();

    const controller = new AbortController();
    const second = projector
      .subscribe({ spec: { scope: 'sessions' }, signal: controller.signal })
      [Symbol.asyncIterator]();
    expect((await second.next()).value).toMatchObject({ type: 'index_reset_begin', generation: 2 });
    controller.abort();
    expect(await second.next()).toEqual({ done: true, value: undefined });
    projector.close();
  });

  test('streams an index reset larger than the live subscriber queue without closing it', async () => {
    const registry = new SessionRegistry();
    const projector = new NotificationProjector(registry, {
      serverInstanceId: 'server-large-index',
    });
    for (let index = 0; index < RUNTIME_HOST_SUBSCRIBER_QUEUE_LIMIT + 40; index += 1) {
      projector.publish(durable(`session-${index}`, 1));
    }

    const iterator = projector.subscribe({ spec: { scope: 'sessions' } })[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({
      type: 'index_reset_begin',
      indexRevision: RUNTIME_HOST_SUBSCRIBER_QUEUE_LIMIT + 40,
    });
    for (let index = 0; index < RUNTIME_HOST_SUBSCRIBER_QUEUE_LIMIT + 40; index += 1) {
      expect((await iterator.next()).value).toMatchObject({ type: 'session_upsert' });
    }
    expect((await iterator.next()).value).toMatchObject({ type: 'index_reset_end' });
    projector.publish(durable('session-after-reset', 1));
    expect((await iterator.next()).value).toMatchObject({
      type: 'session_upsert',
      session: { sessionId: 'session-after-reset' },
    });
    await iterator.return?.();
    projector.close();
  });

  test('fails closed when equal revisions carry divergent canonical projections', () => {
    const registry = new SessionRegistry();
    const projector = new NotificationProjector(registry, { serverInstanceId: 'server-test-3' });
    projector.publish(durable('session-1', 1));
    const original = durable('session-1', 1);
    const divergent = {
      ...original,
      projection: {
        ...original.projection,
        session: { ...original.projection.session, displayName: 'forged' },
      },
    };
    expect(() => projector.publish(divergent)).toThrow('diverged');
    projector.close();
  });
});

describe('NotificationProjector ephemeral streams', () => {
  test('does not replay ephemeral notifications to a later subscriber', async () => {
    const registry = new SessionRegistry();
    registry.commitProjection(activeProjection('session-1', 0));
    const projector = new NotificationProjector(registry);
    projector.publish(ephemeral(1));
    const controller = new AbortController();
    const iterator = projector
      .subscribe({
        spec: { scope: 'session', sessionId: 'session-1', afterRevision: 0 },
        signal: controller.signal,
      })
      [Symbol.asyncIterator]();
    controller.abort();
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    projector.close();
  });

  test('bounds ephemeral backlog without dropping a later durable terminal projection', async () => {
    const registry = new SessionRegistry();
    registry.commitProjection(activeProjection('session-1', 0));
    const projector = new NotificationProjector(registry);
    const iterator = projector
      .subscribe({
        spec: {
          scope: 'session',
          sessionId: 'session-1',
          afterRevision: 0,
          includeEphemeral: true,
        },
      })
      [Symbol.asyncIterator]();
    for (let sequence = 1; sequence <= 300; sequence += 1) {
      projector.publish(ephemeral(sequence));
    }
    projector.publish(durable('session-1', 1));
    let terminal: RuntimeNotification | undefined;
    for (let index = 0; index < RUNTIME_HOST_SUBSCRIBER_QUEUE_LIMIT; index += 1) {
      const next = await iterator.next();
      if (next.done) break;
      if ('durability' in next.value && next.value.durability === 'durable') {
        terminal = next.value;
        break;
      }
    }
    expect(terminal).toMatchObject({ durability: 'durable', revision: 1 });
    await iterator.return?.();
    projector.close();
  });

  test('drops stale work, attempt, stream, and non-monotonic sequence deltas', async () => {
    const registry = new SessionRegistry();
    registry.commitProjection(activeProjection('session-1', 0));
    const projector = new NotificationProjector(registry);
    const iterator = projector
      .subscribe({
        spec: {
          scope: 'session',
          sessionId: 'session-1',
          afterRevision: 0,
          includeEphemeral: true,
        },
      })
      [Symbol.asyncIterator]();
    projector.publish({ ...ephemeral(1), workId: 'stale-work' });
    projector.publish(ephemeral(1));
    projector.publish({ ...ephemeral(1), attemptId: 'attempt-2', streamId: 'stream-2' });
    projector.publish(ephemeral(2));
    expect((await iterator.next()).value).toMatchObject({ attemptId: 'attempt-1', sequence: 1 });
    expect((await iterator.next()).value).toMatchObject({ attemptId: 'attempt-2', sequence: 1 });
    const controller = new AbortController();
    const empty = projector
      .subscribe({
        spec: { scope: 'session', sessionId: 'session-1', afterRevision: 0 },
        signal: controller.signal,
      })
      [Symbol.asyncIterator]();
    controller.abort();
    expect(await empty.next()).toEqual({ done: true, value: undefined });
    await iterator.return?.();
    projector.close();
  });
});

function sessionProjection(sessionId: string, revision: number): RuntimeSessionProjection {
  return {
    schema: RUNTIME_PROJECTION_SCHEMA_,
    sessionId,
    revision,
    lifecycle: 'open',
  };
}

function activeProjection(sessionId: string, revision: number): RuntimeSessionProjection {
  return {
    ...sessionProjection(sessionId, revision),
    activeWork: {
      workId: 'work-1',
      phase: 'building',
      status: 'running',
      activeTurn: { turnId: 'turn-1', status: 'running' },
    },
  };
}

function durable(
  sessionId: string,
  revision: number,
): Extract<RuntimeNotification, { durability: 'durable' }> {
  return {
    schema: RUNTIME_NOTIFICATION_SCHEMA_,
    durability: 'durable',
    sessionId,
    revision,
    projection: { kind: 'session', session: sessionProjection(sessionId, revision) },
  };
}

function ephemeral(sequence: number): Extract<RuntimeNotification, { durability: 'ephemeral' }> {
  return {
    schema: RUNTIME_NOTIFICATION_SCHEMA_,
    durability: 'ephemeral',
    sessionId: 'session-1',
    workId: 'work-1',
    turnId: 'turn-1',
    actorId: 'agent-1',
    attemptId: 'attempt-1',
    compositionRevision: 'state-store-current',
    streamId: 'stream-1',
    sequence,
    event: { type: 'model.text_delta', requestId: 'request-1', text: String(sequence) },
  };
}
