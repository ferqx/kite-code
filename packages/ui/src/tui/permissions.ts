import type {
  Change,
  ClearPermissionGrantsRequest,
  PermissionGrantPage,
  PermissionModeState,
  PermissionMutation,
  SessionView,
  SetPermissionModeRequest,
  SetWorkspaceTrustRequest,
  WorkspaceTrustState,
} from '@kite-ai/client';

/** A change is a reason to reread controls, never a replacement permission snapshot. */
export function permissionChangeAffectsSession(
  change: Change,
  view: SessionView | undefined,
  storeId: string,
): boolean {
  if (!view || view.storeId !== storeId || change.type !== 'host_control.changed') return false;
  const payload = change.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const receipt = payload.receipt;
  if (
    !receipt ||
    typeof receipt !== 'object' ||
    Array.isArray(receipt) ||
    receipt.status !== 'applied'
  )
    return false;
  if (payload.kind === 'workspace.trust')
    return change.sessionId === null && payload.scope === `workspace:${view.session.workspaceId}`;
  return (
    payload.kind === 'permission.mode' &&
    !!change.sessionId &&
    payload.scope === `session:${change.sessionId}` &&
    (change.sessionId === view.session.rootSessionId || receipt.makeDefault === true)
  );
}
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
