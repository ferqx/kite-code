import { describe, expect, test } from 'bun:test';
import type { RuntimeAccess } from '@kite-ai/runtime-contract';
import type { RuntimeProtocolMessage } from '@kite-ai/runtime-protocol';
import {
  RUNTIME_CLIENT_BOUNDARY_,
  RuntimeClient,
  type RuntimeClientConnection,
  type RuntimeClientTransport,
} from '../src/index';

describe('Runtime Client boundary', () => {
  test('exposes only a framework-neutral logical transport seam', () => {
    expect(RUNTIME_CLIENT_BOUNDARY_).toEqual({
      frameworkNeutral: true,
      transport: 'logical-message',
      protocolSchema: 'kite.runtime-protocol.v1',
    });
    const transport = undefined as RuntimeClientTransport | undefined;
    expect(transport).toBeUndefined();
  });
});

describe('RuntimeClient protocol state machine', () => {
  test('uses the same initialized connection for durable History reads', async () => {
    const sessionEntry = {
      sessionId: 'session-history',
      displayName: 'History',
      needsSmartName: false,
      updatedAt: 10,
      lastSequence: 0,
    };
    const connection = new FakeConnection((message, target) => {
      if (message.method === 'initialize') {
        target.push(result(message.id, initializeResult('server-history')));
      } else if (message.method === 'history/list_sessions') {
        target.push(result(message.id, { entries: [sessionEntry], hasMore: false }));
      } else if (message.method === 'history/list_events') {
        target.push(
          result(message.id, {
            entries: [],
            hasMore: false,
            observedLastSequence: 0,
          }),
        );
      } else if (message.method === 'history/load_session') {
        target.push(
          result(message.id, {
            session: sessionEntry,
            records: [],
            events: [],
            interactionMode: 'auto',
            recovery: 'normal',
          }),
        );
      }
    });
    const client = new RuntimeClient({
      transport: transport(connection),
      clientInfo: clientInfo(),
      history: 'protocol',
    });
    await expect(client.history?.listSessions({ limit: 10 })).resolves.toMatchObject({
      entries: [{ sessionId: 'session-history' }],
    });
    await expect(
      client.history?.listEvents({
        sessionId: 'session-history',
        direction: 'forward',
        limit: 10,
      }),
    ).resolves.toMatchObject({ observedLastSequence: 0 });
    await expect(client.history?.loadSession('session-history')).resolves.toMatchObject({
      session: { sessionId: 'session-history' },
      recovery: 'normal',
    });
    expect(connection.requests('initialize')).toHaveLength(1);
    await client.close();
  });

  test('correlates exact App Control envelopes on the initialized connection', async () => {
    const connection = new FakeConnection((message, target) => {
      if (message.method === 'initialize') {
        target.push(result(message.id, initializeResult('server-app-control')));
      } else if (message.method === 'app/release/status') {
        target.push(
          result(message.id, {
            method: 'app/release/status',
            response: { schema: 'kite.app.release-status.response.v1', serverVersion: 'test' },
          }),
        );
      }
    });
    const client = new RuntimeClient({
      transport: transport(connection),
      clientInfo: clientInfo(),
    });
    await expect(
      client.requestApp('app/release/status', {
        schema: 'kite.app.release-status.request.v1',
      }),
    ).resolves.toEqual({
      schema: 'kite.app.release-status.response.v1',
      serverVersion: 'test',
    });
    expect(connection.requests('initialize')).toHaveLength(1);
    await client.close();
  });

  test('fails closed when an App Server identity or required capability does not match', async () => {
    for (const expectedServer of [
      { version: 'expected-version', requiredMethods: [] as const },
      { version: '1', requiredMethods: ['history/list_sessions'] as const },
    ]) {
      const connection = new FakeConnection((message, target) => {
        if (message.method === 'initialize') {
          target.push(result(message.id, initializeResult('wrong-server')));
        }
      });
      const client = new RuntimeClient({
        transport: transport(connection),
        clientInfo: clientInfo(),
        expectedServer,
      });
      await expect(client.connect()).rejects.toMatchObject({ code: 'server_mismatch' });
      expect(client.snapshotStore.getSnapshot().status).toBe('disconnected');
      await client.close();
    }
  });

  test('round-trips private Run queries and original command resources', async () => {
    const run = {
      schema: 'kite.runtime-run.v1' as const,
      sessionId: 'session-1',
      runId: 'run-1',
      phase: 'building' as const,
      status: 'queued' as const,
      createdRevision: 2,
      lastRevision: 2,
      createdAtMs: 100,
    };
    const connection = new FakeConnection((message, target) => {
      if (message.method === 'initialize') {
        target.push(result(message.id, initializeResult('server-runs')));
      }
      if (message.method === 'runtime/command') {
        target.push(
          result(message.id, {
            status: 'applied',
            commandId: message.params.command.commandId,
            sessionId: 'session-1',
            revision: 2,
            resource: { kind: 'run', run },
          }),
        );
      }
      if (message.method === 'runtime/query') {
        target.push(
          result(message.id, {
            status: 'ok',
            queryType: 'list_runs',
            runs: [run],
          }),
        );
      }
    });
    const client = new RuntimeClient({
      transport: transport(connection),
      clientInfo: clientInfo(),
    });
    await client.connect();
    await expect(client.execute(startCommand())).resolves.toMatchObject({
      status: 'applied',
      resource: { kind: 'run', run: { runId: 'run-1', status: 'queued' } },
    });
    await expect(
      client.query({
        schema: 'kite.runtime-query.v1',
        type: 'list_runs',
        sessionId: 'session-1',
        limit: 10,
      }),
    ).resolves.toMatchObject({
      status: 'ok',
      queryType: 'list_runs',
      runs: [{ runId: 'run-1' }],
    });
    await client.close();
  });

  test('correlates RPC responses and rejects pending work on disconnect', async () => {
    const connection = new FakeConnection(async (message, target) => {
      if (message.method === 'initialize')
        target.push(result(message.id, initializeResult('server-1')));
      if (message.method === 'runtime/command') {
        target.push(result('unknown-rpc', { status: 'ok' }));
        target.push(
          result(message.id, {
            status: 'applied',
            commandId: message.params.command.commandId,
            sessionId: 'session-1',
            revision: 2,
          }),
        );
      }
    });
    const client = new RuntimeClient({
      transport: transport(connection),
      clientInfo: clientInfo(),
    });
    await client.connect();
    await expect(client.execute(startCommand())).resolves.toMatchObject({
      status: 'applied',
      revision: 2,
    });

    const pending = client.query({ schema: 'kite.runtime-query.v1', type: 'list_sessions' });
    connection.end();
    await expect(pending).rejects.toMatchObject({ code: 'connection_closed' });
    await client.close();
  });

  test('explicit reconnect increments generation and restores subscriptions without replaying mutations', async () => {
    const first = respondingConnection('server-1');
    const second = respondingConnection('server-2');
    const client = new RuntimeClient({
      transport: transport(first, second),
      clientInfo: clientInfo(),
    });
    await client.connect();
    await client.subscribeHandle({ scope: 'sessions' });
    await client.reconnect();

    expect(client.connectionGeneration).toBe(2);
    expect(first.requests('runtime/command')).toHaveLength(0);
    expect(second.requests('runtime/command')).toHaveLength(0);
    expect(second.requests('runtime/subscribe')).toHaveLength(1);
    expect(client.snapshotStore.getSnapshot().serverInstanceId).toBe('server-2');
    await client.close();
  });

  test('applies index reset atomically and ignores an old connection after reconnect', async () => {
    const first = respondingConnection('server-1');
    const second = respondingConnection('server-2');
    const client = new RuntimeClient({
      transport: transport(first, second),
      clientInfo: clientInfo(),
    });
    let iterator: AsyncIterator<unknown> | undefined;
    try {
      await client.connect();
      iterator = client.subscribe({ spec: { scope: 'sessions' } })[Symbol.asyncIterator]();
      await until(() => first.requests('runtime/subscribe').length === 1);
      await tick();
      first.push(
        subscriptionUpdate(1, {
          type: 'index_reset_begin',
          serverInstanceId: 'server-1',
          generation: 1,
          indexRevision: 3,
        }),
      );
      first.push(
        subscriptionUpdate(1, {
          type: 'session_upsert',
          serverInstanceId: 'server-1',
          generation: 1,
          indexRevision: 3,
          session: session('session-1', 4),
        }),
      );
      first.push(
        subscriptionUpdate(1, {
          type: 'index_reset_end',
          serverInstanceId: 'server-1',
          generation: 1,
          indexRevision: 3,
        }),
      );
      await tick();
      expect((await iterator.next()).value).toMatchObject({ type: 'index_reset_begin' });
      expect((await iterator.next()).value).toMatchObject({
        type: 'session_upsert',
        session: { sessionId: 'session-1', revision: 4 },
      });
      expect((await iterator.next()).value).toMatchObject({ type: 'index_reset_end' });
      expect(client.snapshotStore.getSnapshot().index.ready).toBe(true);
      expect(client.snapshotStore.getSnapshot().sessions['session-1']?.projection.revision).toBe(4);

      await client.reconnect();
      first.push(
        subscriptionUpdate(1, {
          type: 'session_upsert',
          serverInstanceId: 'server-1',
          generation: 1,
          indexRevision: 4,
          session: session('forged-session', 99),
        }),
      );
      await tick();
      expect(client.snapshotStore.getSnapshot().sessions['forged-session']).toBeUndefined();
    } finally {
      try {
        await iterator?.return?.();
      } finally {
        await client.close();
      }
    }
  });

  test('does not let a previous connection subscription identity accept messages on its replacement', async () => {
    const first = respondingConnection('server-1');
    let deferredSubscribe: Request | undefined;
    const second = new FakeConnection((message, target) => {
      if (message.method === 'initialize') {
        target.push(result(message.id, initializeResult('server-2')));
        return;
      }
      if (message.method === 'runtime/subscribe') deferredSubscribe = message;
      if (message.method === 'runtime/unsubscribe')
        target.push(result(message.id, { unsubscribed: true }));
    });
    const client = new RuntimeClient({
      transport: transport(first, second),
      clientInfo: clientInfo(),
    });
    const iterator = client
      .subscribe({ spec: { scope: 'session', sessionId: 'session-1' } })
      [Symbol.asyncIterator]();
    await until(() => first.requests('runtime/subscribe').length === 1);
    await tick();

    const reconnecting = client.reconnect();
    await until(() => second.requests('runtime/subscribe').length === 1);
    // The server is allowed to reuse a subscription id and remote generation.
    // The local connection generation is the additional anti-stale guard.
    second.push(
      subscriptionUpdate(1, {
        type: 'notification',
        durability: 'durable',
        sessionId: 'forged-session',
        revision: 1,
        session: session('forged-session', 1),
      }),
    );
    await tick();
    expect(client.snapshotStore.getSnapshot().sessions['forged-session']).toBeUndefined();

    second.push(result(deferredSubscribe!.id, { subscriptionId: 'subscription-1', generation: 1 }));
    await reconnecting;
    second.push(
      subscriptionUpdate(1, {
        type: 'notification',
        durability: 'durable',
        sessionId: 'session-1',
        revision: 1,
        session: session('session-1', 1),
      }),
    );
    await expect(iterator.next()).resolves.toMatchObject({
      value: { sessionId: 'session-1', revision: 1 },
    });
    await iterator.return?.();
    await client.close();
  });

  test('structurally implements RuntimeAccess with independently returnable streams', async () => {
    const connection = respondingConnection('server-1');
    const client: RuntimeAccess = new RuntimeClient({
      transport: transport(connection),
      clientInfo: clientInfo(),
    });
    const iterator = client.subscribe({ spec: { scope: 'sessions' } })[Symbol.asyncIterator]();
    await until(() => connection.requests('runtime/subscribe').length === 1);
    await tick();
    await iterator.return?.();
    expect(connection.requests('runtime/unsubscribe')).toHaveLength(1);
    await (client as RuntimeClient).close();
  });

  test('binds a subscribe ack before an immediately following initial notification', async () => {
    const connection = new FakeConnection((message, target) => {
      if (message.method === 'initialize') {
        target.push(result(message.id, initializeResult('server-1')));
        return;
      }
      if (message.method === 'runtime/subscribe') {
        target.push(result(message.id, { subscriptionId: 'subscription-1', generation: 1 }));
        target.push(
          subscriptionUpdate(1, {
            type: 'notification',
            durability: 'durable',
            sessionId: 'session-1',
            revision: 1,
            session: session('session-1', 1),
          }),
        );
        target.push(
          subscriptionUpdate(1, {
            type: 'ready',
            sessionId: 'session-1',
            revision: 1,
          }),
        );
      }
      if (message.method === 'runtime/unsubscribe') {
        target.push(result(message.id, { unsubscribed: true }));
      }
    });
    const client = new RuntimeClient({
      transport: transport(connection),
      clientInfo: clientInfo(),
    });
    const iterator = client
      .subscribe({ spec: { scope: 'session', sessionId: 'session-1' } })
      [Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      value: { durability: 'durable', sessionId: 'session-1', revision: 1 },
    });
    await until(() => client.snapshotStore.getSnapshot().sessions['session-1']?.ready === true);
    await iterator.return?.();
    await client.close();
  });

  test('reconstructs a complete ephemeral RuntimeAccess notification from the closed Protocol event', async () => {
    const connection = respondingConnection('server-1');
    const client = new RuntimeClient({
      transport: transport(connection),
      clientInfo: clientInfo(),
    });
    const iterator = client
      .subscribe({ spec: { scope: 'session', sessionId: 'session-1', includeEphemeral: true } })
      [Symbol.asyncIterator]();
    await until(() => connection.requests('runtime/subscribe').length === 1);
    await tick();
    connection.push(
      subscriptionUpdate(1, {
        type: 'notification',
        durability: 'ephemeral',
        sessionId: 'session-1',
        workId: 'work-1',
        turnId: 'turn-1',
        actorId: 'actor-1',
        attemptId: 'attempt-1',
        compositionRevision: 'composition-1',
        streamId: 'stream-1',
        sequence: 9,
        event: {
          type: 'run.terminal',
          runId: 'run-1',
          status: 'failed',
          outcome: {
            status: 'resource_saturated',
            reasonCode: 'queue_exhausted',
            safeRetry: true,
            recoveryEntry: 'reconcile',
          },
        },
      }),
    );
    expect((await iterator.next()).value).toMatchObject({
      schema: 'kite.runtime-notification.v1',
      durability: 'ephemeral',
      sessionId: 'session-1',
      workId: 'work-1',
      turnId: 'turn-1',
      actorId: 'actor-1',
      attemptId: 'attempt-1',
      compositionRevision: 'composition-1',
      streamId: 'stream-1',
      sequence: 9,
      event: {
        type: 'run.terminal',
        outcome: { reasonCode: 'queue_exhausted', recoveryEntry: 'reconcile' },
      },
    });
    expect(Object.values(client.snapshotStore.getSnapshot().streams)[0]).toMatchObject({
      compositionRevision: 'composition-1',
      event: { type: 'run.terminal', runId: 'run-1' },
    });
    await iterator.return?.();
    await client.close();
  });

  test('evicts queued ephemeral notifications before a durable subscription fact', async () => {
    const connection = respondingConnection('server-1');
    const client = new RuntimeClient({
      transport: transport(connection),
      clientInfo: clientInfo(),
    });
    const iterator = client
      .subscribe({ spec: { scope: 'session', sessionId: 'session-1', includeEphemeral: true } })
      [Symbol.asyncIterator]();
    await until(() => connection.requests('runtime/subscribe').length === 1);
    await tick();
    for (let sequence = 1; sequence <= 256; sequence += 1) {
      connection.push(ephemeralUpdate(sequence));
    }
    connection.push(
      subscriptionUpdate(1, {
        type: 'notification',
        durability: 'durable',
        sessionId: 'session-1',
        revision: 2,
        session: session('session-1', 2),
      }),
    );
    await until(
      () => client.snapshotStore.getSnapshot().sessions['session-1']?.projection.revision === 2,
      600,
    );
    expect((await iterator.next()).value).toMatchObject({
      durability: 'durable',
      sessionId: 'session-1',
      revision: 2,
    });
    expect(connection.requests('runtime/unsubscribe')).toHaveLength(0);
    await iterator.return?.();
    await client.close();
  });

  test('fails closed and releases the remote subscription when durable-only backlog overflows', async () => {
    const connection = respondingConnection('server-1');
    const client = new RuntimeClient({
      transport: transport(connection),
      clientInfo: clientInfo(),
    });
    const iterator = client
      .subscribe({ spec: { scope: 'session', sessionId: 'session-1' } })
      [Symbol.asyncIterator]();
    await until(() => connection.requests('runtime/subscribe').length === 1);
    await tick();
    for (let revision = 1; revision <= 257; revision += 1) {
      connection.push(
        subscriptionUpdate(1, {
          type: 'notification',
          durability: 'durable',
          sessionId: 'session-1',
          revision,
          session: session('session-1', revision),
        }),
      );
    }
    await until(() => connection.requests('runtime/unsubscribe').length === 1, 600);
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    await client.close();
  });
});

type Request = Extract<RuntimeProtocolMessage, { readonly id: string; readonly method: string }>;

class FakeConnection implements RuntimeClientConnection {
  readonly #incoming = new AsyncQueue<unknown>();
  readonly sent: RuntimeProtocolMessage[] = [];
  readonly #onSend: (message: Request, target: FakeConnection) => Promise<void> | void;
  #closed = false;

  constructor(onSend: (message: Request, target: FakeConnection) => Promise<void> | void) {
    this.#onSend = onSend;
  }

  async send(message: RuntimeProtocolMessage): Promise<void> {
    if (this.#closed) throw new Error('closed');
    this.sent.push(message);
    if ('id' in message && typeof message.id === 'string' && 'method' in message) {
      await this.#onSend(message, this);
    }
  }

  messages(): AsyncIterable<unknown> {
    return this.#incoming;
  }
  async close(): Promise<void> {
    this.end();
  }
  push(message: unknown): void {
    this.#incoming.push(message);
  }
  end(): void {
    if (!this.#closed) {
      this.#closed = true;
      this.#incoming.close();
    }
  }
  requests(method: string): readonly Request[] {
    return this.sent.filter(
      (message): message is Request =>
        'id' in message &&
        typeof message.id === 'string' &&
        'method' in message &&
        message.method === method,
    );
  }
}

class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  readonly #waiters = new Set<(value: IteratorResult<T>) => void>();
  #closed = false;
  push(value: T): void {
    const waiter = this.#waiters.values().next().value as
      | ((result: IteratorResult<T>) => void)
      | undefined;
    if (waiter) {
      this.#waiters.delete(waiter);
      waiter({ done: false, value });
      return;
    }
    this.#items.push(value);
  }
  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters) waiter({ done: true, value: undefined });
    this.#waiters.clear();
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.#items.shift();
        if (value !== undefined) return Promise.resolve({ done: false, value });
        if (this.#closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise<IteratorResult<T>>((resolve) => this.#waiters.add(resolve));
      },
    };
  }
}

function respondingConnection(serverInstanceId: string): FakeConnection {
  return new FakeConnection((message, target) => {
    if (message.method === 'initialize')
      target.push(result(message.id, initializeResult(serverInstanceId)));
    if (message.method === 'runtime/subscribe')
      target.push(result(message.id, { subscriptionId: 'subscription-1', generation: 1 }));
    if (message.method === 'runtime/unsubscribe')
      target.push(result(message.id, { unsubscribed: true }));
  });
}

function transport(...connections: readonly FakeConnection[]): RuntimeClientTransport {
  let offset = 0;
  return {
    connect: async () => {
      const connection = connections[offset++];
      if (!connection) throw new Error('unexpected connection');
      return connection;
    },
  };
}

function result(id: string, value: object): object {
  return { jsonrpc: '2.0', id, result: value };
}
function initializeResult(instanceId: string): object {
  return {
    protocolVersion: 1,
    protocolSchema: 'kite.runtime-protocol.v1',
    serverInfo: { version: '1', instanceId },
    capabilities: {
      methods: [
        'initialize',
        'runtime/command',
        'runtime/query',
        'runtime/subscribe',
        'runtime/unsubscribe',
        'server/ping',
      ],
      subscriptions: ['session', 'sessions'],
    },
    limits: {
      maxMessageBytes: 1024,
      maxDepth: 8,
      maxInFlightRequests: 8,
      maxSubscriptions: 8,
      maxOutboundMessages: 8,
    },
  };
}
function clientInfo() {
  return { name: 'test-client', version: '1', instanceId: 'client-test-1' };
}
function startCommand() {
  return {
    schema: 'kite.runtime-command.v1' as const,
    commandId: 'command-1',
    type: 'start_turn' as const,
    sessionId: 'session-1',
    expectedRevision: 1,
    input: 'continue',
  };
}
function session(sessionId: string, revision: number) {
  return {
    schema: 'kite.runtime-projection.v1' as const,
    sessionId,
    revision,
    lifecycle: 'open' as const,
    sessionCommandGrantCount: 0,
    interactionQueue: { revision, interactions: [] },
  };
}
function subscriptionUpdate(generation: number, message: object): object {
  return {
    jsonrpc: '2.0',
    method: 'runtime/subscription',
    params: { subscriptionId: 'subscription-1', generation, message },
  };
}
function ephemeralUpdate(sequence: number): object {
  return subscriptionUpdate(1, {
    type: 'notification',
    durability: 'ephemeral',
    sessionId: 'session-1',
    workId: 'work-1',
    turnId: 'turn-1',
    actorId: 'actor-1',
    attemptId: 'attempt-1',
    compositionRevision: 'composition-1',
    streamId: 'stream-1',
    sequence,
    event: {
      type: 'model.text_delta',
      requestId: 'request-ephemeral-update',
      text: `delta-${sequence}`,
    },
  });
}
async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
async function until(predicate: () => boolean, maxAttempts = 20): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (predicate()) return;
    await tick();
  }
  throw new Error('condition was not reached');
}
