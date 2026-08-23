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
  assertRuntimeAuthorizationElevation,
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
import type {
  CapabilityExecutionInvocation,
  CapabilityExecutionPort,
  RuntimeModule,
} from '@kite/runtime-spi';
import {
  assertSqliteSessionMetadataCanOpen,
  createSqliteRuntimeStorage,
  createSqliteRuntimeStorageBoundary,
  createSqliteSessionTokenStats,
  defaultSqliteRuntimeJournalMode,
  type SessionTokenStats,
  SQLITE_RUNTIME_FORMAT_EPOCH,
  SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
  SQLITE_RUNTIME_STORE_SCHEMA_VERSION,
  sqliteRuntimeStorePath,
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
import { createKiteRuntimeExecutionModule } from './bootstrap/runtime/KiteRuntimeExecutionModule';
import {
  createRuntimeSessionCoordinatorBinding,
  type RuntimeSessionCoordinatorAccess,
} from './bootstrap/runtime/RuntimeSessionCoordinator';
import type {
  RuntimeEvent,
  RuntimeState,
  StateRuntimeStorage,
} from './bootstrap/runtime/state-runtime';
import { createAppToolPipelineComposition } from './bootstrap/runtime/tool-pipeline-composition';

const STATE_STORAGE_BINDING_ = createRuntimeHostStateStorageBinding();

function createKiteRuntimeStorage(
  checkpointPath: string,
  threadId?: string,
): RuntimeStorage<RuntimeEvent, RuntimeState> {
  const databasePath = sqliteRuntimeStorePath(checkpointPath);
  const stateBinding = STATE_STORAGE_BINDING_;
  return createSqliteRuntimeStorage<RuntimeEvent, RuntimeState>({
    databasePath,
    codec: stateBinding.codec,
    ...(threadId ? { sessionId: threadId } : {}),
  });
}

interface KiteRuntimeStorageOwner {
  readonly storage: RuntimeStorage<RuntimeEvent, RuntimeState>;
}

function createKiteRuntimeStorageOwner(
  checkpointPath: string,
  threadId?: string,
): KiteRuntimeStorageOwner {
  let underlying: RuntimeStorage<RuntimeEvent, RuntimeState> | undefined;
  let closeRequested = false;
  let closed = false;
  const resolve = (): RuntimeStorage<RuntimeEvent, RuntimeState> => {
    if (closeRequested) throw new Error('Runtime Host storage is closing');
    underlying ??= createKiteRuntimeStorage(checkpointPath, threadId);
    return underlying;
  };
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
    sessions: createLazyPort(() => resolve().sessions),
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

/** Bootstrap-owned Host policy binding supplied to Client entrypoints as a narrow callback. */
export function assertKiteRuntimeAuthorizationElevation(input: {
  readonly mode: 'default' | 'full_access';
  readonly source: 'config';
  readonly sandboxAvailable: boolean;
}): void {
  assertRuntimeAuthorizationElevation(input);
}

export function createKiteCliRuntimeAccess(
  input: Omit<CliRuntimeBridgeInput, 'projectIdentity'>,
): RuntimeHost<RuntimeEvent, RuntimeState> {
  const owner = createKiteRuntimeStorageOwner(input.checkpointPath, input.sessionId);
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
