import {
  WEB_DIRECTORY_RESPONSE_SCHEMA_,
  WEB_DISCONNECT_RESPONSE_SCHEMA_,
  WEB_HISTORY_RESPONSE_SCHEMA_,
  WEB_LIVE_EVENT_SCHEMA_,
  WEB_STREAM_EVENT_SCHEMA_,
  WEB_SUBSCRIBE_RESPONSE_SCHEMA_,
  WEB_TAB_CREATE_RESPONSE_SCHEMA_,
  type WebBootstrapRequest,
  type WebBootstrapResponse,
  type WebDirectoryRequest,
  type WebDirectoryResponse,
  type WebDisconnectRequest,
  type WebDisconnectResponse,
  type WebGatewayObserverClient,
  type WebHistoryRequest,
  type WebHistoryResponse,
  type WebObserverStreamEvent,
  type WebResyncReason,
  type WebSubscribeRequest,
  type WebSubscribeResponse,
  type WebTabCreateRequest,
  type WebTabCreateResponse,
  type WebUnavailableReason,
  type WebUnsubscribeRequest,
  type WebUnsubscribeResponse,
  webBootstrapRequestCodec,
  webBootstrapResponseCodec,
  webDirectoryRequestCodec,
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
import type { RuntimeClientEvent } from '@kite-ai/runtime-contract';
import {
  createWebPresentationReducerState,
  reduceWebPresentationEvent,
  reduceWebPresentationSequence,
  type WebPresentationState,
} from './presentation';

/** Path-free owner-supplied Workspace grouping for the Web left rail. */
export interface WebObserverDirectoryPort {
  list: () => Promise<readonly WebDirectoryEntry[]> | readonly WebDirectoryEntry[];
}

/** Alias retained for adapters that name the port after its boundary. */
export type WebDirectoryPort = WebObserverDirectoryPort;

export type WebDirectoryEntry = WebDirectoryResponse['workspaces'][number];

/**
 * Current-format presentation stream input.  The port is intentionally fed
 * RuntimeClientEvent rather than raw RuntimeEvent, RuntimeNotification, or a
 * Runtime command object.
 */
export interface WebObserverLiveInput {
  readonly sessionId: string;
  readonly sequence: number;
  readonly event: RuntimeClientEvent;
}

export interface WebObserverLivePort {
  subscribe: (input: {
    readonly sessionId: string;
    readonly afterSequence?: number;
    readonly signal: AbortSignal;
  }) => AsyncIterable<WebObserverLiveInput>;
}

export interface WebObserverHistoryRecord {
  readonly sequence: number;
  readonly events: readonly RuntimeClientEvent[];
}

export interface WebObserverHistoryTranscript {
  readonly sessionId: string;
  readonly lastSequence: number;
  readonly records: readonly WebObserverHistoryRecord[];
}

/** Current-format, query-only and already client-safe durable presentation. */
export interface WebObserverHistoryPort {
  loadSession(sessionId: string): Promise<WebObserverHistoryTranscript>;
}

export interface WebObserverCoreOptions {
  readonly directory: WebObserverDirectoryPort;
  /** Must be the current-format, query-only RuntimeHistoryClient. */
  readonly history: WebObserverHistoryPort;
  readonly live: WebObserverLivePort;
  readonly gatewayInstanceId: string;
  readonly contractRevision: string;
  /** Native/Gateway adapters may provide an opaque, browser-safe tab handle. */
  readonly createTabHandle?: () => string;
  /** Gateway-owned identity; both fields must be returned without inference. */
  readonly createTabBinding?: () => {
    readonly tabHandle: string;
    readonly connectionGeneration: number;
  };
  readonly maxQueuedEvents?: number;
  readonly maxQueuedBytes?: number;
}

export interface WebObserverCore extends WebGatewayObserverClient {
  /** Consume the presentation stream associated with a prior subscribe call. */
  readonly subscriptionEvents: (subscriptionId: string) => AsyncIterable<WebObserverStreamEvent>;
  /** Short alias for stream adapters. */
  readonly events: (subscriptionId: string) => AsyncIterable<WebObserverStreamEvent>;
}

export class WebObserverUnavailableError extends Error {
  readonly event: Extract<WebObserverStreamEvent, { readonly type: 'unavailable' }>;

  constructor(sessionId: string, reason: WebUnavailableReason) {
    super('Web Observer is unavailable.');
    this.name = 'WebObserverUnavailableError';
    this.event = {
      schema: WEB_STREAM_EVENT_SCHEMA_,
      type: 'unavailable',
      sessionId: safeIdentifier(sessionId, 'unavailable'),
      reason,
    };
  }
}

export class WebObserverResyncRequiredError extends Error {
  readonly event: Extract<WebObserverStreamEvent, { readonly type: 'resync_required' }>;

  constructor(sessionId: string, reason: WebResyncReason, afterSequence?: number) {
    super('Web Observer requires a fresh History read.');
    this.name = 'WebObserverResyncRequiredError';
    this.event = {
      schema: WEB_STREAM_EVENT_SCHEMA_,
      type: 'resync_required',
      sessionId: safeIdentifier(sessionId, 'resync'),
      reason,
      ...(afterSequence === undefined ? {} : { afterSequence }),
    };
  }
}

const DEFAULT_MAX_QUEUED_EVENTS = 256;
const DEFAULT_MAX_QUEUED_BYTES = 1_048_576;
const DIRECTORY_UNAVAILABLE_SESSION = 'directory';

/**
 * Build the in-process Observer core.  This object only reads injected
 * Directory/History/presentation-stream ports and cannot dispatch a Runtime
 * command.  It is suitable for a private loopback Gateway adapter.
 */
export function createWebObserverCore(options: WebObserverCoreOptions): WebObserverCore {
  const maxQueuedEvents = boundedOption(
    options.maxQueuedEvents,
    DEFAULT_MAX_QUEUED_EVENTS,
    'maxQueuedEvents',
  );
  const maxQueuedBytes = boundedOption(
    options.maxQueuedBytes,
    DEFAULT_MAX_QUEUED_BYTES,
    'maxQueuedBytes',
  );
  const state = new ObserverCoreState(options, maxQueuedEvents, maxQueuedBytes);
  return state.client;
}

class ObserverCoreState {
  readonly #options: WebObserverCoreOptions;
  readonly #maxQueuedEvents: number;
  readonly #maxQueuedBytes: number;
  readonly #subscriptions = new Map<string, ObserverSubscription>();
  readonly #tabHandleFactory: () => string;
  #nextSubscription = 0;
  #nextTab = 0;
  #connectionGeneration = 0;
  #closed = false;
  readonly client: WebObserverCore;

  constructor(options: WebObserverCoreOptions, maxQueuedEvents: number, maxQueuedBytes: number) {
    this.#options = options;
    this.#maxQueuedEvents = maxQueuedEvents;
    this.#maxQueuedBytes = maxQueuedBytes;
    this.#tabHandleFactory = options.createTabHandle ?? (() => `tab-${++this.#nextTab}`);
    this.client = {
      bootstrap: (request) => this.bootstrap(request),
      createTab: (request) => this.createTab(request),
      listDirectory: (request) => this.listDirectory(request),
      loadHistory: (request) => this.loadHistory(request),
      subscribe: (request) => this.subscribe(request),
      unsubscribe: (request) => this.unsubscribe(request),
      disconnect: (request) => this.disconnect(request),
      subscriptionEvents: (subscriptionId) => this.subscriptionEvents(subscriptionId),
      events: (subscriptionId) => this.subscriptionEvents(subscriptionId),
    };
  }

  async bootstrap(request: WebBootstrapRequest): Promise<WebBootstrapResponse> {
    webBootstrapRequestCodec.decode(request);
    this.ensureOpen(DIRECTORY_UNAVAILABLE_SESSION);
    return canonical(webBootstrapResponseCodec, {
      schema: 'kite.app.web.bootstrap-response.v1',
      gatewayInstanceId: this.#options.gatewayInstanceId,
      contractRevision: this.#options.contractRevision,
    });
  }

  async createTab(request: WebTabCreateRequest): Promise<WebTabCreateResponse> {
    webTabCreateRequestCodec.decode(request);
    this.ensureOpen(DIRECTORY_UNAVAILABLE_SESSION);
    const binding = this.#options.createTabBinding?.();
    if (binding !== undefined) {
      return canonical(webTabCreateResponseCodec, {
        schema: WEB_TAB_CREATE_RESPONSE_SCHEMA_,
        tabHandle: binding.tabHandle,
        connectionGeneration: binding.connectionGeneration,
      });
    }
    this.#connectionGeneration += 1;
    return canonical(webTabCreateResponseCodec, {
      schema: WEB_TAB_CREATE_RESPONSE_SCHEMA_,
      tabHandle: this.#tabHandleFactory(),
      connectionGeneration: this.#connectionGeneration,
    });
  }

  async listDirectory(request: WebDirectoryRequest): Promise<WebDirectoryResponse> {
    webDirectoryRequestCodec.decode(request);
    this.ensureOpen(DIRECTORY_UNAVAILABLE_SESSION);
    let workspaces: readonly WebDirectoryEntry[];
    try {
      workspaces = await this.#options.directory.list();
    } catch {
      throw new WebObserverUnavailableError(DIRECTORY_UNAVAILABLE_SESSION, 'worker_unavailable');
    }
    // Encoding performs an exact round-trip validation.  In particular, a
    // Directory owner cannot smuggle a canonical path or extra field through
    // this boundary.
    return canonical(webDirectoryResponseCodec, {
      schema: WEB_DIRECTORY_RESPONSE_SCHEMA_,
      workspaces,
    });
  }

  async loadHistory(request: WebHistoryRequest): Promise<WebHistoryResponse> {
    const decoded = webHistoryRequestCodec.decode(request);
    this.ensureOpen(decoded.sessionId);
    let transcript: WebObserverHistoryTranscript;
    try {
      transcript = await this.#options.history.loadSession(decoded.sessionId);
    } catch {
      // Legacy discovery/import is deliberately not present in the injected
      // current-format client.  Missing legacy-only Sessions are unavailable,
      // never silently imported by a Web Observer read.
      throw new WebObserverUnavailableError(decoded.sessionId, 'history_unavailable');
    }
    if (transcript.sessionId !== decoded.sessionId) {
      throw new WebObserverUnavailableError(decoded.sessionId, 'session_unavailable');
    }

    const state = reduceHistory(transcript.records);
    const observedLastSequence = Math.max(transcript.lastSequence, state.lastSequence ?? 0);
    const messages = state.messages.filter(
      (message) => decoded.cursor === undefined || message.sequence > decoded.cursor,
    );
    const selected = messages.slice(0, decoded.limit);
    const hasMore = messages.length > selected.length;
    const last = selected.at(-1);
    return canonical(webHistoryResponseCodec, {
      schema: WEB_HISTORY_RESPONSE_SCHEMA_,
      sessionId: decoded.sessionId,
      messages: selected,
      ...(hasMore && last ? { nextCursor: last.sequence } : {}),
      hasMore,
      observedLastSequence,
    });
  }

  async subscribe(request: WebSubscribeRequest): Promise<WebSubscribeResponse> {
    const decoded = webSubscribeRequestCodec.decode(request);
    this.ensureOpen(decoded.sessionId);
    let initialState = createWebPresentationReducerState(decoded.afterSequence ?? null);
    if (decoded.afterSequence !== undefined) {
      let transcript: WebObserverHistoryTranscript;
      try {
        transcript = await this.#options.history.loadSession(decoded.sessionId);
      } catch {
        throw new WebObserverUnavailableError(decoded.sessionId, 'history_unavailable');
      }
      if (
        transcript.sessionId !== decoded.sessionId ||
        transcript.lastSequence < decoded.afterSequence
      ) {
        throw new WebObserverResyncRequiredError(
          decoded.sessionId,
          'history_changed',
          decoded.afterSequence,
        );
      }
      initialState = reduceHistory(
        transcript.records.filter((record) => record.sequence <= decoded.afterSequence!),
        decoded.afterSequence === 0 ? 0 : null,
      );
      if (initialState.lastSequence !== decoded.afterSequence) {
        throw new WebObserverResyncRequiredError(
          decoded.sessionId,
          'history_changed',
          initialState.lastSequence ?? undefined,
        );
      }
    }
    const subscriptionId = `subscription-${++this.#nextSubscription}`;
    const controller = new AbortController();
    let source: AsyncIterable<WebObserverLiveInput>;
    try {
      source = this.#options.live.subscribe({
        sessionId: decoded.sessionId,
        ...(decoded.afterSequence === undefined ? {} : { afterSequence: decoded.afterSequence }),
        signal: controller.signal,
      });
    } catch {
      controller.abort();
      throw new WebObserverUnavailableError(decoded.sessionId, 'worker_unavailable');
    }
    let iterator: AsyncIterator<WebObserverLiveInput>;
    try {
      iterator = source[Symbol.asyncIterator]();
    } catch {
      controller.abort();
      throw new WebObserverUnavailableError(decoded.sessionId, 'subscription_unavailable');
    }
    const subscription = new ObserverSubscription(
      subscriptionId,
      decoded.sessionId,
      initialState,
      iterator,
      controller,
      new BoundedEventQueue<WebObserverStreamEvent>(this.#maxQueuedEvents, this.#maxQueuedBytes),
      this,
    );
    this.#subscriptions.set(subscriptionId, subscription);
    void this.pump(subscription);
    return canonical(webSubscribeResponseCodec, {
      schema: WEB_SUBSCRIBE_RESPONSE_SCHEMA_,
      subscriptionId,
      sessionId: decoded.sessionId,
      liveSequence: decoded.afterSequence ?? null,
    });
  }

  async unsubscribe(request: WebUnsubscribeRequest): Promise<WebUnsubscribeResponse> {
    const decoded = webUnsubscribeRequestCodec.decode(request);
    const subscription = this.#subscriptions.get(decoded.subscriptionId);
    if (subscription === undefined) {
      return canonical(webUnsubscribeResponseCodec, {
        schema: 'kite.app.web.unsubscribe-response.v1',
        subscriptionId: decoded.subscriptionId,
        unsubscribed: false,
      });
    }
    await this.terminate(subscription);
    this.#subscriptions.delete(decoded.subscriptionId);
    return canonical(webUnsubscribeResponseCodec, {
      schema: 'kite.app.web.unsubscribe-response.v1',
      subscriptionId: decoded.subscriptionId,
      unsubscribed: true,
    });
  }

  async disconnect(request: WebDisconnectRequest): Promise<WebDisconnectResponse> {
    webDisconnectRequestCodec.decode(request);
    if (this.#closed) {
      return canonical(webDisconnectResponseCodec, {
        schema: WEB_DISCONNECT_RESPONSE_SCHEMA_,
        disconnected: true,
      });
    }
    this.#closed = true;
    await Promise.all(
      [...this.#subscriptions.values()].map((subscription) => this.terminate(subscription)),
    );
    this.#subscriptions.clear();
    return canonical(webDisconnectResponseCodec, {
      schema: WEB_DISCONNECT_RESPONSE_SCHEMA_,
      disconnected: true,
    });
  }

  subscriptionEvents(subscriptionId: string): AsyncIterable<WebObserverStreamEvent> {
    const subscription = this.#subscriptions.get(subscriptionId);
    if (subscription === undefined) {
      throw new WebObserverUnavailableError('subscription', 'subscription_unavailable');
    }
    return subscription.events();
  }

  async pump(subscription: ObserverSubscription): Promise<void> {
    try {
      for (;;) {
        if (subscription.stopped) return;
        const next = await subscription.iterator.next();
        if (subscription.stopped) return;
        if (next.done) {
          await subscription.finishNormally();
          return;
        }
        const input = next.value;
        if (input === undefined) {
          await this.terminate(
            subscription,
            unavailableEvent(subscription.sessionId, 'subscription_unavailable'),
          );
          return;
        }
        if (input.sessionId !== subscription.sessionId) {
          await this.terminate(
            subscription,
            unavailableEvent(subscription.sessionId, 'subscription_unavailable'),
          );
          return;
        }
        const result = reduceWebPresentationEvent(subscription.state, {
          sequence: input.sequence,
          event: input.event,
        });
        if (result.status === 'resync_required') {
          await this.terminate(
            subscription,
            resyncEvent(subscription.sessionId, 'sequence_gap', result.afterSequence),
          );
          return;
        }
        subscription.state = result.state;
        if (result.status === 'ignored' || result.message === undefined) continue;
        const streamEvent = canonical(webObserverStreamEventCodec, {
          schema: WEB_LIVE_EVENT_SCHEMA_,
          type: 'message',
          sessionId: subscription.sessionId,
          sequence: input.sequence,
          message: result.message,
        });
        const size = encodedSize(streamEvent);
        if (!subscription.queue.push(streamEvent, size)) {
          await this.terminate(
            subscription,
            resyncEvent(
              subscription.sessionId,
              'stream_overflow',
              subscription.state.lastSequence ?? undefined,
            ),
          );
          return;
        }
      }
    } catch {
      if (!subscription.stopped) {
        await this.terminate(
          subscription,
          unavailableEvent(subscription.sessionId, 'subscription_unavailable'),
        );
      }
    }
  }

  async terminate(
    subscription: ObserverSubscription,
    terminal?: WebObserverStreamEvent,
  ): Promise<void> {
    if (subscription.stopped) return;
    subscription.stopped = true;
    if (terminal === undefined) subscription.queue.clear();
    else if (!subscription.queue.push(terminal, encodedSize(terminal))) {
      // Overflow cannot preserve the already-buffered presentation stream;
      // replace it with the typed recovery signal so the browser can reload.
      subscription.queue.replace(terminal, encodedSize(terminal));
    }
    await subscription.release();
    subscription.queue.finish();
  }

  ensureOpen(sessionId: string): void {
    if (this.#closed) throw new WebObserverUnavailableError(sessionId, 'gateway_draining');
  }

  retire(subscription: ObserverSubscription): void {
    if (this.#subscriptions.get(subscription.id) === subscription) {
      this.#subscriptions.delete(subscription.id);
    }
  }
}

class ObserverSubscription {
  readonly id: string;
  readonly sessionId: string;
  readonly iterator: AsyncIterator<WebObserverLiveInput>;
  readonly controller: AbortController;
  readonly queue: BoundedEventQueue<WebObserverStreamEvent>;
  readonly #owner: ObserverCoreState;
  state: WebPresentationState;
  stopped = false;
  #releasePromise: Promise<void> | undefined;

  constructor(
    id: string,
    sessionId: string,
    initialState: WebPresentationState,
    iterator: AsyncIterator<WebObserverLiveInput>,
    controller: AbortController,
    queue: BoundedEventQueue<WebObserverStreamEvent>,
    owner: ObserverCoreState,
  ) {
    this.id = id;
    this.sessionId = sessionId;
    this.iterator = iterator;
    this.controller = controller;
    this.queue = queue;
    this.#owner = owner;
    this.state = initialState;
  }

  events(): AsyncIterable<WebObserverStreamEvent> {
    return {
      [Symbol.asyncIterator]: () => {
        const iterator = this.queue[Symbol.asyncIterator]();
        return {
          next: async () => {
            const result = await iterator.next();
            if (result.done) this.#owner.retire(this);
            return result;
          },
          return: async () => {
            await this.#owner.terminate(this);
            this.#owner.retire(this);
            return { done: true, value: undefined } as const;
          },
        };
      },
    };
  }

  async release(): Promise<void> {
    if (this.#releasePromise !== undefined) return this.#releasePromise;
    this.#releasePromise = (async () => {
      this.controller.abort();
      try {
        await this.iterator.return?.();
      } catch {
        // A release is best effort; no Runtime error is exposed to the Web.
      }
    })();
    return this.#releasePromise;
  }

  async finishNormally(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.release();
    this.queue.finish();
  }
}

class BoundedEventQueue<Value> implements AsyncIterable<Value> {
  readonly #maxEvents: number;
  readonly #maxBytes: number;
  readonly #items: Array<{ readonly value: Value; readonly bytes: number }> = [];
  readonly #waiters: Array<(result: IteratorResult<Value>) => void> = [];
  #bytes = 0;
  #closed = false;

  constructor(maxEvents: number, maxBytes: number) {
    this.#maxEvents = maxEvents;
    this.#maxBytes = maxBytes;
  }

  push(value: Value, bytes: number): boolean {
    if (this.#closed || bytes > this.#maxBytes) return false;
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter({ done: false, value });
      return true;
    }
    if (this.#items.length >= this.#maxEvents || this.#bytes + bytes > this.#maxBytes) {
      return false;
    }
    this.#items.push({ value, bytes });
    this.#bytes += bytes;
    return true;
  }

  replace(value: Value, bytes: number): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      this.clear();
      waiter({ done: false, value });
      return;
    }
    this.#items.splice(0, this.#items.length, { value, bytes });
    this.#bytes = bytes;
  }

  clear(): void {
    this.#items.length = 0;
    this.#bytes = 0;
  }

  finish(): void {
    if (this.#closed) return;
    this.#closed = true;
    while (this.#waiters.length > 0 && this.#items.length === 0) {
      this.#waiters.shift()?.({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<Value> {
    return {
      next: () => this.next(),
      return: async () => {
        this.clear();
        this.finish();
        return { done: true, value: undefined } as const;
      },
    };
  }

  async next(): Promise<IteratorResult<Value>> {
    const item = this.#items.shift();
    if (item !== undefined) {
      this.#bytes -= item.bytes;
      return { done: false, value: item.value };
    }
    if (this.#closed) return { done: true, value: undefined };
    return new Promise<IteratorResult<Value>>((resolve) => this.#waiters.push(resolve));
  }
}

function reduceHistory(
  records: readonly WebObserverHistoryRecord[],
  initialSequence: number | null = null,
): WebPresentationState {
  let state = createWebPresentationReducerState(initialSequence);
  for (const record of records) {
    if (!Number.isSafeInteger(record.sequence)) {
      throw new WebObserverResyncRequiredError(
        'history',
        'history_changed',
        state.lastSequence ?? undefined,
      );
    }
    const result = reduceWebPresentationSequence(state, record.sequence, record.events);
    if (result.status === 'resync_required') {
      throw new WebObserverResyncRequiredError('history', result.reason, result.afterSequence);
    }
    state = result.state;
  }
  return state;
}

function unavailableEvent(
  sessionId: string,
  reason: WebUnavailableReason,
): Extract<WebObserverStreamEvent, { readonly type: 'unavailable' }> {
  return {
    schema: WEB_STREAM_EVENT_SCHEMA_,
    type: 'unavailable',
    sessionId: safeIdentifier(sessionId, 'unavailable'),
    reason,
  };
}

function resyncEvent(
  sessionId: string,
  reason: WebResyncReason,
  afterSequence?: number,
): Extract<WebObserverStreamEvent, { readonly type: 'resync_required' }> {
  return {
    schema: WEB_STREAM_EVENT_SCHEMA_,
    type: 'resync_required',
    sessionId: safeIdentifier(sessionId, 'resync'),
    reason,
    ...(afterSequence === undefined ? {} : { afterSequence }),
  };
}

function canonical<Value>(
  codec: { encode: (value: Value) => Record<string, unknown>; decode: (input: unknown) => Value },
  value: Value,
): Value {
  return codec.decode(codec.encode(value));
}

function encodedSize(value: WebObserverStreamEvent): number {
  return JSON.stringify(webObserverStreamEventCodec.encode(value)).length;
}

function safeIdentifier(value: string, fallback: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._:-]/gu, '_').slice(0, 256);
  return normalized.length > 0 && /^[A-Za-z0-9]/u.test(normalized) ? normalized : fallback;
}

function boundedOption(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${label} must be positive.`);
  return value;
}
