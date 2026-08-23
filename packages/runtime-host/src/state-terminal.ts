import {
  completedTerminalOutcomeV1,
  type FailureModeContextV1,
  type FailureModeDispositionV1,
  type FailureModeDurableStateV1,
  type FailureModeFallbackV1,
  type FailureModeResolutionV1,
  failedTerminalOutcomeV1,
  normalizeTerminalRuntimeEventV1,
  RUNTIME_FAILURE_MODES_V1,
  type RunTerminalOutcomeV1,
  type RuntimeFailureModeV1,
  type RuntimeTerminalStatusV1,
  resolveFailureModeV1,
} from '@kite/agent-kernel';

/** Generic Host bindings over deterministic State terminal and failure-mode policy. */
export type StateRunTerminalOutcomeV1 = RunTerminalOutcomeV1;
export type StateRuntimeTerminalStatusV1 = RuntimeTerminalStatusV1;
export type StateFailureModeContextV1 = FailureModeContextV1;
export type StateFailureModeDispositionV1 = FailureModeDispositionV1;
export type StateFailureModeDurableStateV1 = FailureModeDurableStateV1;
export type StateFailureModeFallbackV1 = FailureModeFallbackV1;
export type StateFailureModeResolutionV1 = FailureModeResolutionV1;
export type StateRuntimeFailureModeV1 = RuntimeFailureModeV1;

export const STATE26_RUNTIME_FAILURE_MODES_V1 = RUNTIME_FAILURE_MODES_V1;
export const runtimeHostStateCompletedTerminalOutcomeV1 = completedTerminalOutcomeV1;
export const runtimeHostStateFailedTerminalOutcomeV1 = failedTerminalOutcomeV1;
export const runtimeHostStateNormalizeTerminalRuntimeEventV1 = normalizeTerminalRuntimeEventV1;
export const runtimeHostStateResolveFailureModeV1 = resolveFailureModeV1;
