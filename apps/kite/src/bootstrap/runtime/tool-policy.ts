import type { PendingToolRequest } from '@kite/builtin-runtime';
import type {
  AgentPhase,
  ShellApprovalGrant,
  ToolApprovalPayload,
  WorkspaceAccess,
} from '@kite/runtime-contract';
import {
  runtimeHostState25ApplyApprovalGrantV1,
  runtimeHostState25AuthorizationCommandGrantKeyV1,
  runtimeHostState25DefaultAuthorizationV1,
  runtimeHostState25GrantSameCommandV1,
  runtimeHostState25HasSameCommandGrantV1,
  runtimeHostState25NormalizeAuthorizationV1,
  type State25AuthorizationSourceV1,
  type State25AuthorizationStateV1,
  type State25ToolGovernancePolicyFactV1,
} from '@kite/runtime-host';

/** App-only presentation bridge; authorization identity remains Kernel-owned. */
export function buildToolApproval(input: {
  workspace: string;
  threadId: string;
  request: PendingToolRequest;
  decision: Pick<
    State25ToolGovernancePolicyFactV1,
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
export function defaultAuthorizationState(): State25AuthorizationStateV1 {
  return runtimeHostState25DefaultAuthorizationV1();
}

export function normalizeAuthorizationState(
  authorization?: Readonly<State25AuthorizationStateV1> | null,
): State25AuthorizationStateV1 {
  return runtimeHostState25NormalizeAuthorizationV1(authorization);
}

export function commandGrantKey(input: {
  workspace: string;
  threadId: string;
  command: string;
}): string {
  return runtimeHostState25AuthorizationCommandGrantKeyV1(input);
}

export function grantSameCommand(
  authorization: State25AuthorizationStateV1 | null | undefined,
  input: {
    workspace: string;
    threadId: string;
    command: string;
    source?: State25AuthorizationSourceV1;
  },
): State25AuthorizationStateV1 {
  return runtimeHostState25GrantSameCommandV1({ authorization, ...input });
}

export function hasSameCommandGrant(
  authorization: State25AuthorizationStateV1 | null | undefined,
  input: { workspace: string; threadId: string; command: string },
): boolean {
  return runtimeHostState25HasSameCommandGrantV1({ authorization, ...input });
}

export function applyApprovalGrant(input: {
  authorization: State25AuthorizationStateV1 | null | undefined;
  grant: ShellApprovalGrant;
  workspace: string;
  threadId: string;
  request: PendingToolRequest;
  source?: State25AuthorizationSourceV1;
}): State25AuthorizationStateV1 {
  const authorization = runtimeHostState25NormalizeAuthorizationV1(input.authorization);
  if (input.grant === 'same_command' && input.request.name === 'shell_execute') {
    return runtimeHostState25GrantSameCommandV1({
      authorization,
      workspace: input.workspace,
      threadId: input.threadId,
      command: input.request.args.command,
      source: input.source,
    });
  }
  if (input.grant === 'full_access') {
    return runtimeHostState25ApplyApprovalGrantV1({
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
