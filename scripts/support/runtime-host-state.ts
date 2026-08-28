import { randomUUID } from 'node:crypto';
import {
  type AgentState,
  type KernelEvent,
  projectStateRestartRecoveryEvents,
  type RuntimeEffect,
  stateRestartRecoveryCapabilityInvocationIds,
} from '@kite-ai/agent-kernel';
import {
  assertRestoredCapabilityArtifactEvidence,
  type CapabilityArtifactReader,
} from '@kite-ai/builtin-runtime';
import {
  type ModelArtifactEvidenceAvailability,
  verifyCompletedModelInvocationEvidence,
  verifyPendingModelInvocationEvidence,
} from '@kite-ai/builtin-runtime/model';
import {
  type RuntimeHostExecutionServices,
  restoreRuntimeHostStateSession,
} from '@kite-ai/runtime-host';
import {
  createRuntimeHostStateSession,
  isStateRuntimeEffectDeferred,
  type StateRuntimeEffectExecutor,
  type StateRuntimeEffectPersistenceAcknowledgement,
  type StateRuntimeSession,
  type StateRuntimeSessionEffectLease,
} from '@kite-ai/runtime-host/kernel-adapter';
import type {
  RuntimeEffectLeaseExpectation,
  RuntimeRestoreBoundary,
} from '@kite-ai/runtime-host/storage';
import {
  eventsForRuntimeAction,
  type RuntimeActionResult,
  type RuntimeUserAction,
} from '#kite-service/bootstrap/runtime/state-actions';
import { projectVerificationSchemaAdmissions } from '#kite-service/bootstrap/runtime/verification-schema-admission';
import { type TestRuntimeStore, withTestStateProjectIdentity } from './runtime-storage';

type StateStore = TestRuntimeStore<KernelEvent, AgentState>;

export interface StateHarnessIdSource {
  next(scope: 'turn' | 'task' | 'kernel_runner' | 'kernel_effect' | 'model_invocation'): string;
  now(): number;
}

function liveIdSource(): StateHarnessIdSource {
  return Object.freeze({
    next: () => randomUUID(),
    now: () => Date.now(),
  });
}

export interface StateHostSessionHarnessInput {
  readonly store: StateStore;
  readonly initialState: AgentState;
  readonly interactionMode: AgentState['mode'];
  readonly sandboxAvailable?: boolean;
  readonly runtimeIdSource?: StateHarnessIdSource;
}

export class StateHostSessionHarness {
  readonly runtimeStore: StateStore;
  readonly #session: StateRuntimeSession;
  readonly #runtimeIdSource: StateHarnessIdSource;
  #sandboxAvailable: boolean;

  constructor(input: StateHostSessionHarnessInput) {
    this.runtimeStore = input.store;
    this.#runtimeIdSource = input.runtimeIdSource ?? liveIdSource();
    this.#sandboxAvailable = input.sandboxAvailable ?? false;
    this.#session = createRuntimeHostStateSession({
      state: withTestStateProjectIdentity(input.initialState),
      services: testExecutionServices(input.store, this.#runtimeIdSource),
      clock: () => new Date(this.#runtimeIdSource.now()).toISOString(),
      id: (kind) => this.#id(kind),
      sandboxAvailable: () => this.#sandboxAvailable,
      verificationSchemaAdmissions: (event) => projectVerificationSchemaAdmissions(event),
      eventBatchAdmissionValidator: (events) => {
        for (const event of events) {
          if (event.type !== 'interaction_mode.changed') continue;
          if (!Number.isFinite(Date.parse(event.changedAt))) {
            throw new Error('interaction_mode.changed requires a valid changedAt timestamp.');
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
    requiredEffectLease?: RuntimeEffectLeaseExpectation,
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
    facts?: Parameters<StateRuntimeSession['selectPendingEffects']>[1],
  ): readonly RuntimeEffect[] {
    return this.#session.selectPendingEffects(state, facts);
  }

  acquireRunner(): string | null {
    return this.#session.acquireRunner();
  }

  releaseRunner(runnerId: string): void {
    this.#session.releaseRunner(runnerId);
  }

  beginEffect(effect: RuntimeEffect): StateRuntimeSessionEffectLease {
    return this.#session.beginEffect(effect);
  }

  isEffectEventCurrent(lease: StateRuntimeSessionEffectLease, event: KernelEvent): boolean {
    return this.#session.isEffectEventCurrent(lease, event);
  }

  applyEffectEvent(lease: StateRuntimeSessionEffectLease, event: KernelEvent): boolean {
    return this.#session.applyEffectEvent(lease, event);
  }

  applyEffectResult(
    lease: StateRuntimeSessionEffectLease,
    events: KernelEvent[],
    requiredEffectLease?: RuntimeEffectLeaseExpectation,
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
    lease: StateRuntimeSessionEffectLease,
    events: KernelEvent[],
    acknowledgement: StateRuntimeEffectPersistenceAcknowledgement,
    requiredEffectLease?: RuntimeEffectLeaseExpectation,
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
    executor: StateRuntimeEffectExecutor<AgentState, KernelEvent, RuntimeEffect>,
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
          if (isStateRuntimeEffectDeferred(events)) {
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

export interface RestoreStateHostSessionHarnessInput {
  readonly threadId: string;
  readonly userId: string;
  readonly workspace: string;
  readonly projectId?: string;
  readonly canonicalWorkspaceDigest?: string;
  readonly store: StateStore;
  readonly recoveryIdentityKey: string;
  readonly interactionMode?: AgentState['mode'];
  readonly phase?: 'planning' | 'building';
  readonly sandboxAvailable?: boolean;
  readonly modelArtifactEvidence?: ModelArtifactEvidenceAvailability;
  readonly capabilityArtifactEvidence?: CapabilityArtifactReader;
  readonly runtimeIdSource?: StateHarnessIdSource;
}

export function restoreStateHostSessionHarness(
  input: RestoreStateHostSessionHarnessInput,
): StateHostSessionHarness {
  const source = input.runtimeIdSource ?? liveIdSource();
  const restored = restoreStateStateFromStore({ ...input, runtimeIdSource: source });
  const harness = new StateHostSessionHarness({
    store: input.store,
    initialState: restored.state,
    interactionMode: input.interactionMode ?? 'accept_edits',
    sandboxAvailable: input.sandboxAvailable,
    runtimeIdSource: source,
  });
  if (restored.state.recoveryState.kind !== 'normal') return harness;
  const recoveryEvents = projectStateRestartRecoveryEvents(restored.state, {
    capabilityFinishedAtByInvocationId: Object.fromEntries(
      stateRestartRecoveryCapabilityInvocationIds(restored.state).map((invocationId) => [
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
          verifyPendingModelInvocationEvidence(invocation, input.modelArtifactEvidence),
        ]),
    ),
    completedModelEvidenceFailures: Object.fromEntries(
      Object.values(restored.state.modelInvocations)
        .filter((invocation) => invocation.status === 'completed')
        .map((invocation) => [
          invocation.invocationId,
          verifyCompletedModelInvocationEvidence(invocation, input.modelArtifactEvidence),
        ]),
    ),
  });
  for (const event of recoveryEvents) harness.processEvent(event);
  return harness;
}

export function restoreStateStateFromStore(input: RestoreStateHostSessionHarnessInput): {
  readonly state: AgentState;
  readonly restoreBoundary: RuntimeRestoreBoundary;
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
          assertRestoredCapabilityArtifactEvidence(state, capabilityArtifactEvidence)
      : undefined,
  };
  const restored = restoreRuntimeHostStateSession(common);
  return { state: restored.state, restoreBoundary: restored.restoreBoundary };
}

function testExecutionServices(
  store: StateStore,
  source: StateHarnessIdSource,
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
      commitCommandDecision: (input) =>
        store.appendEventsAndSnapshot(
          input.sessionId,
          input.events,
          input.snapshot,
          input.metadata,
          input.snapshotMetadata,
          input.expectedRestoreBoundary,
          input.requiredEffectLease,
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
