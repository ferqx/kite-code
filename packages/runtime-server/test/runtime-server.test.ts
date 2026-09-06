import { describe, expect, test } from 'bun:test';
import type {
  RuntimeAccess,
  RuntimeAccessNotification,
  RuntimeCommand,
  RuntimeCommandContext,
  RuntimeNotification,
  RuntimeQuery,
  RuntimeSubscription,
} from '@kite-ai/runtime-contract';
import {
  RUNTIME_PROTOCOL_LIMITS,
  RUNTIME_PROTOCOL_VERSION,
  type RuntimeProtocolMessage,
} from '@kite-ai/runtime-protocol';
import {
  createRuntimeServerInProcessHub,
  type DEFAULT_RUNTIME_SERVER_LIMITS,
  RuntimeServer,
  type RuntimeServerAdmissionInput,
  type RuntimeServerAdmissionPort,
  type RuntimeServerLogicalMessageConnection,
} from '../src/index';

const initialize = {
  jsonrpc: '2.0',
  id: 'initialize-1',
  method: 'initialize',
  params: {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
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

    await pair.client.send({ ...initialize, params: { ...initialize.params, protocolVersion: 1 } });
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
      result: { protocolVersion: RUNTIME_PROTOCOL_VERSION },
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
      result: { protocolVersion: RUNTIME_PROTOCOL_VERSION },
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

    await pair.client.send({
      jsonrpc: '2.0',
      id: 'query-runs',
      method: 'runtime/query',
      params: {
        query: {
          schema: 'kite.runtime-query.v1',
          type: 'list_runs',
          sessionId: 'session-1',
          limit: 10,
        },
      },
    });
    expect(await next(messages)).toMatchObject({
      id: 'query-runs',
      result: { status: 'ok', queryType: 'list_runs', runs: [{ runId: 'run-1' }] },
    });
    expect(runtime.queries).toHaveLength(2);
  });

  test('pins admission connection and binding reference into the in-process command context', async () => {
    const runtime = new FakeRuntime();
    const pair = createRuntimeServerInProcessHub(
      {
        runtime,
        admission: {
          authorize: async (input) => ({
            allowed: true as const,
            workspace: '/trusted/workspace',
            bindingReference: `binding:${input.connectionId}`,
          }),
        },
      },
      serverOptions(),
    ).open();
    const messages = pair.client.messages()[Symbol.asyncIterator]();
    await initializePair(pair, messages);

    await pair.client.send(commandRequest('command-context-1'));
    expect(await next(messages)).toMatchObject({
      id: 'command-context-1',
      result: { status: 'applied' },
    });
    expect(runtime.commandContexts).toHaveLength(1);
    expect(runtime.commandContexts[0]).toMatchObject({
      schema: 'kite.runtime-command-context.v1',
      connectionId: 'connection-1',
      requestId: 'command-context-1',
      bindingReference: 'binding:connection-1',
    });
    expect(Object.isFrozen(runtime.commandContexts[0])).toBeTrue();
    expect(Object.isFrozen(runtime.commandContexts[0]?.clientInfo)).toBeTrue();
    expect(runtime.commandContexts[0]).not.toHaveProperty('workspace');
    await pair.connection.close();
  });

  test('binds distinct per-connection admission ports while resume/query retain persisted authority', async () => {
    const runtime = new FakeRuntime();
    const backend = recordingAdmission('/persisted/workspace');
    const hub = createRuntimeServerInProcessHub(
      { runtime, admission: backend.port },
      serverOptions(),
    );
    const firstAdmission = connectionAdmission('/workspace/first', backend.port);
    const secondAdmission = connectionAdmission('/workspace/second', backend.port);
    const first = hub.open({ admission: firstAdmission.port });
    const second = hub.open({ admission: secondAdmission.port });
    const firstMessages = first.client.messages()[Symbol.asyncIterator]();
    const secondMessages = second.client.messages()[Symbol.asyncIterator]();
    await initializePair(first, firstMessages);
    await initializePair(second, secondMessages);

    await first.client.send(commandRequest('create-first'));
    await second.client.send(commandRequest('create-second'));
    expect(await next(firstMessages)).toMatchObject({
      id: 'create-first',
      result: { status: 'applied' },
    });
    expect(await next(secondMessages)).toMatchObject({
      id: 'create-second',
      result: { status: 'applied' },
    });
    expect(runtime.commands.slice(0, 2)).toEqual([
      expect.objectContaining({ type: 'create_session', workspace: '/workspace/first' }),
      expect.objectContaining({ type: 'create_session', workspace: '/workspace/second' }),
    ]);

    await first.client.send(resumeRequest('resume-first', 'persisted-first'));
    expect(await next(firstMessages)).toMatchObject({
      id: 'resume-first',
      result: { status: 'applied' },
    });
    await second.client.send(queryListRequest('query-second'));
    expect(await next(secondMessages)).toMatchObject({
      id: 'query-second',
      result: { status: 'ok', queryType: 'list_sessions' },
    });

    const resumed = runtime.commands.at(-1);
    expect(resumed).toMatchObject({ type: 'resume_session', sessionId: 'persisted-first' });
    expect(resumed).not.toHaveProperty('workspace');
    expect(backend.inputs.map((input) => input.operation)).toEqual(
      expect.arrayContaining(['runtime/command', 'runtime/query']),
    );
    expect(firstAdmission.inputs.map((input) => input.operation)).toContain('runtime/command');
    expect(secondAdmission.inputs.map((input) => input.operation)).toContain('runtime/query');

    await first.connection.close('first_disconnect');
    expect(hub.server.connectionCount).toBe(1);
    const firstCallsAfterClose = firstAdmission.inputs.length;
    await expect(first.client.send(commandRequest('after-close'))).rejects.toThrow(
      'connection is closed',
    );
    expect(firstAdmission.inputs).toHaveLength(firstCallsAfterClose);
    await second.connection.close('second_disconnect');
    expect(hub.server.connectionCount).toBe(0);
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

  test('retains outbound byte reservations until slow sends settle across connections', async () => {
    const runtime = new FakeRuntime();
    runtime.querySessions = Array.from({ length: 3 }, (_, index) => ({
      schema: 'kite.runtime-projection.v2' as const,
      sessionId: `session-large-${index}`,
      revision: 1,
      displayName: 'x'.repeat(256),
      lifecycle: 'open' as const,
      interactionQueue: { revision: 1, interactions: [] },
    }));
    const server = new RuntimeServer(
      { runtime, admission: allowAdmission },
      {
        ...serverOptions(),
        limits: { maxOutboundBytes: 2_000 },
        globalLimits: { maxQueuedBytes: 2_000 },
      },
    );
    const slowTransport = new TestConnection();
    const secondTransport = new TestConnection();
    const slowConnection = server.open(slowTransport);
    server.open(secondTransport);
    await initializeTransport(slowTransport);
    await initializeTransport(secondTransport);

    const gate = deferred<void>();
    slowTransport.sendGate = gate.promise;
    slowTransport.push({
      jsonrpc: '2.0',
      id: 'query-held',
      method: 'runtime/query',
      params: { query: { schema: 'kite.runtime-query.v1', type: 'list_sessions' } },
    });
    await eventually(() => slowTransport.sendCalls === 2);

    secondTransport.push({
      jsonrpc: '2.0',
      id: 'query-over-budget',
      method: 'runtime/query',
      params: { query: { schema: 'kite.runtime-query.v1', type: 'list_sessions' } },
    });
    await eventually(() => secondTransport.closed);

    gate.resolve();
    await eventually(() =>
      slowTransport.sent.some((message) => 'id' in message && message.id === 'query-held'),
    );

    const recoveredTransport = new TestConnection();
    const recoveredConnection = server.open(recoveredTransport);
    await initializeTransport(recoveredTransport);
    recoveredTransport.push({
      jsonrpc: '2.0',
      id: 'query-recovered',
      method: 'runtime/query',
      params: { query: { schema: 'kite.runtime-query.v1', type: 'list_sessions' } },
    });
    await eventually(() =>
      recoveredTransport.sent.some(
        (message) => 'id' in message && message.id === 'query-recovered',
      ),
    );

    const rejectGate = deferred<void>();
    recoveredTransport.sendGate = rejectGate.promise;
    recoveredTransport.failNextSend = true;
    recoveredTransport.push({
      jsonrpc: '2.0',
      id: 'query-rejected',
      method: 'runtime/query',
      params: { query: { schema: 'kite.runtime-query.v1', type: 'list_sessions' } },
    });
    await eventually(() => recoveredTransport.sendCalls === 3);
    rejectGate.resolve();
    await eventually(() => recoveredTransport.closed);

    const finalTransport = new TestConnection();
    const finalConnection = server.open(finalTransport);
    await initializeTransport(finalTransport);
    finalTransport.push({
      jsonrpc: '2.0',
      id: 'query-after-rejection',
      method: 'runtime/query',
      params: { query: { schema: 'kite.runtime-query.v1', type: 'list_sessions' } },
    });
    await eventually(() =>
      finalTransport.sent.some(
        (message) => 'id' in message && message.id === 'query-after-rejection',
      ),
    );

    await slowConnection.close();
    await recoveredConnection.close();
    await finalConnection.close();
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
          schema: 'kite.runtime-projection.v2',
          sessionId: 'session-1',
          revision: 4,
          lifecycle: 'open',
          interactionQueue: { revision: 4, interactions: [] },
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
          schema: 'kite.runtime-projection.v2' as const,
          sessionId: `session-${index}`,
          revision: index,
          lifecycle: 'open' as const,
          interactionQueue: { revision: index, interactions: [] },
        },
      })),
      { type: 'index_reset_end', serverInstanceId: 'server-1', generation: 8, indexRevision: 1 },
      {
        type: 'session_upsert',
        serverInstanceId: 'server-1',
        generation: 8,
        indexRevision: 2,
        session: {
          schema: 'kite.runtime-projection.v2',
          sessionId: 'live-session',
          revision: 2,
          lifecycle: 'open',
          interactionQueue: { revision: 2, interactions: [] },
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

  test('resets an ahead session cursor to the authoritative watermark before ready', async () => {
    const runtime = new FakeRuntime();
    runtime.sessionProjectionRevision = 3;
    runtime.notifications = [durableNotification(4)];
    const pair = createPair(runtime);
    const messages = pair.client.messages()[Symbol.asyncIterator]();
    await initializePair(pair, messages);

    await pair.client.send({
      jsonrpc: '2.0',
      id: 'subscribe-ahead',
      method: 'runtime/subscribe',
      params: { subscription: { scope: 'session', sessionId: 'session-1', afterRevision: 5 } },
    });

    expect(await next(messages)).toMatchObject({
      id: 'subscribe-ahead',
      result: { subscriptionId: 'subscription-1' },
    });
    expect(await next(messages)).toMatchObject({
      method: 'runtime/subscription',
      params: {
        message: {
          type: 'reset',
          sessions: [{ sessionId: 'session-1', revision: 3 }],
        },
      },
    });
    expect(await next(messages)).toMatchObject({
      method: 'runtime/subscription',
      params: { message: { type: 'ready', scope: 'session' } },
    });
    expect(runtime.subscriptions).toHaveLength(2);
    expect(runtime.subscriptions.at(-1)?.spec).toEqual({
      scope: 'session',
      sessionId: 'session-1',
      afterRevision: 3,
    });
    expect(await next(messages)).toMatchObject({
      method: 'runtime/subscription',
      params: { message: { type: 'notification', revision: 4 } },
    });
    expect(pair.connection.state).toBe('active');
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

  test('closes the logical connection when a Host subscription ends after ready', async () => {
    const runtime = new FakeRuntime();
    runtime.sessionProjectionRevision = 1;
    runtime.notifications = [durableNotification(1)];
    runtime.endAfterNotifications = true;
    const transport = new TestConnection();
    const server = new RuntimeServer({ runtime, admission: allowAdmission }, serverOptions());
    const connection = server.open(transport);
    transport.push(initialize);
    await eventually(() => transport.sent.length === 1);
    transport.push({
      jsonrpc: '2.0',
      id: 'subscribe-ended-live',
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
    ).toBeTrue();
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

  test('releases connection accounting when the carrier close reports an error', async () => {
    const runtime = new FakeRuntime();
    const transport = new TestConnection();
    transport.failClose = true;
    const server = new RuntimeServer({ runtime, admission: allowAdmission }, serverOptions());
    const connection = server.open(transport);

    await expect(connection.close('carrier_failure')).rejects.toThrow('simulated close failure');
    expect(connection.state).toBe('closed');
    expect(server.connectionCount).toBe(0);

    const recoveredTransport = new TestConnection();
    const recovered = server.open(recoveredTransport);
    expect(recovered.state).toBe('uninitialized');
    await recovered.close();
  });

  test('releases subscription accounting when an iterator refuses to close', async () => {
    const runtime = new FakeRuntime();
    runtime.notifications = emptyIndex();
    runtime.throwOnIteratorReturn = true;
    const transport = new TestConnection();
    const server = new RuntimeServer({ runtime, admission: allowAdmission }, serverOptions());
    const connection = server.open(transport);
    transport.push(initialize);
    await eventually(() => transport.sent.length === 1);
    transport.push({
      jsonrpc: '2.0',
      id: 'subscribe-throws-on-close',
      method: 'runtime/subscribe',
      params: { subscription: { scope: 'sessions' } },
    });
    await eventually(() =>
      transport.sent.some(
        (message) => 'id' in message && message.id === 'subscribe-throws-on-close',
      ),
    );

    await expect(connection.close('iterator_failure')).rejects.toThrow(
      'simulated iterator close failure',
    );
    expect(server.connectionCount).toBe(0);
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
    result: { protocolVersion: RUNTIME_PROTOCOL_VERSION },
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

function resumeRequest(id: string, sessionId: string) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'runtime/command',
    params: {
      command: {
        schema: 'kite.runtime-command.v1',
        commandId: id,
        type: 'resume_session',
        sessionId,
      },
    },
  } as const;
}

function queryListRequest(id: string) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'runtime/query',
    params: { query: { schema: 'kite.runtime-query.v1', type: 'list_sessions' } },
  } as const;
}

function recordingAdmission(workspace: string) {
  const inputs: RuntimeServerAdmissionInput[] = [];
  const port: RuntimeServerAdmissionPort = {
    authorize: async (input) => {
      inputs.push(input);
      return { allowed: true as const, workspace };
    },
  };
  return { inputs, port };
}

function connectionAdmission(workspace: string, persisted: RuntimeServerAdmissionPort) {
  const inputs: RuntimeServerAdmissionInput[] = [];
  const port: RuntimeServerAdmissionPort = {
    authorize: async (input) => {
      inputs.push(input);
      if (
        input.operation === 'runtime/command' &&
        (input.command as { readonly type?: unknown } | undefined)?.type === 'create_session'
      ) {
        return { allowed: true as const, workspace };
      }
      return persisted.authorize(input);
    },
  };
  return { inputs, port };
}

function durableNotification(revision: number): RuntimeNotification {
  return {
    schema: 'kite.runtime-notification.v2',
    durability: 'durable',
    sessionId: 'session-1',
    revision,
    projection: {
      kind: 'session',
      session: {
        schema: 'kite.runtime-projection.v2',
        sessionId: 'session-1',
        revision,
        lifecycle: 'open',
        interactionQueue: { revision, interactions: [] },
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
  commandContexts: Array<RuntimeCommandContext | undefined> = [];
  queries: RuntimeQuery[] = [];
  subscriptions: RuntimeSubscription[] = [];
  notifications: RuntimeAccessNotification[] = [];
  iteratorReturns = 0;
  commandGate: Promise<void> | undefined;
  querySessions: Array<{
    schema: 'kite.runtime-projection.v2';
    sessionId: string;
    revision: number;
    displayName?: string;
    lifecycle: 'open';
    interactionQueue: { revision: number; interactions: [] };
  }> = [];
  sessionProjectionRevision: number | undefined;
  endAfterNotifications = false;
  throwOnIteratorReturn = false;

  async command(command: RuntimeCommand, context?: RuntimeCommandContext) {
    this.commands.push(command);
    this.commandContexts.push(context);
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
              schema: 'kite.runtime-projection.v2' as const,
              sessionId: query.sessionId,
              revision: this.sessionProjectionRevision,
              lifecycle: 'open' as const,
              interactionQueue: {
                revision: this.sessionProjectionRevision,
                interactions: [],
              },
            },
          };
    }
    if (query.type === 'list_runs') {
      return {
        status: 'ok' as const,
        queryType: query.type,
        runs: [
          {
            schema: 'kite.runtime-run.v1' as const,
            sessionId: query.sessionId,
            runId: 'run-1',
            phase: 'building' as const,
            status: 'queued' as const,
            createdRevision: 1,
            lastRevision: 1,
            createdAtMs: 100,
          },
        ],
      };
    }
    if (query.type === 'get_run') {
      return {
        status: 'not_found' as const,
        queryType: query.type,
        code: 'run_not_found' as const,
      };
    }
    return { status: 'ok' as const, queryType: query.type, sessions: this.querySessions };
  }

  subscribe(subscription: RuntimeSubscription): AsyncIterable<RuntimeAccessNotification> {
    this.subscriptions.push(subscription);
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
            if (runtime.throwOnIteratorReturn) {
              throw new Error('simulated iterator close failure');
            }
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
  failClose = false;
  failNextSend = false;
  sendCalls = 0;
  sendGate: Promise<void> | undefined;
  readonly incoming = this.#incoming;

  push(value: unknown): void {
    this.#incoming.push(value);
  }

  async send(message: RuntimeProtocolMessage): Promise<void> {
    this.sendCalls += 1;
    await this.sendGate;
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error('simulated write failure');
    }
    this.sent.push(message);
  }

  close(): void {
    this.closed = true;
    this.#incoming.close();
    if (this.failClose) throw new Error('simulated close failure');
  }
}

async function initializeTransport(transport: TestConnection): Promise<void> {
  transport.push(initialize);
  await eventually(() =>
    transport.sent.some((message) => 'id' in message && message.id === 'initialize-1'),
  );
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
