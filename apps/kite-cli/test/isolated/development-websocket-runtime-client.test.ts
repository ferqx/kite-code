import { afterEach, describe, expect, test } from 'bun:test';
import { RuntimeClient } from '@kite-ai/runtime-client';
import type {
  RuntimeAccess,
  RuntimeAccessNotification,
  RuntimeCommand,
  RuntimeNotification,
  RuntimeQuery,
  RuntimeSessionProjection,
  RuntimeSubscription,
} from '@kite-ai/runtime-contract';
import { RuntimeServer, type RuntimeServerAdmissionPort } from '@kite-ai/runtime-server';
import type { RuntimeWebSocketLike } from '#kite-cli/carrier/bun-websocket-transport';
import { BunWebSocketRuntimeClientTransport } from '#kite-cli/carrier/bun-websocket-transport';
import {
  createDevelopmentLoopbackCarrier,
  type DevelopmentLoopbackCarrier,
} from '#kite-cli/carrier/development-loopback-carrier';

const DEADLINE_MS = 1_500;
const carriers: DevelopmentLoopbackCarrier[] = [];

afterEach(async () => {
  await within(Promise.all(carriers.splice(0).map((carrier) => settle(carrier.close()))));
});

describe('development WebSocket RuntimeClient qualification', () => {
  test('bootstraps a cookie, initializes, queries, and reaches session subscription ready', async () => {
    const runtime = new ControllableRuntime('server-one', [session('session-one', 1)]);
    const carrier = track(createCarrier(runtime, 'server-one'));
    let cookie = await bootstrapCookie(carrier);
    const client = createClient(
      () => carrier.rpcUrl,
      () => cookie,
      () => carrier.origin,
      'first',
    );
    try {
      await within(client.connect());
      expect(client.snapshotStore.getSnapshot()).toMatchObject({
        status: 'active',
        serverInstanceId: 'server-one',
      });
      await expect(
        within(client.query({ schema: 'kite.runtime-query.v1', type: 'list_sessions' })),
      ).resolves.toMatchObject({
        status: 'ok',
        queryType: 'list_sessions',
        sessions: [{ sessionId: 'session-one', revision: 1 }],
      });

      const iterator = client
        .subscribe({ spec: { scope: 'session', sessionId: 'session-one' } })
        [Symbol.asyncIterator]();
      await expect(within(iterator.next())).resolves.toMatchObject({
        done: false,
        value: { durability: 'durable', sessionId: 'session-one', revision: 1 },
      });
      await waitFor(
        () => client.snapshotStore.getSnapshot().sessions['session-one']?.ready === true,
      );
      expect(runtime.subscriptionCount).toBe(1);
      await returnIterator(iterator);
    } finally {
      await settle(client.close());
      // Keep the mutable binding referenced by the injected factory live until close.
      cookie = '';
    }
  });

  test('reconnects one RuntimeClient to a restarted carrier and atomically replaces index state', async () => {
    const firstRuntime = new ControllableRuntime('server-old', [
      session('legacy-session', 1),
      session('tracked-session', 1),
    ]);
    let carrier = track(createCarrier(firstRuntime, 'server-old'));
    let cookie = await bootstrapCookie(carrier);
    const client = createClient(
      () => carrier.rpcUrl,
      () => cookie,
      () => carrier.origin,
      'restart',
    );
    const snapshots: ReturnType<RuntimeClient['snapshotStore']['getSnapshot']>[] = [];
    const unobserve = client.snapshotStore.subscribe(() =>
      snapshots.push(client.snapshotStore.getSnapshot()),
    );
    try {
      await within(client.connect());
      const index = client.subscribe({ spec: { scope: 'sessions' } })[Symbol.asyncIterator]();
      const sessionStream = client
        .subscribe({ spec: { scope: 'session', sessionId: 'tracked-session' } })
        [Symbol.asyncIterator]();
      await waitFor(() => firstRuntime.subscriptionCount === 2);
      await waitFor(() => client.snapshotStore.getSnapshot().index.ready);
      await expect(within(sessionStream.next())).resolves.toMatchObject({
        value: { sessionId: 'tracked-session', revision: 1 },
      });
      expect(Object.keys(client.snapshotStore.getSnapshot().sessions).sort()).toEqual([
        'legacy-session',
        'tracked-session',
      ]);

      await within(carrier.close());
      await waitFor(() => firstRuntime.subscriptionCount === 0);
      firstRuntime.publish(indexUpsert('server-old', session('stale-old-socket', 99), 99));

      const secondRuntime = new ControllableRuntime('server-new', [
        session('restarted-session', 2),
        session('tracked-session', 7),
      ]);
      carrier = track(createCarrier(secondRuntime, 'server-new'));
      cookie = await bootstrapCookie(carrier);
      await within(client.reconnect());

      await waitFor(
        () =>
          client.snapshotStore.getSnapshot().connectionGeneration === 2 &&
          client.snapshotStore.getSnapshot().index.ready &&
          secondRuntime.subscriptionCount === 2,
      );
      await expect(within(sessionStream.next())).resolves.toMatchObject({
        value: { sessionId: 'tracked-session', revision: 7 },
      });
      const snapshot = client.snapshotStore.getSnapshot();
      expect(snapshot).toMatchObject({
        connectionGeneration: 2,
        serverInstanceId: 'server-new',
        index: { ready: true },
      });
      expect(Object.keys(snapshot.sessions).sort()).toEqual([
        'restarted-session',
        'tracked-session',
      ]);
      expect(snapshot.sessions['stale-old-socket']).toBeUndefined();
      expect(
        snapshots
          .filter((candidate) => candidate.connectionGeneration === 2 && candidate.index.ready)
          .every(
            (candidate) =>
              JSON.stringify(Object.keys(candidate.sessions).sort()) ===
              JSON.stringify(['restarted-session', 'tracked-session']),
          ),
      ).toBe(true);

      await returnIterator(index);
      await returnIterator(sessionStream);
    } finally {
      unobserve();
      await settle(client.close());
    }
  });

  test('isolates an unread connection while a normal client keeps querying, pinging, and receiving notifications', async () => {
    const runtime = new ControllableRuntime('server-isolation', [session('shared-session', 1)]);
    const carrier = track(
      createCarrier(runtime, 'server-isolation', {
        maxLogicalQueueMessages: 2,
        drainDeadlineMs: 80,
      }),
    );
    const cookie = await bootstrapCookie(carrier);
    const slow = await openSocket(carrier.rpcUrl, cookie, carrier.origin);
    try {
      slow.send(JSON.stringify(initializeRequest('slow-initialize')));
      slow.send(
        JSON.stringify(
          subscribeRequest('slow-subscribe', { scope: 'session', sessionId: 'shared-session' }),
        ),
      );
      await waitFor(() => runtime.subscriptionCount === 1);

      const client = createClient(
        () => carrier.rpcUrl,
        () => cookie,
        () => carrier.origin,
        'fast',
      );
      const control = await openSocket(carrier.rpcUrl, cookie, carrier.origin);
      try {
        const controlMessages = new SocketMessages(control);
        control.send(JSON.stringify(initializeRequest('control-initialize')));
        await expect(within(controlMessages.next())).resolves.toMatchObject({
          id: 'control-initialize',
          result: { protocolVersion: 1 },
        });
        control.send(JSON.stringify(pingRequest('control-ping')));
        await expect(within(controlMessages.next())).resolves.toMatchObject({
          id: 'control-ping',
          result: { status: 'ok' },
        });

        const iterator = client
          .subscribe({ spec: { scope: 'session', sessionId: 'shared-session' } })
          [Symbol.asyncIterator]();
        await expect(within(iterator.next())).resolves.toMatchObject({
          value: { sessionId: 'shared-session', revision: 1 },
        });
        runtime.publish(durable(session('shared-session', 2)));
        await expect(within(iterator.next())).resolves.toMatchObject({
          value: { durability: 'durable', sessionId: 'shared-session', revision: 2 },
        });
        await expect(
          within(client.query({ schema: 'kite.runtime-query.v1', type: 'list_sessions' })),
        ).resolves.toMatchObject({ status: 'ok', queryType: 'list_sessions' });
        expect(runtime.dispatchCount).toBeGreaterThanOrEqual(1);

        const slowClosed = closeEvent(slow);
        slow.close();
        await expect(within(slowClosed)).resolves.toMatchObject({ code: 1000 });
        runtime.publish(durable(session('shared-session', 3)));
        await expect(within(iterator.next())).resolves.toMatchObject({
          value: { durability: 'durable', sessionId: 'shared-session', revision: 3 },
        });
        expect(runtime.cancelCalls).toBe(0);
        expect(runtime.disposeCalls).toBe(0);
        await returnIterator(iterator);
      } finally {
        await closeSocket(control);
        await settle(client.close());
      }
    } finally {
      await closeSocket(slow);
      expect(runtime.cancelCalls).toBe(0);
      expect(runtime.disposeCalls).toBe(0);
    }
  });
});

function createCarrier(
  runtime: ControllableRuntime,
  instanceId: string,
  limits: Parameters<typeof createDevelopmentLoopbackCarrier>[0]['limits'] = {},
): DevelopmentLoopbackCarrier {
  return createDevelopmentLoopbackCarrier({
    server: new RuntimeServer(
      { runtime, admission: allowAdmission },
      { serverInfo: { version: 'qualification', instanceId } },
    ),
    limits: { heartbeatIntervalMs: 200, heartbeatDeadlineMs: 600, ...limits },
  });
}

const allowAdmission: RuntimeServerAdmissionPort = {
  authorize: async () => ({ allowed: true, workspace: '/trusted/workspace' }),
};

function createClient(
  url: () => string,
  cookie: () => string,
  origin: () => string,
  instanceId: string,
): RuntimeClient {
  return new RuntimeClient({
    transport: new BunWebSocketRuntimeClientTransport({
      url,
      connectDeadlineMs: DEADLINE_MS,
      sendDeadlineMs: DEADLINE_MS,
      webSocketFactory: (socketUrl) =>
        new WebSocket(socketUrl, {
          headers: { Cookie: cookie(), Origin: origin() },
        } as unknown as string[]) as unknown as RuntimeWebSocketLike,
    }),
    clientInfo: { name: 'development-websocket-qualification', version: '1', instanceId },
  });
}

function track(carrier: DevelopmentLoopbackCarrier): DevelopmentLoopbackCarrier {
  carriers.push(carrier);
  return carrier;
}

async function bootstrapCookie(carrier: DevelopmentLoopbackCarrier): Promise<string> {
  const response = await within(
    fetch(`${carrier.origin}/_kite/bootstrap`, {
      method: 'POST',
      headers: {
        authorization: `Kite-Dev-Bootstrap ${carrier.bootstrapBearer}`,
        origin: carrier.origin,
      },
    }),
  );
  expect(response.status).toBe(204);
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
  if (!cookie) throw new Error('bootstrap did not return a cookie');
  return cookie;
}

function session(sessionId: string, revision: number): RuntimeSessionProjection {
  return {
    schema: 'kite.runtime-projection.v1',
    sessionId,
    revision,
    lifecycle: 'open',
  };
}

function durable(value: RuntimeSessionProjection): RuntimeNotification {
  return {
    schema: 'kite.runtime-notification.v1',
    durability: 'durable',
    sessionId: value.sessionId,
    revision: value.revision,
    projection: { kind: 'session', session: value },
  };
}

function indexUpsert(
  serverInstanceId: string,
  value: RuntimeSessionProjection,
  indexRevision: number,
): RuntimeAccessNotification {
  return { type: 'session_upsert', serverInstanceId, generation: 1, indexRevision, session: value };
}

class ControllableRuntime implements RuntimeAccess {
  readonly #instanceId: string;
  readonly #sessions: RuntimeSessionProjection[];
  readonly #streams = new Set<RuntimeStream>();
  cancelCalls = 0;
  disposeCalls = 0;
  dispatchCount = 0;

  constructor(instanceId: string, sessions: RuntimeSessionProjection[]) {
    this.#instanceId = instanceId;
    this.#sessions = sessions;
  }

  get subscriptionCount(): number {
    return this.#streams.size;
  }

  command(command: RuntimeCommand) {
    return Promise.resolve({
      status: 'applied' as const,
      commandId: command.commandId,
      sessionId: 'shared-session',
      revision: 1,
    });
  }

  query(query: RuntimeQuery) {
    if (query.type === 'get_session_projection') {
      const found = this.#sessions.find((candidate) => candidate.sessionId === query.sessionId);
      return Promise.resolve(
        found
          ? {
              status: 'ok' as const,
              queryType: query.type,
              revision: found.revision,
              session: found,
            }
          : {
              status: 'not_found' as const,
              queryType: query.type,
              code: 'session_not_found' as const,
            },
      );
    }
    return Promise.resolve({
      status: 'ok' as const,
      queryType: query.type,
      sessions: this.#sessions,
    });
  }

  subscribe(subscription: RuntimeSubscription): AsyncIterable<RuntimeAccessNotification> {
    const spec = subscription.spec;
    let initial: RuntimeAccessNotification[];
    if (spec.scope === 'sessions') {
      initial = indexReset(this.#instanceId, this.#sessions);
    } else {
      const found = this.#sessions.find((candidate) => candidate.sessionId === spec.sessionId);
      initial = found ? [durable(found)] : [];
    }
    const stream = new RuntimeStream(initial, () => this.#streams.delete(stream));
    this.#streams.add(stream);
    return stream;
  }

  publish(notification: RuntimeAccessNotification): void {
    this.dispatchCount += 1;
    for (const stream of this.#streams) stream.push(notification);
  }
}

function indexReset(
  instanceId: string,
  sessions: readonly RuntimeSessionProjection[],
): RuntimeAccessNotification[] {
  return [
    { type: 'index_reset_begin', serverInstanceId: instanceId, generation: 1, indexRevision: 1 },
    ...sessions.map((value) => indexUpsert(instanceId, value, 1)),
    { type: 'index_reset_end', serverInstanceId: instanceId, generation: 1, indexRevision: 1 },
  ];
}

class RuntimeStream implements AsyncIterable<RuntimeAccessNotification> {
  readonly #values: RuntimeAccessNotification[];
  readonly #waiters = new Set<(value: IteratorResult<RuntimeAccessNotification>) => void>();
  readonly #onReturn: () => void;
  #closed = false;

  constructor(values: RuntimeAccessNotification[], onReturn: () => void) {
    this.#values = [...values];
    this.#onReturn = onReturn;
  }

  push(value: RuntimeAccessNotification): void {
    if (this.#closed) return;
    const waiter = this.#waiters.values().next().value as
      | ((result: IteratorResult<RuntimeAccessNotification>) => void)
      | undefined;
    if (waiter) {
      this.#waiters.delete(waiter);
      waiter({ done: false, value });
      return;
    }
    this.#values.push(value);
  }

  [Symbol.asyncIterator](): AsyncIterator<RuntimeAccessNotification> {
    return {
      next: () => {
        const value = this.#values.shift();
        if (value) return Promise.resolve({ done: false as const, value });
        if (this.#closed) return Promise.resolve({ done: true as const, value: undefined });
        return new Promise<IteratorResult<RuntimeAccessNotification>>((resolve) =>
          this.#waiters.add(resolve),
        );
      },
      return: async () => {
        this.close();
        return { done: true, value: undefined };
      },
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#values.length = 0;
    this.#onReturn();
    for (const resolve of this.#waiters) resolve({ done: true, value: undefined });
    this.#waiters.clear();
  }
}

function initializeRequest(id: string) {
  return {
    jsonrpc: '2.0' as const,
    id,
    method: 'initialize' as const,
    params: {
      protocolVersion: 1,
      clientInfo: { name: 'qualification', version: '1', instanceId: id },
    },
  };
}

function subscribeRequest(id: string, subscription: RuntimeSubscription['spec']) {
  return {
    jsonrpc: '2.0' as const,
    id,
    method: 'runtime/subscribe' as const,
    params: { subscription },
  };
}

function pingRequest(id: string) {
  return { jsonrpc: '2.0' as const, id, method: 'server/ping' as const, params: {} };
}

async function openSocket(url: string, cookie: string, origin: string): Promise<WebSocket> {
  return within(
    new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(url, {
        headers: { Cookie: cookie, Origin: origin },
      } as unknown as string[]);
      const opened = () => finish(() => resolve(socket));
      const failed = () => finish(() => reject(new Error('WebSocket failed to open')));
      const timer = setTimeout(
        () => finish(() => reject(new Error('WebSocket open deadline exceeded'))),
        DEADLINE_MS,
      );
      const finish = (settle: () => void) => {
        clearTimeout(timer);
        socket.removeEventListener('open', opened);
        socket.removeEventListener('error', failed);
        settle();
      };
      socket.addEventListener('open', opened, { once: true });
      socket.addEventListener('error', failed, { once: true });
    }),
  );
}

function closeEvent(socket: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve) => socket.addEventListener('close', resolve, { once: true }));
}

async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState >= WebSocket.CLOSING) return;
  const closed = closeEvent(socket);
  socket.close();
  await settle(within(closed));
}

async function returnIterator(iterator: AsyncIterator<RuntimeAccessNotification>): Promise<void> {
  const done: IteratorResult<RuntimeAccessNotification> = { done: true, value: undefined };
  await within(iterator.return?.() ?? Promise.resolve(done));
}

class SocketMessages {
  readonly #values: unknown[] = [];
  readonly #waiters = new Set<(value: unknown) => void>();

  constructor(socket: WebSocket) {
    socket.addEventListener('message', (event) =>
      this.push(JSON.parse(String(event.data)) as unknown),
    );
  }

  next(): Promise<unknown> {
    const value = this.#values.shift();
    if (value !== undefined) return Promise.resolve(value);
    return new Promise((resolve) => this.#waiters.add(resolve));
  }

  #push(value: unknown): void {
    const waiter = this.#waiters.values().next().value as ((message: unknown) => void) | undefined;
    if (waiter) {
      this.#waiters.delete(waiter);
      waiter(value);
      return;
    }
    this.#values.push(value);
  }

  push(value: unknown): void {
    this.#push(value);
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + DEADLINE_MS;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition deadline exceeded');
    await Bun.sleep(5);
  }
}

function within<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    Bun.sleep(DEADLINE_MS).then(() => {
      throw new Error(`operation deadline exceeded after ${DEADLINE_MS}ms`);
    }),
  ]);
}

async function settle(promise: Promise<unknown>): Promise<void> {
  await within(promise).catch(() => undefined);
}
