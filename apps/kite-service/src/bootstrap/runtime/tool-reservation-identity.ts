import type { RuntimeState } from './state-runtime';

type ToolReservation = Extract<
  RuntimeState['resourceBudget'],
  { status: 'active' }
>['reservations'][string];

/** Only live reservations named by this call's exact admission facts can authorize dispatch. */
export function resourceReservationBelongsToToolCall(
  state: Readonly<RuntimeState>,
  toolCallId: string,
  reservation: Readonly<ToolReservation>,
): boolean {
  if (reservation.state !== 'reserved' && reservation.state !== 'dispatch_started') return false;
  // Provider call IDs may themselves contain the suffix namespace. Without
  // an unambiguous owner, a sibling's bare invocation cannot fund this call.
  if (
    Object.keys(state.tools.calls).some(
      (otherCallId) =>
        otherCallId !== toolCallId && reservation.invocationId === `tool:${otherCallId}`,
    )
  )
    return false;
  const base = `tool:${toolCallId}`;
  if (reservation.invocationId === base) return true;
  const suspended = state.suspendedSubagents[toolCallId];
  if (suspended && reservation.invocationId === `${base}:resume:${suspended.parentAttempt}`)
    return true;
  return [...state.pendingApprovals.values()].some(
    (pending) =>
      pending.toolCallId === toolCallId &&
      pending.status === 'authorized_queued' &&
      pending.dispatchState === 'before_dispatch' &&
      pending.receiptId !== undefined &&
      reservation.invocationId === `${base}:approval:${pending.receiptId}`,
  );
}
