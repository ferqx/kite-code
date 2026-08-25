import type {
  RuntimeCommandReceipt,
  RuntimeNotification,
  RuntimeQuery,
  RuntimeQueryResult,
} from '@kite-ai/runtime-contract';
import type { CapabilityExecutionPort, CapabilityRegistrySnapshot } from '@kite-ai/runtime-spi';
import type { RuntimeHostKernelInput } from '../kernel-adapter/input';
import type { RuntimeHostExecutionServices } from '../lifecycle/effect-supervisor';

export interface RuntimeHostPreparedExecution {
  readonly receipt: RuntimeCommandReceipt;
  readonly execution?: {
    /** Exact Host-committed identity for this prepared dispatch. */
    readonly sessionId: string;
    readonly operationId: string;
    readonly committedRevision: number;
    readonly operation: 'turn' | 'compaction';
    readonly run: (signal: AbortSignal, requestAbort: (reason: string) => void) => Promise<void>;
    readonly cancel?: (reason: string) => void;
  };
}

/**
 * Temporary RM execution seam for work whose production owner has not moved
 * into Runtime Host yet. One Host receives exactly one bridge and never falls
 * back to a second implementation.
 */
export interface RuntimeHostExecutionBridge {
  recoverSession(
    sessionId: string,
    publish: (notification: RuntimeNotification) => void,
  ): Promise<void>;
  prepare(
    input: RuntimeHostKernelInput,
    publish: (notification: RuntimeNotification) => void,
  ): Promise<RuntimeHostPreparedExecution>;
  query(query: RuntimeQuery): Promise<RuntimeQueryResult>;
  shutdownSession(
    sessionId: string,
    reason: string,
    publish: (notification: RuntimeNotification) => void,
  ): Promise<void>;
  close(): Promise<void>;
}

export const RUNTIME_HOST_EXECUTION_ADAPTER_ID_ = 'kite.runtime-host.execution-bridge.v1';

export interface RuntimeHostExecutionAdapterContext<Event = unknown, State = unknown> {
  readonly services: RuntimeHostExecutionServices<Event, State>;
  readonly capabilities: CapabilityExecutionPort;
  /** Exact frozen snapshot shared by Host execution and the App catalog projection. */
  readonly capabilityRegistrySnapshot: CapabilityRegistrySnapshot;
}
