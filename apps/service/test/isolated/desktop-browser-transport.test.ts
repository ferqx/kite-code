import { setTimeout as sleepTimer } from 'node:timers/promises';
import type { NativeBrowserTransport, NativeBrowserTransportOptions } from '@kite-ai/agent/browser';
import { expect, mock, test } from '#kite-test';
import { serve as fixtureServe } from '../../../../scripts/tooling/http';
import { listenBrowserPageHost } from '../../../desktop/electron/browser-page-channel';
import { NativeBrowserPageHost } from '../../../desktop/electron/browser-page-host';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const innerOptions: NativeBrowserTransportOptions[] = [];
let innerRequest: ((command: { action: string }) => Promise<unknown>) | undefined;
let innerCleanup: { confirmed?: boolean; dispose?: () => Promise<void> } | undefined;
mock.module('@kite-ai/agent/browser', () => ({
  BrowserTransportError: class extends Error {
    readonly dispatched: boolean;
    constructor(message: string, dispatched: boolean) {
      super(message);
      this.dispatched = dispatched;
    }
  },
  createNativeBrowserTransport(options: NativeBrowserTransportOptions) {
    innerOptions.push(options);
    const end = deferred<{ confirmed: boolean }>();
    const cleanup = innerCleanup;
    return {
      ready: Promise.resolve(),
      completion: end.promise,
      async request(command: { action: string }) {
        if (command.action === 'stream_status') return { success: true, data: { enabled: false } };
        if (command.action === 'stream_disable') return { success: true, data: {} };
        return innerRequest ? innerRequest(command) : { success: true, data: {} };
      },
      async close() {
        const result = { confirmed: cleanup?.confirmed !== false };
        end.resolve(result);
        return result;
      },
      async dispose() {
        await cleanup?.dispose?.();
      },
    };
  },
}));
const { createDesktopBrowserClient, createDesktopBrowserTransport } = await import(
  '../../src/desktop-browser'
);
const token = '00000000-0000-0000-0000-00000000000100000000-0000-0000-0000-000000000002';
function endpoint(port: number) {
  return { endpoint: `http://127.0.0.1:${port}/kite-page`, token };
}
const ok = (value: unknown) => Response.json({ ok: true, value });

for (const mode of [
  'destroyed',
  'alive',
  'missing-proof',
  'wrong-incarnation',
  'wrong-page',
  'wrong-lease',
  'extra-field',
  'unproven-poll-error',
] as const)
  test(`page removal confirms cleanup only with the exact destroyed original lease receipt: ${mode}`, async () => {
    const host = new NativeBrowserPageHost(),
      scope = { storeId: 'store', sessionId: 'session' };
    let alive = true,
      sends = 0,
      polls = 0;
    const remove = host.add({
      id: 'original-page',
      scope,
      alive: () => alive,
      attach() {},
      detach: () => true,
      async send() {
        sends++;
        return {};
      },
      typingCursor: async () => null,
      onEvent: () => () => {},
      decorate() {},
      changed() {},
      capture: async () => ({}),
      captureMeta: () => null,
    });
    host.arm('original-page', scope);
    const serialize = host.requestSerialized.bind(host);
    host.requestSerialized = async (input, signal) => {
      const request = input as Record<string, unknown>;
      if (request.op === 'events') polls++;
      if (request.op === 'events' && !alive && mode === 'unproven-poll-error')
        throw Error('unproven_connection_failure');
      const body = await serialize(input, signal);
      if (request.op !== 'release') return body;
      const reply = JSON.parse(body);
      if (mode === 'missing-proof') delete reply.value.closure;
      if (mode === 'wrong-incarnation') reply.value.closure.incarnation = 'replacement';
      if (mode === 'wrong-page') reply.value.closure.pageId = 'replacement';
      if (mode === 'wrong-lease') reply.value.closure.leaseId = 'replacement';
      if (mode === 'extra-field') reply.value.closure.forged = true;
      return JSON.stringify(reply);
    };
    const channel = await listenBrowserPageHost(host),
      owner = new AbortController();
    const transport = createDesktopBrowserTransport(
      { executable: '/fixture/not-spawned', browserPath: '/fixture/not-spawned' },
      channel.startup,
      { sessionId: scope.sessionId, executionId: 'original-job', signal: owner.signal },
      { browserId: 'original-browser', storeId: async () => scope.storeId },
    );
    let socket: WebSocket | undefined;
    try {
      await transport.ready;
      await transport.request({ action: 'launch' }, owner.signal);
      socket = new WebSocket(innerOptions.at(-1)!.attachment!.cdpUrl);
      await new Promise<void>((resolve, reject) => {
        socket!.addEventListener('open', () => resolve(), { once: true });
        socket!.addEventListener('error', reject, { once: true });
      });
      const deadline = Date.now() + 2000;
      while (!polls && Date.now() < deadline) await sleepTimer(5);
      expect(polls).toBeGreaterThan(0);
      remove();
      alive = mode === 'alive';
      const end = await Promise.race([
        transport.completion,
        sleepTimer(2000).then(() => {
          throw Error('original_page_cleanup_did_not_finish');
        }),
      ]);
      expect(end).toEqual({ confirmed: mode === 'destroyed' });
      expect(await transport.close()).toEqual(end);
      if (mode === 'destroyed') await transport.dispose();
      else await expect(transport.dispose()).rejects.toThrow('desktop_browser_cleanup_unknown');
      expect(transport.releasedSharedPage?.()).toBeNull();
      expect(sends).toBe(0);
      expect(host.state('original-page')).toBeUndefined();
    } finally {
      owner.abort();
      socket?.close();
      await transport.close();
      await channel.close();
    }
  });

for (const mode of [
  'valid',
  'business-unknown',
  'missing-proof',
  'foreign-lease',
  'foreign-page',
  'foreign-incarnation',
  'extra-field',
  'missing-title',
  'credential-url',
  'invalid-url',
  'oversized-url',
  'oversized-title',
  'not-detached',
  'destroyed',
  'release-unconfirmed',
  'daemon-unconfirmed',
  'daemon-dispose-failed',
  'context-cancelled',
  'context-cancelled-after-release',
  'pause-only',
  'invalid-acquired-page',
  'invalid-acquired-navigation',
] as const)
  test(`released original-page metadata requires complete cleanup and an exact Main receipt: ${mode}`, async () => {
    const lease: Record<string, unknown> = {
      leaseId: 'lease',
      pageId: 'original-page',
      incarnation: 'original-incarnation',
      navigation: 2,
    };
    const proof: Record<string, unknown> = {
      leaseId: 'lease',
      pageId: 'original-page',
      incarnation: 'original-incarnation',
      url: 'https://destination.test/redirected',
      title: 'Retained original',
    };
    if (mode === 'foreign-lease') proof.leaseId = 'foreign-lease';
    if (mode === 'foreign-page') proof.pageId = 'foreign-page';
    if (mode === 'foreign-incarnation') proof.incarnation = 'foreign-incarnation';
    if (mode === 'extra-field') proof.forged = true;
    if (mode === 'missing-title') delete proof.title;
    if (mode === 'credential-url') proof.url = 'https://user:secret@destination.test/';
    if (mode === 'invalid-url') proof.url = 'file:///private/page';
    if (mode === 'oversized-url') proof.url = `https://destination.test/${'a'.repeat(8192)}`;
    if (mode === 'oversized-title') proof.title = 'a'.repeat(129);
    if (mode === 'invalid-acquired-page') delete lease.pageId;
    if (mode === 'invalid-acquired-navigation') lease.navigation = -1;
    const disposing = deferred<void>(),
      finishDisposal = deferred<void>();
    innerCleanup = {
      confirmed: mode !== 'daemon-unconfirmed',
      async dispose() {
        if (mode === 'daemon-dispose-failed') throw Error('fixture_disposal_failed');
        if (mode === 'valid') {
          disposing.resolve();
          await finishDisposal.promise;
        }
      },
    };
    const server = await fixtureServe({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const input = (await request.json()) as { op: string; pause?: boolean };
        if (input.op === 'acquire') return ok(lease);
        if (input.op === 'events') return ok({ events: [], cursor: 0 });
        if (input.op === 'release')
          return ok({
            confirmed: mode !== 'release-unconfirmed',
            detached: mode !== 'not-detached',
            ...(mode === 'missing-proof' || (mode === 'pause-only' && input.pause !== true)
              ? {}
              : { retainedPage: proof }),
            ...(mode === 'destroyed'
              ? {
                  closure: {
                    kind: 'page_destroyed',
                    leaseId: lease.leaseId,
                    pageId: lease.pageId,
                    incarnation: lease.incarnation,
                  },
                }
              : {}),
          });
        return ok({});
      },
    });
    const owner = new AbortController(),
      transport = createDesktopBrowserTransport(
        { executable: '/not-spawned', browserPath: '/not-spawned' },
        endpoint(server.port!),
        { sessionId: 'session', executionId: 'job', signal: owner.signal },
        { browserId: 'browser', storeId: async () => 'store' },
      );
    let socket: WebSocket | undefined;
    try {
      expect(transport.releasedSharedPage?.()).toBeNull();
      if (mode.startsWith('invalid-acquired')) {
        await expect(transport.ready).rejects.toThrow('desktop_browser_lease_invalid');
        expect(transport.sharedPageIdentity?.()).toBeNull();
      } else {
        await transport.ready;
        socket = new WebSocket(innerOptions.at(-1)!.attachment!.cdpUrl);
        await new Promise<void>((resolve, reject) => {
          socket!.addEventListener('open', () => resolve(), { once: true });
          socket!.addEventListener('error', reject, { once: true });
        });
      }
      const businessFailure = Object.assign(Error('browser_native_request_timeout'), {
        dispatched: true,
      });
      if (mode === 'business-unknown') {
        innerRequest = async () => {
          throw businessFailure;
        };
        await expect(
          transport.request({ action: 'fill', selector: '@e1', value: 'original' }, owner.signal),
        ).rejects.toBe(businessFailure);
        innerRequest = undefined;
      }
      if (mode === 'context-cancelled') owner.abort();
      if (mode === 'pause-only') {
        await transport.handoff!(owner.signal);
        expect(transport.releasedSharedPage?.()).toBeNull();
      }
      const closing = transport.close();
      if (mode === 'valid') {
        await disposing.promise;
        expect(transport.releasedSharedPage?.()).toBeNull();
        finishDisposal.resolve();
      }
      const confirmed = ![
        'release-unconfirmed',
        'daemon-unconfirmed',
        'daemon-dispose-failed',
      ].includes(mode);
      expect(await closing).toEqual({ confirmed });
      expect(transport.releasedSharedPage?.()).toBeNull();
      if (mode === 'context-cancelled-after-release') owner.abort();
      if (confirmed) await transport.dispose();
      else await expect(transport.dispose()).rejects.toThrow('desktop_browser_cleanup_unknown');
      const expected =
        mode === 'valid' ||
        mode === 'business-unknown' ||
        mode === 'context-cancelled-after-release'
          ? {
              url: 'https://destination.test/redirected',
              title: 'Retained original',
              identity: { pageId: 'original-page', incarnation: 'original-incarnation' },
            }
          : null;
      expect(transport.releasedSharedPage?.()).toEqual(expected);
      if (expected) {
        const first = transport.releasedSharedPage!()!;
        Reflect.set(first, 'url', 'https://foreign.test/');
        Reflect.set(first.identity!, 'pageId', 'foreign-page');
        expect(transport.releasedSharedPage?.()).toEqual(expected);
        owner.abort();
        expect(transport.releasedSharedPage?.()).toEqual(expected);
        await expect(
          transport.request({ action: 'url' }, new AbortController().signal),
        ).rejects.toThrow('browser_control_not_owned');
      }
    } finally {
      innerRequest = undefined;
      innerCleanup = undefined;
      finishDisposal.resolve();
      owner.abort();
      socket?.close();
      await transport.close();
      await server.stop(true);
    }
  });

test('only a paired failure proof bound to this exact request establishes no dispatch', async () => {
  const request = { op: 'cdp', leaseId: 'lease', method: 'Page.navigate' },
    proof = { kind: 'not_dispatched', ...request };
  let failure: unknown = proof;
  const server = await fixtureServe({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () =>
      Response.json(
        { ok: false, error: 'browser_page_not_ready', dispatched: false, failure },
        { status: 400 },
      ),
  });
  const call = createDesktopBrowserClient(endpoint(server.port!)),
    signal = new AbortController().signal;
  try {
    let caught: unknown;
    try {
      await call(request, signal);
    } catch (e) {
      caught = e;
    }
    expect(caught).toMatchObject({ message: 'browser_page_not_ready', dispatched: false });
    for (const forged of [
      undefined,
      { ...proof, op: 'dialog' },
      { ...proof, leaseId: 'other' },
      { ...proof, method: 'Input.insertText' },
      { ...proof, extra: true },
      { ...proof, kind: 'safe' },
    ]) {
      failure = forged;
      try {
        await call(request, signal);
      } catch (e) {
        caught = e;
      }
      expect(caught).toMatchObject({ message: 'browser_page_not_ready', dispatched: true });
    }
  } finally {
    await server.stop(true);
  }
});

test('a proven acquire refusal confirms no new lease independently of its diagnostic code', async () => {
  const requests: unknown[] = [];
  const server = await fixtureServe({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      requests.push(await request.json());
      return Response.json(
        {
          ok: false,
          error: 'browser_page_scope_denied',
          failure: { kind: 'not_dispatched', op: 'acquire' },
        },
        { status: 400 },
      );
    },
  });
  const owner = new AbortController(),
    before = innerOptions.length;
  const transport = createDesktopBrowserTransport(
    { executable: '/not-spawned', browserPath: '/not-spawned' },
    endpoint(server.port!),
    { sessionId: 'session', executionId: 'job', signal: owner.signal },
    { browserId: 'browser', storeId: async () => 'store' },
  );
  try {
    await expect(transport.ready).rejects.toThrow('browser_page_scope_denied');
    expect(await transport.close()).toEqual({ confirmed: true });
    expect(innerOptions.length).toBe(before);
    expect(requests).toHaveLength(1);
  } finally {
    owner.abort();
    await transport.close();
    await server.stop(true);
  }
});

test('actual Main read failure remains known and a new Run acquires a fresh lease of the same retained page', async () => {
  const host = new NativeBrowserPageHost(),
    scope = { storeId: 'store', sessionId: 'session' };
  let failed = true,
    attaches = 0,
    detaches = 0;
  const dispatched: string[] = [];
  host.add({
    id: 'same-native-page',
    scope,
    alive: () => true,
    attach() {
      attaches++;
    },
    detach() {
      detaches++;
      return true;
    },
    async send(method) {
      dispatched.push(method);
      if (failed) {
        failed = false;
        throw Object.assign(Error('browser_page_pointer_stale'), { dispatched: false });
      }
      return { nodes: [{ nodeId: 'fresh-node' }] };
    },
    typingCursor: async () => null,
    onEvent: () => () => {},
    decorate() {},
    changed() {},
    capture: async () => ({}),
    captureMeta: () => null,
  });
  host.arm('same-native-page', scope);
  const channel = await listenBrowserPageHost(host),
    call = createDesktopBrowserClient(channel.startup),
    signal = new AbortController().signal;
  try {
    const first = await call({
      op: 'acquire',
      ...scope,
      executionId: 'first-job',
      browserId: 'first-browser',
    });
    await call({ op: 'confirm', leaseId: first.leaseId });
    await expect(
      call(
        {
          op: 'cdp',
          leaseId: first.leaseId,
          method: 'Page.navigate',
          params: { url: 'file:///denied' },
        },
        signal,
      ),
    ).rejects.toMatchObject({ message: 'browser_page_navigation_denied', dispatched: false });
    await expect(
      call({ op: 'cdp', leaseId: first.leaseId, method: 'Accessibility.getFullAXTree' }, signal),
    ).rejects.toMatchObject({ message: 'browser_page_request_failed', dispatched: true });
    expect(host.state('same-native-page')?.phase).toBe('agent');
    expect(
      await call(
        { op: 'cdp', leaseId: first.leaseId, method: 'Accessibility.getFullAXTree' },
        signal,
      ),
    ).toEqual({ nodes: [{ nodeId: 'fresh-node' }] });
    await call({ op: 'revoke', leaseId: first.leaseId });
    expect(
      await call({ op: 'release', leaseId: first.leaseId, pause: false, channelRevoked: true }),
    ).toMatchObject({ confirmed: true });
    host.arm('same-native-page', scope);
    const second = await call({
      op: 'acquire',
      ...scope,
      executionId: 'second-job',
      browserId: 'second-browser',
    });
    expect(second.pageId).toBe(first.pageId);
    expect(second.leaseId).not.toBe(first.leaseId);
    await call({ op: 'confirm', leaseId: second.leaseId });
    await expect(
      call(
        {
          op: 'cdp',
          leaseId: first.leaseId,
          method: 'Input.insertText',
          params: { text: 'must-not-replay' },
        },
        signal,
      ),
    ).rejects.toMatchObject({ dispatched: false });
    expect(
      await call(
        { op: 'cdp', leaseId: second.leaseId, method: 'Accessibility.getFullAXTree' },
        signal,
      ),
    ).toEqual({ nodes: [{ nodeId: 'fresh-node' }] });
    expect(dispatched).toEqual([
      'Accessibility.getFullAXTree',
      'Accessibility.getFullAXTree',
      'Accessibility.getFullAXTree',
    ]);
    expect(attaches).toBe(2);
    expect(detaches).toBe(1);
    await call({ op: 'revoke', leaseId: second.leaseId });
    expect(
      await call({ op: 'release', leaseId: second.leaseId, pause: false, channelRevoked: true }),
    ).toMatchObject({ confirmed: true });
  } finally {
    await channel.close();
  }
});

test('actual Host AX envelopes above 512 KiB reach Service and a proven 2 MiB refusal permits the next read', async () => {
  const host = new NativeBrowserPageHost(),
    scope = { storeId: 'store', sessionId: 'session' };
  const atEnvelopeBytes = (bytes: number) => {
    const value = { nodes: [{ nodeId: 'root', name: { value: '' } }] };
    const overhead = Buffer.byteLength(JSON.stringify({ ok: true, value }));
    value.nodes[0]!.name.value = 'x'.repeat(bytes - overhead);
    expect(Buffer.byteLength(JSON.stringify({ ok: true, value }))).toBe(bytes);
    return value;
  };
  const responses = [
    atEnvelopeBytes(600 * 1024),
    atEnvelopeBytes(2 * 1024 * 1024),
    atEnvelopeBytes(2 * 1024 * 1024 + 1),
    { nodes: [{ nodeId: 'fresh', name: { value: 'next original-page observation' } }] },
  ];
  const sent: string[] = [];
  host.add({
    id: 'page',
    scope,
    alive: () => true,
    attach() {},
    detach: () => true,
    async send(method) {
      sent.push(method);
      return responses[sent.length - 1];
    },
    typingCursor: async () => null,
    onEvent: () => () => {},
    decorate() {},
    changed() {},
    capture: async () => ({}),
    captureMeta: () => null,
  });
  host.arm('page', scope);
  const channel = await listenBrowserPageHost(host),
    call = createDesktopBrowserClient(channel.startup),
    owner = new AbortController();
  try {
    const lease = await call({ op: 'acquire', ...scope, executionId: 'job', browserId: 'browser' });
    await call({ op: 'confirm', leaseId: lease.leaseId });
    const request = {
      op: 'cdp',
      leaseId: lease.leaseId,
      method: 'Accessibility.getFullAXTree',
    };
    expect(await call(request, owner.signal)).toEqual(responses[0]);
    expect(await call(request, owner.signal)).toEqual(responses[1]);
    await expect(call(request, owner.signal)).rejects.toMatchObject({
      message: 'browser_page_response_limit',
      kind: 'read_failed',
      dispatched: true,
    });
    expect(sent).toHaveLength(3);
    expect(host.state('page')).toMatchObject({ phase: 'agent', incarnation: lease.incarnation });
    expect(owner.signal.aborted).toBe(false);
    expect(await call(request, owner.signal)).toEqual(responses[3]);
    expect(sent).toEqual(Array(4).fill('Accessibility.getFullAXTree'));
    await call({ op: 'revoke', leaseId: lease.leaseId });
    expect(
      await call({ op: 'release', leaseId: lease.leaseId, pause: false, channelRevoked: true }),
    ).toMatchObject({ confirmed: true });
  } finally {
    owner.abort();
    await channel.close();
  }
});

for (const priorEffect of [false, true])
  test(`paired refusal survives daemon error flattening with prior effect=${priorEffect}`, async () => {
    const cdp: string[] = [];
    const server = await fixtureServe({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const input = (await request.json()) as { op: string; method: string };
        if (input.op === 'acquire')
          return ok({
            leaseId: 'lease',
            pageId: 'page',
            incarnation: 'incarnation',
            navigation: 1,
          });
        if (input.op === 'events') return ok({ events: [], cursor: 0 });
        if (input.op === 'release') return ok({ confirmed: true });
        if (input.op === 'cdp') {
          cdp.push(input.method);
          if (input.method === 'Runtime.evaluate') return ok({ result: { type: 'undefined' } });
          return Response.json(
            {
              ok: false,
              error: 'browser_page_not_ready',
              failure: {
                kind: 'not_dispatched',
                op: 'cdp',
                leaseId: 'lease',
                method: input.method,
              },
            },
            { status: 400 },
          );
        }
        return ok({});
      },
    });
    const owner = new AbortController();
    let transport: NativeBrowserTransport | undefined, ws: WebSocket | undefined;
    try {
      transport = createDesktopBrowserTransport(
        { executable: '/not-spawned', browserPath: '/not-spawned' },
        endpoint(server.port!),
        { sessionId: 'session', executionId: 'job', signal: owner.signal },
        { browserId: 'browser', storeId: async () => 'store' },
      );
      await transport.ready;
      ws = new WebSocket(innerOptions.at(-1)!.attachment!.cdpUrl);
      await new Promise<void>((resolve, reject) => {
        ws!.addEventListener('open', () => resolve(), { once: true });
        ws!.addEventListener('error', reject, { once: true });
      });
      let sequence = 0;
      const send = (method: string) =>
        new Promise<{ id?: number; result?: unknown; error?: { message: string } }>((resolve) => {
          const id = ++sequence;
          const received = (event: MessageEvent) => {
            const reply = JSON.parse(String(event.data));
            if (reply.id === id) {
              ws!.removeEventListener('message', received);
              resolve(reply);
            }
          };
          ws!.addEventListener('message', received);
          ws!.send(JSON.stringify({ id, method, params: {} }));
        });
      innerRequest = async () => {
        if (priorEffect) expect((await send('Runtime.evaluate')).result).toBeDefined();
        expect(await send('Page.navigate')).toMatchObject({
          error: { message: 'browser_page_not_ready' },
        });
        // A daemon may catch a flattened CDP failure. This request's sticky Host
        // evidence still prevents a queued fallback from operating the page.
        expect((await send('Input.insertText')).error).toBeDefined();
        return { success: false, error: 'CDP command failed' };
      };
      let caught: unknown;
      try {
        await transport.request({ action: 'fixture_navigation' }, owner.signal);
      } catch (e) {
        caught = e;
      }
      expect(caught).toMatchObject({ message: 'browser_page_not_ready', dispatched: priorEffect });
      expect(cdp).toEqual(priorEffect ? ['Runtime.evaluate', 'Page.navigate'] : ['Page.navigate']);
      innerRequest = undefined;
      expect(await transport.close()).toEqual({ confirmed: true });
    } finally {
      innerRequest = undefined;
      owner.abort();
      ws?.close();
      await transport?.close();
      await server.stop(true);
    }
  });

const disabledWebMcpLaunch = {
  action: 'launch',
  headless: true,
  engine: 'chrome',
  webmcp: false,
};

for (const mode of ['event-before-ack', 'event-after-ack', 'post-navigation-read-failed'] as const)
  test(`compatibility CDP lifecycle preserves redirected identity and effects: ${mode}`, async () => {
    const host = new NativeBrowserPageHost(),
      scope = { storeId: 'store', sessionId: 'session' },
      redirected = 'https://destination.test/final',
      lifecycleReceived = deferred<void>();
    const methods: string[] = [],
      receivedEvents: { method: string; params: unknown; sessionId?: string }[] = [];
    let emit!: (method: string, params: unknown) => void,
      pageUrl = 'about:blank',
      navigationAcknowledged = false;
    const publishLifecycle = () => emit('Page.domContentEventFired', { timestamp: 1 });
    host.add({
      id: 'original-page',
      scope,
      alive: () => true,
      attach() {},
      detach: () => true,
      async send(method, params) {
        methods.push(method);
        if (method === 'Page.navigate') {
          expect(params.url).toBe('https://source.test/redirect');
          host.navigate('original-page');
          pageUrl = redirected;
          emit('Page.frameNavigated', {
            frame: { id: 'root-frame', loaderId: 'redirect-loader', url: redirected },
          });
          if (mode === 'event-before-ack') {
            publishLifecycle();
            // Exercise real event polling while the exact CDP response is pending.
            await lifecycleReceived.promise;
            expect(navigationAcknowledged).toBe(false);
          }
          return { frameId: 'root-frame', loaderId: 'redirect-loader' };
        }
        if (method === 'Page.getFrameTree') {
          if (mode === 'post-navigation-read-failed') throw Error('fixture_read_failure');
          return { frameTree: { frame: { id: 'root-frame', url: pageUrl } } };
        }
        return {};
      },
      typingCursor: async () => null,
      onEvent(listener) {
        emit = listener;
        return () => {};
      },
      decorate() {},
      changed() {},
      capture: async () => ({}),
      captureMeta: () => null,
    });
    host.arm('original-page', scope);
    host.configureGrantContext({
      selectedScope: () => ({ ...scope, generation: 1, viewSelection: 1 }),
      create() {
        throw Error('fixture_does_not_create_pages');
      },
      describe: () => ({ url: pageUrl, title: 'Redirected original' }),
      close() {},
    });
    const originalIncarnation = host.state('original-page')!.incarnation;
    const channel = await listenBrowserPageHost(host),
      owner = new AbortController();
    let transport: NativeBrowserTransport | undefined, ws: WebSocket | undefined;
    const disposals: (() => void)[] = [];
    try {
      transport = createDesktopBrowserTransport(
        { executable: '/not-spawned', browserPath: '/not-spawned' },
        channel.startup,
        { sessionId: scope.sessionId, executionId: 'job', signal: owner.signal },
        { browserId: 'browser', storeId: async () => scope.storeId },
      );
      await transport.ready;
      await transport.request(disabledWebMcpLaunch, owner.signal);
      ws = new WebSocket(innerOptions.at(-1)!.attachment!.cdpUrl);
      await new Promise<void>((resolve, reject) => {
        ws!.addEventListener('open', () => resolve(), { once: true });
        ws!.addEventListener('error', reject, { once: true });
      });
      const eventReceived = (event: MessageEvent) => {
        const value = JSON.parse(String(event.data));
        if (!value.method) return;
        receivedEvents.push(value);
        if (value.method === 'Page.domContentEventFired' && value.sessionId === '')
          lifecycleReceived.resolve();
      };
      ws.addEventListener('message', eventReceived);
      disposals.push(() => ws!.removeEventListener('message', eventReceived));
      let sequence = 0;
      const send = (method: string, params: Record<string, unknown> = {}) =>
        new Promise<{
          result?: { frameTree?: { frame: { url: string } } };
          error?: { code: number; message: string };
        }>((resolve, reject) => {
          const id = ++sequence;
          const timer = setTimeout(() => reject(Error('fixture_cdp_reply_timeout')), 2000);
          const received = (event: MessageEvent) => {
            const reply = JSON.parse(String(event.data));
            if (reply.id !== id) return;
            clearTimeout(timer);
            ws!.removeEventListener('message', received);
            resolve(reply);
          };
          disposals.push(() => {
            clearTimeout(timer);
            ws!.removeEventListener('message', received);
          });
          ws!.addEventListener('message', received);
          ws!.send(JSON.stringify({ id, method, params }));
        });
      innerRequest = async () => {
        // The daemon is mocked in this file. Reproduce the pinned reader's
        // subscribe-before-navigate order; this tests the real HTTP/WS bridge.
        expect(await send('Page.navigate', { url: 'https://source.test/redirect' })).toMatchObject({
          result: { frameId: 'root-frame', loaderId: 'redirect-loader' },
        });
        navigationAcknowledged = true;
        if (mode !== 'event-before-ack') publishLifecycle();
        await Promise.race([
          lifecycleReceived.promise,
          sleepTimer(2000).then(() => {
            throw Error('fixture_dom_content_not_forwarded');
          }),
        ]);
        const observed = await send('Page.getFrameTree');
        if (mode === 'post-navigation-read-failed') {
          expect(observed.error).toEqual({ code: -32000, message: 'browser_page_request_failed' });
          expect((await send('Input.insertText', { text: 'must-not-replay' })).error).toBeDefined();
          return { success: false, error: 'CDP command failed' };
        }
        return { success: true, data: { url: observed.result?.frameTree?.frame.url } };
      };
      if (mode === 'post-navigation-read-failed')
        await expect(
          transport.request({ action: 'fixture_navigation' }, owner.signal),
        ).rejects.toMatchObject({
          message: 'browser_page_request_failed',
          dispatched: true,
        });
      else
        expect(await transport.request({ action: 'fixture_navigation' }, owner.signal)).toEqual({
          success: true,
          data: { url: redirected },
        });
      expect(navigationAcknowledged).toBe(true);
      expect(receivedEvents).toEqual([
        {
          method: 'Page.frameNavigated',
          params: { frame: { id: 'root-frame', loaderId: 'redirect-loader', url: redirected } },
          sessionId: '',
        },
        { method: 'Page.domContentEventFired', params: { timestamp: 1 }, sessionId: '' },
      ]);
      expect(methods).toEqual(['Page.navigate', 'Page.getFrameTree']);
      expect(pageUrl).toBe(redirected);
      expect(host.state('original-page')?.phase).toBe('agent');
      innerRequest = undefined;
      expect(await transport.close()).toEqual({ confirmed: true });
      expect(host.state('original-page')?.phase).toBe('human');
      await transport.dispose();
      expect(transport.releasedSharedPage?.()).toEqual({
        url: redirected,
        title: 'Redirected original',
        identity: { pageId: 'original-page', incarnation: originalIncarnation },
      });
    } finally {
      innerRequest = undefined;
      owner.abort();
      for (const dispose of disposals) dispose();
      ws?.close();
      await transport?.close();
      await channel.close();
    }
  });

test('the fixed direct-page initializer survives Main denying its optional probe without allowing the method', async () => {
  const host = new NativeBrowserPageHost(),
    scope = { storeId: 'store', sessionId: 'session' },
    sent: string[] = [];
  host.add({
    id: 'page',
    scope,
    alive: () => true,
    attach() {},
    detach: () => true,
    async send(method) {
      sent.push(method);
      if (method === 'Runtime.evaluate')
        return { result: { type: 'string', value: 'https://fixture.test/same-page' } };
      return {};
    },
    typingCursor: async () => null,
    onEvent: () => () => {},
    decorate() {},
    changed() {},
    capture: async () => ({}),
    captureMeta: () => null,
  });
  host.configureGrantContext({
    selectedScope: () => ({ ...scope, generation: 1, viewSelection: 1 }),
    create() {
      throw Error('fixture_must_not_create');
    },
    describe: () => ({ url: 'https://fixture.test/same-page', title: 'Same Main page' }),
    close() {},
  });
  host.arm('page', scope);
  const channel = await listenBrowserPageHost(host),
    owner = new AbortController();
  let transport: NativeBrowserTransport | undefined, ws: WebSocket | undefined;
  try {
    transport = createDesktopBrowserTransport(
      { executable: '/not-spawned', browserPath: '/not-spawned' },
      channel.startup,
      { sessionId: scope.sessionId, executionId: 'job', signal: owner.signal },
      { browserId: 'browser', storeId: async () => scope.storeId },
    );
    await transport.ready;
    ws = new WebSocket(innerOptions.at(-1)!.attachment!.cdpUrl);
    await new Promise<void>((resolve, reject) => {
      ws!.addEventListener('open', () => resolve(), { once: true });
      ws!.addEventListener('error', reject, { once: true });
    });
    let sequence = 0;
    const send = (method: string) =>
      new Promise<{ result?: { result?: { value?: string } }; error?: { message: string } }>(
        (resolve) => {
          const id = ++sequence;
          const received = (event: MessageEvent) => {
            const reply = JSON.parse(String(event.data));
            if (reply.id === id) {
              ws!.removeEventListener('message', received);
              resolve(reply);
            }
          };
          ws!.addEventListener('message', received);
          ws!.send(JSON.stringify({ id, method }));
        },
      );
    innerRequest = async (command) => {
      if (command.action === 'launch') {
        // Exact pinned browser.rs::enable_domains_direct initialization order.
        for (const method of [
          'Page.enable',
          'Runtime.enable',
          'Runtime.runIfWaitingForDebugger',
          'Network.enable',
        ])
          expect((await send(method)).error).toBeUndefined();
        expect(await send('WebMCP.enable')).toMatchObject({
          error: { message: 'browser_page_method_denied' },
        });
        return { success: true, data: {} };
      }
      throw Error('metadata_must_not_use_the_daemon');
    };
    expect(await transport.request(disabledWebMcpLaunch, owner.signal)).toEqual({
      success: true,
      data: {},
    });
    expect(host.state('page')?.phase).toBe('agent');
    expect(await transport.request({ action: 'url' }, owner.signal)).toEqual({
      success: true,
      data: { url: 'https://fixture.test/same-page', title: 'Same Main page' },
    });
    expect(sent).toEqual([
      'Page.enable',
      'Runtime.enable',
      'Runtime.runIfWaitingForDebugger',
      'Network.enable',
    ]);
    expect(await transport.close()).toEqual({ confirmed: true });
  } finally {
    innerRequest = undefined;
    owner.abort();
    ws?.close();
    await transport?.close();
    await channel.close();
  }
});

for (const variant of [
  { name: 'the exact disabled optional probe', accepted: true },
  { name: 'a business read', action: 'snapshot' },
  { name: 'an enabled WebMCP launch', webmcp: true },
  { name: 'a launch missing the disabled flag', omitFlag: true },
  { name: 'a required startup method', method: 'Page.enable' },
  {
    name: 'another optional method with possible effects',
    method: 'Runtime.runIfWaitingForDebugger',
  },
  { name: 'nonempty probe parameters', params: { unexpected: true } },
  { name: 'a foreign CDP session', sessionId: 'other-session' },
  { name: 'a stale page refusal', error: 'browser_page_not_ready' },
  { name: 'a read failure', kind: 'read_failed' },
  { name: 'an unknown effect', kind: 'effect_unknown', unknown: true },
  { name: 'an unproven failure', noProof: true, unknown: true },
  { name: 'a proof for another method', wrongMethod: true, unknown: true },
  { name: 'a prior failed required command', priorFailure: true },
] as const)
  test(`launch preserves optional-probe boundaries: ${variant.name}`, async () => {
    const mode: {
      accepted?: boolean;
      action?: string;
      webmcp?: boolean;
      omitFlag?: boolean;
      method?: string;
      params?: Record<string, unknown>;
      sessionId?: string;
      error?: string;
      kind?: string;
      noProof?: boolean;
      wrongMethod?: boolean;
      unknown?: boolean;
      priorFailure?: boolean;
    } = variant;
    const method = mode.method ?? 'WebMCP.enable',
      diagnostic = mode.priorFailure
        ? 'browser_page_request_failed'
        : (mode.error ?? 'browser_page_method_denied');
    const cdp: string[] = [];
    let confirms = 0;
    const server = await fixtureServe({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const input = (await request.json()) as { op: string; method?: string };
        if (input.op === 'acquire')
          return ok({
            leaseId: 'lease',
            pageId: 'page',
            incarnation: 'incarnation',
            navigation: 1,
          });
        if (input.op === 'events') return ok({ events: [], cursor: 0 });
        if (input.op === 'release') return ok({ confirmed: true });
        if (input.op === 'confirm') confirms++;
        if (input.op !== 'cdp') return ok({});
        cdp.push(input.method!);
        if (input.method === 'Page.getFrameTree') return ok({ frameTree: {} });
        return Response.json(
          {
            ok: false,
            error: diagnostic,
            ...(mode.noProof
              ? {}
              : {
                  failure: {
                    kind: mode.kind ?? 'not_dispatched',
                    op: 'cdp',
                    leaseId: 'lease',
                    method: mode.wrongMethod ? 'Input.insertText' : input.method,
                  },
                }),
          },
          { status: 400 },
        );
      },
    });
    const owner = new AbortController();
    let transport: NativeBrowserTransport | undefined, ws: WebSocket | undefined;
    try {
      transport = createDesktopBrowserTransport(
        { executable: '/not-spawned', browserPath: '/not-spawned' },
        endpoint(server.port!),
        { sessionId: 'session', executionId: 'job', signal: owner.signal },
        { browserId: 'browser', storeId: async () => 'store' },
      );
      await transport.ready;
      ws = new WebSocket(innerOptions.at(-1)!.attachment!.cdpUrl);
      await new Promise<void>((resolve, reject) => {
        ws!.addEventListener('open', () => resolve(), { once: true });
        ws!.addEventListener('error', reject, { once: true });
      });
      let sequence = 0;
      const send = (sentMethod: string, extra: Record<string, unknown> = {}) =>
        new Promise<{ result?: unknown; error?: { message: string } }>((resolve) => {
          const id = ++sequence;
          const received = (event: MessageEvent) => {
            const reply = JSON.parse(String(event.data));
            if (reply.id === id) {
              ws!.removeEventListener('message', received);
              resolve(reply);
            }
          };
          ws!.addEventListener('message', received);
          ws!.send(JSON.stringify({ id, method: sentMethod, params: {}, ...extra }));
        });
      innerRequest = async () => {
        if (mode.priorFailure) expect((await send('Page.enable')).error).toBeDefined();
        // Match the fixed provider: optional-probe errors are deliberately ignored.
        expect(
          (
            await send(method, {
              params: mode.params ?? {},
              ...(mode.sessionId ? { sessionId: mode.sessionId } : {}),
            })
          ).error,
        ).toBeDefined();
        const next = await send('Page.getFrameTree');
        expect(next.error === undefined).toBe(mode.accepted === true);
        return { success: true, data: {} };
      };
      const { webmcp: _disabled, ...withoutFlag } = disabledWebMcpLaunch;
      const command = {
        ...(mode.omitFlag ? withoutFlag : disabledWebMcpLaunch),
        ...(mode.action ? { action: mode.action } : {}),
        ...(mode.webmcp === undefined ? {} : { webmcp: mode.webmcp }),
      };
      if (mode.accepted)
        expect(await transport.request(command, owner.signal)).toEqual({ success: true, data: {} });
      else
        await expect(transport.request(command, owner.signal)).rejects.toMatchObject({
          message: diagnostic,
          dispatched: mode.unknown === true || mode.kind === 'effect_unknown',
        });
      expect(cdp).toEqual(
        mode.accepted
          ? ['WebMCP.enable', 'Page.getFrameTree']
          : mode.priorFailure
            ? ['Page.enable']
            : [method],
      );
      expect(confirms).toBe(mode.accepted ? 1 : 0);
      expect(owner.signal.aborted).toBe(false);
    } finally {
      innerRequest = undefined;
      owner.abort();
      ws?.close();
      await transport?.close();
      await server.stop(true);
    }
  });

// This crosses the actual former HTTP deadline; no fake clock or model is involved.
for (const operation of ['cdp', 'navigate'] as const)
  test(`a dispatched ${operation} reply keeps its original owner deadline beyond ten seconds`, async () => {
    const input: Record<string, unknown> =
      operation === 'cdp'
        ? {
            op: 'cdp',
            leaseId: 'lease',
            method: 'Page.navigate',
            params: { url: 'https://fixture.test/delayed' },
          }
        : { op: 'navigate', leaseId: 'lease', url: 'https://fixture.test/delayed' };
    const receipt =
      operation === 'cdp'
        ? { frameId: 'original-frame', loaderId: 'original-loader' }
        : {
            leaseId: 'lease',
            pageId: 'page',
            incarnation: 'original',
            navigation: 1,
            url: 'https://fixture.test/delayed',
            title: 'Delayed',
          };
    const entered = deferred<void>(),
      release = deferred<void>();
    let calls = 0;
    const supplied = { authorization: null as string | null };
    const server = await fixtureServe({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        calls++;
        supplied.authorization = request.headers.get('authorization');
        expect(await request.json()).toEqual(input);
        entered.resolve();
        await release.promise;
        return ok(receipt);
      },
    });
    const owner = new AbortController();
    let settled = false;
    const result = createDesktopBrowserClient(endpoint(server.port!))(input, owner.signal).then(
      (value) => {
        settled = true;
        return { value, error: undefined };
      },
      (error) => {
        settled = true;
        return { value: undefined, error };
      },
    );
    try {
      await entered.promise;
      await sleepTimer(10200);
      expect(settled).toBe(false);
      expect(owner.signal.aborted).toBe(false);
      expect(calls).toBe(1);
      expect(supplied.authorization).toBe(`Bearer ${token}`);
      release.resolve();
      expect(await result).toEqual({
        value: receipt,
        error: undefined,
      });
    } finally {
      owner.abort();
      release.resolve();
      await result;
      await server.stop(true);
    }
  }, 15000);

test('non-CDP private requests retain their ten-second bound without aborting the caller owner', async () => {
  const entered = deferred<void>(),
    release = deferred<void>();
  let calls = 0;
  const server = await fixtureServe({
    hostname: '127.0.0.1',
    port: 0,
    async fetch() {
      calls++;
      entered.resolve();
      await release.promise;
      return ok({ revoked: true });
    },
  });
  const owner = new AbortController();
  const at = performance.now();
  const result = createDesktopBrowserClient(endpoint(server.port!))(
    { op: 'revoke', leaseId: 'lease' },
    owner.signal,
  ).then(
    (value) => ({ value, error: undefined }),
    (error) => ({ value: undefined, error }),
  );
  try {
    await entered.promise;
    const reply = await result;
    expect(reply.error).toBeInstanceOf(Error);
    expect(reply.value).toBeUndefined();
    expect(performance.now() - at).toBeGreaterThanOrEqual(9500);
    expect(performance.now() - at).toBeLessThan(14000);
    expect(owner.signal.aborted).toBe(false);
    expect(calls).toBe(1);
  } finally {
    owner.abort();
    release.resolve();
    await result;
    await server.stop(true);
  }
}, 15000);

test('CDP needs an owner signal and cancelled owners never dispatch a request', async () => {
  let calls = 0;
  const server = await fixtureServe({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      calls++;
      return ok({});
    },
  });
  try {
    const call = createDesktopBrowserClient(endpoint(server.port!));
    await expect(call({ op: 'cdp', leaseId: 'lease', method: 'Page.navigate' })).rejects.toThrow(
      'desktop_browser_cdp_signal_required',
    );
    const owner = new AbortController();
    owner.abort();
    await expect(
      call({ op: 'cdp', leaseId: 'lease', method: 'Page.navigate' }, owner.signal),
    ).rejects.toBeDefined();
    expect(calls).toBe(0);
  } finally {
    await server.stop(true);
  }
});

test('authentication failures and the original per-response byte limits remain terminal without retry', async () => {
  let calls = 0;
  const server = await fixtureServe({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      calls++;
      expect(request.headers.get('authorization')).toBe(`Bearer ${token}`);
      const input = (await request.json()) as { mode: string };
      if (input.mode === 'deny')
        return Response.json({ ok: false, error: 'native_sender_denied' }, { status: 403 });
      const length = input.mode === 'large' ? 6 * 1024 * 1024 : 600 * 1024;
      return ok({ data: 'x'.repeat(length) });
    },
  });
  const call = createDesktopBrowserClient(endpoint(server.port!)),
    owner = new AbortController();
  try {
    await expect(call({ op: 'revoke', mode: 'deny' })).rejects.toThrow('native_sender_denied');
    await expect(
      call({ op: 'cdp', method: 'Runtime.evaluate', mode: 'normal' }, owner.signal),
    ).rejects.toThrow('desktop_browser_response_limit');
    await expect(
      call({ op: 'cdp', method: 'Accessibility.getPartialAXTree', mode: 'normal' }, owner.signal),
    ).rejects.toThrow('desktop_browser_response_limit');
    expect(
      (
        await call(
          { op: 'cdp', method: 'Accessibility.getFullAXTree', mode: 'normal' },
          owner.signal,
        )
      ).data,
    ).toHaveLength(600 * 1024);
    await expect(
      call({ op: 'cdp', method: 'Accessibility.getFullAXTree', mode: 'large' }, owner.signal),
    ).rejects.toThrow('desktop_browser_response_limit');
    expect(
      (await call({ op: 'cdp', method: 'Page.captureScreenshot', mode: 'normal' }, owner.signal))
        .data,
    ).toHaveLength(600 * 1024);
    await expect(
      call({ op: 'cdp', method: 'Page.captureScreenshot', mode: 'large' }, owner.signal),
    ).rejects.toThrow('desktop_browser_response_limit');
    await expect(
      call({ op: 'capture', method: 'Accessibility.getFullAXTree', mode: 'normal' }),
    ).rejects.toThrow('desktop_browser_response_limit');
    expect(calls).toBe(8);
    expect(owner.signal.aborted).toBe(false);
  } finally {
    owner.abort();
    await server.stop(true);
  }
});

test('an oversized untrusted AX stream is cancelled without retry or aborting the owner', async () => {
  let calls = 0,
    cancellations = 0;
  const cancelled = deferred<void>();
  const server = await fixtureServe({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      calls++;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const chunk = new Uint8Array(256 * 1024).fill(120);
            for (let index = 0; index < 9; index++) controller.enqueue(chunk);
            // Stay open so a completed stream cannot masquerade as cancellation.
          },
          cancel() {
            cancellations++;
            cancelled.resolve();
          },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    },
  });
  const call = createDesktopBrowserClient(endpoint(server.port!)),
    owner = new AbortController();
  try {
    await expect(
      call({ op: 'cdp', method: 'Accessibility.getFullAXTree' }, owner.signal),
    ).rejects.toThrow('desktop_browser_response_limit');
    await Promise.race([
      cancelled.promise,
      sleepTimer(2000).then(() => {
        throw Error('oversized_stream_cancellation_not_observed');
      }),
    ]);
    expect(calls).toBe(1);
    expect(cancellations).toBe(1);
    expect(owner.signal.aborted).toBe(false);
  } finally {
    owner.abort();
    await server.stop(true);
  }
});

test('original transport cancellation aborts its pending CDP and queued commands cannot dispatch late or claim cleanup', async () => {
  const host = new NativeBrowserPageHost(),
    scope = { storeId: 'store', sessionId: 'session' };
  const started = deferred<void>(),
    reply = deferred<unknown>(),
    finished = deferred<void>();
  const methods: string[] = [];
  let attached = false;
  host.add({
    id: 'page',
    scope,
    alive: () => true,
    attach() {
      attached = true;
    },
    detach() {
      attached = false;
      return true;
    },
    async send(method) {
      methods.push(method);
      started.resolve();
      try {
        return await reply.promise;
      } finally {
        finished.resolve();
      }
    },
    typingCursor: async () => null,
    onEvent: () => () => {},
    decorate() {},
    changed() {},
    capture: async () => ({}),
    captureMeta: () => null,
  });
  host.arm('page', scope);
  const channel = await listenBrowserPageHost(host),
    owner = new AbortController();
  let transport: NativeBrowserTransport | undefined, ws: WebSocket | undefined;
  try {
    transport = createDesktopBrowserTransport(
      { executable: '/fixture/not-spawned', browserPath: '/fixture/not-spawned' },
      channel.startup,
      { sessionId: scope.sessionId, executionId: 'job', signal: owner.signal },
      { browserId: 'browser', storeId: async () => scope.storeId },
    );
    await transport.ready;
    await transport.request({ action: 'launch' }, owner.signal);
    expect(attached).toBe(true);
    ws = new WebSocket(innerOptions.at(-1)!.attachment!.cdpUrl);
    await new Promise<void>((resolve, reject) => {
      ws!.addEventListener('open', () => resolve(), { once: true });
      ws!.addEventListener('error', reject, { once: true });
    });
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'first' } }));
    ws.send(
      JSON.stringify({
        id: 2,
        method: 'Runtime.evaluate',
        params: { expression: 'must-not-dispatch' },
      }),
    );
    await started.promise;
    owner.abort();
    expect(await transport.close()).toEqual({ confirmed: false });
    expect(await transport.completion).toEqual({ confirmed: false });
    expect(host.state('page')?.phase).toBe('unknown');
    expect(methods).toEqual(['Runtime.evaluate']);
    expect(attached).toBe(false);
    await expect(transport.dispose()).rejects.toThrow('desktop_browser_cleanup_unknown');
    reply.resolve({ result: { type: 'undefined' } });
    await finished.promise;
    await sleepTimer(20);
    expect(methods).toEqual(['Runtime.evaluate']);
    expect(await transport.close()).toEqual({ confirmed: false });
  } finally {
    owner.abort();
    ws?.close();
    reply.resolve({});
    await transport?.close();
    if (methods.length) await finished.promise;
    await channel.close();
  }
}, 10000);

for (const changedOwner of [false, true])
  test(`a reconnected direct-page socket cannot adopt a replacement page or owner: ${changedOwner}`, async () => {
    const host = new NativeBrowserPageHost(),
      scope = { storeId: 'store', sessionId: 'session' },
      dispatched: string[] = [],
      requests: Record<string, unknown>[] = [];
    const add = (owner: typeof scope) =>
      host.add({
        id: 'page',
        scope: owner,
        alive: () => true,
        attach() {},
        detach: () => true,
        async send(method) {
          dispatched.push(method);
          return {};
        },
        typingCursor: async () => null,
        onEvent: () => () => {},
        decorate() {},
        changed() {},
        capture: async () => ({}),
        captureMeta: () => null,
      });
    const removeOriginal = add(scope),
      originalIncarnation = host.state('page')!.incarnation,
      mainRequest = host.request.bind(host),
      mainSerialized = host.requestSerialized.bind(host);
    // Keep the polling lane quiet so this exercises the reconnected command's
    // own Main lease check rather than relying on an earlier polling failure.
    host.requestSerialized = async (input, signal) => {
      const request = input as Record<string, unknown>;
      requests.push(request);
      return request.op === 'events'
        ? JSON.stringify({ ok: true, value: { events: [], cursor: 0 } })
        : mainSerialized(input, signal);
    };
    host.arm('page', scope);
    const channel = await listenBrowserPageHost(host),
      owner = new AbortController();
    let transport: NativeBrowserTransport | undefined, ws: WebSocket | undefined;
    let removeReplacement: (() => void) | undefined;
    let replacementLease: { leaseId: string } | undefined;
    const connect = async (url: string) => {
      const socket = new WebSocket(url);
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve(), { once: true });
        socket.addEventListener('error', reject, { once: true });
      });
      return socket;
    };
    try {
      transport = createDesktopBrowserTransport(
        { executable: '/fixture/not-spawned', browserPath: '/fixture/not-spawned' },
        channel.startup,
        { sessionId: scope.sessionId, executionId: 'original-job', signal: owner.signal },
        { browserId: 'original-browser', storeId: async () => scope.storeId },
      );
      await transport.ready;
      await transport.request({ action: 'launch' }, owner.signal);
      expect(transport.sharedPageIdentity?.()).toEqual({
        pageId: 'page',
        incarnation: originalIncarnation,
      });
      const proxyUrl = innerOptions.at(-1)!.attachment!.cdpUrl;
      ws = await connect(proxyUrl);
      await new Promise<void>((resolve) => {
        ws!.addEventListener('close', () => resolve(), { once: true });
        ws!.close();
      });
      removeOriginal();
      const nextScope = changedOwner ? { ...scope, sessionId: 'another-task' } : scope;
      removeReplacement = add(nextScope);
      expect(host.state('page')!.incarnation).not.toBe(originalIncarnation);
      host.arm('page', nextScope);
      replacementLease = (await mainRequest({
        op: 'acquire',
        ...nextScope,
        executionId: 'replacement-job',
        browserId: 'replacement-browser',
      })) as { leaseId: string };
      await mainRequest({ op: 'confirm', leaseId: replacementLease.leaseId });
      ws = await connect(proxyUrl);
      const reply = new Promise<Record<string, unknown>>((resolve) => {
        ws!.addEventListener('message', (event) => {
          const value = JSON.parse(String(event.data));
          if (value.id === 1) resolve(value);
        });
      });
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'Input.insertText',
          params: { text: 'must-not-dispatch' },
        }),
      );
      expect(await reply).toMatchObject({ error: { message: 'browser_page_lease_stale' } });
      expect(dispatched).toEqual([]);
      expect(requests.filter((request) => request.op === 'acquire')).toHaveLength(1);
      expect(host.state('page')).toMatchObject({
        phase: 'agent',
        sessionId: nextScope.sessionId,
        browserId: 'replacement-browser',
      });
      expect(transport.sharedPageIdentity?.()).toEqual({
        pageId: 'page',
        incarnation: originalIncarnation,
      });
    } finally {
      owner.abort();
      ws?.close();
      await transport?.close();
      if (replacementLease) {
        await mainRequest({ op: 'revoke', leaseId: replacementLease.leaseId });
        await mainRequest({
          op: 'release',
          leaseId: replacementLease.leaseId,
          channelRevoked: true,
        });
      }
      removeReplacement?.();
      await channel.close();
    }
  }, 10000);

async function ownedDriverFixture(options: { requestTimeoutMs?: number } = {}) {
  const acquired = {
    leaseId: 'owned-lease',
    pageId: 'owned-page',
    incarnation: 'original',
    navigation: 0,
  };
  const owner = new AbortController();
  const requests: Record<string, unknown>[] = [];
  const state = { ...acquired, url: 'about:blank', title: 'New page' };
  let reply: ((operation: string) => unknown | Promise<unknown>) | undefined;
  let cdpReply: ((request: Record<string, unknown>) => Response) | undefined;
  const server = await fixtureServe({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const value = (await request.json()) as Record<string, unknown>;
      requests.push(value);
      if (value.op === 'acquire') return ok(acquired);
      if (value.op === 'events') return ok({ events: [], cursor: 0 });
      if (value.op === 'confirm') return ok({ ...acquired });
      if (value.op === 'revoke') return ok({ revoked: true });
      if (value.op === 'release') return ok({ confirmed: true, detached: true });
      if (value.op === 'cdp' && cdpReply) return cdpReply(value);
      if (value.op === 'pageState' || value.op === 'navigate') {
        if (value.op === 'navigate') {
          state.url = 'https://owned.test/redirected';
          state.title = 'Actual Main title';
          state.navigation++;
        }
        const result = reply ? await reply(String(value.op)) : { ...state };
        return result instanceof Response ? result : ok(result);
      }
      throw Error('fixture_unexpected_owned_operation');
    },
  });
  const transport = createDesktopBrowserTransport(
    { executable: '/fixture/not-spawned', browserPath: '/fixture/not-spawned', ...options },
    endpoint(server.port!),
    { sessionId: 'owned-session', executionId: 'owned-job', signal: owner.signal },
    { browserId: 'owned-browser', storeId: async () => 'owned-store' },
  );
  return {
    owner,
    requests,
    state,
    transport,
    setReply(value: typeof reply) {
      reply = value;
    },
    setCdpReply(value: typeof cdpReply) {
      cdpReply = value;
    },
    async cleanup() {
      owner.abort();
      await transport.close();
      await server.stop(true);
    },
  };
}

test('Native navigation and metadata use exact Main receipts without daemon helper commands', async () => {
  const fixture = await ownedDriverFixture();
  const daemonCommands: string[] = [];
  innerRequest = async (command) => {
    daemonCommands.push(command.action);
    if (['navigate', 'url', 'title'].includes(command.action))
      throw Error('must-not-use-daemon-helper');
    return { success: true, data: {} };
  };
  try {
    await fixture.transport.ready;
    await fixture.transport.request({ action: 'launch' }, fixture.owner.signal);
    expect(await fixture.transport.request({ action: 'url' }, fixture.owner.signal)).toEqual({
      success: true,
      data: { url: 'about:blank', title: 'New page' },
    });
    expect(
      await fixture.transport.request(
        { action: 'navigate', url: 'https://owned.test/start', waitUntil: 'domcontentloaded' },
        fixture.owner.signal,
      ),
    ).toEqual({
      success: true,
      data: { url: 'https://owned.test/redirected', title: 'Actual Main title' },
    });
    expect(await fixture.transport.request({ action: 'title' }, fixture.owner.signal)).toEqual({
      success: true,
      data: { title: 'Actual Main title' },
    });
    fixture.state.title = '';
    expect(await fixture.transport.request({ action: 'url' }, fixture.owner.signal)).toEqual({
      success: true,
      data: { url: 'https://owned.test/redirected', title: '' },
    });
    const callback = innerOptions.at(-1)!.attachment!.readPageState!;
    expect(await callback(fixture.owner.signal)).toEqual({
      url: fixture.state.url,
      title: fixture.state.title,
    });
    expect(fixture.requests.filter((row) => row.op === 'navigate')).toEqual([
      { op: 'navigate', leaseId: 'owned-lease', url: 'https://owned.test/start' },
    ]);
    expect(daemonCommands).toEqual(['launch']);
    expect(await fixture.transport.close()).toEqual({ confirmed: true });
    await expect(callback(fixture.owner.signal)).rejects.toMatchObject({ dispatched: false });
  } finally {
    innerRequest = undefined;
    await fixture.cleanup();
  }
});

for (const mode of [
  'page',
  'lease',
  'incarnation',
  'navigation',
  'credential',
  'scheme',
  'title',
  'extra',
  'missing',
] as const)
  test(`Main owned ${mode} receipt failure never supplies state or falls back to the daemon`, async () => {
    const fixture = await ownedDriverFixture();
    let daemonReads = 0;
    innerRequest = async () => {
      daemonReads++;
      return { success: true, data: {} };
    };
    try {
      await fixture.transport.ready;
      await fixture.transport.request({ action: 'launch' }, fixture.owner.signal);
      const before = daemonReads;
      fixture.setReply(() => {
        const value: Record<string, unknown> = { ...fixture.state };
        if (mode === 'page') value.pageId = 'same-url-other-page';
        if (mode === 'lease') value.leaseId = 'other-lease';
        if (mode === 'incarnation') value.incarnation = 'replaced';
        if (mode === 'navigation') value.navigation = -1;
        if (mode === 'credential') value.url = 'https://user:secret@owned.test/';
        if (mode === 'scheme') value.url = 'file:///private/';
        if (mode === 'title') value.title = 'x'.repeat(129);
        if (mode === 'extra') value.extra = 'unverified';
        if (mode === 'missing') delete value.incarnation;
        return value;
      });
      await expect(
        fixture.transport.request({ action: 'url' }, fixture.owner.signal),
      ).rejects.toMatchObject({ message: 'desktop_browser_page_state_invalid', dispatched: true });
      expect(daemonReads).toBe(before);
      expect(fixture.requests.filter((row) => row.op === 'pageState')).toHaveLength(1);
      expect(await fixture.transport.close()).toEqual({ confirmed: false });
    } finally {
      innerRequest = undefined;
      await fixture.cleanup();
    }
  });

test('a previous Main state cannot move navigation backwards or acquire a new identity', async () => {
  const fixture = await ownedDriverFixture();
  try {
    await fixture.transport.ready;
    await fixture.transport.request({ action: 'launch' }, fixture.owner.signal);
    fixture.state.navigation = 5;
    await fixture.transport.request({ action: 'url' }, fixture.owner.signal);
    fixture.state.navigation = 4;
    await expect(
      fixture.transport.request({ action: 'title' }, fixture.owner.signal),
    ).rejects.toMatchObject({ message: 'desktop_browser_page_state_invalid' });
    expect(await fixture.transport.close()).toEqual({ confirmed: false });
  } finally {
    await fixture.cleanup();
  }
});

test('owned navigation retains its one original call across cancellation and rejects overlapping work', async () => {
  const fixture = await ownedDriverFixture();
  const entered = deferred<void>(),
    release = deferred<void>();
  fixture.setReply(async (operation) => {
    if (operation === 'navigate') {
      entered.resolve();
      await release.promise;
    }
    return { ...fixture.state };
  });
  const original = new AbortController();
  try {
    await fixture.transport.ready;
    await fixture.transport.request({ action: 'launch' }, fixture.owner.signal);
    const request = fixture.transport.request(
      { action: 'navigate', url: 'https://owned.test/start', waitUntil: 'domcontentloaded' },
      original.signal,
    );
    void request.catch(() => {});
    await entered.promise;
    await expect(
      fixture.transport.request({ action: 'title' }, fixture.owner.signal),
    ).rejects.toMatchObject({ message: 'browser_native_busy', dispatched: false });
    original.abort();
    await expect(request).rejects.toMatchObject({
      message: 'browser_native_connection_failed',
      dispatched: true,
    });
    release.resolve();
    expect(fixture.requests.filter((row) => row.op === 'navigate')).toHaveLength(1);
  } finally {
    original.abort();
    release.resolve();
    await fixture.cleanup();
  }
});

for (const scenario of [
  { name: 'direct unknown', direct: 'effect_unknown', priorEffect: false, unknown: true },
  { name: 'direct no dispatch', direct: 'not_dispatched', priorEffect: false, unknown: false },
  { name: 'prior WS effect', direct: 'not_dispatched', priorEffect: true, unknown: true },
] as const)
  test(`a known WS refusal cannot downgrade owned navigation with ${scenario.name}`, async () => {
    const fixture = await ownedDriverFixture(),
      entered = deferred<void>(),
      finish = deferred<void>();
    let socket: WebSocket | undefined;
    const methods: unknown[] = [];
    fixture.setReply(async (operation) => {
      if (operation !== 'navigate') return { ...fixture.state };
      entered.resolve();
      await finish.promise;
      return Response.json(
        {
          ok: false,
          error:
            scenario.direct === 'effect_unknown'
              ? 'browser_page_navigation_outcome_unknown'
              : 'browser_page_navigation_denied',
          failure: { kind: scenario.direct, op: 'navigate', leaseId: 'owned-lease' },
        },
        { status: 400 },
      );
    });
    fixture.setCdpReply((request) => {
      methods.push(request.method);
      if (request.method === 'Runtime.evaluate')
        return ok({ result: { type: 'boolean', value: true } });
      return Response.json(
        {
          ok: false,
          error: 'browser_page_method_denied',
          failure: {
            kind: 'not_dispatched',
            op: 'cdp',
            leaseId: 'owned-lease',
            method: request.method,
          },
        },
        { status: 400 },
      );
    });
    try {
      await fixture.transport.ready;
      await fixture.transport.request({ action: 'launch' }, fixture.owner.signal);
      socket = new WebSocket(innerOptions.at(-1)!.attachment!.cdpUrl);
      await new Promise<void>((resolve, reject) => {
        socket!.addEventListener('open', () => resolve(), { once: true });
        socket!.addEventListener('error', reject, { once: true });
      });
      let id = 0;
      const send = (method: string, params: Record<string, unknown> = {}) => {
        const requestId = ++id;
        return new Promise<Record<string, unknown>>((resolve) => {
          const receive = (event: MessageEvent) => {
            const value = JSON.parse(String(event.data));
            if (value.id !== requestId) return;
            socket!.removeEventListener('message', receive);
            resolve(value);
          };
          socket!.addEventListener('message', receive);
          socket!.send(JSON.stringify({ id: requestId, method, params }));
        });
      };
      const original = fixture.transport.request(
        {
          action: 'navigate',
          url: 'https://owned.test/start',
          waitUntil: 'domcontentloaded',
        },
        fixture.owner.signal,
      );
      void original.catch(() => {});
      await entered.promise;
      if (scenario.priorEffect)
        expect(await send('Runtime.evaluate', { expression: 'fixtureEffect()' })).toHaveProperty(
          'result',
        );
      expect(await send('WebMCP.enable')).toMatchObject({
        error: { message: 'browser_page_method_denied' },
      });
      finish.resolve();
      await expect(original).rejects.toMatchObject({
        message: 'browser_page_method_denied',
        dispatched: scenario.unknown,
      });
      expect(fixture.requests.filter((request) => request.op === 'navigate')).toHaveLength(1);
      expect(methods).toEqual(
        scenario.priorEffect ? ['Runtime.evaluate', 'WebMCP.enable'] : ['WebMCP.enable'],
      );
    } finally {
      finish.resolve();
      socket?.close();
      await fixture.cleanup();
    }
  });

test('unknown owned navigation arguments refuse before any Main or daemon dispatch', async () => {
  const fixture = await ownedDriverFixture();
  try {
    await fixture.transport.ready;
    await fixture.transport.request({ action: 'launch' }, fixture.owner.signal);
    const commands: Record<string, string | boolean>[] = [
      { action: 'navigate', url: 'https://owned.test/', waitUntil: 'load' },
      {
        action: 'navigate',
        url: 'https://owned.test/',
        waitUntil: 'domcontentloaded',
        extra: true,
      },
      { action: 'title', extra: true },
    ];
    for (const command of commands)
      await expect(fixture.transport.request(command, fixture.owner.signal)).rejects.toMatchObject({
        dispatched: false,
      });
    expect(
      fixture.requests.filter((row) => ['pageState', 'navigate'].includes(String(row.op))),
    ).toEqual([]);
  } finally {
    await fixture.cleanup();
  }
});

test('close aborts its owned HTTP before draining and a late response cannot restore success', async () => {
  const fixture = await ownedDriverFixture();
  const entered = deferred<void>(),
    release = deferred<void>();
  fixture.setReply(async (operation) => {
    if (operation === 'navigate') {
      entered.resolve();
      await release.promise;
    }
    return { ...fixture.state };
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await fixture.transport.ready;
    await fixture.transport.request({ action: 'launch' }, fixture.owner.signal);
    const request = fixture.transport.request(
      { action: 'navigate', url: 'https://owned.test/start', waitUntil: 'domcontentloaded' },
      fixture.owner.signal,
    );
    void request.catch(() => {});
    await entered.promise;
    const closing = fixture.transport.close();
    await expect(request).rejects.toMatchObject({
      message: 'browser_native_connection_failed',
      dispatched: true,
    });
    expect(
      await Promise.race([
        closing,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error('owned HTTP was not drained')), 1000);
        }),
      ]),
    ).toEqual({ confirmed: true });
    release.resolve();
    await expect(request).rejects.toMatchObject({ dispatched: true });
    expect(fixture.requests.filter((row) => row.op === 'navigate')).toHaveLength(1);
  } finally {
    clearTimeout(timer);
    release.resolve();
    await fixture.cleanup();
  }
});

test('the real Main HTTP host and Service driver retain one original page through owned navigation', async () => {
  const scope = { storeId: 'owned-store', sessionId: 'owned-session' };
  const host = new NativeBrowserPageHost();
  const pages = new Map([
    ['original', { url: 'about:blank', title: 'Original' }],
    ['same-url-other-page', { url: 'https://owned.test/result', title: 'Other result' }],
  ]);
  const dispatched: string[] = [];
  const add = (id: string) =>
    host.add({
      id,
      scope,
      alive: () => true,
      attach() {},
      detach: () => true,
      async navigate(url, signal, beforeDispatch) {
        signal?.throwIfAborted();
        beforeDispatch();
        dispatched.push(id);
        pages.get(id)!.url = url;
        pages.get(id)!.title = 'Actual original result';
        host.navigate(id);
        const state = host.state(id)!;
        return {
          navigation: state.navigation,
          current: () =>
            host.state(id)?.navigation === state.navigation && host.state(id)?.phase === 'agent',
        };
      },
      async send() {
        throw Error('owned_navigation_must_not_use_the_daemon_cdp_lane');
      },
      typingCursor: async () => null,
      onEvent: () => () => {},
      decorate() {},
      changed() {},
      capture: async () => ({}),
      captureMeta: () => null,
    });
  const removeOriginal = add('original'),
    removeOther = add('same-url-other-page');
  host.configureGrantContext({
    selectedScope: () => ({ ...scope, generation: 1, viewSelection: 1 }),
    create() {
      throw Error('must-not-create-or-replace');
    },
    describe: (id) => pages.get(id),
    close() {},
  });
  host.arm('original', scope);
  const channel = await listenBrowserPageHost(host),
    owner = new AbortController();
  const transport = createDesktopBrowserTransport(
    { executable: '/fixture/not-spawned', browserPath: '/fixture/not-spawned' },
    channel.startup,
    { sessionId: scope.sessionId, executionId: 'owned-job', signal: owner.signal },
    { browserId: 'owned-browser', storeId: async () => scope.storeId },
  );
  innerRequest = async (command) => {
    if (['navigate', 'url', 'title'].includes(command.action))
      throw Error('must-not-use-daemon-helper');
    return { success: true, data: {} };
  };
  try {
    await transport.ready;
    await transport.request({ action: 'launch' }, owner.signal);
    const identity = transport.sharedPageIdentity!();
    if (!identity) throw Error('fixture_original_identity_required');
    expect(await transport.request({ action: 'url' }, owner.signal)).toEqual({
      success: true,
      data: { url: 'about:blank', title: 'Original' },
    });
    expect(
      await transport.request(
        { action: 'navigate', url: 'https://owned.test/result', waitUntil: 'domcontentloaded' },
        owner.signal,
      ),
    ).toEqual({
      success: true,
      data: { url: 'https://owned.test/result', title: 'Actual original result' },
    });
    expect(dispatched).toEqual(['original']);
    expect(transport.sharedPageIdentity!()).toEqual(identity);
    expect(pages.get('same-url-other-page')).toEqual({
      url: 'https://owned.test/result',
      title: 'Other result',
    });
    expect(await transport.close()).toEqual({ confirmed: true });
    await transport.dispose();
    expect(transport.releasedSharedPage!()).toEqual({
      url: 'https://owned.test/result',
      title: 'Actual original result',
      identity,
    });
    expect(host.state('original')?.phase).toBe('human');
    expect(pages.has('original')).toBe(true);
  } finally {
    innerRequest = undefined;
    owner.abort();
    await transport.close();
    removeOriginal();
    removeOther();
    await channel.close();
  }
});
