import type { TuiRuntimeAuthorityProjection, TuiState } from '../types';

export function isRuntimeAuthorityActive(
  authority: TuiRuntimeAuthorityProjection | undefined,
): boolean {
  const status = authority?.currentRun?.status;
  return (
    status === 'queued' ||
    status === 'running' ||
    status === 'waiting' ||
    status === 'recovery_required'
  );
}

export function isTuiRunActive(
  state: Pick<TuiState, 'runtimeAuthority' | 'runStartTime' | 'exited'>,
): boolean {
  // SET_RUNNING is a presentation-only admission marker for an idle prompt.
  // It intentionally precedes the next authoritative currentRun projection,
  // which may still describe the settled predecessor during the round trip.
  if (!state.exited && state.runStartTime !== undefined) return true;
  if (state.runtimeAuthority !== undefined) {
    return !state.exited && isRuntimeAuthorityActive(state.runtimeAuthority);
  }
  return false;
}
