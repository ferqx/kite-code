import type { KernelEvent } from './events';
import type { AgentState } from './state';

export type State26ModelEvidenceFailureV1 = 'artifact_missing' | 'artifact_corrupt';

export interface State26RestartRecoveryFactsV1 {
  readonly capabilityFinishedAtByInvocationId: Readonly<Record<string, string | undefined>>;
  readonly pendingModelEvidenceFailures: Readonly<
    Record<string, State26ModelEvidenceFailureV1 | undefined>
  >;
  readonly completedModelEvidenceFailures: Readonly<
    Record<string, State26ModelEvidenceFailureV1 | undefined>
  >;
}

/** Exact capability intents which restart recovery must terminalize as unknown. */
export function state26RestartRecoveryCapabilityInvocationIdsV1(
  state: Readonly<AgentState>,
): readonly string[] {
  return Object.values(state.capabilities.invocations)
    .filter((invocation) => {
      if (invocation.status !== 'recorded' && invocation.status !== 'running') return false;
      if (
        invocation.subagentProviderLifecycle &&
        invocation.subagentProviderLifecycle.status !== 'cleanup_completed'
      ) {
        return false;
      }
      if (state.suspendedSubagents[invocation.toolCallId]) return false;
      const suspendedCall = state.tools.calls[invocation.toolCallId];
      return !(
        suspendedCall &&
        (suspendedCall.status === 'awaiting_review' ||
          suspendedCall.status === 'awaiting_approval' ||
          suspendedCall.status === 'awaiting_auto_review' ||
          suspendedCall.status === 'awaiting_user_input')
      );
    })
    .map((invocation) => invocation.invocationId);
}

/**
 * Project the current State26 restart policy from canonical Host/Builtin
 * evidence facts. This function performs no I/O and owns no artifact reader.
 */
export function projectState26RestartRecoveryEventsV1(
  state: Readonly<AgentState>,
  facts: State26RestartRecoveryFactsV1,
): readonly KernelEvent[] {
  const events: KernelEvent[] = [];
  const capabilityRecoveryIds = new Set(state26RestartRecoveryCapabilityInvocationIdsV1(state));
  for (const invocation of Object.values(state.capabilities.invocations)) {
    if (!capabilityRecoveryIds.has(invocation.invocationId)) continue;
    const finishedAt = facts.capabilityFinishedAtByInvocationId[invocation.invocationId];
    if (
      finishedAt === undefined ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(finishedAt)
    ) {
      throw new Error(
        `State26 restart recovery requires a valid Host timestamp for ${invocation.invocationId}.`,
      );
    }
    events.push({
      type: 'capability.execution_unknown',
      invocationId: invocation.invocationId,
      reason: 'Runtime recovered after invocation intent was persisted without a terminal result.',
      finishedAt,
    });
  }

  const evidenceUncertainReservations = new Set<string>();
  for (const invocation of Object.values(state.modelInvocations)) {
    if (invocation.status === 'completed' && !invocation.modelEvidenceUnavailable) {
      const evidenceFailure = facts.completedModelEvidenceFailures[invocation.invocationId];
      if (evidenceFailure) {
        events.push({
          type: 'model.invocation_evidence_unavailable',
          invocationId: invocation.invocationId,
          reasonCode: evidenceFailure,
        });
      }
      continue;
    }
    if (invocation.status !== 'prepared' && invocation.status !== 'dispatching') continue;
    events.push({
      type: 'model.invocation_interrupted',
      invocationId: invocation.invocationId,
      dispatchCertainty: invocation.status === 'prepared' ? 'none' : 'unknown',
      reasonCode: 'runtime_restored',
    });
    if (
      invocation.status === 'dispatching' &&
      facts.pendingModelEvidenceFailures[invocation.invocationId] &&
      invocation.budget.kind === 'reservation'
    ) {
      evidenceUncertainReservations.add(invocation.budget.reservationId);
    }
  }

  if (state.resourceBudget.status === 'active') {
    for (const reservation of Object.values(state.resourceBudget.reservations)) {
      if (reservation.state === 'reserved') {
        events.push(
          evidenceUncertainReservations.has(reservation.reservationId)
            ? { type: 'resource_budget.unknown', reservationId: reservation.reservationId }
            : { type: 'resource_budget.released', reservationId: reservation.reservationId },
        );
      } else if (reservation.state === 'dispatch_started') {
        events.push({ type: 'resource_budget.unknown', reservationId: reservation.reservationId });
      }
    }
    if (state.turn.status !== 'active') {
      for (const waiter of Object.values(state.resourceBudget.waiters ?? {})) {
        if (waiter.state !== 'waiting') continue;
        events.push({
          type: 'resource_budget.waiter_cancelled',
          invocationId: waiter.invocationId,
        });
      }
    }
  }
  return events;
}
