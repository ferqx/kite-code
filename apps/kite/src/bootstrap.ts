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
  type RuntimeTransactionAcknowledgement,
  resolveProjectIdentity,
} from '@kite/runtime-host';
import type { RuntimeEffectLeaseExpectation, RuntimeStorage } from '@kite/runtime-host/storage';
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
  StateSessionStorage,
} from './bootstrap/runtime/state-runtime';
import { createAppToolPipelineComposition } from './bootstrap/runtime/tool-pipeline-composition';
import type { SessionDeps } from './runtime/session';

type ExternalSessionDeps = Omit<
  SessionDeps,
  | 'openStateSessionStorage'
  | 'tokenStatsStorage'
  | 'capabilityExecution'
  | 'modelInvocationRuntimeFactory'
  | 'resolveRecoveryIdentity'
  | 'allocateRecoveryIdentity'
  | 'builtinToolCatalog'
>;

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

/** Non-owning flat view of the current Store ports; Host alone closes storage. */
function createRuntimeStorageView(
  services: RuntimeHostExecutionServices<RuntimeEvent, RuntimeState>,
): StateSessionStorage {
  return {
    appendEvents: (threadId, events, metadata) =>
      services.sessions.appendEvents(threadId, events, metadata),
    appendEventsAndSnapshot: (
      threadId,
      events,
      nextState,
      metadata,
      snapshotMetadata,
      expectedRestoreBoundary,
      requiredEffectLease,
    ) =>
      services.transactions.commit(
        classifyRuntimeTransaction(events),
        {
          sessionId: threadId,
          events,
          snapshot: nextState,
          ...(metadata ? { metadata } : {}),
          ...(snapshotMetadata ? { snapshotMetadata } : {}),
          ...(expectedRestoreBoundary ? { expectedRestoreBoundary } : {}),
          ...(requiredEffectLease ? { requiredEffectLease } : {}),
        },
        requiredCompactionLease(services, threadId, events, requiredEffectLease),
      ),
    loadEventsStrict: (threadId, since) => services.sessions.loadEventsStrict(threadId, since),
    saveSnapshot: (threadId, state) => services.sessions.saveSnapshot(threadId, state),
    loadSnapshot: <T = unknown>(threadId: string) => services.sessions.loadSnapshot<T>(threadId),
    loadSnapshotRecord: <T = unknown>(threadId: string) =>
      services.sessions.loadSnapshotRecord<T>(threadId),
    saveNamedSnapshot: (threadId, name, state, eventPosition) =>
      services.checkpoints.saveNamedSnapshot(threadId, name, state, eventPosition),
    loadNamedSnapshot: <T = unknown>(threadId: string, name: string) =>
      services.checkpoints.loadNamedSnapshot<T>(threadId, name),
    getLastEventPosition: (threadId) => services.sessions.getLastEventPosition(threadId),
    listSessions: (query, limit) => services.sessions.listSessions(query, limit),
    setSessionName: (threadId, name) => services.sessions.setSessionName(threadId, name),
    getSessionModelRoute: (threadId) => services.sessions.getSessionModelRoute(threadId),
    setSessionModelRoute: (threadId, route) =>
      services.sessions.setSessionModelRoute(threadId, route),
    deleteSession: (threadId) => services.sessions.deleteSession(threadId),
    tryAcquireEffectLease: (threadId, effectId, ownerId, expiresAtMs) =>
      services.leases.tryAcquire(threadId, effectId, ownerId, expiresAtMs),
    renewEffectLease: (threadId, effectId, ownerId, expiresAtMs) =>
      services.leases.renew(threadId, effectId, ownerId, expiresAtMs),
    releaseEffectLease: (threadId, effectId, ownerId) =>
      services.leases.release(threadId, effectId, ownerId),
    listNamedSnapshots: (threadId) => services.checkpoints.listNamedSnapshots(threadId),
    restoreNamedSnapshot: (threadId, snapshotId) =>
      services.checkpoints.restoreNamedSnapshot(threadId, snapshotId),
    forkSession: (sourceThreadId, snapshotId, targetThreadId, targetRecoveryIdentityKey) =>
      targetRecoveryIdentityKey !== undefined &&
      services.checkpoints.forkSession(
        sourceThreadId,
        snapshotId,
        targetThreadId,
        targetRecoveryIdentityKey,
      ),
    forkCurrentSession: (sourceThreadId, targetThreadId, targetRecoveryIdentityKey) =>
      targetRecoveryIdentityKey !== undefined &&
      services.checkpoints.forkCurrentSession(
        sourceThreadId,
        targetThreadId,
        targetRecoveryIdentityKey,
      ),
    getNamedSnapshotEntry: (threadId, snapshotId) =>
      services.checkpoints.getNamedSnapshotEntry(threadId, snapshotId),
    recordFilePreimage: (threadId, path, content, existed) =>
      services.checkpoints.recordFilePreimage(threadId, path, content, existed),
    recordFilePostimage: (threadId, path, contentHash, existed) =>
      services.checkpoints.recordFilePostimage(threadId, path, contentHash, existed),
    fileRestorePlan: (threadId, eventPosition) =>
      services.checkpoints.fileRestorePlan(threadId, eventPosition),
    close: () => undefined,
  };
}

function classifyRuntimeTransaction(
  events: readonly RuntimeEvent[],
): RuntimeTransactionAcknowledgement {
  const types = new Set(events.map((event) => event.type));
  if (
    types.has('capability.execution_unknown') ||
    types.has('model.invocation_interrupted') ||
    types.has('runtime.cancellation_diagnostic')
  ) {
    return 'terminal_recovery';
  }
  if (
    types.has('capability.execution_succeeded') ||
    types.has('capability.execution_failed') ||
    types.has('model.invocation_completed') ||
    types.has('provider.readiness_succeeded') ||
    types.has('provider.readiness_failed')
  ) {
    return 'receipt_evidence';
  }
  if (
    types.has('capability.execution_started') ||
    types.has('model.invocation_attempt_started') ||
    types.has('provider.readiness_attempt_started') ||
    types.has('resource_budget.dispatch_started')
  ) {
    return 'attempt_start';
  }
  return 'decision';
}

function requiredCompactionLease(
  services: RuntimeHostExecutionServices<RuntimeEvent, RuntimeState>,
  sessionId: string,
  events: readonly RuntimeEvent[],
  requiredEffectLease?: RuntimeEffectLeaseExpectation,
): { sessionId: string; effectId: string; ownerId: string } | undefined {
  const terminal = events.find(
    (
      event,
    ): event is Extract<
      RuntimeEvent,
      { type: 'context.compaction_completed' | 'context.compaction_failed' }
    > =>
      event.type === 'context.compaction_completed' || event.type === 'context.compaction_failed',
  );
  if (!terminal) {
    if (requiredEffectLease) {
      throw new Error('Runtime effect lease requirement has no matching terminal event');
    }
    return undefined;
  }
  if (requiredEffectLease) {
    if (requiredEffectLease.effectId !== terminal.compactionId) {
      throw new Error('Runtime effect lease requirement does not match compaction terminal');
    }
    return {
      sessionId,
      effectId: terminal.compactionId,
      ownerId: requiredEffectLease.ownerId,
    };
  }
  if (services.leases.hasClaim(sessionId, terminal.compactionId)) {
    throw new Error('Runtime compaction terminal is missing its lease owner');
  }
  return undefined;
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
    const runtimeStorageView = createRuntimeStorageView(services);
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

export function createKiteTuiSessionManager(input: ExternalSessionDeps): object {
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
        openStateSessionStorage: () => {
          if (!executionServices) throw new Error('Runtime Host execution services unavailable');
          return createRuntimeStorageView(executionServices);
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
              store: createRuntimeStorageView(services),
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
