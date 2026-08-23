import type {
  StateRuntimeEffectExecutorV1,
  StateRuntimeEffectV1,
  StateRuntimeEventV1,
  StateRuntimeStateV1,
} from '@kite/runtime-host';
import type {
  RuntimeEffectLeaseExpectationV1,
  RuntimeSessionStoragePortV1,
} from '@kite/runtime-host/storage';

/** App-private names for the exact RMV1 State 25 Host boundary. */
export type RuntimeEffect = StateRuntimeEffectV1;
export type RuntimeEvent = StateRuntimeEventV1;
export type RuntimeState = StateRuntimeStateV1;
export type RuntimeEffectExecutor = StateRuntimeEffectExecutorV1<
  RuntimeState,
  RuntimeEvent,
  RuntimeEffect
>;
export type RuntimeEffectLeaseExpectation = RuntimeEffectLeaseExpectationV1;
export type StateSessionStorageV1 = RuntimeSessionStoragePortV1<RuntimeEvent, RuntimeState>;
