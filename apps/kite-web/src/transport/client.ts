import {
  WEB_DISCONNECT_REQUEST_SCHEMA_,
  WEB_HISTORY_REQUEST_SCHEMA_,
  WEB_SUBSCRIBE_REQUEST_SCHEMA_,
  WEB_UNSUBSCRIBE_REQUEST_SCHEMA_,
  type WebBootstrapResponse,
  type WebDirectoryResponse,
  type WebHistoryResponse,
  type WebObserverStreamEvent,
  type WebSubscribeResponse,
  type WebUnsubscribeResponse,
  webBootstrapResponseCodec,
  webDirectoryResponseCodec,
  webDisconnectResponseCodec,
  webHistoryResponseCodec,
  webObserverStreamEventCodec,
  webSubscribeResponseCodec,
  webTabCreateResponseCodec,
  webUnsubscribeResponseCodec,
} from '@kite-ai/kite-app-contract/web';

const TAB_HEADER = 'x-kite-web-tab';
const WS_CLIENT_PATH = '/_kite/web/client';
const WS_INITIALIZED_SCHEMA = 'kite.app.web.ws-initialized.v1';
const WS_INITIALIZE_DEADLINE_MS = 2_500;
const WS_REQUEST_DEADLINE_MS = 5_000;
const HTTP_REQUEST_DEADLINE_MS = 5_000;
const MAX_HISTORY_PAGES = 32;
const MAX_HISTORY_MESSAGES = 4_096;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export type WebObserverTransportFailure =
  | 'gateway_unavailable'
  | 'history_unavailable'
  | 'session_unavailable'
  | 'subscription_unavailable'
  | 'gateway_draining'
  | 'resync_required'
  | 'protocol_error';

export class WebObserverTransportError extends Error {
  readonly reason: WebObserverTransportFailure;
  readonly status: number | undefined;

  constructor(reason: WebObserverTransportFailure, status?: number) {
    super('Web Observer transport is unavailable.');
    this.name = 'WebObserverTransportError';
    this.reason = reason;
    this.status = status;
  }
}

export type WebObserverTransportConnectionState =
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'unavailable';

export interface WebObserverWebSocket {
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface WebObserverTransportOptions {
  /** Browser Fetch call shape only; Bun-specific static helpers are not part of this port. */
  readonly fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly webSocketFactory?: (url: string) => WebObserverWebSocket;
  readonly location?: Pick<
    Location,
    'hash' | 'host' | 'origin' | 'pathname' | 'protocol' | 'search'
  >;
  readonly history?: Pick<History, 'replaceState'>;
}

export interface WebObserverConnection {
  /** Local monotonic generation used to retire stale browser callbacks. */
  readonly generation: number;
  /** Gateway's tab-binding generation used only for initialize acknowledgement. */
  readonly connectionGeneration: number;
  readonly tabHandle: string;
  readonly gatewayInstanceId: string;
}

export interface WebObserverSubscribeInput {
  readonly sessionId: string;
  readonly afterSequence?: number;
  readonly onEvent: (event: WebObserverStreamEvent, generation: number) => void;
  readonly onState?: (state: WebObserverTransportConnectionState, generation: number) => void;
}

export interface WebObserverSubscription {
  readonly subscriptionId: string;
  readonly generation: number;
  unsubscribe(): Promise<void>;
}

export interface WebObserverTransport {
  connect(): Promise<WebObserverConnection>;
  listDirectory(): Promise<WebDirectoryResponse>;
  loadHistory(sessionId: string, cursor?: number, limit?: number): Promise<WebHistoryResponse>;
  subscribe(input: WebObserverSubscribeInput): Promise<WebObserverSubscription>;
  disconnect(): Promise<void>;
}

/**
 * Browser-only adapter for the closed Web Gateway surface. The launch token
 * is captured and the fragment is cleared synchronously at construction; no
 * token is retained after the one-shot bootstrap request is started.
 */
export function createWebObserverTransport(
  options: WebObserverTransportOptions = {},
): WebObserverTransport {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const browserLocation =
    options.location ??
    (typeof window === 'undefined'
      ? undefined
      : {
          hash: window.location.hash,
          host: window.location.host,
          origin: window.location.origin,
          pathname: window.location.pathname,
          protocol: window.location.protocol,
          search: window.location.search,
        });
  const launchToken = captureLaunchToken(browserLocation, options.history);
  let pendingLaunchToken: string | undefined = launchToken;
  let bootstrapResponse: WebBootstrapResponse | undefined;
  let connection: WebObserverConnection | undefined;
  let socket: WebObserverWebSocket | undefined;
  let socketGeneration = 0;
  let socketReady = false;
  let activeSubscription: ActiveSubscription | undefined;
  let pendingResponse: PendingResponse | undefined;
  let operationTail = Promise.resolve();
  let explicitlyDisconnected = false;
  let nextTransportGeneration = 0;
  let connecting: Promise<WebObserverConnection> | undefined;

  const transport: WebObserverTransport = {
    connect: () => {
      if (connecting !== undefined) return connecting;
      connecting = exclusive(connect).finally(() => {
        connecting = undefined;
      });
      return connecting;
    },
    listDirectory: () => exclusive(postDirectory),
    loadHistory: (sessionId, cursor, limit = 200) =>
      exclusive(() => postHistory(sessionId, cursor, limit)),
    subscribe: (input) => exclusive(() => subscribe(input)),
    disconnect: () => exclusive(disconnect),
  };
  return Object.freeze(transport);

  function exclusive<Value>(work: () => Promise<Value>): Promise<Value> {
    const run = operationTail.then(work, work);
    operationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function connect(): Promise<WebObserverConnection> {
    if (connection !== undefined) return connection;
    explicitlyDisconnected = false;
    await closeSocket(false);
    const bootstrap = await ensureBootstrap();
    const tab = await postTab();
    const nextConnection: WebObserverConnection = {
      generation: ++nextTransportGeneration,
      connectionGeneration: tab.connectionGeneration,
      tabHandle: tab.tabHandle,
      gatewayInstanceId: bootstrap.gatewayInstanceId,
    };
    connection = nextConnection;
    return nextConnection;
  }

  async function ensureBootstrap(): Promise<WebBootstrapResponse> {
    if (bootstrapResponse !== undefined) return bootstrapResponse;
    const token = pendingLaunchToken;
    pendingLaunchToken = undefined;
    if (token === undefined || !TOKEN_PATTERN.test(token)) {
      throw new WebObserverTransportError('gateway_unavailable');
    }
    const response = await postJson('/_kite/web/bootstrap', { launchToken: token });
    try {
      bootstrapResponse = webBootstrapResponseCodec.decode(response);
    } catch {
      throw new WebObserverTransportError('protocol_error');
    }
    return bootstrapResponse;
  }

  async function postTab(): Promise<{
    readonly tabHandle: string;
    readonly connectionGeneration: number;
  }> {
    const response = await postJson('/_kite/web/tabs', {
      schema: 'kite.app.web.tab-create-request.v1',
    });
    try {
      return webTabCreateResponseCodec.decode(response);
    } catch {
      throw new WebObserverTransportError('protocol_error');
    }
  }

  async function postDirectory(): Promise<WebDirectoryResponse> {
    const active = requireConnection();
    const response = await postJson(
      '/_kite/web/directory',
      { schema: 'kite.app.web.directory-request.v1' },
      active.tabHandle,
    );
    try {
      return webDirectoryResponseCodec.decode(response);
    } catch {
      throw new WebObserverTransportError('protocol_error');
    }
  }

  async function postHistory(
    sessionId: string,
    cursor: number | undefined,
    limit: number,
  ): Promise<WebHistoryResponse> {
    const active = requireConnection();
    let nextCursor = cursor;
    let observedLastSequence: number | undefined;
    let hasMore = true;
    let pages = 0;
    let messageCount = 0;
    const seenCursors = new Set<number>();
    const messages = new Map<string, WebHistoryResponse['messages'][number]>();

    while (hasMore) {
      if (pages >= MAX_HISTORY_PAGES) {
        throw new WebObserverTransportError('resync_required');
      }
      const page = await postHistoryPage(sessionId, nextCursor, limit, active.tabHandle);
      pages += 1;
      if (page.sessionId !== sessionId) {
        throw new WebObserverTransportError('session_unavailable');
      }
      if (
        observedLastSequence !== undefined &&
        observedLastSequence !== page.observedLastSequence
      ) {
        throw new WebObserverTransportError('resync_required');
      }
      if (nextCursor !== undefined && page.observedLastSequence < nextCursor) {
        throw new WebObserverTransportError('resync_required');
      }
      observedLastSequence ??= page.observedLastSequence;
      messageCount += page.messages.length;
      if (messageCount > MAX_HISTORY_MESSAGES) {
        throw new WebObserverTransportError('resync_required');
      }
      let priorIncomingSequence = nextCursor;
      for (const message of page.messages) {
        if (
          message.sequence > page.observedLastSequence ||
          (nextCursor !== undefined && message.sequence <= nextCursor) ||
          (priorIncomingSequence !== undefined && message.sequence < priorIncomingSequence)
        ) {
          throw new WebObserverTransportError('resync_required');
        }
        priorIncomingSequence = message.sequence;
        const prior = messages.get(message.messageId);
        if (
          prior !== undefined &&
          message.sequence === prior.sequence &&
          JSON.stringify(message) !== JSON.stringify(prior)
        ) {
          throw new WebObserverTransportError('resync_required');
        }
        if (prior === undefined || message.sequence > prior.sequence) {
          messages.set(message.messageId, message);
        }
      }
      hasMore = page.hasMore;
      if (hasMore) {
        const pageCursor = page.nextCursor;
        if (
          pageCursor === undefined ||
          (nextCursor !== undefined && pageCursor <= nextCursor) ||
          seenCursors.has(pageCursor)
        ) {
          throw new WebObserverTransportError('resync_required');
        }
        seenCursors.add(pageCursor);
        nextCursor = pageCursor;
      }
    }
    return {
      schema: 'kite.app.web.history-response.v1',
      sessionId,
      messages: [...messages.values()].sort(
        (left, right) =>
          left.sequence - right.sequence || left.messageId.localeCompare(right.messageId),
      ),
      hasMore: false,
      observedLastSequence: observedLastSequence ?? 0,
    };
  }

  async function postHistoryPage(
    sessionId: string,
    cursor: number | undefined,
    limit: number,
    tabHandle: string,
  ): Promise<WebHistoryResponse> {
    const response = await postJson(
      '/_kite/web/history',
      {
        schema: WEB_HISTORY_REQUEST_SCHEMA_,
        sessionId,
        ...(cursor === undefined ? {} : { cursor }),
        limit,
      },
      tabHandle,
    );
    try {
      return webHistoryResponseCodec.decode(response);
    } catch {
      throw new WebObserverTransportError('protocol_error');
    }
  }

  async function subscribe(input: WebObserverSubscribeInput): Promise<WebObserverSubscription> {
    const active = requireConnection();
    if (activeSubscription !== undefined) {
      throw new WebObserverTransportError('subscription_unavailable');
    }
    const liveSocket = await ensureLiveSocket(active);
    const request = {
      schema: WEB_SUBSCRIBE_REQUEST_SCHEMA_,
      sessionId: input.sessionId,
      ...(input.afterSequence === undefined ? {} : { afterSequence: input.afterSequence }),
    };
    const subscription: ActiveSubscription = {
      generation: active.generation,
      sessionId: input.sessionId,
      subscriptionId: '',
      onEvent: input.onEvent,
      onState: input.onState,
      closed: false,
    };
    activeSubscription = subscription;
    let response: WebSubscribeResponse;
    try {
      response = await sendAndWait<WebSubscribeResponse>(
        liveSocket,
        active.generation,
        request,
        (value) => webSubscribeResponseCodec.decode(value),
      );
    } catch (error) {
      subscription.closed = true;
      if (activeSubscription === subscription) activeSubscription = undefined;
      throw error;
    }
    if (response.sessionId !== input.sessionId) {
      subscription.closed = true;
      if (activeSubscription === subscription) activeSubscription = undefined;
      throw new WebObserverTransportError('protocol_error');
    }
    if (subscription.closed || activeSubscription !== subscription) {
      throw new WebObserverTransportError('subscription_unavailable');
    }
    subscription.subscriptionId = response.subscriptionId;
    return {
      subscriptionId: response.subscriptionId,
      generation: active.generation,
      unsubscribe: () => exclusive(() => unsubscribe(subscription)),
    };
  }

  async function unsubscribe(subscription: ActiveSubscription): Promise<void> {
    if (subscription.closed) return;
    subscription.closed = true;
    if (activeSubscription === subscription) activeSubscription = undefined;
    const activeSocket = socket;
    if (
      !activeSocket ||
      !socketReady ||
      socketGeneration !== subscription.generation ||
      activeSocket.readyState !== 1
    ) {
      return;
    }
    const request = {
      schema: WEB_UNSUBSCRIBE_REQUEST_SCHEMA_,
      subscriptionId: subscription.subscriptionId,
    };
    const response = await sendAndWait<WebUnsubscribeResponse>(
      activeSocket,
      subscription.generation,
      request,
      (value) => webUnsubscribeResponseCodec.decode(value),
    );
    if (response.subscriptionId !== subscription.subscriptionId) {
      throw new WebObserverTransportError('protocol_error');
    }
  }

  async function disconnect(): Promise<void> {
    if (explicitlyDisconnected) return;
    explicitlyDisconnected = true;
    const active = connection;
    const activeSocket = socket;
    try {
      if (activeSocket && socketReady && activeSocket.readyState === 1 && active !== undefined) {
        const request = { schema: WEB_DISCONNECT_REQUEST_SCHEMA_ };
        const response = await sendAndWait(activeSocket, active.generation, request, (value) =>
          webDisconnectResponseCodec.decode(value),
        );
        if (!response.disconnected) throw new WebObserverTransportError('gateway_unavailable');
        return;
      }
      if (active === undefined) return;
      await postJson(
        '/_kite/web/disconnect',
        { schema: WEB_DISCONNECT_REQUEST_SCHEMA_ },
        active.tabHandle,
      );
    } finally {
      await closeSocket(true);
      connection = undefined;
    }
  }

  async function openSocket(nextConnection: WebObserverConnection): Promise<void> {
    const ws = createWebSocket(browserLocation, options.webSocketFactory);
    socket = ws;
    socketGeneration = nextConnection.generation;
    socketReady = false;
    const initialized = new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled || !isCurrentSocket(ws, nextConnection.generation)) return;
        settled = true;
        reject(new WebObserverTransportError('gateway_unavailable'));
        failCurrentSocket(ws, nextConnection.generation, 'gateway_unavailable', false);
      }, WS_INITIALIZE_DEADLINE_MS);
      ws.onopen = () => {
        if (!isCurrentSocket(ws, nextConnection.generation)) return;
        try {
          ws.send(JSON.stringify({ type: 'initialize', tabHandle: nextConnection.tabHandle }));
        } catch {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            reject(new WebObserverTransportError('gateway_unavailable'));
          }
          failCurrentSocket(ws, nextConnection.generation, 'gateway_unavailable', false);
        }
      };
      ws.onmessage = (event) => {
        if (!isCurrentSocket(ws, nextConnection.generation)) return;
        const value = parseJson(event.data);
        if (!settled) {
          if (isInitialized(value, nextConnection.connectionGeneration)) {
            clearTimeout(timer);
            settled = true;
            socketReady = true;
            resolve();
          } else {
            clearTimeout(timer);
            settled = true;
            reject(new WebObserverTransportError('protocol_error'));
            failCurrentSocket(ws, nextConnection.generation, 'protocol_error', false);
          }
          return;
        }
        handleSocketMessage(value, ws, nextConnection.generation);
      };
      ws.onerror = () => {
        if (!isCurrentSocket(ws, nextConnection.generation)) return;
        if (!settled) {
          clearTimeout(timer);
          settled = true;
          reject(new WebObserverTransportError('gateway_unavailable'));
        }
        failCurrentSocket(ws, nextConnection.generation, 'gateway_unavailable', false);
      };
      ws.onclose = () => {
        if (!isCurrentSocket(ws, nextConnection.generation)) return;
        if (!settled) {
          clearTimeout(timer);
          settled = true;
          reject(new WebObserverTransportError('gateway_unavailable'));
        }
        failCurrentSocket(ws, nextConnection.generation, 'gateway_unavailable', true);
      };
    });
    try {
      await initialized;
    } catch (error) {
      if (socket === ws) socket = undefined;
      throw error;
    }
  }

  async function ensureLiveSocket(active: WebObserverConnection): Promise<WebObserverWebSocket> {
    if (
      socket !== undefined &&
      socketReady &&
      socketGeneration === active.generation &&
      socket.readyState === 1
    ) {
      return socket;
    }
    await closeSocket(false);
    try {
      await openSocket(active);
    } catch (error) {
      if (error instanceof WebObserverTransportError) throw error;
      throw new WebObserverTransportError('gateway_unavailable');
    }
    if (
      socket === undefined ||
      !socketReady ||
      socketGeneration !== active.generation ||
      socket.readyState !== 1
    ) {
      throw new WebObserverTransportError('subscription_unavailable');
    }
    return socket;
  }

  function handleSocketMessage(value: unknown, ws: WebObserverWebSocket, generation: number): void {
    if (pendingResponse !== undefined) {
      const pending = pendingResponse;
      if (pending.generation === generation && pending.socket === ws) {
        try {
          const decoded = pending.decode(value);
          clearTimeout(pending.timer);
          pendingResponse = undefined;
          pending.resolve(decoded);
          return;
        } catch {
          clearTimeout(pending.timer);
          pendingResponse = undefined;
          pending.reject(new WebObserverTransportError('protocol_error'));
          failCurrentSocket(ws, generation, 'protocol_error', false);
          return;
        }
      }
    }
    const subscription = activeSubscription;
    if (subscription === undefined || subscription.generation !== generation || socket !== ws) {
      failCurrentSocket(ws, generation, 'protocol_error', false);
      return;
    }
    try {
      const event = webObserverStreamEventCodec.decode(value);
      subscription.onEvent(event, generation);
      if (event.type !== 'message') {
        subscription.closed = true;
        activeSubscription = undefined;
        if (connection?.generation === generation) connection = undefined;
        void closeSocket(true);
      }
    } catch {
      subscription.onState?.('unavailable', generation);
      subscription.closed = true;
      activeSubscription = undefined;
      failCurrentSocket(ws, generation, 'protocol_error', false);
    }
  }

  function isCurrentSocket(ws: WebObserverWebSocket, generation: number): boolean {
    return socket === ws && socketGeneration === generation;
  }

  function failCurrentSocket(
    ws: WebObserverWebSocket,
    generation: number,
    reason: WebObserverTransportFailure,
    peerClosed: boolean,
  ): void {
    if (!isCurrentSocket(ws, generation)) return;
    const pending = pendingResponse;
    if (pending?.socket === ws && pending.generation === generation) {
      clearTimeout(pending.timer);
      pendingResponse = undefined;
      pending.reject(new WebObserverTransportError(reason));
    }
    const subscription = activeSubscription;
    activeSubscription = undefined;
    if (subscription && !subscription.closed) {
      subscription.closed = true;
      subscription.onState?.(peerClosed ? 'disconnected' : 'unavailable', generation);
    }
    socketReady = false;
    socket = undefined;
    if (!peerClosed) {
      try {
        ws.close(1011, reason === 'protocol_error' ? 'protocol_error' : 'unavailable');
      } catch {
        // A failed transport may already be closing; the identity is retired.
      }
    }
  }

  async function sendAndWait<Value>(
    ws: WebObserverWebSocket,
    generation: number,
    request: Record<string, unknown>,
    decode: (value: unknown) => Value,
  ): Promise<Value> {
    if (pendingResponse !== undefined) throw new WebObserverTransportError('protocol_error');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let created: PendingResponse | undefined;
    const response = new Promise<Value>((resolve, reject) => {
      const pending: PendingResponse = {
        socket: ws,
        generation,
        decode: decode as (value: unknown) => unknown,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer: undefined as unknown as ReturnType<typeof setTimeout>,
      };
      timer = setTimeout(() => {
        if (pendingResponse !== pending) return;
        pendingResponse = undefined;
        pending.reject(new WebObserverTransportError('gateway_unavailable'));
        failCurrentSocket(ws, generation, 'gateway_unavailable', false);
      }, WS_REQUEST_DEADLINE_MS);
      pending.timer = timer;
      pendingResponse = pending;
      created = pending;
    });
    try {
      ws.send(JSON.stringify(request));
    } catch {
      if (created?.socket === ws && created.generation === generation) {
        clearTimeout(created.timer);
        pendingResponse = undefined;
        created.reject(new WebObserverTransportError('gateway_unavailable'));
      }
      return response;
    }
    return response;
  }

  async function closeSocket(intentional: boolean): Promise<void> {
    const ws = socket;
    socketReady = false;
    if (pendingResponse !== undefined) {
      clearTimeout(pendingResponse.timer);
      pendingResponse.reject(new WebObserverTransportError('gateway_unavailable'));
      pendingResponse = undefined;
    }
    const subscription = activeSubscription;
    activeSubscription = undefined;
    if (subscription && !subscription.closed) {
      subscription.closed = true;
      if (!intentional) subscription.onState?.('disconnected', subscription.generation);
    }
    socket = undefined;
    if (ws === undefined) return;
    try {
      ws.close(intentional ? 1000 : 1012, intentional ? 'disconnected' : 'reconnecting');
    } catch {
      // An already-closed browser socket is an expected cleanup race.
    }
  }

  function requireConnection(): WebObserverConnection {
    if (connection === undefined) throw new WebObserverTransportError('gateway_unavailable');
    return connection;
  }

  async function postJson(path: string, body: unknown, tabHandle?: string): Promise<unknown> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'content-type': 'application/json',
    };
    if (tabHandle !== undefined) headers[TAB_HEADER] = tabHandle;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_REQUEST_DEADLINE_MS);
    let response: Response;
    try {
      response = await fetchImpl(path, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
        headers,
        body: JSON.stringify(body),
      });
    } catch {
      clearTimeout(timer);
      throw new WebObserverTransportError('gateway_unavailable');
    }
    if (!response.ok) {
      clearTimeout(timer);
      throw httpFailure(response.status);
    }
    try {
      return await response.json();
    } catch {
      throw new WebObserverTransportError('protocol_error', response.status);
    } finally {
      clearTimeout(timer);
    }
  }
}

interface ActiveSubscription {
  readonly generation: number;
  readonly sessionId: string;
  subscriptionId: string;
  readonly onEvent: (event: WebObserverStreamEvent, generation: number) => void;
  readonly onState?: (state: WebObserverTransportConnectionState, generation: number) => void;
  closed: boolean;
}

interface PendingResponse {
  readonly socket: WebObserverWebSocket;
  readonly generation: number;
  readonly decode: (value: unknown) => unknown;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

function captureLaunchToken(
  location: Pick<Location, 'hash' | 'pathname' | 'search'> | undefined,
  history: Pick<History, 'replaceState'> | undefined,
): string | undefined {
  if (location === undefined) return undefined;
  const hash = location.hash;
  const token = hash.startsWith('#') ? hash.slice(1) : undefined;
  if (hash.length > 0) {
    try {
      (history ?? (typeof window === 'undefined' ? undefined : window.history))?.replaceState(
        null,
        '',
        `${location.pathname}${location.search}`,
      );
    } catch {
      // The fragment is still excluded from every request; failure to mutate
      // browser history does not turn it into an authorization header/query.
    }
  }
  return token;
}

function createWebSocket(
  location: Pick<Location, 'host' | 'origin' | 'protocol'> | undefined,
  factory?: (url: string) => WebObserverWebSocket,
): WebObserverWebSocket {
  const activeLocation =
    location ??
    (typeof window === 'undefined'
      ? undefined
      : {
          host: window.location.host,
          origin: window.location.origin,
          protocol: window.location.protocol,
        });
  if (activeLocation === undefined) throw new WebObserverTransportError('gateway_unavailable');
  const websocketUrl = `${activeLocation.protocol === 'https:' ? 'wss:' : 'ws:'}//${activeLocation.host}${WS_CLIENT_PATH}`;
  if (factory) return factory(websocketUrl);
  if (typeof WebSocket === 'undefined') throw new WebObserverTransportError('gateway_unavailable');
  return new WebSocket(websocketUrl) as unknown as WebObserverWebSocket;
}

function isInitialized(value: unknown, generation: number): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ['connectionGeneration', 'schema', 'type'])) {
    return false;
  }
  return (
    value.schema === WS_INITIALIZED_SCHEMA &&
    value.type === 'initialized' &&
    value.connectionGeneration === generation
  );
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function httpFailure(status: number): WebObserverTransportError {
  if (status === 409) return new WebObserverTransportError('resync_required', status);
  if (status === 401 || status === 404) {
    return new WebObserverTransportError('session_unavailable', status);
  }
  if (status === 400 || status === 405 || status === 415) {
    return new WebObserverTransportError('protocol_error', status);
  }
  return new WebObserverTransportError('gateway_unavailable', status);
}
