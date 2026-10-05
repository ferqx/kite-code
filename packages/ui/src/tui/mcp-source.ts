import type { Command, Execution } from '@kite-ai/client';

export interface TuiMcpSourceIdentity {
  kind: 'user' | 'workspace';
  pathDigest: string;
  rootIdentity: string;
}
export interface TuiMcpSourceRead {
  identity: TuiMcpSourceIdentity;
  etag: string | null;
  error: string | null;
}
export interface TuiMcpSourceReadSet {
  scopeDigest: string;
  user: TuiMcpSourceRead;
  workspace: TuiMcpSourceRead | null;
  approvalEtag: string | null;
  bindingEtag: string | null;
  variablesDigest: string;
}
export interface TuiMcpSourceItem {
  id: string;
  name: string;
  source: TuiMcpSourceIdentity;
  rawEntryDigest: string;
  transportDigest: string | null;
  transport: 'http' | 'stdio' | null;
  enabled: boolean;
  admitted: boolean;
  reason: string | null;
  configDigest: string | null;
}
export interface TuiMcpSourceSnapshot {
  storeId: string;
  sessionId: string;
  workspaceId: string;
  workspaceIdentity: string;
  readSet: TuiMcpSourceReadSet | null;
  registryRevision: string | null;
  items: readonly TuiMcpSourceItem[];
  errors:
    | {
        user: string | null;
        workspace: string | null;
        approval: string | null;
        binding: string | null;
      }
    | readonly string[];
}
export interface TuiMcpSourceApprovalIntent {
  sessionId: string;
  workspaceId: string;
  workspaceIdentity: string;
  request: {
    expectedStoreId: string;
    commandId: string;
    kind: 'extension.invoke';
    extensionId: 'builtin.mcp.sources';
    actionId: 'mcp.source.approve';
    definitionVersion: '1';
    input: { serverId: string; expectedReadSet: TuiMcpSourceReadSet };
  };
}
export interface TuiMcpSourceDecisionProof {
  decisionId: string;
  storeId: string;
  sessionId: string;
  interactionId: string;
  acceptedRevision: string;
  subjectId: string;
  requestDigest: string;
  recordedAt: number;
}
export interface TuiMcpSourceApprovalFact {
  storeId: string;
  sessionId: string;
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
    kind: 'job';
    definitionId: string;
    definitionVersion: string;
    inputDigest: string;
    status: Execution['status'];
  } | null;
  serverId: string | null;
  phase: 'pending' | 'saved' | 'failed' | 'cancelled' | 'outcome_unknown';
  decision: 'approved' | 'rejected' | 'cancel' | null;
  proof: TuiMcpSourceDecisionProof | null;
  mutation: {
    id: string;
    originStoreId: string;
    subjectId: string;
    kind: 'config.user.write';
    scope: 'user';
    requestDigest: string;
    state: 'pending' | 'applied' | 'failed' | 'outcome_unknown';
    etag: string | null;
  } | null;
  recordKey: string | null;
  reason: string | null;
}
export interface TuiMcpSourceApprovalOutcome {
  intent: TuiMcpSourceApprovalIntent;
  phase: TuiMcpSourceApprovalFact['phase'];
  command?: Command;
  fact?: TuiMcpSourceApprovalFact;
}
export interface TuiMcpSourceApprovalPort {
  read(sessionId: string, signal: AbortSignal): Promise<TuiMcpSourceSnapshot>;
  list(): Promise<TuiMcpSourceApprovalOutcome[]>;
  submit(
    intent: TuiMcpSourceApprovalIntent,
    observed: TuiMcpSourceSnapshot,
  ): Promise<TuiMcpSourceApprovalOutcome>;
  lookup(
    intent: TuiMcpSourceApprovalIntent,
    signal: AbortSignal,
  ): Promise<TuiMcpSourceApprovalOutcome>;
}
