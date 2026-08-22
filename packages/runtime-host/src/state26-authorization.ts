import {
  type AgentAuthorizationState,
  type ApprovalGrantV1,
  applyApprovalGrantV1,
  authorizationCommandGrantKeyV1,
} from '@kite/agent-kernel';
import type { WorkspaceAccess } from '@kite/runtime-contract';

export type State26AuthorizationStateV1 = AgentAuthorizationState;
export type State26ApprovalGrantV1 = ApprovalGrantV1;
export type State26AuthorizationSourceV1 = 'user' | 'config' | 'test' | 'system';

/**
 * Canonical State 25 authorization normalization owned by Runtime Host.
 *
 * This is deliberately a thin Host composition wrapper around the Kernel
 * authorization shape.  It does not calculate policy or create a second
 * authorization identity.
 */
export function runtimeHostState26DefaultAuthorizationV1(): State26AuthorizationStateV1 {
  return { mode: 'default', commandGrants: {} };
}

export function runtimeHostState26NormalizeAuthorizationV1(
  authorization?: Readonly<State26AuthorizationStateV1> | null,
): State26AuthorizationStateV1 {
  return {
    mode: authorization?.mode === 'full_access' ? 'full_access' : 'default',
    ...(authorization?.modeSource ? { modeSource: authorization.modeSource } : {}),
    ...(authorization?.modeGrantedAt ? { modeGrantedAt: authorization.modeGrantedAt } : {}),
    commandGrants: authorization?.commandGrants ?? {},
  };
}

/** Apply a same-command grant through the sole Kernel authorization owner. */
export function runtimeHostState26GrantSameCommandV1(input: {
  readonly authorization?: Readonly<State26AuthorizationStateV1> | null;
  readonly workspace: string;
  readonly threadId: string;
  readonly command: string;
  readonly source?: State26AuthorizationSourceV1;
  readonly grantedAt?: string;
}): State26AuthorizationStateV1 {
  const command = input.command.trim();
  const authorization = runtimeHostState26NormalizeAuthorizationV1(input.authorization);
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

export function runtimeHostState26HasSameCommandGrantV1(input: {
  readonly authorization?: Readonly<State26AuthorizationStateV1> | null;
  readonly workspace: string;
  readonly threadId: string;
  readonly command: string;
}): boolean {
  const authorization = runtimeHostState26NormalizeAuthorizationV1(input.authorization);
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
export function runtimeHostState26DefaultPhaseForWorkspaceAccessV1(
  _workspaceAccess: WorkspaceAccess,
): 'planning' | 'building' {
  return 'building';
}

export const runtimeHostState26ApplyApprovalGrantV1 = applyApprovalGrantV1;
export const runtimeHostState26AuthorizationCommandGrantKeyV1 = authorizationCommandGrantKeyV1;
