import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  WORKER_CONTROLLER_PATH_,
  type WorkerControllerClient,
  type WorkerControllerCreateSessionRequest,
  type WorkerControllerReadRequest,
  type WorkerControllerRequest,
  type WorkerControllerResponse,
  type WorkerControllerResumeCapabilityResponse,
  workerControllerRequestCodec,
  workerControllerResponseCodec,
} from '@kite-ai/kite-app-contract/worker-controller';
import {
  createKiteSingleServiceClient,
  createLocalKiteConnection,
  type KiteSingleServiceClient,
  type KiteSingleServiceClientOptions,
  LOCAL_RUNTIME_ACCESS_AUTHORIZATION_SCHEME,
  LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
  type LocalKiteConnection,
  type LocalRuntimeFetch,
  type LocalRuntimeServiceDescriptor,
  type NativeRuntimeWebSocketFactory,
  type NativeRuntimeWebSocketLike,
} from '@kite-ai/kite-local-runtime/client';
import {
  createKiteSingleServiceManager,
  createKiteSingleServiceNativeProcessIdentityProbe,
  createKiteSingleServiceNativeSpawnPort,
  type KiteServiceManager,
  type KiteServiceManagerExecutable,
} from '@kite-ai/kite-local-runtime/manager';
import {
  createKiteHomeIdentity,
  ensureLocalRuntimeServiceHome,
  type KiteHomeIdentity,
  type KiteLocalRuntimeEndpoint,
  resolveKiteLocalRuntimeEndpoint,
} from '@kite-ai/kite-local-runtime/service';
import type { RuntimeClientInfo } from '@kite-ai/runtime-client';
import {
  explicitKiteHomeArgument,
  installedBuildIdentity,
  resolveInstalledReleaseExecutable,
  selectKiteServiceEnvironmentSource,
  sourceServiceBuildIdentity,
} from './local-service-client';

const SINGLE_SERVICE_CLIENT_ID_HEADER = 'x-kite-worker-client-id' as const;
const SINGLE_SERVICE_CONNECTION_GENERATION_HEADER = 'x-kite-worker-connection-generation' as const;
const SINGLE_SERVICE_PURPOSE_HEADER = 'x-kite-worker-purpose' as const;
const SINGLE_SERVICE_WORKSPACE_HEADER = 'x-kite-workspace' as const;
const SINGLE_SERVICE_CONTROLLER_SESSION_HEADER = 'x-kite-worker-controller-session' as const;
const SINGLE_SERVICE_CONTROLLER_GENERATION_HEADER = 'x-kite-worker-controller-generation' as const;
const SINGLE_SERVICE_NATIVE_PURPOSE = 'native_client' as const;
const SINGLE_SERVICE_CONTROLLER_MAX_RESPONSE_BYTES = 32 * 1024;

export interface SingleServiceNativeClientCompositionOptions {
  readonly home: KiteHomeIdentity;
  readonly runtimeParent?: string;
  readonly platform?: NodeJS.Platform;
  readonly expectedBuildId: string;
  readonly request?: KiteSingleServiceClientOptions['request'];
}

export interface SingleServiceNativeClientComposition {
  readonly endpoint: KiteLocalRuntimeEndpoint;
  readonly expectedBuildId: string;
  readonly client: KiteSingleServiceClient;
  readonly discoverWeb: () => Promise<string>;
}

export interface ManagedSingleServiceNativeCompositionOptions
  extends SingleServiceNativeClientCompositionOptions {
  readonly staticAssetRoot: string;
  readonly executable: KiteServiceManagerExecutable;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly args?: readonly string[];
  readonly childStderr?: 'ignore' | 'inherit';
  readonly startupTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
  readonly fetch?: LocalRuntimeFetch;
  readonly webSocketFactory?: NativeRuntimeWebSocketFactory;
}

export interface ManagedSingleServiceNativeComposition
  extends SingleServiceNativeClientComposition {
  readonly manager: KiteServiceManager;
  readonly connector: {
    connect(input: {
      readonly workspace: string;
      readonly clientInfo?: RuntimeClientInfo;
    }): Promise<ManagedSingleServiceNativeConnection>;
  };
}

export type ManagedSingleServiceNativeConnection = LocalKiteConnection & {
  readonly controller: WorkerControllerClient;
};

export interface ManagedLocalSingleServiceCompositionOptions {
  readonly argv?: readonly string[];
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly systemHome?: string;
  readonly executableMode?: 'source' | 'installed';
}

/**
 * Target-only release binding. Home/runtime/build identities are supplied by the release
 * owner; App code receives only typed client operations and never resolves a socket or token.
 */
export function createSingleServiceNativeClientComposition(
  options: SingleServiceNativeClientCompositionOptions,
): SingleServiceNativeClientComposition {
  const platform = options.platform ?? process.platform;
  const endpoint = resolveKiteLocalRuntimeEndpoint({
    home: options.home,
    platform,
    ...(platform === 'win32' ? {} : { runtimeParent: options.runtimeParent }),
  });
  const client = createKiteSingleServiceClient({
    endpoint,
    expectedBuildId: options.expectedBuildId,
    ...(options.request ? { request: options.request } : {}),
  });
  return Object.freeze({
    endpoint,
    expectedBuildId: options.expectedBuildId,
    client,
    discoverWeb: async () => {
      const response = await client.describe();
      return `${response.service.httpOrigin}/`;
    },
  });
}

/** Real-child target binding; still not selected by the public CLI before clean cutover. */
export function createManagedSingleServiceNativeComposition(
  options: ManagedSingleServiceNativeCompositionOptions,
): ManagedSingleServiceNativeComposition {
  if (!isAbsolute(options.staticAssetRoot)) {
    throw new TypeError('Single-Service Web asset root must be absolute.');
  }
  const staticAssetRoot = resolve(options.staticAssetRoot);
  if (options.env.KITE_SERVICE_WEB_STATIC_ROOT !== staticAssetRoot) {
    throw new Error('Single-Service child Web asset root does not match release composition.');
  }
  const base = createSingleServiceNativeClientComposition(options);
  const manager = createKiteSingleServiceManager({
    endpoint: base.endpoint,
    client: base.client,
    process: createKiteSingleServiceNativeProcessIdentityProbe(options.platform),
    spawn: createKiteSingleServiceNativeSpawnPort({
      executable: options.executable,
      args: options.args ?? ['service', 'run-single'],
      cwd: options.cwd,
      env: options.env,
      ...(options.childStderr === undefined ? {} : { stderr: options.childStderr }),
    }),
    ...(options.startupTimeoutMs === undefined
      ? {}
      : { startupTimeoutMs: options.startupTimeoutMs }),
    ...(options.stopTimeoutMs === undefined ? {} : { stopTimeoutMs: options.stopTimeoutMs }),
  });
  let descriptor:
    | import('@kite-ai/kite-local-runtime/client').LocalRuntimeServiceDescriptor
    | undefined;
  let accessToken: string | undefined;
  const refreshDiscovery = async () => {
    const current = await base.client.describe();
    descriptor = Object.freeze({
      schema: 'kite.local-runtime-service.v1',
      instanceId: current.service.instanceId,
      pid: current.service.pid,
      startedAt: current.service.startedAt,
      endpoint: Object.freeze({
        origin: current.service.httpOrigin,
        websocketUrl: `${current.service.httpOrigin.replace(/^http:/u, 'ws:')}/rpc`,
      }),
      protocolVersion: current.service.protocolVersion,
      clientContractRevision: current.service.clientContractRevision,
      serverVersion: current.service.serverVersion,
      buildId: current.service.buildId,
    });
    accessToken = current.accessToken;
    return descriptor;
  };
  const baseFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const connector = Object.freeze({
    async connect(input: {
      readonly workspace: string;
      readonly clientInfo?: RuntimeClientInfo;
    }): Promise<ManagedSingleServiceNativeConnection> {
      const workspace = canonicalWorkspace(input.workspace);
      const clientInfo = validateClientInfo(
        input.clientInfo ?? {
          name: 'kite-terminal',
          version: '0.1.0',
          instanceId: `terminal_${randomUUID()}`,
        },
      );
      const state: SingleServiceConnectionState = {
        generation: 0,
        serviceInstanceId: undefined,
        controllerBinding: undefined,
      };
      const boundFetch = createSingleServiceBoundFetch(
        state,
        workspace,
        clientInfo,
        () => requireDiscovery(descriptor, accessToken),
        baseFetch,
      );
      const webSocketFactory = createSingleServiceBoundWebSocketFactory(
        state,
        workspace,
        clientInfo,
        options.webSocketFactory,
      );
      const controller = createSingleServiceControllerClient({
        state,
        workspace,
        clientInfo,
        discovery: () => requireDiscovery(descriptor, accessToken),
        fetch: boundFetch,
      });
      const connection = createLocalKiteConnection({
        manager: {
          async ensure(options) {
            const previousServiceInstanceId = state.serviceInstanceId;
            const controllerRecovery = state.controllerBinding;
            const result = await manager.ensure({
              ...(options?.clientContractRevision
                ? { clientContractRevision: options.clientContractRevision }
                : {}),
            });
            if (result.outcome !== 'applied' || result.state !== 'ready') return result;
            const discovered = await refreshDiscovery();
            if (state.generation === 0) {
              state.generation = 1;
              state.controllerBinding = undefined;
            } else if (!controllerRecovery || previousServiceInstanceId !== discovered.instanceId) {
              state.generation += 1;
              state.controllerBinding = undefined;
              if (controllerRecovery) {
                const nextSecret = randomBytes(32).toString('base64url');
                const expiresAtMs = Date.now() + 5 * 60_000;
                const response = await controller.resume({
                  schema: 'kite.app.worker-controller.request.v1',
                  operation: 'resume_controller',
                  sessionId: controllerRecovery.sessionId,
                  requestId: `service-resume-${randomUUID()}`,
                  requestDigest: createHash('sha256')
                    .update(
                      `${controllerRecovery.sessionId}\0${controllerRecovery.controllerGeneration}\0${state.generation}`,
                    )
                    .digest('hex'),
                  controllerGeneration: controllerRecovery.controllerGeneration,
                  currentSecret: controllerRecovery.resumeSecret,
                  nextSecret,
                  expiresAtMs,
                });
                if (
                  (response.status !== 'applied' && response.status !== 'replay') ||
                  response.lease?.status !== 'active'
                ) {
                  throw new Error('Single-Service Controller restart recovery was rejected.');
                }
              }
            }
            state.serviceInstanceId = discovered.instanceId;
            return discovered;
          },
        },
        state: {
          readDescriptor: async () => descriptor,
          readToken: async () => accessToken,
        },
        workspace,
        clientInfo,
        clientContractRevision: LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
        fetch: boundFetch,
        webSocketFactory,
      });
      try {
        await connection.prepareAppControl();
        return Object.assign(connection, {
          controller,
        });
      } catch (error) {
        await connection.close('app_control_prepare_failed').catch(() => undefined);
        throw error;
      }
    },
  });
  return Object.freeze({
    ...base,
    discoverWeb: async () => {
      const ensured = await manager.ensure();
      if (ensured.outcome !== 'applied' || ensured.state !== 'ready') {
        throw new Error(`Single-Service ensure failed: ${ensured.diagnostic ?? ensured.outcome}.`);
      }
      const response = await base.client.describe();
      return `${response.service.httpOrigin}/`;
    },
    manager,
    connector,
  });
}

/** Public release/source selection for the accepted single-Service target. */
export function createManagedLocalSingleServiceComposition(
  options: ManagedLocalSingleServiceCompositionOptions = {},
): ManagedSingleServiceNativeComposition {
  const sourceEnvironment = options.environment ?? process.env;
  const systemHome = realpathSync.native(options.systemHome ?? userInfo().homedir);
  const explicitHome = explicitKiteHomeArgument(options.argv ?? process.argv);
  const home = ensureLocalRuntimeServiceHome(
    createKiteHomeIdentity(
      explicitHome ?? join(systemHome, '.kite-code'),
      explicitHome === undefined ? 'os_user_home' : 'explicit_argument',
    ),
  );
  const executableMode = options.executableMode ?? 'source';
  const repositoryRoot = resolve(import.meta.dir, '../..');
  const sourceBuildId =
    executableMode === 'source'
      ? sourceServiceBuildIdentity(repositoryRoot)
      : 'dev:installed-placeholder';
  const expectedBuildId =
    executableMode === 'source' ? sourceBuildId : installedBuildIdentity(process.execPath);
  const candidateRoot = resolve(
    process.env.KITE_CODE_RELEASE_ROOT ?? dirname(dirname(process.execPath)),
  );
  const staticAssetRoot =
    executableMode === 'source'
      ? join(repositoryRoot, 'apps', 'kite-web', 'dist')
      : join(candidateRoot, 'payload', 'web');
  const runtimeParent = singleServiceRuntimeParent(sourceEnvironment);
  const selected = selectKiteServiceEnvironmentSource(sourceEnvironment);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(selected)) {
    if (value !== undefined) env[key] = value;
  }
  env.HOME = systemHome;
  if (process.platform === 'win32') env.USERPROFILE = systemHome;
  env.KITE_CODE_HOME = home.root;
  env.KITE_SERVICE_BUILD_ID = expectedBuildId;
  env.KITE_SERVICE_WEB_STATIC_ROOT = staticAssetRoot;
  env.NODE_ENV = 'production';
  if (process.platform !== 'win32') env.KITE_SINGLE_SERVICE_RUNTIME_PARENT = runtimeParent;
  return createManagedSingleServiceNativeComposition({
    home,
    runtimeParent,
    expectedBuildId,
    staticAssetRoot,
    executable:
      executableMode === 'source'
        ? {
            path: resolve(import.meta.dir, './entrypoints/service.ts'),
            mode: 'source',
            buildId: sourceBuildId,
          }
        : {
            path: resolveInstalledReleaseExecutable('kite-service'),
            mode: 'installed',
            buildId: expectedBuildId,
          },
    cwd: runtimeParent,
    env,
  });
}

interface SingleServiceConnectionState {
  generation: number;
  serviceInstanceId: string | undefined;
  controllerBinding:
    | Readonly<{
        readonly sessionId: string;
        readonly controllerGeneration: number;
        readonly resumeSecret: string;
      }>
    | undefined;
}

interface SingleServiceDiscovery {
  readonly descriptor: LocalRuntimeServiceDescriptor;
  readonly accessToken: string;
}

function canonicalWorkspace(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 4_096 ||
    !isAbsolute(value) ||
    /\p{Cc}/u.test(value)
  ) {
    throw new TypeError('Single-Service Workspace path is invalid.');
  }
  return realpathSync.native(resolve(value));
}

function validateClientInfo(value: RuntimeClientInfo): RuntimeClientInfo {
  if (
    !boundedIdentity(value.name) ||
    !boundedIdentity(value.version) ||
    !boundedIdentity(value.instanceId)
  ) {
    throw new TypeError('Single-Service native client identity is invalid.');
  }
  return Object.freeze({ name: value.name, version: value.version, instanceId: value.instanceId });
}

function boundedIdentity(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= 512 && !/\p{Cc}/u.test(value)
  );
}

function requireDiscovery(
  descriptor: LocalRuntimeServiceDescriptor | undefined,
  accessToken: string | undefined,
): SingleServiceDiscovery {
  if (!descriptor || !accessToken) {
    throw new Error('Single-Service discovery is unavailable.');
  }
  return { descriptor, accessToken };
}

function createSingleServiceBoundFetch(
  state: SingleServiceConnectionState,
  workspace: string,
  clientInfo: RuntimeClientInfo,
  discovery: () => SingleServiceDiscovery,
  baseFetch: LocalRuntimeFetch,
): LocalRuntimeFetch {
  return (request, init) => {
    if (!Number.isSafeInteger(state.generation) || state.generation < 1) {
      throw new Error('Single-Service native connection generation is unavailable.');
    }
    const current = discovery();
    const headers = new Headers(init?.headers);
    headers.set(
      'authorization',
      `${LOCAL_RUNTIME_ACCESS_AUTHORIZATION_SCHEME} ${current.accessToken}`,
    );
    headers.set('origin', current.descriptor.endpoint.origin);
    headers.set(SINGLE_SERVICE_CLIENT_ID_HEADER, clientInfo.instanceId);
    headers.set(SINGLE_SERVICE_CONNECTION_GENERATION_HEADER, String(state.generation));
    headers.set(SINGLE_SERVICE_PURPOSE_HEADER, SINGLE_SERVICE_NATIVE_PURPOSE);
    headers.set(SINGLE_SERVICE_WORKSPACE_HEADER, workspace);
    if (state.controllerBinding) {
      headers.set(SINGLE_SERVICE_CONTROLLER_SESSION_HEADER, state.controllerBinding.sessionId);
      headers.set(
        SINGLE_SERVICE_CONTROLLER_GENERATION_HEADER,
        String(state.controllerBinding.controllerGeneration),
      );
    } else {
      headers.delete(SINGLE_SERVICE_CONTROLLER_SESSION_HEADER);
      headers.delete(SINGLE_SERVICE_CONTROLLER_GENERATION_HEADER);
    }
    headers.delete('cookie');
    return baseFetch(request, {
      ...init,
      headers,
      credentials: 'omit',
      redirect: 'error',
    });
  };
}

function createSingleServiceBoundWebSocketFactory(
  state: SingleServiceConnectionState,
  workspace: string,
  clientInfo: RuntimeClientInfo,
  supplied: NativeRuntimeWebSocketFactory | undefined,
): NativeRuntimeWebSocketFactory {
  const factory = supplied ?? defaultSingleServiceWebSocketFactory;
  return (url, options) => {
    if (!Number.isSafeInteger(state.generation) || state.generation < 1) {
      throw new Error('Single-Service native connection generation is unavailable.');
    }
    const headers: Record<string, string> = {
      ...options.headers,
      [SINGLE_SERVICE_CLIENT_ID_HEADER]: clientInfo.instanceId,
      [SINGLE_SERVICE_CONNECTION_GENERATION_HEADER]: String(state.generation),
      [SINGLE_SERVICE_PURPOSE_HEADER]: SINGLE_SERVICE_NATIVE_PURPOSE,
      [SINGLE_SERVICE_WORKSPACE_HEADER]: workspace,
    };
    if (state.controllerBinding) {
      headers[SINGLE_SERVICE_CONTROLLER_SESSION_HEADER] = state.controllerBinding.sessionId;
      headers[SINGLE_SERVICE_CONTROLLER_GENERATION_HEADER] = String(
        state.controllerBinding.controllerGeneration,
      );
    } else {
      delete headers[SINGLE_SERVICE_CONTROLLER_SESSION_HEADER];
      delete headers[SINGLE_SERVICE_CONTROLLER_GENERATION_HEADER];
    }
    delete headers.cookie;
    return factory(url, { headers });
  };
}

function createSingleServiceControllerClient(input: {
  readonly state: SingleServiceConnectionState;
  readonly workspace: string;
  readonly clientInfo: RuntimeClientInfo;
  readonly discovery: () => SingleServiceDiscovery;
  readonly fetch: LocalRuntimeFetch;
}): WorkerControllerClient {
  const post = async (request: WorkerControllerRequest): Promise<WorkerControllerResponse> => {
    const current = input.discovery();
    let body: string;
    try {
      body = JSON.stringify(workerControllerRequestCodec.encode(request));
    } catch {
      throw new Error('Single-Service Controller request is invalid.');
    }
    let response: Response;
    try {
      response = await input.fetch(
        `${current.descriptor.endpoint.origin}${WORKER_CONTROLLER_PATH_}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body,
        },
      );
    } catch {
      throw new Error('Single-Service Controller is unavailable.');
    }
    if (response.status !== 200) {
      throw new Error(`Single-Service Controller rejected the request (${response.status}).`);
    }
    let decoded: WorkerControllerResponse;
    try {
      decoded = workerControllerResponseCodec.decode(
        await readBoundedJson(response, SINGLE_SERVICE_CONTROLLER_MAX_RESPONSE_BYTES),
      );
      assertControllerResponse(request, decoded);
    } catch {
      throw new Error('Single-Service Controller response is invalid.');
    }
    updateControllerBinding(
      input.state,
      input.clientInfo.instanceId,
      current.descriptor.instanceId,
      request,
      decoded,
    );
    return decoded;
  };
  const forOperation = async <Operation extends WorkerControllerResponse['operation']>(
    request: WorkerControllerRequest,
    operation: Operation,
  ): Promise<Extract<WorkerControllerResponse, { readonly operation: Operation }>> => {
    const response = await post(request);
    if (response.operation !== operation) {
      throw new Error('Single-Service Controller response operation mismatches its request.');
    }
    return response as Extract<WorkerControllerResponse, { readonly operation: Operation }>;
  };
  return Object.freeze({
    createSession: (request: WorkerControllerCreateSessionRequest) =>
      forOperation(request, 'create_session'),
    read: (request: WorkerControllerReadRequest) => forOperation(request, 'read_controller'),
    requestControl: (request) => forOperation(request, 'request_control'),
    releaseControl: (request) => forOperation(request, 'release_control'),
    detach: (request) => forOperation(request, 'detach_controller'),
    issueResumeCapability: (request) => forOperation(request, 'issue_resume_capability'),
    resume: (request) => forOperation(request, 'resume_controller'),
    mintDetachedRecoveryCapability: (request) =>
      forOperation(request, 'mint_detached_recovery_capability'),
    abandonDetachedController: (request) => forOperation(request, 'abandon_detached_controller'),
    validateResumeCapability: async (request): Promise<WorkerControllerResumeCapabilityResponse> =>
      forOperation(request, 'validate_resume_capability'),
  } satisfies WorkerControllerClient);
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
      throw new Error('Single-Service Controller response operation mismatches its request.');
    }
    return;
  }
  if (
    response.operation !== request.operation ||
    response.receipt.sessionId !== request.sessionId ||
    response.receipt.requestId !== request.requestId ||
    response.receipt.requestDigest !== request.requestDigest
  ) {
    throw new Error('Single-Service Controller response receipt mismatches its request.');
  }
}

function updateControllerBinding(
  state: SingleServiceConnectionState,
  clientId: string,
  serviceInstanceId: string,
  request: WorkerControllerRequest,
  response: WorkerControllerResponse,
): void {
  if (response.operation === 'read_controller') {
    if (
      response.state.status === 'active' &&
      response.state.clientId === clientId &&
      response.state.workerInstanceId === serviceInstanceId &&
      response.state.connectionGeneration === state.generation &&
      state.controllerBinding?.sessionId === response.state.sessionId
    ) {
      state.controllerBinding = {
        sessionId: response.state.sessionId,
        controllerGeneration: response.state.controllerGeneration,
        resumeSecret: state.controllerBinding.resumeSecret,
      };
    } else if (state.controllerBinding?.sessionId === request.sessionId) {
      state.controllerBinding = undefined;
    }
    return;
  }
  if (
    response.operation === 'create_session' ||
    response.operation === 'request_control' ||
    response.operation === 'resume_controller'
  ) {
    const resumeSecret =
      request.operation === 'resume_controller'
        ? request.nextSecret
        : request.operation === 'create_session' || request.operation === 'request_control'
          ? request.resumeSecret
          : undefined;
    if (
      (response.status === 'applied' || response.status === 'replay') &&
      response.lease?.status === 'active' &&
      response.lease.clientId === clientId &&
      response.lease.workerInstanceId === serviceInstanceId &&
      response.lease.connectionGeneration === state.generation &&
      resumeSecret !== undefined
    ) {
      state.controllerBinding = {
        sessionId: response.lease.sessionId,
        controllerGeneration: response.lease.controllerGeneration,
        resumeSecret,
      };
    } else if (state.controllerBinding?.sessionId === request.sessionId) {
      state.controllerBinding = undefined;
    }
    return;
  }
  if (
    (response.operation === 'release_control' ||
      response.operation === 'detach_controller' ||
      response.operation === 'abandon_detached_controller') &&
    (response.status === 'applied' || response.status === 'replay') &&
    state.controllerBinding?.sessionId === request.sessionId
  ) {
    state.controllerBinding = undefined;
  }
}

async function readBoundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maximumBytes) throw new Error('response oversized');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
}

function defaultSingleServiceWebSocketFactory(
  url: string,
  options: { readonly headers: Readonly<Record<string, string>> },
): NativeRuntimeWebSocketLike {
  const webSocketConstructor = (
    globalThis as unknown as {
      readonly WebSocket?: new (url: string, options?: unknown) => NativeRuntimeWebSocketLike;
    }
  ).WebSocket;
  if (!webSocketConstructor) throw new Error('Native WebSocket is unavailable.');
  return new webSocketConstructor(url, { headers: { ...options.headers } });
}

function singleServiceRuntimeParent(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const candidate =
    process.platform === 'linux' && environment.XDG_RUNTIME_DIR
      ? environment.XDG_RUNTIME_DIR
      : tmpdir();
  if (!isAbsolute(candidate)) throw new Error('OS runtime parent must be absolute.');
  const canonical = realpathSync.native(candidate);
  const stat = lstatSync(canonical);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('OS runtime parent must be a real directory.');
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    // A shared system temp directory is allowed; the per-home child root is still owner-only.
    if ((stat.mode & 0o002) === 0) throw new Error('OS runtime parent owner is invalid.');
  }
  return canonical;
}
