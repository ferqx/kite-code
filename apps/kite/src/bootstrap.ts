import { randomBytes } from 'node:crypto';
import {
  type BuiltinToolCatalogProjection,
  createBuiltinContextCompilerPort,
  createBuiltinRuntimeModules,
  createBuiltinToolCatalogProjection,
} from '@kite/builtin-runtime';
import type { BuiltinModelOperationExecutionPort } from '@kite/builtin-runtime/model';
import { RUNTIME_CONTRACT_BOUNDARY_ } from '@kite/runtime-contract';
import {
  createRuntimeHost,
  createRuntimeHostBoundary,
  createRuntimeHostStateStorageBinding,
  RUNTIME_HOST_EXECUTION_ADAPTER_ID_,
  type RuntimeHost,
  type RuntimeHostBoundary,
  type RuntimeHostExecutionAdapterContext,
  type RuntimeHostExecutionBridge,
  type RuntimeHostExecutionServices,
  resolveProjectIdentity,
} from '@kite/runtime-host';
import type { RuntimeStorage } from '@kite/runtime-host/storage';
import {
  type CapabilityExecutionInvocation,
  type CapabilityExecutionPort,
  defineRuntimeModule,
  type RuntimeModule,
} from '@kite/runtime-spi';
import {
  assertSqliteSessionMetadataCanOpen,
  createSqliteRuntimeCompatibilityWriter,
  createSqliteRuntimeStorage,
  createSqliteRuntimeStorageBoundary,
  createSqliteSessionTokenStats,
  defaultSqliteRuntimeJournalMode,
  discoverSqliteRuntimeCompatibilitySource,
  type SessionTokenStats,
  SQLITE_RUNTIME_COMPATIBILITY_SOURCE_PROFILES,
  SQLITE_RUNTIME_FORMAT_EPOCH,
  SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
  SQLITE_RUNTIME_STORE_SCHEMA_VERSION,
  type SqliteRuntimeCompatibilityImportResult,
  sqliteCurrentRuntimeStorePath,
  sqliteRuntimeStorePath,
  sqliteRuntimeStorePathForEpoch,
} from '@kite/runtime-storage-sqlite';
import { createTuiRuntimeClient } from './adapters/tui/runtime-bridge';
import type {
  TuiSessionManager,
  TuiSessionManagerDependencies,
} from './adapters/tui/session-adapter';
import { createKiteModelOperationExecutionPort } from './bootstrap/model-operation-execution';
import {
  createInstalledKiteRuntimeCompositionFactory,
  type InstalledKiteRuntimeCompositionFactory,
} from './bootstrap/model-runtime-composition';
import {
  type CliRuntimeBridgeInput,
  createCliRuntimeBridge,
} from './bootstrap/runtime/CliRuntimeBridge';
import { KITE_RUNTIME_OPERATION_IDS_ } from './bootstrap/runtime/KiteRuntimeExecutionModule';
import {
  createRuntimeSessionCoordinatorBinding,
  type RuntimeSessionCoordinatorAccess,
} from './bootstrap/runtime/RuntimeSessionCoordinator';
import type {
  RuntimeEvent,
  RuntimeState,
  StateRuntimeStorage,
} from './bootstrap/runtime/state-runtime';
import { createKiteRuntimeCompatibilityMigrator } from './bootstrap/runtime/state-store-compatibility';
import { createAppToolPipelineComposition } from './bootstrap/runtime/tool-pipeline-composition';

const STATE_STORAGE_BINDING_ = createRuntimeHostStateStorageBinding();

export function createKiteRuntimeExecutionModule<TContext>(input: {
  readonly executionAdapterId: string;
  readonly createBridge: (context: TContext) => RuntimeHostExecutionBridge;
}): RuntimeModule {
  return defineRuntimeModule({
    moduleId: 'kite-runtime-execution',
    providerId: 'kite-runtime-execution',
    revision: 'app-runtime-current',
    operationIds: KITE_RUNTIME_OPERATION_IDS_,
    register: (registry) => {
      registry.registerExecutionAdapter({
        adapterId: input.executionAdapterId,
        revision: 'app-runtime-current',
        create: input.createBridge,
      });
    },
  });
}

function createKiteRuntimeStorage(
  checkpointPath: string,
): RuntimeStorage<RuntimeEvent, RuntimeState> {
  const databasePath = sqliteCurrentRuntimeStorePath(checkpointPath);
  const stateBinding = STATE_STORAGE_BINDING_;
  return createSqliteRuntimeStorage<RuntimeEvent, RuntimeState>({
    databasePath,
    codec: stateBinding.codec,
  });
}

export function compatibilitySourcePaths(checkpointPath: string): readonly string[] {
  if (checkpointPath === ':memory:') return [];
  const currentPath = sqliteCurrentRuntimeStorePath(checkpointPath);
  return [
    sqliteRuntimeStorePath(checkpointPath),
    ...SQLITE_RUNTIME_COMPATIBILITY_SOURCE_PROFILES.map((profile) =>
      sqliteRuntimeStorePathForEpoch(checkpointPath, profile.formatEpoch),
    ),
  ].filter((path, index, all) => path !== currentPath && all.indexOf(path) === index);
}

export type KiteRuntimeSessionImportResult =
  | SqliteRuntimeCompatibilityImportResult
  | { readonly status: 'not_found'; readonly sessionId: string };

export function importCompatibleKiteSession(
  checkpointPath: string,
  threadId: string,
): KiteRuntimeSessionImportResult {
  const notFound = (): KiteRuntimeSessionImportResult => ({
    status: 'not_found',
    sessionId: threadId,
  });
  if (!threadId) return notFound();
  const sources = compatibilitySourcePaths(checkpointPath)
    .map((path) => discoverSqliteRuntimeCompatibilitySource(path))
    .filter((source) => source !== null);
  if (sources.length === 0) return notFound();
  const writer = createSqliteRuntimeCompatibilityWriter({
    databasePath: sqliteCurrentRuntimeStorePath(checkpointPath),
  });
  try {
    if (!writer.available) {
      return {
        status: 'failed',
        sessionId: threadId,
        error: new Error('Current Runtime Store is unavailable.'),
      };
    }
    const selected = sources
      .flatMap((source) =>
        source
          .listSessions()
          .filter((session) => session.sessionId === threadId)
          .map((session) => ({ source, session })),
      )
      .sort(
        (left, right) =>
          right.session.updatedAt - left.session.updatedAt ||
          right.session.revision - left.session.revision,
      )[0];
    if (!selected) return notFound();
    return writer.importSession(
      selected.source,
      threadId,
      createKiteRuntimeCompatibilityMigrator(STATE_STORAGE_BINDING_.codec),
    );
  } finally {
    writer.close();
    for (const source of sources) source.close();
  }
}

export type KiteRuntimeSessionResumePreparation = 'ready' | 'not_found' | 'failed';

/** Exact-session admission used by the headless CLI before create_session. */
export function prepareKiteRuntimeSessionResume(
  checkpointPath: string,
  sessionId: string,
): KiteRuntimeSessionResumePreparation {
  let current: RuntimeStorage<RuntimeEvent, RuntimeState> | undefined;
  try {
    current = createKiteRuntimeStorage(checkpointPath);
    if (current.sessions.loadSnapshotRecord(sessionId)) return 'ready';
  } catch {
    return 'failed';
  } finally {
    current?.close();
  }
  const imported = importCompatibleKiteSession(checkpointPath, sessionId);
  if (imported.status === 'imported' || imported.status === 'already_imported') return 'ready';
  return imported.status === 'not_found' || imported.status === 'ignored' ? 'not_found' : 'failed';
}

export function compatibleSessionList(checkpointPath: string) {
  const sources = compatibilitySourcePaths(checkpointPath)
    .map((path) => discoverSqliteRuntimeCompatibilitySource(path))
    .filter((source) => source !== null);
  if (sources.length === 0) return [];
  const writer = createSqliteRuntimeCompatibilityWriter({
    databasePath: sqliteCurrentRuntimeStorePath(checkpointPath),
  });
  try {
    const sessions = new Map<
      string,
      {
        threadId: string;
        name: string;
        updatedAt: number;
        needsSmartName: boolean;
        revision: number;
      }
    >();
    for (const source of sources) {
      for (const session of source.listSessions()) {
        if (writer.isSessionSuppressed(source, session.sessionId)) continue;
        const prior = sessions.get(session.sessionId);
        if (
          prior &&
          (prior.updatedAt > session.updatedAt ||
            (prior.updatedAt === session.updatedAt && prior.revision >= session.revision))
        )
          continue;
        sessions.set(session.sessionId, {
          threadId: session.sessionId,
          name: session.name || session.sessionId,
          updatedAt: session.updatedAt,
          needsSmartName: session.name.length === 0,
          revision: session.revision,
        });
      }
    }
    return [...sessions.values()].map(({ revision: _revision, ...session }) => session);
  } finally {
    writer.close();
    for (const source of sources) source.close();
  }
}

export function suppressCompatibleKiteSession(checkpointPath: string, sessionId: string): boolean {
  if (!sessionId) return false;
  const writer = createSqliteRuntimeCompatibilityWriter({
    databasePath: sqliteCurrentRuntimeStorePath(checkpointPath),
  });
  let suppressed = false;
  try {
    for (const path of compatibilitySourcePaths(checkpointPath)) {
      suppressed = writer.suppressSession(path, sessionId) || suppressed;
    }
  } finally {
    writer.close();
  }
  return suppressed;
}

export interface KiteRuntimeStorageOwner {
  readonly storage: RuntimeStorage<RuntimeEvent, RuntimeState>;
}

export function createKiteRuntimeStorageOwner(checkpointPath: string): KiteRuntimeStorageOwner {
  let underlying: RuntimeStorage<RuntimeEvent, RuntimeState> | undefined;
  let closeRequested = false;
  let closed = false;
  const resolve = (): RuntimeStorage<RuntimeEvent, RuntimeState> => {
    if (closeRequested) throw new Error('Runtime Host storage is closing');
    underlying ??= createKiteRuntimeStorage(checkpointPath);
    return underlying;
  };
  const ensureImported = (sessionId: string): void => {
    if (!sessionId) return;
    const current = resolve().sessions.loadSnapshot(sessionId);
    if (current !== null) return;
    importCompatibleKiteSession(checkpointPath, sessionId);
  };
  const sessionPort = new Proxy({} as RuntimeStorage<RuntimeEvent, RuntimeState>['sessions'], {
    get: (_target, property) => {
      if (property === 'listSessions') {
        return (query = '', limit = 50) => {
          const currentPort = resolve().sessions;
          const current = currentPort.listSessions(query, limit);
          const seen = new Set(current.map((session) => session.threadId));
          const normalizedQuery = String(query).trim().toLocaleLowerCase();
          const legacy = compatibleSessionList(checkpointPath).filter((session) => {
            if (seen.has(session.threadId)) return false;
            try {
              if (currentPort.loadSnapshot(session.threadId) !== null) return false;
            } catch {
              // A corrupt current row still owns its identity; do not replace
              // it with an older compatibility source carrying the same id.
              return false;
            }
            return (
              !normalizedQuery ||
              session.name.toLocaleLowerCase().includes(normalizedQuery) ||
              session.threadId.toLocaleLowerCase().includes(normalizedQuery)
            );
          });
          return [...current, ...legacy]
            .sort(
              (left, right) =>
                right.updatedAt - left.updatedAt || left.threadId.localeCompare(right.threadId),
            )
            .slice(0, limit);
        };
      }
      const port = resolve().sessions;
      const value = Reflect.get(port, property, port) as unknown;
      if (typeof value !== 'function') return value;
      if (
        [
          'loadEventsStrict',
          'loadSnapshot',
          'loadSnapshotRecord',
          'getLastEventPosition',
          'getSessionModelRoute',
          'setSessionName',
          'setSessionModelRoute',
        ].includes(String(property))
      ) {
        return (sessionId: string, ...args: unknown[]) => {
          ensureImported(sessionId);
          return Reflect.apply(value, port, [sessionId, ...args]);
        };
      }
      if (property === 'deleteSession') {
        return (sessionId: string) => {
          if (!suppressCompatibleKiteSession(checkpointPath, sessionId)) {
            throw new Error('Runtime session deletion could not record compatibility state.');
          }
          const result = Reflect.apply(value, port, [sessionId]);
          return result;
        };
      }
      return value.bind(port);
    },
  });
  const closeWhenIdle = (): void => {
    if (!closeRequested || closed) return;
    closed = true;
    underlying?.close();
  };
  const storage: RuntimeStorage<RuntimeEvent, RuntimeState> = Object.freeze({
    adapterId: 'sqlite',
    stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
    storeSchemaVersion: SQLITE_RUNTIME_STORE_SCHEMA_VERSION,
    formatEpoch: SQLITE_RUNTIME_FORMAT_EPOCH,
    sessions: sessionPort,
    transactions: createLazyPort(() => resolve().transactions),
    effects: createLazyPort(() => resolve().effects),
    checkpoints: createLazyPort(() => resolve().checkpoints),
    artifacts: createLazyPort(() => resolve().artifacts),
    recoveryIdentities: createLazyPort(() => resolve().recoveryIdentities),
    close: () => {
      closeRequested = true;
      closeWhenIdle();
    },
  });
  return {
    storage,
  };
}

function createLazyPort<Port extends object>(resolve: () => Port): Port {
  return new Proxy({} as Port, {
    get: (_target, property) => {
      const port = resolve();
      const value = Reflect.get(port, property, port) as unknown;
      return typeof value === 'function' ? value.bind(port) : value;
    },
  });
}

function resolveKiteRecoveryIdentity(
  services: RuntimeHostExecutionServices<RuntimeEvent, RuntimeState>,
  sessionId: string,
): string {
  const recoveryIdentity = STATE_STORAGE_BINDING_.codec.recoveryIdentity;
  if (!recoveryIdentity) {
    throw new Error('Runtime Host State recovery identity projection is unavailable');
  }
  return services.recoveryIdentities.getOrCreate(sessionId, () => {
    const snapshot = services.sessions.loadSnapshot<RuntimeState>(sessionId);
    return snapshot === null ? allocateKiteRecoveryIdentity() : recoveryIdentity(snapshot);
  });
}

function allocateKiteRecoveryIdentity(): string {
  return randomBytes(32).toString('hex');
}

function createKiteRuntimeHost(
  storage: RuntimeStorage<RuntimeEvent, RuntimeState>,
  createBridge: (
    context: RuntimeHostExecutionAdapterContext<RuntimeEvent, RuntimeState>,
    builtinToolCatalog: BuiltinToolCatalogProjection,
  ) => RuntimeHostExecutionBridge,
): RuntimeHost<RuntimeEvent, RuntimeState> {
  return createRuntimeHost({
    storage,
    modules: createKiteRuntimeModules((context) =>
      createBridge(context, createBuiltinToolCatalogProjection(context.capabilityRegistrySnapshot)),
    ),
    contextCompiler: createBuiltinContextCompilerPort(),
  });
}

function createKiteRuntimeModules(
  createBridge: (
    context: RuntimeHostExecutionAdapterContext<RuntimeEvent, RuntimeState>,
  ) => RuntimeHostExecutionBridge,
): readonly RuntimeModule[] {
  return Object.freeze([
    createKiteRuntimeExecutionModule({
      executionAdapterId: RUNTIME_HOST_EXECUTION_ADAPTER_ID_,
      createBridge,
    }),
    ...createBuiltinRuntimeModules(),
  ]);
}

/** Non-owning nested access to the Host-owned storage ports. */
function createRuntimeStorageAccess(
  services: RuntimeHostExecutionServices<RuntimeEvent, RuntimeState>,
): StateRuntimeStorage {
  return Object.freeze({
    sessions: services.sessions,
    transactions: services.transactions,
    effects: services.leases,
    checkpoints: services.checkpoints,
    recoveryIdentities: services.recoveryIdentities,
    close: () => undefined,
  });
}

export function createKiteRuntimeBoundary(): RuntimeHostBoundary {
  if (RUNTIME_CONTRACT_BOUNDARY_.transport !== 'in-process') {
    throw new Error('Kite RM boundary must remain in-process');
  }
  return createRuntimeHostBoundary({
    storage: createSqliteRuntimeStorageBoundary(),
    modules: createKiteRuntimeModules(() => {
      throw new Error('Kite boundary inspection cannot create a runtime execution adapter');
    }),
  });
}

export function createKiteCliRuntimeAccess(
  input: Omit<CliRuntimeBridgeInput, 'projectIdentity'>,
): RuntimeHost<RuntimeEvent, RuntimeState> {
  const owner = createKiteRuntimeStorageOwner(input.checkpointPath);
  const projectIdentity = resolveProjectIdentity(input.workspace);
  const runtimeCoordinatorBinding = createRuntimeSessionCoordinatorBinding();
  const host = createKiteRuntimeHost(owner.storage, (context, builtinToolCatalog) => {
    const { services, capabilities, capabilityRegistrySnapshot } = context;
    const toolPipelineComposition = createAppToolPipelineComposition(builtinToolCatalog);
    const modelOperationExecution = createKiteModelOperationExecutionPort(
      capabilities,
      builtinToolCatalog,
    );
    const modelRuntime = createInstalledKiteRuntimeCompositionFactory(modelOperationExecution);
    const modelInvocationRuntimeFactory = (workspace: string) => ({
      ...modelRuntime(workspace),
      builtinToolCatalog,
      toolPipelineComposition,
    });
    const runtimeStorageView = createRuntimeStorageAccess(services);
    runtimeCoordinatorBinding.bind({
      services,
      capabilities,
      capabilityRegistrySnapshot,
      builtinToolCatalog,
      toolPipelineComposition,
      modelRuntimeFactory: modelRuntime,
      store: runtimeStorageView,
    });
    return createCliRuntimeBridge(
      { ...input, projectIdentity },
      capabilities,
      modelInvocationRuntimeFactory,
      (sessionId) => resolveKiteRecoveryIdentity(services, sessionId),
      runtimeCoordinatorBinding.access(),
    );
  });
  return host;
}

export function createKiteTuiSessionManager(
  input: TuiSessionManagerDependencies,
): TuiSessionManager {
  const owner = createKiteRuntimeStorageOwner(input.checkpointPath);
  const tokenStatsStorage = createSqliteSessionTokenStats({
    databasePath: `${sqliteRuntimeStorePath(input.checkpointPath)}.session-metadata.db`,
    journalMode: defaultSqliteRuntimeJournalMode(),
    assertCanOpen: assertSqliteSessionMetadataCanOpen,
  }) satisfies {
    save(sessionId: string, value: SessionTokenStats): void;
    loadAll(): readonly { sessionId: string; value: SessionTokenStats }[];
    close(): void;
  };
  try {
    let executionServices: RuntimeHostExecutionServices<RuntimeEvent, RuntimeState> | undefined;
    let capabilityExecution: CapabilityExecutionPort | undefined;
    let builtinToolCatalog: BuiltinToolCatalogProjection | undefined;
    let toolPipelineComposition:
      | import('./bootstrap/runtime/tool-pipeline-composition').AppToolPipelineComposition
      | undefined;
    let modelOperationExecution: BuiltinModelOperationExecutionPort | undefined;
    let modelRuntime: InstalledKiteRuntimeCompositionFactory | undefined;
    const runtimeCoordinatorBinding = createRuntimeSessionCoordinatorBinding();
    const runtimeCoordinatorAccess: RuntimeSessionCoordinatorAccess = {
      ensure: (identity) => runtimeCoordinatorBinding.access().ensure(identity),
      get: (sessionId) => runtimeCoordinatorBinding.access().get(sessionId),
      release: (sessionId) => runtimeCoordinatorBinding.access().release(sessionId),
      close: () => runtimeCoordinatorBinding.access().close(),
    };
    const capabilityExecutionProxy: CapabilityExecutionPort = Object.freeze({
      invoke: (invocation: CapabilityExecutionInvocation) => {
        if (!capabilityExecution) {
          return Promise.reject(new Error('Runtime Host capability execution unavailable'));
        }
        return capabilityExecution.invoke(invocation);
      },
    });
    return createTuiRuntimeClient(
      {
        ...input,
        openStateRuntimeStorage: () => {
          if (!executionServices) throw new Error('Runtime Host execution services unavailable');
          return createRuntimeStorageAccess(executionServices);
        },
        resolveRecoveryIdentity: (sessionId) => {
          if (!executionServices) throw new Error('Runtime Host execution services unavailable');
          return resolveKiteRecoveryIdentity(executionServices, sessionId);
        },
        allocateRecoveryIdentity: allocateKiteRecoveryIdentity,
        get builtinToolCatalog() {
          if (!builtinToolCatalog) {
            throw new Error('Runtime Host Builtin tool catalog unavailable');
          }
          return builtinToolCatalog;
        },
        capabilityExecution: capabilityExecutionProxy,
        modelInvocationRuntimeFactory: (workspace) => {
          if (
            !builtinToolCatalog ||
            !modelOperationExecution ||
            !modelRuntime ||
            !toolPipelineComposition
          ) {
            throw new Error('Runtime Host Builtin model operation composition unavailable');
          }
          return {
            ...modelRuntime(workspace),
            builtinToolCatalog,
            toolPipelineComposition,
          };
        },
        tokenStatsStorage,
        runtimeSessionCoordinator: runtimeCoordinatorAccess,
      },
      (bridge) =>
        createKiteRuntimeHost(
          owner.storage,
          ({ services, capabilities, capabilityRegistrySnapshot }, projection) => {
            executionServices = services;
            capabilityExecution = capabilities;
            builtinToolCatalog = projection;
            toolPipelineComposition = createAppToolPipelineComposition(projection);
            modelOperationExecution = createKiteModelOperationExecutionPort(
              capabilityExecutionProxy,
              projection,
            );
            const installedModelRuntime =
              createInstalledKiteRuntimeCompositionFactory(modelOperationExecution);
            modelRuntime = installedModelRuntime;
            runtimeCoordinatorBinding.bind({
              services,
              // The runtime coordinator and every App effect dependency must
              // consume the same Host-selected port. The proxy is the stable
              // port exposed to SessionManager and Model composition; the
              // callback's raw port remains private to this composition root.
              capabilities: capabilityExecutionProxy,
              capabilityRegistrySnapshot,
              builtinToolCatalog: projection,
              toolPipelineComposition,
              modelRuntimeFactory: installedModelRuntime,
              store: createRuntimeStorageAccess(services),
            });
            return bridge;
          },
        ),
      (workspace) => resolveProjectIdentity(workspace),
    );
  } catch (error) {
    tokenStatsStorage.close();
    owner.storage.close();
    throw error;
  }
}
