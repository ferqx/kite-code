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

/** Generic Host bindings over deterministic State26 terminal and failure-mode policy. */
export type State26RunTerminalOutcomeV1 = RunTerminalOutcomeV1;
export type State26RuntimeTerminalStatusV1 = RuntimeTerminalStatusV1;
export type State26FailureModeContextV1 = FailureModeContextV1;
export type State26FailureModeDispositionV1 = FailureModeDispositionV1;
export type State26FailureModeDurableStateV1 = FailureModeDurableStateV1;
export type State26FailureModeFallbackV1 = FailureModeFallbackV1;
export type State26FailureModeResolutionV1 = FailureModeResolutionV1;
export type State26RuntimeFailureModeV1 = RuntimeFailureModeV1;

export const STATE26_RUNTIME_FAILURE_MODES_V1 = RUNTIME_FAILURE_MODES_V1;
export const runtimeHostState26CompletedTerminalOutcomeV1 = completedTerminalOutcomeV1;
export const runtimeHostState26FailedTerminalOutcomeV1 = failedTerminalOutcomeV1;
export const runtimeHostState26NormalizeTerminalRuntimeEventV1 = normalizeTerminalRuntimeEventV1;
export const runtimeHostState26ResolveFailureModeV1 = resolveFailureModeV1;
