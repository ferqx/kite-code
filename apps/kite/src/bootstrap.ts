import { randomBytes } from 'node:crypto';
import {
  type BuiltinToolCatalogProjectionV1,
  createBuiltinContextCompilerPortV1,
  createBuiltinRuntimeModules,
  createBuiltinToolCatalogProjectionV1,
} from '@kite/builtin-runtime';
import type { BuiltinModelOperationExecutionPortV1 } from '@kite/builtin-runtime/model';
import type { ProjectHandleV1 } from '@kite/runtime-contract';
import { RUNTIME_CONTRACT_BOUNDARY_V1 } from '@kite/runtime-contract';
import {
  type AuthorityKeyV1,
  acquireSingleHostInvariantV1,
  assertRuntimeAuthorizationElevationV1,
  bindProjectIdentityToRuntimeBridgeV1,
  createRuntimeHost,
  createRuntimeHostBoundaryV1,
  createRuntimeHostState26StorageBindingV1,
  createRuntimePersistedAuthorityCodecV1,
  type ProjectIdentityStoreV1,
  RUNTIME_HOST_EXECUTION_ADAPTER_ID_V1,
  type RuntimeHost,
  type RuntimeHostBoundaryV1,
  type RuntimeHostExecutionAdapterContext,
  type RuntimeHostExecutionBridge,
  type RuntimeHostExecutionServices,
  type RuntimeTransactionAcknowledgement,
} from '@kite/runtime-host';
import type { RuntimeEffectLeaseExpectationV1, RuntimeStorage } from '@kite/runtime-host/storage';
import type {
  CapabilityExecutionInvocationV1,
  CapabilityExecutionPortV1,
  RuntimeModuleV1,
} from '@kite/runtime-spi';
import {
  assertSqliteSessionMetadataCanOpenV1,
  createSqliteRuntimeStorageBoundaryV5V1,
  createSqliteRuntimeStorageV5,
  createSqliteSessionTokenStatsV1,
  defaultSqliteRuntimeJournalModeV1,
  type SessionTokenStatsV1,
  SQLITE_RUNTIME_FORMAT_EPOCH_V2,
  SQLITE_RUNTIME_STATE26_SCHEMA_VERSION,
  SQLITE_RUNTIME_STORE5_SCHEMA_VERSION,
  sqliteRuntimeStorePathForV2,
} from '@kite/runtime-storage-sqlite';
import { createKiteModelOperationExecutionPortV1 } from './bootstrap/model-operation-execution';
import {
  createInstalledKiteRuntimeCompositionFactoryV1,
  type InstalledKiteRuntimeCompositionFactoryV1,
} from './bootstrap/model-runtime-composition';
import {
  createInstalledProjectIdentityStoreV1,
  loadInstalledRuntimeAuthorityKeyV1,
} from './bootstrap/project-identity-composition';
import {
  type CliRuntimeBridgeInputV1,
  createCliRuntimeBridgeV1,
} from './bootstrap/runtime/CliRuntimeBridge';
import { createKiteRuntimeExecutionModule } from './bootstrap/runtime/KiteRuntimeExecutionModule';
import {
  createRuntimeSessionCoordinatorBindingV1,
  type RuntimeSessionCoordinatorAccessV1,
} from './bootstrap/runtime/RuntimeSessionCoordinator';
import type { SessionDeps } from './bootstrap/runtime/SessionManager';
import type {
  RuntimeEvent,
  RuntimeState,
  State26SessionStorageV1,
} from './bootstrap/runtime/state26-runtime';
import { createTuiRuntimeClientV1 } from './bootstrap/runtime/TuiRuntimeBridge';
import { createAppToolPipelineCompositionV1 } from './bootstrap/runtime/tool-pipeline-composition';

type ExternalSessionDeps = Omit<
  SessionDeps,
  | 'openState26SessionStorage'
  | 'tokenStatsStorage'
  | 'capabilityExecution'
  | 'modelInvocationRuntimeFactory'
  | 'resolveRecoveryIdentity'
  | 'allocateRecoveryIdentity'
  | 'builtinToolCatalog'
>;

const STATE26_STORAGE_BINDING_V1 = createRuntimeHostState26StorageBindingV1();

function createKiteRuntimeStorage(
  checkpointPath: string,
  authorityKey: AuthorityKeyV1,
  threadId?: string,
): RuntimeStorage<RuntimeEvent, RuntimeState> {
  const databasePath = sqliteRuntimeStorePathForV2(checkpointPath);
  const stateBinding = STATE26_STORAGE_BINDING_V1;
  return createSqliteRuntimeStorageV5<RuntimeEvent, RuntimeState>({
    databasePath,
    codec: stateBinding.codec,
    persistedAuthority: createRuntimePersistedAuthorityCodecV1({
      issuer: 'kite-runtime-host',
      currentKey: authorityKey,
    }),
    ...(threadId ? { sessionId: threadId } : {}),
    uniqueReceiptForEvent: stateBinding.uniqueReceiptForEvent,
  });
}

interface KiteRuntimeStorageOwner {
  readonly storage: RuntimeStorage<RuntimeEvent, RuntimeState>;
}

function createKiteRuntimeStorageOwner(
  checkpointPath: string,
  authorityKey: AuthorityKeyV1,
  threadId?: string,
): KiteRuntimeStorageOwner {
  const singleHostLease = acquireSingleHostInvariantV1({ authorityPath: checkpointPath });
  let underlying: RuntimeStorage<RuntimeEvent, RuntimeState> | undefined;
  let closeRequested = false;
  let closed = false;
  const resolve = (): RuntimeStorage<RuntimeEvent, RuntimeState> => {
    if (closeRequested) throw new Error('Runtime Host storage is closing');
    underlying ??= createKiteRuntimeStorage(checkpointPath, authorityKey, threadId);
    return underlying;
  };
  const closeWhenIdle = (): void => {
    if (!closeRequested || closed) return;
    closed = true;
    underlying?.close();
  };
  const storage: RuntimeStorage<RuntimeEvent, RuntimeState> = Object.freeze({
    adapterId: 'sqlite',
    stateSchemaVersion: SQLITE_RUNTIME_STATE26_SCHEMA_VERSION,
    storeSchemaVersion: SQLITE_RUNTIME_STORE5_SCHEMA_VERSION,
    compatibilityEpoch: SQLITE_RUNTIME_FORMAT_EPOCH_V2,
    sessions: createLazyPort(() => resolve().sessions),
    transactions: createLazyPort(() => resolve().transactions),
    effects: createLazyPort(() => resolve().effects),
    checkpoints: createLazyPort(() => resolve().checkpoints),
    artifacts: createLazyPort(() => resolve().artifacts),
    recoveryIdentities: createLazyPort(() => resolve().recoveryIdentities),
    close: () => {
      closeRequested = true;
      closeWhenIdle();
      singleHostLease.release();
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

function resolveKiteRecoveryIdentityV1(
  services: RuntimeHostExecutionServices<RuntimeEvent, RuntimeState>,
  sessionId: string,
): string {
  const recoveryIdentity = STATE26_STORAGE_BINDING_V1.codec.recoveryIdentity;
  if (!recoveryIdentity) {
    throw new Error('Runtime Host State26 recovery identity projection is unavailable');
  }
  return services.recoveryIdentities.getOrCreate(sessionId, () => {
    const snapshot = services.sessions.loadSnapshot<RuntimeState>(sessionId);
    return snapshot === null ? allocateKiteRecoveryIdentityV1() : recoveryIdentity(snapshot);
  });
}

function allocateKiteRecoveryIdentityV1(): string {
  return randomBytes(32).toString('hex');
}

function createKiteRuntimeHost(
  storage: RuntimeStorage<RuntimeEvent, RuntimeState>,
  projects: ProjectIdentityStoreV1,
  createBridge: (
    context: RuntimeHostExecutionAdapterContext<RuntimeEvent, RuntimeState>,
    builtinToolCatalog: BuiltinToolCatalogProjectionV1,
  ) => RuntimeHostExecutionBridge,
): RuntimeHost<RuntimeEvent, RuntimeState> {
  return createRuntimeHost({
    storage,
    modules: createKiteRuntimeModules((context) =>
      bindProjectIdentityToRuntimeBridgeV1({
        projects,
        bridge: createBridge(
          context,
          createBuiltinToolCatalogProjectionV1(context.capabilityRegistrySnapshot),
        ),
      }),
    ),
    contextCompiler: createBuiltinContextCompilerPortV1(),
  });
}

function createKiteRuntimeModules(
  createBridge: (
    context: RuntimeHostExecutionAdapterContext<RuntimeEvent, RuntimeState>,
  ) => RuntimeHostExecutionBridge,
): readonly RuntimeModuleV1[] {
  return Object.freeze([
    createKiteRuntimeExecutionModule({
      executionAdapterId: RUNTIME_HOST_EXECUTION_ADAPTER_ID_V1,
      createBridge,
    }),
    ...createBuiltinRuntimeModules(),
  ]);
}

/** Non-owning flat view of the current Store5 ports; Host alone closes storage. */
function createKiteRuntimeStorageViewV1(
  services: RuntimeHostExecutionServices<RuntimeEvent, RuntimeState>,
): State26SessionStorageV1 {
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
  requiredEffectLease?: RuntimeEffectLeaseExpectationV1,
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

export function createKiteRuntimeBoundaryV1(): RuntimeHostBoundaryV1 {
  if (RUNTIME_CONTRACT_BOUNDARY_V1.transport !== 'in-process') {
    throw new Error('Kite RMV1 boundary must remain in-process');
  }
  return createRuntimeHostBoundaryV1({
    storage: createSqliteRuntimeStorageBoundaryV5V1(),
    modules: createKiteRuntimeModules(() => {
      throw new Error('Kite boundary inspection cannot create a runtime execution adapter');
    }),
  });
}

/** Bootstrap-owned Host policy binding supplied to Client entrypoints as a narrow callback. */
export function assertKiteRuntimeAuthorizationElevationV1(input: {
  readonly mode: 'default' | 'full_access';
  readonly source: 'config';
  readonly sandboxAvailable: boolean;
}): void {
  assertRuntimeAuthorizationElevationV1(input);
}

export function createKiteCliRuntimeAccess(
  input: Omit<CliRuntimeBridgeInputV1, 'projectHandle'>,
): RuntimeHost<RuntimeEvent, RuntimeState> & { readonly projectHandle: ProjectHandleV1 } {
  const authorityKey = loadInstalledRuntimeAuthorityKeyV1([
    sqliteRuntimeStorePathForV2(input.checkpointPath),
  ]);
  const owner = createKiteRuntimeStorageOwner(input.checkpointPath, authorityKey, input.sessionId);
  const projects = createInstalledProjectIdentityStoreV1(authorityKey);
  const projectHandle = projects.issueHandleSync({
    workspace: input.workspace,
    bootstrapIdentity: input.sessionId,
  });
  const runtimeCoordinatorBinding = createRuntimeSessionCoordinatorBindingV1();
  const host = createKiteRuntimeHost(owner.storage, projects, (context, builtinToolCatalog) => {
    const { services, capabilities, capabilityRegistrySnapshot } = context;
    const toolPipelineComposition = createAppToolPipelineCompositionV1(builtinToolCatalog);
    const modelOperationExecution = createKiteModelOperationExecutionPortV1(
      capabilities,
      builtinToolCatalog,
    );
    const modelRuntime = createInstalledKiteRuntimeCompositionFactoryV1(modelOperationExecution);
    const modelInvocationRuntimeFactory = (workspace: string) => ({
      ...modelRuntime(workspace),
      builtinToolCatalog,
      toolPipelineComposition,
    });
    const legacyStore = createKiteRuntimeStorageViewV1(services);
    runtimeCoordinatorBinding.bind({
      services,
      capabilities,
      capabilityRegistrySnapshot,
      builtinToolCatalog,
      toolPipelineComposition,
      modelRuntimeFactory: modelRuntime,
      store: legacyStore,
    });
    return createCliRuntimeBridgeV1(
      { ...input, projectHandle },
      capabilities,
      modelInvocationRuntimeFactory,
      (sessionId) => resolveKiteRecoveryIdentityV1(services, sessionId),
      runtimeCoordinatorBinding.access(),
    );
  });
  return Object.assign(host, { projectHandle });
}

export function createKiteTuiSessionManager(input: ExternalSessionDeps): object {
  const authorityKey = loadInstalledRuntimeAuthorityKeyV1([
    sqliteRuntimeStorePathForV2(input.checkpointPath),
  ]);
  const owner = createKiteRuntimeStorageOwner(input.checkpointPath, authorityKey);
  const projects = createInstalledProjectIdentityStoreV1(authorityKey);
  const tokenStatsStorage = createSqliteSessionTokenStatsV1({
    databasePath: `${sqliteRuntimeStorePathForV2(input.checkpointPath)}.session-metadata.db`,
    journalMode: defaultSqliteRuntimeJournalModeV1(),
    assertCanOpen: assertSqliteSessionMetadataCanOpenV1,
  }) satisfies {
    save(sessionId: string, value: SessionTokenStatsV1): void;
    loadAll(): readonly { sessionId: string; value: SessionTokenStatsV1 }[];
    close(): void;
  };
  try {
    let executionServices: RuntimeHostExecutionServices<RuntimeEvent, RuntimeState> | undefined;
    let capabilityExecution: CapabilityExecutionPortV1 | undefined;
    let builtinToolCatalog: BuiltinToolCatalogProjectionV1 | undefined;
    let toolPipelineComposition:
      | import('./bootstrap/runtime/tool-pipeline-composition').AppToolPipelineCompositionV1
      | undefined;
    let modelOperationExecution: BuiltinModelOperationExecutionPortV1 | undefined;
    let modelRuntime: InstalledKiteRuntimeCompositionFactoryV1 | undefined;
    const runtimeCoordinatorBinding = createRuntimeSessionCoordinatorBindingV1();
    const runtimeCoordinatorAccess: RuntimeSessionCoordinatorAccessV1 = {
      ensure: (identity) => runtimeCoordinatorBinding.access().ensure(identity),
      get: (sessionId) => runtimeCoordinatorBinding.access().get(sessionId),
      release: (sessionId) => runtimeCoordinatorBinding.access().release(sessionId),
      close: () => runtimeCoordinatorBinding.access().close(),
    };
    const capabilityExecutionProxy: CapabilityExecutionPortV1 = Object.freeze({
      invoke: (invocation: CapabilityExecutionInvocationV1) => {
        if (!capabilityExecution) {
          return Promise.reject(new Error('Runtime Host capability execution unavailable'));
        }
        return capabilityExecution.invoke(invocation);
      },
    });
    return createTuiRuntimeClientV1(
      {
        ...input,
        openState26SessionStorage: () => {
          if (!executionServices) throw new Error('Runtime Host execution services unavailable');
          return createKiteRuntimeStorageViewV1(executionServices);
        },
        resolveRecoveryIdentity: (sessionId) => {
          if (!executionServices) throw new Error('Runtime Host execution services unavailable');
          return resolveKiteRecoveryIdentityV1(executionServices, sessionId);
        },
        allocateRecoveryIdentity: allocateKiteRecoveryIdentityV1,
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
          projects,
          ({ services, capabilities, capabilityRegistrySnapshot }, projection) => {
            executionServices = services;
            capabilityExecution = capabilities;
            builtinToolCatalog = projection;
            toolPipelineComposition = createAppToolPipelineCompositionV1(projection);
            modelOperationExecution = createKiteModelOperationExecutionPortV1(
              capabilityExecutionProxy,
              projection,
            );
            const installedModelRuntime =
              createInstalledKiteRuntimeCompositionFactoryV1(modelOperationExecution);
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
              store: createKiteRuntimeStorageViewV1(services),
            });
            return bridge;
          },
        ),
      (workspace, bootstrapIdentity) => projects.issueHandleSync({ workspace, bootstrapIdentity }),
    );
  } catch (error) {
    tokenStatsStorage.close();
    owner.storage.close();
    throw error;
  }
}
