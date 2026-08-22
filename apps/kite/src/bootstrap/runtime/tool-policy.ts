import type { PendingToolRequest } from '@kite/builtin-runtime';
import type {
  AgentPhase,
  ShellApprovalGrant,
  ToolApprovalPayload,
  WorkspaceAccess,
} from '@kite/runtime-contract';
import {
  runtimeHostState26ApplyApprovalGrantV1,
  runtimeHostState26AuthorizationCommandGrantKeyV1,
  runtimeHostState26DefaultAuthorizationV1,
  runtimeHostState26GrantSameCommandV1,
  runtimeHostState26HasSameCommandGrantV1,
  runtimeHostState26NormalizeAuthorizationV1,
  type State26AuthorizationSourceV1,
  type State26AuthorizationStateV1,
  type State26ToolGovernancePolicyFactV1,
} from '@kite/runtime-host';

/** App-only presentation bridge; authorization identity remains Kernel-owned. */
export function buildToolApproval(input: {
  workspace: string;
  threadId: string;
  request: PendingToolRequest;
  decision: Pick<
    State26ToolGovernancePolicyFactV1,
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
export function defaultAuthorizationState(): State26AuthorizationStateV1 {
  return runtimeHostState26DefaultAuthorizationV1();
}

export function normalizeAuthorizationState(
  authorization?: Readonly<State26AuthorizationStateV1> | null,
): State26AuthorizationStateV1 {
  return runtimeHostState26NormalizeAuthorizationV1(authorization);
}

export function commandGrantKey(input: {
  workspace: string;
  threadId: string;
  command: string;
}): string {
  return runtimeHostState26AuthorizationCommandGrantKeyV1(input);
}

export function grantSameCommand(
  authorization: State26AuthorizationStateV1 | null | undefined,
  input: {
    workspace: string;
    threadId: string;
    command: string;
    source?: State26AuthorizationSourceV1;
  },
): State26AuthorizationStateV1 {
  return runtimeHostState26GrantSameCommandV1({ authorization, ...input });
}

export function hasSameCommandGrant(
  authorization: State26AuthorizationStateV1 | null | undefined,
  input: { workspace: string; threadId: string; command: string },
): boolean {
  return runtimeHostState26HasSameCommandGrantV1({ authorization, ...input });
}

export function applyApprovalGrant(input: {
  authorization: State26AuthorizationStateV1 | null | undefined;
  grant: ShellApprovalGrant;
  workspace: string;
  threadId: string;
  request: PendingToolRequest;
  source?: State26AuthorizationSourceV1;
}): State26AuthorizationStateV1 {
  const authorization = runtimeHostState26NormalizeAuthorizationV1(input.authorization);
  if (input.grant === 'same_command' && input.request.name === 'shell_execute') {
    return runtimeHostState26GrantSameCommandV1({
      authorization,
      workspace: input.workspace,
      threadId: input.threadId,
      command: input.request.args.command,
      source: input.source,
    });
  }
  if (input.grant === 'full_access') {
    return runtimeHostState26ApplyApprovalGrantV1({
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
