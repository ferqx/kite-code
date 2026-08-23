import type { PendingToolRequest } from '@kite/builtin-runtime';
import type {
  AgentPhase,
  ShellApprovalGrant,
  ToolApprovalPayload,
  WorkspaceAccess,
} from '@kite/runtime-contract';
import {
  runtimeHostStateApplyApprovalGrant,
  runtimeHostStateAuthorizationCommandGrantKey,
  runtimeHostStateDefaultAuthorization,
  runtimeHostStateGrantSameCommand,
  runtimeHostStateHasSameCommandGrant,
  runtimeHostStateNormalizeAuthorization,
  type StateAuthorizationSource,
  type StateAuthorizationState,
  type StateToolGovernancePolicyFact,
} from '@kite/runtime-host';

/** App-only presentation bridge; authorization identity remains Kernel-owned. */
export function buildToolApproval(input: {
  workspace: string;
  threadId: string;
  request: PendingToolRequest;
  decision: Pick<
    StateToolGovernancePolicyFact,
    'risk' | 'userVisibleSummary' | 'reason' | 'expectedEffects'
  >;
  /** Kernel-computed exact invocation/policy binding for this approval. */
  approvalBindingDigest: string;
  capability?: {
    capabilityId: string;
    capabilityRevision: string;
    effectiveEffects: unknown;
  };
}): ToolApprovalPayload {
  const grantOptions: ShellApprovalGrant[] =
    input.request.name === 'shell_execute'
      ? ['approve_once', 'same_command', 'full_access']
      : ['approve_once'];
  return {
    scope: 'once',
    ...(input.request.id ? { callId: input.request.id } : {}),
    cwd: input.workspace,
    threadId: input.threadId,
    tool: input.request.name,
    command: approvalCommand(input.request),
    risk: input.decision.risk,
    approvalHash: input.approvalBindingDigest,
    summary: input.decision.userVisibleSummary,
    reason: input.decision.reason,
    expectedEffects: input.decision.expectedEffects,
    grantOptions,
    recommendedGrant: 'approve_once',
  };
}

export function validateApprovalHash(
  resume: { approvalHash?: string },
  expectedHash: string,
): boolean {
  return resume.approvalHash === expectedHash;
}

export function replaceApprovalCommand(
  request: PendingToolRequest,
  replacementCommand: string,
): PendingToolRequest {
  const command = replacementCommand.trim();
  if (!command) throw new Error('Replacement command must not be empty.');
  if (request.name !== 'shell_execute') {
    throw new Error(`Tool ${request.name} does not support command replacement.`);
  }
  return { ...request, args: { ...request.args, command }, protectedCommand: command };
}

/** Compatibility exports delegate to the sole Runtime Host/Kernel authorization owner. */
export function defaultAuthorizationState(): StateAuthorizationState {
  return runtimeHostStateDefaultAuthorization();
}

export function normalizeAuthorizationState(
  authorization?: Readonly<StateAuthorizationState> | null,
): StateAuthorizationState {
  return runtimeHostStateNormalizeAuthorization(authorization);
}

export function commandGrantKey(input: {
  workspace: string;
  threadId: string;
  command: string;
}): string {
  return runtimeHostStateAuthorizationCommandGrantKey(input);
}

export function grantSameCommand(
  authorization: StateAuthorizationState | null | undefined,
  input: {
    workspace: string;
    threadId: string;
    command: string;
    source?: StateAuthorizationSource;
  },
): StateAuthorizationState {
  return runtimeHostStateGrantSameCommand({ authorization, ...input });
}

export function hasSameCommandGrant(
  authorization: StateAuthorizationState | null | undefined,
  input: { workspace: string; threadId: string; command: string },
): boolean {
  return runtimeHostStateHasSameCommandGrant({ authorization, ...input });
}

export function applyApprovalGrant(input: {
  authorization: StateAuthorizationState | null | undefined;
  grant: ShellApprovalGrant;
  workspace: string;
  threadId: string;
  request: PendingToolRequest;
  source?: StateAuthorizationSource;
}): StateAuthorizationState {
  const authorization = runtimeHostStateNormalizeAuthorization(input.authorization);
  if (input.grant === 'same_command' && input.request.name === 'shell_execute') {
    return runtimeHostStateGrantSameCommand({
      authorization,
      workspace: input.workspace,
      threadId: input.threadId,
      command: input.request.args.command,
      source: input.source,
    });
  }
  if (input.grant === 'full_access') {
    return runtimeHostStateApplyApprovalGrant({
      authorization,
      grant: input.grant,
      workspace: input.workspace,
      threadId: input.threadId,
      command: '',
      source: input.source ?? 'user',
      grantedAt: new Date().toISOString(),
    });
  }
  return authorization;
}

function approvalCommand(request: PendingToolRequest): string {
  return request.name === 'shell_execute' ? request.args.command : request.protectedCommand;
}

export function defaultPhaseForWorkspaceAccess(_workspaceAccess: WorkspaceAccess): AgentPhase {
  return 'building';
}
