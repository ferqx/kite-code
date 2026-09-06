import type {
  RuntimeAccessNotification,
  RuntimeClientEvent,
  RuntimeCommand,
  RuntimeCommandReceipt,
  RuntimeNotification,
  RuntimeQuery,
  RuntimeQueryResult,
  RuntimeSessionProjection,
  RuntimeSubscription,
  RuntimeSubscriptionSpec,
} from '@kite-ai/runtime-contract';
import {
  type AcceptedPresentationEnvelope,
  assertAcceptedPresentationEnvelope,
} from '@kite-ai/runtime-contract';
import {
  type InitializeResult,
  mapRuntimeCommandToProtocol,
  mapRuntimeQueryToProtocol,
  RUNTIME_PROTOCOL_VERSION,
  type RuntimeProtocolAppMethod,
  type RuntimeProtocolError,
  type RuntimeProtocolMessage,
  type RuntimeProtocolMethod,
  type RuntimeProtocolResult,
  type RuntimeSubscriptionMessage,
  safeDecodeRuntimeProtocolMessage,
} from '@kite-ai/runtime-protocol';
import type {
  RuntimeClientConnection,
  RuntimeClientTransport,
  RuntimeHistoryClient,
} from './index';
import { type RuntimeClientConnectionStatus, RuntimeSnapshotStore } from './store';

export interface RuntimeClientInfo {
  readonly name: string;
  readonly version: string;
  readonly instanceId: string;
}

export interface RuntimeClientOptions {
  readonly transport: RuntimeClientTransport;
  readonly clientInfo: RuntimeClientInfo;
  readonly snapshotStore?: RuntimeSnapshotStore;
  /** App-injected exact, client-safe durable history reader. */
  readonly history?: RuntimeHistoryClient | 'protocol';
  /** Exact peer identity/capability check used by same-build App Server clients. */
  readonly expectedServer?: Readonly<{
    version: string;
    requiredMethods?: readonly RuntimeProtocolMethod[];
  }>;
}

export interface RuntimeClientSubscription {
  readonly id: string;
  readonly spec: RuntimeSubscriptionSpec;
  readonly generation: number;
  unsubscribe(): Promise<boolean>;
}

export class RuntimeClientError extends Error {
  readonly code:
    | 'connection_closed'
    | 'connection_failed'
    | 'protocol_error'
    | 'server_mismatch'
    | 'unsupported_command'
    | 'unsupported_query';
  readonly protocol?: RuntimeProtocolError;

  constructor(code: RuntimeClientError['code'], message: string, protocol?: RuntimeProtocolError) {
    super(message);
    this.name = 'RuntimeClientError';
    this.code = code;
    this.protocol = protocol;
  }
}

interface PendingRequest {
  readonly generation: number;
  readonly resolve: (result: RuntimeProtocolResult) => void;
  readonly reject: (reason: RuntimeClientError) => void;
  /** Subscribe ack binding must happen in the receive turn before its first notification. */
  readonly subscriptionState?: SubscriptionState;
}

interface SubscriptionState {
  readonly id: string;
  readonly spec: RuntimeSubscriptionSpec;
  readonly queue: RuntimeNotificationQueue;
  readonly signal?: AbortSignal;
  readonly ready?: Readonly<{
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: RuntimeClientError) => void;
  }>;
  remoteId?: string;
  remoteGeneration?: number;
  /** Local connection generation that owns the remote subscription identity. */
  connectionGeneration?: number;
  resyncing?: boolean;
  onAbort?: () => void;
}

/**
 * One RuntimeAccess notification together with the local connection
 * generation that accepted it.  The generation is captured when the
 * notification enters the client queue; consumers must not substitute the
 * current generation later, because a reconnect may have happened while the
 * consumer was suspended.
 */
export interface RuntimeClientNotificationWithGeneration {
  readonly notification: RuntimeAccessNotification;
  readonly connectionGeneration: number;
}

/**
 * Browser-safe Protocol client. Reconnect is explicit and only restores
 * subscriptions; mutations are never replayed automatically.
 */
export class RuntimeClient implements AsyncDisposable {
  readonly #transport: RuntimeClientTransport;
  readonly #clientInfo: RuntimeClientInfo;
  readonly #store: RuntimeSnapshotStore;
  readonly #history: RuntimeHistoryClient | undefined;
  readonly #expectedServer: RuntimeClientOptions['expectedServer'];
  readonly #pending = new Map<string, PendingRequest>();
  readonly #subscriptions = new Map<string, SubscriptionState>();
  #connection: RuntimeClientConnection | undefined;
  #connectionGeneration = 0;
  #nextRequest = 0;
  #nextSubscription = 0;
  #connectPromise: Promise<void> | undefined;
  #closed = false;

  constructor(options: RuntimeClientOptions) {
    this.#transport = options.transport;
    this.#clientInfo = options.clientInfo;
    this.#store = options.snapshotStore ?? new RuntimeSnapshotStore();
    this.#expectedServer = options.expectedServer;
    this.#history =
      options.history === 'protocol'
        ? Object.freeze({
            listSessions: async (request) => {
              const result = await this.#request('history/list_sessions', { request });
              if (!('entries' in result) || 'observedLastSequence' in result) {
                throw new RuntimeClientError(
                  'protocol_error',
                  'Protocol returned invalid History.',
                );
              }
              return result;
            },
            listEvents: async (request) => {
              const result = await this.#request('history/list_events', { request });
              if (!('entries' in result) || !('observedLastSequence' in result)) {
                throw new RuntimeClientError(
                  'protocol_error',
                  'Protocol returned invalid History.',
                );
              }
              return result;
            },
            loadSession: async (sessionId) => {
              const result = await this.#request('history/load_session', { sessionId });
              if (!('records' in result) || !('events' in result)) {
                throw new RuntimeClientError(
                  'protocol_error',
                  'Protocol returned invalid History.',
                );
              }
              return result;
            },
          } satisfies RuntimeHistoryClient)
        : options.history;
  }

  get snapshotStore(): RuntimeSnapshotStore {
    return this.#store;
  }

  get history(): RuntimeHistoryClient | undefined {
    return this.#history;
  }

  get connectionGeneration(): number {
    return this.#connectionGeneration;
  }

  async connect(): Promise<void> {
    if (this.#closed) throw closedError();
    if (this.#connection) return;
    this.#connectPromise ??= this.#open('connecting', false);
    try {
      await this.#connectPromise;
    } finally {
      this.#connectPromise = undefined;
    }
  }

  /** Explicit reconnect: subscriptions are restored, but commands are not replayed. */
  async reconnect(): Promise<void> {
    if (this.#closed) throw closedError();
    if (this.#connectPromise) return this.#connectPromise;
    this.#connectPromise = this.#open('reconnecting', true);
    try {
      await this.#connectPromise;
    } finally {
      this.#connectPromise = undefined;
    }
  }

  async command(command: RuntimeCommand): Promise<RuntimeCommandReceipt> {
    const wire = mapRuntimeCommandToProtocol(command);
    if (!wire) {
      throw new RuntimeClientError(
        'unsupported_command',
        `Runtime command is not available in Protocol V2: ${command.type}`,
      );
    }
    const result = await this.#request('runtime/command', { command: wire });
    if (!isCommandReceipt(result)) {
      throw new RuntimeClientError('protocol_error', 'Protocol returned a non-command result.');
    }
    return result;
  }

  async query(query: RuntimeQuery): Promise<RuntimeQueryResult> {
    const wire = mapRuntimeQueryToProtocol(query);
    if (!wire) {
      throw new RuntimeClientError(
        'unsupported_query',
        `Runtime query is not available in Protocol V2: ${query.type}`,
      );
    }
    const result = await this.#request('runtime/query', { query: wire });
    if (!isQueryResult(result)) {
      throw new RuntimeClientError('protocol_error', 'Protocol returned a non-query result.');
    }
    return result;
  }

  /** Native App connector seam; semantic request/response codecs remain owned above this package. */
  async requestApp(
    method: RuntimeProtocolAppMethod,
    request: Readonly<Record<string, unknown>>,
  ): Promise<Readonly<Record<string, unknown>>> {
    const result = await this.#request(method, { request });
    if (
      !('method' in result) ||
      result.method !== method ||
      !('response' in result) ||
      !isPlainRecord(result.response)
    ) {
      throw new RuntimeClientError(
        'protocol_error',
        'Protocol returned an invalid App Control result.',
      );
    }
    return result.response;
  }

  /** Explicit daemon lifecycle control over the initialized Runtime protocol connection. */
  async requestServerControl(
    method: import('@kite-ai/runtime-protocol').RuntimeProtocolServerControlMethod,
    request: Readonly<Record<string, unknown>>,
  ): Promise<Readonly<Record<string, unknown>>> {
    const result = await this.#request(method, { request });
    if (
      !('method' in result) ||
      result.method !== method ||
      !('response' in result) ||
      !isPlainRecord(result.response)
    ) {
      throw new RuntimeClientError('protocol_error', 'Protocol returned an invalid Server result.');
    }
    return result.response;
  }

  /** RuntimeAccess-compatible stream. Remote acquisition happens asynchronously. */
  subscribe(subscription: RuntimeSubscription): AsyncIterable<RuntimeAccessNotification> {
    const state = this.#createSubscription(subscription.spec, subscription.signal);
    void this.#activateSubscription(state).catch(() => this.#closeSubscription(state, false));
    return state.queue.iterable(() => {
      void this.#closeSubscription(state, true).catch(() => undefined);
    });
  }

  /**
   * Acquire a stream only after the remote initial watermark is ready. This
   * prevents a command from racing the Server's initial subscription phase
   * and losing live ephemeral notifications produced in that window.
   */
  async subscribeReady(
    subscription: RuntimeSubscription,
  ): Promise<AsyncIterable<RuntimeAccessNotification>> {
    const state = this.#createSubscription(subscription.spec, subscription.signal, true);
    try {
      await this.#activateSubscription(state);
      await state.ready!.promise;
      return state.queue.iterable(() => {
        void this.#closeSubscription(state, true).catch(() => undefined);
      });
    } catch (error) {
      await this.#closeSubscription(state, false);
      throw error;
    }
  }

  /**
   * Ready RuntimeAccess stream retaining the receipt-time connection
   * generation for every notification.  This is the stream for presentation
   * adapters that need both event-free authoritative snapshots and accepted
   * envelopes; the ordinary `subscribeReady()` API remains RuntimeAccess
   * compatible and intentionally strips this local transport metadata.
   */
  async subscribeReadyWithGeneration(
    subscription: RuntimeSubscription,
  ): Promise<AsyncIterable<RuntimeClientNotificationWithGeneration>> {
    const state = this.#createSubscription(subscription.spec, subscription.signal, true);
    try {
      await this.#activateSubscription(state);
      await state.ready!.promise;
      return state.queue.iterableWithGeneration(() => {
        void this.#closeSubscription(state, true).catch(() => undefined);
      });
    } catch (error) {
      await this.#closeSubscription(state, false);
      throw error;
    }
  }

  /** Optional lifecycle handle for consumers that need the remote subscription identity. */
  async subscribeHandle(spec: RuntimeSubscriptionSpec): Promise<RuntimeClientSubscription> {
    const state = this.#createSubscription(spec);
    try {
      await this.#activateSubscription(state);
    } catch (error) {
      await this.#closeSubscription(state, false);
      throw error;
    }
    return this.#subscriptionHandle(state);
  }

  async unsubscribe(subscriptionId: string): Promise<boolean> {
    const state = this.#subscriptions.get(subscriptionId);
    if (!state) return false;
    return this.#closeSubscription(state, true);
  }

  #createSubscription(
    spec: RuntimeSubscriptionSpec,
    signal?: AbortSignal,
    waitForReady = false,
  ): SubscriptionState {
    let ready: SubscriptionState['ready'];
    if (waitForReady) {
      let resolve!: () => void;
      let reject!: (error: RuntimeClientError) => void;
      const promise = new Promise<void>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      void promise.catch(() => undefined);
      ready = Object.freeze({ promise, resolve, reject });
    }
    const state: SubscriptionState = {
      id: `client-subscription-${++this.#nextSubscription}`,
      spec,
      queue: new RuntimeNotificationQueue(),
      signal,
      ...(ready ? { ready } : {}),
    };
    this.#subscriptions.set(state.id, state);
    const onAbort = (): void => {
      void this.#closeSubscription(state, true);
    };
    state.onAbort = onAbort;
    if (signal?.aborted) {
      void this.#closeSubscription(state, false);
    } else {
      signal?.addEventListener('abort', onAbort, { once: true });
    }
    return state;
  }

  async #closeSubscription(state: SubscriptionState, sendUnsubscribe: boolean): Promise<boolean> {
    if (!this.#subscriptions.delete(state.id)) return false;
    state.ready?.reject(closedError());
    state.queue.close();
    if (state.signal && state.onAbort) state.signal.removeEventListener('abort', state.onAbort);
    const remoteId = state.remoteId;
    const remoteConnectionGeneration = state.connectionGeneration;
    state.remoteId = undefined;
    state.remoteGeneration = undefined;
    state.connectionGeneration = undefined;
    if (
      !sendUnsubscribe ||
      !remoteId ||
      !this.#connection ||
      remoteConnectionGeneration !== this.#connectionGeneration
    )
      return true;
    const result = await this.#request('runtime/unsubscribe', { subscriptionId: remoteId });
    return isUnsubscribeResult(result) ? result.unsubscribed : false;
  }

  async close(reason = 'runtime_client_closed'): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#store.setConnection({ generation: this.#connectionGeneration, status: 'draining' });
    this.#rejectPending(this.#connectionGeneration, closedError());
    const connection = this.#connection;
    this.#connection = undefined;
    for (const state of this.#subscriptions.values()) {
      state.ready?.reject(closedError());
      state.remoteId = undefined;
      state.remoteGeneration = undefined;
      state.queue.close();
    }
    try {
      await connection?.close(reason);
    } finally {
      this.#store.dispose();
    }
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  async #open(
    status: Extract<RuntimeClientConnectionStatus, 'connecting' | 'reconnecting'>,
    resubscribe: boolean,
  ): Promise<void> {
    const previous = this.#connection;
    const previousGeneration = this.#connectionGeneration;
    const generation = previousGeneration + 1;
    this.#connectionGeneration = generation;
    this.#connection = undefined;
    // A remote id belongs to the connection that created it. It must never be
    // matched, or unsubscribed, on the replacement connection.
    for (const state of this.#subscriptions.values()) {
      state.remoteId = undefined;
      state.remoteGeneration = undefined;
      state.connectionGeneration = undefined;
    }
    this.#store.setConnection({ generation, status });
    this.#rejectPending(
      previousGeneration,
      new RuntimeClientError('connection_closed', 'Runtime connection was replaced.'),
    );
    let openedConnection: RuntimeClientConnection | undefined;
    try {
      await previous?.close('runtime_client_reconnect');
      const connection = await this.#transport.connect();
      openedConnection = connection;
      if (this.#closed || generation !== this.#connectionGeneration) {
        await connection.close('stale_runtime_client_connection');
        throw closedError();
      }
      this.#connection = connection;
      void this.#receive(connection, generation);
      const initialize = await this.#request('initialize', {
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        clientInfo: this.#clientInfo,
      });
      if (!isInitializeResult(initialize)) {
        throw new RuntimeClientError(
          'protocol_error',
          'Protocol returned an invalid initialize result.',
        );
      }
      this.#assertExpectedServer(initialize);
      this.#store.setConnection({
        generation,
        status: 'active',
        serverInstanceId: initialize.serverInfo.instanceId,
      });
      if (resubscribe) {
        for (const state of this.#subscriptions.values()) await this.#activateSubscription(state);
      }
    } catch (error) {
      if (openedConnection && openedConnection !== previous) {
        await openedConnection.close('runtime_client_initialize_failed').catch(() => undefined);
      }
      if (generation === this.#connectionGeneration) {
        this.#connection = undefined;
        this.#store.setConnection({ generation, status: 'disconnected' });
      }
      if (error instanceof RuntimeClientError) throw error;
      throw new RuntimeClientError(
        'connection_failed',
        'Runtime connection could not be established.',
      );
    }
  }

  #assertExpectedServer(initialize: InitializeResult): void {
    const expected = this.#expectedServer;
    if (!expected) return;
    if (initialize.serverInfo.version !== expected.version) {
      throw new RuntimeClientError('server_mismatch', 'Runtime Server version does not match.');
    }
    const advertised = new Set(initialize.capabilities.methods);
    if (expected.requiredMethods?.some((method) => !advertised.has(method))) {
      throw new RuntimeClientError(
        'server_mismatch',
        'Runtime Server capability set is incomplete.',
      );
    }
  }

  async #activateSubscription(state: SubscriptionState): Promise<void> {
    await this.connect();
    if (!this.#subscriptions.has(state.id)) return;
    const connectionGeneration = this.#connectionGeneration;
    const result = await this.#request('runtime/subscribe', { subscription: state.spec }, state);
    if (!isSubscribeResult(result)) {
      throw new RuntimeClientError(
        'protocol_error',
        'Protocol returned an invalid subscribe result.',
      );
    }
    // An async subscribe result may arrive as reconnect replaces the
    // connection. Do not let that old result resurrect a stale identity.
    if (
      !this.#subscriptions.has(state.id) ||
      !this.#connection ||
      connectionGeneration !== this.#connectionGeneration
    )
      return;
    this.#bindRemoteSubscription(state, result, connectionGeneration);
  }

  #subscriptionHandle(state: SubscriptionState): RuntimeClientSubscription {
    return Object.freeze({
      id: state.id,
      spec: state.spec,
      get generation(): number {
        return state.remoteGeneration ?? 0;
      },
      unsubscribe: () => this.#closeSubscription(state, true),
    });
  }

  async #request(
    method:
      | 'initialize'
      | 'runtime/command'
      | 'runtime/query'
      | 'runtime/subscribe'
      | 'runtime/unsubscribe'
      | 'history/list_sessions'
      | 'history/list_events'
      | 'history/load_session'
      | RuntimeProtocolAppMethod
      | import('@kite-ai/runtime-protocol').RuntimeProtocolServerControlMethod,
    params: unknown,
    subscriptionState?: SubscriptionState,
  ): Promise<RuntimeProtocolResult> {
    await this.connectForRequest();
    const connection = this.#connection;
    const generation = this.#connectionGeneration;
    if (!connection)
      throw new RuntimeClientError('connection_closed', 'Runtime connection is unavailable.');
    const id = `rpc-${generation}-${++this.#nextRequest}`;
    const response = new Promise<RuntimeProtocolResult>((resolve, reject) => {
      this.#pending.set(id, { generation, resolve, reject, subscriptionState });
    });
    try {
      await connection.send({ jsonrpc: '2.0', id, method, params } as RuntimeProtocolMessage);
    } catch {
      const pending = this.#pending.get(id);
      this.#pending.delete(id);
      pending?.reject(
        new RuntimeClientError('connection_failed', 'Runtime request could not be sent.'),
      );
    }
    return response;
  }

  async connectForRequest(): Promise<void> {
    if (this.#connection) return;
    if (this.#connectPromise) return this.#connectPromise;
    return this.connect();
  }

  async #receive(connection: RuntimeClientConnection, generation: number): Promise<void> {
    try {
      for await (const value of connection.messages()) {
        if (
          this.#closed ||
          generation !== this.#connectionGeneration ||
          connection !== this.#connection
        )
          return;
        const decoded = safeDecodeRuntimeProtocolMessage(value);
        if (!decoded.success) continue;
        this.#handleMessage(decoded.data, generation);
      }
    } catch {
      // The deterministic disconnect path below rejects only this generation.
    } finally {
      if (
        !this.#closed &&
        generation === this.#connectionGeneration &&
        connection === this.#connection
      ) {
        this.#connection = undefined;
        this.#store.setConnection({ generation, status: 'disconnected' });
        this.#rejectPending(
          generation,
          new RuntimeClientError('connection_closed', 'Runtime connection closed.'),
        );
      }
    }
  }

  #handleMessage(message: RuntimeProtocolMessage, connectionGeneration: number): void {
    if ('id' in message && !('method' in message)) {
      if (message.id === null) return;
      const pending = this.#pending.get(message.id);
      if (!pending || pending.generation !== connectionGeneration) return;
      this.#pending.delete(message.id);
      if ('error' in message) {
        pending.reject(
          new RuntimeClientError('protocol_error', message.error.message, message.error),
        );
      } else {
        if (pending.subscriptionState && isSubscribeResult(message.result)) {
          this.#bindRemoteSubscription(
            pending.subscriptionState,
            message.result,
            connectionGeneration,
          );
        }
        pending.resolve(message.result);
      }
      return;
    }
    if (!('method' in message)) return;
    if (message.method === 'server/draining') {
      this.#store.setConnection({ generation: connectionGeneration, status: 'draining' });
      return;
    }
    if (message.method !== 'runtime/subscription') return;
    const state = [...this.#subscriptions.values()].find(
      (candidate) =>
        candidate.remoteId === message.params.subscriptionId &&
        candidate.remoteGeneration === message.params.generation &&
        candidate.connectionGeneration === connectionGeneration,
    );
    if (!state) return;
    this.#applySubscriptionMessage(
      connectionGeneration,
      message.params.generation,
      state,
      message.params.message,
    );
  }

  #bindRemoteSubscription(
    state: SubscriptionState,
    result: { readonly subscriptionId: string; readonly generation: number },
    connectionGeneration: number,
  ): void {
    if (
      !this.#subscriptions.has(state.id) ||
      !this.#connection ||
      connectionGeneration !== this.#connectionGeneration
    ) {
      return;
    }
    state.remoteId = result.subscriptionId;
    state.remoteGeneration = result.generation;
    state.connectionGeneration = connectionGeneration;
  }

  #applySubscriptionMessage(
    connectionGeneration: number,
    subscriptionGeneration: number,
    state: SubscriptionState,
    message: RuntimeSubscriptionMessage,
  ): void {
    const { spec } = state;
    switch (message.type) {
      case 'index_reset_begin':
        if (
          this.#store.beginIndexReset({
            connectionGeneration,
            subscriptionGeneration: message.generation,
            serverInstanceId: message.serverInstanceId,
            indexRevision: message.indexRevision,
          }) !== 'applied'
        )
          return;
        this.#pushSubscriptionNotification(state, message, connectionGeneration);
        return;
      case 'session_upsert':
        if (
          this.#store.applyIndexSession({
            connectionGeneration,
            subscriptionGeneration: message.generation,
            indexRevision: message.indexRevision,
            session: message.session,
          }) !== 'applied'
        )
          return;
        this.#pushSubscriptionNotification(state, message, connectionGeneration);
        return;
      case 'session_remove':
        if (
          this.#store.removeIndexSession({
            connectionGeneration,
            subscriptionGeneration: message.generation,
            indexRevision: message.indexRevision,
            sessionId: message.sessionId,
          }) !== 'applied'
        )
          return;
        this.#pushSubscriptionNotification(state, message, connectionGeneration);
        return;
      case 'index_reset_end':
        if (
          this.#store.endIndexReset({
            connectionGeneration,
            subscriptionGeneration: message.generation,
            indexRevision: message.indexRevision,
          }) !== 'applied'
        )
          return;
        this.#pushSubscriptionNotification(state, message, connectionGeneration);
        return;
      case 'reset':
        for (const session of message.sessions) {
          const notification = durableNotification(session);
          const applied = this.#store.applySessionNotification({
            connectionGeneration,
            subscriptionGeneration,
            notification,
            reset: true,
          });
          if (applied !== 'applied') continue;
          this.#pushSubscriptionNotification(state, notification, connectionGeneration);
        }
        return;
      case 'notification': {
        if (message.durability === 'ephemeral') {
          const notification = ephemeralNotification(message);
          const applied = this.#store.applySessionNotification({
            connectionGeneration,
            subscriptionGeneration,
            notification,
          });
          if (applied === 'resync_required') void this.#resubscribeAfterResync(state);
          if (applied !== 'applied') return;
          this.#pushSubscriptionNotification(state, notification, connectionGeneration);
          return;
        }
        const notification = durableNotification(message.session, message.revision, message.event, {
          ...(message.runId === undefined ? {} : { runId: message.runId }),
          ...(message.taskId === undefined ? {} : { taskId: message.taskId }),
          ...(message.turnId === undefined ? {} : { turnId: message.turnId }),
        });
        const applied = this.#store.applySessionNotification({
          connectionGeneration,
          subscriptionGeneration,
          notification,
          ready: spec.scope === 'session',
        });
        if (applied === 'resync_required') void this.#resubscribeAfterResync(state);
        if (applied !== 'applied') return;
        this.#pushSubscriptionNotification(state, notification, connectionGeneration);
        return;
      }
      case 'ready':
        if (spec.scope === 'session') {
          this.#store.markSessionReady({
            connectionGeneration,
            subscriptionGeneration,
            sessionId: spec.sessionId,
          });
        }
        state.ready?.resolve();
        return;
    }
  }

  #rejectPending(generation: number, error: RuntimeClientError): void {
    for (const [id, pending] of this.#pending) {
      if (pending.generation !== generation) continue;
      this.#pending.delete(id);
      pending.reject(error);
    }
  }

  async #resubscribeAfterResync(state: SubscriptionState): Promise<void> {
    if (state.resyncing || !this.#subscriptions.has(state.id) || this.#closed) return;
    state.resyncing = true;
    const remoteId = state.remoteId;
    const generation = state.connectionGeneration;
    state.remoteId = undefined;
    state.remoteGeneration = undefined;
    state.connectionGeneration = undefined;
    try {
      if (remoteId && generation === this.#connectionGeneration) {
        await this.#request('runtime/unsubscribe', { subscriptionId: remoteId }).catch(
          () => undefined,
        );
      }
      if (this.#subscriptions.has(state.id) && !this.#closed) {
        await this.#activateSubscription(state);
      }
    } finally {
      state.resyncing = false;
    }
  }

  #pushSubscriptionNotification(
    state: SubscriptionState,
    notification: RuntimeAccessNotification,
    connectionGeneration: number,
  ): void {
    if (state.queue.push(notification, connectionGeneration) !== 'durable_overflow') return;
    // A durable fact cannot be silently discarded. Close the local iterator
    // and release its remote counterpart; callers must resubscribe to obtain
    // a fresh, bounded stream.
    void this.#closeSubscription(state, true).catch(() => undefined);
  }
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

interface QueuedRuntimeNotification {
  readonly notification: RuntimeAccessNotification;
  readonly connectionGeneration: number;
}

class RuntimeNotificationQueue {
  readonly #items: QueuedRuntimeNotification[] = [];
  readonly #waiters = new Set<(result: IteratorResult<QueuedRuntimeNotification>) => void>();
  #closed = false;

  push(
    notification: RuntimeAccessNotification,
    connectionGeneration: number,
  ): 'accepted' | 'dropped_ephemeral' | 'durable_overflow' | 'closed' {
    if (this.#closed) return 'closed';
    const waiter = this.#waiters.values().next().value as
      | ((result: IteratorResult<QueuedRuntimeNotification>) => void)
      | undefined;
    if (waiter) {
      this.#waiters.delete(waiter);
      waiter({
        done: false,
        value: Object.freeze({ notification, connectionGeneration }),
      });
      return 'accepted';
    }
    if (this.#items.length < 256) {
      this.#items.push(Object.freeze({ notification, connectionGeneration }));
      return 'accepted';
    }
    // Stream deltas are intentionally lossy. Before failing a subscription,
    // evict every queued ephemeral value and retain the newest one. Durable
    // messages retain FIFO order and are never evicted or silently dropped.
    const retained = this.#items.filter((item) => !isEphemeralNotification(item.notification));
    if (retained.length < 256) {
      this.#items.splice(0, this.#items.length, ...retained);
      this.#items.push(Object.freeze({ notification, connectionGeneration }));
      return 'accepted';
    }
    if (isEphemeralNotification(notification)) return 'dropped_ephemeral';
    this.close();
    return 'durable_overflow';
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#items.length = 0;
    for (const waiter of this.#waiters) waiter({ done: true, value: undefined });
    this.#waiters.clear();
  }

  iterable(onReturn: () => void): AsyncIterable<RuntimeAccessNotification> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<RuntimeAccessNotification>> => {
          const item = this.#items.shift();
          if (item) return Promise.resolve({ done: false, value: item.notification });
          if (this.#closed) return Promise.resolve({ done: true, value: undefined });
          return new Promise<IteratorResult<RuntimeAccessNotification>>((resolve) =>
            this.#waiters.add((result) =>
              resolve(
                result.done
                  ? { done: true, value: undefined }
                  : { done: false, value: result.value.notification },
              ),
            ),
          );
        },
        return: async (): Promise<IteratorResult<RuntimeAccessNotification>> => {
          onReturn();
          this.close();
          return { done: true, value: undefined };
        },
      }),
    };
  }

  iterableWithGeneration(onReturn: () => void): AsyncIterable<QueuedRuntimeNotification> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<QueuedRuntimeNotification>> => {
          const item = this.#items.shift();
          if (item) return Promise.resolve({ done: false, value: item });
          if (this.#closed) return Promise.resolve({ done: true, value: undefined });
          return new Promise<IteratorResult<QueuedRuntimeNotification>>((resolve) =>
            this.#waiters.add(resolve),
          );
        },
        return: async (): Promise<IteratorResult<QueuedRuntimeNotification>> => {
          onReturn();
          this.close();
          return { done: true, value: undefined };
        },
      }),
    };
  }
}

function durableNotification(
  session: RuntimeSessionProjection,
  revision = session.revision,
  event?: RuntimeClientEvent,
  identity: Readonly<{ runId?: string; taskId?: string; turnId?: string }> = {},
): Extract<RuntimeNotification, { durability: 'durable' }> {
  return {
    schema: 'kite.runtime-notification.v2' as const,
    durability: 'durable' as const,
    sessionId: session.sessionId,
    revision,
    ...(identity.runId === undefined ? {} : { runId: identity.runId }),
    ...(identity.taskId === undefined ? {} : { taskId: identity.taskId }),
    ...(identity.turnId === undefined ? {} : { turnId: identity.turnId }),
    projection: { kind: 'session' as const, session, ...(event === undefined ? {} : { event }) },
  };
}

/** Convert one already accepted Runtime notification to the TUI envelope. */
export function toAcceptedPresentationEnvelope(
  notification: RuntimeNotification,
  connectionGeneration: number,
): AcceptedPresentationEnvelope | undefined {
  const event =
    notification.durability === 'durable' ? notification.projection.event : notification.event;
  if (!event) return undefined;
  if (!Number.isSafeInteger(connectionGeneration) || connectionGeneration < 1) {
    throw new Error('Accepted presentation envelope connection generation is invalid.');
  }
  const run =
    notification.durability === 'durable' ? notification.projection.session.currentRun : undefined;
  const eventRunId = event.type === 'run.terminal' ? event.runId : undefined;
  const eventTaskId =
    event.type === 'task.terminal' ||
    event.type === 'planning.entered' ||
    event.type === 'planning.exited'
      ? event.taskId
      : undefined;
  const eventTurnId = event.type === 'turn.terminal' ? event.turnId : undefined;
  const envelope = Object.freeze({
    sessionId: notification.sessionId,
    connectionGeneration,
    durability: notification.durability,
    ...(notification.durability === 'durable' ? { revision: notification.revision } : {}),
    ...(notification.durability === 'ephemeral'
      ? {
          ...((notification.runId ?? eventRunId)
            ? { runId: notification.runId ?? eventRunId }
            : {}),
          ...((eventTaskId ?? notification.taskId ?? notification.workId)
            ? { taskId: eventTaskId ?? notification.taskId ?? notification.workId }
            : {}),
          turnId: eventTurnId ?? notification.turnId,
        }
      : {
          ...((notification.runId ?? eventRunId ?? run?.runId)
            ? { runId: notification.runId ?? eventRunId ?? run?.runId }
            : {}),
          ...((notification.taskId ??
          eventTaskId ??
          run?.taskId ??
          notification.projection.session.activeTask?.taskId)
            ? {
                taskId:
                  notification.taskId ??
                  eventTaskId ??
                  run?.taskId ??
                  notification.projection.session.activeTask?.taskId,
              }
            : {}),
          ...((notification.turnId ?? eventTurnId ?? run?.activeTurnId ?? run?.initialTurnId)
            ? {
                turnId:
                  notification.turnId ?? eventTurnId ?? run?.activeTurnId ?? run?.initialTurnId,
              }
            : {}),
        }),
    event,
    ...(notification.durability === 'ephemeral'
      ? {
          stream: Object.freeze({
            actorId: notification.actorId,
            attemptId: notification.attemptId,
            compositionRevision: notification.compositionRevision,
            streamId: notification.streamId,
            sequence: notification.sequence,
          }),
        }
      : {}),
  });
  assertAcceptedPresentationEnvelope(envelope);
  return envelope;
}

function ephemeralNotification(
  message: Extract<
    RuntimeSubscriptionMessage,
    { readonly type: 'notification'; readonly durability: 'ephemeral' }
  >,
): Extract<RuntimeNotification, { readonly durability: 'ephemeral' }> {
  return {
    schema: 'kite.runtime-notification.v2',
    durability: 'ephemeral',
    sessionId: message.sessionId,
    workId: message.workId,
    ...(message.runId === undefined ? {} : { runId: message.runId }),
    ...(message.taskId === undefined ? {} : { taskId: message.taskId }),
    turnId: message.turnId,
    actorId: message.actorId,
    attemptId: message.attemptId,
    compositionRevision: message.compositionRevision,
    streamId: message.streamId,
    sequence: message.sequence,
    event: message.event,
  };
}

function isEphemeralNotification(
  notification: RuntimeAccessNotification,
): notification is Extract<RuntimeNotification, { readonly durability: 'ephemeral' }> {
  return 'durability' in notification && notification.durability === 'ephemeral';
}

function isInitializeResult(result: RuntimeProtocolResult): result is InitializeResult {
  return 'protocolVersion' in result && 'serverInfo' in result;
}

function isSubscribeResult(
  result: RuntimeProtocolResult,
): result is { readonly subscriptionId: string; readonly generation: number } {
  return 'subscriptionId' in result && 'generation' in result;
}

function isUnsubscribeResult(
  result: RuntimeProtocolResult,
): result is { readonly unsubscribed: boolean } {
  return 'unsubscribed' in result;
}

function isCommandReceipt(result: RuntimeProtocolResult): result is RuntimeCommandReceipt {
  return 'commandId' in result && 'status' in result;
}

function isQueryResult(result: RuntimeProtocolResult): result is RuntimeQueryResult {
  return 'queryType' in result && 'status' in result;
}

function closedError(): RuntimeClientError {
  return new RuntimeClientError('connection_closed', 'Runtime Client is closed.');
}
