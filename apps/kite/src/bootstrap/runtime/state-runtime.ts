import type {
  StateRuntimeEffect,
  StateRuntimeEffectExecutor,
  StateRuntimeEvent,
  StateRuntimeState,
} from '@kite/runtime-host';
import type {
  RuntimeEffectLeaseExpectation as HostRuntimeEffectLeaseExpectation,
  RuntimeSessionStoragePort,
} from '@kite/runtime-host/storage';

/** App-private names for the exact RM State 25 Host boundary. */
export type RuntimeEffect = StateRuntimeEffect;
export type RuntimeEvent = StateRuntimeEvent;
export type RuntimeState = StateRuntimeState;
export type RuntimeEffectExecutor = StateRuntimeEffectExecutor<
  RuntimeState,
  RuntimeEvent,
  RuntimeEffect
>;
export type RuntimeEffectLeaseExpectation = HostRuntimeEffectLeaseExpectation;
export type StateSessionStorage = RuntimeSessionStoragePort<RuntimeEvent, RuntimeState>;
