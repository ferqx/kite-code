import type {
  AppMcpActionRequest,
  AppMcpActionResponse,
  AppMcpSnapshot,
  AppMcpSnapshotRequest,
  ExactJsonCodec,
  ExecutionStatusRequest,
  ExecutionStatusSnapshot,
  KiteAppControlClient,
  ProviderModelSelectRequest,
  ProviderModelSelectResponse,
  ProviderModelSnapshot,
  ProviderModelSnapshotRequest,
  ReleaseStatusRequest,
  ReleaseStatusSnapshot,
  SkillCatalogRequest,
  SkillCatalogSnapshot,
  WorkspaceTrustDecisionRequest,
  WorkspaceTrustDecisionResponse,
  WorkspaceTrustQueryRequest,
  WorkspaceTrustQueryResponse,
} from '@kite-ai/kite-app-contract';
import {
  executionStatusRequestCodec,
  executionStatusResponseCodec,
  mcpActionRequestCodec,
  mcpActionResponseCodec,
  mcpSnapshotRequestCodec,
  mcpSnapshotResponseCodec,
  providerModelSelectRequestCodec,
  providerModelSelectResponseCodec,
  providerModelSnapshotRequestCodec,
  providerModelSnapshotResponseCodec,
  releaseStatusRequestCodec,
  releaseStatusResponseCodec,
  skillCatalogRequestCodec,
  skillCatalogResponseCodec,
  workspaceTrustDecisionRequestCodec,
  workspaceTrustDecisionResponseCodec,
  workspaceTrustQueryRequestCodec,
  workspaceTrustQueryResponseCodec,
} from '@kite-ai/kite-app-contract';
import {
  assertRuntimeClientEvent,
  RuntimeClient,
  type RuntimeClientConnection,
  type RuntimeClientInfo,
  type RuntimeHistoryClient,
} from '@kite-ai/runtime-client';
import {
  RUNTIME_PROTOCOL_LIMITS,
  type RuntimeProtocolMessage,
  safeDecodeRuntimeProtocolMessage,
} from '@kite-ai/runtime-protocol';
import {
  decodeLocalRuntimeServiceDescriptor,
  decodeLocalRuntimeToken,
  LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
  type LocalRuntimeServiceDescriptor,
  type LocalRuntimeToken,
} from '../service/codecs';
import {
  decodeLocalRuntimeCredentialRequest,
  decodeLocalRuntimeCredentialResult,
  encodeLocalRuntimeCredentialRequest,
  encodeLocalRuntimeCredentialResult,
  type LocalRuntimeCredentialRequest,
  type NativeProviderCredentialRequest,
  type NativeProviderCredentialResult,
} from './codecs';
import type {
  LocalKiteConnection,
  LocalKiteConnectionStatus,
  LocalRuntimeAppControlTransport,
  LocalRuntimeClientOptions,
  LocalRuntimeHistoryTransport,
  LocalRuntimeWebSocketTransport,
  NativeProviderCredentialClient,
} from './connection';

type ListRuntimeLogEventsRequest = Parameters<RuntimeHistoryClient['listEvents']>[0];
type ListRuntimeLogSessionsRequest = Parameters<RuntimeHistoryClient['listSessions']>[0];
type RuntimeLogSessionPage = Awaited<ReturnType<RuntimeHistoryClient['listSessions']>>;
type RuntimeLogEventPage = Awaited<ReturnType<RuntimeHistoryClient['listEvents']>>;
type RuntimeHistorySessionTranscript = Awaited<ReturnType<RuntimeHistoryClient['loadSession']>>;
type RuntimeLogSessionEntry = RuntimeLogSessionPage['entries'][number];
type RuntimeLogSessionCursor = NonNullable<RuntimeLogSessionPage['nextCursor']>;
type RuntimeLogEventEntry = RuntimeLogEventPage['entries'][number];
type RuntimeLogEventDetail = NonNullable<RuntimeLogEventEntry['detail']>;
type RuntimeClientEvent = RuntimeHistorySessionTranscript['events'][number];

/** Native loopback route names are duplicated here intentionally: this package must not import an
 * app-owned Service carrier or make the Service depend on its client implementation. */
export const LOCAL_RUNTIME_CONNECT_PATH = '/_kite/connect' as const;
export const LOCAL_RUNTIME_RPC_PATH = '/rpc' as const;
export const LOCAL_RUNTIME_HISTORY_LIST_SESSIONS_PATH = '/_kite/history/list-sessions' as const;
export const LOCAL_RUNTIME_HISTORY_LIST_EVENTS_PATH = '/_kite/history/list-events' as const;
export const LOCAL_RUNTIME_HISTORY_LOAD_SESSION_PATH = '/_kite/history/load-session' as const;
export const LOCAL_RUNTIME_APP_WORKSPACE_TRUST_QUERY_PATH =
  '/_kite/app/workspace-trust/query' as const;
export const LOCAL_RUNTIME_APP_WORKSPACE_TRUST_DECIDE_PATH =
  '/_kite/app/workspace-trust/decide' as const;
export const LOCAL_RUNTIME_APP_PROVIDER_MODEL_SNAPSHOT_PATH =
  '/_kite/app/provider-model/snapshot' as const;
export const LOCAL_RUNTIME_APP_PROVIDER_MODEL_SELECT_PATH =
  '/_kite/app/provider-model/select' as const;
export const LOCAL_RUNTIME_APP_MCP_SNAPSHOT_PATH = '/_kite/app/mcp/snapshot' as const;
export const LOCAL_RUNTIME_APP_MCP_ACTION_PATH = '/_kite/app/mcp/action' as const;
export const LOCAL_RUNTIME_APP_SKILL_CATALOG_PATH = '/_kite/app/skills/catalog' as const;
export const LOCAL_RUNTIME_APP_EXECUTION_STATUS_PATH = '/_kite/app/execution/status' as const;
export const LOCAL_RUNTIME_APP_RELEASE_STATUS_PATH = '/_kite/app/release/status' as const;
export const LOCAL_RUNTIME_APP_PROVIDER_CREDENTIAL_WRITE_PATH =
  '/_kite/app/provider-credential/write' as const;

export const LOCAL_RUNTIME_ACCESS_AUTHORIZATION_SCHEME = 'Kite-Local-Access' as const;
export const LOCAL_RUNTIME_TICKET_AUTHORIZATION_SCHEME = 'Kite-Local-Ticket' as const;

const DEFAULT_CONNECT_DEADLINE_MS = 5_000;
const DEFAULT_SEND_DEADLINE_MS = 5_000;
const DEFAULT_MAX_BUFFERED_AMOUNT = RUNTIME_PROTOCOL_LIMITS.maxMessageBytes;
const DEFAULT_MAX_QUEUED_MESSAGES = RUNTIME_PROTOCOL_LIMITS.maxOutboundMessages;
const DEFAULT_MAX_HTTP_RESPONSE_BYTES = RUNTIME_PROTOCOL_LIMITS.maxMessageBytes;
const WEBSOCKET_CONNECTING = 0;
const WEBSOCKET_OPEN = 1;
const WEBSOCKET_CLOSING = 2;

export type LocalRuntimeFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface NativeRuntimeWebSocketEvent {
  readonly data?: unknown;
}

export type NativeRuntimeWebSocketEventType = 'open' | 'message' | 'close' | 'error';

/** The small Bun WebSocket subset used by the native connector. */
export interface NativeRuntimeWebSocketLike {
  readonly readyState: number;
  readonly bufferedAmount: number;
  addEventListener(
    type: NativeRuntimeWebSocketEventType,
    listener: (event: NativeRuntimeWebSocketEvent) => void,
  ): void;
  removeEventListener(
    type: NativeRuntimeWebSocketEventType,
    listener: (event: NativeRuntimeWebSocketEvent) => void,
  ): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface NativeRuntimeWebSocketOptions {
  readonly headers: Readonly<Record<string, string>>;
}

export type NativeRuntimeWebSocketFactory = (
  url: string,
  options: NativeRuntimeWebSocketOptions,
) => NativeRuntimeWebSocketLike;

export type LocalRuntimeConnectionErrorCode =
  | 'connection_closed'
  | 'connection_failed'
  | 'service_unavailable'
  | 'invalid_descriptor'
  | 'invalid_access_token'
  | 'unauthorized'
  | 'invalid_request'
  | 'invalid_response'
  | 'instance_mismatch'
  | 'protocol_error';

export class LocalRuntimeConnectionError extends Error {
  readonly code: LocalRuntimeConnectionErrorCode;
  readonly status?: number;

  constructor(code: LocalRuntimeConnectionErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'LocalRuntimeConnectionError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Deliberately narrow state reader for the client. A client can discover only
 * the descriptor and access token. It has no method that can read the control
 * token, which remains exclusively in the lifecycle manager.
 */
export interface LocalRuntimeClientStatePort {
  readDescriptor(): Promise<unknown | undefined>;
  readToken(kind: 'access'): Promise<unknown | undefined>;
}

/** The connector needs only the manager's ensure operation; lifecycle stop/control stays private. */
export interface LocalRuntimeServiceEnsurePort {
  ensure(options?: LocalRuntimeClientOptions): Promise<unknown>;
}

export interface LocalRuntimeConnectorOptions {
  readonly manager: LocalRuntimeServiceEnsurePort;
  readonly state: LocalRuntimeClientStatePort;
  /** Requested Workspace path; the Service performs canonical admission. */
  readonly workspace: string;
  readonly clientInfo: RuntimeClientInfo;
  readonly clientContractRevision?: LocalRuntimeClientOptions['clientContractRevision'];
  readonly fetch?: LocalRuntimeFetch;
  readonly webSocketFactory?: NativeRuntimeWebSocketFactory;
  readonly connectDeadlineMs?: number;
  readonly sendDeadlineMs?: number;
  readonly maxBufferedAmount?: number;
  readonly maxQueuedMessages?: number;
  readonly maxHttpResponseBytes?: number;
}

export interface LocalRuntimeDiscovery {
  readonly descriptor: LocalRuntimeServiceDescriptor;
  readonly accessToken: LocalRuntimeToken;
}

/** Strictly read one descriptor/access pair. This function never requests the control token. */
export async function discoverLocalRuntimeService(
  state: LocalRuntimeClientStatePort,
): Promise<LocalRuntimeDiscovery> {
  let rawDescriptor: unknown | undefined;
  try {
    rawDescriptor = await state.readDescriptor();
  } catch {
    throw new LocalRuntimeConnectionError(
      'service_unavailable',
      'Local Runtime Service state is unavailable.',
    );
  }
  if (rawDescriptor === undefined) {
    throw new LocalRuntimeConnectionError(
      'service_unavailable',
      'Local Runtime Service is not running.',
    );
  }
  let descriptor: LocalRuntimeServiceDescriptor;
  try {
    descriptor = freezeDescriptor(decodeLocalRuntimeServiceDescriptor(rawDescriptor));
  } catch {
    throw new LocalRuntimeConnectionError(
      'invalid_descriptor',
      'Local Runtime Service descriptor is invalid.',
    );
  }

  let rawAccessToken: unknown | undefined;
  try {
    rawAccessToken = await state.readToken('access');
  } catch {
    throw new LocalRuntimeConnectionError(
      'service_unavailable',
      'Local Runtime Service access state is unavailable.',
    );
  }
  let accessToken: LocalRuntimeToken;
  try {
    accessToken = decodeLocalRuntimeToken(rawAccessToken);
  } catch {
    throw new LocalRuntimeConnectionError(
      'invalid_access_token',
      'Local Runtime Service access credential is invalid.',
    );
  }
  return Object.freeze({ descriptor, accessToken });
}

/** Native Runtime WebSocket transport. Each connect obtains a fresh one-shot ticket. */
export class NativeRuntimeWebSocketTransport implements LocalRuntimeWebSocketTransport {
  readonly #resolveDescriptor: () => LocalRuntimeServiceDescriptor;
  readonly #resolveAccessToken: (() => string) | undefined;
  readonly #ticketProvider: () => Promise<string>;
  readonly #webSocketFactory: NativeRuntimeWebSocketFactory;
  readonly #connectDeadlineMs: number;
  readonly #sendDeadlineMs: number;
  readonly #maxBufferedAmount: number;
  readonly #maxQueuedMessages: number;

  constructor(options: NativeRuntimeWebSocketTransportOptions) {
    this.#resolveDescriptor = resolveDescriptorProvider(options.descriptor);
    this.#resolveAccessToken =
      options.accessToken === undefined
        ? undefined
        : () => resolveStringProvider(options.accessToken!);
    this.#ticketProvider = options.ticketProvider ?? createTicketProvider(options);
    this.#webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.#connectDeadlineMs = boundedPositiveInteger(
      options.connectDeadlineMs,
      DEFAULT_CONNECT_DEADLINE_MS,
      'connectDeadlineMs',
    );
    this.#sendDeadlineMs = boundedPositiveInteger(
      options.sendDeadlineMs,
      DEFAULT_SEND_DEADLINE_MS,
      'sendDeadlineMs',
    );
    this.#maxBufferedAmount = boundedPositiveInteger(
      options.maxBufferedAmount,
      DEFAULT_MAX_BUFFERED_AMOUNT,
      'maxBufferedAmount',
    );
    this.#maxQueuedMessages = boundedPositiveInteger(
      options.maxQueuedMessages,
      DEFAULT_MAX_QUEUED_MESSAGES,
      'maxQueuedMessages',
    );
  }

  get descriptor(): LocalRuntimeServiceDescriptor {
    try {
      return freezeDescriptor(this.#resolveDescriptor());
    } catch {
      throw new LocalRuntimeConnectionError(
        'invalid_descriptor',
        'Local Runtime Service descriptor is invalid.',
      );
    }
  }

  get accessToken(): string {
    if (!this.#resolveAccessToken) {
      throw new LocalRuntimeConnectionError(
        'invalid_access_token',
        'Local Runtime Service access credential is unavailable.',
      );
    }
    const value = this.#resolveAccessToken();
    try {
      return decodeLocalRuntimeToken(value);
    } catch {
      throw new LocalRuntimeConnectionError(
        'invalid_access_token',
        'Local Runtime Service access credential is invalid.',
      );
    }
  }

  async connect(): Promise<RuntimeClientConnection> {
    const descriptor = this.descriptor;
    const ticket = await this.#ticketProvider();
    let currentDescriptor: LocalRuntimeServiceDescriptor;
    try {
      currentDescriptor = freezeDescriptor(this.#resolveDescriptor());
    } catch {
      throw new LocalRuntimeConnectionError(
        'invalid_descriptor',
        'Local Runtime Service descriptor is invalid.',
      );
    }
    if (!sameServiceInstance(descriptor, currentDescriptor)) {
      throw new LocalRuntimeConnectionError(
        'instance_mismatch',
        'Service descriptor changed while obtaining a connection ticket.',
      );
    }
    assertTicket(ticket);
    const socket = this.#webSocketFactory(descriptor.endpoint.websocketUrl, {
      headers: {
        authorization: `${LOCAL_RUNTIME_TICKET_AUTHORIZATION_SCHEME} ${ticket}`,
        origin: descriptor.endpoint.origin,
      },
    });
    const connection = new NativeRuntimeWebSocketConnection({
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

export interface NativeRuntimeWebSocketTransportOptions {
  readonly descriptor: LocalRuntimeServiceDescriptor | (() => LocalRuntimeServiceDescriptor);
  /** Supply a fresh ticket callback when the descriptor/access token are managed externally. */
  readonly ticketProvider?: () => Promise<string>;
  readonly accessToken?: string | (() => string);
  readonly workspace?: string;
  readonly fetch?: LocalRuntimeFetch;
  readonly webSocketFactory?: NativeRuntimeWebSocketFactory;
  readonly connectDeadlineMs?: number;
  readonly sendDeadlineMs?: number;
  readonly maxBufferedAmount?: number;
  readonly maxQueuedMessages?: number;
}

export function createNativeRuntimeWebSocketTransport(
  options: NativeRuntimeWebSocketTransportOptions,
): NativeRuntimeWebSocketTransport {
  return new NativeRuntimeWebSocketTransport(options);
}

/** Exact three-route History client used by LocalKiteConnection. */
export class NativeRuntimeHistoryClient {
  readonly #request: NativeRuntimeHttpRequest;

  constructor(request: NativeRuntimeHttpRequest) {
    this.#request = request;
  }

  async listSessions(request: ListRuntimeLogSessionsRequest): Promise<RuntimeLogSessionPage> {
    try {
      assertListRuntimeLogSessionsRequest(request);
    } catch {
      throw invalidRequestError();
    }
    const value = await this.#request(LOCAL_RUNTIME_HISTORY_LIST_SESSIONS_PATH, request);
    return decodeRuntimeLogSessionPage(value);
  }

  async listEvents(request: ListRuntimeLogEventsRequest): Promise<RuntimeLogEventPage> {
    try {
      assertListRuntimeLogEventsRequest(request);
    } catch {
      throw invalidRequestError();
    }
    const value = await this.#request(LOCAL_RUNTIME_HISTORY_LIST_EVENTS_PATH, request);
    return decodeRuntimeLogEventPage(value);
  }

  async loadSession(sessionId: string): Promise<RuntimeHistorySessionTranscript> {
    if (!boundedString(sessionId, 512)) throw invalidRequestError();
    const value = await this.#request(LOCAL_RUNTIME_HISTORY_LOAD_SESSION_PATH, {
      sessionId,
    });
    return decodeRuntimeHistoryTranscript(value);
  }
}

export function createNativeRuntimeHistoryClient(
  request: NativeRuntimeHttpRequest,
): NativeRuntimeHistoryClient {
  return new NativeRuntimeHistoryClient(request);
}

export interface NativeRuntimeHttpTransportOptions {
  readonly descriptor: LocalRuntimeServiceDescriptor | (() => LocalRuntimeServiceDescriptor);
  readonly accessToken: string | (() => string);
  readonly fetch?: LocalRuntimeFetch;
  readonly maxResponseBytes?: number;
}

/** Concrete three-route transport retained for callers that do not need a full connection. */
export class NativeRuntimeHistoryTransport implements LocalRuntimeHistoryTransport {
  readonly #descriptor: () => LocalRuntimeServiceDescriptor;
  readonly #accessToken: () => string;
  readonly #client: NativeRuntimeHistoryClient;

  constructor(options: NativeRuntimeHttpTransportOptions) {
    this.#descriptor = resolveDescriptorProvider(options.descriptor);
    this.#accessToken = () => resolveStringProvider(options.accessToken);
    this.#client = new NativeRuntimeHistoryClient(
      createNativeHttpRequest({
        descriptor: this.#descriptor,
        accessToken: this.#accessToken,
        fetch: options.fetch,
        maxResponseBytes: options.maxResponseBytes,
      }),
    );
  }

  get descriptor(): LocalRuntimeServiceDescriptor {
    return freezeDescriptor(this.#descriptor());
  }

  get accessToken(): string {
    return decodeAccessToken(this.#accessToken());
  }

  listSessions(request: ListRuntimeLogSessionsRequest): Promise<RuntimeLogSessionPage> {
    return this.#client.listSessions(request);
  }

  listEvents(request: ListRuntimeLogEventsRequest): Promise<RuntimeLogEventPage> {
    return this.#client.listEvents(request);
  }

  loadSession(sessionId: string): Promise<RuntimeHistorySessionTranscript> {
    return this.#client.loadSession(sessionId);
  }
}

export function createNativeRuntimeHistoryTransport(
  options: NativeRuntimeHttpTransportOptions,
): NativeRuntimeHistoryTransport {
  return new NativeRuntimeHistoryTransport(options);
}

/** Exact App Control facade; every method has a fixed route and dedicated codec pair. */
export class NativeKiteAppControlClient implements KiteAppControlClient {
  readonly #request: NativeRuntimeHttpRequest;

  constructor(request: NativeRuntimeHttpRequest) {
    this.#request = request;
  }

  async queryWorkspaceTrust(
    request: WorkspaceTrustQueryRequest,
  ): Promise<WorkspaceTrustQueryResponse> {
    return this.#call(
      LOCAL_RUNTIME_APP_WORKSPACE_TRUST_QUERY_PATH,
      workspaceTrustQueryRequestCodec,
      workspaceTrustQueryResponseCodec,
      request,
    );
  }

  async decideWorkspaceTrust(
    request: WorkspaceTrustDecisionRequest,
  ): Promise<WorkspaceTrustDecisionResponse> {
    return this.#call(
      LOCAL_RUNTIME_APP_WORKSPACE_TRUST_DECIDE_PATH,
      workspaceTrustDecisionRequestCodec,
      workspaceTrustDecisionResponseCodec,
      request,
    );
  }

  async getProviderModelSnapshot(
    request: ProviderModelSnapshotRequest,
  ): Promise<ProviderModelSnapshot> {
    return this.#call(
      LOCAL_RUNTIME_APP_PROVIDER_MODEL_SNAPSHOT_PATH,
      providerModelSnapshotRequestCodec,
      providerModelSnapshotResponseCodec,
      request,
    );
  }

  async selectProviderModel(
    request: ProviderModelSelectRequest,
  ): Promise<ProviderModelSelectResponse> {
    return this.#call(
      LOCAL_RUNTIME_APP_PROVIDER_MODEL_SELECT_PATH,
      providerModelSelectRequestCodec,
      providerModelSelectResponseCodec,
      request,
    );
  }

  async getMcpSnapshot(request: AppMcpSnapshotRequest): Promise<AppMcpSnapshot> {
    return this.#call(
      LOCAL_RUNTIME_APP_MCP_SNAPSHOT_PATH,
      mcpSnapshotRequestCodec,
      mcpSnapshotResponseCodec,
      request,
    );
  }

  async applyMcpAction(request: AppMcpActionRequest): Promise<AppMcpActionResponse> {
    return this.#call(
      LOCAL_RUNTIME_APP_MCP_ACTION_PATH,
      mcpActionRequestCodec,
      mcpActionResponseCodec,
      request,
    );
  }

  async getSkillCatalog(request: SkillCatalogRequest): Promise<SkillCatalogSnapshot> {
    return this.#call(
      LOCAL_RUNTIME_APP_SKILL_CATALOG_PATH,
      skillCatalogRequestCodec,
      skillCatalogResponseCodec,
      request,
    );
  }

  async getExecutionStatus(request: ExecutionStatusRequest): Promise<ExecutionStatusSnapshot> {
    return this.#call(
      LOCAL_RUNTIME_APP_EXECUTION_STATUS_PATH,
      executionStatusRequestCodec,
      executionStatusResponseCodec,
      request,
    );
  }

  async getReleaseStatus(request: ReleaseStatusRequest): Promise<ReleaseStatusSnapshot> {
    return this.#call(
      LOCAL_RUNTIME_APP_RELEASE_STATUS_PATH,
      releaseStatusRequestCodec,
      releaseStatusResponseCodec,
      request,
    );
  }

  #call<Request, ResponseValue>(
    path: string,
    requestCodec: ExactJsonCodec<Request>,
    responseCodec: ExactJsonCodec<ResponseValue>,
    request: Request,
  ): Promise<ResponseValue> {
    let encoded: unknown;
    try {
      encoded = requestCodec.encode(request);
    } catch {
      throw invalidRequestError();
    }
    return this.#request(path, encoded).then((value) => {
      try {
        const response = responseCodec.decode(value);
        assertMatchingWorkspaceIdentity(request, response);
        return response;
      } catch {
        throw invalidResponseError();
      }
    });
  }
}

export function createNativeKiteAppControlClient(
  request: NativeRuntimeHttpRequest,
): NativeKiteAppControlClient {
  return new NativeKiteAppControlClient(request);
}

/** Concrete exact App Control transport; no dynamic method or generic RPC escape hatch. */
export class NativeRuntimeAppControlTransport implements LocalRuntimeAppControlTransport {
  readonly #descriptor: () => LocalRuntimeServiceDescriptor;
  readonly #accessToken: () => string;
  readonly #client: NativeKiteAppControlClient;

  constructor(options: NativeRuntimeHttpTransportOptions) {
    this.#descriptor = resolveDescriptorProvider(options.descriptor);
    this.#accessToken = () => resolveStringProvider(options.accessToken);
    this.#client = new NativeKiteAppControlClient(
      createNativeHttpRequest({
        descriptor: this.#descriptor,
        accessToken: this.#accessToken,
        fetch: options.fetch,
        maxResponseBytes: options.maxResponseBytes,
      }),
    );
  }

  get descriptor(): LocalRuntimeServiceDescriptor {
    return freezeDescriptor(this.#descriptor());
  }

  get accessToken(): string {
    return decodeAccessToken(this.#accessToken());
  }

  connect(): Promise<KiteAppControlClient> {
    return Promise.resolve(this.#client);
  }
}

export function createNativeRuntimeAppControlTransport(
  options: NativeRuntimeHttpTransportOptions,
): NativeRuntimeAppControlTransport {
  return new NativeRuntimeAppControlTransport(options);
}

/**
 * Native exact connection. Manager ensure and local state discovery happen on
 * initial connect and every explicit reconnect; no mutation is ever replayed.
 */
export class NativeLocalKiteConnection implements LocalKiteConnection {
  readonly #manager: LocalRuntimeServiceEnsurePort;
  readonly #state: LocalRuntimeClientStatePort;
  readonly #workspace: string;
  readonly #clientInfo: RuntimeClientInfo;
  readonly #clientContractRevision: LocalRuntimeClientOptions['clientContractRevision'];
  readonly #fetch: LocalRuntimeFetch;
  readonly #webSocketFactory: NativeRuntimeWebSocketFactory;
  readonly #transport: NativeRuntimeWebSocketTransport;
  readonly #runtime: RuntimeClient;
  readonly #history: NativeRuntimeHistoryClient;
  readonly #app: NativeKiteAppControlClient;
  readonly #credential: NativeProviderCredentialClient;
  readonly #maxHttpResponseBytes: number;
  #service: LocalRuntimeServiceDescriptor | undefined;
  #accessToken: LocalRuntimeToken | undefined;
  #preparePromise: Promise<number> | undefined;
  #connectPromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;
  #identityGeneration = 0;
  #closed = false;

  constructor(options: LocalRuntimeConnectorOptions) {
    if (!boundedString(options.workspace, 4_096)) {
      throw new TypeError('Local Runtime connector workspace must be a bounded path.');
    }
    this.#manager = options.manager;
    this.#state = options.state;
    this.#workspace = options.workspace;
    this.#clientInfo = Object.freeze({ ...options.clientInfo });
    this.#clientContractRevision =
      options.clientContractRevision ?? LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_;
    this.#maxHttpResponseBytes = boundedPositiveInteger(
      options.maxHttpResponseBytes,
      DEFAULT_MAX_HTTP_RESPONSE_BYTES,
      'maxHttpResponseBytes',
    );
    this.#fetch = options.fetch ?? defaultFetch;
    this.#webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.#transport = new NativeRuntimeWebSocketTransport({
      descriptor: () => this.#requireService(),
      ticketProvider: () => this.#issueTicket(),
      accessToken: () => this.#requireAccessToken(),
      webSocketFactory: this.#webSocketFactory,
      connectDeadlineMs: options.connectDeadlineMs,
      sendDeadlineMs: options.sendDeadlineMs,
      maxBufferedAmount: options.maxBufferedAmount,
      maxQueuedMessages: options.maxQueuedMessages,
    });
    const request: NativeRuntimeHttpRequest = (path, body, signal) =>
      this.#post(path, body, signal, this.#maxHttpResponseBytes);
    this.#history = new NativeRuntimeHistoryClient(request);
    this.#app = new NativeKiteAppControlClient(request);
    this.#credential = Object.freeze({
      writeProviderCredential: (
        requestValue: NativeProviderCredentialRequest,
        requestOptions?: { readonly signal?: AbortSignal },
      ) =>
        this.#writeProviderCredential(
          requestValue,
          requestOptions?.signal,
          this.#maxHttpResponseBytes,
        ),
    });
    this.#runtime = new RuntimeClient({
      transport: this.#transport,
      clientInfo: this.#clientInfo,
      history: this.#history,
    });
  }

  get runtime(): RuntimeClient {
    return this.#runtime;
  }

  get history(): NativeRuntimeHistoryClient {
    return this.#history;
  }

  get app(): NativeKiteAppControlClient {
    return this.#app;
  }

  get credential(): NativeProviderCredentialClient {
    return this.#credential;
  }

  get service(): LocalRuntimeServiceDescriptor {
    return this.#requireService();
  }

  get status(): LocalKiteConnectionStatus {
    if (this.#closed) return 'closed';
    const status = this.#runtime.snapshotStore.getSnapshot().status;
    if (status === 'connecting') return 'connecting';
    if (status === 'reconnecting') return 'reconnecting';
    if (status === 'active') return 'active';
    if (status === 'closed' || status === 'draining') return 'closed';
    return 'disconnected';
  }

  get generation(): number {
    return this.#runtime.snapshotStore.getSnapshot().connectionGeneration;
  }

  get snapshotStore(): RuntimeClient['snapshotStore'] {
    return this.#runtime.snapshotStore;
  }

  subscribe(listener: () => void): () => void {
    return this.#runtime.snapshotStore.subscribe(listener);
  }

  async prepareAppControl(): Promise<void> {
    if (this.#closed) throw closedError();
    await this.#prepareIdentity(false);
  }

  async connect(): Promise<void> {
    if (this.#closed) throw closedError();
    if (this.#runtime.snapshotStore.getSnapshot().status === 'active') return;
    this.#connectPromise ??= this.#connect(false);
    try {
      await this.#connectPromise;
    } finally {
      this.#connectPromise = undefined;
    }
  }

  async reconnect(): Promise<void> {
    if (this.#closed) throw closedError();
    this.#connectPromise ??= this.#connect(true);
    try {
      await this.#connectPromise;
    } finally {
      this.#connectPromise = undefined;
    }
  }

  async close(reason = 'runtime_client_closed'): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    const pendingPrepare = this.#preparePromise;
    const pendingConnect = this.#connectPromise;
    this.#closePromise = (async () => {
      try {
        await this.#runtime.close(reason);
      } finally {
        await pendingPrepare?.catch(() => undefined);
        await pendingConnect?.catch(() => undefined);
      }
    })();
    return this.#closePromise;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  async #connect(reconnect: boolean): Promise<void> {
    const identityGeneration = await this.#prepareIdentity(reconnect);
    try {
      if (reconnect && this.#runtime.snapshotStore.getSnapshot().connectionGeneration > 0) {
        await this.#runtime.reconnect();
      } else {
        await this.#runtime.connect();
      }
      if (this.#closed || identityGeneration !== this.#identityGeneration) throw closedError();
      this.#assertRuntimeInstance();
    } catch (error) {
      if (error instanceof LocalRuntimeConnectionError) throw error;
      if (error instanceof Error && error.message === 'Runtime Client is closed.') {
        throw closedError();
      }
      throw error;
    }
  }

  async #prepareIdentity(force: boolean): Promise<number> {
    if (!force && this.#service && this.#accessToken) return this.#identityGeneration;
    const pending = this.#preparePromise;
    if (pending) return pending;
    const preparation = this.#discoverIdentity();
    this.#preparePromise = preparation;
    try {
      return await preparation;
    } finally {
      if (this.#preparePromise === preparation) this.#preparePromise = undefined;
    }
  }

  async #discoverIdentity(): Promise<number> {
    const ensured = await this.#ensureService();
    if (this.#closed) throw closedError();
    const discovered = await discoverLocalRuntimeService(this.#state);
    if (this.#closed) throw closedError();
    if (ensured && !sameServiceInstance(ensured, discovered.descriptor)) {
      throw new LocalRuntimeConnectionError(
        'instance_mismatch',
        'Local Runtime Service identity changed during discovery.',
      );
    }
    const identityGeneration = ++this.#identityGeneration;
    this.#service = discovered.descriptor;
    this.#accessToken = discovered.accessToken;
    return identityGeneration;
  }

  async #ensureService(): Promise<LocalRuntimeServiceDescriptor | undefined> {
    let value: unknown;
    try {
      value = await this.#manager.ensure({
        clientInfo: this.#clientInfo,
        clientContractRevision: this.#clientContractRevision,
      });
    } catch {
      throw new LocalRuntimeConnectionError(
        'service_unavailable',
        'Local Runtime Service could not be ensured.',
      );
    }
    if (value === undefined) return undefined;
    const descriptor = extractEnsuredDescriptor(value);
    if (descriptor === undefined && isNonAppliedLifecycleResult(value)) {
      if (value.outcome === 'incompatible' && value.diagnostic === 'build_mismatch') {
        throw new LocalRuntimeConnectionError(
          'protocol_error',
          'Local Runtime Service is ready for a different build (build_mismatch). Stop it from the checkout or build that started it, or use a different --kite-home.',
        );
      }
      throw new LocalRuntimeConnectionError(
        value.outcome === 'incompatible' ? 'protocol_error' : 'service_unavailable',
        'Local Runtime Service did not become ready.',
      );
    }
    return descriptor;
  }

  async #issueTicket(): Promise<string> {
    const service = this.#requireService();
    const accessToken = this.#requireAccessToken();
    const value = await this.#post(
      LOCAL_RUNTIME_CONNECT_PATH,
      { workspace: this.#workspace },
      undefined,
    );
    if (!isRecord(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'ticket')) {
      throw invalidResponseError();
    }
    const ticket = value.ticket;
    try {
      assertTicket(ticket);
    } catch {
      throw invalidResponseError();
    }
    // Keep these reads explicit so a future request implementation cannot silently issue a ticket
    // from a descriptor/token pair belonging to a different Service instance.
    if (service.endpoint.origin.length === 0 || accessToken.length === 0) throw closedError();
    return ticket;
  }

  async #writeProviderCredential(
    request: NativeProviderCredentialRequest,
    signal?: AbortSignal,
    maxResponseBytes?: number,
  ): Promise<NativeProviderCredentialResult> {
    let decoded: LocalRuntimeCredentialRequest;
    try {
      decoded = decodeLocalRuntimeCredentialRequest(request);
      if (decoded.operation !== 'write_provider_api_key') throw new TypeError('wrong operation');
    } catch {
      throw invalidRequestError();
    }
    const value = await this.#post(
      LOCAL_RUNTIME_APP_PROVIDER_CREDENTIAL_WRITE_PATH,
      encodeLocalRuntimeCredentialRequest(decoded),
      signal,
      maxResponseBytes,
    );
    try {
      const result = decodeLocalRuntimeCredentialResult(value);
      if (result.operation !== 'write_provider_api_key') throw new TypeError('wrong operation');
      return encodeLocalRuntimeCredentialResult(result) as NativeProviderCredentialResult;
    } catch {
      throw invalidResponseError();
    }
  }

  async #post(
    path: string,
    body: unknown,
    signal?: AbortSignal,
    maxResponseBytes?: number,
    refreshOnUnauthorized = true,
  ): Promise<unknown> {
    if (this.#closed) throw closedError();
    const service = this.#requireService();
    const accessToken = this.#requireAccessToken();
    const identityGeneration = this.#identityGeneration;
    const url = serviceUrl(service.endpoint.origin, path);
    let encodedBody: string;
    try {
      encodedBody = JSON.stringify(body);
    } catch {
      throw invalidRequestError();
    }
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: 'POST',
        headers: {
          authorization: `${LOCAL_RUNTIME_ACCESS_AUTHORIZATION_SCHEME} ${accessToken}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        credentials: 'omit',
        body: encodedBody,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch {
      throw new LocalRuntimeConnectionError(
        signal?.aborted ? 'connection_closed' : 'connection_failed',
        'Local Runtime Service request failed.',
      );
    }
    this.#assertHttpIdentity(service.instanceId, identityGeneration);
    if (
      response.status === 401 &&
      refreshOnUnauthorized &&
      this.#runtime.snapshotStore.getSnapshot().connectionGeneration === 0
    ) {
      // Pre-Runtime App Control can legitimately wait on an in-person Trust decision longer than
      // a one-shot Worker capability TTL. A 401 is produced before route parsing or dispatch, so
      // refreshing the exact Coordinator/Worker identity and retrying once cannot replay a
      // mutation. Once Runtime is connected, callers must use explicit reconnect instead.
      await this.#prepareIdentity(true);
      return this.#post(path, body, signal, maxResponseBytes, false);
    }
    if (response.status !== 200) {
      throw new LocalRuntimeConnectionError(
        response.status === 400
          ? 'invalid_request'
          : response.status === 401 || response.status === 403
            ? 'unauthorized'
            : 'service_unavailable',
        'Local Runtime Service rejected the request.',
        response.status,
      );
    }
    const value = await readJsonResponse(
      response,
      maxResponseBytes ?? DEFAULT_MAX_HTTP_RESPONSE_BYTES,
    );
    this.#assertHttpIdentity(service.instanceId, identityGeneration);
    return value;
  }

  #assertHttpIdentity(instanceId: string, identityGeneration: number): void {
    if (this.#closed) throw closedError();
    if (
      this.#identityGeneration !== identityGeneration ||
      this.#service?.instanceId !== instanceId
    ) {
      throw new LocalRuntimeConnectionError(
        'connection_closed',
        'Local Runtime response belongs to a replaced Service connection.',
      );
    }
  }

  #requireService(): LocalRuntimeServiceDescriptor {
    if (!this.#service)
      throw new LocalRuntimeConnectionError('service_unavailable', 'Service is not connected.');
    return this.#service;
  }

  #requireAccessToken(): LocalRuntimeToken {
    if (!this.#accessToken) {
      throw new LocalRuntimeConnectionError(
        'invalid_access_token',
        'Local Runtime Service access credential is unavailable.',
      );
    }
    return this.#accessToken;
  }

  #assertRuntimeInstance(): void {
    const expected = this.#requireService().instanceId;
    const actual = this.#runtime.snapshotStore.getSnapshot().serverInstanceId;
    if (actual !== expected) {
      void this.#runtime.close('runtime_instance_mismatch').catch(() => undefined);
      this.#closed = true;
      throw new LocalRuntimeConnectionError(
        'instance_mismatch',
        'Runtime handshake belongs to a different Service instance.',
      );
    }
  }
}

export function createLocalKiteConnection(
  options: LocalRuntimeConnectorOptions,
): NativeLocalKiteConnection {
  return new NativeLocalKiteConnection(options);
}

/** Async convenience for callers that want ensure + connect as one operation. */
export async function connectLocalKiteConnection(
  options: LocalRuntimeConnectorOptions,
): Promise<NativeLocalKiteConnection> {
  const connection = createLocalKiteConnection(options);
  try {
    await connection.connect();
    return connection;
  } catch (error) {
    await connection.close('runtime_connect_failed').catch(() => undefined);
    throw error;
  }
}

/** Descriptive aliases used by Native-only app integration code. */
export const createNativeLocalKiteConnection = createLocalKiteConnection;
export const connectNativeLocalKiteConnection = connectLocalKiteConnection;

export type NativeRuntimeHttpRequest = (
  path: string,
  body: unknown,
  signal?: AbortSignal,
) => Promise<unknown>;

interface NativeRuntimeWebSocketTransportTicketOptions {
  readonly descriptor: LocalRuntimeServiceDescriptor | (() => LocalRuntimeServiceDescriptor);
  readonly accessToken: string | (() => string);
  readonly workspace: string;
  readonly fetch?: LocalRuntimeFetch;
}

function createTicketProvider(
  options: NativeRuntimeWebSocketTransportOptions,
): () => Promise<string> {
  if (options.accessToken === undefined || options.workspace === undefined) {
    throw new TypeError(
      'Native Runtime WebSocket transport requires a ticket provider or access credentials.',
    );
  }
  const descriptor = resolveDescriptorProvider(options.descriptor);
  return () =>
    requestConnectTicket({
      descriptor,
      accessToken: options.accessToken!,
      workspace: options.workspace!,
      fetch: options.fetch,
    });
}

async function requestConnectTicket(
  options: NativeRuntimeWebSocketTransportTicketOptions,
): Promise<string> {
  let descriptor: LocalRuntimeServiceDescriptor;
  try {
    descriptor = freezeDescriptor(resolveDescriptorProvider(options.descriptor)());
  } catch {
    throw new LocalRuntimeConnectionError(
      'invalid_descriptor',
      'Local Runtime Service descriptor is invalid.',
    );
  }
  const accessToken = resolveStringProvider(options.accessToken);
  try {
    decodeLocalRuntimeToken(accessToken);
  } catch {
    throw new LocalRuntimeConnectionError('invalid_access_token', 'Access credential is invalid.');
  }
  if (!boundedString(options.workspace, 4_096)) throw invalidRequestError();
  const fetcher = options.fetch ?? defaultFetch;
  let response: Response;
  try {
    response = await fetcher(serviceUrl(descriptor.endpoint.origin, LOCAL_RUNTIME_CONNECT_PATH), {
      method: 'POST',
      headers: {
        authorization: `${LOCAL_RUNTIME_ACCESS_AUTHORIZATION_SCHEME} ${accessToken}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      credentials: 'omit',
      body: JSON.stringify({ workspace: options.workspace }),
    });
  } catch {
    throw new LocalRuntimeConnectionError(
      'connection_failed',
      'Local Runtime Service connect failed.',
    );
  }
  if (response.status !== 200) {
    throw new LocalRuntimeConnectionError(
      response.status === 400
        ? 'invalid_request'
        : response.status === 401 || response.status === 403
          ? 'unauthorized'
          : 'service_unavailable',
      'Local Runtime Service connect was rejected.',
      response.status,
    );
  }
  const value = await readJsonResponse(response, DEFAULT_MAX_HTTP_RESPONSE_BYTES);
  if (!isRecord(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'ticket')) {
    throw invalidResponseError();
  }
  const ticket = value.ticket;
  assertTicket(ticket);
  return ticket;
}

class NativeRuntimeWebSocketConnection implements RuntimeClientConnection {
  readonly #socket: NativeRuntimeWebSocketLike;
  readonly #sendDeadlineMs: number;
  readonly #maxBufferedAmount: number;
  readonly #queue: NativeRuntimeMessageQueue;
  readonly #onOpen = (): void => this.#opened();
  readonly #onMessage = (event: NativeRuntimeWebSocketEvent): void => this.#received(event);
  readonly #onClose = (): void => this.#failed('Runtime WebSocket connection closed.');
  readonly #onError = (): void => this.#failed('Runtime WebSocket connection failed.');
  #openPromise: Promise<void>;
  #resolveOpen!: () => void;
  #rejectOpen!: (reason: Error) => void;
  #connectTimer: ReturnType<typeof setTimeout> | undefined;
  #failure: Error | undefined;
  #sendTail = Promise.resolve();
  #pendingSends = 0;
  #closed = false;

  constructor(options: {
    readonly socket: NativeRuntimeWebSocketLike;
    readonly connectDeadlineMs: number;
    readonly sendDeadlineMs: number;
    readonly maxBufferedAmount: number;
    readonly maxQueuedMessages: number;
  }) {
    this.#socket = options.socket;
    this.#sendDeadlineMs = options.sendDeadlineMs;
    this.#maxBufferedAmount = options.maxBufferedAmount;
    this.#queue = new NativeRuntimeMessageQueue(options.maxQueuedMessages);
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
    if (this.#socket.readyState === WEBSOCKET_OPEN) this.#opened();
    else if (this.#socket.readyState !== WEBSOCKET_CONNECTING) {
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
    if (new TextEncoder().encode(frame).byteLength > RUNTIME_PROTOCOL_LIMITS.maxMessageBytes) {
      throw new TypeError('Runtime WebSocket message exceeds the protocol limit.');
    }
    if (++this.#pendingSends > RUNTIME_PROTOCOL_LIMITS.maxOutboundMessages) {
      this.#pendingSends -= 1;
      this.#failed('Runtime WebSocket outbound queue exceeded its bound.', 1013);
      throw this.#connectionError();
    }
    const action = async (): Promise<void> => {
      await this.#waitForWritableSocket();
      try {
        this.#socket.send(frame);
      } catch {
        this.#failed('Runtime WebSocket send failed.');
        throw this.#connectionError();
      }
      await this.#waitForWritableSocket();
    };
    const current = this.#sendTail.then(action, action);
    this.#sendTail = current.catch(() => undefined);
    try {
      await current;
    } finally {
      this.#pendingSends -= 1;
    }
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
    if (this.#socket.readyState < WEBSOCKET_CLOSING) {
      try {
        this.#socket.close(1000, reason);
      } catch {
        // Socket close is best-effort; RuntimeClient owns the stable error surface.
      }
    }
  }

  #opened(): void {
    if (this.#closed || this.#failure) return;
    this.#clearConnectTimer();
    this.#resolveOpen();
  }

  #received(event: NativeRuntimeWebSocketEvent): void {
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
    if (!safeDecodeRuntimeProtocolMessage(value).success) {
      this.#failed('Runtime WebSocket received an invalid protocol message.', 1002);
      return;
    }
    if (!this.#queue.push(value))
      this.#failed('Runtime WebSocket receive queue exceeded its bound.', 1013);
  }

  #failed(message: string, closeCode = 1011): void {
    if (this.#failure || this.#closed) return;
    this.#failure = new Error(message);
    this.#clearConnectTimer();
    this.#removeListeners();
    this.#queue.fail(this.#failure);
    this.#rejectOpen(this.#failure);
    if (this.#socket.readyState < WEBSOCKET_CLOSING) {
      try {
        this.#socket.close(closeCode, 'runtime_websocket_failed');
      } catch {
        // Already failed; no raw socket exception crosses the client boundary.
      }
    }
  }

  async #waitForWritableSocket(): Promise<void> {
    const deadline = Date.now() + this.#sendDeadlineMs;
    while (true) {
      if (this.#failure || this.#closed || this.#socket.readyState !== WEBSOCKET_OPEN) {
        throw this.#connectionError();
      }
      if (this.#socket.bufferedAmount <= this.#maxBufferedAmount) return;
      if (Date.now() >= deadline) {
        this.#failed('Runtime WebSocket send deadline exceeded.', 1013);
        throw this.#connectionError();
      }
      await delay(Math.min(5, Math.max(1, deadline - Date.now())));
    }
  }

  #connectionError(): Error {
    return (
      this.#failure ??
      new LocalRuntimeConnectionError('connection_closed', 'Runtime WebSocket is closed.')
    );
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

class NativeRuntimeMessageQueue {
  readonly #items: unknown[] = [];
  readonly #waiters = new Set<{
    readonly resolve: (result: IteratorResult<unknown>) => void;
    readonly reject: (reason: Error) => void;
  }>();
  readonly #maxMessages: number;
  #failure: Error | undefined;
  #closed = false;

  constructor(maxMessages: number) {
    this.#maxMessages = maxMessages;
  }

  push(value: unknown): boolean {
    if (this.#closed || this.#failure || this.#items.length >= this.#maxMessages) return false;
    const waiter = this.#waiters.values().next().value;
    if (waiter) {
      this.#waiters.delete(waiter);
      waiter.resolve({ done: false, value });
      return true;
    }
    this.#items.push(value);
    return true;
  }

  fail(error: Error): void {
    if (this.#closed || this.#failure) return;
    this.#failure = error;
    this.#items.length = 0;
    for (const waiter of this.#waiters) waiter.reject(error);
    this.#waiters.clear();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#items.length = 0;
    for (const waiter of this.#waiters) waiter.resolve({ done: true, value: undefined });
    this.#waiters.clear();
  }

  iterable(): AsyncIterable<unknown> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<unknown>> => {
          if (this.#failure) return Promise.reject(this.#failure);
          const value = this.#items.shift();
          if (value !== undefined) return Promise.resolve({ done: false, value });
          if (this.#closed) return Promise.resolve({ done: true, value: undefined });
          return new Promise<IteratorResult<unknown>>((resolve, reject) =>
            this.#waiters.add({ resolve, reject }),
          );
        },
        return: async (): Promise<IteratorResult<unknown>> => {
          this.close();
          return { done: true, value: undefined };
        },
      }),
    };
  }
}

function resolveDescriptorProvider(
  value: LocalRuntimeServiceDescriptor | (() => LocalRuntimeServiceDescriptor),
): () => LocalRuntimeServiceDescriptor {
  return typeof value === 'function' ? value : () => value;
}

function resolveStringProvider(value: string | (() => string)): string {
  return typeof value === 'function' ? value() : value;
}

function defaultFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return globalThis.fetch(input, init);
}

function createNativeHttpRequest(options: {
  readonly descriptor: () => LocalRuntimeServiceDescriptor;
  readonly accessToken: () => string;
  readonly fetch?: LocalRuntimeFetch;
  readonly maxResponseBytes?: number;
}): NativeRuntimeHttpRequest {
  const fetcher = options.fetch ?? defaultFetch;
  const maxResponseBytes = boundedPositiveInteger(
    options.maxResponseBytes,
    DEFAULT_MAX_HTTP_RESPONSE_BYTES,
    'maxResponseBytes',
  );
  return async (path, body, signal) => {
    let descriptor: LocalRuntimeServiceDescriptor;
    let accessToken: string;
    try {
      descriptor = freezeDescriptor(options.descriptor());
      accessToken = decodeAccessToken(options.accessToken());
    } catch (error) {
      if (error instanceof LocalRuntimeConnectionError) throw error;
      throw new LocalRuntimeConnectionError(
        'invalid_descriptor',
        'Local Runtime Service identity is invalid.',
      );
    }
    let encodedBody: string;
    try {
      encodedBody = JSON.stringify(body);
    } catch {
      throw invalidRequestError();
    }
    let response: Response;
    try {
      response = await fetcher(serviceUrl(descriptor.endpoint.origin, path), {
        method: 'POST',
        headers: {
          authorization: `${LOCAL_RUNTIME_ACCESS_AUTHORIZATION_SCHEME} ${accessToken}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        credentials: 'omit',
        body: encodedBody,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch {
      throw new LocalRuntimeConnectionError(
        signal?.aborted ? 'connection_closed' : 'connection_failed',
        'Local Runtime Service request failed.',
      );
    }
    if (response.status !== 200) {
      throw new LocalRuntimeConnectionError(
        response.status === 400
          ? 'invalid_request'
          : response.status === 401 || response.status === 403
            ? 'unauthorized'
            : 'service_unavailable',
        'Local Runtime Service rejected the request.',
        response.status,
      );
    }
    return readJsonResponse(response, maxResponseBytes);
  };
}

function decodeAccessToken(value: string): LocalRuntimeToken {
  try {
    return decodeLocalRuntimeToken(value);
  } catch {
    throw new LocalRuntimeConnectionError(
      'invalid_access_token',
      'Local Runtime Service access credential is invalid.',
    );
  }
}

function defaultWebSocketFactory(
  url: string,
  options: NativeRuntimeWebSocketOptions,
): NativeRuntimeWebSocketLike {
  const webSocketConstructor = (
    globalThis as unknown as {
      readonly WebSocket?: new (url: string, options?: unknown) => NativeRuntimeWebSocketLike;
    }
  ).WebSocket;
  if (!webSocketConstructor)
    throw new LocalRuntimeConnectionError('connection_failed', 'Native WebSocket is unavailable.');
  return new webSocketConstructor(url, { headers: { ...options.headers } });
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return result;
}

function boundedString(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    ![...value].some((character) => /\p{Cc}/u.test(character))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertListRuntimeLogSessionsRequest(value: ListRuntimeLogSessionsRequest): void {
  if (!isRecord(value)) throw invalidRequestError();
  if (!nonNegativeSafeInteger(value.limit) || value.limit < 1 || value.limit > 100) {
    throw invalidRequestError();
  }
  if (value.query !== undefined && (!boundedString(value.query, 256) || value.query.length === 0)) {
    throw invalidRequestError();
  }
  if (value.cursor !== undefined) {
    if (!isRecord(value.cursor)) throw invalidRequestError();
    if (
      !boundedString(value.cursor.sessionId, 512) ||
      !nonNegativeSafeInteger(value.cursor.updatedAt)
    ) {
      throw invalidRequestError();
    }
  }
}

function assertListRuntimeLogEventsRequest(value: ListRuntimeLogEventsRequest): void {
  if (!isRecord(value)) throw invalidRequestError();
  if (
    !boundedString(value.sessionId, 512) ||
    !nonNegativeSafeInteger(value.limit) ||
    value.limit < 1 ||
    value.limit > 200 ||
    (value.direction !== 'forward' && value.direction !== 'backward')
  ) {
    throw invalidRequestError();
  }
  if (
    value.afterSequence !== undefined &&
    (!nonNegativeSafeInteger(value.afterSequence) || value.beforeSequence !== undefined)
  ) {
    throw invalidRequestError();
  }
  if (value.beforeSequence !== undefined && !nonNegativeSafeInteger(value.beforeSequence)) {
    throw invalidRequestError();
  }
  if (
    value.eventTypes !== undefined &&
    (!Array.isArray(value.eventTypes) ||
      value.eventTypes.length > 256 ||
      value.eventTypes.some((entry) => !boundedString(entry, 160)))
  ) {
    throw invalidRequestError();
  }
}

function assertTicket(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw invalidResponseError();
  }
}

function serviceUrl(origin: string, path: string): string {
  try {
    const url = new URL(path, origin);
    if (url.origin !== origin || url.pathname !== path || url.search || url.hash) {
      throw new TypeError('invalid service route');
    }
    return url.toString();
  } catch {
    throw new LocalRuntimeConnectionError(
      'invalid_descriptor',
      'Local Runtime Service endpoint is invalid.',
    );
  }
}

async function readJsonResponse(response: Response, maximumBytes: number): Promise<unknown> {
  let bytes: Uint8Array;
  try {
    const reader = response.body?.getReader();
    if (!reader) {
      const fallback = new Uint8Array(await response.arrayBuffer());
      if (fallback.byteLength > maximumBytes) throw invalidResponseError();
      bytes = fallback;
    } else {
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        total += item.value.byteLength;
        if (total > maximumBytes) {
          await reader.cancel().catch(() => undefined);
          throw invalidResponseError();
        }
        chunks.push(item.value);
      }
      bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
    }
  } catch {
    throw invalidResponseError();
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw invalidResponseError();
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalidResponseError();
  }
}

function freezeDescriptor(value: LocalRuntimeServiceDescriptor): LocalRuntimeServiceDescriptor {
  const descriptor = decodeLocalRuntimeServiceDescriptor(value);
  return Object.freeze({
    ...descriptor,
    endpoint: Object.freeze({ ...descriptor.endpoint }),
  });
}

function sameServiceInstance(
  left: LocalRuntimeServiceDescriptor,
  right: LocalRuntimeServiceDescriptor,
): boolean {
  return (
    left.instanceId === right.instanceId &&
    left.endpoint.origin === right.endpoint.origin &&
    left.endpoint.websocketUrl === right.endpoint.websocketUrl
  );
}

function assertMatchingWorkspaceIdentity(request: unknown, response: unknown): void {
  if (!isRecord(request) || !isWorkspaceIdentity(request.workspace)) return;
  const responseWorkspace =
    isRecord(response) && isWorkspaceIdentity(response.workspace)
      ? response.workspace
      : isRecord(response) &&
          isRecord(response.snapshot) &&
          isWorkspaceIdentity(response.snapshot.workspace)
        ? response.snapshot.workspace
        : undefined;
  if (!responseWorkspace || !sameWorkspaceIdentity(request.workspace, responseWorkspace)) {
    throw new TypeError('App Control response belongs to a different Workspace.');
  }
}

function isWorkspaceIdentity(value: unknown): value is {
  readonly canonicalPath: string;
  readonly projectId: string;
  readonly workspaceDigest: string;
} {
  return (
    isRecord(value) &&
    typeof value.canonicalPath === 'string' &&
    typeof value.projectId === 'string' &&
    typeof value.workspaceDigest === 'string'
  );
}

function sameWorkspaceIdentity(
  left: {
    readonly canonicalPath: string;
    readonly projectId: string;
    readonly workspaceDigest: string;
  },
  right: {
    readonly canonicalPath: string;
    readonly projectId: string;
    readonly workspaceDigest: string;
  },
): boolean {
  return (
    left.canonicalPath === right.canonicalPath &&
    left.projectId === right.projectId &&
    left.workspaceDigest === right.workspaceDigest
  );
}

function isNonAppliedLifecycleResult(value: unknown): value is {
  readonly outcome: string;
  readonly descriptor?: unknown;
  readonly diagnostic?: unknown;
} {
  return isRecord(value) && typeof value.outcome === 'string' && value.outcome !== 'applied';
}

function extractEnsuredDescriptor(value: unknown): LocalRuntimeServiceDescriptor | undefined {
  const candidate =
    isRecord(value) && Object.hasOwn(value, 'descriptor') ? value.descriptor : value;
  if (candidate === undefined) return undefined;
  try {
    return freezeDescriptor(decodeLocalRuntimeServiceDescriptor(candidate));
  } catch {
    if (
      isRecord(value) &&
      typeof value.outcome === 'string' &&
      value.outcome !== 'applied' &&
      value.descriptor === undefined
    )
      return undefined;
    throw new LocalRuntimeConnectionError(
      'invalid_descriptor',
      'Service ensure returned an invalid descriptor.',
    );
  }
}

function decodeRuntimeLogSessionPage(value: unknown): RuntimeLogSessionPage {
  if (!isRecord(value)) throw invalidResponseError();
  assertOnlyKeys(value, ['entries', 'hasMore', 'nextCursor']);
  if (!Array.isArray(value.entries) || typeof value.hasMore !== 'boolean')
    throw invalidResponseError();
  const entries = value.entries.map((entry) => decodeRuntimeLogSessionEntry(entry));
  const nextCursor =
    value.nextCursor === undefined ? undefined : decodeRuntimeLogSessionCursor(value.nextCursor);
  return Object.freeze({
    entries: Object.freeze(entries),
    hasMore: value.hasMore,
    ...(nextCursor ? { nextCursor } : {}),
  });
}

function decodeRuntimeLogSessionEntry(value: unknown): RuntimeLogSessionEntry {
  if (!isRecord(value)) throw invalidResponseError();
  assertOnlyKeys(value, [
    'displayName',
    'lastSequence',
    'model',
    'needsSmartName',
    'sessionId',
    'updatedAt',
  ]);
  if (
    !boundedString(value.sessionId, 512) ||
    typeof value.displayName !== 'string' ||
    value.displayName.length > 8_192 ||
    typeof value.needsSmartName !== 'boolean' ||
    !nonNegativeSafeInteger(value.updatedAt) ||
    !nonNegativeSafeInteger(value.lastSequence)
  )
    throw invalidResponseError();
  let model: RuntimeLogSessionEntry['model'];
  if (value.model !== undefined) {
    if (!isRecord(value.model)) throw invalidResponseError();
    assertOnlyKeys(value.model, ['name', 'provider']);
    if (!boundedString(value.model.provider, 512) || !boundedString(value.model.name, 512))
      throw invalidResponseError();
    model = { provider: value.model.provider, name: value.model.name };
  }
  return Object.freeze({
    sessionId: value.sessionId,
    displayName: value.displayName,
    needsSmartName: value.needsSmartName,
    updatedAt: value.updatedAt,
    lastSequence: value.lastSequence,
    ...(model ? { model: Object.freeze(model) } : {}),
  });
}

function decodeRuntimeLogSessionCursor(value: unknown): RuntimeLogSessionCursor {
  if (!isRecord(value)) throw invalidResponseError();
  assertOnlyKeys(value, ['sessionId', 'updatedAt']);
  if (!boundedString(value.sessionId, 512) || !nonNegativeSafeInteger(value.updatedAt))
    throw invalidResponseError();
  return Object.freeze({
    sessionId: value.sessionId,
    updatedAt: value.updatedAt,
  });
}

function decodeRuntimeLogEventPage(value: unknown): RuntimeLogEventPage {
  if (!isRecord(value)) throw invalidResponseError();
  assertOnlyKeys(value, ['entries', 'hasMore', 'nextCursor', 'observedLastSequence']);
  if (
    !Array.isArray(value.entries) ||
    typeof value.hasMore !== 'boolean' ||
    !nonNegativeSafeInteger(value.observedLastSequence)
  ) {
    throw invalidResponseError();
  }
  const entries = value.entries.map((entry) => decodeRuntimeLogEventEntry(entry));
  if (value.nextCursor !== undefined && !nonNegativeSafeInteger(value.nextCursor))
    throw invalidResponseError();
  return Object.freeze({
    entries: Object.freeze(entries),
    hasMore: value.hasMore,
    observedLastSequence: value.observedLastSequence,
    ...(value.nextCursor === undefined ? {} : { nextCursor: value.nextCursor }),
  });
}

function decodeRuntimeLogEventEntry(value: unknown): RuntimeLogEventEntry {
  if (!isRecord(value)) throw invalidResponseError();
  assertOnlyKeys(value, [
    'causationId',
    'category',
    'createdAt',
    'detail',
    'eventId',
    'occurredAt',
    'sequence',
    'sessionId',
    'status',
    'summary',
    'type',
  ]);
  if (
    !boundedString(value.sessionId, 512) ||
    !nonNegativeSafeInteger(value.sequence) ||
    !boundedString(value.eventId, 512) ||
    !nonNegativeSafeInteger(value.createdAt) ||
    !boundedString(value.type, 512) ||
    !isOneOf(value.category, [
      'session',
      'turn',
      'model',
      'tool',
      'interaction',
      'subagent',
      'verification',
      'recovery',
      'other',
    ] as const) ||
    !isOneOf(value.status, ['ok', 'running', 'waiting', 'cancelled', 'failed', 'unknown'] as const)
  )
    throw invalidResponseError();
  for (const key of ['causationId', 'occurredAt', 'summary'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'string') throw invalidResponseError();
  }
  const causationId = value.causationId;
  const occurredAt = value.occurredAt;
  const summary = value.summary;
  if (
    (causationId !== undefined && typeof causationId !== 'string') ||
    (occurredAt !== undefined && typeof occurredAt !== 'string') ||
    (summary !== undefined && typeof summary !== 'string')
  )
    throw invalidResponseError();
  const detail = value.detail === undefined ? undefined : decodeRuntimeLogEventDetail(value.detail);
  return Object.freeze({
    sessionId: value.sessionId,
    sequence: value.sequence,
    eventId: value.eventId,
    createdAt: value.createdAt,
    type: value.type,
    category: value.category as RuntimeLogEventEntry['category'],
    status: value.status as RuntimeLogEventEntry['status'],
    ...(causationId === undefined ? {} : { causationId }),
    ...(occurredAt === undefined ? {} : { occurredAt }),
    ...(summary === undefined ? {} : { summary }),
    ...(detail === undefined ? {} : { detail }),
  });
}

function decodeRuntimeLogEventDetail(value: unknown): RuntimeLogEventDetail {
  if (!isRecord(value)) throw invalidResponseError();
  assertOnlyKeys(value, ['artifact', 'fields', 'kind']);
  if (
    !isOneOf(value.kind, [
      'message',
      'model',
      'tool',
      'interaction',
      'subagent',
      'verification',
      'artifact',
      'unavailable',
    ] as const)
  )
    throw invalidResponseError();
  let fields: RuntimeLogEventDetail['fields'];
  if (value.fields !== undefined) {
    if (!isRecord(value.fields)) throw invalidResponseError();
    for (const field of Object.values(value.fields)) {
      if (
        field !== null &&
        typeof field !== 'string' &&
        typeof field !== 'boolean' &&
        (typeof field !== 'number' || !Number.isFinite(field))
      )
        throw invalidResponseError();
    }
    fields = value.fields as RuntimeLogEventDetail['fields'];
  }
  let artifact: RuntimeLogEventDetail['artifact'];
  if (value.artifact !== undefined) {
    if (!isRecord(value.artifact)) throw invalidResponseError();
    assertOnlyKeys(value.artifact, ['availability', 'kind']);
    if (
      !boundedString(value.artifact.kind, 512) ||
      (value.artifact.availability !== 'available' && value.artifact.availability !== 'unavailable')
    )
      throw invalidResponseError();
    artifact = {
      kind: value.artifact.kind,
      availability: value.artifact.availability,
    };
  }
  return Object.freeze({
    kind: value.kind as RuntimeLogEventDetail['kind'],
    ...(fields ? { fields: Object.freeze(fields) } : {}),
    ...(artifact ? { artifact: Object.freeze(artifact) } : {}),
  });
}

function decodeRuntimeHistoryTranscript(value: unknown): RuntimeHistorySessionTranscript {
  if (!isRecord(value)) throw invalidResponseError();
  assertOnlyKeys(value, ['events', 'interactionMode', 'records', 'recovery', 'session']);
  const session = decodeRuntimeLogSessionEntry(value.session);
  if (!Array.isArray(value.events) || !Array.isArray(value.records)) throw invalidResponseError();
  const events: RuntimeClientEvent[] = [];
  for (const event of value.events) {
    try {
      assertRuntimeClientEvent(event);
    } catch {
      throw invalidResponseError();
    }
    events.push(event);
  }
  const records: RuntimeHistorySessionTranscript['records'][number][] = [];
  let previousSequence = -1;
  for (const record of value.records) {
    if (!isRecord(record)) throw invalidResponseError();
    assertOnlyKeys(record, ['events', 'sequence']);
    if (
      !nonNegativeSafeInteger(record.sequence) ||
      record.sequence <= previousSequence ||
      record.sequence > session.lastSequence ||
      !Array.isArray(record.events)
    ) {
      throw invalidResponseError();
    }
    previousSequence = record.sequence;
    const recordEvents: RuntimeClientEvent[] = [];
    for (const event of record.events) {
      try {
        assertRuntimeClientEvent(event);
      } catch {
        throw invalidResponseError();
      }
      recordEvents.push(event);
    }
    records.push(
      Object.freeze({
        sequence: record.sequence,
        events: Object.freeze(recordEvents),
      }),
    );
  }
  if (JSON.stringify(records.flatMap((record) => record.events)) !== JSON.stringify(events)) {
    throw invalidResponseError();
  }
  if (
    value.interactionMode !== 'accept_edits' &&
    value.interactionMode !== 'auto' &&
    value.interactionMode !== 'full'
  )
    throw invalidResponseError();
  if (value.recovery !== 'normal' && value.recovery !== 'pending_interaction')
    throw invalidResponseError();
  return Object.freeze({
    session,
    records: Object.freeze(records),
    events: Object.freeze(events),
    interactionMode: value.interactionMode,
    recovery: value.recovery,
  });
}

function assertOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const expected = new Set(keys);
  if (Object.keys(value).some((key) => !expected.has(key))) throw invalidResponseError();
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isOneOf<Value extends string>(value: unknown, values: readonly Value[]): value is Value {
  return typeof value === 'string' && values.includes(value as Value);
}

function invalidRequestError(): LocalRuntimeConnectionError {
  return new LocalRuntimeConnectionError('invalid_request', 'Local Runtime request is invalid.');
}

function invalidResponseError(): LocalRuntimeConnectionError {
  return new LocalRuntimeConnectionError('invalid_response', 'Local Runtime response is invalid.');
}

function closedError(): LocalRuntimeConnectionError {
  return new LocalRuntimeConnectionError(
    'connection_closed',
    'Local Runtime connection is closed.',
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
