import { randomUUID } from 'node:crypto';
import {
  type AgentState,
  assertAuthorizationElevation,
  type KernelEvent,
  projectStateRestartRecoveryEventsV1,
  type RuntimeEffect,
  stateRestartRecoveryCapabilityInvocationIdsV1,
} from '@kite/agent-kernel';
import {
  assertRestoredCapabilityArtifactEvidenceV1,
  type CapabilityArtifactReaderV1,
} from '@kite/builtin-runtime';
import {
  type ModelArtifactEvidenceAvailabilityV1,
  verifyCompletedModelInvocationEvidenceV1,
  verifyPendingModelInvocationEvidenceV1,
} from '@kite/builtin-runtime/model';
import {
  createRuntimeHostStateSessionV1,
  isStateRuntimeEffectDeferredV1,
  type RuntimeHostExecutionServices,
  restoreRuntimeHostStateSessionV1,
  type StateRuntimeEffectExecutorV1,
  type StateRuntimeEffectPersistenceAcknowledgementV1,
  type StateRuntimeSessionEffectLeaseV1,
  type StateRuntimeSessionV1,
} from '@kite/runtime-host';
import type {
  RuntimeEffectLeaseExpectationV1,
  RuntimeRestoreBoundaryV1,
  RuntimeSessionStoragePortV1,
} from '@kite/runtime-host/storage';
import {
  eventsForRuntimeAction,
  type RuntimeActionResult,
  type RuntimeUserAction,
} from '#app/bootstrap/runtime/state-actions';
import { projectVerificationSchemaAdmissionsV1 } from '#app/bootstrap/runtime/verification-schema-admission';
import { withTestStateProjectIdentityV1 } from './runtime-storage';

type StateStore = RuntimeSessionStoragePortV1<KernelEvent, AgentState>;

export interface StateHarnessIdSourceV1 {
  next(scope: 'turn' | 'task' | 'kernel_runner' | 'kernel_effect' | 'model_invocation'): string;
  now(): number;
}

function liveIdSource(): StateHarnessIdSourceV1 {
  return Object.freeze({
    next: () => randomUUID(),
    now: () => Date.now(),
  });
}

export interface StateHostSessionHarnessInputV1 {
  readonly store: StateStore;
  readonly initialState: AgentState;
  readonly interactionMode: AgentState['mode'];
  readonly sandboxAvailable?: boolean;
  readonly runtimeIdSource?: StateHarnessIdSourceV1;
}

export class StateHostSessionHarnessV1 {
  readonly runtimeStore: StateStore;
  readonly #session: StateRuntimeSessionV1;
  readonly #runtimeIdSource: StateHarnessIdSourceV1;
  #sandboxAvailable: boolean;

  constructor(input: StateHostSessionHarnessInputV1) {
    this.runtimeStore = input.store;
    this.#runtimeIdSource = input.runtimeIdSource ?? liveIdSource();
    this.#sandboxAvailable = input.sandboxAvailable ?? false;
    this.#session = createRuntimeHostStateSessionV1({
      state: withTestStateProjectIdentityV1(input.initialState),
      services: compatibilityServices(input.store, this.#runtimeIdSource),
      clock: () => new Date(this.#runtimeIdSource.now()).toISOString(),
      id: (kind) => this.#id(kind),
      sandboxAvailable: () => this.#sandboxAvailable,
      verificationSchemaAdmissions: (event) => projectVerificationSchemaAdmissionsV1(event),
      eventBatchAdmissionValidator: (events) => {
        for (const event of events) {
          if (event.type !== 'interaction_mode.changed') continue;
          if (!Number.isFinite(Date.parse(event.changedAt))) {
            throw new Error('interaction_mode.changed requires a valid changedAt timestamp.');
          }
          if (event.mode === 'full') {
            assertAuthorizationElevation({
              mode: 'full_access',
              source: event.source,
              sandboxAvailable: this.#sandboxAvailable,
            });
          }
        }
        return true;
      },
      onNamedTurnSnapshot: ({ sessionId, turnId, state, eventPosition }) =>
        input.store.saveNamedSnapshot(
          sessionId,
          `turn-${turnId}-${eventPosition}`,
          state,
          eventPosition,
        ),
    });
  }

  getState(): Readonly<AgentState> {
    return this.#session.getState();
  }

  processEvent(event: KernelEvent) {
    return this.#session.processEvent(event);
  }

  processEventBatch(
    events: KernelEvent[],
    requiredEffectLease?: RuntimeEffectLeaseExpectationV1,
    source: 'command' | 'receipt' | 'host_fact' = 'host_fact',
  ): KernelEvent[] {
    return [
      ...this.#session.processEventBatch(events, {
        source,
        ...(requiredEffectLease
          ? {
              requiredEffectLease: {
                sessionId: this.#session.sessionId,
                effectId: requiredEffectLease.effectId,
                ownerId: requiredEffectLease.ownerId,
              },
            }
          : {}),
      }),
    ];
  }

  processEvents(events: KernelEvent[]): void {
    for (const event of events) this.processEvent(event);
  }

  getLastAppliedEvents(): readonly KernelEvent[] {
    return this.#session.getLastAppliedEvents();
  }

  selectPendingEffects(
    state: Readonly<AgentState> = this.#session.getState(),
    facts?: Parameters<StateRuntimeSessionV1['selectPendingEffects']>[1],
  ): readonly RuntimeEffect[] {
    return this.#session.selectPendingEffects(state, facts);
  }

  acquireRunner(): string | null {
    return this.#session.acquireRunner();
  }

  releaseRunner(runnerId: string): void {
    this.#session.releaseRunner(runnerId);
  }

  beginEffect(effect: RuntimeEffect): StateRuntimeSessionEffectLeaseV1 {
    return this.#session.beginEffect(effect);
  }

  isEffectEventCurrent(lease: StateRuntimeSessionEffectLeaseV1, event: KernelEvent): boolean {
    return this.#session.isEffectEventCurrent(lease, event);
  }

  applyEffectEvent(lease: StateRuntimeSessionEffectLeaseV1, event: KernelEvent): boolean {
    return this.#session.applyEffectEvent(lease, event);
  }

  applyEffectResult(
    lease: StateRuntimeSessionEffectLeaseV1,
    events: KernelEvent[],
    requiredEffectLease?: RuntimeEffectLeaseExpectationV1,
  ): boolean {
    return this.#session.applyEffectResult(
      lease,
      events,
      requiredEffectLease
        ? {
            sessionId: this.#session.sessionId,
            effectId: requiredEffectLease.effectId,
            ownerId: requiredEffectLease.ownerId,
          }
        : undefined,
    );
  }

  applyEffectEvents(
    lease: StateRuntimeSessionEffectLeaseV1,
    events: KernelEvent[],
    acknowledgement: StateRuntimeEffectPersistenceAcknowledgementV1,
    requiredEffectLease?: RuntimeEffectLeaseExpectationV1,
  ): boolean {
    return this.#session.applyEffectEvents(
      lease,
      events,
      acknowledgement,
      requiredEffectLease
        ? {
            sessionId: this.#session.sessionId,
            effectId: requiredEffectLease.effectId,
            ownerId: requiredEffectLease.ownerId,
          }
        : undefined,
    );
  }

  applyLateResourceReconciliation(events: readonly KernelEvent[]): boolean {
    return this.#session.applyLateResourceReconciliation(events);
  }

  applyAction(
    action: RuntimeUserAction,
    additionalEvents: KernelEvent[] = [],
  ): RuntimeActionResult {
    const events = eventsForRuntimeAction(this.#session.getState(), action, {
      sandboxAvailable: this.#sandboxAvailable,
    });
    if (events.length === 0) {
      const reason =
        this.#session.getState().interactions.kind === 'idle'
          ? 'No active interaction accepts this action.'
          : 'The action does not match the active interaction.';
      return {
        status: this.#session.getState().interactions.kind === 'idle' ? 'rejected' : 'stale',
        reason,
        telemetry: {
          type: 'runtime.action_ignored',
          ...('interactionId' in action ? { interactionId: action.interactionId } : {}),
          reason,
        },
      };
    }
    return {
      status: 'applied',
      events: this.processEventBatch([...events, ...additionalEvents], undefined, 'command'),
    };
  }

  setSandboxAvailable(available: boolean): void {
    this.#sandboxAvailable = available;
  }

  async run(
    executor: StateRuntimeEffectExecutorV1<AgentState, KernelEvent, RuntimeEffect>,
    maxEffects = 10_000,
  ): Promise<RuntimeEffect> {
    const runnerId = this.acquireRunner();
    if (!runnerId) {
      return { type: 'busy', reason: 'A runtime runner is already active for this thread.' };
    }
    try {
      for (let index = 0; index < maxEffects; index++) {
        const effect = this.selectPendingEffects()[0] ?? { type: 'stop' as const };
        if (
          effect.type === 'recovery_blocked' ||
          effect.type === 'request_user_input' ||
          effect.type === 'request_plan_review' ||
          effect.type === 'request_tool_approval' ||
          effect.type === 'request_verification_decision' ||
          effect.type === 'request_provider_action' ||
          effect.type === 'request_provider_admission' ||
          effect.type === 'stop' ||
          effect.type === 'emit_final'
        ) {
          return effect;
        }
        const lease = this.beginEffect(effect);
        try {
          const events = await executor(effect, this.getState());
          if (isStateRuntimeEffectDeferredV1(events)) {
            return { type: 'busy', reason: events.deferred.reason };
          }
          if (events.length === 0) return { type: 'stop' };
          if (!this.applyEffectResult(lease, events)) continue;
        } finally {
          this.#session.releaseEffect(lease);
        }
      }
      throw new Error(`Runtime effect limit (${maxEffects}) exceeded`);
    } finally {
      this.releaseRunner(runnerId);
    }
  }

  close(closeStore = true): void {
    if (closeStore) this.runtimeStore.close();
  }

  #id(kind: string): string {
    if (kind === 'task') return this.#runtimeIdSource.next('task');
    if (kind === 'state_runner') return this.#runtimeIdSource.next('kernel_runner');
    if (kind === 'state_effect') return this.#runtimeIdSource.next('kernel_effect');
    throw new Error(`Unexpected State harness identity scope: ${kind}`);
  }
}

export interface RestoreStateHostSessionHarnessInputV1 {
  readonly threadId: string;
  readonly userId: string;
  readonly workspace: string;
  readonly projectId?: string;
  readonly canonicalWorkspaceDigest?: string;
  readonly store: StateStore;
  readonly recoveryIdentityKey: string;
  readonly interactionMode?: AgentState['mode'];
  readonly authorizationMode?: AgentState['authorization']['mode'];
  readonly authorizationSource?: NonNullable<AgentState['authorization']['modeSource']>;
  readonly phase?: 'planning' | 'building';
  readonly sandboxAvailable?: boolean;
  readonly modelArtifactEvidence?: ModelArtifactEvidenceAvailabilityV1;
  readonly capabilityArtifactEvidence?: CapabilityArtifactReaderV1;
  readonly runtimeIdSource?: StateHarnessIdSourceV1;
}

export function restoreStateHostSessionHarnessV1(
  input: RestoreStateHostSessionHarnessInputV1,
): StateHostSessionHarnessV1 {
  const source = input.runtimeIdSource ?? liveIdSource();
  const restored = restoreStateStateFromStoreV1({ ...input, runtimeIdSource: source });
  const harness = new StateHostSessionHarnessV1({
    store: input.store,
    initialState: restored.state,
    interactionMode: input.interactionMode ?? 'accept_edits',
    sandboxAvailable: input.sandboxAvailable,
    runtimeIdSource: source,
  });
  if (restored.state.recoveryState.kind !== 'normal') return harness;
  const recoveryEvents = projectStateRestartRecoveryEventsV1(restored.state, {
    capabilityFinishedAtByInvocationId: Object.fromEntries(
      stateRestartRecoveryCapabilityInvocationIdsV1(restored.state).map((invocationId) => [
        invocationId,
        new Date(source.now()).toISOString(),
      ]),
    ),
    pendingModelEvidenceFailures: Object.fromEntries(
      Object.values(restored.state.modelInvocations)
        .filter(
          (invocation) => invocation.status === 'prepared' || invocation.status === 'dispatching',
        )
        .map((invocation) => [
          invocation.invocationId,
          verifyPendingModelInvocationEvidenceV1(invocation, input.modelArtifactEvidence),
        ]),
    ),
    completedModelEvidenceFailures: Object.fromEntries(
      Object.values(restored.state.modelInvocations)
        .filter((invocation) => invocation.status === 'completed')
        .map((invocation) => [
          invocation.invocationId,
          verifyCompletedModelInvocationEvidenceV1(invocation, input.modelArtifactEvidence),
        ]),
    ),
  });
  for (const event of recoveryEvents) harness.processEvent(event);
  return harness;
}

export function restoreStateStateFromStoreV1(input: RestoreStateHostSessionHarnessInputV1): {
  readonly state: AgentState;
  readonly restoreBoundary: RuntimeRestoreBoundaryV1;
} {
  const source = input.runtimeIdSource ?? liveIdSource();
  const capabilityArtifactEvidence = input.capabilityArtifactEvidence;
  const common = {
    sessions: input.store,
    sessionId: input.threadId,
    userId: input.userId,
    workspace: input.workspace,
    projectId: input.projectId,
    canonicalWorkspaceDigest: input.canonicalWorkspaceDigest,
    turnId: source.next('turn'),
    recoveryIdentityKey: input.recoveryIdentityKey,
    interactionMode: input.interactionMode,
    phase: input.phase,
    validateRestoredState: capabilityArtifactEvidence
      ? (state: Readonly<AgentState>) =>
          assertRestoredCapabilityArtifactEvidenceV1(state, capabilityArtifactEvidence)
      : undefined,
  };
  const restored =
    input.authorizationMode === 'full_access'
      ? restoreRuntimeHostStateSessionV1({
          ...common,
          authorizationMode: 'full_access',
          authorizationSource: input.authorizationSource ?? 'system',
          modeGrantedAt: new Date(source.now()).toISOString(),
        })
      : restoreRuntimeHostStateSessionV1({
          ...common,
          authorizationMode: input.authorizationMode,
          authorizationSource: input.authorizationSource,
        });
  return { state: restored.state, restoreBoundary: restored.restoreBoundary };
}

function compatibilityServices(
  store: StateStore,
  source: StateHarnessIdSourceV1,
): RuntimeHostExecutionServices<KernelEvent, AgentState> {
  return {
    sessions: store,
    transactions: {
      commit: (_acknowledgement, input, requiredLease) =>
        store.appendEventsAndSnapshot(
          input.sessionId,
          input.events,
          input.snapshot,
          input.metadata,
          input.snapshotMetadata,
          input.expectedRestoreBoundary,
          requiredLease
            ? {
                effectId: requiredLease.effectId,
                ownerId: requiredLease.ownerId,
                observedAtMs: source.now(),
              }
            : input.requiredEffectLease,
        ),
    },
    leases: {
      tryAcquire: (sessionId, effectId, ownerId, expiresAtMs) =>
        store.tryAcquireEffectLease(sessionId, effectId, ownerId, expiresAtMs),
      renew: (sessionId, effectId, ownerId, expiresAtMs) =>
        store.renewEffectLease(sessionId, effectId, ownerId, expiresAtMs),
      release: (sessionId, effectId, ownerId) =>
        store.releaseEffectLease(sessionId, effectId, ownerId),
      hasClaim: () => true,
    },
    checkpoints: store,
    recoveryIdentities: {
      read: () => null,
      getOrCreate: (_sessionId, allocate) => allocate(),
      remove: () => undefined,
    },
  };
}
