import type {
  State25RuntimeEffectExecutorV1,
  State25RuntimeEffectV1,
  State25RuntimeEventV1,
  State25RuntimeStateV1,
} from '@kite/runtime-host';
import type {
  RuntimeEffectLeaseExpectationV1,
  RuntimeSessionStoragePortV1,
} from '@kite/runtime-host/storage';

/** App-private names for the exact RMV1 State 25 Host boundary. */
export type RuntimeEffect = State25RuntimeEffectV1;
export type RuntimeEvent = State25RuntimeEventV1;
export type RuntimeState = State25RuntimeStateV1;
export type RuntimeEffectExecutor = State25RuntimeEffectExecutorV1<
  RuntimeState,
  RuntimeEvent,
  RuntimeEffect
>;
export type RuntimeEffectLeaseExpectation = RuntimeEffectLeaseExpectationV1;
export type State25SessionStorageV1 = RuntimeSessionStoragePortV1<RuntimeEvent, RuntimeState>;
