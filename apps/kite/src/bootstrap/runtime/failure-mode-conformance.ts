import {
  runtimeHostStateResolveFailureModeV1,
  STATE26_RUNTIME_FAILURE_MODES_V1,
  type StateFailureModeContextV1,
  type StateFailureModeDispositionV1,
  type StateFailureModeDurableStateV1,
  type StateFailureModeFallbackV1,
  type StateFailureModeResolutionV1,
  type StateRuntimeFailureModeV1,
} from '@kite/runtime-host';

/** App compatibility names over the Kernel-owned State failure-mode policy. */
export type RuntimeFailureModeV1 = StateRuntimeFailureModeV1;
export type FailureModeDispositionV1 = StateFailureModeDispositionV1;
export type FailureModeDurableStateV1 = StateFailureModeDurableStateV1;
export type FailureModeFallbackV1 = StateFailureModeFallbackV1;
export type FailureModeResolutionV1 = StateFailureModeResolutionV1;
export type FailureModeContextV1 = StateFailureModeContextV1;

export const RUNTIME_FAILURE_MODES_V1 = STATE26_RUNTIME_FAILURE_MODES_V1;
export const resolveFailureModeV1 = runtimeHostStateResolveFailureModeV1;
