import type {
  State26RuntimeEffectExecutorV1,
  State26RuntimeEffectV1,
  State26RuntimeEventV1,
  State26RuntimeStateV1,
} from '@kite/runtime-host';
import type {
  RuntimeEffectLeaseExpectationV1,
  RuntimeSessionStoragePortV1,
} from '@kite/runtime-host/storage';

/** App-private names for the exact RMV1 State 25 Host boundary. */
export type RuntimeEffect = State26RuntimeEffectV1;
export type RuntimeEvent = State26RuntimeEventV1;
export type RuntimeState = State26RuntimeStateV1;
export type RuntimeEffectExecutor = State26RuntimeEffectExecutorV1<
  RuntimeState,
  RuntimeEvent,
  RuntimeEffect
>;
export type RuntimeEffectLeaseExpectation = RuntimeEffectLeaseExpectationV1;
export type State26SessionStorageV1 = RuntimeSessionStoragePortV1<RuntimeEvent, RuntimeState>;
