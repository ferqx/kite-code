import type {
  RuntimeHostLeasePort,
  RuntimeHostTransactionPort,
  StateRuntimeEffect,
  StateRuntimeEvent,
  StateRuntimeState,
} from '@kite-ai/runtime-host';
import type { StateRuntimeEffectExecutor } from '@kite-ai/runtime-host/kernel-adapter';
import type {
  CheckpointPort,
  RuntimeEffectLeaseExpectation as HostRuntimeEffectLeaseExpectation,
  RuntimeRecoveryIdentityPort,
  SessionStore,
} from '@kite-ai/runtime-host/storage';

/** App-private names for the exact RM State 27 Host boundary. */
export type RuntimeEffect = StateRuntimeEffect;
export type RuntimeEvent = StateRuntimeEvent;
export type RuntimeState = StateRuntimeState;
export type RuntimeEffectExecutor = StateRuntimeEffectExecutor<
  RuntimeState,
  RuntimeEvent,
  RuntimeEffect
>;
export type RuntimeEffectLeaseExpectation = HostRuntimeEffectLeaseExpectation;
export interface StateRuntimeStorage {
  readonly sessions: SessionStore<RuntimeEvent, RuntimeState>;
  readonly transactions: RuntimeHostTransactionPort<RuntimeEvent, RuntimeState>;
  readonly effects: RuntimeHostLeasePort;
  readonly checkpoints: CheckpointPort<RuntimeState>;
  readonly recoveryIdentities: RuntimeRecoveryIdentityPort;
  close(): void;
}
