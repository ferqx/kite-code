import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  COORDINATOR_CLIENT_CONTRACT_REVISION_,
  COORDINATOR_PROTOCOL_REVISION_,
  COORDINATOR_PROTOCOL_VERSION,
  type CoordinatorClientIdentity,
  type CoordinatorHandshakeResponse,
  type CoordinatorListSessionMetadataParams,
  type CoordinatorManagerRequest,
  type CoordinatorManagerResult,
  type CoordinatorMintWorkerConnectionCapabilityParams,
  type CoordinatorProcessManager,
  type CoordinatorRequestClient,
  type CoordinatorResolveSessionWorkspaceParams,
  type CoordinatorResponseFor,
  type CoordinatorSubscribeDirectoryChangesParams,
  type CoordinatorWorkspaceParams,
  coordinatorManagedConnection,
  createCoordinatorProcessExecutableResolver,
  createCoordinatorProcessHost,
  createCoordinatorProcessManager,
  createCoordinatorProcessPort,
  createCoordinatorProcessStatePort,
  createCoordinatorRequestClient,
  createCoordinatorSocketRequestTransport,
  readCoordinatorProcessStartIdentity,
  resolveCoordinatorStatePaths,
} from '@kite-ai/kite-local-runtime/coordinator';
import {
  createKiteHomeIdentity,
  ensureLocalRuntimeServiceHome,
  type KiteHomeIdentity,
  resolveCurrentWindowsUserSid,
} from '@kite-ai/kite-local-runtime/service';
import {
  assertSqliteCoordinatorCatalogActive,
  readSqliteActiveLayoutPointer,
  readSqliteRuntimeLayoutManifest,
  readSqliteRuntimeMigrationFence,
  readSqliteRuntimeMigrationJournal,
  resolveSqliteCatalogPath,
  resolveSqliteRuntimeLayoutPaths,
  sqliteCurrentRuntimeStorePath,
} from '@kite-ai/runtime-storage-sqlite';
import { runLocalLayoutMigration } from './local-layout-migration';
import { installedBuildIdentity, sourceServiceBuildIdentity } from './local-service-client';

const COORDINATOR_NEUTRAL_DIRECTORY = 'neutral-cwd';
const DEFAULT_OPERATION_DEADLINE_MS = 30_000;

export interface ManagedLocalCoordinatorLifecycle {
  ensure(request?: CoordinatorManagerRequest): Promise<CoordinatorManagerResult>;
  status(request?: CoordinatorManagerRequest): Promise<CoordinatorManagerResult>;
  stop(request?: CoordinatorManagerRequest): Promise<CoordinatorManagerResult>;
}

export interface ManagedLocalCoordinatorClientComposition {
  readonly client: CoordinatorRequestClient;
  readonly lifecycle: ManagedLocalCoordinatorLifecycle;
  /** Resolve the existing Gateway URL; this never starts a Gateway. */
  readonly discoverWebGateway: () => Promise<string | undefined>;
  readonly executableMode: 'source' | 'installed';
}

export interface ManagedLocalCoordinatorClientCompositionOptions {
  readonly argv?: readonly string[];
  /** Canonical OS account home supplied by the release/platform adapter. */
  readonly systemHome?: string;
  /** Build-owned immutable executable selection; never inferred from cwd or PATH. */
  readonly executableMode?: 'source' | 'installed';
  /** Trusted native platform identity. Windows callers must provide the verified SID. */
  readonly peerOsIdentity?:
    | { readonly kind: 'posix_uid'; readonly uid: number }
    | { readonly kind: 'windows_sid'; readonly sid: string };
  /** Test/platform seam for the process identity lookup. */
  readonly readProcessStartIdentity?: () => Promise<string | undefined>;
}

/**
 * Compose the release-side Coordinator owner and a client-only request facade.
 *
 * The returned request methods establish one short native connection, complete the
 * server-owned handshake, perform one closed Coordinator method, and close the connection.
 * No browser/Web data or Runtime command is exposed by this composition.
 */
export function createManagedLocalCoordinatorClientComposition(
  options: ManagedLocalCoordinatorClientCompositionOptions = {},
): ManagedLocalCoordinatorClientComposition {
  const executableMode = options.executableMode ?? 'source';
  const systemHome = realpathSync(options.systemHome ?? userInfo().homedir);
  const explicitHome = explicitKiteHomeArgument(options.argv ?? process.argv);
  const home = ensureLocalRuntimeServiceHome(
    createKiteHomeIdentity(
      explicitHome ?? join(systemHome, '.kite-code'),
      explicitHome === undefined ? 'os_user_home' : 'explicit_argument',
    ),
  );
  const peerOsIdentity = resolveCoordinatorPeerOsIdentity(options.peerOsIdentity);
  const statePaths = resolveCoordinatorStatePaths(home);
  const state = createCoordinatorProcessStatePort(home);
  ensureNeutralDirectory(join(statePaths.root, COORDINATOR_NEUTRAL_DIRECTORY));

  const sourceBuildId =
    executableMode === 'source'
      ? sourceServiceBuildIdentity(resolve(import.meta.dir, '../..'))
      : undefined;
  const sourceExecutable = resolve(import.meta.dir, 'entrypoints/coordinator.ts');
  const installedExecutable = join(
    dirname(process.execPath),
    process.platform === 'win32' ? 'kite-coordinator.exe' : 'kite-coordinator',
  );
  const installedBuildId =
    executableMode === 'installed' ? installedBuildIdentity(installedExecutable) : undefined;
  const expectedBuildId = requireBuildIdentity(
    executableMode === 'source' ? sourceBuildId : installedBuildId,
  );
  const companionRoot =
    executableMode === 'source'
      ? resolve(import.meta.dir, '../..')
      : dirname(dirname(installedExecutable));
  const coordinationHome = join(systemHome, '.kite-code-coordination');
  const webStaticRoot =
    executableMode === 'source'
      ? join(companionRoot, 'apps', 'kite-web', 'dist')
      : join(companionRoot, 'payload', 'web');

  const managerProcess = createCoordinatorProcessPort();
  const processHost = createCoordinatorProcessHost({ runtimeExecutable: process.execPath });
  const managerProcessStartIdentityPromise = resolveManagerProcessStartIdentity();
  const managerPromise = createManagerWhenIdentityIsKnown();

  const lifecycle: ManagedLocalCoordinatorLifecycle = Object.freeze({
    ensure: (request?: CoordinatorManagerRequest) =>
      runLifecycleOperation('ensure', request, async (manager) => manager.ensure(request)),
    status: (request?: CoordinatorManagerRequest) =>
      runLifecycleOperation('status', request, async (manager) => manager.status(request)),
    stop: (request?: CoordinatorManagerRequest) =>
      runLifecycleOperation('stop', request, async (manager) => manager.stop(request)),
  });

  const client = createManagedRequestClient();

  return Object.freeze({
    client,
    lifecycle,
    discoverWebGateway: async () => {
      const response = await client.discoverWebGateway();
      if (response.outcome !== 'ok' || response.result.gateway === null) return undefined;
      return response.result.launchUrl;
    },
    executableMode,
  });

  async function createManagerWhenIdentityIsKnown(): Promise<CoordinatorProcessManager> {
    const processStartIdentity = await managerProcessStartIdentityPromise;
    // Passing an empty identity intentionally activates the Coordinator manager's existing
    // fail-closed branch. It cannot acquire a lifecycle lock or spawn when this proof is absent.
    const managerProcessStartIdentity = processStartIdentity ?? '';
    return createCoordinatorProcessManager({
      state,
      process: managerProcess,
      spawn: processHost,
      executableResolver: createCoordinatorProcessExecutableResolver({
        source: sourceExecutable,
        installed: installedExecutable,
        ...(sourceBuildId === undefined ? {} : { sourceBuildId }),
        ...(installedBuildId === undefined ? {} : { installedBuildId }),
      }),
      environment: {
        async resolve() {
          const active = resolveCommittedCoordinatorLayout(home);
          return Object.freeze({
            cwd: join(statePaths.root, COORDINATOR_NEUTRAL_DIRECTORY),
            env: Object.freeze({
              KITE_COORDINATOR_HOME: home.root,
              KITE_COORDINATOR_COORDINATION_HOME: coordinationHome,
              KITE_COORDINATOR_CATALOG_PATH: active.catalogPath,
              KITE_COORDINATOR_LAYOUT_GENERATION: active.layoutGeneration,
              KITE_COORDINATOR_BUILD_ID: expectedBuildId,
              KITE_COORDINATOR_EXECUTABLE_MODE: executableMode,
              KITE_COORDINATOR_COMPANION_ROOT: companionRoot,
              KITE_COORDINATOR_WEB_STATIC_ROOT: webStaticRoot,
              ...(peerOsIdentity.kind === 'posix_uid'
                ? { KITE_COORDINATOR_OS_UID: String(peerOsIdentity.uid) }
                : { KITE_COORDINATOR_OS_SID: peerOsIdentity.sid }),
            }),
          });
        },
      },
      probe: {
        handshake: async ({ descriptor, endpoint }) => {
          const transport = createCoordinatorSocketRequestTransport({
            home,
            endpoint,
            operationDeadlineMs: DEFAULT_OPERATION_DEADLINE_MS,
          });
          const requestClient = createCoordinatorRequestClient({
            transport,
            identity: clientIdentity(expectedBuildId),
            expectedCoordinator: endpoint.coordinator,
            peerOsIdentity,
            deadlineMs: DEFAULT_OPERATION_DEADLINE_MS,
          });
          try {
            const response = await requestClient.handshake();
            return handshakeToManagerResult(response, descriptor);
          } catch {
            return { outcome: 'unavailable', diagnostic: 'identity_uncertain' as const };
          } finally {
            await Promise.resolve(transport.close?.()).catch(() => undefined);
          }
        },
      },
      expectedBuildId,
      managerProcessStartIdentity,
      operationTimeoutMs: DEFAULT_OPERATION_DEADLINE_MS,
      startupTimeoutMs: DEFAULT_OPERATION_DEADLINE_MS,
    });
  }

  async function runLifecycleOperation(
    operation: 'ensure' | 'status' | 'stop',
    request: CoordinatorManagerRequest | undefined,
    invoke: (manager: CoordinatorProcessManager) => Promise<CoordinatorManagerResult>,
  ): Promise<CoordinatorManagerResult> {
    const id = request?.requestId ?? `release-coordinator-${randomUUID()}`;
    try {
      if (operation === 'ensure') await initializeFreshLayoutIfNeeded();
      resolveCommittedCoordinatorLayout(home);
    } catch {
      return unavailableLifecycleResult(operation, id);
    }
    try {
      return await invoke(await managerPromise);
    } catch {
      return unavailableLifecycleResult(operation, id);
    }
  }

  async function initializeFreshLayoutIfNeeded(): Promise<void> {
    if (!(await managerProcessStartIdentityPromise)) {
      throw new Error('Kite Coordinator manager process identity is unavailable.');
    }
    try {
      resolveCommittedCoordinatorLayout(home);
      return;
    } catch {
      // A missing layout may be a genuinely fresh home or migration evidence. The maintenance
      // helper creates only the former; legacy/corrupt/partial state remains fail closed.
    }
    const result = await runLocalLayoutMigration({
      home,
      sourceStorePath: sqliteCurrentRuntimeStorePath(join(home.root, 'checkpoints.sqlite')),
    });
    if (result.status !== 'initialized') {
      throw new Error('Kite Coordinator layout requires explicit offline maintenance.');
    }
  }

  async function resolveManagerProcessStartIdentity(): Promise<string | undefined> {
    try {
      return await (
        options.readProcessStartIdentity ?? (() => readCoordinatorProcessStartIdentity())
      )();
    } catch {
      return undefined;
    }
  }

  function createManagedRequestClient(): CoordinatorRequestClient {
    const withRequest = async <Value>(
      operation: (client: CoordinatorRequestClient) => Promise<Value>,
    ): Promise<Value> => {
      const ensured = await lifecycle.ensure({ executableMode });
      const connection = coordinatorManagedConnection(ensured);
      const transport = createCoordinatorSocketRequestTransport({
        home,
        endpoint: connection.endpoint,
        operationDeadlineMs: DEFAULT_OPERATION_DEADLINE_MS,
      });
      const requestClient = createCoordinatorRequestClient({
        transport,
        identity: clientIdentity(expectedBuildId),
        expectedCoordinator: connection.endpoint.coordinator,
        peerOsIdentity,
        deadlineMs: DEFAULT_OPERATION_DEADLINE_MS,
      });
      try {
        const handshake = await requestClient.handshake();
        if (!handshake.accepted) {
          throw new Error('Kite Coordinator rejected the client identity.');
        }
        return await operation(requestClient);
      } finally {
        await Promise.resolve(transport.close?.()).catch(() => undefined);
      }
    };

    const handshake = async (): Promise<CoordinatorHandshakeResponse> => {
      const ensured = await lifecycle.ensure({ executableMode });
      const connection = coordinatorManagedConnection(ensured);
      const transport = createCoordinatorSocketRequestTransport({
        home,
        endpoint: connection.endpoint,
        operationDeadlineMs: DEFAULT_OPERATION_DEADLINE_MS,
      });
      const requestClient = createCoordinatorRequestClient({
        transport,
        identity: clientIdentity(expectedBuildId),
        expectedCoordinator: connection.endpoint.coordinator,
        peerOsIdentity,
        deadlineMs: DEFAULT_OPERATION_DEADLINE_MS,
      });
      try {
        return await requestClient.handshake();
      } finally {
        await Promise.resolve(transport.close?.()).catch(() => undefined);
      }
    };

    return Object.freeze({
      handshake,
      status: (): Promise<CoordinatorResponseFor<'status'>> =>
        withRequest((requestClient) => requestClient.status()),
      resolveWorkspaceWorker: (
        params: CoordinatorWorkspaceParams,
      ): Promise<CoordinatorResponseFor<'resolveWorkspaceWorker'>> =>
        withRequest((requestClient) => requestClient.resolveWorkspaceWorker(params)),
      ensureWorkspaceWorker: (
        params: CoordinatorWorkspaceParams,
      ): Promise<CoordinatorResponseFor<'ensureWorkspaceWorker'>> =>
        withRequest((requestClient) => requestClient.ensureWorkspaceWorker(params)),
      resolveSessionWorkspace: (
        params: CoordinatorResolveSessionWorkspaceParams,
      ): Promise<CoordinatorResponseFor<'resolveSessionWorkspace'>> =>
        withRequest((requestClient) => requestClient.resolveSessionWorkspace(params)),
      listSessionMetadata: (
        params: CoordinatorListSessionMetadataParams,
      ): Promise<CoordinatorResponseFor<'listSessionMetadata'>> =>
        withRequest((requestClient) => requestClient.listSessionMetadata(params)),
      mintWorkerConnectionCapability: (
        params: CoordinatorMintWorkerConnectionCapabilityParams,
      ): Promise<CoordinatorResponseFor<'mintWorkerConnectionCapability'>> =>
        withRequest((requestClient) => requestClient.mintWorkerConnectionCapability(params)),
      ensureWebGateway: (): Promise<CoordinatorResponseFor<'ensureWebGateway'>> =>
        withRequest((requestClient) => requestClient.ensureWebGateway()),
      discoverWebGateway: (): Promise<CoordinatorResponseFor<'discoverWebGateway'>> =>
        withRequest((requestClient) => requestClient.discoverWebGateway()),
      stopWebGateway: (): Promise<CoordinatorResponseFor<'stopWebGateway'>> =>
        withRequest((requestClient) => requestClient.stopWebGateway()),
      subscribeDirectoryChanges: (
        params: CoordinatorSubscribeDirectoryChangesParams,
      ): Promise<CoordinatorResponseFor<'subscribeDirectoryChanges'>> =>
        withRequest((requestClient) => requestClient.subscribeDirectoryChanges(params)),
    });
  }
}

function explicitKiteHomeArgument(argv: readonly string[]): string | undefined {
  const positions = argv.flatMap((value, index) => (value === '--kite-home' ? [index] : []));
  if (positions.length === 0) return undefined;
  if (positions.length !== 1) throw new Error('--kite-home may be supplied only once.');
  const value = argv[(positions[0] ?? -1) + 1];
  if (!value || (!isAbsolute(value) && !/^[A-Za-z]:[\\/]/u.test(value))) {
    throw new Error('--kite-home requires an absolute path.');
  }
  return value;
}

function requireBuildIdentity(value: string | undefined): string {
  if (value === undefined || value.length === 0 || /\p{Cc}/u.test(value)) {
    throw new Error('Kite Coordinator executable identity is unavailable.');
  }
  return value;
}

export function resolveCoordinatorPeerOsIdentity(
  supplied: ManagedLocalCoordinatorClientCompositionOptions['peerOsIdentity'],
  platform: NodeJS.Platform = process.platform,
  readWindowsUserSid: () => string = resolveCurrentWindowsUserSid,
): NonNullable<ManagedLocalCoordinatorClientCompositionOptions['peerOsIdentity']> {
  if (supplied !== undefined) {
    if (supplied.kind === 'posix_uid' && Number.isSafeInteger(supplied.uid) && supplied.uid >= 0) {
      return Object.freeze({ kind: 'posix_uid', uid: supplied.uid });
    }
    if (supplied.kind === 'windows_sid' && /^S-\d-(?:\d+-){1,15}\d+$/u.test(supplied.sid)) {
      return Object.freeze({ kind: 'windows_sid', sid: supplied.sid });
    }
    throw new Error('Kite Coordinator OS identity is invalid.');
  }
  if (platform !== 'win32' && typeof process.getuid === 'function') {
    return Object.freeze({ kind: 'posix_uid', uid: process.getuid() });
  }
  if (platform === 'win32') {
    const sid = readWindowsUserSid();
    if (/^S-\d-(?:\d+-){1,15}\d+$/u.test(sid)) {
      return Object.freeze({ kind: 'windows_sid', sid });
    }
  }
  throw new Error('Kite Coordinator requires a verified native user identity.');
}

function ensureNeutralDirectory(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: false, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Kite Coordinator neutral cwd is not a real directory.');
  }
  if (readdirSync(path).length !== 0) {
    throw new Error('Kite Coordinator neutral cwd must remain empty.');
  }
  chmodSync(path, 0o700);
}

function resolveCommittedCoordinatorLayout(home: KiteHomeIdentity): {
  readonly layoutGeneration: string;
  readonly catalogPath: string;
} {
  const paths = resolveSqliteRuntimeLayoutPaths(home.root);
  const pointer = readSqliteActiveLayoutPointer(paths);
  if (pointer === undefined) throw new Error('Kite Coordinator active layout is unavailable.');
  const manifest = readSqliteRuntimeLayoutManifest(paths, pointer.generation);
  const journal = readSqliteRuntimeMigrationJournal(paths);
  const fence = readSqliteRuntimeMigrationFence(paths);
  if (
    manifest === undefined ||
    manifest.generation !== pointer.generation ||
    journal === undefined ||
    journal.targetLayoutGeneration !== pointer.generation ||
    journal.pointerPhase !== 'committed' ||
    fence === undefined ||
    fence.targetLayoutGeneration !== pointer.generation ||
    fence.migrationNonce !== journal.migrationNonce
  ) {
    throw new Error('Kite Coordinator active layout is not committed.');
  }
  const catalogPath = resolveSqliteCatalogPath(paths, pointer.generation);
  assertSqliteCoordinatorCatalogActive(paths, pointer.generation, catalogPath);
  return Object.freeze({ layoutGeneration: pointer.generation, catalogPath });
}

function clientIdentity(buildId: string): CoordinatorClientIdentity {
  return Object.freeze({
    role: 'client',
    instanceId: `release-client-${randomUUID()}`,
    buildId,
    protocolVersion: COORDINATOR_PROTOCOL_VERSION,
    protocolRevision: COORDINATOR_PROTOCOL_REVISION_,
    clientContractRevision: COORDINATOR_CLIENT_CONTRACT_REVISION_,
  });
}

function handshakeToManagerResult(
  response: CoordinatorHandshakeResponse,
  descriptor: { readonly instanceId: string; readonly buildId: string },
): {
  readonly outcome: 'healthy' | 'incompatible' | 'unavailable';
  readonly instanceId?: string;
  readonly buildId?: string;
  readonly protocolVersion?: number;
  readonly protocolRevision?: string;
  readonly clientContractRevision?: string;
  readonly diagnostic?:
    | 'protocol_incompatible'
    | 'client_contract_incompatible'
    | 'identity_uncertain';
} {
  if (response.accepted) {
    return {
      outcome: 'healthy',
      instanceId: response.coordinator.instanceId,
      buildId: response.coordinator.buildId,
      protocolVersion: response.coordinator.protocolVersion,
      protocolRevision: response.coordinator.protocolRevision,
      clientContractRevision: response.coordinator.clientContractRevision,
    };
  }
  if (response.diagnostic === 'wrong_protocol') {
    return { outcome: 'incompatible', diagnostic: 'protocol_incompatible' };
  }
  if (response.diagnostic === 'wrong_build') {
    return { outcome: 'incompatible', diagnostic: 'identity_uncertain' };
  }
  if (response.diagnostic === 'wrong_instance') {
    return { outcome: 'unavailable', diagnostic: 'identity_uncertain' };
  }
  void descriptor;
  return { outcome: 'unavailable', diagnostic: 'identity_uncertain' };
}

function unavailableLifecycleResult(
  operation: 'ensure' | 'status' | 'stop',
  requestId: string,
): CoordinatorManagerResult {
  return Object.freeze({
    requestId,
    operation,
    outcome: 'unavailable' as const,
    state: 'absent' as const,
    diagnostic: 'identity_uncertain' as const,
  });
}
