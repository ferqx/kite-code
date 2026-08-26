import {
  BunWebSocketRuntimeClientTransport,
  type RuntimeWebSocketFactory,
} from '@kite-ai/kite-local-runtime/client';
import {
  RuntimeClient,
  type RuntimeClientConnectionStatus,
  type RuntimeClientSubscription,
  type RuntimeHistoryClient,
} from '@kite-ai/runtime-client';
import type {
  ListRuntimeLogEventsRequest,
  ListRuntimeLogSessionsRequest,
  RuntimeLogEventPage,
  RuntimeLogSessionPage,
  RuntimeQuery,
  RuntimeQueryResult,
} from '@kite-ai/runtime-contract';

export type DevelopmentRuntimeReferenceFetch = (
  input: URL | RequestInfo,
  init?: RequestInit,
) => Promise<Response>;

export interface DevelopmentRuntimeReferenceOptions {
  /** Exact HTTP loopback origin supplied by the App-owned development carrier. */
  readonly origin: string;
  /** One-time carrier bootstrap material. It is consumed only in the POST Authorization header. */
  readonly bootstrapBearer: string;
  readonly clientInfo: Readonly<{ name: string; version: string; instanceId: string }>;
  /** Explicit App-owned durable-history seam. Omitting it disables all history reads. */
  readonly history?: RuntimeHistoryClient;
  /** Injectable for Bun headless qualification; browsers use the global fetch implementation. */
  readonly fetch?: DevelopmentRuntimeReferenceFetch;
  /** Injectable for Bun headless qualification; browsers use the global WebSocket constructor. */
  readonly webSocketFactory?: RuntimeWebSocketFactory;
}

export interface DevelopmentRuntimeReferenceSession {
  readonly sessionId: string;
  readonly revision: number;
  readonly lifecycle: 'open' | 'closed' | 'unavailable';
  /** Text data only. This reference never interpolates it into HTML or evaluates it. */
  readonly displayName?: string;
  readonly updatedAt?: string;
}

export interface DevelopmentRuntimeReferenceSnapshot {
  readonly status: RuntimeClientConnectionStatus;
  readonly serverInstanceId?: string;
  readonly sessionIndexReady: boolean;
  readonly sessions: readonly DevelopmentRuntimeReferenceSession[];
}

export interface DevelopmentRuntimeReferenceView {
  getSnapshot(): DevelopmentRuntimeReferenceSnapshot;
  subscribe(listener: () => void): () => void;
}

export interface DevelopmentRuntimeReference {
  /** Client-safe, read-only state. It is deliberately not an HTML renderer or raw event stream. */
  readonly view: DevelopmentRuntimeReferenceView;
  /** Bootstraps through POST + Authorization and starts the same RuntimeClient/index path. */
  connect(): Promise<void>;
  /** Explicit closed RuntimeClient query seam; no transport-specific query implementation exists here. */
  query(query: RuntimeQuery): Promise<RuntimeQueryResult>;
  /** Convenience spelling for the fixed V1 session-list query. */
  listSessions(): Promise<RuntimeQueryResult>;
  /** Explicit History Client only. No notification, trace, or SQLite fallback exists. */
  listHistorySessions(request: ListRuntimeLogSessionsRequest): Promise<RuntimeLogSessionPage>;
  /** Explicit History Client only. No notification, trace, or SQLite fallback exists. */
  listHistoryEvents(request: ListRuntimeLogEventsRequest): Promise<RuntimeLogEventPage>;
  close(): Promise<void>;
}

export class DevelopmentRuntimeReferenceHistoryUnavailableError extends Error {
  readonly code = 'history_unavailable' as const;

  constructor() {
    super('Development runtime reference has no injected RuntimeHistoryClient.');
    this.name = 'DevelopmentRuntimeReferenceHistoryUnavailableError';
  }
}

/**
 * App-internal browser/headless reference consumer. It is development evidence,
 * not a Web product surface or a second Runtime client/store implementation.
 */
export function createDevelopmentRuntimeReference(
  options: DevelopmentRuntimeReferenceOptions,
): DevelopmentRuntimeReference {
  return new DevelopmentRuntimeReferenceConsumer(options);
}

class DevelopmentRuntimeReferenceConsumer implements DevelopmentRuntimeReference {
  readonly #fetch: DevelopmentRuntimeReferenceFetch;
  readonly #origin: string;
  readonly #client: RuntimeClient;
  readonly #history: RuntimeHistoryClient | undefined;
  readonly #view: DevelopmentRuntimeReferenceView;
  #bootstrapBearer: string;
  #bootstrapped = false;
  #indexSubscription: RuntimeClientSubscription | undefined;
  #connectPromise: Promise<void> | undefined;
  #closed = false;

  constructor(options: DevelopmentRuntimeReferenceOptions) {
    this.#origin = assertDevelopmentOrigin(options.origin);
    if (options.bootstrapBearer.length === 0)
      throw new TypeError('Development runtime reference requires a bootstrap bearer.');
    this.#bootstrapBearer = options.bootstrapBearer;
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#history = options.history;
    this.#client = new RuntimeClient({
      transport: new BunWebSocketRuntimeClientTransport({
        url: webSocketUrlFor(this.#origin),
        webSocketFactory: options.webSocketFactory,
      }),
      clientInfo: options.clientInfo,
      history: options.history,
    });
    this.#view = Object.freeze({
      getSnapshot: () => projectSnapshot(this.#client.snapshotStore.getSnapshot()),
      subscribe: (listener: () => void) => this.#client.snapshotStore.subscribe(listener),
    });
  }

  get view(): DevelopmentRuntimeReferenceView {
    return this.#view;
  }

  async connect(): Promise<void> {
    if (this.#closed) throw new Error('Development runtime reference is closed.');
    this.#connectPromise ??= this.#connect();
    try {
      await this.#connectPromise;
    } finally {
      this.#connectPromise = undefined;
    }
  }

  async query(query: RuntimeQuery): Promise<RuntimeQueryResult> {
    await this.connect();
    return this.#client.query(query);
  }

  listSessions(): Promise<RuntimeQueryResult> {
    return this.query({ schema: 'kite.runtime-query.v1', type: 'list_sessions' });
  }

  async listHistorySessions(
    request: ListRuntimeLogSessionsRequest,
  ): Promise<RuntimeLogSessionPage> {
    return this.#requireHistory().listSessions(request);
  }

  async listHistoryEvents(request: ListRuntimeLogEventsRequest): Promise<RuntimeLogEventPage> {
    return this.#requireHistory().listEvents(request);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    // Closing the sole RuntimeClient connection releases the remote index
    // subscription without an unbounded unsubscribe round trip.
    this.#indexSubscription = undefined;
    await this.#client.close('development_runtime_reference_closed');
  }

  async #connect(): Promise<void> {
    if (!this.#bootstrapped) await this.#bootstrap();
    await this.#client.connect();
    if (!this.#indexSubscription) {
      this.#indexSubscription = await this.#client.subscribeHandle({ scope: 'sessions' });
    }
  }

  async #bootstrap(): Promise<void> {
    const bearer = this.#bootstrapBearer;
    if (bearer.length === 0)
      throw new Error('Development runtime bootstrap bearer is unavailable after its first use.');
    // The carrier accepts this secret once. Clear our only retained copy before
    // awaiting I/O, so failed/replayed bootstrap cannot be retried from memory.
    this.#bootstrapBearer = '';
    const response = await this.#fetch(`${this.#origin}/_kite/bootstrap`, {
      method: 'POST',
      headers: { authorization: `Kite-Dev-Bootstrap ${bearer}` },
      credentials: 'include',
    });
    if (response.status !== 204)
      throw new Error(`Development runtime bootstrap failed with HTTP ${response.status}.`);
    this.#bootstrapped = true;
  }

  #requireHistory(): RuntimeHistoryClient {
    if (!this.#history) throw new DevelopmentRuntimeReferenceHistoryUnavailableError();
    return this.#history;
  }
}

function assertDevelopmentOrigin(value: string): string {
  const url = new URL(value);
  const port = Number(url.port);
  if (
    url.protocol !== 'http:' ||
    url.origin !== value ||
    url.hostname !== '127.0.0.1' ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new TypeError(
      'Development runtime reference origin must be an exact http://127.0.0.1:<port> origin.',
    );
  }
  return url.origin;
}

function webSocketUrlFor(origin: string): string {
  const url = new URL('/rpc', origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function projectSnapshot(
  snapshot: ReturnType<RuntimeClient['snapshotStore']['getSnapshot']>,
): DevelopmentRuntimeReferenceSnapshot {
  const sessions = Object.values(snapshot.sessions)
    .map(({ projection }) =>
      Object.freeze({
        sessionId: projection.sessionId,
        revision: projection.revision,
        lifecycle: projection.lifecycle,
        ...(projection.displayName === undefined ? {} : { displayName: projection.displayName }),
        ...(projection.updatedAt === undefined ? {} : { updatedAt: projection.updatedAt }),
      }),
    )
    .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  return Object.freeze({
    status: snapshot.status,
    ...(snapshot.serverInstanceId === undefined
      ? {}
      : { serverInstanceId: snapshot.serverInstanceId }),
    sessionIndexReady: snapshot.index.ready,
    sessions: Object.freeze(sessions),
  });
}
