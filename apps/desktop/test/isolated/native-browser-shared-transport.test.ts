import { createHash } from 'node:crypto';
import type { NativeBrowserTransport } from '@kite-ai/agent/browser';
import { expect, mock, test } from '#kite-test';
import type { serveLoopbackWebSocket } from '../../../service/src/loopback-server';
import { NativeBrowserPageHost } from '../../electron/browser-page-host';

const natives: any[] = [];
let nextNativeReady: Promise<void> | undefined;
let onNativeCreated: (() => void) | undefined;
const frame = {
  mimeType: 'image/jpeg' as const,
  data: Buffer.from('controlled-frame').toString('base64'),
  width: 500,
  height: 250,
};
mock.module('@kite-ai/agent/browser', () => ({
  BrowserTransportError: class extends Error {
    readonly dispatched: boolean;
    constructor(message: string, dispatched: boolean) {
      super(message);
      this.dispatched = dispatched;
    }
  },
  createNativeBrowserTransport(options: unknown) {
    const ready = nextNativeReady ?? Promise.resolve();
    nextNativeReady = undefined;
    let end!: (value: { confirmed: boolean }) => void;
    const row = {
      options,
      closed: 0,
      disposed: 0,
      ready,
      completion: new Promise<{ confirmed: boolean }>((resolve) => {
        end = resolve;
      }),
      async request(command: any) {
        return command.action === 'stream_status'
          ? { success: true, data: { enabled: false } }
          : { success: true, data: {} };
      },
      async capture() {
        return {
          frame,
          annotations: [
            {
              ref: '@e1',
              number: 1,
              role: 'button',
              box: { x: 100, y: 40, width: 80, height: 20 },
            },
          ],
        };
      },
      async close() {
        row.closed++;
        end({ confirmed: true });
        return { confirmed: true };
      },
      async dispose() {
        row.disposed++;
      },
    };
    natives.push(row);
    onNativeCreated?.();
    onNativeCreated = undefined;
    return row;
  },
}));
let serveFixture: typeof serveLoopbackWebSocket = async () => {
  throw Error('test_websocket_fixture_missing');
};
mock.module('../../../service/src/loopback-server', () => ({
  serveLoopbackWebSocket: (options: Parameters<typeof serveLoopbackWebSocket>[0]) =>
    serveFixture(options),
}));
const { createDesktopBrowserTransport } = await import('../../../service/src/desktop-browser');

for (const timing of ['before-reply', 'after-reply'] as const)
  test(`compatibility CDP reader waits for its empty-session DOM content event: ${timing}`, async () => {
    const originalFetch = globalThis.fetch,
      originalServe = serveFixture;
    const host = new NativeBrowserPageHost(),
      scope = { storeId: 'store', sessionId: 'session' };
    let onEvent!: (method: string, params: unknown, sessionId?: string) => void;
    const calls: string[] = [],
      received: any[] = [],
      requests: any[] = [];
    const navigation = { frameId: 'main-frame', loaderId: 'current-loader' };
    const lifecycle = { ...navigation, name: 'DOMContentLoaded', timestamp: 1 };
    const domContent = { timestamp: 1 };
    const emitLifecycle = () => {
      // Electron root-target messages omit sessionId. A different target must not be adopted.
      onEvent('Page.domContentEventFired', domContent, 'foreign-target');
      onEvent('Page.lifecycleEvent', lifecycle);
      onEvent('Page.domContentEventFired', domContent);
    };
    host.add({
      id: 'page',
      scope,
      attach() {},
      detach: () => true,
      alive: () => true,
      async send(method) {
        calls.push(method);
        if (timing === 'before-reply') emitLifecycle();
        return navigation;
      },
      typingCursor: async () => null,
      onEvent(listener) {
        onEvent = listener;
        return () => {};
      },
      decorate() {},
      changed() {},
      capture: async () => ({}),
      captureMeta: () => null,
    });
    host.arm('page', scope);
    let server: any, lifecycleReady!: () => void, timer: ReturnType<typeof setTimeout> | undefined;
    let foreignBatch = false;
    const ws = {
      readyState: 1,
      send(value: string) {
        const event = JSON.parse(value);
        received.push(event);
        // Fixed provider direct_page uses session_id = String::new() and compares
        // event.session_id.as_deref() == Some(session_id), not None. Its
        // wait_for_lifecycle("domcontentloaded") waits for domContentEventFired.
        if (event.method === 'Page.domContentEventFired' && event.sessionId === '')
          lifecycleReady();
      },
      close() {
        this.readyState = 3;
        server.websocket.close(this);
      },
    };
    let transport: NativeBrowserTransport | undefined;
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      requests.push(request);
      try {
        const value =
          foreignBatch && request.op === 'events'
            ? {
                events: [
                  { method: 'Page.domContentEventFired', params: domContent, sessionId: 'foreign' },
                ],
                cursor: 1,
              }
            : await host.request(request);
        return new Response(JSON.stringify({ ok: true, value }));
      } catch (error) {
        return new Response(JSON.stringify({ ok: false, error: (error as Error).message }), {
          status: 400,
        });
      }
    }) as typeof fetch;
    serveFixture = (async (options: any) => {
      server = options;
      return { port: 12345, stop: async () => {} };
    }) as unknown as typeof serveFixture;
    try {
      const signal = new AbortController().signal;
      transport = createDesktopBrowserTransport(
        { executable: '/trusted/native', browserPath: '/unused' },
        {
          endpoint: 'http://127.0.0.1:1234/kite-page',
          token: '00000000-0000-0000-0000-00000000000100000000-0000-0000-0000-000000000002',
        },
        { sessionId: scope.sessionId, executionId: 'job', signal },
        { browserId: 'browser', storeId: async () => scope.storeId },
      );
      await transport.ready;
      server.websocket.open(ws);
      await transport.request({ action: 'launch' }, signal);
      const native = natives.at(-1)!;
      native.request = async (command: any) => {
        expect(command.action).toBe('fixture_navigation');
        const ready = new Promise<void>((resolve, reject) => {
          lifecycleReady = resolve;
          timer = setTimeout(() => reject(Error('direct_page_lifecycle_timeout')), 500);
        });
        // The fixed direct-page client omits empty sessionId on outgoing commands.
        await server.websocket.message(
          ws,
          JSON.stringify({ id: 1, method: 'Page.navigate', params: { url: command.url } }),
        );
        expect(received.find((event) => event.id === 1)).toEqual({ id: 1, result: navigation });
        if (timing === 'after-reply') emitLifecycle();
        await ready;
        clearTimeout(timer);
        return { success: true, data: { url: command.url } };
      };
      expect(
        await transport.request(
          {
            action: 'fixture_navigation',
            url: 'https://example.com/',
            waitUntil: 'domcontentloaded',
          },
          signal,
        ),
      ).toEqual({ success: true, data: { url: 'https://example.com/' } });
      expect(received.filter((event) => event.method)).toEqual([
        { method: 'Page.lifecycleEvent', params: lifecycle, sessionId: '' },
        { method: 'Page.domContentEventFired', params: domContent, sessionId: '' },
      ]);
      expect(requests.find((request) => request.op === 'cdp')).not.toHaveProperty('sessionId');
      await server.websocket.message(
        ws,
        JSON.stringify({ id: 2, method: 'Page.navigate', sessionId: 'foreign-target' }),
      );
      expect(received.find((event) => event.id === 2)?.error).toEqual({
        code: -32000,
        message: 'desktop_browser_command_failed',
      });
      expect(calls).toEqual(['Page.navigate']);
      const eventCount = received.length;
      foreignBatch = true;
      expect(await transport.completion).toEqual({ confirmed: false });
      expect(received).toHaveLength(eventCount);
    } finally {
      clearTimeout(timer);
      await transport?.close();
      globalThis.fetch = originalFetch;
      serveFixture = originalServe;
    }
  });

test('ordinary page/Job adapter confirms control, pauses with daemon cleanup, and resumes without owning the renderer', async () => {
  const before = natives.length;
  const host = new NativeBrowserPageHost(),
    scope = { storeId: 'store-a', sessionId: 'session-a' };
  let attaches = 0,
    detaches = 0;
  host.add({
    id: 'same-page',
    scope,
    attach() {
      attaches++;
    },
    detach() {
      detaches++;
      return true;
    },
    alive: () => true,
    send: async () => ({}),
    typingCursor: async () => null,
    onEvent: () => () => {},
    decorate() {},
    changed() {},
    capture: async () => ({ frame, annotations: [] }),
    captureMeta: () => ({
      metadata: {
        sha256: createHash('sha256').update(Buffer.from(frame.data, 'base64')).digest('hex'),
        navigation: 0,
        width: 1000,
        height: 500,
      },
      navigation: 0,
    }),
  });
  host.arm('same-page', scope);
  const originalFetch = globalThis.fetch,
    originalServe = serveFixture;
  let stops = 0;
  const requests: any[] = [];
  globalThis.fetch = (async (_url: any, init: any) => {
    const request = JSON.parse(init.body);
    requests.push(request);
    try {
      return new Response(JSON.stringify({ ok: true, value: await host.request(request) }));
    } catch (error) {
      return new Response(JSON.stringify({ ok: false, error: (error as Error).message }), {
        status: 400,
      });
    }
  }) as typeof fetch;
  serveFixture = (async (_options: any) => ({
    port: 12345,
    stop: async () => {
      stops++;
    },
  })) as unknown as typeof serveFixture;
  let transport: NativeBrowserTransport | undefined;
  const signal = new AbortController();
  try {
    transport = createDesktopBrowserTransport(
      { executable: '/trusted/agent-browser', browserPath: '/unused' },
      {
        endpoint: 'http://127.0.0.1:1234/kite-page',
        token: '00000000-0000-0000-0000-00000000000100000000-0000-0000-0000-000000000002',
      },
      { sessionId: scope.sessionId, executionId: 'original-job', signal: signal.signal },
      { browserId: 'browser-a', storeId: async () => scope.storeId },
    );
    await transport.ready;
    expect(attaches).toBe(1);
    expect(host.state('same-page')?.phase).toBe('acquiring');
    await transport.request(
      { action: 'launch', headless: true, engine: 'chrome', webmcp: false },
      signal.signal,
    );
    expect(host.state('same-page')?.phase).toBe('agent');
    expect(transport.sharedPage).toBe(true);
    const captured = await transport.capture(signal.signal);
    expect(captured.annotations[0]!.box).toEqual({ x: 50, y: 20, width: 40, height: 10 });
    let ended = false;
    void transport.completion.then(() => {
      ended = true;
    });
    await transport.handoff!(signal.signal);
    expect(host.state('same-page')?.phase).toBe('human');
    expect(host.retained('same-page')).toBe(true);
    expect(natives[before].closed).toBe(1);
    expect(natives[before].disposed).toBe(1);
    expect(ended).toBe(false);
    expect((await transport.capture(signal.signal)).annotations).toHaveLength(0);
    await transport.resume!(signal.signal);
    expect(natives.length - before).toBe(2);
    expect(attaches).toBe(2);
    expect(host.state('same-page')?.phase).toBe('agent');
    expect(await transport.close()).toEqual({ confirmed: true });
    expect(await transport.completion).toEqual({ confirmed: true });
    expect(host.retained('same-page')).toBe(false);
    expect(detaches).toBe(2);
    expect(stops).toBe(2);
    expect(requests.filter((row) => row.op === 'acquire')).toHaveLength(1);
  } finally {
    await transport?.close();
    serveFixture = originalServe;
    globalThis.fetch = originalFetch;
  }
});
test('known missing grant ends without a phantom daemon; lost acquisition response stays unknown', async () => {
  const originalFetch = globalThis.fetch,
    originalServe = serveFixture;
  const before = natives.length;
  try {
    let cancelled = 0;
    for (const mode of ['rejected', 'lost', 'oversized'] as const) {
      globalThis.fetch = (async () => {
        if (mode === 'lost') throw Error('response_lost');
        if (mode === 'oversized')
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array(512 * 1024 + 1));
              },
              cancel() {
                cancelled++;
              },
            }),
          );
        return new Response(
          JSON.stringify({
            ok: false,
            error: 'browser_page_explicit_grant_required',
            failure: { kind: 'not_dispatched', op: 'acquire' },
          }),
          { status: 400 },
        );
      }) as unknown as typeof fetch;
      serveFixture = (async () => {
        throw Error('unexpected_server');
      }) as unknown as typeof serveFixture;
      const transport = createDesktopBrowserTransport(
        { executable: '/trusted/native', browserPath: '/unused' },
        {
          endpoint: 'http://127.0.0.1:1234/kite-page',
          token: '00000000-0000-0000-0000-00000000000100000000-0000-0000-0000-000000000002',
        },
        { sessionId: 'a', executionId: 'job', signal: new AbortController().signal },
        { browserId: 'b', storeId: async () => 'store-a' },
      );
      await expect(transport.ready).rejects.toThrow();
      expect(await transport.close()).toEqual({ confirmed: mode === 'rejected' });
    }
    expect(cancelled).toBe(1);
    expect(natives).toHaveLength(before);
  } finally {
    globalThis.fetch = originalFetch;
    serveFixture = originalServe;
  }
});

for (const boundary of ['reply', 'lost-reply', 'native-ready'] as const)
  for (const mode of ['close', 'cancel', 'deadline'] as const)
    test(`late resume is drained before final cleanup: ${mode}/${boundary}`, async () => {
      const originalFetch = globalThis.fetch,
        originalServe = serveFixture,
        originalTimer = globalThis.setTimeout;
      try {
        const host = new NativeBrowserPageHost(),
          scope = { storeId: 's', sessionId: 'a' };
        host.add({
          id: 'p',
          scope,
          attach() {},
          detach: () => true,
          alive: () => true,
          send: async () => ({}),
          typingCursor: async () => null,
          onEvent: () => () => {},
          decorate() {},
          changed() {},
          capture: async () => ({}),
          captureMeta: () => null,
        });
        host.arm('p', scope);
        let releaseReply!: () => void, notifyResume!: () => void;
        const gate = new Promise<void>((resolve) => {
          releaseReply = resolve;
        });
        const entered = new Promise<void>((resolve) => {
          notifyResume = resolve;
        });
        const requests: Record<string, unknown>[] = [];
        globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
          const request = JSON.parse(String(init.body));
          requests.push(request);
          try {
            const value = await host.request(request);
            if (request.op === 'resume' && boundary !== 'native-ready') {
              notifyResume();
              await gate;
              if (boundary === 'lost-reply') throw Error('response_lost_after_resume');
            }
            return new Response(JSON.stringify({ ok: true, value }));
          } catch (error) {
            return new Response(JSON.stringify({ ok: false, error: (error as Error).message }), {
              status: 400,
            });
          }
        }) as unknown as typeof fetch;
        let servers = 0,
          stops = 0,
          deadline: (() => void) | undefined;
        serveFixture = (async () => {
          servers++;
          return {
            port: 12345,
            stop: async () => {
              stops++;
            },
          };
        }) as unknown as typeof serveFixture;
        globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
          const [handler, timeout] = args;
          if (timeout === 600000 && typeof handler === 'function') deadline = handler as () => void;
          return originalTimer(...args);
        }) as typeof setTimeout;
        const context = new AbortController(),
          before = natives.length;
        const transport = createDesktopBrowserTransport(
          { executable: '/trusted/native', browserPath: '/unused' },
          {
            endpoint: 'http://127.0.0.1:1234/kite-page',
            token: '00000000-0000-0000-0000-00000000000100000000-0000-0000-0000-000000000002',
          },
          { sessionId: scope.sessionId, executionId: 'j', signal: context.signal },
          { browserId: 'b', storeId: async () => scope.storeId },
        );
        let resume: Promise<unknown> | undefined;
        try {
          await transport.ready;
          await transport.request(
            { action: 'launch', headless: true, engine: 'chrome', webmcp: false },
            context.signal,
          );
          await transport.handoff!(context.signal);
          if (boundary === 'native-ready') {
            nextNativeReady = gate;
            onNativeCreated = notifyResume;
          }
          resume = transport.resume!(new AbortController().signal).then(
            () => undefined,
            (error) => error,
          );
          await entered;
          if (mode === 'deadline') deadline!();
          if (mode === 'cancel') context.abort();
          const closing = transport.close();
          let settled = false;
          void closing.then(() => {
            settled = true;
          });
          for (let i = 0; i < 10; i++) await Promise.resolve();
          const closedBeforeReply = settled;
          releaseReply();
          const outcome = await resume;
          const result = await closing;
          expect(closedBeforeReply).toBe(false);
          expect(outcome).toBeInstanceOf(Error);
          expect(result).toEqual({ confirmed: boundary !== 'lost-reply' });
          expect(await transport.close()).toEqual(result);
          expect(await transport.completion).toEqual(result);
          const expected = boundary === 'native-ready' ? 2 : 1;
          expect(natives.length - before).toBe(expected);
          for (const row of natives.slice(before)) {
            expect(row.closed).toBe(1);
            expect(row.disposed).toBe(1);
          }
          expect(servers).toBe(expected);
          expect(stops).toBe(expected);
          expect(host.retained('p')).toBe(boundary === 'lost-reply');
          expect(requests.filter((row) => row.op === 'resume')).toHaveLength(1);
          expect(requests.filter((row) => row.op === 'confirm')).toHaveLength(1);
          expect(context.signal.aborted).toBe(mode === 'cancel');
        } finally {
          releaseReply();
          await resume;
          await transport.close();
          nextNativeReady = undefined;
          onNativeCreated = undefined;
          // Fake objects only; a failing regression must not leave unresolved fake completion promises.
          for (const row of natives.slice(before)) if (!row.closed) await row.close();
        }
      } finally {
        globalThis.fetch = originalFetch;
        serveFixture = originalServe;
        globalThis.setTimeout = originalTimer;
      }
    });

test('a paused capture response delayed past close cannot publish its pixels', async () => {
  const originalFetch = globalThis.fetch,
    originalServe = serveFixture;
  let unblock!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const called = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const lease = { leaseId: 'l', pageId: 'p', incarnation: 'i', navigation: 0 };
  let transport: NativeBrowserTransport | undefined;
  try {
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      if (request.op === 'capture') {
        entered();
        await gate;
      }
      return new Response(
        JSON.stringify({
          ok: true,
          value:
            request.op === 'acquire'
              ? lease
              : request.op === 'capture'
                ? { pixels: 'late' }
                : { confirmed: true },
        }),
      );
    }) as unknown as typeof fetch;
    serveFixture = (async () => ({
      port: 12345,
      stop: async () => {},
    })) as unknown as typeof serveFixture;
    const signal = new AbortController().signal;
    transport = createDesktopBrowserTransport(
      { executable: '/trusted/native', browserPath: '/unused' },
      {
        endpoint: 'http://127.0.0.1:1234/kite-page',
        token: '00000000-0000-0000-0000-00000000000100000000-0000-0000-0000-000000000002',
      },
      { sessionId: 'a', executionId: 'j', signal },
      { browserId: 'b', storeId: async () => 's' },
    );
    await transport.ready;
    await transport.request(
      { action: 'launch', headless: true, engine: 'chrome', webmcp: false },
      signal,
    );
    await transport.handoff!(signal);
    const result = transport.capture(signal).then(
      (value) => ({ value, error: undefined }),
      (error) => ({ value: undefined, error }),
    );
    await called;
    expect(await transport.close()).toEqual({ confirmed: true });
    unblock();
    const reply = await result;
    expect(reply.error?.message).toContain('read_stale');
    expect(reply.value).toBeUndefined();
  } finally {
    unblock();
    await transport?.close();
    globalThis.fetch = originalFetch;
    serveFixture = originalServe;
  }
});
