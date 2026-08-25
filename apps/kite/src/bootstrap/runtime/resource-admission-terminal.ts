import type { RuntimeBudgetAdmissionReason } from '@kite/runtime-host/kernel-adapter';
import { runtimeHostStateResolveFailureMode as resolveFailureMode } from '@kite/runtime-host/kernel-adapter';
import { classifyFailure } from './failures';
import type { RuntimeEvent, RuntimeState } from './state-runtime';
import { failedTerminalOutcome, type RunTerminalOutcome } from './terminal-outcome';

/** Canonical production projection for both parent and descendant admission failures. */
export function resolveResourceAdmissionFailureOutcome(
  reason: RuntimeBudgetAdmissionReason,
  state: RuntimeState,
): RunTerminalOutcome {
  const reservationStates =
    state.resourceBudget.status === 'active'
      ? Object.values(state.resourceBudget.reservations).map((reservation) => reservation.state)
      : [];
  const knownExternalEffects = reservationStates.some(
    (reservationState) => reservationState === 'dispatch_started' || reservationState === 'unknown',
  )
    ? 'unknown'
    : reservationStates.some((reservationState) => reservationState === 'reconciled') ||
        (state.resourceBudget.status === 'active' &&
          (state.resourceBudget.reconciledUsage.counters.modelRequests > 0 ||
            state.resourceBudget.reconciledUsage.counters.toolInvocations > 0 ||
            state.resourceBudget.reconciledUsage.counters.artifactBytes > 0))
      ? 'known'
      : 'none';
  const conformanceMode =
    reason === 'budget_unconfigured'
      ? 'mandatory_admin_policy_unavailable'
      : reason === 'budget_exhausted'
        ? 'budget_exhausted'
        : reason === 'tool_concurrency_saturated'
          ? 'tool_permit_timeout'
          : reason === 'shell_concurrency_saturated'
            ? 'shell_permit_timeout'
            : undefined;
  const conformanceOutcome = conformanceMode
    ? resolveFailureMode(conformanceMode, { knownExternalEffects }).terminalOutcome
    : null;
  if (conformanceOutcome) return conformanceOutcome;
  if (reason === 'persistence_unavailable') {
    return failedTerminalOutcome(
      classifyFailure(
        'persistence_unavailable',
        'Runtime resource admission could not be persisted.',
      ),
      { knownExternalEffects },
    );
  }
  return failedTerminalOutcome(
    classifyFailure('unknown', `Runtime resource admission denied: ${reason}.`),
    { knownExternalEffects: 'unknown' },
  );
}

export function resourceAdmissionFailureEvent(
  reason: RuntimeBudgetAdmissionReason,
  state: RuntimeState,
): Extract<RuntimeEvent, { type: 'run.error' }> {
  const failureKind =
    reason === 'budget_unconfigured'
      ? 'mandatory_policy_unavailable'
      : reason === 'persistence_unavailable'
        ? 'persistence_unavailable'
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
    turnId: state.turn.turnId,
    outcome: resolveResourceAdmissionFailureOutcome(reason, state),
  };
}

export function resourceAdmissionTerminalEvents(
  state: RuntimeState,
  reason: RuntimeBudgetAdmissionReason,
): RuntimeEvent[] {
  const failure = resourceAdmissionFailureEvent(reason, state);
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
