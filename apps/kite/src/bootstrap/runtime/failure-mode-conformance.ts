import {
  runtimeHostState26ResolveFailureModeV1,
  STATE26_RUNTIME_FAILURE_MODES_V1,
  type State26FailureModeContextV1,
  type State26FailureModeDispositionV1,
  type State26FailureModeDurableStateV1,
  type State26FailureModeFallbackV1,
  type State26FailureModeResolutionV1,
  type State26RuntimeFailureModeV1,
} from '@kite/runtime-host';

/** App compatibility names over the Kernel-owned State26 failure-mode policy. */
export type RuntimeFailureModeV1 = State26RuntimeFailureModeV1;
export type FailureModeDispositionV1 = State26FailureModeDispositionV1;
export type FailureModeDurableStateV1 = State26FailureModeDurableStateV1;
export type FailureModeFallbackV1 = State26FailureModeFallbackV1;
export type FailureModeResolutionV1 = State26FailureModeResolutionV1;
export type FailureModeContextV1 = State26FailureModeContextV1;

export const RUNTIME_FAILURE_MODES_V1 = STATE26_RUNTIME_FAILURE_MODES_V1;
export const resolveFailureModeV1 = runtimeHostState26ResolveFailureModeV1;
