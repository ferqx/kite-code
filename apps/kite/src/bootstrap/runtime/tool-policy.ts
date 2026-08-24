import type { PendingToolRequest } from '@kite/builtin-runtime';
import type {
  AgentPhase,
  ShellApprovalGrant,
  ToolApprovalPayload,
  WorkspaceAccess,
} from '@kite/runtime-contract';
import type { StateAuthorizationSource } from '@kite/runtime-host';
import {
  runtimeHostStateApplyApprovalGrant,
  runtimeHostStateGrantSameCommand,
  runtimeHostStateNormalizeAuthorization,
  type StateAuthorizationState,
  type StateToolGovernancePolicyFact,
} from '@kite/runtime-host/kernel-adapter';

/** App-only presentation bridge; authorization identity remains Kernel-owned. */
export function buildToolApproval(input: {
  workspace: string;
  threadId: string;
  request: PendingToolRequest;
  decision: Pick<StateToolGovernancePolicyFact, 'risk' | 'reason' | 'expectedEffects'>;
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
    summary: approvalSummary(input.request, input.decision.risk),
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

/** Presentation-only label. Exact commands remain in ToolApprovalPayload.command. */
function approvalSummary(
  request: PendingToolRequest,
  risk: StateToolGovernancePolicyFact['risk'],
): string {
  if (request.name !== 'shell_execute') {
    const prefix = 'Approve ';
    return `${prefix}${request.name.slice(0, 256 - prefix.length)}`;
  }
  switch (risk) {
    case 'vcs_mutation':
      return 'Approve a version-control mutation command';
    case 'write_file':
      return 'Approve a workspace-mutating shell command';
    case 'network':
      return 'Approve a network-capable shell command';
    case 'destructive':
      return 'Approve a destructive shell command';
    default:
      return 'Approve a shell command';
  }
}

export function defaultPhaseForWorkspaceAccess(_workspaceAccess: WorkspaceAccess): AgentPhase {
  return 'building';
}
