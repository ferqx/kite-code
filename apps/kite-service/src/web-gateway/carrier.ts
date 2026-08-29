import { createHash, randomBytes as systemRandomBytes, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import {
  WEB_BOOTSTRAP_REQUEST_SCHEMA_,
  WEB_DISCONNECT_REQUEST_SCHEMA_,
  WEB_SUBSCRIBE_REQUEST_SCHEMA_,
  WEB_UNSUBSCRIBE_REQUEST_SCHEMA_,
  type WebBootstrapResponse,
  type WebDirectoryRequest,
  type WebDisconnectResponse,
  type WebObserverStreamEvent,
  type WebSubscribeRequest,
  type WebUnsubscribeRequest,
  webBootstrapResponseCodec,
  webDirectoryResponseCodec,
  webDisconnectRequestCodec,
  webDisconnectResponseCodec,
  webHistoryRequestCodec,
  webHistoryResponseCodec,
  webObserverStreamEventCodec,
  webSubscribeRequestCodec,
  webSubscribeResponseCodec,
  webTabCreateRequestCodec,
  webTabCreateResponseCodec,
  webUnsubscribeRequestCodec,
  webUnsubscribeResponseCodec,
} from '@kite-ai/kite-app-contract';
import type { WebObserverCore } from '../web-observer';
import { createWebGatewayAuth, type WebGatewaySessionRecord } from './auth';

export const KITE_WEB_LOOPBACK_HOST = '127.0.0.1' as const;
export const KITE_WEB_BOOTSTRAP_PATH = '/_kite/web/bootstrap' as const;
export const KITE_WEB_TABS_PATH = '/_kite/web/tabs' as const;
export const KITE_WEB_DIRECTORY_PATH = '/_kite/web/directory' as const;
export const KITE_WEB_HISTORY_PATH = '/_kite/web/history' as const;
export const KITE_WEB_DISCONNECT_PATH = '/_kite/web/disconnect' as const;
export const KITE_WEB_CLIENT_PATH = '/_kite/web/client' as const;
export const KITE_WEB_NATIVE_MINT_PATH = '/_kite/web/native/mint-launch' as const;
export const KITE_WEB_NATIVE_STOP_PATH = '/_kite/web/native/stop' as const;
export const KITE_WEB_CONTROL_AUTHORIZATION_SCHEME = 'Kite-Web-Control' as const;
export const KITE_WEB_CONTROL_RESPONSE_SCHEMA_ = 'kite.app.web.native-control.v1' as const;
export const KITE_WEB_TAB_HEADER = 'x-kite-web-tab' as const;
export const KITE_WEB_WS_INITIALIZE_SCHEMA_ = 'kite.app.web.ws-initialize.v1' as const;
export const KITE_WEB_WS_INITIALIZED_SCHEMA_ = 'kite.app.web.ws-initialized.v1' as const;

const DEFAULT_MAX_HTTP_BODY_BYTES = 1_048_576;
const DEFAULT_MAX_WS_MESSAGE_BYTES = 1_048_576;
const DEFAULT_MAX_QUEUED_MESSAGES = 256;
const DEFAULT_MAX_QUEUED_BYTES = 1_048_576;
const DEFAULT_MAX_TABS = 64;
const DEFAULT_DRAIN_DEADLINE_MS = 1_000;
const DEFAULT_INITIALIZE_DEADLINE_MS = 2_000;
const MAX_NATIVE_CONTROL_BODY_BYTES = 16;
const NATIVE_STOP_FLUSH_DELAY_MS = 25;
const CONTROL_CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

const SECURITY_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; form-action 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
});

type RequestIp = Readonly<{ address: string }> | null;
type SocketData = Readonly<{ connection: WebGatewaySocket }>;

export type WebGatewayDiagnosticCode =
  | 'request_rejected'
  | 'socket_open'
  | 'socket_closed'
  | 'stream_overflow'
  | 'drain_timeout';

export interface WebGatewayLimits {
  readonly maxHttpBodyBytes?: number;
  readonly maxWsMessageBytes?: number;
  readonly maxQueuedMessages?: number;
  readonly maxQueuedBytes?: number;
  readonly maxTabs?: number;
  readonly drainDeadlineMs?: number;
  readonly initializeDeadlineMs?: number;
  readonly maxBufferedAmount?: number;
}

export type WebGatewayAssetReader = (absolutePath: string) => Promise<Response | undefined>;

export interface WebGatewayNativeControlOptions {
  /** Restart-scoped native credential; it is hashed immediately and never returned by this carrier. */
  readonly credential: string;
  readonly buildId: string;
  /** Owner shutdown only. It must not cancel Worker, Turn, effect, or Controller state. */
  readonly requestStop: () => Promise<void> | void;
}

export interface WebGatewayCarrierOptions {
  /** Explicit bundle-owned static root. It is never returned to a browser. */
  readonly staticAssetRoot: string;
  /** A fresh closed Observer core is required for every browser tab. */
  readonly createObserver: (binding: {
    readonly tabHandle: string;
    readonly connectionGeneration: number;
  }) => WebObserverCore;
  readonly instanceId: string;
  readonly nativeControl?: WebGatewayNativeControlOptions;
  readonly limits?: WebGatewayLimits;
  readonly now?: () => number;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly maxSessions?: number;
  readonly maxLaunchTokens?: number;
  /** Test seam; production uses Bun.file under the explicit root. */
  readonly readAsset?: WebGatewayAssetReader;
  /** Test seam for loopback peer inspection. */
  readonly requestIp?: (request: Request, server: Bun.Server<SocketData>) => RequestIp;
  /** Test seam for deterministic/fault-injected Bun listeners. */
  readonly serve?: typeof Bun.serve;
  readonly onDiagnostic?: (code: WebGatewayDiagnosticCode) => void;
}

export interface WebGatewayCarrier extends AsyncDisposable {
  readonly origin: string;
  /** Launch URL whose fragment contains the one-shot token for body exchange. */
  readonly launchUrl: string;
  mintLaunchUrl(): string;
  close(): Promise<void>;
}

interface NormalizedLimits {
  readonly maxHttpBodyBytes: number;
  readonly maxWsMessageBytes: number;
  readonly maxQueuedMessages: number;
  readonly maxQueuedBytes: number;
  readonly maxTabs: number;
  readonly drainDeadlineMs: number;
  readonly initializeDeadlineMs: number;
  readonly maxBufferedAmount: number;
}

interface TabRecord {
  readonly tabHandle: string;
  readonly cookieHash: string;
  readonly connectionGeneration: number;
  readonly subscriptions: Set<string>;
  readonly observer: WebObserverCore;
  disconnectPromise?: Promise<WebDisconnectResponse>;
  socket?: WebGatewaySocket;
}

/**
 * Private loopback Web BFF. It serves static assets and a closed browser
 * Observer protocol; it never constructs or imports Runtime Host/Store/raw
 * Runtime events and has no mutation/controller route.
 */
export function createWebGatewayCarrier(options: WebGatewayCarrierOptions): WebGatewayCarrier {
  const limits = normalizeLimits(options.limits);
  const staticRoot = options.readAsset
    ? resolve(options.staticAssetRoot)
    : secureStaticAssetRoot(options.staticAssetRoot);
  const now = options.now ?? Date.now;
  const readAsset = options.readAsset ?? defaultAssetReader;
  const tabs = new Map<string, TabRecord>();
  const sockets = new Set<WebGatewaySocket>();
  let closed = false;
  let closing: Promise<void> | undefined;
  let bunServer!: Bun.Server<SocketData>;
  let auth!: ReturnType<typeof createWebGatewayAuth>;
  let nextConnectionGeneration = 0;
  let pendingTabCreates = 0;
  let nativeStopAccepted = false;
  let activeHttpRequests = 0;
  const httpDrainWaiters = new Set<() => void>();
  const bootstrapObserver = options.createObserver({
    tabHandle: 'bootstrap',
    connectionGeneration: 0,
  });

  bunServer = (options.serve ?? Bun.serve)<SocketData>({
    hostname: KITE_WEB_LOOPBACK_HOST,
    port: 0,
    development: false,
    async fetch(request, server) {
      activeHttpRequests += 1;
      try {
        const port = server.port;
        if (!port || closed) return secureResponse(503, 'unavailable');
        const binding = bindingFor(port);
        const requestIp = (options.requestIp ?? defaultRequestIp)(request, server);
        if (!isLoopbackRequest(requestIp) || request.headers.get('host') !== binding.host) {
          diagnose(options, 'request_rejected');
          return secureResponse(403, 'forbidden');
        }
        const url = new URL(request.url);
        if (url.search.length !== 0 || url.username || url.password) {
          diagnose(options, 'request_rejected');
          return secureResponse(403, 'forbidden');
        }
        if (
          url.pathname === KITE_WEB_NATIVE_MINT_PATH ||
          url.pathname === KITE_WEB_NATIVE_STOP_PATH
        ) {
          return handleNativeControl(request, binding, url.pathname);
        }
        if (url.pathname === KITE_WEB_CLIENT_PATH && isWebSocketUpgrade(request)) {
          return openWebSocket(request, server, binding, tabs, sockets);
        }
        if (request.method === 'OPTIONS') {
          diagnose(options, 'request_rejected');
          return secureResponse(405, 'method_not_allowed');
        }
        if (url.pathname === KITE_WEB_BOOTSTRAP_PATH) {
          return handleBootstrap(request, binding);
        }
        if (url.pathname === KITE_WEB_TABS_PATH) {
          return handleTabCreate(request, binding);
        }
        if (
          url.pathname === KITE_WEB_DIRECTORY_PATH ||
          url.pathname === KITE_WEB_HISTORY_PATH ||
          url.pathname === KITE_WEB_DISCONNECT_PATH
        ) {
          return handleObserverRoute(request, binding, url.pathname);
        }
        if (url.pathname.startsWith('/_kite/web/')) {
          diagnose(options, 'request_rejected');
          return secureResponse(404, 'not_found');
        }
        if (request.method === 'GET') return serveStatic(request, url.pathname);
        diagnose(options, 'request_rejected');
        return secureResponse(404, 'not_found');
      } finally {
        activeHttpRequests -= 1;
        if (activeHttpRequests === 0) {
          for (const resolvePromise of httpDrainWaiters) resolvePromise();
          httpDrainWaiters.clear();
        }
      }
    },
    websocket: {
      data: {} as SocketData,
      maxPayloadLength: limits.maxWsMessageBytes,
      // Bun's hard transport cap must leave room for the application's one
      // terminal signal beyond its soft buffered threshold.
      backpressureLimit: limits.maxBufferedAmount + limits.maxQueuedBytes,
      closeOnBackpressureLimit: false,
      sendPings: false,
      open(socket) {
        sockets.add(socket.data.connection);
        socket.data.connection.open(socket);
      },
      message(socket, message) {
        socket.data.connection.message(socket, message);
      },
      drain(socket) {
        socket.data.connection.drain();
      },
      close(socket) {
        sockets.delete(socket.data.connection);
        void socket.data.connection.closed();
      },
    },
  });

  const port = bunServer.port;
  if (!port) {
    throw new Error('Web Gateway did not obtain an ephemeral port.');
  }
  const binding = bindingFor(port);
  auth = createWebGatewayAuth({
    instanceId: options.instanceId,
    origin: binding.origin,
    now,
    randomBytes: options.randomBytes,
    maxSessions: options.maxSessions,
    maxLaunchTokens: options.maxLaunchTokens,
  });

  const nativeControlDigest = options.nativeControl
    ? controlCredentialDigest(options.nativeControl.credential)
    : undefined;

  return Object.freeze({
    origin: binding.origin,
    get launchUrl() {
      return auth.url;
    },
    mintLaunchUrl: () => auth.mintLaunchUrl(),
    close: () => {
      closing ??= closeGateway();
      return closing;
    },
    [Symbol.asyncDispose]() {
      return this.close();
    },
  });

  async function handleBootstrap(request: Request, requestBinding: Binding): Promise<Response> {
    if (!browserRequestAllowed(request, requestBinding, 'bootstrap') || request.method !== 'POST') {
      diagnose(options, 'request_rejected');
      return secureResponse(request.method === 'POST' ? 403 : 405, 'forbidden');
    }
    if (!isJsonRequest(request)) return secureResponse(415, 'unsupported_media_type');
    const body = await readJson(request, limits.maxHttpBodyBytes);
    if (!body.ok) return secureResponse(400, 'invalid_request');
    if (closed) return secureResponse(503, 'unavailable');
    const token = exactLaunchBody(body.value);
    if (token === undefined) return secureResponse(400, 'invalid_request');
    const inspectedCookie = auth.inspectCookie(request.headers.get('cookie'));
    if (inspectedCookie.status === 'invalid') return secureResponse(401, 'unauthorized');
    const replacedCookieHash =
      inspectedCookie.status === 'valid' ? inspectedCookie.record.cookieHash : undefined;
    const session = auth.consumeLaunch(token, replacedCookieHash);
    if (session === undefined) return secureResponse(401, 'unauthorized');
    if (replacedCookieHash !== undefined) await retireCookieTabs(replacedCookieHash);
    if (closed) {
      auth.revokeSession(session.cookieHash);
      return secureResponse(503, 'unavailable');
    }
    let response: WebBootstrapResponse;
    try {
      response = await bootstrapObserver.bootstrap({ schema: WEB_BOOTSTRAP_REQUEST_SCHEMA_ });
    } catch {
      auth.revokeSession(session.cookieHash);
      return secureResponse(503, 'unavailable');
    }
    if (closed) {
      auth.revokeSession(session.cookieHash);
      return secureResponse(503, 'unavailable');
    }
    return jsonResponse(webBootstrapResponseCodec.encode(response), {
      'set-cookie': session.setCookie,
    });
  }

  async function handleNativeControl(
    request: Request,
    requestBinding: Binding,
    pathname: string,
  ): Promise<Response> {
    const control = options.nativeControl;
    if (
      control === undefined ||
      nativeControlDigest === undefined ||
      request.method !== 'POST' ||
      request.headers.get('host') !== requestBinding.host ||
      request.headers.get('origin') !== null ||
      request.headers.get('cookie') !== null ||
      request.headers.get('sec-fetch-site') !== null ||
      request.headers.get('sec-fetch-mode') !== null ||
      !isJsonRequest(request) ||
      !controlAuthorizationMatches(request.headers.get('authorization'), nativeControlDigest)
    ) {
      diagnose(options, 'request_rejected');
      return secureResponse(request.method === 'POST' ? 403 : 405, 'forbidden');
    }
    const body = await readJson(request, MAX_NATIVE_CONTROL_BODY_BYTES);
    if (!body.ok || !isPlainObject(body.value) || !hasExactKeys(body.value, [])) {
      diagnose(options, 'request_rejected');
      return secureResponse(400, 'invalid_request');
    }
    if (closed) return secureResponse(503, 'unavailable');
    if (pathname === KITE_WEB_NATIVE_MINT_PATH) {
      let launchUrl: string;
      try {
        launchUrl = auth.mintLaunchUrl();
      } catch {
        return secureResponse(503, 'unavailable');
      }
      return jsonResponse({
        schema: KITE_WEB_CONTROL_RESPONSE_SCHEMA_,
        operation: 'mint_launch',
        gatewayInstanceId: options.instanceId,
        buildId: control.buildId,
        origin: requestBinding.origin,
        launchUrl,
      });
    }
    if (nativeStopAccepted) return secureResponse(503, 'unavailable');
    nativeStopAccepted = true;
    setTimeout(() => {
      void Promise.resolve()
        .then(() => control.requestStop())
        .catch(() => undefined);
    }, NATIVE_STOP_FLUSH_DELAY_MS);
    return jsonResponse({
      schema: KITE_WEB_CONTROL_RESPONSE_SCHEMA_,
      operation: 'stop',
      gatewayInstanceId: options.instanceId,
      buildId: control.buildId,
      origin: requestBinding.origin,
    });
  }

  async function handleObserverRoute(
    request: Request,
    requestBinding: Binding,
    pathname: string,
  ): Promise<Response> {
    if (!browserRequestAllowed(request, requestBinding, 'api') || request.method !== 'POST') {
      diagnose(options, 'request_rejected');
      return secureResponse(request.method === 'POST' ? 403 : 405, 'forbidden');
    }
    if (!isJsonRequest(request)) return secureResponse(415, 'unsupported_media_type');
    const session = auth.authorize(request.headers.get('cookie'));
    if (session === undefined) return secureResponse(401, 'unauthorized');
    const tab = tabForRequest(request, session, tabs);
    if (tab === undefined) return secureResponse(401, 'unauthorized');
    const body = await readJson(request, limits.maxHttpBodyBytes);
    if (!body.ok) return secureResponse(400, 'invalid_request');
    if (closed) return secureResponse(503, 'unavailable');
    try {
      if (pathname === KITE_WEB_DIRECTORY_PATH) {
        const value = exactSchemaBody(body.value, 'directory');
        if (value === undefined) return secureResponse(400, 'invalid_request');
        const response = await tab.observer.listDirectory(value as WebDirectoryRequest);
        return closed
          ? secureResponse(503, 'unavailable')
          : jsonResponse(webDirectoryResponseCodec.encode(response));
      }
      if (pathname === KITE_WEB_HISTORY_PATH) {
        const value = webHistoryRequestCodec.decode(body.value);
        const response = await tab.observer.loadHistory(value);
        return closed
          ? secureResponse(503, 'unavailable')
          : jsonResponse(webHistoryResponseCodec.encode(response));
      }
      const value = webDisconnectRequestCodec.decode(body.value);
      const response = await disconnectTabObserver(tab, value);
      await closeTabSockets(tab);
      tabs.delete(tab.tabHandle);
      if (closed) return secureResponse(503, 'unavailable');
      return jsonResponse(webDisconnectResponseCodec.encode(response));
    } catch (error) {
      return responseForObserverError(error);
    }
  }

  async function handleTabCreate(request: Request, requestBinding: Binding): Promise<Response> {
    if (!browserRequestAllowed(request, requestBinding, 'api') || request.method !== 'POST') {
      diagnose(options, 'request_rejected');
      return secureResponse(request.method === 'POST' ? 403 : 405, 'forbidden');
    }
    if (!isJsonRequest(request)) return secureResponse(415, 'unsupported_media_type');
    const session = auth.authorize(request.headers.get('cookie'));
    if (session === undefined) return secureResponse(401, 'unauthorized');
    if (tabs.size + pendingTabCreates >= limits.maxTabs) return secureResponse(429, 'unavailable');
    const body = await readJson(request, limits.maxHttpBodyBytes);
    if (!body.ok) return secureResponse(400, 'invalid_request');
    if (closed) return secureResponse(503, 'unavailable');
    let observer: WebObserverCore | undefined;
    pendingTabCreates += 1;
    try {
      const requestValue = webTabCreateRequestCodec.decode(body.value);
      const tabHandle = opaqueTabHandle(options.randomBytes ?? systemRandomBytes);
      const connectionGeneration = ++nextConnectionGeneration;
      observer = options.createObserver({ tabHandle, connectionGeneration });
      const response = await observer.createTab(requestValue);
      if (closed) {
        await observer
          .disconnect({ schema: WEB_DISCONNECT_REQUEST_SCHEMA_ })
          .catch(() => undefined);
        return secureResponse(503, 'unavailable');
      }
      if (
        response.tabHandle !== tabHandle ||
        response.connectionGeneration !== connectionGeneration ||
        tabs.has(tabHandle)
      ) {
        await observer
          .disconnect({ schema: WEB_DISCONNECT_REQUEST_SCHEMA_ })
          .catch(() => undefined);
        return secureResponse(503, 'unavailable');
      }
      const tab: TabRecord = {
        tabHandle: response.tabHandle,
        cookieHash: session.cookieHash,
        connectionGeneration: response.connectionGeneration,
        subscriptions: new Set(),
        observer,
      };
      tabs.set(response.tabHandle, tab);
      return jsonResponse(webTabCreateResponseCodec.encode(response));
    } catch (error) {
      await observer?.disconnect({ schema: WEB_DISCONNECT_REQUEST_SCHEMA_ }).catch(() => undefined);
      return responseForObserverError(error);
    } finally {
      pendingTabCreates -= 1;
    }
  }

  async function serveStatic(_request: Request, pathname: string): Promise<Response> {
    const path = safeAssetPath(staticRoot, pathname);
    if (path === undefined) return secureResponse(404, 'not_found');
    try {
      const asset = await readAsset(path);
      if (asset === undefined || asset.body === null) return secureResponse(404, 'not_found');
      return secureResponse(200, asset.body, {
        'content-type': contentTypeFor(path),
      });
    } catch {
      return secureResponse(404, 'not_found');
    }
  }

  async function openWebSocket(
    request: Request,
    server: Bun.Server<SocketData>,
    requestBinding: Binding,
    tabRegistry: Map<string, TabRecord>,
    socketRegistry: Set<WebGatewaySocket>,
  ): Promise<Response | undefined> {
    if (!browserRequestAllowed(request, requestBinding, 'websocket')) {
      diagnose(options, 'request_rejected');
      return secureResponse(403, 'forbidden');
    }
    const session = auth.authorize(request.headers.get('cookie'));
    if (session === undefined) return secureResponse(401, 'unauthorized');
    if (closed) return secureResponse(503, 'unavailable');
    const connection = new WebGatewaySocket({
      session,
      tabs: tabRegistry,
      limits,
      diagnose: (code) => diagnose(options, code),
    });
    if (!server.upgrade(request, { data: { connection } })) {
      await connection.abortBeforeOpen();
      return secureResponse(400, 'bad_request');
    }
    socketRegistry.add(connection);
    return undefined;
  }

  async function closeTabSockets(tab: TabRecord): Promise<void> {
    tab.socket?.closeAfterDrain(1000, 'disconnected');
    tab.socket = undefined;
  }

  async function retireCookieTabs(cookieHash: string): Promise<void> {
    const retirements: Promise<unknown>[] = [];
    for (const tab of tabs.values()) {
      if (tab.cookieHash !== cookieHash) continue;
      tabs.delete(tab.tabHandle);
      if (tab.socket !== undefined) {
        tab.socket.closeAfterDrain(1008, 'session_replaced');
        tab.socket = undefined;
      } else {
        retirements.push(disconnectTabObserver(tab).catch(() => undefined));
      }
    }
    await Promise.allSettled(retirements);
  }

  async function closeGateway(): Promise<void> {
    if (closed) return;
    closed = true;
    const failures: unknown[] = [];
    if (activeHttpRequests > 0) {
      let drained = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let waiter: (() => void) | undefined;
      await Promise.race([
        new Promise<void>((resolvePromise) => {
          waiter = () => {
            drained = true;
            resolvePromise();
          };
          httpDrainWaiters.add(waiter);
        }),
        new Promise<void>((resolvePromise) => {
          timer = setTimeout(resolvePromise, limits.drainDeadlineMs);
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
      if (waiter !== undefined) httpDrainWaiters.delete(waiter);
      if (!drained) diagnose(options, 'drain_timeout');
    }
    const socketResults = await Promise.allSettled(
      [...sockets].map((socket) => socket.shutdownForGateway()),
    );
    const observerResults = await Promise.allSettled([
      bootstrapObserver.disconnect({ schema: WEB_DISCONNECT_REQUEST_SCHEMA_ }),
      ...[...tabs.values()].map((tab) => disconnectTabObserver(tab)),
    ]);
    for (const result of [...socketResults, ...observerResults]) {
      if (result.status === 'rejected') failures.push(result.reason);
    }
    tabs.clear();
    auth.close();
    let listenerSettled = false;
    let listenerFailure: unknown;
    const listenerStop = Promise.resolve(bunServer.stop(true)).then(
      () => {
        listenerSettled = true;
      },
      (error: unknown) => {
        listenerSettled = true;
        listenerFailure = error;
      },
    );
    let listenerTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      listenerStop,
      new Promise<void>((resolvePromise) => {
        listenerTimer = setTimeout(resolvePromise, limits.drainDeadlineMs);
      }),
    ]);
    if (listenerTimer !== undefined) clearTimeout(listenerTimer);
    if (!listenerSettled) diagnose(options, 'drain_timeout');
    else if (listenerFailure !== undefined) failures.push(listenerFailure);
    sockets.clear();
    if (failures[0]) throw failures[0];
  }

  function responseForObserverError(error: unknown): Response {
    if (error && typeof error === 'object' && 'event' in error) {
      const event = (error as { readonly event?: WebObserverStreamEvent }).event;
      if (event?.type === 'resync_required') return secureResponse(409, 'resync_required');
      if (event?.type === 'unavailable') return secureResponse(503, 'unavailable');
    }
    return secureResponse(503, 'unavailable');
  }
}

class WebGatewaySocket {
  readonly #session: WebGatewaySessionRecord;
  readonly #tabs: Map<string, TabRecord>;
  readonly #limits: NormalizedLimits;
  readonly #diagnose: (code: WebGatewayDiagnosticCode) => void;
  readonly #pending: Array<{ readonly payload: string; readonly bytes: number }> = [];
  readonly #subscriptions = new Set<string>();
  readonly #drainWaiters = new Set<() => void>();
  #socket: Bun.ServerWebSocket<SocketData> | undefined;
  #tab: TabRecord | undefined;
  #activeSessionIdValue: string | undefined;
  #closed = false;
  #cleaned = false;
  #initialized = false;
  #initializeTimer: ReturnType<typeof setTimeout> | undefined;
  #pendingBytes = 0;
  #flushing = false;
  #terminalQueued = false;
  #closeAfterFlush: { readonly code: number; readonly reason: string } | undefined;
  #messageTail = Promise.resolve();
  #resolveClosed!: () => void;
  readonly #closedPromise = new Promise<void>((resolvePromise) => {
    this.#resolveClosed = resolvePromise;
  });

  constructor(input: {
    readonly session: WebGatewaySessionRecord;
    readonly tabs: Map<string, TabRecord>;
    readonly limits: NormalizedLimits;
    readonly diagnose: (code: WebGatewayDiagnosticCode) => void;
  }) {
    this.#session = input.session;
    this.#tabs = input.tabs;
    this.#limits = input.limits;
    this.#diagnose = input.diagnose;
  }

  open(socket: Bun.ServerWebSocket<SocketData>): void {
    if (this.#closed) {
      socket.close(1012, 'gateway_draining');
      return;
    }
    this.#socket = socket;
    this.#initializeTimer = setTimeout(
      () => this.protocolClose(1008, 'initialize_timeout'),
      this.#limits.initializeDeadlineMs,
    );
    this.#diagnose('socket_open');
  }

  message(socket: Bun.ServerWebSocket<SocketData>, message: string | Buffer): void {
    if (this.#closed || socket !== this.#socket) return;
    if (typeof message !== 'string' || byteLength(message) > this.#limits.maxWsMessageBytes) {
      this.protocolClose(1009, 'message_too_big');
      return;
    }
    this.#messageTail = this.#messageTail.then(
      () => this.handleMessage(message),
      () => this.handleMessage(message),
    );
  }

  drain(): void {
    for (const resolve of this.#drainWaiters) resolve();
    this.#drainWaiters.clear();
  }

  async closed(): Promise<void> {
    if (this.#cleaned) return;
    this.#cleaned = true;
    this.#closed = true;
    this.clearInitializeTimer();
    const observer = this.#tab?.observer;
    for (const subscriptionId of this.#subscriptions) {
      if (observer) {
        await observer
          .unsubscribe({
            schema: WEB_UNSUBSCRIBE_REQUEST_SCHEMA_,
            subscriptionId,
          })
          .catch(() => undefined);
      }
    }
    for (const subscriptionId of this.#subscriptions)
      this.#tab?.subscriptions.delete(subscriptionId);
    this.#subscriptions.clear();
    if (this.#tab?.socket === this) this.#tab.socket = undefined;
    if (this.#tab) {
      this.#tabs.delete(this.#tab.tabHandle);
      await disconnectTabObserver(this.#tab).catch(() => undefined);
    }
    this.#diagnose('socket_closed');
    this.#resolveClosed();
  }

  async shutdownForGateway(): Promise<void> {
    this.sendGatewayDraining();
    this.closeAfterDrain(1012, 'gateway_draining');
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.#closedPromise,
      new Promise<void>((resolvePromise) => {
        timer = setTimeout(resolvePromise, this.#limits.drainDeadlineMs);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (!this.#cleaned) {
      this.protocolClose(1012, 'gateway_draining');
      await this.#closedPromise;
    }
  }

  async abortBeforeOpen(): Promise<void> {
    this.#closed = true;
    this.clearInitializeTimer();
  }

  sendGatewayDraining(): void {
    if (!this.#initialized || this.#tab === undefined) return;
    const sessionId = this.activeSessionId();
    if (sessionId === undefined) return;
    this.enqueueTerminal({
      schema: 'kite.app.web.live-event.v1',
      type: 'unavailable',
      sessionId,
      reason: 'gateway_draining',
    });
  }

  closeAfterDrain(code: number, reason: string): void {
    if (this.#closed) return;
    this.#closeAfterFlush = { code, reason };
    void this.flush();
  }

  private async handleMessage(payload: string): Promise<void> {
    if (this.#closed) return;
    let value: unknown;
    try {
      value = JSON.parse(payload) as unknown;
    } catch {
      this.protocolClose(1008, 'invalid_request');
      return;
    }
    if (!this.#initialized) {
      await this.initialize(value);
      return;
    }
    if (!isPlainObject(value) || typeof value.schema !== 'string') {
      this.protocolClose(1008, 'invalid_request');
      return;
    }
    try {
      if (value.schema === WEB_SUBSCRIBE_REQUEST_SCHEMA_) {
        const request = webSubscribeRequestCodec.decode(value) as WebSubscribeRequest;
        if (this.#subscriptions.size > 0) {
          this.protocolClose(1008, 'subscription_unavailable');
          return;
        }
        const observer = this.#tab?.observer;
        if (!observer) {
          this.protocolClose(1008, 'unauthorized');
          return;
        }
        const response = await observer.subscribe(request);
        this.#subscriptions.add(response.subscriptionId);
        this.#activeSessionIdValue = request.sessionId;
        this.#tab?.subscriptions.add(response.subscriptionId);
        this.enqueueJson(webSubscribeResponseCodec.encode(response));
        void this.forwardSubscription(response.subscriptionId, request.sessionId);
        return;
      }
      if (value.schema === WEB_UNSUBSCRIBE_REQUEST_SCHEMA_) {
        const request = webUnsubscribeRequestCodec.decode(value) as WebUnsubscribeRequest;
        if (!this.#subscriptions.has(request.subscriptionId)) {
          this.protocolClose(1008, 'subscription_unavailable');
          return;
        }
        const response = await this.#tab!.observer.unsubscribe(request);
        this.#subscriptions.delete(request.subscriptionId);
        this.#tab?.subscriptions.delete(request.subscriptionId);
        if (this.#subscriptions.size === 0) this.#activeSessionIdValue = undefined;
        this.enqueueJson(webUnsubscribeResponseCodec.encode(response));
        return;
      }
      if (value.schema === 'kite.app.web.disconnect-request.v1') {
        const request = webDisconnectRequestCodec.decode(value);
        const response = await disconnectTabObserver(this.#tab!, request);
        this.enqueueJson(webDisconnectResponseCodec.encode(response));
        this.closeAfterDrain(1000, 'disconnected');
        return;
      }
      this.protocolClose(1008, 'invalid_request');
    } catch {
      this.protocolClose(1011, 'unavailable');
    }
  }

  private async initialize(value: unknown): Promise<void> {
    if (!isPlainObject(value) || !hasExactKeys(value, ['tabHandle', 'type'])) {
      this.protocolClose(1008, 'invalid_request');
      return;
    }
    if (value.type !== 'initialize' || typeof value.tabHandle !== 'string') {
      this.protocolClose(1008, 'invalid_request');
      return;
    }
    const tab = this.#tabs.get(value.tabHandle);
    if (tab === undefined || tab.cookieHash !== this.#session.cookieHash) {
      this.protocolClose(1008, 'unauthorized');
      return;
    }
    if (tab.socket !== undefined && tab.socket !== this)
      tab.socket.protocolClose(1012, 'connection_replaced');
    tab.socket = this;
    this.#tab = tab;
    this.#initialized = true;
    this.clearInitializeTimer();
    this.enqueueJson({
      schema: KITE_WEB_WS_INITIALIZED_SCHEMA_,
      type: 'initialized',
      connectionGeneration: tab.connectionGeneration,
    });
  }

  private async forwardSubscription(subscriptionId: string, sessionId: string): Promise<void> {
    try {
      const observer = this.#tab?.observer;
      if (!observer) return;
      for await (const event of observer.events(subscriptionId)) {
        if (this.#closed) return;
        if (event.sessionId !== sessionId) {
          this.protocolClose(1011, 'subscription_unavailable');
          return;
        }
        if (event.type === 'message') {
          this.enqueueEvent(event);
        } else {
          this.enqueueTerminal(event);
          this.closeAfterDrain(
            1012,
            event.type === 'resync_required' ? 'resync_required' : 'unavailable',
          );
          return;
        }
      }
    } catch {
      if (!this.#closed) this.protocolClose(1011, 'subscription_unavailable');
    }
  }

  private enqueueEvent(event: WebObserverStreamEvent): void {
    this.enqueueJson(webObserverStreamEventCodec.encode(event));
  }

  private enqueueJson(value: Record<string, unknown>): void {
    if (this.#closed || this.#terminalQueued) return;
    const payload = JSON.stringify(value);
    const bytes = byteLength(payload);
    if (
      bytes > this.#limits.maxQueuedBytes ||
      this.#pending.length >= this.#limits.maxQueuedMessages ||
      this.#pendingBytes + bytes > this.#limits.maxQueuedBytes
    ) {
      this.overflow();
      return;
    }
    this.#pending.push({ payload, bytes });
    this.#pendingBytes += bytes;
    void this.flush();
  }

  private overflow(): void {
    if (this.#closed || this.#terminalQueued) return;
    this.#diagnose('stream_overflow');
    const sessionId = this.activeSessionId();
    if (sessionId !== undefined) {
      this.enqueueTerminal({
        schema: 'kite.app.web.live-event.v1',
        type: 'resync_required',
        sessionId,
        reason: 'stream_overflow',
      });
    } else {
      this.#terminalQueued = true;
      this.#pending.length = 0;
      this.#pendingBytes = 0;
    }
    this.closeAfterDrain(1013, 'stream_overflow');
  }

  private enqueueTerminal(event: WebObserverStreamEvent): void {
    if (this.#closed || this.#terminalQueued) return;
    const payload = JSON.stringify(webObserverStreamEventCodec.encode(event));
    const bytes = byteLength(payload);
    this.#terminalQueued = true;
    this.#pending.length = 0;
    this.#pendingBytes = 0;
    this.#pending.push({ payload, bytes });
    this.#pendingBytes = bytes;
    void this.flush();
  }

  private async flush(): Promise<void> {
    if (this.#flushing || this.#closed) return;
    this.#flushing = true;
    try {
      for (;;) {
        const socket = this.#socket;
        const next = this.#pending[0];
        if (!socket || next === undefined) break;
        // A small terminal event gets one priority send attempt even when an
        // ordinary payload has filled the peer's buffer. This preserves the
        // resync/draining signal without allowing more ordinary backlog.
        if (!this.#terminalQueued && !(await this.waitForWritable(socket))) break;
        // A terminal replacement may have occurred while writable state was
        // awaited. Never send or shift the stale ordinary item in that case.
        if (this.#pending[0] !== next) continue;
        const result = socket.sendText(next.payload);
        // Bun returns -1 when the frame was accepted but backpressured, and
        // 0 only when the frame was dropped.
        if (result === 0) {
          if (this.#terminalQueued && (await this.waitForWritable(socket))) continue;
          this.protocolClose(1013, 'stream_overflow');
          break;
        }
        if (this.#pending[0] !== next) continue;
        this.#pending.shift();
        this.#pendingBytes -= next.bytes;
        await Promise.resolve();
      }
      if (this.#pending.length === 0 && this.#closeAfterFlush !== undefined) {
        const close = this.#closeAfterFlush;
        this.#closeAfterFlush = undefined;
        socketClose(this.#socket, close.code, close.reason);
      }
    } finally {
      this.#flushing = false;
    }
  }

  private async waitForWritable(socket: Bun.ServerWebSocket<SocketData>): Promise<boolean> {
    const deadline = Date.now() + this.#limits.drainDeadlineMs;
    while (!this.#closed && socket.getBufferedAmount() > this.#limits.maxBufferedAmount) {
      if (Date.now() >= deadline) {
        this.#diagnose('drain_timeout');
        this.protocolClose(1013, 'drain_timeout');
        return false;
      }
      await new Promise<void>((resolvePromise) => {
        const timer = setTimeout(
          () => {
            this.#drainWaiters.delete(wake);
            resolvePromise();
          },
          Math.min(10, Math.max(1, deadline - Date.now())),
        );
        const wake = () => {
          clearTimeout(timer);
          resolvePromise();
        };
        this.#drainWaiters.add(wake);
      });
    }
    return !this.#closed;
  }

  private protocolClose(code: number, reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.clearInitializeTimer();
    this.#pending.length = 0;
    this.#pendingBytes = 0;
    socketClose(this.#socket, code, reason);
    void this.closed();
  }

  private clearInitializeTimer(): void {
    if (this.#initializeTimer !== undefined) clearTimeout(this.#initializeTimer);
    this.#initializeTimer = undefined;
  }

  private activeSessionId(): string | undefined {
    return this.#activeSessionIdValue;
  }
}

function disconnectTabObserver(
  tab: TabRecord,
  request = { schema: WEB_DISCONNECT_REQUEST_SCHEMA_ } as const,
): Promise<WebDisconnectResponse> {
  tab.disconnectPromise ??= tab.observer.disconnect(request);
  return tab.disconnectPromise;
}

interface Binding {
  readonly host: string;
  readonly origin: string;
}

function normalizeLimits(input: WebGatewayLimits | undefined): NormalizedLimits {
  const limits: NormalizedLimits = {
    maxHttpBodyBytes: positive(
      input?.maxHttpBodyBytes,
      DEFAULT_MAX_HTTP_BODY_BYTES,
      'maxHttpBodyBytes',
    ),
    maxWsMessageBytes: positive(
      input?.maxWsMessageBytes,
      DEFAULT_MAX_WS_MESSAGE_BYTES,
      'maxWsMessageBytes',
    ),
    maxQueuedMessages: positive(
      input?.maxQueuedMessages,
      DEFAULT_MAX_QUEUED_MESSAGES,
      'maxQueuedMessages',
    ),
    maxQueuedBytes: positive(input?.maxQueuedBytes, DEFAULT_MAX_QUEUED_BYTES, 'maxQueuedBytes'),
    maxTabs: positive(input?.maxTabs, DEFAULT_MAX_TABS, 'maxTabs'),
    drainDeadlineMs: positive(input?.drainDeadlineMs, DEFAULT_DRAIN_DEADLINE_MS, 'drainDeadlineMs'),
    initializeDeadlineMs: positive(
      input?.initializeDeadlineMs,
      DEFAULT_INITIALIZE_DEADLINE_MS,
      'initializeDeadlineMs',
    ),
    maxBufferedAmount: positive(
      input?.maxBufferedAmount,
      DEFAULT_MAX_QUEUED_BYTES,
      'maxBufferedAmount',
    ),
  };
  if (!Number.isSafeInteger(limits.maxBufferedAmount + limits.maxQueuedBytes)) {
    throw new RangeError('Web Gateway combined backpressure limit exceeds safe range.');
  }
  return limits;
}

function positive(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new RangeError(`${label} must be positive.`);
  return value;
}

function bindingFor(port: number): Binding {
  const host = `${KITE_WEB_LOOPBACK_HOST}:${port}`;
  return { host, origin: `http://${host}` };
}

function defaultRequestIp(request: Request, server: Bun.Server<SocketData>): RequestIp {
  return server.requestIP(request);
}

function isLoopbackRequest(value: RequestIp): boolean {
  return value?.address === KITE_WEB_LOOPBACK_HOST;
}

function browserRequestAllowed(
  request: Request,
  binding: Binding,
  kind: 'bootstrap' | 'api' | 'websocket',
): boolean {
  if (request.headers.get('host') !== binding.host) return false;
  if (request.headers.get('origin') !== binding.origin) return false;
  if (request.headers.get('authorization') !== null) return false;
  const site = request.headers.get('sec-fetch-site');
  if (site !== 'same-origin') return false;
  const mode = request.headers.get('sec-fetch-mode');
  if (kind === 'websocket') return mode === 'websocket';
  return mode === 'cors' || mode === 'same-origin';
}

function isJsonRequest(request: Request): boolean {
  return request.headers.get('content-type') === 'application/json';
}

function controlCredentialDigest(credential: string): Buffer {
  if (!CONTROL_CREDENTIAL_PATTERN.test(credential)) {
    throw new TypeError('Web Gateway native control credential is invalid.');
  }
  return createHash('sha256').update(credential, 'utf8').digest();
}

function controlAuthorizationMatches(header: string | null, expected: Buffer): boolean {
  if (header === null || header.includes(',')) return false;
  const prefix = `${KITE_WEB_CONTROL_AUTHORIZATION_SCHEME} `;
  if (!header.startsWith(prefix)) return false;
  const credential = header.slice(prefix.length);
  if (!CONTROL_CREDENTIAL_PATTERN.test(credential)) return false;
  const actual = createHash('sha256').update(credential, 'utf8').digest();
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

function isWebSocketUpgrade(request: Request): boolean {
  return request.method === 'GET' && request.headers.get('upgrade')?.toLowerCase() === 'websocket';
}

function tabForRequest(
  request: Request,
  session: WebGatewaySessionRecord,
  tabs: Map<string, TabRecord>,
): TabRecord | undefined {
  const value = request.headers.get(KITE_WEB_TAB_HEADER);
  if (value === null || value.includes(',')) return undefined;
  const tab = tabs.get(value.trim());
  return tab?.cookieHash === session.cookieHash ? tab : undefined;
}

function exactLaunchBody(value: unknown): string | undefined {
  if (!isPlainObject(value) || !hasExactKeys(value, ['launchToken'])) return undefined;
  return typeof value.launchToken === 'string' ? value.launchToken : undefined;
}

function exactSchemaBody(value: unknown, kind: 'directory'): object | undefined {
  if (!isPlainObject(value)) return undefined;
  const expected = kind === 'directory' ? 'kite.app.web.directory-request.v1' : '';
  if (!hasExactKeys(value, ['schema']) || value.schema !== expected) return undefined;
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

async function readJson(
  request: Request,
  maximum: number,
): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false }> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maximum))
    return { ok: false };
  try {
    const reader = request.body?.getReader();
    if (reader === undefined) return { ok: false };
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        return { ok: false };
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function safeAssetPath(root: string, pathname: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return undefined;
  const relativeName =
    decoded === '/' || decoded === '/api-docs' || decoded === '/api-docs/'
      ? 'index.html'
      : decoded.replace(/^\/+/u, '');
  if (
    relativeName !== 'index.html' &&
    relativeName !== 'api-docs/openapi.json' &&
    !/^assets\/[A-Za-z0-9_-]+\.(?:css|ico|js|mjs|png|svg|woff2)$/u.test(relativeName)
  ) {
    return undefined;
  }
  const candidate = resolve(root, relativeName);
  const relativeNameCheck = relative(root, candidate);
  if (
    relativeNameCheck === '..' ||
    relativeNameCheck.startsWith(`..${sep}`) ||
    relativeNameCheck.includes(`..${sep}`)
  ) {
    return undefined;
  }
  return candidate;
}

function secureStaticAssetRoot(path: string): string {
  const absolute = resolve(path);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('Web Gateway static root is not a real directory.');
  }
  const canonical = realpathSync.native(absolute);
  if (canonical !== absolute) throw new Error('Web Gateway static root is not canonical.');
  return canonical;
}

function contentTypeFor(path: string): string {
  const extension = path.slice(path.lastIndexOf('.')).toLowerCase();
  switch (extension) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.ico':
      return 'image/x-icon';
    case '.woff2':
      return 'font/woff2';
    default:
      return 'application/octet-stream';
  }
}

async function defaultAssetReader(path: string): Promise<Response | undefined> {
  let descriptor: number | undefined;
  try {
    const parent = lstatSync(dirname(path));
    if (parent.isSymbolicLink() || !parent.isDirectory()) return undefined;
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1) return undefined;
    return new Response(readFileSync(descriptor));
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      ['ELOOP', 'ENOENT', 'ENOTDIR'].includes(String(error.code))
    ) {
      return undefined;
    }
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function secureResponse(
  status: number,
  body: BodyInit | undefined,
  extra: Record<string, string> = {},
): Response {
  const headers = new Headers(SECURITY_HEADERS);
  for (const [key, value] of Object.entries(extra)) headers.set(key, value);
  if (typeof body === 'string' && !headers.has('content-type')) {
    headers.set('content-type', 'text/plain; charset=utf-8');
  }
  return new Response(body, { status, headers });
}

function jsonResponse(
  value: Record<string, unknown>,
  extra: Record<string, string> = {},
): Response {
  return secureResponse(200, JSON.stringify(value), {
    'content-type': 'application/json; charset=utf-8',
    ...extra,
  });
}

function diagnose(options: WebGatewayCarrierOptions, code: WebGatewayDiagnosticCode): void {
  try {
    options.onDiagnostic?.(code);
  } catch {
    // Diagnostics are observation-only and cannot break Gateway cleanup.
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function opaqueTabHandle(random: (size: number) => Uint8Array): string {
  const bytes = random(24);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 24) {
    throw new Error('Web Gateway tab identity source is invalid.');
  }
  const handle = Buffer.from(bytes).toString('base64url');
  bytes.fill(0);
  return handle;
}

function socketClose(
  socket: Bun.ServerWebSocket<SocketData> | undefined,
  code: number,
  reason: string,
): void {
  try {
    socket?.close(code, reason);
  } catch {
    // Bun may throw when the peer already closed; the close callback remains
    // the only lifecycle evidence needed by this observer binding.
  }
}
