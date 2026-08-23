import {
  completedTerminalOutcome,
  type FailureModeContext,
  type FailureModeDisposition,
  type FailureModeDurableState,
  type FailureModeFallback,
  type FailureModeResolution,
  failedTerminalOutcome,
  normalizeTerminalRuntimeEvent,
  RUNTIME_FAILURE_MODES_,
  type RunTerminalOutcome,
  type RuntimeFailureMode,
  type RuntimeTerminalStatus,
  resolveFailureMode,
} from '@kite/agent-kernel';

/** Generic Host bindings over deterministic State terminal and failure-mode policy. */
export type StateRunTerminalOutcome = RunTerminalOutcome;
export type StateRuntimeTerminalStatus = RuntimeTerminalStatus;
export type StateFailureModeContext = FailureModeContext;
export type StateFailureModeDisposition = FailureModeDisposition;
export type StateFailureModeDurableState = FailureModeDurableState;
export type StateFailureModeFallback = FailureModeFallback;
export type StateFailureModeResolution = FailureModeResolution;
export type StateRuntimeFailureMode = RuntimeFailureMode;

export const STATE_RUNTIME_FAILURE_MODES_ = RUNTIME_FAILURE_MODES_;
export const runtimeHostStateCompletedTerminalOutcome = completedTerminalOutcome;
export const runtimeHostStateFailedTerminalOutcome = failedTerminalOutcome;
export const runtimeHostStateNormalizeTerminalRuntimeEvent = normalizeTerminalRuntimeEvent;
export const runtimeHostStateResolveFailureMode = resolveFailureMode;
