import type {
  ClearPermissionGrantsRequest,
  PermissionGrantPage,
  PermissionModeState,
  PermissionMutation,
  SetPermissionModeRequest,
  SetWorkspaceTrustRequest,
  WorkspaceTrustState,
} from '@kite-ai/client';
export type TuiPermissionIntent =
  | { kind: 'permission.mode'; sessionId: string; request: SetPermissionModeRequest }
  | { kind: 'permission.grants.clear'; sessionId: string; request: ClearPermissionGrantsRequest }
  | { kind: 'workspace.trust'; workspaceId: string; request: SetWorkspaceTrustRequest };
export interface TuiPermissionSnapshot {
  mode: PermissionModeState;
  trust: WorkspaceTrustState;
  grants: PermissionGrantPage;
}
export interface TuiPermissionOutcome {
  intent: TuiPermissionIntent;
  status: PermissionMutation['state'] | 'outcome_unknown';
  mutation?: PermissionMutation;
}
export interface TuiPermissionPort {
  read(sessionId: string, workspaceId: string, signal: AbortSignal): Promise<TuiPermissionSnapshot>;
  submit(intent: TuiPermissionIntent): Promise<TuiPermissionOutcome>;
  lookup(intent: TuiPermissionIntent): Promise<TuiPermissionOutcome>;
}
