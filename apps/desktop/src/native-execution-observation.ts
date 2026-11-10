import type { NativeExecutionObservation, NativeState } from './native-bridge';

/** Match readonly facts to the exact reading; never manufacture a NativeSelection. */
export function nativeExecutionObservation(
  state:
    | Pick<NativeState, 'generation' | 'historyEpoch' | 'selection' | 'executionObservation'>
    | undefined,
): NativeExecutionObservation | undefined {
  const observation = state?.executionObservation,
    selection = state?.selection;
  return observation &&
    selection &&
    observation.generation === state.generation &&
    observation.historyEpoch === (state.historyEpoch ?? 0) &&
    observation.storeId === selection.storeId &&
    observation.sessionId === selection.session.id &&
    observation.workspaceId === selection.session.workspaceId &&
    observation.viewSelection === (selection.viewSelection ?? selection.viewGeneration)
    ? observation
    : undefined;
}
