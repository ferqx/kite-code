import { afterEach, describe, expect, test } from 'bun:test';
import { createConnection } from 'node:net';
import type {
  RuntimeAccess,
  RuntimeAccessNotification,
  RuntimeCommand,
  RuntimeQuery,
  RuntimeSubscription,
} from '@kite-ai/runtime-contract';
import { RuntimeServer, type RuntimeServerAdmissionPort } from '@kite-ai/runtime-server';
import {
  createDevelopmentLoopbackCarrier,
  type DevelopmentLoopbackCarrier,
} from '#kite-cli/carrier/development-loopback-carrier';

const carriers: DevelopmentLoopbackCarrier[] = [];
const SOCKET_DEADLINE_MS = 1_000;

afterEach(async () => {
  await Promise.all(carriers.splice(0).map((carrier) => carrier.close()));
});

describe('development loopback WebSocket carrier', () => {
  test('binds only exact loopback Host/Origin, consumes bootstrap once, and returns hardened no-CORS responses', async () => {
    const carrier = createCarrier({
      requestIp: (request) => ({ address: request.headers.get('x-test-ip') ?? '127.0.0.1' }),
    });
    const headers = { origin: carrier.origin };

    const unauthorized = await fetch(`${carrier.origin}/_kite/bootstrap`, {
      method: 'POST',
      headers,
    });
    expect(unauthorized.status).toBe(401);
    expectSecurityHeaders(unauthorized);
    expect(unauthorized.headers.get('access-control-allow-origin')).toBeNull();

    const wrongOrigin = await fetch(`${carrier.origin}/_kite/bootstrap`, {
      method: 'POST',
      headers: {
        authorization: authorization(carrier.bootstrapBearer),
        origin: 'http://localhost:1',
      },
    });
    expect(wrongOrigin.status).toBe(403);

    expect(await rawStatus(carrier, 'localhost:1')).toBe(403);

    const query = await fetch(`${carrier.origin}/_kite/bootstrap?token=secret-value`, {
      method: 'POST',
      headers: { authorization: authorization(carrier.bootstrapBearer), origin: carrier.origin },
    });
    expect(query.status).toBe(403);
    expectSecurityHeaders(query);
    expect(await query.text()).not.toContain('secret-value');

    const nonEmptyBody = await fetch(`${carrier.origin}/_kite/bootstrap`, {
      method: 'POST',
      headers: { authorization: authorization(carrier.bootstrapBearer), origin: carrier.origin },
      body: 'token=secret-value',
    });
    expect(nonEmptyBody.status).toBe(403);
    expectSecurityHeaders(nonEmptyBody);
    expect(await nonEmptyBody.text()).not.toContain('secret-value');

    const chunked = await rawRequest(
      carrier,
      [
        'POST /_kite/bootstrap HTTP/1.1',
        `Host: ${new URL(carrier.origin).host}`,
        `Origin: ${carrier.origin}`,
        `Authorization: ${authorization(carrier.bootstrapBearer)}`,
        'Transfer-Encoding: chunked',
        'Connection: close',
        '',
        '12',
        'token=secret-value',
        '0',
        '',
        '',
      ].join('\r\n'),
    );
    expect(chunked.status).toBe(403);
    expectRawSecurityHeaders(chunked);
    expect(chunked.body).not.toContain('secret-value');

    const nonLoopback = await fetch(`${carrier.origin}/healthz`, {
      headers: { 'x-test-ip': '192.0.2.1' },
    });
    expect(nonLoopback.status).toBe(403);

    const bootstrap = await bootstrapCarrier(carrier);
    expect(bootstrap.status).toBe(204);
    const cookie = bootstrap.headers.get('set-cookie');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');

    const replay = await fetch(`${carrier.origin}/_kite/bootstrap`, {
      method: 'POST',
      headers: { authorization: authorization(carrier.bootstrapBearer), origin: carrier.origin },
    });
    expect(replay.status).toBe(401);

    const options = await fetch(`${carrier.origin}/rpc`, { method: 'OPTIONS' });
    expect(options.status).toBe(403);
  });

  test('authorizes cookie-bound WebSockets and routes initialize/ping through the injected RuntimeServer', async () => {
    const carrier = createCarrier();
    const bootstrap = await bootstrapCarrier(carrier);
    const socket = await openSocket(carrier, cookieHeader(bootstrap));
    const messages = new SocketMessages(socket);

    socket.send(JSON.stringify(initializeRequest()));
    expect(await messages.next()).toMatchObject({
      id: 'initialize',
      result: { protocolVersion: 1 },
    });
    socket.send(JSON.stringify(pingRequest()));
    expect(await messages.next()).toMatchObject({ id: 'ping', result: { status: 'ok' } });

    socket.close();
  });

  test('rejects unauthenticated, wrong-cookie, wrong-Origin, and Authorization WebSocket handshakes without opening Runtime connections', async () => {
    const runtimeServer = server();
    const carrier = track(createDevelopmentLoopbackCarrier({ server: runtimeServer }));
    const bootstrap = await bootstrapCarrier(carrier);
    const cookie = cookieHeader(bootstrap);

    await expectSocketRejected(carrier, { Origin: carrier.origin });
    await expectSocketRejected(carrier, {
      Cookie: 'kite_dev_session=wrong',
      Origin: carrier.origin,
    });
    await expectSocketRejected(carrier, { Cookie: cookie, Origin: 'http://localhost:1' });
    await expectSocketRejected(carrier, {
      Cookie: cookie,
      Origin: carrier.origin,
      Authorization: authorization('not-a-websocket-credential'),
    });
    await eventually(() => runtimeServer.connectionCount === 0);
  });

  test('rejects malformed, binary, and oversized frames without leaking frame content', async () => {
    const malformedCarrier = createCarrier();
    const malformedSocket = await openSocket(
      malformedCarrier,
      cookieHeader(await bootstrapCarrier(malformedCarrier)),
    );
    const malformedMessages = new SocketMessages(malformedSocket);
    malformedSocket.send('{not json secret-value}');
    expect(await malformedMessages.next()).toMatchObject({
      id: null,
      error: { code: -32700, data: { code: 'parse_error' } },
    });
    malformedSocket.close();

    const binaryCarrier = createCarrier();
    const binary = await openSocket(
      binaryCarrier,
      cookieHeader(await bootstrapCarrier(binaryCarrier)),
    );
    const binaryClose = closed(binary);
    binary.send(new Uint8Array([1, 2, 3]));
    expect((await binaryClose).code).toBe(1003);

    const oversizedCarrier = createCarrier();
    const oversized = await openSocket(
      oversizedCarrier,
      cookieHeader(await bootstrapCarrier(oversizedCarrier)),
    );
    const oversizedClose = closed(oversized);
    oversized.send(JSON.stringify({ value: 'x'.repeat(1_048_577) }));
    expect((await oversizedClose).code).toBe(1009);
  });

  test('isolates a rejected connection and shuts down surviving sockets with 1012 without disposing Runtime ownership', async () => {
    const runtimeServer = server();
    const carrier = track(createDevelopmentLoopbackCarrier({ server: runtimeServer }));
    const first = await openSocket(carrier, cookieHeader(await bootstrapCarrier(carrier)));
    const firstClose = closed(first);
    first.send(new Uint8Array([1]));
    expect((await firstClose).code).toBe(1003);

    // A rejected connection never drains or disposes the shared injected core.
    expect(runtimeServer.connectionCount).toBe(0);

    // A restart requires fresh bootstrap state, so use a second carrier/server
    // to prove the controlled 1012 lifecycle rather than retaining auth state.
    const restartServer = server();
    const restartCarrier = track(createDevelopmentLoopbackCarrier({ server: restartServer }));
    const socket = await openSocket(
      restartCarrier,
      cookieHeader(await bootstrapCarrier(restartCarrier)),
    );
    const closing = closed(socket);
    await restartCarrier.close();
    expect((await closing).code).toBe(1012);
    expect(restartServer.connectionCount).toBe(0);
  });

  test('closes a heartbeat-expired socket and releases its RuntimeServer connection', async () => {
    let now = 0;
    const runtimeServer = server();
    const carrier = track(
      createDevelopmentLoopbackCarrier({
        server: runtimeServer,
        now: () => now,
        limits: { heartbeatIntervalMs: 5, heartbeatDeadlineMs: 10, drainDeadlineMs: 50 },
      }),
    );
    const socket = await openSocket(carrier, cookieHeader(await bootstrapCarrier(carrier)));
    expect(runtimeServer.connectionCount).toBe(1);
    const closing = closed(socket);
    now = 10;
    expect((await closing).code).toBe(1001);
    await eventually(() => runtimeServer.connectionCount === 0);
  });

  test('bounds a stalled logical connection without draining the shared RuntimeServer', async () => {
    const runtimeServer = server();
    let opens = 0;
    const serverWithOneStalledConnection = {
      open(connection: AsyncIterable<unknown>) {
        opens += 1;
        if (opens === 1) return stalledConnection();
        return runtimeServer.open(connection as never);
      },
      beginDraining: () => runtimeServer.beginDraining(),
    } as unknown as RuntimeServer;
    const carrier = track(
      createDevelopmentLoopbackCarrier({
        server: serverWithOneStalledConnection,
        limits: {
          maxLogicalQueueMessages: 1,
          heartbeatIntervalMs: 50,
          heartbeatDeadlineMs: 150,
          drainDeadlineMs: 50,
        },
      }),
    );
    const bootstrap = await bootstrapCarrier(carrier);
    const first = await openSocket(carrier, cookieHeader(bootstrap));
    const firstClose = closed(first);
    first.send(JSON.stringify(initializeRequest('stalled-init')));
    first.send(JSON.stringify(pingRequest('stalled-ping')));
    expect((await firstClose).code).toBe(1013);

    const second = await openSocket(carrier, cookieHeader(bootstrap));
    const messages = new SocketMessages(second);
    second.send(JSON.stringify(initializeRequest('fresh-init')));
    expect(await messages.next()).toMatchObject({
      id: 'fresh-init',
      result: { protocolVersion: 1 },
    });
    second.send(JSON.stringify(pingRequest('fresh-ping')));
    expect(await messages.next()).toMatchObject({ id: 'fresh-ping', result: { status: 'ok' } });
    expect(runtimeServer.connectionCount).toBe(1);
    second.close();
  });
});

function createCarrier(
  options: {
    readonly requestIp?: (
      request: Request,
      server: Bun.Server<unknown>,
    ) => Readonly<{ address: string }> | null;
  } = {},
): DevelopmentLoopbackCarrier {
  const carrier = createDevelopmentLoopbackCarrier({
    server: server(),
    requestIp: options.requestIp as
      | ((
          request: Request,
          server: Bun.Server<{ readonly session: never }>,
        ) => Readonly<{ address: string }> | null)
      | undefined,
    limits: { heartbeatIntervalMs: 50, heartbeatDeadlineMs: 150, drainDeadlineMs: 50 },
  });
  return track(carrier);
}

function track(carrier: DevelopmentLoopbackCarrier): DevelopmentLoopbackCarrier {
  carriers.push(carrier);
  return carrier;
}

function server(): RuntimeServer {
  return new RuntimeServer(
    { runtime: new FakeRuntime(), admission: allowAdmission },
    { serverInfo: { version: 'test', instanceId: 'development-loopback' } },
  );
}

const allowAdmission: RuntimeServerAdmissionPort = {
  authorize: async () => ({ allowed: true, workspace: '/trusted/workspace' }),
};

async function bootstrapCarrier(carrier: DevelopmentLoopbackCarrier): Promise<Response> {
  return fetch(`${carrier.origin}/_kite/bootstrap`, {
    method: 'POST',
    headers: { authorization: authorization(carrier.bootstrapBearer), origin: carrier.origin },
  });
}

function authorization(token: string): string {
  return `Kite-Dev-Bootstrap ${token}`;
}

function cookieHeader(response: Response): string {
  const cookie = response.headers.get('set-cookie');
  if (!cookie) throw new Error('bootstrap response omitted session cookie');
  return cookie.split(';', 1)[0] ?? '';
}

async function rawStatus(carrier: DevelopmentLoopbackCarrier, host: string): Promise<number> {
  const response = await rawRequest(
    carrier,
    `GET /healthz HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`,
  );
  return response.status;
}

type RawHttpResponse = Readonly<{
  status: number;
  headers: ReadonlyMap<string, string>;
  body: string;
}>;

async function rawRequest(
  carrier: DevelopmentLoopbackCarrier,
  request: string,
): Promise<RawHttpResponse> {
  const port = Number.parseInt(new URL(carrier.origin).port, 10);
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const chunks: Buffer[] = [];
    const timer = setTimeout(
      () => finish(() => reject(new Error('raw loopback HTTP deadline exceeded'))),
      SOCKET_DEADLINE_MS,
    );
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      socket.destroy();
      settle();
    };
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.once('error', (error) => finish(() => reject(error)));
    socket.once('connect', () => {
      socket.end(request);
    });
    socket.once('end', () => {
      const response = parseRawResponse(Buffer.concat(chunks).toString('utf8'));
      if (!response) finish(() => reject(new Error('raw loopback HTTP omitted a status')));
      else finish(() => resolve(response));
    });
  });
}

function parseRawResponse(value: string): RawHttpResponse | undefined {
  const [head, body = ''] = value.split('\r\n\r\n', 2);
  if (!head) return undefined;
  const [statusLine, ...headerLines] = head.split('\r\n');
  const status = /^HTTP\/1\.1 (\d{3})/u.exec(statusLine ?? '')?.[1];
  if (!status) return undefined;
  const headers = new Map<string, string>();
  for (const line of headerLines) {
    const separator = line.indexOf(':');
    if (separator > 0)
      headers.set(line.slice(0, separator).toLowerCase(), line.slice(separator + 1).trim());
  }
  return { status: Number.parseInt(status, 10), headers, body };
}

async function openSocket(carrier: DevelopmentLoopbackCarrier, cookie: string): Promise<WebSocket> {
  return openSocketWithHeaders(carrier, { Cookie: cookie, Origin: carrier.origin });
}

async function openSocketWithHeaders(
  carrier: DevelopmentLoopbackCarrier,
  headers: Record<string, string>,
): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(carrier.rpcUrl, {
      headers,
    } as unknown as string[]);
    const timer = setTimeout(
      () => finish(() => reject(new Error('loopback WebSocket open deadline exceeded'))),
      SOCKET_DEADLINE_MS,
    );
    const opened = () => finish(() => resolve(socket));
    const failed = () => finish(() => reject(new Error('loopback WebSocket failed to open')));
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      socket.removeEventListener('open', opened);
      socket.removeEventListener('error', failed);
      settle();
    };
    socket.addEventListener('open', opened, { once: true });
    socket.addEventListener('error', failed, { once: true });
  });
}

async function expectSocketRejected(
  carrier: DevelopmentLoopbackCarrier,
  headers: Record<string, string>,
): Promise<void> {
  const socket = new WebSocket(carrier.rpcUrl, { headers } as unknown as string[]);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => finish(() => reject(new Error('loopback WebSocket rejection deadline exceeded'))),
      SOCKET_DEADLINE_MS,
    );
    const opened = () => finish(() => reject(new Error('unauthorized loopback WebSocket opened')));
    const rejected = () => finish(resolve);
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      socket.removeEventListener('open', opened);
      socket.removeEventListener('error', rejected);
      socket.removeEventListener('close', rejected);
      settle();
    };
    socket.addEventListener('open', opened, { once: true });
    socket.addEventListener('error', rejected, { once: true });
    socket.addEventListener('close', rejected, { once: true });
  });
}

function closed(socket: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => finish(() => reject(new Error('loopback WebSocket close deadline exceeded'))),
      SOCKET_DEADLINE_MS,
    );
    const listener = (event: CloseEvent) => finish(() => resolve(event));
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      socket.removeEventListener('close', listener);
      settle();
    };
    socket.addEventListener('close', listener, { once: true });
  });
}

function initializeRequest(id = 'initialize') {
  return {
    jsonrpc: '2.0' as const,
    id,
    method: 'initialize' as const,
    params: {
      protocolVersion: 1,
      clientInfo: { name: 'test', version: '1', instanceId: 'socket' },
    },
  };
}

function pingRequest(id = 'ping') {
  return { jsonrpc: '2.0' as const, id, method: 'server/ping' as const, params: {} };
}

function expectSecurityHeaders(response: Response): void {
  expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
  expect(response.headers.get('x-frame-options')).toBe('DENY');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  expect(response.headers.get('cache-control')).toBe('no-store');
}

function expectRawSecurityHeaders(response: RawHttpResponse): void {
  expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
  expect(response.headers.get('x-frame-options')).toBe('DENY');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  expect(response.headers.get('cache-control')).toBe('no-store');
}

function stalledConnection() {
  return {
    connectionId: 'stalled',
    state: 'active' as const,
    close: async () => undefined,
    beginDraining: async () => undefined,
  };
}

async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + SOCKET_DEADLINE_MS;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('eventual loopback condition deadline exceeded');
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}

class SocketMessages {
  readonly #messages: unknown[] = [];
  readonly #waiters = new Set<(value: unknown) => void>();

  constructor(socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      const value = JSON.parse(String(event.data)) as unknown;
      const waiter = this.#waiters.values().next().value;
      if (waiter) {
        this.#waiters.delete(waiter);
        waiter(value);
      } else {
        this.#messages.push(value);
      }
    });
  }

  next(): Promise<unknown> {
    const value = this.#messages.shift();
    if (value !== undefined) return Promise.resolve(value);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiters.delete(waiter);
        reject(new Error('loopback WebSocket message deadline exceeded'));
      }, SOCKET_DEADLINE_MS);
      const waiter = (message: unknown) => {
        clearTimeout(timer);
        resolve(message);
      };
      this.#waiters.add(waiter);
    });
  }
}

class FakeRuntime implements RuntimeAccess {
  command(_command: RuntimeCommand) {
    return Promise.resolve({
      status: 'applied' as const,
      commandId: 'unused',
      sessionId: 'unused',
      revision: 1,
    });
  }

  query(_query: RuntimeQuery) {
    return Promise.resolve({
      status: 'ok' as const,
      queryType: 'list_sessions' as const,
      sessions: [],
    });
  }

  subscribe(_subscription: RuntimeSubscription): AsyncIterable<RuntimeAccessNotification> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<RuntimeAccessNotification>>(() => undefined),
      }),
    };
  }
}
