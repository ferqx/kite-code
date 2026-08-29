import {
  type AgentState,
  assertAgentStateInvariants,
  assertCapabilityToolTerminalBatch,
  attachSuspendedCapabilityTerminals,
  type DecisionFacts,
  decide,
  digestAgentEvent,
  finalizeAgentEvent,
  getEffectiveInteractionMode,
  hasLateTerminalEventForCancelledTool,
  isConcurrentShellEffectBatchCurrent,
  type KernelEvent,
  normalizeAgentEvent,
  RUNTIME_STATE_FORMAT_EPOCH,
  RUNTIME_STATE_SCHEMA_VERSION,
  type RuntimeEffect,
  reduce,
  type SchedulerFacts,
  selectPendingEffects,
  suspendedCapabilityTerminalRequirements,
  taskIdentityAllocationKey,
  type VerificationSchemaAdmissionFact,
} from '@kite-ai/agent-kernel';
import type {
  RuntimeHostExecutionServices,
  RuntimeLeaseRequirement,
  RuntimeTransactionAcknowledgement,
} from '../lifecycle/effect-supervisor';
import type {
  RuntimeCommandCommitEvidence,
  RuntimeEventMetadata,
  RuntimeRestoreBoundary,
  RuntimeRunStatus,
  RuntimeRunTransactionMutation,
  RuntimeStoredCommandReceipt,
  RuntimeStoredCommandResourceResult,
  RuntimeStoredRun,
  RuntimeTransactionInput,
} from '../storage';
import { createRuntimeRunStartResourceResult, createRuntimeStoredCommandReceipt } from '../storage';
import type {
  StateRuntimeEffectLease as BaseStateRuntimeEffectLease,
  StateRuntimeEffectPersistenceAcknowledgement,
} from './effect-runtime';

/** The one current State / Store format accepted by this Host session. */
export const STATE_RUNTIME_SESSION_FORMAT_ = Object.freeze({
  schemaVersion: RUNTIME_STATE_SCHEMA_VERSION,
  storeVersion: 5 as const,
  epoch: RUNTIME_STATE_FORMAT_EPOCH,
});

export type StateRuntimeSessionClock = () => string;
export type StateRuntimeSessionIdSource = (kind: string) => string;

export type StateRuntimeSessionEffectLease = BaseStateRuntimeEffectLease;

export interface StateRuntimeSessionEventContext {
  readonly sessionId: string;
  readonly eventIndex: number;
  readonly state: Readonly<AgentState>;
}

export type StateRuntimeVerificationAdmission = (
  event: KernelEvent,
  context: StateRuntimeSessionEventContext,
) => readonly (VerificationSchemaAdmissionFact | null)[] | undefined;

export type StateRuntimeEventBatchPreprocessor = (
  events: readonly KernelEvent[],
  state: Readonly<AgentState>,
) => readonly KernelEvent[];

export type StateRuntimeEventBatchAdmissionValidator = (
  events: readonly KernelEvent[],
  state: Readonly<AgentState>,
) => undefined | boolean;

export type StateRuntimeToolTerminalBatchValidator = (
  effect: Extract<RuntimeEffect, { readonly type: 'run_tools' }>,
  events: readonly KernelEvent[],
  state: Readonly<AgentState>,
) => undefined | boolean;

export interface StateRuntimeNamedTurnSnapshotInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly state: Readonly<AgentState>;
  readonly eventPosition: number;
}

/**
 * The only Host seam for a concurrent effect that is allowed to survive an
 * unrelated State 27 revision.  The callback owns the domain-specific
 * predicate (for example, a shell sibling predicate); Host never inspects a
 * tool name or a model operation.
 */
export type StateRuntimeConcurrentEffectEventCurrent = (
  lease: Readonly<StateRuntimeSessionEffectLease>,
  event: KernelEvent,
  state: Readonly<AgentState>,
) => boolean;

/**
 * Optional pure projection paired with the concurrent-event predicate.  When
 * omitted, the Kernel reducer is used for the transient validation projection.
 * It is never persisted and never becomes a second reducer authority.
 */
export type StateRuntimeConcurrentEffectStateProjector = (
  state: Readonly<AgentState>,
  event: KernelEvent,
) => AgentState;

export interface StateRuntimeSessionInput {
  readonly state: AgentState;
  readonly services: RuntimeHostExecutionServices<KernelEvent, AgentState>;
  readonly clock: StateRuntimeSessionClock;
  readonly id: StateRuntimeSessionIdSource;
  readonly sandboxAvailable?: boolean | (() => boolean);
  readonly verificationSchemaAdmissions?: StateRuntimeVerificationAdmission;
  readonly eventBatchPreprocessor?: StateRuntimeEventBatchPreprocessor;
  readonly eventBatchAdmissionValidator?: StateRuntimeEventBatchAdmissionValidator;
  readonly toolTerminalBatchValidator?: StateRuntimeToolTerminalBatchValidator;
  readonly onNamedTurnSnapshot?: (input: StateRuntimeNamedTurnSnapshotInput) => void;
  readonly isConcurrentEffectEventCurrent?: StateRuntimeConcurrentEffectEventCurrent;
  readonly projectConcurrentEffectState?: StateRuntimeConcurrentEffectStateProjector;
  /** Reject a late result which has become terminal for a cancelled owner. */
  readonly isLateEffectResult?: (
    lease: Readonly<StateRuntimeSessionEffectLease>,
    events: readonly KernelEvent[],
    state: Readonly<AgentState>,
  ) => boolean;
}

export interface StateRuntimeProcessEventResult {
  readonly status: 'applied' | 'duplicate';
  readonly eventId: string;
}

export interface StateRuntimeProcessEventBatchOptions {
  readonly acknowledgement?: RuntimeTransactionAcknowledgement;
  readonly requiredEffectLease?: RuntimeLeaseRequirement;
  readonly causationId?: string;
  readonly source?: 'command' | 'receipt' | 'host_fact';
  /** Single-event clock binding used by processEvent. */
  readonly occurredAt?: string;
}

export interface StateRuntimeCommandCommitResult {
  readonly receipt: RuntimeStoredCommandReceipt;
  readonly events: readonly KernelEvent[];
}

export interface StateRuntimeSession {
  readonly sessionId: string;
  getState(): Readonly<AgentState>;
  /** True only when the injected storage owner has passed Store 8 preflight. */
  supportsRunStorage(): boolean;
  /** Row-only post-commit activation; Store 6/7 remain an explicit no-op. */
  activateRun(runId: string): void;
  processEvent(event: KernelEvent): StateRuntimeProcessEventResult;
  processEventBatch(
    events: readonly KernelEvent[],
    options?: StateRuntimeProcessEventBatchOptions,
  ): readonly KernelEvent[];
  /**
   * Commits an accepted command's exact State decision and applied receipt in
   * one Store transaction. This is intentionally separate from effect and
   * ordinary event paths.
   */
  commitCommandBatch(
    events: readonly KernelEvent[],
    evidence: RuntimeCommandCommitEvidence,
  ): StateRuntimeCommandCommitResult;
  /**
   * Commits a command receipt against the exact current snapshot without
   * inventing a Kernel event or advancing State revision. This is reserved
   * for accepted lifecycle decisions such as create/resume/idle close.
   */
  commitCommandSnapshot(evidence: RuntimeCommandCommitEvidence): RuntimeStoredCommandReceipt;
  /**
   * Commit one same-command release as a single Store transaction. The event
   * contains the complete snapshot match and per-invocation receipts; callers
   * may not emulate this by looping approval.granted events.
   */
  commitApprovalBatch(
    event: Extract<KernelEvent, { readonly type: 'approval.batch_released' }>,
    expectedRevision: number,
  ): StateRuntimeProcessEventResult;
  getLastAppliedEvents(): readonly KernelEvent[];
  selectPendingEffects(
    state?: Readonly<AgentState>,
    facts?: SchedulerFacts,
  ): readonly RuntimeEffect[];
  acquireRunner(): string | null;
  releaseRunner(runnerId: string): void;
  beginEffect(effect: RuntimeEffect): StateRuntimeSessionEffectLease;
  isEffectLeaseCurrent(lease: Readonly<StateRuntimeSessionEffectLease>): boolean;
  isEffectEventCurrent(
    lease: Readonly<StateRuntimeSessionEffectLease>,
    event: KernelEvent,
  ): boolean;
  applyResult(
    lease: StateRuntimeSessionEffectLease,
    events: readonly KernelEvent[],
    requiredEffectLease?: RuntimeLeaseRequirement,
  ): boolean;
  applyEffectResult(
    lease: StateRuntimeSessionEffectLease,
    events: readonly KernelEvent[],
    requiredEffectLease?: RuntimeLeaseRequirement,
  ): boolean;
  /**
   * Apply a durable effect batch through one explicit Store 4 acknowledgement
   * channel.  This method requires the exact in-process effect lease; stale
   * callers fail closed and cannot publish through a successor attempt.
   */
  applyEffectEvents(
    lease: StateRuntimeSessionEffectLease,
    events: readonly KernelEvent[],
    acknowledgement: StateRuntimeEffectPersistenceAcknowledgement,
    requiredEffectLease?: RuntimeLeaseRequirement,
  ): boolean;
  applyEvent(
    lease: StateRuntimeSessionEffectLease,
    event: KernelEvent,
    requiredEffectLease?: RuntimeLeaseRequirement,
  ): boolean;
  applyEffectEvent(
    lease: StateRuntimeSessionEffectLease,
    event: KernelEvent,
    requiredEffectLease?: RuntimeLeaseRequirement,
  ): boolean;
  applyLateResourceReconciliation(events: readonly KernelEvent[]): boolean;
  releaseEffect(lease: Readonly<StateRuntimeSessionEffectLease>): void;
}

interface StateRuntimeSessionDefaults {
  readonly clock: StateRuntimeSessionClock;
  readonly id: StateRuntimeSessionIdSource;
}

function assertStateRuntimeSessionState(state: AgentState): void {
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
 * Host-owned State 27 session.  It is deliberately a thin transaction and
 * lease boundary around the pure Agent Kernel; it owns no Builtin, Model,
 * Prompt, Tool, or MCP semantics.
 */
class StateRuntimeSessionImpl implements StateRuntimeSession {
  readonly sessionId: string;
  readonly #services: RuntimeHostExecutionServices<KernelEvent, AgentState>;
  readonly #defaults: StateRuntimeSessionDefaults;
  readonly #sandboxAvailable: () => boolean;
  readonly #verificationSchemaAdmissions?: StateRuntimeVerificationAdmission;
  readonly #eventBatchPreprocessor?: StateRuntimeEventBatchPreprocessor;
  readonly #eventBatchAdmissionValidator?: StateRuntimeEventBatchAdmissionValidator;
  readonly #toolTerminalBatchValidator?: StateRuntimeToolTerminalBatchValidator;
  readonly #onNamedTurnSnapshot?: StateRuntimeSessionInput['onNamedTurnSnapshot'];
  readonly #isConcurrentEffectEventCurrent?: StateRuntimeConcurrentEffectEventCurrent;
  readonly #projectConcurrentEffectState?: StateRuntimeConcurrentEffectStateProjector;
  readonly #isLateEffectResult?: StateRuntimeSessionInput['isLateEffectResult'];
  readonly #effectLeases = new Map<string, StateRuntimeSessionEffectLease>();
  #state: AgentState;
  #lastAppliedEvents: readonly KernelEvent[] = [];
  #lastProcessedEventId: string | undefined;
  #runnerId: string | null = null;

  constructor(input: StateRuntimeSessionInput) {
    assertStateRuntimeSessionState(input.state);
    if (input.state.schemaVersion !== STATE_RUNTIME_SESSION_FORMAT_.schemaVersion) {
      throw new Error(
        `Runtime Host State session requires schema version ${STATE_RUNTIME_SESSION_FORMAT_.schemaVersion}.`,
      );
    }
    if (input.state.formatEpoch !== STATE_RUNTIME_SESSION_FORMAT_.epoch) {
      throw new Error('Runtime Host State session requires the current compatibility epoch.');
    }
    if (input.state.session.threadId.length === 0) {
      throw new Error('Runtime Host State session requires a non-empty session identity.');
    }
    if (input.services.sessions === undefined || input.services.transactions === undefined) {
      throw new Error('Runtime Host State session requires the injected Store services.');
    }
    if (typeof input.clock !== 'function' || typeof input.id !== 'function') {
      throw new Error('Runtime Host State session requires injected clock and id callbacks.');
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

  supportsRunStorage(): boolean {
    return this.#services.runs !== undefined;
  }

  activateRun(runId: string): void {
    const runs = this.#services.runs;
    if (!runs) return;
    const current = runs.get(this.sessionId, runId);
    if (!current) throw new Error(`Runtime Run activation target is missing: ${runId}.`);
    if (current.status !== 'queued') {
      if (current.status === 'running') return;
      throw new Error(`Runtime Run activation target is ${current.status}: ${runId}.`);
    }
    const startedAtMs = Math.max(current.createdAtMs, this.#clockMilliseconds());
    const result = runs.transition({
      sessionId: this.sessionId,
      runId,
      expectedLastRevision: current.lastRevision,
      next: Object.freeze({
        ...current,
        status: 'running',
        startedAtMs,
      }),
    });
    if (result !== 'applied') {
      throw new Error(`Runtime Run activation was not applied: ${result}.`);
    }
  }

  processEvent(event: KernelEvent): StateRuntimeProcessEventResult {
    const occurredAt = this.#eventTimestamp();
    this.#lastProcessedEventId = undefined;
    const applied = this.processEventBatch([event], { occurredAt });
    if (!this.#lastProcessedEventId) {
      throw new Error('Runtime State session did not produce an event identity.');
    }
    return {
      status: applied.length === 0 ? 'duplicate' : 'applied',
      eventId: this.#lastProcessedEventId,
    };
  }

  processEventBatch(
    events: readonly KernelEvent[],
    options: StateRuntimeProcessEventBatchOptions = {},
  ): readonly KernelEvent[] {
    return this.#processEventBatch(events, options).events;
  }

  commitCommandBatch(
    events: readonly KernelEvent[],
    evidence: RuntimeCommandCommitEvidence,
  ): StateRuntimeCommandCommitResult {
    if (evidence.targetSessionId !== this.sessionId) {
      throw new Error('Runtime command receipt target does not match State session.');
    }
    const committed = this.#processEventBatch(events, { source: 'command' }, evidence);
    if (!committed.receipt) {
      throw new Error('Runtime command did not produce an applied State decision.');
    }
    return Object.freeze({ receipt: committed.receipt, events: committed.events });
  }

  commitCommandSnapshot(evidence: RuntimeCommandCommitEvidence): RuntimeStoredCommandReceipt {
    if (evidence.targetSessionId !== this.sessionId) {
      throw new Error('Runtime command receipt target does not match State session.');
    }
    assertStateRuntimeSessionState(this.#state);
    const receipt = createRuntimeStoredCommandReceipt(evidence, this.#state.revision);
    const input: RuntimeTransactionInput<KernelEvent, AgentState> = {
      sessionId: this.sessionId,
      events: [],
      snapshot: this.#state,
      metadata: [],
      expectedRestoreBoundary: this.#restoreBoundary(),
      commandReceipt: receipt,
    };
    this.#lastAppliedEvents = [];
    this.#lastProcessedEventId = undefined;
    this.#services.transactions.commitCommandDecision(input);
    return receipt;
  }

  #processEventBatch(
    events: readonly KernelEvent[],
    options: StateRuntimeProcessEventBatchOptions,
    commandEvidence?: RuntimeCommandCommitEvidence,
  ): { readonly events: readonly KernelEvent[]; readonly receipt?: RuntimeStoredCommandReceipt } {
    this.#lastProcessedEventId = undefined;
    if (events.length === 0) {
      this.#lastAppliedEvents = [];
      return { events: [] };
    }
    const preparedEvents = this.#preprocessEvents(events);
    if (preparedEvents.length === 0) {
      this.#lastAppliedEvents = [];
      return { events: [] };
    }
    const previousState = this.#state;
    assertStateRuntimeSessionState(previousState);
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
      return { events: [] };
    }
    if (decision.status === 'conflict') {
      this.#lastAppliedEvents = [];
      throw new Error(`Runtime State revision conflict at ${decision.currentRevision}.`);
    }
    if (decision.status === 'rejected') {
      this.#lastAppliedEvents = [];
      throw new Error(`Runtime State transition rejected: ${decision.code}.`);
    }
    assertAgentStateInvariants(decision.nextState);
    const metadata = decision.envelopes.map(
      (envelope): RuntimeEventMetadata => ({
        eventId: envelope.eventId,
        revision: envelope.revision,
        ...(envelope.causationId ? { causationId: envelope.causationId } : {}),
        occurredAt: envelope.occurredAt,
      }),
    );
    const runCommit = this.#runCommitForDecision(
      previousState,
      decision.nextState,
      metadata,
      commandEvidence,
    );
    const receiptEvidence =
      commandEvidence && runCommit?.resourceResult
        ? Object.freeze({ ...commandEvidence, resourceResult: runCommit.resourceResult })
        : commandEvidence;
    const receipt = receiptEvidence
      ? createRuntimeStoredCommandReceipt(receiptEvidence, decision.nextState.revision)
      : undefined;
    const input: RuntimeTransactionInput<KernelEvent, AgentState> = {
      sessionId: this.sessionId,
      events: decision.events,
      snapshot: decision.nextState,
      metadata,
      expectedRestoreBoundary: this.#restoreBoundary(),
      ...(receipt ? { commandReceipt: receipt } : {}),
      ...(runCommit ? { runMutation: runCommit.mutation } : {}),
    };
    try {
      if (receipt) this.#services.transactions.commitCommandDecision(input);
      else {
        this.#services.transactions.commit(
          options.acknowledgement ?? 'decision',
          input,
          options.requiredEffectLease,
        );
      }
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
    return { events: this.#lastAppliedEvents, ...(receipt ? { receipt } : {}) };
  }

  commitApprovalBatch(
    event: Extract<KernelEvent, { readonly type: 'approval.batch_released' }>,
    expectedRevision: number,
  ): StateRuntimeProcessEventResult {
    if (
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      event.sessionRevision !== expectedRevision ||
      this.#state.revision !== expectedRevision
    ) {
      throw new Error(`Runtime approval batch revision conflict at ${this.#state.revision}.`);
    }
    return this.processEvent(event);
  }

  getLastAppliedEvents(): readonly KernelEvent[] {
    return this.#lastAppliedEvents;
  }

  selectPendingEffects(
    state: Readonly<AgentState> = this.#state,
    facts?: SchedulerFacts,
  ): readonly RuntimeEffect[] {
    assertStateRuntimeSessionState(state);
    return selectPendingEffects(state, facts);
  }

  acquireRunner(): string | null {
    if (this.#runnerId) return null;
    const runnerId = this.#nextId('state_runner');
    this.#runnerId = runnerId;
    return runnerId;
  }

  releaseRunner(runnerId: string): void {
    if (this.#runnerId === runnerId) this.#runnerId = null;
  }

  beginEffect(effect: RuntimeEffect): StateRuntimeSessionEffectLease {
    assertStateRuntimeSessionState(this.#state);
    const effectId = this.#nextId('state_effect');
    const lease: StateRuntimeSessionEffectLease = {
      effectId,
      turnId: this.#state.turn.turnId,
      effect,
      expectedRevision: this.#state.revision,
    };
    this.#effectLeases.set(effectId, lease);
    return lease;
  }

  isEffectLeaseCurrent(lease: Readonly<StateRuntimeSessionEffectLease>): boolean {
    const owned = this.#effectLeases.get(lease.effectId);
    return Boolean(
      owned === lease &&
        lease.expectedRevision === this.#state.revision &&
        lease.turnId === this.#state.turn.turnId &&
        this.#effectLeases.has(lease.effectId),
    );
  }

  isEffectEventCurrent(
    lease: Readonly<StateRuntimeSessionEffectLease>,
    event: KernelEvent,
  ): boolean {
    if (this.isEffectLeaseCurrent(lease)) return true;
    return this.#concurrentEventsCurrent(lease, [event]);
  }

  applyResult(
    lease: StateRuntimeSessionEffectLease,
    events: readonly KernelEvent[],
    requiredEffectLease?: RuntimeLeaseRequirement,
  ): boolean {
    if (events.length === 0) return false;
    if (
      hasLateTerminalEventForCancelledTool(this.#state, lease, events) ||
      this.#isLateEffectResult?.(lease, events, this.#state)
    ) {
      return false;
    }
    if (requiredEffectLease && !this.#validRequiredLease(requiredEffectLease)) return false;
    const current = this.isEffectLeaseCurrent(lease);
    if (!current && !this.#concurrentEventsCurrent(lease, events)) return false;
    if (lease.effect.type === 'run_tools') {
      assertCapabilityToolTerminalBatch(this.#state, lease, events);
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
    lease: StateRuntimeSessionEffectLease,
    event: KernelEvent,
    requiredEffectLease?: RuntimeLeaseRequirement,
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
    lease: StateRuntimeSessionEffectLease,
    events: readonly KernelEvent[],
    requiredEffectLease?: RuntimeLeaseRequirement,
  ): boolean {
    return this.applyResult(lease, events, requiredEffectLease);
  }

  applyEffectEvents(
    lease: StateRuntimeSessionEffectLease,
    events: readonly KernelEvent[],
    acknowledgement: StateRuntimeEffectPersistenceAcknowledgement,
    requiredEffectLease?: RuntimeLeaseRequirement,
  ): boolean {
    if (events.length === 0 || !this.isEffectLeaseCurrent(lease)) return false;
    if (requiredEffectLease && !this.#validRequiredLease(requiredEffectLease)) return false;
    if (acknowledgement !== 'attempt_start' && lease.effect.type === 'run_tools') {
      if (
        hasLateTerminalEventForCancelledTool(this.#state, lease, events) ||
        this.#isLateEffectResult?.(lease, events, this.#state)
      ) {
        return false;
      }
      assertCapabilityToolTerminalBatch(this.#state, lease, events);
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
    lease: StateRuntimeSessionEffectLease,
    event: KernelEvent,
    requiredEffectLease?: RuntimeLeaseRequirement,
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

  releaseEffect(lease: Readonly<StateRuntimeSessionEffectLease>): void {
    const owned = this.#effectLeases.get(lease.effectId);
    if (owned !== lease) return;
    this.#effectLeases.delete(lease.effectId);
  }

  #preprocessEvents(events: readonly KernelEvent[]): readonly KernelEvent[] {
    const prepared = this.#eventBatchPreprocessor
      ? this.#eventBatchPreprocessor(events, this.#state)
      : events;
    const copied = [...prepared];
    const requirements = suspendedCapabilityTerminalRequirements(this.#state, copied);
    const finishedAtByInvocationId: Record<string, string> = {};
    for (const requirement of requirements) {
      finishedAtByInvocationId[requirement.invocationId] = this.#eventTimestamp();
    }
    const withSuspendedTerminals = attachSuspendedCapabilityTerminals(
      this.#state,
      copied,
      finishedAtByInvocationId,
    );
    const accepted = this.#eventBatchAdmissionValidator?.(withSuspendedTerminals, this.#state);
    if (accepted === false) throw new Error('Runtime State event batch admission was rejected.');
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
        allocatedIds[taskIdentityAllocationKey(eventIndex, event.messageId)] = taskId;
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
      provider: { semantics: 'current' },
      protectedPath: { semantics: 'current' },
      network: { semantics: 'current' },
      executionBoundary: { semantics: 'current' },
      attempt: { runnerId: this.#runnerId },
    };
  }

  #concurrentEventsCurrent(
    lease: Readonly<StateRuntimeSessionEffectLease>,
    events: readonly KernelEvent[],
  ): boolean {
    if (!this.#isConcurrentEffectEventCurrent) {
      if (lease.effect.type !== 'run_tools') return false;
      try {
        return isConcurrentShellEffectBatchCurrent(this.#state, lease, events, () =>
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

  #validRequiredLease(required: RuntimeLeaseRequirement): boolean {
    return (
      typeof required.sessionId === 'string' &&
      required.sessionId === this.sessionId &&
      typeof required.effectId === 'string' &&
      required.effectId.length > 0 &&
      typeof required.ownerId === 'string' &&
      required.ownerId.length > 0
    );
  }

  #restoreBoundary(): RuntimeRestoreBoundary {
    const record = this.#services.sessions.loadSnapshotRecord<AgentState>(this.sessionId);
    return {
      snapshot: record?.metadata ?? null,
      lastEventPosition: this.#services.sessions.getLastEventPosition(this.sessionId),
    };
  }

  #runCommitForDecision(
    previousState: Readonly<AgentState>,
    nextState: Readonly<AgentState>,
    metadata: readonly RuntimeEventMetadata[],
    commandEvidence?: RuntimeCommandCommitEvidence,
  ):
    | {
        readonly mutation: RuntimeRunTransactionMutation;
        readonly resourceResult?: RuntimeStoredCommandResourceResult;
      }
    | undefined {
    const runStart = commandEvidence?.runStart;
    if (runStart) {
      if (!this.#services.runs) {
        throw new Error('Runtime start Run evidence requires Store 8 authority.');
      }
      if (commandEvidence.resourceResult !== undefined) {
        throw new Error('Runtime start Run resource result is Host-owned.');
      }
      if (
        nextState.turn.turnId !== runStart.runId ||
        nextState.turn.status !== 'active' ||
        nextState.revision <= previousState.revision
      ) {
        throw new Error('Runtime start Run evidence does not match the accepted State decision.');
      }
      const run: RuntimeStoredRun = Object.freeze({
        sessionId: this.sessionId,
        runId: runStart.runId,
        startCommandId: commandEvidence.commandId,
        phase: runStart.phase,
        status: 'queued',
        createdRevision: nextState.revision,
        lastRevision: nextState.revision,
        createdAtMs: timestampMilliseconds(metadata.at(-1)?.occurredAt),
      });
      return Object.freeze({
        mutation: Object.freeze({ type: 'insert', run }),
        resourceResult: createRuntimeRunStartResourceResult(run),
      });
    }

    const runs = this.#services.runs;
    const runId = previousState.turn.turnId;
    if (!runs || !runId) return undefined;
    const current = runs.get(this.sessionId, runId);
    if (!current || isTerminalRunStatus(current.status)) return undefined;
    const status = projectRunStatus(previousState, nextState, current.status);
    if (!status || status === current.status) return undefined;
    const occurredAtMs = Math.max(
      current.startedAtMs ?? current.createdAtMs,
      timestampMilliseconds(metadata.at(-1)?.occurredAt),
    );
    const terminal = isTerminalRunStatus(status);
    const next: RuntimeStoredRun = Object.freeze({
      ...current,
      status,
      lastRevision: nextState.revision,
      ...(terminal ? { finishedAtMs: occurredAtMs } : {}),
      ...(terminal
        ? {
            terminal: projectRunTerminal(nextState, status),
          }
        : {}),
    });
    return Object.freeze({
      mutation: Object.freeze({
        type: 'transition',
        transition: Object.freeze({
          sessionId: this.sessionId,
          runId,
          expectedLastRevision: current.lastRevision,
          next,
        }),
      }),
    });
  }

  #eventTimestamp(): string {
    const value = this.#defaults.clock();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) {
      throw new Error('Runtime Host clock returned an invalid State timestamp.');
    }
    return value;
  }

  #clockMilliseconds(): number {
    return timestampMilliseconds(this.#eventTimestamp());
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

function projectRunStatus(
  previousState: Readonly<AgentState>,
  nextState: Readonly<AgentState>,
  current: RuntimeRunStatus,
): RuntimeRunStatus | undefined {
  if (nextState.turn.status === 'completed') return 'completed';
  if (nextState.turn.status === 'aborted') {
    if (nextState.terminalOutcome?.status === 'unknown') return 'unknown';
    return nextState.turn.abortCause === 'user' ? 'cancelled' : 'failed';
  }
  if (nextState.turn.status !== 'active') return undefined;
  if (nextState.interactions.kind !== 'idle') return 'waiting';
  if (current === 'waiting' && previousState.interactions.kind !== 'idle') return 'running';
  return undefined;
}

function projectRunTerminal(
  state: Readonly<AgentState>,
  status: RuntimeRunStatus,
): NonNullable<RuntimeStoredRun['terminal']> {
  const outcome = state.terminalOutcome;
  if (outcome) {
    return Object.freeze({
      reasonCode: outcome.reasonCode,
      safeRetry: outcome.safeRetry,
      recoveryEntry: outcome.recoveryEntry,
    });
  }
  switch (status) {
    case 'completed':
      return Object.freeze({ reasonCode: 'completed', safeRetry: false, recoveryEntry: 'none' });
    case 'cancelled':
      return Object.freeze({
        reasonCode: 'cancelled',
        safeRetry: false,
        recoveryEntry: 'new_run',
      });
    case 'unknown':
      return Object.freeze({
        reasonCode: 'unknown',
        safeRetry: false,
        recoveryEntry: 'reconcile',
      });
    default:
      return Object.freeze({
        reasonCode: 'runtime_failed',
        safeRetry: false,
        recoveryEntry: 'new_run',
      });
  }
}

function isTerminalRunStatus(status: RuntimeRunStatus): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'unknown'
  );
}

function timestampMilliseconds(value: string | undefined): number {
  if (value === undefined) throw new Error('Runtime Run transition requires event commit time.');
  const milliseconds = Date.parse(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new Error('Runtime Run transition timestamp is invalid.');
  }
  return milliseconds;
}

export function createRuntimeHostStateSession(
  input: StateRuntimeSessionInput,
): StateRuntimeSession {
  return new StateRuntimeSessionImpl(input);
}
