import type {
  StateRuntimeEffect as RuntimeEffect,
  StateRuntimeSchedulerFacts as SchedulerFacts,
} from '@kite-ai/runtime-host';
import {
  DescendantResourceAdmissionError,
  runtimeHostStateDecideCompletion as decideCompletion,
  type StateRuntimeEffectExecutor as HostStateRuntimeEffectExecutor,
  isRuntimeHostStateToolRecoveryInvalid,
  isStateRuntimeEffectDeferred,
  planRuntimeBudgetAdmission,
  reconciliationEventsForReservations,
  type StateRuntimeEffectLease,
  type StateRuntimeEffectPersistenceAcknowledgement,
} from '@kite-ai/runtime-host/kernel-adapter';
import type {
  RuntimeCommandCommitEvidence,
  RuntimeEffectLeaseExpectation,
} from '@kite-ai/runtime-host/storage';
import {
  assertPrecommittedInteractionAction,
  type CommittedInteractionCommand,
  isPrecommittedInteractionAction,
  type PrecommittedInteractionActionDescriptor,
  type RuntimeInteractionCommandCommitInput,
} from './command-interaction-decision';
import { classifyFailure } from './failures';
import { resourceAdmissionTerminalEvents } from './resource-admission-terminal';
import {
  approvalRejectionSettlementEvents,
  deferredApprovalRejectionTurnAbortEvent,
  type RuntimeActionResult,
  type RuntimeUserAction,
} from './state-actions';
import type { RuntimeEvent, RuntimeState } from './state-runtime';
import { completedTerminalOutcome, failedTerminalOutcome } from './terminal-outcome';

type RuntimeEffectExecutor = HostStateRuntimeEffectExecutor<
  RuntimeState,
  RuntimeEvent,
  RuntimeEffect
>;

/**
 * Transitional State runner port. Production is backed by the one Host
 * session; Core's historical AgentKernel only remains a test migration source.
 */
export interface RuntimeStateSessionPort {
  getState(): Readonly<RuntimeState>;
  processEvent(event: RuntimeEvent): { status: 'applied' | 'duplicate'; eventId: string };
  processEventBatch(events: RuntimeEvent[]): readonly RuntimeEvent[];
  getLastAppliedEvents(): readonly RuntimeEvent[];
  selectPendingEffects(
    state?: Readonly<RuntimeState>,
    facts?: SchedulerFacts,
  ): readonly RuntimeEffect[];
  acquireRunner(): string | null;
  releaseRunner(runnerId: string): void;
  beginEffect(effect: RuntimeEffect): StateRuntimeEffectLease;
  isEffectEventCurrent(lease: StateRuntimeEffectLease, event: RuntimeEvent): boolean;
  applyEffectEvent(lease: StateRuntimeEffectLease, event: RuntimeEvent): boolean;
  applyEffectResult(
    lease: StateRuntimeEffectLease,
    events: RuntimeEvent[],
    requiredEffectLease?: RuntimeEffectLeaseExpectation,
  ): boolean;
  /** Explicit Store 4 acknowledgement route; absent legacy ports can only
   * retain the receipt_evidence compatibility path below. */
  applyEffectEvents?(
    lease: StateRuntimeEffectLease,
    events: RuntimeEvent[],
    acknowledgement: StateRuntimeEffectPersistenceAcknowledgement,
    requiredEffectLease?: RuntimeEffectLeaseExpectation,
  ): boolean;
  applyLateResourceReconciliation(events: readonly RuntimeEvent[]): boolean;
  applyAction(action: RuntimeUserAction, additionalEvents?: RuntimeEvent[]): RuntimeActionResult;
  getSandboxAvailable?(): boolean;
  /** Absent only in legacy test harnesses; command settlement fails closed there. */
  commitInteractionCommand?(
    input: RuntimeInteractionCommandCommitInput,
  ): CommittedInteractionCommand;
  /** Host sessions release in-process ownership after every attempt. */
  releaseEffect?(lease: Readonly<StateRuntimeEffectLease>): void;
}

export { resolveResourceAdmissionFailureOutcome } from './resource-admission-terminal';

export interface RuntimeActionProvider {
  requestAction(
    effect: Extract<RuntimeEffect, { interactionId: string }>,
    state: Readonly<RuntimeState>,
    commandCommit: RuntimeInteractionCommandCommitPort,
  ): Promise<RuntimeUserAction | PrecommittedInteractionActionDescriptor>;
}

/** Saved by a bridge during the interaction wait; commit never wakes that wait. */
export interface RuntimeInteractionCommandCommitPort {
  commit(
    action: RuntimeUserAction,
    evidence: RuntimeCommandCommitEvidence,
    /** Revision accepted by Host inspection; commit must never substitute a newer State revision. */
    expectedRevision: number,
  ): CommittedInteractionCommand;
}

type EffectExecutionOutcome = {
  applied: boolean;
  emitted: boolean;
  deferred?: { reason: string; retryAfterMs: number };
};
const ABORTED_WAIT = Symbol('aborted-wait');
const TIMED_OUT_WAIT = Symbol('timed-out-wait');
// The executor has already received AbortSignal before this grace period
// begins.  Keep consuming its terminal cleanup facts, but never let one
// non-cooperative adapter hold the Runtime (and its successor turn) forever.
const ABORT_CLEANUP_GRACE_MS = 3_000;

async function waitForPromiseOrAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T | typeof ABORTED_WAIT> {
  if (!signal) return promise;
  if (signal.aborted) return ABORTED_WAIT;
  return new Promise<T | typeof ABORTED_WAIT>((resolve, reject) => {
    let settled = false;
    const finish = (value: T | typeof ABORTED_WAIT) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      resolve(value);
    };
    const abort = () => finish(ABORTED_WAIT);
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(finish, (error: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      reject(error);
    });
  });
}

async function waitForRetryOrAbort(
  retryAfterMs: number,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const delay = new Promise<void>((resolve) => setTimeout(resolve, Math.max(1, retryAfterMs)));
  return (await waitForPromiseOrAbort(delay, signal)) !== ABORTED_WAIT;
}

async function waitForPromiseOrTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | typeof TIMED_OUT_WAIT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof TIMED_OUT_WAIT>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, timeoutMs), TIMED_OUT_WAIT);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const MAX_PENDING_TOOL_PROGRESS_CHARS = 16 * 1024;
const TOOL_PROGRESS_TRUNCATED_MARKER = '… progress truncated … ';
type BufferedToolProgressEvent = Extract<RuntimeEvent, { type: 'tool.progress' }> & {
  lineCount?: number;
};

function isEphemeralEffectEvent(event: RuntimeEvent): event is Extract<
  RuntimeEvent,
  {
    type:
      | 'model.reasoning_delta'
      | 'model.reasoning_completed'
      | 'model.text_delta'
      | 'tool.progress';
  }
> {
  return (
    event.type === 'model.reasoning_delta' ||
    event.type === 'model.reasoning_completed' ||
    event.type === 'model.text_delta' ||
    event.type === 'tool.progress'
  );
}

function toolProgressKey(event: Extract<RuntimeEvent, { type: 'tool.progress' }>): string {
  return `${event.toolCallId}\0${event.stream}`;
}

function boundToolProgressChunk(chunk: string): string {
  if (chunk.length <= MAX_PENDING_TOOL_PROGRESS_CHARS) return chunk;
  const available = Math.max(
    1,
    MAX_PENDING_TOOL_PROGRESS_CHARS - TOOL_PROGRESS_TRUNCATED_MARKER.length,
  );
  let tail = chunk.slice(-available);
  const firstBoundary = tail.indexOf('\n');
  if (firstBoundary >= 0) tail = tail.slice(firstBoundary + 1);
  return `${TOOL_PROGRESS_TRUNCATED_MARKER}${tail}`;
}

function normalizeToolProgress(event: BufferedToolProgressEvent): BufferedToolProgressEvent {
  return {
    ...event,
    chunk: boundToolProgressChunk(event.chunk),
    lineCount: event.lineCount ?? event.chunk.split('\n').length,
  };
}

function mergeToolProgress(
  previous: BufferedToolProgressEvent,
  next: BufferedToolProgressEvent,
): BufferedToolProgressEvent {
  const combined = `${previous.chunk}\n${next.chunk}`;
  return {
    ...next,
    // Progress is an ephemeral tail-follow surface. Keep the pending producer
    // queue bounded; tool.finished remains the authoritative complete result.
    chunk: boundToolProgressChunk(combined),
    lineCount:
      (previous.lineCount ?? previous.chunk.split('\n').length) +
      (next.lineCount ?? next.chunk.split('\n').length),
  };
}

/** Execute an effect while forwarding events produced during the effect. */
async function* executeEffectWithStreaming(
  kernel: RuntimeStateSessionPort,
  executor: RuntimeEffectExecutor,
  lease: StateRuntimeEffectLease,
  reservationIds: string[] = [],
  signal?: AbortSignal,
): AsyncGenerator<RuntimeEvent, EffectExecutionOutcome> {
  // A lease can become stale after async preparation or while another durable
  // fact is applied. Never enter any executor once the journal is corrupt;
  // report a non-applied attempt so the outer loop schedules the hard block.
  if (isRuntimeHostStateToolRecoveryInvalid(kernel.getState())) {
    return { applied: false, emitted: true };
  }
  const pending: Array<{
    events: RuntimeEvent[];
    requiredEffectLease?: RuntimeEffectLeaseExpectation;
    acknowledgement?: StateRuntimeEffectPersistenceAcknowledgement;
    mode?: 'late_resource_reconciliation';
    resolve?: (applied: boolean) => void;
    reject?: (error: unknown) => void;
  }> = [];
  const pendingToolProgress = new Map<string, (typeof pending)[number]>();
  let wake: (() => void) | null = null;
  let settled = false;
  let result: RuntimeEvent[] = [];
  let deferred: { reason: string; retryAfterMs: number } | undefined;
  let failure: unknown;
  let acceptingEvents = true;

  const enqueue = (
    events: RuntimeEvent[],
    resolve?: (applied: boolean) => void,
    reject?: (error: unknown) => void,
    mode?: 'late_resource_reconciliation',
    requiredEffectLease?: RuntimeEffectLeaseExpectation,
    acknowledgement?: StateRuntimeEffectPersistenceAcknowledgement,
  ) => {
    if (!acceptingEvents) {
      resolve?.(false);
      return;
    }
    const event = events.length === 1 ? events[0] : undefined;
    if (!resolve && !reject && !mode && event?.type === 'tool.progress') {
      const key = toolProgressKey(event);
      const existing = pendingToolProgress.get(key);
      const existingEvent = existing?.events[0];
      if (existing && existingEvent?.type === 'tool.progress') {
        existing.events[0] = mergeToolProgress(existingEvent, event);
        return;
      }
      const entry = { events: [normalizeToolProgress(event)] };
      pending.push(entry);
      pendingToolProgress.set(key, entry);
    } else {
      // Durable/lifecycle events are ordering barriers. Progress emitted after
      // one of these facts must occupy a new queue slot.
      pendingToolProgress.clear();
      pending.push({ events, resolve, reject, mode, requiredEffectLease, acknowledgement });
    }
    wake?.();
    wake = null;
  };
  const closeEventChannel = () => {
    acceptingEvents = false;
    wake?.();
    wake = null;
    for (const pendingEvent of pending.splice(0)) pendingEvent.resolve?.(false);
    pendingToolProgress.clear();
  };
  const execution = executor(
    lease.effect,
    kernel.getState(),
    (event) => {
      enqueue([event]);
    },
    {
      reservationIds,
      getState: () => kernel.getState(),
      persistEvent: (event) =>
        new Promise<boolean>((resolve, reject) => {
          // Keep the historical callback on the receipt_evidence-compatible
          // applyEffectEvent/applyEffectResult path. Explicit channels below
          // are the only callers of the strict acknowledgement method.
          enqueue([event], resolve, reject);
        }),
      persistEvents: (events, requiredEffectLease) =>
        new Promise<boolean>((resolve, reject) => {
          enqueue(events, resolve, reject, undefined, requiredEffectLease);
        }),
      persistAttemptStartEvents: (events, requiredEffectLease) =>
        new Promise<boolean>((resolve, reject) => {
          enqueue(events, resolve, reject, undefined, requiredEffectLease, 'attempt_start');
        }),
      persistTerminalRecoveryEvents: (events, requiredEffectLease) =>
        new Promise<boolean>((resolve, reject) => {
          enqueue(events, resolve, reject, undefined, requiredEffectLease, 'terminal_recovery');
        }),
      persistLateResourceReconciliation: (event) =>
        new Promise<boolean>((resolve, reject) => {
          enqueue([event], resolve, reject, 'late_resource_reconciliation');
        }),
    },
  ).then(
    (events) => {
      if (isStateRuntimeEffectDeferred(events)) {
        deferred = events.deferred;
      } else {
        result = events;
      }
      settled = true;
      wake?.();
      wake = null;
    },
    (error: unknown) => {
      failure = error;
      settled = true;
      wake?.();
      wake = null;
    },
  );

  try {
    let emitted = false;
    let cancellationIncomplete = false;
    let cleanupDeadlineAt: number | undefined;
    while (!settled || pending.length > 0) {
      if (pending.length === 0) {
        const waitForWake = new Promise<void>((resolve) => {
          wake = resolve;
        });
        if (cleanupDeadlineAt != null || signal?.aborted) {
          cleanupDeadlineAt ??= Date.now() + ABORT_CLEANUP_GRACE_MS;
          const waited = await waitForPromiseOrTimeout(waitForWake, cleanupDeadlineAt - Date.now());
          if (waited === TIMED_OUT_WAIT) {
            // The executor has exhausted its bounded cleanup grace. Close its
            // persistence channel before returning so a non-cooperative late
            // callback cannot enqueue an event whose acknowledgement will never
            // be consumed by this finished generator.
            closeEventChannel();
            return { applied: false, emitted };
          }
        } else {
          const waited = await waitForPromiseOrAbort(waitForWake, signal);
          if (waited === ABORTED_WAIT) {
            cleanupDeadlineAt = Date.now() + ABORT_CLEANUP_GRACE_MS;
          }
        }
      }
      while (pending.length > 0) {
        const pendingEvent = pending.shift()!;
        const events = pendingEvent.events;
        const event = events[0];
        if (!event) {
          pendingEvent.resolve?.(true);
          continue;
        }
        if (event.type === 'tool.progress') {
          const key = toolProgressKey(event);
          if (pendingToolProgress.get(key) === pendingEvent) pendingToolProgress.delete(key);
        }
        emitted = true;
        if (pendingEvent.mode === 'late_resource_reconciliation') {
          try {
            const applied = kernel.applyLateResourceReconciliation([event]);
            pendingEvent.resolve?.(applied);
            if (applied) yield* kernel.getLastAppliedEvents();
          } catch (error) {
            if (!pendingEvent.reject) throw error;
            pendingEvent.reject(error);
          }
        } else if (events.length === 1 && isEphemeralEffectEvent(event)) {
          const applied = kernel.isEffectEventCurrent(lease, event);
          pendingEvent.resolve?.(applied);
          if (applied) yield event;
        } else {
          if (events.some((candidate) => candidate.type === 'runtime.cancellation_diagnostic')) {
            cancellationIncomplete = true;
          }
          try {
            const applied = pendingEvent.acknowledgement
              ? kernel.applyEffectEvents
                ? kernel.applyEffectEvents(
                    lease,
                    events,
                    pendingEvent.acknowledgement,
                    pendingEvent.requiredEffectLease,
                  )
                : pendingEvent.acknowledgement === 'receipt_evidence'
                  ? events.length === 1
                    ? kernel.applyEffectEvent(lease, event)
                    : kernel.applyEffectResult(lease, events, pendingEvent.requiredEffectLease)
                  : false
              : events.length === 1
                ? kernel.applyEffectEvent(lease, event)
                : kernel.applyEffectResult(lease, events, pendingEvent.requiredEffectLease);
            pendingEvent.resolve?.(applied);
            if (applied) {
              yield* kernel.getLastAppliedEvents();
            }
          } catch (error) {
            if (!pendingEvent.reject) throw error;
            pendingEvent.reject(error);
          }
        }
      }
    }
    await execution;
    if (deferred) return { applied: false, emitted: false, deferred };
    if (failure) {
      if (failure instanceof DescendantResourceAdmissionError) {
        const terminalEvents = resourceAdmissionTerminalEvents(kernel.getState(), failure.reason);
        kernel.applyEffectResult(lease, terminalEvents);
        yield* kernel.getLastAppliedEvents();
        return { applied: true, emitted: true };
      }
      if (reservationIds.length > 0) {
        const terminalReservationEvents: RuntimeEvent[] = reservationIds.map((reservationId) => ({
          type: 'resource_budget.unknown',
          reservationId,
        }));
        kernel.applyEffectResult(lease, terminalReservationEvents);
      }
      throw failure;
    }

    const reconciled = reconciliationEventsForReservations(
      kernel.getState(),
      reservationIds,
      result,
    );
    const terminalResult = [...result, ...reconciled];
    if (terminalResult.length > 0) {
      emitted = true;
      try {
        if (!kernel.applyEffectResult(lease, terminalResult)) {
          if (
            !cancellationIncomplete &&
            reconciled.length > 0 &&
            kernel.applyLateResourceReconciliation(reconciled)
          ) {
            yield* reconciled;
          }
          return { applied: false, emitted };
        }
      } catch (error) {
        const unknownEvents: RuntimeEvent[] = reservationIds.flatMap((reservationId) => {
          const budget = kernel.getState().resourceBudget;
          return budget.status === 'active' &&
            budget.reservations[reservationId]?.state === 'dispatch_started'
            ? [{ type: 'resource_budget.unknown' as const, reservationId }]
            : [];
        });
        if (unknownEvents.length > 0) kernel.applyEffectResult(lease, unknownEvents);
        throw error;
      }
      yield* kernel.getLastAppliedEvents();
    }
    if (!emitted) return { applied: true, emitted: false };
    return { applied: true, emitted: true };
  } finally {
    closeEventChannel();
  }
}

function shellConcurrencyGroup(
  effect: Extract<RuntimeEffect, { type: 'run_tools' }>,
  facts: SchedulerFacts | undefined,
): string | undefined {
  let group: string | undefined;
  for (const toolCallId of effect.toolCallIds) {
    const traits = facts?.traits[toolCallId];
    if (!traits) return undefined;
    if (!traits.resourceScopes.some((scope) => scope.kind === 'process')) return undefined;
    const candidate = traits.causalGroup;
    if (group != null && group !== candidate) return undefined;
    group = candidate;
  }
  return group;
}

/**
 * Kernel-native execution loop.  It is deliberately free of LangGraph stream,
 * checkpoint concepts so application runners can adopt it as a
 * single, testable replacement boundary.
 */
export async function* runStateRuntimeLoop(
  kernel: RuntimeStateSessionPort,
  executor: RuntimeEffectExecutor,
  provider: RuntimeActionProvider,
  maxEffects = 10_000,
  prepareEffect?: (
    effect: RuntimeEffect,
    state: Readonly<RuntimeState>,
  ) => Promise<RuntimeEffect> | RuntimeEffect,
  signal?: AbortSignal,
  schedulerFacts?: (state: Readonly<RuntimeState>) => SchedulerFacts,
): AsyncGenerator<RuntimeEvent> {
  const runnerId = kernel.acquireRunner();
  if (!runnerId) return;
  const backgroundEvents: RuntimeEvent[] = [];
  const backgroundGroups = new Map<string, number>();
  let backgroundCount = 0;
  let backgroundFailure: unknown;
  let backgroundNoProgressRevision: number | undefined;
  let wakeBackground: (() => void) | undefined;
  const signalBackground = () => {
    wakeBackground?.();
    wakeBackground = undefined;
  };
  const waitForBackground = () =>
    backgroundEvents.length > 0 ||
    backgroundFailure ||
    (backgroundCount === 0 && backgroundNoProgressRevision !== undefined)
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          wakeBackground = resolve;
        });
  const consumeSettledBackgroundNoProgress = () => {
    if (backgroundCount > 0 || backgroundNoProgressRevision === undefined) return false;
    const candidateRevision = backgroundNoProgressRevision;
    backgroundNoProgressRevision = undefined;
    return kernel.getState().revision === candidateRevision;
  };
  const launchShellEffect = (
    effect: Extract<RuntimeEffect, { type: 'run_tools' }>,
    group: string,
    reservationIds: string[],
  ) => {
    const lease = kernel.beginEffect(effect);
    backgroundCount += 1;
    backgroundGroups.set(group, (backgroundGroups.get(group) ?? 0) + 1);
    void (async () => {
      const stream = executeEffectWithStreaming(kernel, executor, lease, reservationIds, signal);
      try {
        while (true) {
          const step = await stream.next();
          if (step.done) {
            // An event-free background attempt is only a candidate for stopping. Another
            // sibling may still commit durable progress after this callback returns, so the
            // main loop must wait for the complete background set and compare revisions again.
            if (
              !step.value.emitted &&
              backgroundCount === 1 &&
              kernel.getState().revision === lease.expectedRevision
            )
              backgroundNoProgressRevision = lease.expectedRevision;
            break;
          }
          backgroundEvents.push(step.value);
          signalBackground();
        }
      } catch (error) {
        backgroundFailure ??= error;
      } finally {
        kernel.releaseEffect?.(lease);
        backgroundCount -= 1;
        const remaining = (backgroundGroups.get(group) ?? 1) - 1;
        if (remaining > 0) backgroundGroups.set(group, remaining);
        else backgroundGroups.delete(group);
        signalBackground();
      }
    })();
  };
  const drainBackgroundEffects = async function* (): AsyncGenerator<
    RuntimeEvent,
    Extract<RuntimeEvent, { type: 'runtime.cancellation_diagnostic' }> | undefined
  > {
    let cancellationIncomplete:
      | Extract<RuntimeEvent, { type: 'runtime.cancellation_diagnostic' }>
      | undefined;
    while (backgroundCount > 0 || backgroundEvents.length > 0) {
      if (backgroundEvents.length === 0) {
        // Every background executor receives the same signal and has its own
        // bounded post-abort cleanup grace. Once cancellation is observed we
        // must drain that grace rather than race the already-aborted signal,
        // otherwise diagnostics and terminal cleanup facts disappear.
        if (signal?.aborted) await waitForBackground();
        else await waitForPromiseOrAbort(waitForBackground(), signal);
      }
      while (backgroundEvents.length > 0) {
        const backgroundEvent = backgroundEvents.shift()!;
        if (backgroundEvent.type === 'runtime.cancellation_diagnostic') {
          cancellationIncomplete = backgroundEvent;
        }
        yield backgroundEvent;
      }
      if (backgroundFailure) throw backgroundFailure;
    }
    return cancellationIncomplete;
  };

  try {
    let count = 0;
    while (count < maxEffects) {
      while (backgroundEvents.length > 0) yield backgroundEvents.shift()!;
      if (backgroundFailure) throw backgroundFailure;
      if (consumeSettledBackgroundNoProgress()) return;

      const state = kernel.getState();
      let facts = schedulerFacts?.(state);
      let effect = kernel.selectPendingEffects(state, facts)[0] ?? { type: 'stop' as const };
      if (prepareEffect) effect = await prepareEffect(effect, kernel.getState());
      const effectState = kernel.getState();
      facts = schedulerFacts?.(effectState);
      const currentEffect = kernel.selectPendingEffects(effectState, facts)[0] ?? {
        type: 'stop' as const,
      };
      if (currentEffect.type === 'recovery_blocked') effect = currentEffect;
      const shellGroup =
        effect.type === 'run_tools' ? shellConcurrencyGroup(effect, facts) : undefined;
      const effectToolCallIds = effect.type === 'run_tools' ? effect.toolCallIds : [];
      const overlapsRunningShell =
        shellGroup != null && (backgroundGroups.get(shellGroup) ?? 0) > 0;
      const hasQueuedShellSibling =
        shellGroup != null &&
        effectState.tools.queue.some(
          (toolCallId) =>
            !effectToolCallIds.includes(toolCallId) &&
            shellConcurrencyGroup({ type: 'run_tools', toolCallIds: [toolCallId] }, facts) ===
              shellGroup,
        );

      // A running shell may overlap only with shell siblings from the same
      // model response and task. Other tools, model calls and completion wait.
      if (
        backgroundCount > 0 &&
        !(
          effect.type === 'request_tool_approval' ||
          (effect.type === 'run_tools' && overlapsRunningShell)
        )
      ) {
        await waitForBackground();
        continue;
      }

      if (effect.type === 'stop') {
        const deferredAbort = deferredApprovalRejectionTurnAbortEvent(kernel.getState());
        if (deferredAbort) {
          kernel.processEvent(deferredAbort);
          yield* kernel.getLastAppliedEvents();
        }
        return;
      }
      if (effect.type === 'recovery_blocked') {
        count += 1;
        const lease = kernel.beginEffect(effect);
        const failure = classifyFailure(
          effect.failureKind,
          `Runtime recovery is blocked: ${effect.reason}`,
        );
        const terminal: RuntimeEvent = {
          type: 'run.error',
          message: failure.message,
          recoverable: false,
          failure,
          effectId: lease.effectId,
          turnId: lease.turnId,
          outcome: failedTerminalOutcome(failure, {
            knownExternalEffects: effect.failureKind === 'unknown' ? 'unknown' : 'none',
          }),
        };
        const aborted: RuntimeEvent = {
          type: 'turn.aborted',
          turnId: lease.turnId,
          reason: failure.message,
          cause: 'error',
        };
        // A non-normal recovery state may only cross the Kernel invariant
        // boundary after the turn is terminal. Persist the abort first and
        // retain the recovery hard block so a later turn cannot restart it.
        kernel.processEventBatch([aborted, terminal]);
        kernel.releaseEffect?.(lease);
        yield aborted;
        yield terminal;
        return;
      }
      if (effect.type === 'emit_final') {
        count += 1;
        const decision = decideCompletion(kernel.getState());
        if (decision.status !== 'accepted') continue;
        const completed: RuntimeEvent = {
          type: 'run.completed',
          turnId: kernel.getState().turn.turnId,
          output: kernel.getState().transcript.final ?? '',
          completionGuardVersion: decision.version,
          ...(decision.version === 'completion_guard_v2'
            ? { planIdentity: decision.planIdentity }
            : {}),
          outcome: completedTerminalOutcome(),
        };
        const turnCompleted: RuntimeEvent = {
          type: 'turn.completed',
          turnId: kernel.getState().turn.turnId,
        };
        // Persist both completion facts before exposing either one. A slow
        // consumer must not leave an active turn vulnerable to the deadline
        // timer after run.completed is already durable.
        kernel.processEventBatch([completed, turnCompleted]);
        yield completed;
        yield turnCompleted;
        return;
      }
      if (effect.type === 'completion_blocked') {
        count += 1;
        const blocked: RuntimeEvent = {
          type: 'completion.blocked',
          turnId: kernel.getState().turn.turnId,
          guardVersion: effect.decision.version,
          code: effect.decision.code,
          nextAction: effect.decision.nextAction,
          planning: effect.decision.planning,
          correctionAttempt: effect.decision.correctionAttempt,
          ...(effect.decision.version === 'completion_guard_v2'
            ? { planIdentity: effect.decision.planIdentity }
            : {}),
        };
        if (effect.decision.canCorrect) {
          kernel.processEvent(blocked);
          yield blocked;
          continue;
        }
        if (effect.decision.code === 'plan_draft_pending') {
          const turnCompleted: RuntimeEvent = {
            type: 'turn.completed',
            turnId: kernel.getState().turn.turnId,
          };
          // A draft can intentionally remain paused across user turns. The
          // guard still prevents run/task completion, but a second plain-text
          // acknowledgement must not turn that safe pending state into an
          // opaque Runtime error. Persist the blocker and close only the turn.
          kernel.processEventBatch([blocked, turnCompleted]);
          yield blocked;
          yield turnCompleted;
          return;
        }
        const failure = classifyFailure(
          'unknown',
          `Completion blocked by ${effect.decision.code}; next action: ${effect.decision.nextAction}.`,
        );
        const aborted: RuntimeEvent = {
          type: 'turn.aborted',
          turnId: kernel.getState().turn.turnId,
          reason: failure.message,
          cause: 'error',
        };
        const terminal: RuntimeEvent = {
          type: 'run.error',
          message: failure.message,
          recoverable: false,
          failure,
          turnId: kernel.getState().turn.turnId,
          outcome: failedTerminalOutcome({ ...failure, kind: 'unknown' }),
        };
        // The non-correctable blocker and both terminal facts are one durable
        // boundary. A consumer that stops after observing attempt two must
        // never leave an active turn that can schedule a third model call.
        kernel.processEventBatch([blocked, aborted, terminal]);
        yield blocked;
        yield aborted;
        yield terminal;
        return;
      }
      let reservationIds: string[] = [];
      if (kernel.getState().resourceBudget.status === 'active') {
        const admission = planRuntimeBudgetAdmission(kernel.getState(), effect);
        if (admission.preparationEvents.length > 0) {
          kernel.processEventBatch(admission.preparationEvents);
          yield* admission.preparationEvents;
        }
        if (admission.status === 'waiting') {
          const remainingMs = Math.max(
            0,
            Date.parse(admission.waitDeadlineAt ?? new Date().toISOString()) - Date.now(),
          );
          if (remainingMs > 0) {
            await new Promise<void>((resolve) => {
              let settled = false;
              const finish = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                signal?.removeEventListener('abort', finish);
                resolve();
              };
              const timer = setTimeout(finish, remainingMs);
              if (signal?.aborted) finish();
              else signal?.addEventListener('abort', finish, { once: true });
              if (backgroundCount > 0) void waitForBackground().then(finish);
            });
            if (signal?.aborted) return;
            continue;
          }
          const terminalEvents = resourceAdmissionTerminalEvents(
            kernel.getState(),
            admission.reason,
          );
          kernel.processEventBatch(terminalEvents);
          yield* terminalEvents;
          return;
        }
        if (admission.status === 'denied') {
          const terminalEvents = resourceAdmissionTerminalEvents(
            kernel.getState(),
            admission.reason,
          );
          kernel.processEventBatch(terminalEvents);
          yield* terminalEvents;
          return;
        }
        if (admission.dispatchEvents.length > 0) {
          kernel.processEventBatch(admission.dispatchEvents);
          yield* admission.dispatchEvents;
        }
        effect = admission.effect;
        reservationIds = admission.reservationIds;
      }
      // Recheck after all async/preparation admission boundaries and before a
      // prepared effect can request UI, Provider, verification, compaction or
      // tool execution. The leased executor repeats this check once more.
      if (isRuntimeHostStateToolRecoveryInvalid(kernel.getState())) {
        continue;
      }
      if (
        effect.type === 'run_tools' &&
        shellGroup != null &&
        (overlapsRunningShell || hasQueuedShellSibling)
      ) {
        count += 1;
        launchShellEffect(effect, shellGroup, reservationIds);
        await waitForBackground();
        continue;
      }
      if (
        effect.type === 'request_user_input' ||
        effect.type === 'request_plan_review' ||
        effect.type === 'request_tool_approval' ||
        effect.type === 'request_verification_decision' ||
        effect.type === 'request_provider_action' ||
        effect.type === 'request_provider_admission'
      ) {
        count += 1;
        const interaction = kernel.getState().interactions;
        if (
          effect.type === 'request_provider_action' &&
          interaction.kind === 'awaiting_provider_action' &&
          interaction.status === 'required'
        ) {
          const started: RuntimeEvent = {
            type: 'provider.action_started',
            interactionId: effect.interactionId,
          };
          kernel.processEvent(started);
          yield started;
        }
        let action: RuntimeUserAction;
        let precommitted: PrecommittedInteractionActionDescriptor | undefined;
        try {
          const actionState = kernel.getState();
          const commandCommit: RuntimeInteractionCommandCommitPort = Object.freeze({
            commit: (
              candidate: RuntimeUserAction,
              evidence: RuntimeCommandCommitEvidence,
              expectedRevision: number,
            ) => {
              if (!kernel.commitInteractionCommand) {
                throw new Error('Runtime interaction command commit is unavailable.');
              }
              if (!kernel.getSandboxAvailable) {
                throw new Error('Runtime interaction command sandbox fact is unavailable.');
              }
              const commitState = kernel.getState();
              return kernel.commitInteractionCommand({
                action: candidate,
                sessionId: commitState.session.threadId,
                interactionId: effect.interactionId,
                expectedRevision,
                effectType: effect.type,
                reservationReconciliationEvents:
                  effect.type === 'request_provider_action'
                    ? reconciliationEventsForReservations(commitState, reservationIds)
                    : [],
                sandboxAvailable: kernel.getSandboxAvailable(),
                evidence,
              });
            },
          });
          const requested = provider.requestAction(effect, actionState, commandCommit).then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({ ok: false as const, error }),
          );
          let resolved: Awaited<typeof requested> | undefined;
          void requested.then((value) => {
            resolved = value;
            signalBackground();
          });
          while (!resolved) {
            if (backgroundCount === 0) {
              const waited = await waitForPromiseOrAbort(requested, signal);
              if (waited === ABORTED_WAIT) {
                yield* drainBackgroundEffects();
                return;
              }
              resolved = waited;
              break;
            }
            const waited = await waitForPromiseOrAbort(waitForBackground(), signal);
            if (waited === ABORTED_WAIT) {
              yield* drainBackgroundEffects();
              return;
            }
            while (backgroundEvents.length > 0) yield backgroundEvents.shift()!;
            if (backgroundFailure) throw backgroundFailure;
            if (consumeSettledBackgroundNoProgress()) return;
          }
          if (!resolved.ok) throw resolved.error;
          if (isPrecommittedInteractionAction(resolved.value)) {
            precommitted = resolved.value;
            action = precommitted.action;
          } else {
            action = resolved.value;
          }
        } catch (error) {
          if (effect.type === 'request_provider_action') {
            action = {
              type: 'provider_action_result',
              interactionId: effect.interactionId,
              outcome: 'failed',
              failureCode: 'unknown',
            };
          } else {
            // A provider-admission UI/transport failure is not a user
            // decision. Let the agent persist a typed error-caused terminal
            // instead of falsely recording task/turn cancellation by user.
            throw error;
          }
        }
        let events: readonly RuntimeEvent[];
        if (precommitted) {
          assertPrecommittedInteractionAction(
            kernel.getState(),
            precommitted,
            precommitted.sessionId,
          );
          events = precommitted.events;
        } else {
          const actionState = kernel.getState();
          const actionResult = kernel.applyAction(
            action,
            effect.type === 'request_provider_action'
              ? reconciliationEventsForReservations(kernel.getState(), reservationIds)
              : [],
          );
          if (actionResult.status !== 'applied') {
            // Stale UI actions are expected during cancellation/session-switch races.
            // They are recorded by the runtime logger but must not become user errors.
            yield actionResult.telemetry;
            continue;
          }
          events = actionResult.events;
          // RuntimeSessionCoordinator commits approval settlement atomically,
          // while lightweight Host harnesses may only persist the user decision
          // in applyAction. Keep the provider→runner path equivalent without
          // duplicating facts from the atomic production path.
          if (
            events.some((event) => event.type === 'approval.rejected') &&
            !events.some((event) => event.type === 'tool.rejected')
          ) {
            const settlement = approvalRejectionSettlementEvents(actionState, events);
            if (settlement.length > 0) {
              const persistedSettlement = kernel.processEventBatch(settlement);
              events = [...events, ...persistedSettlement];
            }
          }
        }
        // Rejecting a focused tool approval terminates the current turn. The
        // committed settlement rejects that exact invocation, cancels every
        // unfinished sibling, and records turn.aborted before this shared
        // execution signal is propagated.
        const executionAuthorizationCancelled =
          (effect.type === 'request_tool_approval' &&
            (action.type === 'cancel' || action.type === 'reject')) ||
          (effect.type === 'request_plan_review' &&
            (action.type === 'cancel' ||
              (action.type === 'plan_review_decision' && action.decision.kind === 'cancel')));

        yield* events;
        if (executionAuthorizationCancelled) {
          if (!signal) return;
          const cancellationIncomplete = yield* drainBackgroundEffects();
          if (cancellationIncomplete) {
            const failure = cancellationIncomplete.failure;
            const terminal: RuntimeEvent = {
              type: 'run.error',
              message: failure.message,
              recoverable: false,
              failure,
              turnId: kernel.getState().turn.turnId,
              outcome: failedTerminalOutcome(failure, {
                knownExternalEffects: 'unknown',
              }),
            };
            kernel.processEvent(terminal);
            yield terminal;
          }
          return;
        }
        if (
          effect.type === 'request_provider_admission' &&
          (action.type === 'cancel' ||
            (action.type === 'provider_admission_decision' && action.decision.kind === 'cancel'))
        ) {
          return;
        }
        continue;
      }
      count += 1;
      const lease = kernel.beginEffect(effect);
      let outcome: EffectExecutionOutcome;
      try {
        outcome = yield* executeEffectWithStreaming(
          kernel,
          executor,
          lease,
          reservationIds,
          signal,
        );
      } finally {
        kernel.releaseEffect?.(lease);
      }
      if (outcome.deferred) {
        // A cross-runtime effect lease is contention, not a terminal outcome.
        // Do not consume the effect budget while waiting for the owning runtime.
        count -= 1;
        if (!(await waitForRetryOrAbort(outcome.deferred.retryAfterMs, signal))) return;
        continue;
      }
      if (!outcome.emitted && kernel.getState().revision === lease.expectedRevision) return;
      if (!outcome.applied) continue;
    }
    throw new Error(`Runtime effect limit (${maxEffects}) exceeded`);
  } finally {
    kernel.releaseRunner(runnerId);
  }
}
