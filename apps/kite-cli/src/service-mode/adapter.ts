import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { KiteAppControlClient } from '@kite-ai/kite-app-contract';
import {
  WORKER_CONTROLLER_REQUEST_SCHEMA_,
  type WorkerControllerClient,
  type WorkerControllerOperationResponse,
  type WorkerControllerReadResponse,
} from '@kite-ai/kite-app-contract/worker-controller';
import type {
  LocalKiteConnection,
  LocalKiteConnectionStatus,
  LocalRuntimeClientStatePort,
  LocalRuntimeServiceEnsurePort,
} from '@kite-ai/kite-local-runtime/client';
import {
  connectLocalKiteConnection,
  type LocalRuntimeConnectorOptions,
} from '@kite-ai/kite-local-runtime/client';
import type { LocalRuntimeServiceDescriptor } from '@kite-ai/kite-local-runtime/service';
import type {
  RuntimeClient,
  RuntimeClientInfo,
  RuntimeHistoryClient,
  RuntimeSnapshotStore,
} from '@kite-ai/runtime-client';

/**
 * The only CLI-owned object in the opt-in Service path.  It is a typed view
 * over one Native connection; discovery, auth, reconnect transport and every
 * remote owner remain in `@kite-ai/kite-local-runtime/client`.
 */
export interface KiteServiceModeAdapter extends AsyncDisposable {
  /** The opaque Native connection; tokens and process handles are not exposed. */
  readonly connection: KiteServiceModeConnection;
  /** Native-only Controller surface; absent on test-only/non-Worker connections. */
  readonly controller?: WorkerControllerClient;
  /** Existing Runtime Client facade; no Runtime Host/Store is created here. */
  readonly runtime: RuntimeClient;
  /** Existing authenticated durable History facade. */
  readonly history: RuntimeHistoryClient;
  /** Existing exact App Control facade. */
  readonly appControl: KiteAppControlClient;
  /** Optional Native-only credential capability for first-run composition. */
  readonly credentialClient: LocalKiteConnection['credential'];
  readonly service: LocalRuntimeServiceDescriptor;
  readonly snapshotStore: RuntimeSnapshotStore;
  readonly status: LocalKiteConnectionStatus;
  readonly generation: number;
  /** Snapshot observers are presentation-only and cannot alter Runtime state. */
  subscribeSnapshot(listener: () => void): () => void;
  reconnect(): Promise<void>;
  close(reason?: string): Promise<void>;
}

export interface KiteServiceModeAdapterOptions {
  readonly connection: KiteServiceModeConnection;
}

/** Structural extension returned by the managed Workspace Worker connector. */
export type KiteServiceModeConnection = LocalKiteConnection & {
  readonly controller?: WorkerControllerClient;
};

export interface KiteServiceModeControllerLease {
  readonly sessionId: string;
  readonly clientId: string;
  readonly connectionGeneration: number;
  readonly controllerGeneration: number;
  readonly interactionGeneration: number;
  readonly workerInstanceId: string;
}

export interface KiteServiceModeCreatedSession {
  readonly lease: KiteServiceModeControllerLease;
  readonly sessionRevision: number;
}

export type KiteServiceModeControllerErrorCode =
  | 'unavailable'
  | 'busy'
  | 'detached'
  | 'rejected'
  | 'invalid';

/** Typed native Controller boundary used by release CLI/TUI mutation paths. */
export class KiteServiceModeControllerError extends Error {
  readonly code: KiteServiceModeControllerErrorCode;

  constructor(code: KiteServiceModeControllerErrorCode, message: string) {
    super(message);
    this.name = 'KiteServiceModeControllerError';
    this.code = code;
  }
}

const controllerLeases = new WeakMap<
  KiteServiceModeConnection,
  Map<string, KiteServiceModeControllerLease>
>();

/** Atomically create one Runtime Session and its generation-one Controller in Store 7. */
export async function createKiteServiceModeSession(
  connection: KiteServiceModeConnection,
  sessionId: string,
): Promise<KiteServiceModeCreatedSession> {
  assertControllerSessionId(sessionId);
  const controller = requireController(connection);
  const leases = leaseMap(connection);
  if (leases.has(sessionId)) {
    throw new KiteServiceModeControllerError('invalid', 'The Session is already tracked.');
  }
  const requestIdentity = {
    operation: 'create_session',
    sessionId,
    nonce: randomUUID(),
  } as const;
  const response = await controller.createSession({
    schema: WORKER_CONTROLLER_REQUEST_SCHEMA_,
    operation: 'create_session',
    sessionId,
    requestId: `cli-controller-create-${requestIdentity.nonce}`,
    requestDigest: digestControllerRequest(requestIdentity),
    resumeSecret: randomBytes(32).toString('base64url'),
    resumeExpiresAtMs: Date.now() + 5 * 60_000,
  });
  const lease = response.lease;
  const sessionRevision = response.sessionRevision;
  if (
    (response.status !== 'applied' && response.status !== 'replay') ||
    lease?.status !== 'active' ||
    lease.sessionId !== sessionId ||
    lease.workerInstanceId !== connection.service.instanceId ||
    !safeControllerText(lease.clientId) ||
    !positiveControllerGeneration(lease.connectionGeneration) ||
    lease.controllerGeneration !== 1 ||
    typeof sessionRevision !== 'number' ||
    !Number.isSafeInteger(sessionRevision) ||
    sessionRevision < 0
  ) {
    throw new KiteServiceModeControllerError(
      'invalid',
      'The native Worker returned an invalid atomic Session creation result.',
    );
  }
  const result: KiteServiceModeControllerLease = Object.freeze({
    sessionId,
    clientId: lease.clientId,
    connectionGeneration: lease.connectionGeneration,
    controllerGeneration: lease.controllerGeneration,
    interactionGeneration: 0,
    workerInstanceId: lease.workerInstanceId,
  });
  leases.set(sessionId, result);
  return Object.freeze({ lease: result, sessionRevision });
}

/**
 * Acquire and then re-read one exact Store 7 Controller lease. The native Worker connector has
 * already authenticated the connection generation; this helper never accepts identity from a
 * request body and never infers ownership from an untracked active lease.
 */
export async function acquireKiteServiceModeController(
  connection: KiteServiceModeConnection,
  sessionId: string,
): Promise<KiteServiceModeControllerLease> {
  assertControllerSessionId(sessionId);
  const controller = requireController(connection);
  const leases = leaseMap(connection);
  const existing = leases.get(sessionId);
  const observed = await readController(controller, sessionId);
  if (observed.state.status === 'active') {
    if (existing && sameControllerLease(existing, observed.state, connection.service.instanceId)) {
      return existing;
    }
    if (
      existing &&
      observed.state.sessionId === existing.sessionId &&
      observed.state.clientId === existing.clientId &&
      observed.state.controllerGeneration === existing.controllerGeneration &&
      observed.state.workerInstanceId === connection.service.instanceId &&
      positiveControllerGeneration(observed.state.connectionGeneration)
    ) {
      const resumed: KiteServiceModeControllerLease = Object.freeze({
        sessionId,
        clientId: existing.clientId,
        connectionGeneration: observed.state.connectionGeneration,
        controllerGeneration: observed.state.controllerGeneration,
        interactionGeneration: observed.state.interactionGeneration,
        workerInstanceId: observed.state.workerInstanceId,
      });
      leases.set(sessionId, resumed);
      return resumed;
    }
    throw new KiteServiceModeControllerError(
      'busy',
      'The Session Controller is already owned by another native connection.',
    );
  }
  if (observed.state.status === 'detached') {
    throw new KiteServiceModeControllerError(
      'detached',
      'The Session Controller is detached and requires its explicit recovery capability.',
    );
  }
  if (observed.state.status !== 'idle') {
    throw new KiteServiceModeControllerError(
      'rejected',
      'The Session Controller did not return an actionable state.',
    );
  }

  const request = {
    schema: WORKER_CONTROLLER_REQUEST_SCHEMA_,
    operation: 'request_control' as const,
    sessionId,
    requestId: `cli-controller-${randomUUID()}`,
    requestDigest: digestControllerRequest({ operation: 'request_control', sessionId }),
    resumeSecret: randomBytes(32).toString('base64url'),
    resumeExpiresAtMs: Date.now() + 5 * 60_000,
  };
  let response: WorkerControllerOperationResponse;
  try {
    response = await controller.requestControl(request);
  } catch {
    throw new KiteServiceModeControllerError(
      'rejected',
      'The native Worker rejected the Controller request.',
    );
  }
  if (response.status !== 'applied' && response.status !== 'replay') {
    throw new KiteServiceModeControllerError(
      response.receipt.code === 'controller_busy' ? 'busy' : 'rejected',
      'The Session Controller request was not applied.',
    );
  }
  const lease = response.lease;
  if (
    lease === undefined ||
    lease.status !== 'active' ||
    lease.sessionId !== sessionId ||
    lease.workerInstanceId !== connection.service.instanceId ||
    !safeControllerText(lease.clientId) ||
    !positiveControllerGeneration(lease.connectionGeneration) ||
    !positiveControllerGeneration(lease.controllerGeneration)
  ) {
    throw new KiteServiceModeControllerError(
      'invalid',
      'The native Worker returned an invalid Controller lease.',
    );
  }
  const confirmed = await readController(controller, sessionId);
  if (!sameControllerLease(lease, confirmed.state, connection.service.instanceId)) {
    throw new KiteServiceModeControllerError(
      'invalid',
      'The Controller lease changed before Runtime admission.',
    );
  }
  const result: KiteServiceModeControllerLease = Object.freeze({
    sessionId,
    clientId: lease.clientId,
    connectionGeneration: lease.connectionGeneration,
    controllerGeneration: lease.controllerGeneration,
    interactionGeneration: confirmed.state.interactionGeneration,
    workerInstanceId: lease.workerInstanceId,
  });
  leases.set(sessionId, result);
  return result;
}

/** Release a failed, not-yet-running Session reservation; never cancels a Runtime Turn. */
export async function releaseKiteServiceModeController(
  connection: KiteServiceModeConnection,
  lease: KiteServiceModeControllerLease,
): Promise<void> {
  const controller = requireController(connection);
  const request = {
    schema: WORKER_CONTROLLER_REQUEST_SCHEMA_,
    operation: 'release_control' as const,
    sessionId: lease.sessionId,
    requestId: `cli-controller-release-${randomUUID()}`,
    requestDigest: digestControllerRequest({
      operation: 'release_control',
      sessionId: lease.sessionId,
      controllerGeneration: lease.controllerGeneration,
    }),
    controllerGeneration: lease.controllerGeneration,
  };
  try {
    const response = await controller.releaseControl(request);
    if (
      (response.status === 'applied' || response.status === 'replay') &&
      response.receipt.clientId !== null &&
      response.receipt.clientId !== lease.clientId
    ) {
      throw new Error('Controller release belongs to a different native client.');
    }
  } finally {
    leaseMap(connection).delete(lease.sessionId);
  }
}

/** Detach one owned Controller lease during connection teardown; it never sends cancel/abort. */
export async function detachKiteServiceModeController(
  connection: KiteServiceModeConnection,
  lease: KiteServiceModeControllerLease,
): Promise<void> {
  const controller = requireController(connection);
  const request = {
    schema: WORKER_CONTROLLER_REQUEST_SCHEMA_,
    operation: 'detach_controller' as const,
    sessionId: lease.sessionId,
    requestId: `cli-controller-detach-${randomUUID()}`,
    requestDigest: digestControllerRequest({
      operation: 'detach_controller',
      sessionId: lease.sessionId,
      controllerGeneration: lease.controllerGeneration,
      interactionGeneration: lease.interactionGeneration,
    }),
    controllerGeneration: lease.controllerGeneration,
    interactionGeneration: lease.interactionGeneration,
  };
  try {
    await controller.detach(request);
  } finally {
    leaseMap(connection).delete(lease.sessionId);
  }
}

function requireController(connection: KiteServiceModeConnection): WorkerControllerClient {
  if (!connection.controller) {
    throw new KiteServiceModeControllerError(
      'unavailable',
      'The managed connection does not expose a native Controller client.',
    );
  }
  return connection.controller;
}

function leaseMap(
  connection: KiteServiceModeConnection,
): Map<string, KiteServiceModeControllerLease> {
  let leases = controllerLeases.get(connection);
  if (!leases) {
    leases = new Map();
    controllerLeases.set(connection, leases);
  }
  return leases;
}

async function readController(
  controller: WorkerControllerClient,
  sessionId: string,
): Promise<WorkerControllerReadResponse> {
  try {
    return await controller.read({
      schema: WORKER_CONTROLLER_REQUEST_SCHEMA_,
      operation: 'read_controller',
      sessionId,
    });
  } catch {
    throw new KiteServiceModeControllerError(
      'rejected',
      'The native Worker Controller state is unavailable.',
    );
  }
}

function sameControllerLease(
  lease: Pick<
    KiteServiceModeControllerLease,
    'sessionId' | 'clientId' | 'connectionGeneration' | 'controllerGeneration' | 'workerInstanceId'
  >,
  state: WorkerControllerReadResponse['state'],
  expectedWorkerInstanceId: string,
): boolean {
  return (
    state.status === 'active' &&
    state.sessionId === lease.sessionId &&
    state.clientId === lease.clientId &&
    state.connectionGeneration === lease.connectionGeneration &&
    state.controllerGeneration === lease.controllerGeneration &&
    state.workerInstanceId === expectedWorkerInstanceId &&
    lease.workerInstanceId === expectedWorkerInstanceId
  );
}

function digestControllerRequest(value: Readonly<Record<string, unknown>>): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function assertControllerSessionId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(value)) {
    throw new KiteServiceModeControllerError(
      'invalid',
      'The Controller Session identity is invalid.',
    );
  }
}

function safeControllerText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    ![...value].some((character) => /\p{Cc}/u.test(character))
  );
}

function positiveControllerGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

/**
 * Compose an adapter from an already authenticated typed connection.  This
 * function never discovers files, reads tokens, opens SQLite, starts a Host,
 * or falls back to the InProcess composition.
 */
export function createKiteServiceModeAdapter(
  options: KiteServiceModeAdapterOptions | LocalKiteConnection,
): KiteServiceModeAdapter {
  const connection = isOptions(options) ? options.connection : options;
  return new KiteServiceModeAdapterImpl(connection);
}

/** Descriptive alias used by foreground CLI integration code. */
export const createKiteServiceModeClient = createKiteServiceModeAdapter;

export interface KiteServiceModeConnector {
  /** Discovery/ensure is intentionally outside this CLI adapter. */
  connect(input: {
    readonly workspace: string;
    readonly clientInfo?: RuntimeClientInfo;
  }): Promise<LocalKiteConnection>;
}

/**
 * Narrow Native connector composition used by the release owner. The CLI
 * receives an already-composed manager/state pair; source-vs-installed
 * executable selection and validated home identity remain outside this file.
 */
export interface NativeKiteServiceModeConnectorOptions {
  readonly manager: LocalRuntimeServiceEnsurePort;
  readonly state: LocalRuntimeClientStatePort;
  readonly clientInfo: RuntimeClientInfo;
  readonly clientOptions?: Omit<
    LocalRuntimeConnectorOptions,
    'manager' | 'state' | 'workspace' | 'clientInfo'
  >;
}

export function createNativeKiteServiceModeConnector(
  options: NativeKiteServiceModeConnectorOptions,
): KiteServiceModeConnector {
  return Object.freeze({
    connect: (input: { readonly workspace: string; readonly clientInfo?: RuntimeClientInfo }) =>
      connectLocalKiteConnection({
        ...options.clientOptions,
        manager: options.manager,
        state: options.state,
        workspace: input.workspace,
        clientInfo: input.clientInfo ?? options.clientInfo,
      }),
  });
}

/**
 * Explicit connector entry point for future opt-in wiring.  A failed
 * connection rejects; it is never replaced with an embedded/InProcess client.
 */
export async function connectKiteServiceMode(
  connector: KiteServiceModeConnector,
  input: { readonly workspace: string },
): Promise<KiteServiceModeAdapter> {
  const connection = await connector.connect({ workspace: input.workspace });
  return createKiteServiceModeAdapter(connection);
}

class KiteServiceModeAdapterImpl implements KiteServiceModeAdapter {
  readonly connection: KiteServiceModeConnection;
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(connection: KiteServiceModeConnection) {
    this.connection = connection;
  }

  get controller(): WorkerControllerClient | undefined {
    return this.connection.controller;
  }

  get runtime(): RuntimeClient {
    return this.connection.runtime;
  }

  get history(): RuntimeHistoryClient {
    return this.connection.history;
  }

  get appControl(): KiteAppControlClient {
    return this.connection.app;
  }

  get credentialClient(): LocalKiteConnection['credential'] {
    return this.connection.credential;
  }

  get service(): LocalRuntimeServiceDescriptor {
    return this.connection.service;
  }

  get snapshotStore(): RuntimeSnapshotStore {
    return this.connection.snapshotStore;
  }

  get status(): LocalKiteConnectionStatus {
    return this.connection.status;
  }

  get generation(): number {
    return this.connection.generation;
  }

  subscribeSnapshot(listener: () => void): () => void {
    return this.connection.subscribe(listener);
  }

  reconnect(): Promise<void> {
    if (this.#closed) return Promise.reject(new Error('Kite Service mode adapter is closed.'));
    return this.connection.reconnect();
  }

  close(reason = 'service_mode_client_closed'): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    // Closing the Native connection only tears down this Client's connection,
    // subscriptions and local snapshot store.  It never sends Runtime cancel
    // or close-session commands and cannot dispose the Service Host.
    this.#closePromise = this.connection.close(reason);
    return this.#closePromise;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}

function isOptions(
  value: KiteServiceModeAdapterOptions | LocalKiteConnection,
): value is KiteServiceModeAdapterOptions {
  return 'connection' in value;
}
