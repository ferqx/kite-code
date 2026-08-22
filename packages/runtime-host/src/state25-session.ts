import {
  type AgentState,
  assertAgentStateInvariants,
  assertCapabilityToolTerminalBatchV1,
  attachSuspendedCapabilityTerminalsV1,
  type DecisionFacts,
  decide,
  digestAgentEvent,
  finalizeAgentEvent,
  getEffectiveInteractionMode,
  hasLateTerminalEventForCancelledToolV1,
  isConcurrentShellEffectBatchCurrentV1,
  type KernelEvent,
  normalizeAgentEvent,
  type RuntimeEffect,
  reduce,
  type SchedulerFactsV1,
  selectPendingEffects,
  suspendedCapabilityTerminalRequirementsV1,
  taskIdentityAllocationKeyV1,
  type VerificationSchemaAdmissionFactV1,
} from '@kite/agent-kernel';
import type {
  RuntimeHostExecutionServices,
  RuntimeLeaseRequirementV1,
  RuntimeTransactionAcknowledgement,
} from './effect-supervisor';
import type {
  State25RuntimeEffectLeaseV1 as BaseState25RuntimeEffectLeaseV1,
  State25RuntimeEffectPersistenceAcknowledgementV1,
} from './state25-effect-runtime';
import type {
  RuntimeEventMetadataV1,
  RuntimeRestoreBoundaryV1,
  RuntimeTransactionInputV1,
} from './storage';

/** The one State 25 / Store 4 format accepted by this Host session. */
export const STATE25_RUNTIME_SESSION_FORMAT_V1 = Object.freeze({
  schemaVersion: 25 as const,
  storeVersion: 4 as const,
  epoch: 'kite-runtime-2026-08-18' as const,
});

export type State25RuntimeSessionClockV1 = () => string;
export type State25RuntimeSessionIdSourceV1 = (kind: string) => string;

export type State25RuntimeSessionEffectLeaseV1 = BaseState25RuntimeEffectLeaseV1;

export interface State25RuntimeSessionEventContextV1 {
  readonly sessionId: string;
  readonly eventIndex: number;
  readonly state: Readonly<AgentState>;
}

export type State25RuntimeVerificationAdmissionV1 = (
  event: KernelEvent,
  context: State25RuntimeSessionEventContextV1,
) => readonly (VerificationSchemaAdmissionFactV1 | null)[] | undefined;

export type State25RuntimeEventBatchPreprocessorV1 = (
  events: readonly KernelEvent[],
  state: Readonly<AgentState>,
) => readonly KernelEvent[];

export type State25RuntimeEventBatchAdmissionValidatorV1 = (
  events: readonly KernelEvent[],
  state: Readonly<AgentState>,
) => undefined | boolean;

export type State25RuntimeToolTerminalBatchValidatorV1 = (
  effect: Extract<RuntimeEffect, { readonly type: 'run_tools' }>,
  events: readonly KernelEvent[],
  state: Readonly<AgentState>,
) => undefined | boolean;

export interface State25RuntimeNamedTurnSnapshotInputV1 {
  readonly sessionId: string;
  readonly turnId: string;
  readonly state: Readonly<AgentState>;
  readonly eventPosition: number;
}

/**
 * The only Host seam for a concurrent effect that is allowed to survive an
 * unrelated State 25 revision.  The callback owns the domain-specific
 * predicate (for example, a shell sibling predicate); Host never inspects a
 * tool name or a model operation.
 */
export type State25RuntimeConcurrentEffectEventCurrentV1 = (
  lease: Readonly<State25RuntimeSessionEffectLeaseV1>,
  event: KernelEvent,
  state: Readonly<AgentState>,
) => boolean;

/**
 * Optional pure projection paired with the concurrent-event predicate.  When
 * omitted, the Kernel reducer is used for the transient validation projection.
 * It is never persisted and never becomes a second reducer authority.
 */
export type State25RuntimeConcurrentEffectStateProjectorV1 = (
  state: Readonly<AgentState>,
  event: KernelEvent,
) => AgentState;

export interface State25RuntimeSessionInputV1 {
  readonly state: AgentState;
  readonly services: RuntimeHostExecutionServices<KernelEvent, AgentState>;
  readonly clock: State25RuntimeSessionClockV1;
  readonly id: State25RuntimeSessionIdSourceV1;
  readonly sandboxAvailable?: boolean | (() => boolean);
  readonly verificationSchemaAdmissions?: State25RuntimeVerificationAdmissionV1;
  readonly eventBatchPreprocessor?: State25RuntimeEventBatchPreprocessorV1;
  readonly eventBatchAdmissionValidator?: State25RuntimeEventBatchAdmissionValidatorV1;
  readonly toolTerminalBatchValidator?: State25RuntimeToolTerminalBatchValidatorV1;
  readonly onNamedTurnSnapshot?: (input: State25RuntimeNamedTurnSnapshotInputV1) => void;
  readonly isConcurrentEffectEventCurrent?: State25RuntimeConcurrentEffectEventCurrentV1;
  readonly projectConcurrentEffectState?: State25RuntimeConcurrentEffectStateProjectorV1;
  /** Reject a late result which has become terminal for a cancelled owner. */
  readonly isLateEffectResult?: (
    lease: Readonly<State25RuntimeSessionEffectLeaseV1>,
    events: readonly KernelEvent[],
    state: Readonly<AgentState>,
  ) => boolean;
}

export interface State25RuntimeProcessEventResultV1 {
  readonly status: 'applied' | 'duplicate';
  readonly eventId: string;
}

export interface State25RuntimeProcessEventBatchOptionsV1 {
  readonly acknowledgement?: RuntimeTransactionAcknowledgement;
  readonly requiredEffectLease?: RuntimeLeaseRequirementV1;
  readonly causationId?: string;
  readonly source?: 'command' | 'receipt' | 'host_fact';
  /** Single-event clock binding used by processEvent. */
  readonly occurredAt?: string;
}

export interface State25RuntimeSessionV1 {
  readonly sessionId: string;
  getState(): Readonly<AgentState>;
  processEvent(event: KernelEvent): State25RuntimeProcessEventResultV1;
  processEventBatch(
    events: readonly KernelEvent[],
    options?: State25RuntimeProcessEventBatchOptionsV1,
  ): readonly KernelEvent[];
  getLastAppliedEvents(): readonly KernelEvent[];
  selectPendingEffects(
    state?: Readonly<AgentState>,
    facts?: SchedulerFactsV1,
  ): readonly RuntimeEffect[];
  acquireRunner(): string | null;
  releaseRunner(runnerId: string): void;
  beginEffect(effect: RuntimeEffect): State25RuntimeSessionEffectLeaseV1;
  isEffectLeaseCurrent(lease: Readonly<State25RuntimeSessionEffectLeaseV1>): boolean;
  isEffectEventCurrent(
    lease: Readonly<State25RuntimeSessionEffectLeaseV1>,
    event: KernelEvent,
  ): boolean;
  applyResult(
    lease: State25RuntimeSessionEffectLeaseV1,
    events: readonly KernelEvent[],
    requiredEffectLease?: RuntimeLeaseRequirementV1,
  ): boolean;
  applyEffectResult(
    lease: State25RuntimeSessionEffectLeaseV1,
    events: readonly KernelEvent[],
    requiredEffectLease?: RuntimeLeaseRequirementV1,
  ): boolean;
  /**
   * Apply a durable effect batch through one explicit Store 4 acknowledgement
   * channel.  This method requires the exact in-process effect lease; stale
   * callers fail closed and cannot publish through a successor attempt.
   */
  applyEffectEvents(
    lease: State25RuntimeSessionEffectLeaseV1,
    events: readonly KernelEvent[],
    acknowledgement: State25RuntimeEffectPersistenceAcknowledgementV1,
    requiredEffectLease?: RuntimeLeaseRequirementV1,
  ): boolean;
  applyEvent(
    lease: State25RuntimeSessionEffectLeaseV1,
    event: KernelEvent,
    requiredEffectLease?: RuntimeLeaseRequirementV1,
  ): boolean;
  applyEffectEvent(
    lease: State25RuntimeSessionEffectLeaseV1,
    event: KernelEvent,
    requiredEffectLease?: RuntimeLeaseRequirementV1,
  ): boolean;
  applyLateResourceReconciliation(events: readonly KernelEvent[]): boolean;
  releaseEffect(lease: Readonly<State25RuntimeSessionEffectLeaseV1>): void;
}

interface State25RuntimeSessionDefaults {
  readonly clock: State25RuntimeSessionClockV1;
  readonly id: State25RuntimeSessionIdSourceV1;
}

function assertState25RuntimeSessionStateV1(state: AgentState): void {
  if (state.recoveryState.kind === 'normal' || state.turn.status === 'aborted') {
    assertAgentStateInvariants(state);
    return;
  }
  // A failed restore is intentionally represented as a current-format hard
  // block with an active turn. The pure scheduler must be allowed to emit its
  // recovery_blocked effect so the Host can durably abort that turn. Validate
  // every other invariant by replacing only the hard-block marker.
  assertAgentStateInvariants({ ...state, recoveryState: { kind: 'normal' } });
}

/**
 * Host-owned State 25 session.  It is deliberately a thin transaction and
 * lease boundary around the pure Agent Kernel; it owns no Builtin, Model,
 * Prompt, Tool, or MCP semantics.
 */
export class State25RuntimeSession implements State25RuntimeSessionV1 {
  readonly sessionId: string;
  readonly #services: RuntimeHostExecutionServices<KernelEvent, AgentState>;
  readonly #defaults: State25RuntimeSessionDefaults;
  readonly #sandboxAvailable: () => boolean;
  readonly #verificationSchemaAdmissions?: State25RuntimeVerificationAdmissionV1;
  readonly #eventBatchPreprocessor?: State25RuntimeEventBatchPreprocessorV1;
  readonly #eventBatchAdmissionValidator?: State25RuntimeEventBatchAdmissionValidatorV1;
  readonly #toolTerminalBatchValidator?: State25RuntimeToolTerminalBatchValidatorV1;
  readonly #onNamedTurnSnapshot?: State25RuntimeSessionInputV1['onNamedTurnSnapshot'];
  readonly #isConcurrentEffectEventCurrent?: State25RuntimeConcurrentEffectEventCurrentV1;
  readonly #projectConcurrentEffectState?: State25RuntimeConcurrentEffectStateProjectorV1;
  readonly #isLateEffectResult?: State25RuntimeSessionInputV1['isLateEffectResult'];
  readonly #effectLeases = new Map<string, State25RuntimeSessionEffectLeaseV1>();
  #state: AgentState;
  #lastAppliedEvents: readonly KernelEvent[] = [];
  #lastProcessedEventId: string | undefined;
  #runnerId: string | null = null;

  constructor(input: State25RuntimeSessionInputV1) {
    assertState25RuntimeSessionStateV1(input.state);
    if (input.state.schemaVersion !== STATE25_RUNTIME_SESSION_FORMAT_V1.schemaVersion) {
      throw new Error('Runtime Host State25 session requires schema version 25.');
    }
    if (input.state.formatEpoch !== STATE25_RUNTIME_SESSION_FORMAT_V1.epoch) {
      throw new Error('Runtime Host State25 session requires the current compatibility epoch.');
    }
    if (input.state.session.threadId.length === 0) {
      throw new Error('Runtime Host State25 session requires a non-empty session identity.');
    }
    if (input.services.sessions === undefined || input.services.transactions === undefined) {
      throw new Error('Runtime Host State25 session requires the injected Store 4 services.');
    }
    if (typeof input.clock !== 'function' || typeof input.id !== 'function') {
      throw new Error('Runtime Host State25 session requires injected clock and id callbacks.');
    }
    this.#state = input.state;
    this.sessionId = input.state.session.threadId;
    this.#services = input.services;
    this.#defaults = {
      clock: input.clock,
      id: input.id,
    };
    this.#sandboxAvailable =
      typeof input.sandboxAvailable === 'function'
        ? input.sandboxAvailable
        : () => input.sandboxAvailable === true;
    this.#verificationSchemaAdmissions = input.verificationSchemaAdmissions;
    this.#eventBatchPreprocessor = input.eventBatchPreprocessor;
    this.#eventBatchAdmissionValidator = input.eventBatchAdmissionValidator;
    this.#toolTerminalBatchValidator = input.toolTerminalBatchValidator;
    this.#onNamedTurnSnapshot = input.onNamedTurnSnapshot;
    this.#isConcurrentEffectEventCurrent = input.isConcurrentEffectEventCurrent;
    this.#projectConcurrentEffectState = input.projectConcurrentEffectState;
    this.#isLateEffectResult = input.isLateEffectResult;
  }

  getState(): Readonly<AgentState> {
    return this.#state;
  }

  processEvent(event: KernelEvent): State25RuntimeProcessEventResultV1 {
    const occurredAt = this.#eventTimestamp();
    this.#lastProcessedEventId = undefined;
    const applied = this.processEventBatch([event], { occurredAt });
    if (!this.#lastProcessedEventId) {
      throw new Error('Runtime State25 session did not produce an event identity.');
    }
    return {
      status: applied.length === 0 ? 'duplicate' : 'applied',
      eventId: this.#lastProcessedEventId,
    };
  }

  processEventBatch(
    events: readonly KernelEvent[],
    options: State25RuntimeProcessEventBatchOptionsV1 = {},
  ): readonly KernelEvent[] {
    this.#lastProcessedEventId = undefined;
    if (events.length === 0) {
      this.#lastAppliedEvents = [];
      return [];
    }
    const preparedEvents = this.#preprocessEvents(events);
    if (preparedEvents.length === 0) {
      this.#lastAppliedEvents = [];
      return [];
    }
    const previousState = this.#state;
    assertState25RuntimeSessionStateV1(previousState);
    const facts = this.#decisionFacts(preparedEvents, previousState, options.occurredAt);
    const decision = decide(
      previousState,
      {
        source: options.source ?? 'host_fact',
        sessionId: this.sessionId,
        expectedRevision: previousState.revision,
        events: preparedEvents,
        ...(options.causationId ? { causationId: options.causationId } : {}),
      },
      facts,
    );
    if (decision.status === 'idempotent_replay') {
      this.#lastAppliedEvents = [];
      this.#lastProcessedEventId = this.#eventId(
        preparedEvents[0]!,
        previousState,
        facts.eventFacts[0]!.occurredAt,
      );
      return [];
    }
    if (decision.status === 'conflict') {
      this.#lastAppliedEvents = [];
      throw new Error(`Runtime State25 revision conflict at ${decision.currentRevision}.`);
    }
    if (decision.status === 'rejected') {
      this.#lastAppliedEvents = [];
      throw new Error(`Runtime State25 transition rejected: ${decision.code}.`);
    }
    assertAgentStateInvariants(decision.nextState);
    const metadata = decision.envelopes.map(
      (envelope): RuntimeEventMetadataV1 => ({
        eventId: envelope.eventId,
        revision: envelope.revision,
        ...(envelope.causationId ? { causationId: envelope.causationId } : {}),
        occurredAt: envelope.occurredAt,
      }),
    );
    const input: RuntimeTransactionInputV1<KernelEvent, AgentState> = {
      sessionId: this.sessionId,
      events: decision.events,
      snapshot: decision.nextState,
      metadata,
      expectedRestoreBoundary: this.#restoreBoundary(),
    };
    try {
      this.#services.transactions.commit(
        options.acknowledgement ?? 'decision',
        input,
        options.requiredEffectLease,
      );
    } catch (error) {
      this.#lastAppliedEvents = [];
      throw error;
    }
    // The durable transaction is the publication boundary. Never expose a
    // speculative reducer result to an executor or caller before this point.
    this.#state = decision.nextState;
    this.#lastAppliedEvents = [...decision.events];
    this.#lastProcessedEventId = decision.envelopes[0]?.eventId;
    const completedTurn = decision.events.find(
      (event): event is Extract<KernelEvent, { readonly type: 'turn.completed' }> =>
        event.type === 'turn.completed',
    );
    if (completedTurn && this.#onNamedTurnSnapshot) {
      const eventPosition = this.#services.sessions.getLastEventPosition(this.sessionId);
      this.#onNamedTurnSnapshot({
        sessionId: this.sessionId,
        turnId: completedTurn.turnId,
        state: this.#state,
        eventPosition,
      });
    }
    return this.#lastAppliedEvents;
  }

  getLastAppliedEvents(): readonly KernelEvent[] {
    return this.#lastAppliedEvents;
  }

  selectPendingEffects(
    state: Readonly<AgentState> = this.#state,
    facts?: SchedulerFactsV1,
  ): readonly RuntimeEffect[] {
    assertState25RuntimeSessionStateV1(state);
    return selectPendingEffects(state, facts);
  }

  acquireRunner(): string | null {
    if (this.#runnerId) return null;
    const runnerId = this.#nextId('state25_runner');
    this.#runnerId = runnerId;
    return runnerId;
  }

  releaseRunner(runnerId: string): void {
    if (this.#runnerId === runnerId) this.#runnerId = null;
  }

  beginEffect(effect: RuntimeEffect): State25RuntimeSessionEffectLeaseV1 {
    assertState25RuntimeSessionStateV1(this.#state);
    const effectId = this.#nextId('state25_effect');
    const lease: State25RuntimeSessionEffectLeaseV1 = {
      effectId,
      turnId: this.#state.turn.turnId,
      effect,
      expectedRevision: this.#state.revision,
    };
    this.#effectLeases.set(effectId, lease);
    return lease;
  }

  isEffectLeaseCurrent(lease: Readonly<State25RuntimeSessionEffectLeaseV1>): boolean {
    const owned = this.#effectLeases.get(lease.effectId);
    return Boolean(
      owned === lease &&
        lease.expectedRevision === this.#state.revision &&
        lease.turnId === this.#state.turn.turnId &&
        this.#effectLeases.has(lease.effectId),
    );
  }

  isEffectEventCurrent(
    lease: Readonly<State25RuntimeSessionEffectLeaseV1>,
    event: KernelEvent,
  ): boolean {
    if (this.isEffectLeaseCurrent(lease)) return true;
    return this.#concurrentEventsCurrent(lease, [event]);
  }

  applyResult(
    lease: State25RuntimeSessionEffectLeaseV1,
    events: readonly KernelEvent[],
    requiredEffectLease?: RuntimeLeaseRequirementV1,
  ): boolean {
    if (events.length === 0) return false;
    if (
      hasLateTerminalEventForCancelledToolV1(this.#state, lease, events) ||
      this.#isLateEffectResult?.(lease, events, this.#state)
    ) {
      return false;
    }
    if (requiredEffectLease && !this.#validRequiredLease(requiredEffectLease)) return false;
    const current = this.isEffectLeaseCurrent(lease);
    if (!current && !this.#concurrentEventsCurrent(lease, events)) return false;
    if (lease.effect.type === 'run_tools') {
      assertCapabilityToolTerminalBatchV1(this.#state, lease, events);
    }
    if (lease.effect.type === 'run_tools' && this.#toolTerminalBatchValidator) {
      const accepted = this.#toolTerminalBatchValidator(lease.effect, events, this.#state);
      if (accepted === false) throw new Error('Runtime Tool terminal batch was rejected.');
    }
    const applied = this.processEventBatch(events, {
      acknowledgement: 'receipt_evidence',
      ...(requiredEffectLease ? { requiredEffectLease } : {}),
      source: 'receipt',
    });
    if (applied.length === 0) return false;
    lease.expectedRevision = this.#state.revision;
    return true;
  }

  applyEvent(
    lease: State25RuntimeSessionEffectLeaseV1,
    event: KernelEvent,
    requiredEffectLease?: RuntimeLeaseRequirementV1,
  ): boolean {
    if (!this.isEffectEventCurrent(lease, event)) return false;
    const applied = this.processEventBatch([event], {
      acknowledgement: 'receipt_evidence',
      ...(requiredEffectLease ? { requiredEffectLease } : {}),
      source: 'receipt',
    });
    if (applied.length === 0) return false;
    lease.expectedRevision = this.#state.revision;
    return true;
  }

  applyEffectResult(
    lease: State25RuntimeSessionEffectLeaseV1,
    events: readonly KernelEvent[],
    requiredEffectLease?: RuntimeLeaseRequirementV1,
  ): boolean {
    return this.applyResult(lease, events, requiredEffectLease);
  }

  applyEffectEvents(
    lease: State25RuntimeSessionEffectLeaseV1,
    events: readonly KernelEvent[],
    acknowledgement: State25RuntimeEffectPersistenceAcknowledgementV1,
    requiredEffectLease?: RuntimeLeaseRequirementV1,
  ): boolean {
    if (events.length === 0 || !this.isEffectLeaseCurrent(lease)) return false;
    if (requiredEffectLease && !this.#validRequiredLease(requiredEffectLease)) return false;
    if (acknowledgement !== 'attempt_start' && lease.effect.type === 'run_tools') {
      if (
        hasLateTerminalEventForCancelledToolV1(this.#state, lease, events) ||
        this.#isLateEffectResult?.(lease, events, this.#state)
      ) {
        return false;
      }
      assertCapabilityToolTerminalBatchV1(this.#state, lease, events);
      if (this.#toolTerminalBatchValidator) {
        const accepted = this.#toolTerminalBatchValidator(lease.effect, events, this.#state);
        if (accepted === false) throw new Error('Runtime Tool terminal batch was rejected.');
      }
    }
    const applied = this.processEventBatch(events, {
      acknowledgement,
      ...(requiredEffectLease ? { requiredEffectLease } : {}),
      source: 'receipt',
    });
    if (applied.length === 0) return false;
    lease.expectedRevision = this.#state.revision;
    return true;
  }

  applyEffectEvent(
    lease: State25RuntimeSessionEffectLeaseV1,
    event: KernelEvent,
    requiredEffectLease?: RuntimeLeaseRequirementV1,
  ): boolean {
    return this.applyEvent(lease, event, requiredEffectLease);
  }

  applyLateResourceReconciliation(events: readonly KernelEvent[]): boolean {
    if (
      events.length === 0 ||
      this.#state.resourceBudget.status !== 'active' ||
      events.some((event) => event.type !== 'resource_budget.reconciled')
    ) {
      return false;
    }
    for (const event of events) {
      if (event.type !== 'resource_budget.reconciled') return false;
      const reservation = this.#state.resourceBudget.reservations[event.reservationId];
      if (
        !reservation ||
        (reservation.state !== 'dispatch_started' && reservation.state !== 'unknown')
      ) {
        return false;
      }
    }
    const applied = this.processEventBatch(events, {
      acknowledgement: 'receipt_evidence',
      source: 'receipt',
    });
    return applied.length === events.length;
  }

  releaseEffect(lease: Readonly<State25RuntimeSessionEffectLeaseV1>): void {
    const owned = this.#effectLeases.get(lease.effectId);
    if (owned !== lease) return;
    this.#effectLeases.delete(lease.effectId);
  }

  #preprocessEvents(events: readonly KernelEvent[]): readonly KernelEvent[] {
    const prepared = this.#eventBatchPreprocessor
      ? this.#eventBatchPreprocessor(events, this.#state)
      : events;
    const copied = [...prepared];
    const requirements = suspendedCapabilityTerminalRequirementsV1(this.#state, copied);
    const finishedAtByInvocationId: Record<string, string> = {};
    for (const requirement of requirements) {
      finishedAtByInvocationId[requirement.invocationId] = this.#eventTimestamp();
    }
    const withSuspendedTerminals = attachSuspendedCapabilityTerminalsV1(
      this.#state,
      copied,
      finishedAtByInvocationId,
    );
    const accepted = this.#eventBatchAdmissionValidator?.(withSuspendedTerminals, this.#state);
    if (accepted === false) throw new Error('Runtime State25 event batch admission was rejected.');
    return withSuspendedTerminals;
  }

  #decisionFacts(
    events: readonly KernelEvent[],
    state: Readonly<AgentState>,
    occurredAt?: string,
  ): DecisionFacts {
    const eventFacts = events.map((event, eventIndex) => {
      const admissions =
        event.type === 'verification.requested'
          ? this.#verificationSchemaAdmissions?.(event, {
              sessionId: this.sessionId,
              eventIndex,
              state,
            })
          : undefined;
      return {
        occurredAt: occurredAt ?? this.#eventTimestamp(),
        ...(admissions !== undefined ? { verificationSchemaAdmissions: [...admissions] } : {}),
      };
    });
    const allocatedIds: Record<string, string> = {};
    let activeTaskId = state.activeTaskId;
    for (const [eventIndex, event] of events.entries()) {
      if (event.type === 'task.started') activeTaskId = event.taskId;
      if (
        (event.type === 'task.completed' || event.type === 'task.cancelled') &&
        event.taskId === activeTaskId
      ) {
        activeTaskId = null;
      }
      if (event.type === 'user.message_appended' && activeTaskId === null) {
        const taskId = this.#nextId('task');
        allocatedIds[taskIdentityAllocationKeyV1(eventIndex, event.messageId)] = taskId;
        activeTaskId = taskId;
      }
    }
    return {
      schema: 'kite.kernel-decision-facts.v1',
      eventFacts,
      knownEventIds: [...state.appliedEventIds],
      allocatedIds,
      workspace: { root: state.session.workspace },
      policy: {
        interactionMode: getEffectiveInteractionMode(state),
        sandboxAvailable: this.#sandboxFact(),
      },
      provider: { semantics: 'rmv1-current' },
      protectedPath: { semantics: 'rmv1-current' },
      network: { semantics: 'rmv1-current' },
      executionBoundary: { semantics: 'rmv1-current' },
      attempt: { runnerId: this.#runnerId },
    };
  }

  #concurrentEventsCurrent(
    lease: Readonly<State25RuntimeSessionEffectLeaseV1>,
    events: readonly KernelEvent[],
  ): boolean {
    if (!this.#isConcurrentEffectEventCurrent) {
      if (lease.effect.type !== 'run_tools') return false;
      try {
        return isConcurrentShellEffectBatchCurrentV1(this.#state, lease, events, () =>
          this.#eventTimestamp(),
        );
      } catch {
        return false;
      }
    }
    let projected = this.#state;
    for (const event of events) {
      try {
        if (!this.#isConcurrentEffectEventCurrent(lease, event, projected)) return false;
        projected = this.#projectConcurrentEffectState
          ? this.#projectConcurrentEffectState(projected, event)
          : reduce(projected, [event]);
        assertAgentStateInvariants(projected);
      } catch {
        return false;
      }
    }
    return true;
  }

  #validRequiredLease(required: RuntimeLeaseRequirementV1): boolean {
    return (
      typeof required.sessionId === 'string' &&
      required.sessionId === this.sessionId &&
      typeof required.effectId === 'string' &&
      required.effectId.length > 0 &&
      typeof required.ownerId === 'string' &&
      required.ownerId.length > 0
    );
  }

  #restoreBoundary(): RuntimeRestoreBoundaryV1 {
    const record = this.#services.sessions.loadSnapshotRecord<AgentState>(this.sessionId);
    return {
      snapshot: record?.metadata ?? null,
      lastEventPosition: this.#services.sessions.getLastEventPosition(this.sessionId),
    };
  }

  #eventTimestamp(): string {
    const value = this.#defaults.clock();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) {
      throw new Error('Runtime Host clock returned an invalid State25 timestamp.');
    }
    return value;
  }

  #sandboxFact(): boolean {
    const value = this.#sandboxAvailable();
    if (typeof value !== 'boolean') {
      throw new Error('Runtime Host sandbox fact is invalid.');
    }
    return value;
  }

  #nextId(kind: string): string {
    const value = this.#defaults.id(kind);
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`Runtime Host id source returned an invalid ${kind} identity.`);
    }
    return value;
  }

  #eventId(event: KernelEvent, state: Readonly<AgentState>, occurredAt: string): string {
    return digestAgentEvent(
      finalizeAgentEvent(normalizeAgentEvent(event, state, occurredAt), occurredAt),
    );
  }
}

export function createRuntimeHostState25SessionV1(
  input: State25RuntimeSessionInputV1,
): State25RuntimeSessionV1 {
  return new State25RuntimeSession(input);
}
