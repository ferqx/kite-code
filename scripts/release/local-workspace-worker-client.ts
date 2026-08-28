import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve, win32 } from 'node:path';
import type { KiteWorkspaceIdentity } from '@kite-ai/kite-app-contract';
import {
  WORKER_CONTROLLER_PATH_,
  type WorkerControllerAbandonDetachedRequest,
  type WorkerControllerClient,
  type WorkerControllerCreateSessionRequest,
  type WorkerControllerDetachRequest,
  type WorkerControllerIssueResumeCapabilityRequest,
  type WorkerControllerMintDetachedRecoveryRequest,
  type WorkerControllerReadRequest,
  type WorkerControllerReleaseControlRequest,
  type WorkerControllerRequest,
  type WorkerControllerRequestControlRequest,
  type WorkerControllerResponse,
  type WorkerControllerResumeRequest,
  type WorkerControllerValidateResumeRequest,
  workerControllerRequestCodec,
  workerControllerResponseCodec,
} from '@kite-ai/kite-app-contract/worker-controller';
import {
  createLocalKiteConnection,
  LOCAL_RUNTIME_ACCESS_AUTHORIZATION_SCHEME,
  LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
  type LocalKiteConnection,
  type LocalRuntimeClientStatePort,
  type LocalRuntimeFetch,
  type LocalRuntimeServiceEnsurePort,
  type NativeRuntimeWebSocketFactory,
} from '@kite-ai/kite-local-runtime/client';
import {
  COORDINATOR_WORKER_ENDPOINT_SCHEMA,
  COORDINATOR_WORKER_IDENTITY_SCHEMA,
  COORDINATOR_WORKSPACE_IDENTITY_SCHEMA,
  type CoordinatorRequestClient,
  type CoordinatorWorkerReference,
} from '@kite-ai/kite-local-runtime/coordinator';
import {
  decodeLocalRuntimeServiceDescriptor,
  type LocalRuntimeServiceDescriptor,
} from '@kite-ai/kite-local-runtime/service';
import type { RuntimeClientInfo } from '@kite-ai/runtime-client';
import { RUNTIME_PROTOCOL_VERSION } from '@kite-ai/runtime-protocol';
import { z } from 'zod';
import type { KiteServiceModeConnector } from '../../apps/kite-cli/src/service-mode';
import type { ManagedLocalCoordinatorClientComposition } from './local-coordinator-client';

const WORKER_INSTANCE_HANDSHAKE_PATH = '/_kite/instance' as const;
const WORKER_PURPOSE = 'native_client' as const;
// These headers are the fixed Worker data-plane binding contract. They are kept here, like the
// existing Native Runtime route constants, so this release-side connector does not import the
// Service application or its Store/Host composition.
const KITE_WORKER_CLIENT_ID_HEADER = 'x-kite-worker-client-id' as const;
const KITE_WORKER_CONNECTION_GENERATION_HEADER = 'x-kite-worker-connection-generation' as const;
const KITE_WORKER_PURPOSE_HEADER = 'x-kite-worker-purpose' as const;
const KITE_WORKER_CONTROLLER_SESSION_HEADER = 'x-kite-worker-controller-session' as const;
const KITE_WORKER_CONTROLLER_GENERATION_HEADER = 'x-kite-worker-controller-generation' as const;
const DEFAULT_SERVER_VERSION = 'kite-workspace-worker-v1';
const MAX_HANDSHAKE_BYTES = 16 * 1024;
const MAX_CLIENT_ID_LENGTH = 512;
const MAX_WORKSPACE_PATH_LENGTH = 4_096;
const timestamp = z.iso.datetime({ offset: true });

const handshakeSchema = z
  .object({
    schema: z.literal('kite.local-runtime.instance-handshake.v1'),
    instanceId: boundedText(),
    protocolVersion: z.literal(RUNTIME_PROTOCOL_VERSION),
    clientContractRevision: z.literal(LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_),
    serverVersion: boundedText(),
    buildId: boundedText(),
  })
  .strict();

type CoordinatorClient = Pick<
  ManagedLocalCoordinatorClientComposition['client'],
  'ensureWorkspaceWorker' | 'mintWorkerConnectionCapability'
>;

export interface LocalWorkspaceWorkerClientOptions {
  /** Existing Coordinator request facade; lifecycle/state ownership stays outside this module. */
  readonly coordinatorClient: CoordinatorClient;
  readonly clientInfo?: RuntimeClientInfo;
  readonly fetch?: LocalRuntimeFetch;
  readonly webSocketFactory?: NativeRuntimeWebSocketFactory;
  readonly connectDeadlineMs?: number;
  readonly sendDeadlineMs?: number;
  readonly maxBufferedAmount?: number;
  readonly maxQueuedMessages?: number;
  readonly maxHttpResponseBytes?: number;
}

export type LocalWorkspaceWorkerConnection = LocalKiteConnection & {
  /** Explicit native-only Controller client; no Controller operation is automatic. */
  readonly controller: WorkerControllerClient;
};

export interface LocalWorkspaceWorkerConnector extends KiteServiceModeConnector {
  connect(input: {
    readonly workspace: string;
    readonly clientInfo?: RuntimeClientInfo;
  }): Promise<LocalWorkspaceWorkerConnection>;
}

export type LocalWorkspaceWorkerClientErrorCode =
  | 'workspace_invalid'
  | 'coordinator_unavailable'
  | 'worker_unavailable'
  | 'worker_identity_mismatch'
  | 'capability_unavailable'
  | 'handshake_failed';

export class LocalWorkspaceWorkerClientError extends Error {
  readonly code: LocalWorkspaceWorkerClientErrorCode;

  constructor(code: LocalWorkspaceWorkerClientErrorCode, message: string) {
    super(message);
    this.name = 'LocalWorkspaceWorkerClientError';
    this.code = code;
  }
}

/**
 * Build the release-side Worker connector consumed by the existing CLI service-mode adapter.
 * Coordinator discovery, Worker capability mint, and all Runtime HTTP/WebSocket traffic remain
 * closed native operations; no Service state, Store, Host, or legacy Service fallback is used.
 */
export function createManagedLocalWorkspaceWorkerConnector(
  options: LocalWorkspaceWorkerClientOptions,
): LocalWorkspaceWorkerConnector {
  const coordinator = options.coordinatorClient;
  const baseFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const defaultClientInfo = Object.freeze({
    name: 'kite-workspace-worker-client',
    version: '0.1.0',
    instanceId: `workspace-worker-client-${randomUUID()}`,
  });

  return Object.freeze({
    connect: async (input: {
      readonly workspace: string;
      readonly clientInfo?: RuntimeClientInfo;
    }): Promise<LocalWorkspaceWorkerConnection> => {
      const workspace = canonicalizeWorkspace(input.workspace);
      const clientInfo = validateClientInfo(
        input.clientInfo ?? options.clientInfo ?? defaultClientInfo,
      );
      const connectionState = createConnectionState();
      const manager = createWorkerEnsurePort(connectionState, workspace, clientInfo);
      const state = createWorkerClientState(connectionState);
      const fetch = createBoundFetch(connectionState, clientInfo, baseFetch);
      const webSocketFactory = createBoundWebSocketFactory(
        connectionState,
        clientInfo,
        options.webSocketFactory,
      );
      const connection = createLocalKiteConnection({
        manager,
        state,
        workspace: workspace.canonicalPath,
        clientInfo,
        clientContractRevision: LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
        fetch,
        webSocketFactory,
        ...(options.connectDeadlineMs === undefined
          ? {}
          : { connectDeadlineMs: options.connectDeadlineMs }),
        ...(options.sendDeadlineMs === undefined ? {} : { sendDeadlineMs: options.sendDeadlineMs }),
        ...(options.maxBufferedAmount === undefined
          ? {}
          : { maxBufferedAmount: options.maxBufferedAmount }),
        ...(options.maxQueuedMessages === undefined
          ? {}
          : { maxQueuedMessages: options.maxQueuedMessages }),
        ...(options.maxHttpResponseBytes === undefined
          ? {}
          : { maxHttpResponseBytes: options.maxHttpResponseBytes }),
      });
      try {
        // The instance handshake is completed by the manager before this returns. The CLI may
        // now perform its normal trust query; Runtime History/App/WS calls use the same binding.
        await connection.prepareAppControl();
        return Object.assign(connection, {
          controller: createWorkerControllerClient(connectionState, clientInfo, baseFetch),
        }) as LocalWorkspaceWorkerConnection;
      } catch (error) {
        await connection.close('workspace_worker_prepare_failed').catch(() => undefined);
        throw error;
      }
    },
  });

  function createConnectionState(): WorkerConnectionState {
    return {
      generation: 0,
      binding: undefined,
      controllerBinding: undefined,
      descriptor: undefined,
      ensureTail: Promise.resolve(),
    };
  }

  function createWorkerEnsurePort(
    state: WorkerConnectionState,
    workspace: KiteWorkspaceIdentity,
    clientInfo: RuntimeClientInfo,
  ): LocalRuntimeServiceEnsurePort {
    return {
      ensure(): Promise<LocalRuntimeServiceDescriptor> {
        const operation = state.ensureTail.then(
          () => ensureWorker(state, workspace, clientInfo),
          () => ensureWorker(state, workspace, clientInfo),
        );
        state.ensureTail = operation.then(
          () => undefined,
          () => undefined,
        );
        return operation;
      },
    };
  }

  async function ensureWorker(
    state: WorkerConnectionState,
    workspace: KiteWorkspaceIdentity,
    clientInfo: RuntimeClientInfo,
  ): Promise<LocalRuntimeServiceDescriptor> {
    const nextGeneration = state.generation + 1;
    const worker = await ensureCoordinatorWorker(coordinator, workspace);
    const capability = await mintWorkerCapability(
      coordinator,
      worker,
      workspace,
      clientInfo,
      nextGeneration,
    );
    const handshake = await authenticateWorkerInstance(
      worker,
      capability,
      clientInfo,
      nextGeneration,
      baseFetch,
    );
    const descriptor = workerDescriptor(worker, handshake);
    // Publish the new binding only after Coordinator identity, capability, endpoint, and Worker
    // instance handshake all agree. A failed reconnect leaves no partially updated binding.
    state.generation = nextGeneration;
    // Controller leases are bound to the previous connection generation. A reconnect therefore
    // returns to Observer mode until the caller explicitly acquires/resumes a lease again.
    state.controllerBinding = undefined;
    state.binding = Object.freeze({
      worker,
      capability,
      generation: nextGeneration,
    });
    state.descriptor = descriptor;
    return descriptor;
  }
}

/** Compatibility alias for release callers that name this object as a connector directly. */
export const createLocalWorkspaceWorkerConnector = createManagedLocalWorkspaceWorkerConnector;

interface WorkerBinding {
  readonly worker: CoordinatorWorkerReference;
  readonly capability: string;
  readonly generation: number;
}

interface WorkerConnectionState {
  generation: number;
  binding: WorkerBinding | undefined;
  controllerBinding: Readonly<{ sessionId: string; controllerGeneration: number }> | undefined;
  descriptor: LocalRuntimeServiceDescriptor | undefined;
  ensureTail: Promise<void>;
}

/** Local copy of the repository's exact canonical Workspace identity rule. */
function canonicalWorkspaceIdentity(workspace: KiteWorkspaceIdentity): KiteWorkspaceIdentity {
  if (!isAbsolute(workspace.canonicalPath)) throw new Error('Workspace path is not absolute.');
  const canonicalPath = realpathSync.native(resolve(workspace.canonicalPath));
  const digest = createHash('sha256').update(canonicalPath, 'utf8').digest('hex');
  if (
    canonicalPath !== workspace.canonicalPath ||
    workspace.workspaceDigest !== `sha256:${digest}` ||
    workspace.projectId !== `project_${digest}`
  ) {
    throw new Error('Workspace identity is not canonical.');
  }
  return Object.freeze({
    canonicalPath,
    projectId: workspace.projectId,
    workspaceDigest: workspace.workspaceDigest,
  });
}

function canonicalizeWorkspace(requested: string): KiteWorkspaceIdentity {
  if (
    typeof requested !== 'string' ||
    requested.length === 0 ||
    requested.length > MAX_WORKSPACE_PATH_LENGTH ||
    (!isAbsolute(requested) && !win32.isAbsolute(requested)) ||
    [...requested].some((character) => /\p{Cc}/u.test(character))
  ) {
    throw new LocalWorkspaceWorkerClientError('workspace_invalid', 'Workspace path is invalid.');
  }
  try {
    const canonicalPath = realpathSync.native(resolve(requested));
    const digest = createHash('sha256').update(canonicalPath, 'utf8').digest('hex');
    return canonicalWorkspaceIdentity({
      canonicalPath,
      projectId: `project_${digest}`,
      workspaceDigest: `sha256:${digest}`,
    });
  } catch {
    throw new LocalWorkspaceWorkerClientError(
      'workspace_invalid',
      'Workspace identity is unavailable.',
    );
  }
}

function validateClientInfo(value: RuntimeClientInfo): RuntimeClientInfo {
  if (
    !boundedTextValue(value.name, MAX_CLIENT_ID_LENGTH) ||
    !boundedTextValue(value.version, MAX_CLIENT_ID_LENGTH) ||
    !boundedTextValue(value.instanceId, MAX_CLIENT_ID_LENGTH)
  ) {
    throw new LocalWorkspaceWorkerClientError(
      'worker_identity_mismatch',
      'Client identity is invalid.',
    );
  }
  return Object.freeze({ name: value.name, version: value.version, instanceId: value.instanceId });
}

async function ensureCoordinatorWorker(
  coordinator: CoordinatorClient,
  workspace: KiteWorkspaceIdentity,
): Promise<CoordinatorWorkerReference> {
  let response: Awaited<ReturnType<CoordinatorRequestClient['ensureWorkspaceWorker']>>;
  try {
    response = await coordinator.ensureWorkspaceWorker({ workspace });
  } catch {
    throw new LocalWorkspaceWorkerClientError(
      'coordinator_unavailable',
      'Coordinator could not ensure the Workspace Worker.',
    );
  }
  if (response.outcome !== 'ok' || response.result.worker === null) {
    if (response.outcome === 'error' && response.error.code === 'identity_mismatch') {
      throw new LocalWorkspaceWorkerClientError(
        'worker_identity_mismatch',
        'Workspace Worker identity is unavailable.',
      );
    }
    throw new LocalWorkspaceWorkerClientError(
      'worker_unavailable',
      response.outcome === 'error' && response.error.code === 'outcome_unknown'
        ? 'Workspace Worker ensure outcome is unknown.'
        : 'Workspace Worker is unavailable.',
    );
  }
  return validateWorkerReference(response.result.worker, workspace);
}

async function mintWorkerCapability(
  coordinator: CoordinatorClient,
  worker: CoordinatorWorkerReference,
  workspace: KiteWorkspaceIdentity,
  clientInfo: RuntimeClientInfo,
  generation: number,
): Promise<string> {
  let response: Awaited<ReturnType<CoordinatorRequestClient['mintWorkerConnectionCapability']>>;
  try {
    response = await coordinator.mintWorkerConnectionCapability({
      workspace,
      workerScopeId: worker.identity.workerScopeId,
      clientId: clientInfo.instanceId,
      connectionGeneration: generation,
      purpose: WORKER_PURPOSE,
    });
  } catch {
    throw new LocalWorkspaceWorkerClientError(
      'coordinator_unavailable',
      'Coordinator could not mint a Workspace Worker capability.',
    );
  }
  if (response.outcome !== 'ok') {
    throw new LocalWorkspaceWorkerClientError(
      response.error.code === 'identity_mismatch'
        ? 'worker_identity_mismatch'
        : 'capability_unavailable',
      response.error.code === 'outcome_unknown'
        ? 'Workspace Worker capability outcome is unknown.'
        : response.error.code === 'identity_mismatch'
          ? 'Workspace Worker capability identity is unavailable.'
          : 'Workspace Worker capability is unavailable.',
    );
  }
  const result = response.result;
  const returnedWorker = validateWorkerReference(result.worker, workspace);
  if (!sameWorkerReference(returnedWorker, worker)) {
    throw new LocalWorkspaceWorkerClientError(
      'worker_identity_mismatch',
      'Workspace Worker capability belongs to a different Worker.',
    );
  }
  if (
    result.clientId !== clientInfo.instanceId ||
    result.connectionGeneration !== generation ||
    result.purpose !== WORKER_PURPOSE ||
    !/^[A-Za-z0-9_-]{32,512}$/u.test(result.workerConnectionCapability) ||
    !timestamp.safeParse(result.expiresAt).success
  ) {
    throw new LocalWorkspaceWorkerClientError(
      'capability_unavailable',
      'Workspace Worker capability response is invalid.',
    );
  }
  return result.workerConnectionCapability;
}

function validateWorkerReference(
  value: CoordinatorWorkerReference,
  expectedWorkspace: KiteWorkspaceIdentity,
): CoordinatorWorkerReference {
  try {
    const identity = COORDINATOR_WORKER_IDENTITY_SCHEMA.parse(value.identity);
    const endpoint = COORDINATOR_WORKER_ENDPOINT_SCHEMA.parse(value.endpoint);
    const workspaceValue = COORDINATOR_WORKSPACE_IDENTITY_SCHEMA.parse(value.workspace);
    const workspace = canonicalWorkspaceIdentity({
      canonicalPath: workspaceValue.canonicalPath,
      projectId: workspaceValue.projectId,
      workspaceDigest: workspaceValue.workspaceDigest as `sha256:${string}`,
    });
    if (!sameWorkspace(workspace, expectedWorkspace)) throw new Error('workspace mismatch');
    return Object.freeze({ identity, endpoint, workspace });
  } catch {
    throw new LocalWorkspaceWorkerClientError(
      'worker_identity_mismatch',
      'Workspace Worker reference identity is invalid.',
    );
  }
}

async function authenticateWorkerInstance(
  worker: CoordinatorWorkerReference,
  capability: string,
  clientInfo: RuntimeClientInfo,
  generation: number,
  fetcher: LocalRuntimeFetch,
): Promise<WorkerHandshake> {
  const url = `${worker.endpoint.origin}${WORKER_INSTANCE_HANDSHAKE_PATH}`;
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'POST',
      headers: bindingHeaders(worker.endpoint.origin, capability, clientInfo, generation),
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      body: '{}',
    });
  } catch {
    throw new LocalWorkspaceWorkerClientError(
      'handshake_failed',
      'Workspace Worker instance handshake failed.',
    );
  }
  if (response.status !== 200 || (response.url.length > 0 && response.url !== url)) {
    throw new LocalWorkspaceWorkerClientError(
      'handshake_failed',
      'Workspace Worker instance handshake was rejected.',
    );
  }
  let value: unknown;
  try {
    value = await readJson(response, MAX_HANDSHAKE_BYTES);
  } catch {
    throw new LocalWorkspaceWorkerClientError(
      'handshake_failed',
      'Workspace Worker instance handshake is invalid.',
    );
  }
  try {
    const decoded = handshakeSchema.parse(value);
    if (
      decoded.instanceId !== worker.identity.instanceId ||
      decoded.buildId !== worker.identity.buildId ||
      decoded.protocolVersion !== RUNTIME_PROTOCOL_VERSION ||
      decoded.clientContractRevision !== LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_
    ) {
      throw new Error('Worker instance identity mismatch');
    }
    // The endpoint is the Coordinator-owned registration we just used for this exact request.
    COORDINATOR_WORKER_ENDPOINT_SCHEMA.parse(worker.endpoint);
    return decoded;
  } catch {
    throw new LocalWorkspaceWorkerClientError(
      'worker_identity_mismatch',
      'Workspace Worker instance identity does not match its registration.',
    );
  }
}

interface WorkerHandshake {
  readonly instanceId: string;
  readonly protocolVersion: typeof RUNTIME_PROTOCOL_VERSION;
  readonly clientContractRevision: typeof LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_;
  readonly serverVersion: string;
  readonly buildId: string;
}

function workerDescriptor(
  worker: CoordinatorWorkerReference,
  handshake: WorkerHandshake,
): LocalRuntimeServiceDescriptor {
  try {
    return Object.freeze({
      ...decodeLocalRuntimeServiceDescriptor({
        schema: 'kite.local-runtime-service.v1',
        instanceId: handshake.instanceId,
        // LocalKiteConnection requires a descriptor-shaped compatibility value. This pid is not
        // used for lifecycle or cleanup; Coordinator/Worker identity remains authoritative.
        pid: process.pid,
        startedAt: new Date().toISOString(),
        endpoint: worker.endpoint,
        protocolVersion: handshake.protocolVersion,
        clientContractRevision: handshake.clientContractRevision,
        serverVersion: handshake.serverVersion || DEFAULT_SERVER_VERSION,
        buildId: handshake.buildId,
      }),
      endpoint: Object.freeze({ ...worker.endpoint }),
    });
  } catch {
    throw new LocalWorkspaceWorkerClientError(
      'handshake_failed',
      'Workspace Worker transport descriptor is invalid.',
    );
  }
}

function createWorkerClientState(state: WorkerConnectionState): LocalRuntimeClientStatePort {
  return Object.freeze({
    async readDescriptor() {
      return state.descriptor;
    },
    async readToken(kind: 'access') {
      if (kind !== 'access') return undefined;
      return state.binding?.capability;
    },
  });
}

function createWorkerControllerClient(
  state: WorkerConnectionState,
  clientInfo: RuntimeClientInfo,
  fetcher: LocalRuntimeFetch,
): WorkerControllerClient {
  const post = async (request: WorkerControllerRequest): Promise<WorkerControllerResponse> => {
    const binding = requireBinding(state);
    let body: string;
    try {
      body = JSON.stringify(workerControllerRequestCodec.encode(request));
    } catch {
      throw new LocalWorkspaceWorkerClientError(
        'handshake_failed',
        'Worker Controller request is invalid.',
      );
    }
    const url = `${binding.worker.endpoint.origin}${WORKER_CONTROLLER_PATH_}`;
    let response: Response;
    try {
      response = await fetcherWithBinding(
        fetcher,
        url,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body,
        },
        binding,
        clientInfo,
        state,
      );
    } catch {
      throw new LocalWorkspaceWorkerClientError(
        'worker_unavailable',
        'Worker Controller request failed.',
      );
    }
    if (response.status !== 200) {
      throw new LocalWorkspaceWorkerClientError(
        response.status === 400 || response.status === 401
          ? 'handshake_failed'
          : 'worker_unavailable',
        'Worker Controller request was rejected.',
      );
    }
    let value: unknown;
    try {
      value = await readJson(response, MAX_HANDSHAKE_BYTES);
      const decoded = workerControllerResponseCodec.decode(value);
      assertControllerResponse(request, decoded);
      updateControllerBinding(state, clientInfo.instanceId, request, decoded);
      return decoded;
    } catch {
      throw new LocalWorkspaceWorkerClientError(
        'handshake_failed',
        'Worker Controller response is invalid.',
      );
    }
  };

  const forOperation = async <Operation extends WorkerControllerResponse['operation']>(
    request: WorkerControllerRequest,
    operation: Operation,
  ): Promise<Extract<WorkerControllerResponse, { readonly operation: Operation }>> => {
    const response = await post(request);
    if (response.operation !== operation) {
      throw new LocalWorkspaceWorkerClientError(
        'handshake_failed',
        'Worker Controller response operation mismatches its request.',
      );
    }
    return response as Extract<WorkerControllerResponse, { readonly operation: Operation }>;
  };

  return Object.freeze({
    createSession: (request: WorkerControllerCreateSessionRequest) =>
      forOperation(request, 'create_session'),
    read: (request: WorkerControllerReadRequest) => forOperation(request, 'read_controller'),
    requestControl: (request: WorkerControllerRequestControlRequest) =>
      forOperation(request, 'request_control'),
    releaseControl: (request: WorkerControllerReleaseControlRequest) =>
      forOperation(request, 'release_control'),
    detach: (request: WorkerControllerDetachRequest) => forOperation(request, 'detach_controller'),
    issueResumeCapability: (request: WorkerControllerIssueResumeCapabilityRequest) =>
      forOperation(request, 'issue_resume_capability'),
    resume: (request: WorkerControllerResumeRequest) => forOperation(request, 'resume_controller'),
    mintDetachedRecoveryCapability: (request: WorkerControllerMintDetachedRecoveryRequest) =>
      forOperation(request, 'mint_detached_recovery_capability'),
    abandonDetachedController: (request: WorkerControllerAbandonDetachedRequest) =>
      forOperation(request, 'abandon_detached_controller'),
    validateResumeCapability: (request: WorkerControllerValidateResumeRequest) =>
      forOperation(request, 'validate_resume_capability'),
  });
}

function assertControllerResponse(
  request: WorkerControllerRequest,
  response: WorkerControllerResponse,
): void {
  if (
    response.operation === 'read_controller' ||
    response.operation === 'validate_resume_capability'
  ) {
    if (response.operation !== request.operation) {
      throw new Error('Worker Controller response operation mismatches request.');
    }
    return;
  }
  if (
    response.operation !== request.operation ||
    response.receipt.sessionId !== request.sessionId ||
    response.receipt.requestId !== request.requestId ||
    response.receipt.requestDigest !== request.requestDigest
  ) {
    throw new Error('Worker Controller response receipt mismatches request.');
  }
}

function updateControllerBinding(
  state: WorkerConnectionState,
  clientId: string,
  request: WorkerControllerRequest,
  response: WorkerControllerResponse,
): void {
  if (response.operation === 'read_controller') {
    if (
      response.state.status === 'active' &&
      response.state.clientId === clientId &&
      response.state.workerInstanceId === state.binding?.worker.identity.instanceId
    ) {
      state.controllerBinding = {
        sessionId: response.state.sessionId,
        controllerGeneration: response.state.controllerGeneration,
      };
    }
    return;
  }
  if (
    response.operation === 'create_session' ||
    response.operation === 'request_control' ||
    response.operation === 'resume_controller'
  ) {
    if (
      (response.status === 'applied' || response.status === 'replay') &&
      response.lease?.status === 'active' &&
      response.lease.clientId === clientId
    ) {
      state.controllerBinding = {
        sessionId: response.lease.sessionId,
        controllerGeneration: response.lease.controllerGeneration,
      };
    } else if (request.sessionId === state.controllerBinding?.sessionId) {
      state.controllerBinding = undefined;
    }
    return;
  }
  if (
    (request.operation === 'release_control' ||
      request.operation === 'abandon_detached_controller') &&
    (response.status === 'applied' || response.status === 'replay') &&
    (response.receipt.code === 'released' || response.receipt.code === 'abandoned') &&
    response.receipt.clientId === clientId
  ) {
    state.controllerBinding = undefined;
  }
}

function createBoundFetch(
  state: WorkerConnectionState,
  clientInfo: RuntimeClientInfo,
  baseFetch: LocalRuntimeFetch,
): LocalRuntimeFetch {
  return (input, init) => {
    const binding = requireBinding(state);
    return fetcherWithBinding(baseFetch, input, init, binding, clientInfo, state);
  };
}

function createBoundWebSocketFactory(
  state: WorkerConnectionState,
  clientInfo: RuntimeClientInfo,
  supplied: NativeRuntimeWebSocketFactory | undefined,
): NativeRuntimeWebSocketFactory {
  const factory = supplied ?? defaultWebSocketFactory;
  return (url, options) => {
    const binding = requireBinding(state);
    const headers = {
      ...options.headers,
      [KITE_WORKER_CLIENT_ID_HEADER]: clientInfo.instanceId,
      [KITE_WORKER_CONNECTION_GENERATION_HEADER]: String(binding.generation),
      [KITE_WORKER_PURPOSE_HEADER]: WORKER_PURPOSE,
      ...(state.controllerBinding === undefined
        ? {}
        : {
            [KITE_WORKER_CONTROLLER_SESSION_HEADER]: state.controllerBinding.sessionId,
            [KITE_WORKER_CONTROLLER_GENERATION_HEADER]: String(
              state.controllerBinding.controllerGeneration,
            ),
          }),
    };
    return factory(url, { headers });
  };
}

function fetcherWithBinding(
  fetcher: LocalRuntimeFetch,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  binding: WorkerBinding,
  clientInfo: RuntimeClientInfo,
  state: WorkerConnectionState,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set(
    'authorization',
    `${LOCAL_RUNTIME_ACCESS_AUTHORIZATION_SCHEME} ${binding.capability}`,
  );
  headers.set('origin', binding.worker.endpoint.origin);
  headers.set(KITE_WORKER_CLIENT_ID_HEADER, clientInfo.instanceId);
  headers.set(KITE_WORKER_CONNECTION_GENERATION_HEADER, String(binding.generation));
  headers.set(KITE_WORKER_PURPOSE_HEADER, WORKER_PURPOSE);
  if (state.controllerBinding !== undefined) {
    headers.set(KITE_WORKER_CONTROLLER_SESSION_HEADER, state.controllerBinding.sessionId);
    headers.set(
      KITE_WORKER_CONTROLLER_GENERATION_HEADER,
      String(state.controllerBinding.controllerGeneration),
    );
  } else {
    headers.delete(KITE_WORKER_CONTROLLER_SESSION_HEADER);
    headers.delete(KITE_WORKER_CONTROLLER_GENERATION_HEADER);
  }
  headers.delete('cookie');
  return fetcher(input, {
    ...init,
    headers,
    credentials: 'omit',
    redirect: 'error',
  });
}

function bindingHeaders(
  origin: string,
  capability: string,
  clientInfo: RuntimeClientInfo,
  generation: number,
): Record<string, string> {
  return {
    authorization: `${LOCAL_RUNTIME_ACCESS_AUTHORIZATION_SCHEME} ${capability}`,
    'content-type': 'application/json',
    accept: 'application/json',
    origin,
    [KITE_WORKER_CLIENT_ID_HEADER]: clientInfo.instanceId,
    [KITE_WORKER_CONNECTION_GENERATION_HEADER]: String(generation),
    [KITE_WORKER_PURPOSE_HEADER]: WORKER_PURPOSE,
  };
}

function requireBinding(state: WorkerConnectionState): WorkerBinding {
  if (state.binding === undefined) {
    throw new LocalWorkspaceWorkerClientError(
      'worker_unavailable',
      'Workspace Worker binding is unavailable.',
    );
  }
  return state.binding;
}

function sameWorkerReference(
  left: CoordinatorWorkerReference,
  right: CoordinatorWorkerReference,
): boolean {
  return (
    left.identity.role === right.identity.role &&
    left.identity.workerScopeId === right.identity.workerScopeId &&
    left.identity.instanceId === right.identity.instanceId &&
    left.identity.buildId === right.identity.buildId &&
    left.identity.protocolVersion === right.identity.protocolVersion &&
    left.identity.protocolRevision === right.identity.protocolRevision &&
    left.identity.clientContractRevision === right.identity.clientContractRevision &&
    sameWorkspace(left.workspace, right.workspace) &&
    left.endpoint.origin === right.endpoint.origin &&
    left.endpoint.websocketUrl === right.endpoint.websocketUrl
  );
}

function sameWorkspace(
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

function boundedText(): z.ZodString {
  return z
    .string()
    .min(1)
    .max(512)
    .refine((value) => ![...value].some((character) => /\p{Cc}/u.test(character)));
}

function boundedTextValue(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    ![...value].some((character) => /\p{Cc}/u.test(character))
  );
}

async function readJson(response: Response, maximumBytes: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maximumBytes) throw new Error('response oversized');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error('response oversized');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
}

function defaultWebSocketFactory(
  url: string,
  options: { readonly headers: Readonly<Record<string, string>> },
): import('@kite-ai/kite-local-runtime/client').NativeRuntimeWebSocketLike {
  const webSocketConstructor = (
    globalThis as unknown as {
      readonly WebSocket?: new (
        url: string,
        options?: unknown,
      ) => import('@kite-ai/kite-local-runtime/client').NativeRuntimeWebSocketLike;
    }
  ).WebSocket;
  if (!webSocketConstructor)
    throw new LocalWorkspaceWorkerClientError(
      'handshake_failed',
      'Native WebSocket is unavailable.',
    );
  return new webSocketConstructor(url, { headers: { ...options.headers } });
}
