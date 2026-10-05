import type { Command, Execution } from '@kite-ai/client';
import type { TuiMcpSnapshot } from './mcp';

export interface TuiMcpConnectionIntent {
  sessionId: string;
  workspaceId: string;
  workspaceIdentity: string;
  request: {
    expectedStoreId: string;
    commandId: string;
    kind: 'extension.invoke';
    extensionId: 'builtin.mcp';
    actionId: 'mcp.connect';
    definitionVersion: '1';
    input: { serverId: string; key: string };
  };
}
export interface TuiMcpConnectionExecution {
  id: string;
  originStoreId: string;
  sessionId: string;
  originCommandId: string;
  parentExecutionId: string | null;
  kind: 'job';
  definitionId: string;
  definitionVersion: string;
  status: Execution['status'];
}
export interface TuiMcpConnectionFact {
  storeId: string;
  sessionId: string;
  execution: TuiMcpConnectionExecution & { inputDigest: string };
  phase: 'pending' | 'ready' | 'failed' | 'outcome_unknown';
  operationRef: {
    childSessionId?: string;
    commandId: string;
    sessionId: string;
    originStoreId: string;
    extensionId: string;
    key: string;
    executionId: string | null;
  } | null;
  connection: TuiMcpConnectionExecution | null;
  ready: { serverId: string; configDigest: string; generation: number; toolCount: number } | null;
  live: boolean;
  currentGeneration: number | null;
  created: boolean | null;
  reason: string | null;
}
export interface TuiMcpConnectionOutcome {
  intent: TuiMcpConnectionIntent;
  phase: TuiMcpConnectionFact['phase'];
  command?: Command;
  fact?: TuiMcpConnectionFact;
}
export interface TuiMcpConnectionPort {
  list(): Promise<TuiMcpConnectionOutcome[]>;
  submit(
    intent: TuiMcpConnectionIntent,
    observed: TuiMcpSnapshot,
  ): Promise<TuiMcpConnectionOutcome>;
  lookup(intent: TuiMcpConnectionIntent, signal: AbortSignal): Promise<TuiMcpConnectionOutcome>;
}
