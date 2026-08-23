import {
  type AgentAuthorizationState,
  type ApprovalGrantV1,
  applyApprovalGrantV1,
  authorizationCommandGrantKeyV1,
} from '@kite/agent-kernel';
import type { WorkspaceAccess } from '@kite/runtime-contract';

export type StateAuthorizationStateV1 = AgentAuthorizationState;
export type StateApprovalGrantV1 = ApprovalGrantV1;
export type StateAuthorizationSourceV1 = 'user' | 'config' | 'test' | 'system';

/**
 * Canonical State 25 authorization normalization owned by Runtime Host.
 *
 * This is deliberately a thin Host composition wrapper around the Kernel
 * authorization shape.  It does not calculate policy or create a second
 * authorization identity.
 */
export function runtimeHostStateDefaultAuthorizationV1(): StateAuthorizationStateV1 {
  return { mode: 'default', commandGrants: {} };
}

export function runtimeHostStateNormalizeAuthorizationV1(
  authorization?: Readonly<StateAuthorizationStateV1> | null,
): StateAuthorizationStateV1 {
  return {
    mode: authorization?.mode === 'full_access' ? 'full_access' : 'default',
    ...(authorization?.modeSource ? { modeSource: authorization.modeSource } : {}),
    ...(authorization?.modeGrantedAt ? { modeGrantedAt: authorization.modeGrantedAt } : {}),
    commandGrants: authorization?.commandGrants ?? {},
  };
}

/** Apply a same-command grant through the sole Kernel authorization owner. */
export function runtimeHostStateGrantSameCommandV1(input: {
  readonly authorization?: Readonly<StateAuthorizationStateV1> | null;
  readonly workspace: string;
  readonly threadId: string;
  readonly command: string;
  readonly source?: StateAuthorizationSourceV1;
  readonly grantedAt?: string;
}): StateAuthorizationStateV1 {
  const command = input.command.trim();
  const authorization = runtimeHostStateNormalizeAuthorizationV1(input.authorization);
  if (!command) return authorization;
  return applyApprovalGrantV1({
    authorization,
    grant: 'same_command',
    workspace: input.workspace,
    threadId: input.threadId,
    command,
    source: input.source ?? 'user',
    grantedAt: input.grantedAt ?? new Date().toISOString(),
  });
}

export function runtimeHostStateHasSameCommandGrantV1(input: {
  readonly authorization?: Readonly<StateAuthorizationStateV1> | null;
  readonly workspace: string;
  readonly threadId: string;
  readonly command: string;
}): boolean {
  const authorization = runtimeHostStateNormalizeAuthorizationV1(input.authorization);
  const command = input.command.trim();
  if (!command) return false;
  const key = authorizationCommandGrantKeyV1({
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
export function runtimeHostStateDefaultPhaseForWorkspaceAccessV1(
  _workspaceAccess: WorkspaceAccess,
): 'planning' | 'building' {
  return 'building';
}

export const runtimeHostStateApplyApprovalGrantV1 = applyApprovalGrantV1;
export const runtimeHostStateAuthorizationCommandGrantKeyV1 = authorizationCommandGrantKeyV1;
