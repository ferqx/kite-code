import type { PermissionControlRead } from '../storage/port';
import { AgentError, type OwnerRef } from '../storage/types';

/** Owner-only invalidation of an unconsumed approval; never a synthetic answer. */
export interface RefreshApprovalInput {
  expectedStoreId: string;
  owner: OwnerRef;
  executionId: string;
  interactionId: string;
  policyRevision: string;
  controlReads?: readonly PermissionControlRead[];
}

export interface InvalidateAuthorizationCheckInput {
  expectedStoreId: string;
  owner: OwnerRef;
  executionId: string;
  /** Exact check, or the exact original policy when its in-flight reference is not returned yet. */
  checkExecutionId?: string;
  previousPolicyRevision: string;
  policyRevision: string;
  controlReads?: readonly PermissionControlRead[];
}

/** Only pre-dispatch authorization boundaries may restart on this error. */
export class AuthorizationRefreshRequired extends AgentError {
  constructor() {
    super('authorization_refresh_required');
  }
}

export type AuthorizationChangeWait = (
  cursor: string,
  signal: AbortSignal,
  timeoutMs: number,
) => Promise<unknown>;

export function modeControlsChanged(
  previous: readonly PermissionControlRead[] | undefined,
  current: readonly PermissionControlRead[] | undefined,
): boolean {
  return (
    !!previous?.some(
      (read) =>
        read.kind === 'permission.mode' &&
        current?.some(
          (next) =>
            next.kind === read.kind && next.scope === read.scope && next.revision !== read.revision,
        ),
    ) &&
    !previous.some(
      (read) =>
        read.kind === 'workspace.trust' &&
        !current?.some(
          (next) =>
            next.kind === read.kind && next.scope === read.scope && next.revision === read.revision,
        ),
    )
  );
}
