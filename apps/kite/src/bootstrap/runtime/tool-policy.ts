import type { PendingToolRequest } from '@kite/builtin-runtime';
import type {
  AgentPhase,
  ShellApprovalGrant,
  ToolApprovalPayload,
  WorkspaceAccess,
} from '@kite/runtime-contract';
import {
  runtimeHostStateApplyApprovalGrantV1,
  runtimeHostStateAuthorizationCommandGrantKeyV1,
  runtimeHostStateDefaultAuthorizationV1,
  runtimeHostStateGrantSameCommandV1,
  runtimeHostStateHasSameCommandGrantV1,
  runtimeHostStateNormalizeAuthorizationV1,
  type StateAuthorizationSourceV1,
  type StateAuthorizationStateV1,
  type StateToolGovernancePolicyFactV1,
} from '@kite/runtime-host';

/** App-only presentation bridge; authorization identity remains Kernel-owned. */
export function buildToolApproval(input: {
  workspace: string;
  threadId: string;
  request: PendingToolRequest;
  decision: Pick<
    StateToolGovernancePolicyFactV1,
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
export function defaultAuthorizationState(): StateAuthorizationStateV1 {
  return runtimeHostStateDefaultAuthorizationV1();
}

export function normalizeAuthorizationState(
  authorization?: Readonly<StateAuthorizationStateV1> | null,
): StateAuthorizationStateV1 {
  return runtimeHostStateNormalizeAuthorizationV1(authorization);
}

export function commandGrantKey(input: {
  workspace: string;
  threadId: string;
  command: string;
}): string {
  return runtimeHostStateAuthorizationCommandGrantKeyV1(input);
}

export function grantSameCommand(
  authorization: StateAuthorizationStateV1 | null | undefined,
  input: {
    workspace: string;
    threadId: string;
    command: string;
    source?: StateAuthorizationSourceV1;
  },
): StateAuthorizationStateV1 {
  return runtimeHostStateGrantSameCommandV1({ authorization, ...input });
}

export function hasSameCommandGrant(
  authorization: StateAuthorizationStateV1 | null | undefined,
  input: { workspace: string; threadId: string; command: string },
): boolean {
  return runtimeHostStateHasSameCommandGrantV1({ authorization, ...input });
}

export function applyApprovalGrant(input: {
  authorization: StateAuthorizationStateV1 | null | undefined;
  grant: ShellApprovalGrant;
  workspace: string;
  threadId: string;
  request: PendingToolRequest;
  source?: StateAuthorizationSourceV1;
}): StateAuthorizationStateV1 {
  const authorization = runtimeHostStateNormalizeAuthorizationV1(input.authorization);
  if (input.grant === 'same_command' && input.request.name === 'shell_execute') {
    return runtimeHostStateGrantSameCommandV1({
      authorization,
      workspace: input.workspace,
      threadId: input.threadId,
      command: input.request.args.command,
      source: input.source,
    });
  }
  if (input.grant === 'full_access') {
    return runtimeHostStateApplyApprovalGrantV1({
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
