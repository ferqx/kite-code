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
  if (state.runtimeAuthority !== undefined) {
    return !state.exited && isRuntimeAuthorityActive(state.runtimeAuthority);
  }
  return state.runStartTime !== undefined && !state.exited;
}
