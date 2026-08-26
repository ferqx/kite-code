import {
  RUNTIME_PROTOCOL_ERROR_NUMBERS,
  RUNTIME_PROTOCOL_LIMITS,
  type RuntimeProtocolMessage,
} from '@kite-ai/runtime-protocol';
import type { RuntimeServer, RuntimeServerLogicalMessageConnection } from '@kite-ai/runtime-server';
import {
  createLocalBootstrapAuth,
  type LocalBootstrapAuth,
  type LocalBootstrapAuthOptions,
} from './local-bootstrap-auth';

const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_LOGICAL_QUEUE_MESSAGES = 32;
const DEFAULT_BACKPRESSURE_LIMIT = RUNTIME_PROTOCOL_LIMITS.maxMessageBytes * 2;
const DEFAULT_DRAIN_DEADLINE_MS = 1_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_HEARTBEAT_DEADLINE_MS = 45_000;
const POLL_INTERVAL_MS = 10;

type SocketData = Readonly<{ session: LoopbackSocketSession }>;
type RequestIp = Readonly<{ address: string }> | null;

export interface DevelopmentLoopbackCarrierLimits {
  readonly maxLogicalQueueMessages?: number;
  readonly maxBufferedAmount?: number;
  readonly drainDeadlineMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatDeadlineMs?: number;
}

export interface DevelopmentLoopbackCarrierOptions {
  /** The existing App-composed Server; this carrier never creates a Host or Store. */
  readonly server: RuntimeServer;
  /** Test-only deterministic local-auth seam. Production callers use the per-process default. */
  readonly auth?: LocalBootstrapAuth;
  readonly authOptions?: LocalBootstrapAuthOptions;
  readonly limits?: DevelopmentLoopbackCarrierLimits;
  /** Test-only seam for Bun.Server.requestIP(). It is never a caller-controlled host override. */
  readonly requestIp?: (request: Request, server: Bun.Server<SocketData>) => RequestIp;
  /** Injectable only to make heartbeat and drain conformance deterministic. */
  readonly now?: () => number;
  /** Fixed-code, content-free diagnostics for development qualification. */
  readonly onDiagnostic?: (code: DevelopmentLoopbackDiagnosticCode) => void;
}

export type DevelopmentLoopbackDiagnosticCode =
  | 'socket_open'
  | 'socket_closed'
  | 'outbound_sent'
  | 'outbound_backpressure'
  | 'outbound_dropped';

export interface DevelopmentLoopbackCarrier {
  readonly origin: string;
  readonly rpcUrl: string;
  /** One-time bootstrap bearer. Send it only in Authorization on POST /_kite/bootstrap. */
  readonly bootstrapBearer: string;
  /** Drains the injected core, closes old sockets with 1012, and clears auth/timers. */
  close(): Promise<void>;
}

/**
 * Development/reference-only loopback carrier. It deliberately binds exactly
 * 127.0.0.1:0 and exposes no CLI or package-public production entrypoint.
 */
export function createDevelopmentLoopbackCarrier(
  options: DevelopmentLoopbackCarrierOptions,
): DevelopmentLoopbackCarrier {
  const limits = normalizeLimits(options.limits);
  const auth = options.auth ?? createLocalBootstrapAuth(options.authOptions);
  const now = options.now ?? Date.now;
  const sessions = new Set<LoopbackSocketSession>();
  let closing: Promise<void> | undefined;
  let closed = false;
  let bunServer!: Bun.Server<SocketData>;

  bunServer = Bun.serve<SocketData>({
    hostname: LOOPBACK_HOST,
    port: 0,
    development: false,
    fetch(request, server) {
      const port = server.port;
      if (!port || closed) return secureResponse(503, 'unavailable');
      const binding = bindingFor(port);
      const requestIp = (options.requestIp ?? defaultRequestIp)(request, server);
      if (!isLoopbackRequest(requestIp) || request.headers.get('host') !== binding.host) {
        return secureResponse(403, 'forbidden');
      }

      const url = new URL(request.url);
      if (url.search.length !== 0) return secureResponse(403, 'forbidden');
      if (url.pathname === '/healthz' || url.pathname === '/readyz') {
        if (request.method !== 'GET' || !hasExactOrAbsentOrigin(request, binding.origin)) {
          return secureResponse(403, 'forbidden');
        }
        return secureResponse(200, url.pathname === '/healthz' ? 'ok' : 'ready');
      }
      if (url.pathname === '/_kite/bootstrap') {
        if (
          request.method !== 'POST' ||
          request.headers.get('origin') !== binding.origin ||
          request.headers.get('cookie') !== null ||
          request.body !== null
        ) {
          return secureResponse(403, 'forbidden');
        }
        const result = auth.consumeBootstrap({
          authorization: request.headers.get('authorization'),
          origin: binding.origin,
          host: binding.host,
        });
        if (!result.ok) return secureResponse(401, 'unauthorized');
        return secureResponse(204, undefined, { 'set-cookie': result.cookie.setCookie });
      }
      if (url.pathname === '/rpc') {
        if (
          request.method !== 'GET' ||
          request.headers.get('origin') !== binding.origin ||
          request.headers.get('authorization') !== null ||
          !isWebSocketUpgrade(request)
        ) {
          return secureResponse(403, 'forbidden');
        }
        const authorized = auth.authorizeWebSocket({
          cookie: request.headers.get('cookie'),
          origin: binding.origin,
          host: binding.host,
        });
        if (!authorized.ok) return secureResponse(401, 'unauthorized');
        const session = new LoopbackSocketSession({
          server: options.server,
          sessions,
          limits,
          now,
          restarting: () => closed,
          diagnose: (code) => options.onDiagnostic?.(code),
        });
        if (!server.upgrade(request, { data: { session } }))
          return secureResponse(400, 'bad_request');
        sessions.add(session);
        return undefined;
      }
      return secureResponse(request.method === 'OPTIONS' ? 405 : 404, 'not_found');
    },
    websocket: {
      data: {} as SocketData,
      // Leave enough headroom for the carrier to return the required 1009
      // instead of relying on Bun's implementation-defined over-limit close.
      maxPayloadLength: RUNTIME_PROTOCOL_LIMITS.maxMessageBytes * 2,
      backpressureLimit: limits.maxBufferedAmount,
      closeOnBackpressureLimit: true,
      sendPings: false,
      open(ws) {
        ws.data.session.open(ws);
      },
      message(ws, message) {
        ws.data.session.message(ws, message);
      },
      drain(ws) {
        ws.data.session.drain();
      },
      ping(ws, data) {
        ws.pong(data);
        ws.data.session.heartbeat();
      },
      pong(ws) {
        ws.data.session.heartbeat();
      },
      close(ws) {
        ws.data.session.closed();
      },
    },
  });

  const port = bunServer.port;
  if (!port) {
    auth.close();
    bunServer.stop(true);
    throw new Error('Development loopback carrier did not obtain an ephemeral port.');
  }
  const binding = bindingFor(port);
  return Object.freeze({
    origin: binding.origin,
    rpcUrl: `ws://${binding.host}/rpc`,
    get bootstrapBearer() {
      return auth.bootstrapBearer;
    },
    close: () => {
      closing ??= (async () => {
        closed = true;
        for (const session of sessions) session.restart();
        try {
          await options.server.beginDraining();
        } finally {
          for (const session of sessions) session.forceClose(1012, 'service_restart');
          sessions.clear();
          auth.close();
          await bunServer.stop(true);
        }
      })();
      return closing;
    },
  });
}

class LoopbackSocketSession implements RuntimeServerLogicalMessageConnection {
  readonly incoming: AsyncIterable<unknown>;
  readonly #queue: BoundedLogicalMessageQueue;
  readonly #server: RuntimeServer;
  readonly #sessions: Set<LoopbackSocketSession>;
  readonly #limits: Required<DevelopmentLoopbackCarrierLimits>;
  readonly #now: () => number;
  readonly #restarting: () => boolean;
  readonly #diagnose: (code: DevelopmentLoopbackDiagnosticCode) => void;
  #socket: Bun.ServerWebSocket<SocketData> | undefined;
  #closed = false;
  #lastPong = 0;
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  #drainWaiters = new Set<() => void>();
  #outboundPending = 0;
  #outboundTail = Promise.resolve();

  constructor(input: {
    readonly server: RuntimeServer;
    readonly sessions: Set<LoopbackSocketSession>;
    readonly limits: Required<DevelopmentLoopbackCarrierLimits>;
    readonly now: () => number;
    readonly restarting: () => boolean;
    readonly diagnose: (code: DevelopmentLoopbackDiagnosticCode) => void;
  }) {
    this.#server = input.server;
    this.#sessions = input.sessions;
    this.#limits = input.limits;
    this.#now = input.now;
    this.#restarting = input.restarting;
    this.#diagnose = input.diagnose;
    this.#queue = new BoundedLogicalMessageQueue(input.limits.maxLogicalQueueMessages);
    this.incoming = this.#queue;
  }

  open(socket: Bun.ServerWebSocket<SocketData>): void {
    if (this.#closed) {
      socket.close(1012, 'service_restart');
      return;
    }
    this.#socket = socket;
    this.#diagnose('socket_open');
    this.#lastPong = this.#now();
    this.#heartbeatTimer = setInterval(
      () => this.#tickHeartbeat(),
      this.#limits.heartbeatIntervalMs,
    );
    this.#server.open(this);
  }

  message(socket: Bun.ServerWebSocket<SocketData>, message: string | Buffer): void {
    if (this.#closed || socket !== this.#socket) return;
    this.heartbeat();
    if (typeof message !== 'string') {
      this.forceClose(1003, 'binary_unsupported');
      return;
    }
    if (byteLength(message) > RUNTIME_PROTOCOL_LIMITS.maxMessageBytes) {
      this.forceClose(1009, 'message_too_big');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(message) as unknown;
    } catch {
      void this.#sendParseError();
      return;
    }
    if (!this.#queue.push(parsed)) this.forceClose(1013, 'message_queue_full');
  }

  drain(): void {
    for (const resolve of this.#drainWaiters) resolve();
    this.#drainWaiters.clear();
  }

  heartbeat(): void {
    this.#lastPong = this.#now();
  }

  restart(): void {
    this.#clearHeartbeat();
  }

  forceClose(code: number, reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearHeartbeat();
    this.#queue.close();
    this.#socket?.close(code, reason);
  }

  async send(message: RuntimeProtocolMessage): Promise<void> {
    return this.#enqueueOutbound(async () => {
      const socket = this.#socket;
      if (!socket || this.#closed) throw new Error('development loopback socket is closed');
      const payload = JSON.stringify(message);
      await this.#waitForWritable(socket);
      const result = socket.sendText(payload);
      if (result === 0) {
        this.#diagnose('outbound_dropped');
        this.forceClose(1013, 'outbound_dropped');
        throw new Error('development loopback socket dropped an outbound message');
      }
      if (result < 0) {
        this.#diagnose('outbound_backpressure');
        await this.#waitForWritable(socket);
      } else {
        this.#diagnose('outbound_sent');
      }
      // Bun's positive sendText result means accepted, not that a following
      // frame can already share the same protocol ordering boundary. Yield
      // one I/O turn before RuntimeServer observes send completion so a
      // subscribe ack is visible before its initial notification/ready frames.
      await socketDeliveryTurn();
    });
  }

  async #enqueueOutbound(action: () => Promise<void>): Promise<void> {
    if (this.#outboundPending >= this.#limits.maxLogicalQueueMessages) {
      this.forceClose(1013, 'outbound_queue_full');
      throw new Error('development loopback socket outbound queue is full');
    }
    this.#outboundPending += 1;
    const current = this.#outboundTail.then(action, action);
    this.#outboundTail = current.catch(() => undefined);
    try {
      await current;
    } finally {
      this.#outboundPending -= 1;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearHeartbeat();
    this.#queue.close();
    this.#socket?.close(
      this.#restarting() ? 1012 : 1000,
      this.#restarting() ? 'service_restart' : 'connection_closed',
    );
  }

  closed(): void {
    this.#diagnose('socket_closed');
    if (this.#closed) {
      this.#sessions.delete(this);
      return;
    }
    this.#closed = true;
    this.#clearHeartbeat();
    this.#queue.close();
    this.#sessions.delete(this);
  }

  async #sendParseError(): Promise<void> {
    try {
      await this.send({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: RUNTIME_PROTOCOL_ERROR_NUMBERS.parse_error,
          message: 'Parse error',
          data: { code: 'parse_error' },
        },
      });
    } catch {
      this.forceClose(1011, 'parse_response_failed');
    }
  }

  async #waitForWritable(socket: Bun.ServerWebSocket<SocketData>): Promise<void> {
    const deadline = this.#now() + this.#limits.drainDeadlineMs;
    while (!this.#closed && socket.getBufferedAmount() > this.#limits.maxBufferedAmount) {
      if (this.#now() >= deadline) {
        this.forceClose(1013, 'drain_timeout');
        throw new Error('development loopback socket drain deadline exceeded');
      }
      await this.#waitForDrain(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - this.#now())));
    }
    if (this.#closed) throw new Error('development loopback socket is closed');
  }

  #waitForDrain(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#drainWaiters.delete(wake);
        resolve();
      }, timeoutMs);
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      this.#drainWaiters.add(wake);
    });
  }

  #tickHeartbeat(): void {
    const socket = this.#socket;
    if (!socket || this.#closed) return;
    const elapsed = this.#now() - this.#lastPong;
    if (elapsed >= this.#limits.heartbeatDeadlineMs) {
      this.forceClose(1001, 'heartbeat_timeout');
      return;
    }
    socket.ping();
  }

  #clearHeartbeat(): void {
    if (this.#heartbeatTimer !== undefined) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
    for (const resolve of this.#drainWaiters) resolve();
    this.#drainWaiters.clear();
  }
}

class BoundedLogicalMessageQueue implements AsyncIterable<unknown> {
  readonly #items: unknown[] = [];
  readonly #waiters = new Set<(result: IteratorResult<unknown>) => void>();
  readonly #maximum: number;
  #closed = false;

  constructor(maximum: number) {
    this.#maximum = maximum;
  }

  push(value: unknown): boolean {
    if (this.#closed) return false;
    const waiter = this.#waiters.values().next().value;
    if (waiter) {
      this.#waiters.delete(waiter);
      waiter({ done: false, value });
      return true;
    }
    if (this.#items.length >= this.#maximum) return false;
    this.#items.push(value);
    return true;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#items.length = 0;
    for (const waiter of this.#waiters) waiter({ done: true, value: undefined });
    this.#waiters.clear();
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: () => {
        const value = this.#items.shift();
        if (value !== undefined) return Promise.resolve({ done: false, value });
        if (this.#closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise<IteratorResult<unknown>>((resolve) => this.#waiters.add(resolve));
      },
      return: async () => {
        this.close();
        return { done: true, value: undefined };
      },
    };
  }
}

function normalizeLimits(
  input: DevelopmentLoopbackCarrierLimits | undefined,
): Required<DevelopmentLoopbackCarrierLimits> {
  const limits = {
    maxLogicalQueueMessages: input?.maxLogicalQueueMessages ?? DEFAULT_LOGICAL_QUEUE_MESSAGES,
    maxBufferedAmount: input?.maxBufferedAmount ?? DEFAULT_BACKPRESSURE_LIMIT,
    drainDeadlineMs: input?.drainDeadlineMs ?? DEFAULT_DRAIN_DEADLINE_MS,
    heartbeatIntervalMs: input?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
    heartbeatDeadlineMs: input?.heartbeatDeadlineMs ?? DEFAULT_HEARTBEAT_DEADLINE_MS,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new TypeError(`${name} must be a positive safe integer.`);
  }
  if (limits.heartbeatDeadlineMs < limits.heartbeatIntervalMs) {
    throw new RangeError('heartbeatDeadlineMs must not be shorter than heartbeatIntervalMs.');
  }
  return limits;
}

function bindingFor(port: number): Readonly<{ host: string; origin: string }> {
  const host = `${LOOPBACK_HOST}:${port}`;
  return { host, origin: `http://${host}` };
}

function defaultRequestIp(request: Request, server: Bun.Server<SocketData>): RequestIp {
  return server.requestIP(request);
}

function isLoopbackRequest(value: RequestIp): boolean {
  return value?.address === LOOPBACK_HOST;
}

function hasExactOrAbsentOrigin(request: Request, origin: string): boolean {
  const value = request.headers.get('origin');
  return value === null || value === origin;
}

function isWebSocketUpgrade(request: Request): boolean {
  return request.headers.get('upgrade')?.toLowerCase() === 'websocket';
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function socketDeliveryTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function secureResponse(status: number, body?: string, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set('cache-control', 'no-store');
  headers.set(
    'content-security-policy',
    "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  headers.set('referrer-policy', 'no-referrer');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('x-frame-options', 'DENY');
  return new Response(body, { status, headers });
}
