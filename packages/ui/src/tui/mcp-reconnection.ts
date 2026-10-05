import type { Command } from '@kite-ai/client';
import type { TuiMcpSnapshot } from './mcp';
import type { TuiMcpConnectionExecution, TuiMcpConnectionIntent } from './mcp-connection';
import type { TuiMcpSourceReadSet, TuiMcpSourceSnapshot } from './mcp-source';

export interface TuiMcpReconnectionTarget {
  carrierExecutionId: string;
  carrierKey: string;
  operationRef: {
    commandId: string;
    sessionId: string;
    originStoreId: string;
    extensionId: 'builtin.mcp';
    key: string;
    executionId: string;
  };
  connectionExecutionId: string;
  configDigest: string;
  currentGeneration: number;
}
export type TuiMcpReconnectionReplacement =
  | { kind: 'static'; expectedConfigDigest: string }
  | {
      kind: 'source';
      expectedConfigDigest: string;
      expectedReadSet: TuiMcpSourceReadSet;
    };
export interface TuiMcpReconnectionInput {
  serverId: string;
  key: string;
  target: TuiMcpReconnectionTarget;
  replacement: TuiMcpReconnectionReplacement;
}
export interface TuiMcpReconnectionRequest {
  expectedStoreId: string;
  commandId: string;
  kind: 'extension.invoke';
  extensionId: 'builtin.mcp';
  actionId: 'mcp.reconnect';
  definitionVersion: '1';
  input: TuiMcpReconnectionInput;
}
export type TuiMcpReconnectionTargetRequest =
  | TuiMcpConnectionIntent['request']
  | TuiMcpReconnectionRequest;
/** One original request; prior reconnection intents are not nested here. */
export interface TuiMcpReconnectionCarrier {
  sessionId: string;
  workspaceId: string;
  workspaceIdentity: string;
  request: TuiMcpReconnectionTargetRequest;
}
export interface TuiMcpReconnectionIntent {
  sessionId: string;
  workspaceId: string;
  workspaceIdentity: string;
  targetRequest: TuiMcpReconnectionTargetRequest;
  request: TuiMcpReconnectionRequest;
}
export interface TuiMcpReconnectionFact {
  storeId: string;
  sessionId: string;
  execution: TuiMcpConnectionExecution & { inputDigest: string };
  phase: 'pending' | 'ready' | 'failed' | 'cancelled' | 'outcome_unknown';
  target: TuiMcpReconnectionTarget | null;
  oldStop: {
    confirmed: boolean;
    execution: (TuiMcpConnectionExecution & { resultRevision: string }) | null;
  };
  newOperationRef: TuiMcpReconnectionTarget['operationRef'] | null;
  newConnection: TuiMcpConnectionExecution | null;
  ready: { serverId: string; configDigest: string; generation: number; toolCount: number } | null;
  live: boolean;
  currentGeneration: number | null;
  reason: string | null;
}
export interface TuiMcpReconnectionOutcome {
  intent: TuiMcpReconnectionIntent;
  phase: TuiMcpReconnectionFact['phase'];
  command?: Command;
  fact?: TuiMcpReconnectionFact;
}
/** Current review facts only. A saved observation gives no POST or transport permit. */
export interface TuiMcpReconnectionObservation {
  carrier: TuiMcpReconnectionCarrier;
  target: TuiMcpReconnectionTarget;
  replacement: TuiMcpReconnectionReplacement;
  management: TuiMcpSnapshot;
  source: TuiMcpSourceSnapshot | null;
}
export interface TuiMcpReconnectionPort {
  list(): Promise<TuiMcpReconnectionOutcome[]>;
  observe(
    carrier: TuiMcpReconnectionCarrier,
    signal: AbortSignal,
  ): Promise<TuiMcpReconnectionObservation>;
  submit(
    intent: TuiMcpReconnectionIntent,
    observed: TuiMcpReconnectionObservation,
  ): Promise<TuiMcpReconnectionOutcome>;
  lookup(intent: TuiMcpReconnectionIntent, signal: AbortSignal): Promise<TuiMcpReconnectionOutcome>;
}
