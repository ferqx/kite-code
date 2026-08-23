import { createHash } from 'node:crypto';
import {
  assertRestoredCapabilityArtifactEvidenceV1,
  type BuiltinToolCatalogProjectionV1,
} from '@kite/builtin-runtime';
import {
  type ModelArtifactEvidenceAvailabilityV1,
  verifyCompletedModelInvocationEvidenceV1,
  verifyPendingModelInvocationEvidenceV1,
} from '@kite/builtin-runtime/model';
import { canonicalPathForComparison } from '@kite/builtin-runtime/sandbox';
import {
  assertRuntimeAuthorizationElevationV1,
  createRuntimeHostStateSessionV1,
  projectRuntimeHostStateRestartRecoveryEventsV1,
  type RuntimeHostExecutionServices,
  restoreRuntimeHostStateSessionV1,
  runtimeHostStateRestartRecoveryCapabilityInvocationIdsV1,
  type StateRuntimeSessionEffectLeaseV1,
  type StateRuntimeSessionV1,
} from '@kite/runtime-host';
import type { CapabilityExecutionPortV1, CapabilityRegistrySnapshotV1 } from '@kite/runtime-spi';
import type {
  InstalledKiteRuntimeCompositionFactoryV1,
  InstalledKiteRuntimeCompositionV1,
} from '../model-runtime-composition';
import { createAppRuntimeEffectExecutorV1 } from './runtime-effect-coordinator';
import type { RuntimeExecutorDependencies } from './runtime-effect-dependencies';
import {
  eventsForRuntimeAction,
  type RuntimeActionResult,
  type RuntimeUserAction,
} from './state-actions';
import type { RuntimeActionProvider, RuntimeStateSessionPortV1 } from './state-runner';
import type {
  RuntimeEffectExecutor,
  RuntimeEffectLeaseExpectation,
  RuntimeEvent,
  RuntimeState,
  StateSessionStorageV1,
} from './state-runtime';
import type { AppToolPipelineCompositionV1 } from './tool-pipeline-composition';
import { executeRuntimeTurnV1, type RuntimeTurnInputV1 } from './turn-coordinator';
import { projectVerificationSchemaAdmissionsV1 } from './verification-schema-admission';

/** App-private transition control used by the State 25 coordinator. */
export interface AuthorizedExecutionControlV1 {
  getState: () => Readonly<RuntimeState>;
  processEvent: (event: RuntimeEvent) => void;
  processEventBatch: (events: RuntimeEvent[]) => RuntimeEvent[];
  cancelRun: (reason?: string) => RuntimeEvent[];
}

export interface RuntimeSessionCoordinatorIdentityV1 {
  readonly sessionId: string;
  readonly userId: string;
  readonly workspace: string;
  readonly projectId: string;
  readonly canonicalWorkspaceDigest: `sha256:${string}`;
  readonly interactionMode: RuntimeState['mode'];
  readonly recoveryIdentityKey: string;
  readonly sandboxAvailable?: boolean;
  readonly modelArtifactEvidence?: ModelArtifactEvidenceAvailabilityV1;
  readonly capabilityArtifactEvidence?: import('@kite/builtin-runtime').CapabilityArtifactReaderV1;
}

export interface RuntimeSessionCoordinatorV1 {
  readonly sessionId: string;
  readonly control: AuthorizedExecutionControlV1;
  readonly session: StateRuntimeSessionV1;
  readonly recoveryChanged: boolean;
  readonly lifecycle: 'idle' | 'running' | 'compacting' | 'closing' | 'closed';

  getState(): Readonly<RuntimeState>;
  getStateSessionStorage(): StateSessionStorageV1;
  isTurnActive(): boolean;
  beginTurn(): void;
  endTurn(): void;
  /** Explicitly records a durable interaction-mode mutation for identity checks. */
  updateInteractionMode(mode: RuntimeState['mode']): void;
  /** Applies the Host-prepared sandbox fact before the next turn. */
  updateSandboxAvailable(available: boolean): void;
  getSandboxAvailable(): boolean | undefined;
  setActiveCancelRun(cancelRun: (reason?: string) => RuntimeEvent[]): void;
  clearActiveCancelRun(): void;
  executeTurn(
    input: Omit<RuntimeTurnInputV1, 'runtimeSession' | 'createRuntimeEffectPort'>,
    provider: RuntimeActionProvider,
  ): AsyncGenerator<RuntimeEvent>;
  createRuntimeEffectPort(dependencies: RuntimeExecutorDependencies): RuntimeEffectExecutor;
  executePendingCompaction(input: {
    readonly dependencies: RuntimeExecutorDependencies;
    readonly signal?: AbortSignal;
  }): Promise<RuntimeEvent[]>;
  waitForIdle(): Promise<void>;
  close(): Promise<void>;
}

export interface RuntimeSessionCoordinatorAccessV1 {
  ensure(input: RuntimeSessionCoordinatorIdentityV1): RuntimeSessionCoordinatorV1;
  get(sessionId: string): RuntimeSessionCoordinatorV1 | undefined;
  release(sessionId: string): Promise<void>;
  close(): Promise<void>;
}

export interface RuntimeSessionCoordinatorBindingV1 {
  bind(input: {
    readonly services: RuntimeHostExecutionServices<RuntimeEvent, RuntimeState>;
    readonly capabilities: CapabilityExecutionPortV1;
    readonly capabilityRegistrySnapshot: CapabilityRegistrySnapshotV1;
    readonly builtinToolCatalog: BuiltinToolCatalogProjectionV1;
    readonly toolPipelineComposition?: AppToolPipelineCompositionV1;
    readonly modelRuntimeFactory: InstalledKiteRuntimeCompositionFactoryV1;
    readonly store: StateSessionStorageV1;
  }): void;
  access(): RuntimeSessionCoordinatorAccessV1;
}

class RuntimeSessionCoordinator implements RuntimeSessionCoordinatorV1 {
  readonly sessionId: string;
  readonly session: StateRuntimeSessionV1;
  readonly control: AuthorizedExecutionControlV1;
  readonly recoveryChanged: boolean;
  #lifecycle: RuntimeSessionCoordinatorV1['lifecycle'] = 'idle';
  #activeOperation: 'turn' | 'compacting' | null = null;
  #activeCancelRun: (reason?: string) => RuntimeEvent[] = () => [];
  #operationCompletion: Promise<void> = Promise.resolve();
  #resolveOperationCompletion: (() => void) | null = null;
  #closePromise: Promise<void> | null = null;
  #closed = false;
  readonly #store: StateSessionStorageV1;
  readonly #workspace: string;
  readonly #projectId: string;
  readonly #canonicalWorkspaceDigest: `sha256:${string}`;
  readonly #userId: string;
  readonly #recoveryIdentityKey: string;
  #sandboxAvailable: boolean | undefined;
  #interactionMode: RuntimeState['mode'];
  readonly #modelArtifactEvidence: ModelArtifactEvidenceAvailabilityV1 | undefined;
  readonly #capabilityArtifactEvidence:
    | import('@kite/builtin-runtime').CapabilityArtifactReaderV1
    | undefined;
  readonly #services: RuntimeHostExecutionServices<RuntimeEvent, RuntimeState>;
  readonly #capabilities: CapabilityExecutionPortV1;
  readonly #capabilityRegistrySnapshot: CapabilityRegistrySnapshotV1;
  readonly #builtinToolCatalog: BuiltinToolCatalogProjectionV1;
  readonly #toolPipelineComposition: AppToolPipelineCompositionV1 | undefined;
  readonly #modelRuntime: InstalledKiteRuntimeCompositionV1;
  readonly #runtimePort: RuntimeStateSessionPortV1 & {
    readonly runtimeStore: StateSessionStorageV1;
    processEvents(events: RuntimeEvent[]): void;
  };

  constructor(
    identity: RuntimeSessionCoordinatorIdentityV1,
    input: {
      readonly services: RuntimeHostExecutionServices<RuntimeEvent, RuntimeState>;
      readonly capabilities: CapabilityExecutionPortV1;
      readonly capabilityRegistrySnapshot: CapabilityRegistrySnapshotV1;
      readonly builtinToolCatalog: BuiltinToolCatalogProjectionV1;
      readonly toolPipelineComposition?: AppToolPipelineCompositionV1;
      readonly modelRuntime: InstalledKiteRuntimeCompositionV1;
      readonly store: StateSessionStorageV1;
    },
  ) {
    this.sessionId = identity.sessionId;
    this.#workspace = canonicalPathForComparison(identity.workspace);
    const workspaceDigest =
      `sha256:${createHash('sha256').update(this.#workspace).digest('hex')}` as const;
    if (
      !identity.projectId.startsWith('project_') ||
      identity.canonicalWorkspaceDigest !== workspaceDigest
    ) {
      throw new Error('Runtime session Project identity is invalid.');
    }
    this.#projectId = identity.projectId;
    this.#canonicalWorkspaceDigest = identity.canonicalWorkspaceDigest;
    this.#userId = identity.userId;
    this.#recoveryIdentityKey = identity.recoveryIdentityKey;
    this.#sandboxAvailable = identity.sandboxAvailable;
    this.#interactionMode = identity.interactionMode;
    this.#modelArtifactEvidence = identity.modelArtifactEvidence;
    this.#capabilityArtifactEvidence = identity.capabilityArtifactEvidence;
    this.#services = input.services;
    this.#capabilities = input.capabilities;
    this.#capabilityRegistrySnapshot = input.capabilityRegistrySnapshot;
    this.#builtinToolCatalog = input.builtinToolCatalog;
    this.#toolPipelineComposition = input.toolPipelineComposition;
    this.#modelRuntime = input.modelRuntime;
    this.#store = input.store;
    const restored = restoreRuntimeHostStateSessionV1({
      sessions: input.services.sessions,
      sessionId: identity.sessionId,
      userId: identity.userId,
      workspace: identity.workspace,
      projectId: identity.projectId,
      canonicalWorkspaceDigest: identity.canonicalWorkspaceDigest,
      turnId: crypto.randomUUID(),
      recoveryIdentityKey: identity.recoveryIdentityKey,
      interactionMode: this.#interactionMode,
      phase: 'building',
      validateRestoredState: identity.capabilityArtifactEvidence
        ? (state) =>
            assertRestoredCapabilityArtifactEvidenceV1(state, identity.capabilityArtifactEvidence!)
        : undefined,
    });
    this.session = createRuntimeHostStateSessionV1({
      state: restored.state,
      services: input.services,
      clock: () => new Date().toISOString(),
      id: () => crypto.randomUUID(),
      sandboxAvailable: () => this.#sandboxAvailable === true,
      verificationSchemaAdmissions: (event) => projectVerificationSchemaAdmissionsV1(event),
      eventBatchAdmissionValidator: (events) => {
        for (const event of events) {
          if (event.type !== 'interaction_mode.changed') continue;
          if (!Number.isFinite(Date.parse(event.changedAt))) {
            throw new Error('interaction_mode.changed requires a valid changedAt timestamp.');
          }
          if (event.mode === 'full') {
            assertRuntimeAuthorizationElevationV1({
              mode: 'full_access',
              source: event.source,
              sandboxAvailable: this.#sandboxAvailable === true,
            });
          }
        }
        return true;
      },
      onNamedTurnSnapshot: ({ sessionId, turnId, state, eventPosition }) => {
        input.services.checkpoints.saveNamedSnapshot(
          sessionId,
          `turn-${turnId}-${eventPosition}`,
          state,
          eventPosition,
        );
      },
    });
    this.#runtimePort = this.#createRuntimePort();
    const recoveryEvents =
      restored.state.recoveryState.kind === 'normal'
        ? projectRuntimeHostStateRestartRecoveryEventsV1(restored.state, {
            capabilityFinishedAtByInvocationId: Object.fromEntries(
              runtimeHostStateRestartRecoveryCapabilityInvocationIdsV1(restored.state).map(
                (invocationId) => [invocationId, new Date().toISOString()],
              ),
            ),
            pendingModelEvidenceFailures: Object.fromEntries(
              Object.values(restored.state.modelInvocations)
                .filter(
                  (invocation) =>
                    invocation.status === 'prepared' || invocation.status === 'dispatching',
                )
                .map((invocation) => [
                  invocation.invocationId,
                  verifyPendingModelInvocationEvidenceV1(
                    invocation,
                    identity.modelArtifactEvidence,
                  ),
                ]),
            ),
            completedModelEvidenceFailures: Object.fromEntries(
              Object.values(restored.state.modelInvocations)
                .filter((invocation) => invocation.status === 'completed')
                .map((invocation) => [
                  invocation.invocationId,
                  verifyCompletedModelInvocationEvidenceV1(
                    invocation,
                    identity.modelArtifactEvidence,
                  ),
                ]),
            ),
          })
        : [];
    const appliedRecoveryEvents =
      recoveryEvents.length > 0
        ? this.session.processEventBatch(recoveryEvents, {
            acknowledgement: 'terminal_recovery',
            source: 'host_fact',
          })
        : [];
    this.recoveryChanged = appliedRecoveryEvents.length > 0;
    this.control = Object.freeze({
      getState: () => this.getState(),
      processEvent: (event: RuntimeEvent) => {
        this.#assertOpen();
        this.session.processEvent(event);
      },
      processEventBatch: (events: RuntimeEvent[]) => {
        this.#assertOpen();
        return [...this.session.processEventBatch(events)];
      },
      cancelRun: (reason?: string) => {
        this.#assertOpen();
        return this.#activeCancelRun(reason);
      },
    });
  }

  get lifecycle(): RuntimeSessionCoordinatorV1['lifecycle'] {
    return this.#lifecycle;
  }

  getState(): Readonly<RuntimeState> {
    this.#assertOpen();
    return this.session.getState();
  }

  getStateSessionStorage(): StateSessionStorageV1 {
    this.#assertOpen();
    return this.#store;
  }

  isTurnActive(): boolean {
    return this.#activeOperation === 'turn';
  }

  beginTurn(): void {
    this.#beginOperation('turn');
    this.#lifecycle = 'running';
  }

  endTurn(): void {
    if (this.#activeOperation !== 'turn') return;
    this.#activeOperation = null;
    if (this.#lifecycle !== 'closing') this.#lifecycle = 'idle';
    this.#resolveOperationCompletion?.();
    this.#resolveOperationCompletion = null;
  }

  updateInteractionMode(mode: RuntimeState['mode']): void {
    this.#assertOpen();
    this.#interactionMode = mode;
  }

  updateSandboxAvailable(available: boolean): void {
    this.#assertOpen();
    if (this.#activeOperation) {
      throw new Error('Runtime sandbox identity cannot change during an active operation.');
    }
    this.#sandboxAvailable = available;
  }

  getSandboxAvailable(): boolean | undefined {
    return this.#sandboxAvailable;
  }

  setActiveCancelRun(cancelRun: (reason?: string) => RuntimeEvent[]): void {
    this.#assertOpen();
    this.#activeCancelRun = cancelRun;
  }

  clearActiveCancelRun(): void {
    this.#activeCancelRun = () => [];
  }

  async *executeTurn(
    input: Omit<RuntimeTurnInputV1, 'runtimeSession' | 'createRuntimeEffectPort'>,
    provider: RuntimeActionProvider,
  ): AsyncGenerator<RuntimeEvent> {
    this.#assertOpen();
    if (
      input.threadId !== this.sessionId ||
      canonicalPathForComparison(input.workspace) !== this.#workspace ||
      input.userId !== this.#userId
    ) {
      throw new Error('Runtime turn identity mismatch.');
    }
    this.beginTurn();
    try {
      yield* executeRuntimeTurnV1(
        {
          ...input,
          runtimeSession: this.#runtimePort,
          createRuntimeEffectPort: (dependencies) => this.createRuntimeEffectPort(dependencies),
          registerRunCancellation: (cancelRun) => {
            if (cancelRun) this.setActiveCancelRun(cancelRun);
            else this.clearActiveCancelRun();
          },
        },
        provider,
      );
    } finally {
      this.clearActiveCancelRun();
      this.endTurn();
    }
  }

  createRuntimeEffectPort(dependencies: RuntimeExecutorDependencies): RuntimeEffectExecutor {
    this.#assertOpen();
    if (dependencies.runtimeStore !== this.#store) {
      throw new Error('Runtime effect store identity mismatch.');
    }
    if (dependencies.capabilityExecution !== this.#capabilities) {
      throw new Error('Runtime capability execution port identity mismatch.');
    }
    if (dependencies.builtinToolCatalog !== this.#builtinToolCatalog) {
      throw new Error('Runtime Builtin catalog identity mismatch.');
    }
    if (
      this.#toolPipelineComposition &&
      dependencies.toolPipelineComposition !== this.#toolPipelineComposition
    ) {
      throw new Error('Runtime Tool Pipeline composition identity mismatch.');
    }
    if (
      !Object.isFrozen(this.#capabilityRegistrySnapshot) ||
      !Object.isFrozen(this.#capabilityRegistrySnapshot.modules) ||
      !Object.isFrozen(this.#capabilityRegistrySnapshot.capabilities) ||
      !Object.isFrozen(this.#capabilityRegistrySnapshot.contextSources)
    ) {
      throw new Error('Runtime capability snapshot is no longer frozen.');
    }
    if (
      !this.#services.sessions ||
      !this.#services.transactions ||
      !this.#services.leases ||
      !this.#services.checkpoints ||
      !this.#services.recoveryIdentities
    ) {
      throw new Error('Runtime Host services are incomplete.');
    }
    if (this.#modelRuntime.status !== 'available') {
      throw new Error('Runtime Model composition is unavailable.');
    }
    if (
      dependencies.modelInvocationGateway !== this.#modelRuntime.gateway ||
      dependencies.modelEffectCoordinator !== this.#modelRuntime.modelEffects
    ) {
      throw new Error('Runtime Model composition identity mismatch.');
    }
    return createAppRuntimeEffectExecutorV1(dependencies);
  }

  async executePendingCompaction(input: {
    readonly dependencies: RuntimeExecutorDependencies;
    readonly signal?: AbortSignal;
  }): Promise<RuntimeEvent[]> {
    this.#assertOpen();
    this.#beginOperation('compacting');
    this.#lifecycle = 'compacting';
    let runnerId: string | null = null;
    let effectLease: StateRuntimeSessionEffectLeaseV1 | null = null;
    try {
      runnerId = this.session.acquireRunner();
      if (!runnerId) {
        throw new Error('Runtime session already has an active Kernel runner.');
      }
      const pending = this.session.getState().context.pendingCompaction;
      if (!pending) return [];
      const effect = {
        type: 'compact_context' as const,
        compactionId: pending.compactionId,
      };
      const dependencies: RuntimeExecutorDependencies = {
        ...input.dependencies,
        runtimeStore: this.#store,
        ...(input.signal ? { signal: input.signal } : {}),
      };
      const executor = this.createRuntimeEffectPort(dependencies);
      const lease = this.session.beginEffect(effect);
      effectLease = lease;
      const persistedDuringExecution: RuntimeEvent[] = [];
      let terminalPersisted = false;
      const isTerminalForThisCompaction = (event: RuntimeEvent): boolean =>
        (event.type === 'context.compaction_completed' ||
          event.type === 'context.compaction_failed') &&
        event.compactionId === pending.compactionId;
      const persistEvents = async (
        events: RuntimeEvent[],
        requiredEffectLease?: RuntimeEffectLeaseExpectation,
      ): Promise<boolean> => {
        if (terminalPersisted && events.some(isTerminalForThisCompaction)) return false;
        const applied = this.session.applyEffectResult(
          lease,
          events,
          requiredEffectLease
            ? {
                sessionId: this.sessionId,
                effectId: requiredEffectLease.effectId,
                ownerId: requiredEffectLease.ownerId,
              }
            : undefined,
        );
        if (applied) {
          const appliedEvents = [...this.session.getLastAppliedEvents()];
          persistedDuringExecution.push(...appliedEvents);
          if (appliedEvents.some(isTerminalForThisCompaction)) terminalPersisted = true;
        }
        return applied;
      };
      const events = await executor(effect, this.session.getState(), undefined, {
        reservationIds: [],
        getState: () => this.session.getState(),
        persistEvent: async (event) => {
          if (terminalPersisted && isTerminalForThisCompaction(event)) return false;
          const applied = this.session.applyEffectEvent(lease, event);
          if (applied && isTerminalForThisCompaction(event)) terminalPersisted = true;
          return applied;
        },
        persistEvents,
      });
      if (events.length === 0) return persistedDuringExecution;
      if (terminalPersisted && events.some(isTerminalForThisCompaction)) {
        return persistedDuringExecution;
      }
      if (!this.session.applyEffectResult(lease, events)) return persistedDuringExecution;
      const appliedEvents = [...this.session.getLastAppliedEvents()];
      return [...persistedDuringExecution, ...appliedEvents];
    } finally {
      if (effectLease) this.session.releaseEffect(effectLease);
      if (runnerId) this.session.releaseRunner(runnerId);
      this.#finishOperation();
    }
  }

  waitForIdle(): Promise<void> {
    return this.#operationCompletion;
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#lifecycle = 'closing';
    this.#closePromise = this.#operationCompletion.then(() => {
      if (this.#closed) return;
      this.#closed = true;
      this.clearActiveCancelRun();
      this.#lifecycle = 'closed';
    });
    return this.#closePromise;
  }

  #beginOperation(operation: 'turn' | 'compacting'): void {
    this.#assertOpen();
    if (this.#activeOperation) {
      throw new Error(`Runtime session is busy with ${this.#activeOperation}.`);
    }
    this.#activeOperation = operation;
    this.#operationCompletion = new Promise<void>((resolve) => {
      this.#resolveOperationCompletion = resolve;
    });
  }

  #finishOperation(): void {
    this.#activeOperation = null;
    if (!this.#closed && this.#lifecycle !== 'closing') this.#lifecycle = 'idle';
    this.#resolveOperationCompletion?.();
    this.#resolveOperationCompletion = null;
    this.#operationCompletion = Promise.resolve();
  }

  #assertOpen(): void {
    if (this.#closed || this.#lifecycle === 'closing' || this.#lifecycle === 'closed') {
      throw new Error(`Runtime session is ${this.#lifecycle}.`);
    }
  }

  assertIdentity(identity: RuntimeSessionCoordinatorIdentityV1): void {
    if (
      canonicalPathForComparison(identity.workspace) !== this.#workspace ||
      identity.sessionId !== this.sessionId ||
      identity.userId !== this.#userId ||
      identity.projectId !== this.#projectId ||
      identity.canonicalWorkspaceDigest !== this.#canonicalWorkspaceDigest ||
      identity.recoveryIdentityKey !== this.#recoveryIdentityKey ||
      identity.interactionMode !== this.#interactionMode ||
      identity.sandboxAvailable !== this.#sandboxAvailable ||
      identity.modelArtifactEvidence !== this.#modelArtifactEvidence ||
      identity.capabilityArtifactEvidence !== this.#capabilityArtifactEvidence
    ) {
      throw new Error('Runtime session identity drifted.');
    }
  }

  #createRuntimePort(): RuntimeStateSessionPortV1 & {
    readonly runtimeStore: StateSessionStorageV1;
    processEvents(events: RuntimeEvent[]): void;
  } {
    const applyAction = (
      action: RuntimeUserAction,
      additionalEvents: RuntimeEvent[] = [],
    ): RuntimeActionResult => {
      const events = eventsForRuntimeAction(this.session.getState(), action, {
        sandboxAvailable: this.#sandboxAvailable === true,
      });
      if (events.length === 0) {
        const reason =
          this.session.getState().interactions.kind === 'idle'
            ? 'No active interaction accepts this action.'
            : 'The action does not match the active interaction.';
        return {
          status: this.session.getState().interactions.kind === 'idle' ? 'rejected' : 'stale',
          reason,
          telemetry: {
            type: 'runtime.action_ignored',
            ...('interactionId' in action ? { interactionId: action.interactionId } : {}),
            reason,
          },
        };
      }
      const applied = this.session.processEventBatch([...events, ...additionalEvents], {
        source: 'command',
      });
      return { status: 'applied', events: [...applied] };
    };
    const port: RuntimeStateSessionPortV1 & {
      readonly runtimeStore: StateSessionStorageV1;
      processEvents(events: RuntimeEvent[]): void;
    } = {
      runtimeStore: this.#store,
      getState: () => this.session.getState(),
      processEvent: (event: RuntimeEvent) => this.session.processEvent(event),
      processEventBatch: (events: RuntimeEvent[]) => this.session.processEventBatch(events),
      processEvents: (events: RuntimeEvent[]) => {
        for (const event of events) this.session.processEvent(event);
      },
      getLastAppliedEvents: () => this.session.getLastAppliedEvents(),
      selectPendingEffects: (
        state?: Readonly<RuntimeState>,
        facts?: Parameters<StateRuntimeSessionV1['selectPendingEffects']>[1],
      ) => this.session.selectPendingEffects(state, facts),
      acquireRunner: () => this.session.acquireRunner(),
      releaseRunner: (runnerId: string) => this.session.releaseRunner(runnerId),
      beginEffect: (effect) => this.session.beginEffect(effect),
      isEffectEventCurrent: (lease, event) => this.session.isEffectEventCurrent(lease, event),
      applyEffectEvent: (lease, event) => this.session.applyEffectEvent(lease, event),
      applyEffectEvents: (lease, events, acknowledgement, requiredEffectLease) =>
        this.session.applyEffectEvents(
          lease,
          events,
          acknowledgement,
          requiredEffectLease
            ? {
                sessionId: this.sessionId,
                effectId: requiredEffectLease.effectId,
                ownerId: requiredEffectLease.ownerId,
              }
            : undefined,
        ),
      applyEffectResult: (lease, events, requiredEffectLease) =>
        this.session.applyEffectResult(
          lease,
          events,
          requiredEffectLease
            ? {
                sessionId: this.sessionId,
                effectId: requiredEffectLease.effectId,
                ownerId: requiredEffectLease.ownerId,
              }
            : undefined,
        ),
      applyLateResourceReconciliation: (events) =>
        this.session.applyLateResourceReconciliation(events),
      applyAction,
      releaseEffect: (lease) => this.session.releaseEffect(lease),
    };
    return Object.freeze(port);
  }
}

class RuntimeSessionCoordinatorRegistry implements RuntimeSessionCoordinatorAccessV1 {
  readonly #coordinators = new Map<string, RuntimeSessionCoordinator>();
  readonly #services: RuntimeHostExecutionServices<RuntimeEvent, RuntimeState>;
  readonly #store: StateSessionStorageV1;
  readonly #modelRuntimeFactory: InstalledKiteRuntimeCompositionFactoryV1;
  readonly #capabilities: CapabilityExecutionPortV1;
  readonly #snapshot: CapabilityRegistrySnapshotV1;
  readonly #builtinToolCatalog: BuiltinToolCatalogProjectionV1;
  readonly #toolPipelineComposition: AppToolPipelineCompositionV1 | undefined;
  #closed = false;

  constructor(input: {
    readonly services: RuntimeHostExecutionServices<RuntimeEvent, RuntimeState>;
    readonly store: StateSessionStorageV1;
    readonly capabilities: CapabilityExecutionPortV1;
    readonly capabilityRegistrySnapshot: CapabilityRegistrySnapshotV1;
    readonly builtinToolCatalog: BuiltinToolCatalogProjectionV1;
    readonly toolPipelineComposition?: AppToolPipelineCompositionV1;
    readonly modelRuntimeFactory: InstalledKiteRuntimeCompositionFactoryV1;
  }) {
    if (
      !Object.isFrozen(input.capabilityRegistrySnapshot) ||
      !Object.isFrozen(input.capabilityRegistrySnapshot.modules) ||
      !Object.isFrozen(input.capabilityRegistrySnapshot.capabilities) ||
      !Object.isFrozen(input.capabilityRegistrySnapshot.contextSources) ||
      !Object.isFrozen(input.builtinToolCatalog) ||
      !Object.isFrozen(input.builtinToolCatalog.entries)
    ) {
      throw new Error('Runtime coordinator requires a frozen capability snapshot.');
    }
    const catalogEntries = new Map(
      input.builtinToolCatalog.entries.map((entry) => [entry.operationId, entry]),
    );
    if (catalogEntries.size !== input.builtinToolCatalog.entries.length) {
      throw new Error('Runtime Builtin catalog contains duplicate operation owners.');
    }
    for (const { definition, executor } of input.capabilityRegistrySnapshot.capabilities) {
      const entry = catalogEntries.get(definition.capabilityId);
      if (
        !entry ||
        entry.providerId !== definition.providerId ||
        entry.revision !== definition.revision ||
        (executor && entry.executorRevision !== executor.executorRevision)
      ) {
        throw new Error(
          `Runtime Builtin catalog does not match capability snapshot: ${definition.capabilityId}`,
        );
      }
    }
    this.#services = input.services;
    this.#store = input.store;
    this.#capabilities = input.capabilities;
    this.#snapshot = input.capabilityRegistrySnapshot;
    this.#builtinToolCatalog = input.builtinToolCatalog;
    this.#toolPipelineComposition = input.toolPipelineComposition;
    this.#modelRuntimeFactory = input.modelRuntimeFactory;
  }

  ensure(identity: RuntimeSessionCoordinatorIdentityV1): RuntimeSessionCoordinatorV1 {
    if (this.#closed) throw new Error('Runtime coordinator registry is closed.');
    const existing = this.#coordinators.get(identity.sessionId);
    if (existing) {
      existing.assertIdentity(identity);
      return existing;
    }

    const modelRuntime = this.#modelRuntimeFactory(identity.workspace);
    if (
      modelRuntime.status === 'available' &&
      (!modelRuntime.gateway || !modelRuntime.modelEffects)
    ) {
      throw new Error('Runtime Model composition is incomplete.');
    }
    const coordinator = new RuntimeSessionCoordinator(identity, {
      services: this.#services,
      capabilities: this.#capabilities,
      capabilityRegistrySnapshot: this.#snapshot,
      builtinToolCatalog: this.#builtinToolCatalog,
      toolPipelineComposition: this.#toolPipelineComposition,
      modelRuntime,
      store: this.#store,
    });
    this.#coordinators.set(identity.sessionId, coordinator);
    return coordinator;
  }

  get(sessionId: string): RuntimeSessionCoordinatorV1 | undefined {
    return this.#coordinators.get(sessionId);
  }

  async release(sessionId: string): Promise<void> {
    const coordinator = this.#coordinators.get(sessionId);
    if (!coordinator) return;
    await coordinator.close();
    if (this.#coordinators.get(sessionId) === coordinator) {
      this.#coordinators.delete(sessionId);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const coordinators = [...this.#coordinators.values()];
    await Promise.all(coordinators.map((coordinator) => coordinator.close()));
    this.#coordinators.clear();
  }
}

export function createRuntimeSessionCoordinatorBindingV1(): RuntimeSessionCoordinatorBindingV1 {
  let access: RuntimeSessionCoordinatorAccessV1 | undefined;
  let bound = false;
  return {
    bind(input) {
      if (bound) throw new Error('Runtime coordinator binding is already bound.');
      bound = true;
      access = new RuntimeSessionCoordinatorRegistry(input);
    },
    access() {
      if (!access) throw new Error('Runtime coordinator binding is unavailable.');
      return access;
    },
  };
}
