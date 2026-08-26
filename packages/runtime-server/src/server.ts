import type {
  RuntimeAccess,
  RuntimeAccessNotification,
  RuntimeNotification,
  RuntimeSubscriptionSpec,
} from '@kite-ai/runtime-contract';
import {
  type InitializeResult,
  mapProtocolCommandToRuntimeCommand,
  mapProtocolQueryToRuntimeQuery,
  mapRuntimeAccessNotificationToSubscriptionMessage,
  mapRuntimeQueryResultToProtocol,
  RUNTIME_PROTOCOL_ERROR_NUMBERS,
  RUNTIME_PROTOCOL_ERROR_SCHEMA_,
  RUNTIME_PROTOCOL_LIMITS,
  RUNTIME_PROTOCOL_NOTIFICATION_SCHEMA_,
  RUNTIME_PROTOCOL_RESULT_SCHEMA_,
  RUNTIME_PROTOCOL_SCHEMA,
  RUNTIME_PROTOCOL_VERSION,
  type RuntimeProtocolErrorCode,
  type RuntimeProtocolMessage,
  type RuntimeProtocolMethod,
  type RuntimeProtocolRequest,
  type RuntimeProtocolResult,
  type RuntimeSubscriptionSpec as RuntimeProtocolSubscriptionSpec,
  type RuntimeSubscriptionMessage,
  safeDecodeRuntimeProtocolMessage,
} from '@kite-ai/runtime-protocol';

export type RuntimeServerConnectionState = 'uninitialized' | 'active' | 'draining' | 'closed';

/** One framing-neutral logical-message duplex. Carriers own streams, sockets, and process lifecycle. */
export interface RuntimeServerLogicalMessageConnection {
  readonly incoming: AsyncIterable<unknown>;
  send(message: RuntimeProtocolMessage): Promise<void>;
  close(reason?: string): void | Promise<void>;
}

export interface RuntimeServerAdmissionInput {
  readonly connectionId: string;
  readonly operation: RuntimeProtocolMethod;
  readonly requestId: string;
  readonly clientInfo?: Readonly<{ name: string; version: string; instanceId: string }>;
  readonly command?: unknown;
  readonly query?: unknown;
  readonly subscription?: RuntimeProtocolSubscriptionSpec;
}

export type RuntimeServerAdmissionDecision =
  | { readonly allowed: true; readonly workspace: string }
  | { readonly allowed: false; readonly reason?: 'unauthorized' | 'unavailable' };

/** App-owned authority for transport, role and its one already-trusted Workspace. */
export interface RuntimeServerAdmissionPort {
  authorize(input: RuntimeServerAdmissionInput): Promise<RuntimeServerAdmissionDecision>;
}

export interface RuntimeServerBackend {
  readonly runtime: RuntimeAccess;
  readonly admission: RuntimeServerAdmissionPort;
}

export interface RuntimeServerLimits {
  readonly maxInFlightRequests: number;
  readonly maxSubscriptions: number;
  readonly maxOutboundMessages: number;
  readonly maxOutboundBytes: number;
}

/** Process-wide core budgets. App carriers may impose narrower transport budgets. */
export interface RuntimeServerGlobalLimits {
  readonly maxConnections: number;
  readonly maxSubscriptions: number;
  readonly maxQueuedBytes: number;
  readonly drainTimeoutMs: number;
}

export const DEFAULT_RUNTIME_SERVER_LIMITS: RuntimeServerLimits = Object.freeze({
  maxInFlightRequests: RUNTIME_PROTOCOL_LIMITS.maxInFlightRequests,
  maxSubscriptions: RUNTIME_PROTOCOL_LIMITS.maxSubscriptions,
  maxOutboundMessages: RUNTIME_PROTOCOL_LIMITS.maxOutboundMessages,
  maxOutboundBytes: RUNTIME_PROTOCOL_LIMITS.maxMessageBytes * 2,
});

export const DEFAULT_RUNTIME_SERVER_GLOBAL_LIMITS: RuntimeServerGlobalLimits = Object.freeze({
  maxConnections: 128,
  maxSubscriptions: RUNTIME_PROTOCOL_LIMITS.maxSubscriptions * 8,
  maxQueuedBytes: RUNTIME_PROTOCOL_LIMITS.maxMessageBytes * 16,
  drainTimeoutMs: 5_000,
});

export interface RuntimeServerOptions {
  readonly serverInfo: Readonly<{ version: string; instanceId: string }>;
  readonly limits?: Partial<RuntimeServerLimits>;
  readonly globalLimits?: Partial<RuntimeServerGlobalLimits>;
}

export interface RuntimeServerConnection {
  readonly connectionId: string;
  readonly state: RuntimeServerConnectionState;
  close(reason?: string): Promise<void>;
  beginDraining(): Promise<void>;
}

/**
 * A framework-neutral Server core. It has no listener: an App carrier supplies
 * each already-framed logical duplex and owns its lifecycle.
 */
export class RuntimeServer {
  readonly #backend: RuntimeServerBackend;
  readonly #options: RuntimeServerOptions;
  readonly #limits: RuntimeServerLimits;
  readonly #globalLimits: RuntimeServerGlobalLimits;
  readonly #connections = new Set<ServerConnection>();
  #subscriptionCount = 0;
  #queuedBytes = 0;
  #nextConnection = 0;
  #draining = false;

  constructor(backend: RuntimeServerBackend, options: RuntimeServerOptions) {
    this.#backend = backend;
    this.#options = options;
    this.#limits = normalizeLimits(options.limits);
    this.#globalLimits = normalizeGlobalLimits(options.globalLimits);
  }

  open(connection: RuntimeServerLogicalMessageConnection): RuntimeServerConnection {
    if (this.#draining || this.#connections.size >= this.#globalLimits.maxConnections) {
      void connection.close('server_draining');
      return closedConnection();
    }
    const session = new ServerConnection(
      `connection-${++this.#nextConnection}`,
      this.#backend,
      connection,
      this.#options.serverInfo,
      this.#limits,
      this.#globalLimits.drainTimeoutMs,
      () => this.#reserveSubscription(),
      () => this.#releaseSubscription(),
      (delta) => this.#reserveQueuedBytes(delta),
      () => this.#connections.delete(session),
    );
    this.#connections.add(session);
    session.start();
    return session;
  }

  async beginDraining(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    await Promise.all([...this.#connections].map((connection) => connection.beginDraining()));
  }

  get connectionCount(): number {
    return this.#connections.size;
  }

  #reserveSubscription(): boolean {
    if (this.#subscriptionCount >= this.#globalLimits.maxSubscriptions) return false;
    this.#subscriptionCount += 1;
    return true;
  }

  #releaseSubscription(): void {
    if (this.#subscriptionCount > 0) this.#subscriptionCount -= 1;
  }

  #reserveQueuedBytes(delta: number): boolean {
    if (!Number.isSafeInteger(delta)) return false;
    if (delta > 0 && this.#queuedBytes + delta > this.#globalLimits.maxQueuedBytes) return false;
    this.#queuedBytes = Math.max(0, this.#queuedBytes + delta);
    return true;
  }
}

class ServerConnection implements RuntimeServerConnection {
  readonly connectionId: string;
  readonly #backend: RuntimeServerBackend;
  readonly #connection: RuntimeServerLogicalMessageConnection;
  readonly #serverInfo: Readonly<{ version: string; instanceId: string }>;
  readonly #limits: RuntimeServerLimits;
  readonly #drainTimeoutMs: number;
  readonly #reserveSubscription: () => boolean;
  readonly #releaseSubscription: () => void;
  readonly #reserveQueuedBytes: (delta: number) => boolean;
  readonly #onClose: () => void;
  readonly #outbound: OutboundQueue;
  readonly #inFlight = new Set<Promise<void>>();
  readonly #subscriptions = new Map<string, Subscription>();
  readonly #rpcIds = new Set<string>();
  #activeRequestTasks = 0;
  #clientInfo: RuntimeServerAdmissionInput['clientInfo'];
  #state: RuntimeServerConnectionState = 'uninitialized';
  #initializing = false;
  #nextSubscription = 0;
  #nextGeneration = 0;
  #closed: Promise<void> | undefined;

  constructor(
    connectionId: string,
    backend: RuntimeServerBackend,
    connection: RuntimeServerLogicalMessageConnection,
    serverInfo: Readonly<{ version: string; instanceId: string }>,
    limits: RuntimeServerLimits,
    drainTimeoutMs: number,
    reserveSubscription: () => boolean,
    releaseSubscription: () => void,
    reserveQueuedBytes: (delta: number) => boolean,
    onClose: () => void,
  ) {
    this.connectionId = connectionId;
    this.#backend = backend;
    this.#connection = connection;
    this.#serverInfo = serverInfo;
    this.#limits = limits;
    this.#drainTimeoutMs = drainTimeoutMs;
    this.#reserveSubscription = reserveSubscription;
    this.#releaseSubscription = releaseSubscription;
    this.#reserveQueuedBytes = reserveQueuedBytes;
    this.#onClose = onClose;
    this.#outbound = new OutboundQueue(
      limits,
      connection,
      this.#reserveQueuedBytes,
      () => void this.close('slow_consumer'),
    );
  }

  get state(): RuntimeServerConnectionState {
    return this.#state;
  }

  start(): void {
    void this.#receive();
  }

  async beginDraining(): Promise<void> {
    if (this.#state === 'closed' || this.#state === 'draining') return;
    this.#state = 'draining';
    void this.#sendNotification(
      {
        jsonrpc: '2.0',
        method: 'server/draining',
        params: {},
      },
      'control',
    );
    await this.#stopSubscriptions();
    await withDeadline(this.#outbound.whenIdle(), this.#drainTimeoutMs);
    await this.close('drain_complete');
  }

  async close(reason = 'connection_closed'): Promise<void> {
    this.#closed ??= this.#close(reason);
    return this.#closed;
  }

  async #receive(): Promise<void> {
    try {
      for await (const value of this.#connection.incoming) {
        if (this.#state === 'closed') break;
        const requestId = requestIdFrom(value);
        if (requestId && this.#rpcIds.has(requestId)) {
          await this.#sendError(requestId, 'invalid_request');
          continue;
        }
        if (this.#activeRequestTasks >= this.#limits.maxInFlightRequests) {
          await this.#sendError(requestId, 'overloaded');
          continue;
        }
        this.#activeRequestTasks += 1;
        let permitReleased = false;
        const releasePermit = () => {
          if (permitReleased) return;
          permitReleased = true;
          this.#activeRequestTasks -= 1;
        };
        const task = this.#handle(value, releasePermit).catch(async () => {
          releasePermit();
          await this.#sendError(requestIdFrom(value), 'internal_error');
        });
        if (requestId) this.#rpcIds.add(requestId);
        this.#inFlight.add(task);
        void task.finally(() => {
          releasePermit();
          this.#inFlight.delete(task);
          if (requestId) this.#rpcIds.delete(requestId);
        });
      }
    } finally {
      await this.close('incoming_closed');
    }
  }

  async #handle(value: unknown, releasePermit: () => void): Promise<void> {
    const decoded = safeDecodeRuntimeProtocolMessage(value);
    if (!decoded.success) {
      const code = decodeErrorCode(value);
      await this.#sendError(requestIdFrom(value), code, releasePermit);
      if (code === 'protocol_version_mismatch') await this.close('protocol_version_mismatch');
      return;
    }
    const request = decoded.data;
    if (!isRequest(request)) {
      await this.#sendError(null, 'invalid_request', releasePermit);
      return;
    }
    if (this.#state === 'draining' && request.method !== 'runtime/unsubscribe') {
      await this.#sendError(request.id, 'overloaded', releasePermit);
      return;
    }
    if (this.#state === 'uninitialized') {
      if (request.method !== 'initialize') {
        await this.#sendError(request.id, 'not_initialized', releasePermit);
        return;
      }
      if (this.#initializing) {
        await this.#sendError(request.id, 'already_initialized', releasePermit);
        return;
      }
      this.#initializing = true;
      try {
        await this.#initialize(request, releasePermit);
      } finally {
        this.#initializing = false;
      }
      return;
    }
    if (request.method === 'initialize') {
      await this.#sendError(request.id, 'already_initialized', releasePermit);
      return;
    }
    if (
      this.#state !== 'active' &&
      !(this.#state === 'draining' && request.method === 'runtime/unsubscribe')
    ) {
      await this.#sendError(request.id, 'overloaded', releasePermit);
      return;
    }
    switch (request.method) {
      case 'runtime/command':
        await this.#command(request, releasePermit);
        return;
      case 'runtime/query':
        await this.#query(request, releasePermit);
        return;
      case 'runtime/subscribe':
        await this.#subscribe(request, releasePermit);
        return;
      case 'runtime/unsubscribe':
        await this.#unsubscribe(request, releasePermit);
        return;
      case 'server/ping':
        await this.#sendResult(request.id, { status: 'ok' }, releasePermit);
        return;
      default:
        return;
    }
  }

  async #initialize(
    request: Extract<RuntimeProtocolRequest, { method: 'initialize' }>,
    releasePermit: () => void,
  ): Promise<void> {
    const decision = await this.#authorize(request, request.params.clientInfo);
    if (!decision.allowed) {
      await this.#sendError(request.id, 'unauthorized', releasePermit);
      return;
    }
    this.#clientInfo = request.params.clientInfo;
    this.#state = 'active';
    const result: InitializeResult = {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      protocolSchema: RUNTIME_PROTOCOL_SCHEMA,
      serverInfo: this.#serverInfo,
      capabilities: {
        methods: [
          'initialize',
          'runtime/command',
          'runtime/query',
          'runtime/subscribe',
          'runtime/unsubscribe',
          'server/ping',
        ],
        subscriptions: ['session', 'sessions'],
      },
      limits: {
        maxMessageBytes: RUNTIME_PROTOCOL_LIMITS.maxMessageBytes,
        maxDepth: RUNTIME_PROTOCOL_LIMITS.maxDepth,
        maxInFlightRequests: this.#limits.maxInFlightRequests,
        maxSubscriptions: this.#limits.maxSubscriptions,
        maxOutboundMessages: this.#limits.maxOutboundMessages,
      },
    };
    await this.#sendResult(
      request.id,
      RUNTIME_PROTOCOL_RESULT_SCHEMA_.parse(result),
      releasePermit,
    );
  }

  async #command(
    request: Extract<RuntimeProtocolRequest, { method: 'runtime/command' }>,
    releasePermit: () => void,
  ): Promise<void> {
    const decision = await this.#authorize(request);
    if (!decision.allowed) {
      await this.#sendError(request.id, 'unauthorized', releasePermit);
      return;
    }
    const command = mapProtocolCommandToRuntimeCommand(request.params.command, {
      workspace: decision.workspace,
    });
    await this.#sendResult(
      request.id,
      RUNTIME_PROTOCOL_RESULT_SCHEMA_.parse(await this.#backend.runtime.command(command)),
      releasePermit,
    );
  }

  async #query(
    request: Extract<RuntimeProtocolRequest, { method: 'runtime/query' }>,
    releasePermit: () => void,
  ): Promise<void> {
    const decision = await this.#authorize(request);
    if (!decision.allowed) {
      await this.#sendError(request.id, 'unauthorized', releasePermit);
      return;
    }
    const result = mapRuntimeQueryResultToProtocol(
      await this.#backend.runtime.query(mapProtocolQueryToRuntimeQuery(request.params.query)),
    );
    if (!result) {
      await this.#sendError(request.id, 'internal_error', releasePermit);
      return;
    }
    await this.#sendResult(request.id, result, releasePermit);
  }

  async #subscribe(
    request: Extract<RuntimeProtocolRequest, { method: 'runtime/subscribe' }>,
    releasePermit: () => void,
  ): Promise<void> {
    if (this.#subscriptions.size >= this.#limits.maxSubscriptions) {
      await this.#sendError(request.id, 'overloaded', releasePermit);
      return;
    }
    if (!this.#reserveSubscription()) {
      await this.#sendError(request.id, 'overloaded', releasePermit);
      return;
    }
    const decision = await this.#authorize(request);
    if (!decision.allowed) {
      this.#releaseSubscription();
      await this.#sendError(request.id, 'unauthorized', releasePermit);
      return;
    }
    const subscriptionId = `subscription-${++this.#nextSubscription}`;
    const subscription = new Subscription(
      subscriptionId,
      ++this.#nextGeneration,
      request.params.subscription,
      this.#backend.runtime,
      (message) => this.#sendSubscription(subscriptionId, message),
      () => void this.close('subscription_unavailable'),
      () => {
        this.#subscriptions.delete(subscriptionId);
        this.#releaseSubscription();
      },
    );
    this.#subscriptions.set(subscriptionId, subscription);
    try {
      subscription.acquire();
      await subscription.prepareInitialBoundary();
      const acknowledged = await this.#sendResult(
        request.id,
        RUNTIME_PROTOCOL_RESULT_SCHEMA_.parse({
          subscriptionId,
          generation: subscription.generation,
        }),
        releasePermit,
      );
      if (!acknowledged) {
        await subscription.close();
        return;
      }
      subscription.start();
    } catch (_error) {
      this.#subscriptions.delete(subscriptionId);
      await subscription.close();
      await this.#sendError(request.id, 'subscription_unavailable', releasePermit);
    }
  }

  async #unsubscribe(
    request: Extract<RuntimeProtocolRequest, { method: 'runtime/unsubscribe' }>,
    releasePermit: () => void,
  ): Promise<void> {
    const subscription = this.#subscriptions.get(request.params.subscriptionId);
    if (subscription) await subscription.close();
    await this.#sendResult(
      request.id,
      RUNTIME_PROTOCOL_RESULT_SCHEMA_.parse({ unsubscribed: Boolean(subscription) }),
      releasePermit,
    );
  }

  async #authorize(
    request: RuntimeProtocolRequest,
    clientInfo = this.#clientInfo,
  ): Promise<RuntimeServerAdmissionDecision> {
    return this.#backend.admission.authorize({
      connectionId: this.connectionId,
      operation: request.method,
      requestId: request.id,
      ...(clientInfo ? { clientInfo } : {}),
      ...(request.method === 'runtime/command' ? { command: request.params.command } : {}),
      ...(request.method === 'runtime/query' ? { query: request.params.query } : {}),
      ...(request.method === 'runtime/subscribe'
        ? { subscription: request.params.subscription }
        : {}),
    });
  }

  async #sendSubscription(
    subscriptionId: string,
    message: RuntimeSubscriptionMessage,
  ): Promise<boolean> {
    const subscription = this.#subscriptions.get(subscriptionId);
    if (!subscription || this.#state === 'closed') return false;
    const kind =
      message.type === 'notification' && message.durability === 'ephemeral'
        ? 'ephemeral'
        : 'durable';
    return this.#sendNotification(
      {
        jsonrpc: '2.0',
        method: 'runtime/subscription',
        params: { subscriptionId, generation: subscription.generation, message },
      },
      kind,
    );
  }

  #sendResult(
    id: string,
    result: RuntimeProtocolResult,
    releasePermit?: () => void,
  ): Promise<boolean> {
    releasePermit?.();
    return this.#outbound.enqueue({ jsonrpc: '2.0', id, result }, 'response');
  }

  #sendError(
    id: string | null,
    code: RuntimeProtocolErrorCode,
    releasePermit?: () => void,
  ): Promise<boolean> {
    releasePermit?.();
    return this.#outbound.enqueue(
      {
        jsonrpc: '2.0',
        id,
        error: protocolError(code),
      },
      'response',
    );
  }

  #sendNotification(message: RuntimeProtocolMessage, kind: OutboundMessageKind): Promise<boolean> {
    return this.#outbound.enqueue(RUNTIME_PROTOCOL_NOTIFICATION_SCHEMA_.parse(message), kind);
  }

  async #stopSubscriptions(): Promise<void> {
    await Promise.all(
      [...this.#subscriptions.values()].map((subscription) => subscription.close()),
    );
  }

  async #close(reason: string): Promise<void> {
    if (this.#state === 'closed') return;
    this.#state = 'closed';
    await this.#stopSubscriptions();
    this.#outbound.close();
    await this.#connection.close(reason);
    this.#onClose();
  }
}

class Subscription {
  readonly id: string;
  readonly generation: number;
  readonly #spec: RuntimeSubscriptionSpec;
  readonly #runtime: RuntimeAccess;
  readonly #publish: (message: RuntimeSubscriptionMessage) => Promise<boolean>;
  readonly #onFailure: () => void;
  readonly #onClose: () => void;
  readonly #controller = new AbortController();
  #iterator: AsyncIterator<RuntimeAccessNotification> | undefined;
  #phase: 'initial' | 'live' = 'initial';
  #initialSessionRevision: number | undefined;
  #closed = false;

  constructor(
    id: string,
    generation: number,
    spec: RuntimeSubscriptionSpec,
    runtime: RuntimeAccess,
    publish: (message: RuntimeSubscriptionMessage) => Promise<boolean>,
    onFailure: () => void,
    onClose: () => void,
  ) {
    this.id = id;
    this.generation = generation;
    this.#spec = spec;
    this.#runtime = runtime;
    this.#publish = publish;
    this.#onFailure = onFailure;
    this.#onClose = onClose;
  }

  acquire(): void {
    const iterable = this.#runtime.subscribe({ spec: this.#spec, signal: this.#controller.signal });
    this.#iterator = iterable[Symbol.asyncIterator]();
  }

  start(): void {
    if (!this.#iterator) throw new Error('Subscription iterator was not acquired.');
    if (this.#spec.scope === 'session') {
      void this.#runSession();
      return;
    }
    void this.#run();
  }

  async prepareInitialBoundary(): Promise<void> {
    if (this.#spec.scope !== 'session') return;
    const result = await this.#runtime.query({
      schema: 'kite.runtime-query.v1',
      type: 'get_session_projection',
      sessionId: this.#spec.sessionId,
    });
    if (result.status === 'not_found') return;
    if (result.status !== 'ok') throw new Error('Session projection watermark is unavailable.');
    const revision = result.revision ?? result.session?.revision;
    if (revision === undefined) return;
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new Error('Session projection watermark is invalid.');
    }
    this.#initialSessionRevision = revision;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#controller.abort();
    try {
      await this.#iterator?.return?.();
    } finally {
      this.#onClose();
    }
  }

  async #run(): Promise<void> {
    try {
      while (!this.#closed) {
        const next = await this.#iterator?.next();
        if (!next || next.done) {
          if (!this.#closed) this.#onFailure();
          return;
        }
        const message = mapRuntimeAccessNotificationToSubscriptionMessage(next.value);
        if (!(await this.#publish(message))) return;
        if (this.#phase === 'initial' && message.type === 'index_reset_end') {
          if (!(await this.#publish({ type: 'ready', scope: 'sessions' }))) return;
          this.#phase = 'live';
        }
      }
    } finally {
      await this.close();
    }
  }

  async #runSession(): Promise<void> {
    try {
      const watermark = this.#initialSessionRevision;
      const afterRevision = this.#spec.scope === 'session' ? this.#spec.afterRevision : undefined;
      if (watermark === undefined || afterRevision === watermark) {
        if (!(await this.#publish({ type: 'ready', scope: 'session' }))) return;
        this.#phase = 'live';
      }
      while (!this.#closed) {
        const next = await this.#iterator?.next();
        if (!next || next.done) {
          if (!this.#closed) this.#onFailure();
          return;
        }
        if (!isRuntimeNotification(next.value)) {
          this.#onFailure();
          return;
        }
        const notification = next.value;
        if (this.#phase === 'initial') {
          if (notification.durability === 'ephemeral') continue;
          if (watermark === undefined || notification.revision > watermark) {
            this.#onFailure();
            return;
          }
          if (
            !(await this.#publish(mapRuntimeAccessNotificationToSubscriptionMessage(notification)))
          ) {
            return;
          }
          if (notification.revision === watermark) {
            if (!(await this.#publish({ type: 'ready', scope: 'session' }))) return;
            this.#phase = 'live';
          }
          continue;
        }
        if (
          !(await this.#publish(mapRuntimeAccessNotificationToSubscriptionMessage(notification)))
        ) {
          return;
        }
      }
    } finally {
      await this.close();
    }
  }
}

type OutboundMessageKind = 'response' | 'durable' | 'ephemeral' | 'control';

class OutboundQueue {
  readonly #limits: RuntimeServerLimits;
  readonly #connection: RuntimeServerLogicalMessageConnection;
  readonly #reserveBytes: (delta: number) => boolean;
  readonly #onOverflow: () => void;
  readonly #items: Array<{
    message: RuntimeProtocolMessage;
    bytes: number;
    kind: OutboundMessageKind;
    resolve: (accepted: boolean) => void;
  }> = [];
  readonly #idleWaiters = new Set<() => void>();
  #bytes = 0;
  #sending = false;
  #closed = false;

  constructor(
    limits: RuntimeServerLimits,
    connection: RuntimeServerLogicalMessageConnection,
    reserveBytes: (delta: number) => boolean,
    onOverflow: () => void,
  ) {
    this.#limits = limits;
    this.#connection = connection;
    this.#reserveBytes = reserveBytes;
    this.#onOverflow = onOverflow;
  }

  enqueue(message: RuntimeProtocolMessage, kind: OutboundMessageKind): Promise<boolean> {
    if (this.#closed) return Promise.resolve(false);
    const bytes = encodedBytes(message);
    if (!this.#canAccept(bytes)) {
      this.#dropQueuedEphemeral();
    }
    if (!this.#canAccept(bytes)) {
      if (kind === 'ephemeral') return Promise.resolve(true);
      this.#onOverflow();
      return Promise.resolve(false);
    }
    let globallyReserved = this.#reserveBytes(bytes);
    if (!globallyReserved) {
      this.#dropQueuedEphemeral();
      globallyReserved = this.#reserveBytes(bytes);
    }
    if (!globallyReserved) {
      if (kind === 'ephemeral') return Promise.resolve(true);
      this.#onOverflow();
      return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      this.#items.push({ message, bytes, kind, resolve });
      this.#bytes += bytes;
      void this.#drain();
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const item of this.#items.splice(0)) {
      this.#reserveBytes(-item.bytes);
      item.resolve(false);
    }
    this.#bytes = 0;
    this.#notifyIdle();
  }

  whenIdle(): Promise<void> {
    if (!this.#sending && this.#items.length === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.#idleWaiters.add(resolve));
  }

  async #drain(): Promise<void> {
    if (this.#sending) return;
    this.#sending = true;
    try {
      while (!this.#closed) {
        const item = this.#items.shift();
        if (!item) {
          this.#notifyIdle();
          return;
        }
        this.#bytes -= item.bytes;
        this.#reserveBytes(-item.bytes);
        try {
          await this.#connection.send(item.message);
          item.resolve(true);
        } catch {
          item.resolve(false);
          this.#onOverflow();
          return;
        }
      }
    } finally {
      this.#sending = false;
      if (this.#items.length === 0) this.#notifyIdle();
    }
  }

  #canAccept(bytes: number): boolean {
    return (
      bytes <= this.#limits.maxOutboundBytes &&
      this.#items.length < this.#limits.maxOutboundMessages &&
      this.#bytes + bytes <= this.#limits.maxOutboundBytes
    );
  }

  #dropQueuedEphemeral(): void {
    for (let index = this.#items.length - 1; index >= 0; index -= 1) {
      const item = this.#items[index];
      if (item?.kind !== 'ephemeral') continue;
      this.#items.splice(index, 1);
      this.#bytes -= item.bytes;
      this.#reserveBytes(-item.bytes);
      item.resolve(true);
      if (
        this.#items.length < this.#limits.maxOutboundMessages &&
        this.#bytes < this.#limits.maxOutboundBytes
      )
        return;
    }
  }

  #notifyIdle(): void {
    for (const resolve of this.#idleWaiters) resolve();
    this.#idleWaiters.clear();
  }
}

function protocolError(code: RuntimeProtocolErrorCode) {
  const messages: Readonly<Record<RuntimeProtocolErrorCode, string>> = {
    parse_error: 'Parse error',
    invalid_request: 'Invalid request',
    method_not_found: 'Method not found',
    invalid_params: 'Invalid params',
    internal_error: 'Internal error',
    overloaded: 'Overloaded',
    not_initialized: 'Not initialized',
    already_initialized: 'Already initialized',
    protocol_version_mismatch: 'Protocol version mismatch',
    unauthorized: 'Unauthorized',
    subscription_unavailable: 'Subscription unavailable',
    resync_required: 'Resync required',
  };
  return RUNTIME_PROTOCOL_ERROR_SCHEMA_.parse({
    code: RUNTIME_PROTOCOL_ERROR_NUMBERS[code],
    message: messages[code],
    data: { code },
  });
}

function normalizeLimits(overrides: RuntimeServerOptions['limits']): RuntimeServerLimits {
  const limits = { ...DEFAULT_RUNTIME_SERVER_LIMITS, ...overrides };
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new TypeError('Runtime Server limits must be positive safe integers.');
  }
  return Object.freeze(limits);
}

function normalizeGlobalLimits(
  overrides: RuntimeServerOptions['globalLimits'],
): RuntimeServerGlobalLimits {
  const limits = { ...DEFAULT_RUNTIME_SERVER_GLOBAL_LIMITS, ...overrides };
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError('Runtime Server global limits must be positive safe integers.');
    }
  }
  return Object.freeze(limits);
}

async function withDeadline(promise: Promise<void>, timeoutMs: number): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timeout = setTimeout(resolve, timeoutMs);
  });
  await Promise.race([promise, deadline]);
  if (timeout !== undefined) clearTimeout(timeout);
}

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function isRuntimeNotification(value: RuntimeAccessNotification): value is RuntimeNotification {
  return 'durability' in value;
}

function isRequest(value: RuntimeProtocolMessage): value is RuntimeProtocolRequest {
  return 'id' in value && 'method' in value && typeof value.id === 'string';
}

function requestIdFrom(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === 'string' ? id : null;
}

function decodeErrorCode(value: unknown): RuntimeProtocolErrorCode {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'invalid_request';
  const candidate = value as { method?: unknown; params?: { protocolVersion?: unknown } };
  if (typeof candidate.method !== 'string') return 'invalid_request';
  if (
    ![
      'initialize',
      'runtime/command',
      'runtime/query',
      'runtime/subscribe',
      'runtime/unsubscribe',
      'server/ping',
    ].includes(candidate.method)
  )
    return 'method_not_found';
  if (
    candidate.method === 'initialize' &&
    candidate.params?.protocolVersion !== RUNTIME_PROTOCOL_VERSION
  )
    return 'protocol_version_mismatch';
  return 'invalid_params';
}

function closedConnection(): RuntimeServerConnection {
  return {
    connectionId: 'closed',
    state: 'closed',
    close: () => Promise.resolve(),
    beginDraining: () => Promise.resolve(),
  };
}
