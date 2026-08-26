import type { PendingToolRequest } from '@kite-ai/builtin-runtime';
import type { ShellApprovalGrant, ToolApprovalPayload } from '@kite-ai/runtime-contract';
import type {
  RuntimeHostStateApprovalCommandIdentity,
  StateToolGovernanceInvocationFact,
  StateToolGovernancePolicyFact,
} from '@kite-ai/runtime-host/kernel-adapter';

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
    input.request.name === 'shell_execute' ? ['approve_once', 'same_command'] : ['approve_once'];
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

/** Complete Session-scoped Shell subject carried by the durable queue event. */
export function commandIdentityForToolApproval(input: {
  readonly sessionId: string;
  readonly threadId: string;
  readonly workspace: string;
  readonly canonicalWorkspaceIdentity: string;
  readonly invocation: Readonly<StateToolGovernanceInvocationFact>;
}): RuntimeHostStateApprovalCommandIdentity | undefined {
  const invocation = input.invocation;
  if (
    !invocation.commandDigest ||
    !invocation.cwd ||
    !invocation.executor ||
    !invocation.environmentDigest ||
    !invocation.scopeDigest
  ) {
    return undefined;
  }
  return {
    sessionId: input.sessionId,
    threadId: input.threadId,
    workspace: input.workspace,
    canonicalWorkspaceIdentity: input.canonicalWorkspaceIdentity,
    cwd: invocation.cwd,
    executor: invocation.executor,
    environment: invocation.environmentDigest,
    scope: invocation.scopeDigest,
    effects: invocation.effectiveEffectsDigest,
    parserRevision: invocation.policyParserExecutorRevision ?? invocation.parserRevision,
    ...(invocation.executorRevision === null
      ? {}
      : { executorRevision: invocation.executorRevision }),
    commandDigest: invocation.commandDigest,
  };
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
