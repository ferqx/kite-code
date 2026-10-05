import type { Command, Execution } from '@kite-ai/client';
import type { TuiCallerIntent, TuiCallerOutcome, TuiCallerRequest } from './caller';
import type { TuiMcpSourceSnapshot } from './mcp-source';
export type TuiMcpAuthAction =
  | 'mcp.auth.login'
  | 'mcp.auth.refresh'
  | 'mcp.auth.clear'
  | 'mcp.auth.revoke';
export interface TuiMcpAuthStatus {
  serverId: string;
  workspaceId: string;
  loginAllowed: boolean;
  policy: 'oauth' | 'auto';
  status: 'available' | 'locked' | 'unavailable';
  credentialPresent: boolean;
}
export interface TuiMcpAuthFact {
  storeId: string;
  sessionId: string;
  command: {
    id: string;
    originStoreId: string;
    sessionId: string;
    subjectId: string;
    requestDigest: string;
    status: Command['status'];
    executionId: string | null;
  } | null;
  execution: {
    id: string;
    originStoreId: string;
    sessionId: string;
    originCommandId: string;
    parentExecutionId: null;
    kind: 'job';
    definitionId: string;
    definitionVersion: string;
    inputDigest: string;
    status: Execution['status'];
  } | null;
  binding: {
    version: 1;
    executionId: string;
    originCommandId: string;
    originalStoreId: string;
    sessionId: string;
    workspaceId: string;
    actionId: TuiMcpAuthAction;
    serverId: string;
    inputDigest: string;
  } | null;
  phase: 'pending' | 'completed' | 'failed' | 'cancelled' | 'outcome_unknown';
  authStatus:
    | 'authenticated'
    | 'revoked'
    | 'not_supported'
    | 'reauth_required'
    | 'error'
    | 'cancelled'
    | 'unknown';
  effectAttempted: boolean | null;
  reason: string | null;
}
export interface TuiMcpAuthOutcome {
  intent: TuiCallerIntent;
  phase: TuiMcpAuthFact['phase'];
  fact?: TuiMcpAuthFact;
  caller?: TuiCallerOutcome;
}
export interface TuiMcpAuthPort {
  read(
    observed: TuiMcpSourceSnapshot,
    serverId: string,
    signal: AbortSignal,
  ): Promise<TuiMcpAuthStatus>;
  prepare(request: TuiCallerRequest, observed: TuiMcpSourceSnapshot): Promise<TuiCallerIntent>;
  submit(intent: TuiCallerIntent): Promise<TuiCallerOutcome>;
  lookup(intent: TuiCallerIntent, signal: AbortSignal): Promise<TuiMcpAuthOutcome>;
}
export function mcpAuthRequest(intent: TuiCallerIntent) {
  const request = intent.request;
  return request.kind === 'extension.invoke' &&
    request.extensionId === 'builtin.mcp.sources' &&
    request.definitionVersion === '1' &&
    ['mcp.auth.login', 'mcp.auth.refresh', 'mcp.auth.clear', 'mcp.auth.revoke'].includes(
      request.actionId,
    )
    ? request
    : undefined;
}
