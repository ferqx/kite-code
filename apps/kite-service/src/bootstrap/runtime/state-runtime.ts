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
  RuntimeCommandReceiptPort,
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
  /** Exact Store receipt lookup for idempotent Agent Tool command preflight. */
  readonly commandReceipts?: RuntimeCommandReceiptPort;
  /** Store 11 metadata only; private bodies require a separate execution-scoped reader. */
  readonly agentMailbox?: import('@kite-ai/runtime-storage-sqlite').KiteSessionAgentMailboxPort;
  /** Execution-scoped private input read, guarded by the current Store owner handle. */
  readonly agentMailInput?: import('@kite-ai/runtime-storage-sqlite').KiteSessionAgentMailInputPort;
  /** Actual Store controller generation for the current execution scope. */
  readonly currentExecutionGeneration?: (sessionId: string) => string;
  close(): void;
}
