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

/** Generic Host bindings over deterministic State25 terminal and failure-mode policy. */
export type State25RunTerminalOutcomeV1 = RunTerminalOutcomeV1;
export type State25RuntimeTerminalStatusV1 = RuntimeTerminalStatusV1;
export type State25FailureModeContextV1 = FailureModeContextV1;
export type State25FailureModeDispositionV1 = FailureModeDispositionV1;
export type State25FailureModeDurableStateV1 = FailureModeDurableStateV1;
export type State25FailureModeFallbackV1 = FailureModeFallbackV1;
export type State25FailureModeResolutionV1 = FailureModeResolutionV1;
export type State25RuntimeFailureModeV1 = RuntimeFailureModeV1;

export const STATE25_RUNTIME_FAILURE_MODES_V1 = RUNTIME_FAILURE_MODES_V1;
export const runtimeHostState25CompletedTerminalOutcomeV1 = completedTerminalOutcomeV1;
export const runtimeHostState25FailedTerminalOutcomeV1 = failedTerminalOutcomeV1;
export const runtimeHostState25NormalizeTerminalRuntimeEventV1 = normalizeTerminalRuntimeEventV1;
export const runtimeHostState25ResolveFailureModeV1 = resolveFailureModeV1;
