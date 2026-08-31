import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebGatewayObserverClient, WebObserverStreamEvent } from '@kite-ai/kite-app-contract';
import { WEB_DIRECTORY_REQUEST_SCHEMA_ } from '@kite-ai/kite-app-contract';
import {
  createWebGatewayCarrier,
  createWebGatewayControlLink,
  KITE_WEB_CONTROL_AUTHORIZATION_SCHEME,
  KITE_WEB_DIRECTORY_PATH,
  KITE_WEB_DISCONNECT_PATH,
  KITE_WEB_NATIVE_MINT_PATH,
  KITE_WEB_TABS_PATH,
  type WebGatewayCarrier,
  type WebGatewayCarrierOptions,
} from '../../../src/web-gateway';
import type { WebObserverCore } from '../../../src/web-observer';

const carriers: WebGatewayCarrier[] = [];

afterEach(async () => {
  while (carriers.length > 0) await carriers.pop()?.close();
});

function observer(binding: {
  readonly tabHandle: string;
  readonly connectionGeneration: number;
}): WebObserverCore {
  const client: WebGatewayObserverClient & {
    readonly events: (subscriptionId: string) => AsyncIterable<WebObserverStreamEvent>;
    readonly subscriptionEvents: (subscriptionId: string) => AsyncIterable<WebObserverStreamEvent>;
  } = {
    bootstrap: async () => ({
      schema: 'kite.app.web.bootstrap-response.v1',
      gatewayInstanceId: 'gateway-1',
      contractRevision: 'contract-1',
    }),
    createTab: async () => ({
      schema: 'kite.app.web.tab-create-response.v1',
      tabHandle: binding.tabHandle,
      connectionGeneration: binding.connectionGeneration,
    }),
    listDirectory: async () => ({
      schema: 'kite.app.web.directory-response.v1',
      workspaces: [],
    }),
    loadHistory: async (request) => ({
      schema: 'kite.app.web.history-response.v1',
      sessionId: request.sessionId,
      messages: [],
      hasMore: false,
      observedLastSequence: 0,
    }),
    subscribe: async () => ({
      schema: 'kite.app.web.subscribe-response.v1',
      subscriptionId: 'subscription-1',
      sessionId: 'session-1',
      liveSequence: null,
    }),
    unsubscribe: async (request) => ({
      schema: 'kite.app.web.unsubscribe-response.v1',
      subscriptionId: request.subscriptionId,
      unsubscribed: true,
    }),
    disconnect: async () => ({
      schema: 'kite.app.web.disconnect-response.v1',
      disconnected: true,
    }),
    events: () => ({
      async *[Symbol.asyncIterator]() {
        // No live data is needed for the HTTP auth/route assertions.
      },
    }),
    subscriptionEvents: () => ({
      async *[Symbol.asyncIterator]() {
        // No live data is needed for the HTTP auth/route assertions.
      },
    }),
  };
  return client;
}

function headers(origin: string, cookie?: string, tab?: string): HeadersInit {
  return {
    origin,
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    ...(cookie === undefined ? {} : { cookie }),
    ...(tab === undefined ? {} : { 'x-kite-web-tab': tab }),
  };
}

function jsonHeaders(origin: string, cookie?: string, tab?: string): HeadersInit {
  return {
    ...headers(origin, cookie, tab),
    'content-type': 'application/json',
  };
}

async function start(
  overrides: Partial<
    Pick<WebGatewayCarrierOptions, 'createObserver' | 'limits' | 'nativeControl' | 'onDiagnostic'>
  > = {},
): Promise<WebGatewayCarrier> {
  let randomCounter = 0;
  const carrier = createWebGatewayCarrier({
    staticAssetRoot: '/private/explicit-web-root',
    createObserver: overrides.createObserver ?? observer,
    instanceId: 'gateway-instance-1',
    nativeControl: overrides.nativeControl,
    readAsset: async () => new Response('<!doctype html><title>Kite</title>'),
    randomBytes: (size) => {
      const bytes = new Uint8Array(size);
      for (let index = 0; index < size; index += 1)
        bytes[index] = (randomCounter + index + 1) & 255;
      randomCounter += 1;
      return bytes;
    },
    limits: overrides.limits,
    onDiagnostic: overrides.onDiagnostic,
  });
  carriers.push(carrier);
  return carrier;
}

async function createTab(
  carrier: WebGatewayCarrier,
  session: { readonly origin: string },
): Promise<{ readonly tabHandle: string; readonly connectionGeneration: number }> {
  const response = await fetch(`${carrier.origin}${KITE_WEB_TABS_PATH}`, {
    method: 'POST',
    headers: jsonHeaders(session.origin),
    body: JSON.stringify({ schema: 'kite.app.web.tab-create-request.v1' }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    readonly tabHandle: string;
    readonly connectionGeneration: number;
  };
}

async function openSocket(carrier: WebGatewayCarrier): Promise<WebSocket> {
  return new Promise<WebSocket>((resolvePromise, reject) => {
    const socket = new WebSocket(`${carrier.origin.replace('http:', 'ws:')}/_kite/web/client`, {
      headers: {
        Origin: carrier.origin,
        'Sec-Fetch-Mode': 'websocket',
        'Sec-Fetch-Site': 'same-origin',
      },
    } as unknown as string[]);
    const timer = setTimeout(() => reject(new Error('Web Gateway socket open timed out')), 1_000);
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timer);
        resolvePromise(socket);
      },
      { once: true },
    );
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timer);
        reject(new Error('Web Gateway socket failed to open'));
      },
      { once: true },
    );
  });
}

async function nextSocketMessage(socket: WebSocket): Promise<unknown> {
  return new Promise<unknown>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('Web Gateway message timed out')), 1_000);
    socket.addEventListener(
      'message',
      (event) => {
        clearTimeout(timer);
        resolvePromise(JSON.parse(String(event.data)) as unknown);
      },
      { once: true },
    );
  });
}

async function socketClosed(socket: WebSocket): Promise<CloseEvent> {
  return new Promise<CloseEvent>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('Web Gateway close timed out')), 1_000);
    socket.addEventListener(
      'close',
      (event) => {
        clearTimeout(timer);
        resolvePromise(event);
      },
      { once: true },
    );
  });
}

async function bootstrap(carrier: WebGatewayCarrier): Promise<{ readonly origin: string }> {
  const response = await fetch(`${carrier.origin}/_kite/web/bootstrap`, {
    method: 'POST',
    headers: jsonHeaders(carrier.origin),
    body: JSON.stringify({ schema: 'kite.app.web.bootstrap-request.v1' }),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('set-cookie')).toBeNull();
  return { origin: carrier.origin };
}

describe('Web Gateway loopback carrier', () => {
  test('keeps native mint/stop on a distinct closed credential namespace', async () => {
    let stopRequested = 0;
    const credential = 'c'.repeat(43);
    const carrier = await start({
      nativeControl: {
        credential,
        buildId: 'gateway-build-1',
        requestStop: () => {
          stopRequested += 1;
        },
      },
    });
    const control = createWebGatewayControlLink({
      origin: carrier.origin,
      credential,
      expectedInstanceId: 'gateway-instance-1',
      expectedBuildId: 'gateway-build-1',
    });
    const first = await control.mintLaunchUrl();
    const second = await control.mintLaunchUrl();
    expect(first).toBe(carrier.origin);
    expect(second).toBe(first);

    const confusedNative = await fetch(`${carrier.origin}${KITE_WEB_NATIVE_MINT_PATH}`, {
      method: 'POST',
      headers: {
        authorization: `${KITE_WEB_CONTROL_AUTHORIZATION_SCHEME} ${credential}`,
        'content-type': 'application/json',
        cookie: 'kite_web_fake=value',
        origin: carrier.origin,
        'sec-fetch-site': 'same-origin',
      },
      body: '{}',
    });
    expect(confusedNative.status).toBe(403);

    await expect(
      createWebGatewayControlLink({
        origin: carrier.origin,
        credential: 'd'.repeat(43),
        expectedInstanceId: 'gateway-instance-1',
        expectedBuildId: 'gateway-build-1',
      }).mintLaunchUrl(),
    ).rejects.toThrow('unavailable');

    await control.stop();
    expect(stopRequested).toBe(0);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 40));
    expect(stopRequested).toBe(1);
  });

  test('bootstraps without credentials and requires an exact tab route', async () => {
    const carrier = await start();
    const session = await bootstrap(carrier);

    const tab = await createTab(carrier, session);
    expect(tab.tabHandle).toMatch(/^[A-Za-z0-9_-]{32}$/u);

    const directory = await fetch(`${carrier.origin}${KITE_WEB_DIRECTORY_PATH}`, {
      method: 'POST',
      headers: jsonHeaders(session.origin, undefined, tab.tabHandle),
      body: JSON.stringify({ schema: WEB_DIRECTORY_REQUEST_SCHEMA_ }),
    });
    expect(directory.status).toBe(200);
    expect(await directory.text()).not.toContain('/private/explicit-web-root');
  });

  test('isolates multiple tab observer lifecycles without browser credentials', async () => {
    const disconnected: string[] = [];
    const carrier = await start({
      createObserver: (binding) => {
        const core = observer(binding);
        return {
          ...core,
          disconnect: async (request) => {
            disconnected.push(binding.tabHandle);
            return core.disconnect(request);
          },
        };
      },
    });
    const session = await bootstrap(carrier);
    const first = await createTab(carrier, session);
    const second = await createTab(carrier, session);
    expect(first.tabHandle).not.toBe(second.tabHandle);
    expect(second.connectionGeneration).toBeGreaterThan(first.connectionGeneration);

    const disconnect = await fetch(`${carrier.origin}${KITE_WEB_DISCONNECT_PATH}`, {
      method: 'POST',
      headers: jsonHeaders(carrier.origin, undefined, first.tabHandle),
      body: JSON.stringify({ schema: 'kite.app.web.disconnect-request.v1' }),
    });
    expect(disconnect.status).toBe(200);

    const secondDirectory = await fetch(`${carrier.origin}${KITE_WEB_DIRECTORY_PATH}`, {
      method: 'POST',
      headers: jsonHeaders(carrier.origin, undefined, second.tabHandle),
      body: JSON.stringify({ schema: WEB_DIRECTORY_REQUEST_SCHEMA_ }),
    });
    expect(secondDirectory.status).toBe(200);
    expect(disconnected).toContain(first.tabHandle);
    expect(disconnected).not.toContain(second.tabHandle);
  });

  test('requires exact WebSocket initialization before the bounded deadline', async () => {
    const carrier = await start({ limits: { initializeDeadlineMs: 40 } });
    const session = await bootstrap(carrier);
    const tab = await createTab(carrier, session);

    const initializedSocket = await openSocket(carrier);
    const initializedMessage = nextSocketMessage(initializedSocket);
    initializedSocket.send(JSON.stringify({ type: 'initialize', tabHandle: tab.tabHandle }));
    await expect(initializedMessage).resolves.toEqual({
      schema: 'kite.app.web.ws-initialized.v1',
      type: 'initialized',
      connectionGeneration: tab.connectionGeneration,
    });
    initializedSocket.close(1000, 'done');

    const uninitializedSocket = await openSocket(carrier);
    const close = await socketClosed(uninitializedSocket);
    expect(close.code).toBe(1008);
    expect(close.reason).toBe('initialize_timeout');
  });

  test('closes binary and malformed WebSocket frames without exposing request content', async () => {
    const carrier = await start();
    const session = await bootstrap(carrier);
    await createTab(carrier, session);

    const binarySocket = await openSocket(carrier);
    const binaryClosed = socketClosed(binarySocket);
    binarySocket.send(new Uint8Array([1, 2, 3]));
    await expect(binaryClosed).resolves.toMatchObject({ code: 1009, reason: 'message_too_big' });

    const malformedSocket = await openSocket(carrier);
    const malformedClosed = socketClosed(malformedSocket);
    malformedSocket.send('{"type":');
    await expect(malformedClosed).resolves.toMatchObject({ code: 1008, reason: 'invalid_request' });

    const oversizedCarrier = await start({ limits: { maxWsMessageBytes: 16 } });
    const oversizedSession = await bootstrap(oversizedCarrier);
    await createTab(oversizedCarrier, oversizedSession);
    const oversizedSocket = await openSocket(oversizedCarrier);
    const oversizedClosed = socketClosed(oversizedSocket);
    oversizedSocket.send('x'.repeat(17));
    const oversizedClose = await oversizedClosed;
    expect([1006, 1009]).toContain(oversizedClose.code);
    expect(oversizedClose.reason).not.toContain('xxxxxxxx');
  });

  test('makes overflow resync terminal visible and ignores later events from that generation', async () => {
    const carrier = await start({
      limits: {
        maxQueuedMessages: 2,
        maxQueuedBytes: 150_000,
        maxBufferedAmount: 1,
        drainDeadlineMs: 200,
      },
      onDiagnostic: () => {
        throw new Error('diagnostic sink failure must be contained');
      },
      createObserver: (binding) => {
        const core = observer(binding);
        return {
          ...core,
          events: () => ({
            async *[Symbol.asyncIterator]() {
              for (let sequence = 1; sequence <= 100; sequence += 1) {
                yield {
                  schema: 'kite.app.web.live-event.v1',
                  type: 'message',
                  sessionId: 'session-1',
                  sequence,
                  message: {
                    messageId: 'assistant-1',
                    sequence,
                    role: 'assistant',
                    blocks: [{ kind: 'text', text: `${sequence}:${'x'.repeat(60_000)}` }],
                  },
                } satisfies WebObserverStreamEvent;
              }
            },
          }),
        };
      },
    });
    const session = await bootstrap(carrier);
    const tab = await createTab(carrier, session);
    const socket = await openSocket(carrier);
    const initialized = nextSocketMessage(socket);
    socket.send(JSON.stringify({ type: 'initialize', tabHandle: tab.tabHandle }));
    await initialized;

    const received: unknown[] = [];
    socket.addEventListener('message', (event) => {
      received.push(JSON.parse(String(event.data)) as unknown);
    });
    const closed = socketClosed(socket);
    socket.send(
      JSON.stringify({
        schema: 'kite.app.web.subscribe-request.v1',
        sessionId: 'session-1',
        afterSequence: 0,
      }),
    );
    const closeEvent = await closed;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    const terminalIndex = received.findIndex(
      (value) =>
        typeof value === 'object' &&
        value !== null &&
        'type' in value &&
        value.type === 'resync_required',
    );
    expect(closeEvent).toMatchObject({ code: 1013, reason: 'stream_overflow' });
    expect(terminalIndex).toBeGreaterThanOrEqual(0);
    expect(received.slice(terminalIndex + 1)).toEqual([]);
  });

  test('drains an in-flight bootstrap without publishing browser credentials', async () => {
    let releaseBootstrap!: () => void;
    let markEntered!: () => void;
    const entered = new Promise<void>((resolvePromise) => {
      markEntered = resolvePromise;
    });
    const blocked = new Promise<void>((resolvePromise) => {
      releaseBootstrap = resolvePromise;
    });
    const carrier = await start({
      createObserver: (binding) => {
        const core = observer(binding);
        return binding.tabHandle === 'bootstrap'
          ? {
              ...core,
              bootstrap: async (request) => {
                markEntered();
                await blocked;
                return core.bootstrap(request);
              },
            }
          : core;
      },
    });
    const request = fetch(`${carrier.origin}/_kite/web/bootstrap`, {
      method: 'POST',
      headers: jsonHeaders(carrier.origin),
      body: JSON.stringify({ schema: 'kite.app.web.bootstrap-request.v1' }),
    });
    await entered;
    const closing = carrier.close();
    releaseBootstrap();
    const response = await request;
    expect([502, 503]).toContain(response.status);
    expect(response.headers.get('set-cookie')).toBeNull();
    await closing;
    try {
      const late = await fetch(`${carrier.origin}/_kite/web/bootstrap`, {
        method: 'POST',
        headers: jsonHeaders(carrier.origin),
        body: JSON.stringify({ schema: 'kite.app.web.bootstrap-request.v1' }),
      });
      expect([502, 503]).toContain(late.status);
      expect(late.headers.get('set-cookie')).toBeNull();
      await late.text();
    } catch {
      // A listener already removed from the loopback port is the same
      // fail-closed outcome; no browser authority was created.
    }
  });

  test('bounds close when an Observer HTTP operation never settles', async () => {
    let markEntered!: () => void;
    let releaseBootstrap!: () => void;
    const entered = new Promise<void>((resolvePromise) => {
      markEntered = resolvePromise;
    });
    const blocked = new Promise<void>((resolvePromise) => {
      releaseBootstrap = resolvePromise;
    });
    const diagnostics: string[] = [];
    const carrier = await start({
      limits: { drainDeadlineMs: 10 },
      onDiagnostic: (code) => diagnostics.push(code),
      createObserver: (binding) => {
        const core = observer(binding);
        return binding.tabHandle === 'bootstrap'
          ? {
              ...core,
              bootstrap: async () => {
                markEntered();
                await blocked;
                return core.bootstrap({ schema: 'kite.app.web.bootstrap-request.v1' });
              },
            }
          : core;
      },
    });
    const request = fetch(`${carrier.origin}/_kite/web/bootstrap`, {
      method: 'POST',
      headers: jsonHeaders(carrier.origin),
      body: JSON.stringify({ schema: 'kite.app.web.bootstrap-request.v1' }),
    }).catch(() => undefined);
    await entered;
    await carrier.close();
    expect(diagnostics).toContain('drain_timeout');
    releaseBootstrap();
    await request;
  });

  test('rejects wrong Origin, Authorization, OPTIONS and mutation/unknown routes', async () => {
    const carrier = await start();
    const wrongOrigin = await fetch(`${carrier.origin}/_kite/web/bootstrap`, {
      method: 'POST',
      headers: {
        ...jsonHeaders(carrier.origin),
        origin: 'http://127.0.0.1:1',
      },
      body: JSON.stringify({ schema: 'kite.app.web.bootstrap-request.v1' }),
    });
    expect(wrongOrigin.status).toBe(403);

    const authorization = await fetch(`${carrier.origin}/_kite/web/bootstrap`, {
      method: 'POST',
      headers: {
        ...jsonHeaders(carrier.origin),
        authorization: 'Bearer worker-secret',
      },
      body: JSON.stringify({ schema: 'kite.app.web.bootstrap-request.v1' }),
    });
    expect(authorization.status).toBe(403);

    const options = await fetch(`${carrier.origin}/_kite/web/directory`, {
      method: 'OPTIONS',
      headers: headers(carrier.origin),
    });
    expect(options.status).toBe(405);

    const mutation = await fetch(`${carrier.origin}/_kite/web/prompt`, {
      method: 'POST',
      headers: jsonHeaders(carrier.origin),
      body: JSON.stringify({ prompt: 'must not cross' }),
    });
    expect(mutation.status).toBe(404);
    expect(await mutation.text()).not.toContain('must not cross');
  });

  test('hardened static response carries browser security headers and rejects traversal', async () => {
    const carrier = await start();
    const response = await fetch(`${carrier.origin}/`, {
      headers: { host: new URL(carrier.origin).host },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");

    const traversal = await fetch(`${carrier.origin}/bundle.js.map`, {
      headers: { host: new URL(carrier.origin).host },
    });
    expect(traversal.status).toBe(404);
  });

  test('serves only fixed bundle assets and refuses a symlinked allowlisted file', async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), 'kite-web-gateway-')));
    const root = join(temporary, 'dist');
    const outside = join(temporary, 'outside.js');
    await mkdir(join(root, 'assets'), { recursive: true });
    await mkdir(join(root, 'api-docs'), { recursive: true });
    await writeFile(join(root, 'index.html'), '<!doctype html><title>Kite</title>');
    await writeFile(join(root, 'assets', 'app.js'), 'globalThis.kite = true;');
    await writeFile(join(root, 'api-docs', 'openapi.json'), '{"openapi":"3.1.0"}\n');
    await writeFile(outside, 'globalThis.secret = true;');
    await symlink(outside, join(root, 'assets', 'escape.js'));
    const carrier = createWebGatewayCarrier({
      staticAssetRoot: root,
      createObserver: observer,
      instanceId: 'static-gateway-instance',
    });
    try {
      const index = await fetch(`${carrier.origin}/`, {
        headers: { host: new URL(carrier.origin).host },
      });
      expect(index.status).toBe(200);
      const docs = await fetch(`${carrier.origin}/api-docs`, {
        headers: { host: new URL(carrier.origin).host },
      });
      expect(docs.status).toBe(200);
      expect(await docs.text()).toBe('<!doctype html><title>Kite</title>');
      expect(docs.headers.get('content-security-policy')).toContain("default-src 'self'");
      expect(docs.headers.get('cache-control')).toBe('no-store');
      const docsWithSlash = await fetch(`${carrier.origin}/api-docs/`, {
        headers: { host: new URL(carrier.origin).host },
      });
      expect(docsWithSlash.status).toBe(200);
      const openApi = await fetch(`${carrier.origin}/api-docs/openapi.json`, {
        headers: { host: new URL(carrier.origin).host },
      });
      expect(openApi.status).toBe(200);
      expect(openApi.headers.get('content-type')).toBe('application/json; charset=utf-8');
      expect(openApi.headers.get('cache-control')).toBe('no-store');
      expect(await openApi.text()).toBe('{"openapi":"3.1.0"}\n');
      const docsDeepLink = await fetch(`${carrier.origin}/api-docs/anything`, {
        headers: { host: new URL(carrier.origin).host },
      });
      expect(docsDeepLink.status).toBe(404);
      const script = await fetch(`${carrier.origin}/assets/app.js`, {
        headers: { host: new URL(carrier.origin).host },
      });
      expect(script.status).toBe(200);
      const symlinked = await fetch(`${carrier.origin}/assets/escape.js`, {
        headers: { host: new URL(carrier.origin).host },
      });
      expect(symlinked.status).toBe(404);
      const sourceMap = await fetch(`${carrier.origin}/assets/app.js.map`, {
        headers: { host: new URL(carrier.origin).host },
      });
      expect(sourceMap.status).toBe(404);
    } finally {
      await carrier.close();
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
