import type {
  RuntimeCommand,
  RuntimeCommandReceipt,
  RuntimeNotification,
  RuntimeQuery,
  RuntimeQueryResult,
} from '@kite-ai/runtime-contract';
import type { CapabilityExecutionPort, CapabilityRegistrySnapshot } from '@kite-ai/runtime-spi';
import type { RuntimeHostExecutionServices } from '../lifecycle/effect-supervisor';
import type { RuntimeCommandCommitEvidence } from '../storage';

export interface RuntimeHostPreparedExecution {
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

export interface RuntimeHostAcceptedCommand {
  /** Must equal the Host-derived target for create/fork, or command Session otherwise. */
  readonly targetSessionId: string;
  /**
   * The bridge may mutate only here. It must atomically persist the State
   * decision and supplied receipt evidence before resolving.
   */
  commit(evidence: RuntimeCommandCommitEvidence): Promise<{
    readonly receipt: Extract<RuntimeCommandReceipt, { readonly status: 'applied' }>;
    readonly activation?: (publish: (notification: RuntimeNotification) => void) => Promise<void>;
    readonly preparedExecution?: RuntimeHostPreparedExecution;
  }>;
}

export type RuntimeHostCommandInspection =
  | {
      readonly kind: 'terminal';
      readonly receipt: Exclude<RuntimeCommandReceipt, { readonly status: 'applied' }>;
    }
  | { readonly kind: 'accepted'; readonly decision: RuntimeHostAcceptedCommand };

/** Host-derived, content-free command target facts. Bridges must not derive them. */
export interface RuntimeHostCommandInspectionContext {
  readonly targetSessionId: string;
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
  /** Pure admission/plan phase. It must not mutate State, publish, or dispatch. */
  inspectCommand(
    command: RuntimeCommand,
    context: RuntimeHostCommandInspectionContext,
  ): Promise<RuntimeHostCommandInspection>;
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
