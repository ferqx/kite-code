import {
  runtimeHostState25ResolveFailureModeV1,
  STATE25_RUNTIME_FAILURE_MODES_V1,
  type State25FailureModeContextV1,
  type State25FailureModeDispositionV1,
  type State25FailureModeDurableStateV1,
  type State25FailureModeFallbackV1,
  type State25FailureModeResolutionV1,
  type State25RuntimeFailureModeV1,
} from '@kite/runtime-host';

/** App compatibility names over the Kernel-owned State25 failure-mode policy. */
export type RuntimeFailureModeV1 = State25RuntimeFailureModeV1;
export type FailureModeDispositionV1 = State25FailureModeDispositionV1;
export type FailureModeDurableStateV1 = State25FailureModeDurableStateV1;
export type FailureModeFallbackV1 = State25FailureModeFallbackV1;
export type FailureModeResolutionV1 = State25FailureModeResolutionV1;
export type FailureModeContextV1 = State25FailureModeContextV1;

export const RUNTIME_FAILURE_MODES_V1 = STATE25_RUNTIME_FAILURE_MODES_V1;
export const resolveFailureModeV1 = runtimeHostState25ResolveFailureModeV1;
