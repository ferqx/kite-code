import type { Command } from '@kite-ai/client';
import type { TuiMcpSourceIdentity, TuiMcpSourceReadSet, TuiMcpSourceSnapshot } from './mcp-source';
export type TuiMcpSourceMutationInput =
  | {
      scope: 'user' | 'workspace';
      name: string;
      entry: { type: 'http'; url: string } | { type: 'stdio'; command: string };
      expectedReadSet: TuiMcpSourceReadSet;
    }
  | {
      scope: 'user' | 'workspace';
      serverId: string;
      expectedRawEntryDigest: string;
      expectedReadSet: TuiMcpSourceReadSet;
    };
export interface TuiMcpSourceMutationIntent {
  sessionId: string;
  workspaceId: string;
  workspaceIdentity: string;
  request: {
    expectedStoreId: string;
    commandId: string;
    kind: 'extension.invoke';
    extensionId: 'builtin.mcp.sources';
    actionId: 'mcp.source.add' | 'mcp.source.remove';
    definitionVersion: '1';
    input: TuiMcpSourceMutationInput;
  };
}
export interface TuiMcpSourceEntryDeclaration {
  serverId: string;
  name: string;
  source: TuiMcpSourceIdentity;
  rawEntryDigest: string;
  transport: 'http' | 'stdio' | null;
  enabled: boolean;
  reason: string | null;
}
export interface TuiMcpSourceEntryPreview {
  target: TuiMcpSourceEntryDeclaration;
  fallback: TuiMcpSourceEntryDeclaration | null;
}
export interface TuiMcpSourceMutationFact {
  storeId: string;
  sessionId: string;
  workspaceId: string | null;
  operation: 'add' | 'remove' | null;
  command: {
    id: string;
    originStoreId: string;
    sessionId: string;
    subjectId: string;
    kind: 'extension.invoke';
    requestDigest: string;
    status: Command['status'];
    executionId: string | null;
  } | null;
  execution: {
    id: string;
    originStoreId: string;
    sessionId: string;
    originCommandId: string;
    parentExecutionId: string | null;
    runId: string | null;
    kind: 'job';
    definitionId: string;
    definitionVersion: string;
    inputDigest: string;
    status: string;
  } | null;
  phase: 'pending' | 'saved' | 'failed' | 'cancelled' | 'outcome_unknown';
  mutation: {
    id: string;
    originStoreId: string;
    subjectId: string;
    kind: 'config.user.write' | 'config.workspace.write';
    scope: string;
    requestDigest: string;
    state: 'pending' | 'applied' | 'failed' | 'outcome_unknown';
    etag: string | null;
  } | null;
  receipt:
    | (TuiMcpSourceEntryPreview & {
        operationId: string;
        kind: 'add' | 'remove';
        oldEtag: string;
        newEtag: string;
      })
    | null;
  reason: string | null;
  /** Source saved proves only declaration publication. OAuth cleanup has its own result. */
  credentialCleanup?: {
    status: 'not_attempted' | 'not_needed' | 'completed' | 'failed' | 'outcome_unknown';
    attempted: boolean;
  };
}
export interface TuiMcpSourceMutationOutcome {
  intent: TuiMcpSourceMutationIntent;
  phase: TuiMcpSourceMutationFact['phase'];
  command?: Command;
  fact?: TuiMcpSourceMutationFact;
}
export interface TuiMcpSourceMutationPort {
  read(sessionId: string, signal: AbortSignal): Promise<TuiMcpSourceSnapshot>;
  preview(
    sessionId: string,
    input: { scope: 'user' | 'workspace'; serverId: string; expectedReadSet: TuiMcpSourceReadSet },
    signal: AbortSignal,
  ): Promise<TuiMcpSourceEntryPreview>;
  list(): Promise<TuiMcpSourceMutationOutcome[]>;
  submit(
    intent: TuiMcpSourceMutationIntent,
    observed: TuiMcpSourceSnapshot,
  ): Promise<TuiMcpSourceMutationOutcome>;
  lookup(
    intent: TuiMcpSourceMutationIntent,
    signal: AbortSignal,
  ): Promise<TuiMcpSourceMutationOutcome>;
}
