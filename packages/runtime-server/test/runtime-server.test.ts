import { describe, expect, test } from 'bun:test';
import type {
  RuntimeAccess,
  RuntimeAccessNotification,
  RuntimeCommand,
  RuntimeNotification,
  RuntimeQuery,
  RuntimeSubscription,
} from '@kite-ai/runtime-contract';
import { RUNTIME_PROTOCOL_LIMITS, type RuntimeProtocolMessage } from '@kite-ai/runtime-protocol';
import {
  createRuntimeServerInProcessHub,
  type DEFAULT_RUNTIME_SERVER_LIMITS,
  RuntimeServer,
  type RuntimeServerAdmissionPort,
  type RuntimeServerLogicalMessageConnection,
} from '../src/index';

const initialize = {
  jsonrpc: '2.0',
  id: 'initialize-1',
  method: 'initialize',
  params: {
    protocolVersion: 1,
    clientInfo: { name: 'test', version: '1', instanceId: 'client-1' },
  },
} as const;

describe('Runtime Server', () => {
  test('rejects pre-init, duplicate init, malformed and incompatible requests before RuntimeAccess', async () => {
    const runtime = new FakeRuntime();
    const pair = createPair(runtime);
    const messages = pair.client.messages()[Symbol.asyncIterator]();

    await pair.client.send(commandRequest('command-before-init'));
    expect(await next(messages)).toMatchObject({
      id: 'command-before-init',
      error: { data: { code: 'not_initialized' } },
    });

    await pair.client.send({ ...initialize, params: { ...initialize.params, protocolVersion: 2 } });
    expect(await next(messages)).toMatchObject({
      id: 'initialize-1',
      error: { data: { code: 'protocol_version_mismatch' } },
    });

    const activePair = createPair(runtime);
    const activeMessages = activePair.client.messages()[Symbol.asyncIterator]();
    await initializePair(activePair, activeMessages);
    await activePair.client.send({ ...initialize, id: 'initialize-2' });
    expect(await next(activeMessages)).toMatchObject({
      id: 'initialize-2',
      error: { data: { code: 'already_initialized' } },
    });

    await activePair.client.send({
      jsonrpc: '2.0',
      id: 'bad-command',
      method: 'runtime/command',
      params: {},
    });
    expect(await next(activeMessages)).toMatchObject({
      id: 'bad-command',
      error: { data: { code: 'invalid_params' } },
    });
    expect(runtime.commands).toHaveLength(0);
  });

  test('linearizes concurrent initialize requests while admission is pending', async () => {
    const runtime = new FakeRuntime();
    const gate = deferred<void>();
    let initializeAdmissions = 0;
    const admission: RuntimeServerAdmissionPort = {
      authorize: async (input) => {
        if (input.operation === 'initialize') {
          initializeAdmissions += 1;
          await gate.promise;
        }
        return { allowed: true, workspace: '/trusted/workspace' };
      },
    };
    const pair = createRuntimeServerInProcessHub(
      { runtime, admission },
      { ...serverOptions(), limits: { maxInFlightRequests: 2 } },
    ).open();
    const messages = pair.client.messages()[Symbol.asyncIterator]();

    await pair.client.send(initialize);
    await eventually(() => initializeAdmissions === 1);
    await pair.client.send({ ...initialize, id: 'initialize-2' });
    expect(await next(messages)).toMatchObject({
      id: 'initialize-2',
      error: { data: { code: 'already_initialized' } },
    });
    expect(initializeAdmissions).toBe(1);

    gate.resolve();
    expect(await next(messages)).toMatchObject({
      id: 'initialize-1',
      result: { protocolVersion: 1 },
    });
  });

  test('counts initialize, malformed, ping, and unsubscribe against one request-task limit', async () => {
    const runtime = new FakeRuntime();
    const gate = deferred<void>();
    let initializeAdmissions = 0;
    const admission: RuntimeServerAdmissionPort = {
      authorize: async (input) => {
        if (input.operation === 'initialize') {
          initializeAdmissions += 1;
          await gate.promise;
        }
        return { allowed: true, workspace: '/trusted/workspace' };
      },
    };
    const pair = createRuntimeServerInProcessHub(
      { runtime, admission },
      { ...serverOptions(), limits: { maxInFlightRequests: 1 } },
    ).open();
    const messages = pair.client.messages()[Symbol.asyncIterator]();

    await pair.client.send(initialize);
    await eventually(() => initializeAdmissions === 1);
    await pair.client.send({ jsonrpc: '2.0', id: 'malformed', params: {} });
    await pair.client.send({
      jsonrpc: '2.0',
      id: 'ping-overload',
      method: 'server/ping',
      params: {},
    });
    await pair.client.send({
      jsonrpc: '2.0',
      id: 'unsubscribe-overload',
      method: 'runtime/unsubscribe',
      params: { subscriptionId: 'subscription-missing' },
    });
    for (const id of ['malformed', 'ping-overload', 'unsubscribe-overload']) {
      expect(await next(messages)).toMatchObject({ id, error: { data: { code: 'overloaded' } } });
    }

    gate.resolve();
    expect(await next(messages)).toMatchObject({
      id: 'initialize-1',
      result: { protocolVersion: 1 },
    });
  });

  test('bounds InProcess logical-message size and queued message count per connection', async () => {
    const runtime = new FakeRuntime();
    const oversized = createRuntimeServerInProcessHub(
      { runtime, admission: allowAdmission },
      serverOptions(),
    ).open();
    await expect(
      oversized.client.send({
        ...initialize,
        params: {
          ...initialize.params,
          clientInfo: {
            ...initialize.params.clientInfo,
            name: 'x'.repeat(RUNTIME_PROTOCOL_LIMITS.maxMessageBytes + 1),
          },
        },
      }),
    ).rejects.toThrow('capacity exceeded');
    expect(oversized.connection.state).toBe('closed');

    const bounded = createRuntimeServerInProcessHub(
      { runtime, admission: allowAdmission },
      {
        ...serverOptions(),
        limits: { maxOutboundMessages: 2, maxOutboundBytes: 512 },
      },
    ).open();
    const burst = Array.from({ length: 8 }, (_, index) =>
      bounded.client.send({
        jsonrpc: '2.0',
        id: `queued-${index}`,
        method: 'server/ping',
        params: {},
      }),
    );
    const settled = await Promise.allSettled(burst);
    expect(settled.some((result) => result.status === 'rejected')).toBeTrue();
    expect(bounded.connection.state).toBe('closed');
    expect(runtime.commands).toHaveLength(0);
  });

  test('routes command/query only after admission and injects the one App Workspace', async () => {
    const runtime = new FakeRuntime();
    const pair = createPair(runtime);
    const messages = pair.client.messages()[Symbol.asyncIterator]();
    await initializePair(pair, messages);

    await pair.client.send(commandRequest('command-1'));
    expect(await next(messages)).toMatchObject({ id: 'command-1', result: { status: 'applied' } });
    expect(runtime.commands[0]).toMatchObject({
      type: 'create_session',
      workspace: '/trusted/workspace',
    });

    await pair.client.send({
      jsonrpc: '2.0',
      id: 'query-1',
      method: 'runtime/query',
      params: { query: { schema: 'kite.runtime-query.v1', type: 'list_sessions' } },
    });
    expect(await next(messages)).toMatchObject({
      id: 'query-1',
      result: { status: 'ok', queryType: 'list_sessions' },
    });
    expect(runtime.queries).toHaveLength(1);
  });

  test('acknowledges session subscriptions before ready and same-subscription FIFO replay', async () => {
    const runtime = new FakeRuntime();
    runtime.sessionProjectionRevision = 2;
    runtime.notifications = [durableNotification(1), durableNotification(2)];
    const pair = createPair(runtime);
    const messages = pair.client.messages()[Symbol.asyncIterator]();
    await initializePair(pair, messages);

    await pair.client.send({
      jsonrpc: '2.0',
      id: 'subscribe-1',
      method: 'runtime/subscribe',
      params: { subscription: { scope: 'session', sessionId: 'session-1' } },
    });
    const ack = await next(messages);
    const first = await next(messages);
    const second = await next(messages);
    const ready = await next(messages);
    expect(ack).toMatchObject({
      id: 'subscribe-1',
      result: { subscriptionId: 'subscription-1', generation: 1 },
    });
    expect(first).toMatchObject({
      method: 'runtime/subscription',
      params: { message: { type: 'notification', revision: 1 } },
    });
    expect(second).toMatchObject({
      method: 'runtime/subscription',
      params: { message: { type: 'notification', revision: 2 } },
    });
    expect(ready).toMatchObject({
      method: 'runtime/subscription',
      params: { message: { type: 'ready', scope: 'session' } },
    });

    await pair.client.send({
      jsonrpc: '2.0',
      id: 'unsubscribe-1',
      method: 'runtime/unsubscribe',
      params: { subscriptionId: 'subscription-1' },
    });
    expect(await next(messages)).toMatchObject({
      id: 'unsubscribe-1',
      result: { unsubscribed: true },
    });
    expect(runtime.iteratorReturns).toBe(1);
  });

  test('enforces in-flight overload without dispatching the excess request', async () => {
    const runtime = new FakeRuntime();
    const gate = deferred<void>();
    runtime.commandGate = gate.promise;
    const pair = createPair(runtime, { maxInFlightRequests: 1 });
    const messages = pair.client.messages()[Symbol.asyncIterator]();
    await initializePair(pair, messages);

    await pair.client.send(commandRequest('command-1'));
    await pair.client.send(commandRequest('command-2'));
    expect(await next(messages)).toMatchObject({
      id: 'command-2',
      error: { data: { code: 'overloaded' } },
    });
    expect(runtime.commands).toHaveLength(1);
    gate.resolve();
    expect(await next(messages)).toMatchObject({ id: 'command-1', result: { status: 'applied' } });
  });

  test('shares the App-composed Server instance and global limits across InProcess clients', async () => {
    const runtime = new FakeRuntime();
    runtime.notifications = emptyIndex();
    const hub = createRuntimeServerInProcessHub(
      { runtime, admission: allowAdmission },
      { ...serverOptions(), globalLimits: { maxConnections: 2, maxSubscriptions: 1 } },
    );
    const first = hub.open();
    const second = hub.open();
    expect(hub.server.connectionCount).toBe(2);
    const firstMessages = first.client.messages()[Symbol.asyncIterator]();
    const secondMessages = second.client.messages()[Symbol.asyncIterator]();
    await initializePair(first, firstMessages);
    await initializePair(second, secondMessages);

    await first.client.send({
      jsonrpc: '2.0',
      id: 'subscribe-first',
      method: 'runtime/subscribe',
      params: { subscription: { scope: 'sessions' } },
    });
    expect(await next(firstMessages)).toMatchObject({
      id: 'subscribe-first',
      result: { subscriptionId: 'subscription-1' },
    });
    await firstMessages.next();
    await second.client.send({
      jsonrpc: '2.0',
      id: 'subscribe-second',
      method: 'runtime/subscribe',
      params: { subscription: { scope: 'sessions' } },
    });
    expect(await next(secondMessages)).toMatchObject({
      id: 'subscribe-second',
      error: { data: { code: 'overloaded' } },
    });
    await first.connection.close();
    await second.connection.close();
  });

  test('preserves session-index reset boundaries without synthesizing a session notification', async () => {
    const runtime = new FakeRuntime();
    runtime.notifications = [
      { type: 'index_reset_begin', serverInstanceId: 'server-1', generation: 7, indexRevision: 4 },
      {
        type: 'session_upsert',
        serverInstanceId: 'server-1',
        generation: 7,
        indexRevision: 4,
        session: {
          schema: 'kite.runtime-projection.v1',
          sessionId: 'session-1',
          revision: 4,
          lifecycle: 'open',
        },
      },
      { type: 'index_reset_end', serverInstanceId: 'server-1', generation: 7, indexRevision: 4 },
    ];
    const pair = createPair(runtime);
    const messages = pair.client.messages()[Symbol.asyncIterator]();
    await initializePair(pair, messages);
    await pair.client.send({
      jsonrpc: '2.0',
      id: 'subscribe-index',
      method: 'runtime/subscribe',
      params: { subscription: { scope: 'sessions' } },
    });
    expect(await next(messages)).toMatchObject({
      id: 'subscribe-index',
      result: { subscriptionId: 'subscription-1' },
    });
    expect(await next(messages)).toMatchObject({
      method: 'runtime/subscription',
      params: {
        message: {
          type: 'index_reset_begin',
          serverInstanceId: 'server-1',
          generation: 7,
          indexRevision: 4,
        },
      },
    });
    expect(await next(messages)).toMatchObject({
      method: 'runtime/subscription',
      params: {
        message: { type: 'session_upsert', session: { sessionId: 'session-1', revision: 4 } },
      },
    });
    expect(await next(messages)).toMatchObject({
      method: 'runtime/subscription',
      params: {
        message: {
          type: 'index_reset_end',
          serverInstanceId: 'server-1',
          generation: 7,
          indexRevision: 4,
        },
      },
    });
    expect(await next(messages)).toMatchObject({
      method: 'runtime/subscription',
      params: { message: { type: 'ready', scope: 'sessions' } },
    });
  });

  test('streams a large index after ack and does not let live facts pass reset end', async () => {
    const runtime = new FakeRuntime();
    runtime.notifications = [
      { type: 'index_reset_begin', serverInstanceId: 'server-1', generation: 8, indexRevision: 1 },
      ...Array.from({ length: 300 }, (_, index) => ({
        type: 'session_upsert' as const,
        serverInstanceId: 'server-1',
        generation: 8,
        indexRevision: 1,
        session: {
          schema: 'kite.runtime-projection.v1' as const,
          sessionId: `session-${index}`,
          revision: index,
          lifecycle: 'open' as const,
        },
      })),
      { type: 'index_reset_end', serverInstanceId: 'server-1', generation: 8, indexRevision: 1 },
      {
        type: 'session_upsert',
        serverInstanceId: 'server-1',
        generation: 8,
        indexRevision: 2,
        session: {
          schema: 'kite.runtime-projection.v1',
          sessionId: 'live-session',
          revision: 2,
          lifecycle: 'open',
        },
      },
    ];
    const pair = createPair(runtime);
    const messages = pair.client.messages()[Symbol.asyncIterator]();
    await initializePair(pair, messages);
    await pair.client.send({
      jsonrpc: '2.0',
      id: 'subscribe-large',
      method: 'runtime/subscribe',
      params: { subscription: { scope: 'sessions' } },
    });
    expect(await next(messages)).toMatchObject({
      id: 'subscribe-large',
      result: { subscriptionId: 'subscription-1' },
    });
    expect(await next(messages)).toMatchObject({
      params: { message: { type: 'index_reset_begin' } },
    });
    for (let index = 0; index < 300; index += 1) {
      expect(await next(messages)).toMatchObject({
        params: { message: { type: 'session_upsert', session: { sessionId: `session-${index}` } } },
      });
    }
    expect(await next(messages)).toMatchObject({
      params: { message: { type: 'index_reset_end' } },
    });
    expect(await next(messages)).toMatchObject({
      params: { message: { type: 'ready', scope: 'sessions' } },
    });
    expect(await next(messages)).toMatchObject({
      params: { message: { type: 'session_upsert', session: { sessionId: 'live-session' } } },
    });
  });

  test('uses the post-registration session watermark for continuous replay, gaps, empty sessions, and live events', async () => {
    const runtime = new FakeRuntime();
    runtime.sessionProjectionRevision = 3;
    runtime.notifications = [
      durableNotification(2),
      durableNotification(3),
      durableNotification(4),
    ];
    const pair = createPair(runtime);
    const messages = pair.client.messages()[Symbol.asyncIterator]();
    await initializePair(pair, messages);
    await pair.client.send({
      jsonrpc: '2.0',
      id: 'subscribe-watermark',
      method: 'runtime/subscribe',
      params: { subscription: { scope: 'session', sessionId: 'session-1', afterRevision: 1 } },
    });
    expect(await next(messages)).toMatchObject({ id: 'subscribe-watermark' });
    expect(await next(messages)).toMatchObject({
      params: { message: { type: 'notification', revision: 2 } },
    });
    expect(await next(messages)).toMatchObject({
      params: { message: { type: 'notification', revision: 3 } },
    });
    expect(await next(messages)).toMatchObject({
      params: { message: { type: 'ready', scope: 'session' } },
    });
    expect(await next(messages)).toMatchObject({
      params: { message: { type: 'notification', revision: 4 } },
    });

    const gapRuntime = new FakeRuntime();
    gapRuntime.sessionProjectionRevision = 5;
    gapRuntime.notifications = [durableNotification(5)];
    const gap = createPair(gapRuntime);
    const gapMessages = gap.client.messages()[Symbol.asyncIterator]();
    await initializePair(gap, gapMessages);
    await gap.client.send({
      jsonrpc: '2.0',
      id: 'subscribe-gap',
      method: 'runtime/subscribe',
      params: { subscription: { scope: 'session', sessionId: 'session-1', afterRevision: 1 } },
    });
    expect(await next(gapMessages)).toMatchObject({ id: 'subscribe-gap' });
    expect(await next(gapMessages)).toMatchObject({
      params: { message: { type: 'notification', revision: 5 } },
    });
    expect(await next(gapMessages)).toMatchObject({
      params: { message: { type: 'ready', scope: 'session' } },
    });

    const emptyRuntime = new FakeRuntime();
    const empty = createPair(emptyRuntime);
    const emptyMessages = empty.client.messages()[Symbol.asyncIterator]();
    await initializePair(empty, emptyMessages);
    await empty.client.send({
      jsonrpc: '2.0',
      id: 'subscribe-empty',
      method: 'runtime/subscribe',
      params: { subscription: { scope: 'session', sessionId: 'missing-session' } },
    });
    expect(await next(emptyMessages)).toMatchObject({ id: 'subscribe-empty' });
    expect(await next(emptyMessages)).toMatchObject({
      params: { message: { type: 'ready', scope: 'session' } },
    });

    const caughtUpRuntime = new FakeRuntime();
    caughtUpRuntime.sessionProjectionRevision = 7;
    const caughtUp = createPair(caughtUpRuntime);
    const caughtUpMessages = caughtUp.client.messages()[Symbol.asyncIterator]();
    await initializePair(caughtUp, caughtUpMessages);
    await caughtUp.client.send({
      jsonrpc: '2.0',
      id: 'subscribe-caught-up',
      method: 'runtime/subscribe',
      params: { subscription: { scope: 'session', sessionId: 'session-1', afterRevision: 7 } },
    });
    expect(await next(caughtUpMessages)).toMatchObject({ id: 'subscribe-caught-up' });
    expect(await next(caughtUpMessages)).toMatchObject({
      params: { message: { type: 'ready', scope: 'session' } },
    });
  });

  test('returns the acquired iterator when the subscribe ack cannot be written', async () => {
    const runtime = new FakeRuntime();
    const transport = new TestConnection();
    const server = new RuntimeServer({ runtime, admission: allowAdmission }, serverOptions());
    server.open(transport);
    transport.push(initialize);
    await eventually(() => transport.sent.length === 1);
    transport.failNextSend = true;
    transport.push({
      jsonrpc: '2.0',
      id: 'subscribe-fail',
      method: 'runtime/subscribe',
      params: { subscription: { scope: 'session', sessionId: 'session-1' } },
    });
    await eventually(() => runtime.iteratorReturns === 1);
    expect(
      transport.sent.some(
        (message) => 'method' in message && message.method === 'runtime/subscription',
      ),
    ).toBeFalse();
  });

  test('closes the logical connection when a Host subscription ends without a ready boundary', async () => {
    const runtime = new FakeRuntime();
    runtime.sessionProjectionRevision = 1;
    runtime.endAfterNotifications = true;
    const transport = new TestConnection();
    const server = new RuntimeServer({ runtime, admission: allowAdmission }, serverOptions());
    const connection = server.open(transport);
    transport.push(initialize);
    await eventually(() => transport.sent.length === 1);
    transport.push({
      jsonrpc: '2.0',
      id: 'subscribe-ended',
      method: 'runtime/subscribe',
      params: { subscription: { scope: 'session', sessionId: 'session-1' } },
    });
    await eventually(() => transport.closed);
    expect(connection.state).toBe('closed');
    expect(runtime.iteratorReturns).toBe(1);
    expect(
      transport.sent.some(
        (message) =>
          'method' in message &&
          message.method === 'runtime/subscription' &&
          message.params.message.type === 'ready',
      ),
    ).toBeFalse();
  });

  test('closes only a slow logical connection and returns its iterator', async () => {
    const runtime = new FakeRuntime();
    runtime.notifications = [durableNotification(1)];
    const transport = new TestConnection();
    const server = new RuntimeServer(
      { runtime, admission: allowAdmission },
      {
        serverInfo: { version: 'test', instanceId: 'server-1' },
        limits: { maxOutboundMessages: 1, maxOutboundBytes: 1 },
      },
    );
    server.open(transport);
    transport.push(initialize);
    await eventually(() => transport.closed);
    expect(runtime.commands).toHaveLength(0);
    expect(transport.closed).toBeTrue();
  });

  test('draining is bounded, releases subscription resources, and never cancels Runtime work', async () => {
    const runtime = new FakeRuntime();
    runtime.notifications = emptyIndex();
    const transport = new TestConnection();
    const server = new RuntimeServer({ runtime, admission: allowAdmission }, serverOptions());
    const connection = server.open(transport);
    transport.push(initialize);
    await eventually(() => transport.sent.length === 1);
    transport.push({
      jsonrpc: '2.0',
      id: 'subscribe-1',
      method: 'runtime/subscribe',
      params: { subscription: { scope: 'sessions' } },
    });
    await eventually(() =>
      transport.sent.some((message) => 'id' in message && message.id === 'subscribe-1'),
    );

    await connection.beginDraining();
    expect(runtime.iteratorReturns).toBe(1);
    expect(connection.state).toBe('closed');
    expect(transport.sent).toContainEqual(expect.objectContaining({ method: 'server/draining' }));
    expect(runtime.commands).toHaveLength(0);
  });
});

const allowAdmission: RuntimeServerAdmissionPort = {
  authorize: async () => ({ allowed: true, workspace: '/trusted/workspace' }),
};

function createPair(runtime: FakeRuntime, limits?: Partial<typeof DEFAULT_RUNTIME_SERVER_LIMITS>) {
  return createRuntimeServerInProcessHub(
    { runtime, admission: allowAdmission },
    { ...serverOptions(), ...(limits ? { limits } : {}) },
  ).open();
}

function serverOptions() {
  return { serverInfo: { version: 'test', instanceId: 'server-1' } };
}

async function initializePair(
  pair: ReturnType<typeof createPair>,
  messages: AsyncIterator<unknown>,
): Promise<void> {
  await pair.client.send(initialize);
  expect(await next(messages)).toMatchObject({
    id: 'initialize-1',
    result: { protocolVersion: 1 },
  });
}

function commandRequest(id: string) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'runtime/command',
    params: {
      command: {
        schema: 'kite.runtime-command.v1',
        commandId: id,
        type: 'create_session',
        bootstrapSessionId: 'session-1',
      },
    },
  } as const;
}

function durableNotification(revision: number): RuntimeNotification {
  return {
    schema: 'kite.runtime-notification.v1',
    durability: 'durable',
    sessionId: 'session-1',
    revision,
    projection: {
      kind: 'session',
      session: {
        schema: 'kite.runtime-projection.v1',
        sessionId: 'session-1',
        revision,
        lifecycle: 'open',
      },
    },
  };
}

function emptyIndex(): RuntimeAccessNotification[] {
  return [
    { type: 'index_reset_begin', serverInstanceId: 'server-1', generation: 1, indexRevision: 0 },
    { type: 'index_reset_end', serverInstanceId: 'server-1', generation: 1, indexRevision: 0 },
  ];
}

class FakeRuntime implements RuntimeAccess {
  commands: RuntimeCommand[] = [];
  queries: RuntimeQuery[] = [];
  notifications: RuntimeAccessNotification[] = [];
  iteratorReturns = 0;
  commandGate: Promise<void> | undefined;
  sessionProjectionRevision: number | undefined;
  endAfterNotifications = false;

  async command(command: RuntimeCommand) {
    this.commands.push(command);
    await this.commandGate;
    return {
      status: 'applied' as const,
      commandId: command.commandId,
      sessionId: 'session-1',
      revision: 1,
    };
  }

  async query(query: RuntimeQuery) {
    this.queries.push(query);
    if (query.type === 'get_session_projection') {
      return this.sessionProjectionRevision === undefined
        ? {
            status: 'not_found' as const,
            queryType: query.type,
            code: 'session_not_found' as const,
          }
        : {
            status: 'ok' as const,
            queryType: query.type,
            revision: this.sessionProjectionRevision,
            session: {
              schema: 'kite.runtime-projection.v1' as const,
              sessionId: query.sessionId,
              revision: this.sessionProjectionRevision,
              lifecycle: 'open' as const,
            },
          };
    }
    return { status: 'ok' as const, queryType: query.type, sessions: [] };
  }

  subscribe(_subscription: RuntimeSubscription): AsyncIterable<RuntimeAccessNotification> {
    const notifications = [...this.notifications];
    const runtime = this;
    return {
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          next: async () => {
            const value = notifications[index++];
            return value
              ? { done: false as const, value }
              : runtime.endAfterNotifications
                ? { done: true as const, value: undefined }
                : await new Promise<IteratorResult<RuntimeAccessNotification>>(() => undefined);
          },
          return: async () => {
            runtime.iteratorReturns += 1;
            return { done: true as const, value: undefined };
          },
        };
      },
    };
  }
}

class TestConnection implements RuntimeServerLogicalMessageConnection {
  readonly #incoming = new AsyncValues<unknown>();
  readonly sent: RuntimeProtocolMessage[] = [];
  closed = false;
  failNextSend = false;
  readonly incoming = this.#incoming;

  push(value: unknown): void {
    this.#incoming.push(value);
  }

  async send(message: RuntimeProtocolMessage): Promise<void> {
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error('simulated write failure');
    }
    this.sent.push(message);
  }

  close(): void {
    this.closed = true;
    this.#incoming.close();
  }
}

class AsyncValues<T> implements AsyncIterable<T> {
  readonly #values: T[] = [];
  readonly #waiters = new Set<(result: IteratorResult<T>) => void>();
  #closed = false;

  push(value: T): void {
    const waiter = this.#waiters.values().next().value;
    if (waiter) {
      this.#waiters.delete(waiter);
      waiter({ done: false, value });
    } else {
      this.#values.push(value);
    }
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters) waiter({ done: true, value: undefined });
    this.#waiters.clear();
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.#values.shift();
        if (value !== undefined) return Promise.resolve({ done: false, value });
        if (this.#closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise<IteratorResult<T>>((resolve) => this.#waiters.add(resolve));
      },
    };
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function next(iterator: AsyncIterator<unknown>): Promise<unknown> {
  const value = await iterator.next();
  if (value.done) throw new Error('Expected a logical protocol message.');
  return value.value;
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('Condition did not settle.');
}
