import type { RuntimeClientConnection, RuntimeClientTransport } from '@kite-ai/runtime-client';
import {
  RUNTIME_PROTOCOL_LIMITS,
  type RuntimeProtocolMessage,
  safeDecodeRuntimeProtocolMessage,
} from '@kite-ai/runtime-protocol';

const DEFAULT_CONNECT_DEADLINE_MS = 5_000;
const DEFAULT_SEND_DEADLINE_MS = 5_000;
const DEFAULT_MAX_BUFFERED_AMOUNT = RUNTIME_PROTOCOL_LIMITS.maxMessageBytes;
const DEFAULT_MAX_QUEUED_MESSAGES = RUNTIME_PROTOCOL_LIMITS.maxOutboundMessages;
const BACKPRESSURE_POLL_INTERVAL_MS = 5;
const WEB_SOCKET_CONNECTING = 0;
const WEB_SOCKET_OPEN = 1;
const WEB_SOCKET_CLOSING = 2;

type WebSocketEventType = 'open' | 'message' | 'close' | 'error';

interface BrowserWebSocketEvent {
  readonly data?: unknown;
}

/** The browser-compatible subset used by this App-owned carrier. */
export interface RuntimeWebSocketLike {
  readonly readyState: number;
  readonly bufferedAmount: number;
  addEventListener(
    type: WebSocketEventType,
    listener: (event: BrowserWebSocketEvent) => void,
  ): void;
  removeEventListener(
    type: WebSocketEventType,
    listener: (event: BrowserWebSocketEvent) => void,
  ): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/** A factory is injectable for reference consumers and isolated conformance tests. */
export type RuntimeWebSocketFactory = (url: string) => RuntimeWebSocketLike;

export interface BunWebSocketRuntimeClientTransportOptions {
  /** The App bootstrap supplies this URL; a resolver supports a fresh endpoint after Server restart. */
  readonly url: string | (() => string);
  /** Defaults to the browser/Bun global WebSocket constructor. */
  readonly webSocketFactory?: RuntimeWebSocketFactory;
  readonly connectDeadlineMs?: number;
  readonly sendDeadlineMs?: number;
  readonly maxBufferedAmount?: number;
  readonly maxQueuedMessages?: number;
}

/**
 * App-local WebSocket transport for RuntimeClient. It owns only framing and
 * socket lifecycle; browser cookies are attached by the WebSocket runtime
 * after App-owned HTTP bootstrap.
 */
export class BunWebSocketRuntimeClientTransport implements RuntimeClientTransport {
  readonly #resolveUrl: () => string;
  readonly #webSocketFactory: RuntimeWebSocketFactory;
  readonly #connectDeadlineMs: number;
  readonly #sendDeadlineMs: number;
  readonly #maxBufferedAmount: number;
  readonly #maxQueuedMessages: number;

  constructor(options: BunWebSocketRuntimeClientTransportOptions) {
    this.#resolveUrl = typeof options.url === 'string' ? () => options.url as string : options.url;
    if (typeof options.url === 'string') assertWebSocketUrl(options.url);
    this.#webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.#connectDeadlineMs = positiveSafeInteger(
      options.connectDeadlineMs,
      DEFAULT_CONNECT_DEADLINE_MS,
      'connectDeadlineMs',
    );
    this.#sendDeadlineMs = positiveSafeInteger(
      options.sendDeadlineMs,
      DEFAULT_SEND_DEADLINE_MS,
      'sendDeadlineMs',
    );
    this.#maxBufferedAmount = nonNegativeSafeInteger(
      options.maxBufferedAmount,
      DEFAULT_MAX_BUFFERED_AMOUNT,
      'maxBufferedAmount',
    );
    this.#maxQueuedMessages = positiveSafeInteger(
      options.maxQueuedMessages,
      DEFAULT_MAX_QUEUED_MESSAGES,
      'maxQueuedMessages',
    );
  }

  async connect(): Promise<RuntimeClientConnection> {
    const url = this.#resolveUrl();
    assertWebSocketUrl(url);
    const socket = this.#webSocketFactory(url);
    const connection = new WebSocketRuntimeClientConnection({
      socket,
      connectDeadlineMs: this.#connectDeadlineMs,
      sendDeadlineMs: this.#sendDeadlineMs,
      maxBufferedAmount: this.#maxBufferedAmount,
      maxQueuedMessages: this.#maxQueuedMessages,
    });
    await connection.waitForOpen();
    return connection;
  }
}

export function createBunWebSocketRuntimeClientTransport(
  options: BunWebSocketRuntimeClientTransportOptions,
): RuntimeClientTransport {
  return new BunWebSocketRuntimeClientTransport(options);
}

class WebSocketRuntimeClientConnection implements RuntimeClientConnection {
  readonly #socket: RuntimeWebSocketLike;
  readonly #sendDeadlineMs: number;
  readonly #maxBufferedAmount: number;
  readonly #queue: BoundedMessageQueue;
  readonly #onOpen = (): void => this.#opened();
  readonly #onMessage = (event: BrowserWebSocketEvent): void => this.#received(event);
  readonly #onClose = (): void => this.#failed('Runtime WebSocket connection closed.');
  readonly #onError = (): void => this.#failed('Runtime WebSocket connection failed.');
  #openPromise: Promise<void>;
  #resolveOpen!: () => void;
  #rejectOpen!: (reason: Error) => void;
  #connectTimer: ReturnType<typeof setTimeout> | undefined;
  #failure: Error | undefined;
  #closed = false;

  constructor(options: {
    readonly socket: RuntimeWebSocketLike;
    readonly connectDeadlineMs: number;
    readonly sendDeadlineMs: number;
    readonly maxBufferedAmount: number;
    readonly maxQueuedMessages: number;
  }) {
    this.#socket = options.socket;
    this.#sendDeadlineMs = options.sendDeadlineMs;
    this.#maxBufferedAmount = options.maxBufferedAmount;
    this.#queue = new BoundedMessageQueue(options.maxQueuedMessages);
    this.#openPromise = new Promise<void>((resolve, reject) => {
      this.#resolveOpen = resolve;
      this.#rejectOpen = reject;
    });
    this.#socket.addEventListener('open', this.#onOpen);
    this.#socket.addEventListener('message', this.#onMessage);
    this.#socket.addEventListener('close', this.#onClose);
    this.#socket.addEventListener('error', this.#onError);
    this.#connectTimer = setTimeout(
      () => this.#failed('Runtime WebSocket connection deadline exceeded.'),
      options.connectDeadlineMs,
    );
    if (this.#socket.readyState === WEB_SOCKET_OPEN) this.#opened();
    else if (this.#socket.readyState !== WEB_SOCKET_CONNECTING) {
      this.#failed('Runtime WebSocket was not connecting.');
    }
  }

  async waitForOpen(): Promise<void> {
    try {
      await this.#openPromise;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async send(message: RuntimeProtocolMessage): Promise<void> {
    if (this.#failure || this.#closed) throw this.#connectionError();
    const decoded = safeDecodeRuntimeProtocolMessage(message);
    if (!decoded.success)
      throw new TypeError('Runtime WebSocket refused an invalid protocol message.');
    const frame = JSON.stringify(decoded.data);
    await this.#waitForWritableSocket();
    try {
      this.#socket.send(frame);
    } catch {
      this.#failed('Runtime WebSocket send failed.');
      throw this.#connectionError();
    }
    await this.#waitForWritableSocket();
  }

  messages(): AsyncIterable<unknown> {
    return this.#queue.iterable();
  }

  async close(reason = 'runtime_client_closed'): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearConnectTimer();
    this.#removeListeners();
    this.#queue.close();
    if (this.#socket.readyState < WEB_SOCKET_CLOSING) {
      try {
        this.#socket.close(1000, reason);
      } catch {
        // Closing is best-effort. No raw socket failure is surfaced or logged.
      }
    }
  }

  #opened(): void {
    if (this.#closed || this.#failure) return;
    this.#clearConnectTimer();
    this.#resolveOpen();
  }

  #received(event: BrowserWebSocketEvent): void {
    if (this.#closed || this.#failure) return;
    if (typeof event.data !== 'string') {
      this.#failed('Runtime WebSocket received a binary frame.', 1003);
      return;
    }
    if (new TextEncoder().encode(event.data).byteLength > RUNTIME_PROTOCOL_LIMITS.maxMessageBytes) {
      this.#failed('Runtime WebSocket received an oversized frame.', 1009);
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(event.data) as unknown;
    } catch {
      this.#failed('Runtime WebSocket received malformed JSON.', 1002);
      return;
    }
    if (!this.#queue.push(value)) {
      this.#failed('Runtime WebSocket receive queue exceeded its bound.', 1013);
    }
  }

  #failed(message: string, closeCode = 1011): void {
    if (this.#failure || this.#closed) return;
    this.#failure = new Error(message);
    this.#clearConnectTimer();
    this.#removeListeners();
    this.#queue.fail(this.#failure);
    this.#rejectOpen(this.#failure);
    if (this.#socket.readyState < WEB_SOCKET_CLOSING) {
      try {
        this.#socket.close(closeCode, 'runtime_websocket_failed');
      } catch {
        // The connection is already failed; socket close is best-effort.
      }
    }
  }

  async #waitForWritableSocket(): Promise<void> {
    const deadline = Date.now() + this.#sendDeadlineMs;
    while (true) {
      if (this.#failure || this.#closed || this.#socket.readyState !== WEB_SOCKET_OPEN) {
        throw this.#connectionError();
      }
      if (this.#socket.bufferedAmount <= this.#maxBufferedAmount) return;
      if (Date.now() >= deadline) {
        this.#failed('Runtime WebSocket send deadline exceeded.', 1013);
        throw this.#connectionError();
      }
      await delay(Math.min(BACKPRESSURE_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
    }
  }

  #connectionError(): Error {
    return this.#failure ?? new Error('Runtime WebSocket connection is closed.');
  }

  #clearConnectTimer(): void {
    if (this.#connectTimer === undefined) return;
    clearTimeout(this.#connectTimer);
    this.#connectTimer = undefined;
  }

  #removeListeners(): void {
    this.#socket.removeEventListener('open', this.#onOpen);
    this.#socket.removeEventListener('message', this.#onMessage);
    this.#socket.removeEventListener('close', this.#onClose);
    this.#socket.removeEventListener('error', this.#onError);
  }
}

function assertWebSocketUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('WebSocket URL is invalid.');
  }
  if (
    (url.protocol !== 'ws:' && url.protocol !== 'wss:') ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new TypeError('WebSocket URL must not contain credentials, query, or fragment data.');
  }
}

class BoundedMessageQueue {
  readonly #items: unknown[] = [];
  readonly #waiters = new Set<{
    resolve: (result: IteratorResult<unknown>) => void;
    reject: (reason: Error) => void;
  }>();
  readonly #maximum: number;
  #closed = false;
  #failure: Error | undefined;

  constructor(maximum: number) {
    this.#maximum = maximum;
  }

  push(value: unknown): boolean {
    if (this.#closed || this.#failure) return false;
    const waiter = this.#waiters.values().next().value;
    if (waiter) {
      this.#waiters.delete(waiter);
      waiter.resolve({ done: false, value });
      return true;
    }
    if (this.#items.length >= this.#maximum) return false;
    this.#items.push(value);
    return true;
  }

  close(): void {
    if (this.#closed || this.#failure) return;
    this.#closed = true;
    this.#items.length = 0;
    for (const waiter of this.#waiters) waiter.resolve({ done: true, value: undefined });
    this.#waiters.clear();
  }

  fail(error: Error): void {
    if (this.#closed || this.#failure) return;
    this.#failure = error;
    this.#items.length = 0;
    for (const waiter of this.#waiters) waiter.reject(error);
    this.#waiters.clear();
  }

  iterable(): AsyncIterable<unknown> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<unknown>> => {
          const item = this.#items.shift();
          if (item !== undefined) return Promise.resolve({ done: false, value: item });
          if (this.#failure) return Promise.reject(this.#failure);
          if (this.#closed) return Promise.resolve({ done: true, value: undefined });
          return new Promise<IteratorResult<unknown>>((resolve, reject) => {
            this.#waiters.add({ resolve, reject });
          });
        },
        return: async (): Promise<IteratorResult<unknown>> => {
          this.close();
          return { done: true, value: undefined };
        },
      }),
    };
  }
}

function defaultWebSocketFactory(url: string): RuntimeWebSocketLike {
  return new WebSocket(url) as unknown as RuntimeWebSocketLike;
}

function positiveSafeInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return resolved;
}

function nonNegativeSafeInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer.`);
  }
  return resolved;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
