import { describe, expect, test } from 'bun:test';
import type { RuntimeClientTransport } from '@kite-ai/runtime-client';
import type { RuntimeProtocolMessage } from '@kite-ai/runtime-protocol';
import {
  BunWebSocketRuntimeClientTransport,
  type RuntimeWebSocketLike,
} from '#kite-cli/carrier/bun-websocket-transport';

describe('Bun WebSocket RuntimeClient transport', () => {
  test('opens with the exact bootstrap URL, sends strict JSON, and yields parsed text frames', async () => {
    const socket = new FakeWebSocket();
    let factoryUrl: string | undefined;
    const transport = createTransport((url) => {
      factoryUrl = url;
      return socket;
    });
    const connecting = transport.connect();
    socket.open();
    const connection = await connecting;

    expect(factoryUrl).toBe('ws://127.0.0.1:4317/rpc');
    await connection.send(pingRequest());
    expect(socket.sent).toEqual([JSON.stringify(pingRequest())]);

    const messages = connection.messages()[Symbol.asyncIterator]();
    socket.message(JSON.stringify(pingResponse()));
    expect(await messages.next()).toEqual({ done: false, value: pingResponse() });
  });

  test('waits for buffer capacity, rejects invalid outgoing protocol objects, and bounds send failure', async () => {
    const socket = new FakeWebSocket();
    socket.bufferedAmount = 100;
    const transport = createTransport(() => socket, { maxBufferedAmount: 10, sendDeadlineMs: 50 });
    const opening = transport.connect();
    socket.open();
    const connection = await opening;

    const sending = connection.send(pingRequest());
    await Promise.resolve();
    expect(socket.sent).toHaveLength(0);
    socket.bufferedAmount = 0;
    await sending;
    expect(socket.sent).toHaveLength(1);

    await expect(
      connection.send({
        jsonrpc: '2.0',
        id: 'x',
        method: 'not/allowed',
        params: {},
      } as unknown as RuntimeProtocolMessage),
    ).rejects.toThrow('invalid protocol message');

    socket.bufferedAmount = 100;
    await expect(connection.send(pingRequest())).rejects.toThrow('send deadline');
    expect(socket.closeCalls).toHaveLength(1);
  });

  test('fails closed for binary, malformed, and oversized frames without echoing data', async () => {
    for (const [frame, code] of [
      [new Uint8Array([1, 2]), 1003],
      ['{not json}', 1002],
      [`"${'x'.repeat(1_048_577)}"`, 1009],
    ] as const) {
      const socket = new FakeWebSocket();
      const transport = createTransport(() => socket);
      const opening = transport.connect();
      socket.open();
      const connection = await opening;
      const messages = connection.messages()[Symbol.asyncIterator]();

      socket.message(frame);
      await expect(messages.next()).rejects.toThrow();
      expect(socket.closeCalls).toEqual([{ code, reason: 'runtime_websocket_failed' }]);
      expect(socket.sent).toEqual([]);
    }
  });

  test('fails the connection on close and error before open or while receiving', async () => {
    const closedSocket = new FakeWebSocket();
    const closedTransport = createTransport(() => closedSocket);
    const connecting = closedTransport.connect();
    closedSocket.closed();
    await expect(connecting).rejects.toThrow('connection closed');
    expect(closedSocket.listenerCount()).toBe(0);

    const socket = new FakeWebSocket();
    const transport = createTransport(() => socket);
    const opening = transport.connect();
    socket.open();
    const connection = await opening;
    const messages = connection.messages()[Symbol.asyncIterator]();
    socket.error();
    await expect(messages.next()).rejects.toThrow('connection failed');
    expect(socket.listenerCount()).toBe(0);
  });

  test('has a bounded receive queue for slow consumers and clears listeners idempotently', async () => {
    const socket = new FakeWebSocket();
    const transport = createTransport(() => socket, { maxQueuedMessages: 2 });
    const opening = transport.connect();
    socket.open();
    const connection = await opening;

    socket.message(JSON.stringify(pingResponse('one')));
    socket.message(JSON.stringify(pingResponse('two')));
    socket.message(JSON.stringify(pingResponse('three')));
    expect(socket.closeCalls).toEqual([{ code: 1013, reason: 'runtime_websocket_failed' }]);
    expect(socket.listenerCount()).toBe(0);

    await connection.close();
    await connection.close();
    expect(socket.closeCalls).toHaveLength(1);
  });

  test('uses a fresh socket per reconnect and never adds token/query or subprotocol assumptions', async () => {
    const firstSocket = new FakeWebSocket();
    const secondSocket = new FakeWebSocket();
    const sockets = [firstSocket, secondSocket];
    const urls: string[] = [];
    let resolvedUrl = 'ws://127.0.0.1:4317/rpc';
    const transport = new BunWebSocketRuntimeClientTransport({
      url: () => resolvedUrl,
      webSocketFactory: (url) => {
        urls.push(url);
        const socket = sockets.shift();
        if (!socket) throw new Error('unexpected extra socket');
        return socket;
      },
      connectDeadlineMs: 100,
    });

    const first = transport.connect();
    firstSocket.open();
    const firstConnection = await first;
    await firstConnection.close();

    resolvedUrl = 'ws://127.0.0.1:4318/rpc';
    const second = transport.connect();
    secondSocket.open();
    await second;
    expect(urls).toEqual(['ws://127.0.0.1:4317/rpc', 'ws://127.0.0.1:4318/rpc']);
    expect(
      () =>
        new BunWebSocketRuntimeClientTransport({
          url: 'ws://127.0.0.1:4317/rpc?token=must-not-enter-the-url',
        }),
    ).toThrow('query');
  });
});

function createTransport(
  webSocketFactory: (url: string) => RuntimeWebSocketLike,
  options: {
    readonly maxBufferedAmount?: number;
    readonly sendDeadlineMs?: number;
    readonly maxQueuedMessages?: number;
  } = {},
): RuntimeClientTransport {
  return new BunWebSocketRuntimeClientTransport({
    url: 'ws://127.0.0.1:4317/rpc',
    webSocketFactory,
    connectDeadlineMs: 100,
    ...options,
  });
}

function pingRequest() {
  return { jsonrpc: '2.0' as const, id: 'ping', method: 'server/ping' as const, params: {} };
}

function pingResponse(id = 'ping') {
  return { jsonrpc: '2.0', id, result: { status: 'ok' } };
}

class FakeWebSocket implements RuntimeWebSocketLike {
  readyState = 0;
  bufferedAmount = 0;
  readonly sent: string[] = [];
  readonly closeCalls: { code: number | undefined; reason: string | undefined }[] = [];
  readonly #listeners = new Map<string, Set<(event: { readonly data?: unknown }) => void>>();

  addEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    listener: (event: { readonly data?: unknown }) => void,
  ): void {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    listener: (event: { readonly data?: unknown }) => void,
  ): void {
    this.#listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('socket is not open');
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.#emit('open', {});
  }

  message(data: unknown): void {
    this.#emit('message', { data });
  }

  closed(): void {
    this.readyState = 3;
    this.#emit('close', {});
  }

  error(): void {
    this.#emit('error', {});
  }

  listenerCount(): number {
    return [...this.#listeners.values()].reduce((total, listeners) => total + listeners.size, 0);
  }

  #emit(type: string, event: { readonly data?: unknown }): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}
