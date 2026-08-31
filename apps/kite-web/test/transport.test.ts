import {
  WEB_BOOTSTRAP_RESPONSE_SCHEMA_,
  WEB_DIRECTORY_RESPONSE_SCHEMA_,
  WEB_HISTORY_RESPONSE_SCHEMA_,
  WEB_LIVE_EVENT_SCHEMA_,
  WEB_SUBSCRIBE_REQUEST_SCHEMA_,
  WEB_SUBSCRIBE_RESPONSE_SCHEMA_,
  WEB_UNSUBSCRIBE_REQUEST_SCHEMA_,
  WEB_UNSUBSCRIBE_RESPONSE_SCHEMA_,
  type WebHistoryResponse,
} from '@kite-ai/kite-app-contract/web';
import { describe, expect, test, vi } from 'vitest';
import {
  createWebObserverTransport,
  type WebObserverTransport,
  type WebObserverWebSocket,
} from '@/transport/client';

class MockWebSocket implements WebObserverWebSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readonly sent: string[] = [];

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  send(data: string): void {
    this.sent.push(data);
    const value = JSON.parse(data) as {
      readonly schema?: string;
      readonly type?: string;
      readonly tabHandle?: string;
    };
    if (value.type === 'initialize' && value.tabHandle) {
      this.receive({
        schema: 'kite.app.web.ws-initialized.v1',
        type: 'initialized',
        connectionGeneration: Number(value.tabHandle.replace('tab-', '')),
      });
    }
    if (value.schema === 'kite.app.web.disconnect-request.v1') {
      this.receive({ schema: 'kite.app.web.disconnect-response.v1', disconnected: true });
    }
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  receive(value: unknown): void {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
}

function response(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function messageFixture() {
  return {
    messageId: 'message-1',
    sequence: 1,
    role: 'assistant' as const,
    blocks: [{ kind: 'text' as const, text: 'stale event' }],
  };
}

function harness(
  options: {
    readonly historyPages?: readonly WebHistoryResponse[];
    readonly webSocketFailure?: boolean;
  } = {},
): {
  readonly transport: WebObserverTransport;
  readonly sockets: MockWebSocket[];
  readonly requests: Array<{ readonly path: string; readonly init: RequestInit | undefined }>;
} {
  const sockets: MockWebSocket[] = [];
  const requests: Array<{ readonly path: string; readonly init: RequestInit | undefined }> = [];
  let tabGeneration = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input.toString();
    requests.push({ path, init });
    if (path.endsWith('/bootstrap')) {
      return response({
        schema: WEB_BOOTSTRAP_RESPONSE_SCHEMA_,
        gatewayInstanceId: 'gateway-1',
        contractRevision: 'contract-1',
      });
    }
    if (path.endsWith('/tabs')) {
      tabGeneration += 1;
      return response({
        schema: 'kite.app.web.tab-create-response.v1',
        tabHandle: `tab-${tabGeneration}`,
        connectionGeneration: tabGeneration,
      });
    }
    if (path.endsWith('/directory')) {
      return response({ schema: WEB_DIRECTORY_RESPONSE_SCHEMA_, workspaces: [] });
    }
    if (path.endsWith('/history')) {
      const body = JSON.parse(String(init?.body)) as {
        readonly sessionId: string;
        readonly cursor?: number;
      };
      const historyPages = options.historyPages;
      if (historyPages) {
        const cursor = body.cursor;
        const page =
          cursor === undefined
            ? historyPages[0]
            : historyPages.find((candidate) => {
                const firstSequence = candidate.messages[0]?.sequence;
                return firstSequence !== undefined && firstSequence > cursor;
              });
        if (page) return response(page);
      }
      return response({
        schema: WEB_HISTORY_RESPONSE_SCHEMA_,
        sessionId: body.sessionId,
        messages: [],
        hasMore: false,
        observedLastSequence: 0,
      });
    }
    return response({ schema: 'kite.app.web.disconnect-response.v1', disconnected: true });
  });
  const transport = createWebObserverTransport({
    fetch: fetchMock,
    location: {
      host: '127.0.0.1:4242',
      origin: 'http://127.0.0.1:4242',
      protocol: 'http:',
    },
    webSocketFactory: () => {
      if (options.webSocketFailure) throw new Error('WebSocket unavailable');
      const socket = new MockWebSocket();
      sockets.push(socket);
      return socket;
    },
  });
  return { transport, sockets, requests };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

async function waitForSocket(sockets: readonly MockWebSocket[]): Promise<MockWebSocket> {
  for (let index = 0; index < 20; index += 1) {
    const socket = sockets[0];
    if (socket) return socket;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('mock socket was not created');
}

describe('Web Observer browser transport', () => {
  test('coalesces concurrent HTTP connect calls into one tab without opening live WS', async () => {
    const fixture = harness();
    const first = fixture.transport.connect();
    const second = fixture.transport.connect();
    const [firstConnection, secondConnection] = await Promise.all([first, second]);
    expect(secondConnection).toEqual(firstConnection);
    expect(fixture.requests.filter((entry) => entry.path.endsWith('/tabs'))).toHaveLength(1);
    expect(fixture.sockets).toHaveLength(0);
  });

  test('keeps Directory readable when the optional live WebSocket cannot open', async () => {
    const fixture = harness({ webSocketFailure: true });
    await fixture.transport.connect();
    await expect(fixture.transport.listDirectory()).resolves.toMatchObject({ workspaces: [] });
    await expect(
      fixture.transport.subscribe({ sessionId: 'session-1', onEvent: vi.fn() }),
    ).rejects.toMatchObject({ reason: 'gateway_unavailable' });
    await expect(fixture.transport.listDirectory()).resolves.toMatchObject({ workspaces: [] });
    expect(fixture.requests.filter((entry) => entry.path.endsWith('/directory'))).toHaveLength(2);
  });

  test('bootstraps directly, creates tab, sends tab header, and speaks closed WS methods', async () => {
    const fixture = harness();
    const connection = await fixture.transport.connect();
    expect(connection).toMatchObject({ tabHandle: 'tab-1', generation: 1 });

    await fixture.transport.listDirectory();
    const directoryRequest = fixture.requests.find((entry) => entry.path.endsWith('/directory'));
    expect(directoryRequest?.init?.headers).toMatchObject({ 'x-kite-web-tab': 'tab-1' });

    const events: unknown[] = [];
    const subscriptionPromise = fixture.transport.subscribe({
      sessionId: 'session-1',
      afterSequence: 0,
      onEvent: (event, generation) => events.push({ event, generation }),
    });
    const socket = await waitForSocket(fixture.sockets);
    socket.open();
    await flush();
    socket.receive({
      schema: WEB_SUBSCRIBE_RESPONSE_SCHEMA_,
      subscriptionId: 'subscription-1',
      sessionId: 'session-1',
      liveSequence: 0,
    });
    const subscription = await subscriptionPromise;
    socket.receive({
      schema: WEB_LIVE_EVENT_SCHEMA_,
      type: 'message',
      sessionId: 'session-1',
      sequence: 1,
      message: {
        messageId: 'message-1',
        sequence: 1,
        role: 'assistant',
        blocks: [{ kind: 'text', text: 'safe live update' }],
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ generation: 1 });

    const unsubscribePromise = subscription.unsubscribe();
    await flush();
    socket.receive({
      schema: WEB_UNSUBSCRIBE_RESPONSE_SCHEMA_,
      subscriptionId: 'subscription-1',
      unsubscribed: true,
    });
    await unsubscribePromise;
    await fixture.transport.disconnect();
    expect(socket.sent.map((value) => JSON.parse(value).schema ?? JSON.parse(value).type)).toEqual([
      'initialize',
      WEB_SUBSCRIBE_REQUEST_SCHEMA_,
      WEB_UNSUBSCRIBE_REQUEST_SCHEMA_,
      'kite.app.web.disconnect-request.v1',
    ]);
  });

  test('does not retain a stale terminal generation and reconnects through a fresh tab', async () => {
    const fixture = harness();
    await fixture.transport.connect();
    await flush();
    const onEvent = vi.fn();
    const subscriptionPromise = fixture.transport.subscribe({
      sessionId: 'session-1',
      onEvent,
    });
    const firstSocket = await waitForSocket(fixture.sockets);
    firstSocket.open();
    await flush();
    firstSocket.receive({
      schema: WEB_SUBSCRIBE_RESPONSE_SCHEMA_,
      subscriptionId: 'subscription-1',
      sessionId: 'session-1',
      liveSequence: null,
    });
    await subscriptionPromise;
    firstSocket.receive({
      schema: WEB_LIVE_EVENT_SCHEMA_,
      type: 'resync_required',
      sessionId: 'session-1',
      reason: 'stream_overflow',
    });
    expect(onEvent).toHaveBeenCalledTimes(1);
    const secondConnect = fixture.transport.connect();
    await expect(secondConnect).resolves.toMatchObject({ tabHandle: 'tab-2', generation: 2 });
    firstSocket.receive({
      schema: WEB_LIVE_EVENT_SCHEMA_,
      type: 'message',
      sessionId: 'session-1',
      sequence: 2,
      message: { ...messageFixture(), sequence: 2 },
    });
    firstSocket.onclose?.();
    firstSocket.onerror?.();
    expect(onEvent).toHaveBeenCalledTimes(1);
    const secondEvents = vi.fn();
    const secondSubscriptionPromise = fixture.transport.subscribe({
      sessionId: 'session-1',
      onEvent: secondEvents,
    });
    for (let index = 0; index < 20 && fixture.sockets.length < 2; index += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    const secondSocket = fixture.sockets[1];
    if (!secondSocket) throw new Error('second mock socket was not created');
    secondSocket.open();
    await flush();
    secondSocket.receive({
      schema: WEB_SUBSCRIBE_RESPONSE_SCHEMA_,
      subscriptionId: 'subscription-2',
      sessionId: 'session-1',
      liveSequence: null,
    });
    await secondSubscriptionPromise;
    expect(secondEvents).not.toHaveBeenCalled();
  });

  test('aggregates bounded History pages and rejects cursor cycles or changing observations', async () => {
    const first = {
      schema: WEB_HISTORY_RESPONSE_SCHEMA_,
      sessionId: 'session-1',
      messages: [
        {
          messageId: 'message-1',
          sequence: 1,
          role: 'assistant' as const,
          blocks: [{ kind: 'text' as const, text: 'first page' }],
        },
      ],
      nextCursor: 1,
      hasMore: true,
      observedLastSequence: 2,
    };
    const second = {
      schema: WEB_HISTORY_RESPONSE_SCHEMA_,
      sessionId: 'session-1',
      messages: [
        {
          messageId: 'message-2',
          sequence: 2,
          role: 'assistant' as const,
          blocks: [{ kind: 'text' as const, text: 'second page' }],
        },
      ],
      hasMore: false,
      observedLastSequence: 2,
    };
    const fixture = harness({ historyPages: [first, second] });
    await fixture.transport.connect();
    const history = await fixture.transport.loadHistory('session-1');
    expect(history.messages.map((message) => message.messageId)).toEqual([
      'message-1',
      'message-2',
    ]);
    expect(fixture.requests.filter((entry) => entry.path.endsWith('/history'))).toHaveLength(2);

    const cyclic = harness({
      historyPages: [
        { ...first, nextCursor: 1 },
        { ...first, nextCursor: 1 },
      ],
    });
    await cyclic.transport.connect();
    await expect(cyclic.transport.loadHistory('session-1')).rejects.toMatchObject({
      reason: 'resync_required',
    });

    const changing = harness({
      historyPages: [first, { ...second, observedLastSequence: 3 }],
    });
    await changing.transport.connect();
    await expect(changing.transport.loadHistory('session-1')).rejects.toMatchObject({
      reason: 'resync_required',
    });
  });

  test('rejects a waiting WS response on timeout instead of leaving a promise pending', async () => {
    try {
      const fixture = harness();
      vi.useFakeTimers();
      await fixture.transport.connect();
      const pending = fixture.transport.subscribe({ sessionId: 'session-1', onEvent: vi.fn() });
      await vi.advanceTimersByTimeAsync(0);
      const socket = fixture.sockets[0];
      if (!socket) throw new Error('mock socket was not created');
      socket.open();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5_001);
      await expect(pending).rejects.toMatchObject({ reason: 'gateway_unavailable' });
      expect(fixture.sockets[0]?.readyState).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test('rejects an invalid initialize receipt immediately', async () => {
    const fixture = harness();
    await fixture.transport.connect();
    const subscribing = fixture.transport.subscribe({ sessionId: 'session-1', onEvent: vi.fn() });
    const socket = await waitForSocket(fixture.sockets);
    socket.send = (data: string) => {
      socket.sent.push(data);
    };
    socket.open();
    socket.receive({ type: 'initialized', connectionGeneration: 1, rawRuntime: true });
    await expect(subscribing).rejects.toMatchObject({ reason: 'protocol_error' });
    expect(socket.readyState).toBe(3);
  });

  test('serializes duplicate disconnect calls to one closed HTTP request without live WS', async () => {
    const fixture = harness();
    await fixture.transport.connect();
    await Promise.all([fixture.transport.disconnect(), fixture.transport.disconnect()]);
    const disconnectRequests = fixture.requests.filter((entry) =>
      entry.path.endsWith('/disconnect'),
    );
    expect(disconnectRequests).toHaveLength(1);
    expect(fixture.sockets).toHaveLength(0);
  });

  test('does not poison the operation tail after a rejected History read', async () => {
    const firstPage = {
      schema: WEB_HISTORY_RESPONSE_SCHEMA_,
      sessionId: 'session-1',
      messages: [messageFixture()],
      nextCursor: 1,
      hasMore: true,
      observedLastSequence: 1,
    };
    const fixture = harness({ historyPages: [firstPage] });
    await fixture.transport.connect();
    await expect(fixture.transport.loadHistory('session-1')).rejects.toMatchObject({
      reason: 'resync_required',
    });
    await expect(fixture.transport.disconnect()).resolves.toBeUndefined();

    const reconnect = fixture.transport.connect();
    await expect(reconnect).resolves.toMatchObject({ generation: 2, tabHandle: 'tab-2' });
    expect(fixture.sockets).toHaveLength(0);
  });

  test('aborts a hung HTTP operation so queued disconnect can complete', async () => {
    try {
      vi.useFakeTimers();
      let aborts = 0;
      const transport = createWebObserverTransport({
        fetch: vi.fn(
          (_input, init) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener(
                'abort',
                () => {
                  aborts += 1;
                  reject(new DOMException('aborted', 'AbortError'));
                },
                { once: true },
              );
            }),
        ) as typeof fetch,
        location: {
          host: '127.0.0.1:4242',
          origin: 'http://127.0.0.1:4242',
          protocol: 'http:',
        },
      });
      const connecting = transport.connect();
      const rejectedConnect = expect(connecting).rejects.toMatchObject({
        reason: 'gateway_unavailable',
      });
      const disconnecting = transport.disconnect();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(5_001);
      await rejectedConnect;
      await expect(disconnecting).resolves.toBeUndefined();
      expect(aborts).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
