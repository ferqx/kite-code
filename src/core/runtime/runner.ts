import { ProviderDataAdmissionError } from '@/core/config/provider-data-admission';
import {
  createManualSummaryPreReservationDeniedEventV1,
  createSummaryStartBatchKeyV1,
  ProviderDispatchEntryGuardV1,
} from '@/core/model/progressive-context-orchestrator';
import type { RuntimeUserAction } from './actions';
import type { RuntimeEvent } from './events';
import { classifyFailure } from './failures';
import type { AgentKernel, RuntimeEffectExecutor } from './kernel';
import { resourceAdmissionTerminalEventsV1 } from './resource-admission-terminal';
import {
  finalizeRuntimeEffectTerminalBatchV1,
  planRuntimeBudgetAdmissionV1,
  reconciliationEventsForReservationsV1,
} from './resource-budget-admission';
import { decideNextEffect } from './scheduler';
import { completedTerminalOutcomeV1, failedTerminalOutcomeV1 } from './terminal-outcome';

export { resolveResourceAdmissionFailureOutcomeV1 } from './resource-admission-terminal';

export interface RuntimeActionProvider {
  requestAction(
    effect: Extract<import('./effects').RuntimeEffect, { interactionId: string }>,
    state: Readonly<import('./state').RuntimeState>,
  ): Promise<RuntimeUserAction>;
}

export interface RuntimeEffectPreparationV2 {
  effect: import('./effects').RuntimeEffect;
  preparationEvents: RuntimeEvent[];
}

type EffectExecutionOutcome = { applied: boolean; emitted: boolean };
const ABORTED_WAIT = Symbol('aborted-wait');

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
  kernel: AgentKernel,
  executor: RuntimeEffectExecutor,
  lease: import('./effects').RuntimeEffectLease,
  reservationIds: string[] = [],
  summaryDispatchEntryGuard?: ProviderDispatchEntryGuardV1,
): AsyncGenerator<RuntimeEvent, EffectExecutionOutcome> {
  const pending: Array<{
    events: RuntimeEvent[];
    mode?: 'late_resource_reconciliation';
    resolve?: (applied: boolean) => void;
    reject?: (error: unknown) => void;
  }> = [];
  const pendingToolProgress = new Map<string, (typeof pending)[number]>();
  let wake: (() => void) | null = null;
  let settled = false;
  let result: RuntimeEvent[] = [];
  let failure: unknown;

  const enqueue = (
    events: RuntimeEvent[],
    resolve?: (applied: boolean) => void,
    reject?: (error: unknown) => void,
    mode?: 'late_resource_reconciliation',
  ) => {
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
      pending.push({ events, resolve, reject, mode });
    }
    wake?.();
    wake = null;
  };
  const execution = executor(
    lease.effect,
    kernel.getState(),
    (event) => {
      enqueue([event]);
    },
    {
      effectLeaseId: lease.effectId,
      producerGeneration: kernel.getProducerGeneration(),
      summaryDispatchEntryGuard,
      reservationIds,
      getState: () => kernel.getState(),
      persistEvent: (event) =>
        new Promise<boolean>((resolve, reject) => {
          enqueue([event], resolve, reject);
        }),
      persistEvents: (events) =>
        new Promise<boolean>((resolve, reject) => {
          enqueue(events, resolve, reject);
        }),
      persistLateResourceReconciliation: (event) =>
        new Promise<boolean>((resolve, reject) => {
          enqueue([event], resolve, reject, 'late_resource_reconciliation');
        }),
    },
  ).then(
    (events) => {
      result = events;
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

  let emitted = false;
  let cancellationIncomplete = false;
  while (!settled || pending.length > 0) {
    if (pending.length === 0) {
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
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
          if (applied) yield event;
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
          const applied =
            events.length === 1
              ? kernel.applyEffectEvent(lease, event)
              : kernel.applyEffectResult(lease, events);
          pendingEvent.resolve?.(applied);
          if (applied) {
            yield* events;
          }
        } catch (error) {
          if (!pendingEvent.reject) throw error;
          pendingEvent.reject(error);
        }
      }
    }
  }
  await execution;
  if (failure) {
    const lifecycle = kernel.getState().context.summaryLifecycle;
    const consumption =
      lease.effect.type === 'call_model' &&
      lease.effect.primaryRequestId &&
      lifecycle.kind === 'idle' &&
      lifecycle.lastConsumption?.primaryRequestId === lease.effect.primaryRequestId
        ? lifecycle.lastConsumption
        : undefined;
    if (consumption) {
      const admissionFailure = failure instanceof ProviderDataAdmissionError ? failure : undefined;
      const denied = admissionFailure?.knownExternalEffects === 'none';
      const failureKind = denied
        ? admissionFailure?.decision.reason === 'mandatory_policy_unavailable'
          ? 'mandatory_policy_unavailable'
          : 'policy_denied'
        : 'unknown';
      const classified = classifyFailure(
        failureKind,
        denied
          ? 'Provider data admission denied the continuation primary.'
          : 'Continuation primary outcome is unknown after dispatch.',
      );
      const terminalEvents: RuntimeEvent[] = [
        {
          type: 'run.error',
          message: classified.message,
          recoverable: false,
          failure: classified,
          turnId: consumption.continuation.turnId,
          outcome: failedTerminalOutcomeV1(classified, {
            knownExternalEffects: denied ? 'none' : 'unknown',
          }),
        },
        ...reservationIds.map(
          (reservationId): RuntimeEvent =>
            denied
              ? {
                  type: 'resource_budget.released',
                  reservationId,
                  proof: 'local_provider_admission_denied',
                }
              : { type: 'resource_budget.unknown', reservationId },
        ),
        {
          type: 'turn.aborted',
          turnId: consumption.continuation.turnId,
          reason: classified.message,
          cause: 'error',
        },
      ];
      if (kernel.applyEffectResult(lease, terminalEvents)) {
        yield* terminalEvents;
      }
      return { applied: true, emitted: true };
    }
    if (reservationIds.length > 0) {
      const terminalReservationEvents: RuntimeEvent[] = reservationIds.map((reservationId) =>
        failure instanceof ProviderDataAdmissionError && failure.knownExternalEffects === 'none'
          ? {
              type: 'resource_budget.released',
              reservationId,
              proof: 'local_provider_admission_denied',
            }
          : {
              type: 'resource_budget.unknown',
              reservationId,
            },
      );
      kernel.applyEffectResult(lease, terminalReservationEvents);
    }
    throw failure;
  }

  const terminalResult = finalizeRuntimeEffectTerminalBatchV1(
    kernel.getState() as import('./state').RuntimeState,
    reservationIds,
    result,
  );
  const reconciled = terminalResult.filter(
    (event) =>
      event.type === 'resource_budget.reconciled' ||
      event.type === 'resource_budget.released' ||
      event.type === 'resource_budget.unknown',
  );
  if (terminalResult.length > 0) {
    emitted = true;
    try {
      if (!kernel.applyEffectResult(lease, terminalResult)) {
        const staleSummarySettlement = !cancellationIncomplete
          ? kernel.applyStaleSummarySettlementV1(terminalResult)
          : false;
        if (staleSummarySettlement) {
          yield* staleSummarySettlement;
        } else if (
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
    yield* terminalResult;
  }
  if (!emitted) return { applied: true, emitted: false };
  return { applied: true, emitted: true };
}

function shellConcurrencyGroup(
  effect: Extract<import('./effects').RuntimeEffect, { type: 'run_tools' }>,
  state: Readonly<import('./state').RuntimeState>,
): string | undefined {
  let group: string | undefined;
  for (const toolCallId of effect.toolCallIds) {
    const call = state.tools.calls[toolCallId];
    if (call?.name !== 'shell_execute' || !call.modelMessageId) return undefined;
    const candidate = `${call.taskId ?? state.activeTaskId ?? ''}\0${call.modelMessageId}`;
    if (group != null && group !== candidate) return undefined;
    group = candidate;
  }
  return group;
}

/**
 * Kernel-native execution loop.  It is deliberately free of LangGraph stream,
 * checkpoint and AgentEvent concepts so application runners can adopt it as a
 * single, testable replacement boundary.
 */
export async function* runRuntimeLoop(
  kernel: AgentKernel,
  executor: RuntimeEffectExecutor,
  provider: RuntimeActionProvider,
  maxEffects = 10_000,
  prepareEffect?: (
    effect: import('./effects').RuntimeEffect,
    state: Readonly<import('./state').RuntimeState>,
  ) =>
    | Promise<import('./effects').RuntimeEffect | RuntimeEffectPreparationV2>
    | import('./effects').RuntimeEffect
    | RuntimeEffectPreparationV2,
  signal?: AbortSignal,
): AsyncGenerator<RuntimeEvent> {
  const runnerId = kernel.acquireRunner();
  if (!runnerId) return;
  const backgroundEvents: RuntimeEvent[] = [];
  const backgroundGroups = new Map<string, number>();
  let backgroundCount = 0;
  let backgroundFailure: unknown;
  let backgroundStopped = false;
  let wakeBackground: (() => void) | undefined;
  const signalBackground = () => {
    wakeBackground?.();
    wakeBackground = undefined;
  };
  const waitForBackground = () =>
    backgroundEvents.length > 0 || backgroundFailure || backgroundStopped
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          wakeBackground = resolve;
        });
  const launchShellEffect = (
    effect: Extract<import('./effects').RuntimeEffect, { type: 'run_tools' }>,
    group: string,
    reservationIds: string[],
  ) => {
    const lease = kernel.beginEffect(effect);
    backgroundCount += 1;
    backgroundGroups.set(group, (backgroundGroups.get(group) ?? 0) + 1);
    void (async () => {
      const stream = executeEffectWithStreaming(kernel, executor, lease, reservationIds);
      try {
        while (true) {
          const step = await stream.next();
          if (step.done) {
            if (!step.value.emitted) backgroundStopped = true;
            break;
          }
          backgroundEvents.push(step.value);
          signalBackground();
        }
      } catch (error) {
        backgroundFailure ??= error;
      } finally {
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
      if (backgroundEvents.length === 0) await waitForBackground();
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
      if (backgroundStopped) return;

      let effect = decideNextEffect(kernel.getState());
      if (prepareEffect) {
        const prepared = await prepareEffect(effect, kernel.getState());
        if ('preparationEvents' in prepared) {
          if (prepared.preparationEvents.length > 0) {
            kernel.processEventBatch(prepared.preparationEvents);
            yield* prepared.preparationEvents;
            continue;
          }
          effect = prepared.effect;
        } else {
          effect = prepared;
        }
      }
      const effectState = kernel.getState();
      const shellGroup =
        effect.type === 'run_tools' ? shellConcurrencyGroup(effect, effectState) : undefined;
      const effectToolCallIds = effect.type === 'run_tools' ? effect.toolCallIds : [];
      const overlapsRunningShell =
        shellGroup != null && (backgroundGroups.get(shellGroup) ?? 0) > 0;
      const hasQueuedShellSibling =
        shellGroup != null &&
        effectState.tools.queue.some(
          (toolCallId) =>
            !effectToolCallIds.includes(toolCallId) &&
            shellConcurrencyGroup({ type: 'run_tools', toolCallIds: [toolCallId] }, effectState) ===
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

      if (effect.type === 'stop') return;
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
          outcome: failedTerminalOutcomeV1(failure, {
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
        yield aborted;
        yield terminal;
        return;
      }
      if (effect.type === 'subagent.recovery_unavailable') {
        count += 1;
        const lease = kernel.beginEffect(effect);
        const outcome = yield* executeEffectWithStreaming(kernel, executor, lease);
        if (!outcome.emitted) return;
        if (!outcome.applied) continue;
        continue;
      }
      if (effect.type === 'emit_final') {
        count += 1;
        const completed: RuntimeEvent = {
          type: 'run.completed',
          turnId: kernel.getState().turn.turnId,
          output: kernel.getState().transcript.final ?? '',
          outcome: completedTerminalOutcomeV1(),
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
      let reservationIds: string[] = [];
      let admittedModelLease: import('./effects').RuntimeEffectLease | undefined;
      let admittedSummaryLease: import('./effects').RuntimeEffectLease | undefined;
      let admittedSummaryGuard: ProviderDispatchEntryGuardV1 | undefined;
      if (kernel.getState().resourceBudget.status === 'active') {
        const admission = planRuntimeBudgetAdmissionV1(
          kernel.getState() as import('./state').RuntimeState,
          effect,
        );
        const atomicModelAdmission =
          admission.status === 'admitted' && effect.type === 'call_model';
        const atomicSummaryAdmission =
          admission.status === 'admitted' &&
          effect.type === 'compact_context' &&
          (kernel.getState().context.summaryLifecycle.kind === 'requested' ||
            Boolean(effect.summaryRequest));
        if (
          admission.preparationEvents.length > 0 &&
          !atomicModelAdmission &&
          !atomicSummaryAdmission
        ) {
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
          const terminalEvents = resourceAdmissionTerminalEventsV1(
            kernel.getState() as import('./state').RuntimeState,
            admission.reason,
          );
          const lifecycle = kernel.getState().context.summaryLifecycle;
          if (effect.type === 'compact_context' && lifecycle.kind === 'requested') {
            const denied = createManualSummaryPreReservationDeniedEventV1({
              state: kernel.getState(),
              message: `Summary resource admission was denied: ${admission.reason}.`,
            });
            kernel.processEvent(denied);
            yield denied;
            return;
          }
          kernel.processEventBatch(terminalEvents);
          yield* terminalEvents;
          return;
        }
        if (admission.status === 'denied') {
          const lifecycle = kernel.getState().context.summaryLifecycle;
          if (effect.type === 'compact_context' && lifecycle.kind === 'requested') {
            const denied = createManualSummaryPreReservationDeniedEventV1({
              state: kernel.getState(),
              message: `Summary resource admission was denied: ${admission.reason}.`,
            });
            kernel.processEvent(denied);
            yield denied;
            return;
          }
          const terminalEvents = resourceAdmissionTerminalEventsV1(
            kernel.getState() as import('./state').RuntimeState,
            admission.reason,
          );
          kernel.processEventBatch(terminalEvents);
          yield* terminalEvents;
          return;
        }
        if (atomicModelAdmission) {
          const continuationLifecycle = kernel.getState().context.summaryLifecycle;
          const primaryRequestId =
            continuationLifecycle.kind === 'normal_reprepare_required'
              ? crypto.randomUUID()
              : undefined;
          const admittedEffect = primaryRequestId
            ? { ...admission.effect, primaryRequestId }
            : admission.effect;
          admittedModelLease = kernel.beginEffect(admittedEffect);
          const reservationId = admission.reservationIds[0];
          const reservation = admission.preparationEvents.find(
            (event) =>
              event.type === 'resource_budget.reserved' &&
              event.reservation.reservationId === reservationId,
          );
          const consumptionKey =
            continuationLifecycle.kind === 'normal_reprepare_required' &&
            primaryRequestId &&
            reservationId &&
            reservation?.type === 'resource_budget.reserved'
              ? {
                  version: 1 as const,
                  generation: kernel.getProducerGeneration(),
                  consumptionBatchId: crypto.randomUUID(),
                  attemptId: continuationLifecycle.receipt.attemptId,
                  compactionId: continuationLifecycle.receipt.compactionId,
                  continuation: continuationLifecycle.receipt.continuation,
                  originReceipt: continuationLifecycle.receipt,
                  primaryEffectLeaseId: admittedModelLease.effectId,
                  primaryInvocationId: reservation.reservation.invocationId,
                  primaryRequestId,
                  resourceReservationId: reservationId,
                }
              : undefined;
          if (continuationLifecycle.kind === 'normal_reprepare_required' && !consumptionKey) {
            throw new Error('Continuation primary requires one exact reservation binding.');
          }
          const admissionEvents = [...admission.preparationEvents, ...admission.dispatchEvents].map(
            (event): RuntimeEvent =>
              consumptionKey &&
              (event.type === 'resource_budget.reserved' ||
                event.type === 'resource_budget.dispatch_started')
                ? { ...event, normalReprepareConsumptionKey: consumptionKey }
                : event,
          );
          if (consumptionKey) {
            admissionEvents.push({
              type: 'context.normal_reprepare_consumed_v1',
              consumptionKey,
            });
          }
          if (
            admissionEvents.length > 0 &&
            !kernel.applyEffectResult(admittedModelLease, admissionEvents)
          ) {
            continue;
          }
          yield* admissionEvents;
        } else if (atomicSummaryAdmission) {
          admittedSummaryLease = kernel.beginEffect(admission.effect);
          admittedSummaryGuard = new ProviderDispatchEntryGuardV1();
          const summaryEffect = admission.effect as Extract<
            import('./effects').RuntimeEffect,
            { type: 'compact_context' }
          >;
          const reservationId = admission.reservationIds[0];
          if (!reservationId || admission.reservationIds.length !== 1) {
            throw new Error('Summary dispatch requires exactly one resource reservation.');
          }
          const startBatchKey = createSummaryStartBatchKeyV1({
            state: kernel.getState(),
            effectLeaseId: admittedSummaryLease.effectId,
            resourceReservationId: reservationId,
            expectedMaxOutputTokens: summaryEffect.resourceEstimate?.maxOutputTokens ?? 6_000,
            ...(summaryEffect.summaryRequest
              ? { attemptOverride: summaryEffect.summaryRequest.attempt }
              : {}),
          });
          const admissionEvents = [
            ...(summaryEffect.summaryRequest ? [summaryEffect.summaryRequest] : []),
            ...admission.preparationEvents,
            ...admission.dispatchEvents,
          ].map(
            (event): RuntimeEvent =>
              event.type === 'resource_budget.reserved' ||
              event.type === 'resource_budget.dispatch_started'
                ? { ...event, summaryStartBatchKey: startBatchKey }
                : event,
          );
          const started: RuntimeEvent = {
            type: 'context.summary_dispatch_started_v1',
            attemptId: startBatchKey.attemptId,
            startBatchKey,
          };
          const startEvents = [...admissionEvents, started];
          if (!kernel.applyEffectResult(admittedSummaryLease, startEvents)) continue;
          kernel.registerSummaryDispatchEntryGuard(admittedSummaryLease, admittedSummaryGuard);
          yield* startEvents;
        } else if (admission.dispatchEvents.length > 0) {
          kernel.processEventBatch(admission.dispatchEvents);
          yield* admission.dispatchEvents;
        }
        effect = admittedModelLease?.effect ?? admittedSummaryLease?.effect ?? admission.effect;
        reservationIds = admission.reservationIds;
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
        try {
          const requested = provider.requestAction(effect, kernel.getState()).then(
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
            if (backgroundStopped) return;
          }
          if (!resolved.ok) throw resolved.error;
          action = resolved.value;
        } catch (error) {
          if (effect.type === 'request_provider_action') {
            action = {
              type: 'provider_action_result',
              interactionId: effect.interactionId,
              outcome: 'failed',
              failureCode: 'unknown',
            };
          } else if (effect.type === 'request_provider_admission') {
            action = {
              type: 'provider_admission_decision',
              interactionId: effect.interactionId,
              decision: { kind: 'cancel' },
            };
          } else {
            throw error;
          }
        }
        const actionResult = kernel.applyAction(
          action,
          effect.type === 'request_provider_action'
            ? reconciliationEventsForReservationsV1(
                kernel.getState() as import('./state').RuntimeState,
                reservationIds,
              )
            : [],
        );
        if (actionResult.status !== 'applied') {
          // Stale UI actions are expected during cancellation/session-switch races.
          // They are recorded by the runtime logger but must not become user errors.
          yield actionResult.telemetry;
          continue;
        }
        const events = actionResult.events;
        // Cancelling either execution authorization barrier ends the turn.
        // Declining ask_user remains a normal tool result, so the model can
        // continue without the optional answer.
        const executionAuthorizationCancelled =
          (effect.type === 'request_tool_approval' &&
            (action.type === 'reject' || action.type === 'cancel')) ||
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
              outcome: failedTerminalOutcomeV1(failure, {
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
      const lease = admittedModelLease ?? admittedSummaryLease ?? kernel.beginEffect(effect);
      const outcome = yield* executeEffectWithStreaming(
        kernel,
        executor,
        lease,
        reservationIds,
        admittedSummaryGuard,
      );
      if (!outcome.emitted) return;
      if (!outcome.applied) continue;
    }
    throw new Error(`Runtime effect limit (${maxEffects}) exceeded`);
  } finally {
    kernel.releaseRunner(runnerId);
  }
}
