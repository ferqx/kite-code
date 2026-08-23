import {
  type AgentAuthorizationState,
  type ApprovalGrant,
  applyApprovalGrant,
  authorizationCommandGrantKey,
} from '@kite/agent-kernel';
import type { WorkspaceAccess } from '@kite/runtime-contract';

export type StateAuthorizationState = AgentAuthorizationState;
export type StateApprovalGrant = ApprovalGrant;
export type StateAuthorizationSource = 'user' | 'config' | 'test' | 'system';

/**
 * Canonical State 25 authorization normalization owned by Runtime Host.
 *
 * This is deliberately a thin Host composition wrapper around the Kernel
 * authorization shape.  It does not calculate policy or create a second
 * authorization identity.
 */
export function runtimeHostStateDefaultAuthorization(): StateAuthorizationState {
  return { mode: 'default', commandGrants: {} };
}

export function runtimeHostStateNormalizeAuthorization(
  authorization?: Readonly<StateAuthorizationState> | null,
): StateAuthorizationState {
  return {
    mode: authorization?.mode === 'full_access' ? 'full_access' : 'default',
    ...(authorization?.modeSource ? { modeSource: authorization.modeSource } : {}),
    ...(authorization?.modeGrantedAt ? { modeGrantedAt: authorization.modeGrantedAt } : {}),
    commandGrants: authorization?.commandGrants ?? {},
  };
}

/** Apply a same-command grant through the sole Kernel authorization owner. */
export function runtimeHostStateGrantSameCommand(input: {
  readonly authorization?: Readonly<StateAuthorizationState> | null;
  readonly workspace: string;
  readonly threadId: string;
  readonly command: string;
  readonly source?: StateAuthorizationSource;
  readonly grantedAt?: string;
}): StateAuthorizationState {
  const command = input.command.trim();
  const authorization = runtimeHostStateNormalizeAuthorization(input.authorization);
  if (!command) return authorization;
  return applyApprovalGrant({
    authorization,
    grant: 'same_command',
    workspace: input.workspace,
    threadId: input.threadId,
    command,
    source: input.source ?? 'user',
    grantedAt: input.grantedAt ?? new Date().toISOString(),
  });
}

export function runtimeHostStateHasSameCommandGrant(input: {
  readonly authorization?: Readonly<StateAuthorizationState> | null;
  readonly workspace: string;
  readonly threadId: string;
  readonly command: string;
}): boolean {
  const authorization = runtimeHostStateNormalizeAuthorization(input.authorization);
  const command = input.command.trim();
  if (!command) return false;
  const key = authorizationCommandGrantKey({
    workspace: input.workspace,
    threadId: input.threadId,
    command,
  });
  const grant = authorization.commandGrants[key];
  return (
    grant !== undefined &&
    grant.workspace === input.workspace &&
    grant.threadId === input.threadId &&
    grant.command === command
  );
}

/** State 25 compatibility projection used when a caller has no explicit phase fact. */
export function runtimeHostStateDefaultPhaseForWorkspaceAccess(
  _workspaceAccess: WorkspaceAccess,
): 'planning' | 'building' {
  return 'building';
}

export const runtimeHostStateApplyApprovalGrant = applyApprovalGrant;
export const runtimeHostStateAuthorizationCommandGrantKey = authorizationCommandGrantKey;
