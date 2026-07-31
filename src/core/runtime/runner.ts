import { ProviderDataAdmissionError } from '@/core/config/provider-data-admission';
import type { RuntimeUserAction } from './actions';
import type { RuntimeEvent } from './events';
import { classifyFailure } from './failures';
import type { AgentKernel, RuntimeEffectExecutor } from './kernel';
import {
  planRuntimeBudgetAdmissionV1,
  type RuntimeBudgetAdmissionReasonV1,
  reconciliationEventsForReservationsV1,
} from './resource-budget-admission';
import { decideNextEffect } from './scheduler';
import { completedTerminalOutcomeV1, failedTerminalOutcomeV1 } from './terminal-outcome';

export interface RuntimeActionProvider {
  requestAction(
    effect: Extract<import('./effects').RuntimeEffect, { interactionId: string }>,
    state: Readonly<import('./state').RuntimeState>,
  ): Promise<RuntimeUserAction>;
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

function isEphemeralModelDelta(
  event: RuntimeEvent,
): event is Extract<
  RuntimeEvent,
  { type: 'model.reasoning_delta' | 'model.reasoning_completed' | 'model.text_delta' }
> {
  return (
    event.type === 'model.reasoning_delta' ||
    event.type === 'model.reasoning_completed' ||
    event.type === 'model.text_delta'
  );
}

/** Execute an effect while forwarding events produced during the effect. */
async function* executeEffectWithStreaming(
  kernel: AgentKernel,
  executor: RuntimeEffectExecutor,
  lease: import('./effects').RuntimeEffectLease,
  reservationIds: string[] = [],
): AsyncGenerator<RuntimeEvent, EffectExecutionOutcome> {
  const pending: Array<{
    event: RuntimeEvent;
    resolve?: (applied: boolean) => void;
    reject?: (error: unknown) => void;
  }> = [];
  let wake: (() => void) | null = null;
  let settled = false;
  let result: RuntimeEvent[] = [];
  let failure: unknown;

  const enqueue = (
    event: RuntimeEvent,
    resolve?: (applied: boolean) => void,
    reject?: (error: unknown) => void,
  ) => {
    pending.push({ event, resolve, reject });
    wake?.();
    wake = null;
  };
  const execution = executor(
    lease.effect,
    kernel.getState(),
    (event) => {
      enqueue(event);
    },
    {
      reservationIds,
      persistEvent: (event) =>
        new Promise<boolean>((resolve, reject) => {
          enqueue(event, resolve, reject);
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
      const event = pendingEvent.event;
      emitted = true;
      if (isEphemeralModelDelta(event)) {
        const applied = kernel.isEffectLeaseCurrent(lease);
        pendingEvent.resolve?.(applied);
        if (applied) yield event;
      } else {
        if (event.type === 'runtime.cancellation_diagnostic') {
          cancellationIncomplete = true;
        }
        try {
          const applied = kernel.applyEffectEvent(lease, event);
          pendingEvent.resolve?.(applied);
          if (applied) {
            yield event;
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

  const reconciled = reconciliationEventsForReservationsV1(
    kernel.getState() as import('./state').RuntimeState,
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
  ) => Promise<import('./effects').RuntimeEffect> | import('./effects').RuntimeEffect,
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
      if (prepareEffect) effect = await prepareEffect(effect, kernel.getState());
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
      if (kernel.getState().resourceBudget.status === 'active') {
        const admission = planRuntimeBudgetAdmissionV1(
          kernel.getState() as import('./state').RuntimeState,
          effect,
        );
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
          const failureEvent = resourceAdmissionFailureEvent(
            admission.reason,
            kernel.getState().turn.turnId,
          );
          const terminalEvents = resourceAdmissionTerminalEvents(
            kernel.getState() as import('./state').RuntimeState,
            failureEvent,
          );
          kernel.processEventBatch(terminalEvents);
          yield* terminalEvents;
          return;
        }
        if (admission.status === 'denied') {
          const failureEvent = resourceAdmissionFailureEvent(
            admission.reason,
            kernel.getState().turn.turnId,
          );
          const terminalEvents = resourceAdmissionTerminalEvents(
            kernel.getState() as import('./state').RuntimeState,
            failureEvent,
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
      const lease = kernel.beginEffect(effect);
      const outcome = yield* executeEffectWithStreaming(kernel, executor, lease, reservationIds);
      if (!outcome.emitted) return;
      if (!outcome.applied) continue;
    }
    throw new Error(`Runtime effect limit (${maxEffects}) exceeded`);
  } finally {
    kernel.releaseRunner(runnerId);
  }
}

function resourceAdmissionFailureEvent(
  reason: RuntimeBudgetAdmissionReasonV1,
  turnId: string,
): Extract<RuntimeEvent, { type: 'run.error' }> {
  const failureKind =
    reason === 'budget_unconfigured'
      ? 'mandatory_policy_unavailable'
      : reason === 'reconciliation_required'
        ? 'unknown'
        : reason === 'budget_exhausted'
          ? 'budget_exceeded'
          : 'resource_saturated';
  const failure = classifyFailure(failureKind, `Runtime resource admission denied: ${reason}.`);
  return {
    type: 'run.error',
    message: failure.message,
    recoverable: false,
    failure,
    turnId,
    outcome: failedTerminalOutcomeV1(failure, {
      knownExternalEffects: reason === 'reconciliation_required' ? 'unknown' : 'none',
      reasonCode:
        reason === 'tool_concurrency_saturated' || reason === 'shell_concurrency_saturated'
          ? reason
          : undefined,
    }),
  };
}

function resourceAdmissionTerminalEvents(
  state: import('./state').RuntimeState,
  failure: Extract<RuntimeEvent, { type: 'run.error' }>,
): RuntimeEvent[] {
  const waiterCancellations: RuntimeEvent[] =
    state.resourceBudget.status === 'active'
      ? Object.values(state.resourceBudget.waiters)
          .filter((waiter) => waiter.state === 'waiting')
          .map((waiter) => ({
            type: 'resource_budget.waiter_cancelled' as const,
            invocationId: waiter.invocationId,
          }))
      : [];
  return [
    failure,
    ...waiterCancellations,
    {
      type: 'turn.aborted',
      turnId: state.turn.turnId,
      reason: failure.message,
      cause: 'error',
    },
  ];
}
