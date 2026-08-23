import {
  runtimeHostStateResolveFailureMode,
  STATE_RUNTIME_FAILURE_MODES_,
  type StateFailureModeContext,
  type StateFailureModeDisposition,
  type StateFailureModeDurableState,
  type StateFailureModeFallback,
  type StateFailureModeResolution,
  type StateRuntimeFailureMode,
} from '@kite/runtime-host';

/** App compatibility names over the Kernel-owned State failure-mode policy. */
export type RuntimeFailureMode = StateRuntimeFailureMode;
export type FailureModeDisposition = StateFailureModeDisposition;
export type FailureModeDurableState = StateFailureModeDurableState;
export type FailureModeFallback = StateFailureModeFallback;
export type FailureModeResolution = StateFailureModeResolution;
export type FailureModeContext = StateFailureModeContext;

export const RUNTIME_FAILURE_MODES_ = STATE_RUNTIME_FAILURE_MODES_;
export const resolveFailureMode = runtimeHostStateResolveFailureMode;
