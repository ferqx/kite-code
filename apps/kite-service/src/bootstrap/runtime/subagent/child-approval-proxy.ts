import type { RuntimeApprovalInteraction } from '@kite-ai/runtime-contract';
import { parseFollowupChildApprovalParentToolCallId } from '@kite-ai/runtime-host/storage';
import type { KiteChildApprovalProxyRecord } from '@kite-ai/runtime-storage-sqlite';
import { projectRuntimeClientInteraction } from '../../../runtime-client/interaction-projector';
import type { RuntimeState } from '../state-runtime';

function matchesChildOrigin(
  parent: Readonly<RuntimeState>,
  child: Readonly<RuntimeState>,
  proxy: Readonly<KiteChildApprovalProxyRecord>,
): boolean {
  const origin = child.childSessionOrigin;
  const followupIdentity = parseFollowupChildApprovalParentToolCallId(proxy.parentToolCallId);
  const active = child.activeFollowupTurn;
  if (followupIdentity) {
    return Boolean(
      parent.session.threadId === proxy.parentSessionId &&
        child.session.threadId === proxy.childThreadId &&
        origin?.parentSessionId === proxy.parentSessionId &&
        origin.childInvocationId === proxy.childInvocationId &&
        origin.terminal?.status === 'completed' &&
        origin.terminal.cleanupConfirmed &&
        active?.sourceSessionId === proxy.parentSessionId &&
        active.submissionId === followupIdentity.submissionId &&
        active.targetRunId === followupIdentity.targetRunId &&
        active.grantDigest === proxy.grantDigest &&
        child.turn.turnId === followupIdentity.targetRunId &&
        child.turn.status === 'active' &&
        child.resourceBudget.status === 'active' &&
        child.resourceBudget.runId === followupIdentity.targetRunId,
    );
  }
  if (proxy.parentToolCallId.startsWith('followup-approval:v2:')) return false;
  if (
    parent.session.threadId !== proxy.parentSessionId ||
    parent.turn.status !== 'active' ||
    parent.resourceBudget.status !== 'active' ||
    child.session.threadId !== proxy.childThreadId ||
    origin?.parentSessionId !== proxy.parentSessionId ||
    origin.childInvocationId !== proxy.childInvocationId ||
    origin.parentToolCallId !== proxy.parentToolCallId ||
    origin.grantDigest !== proxy.grantDigest ||
    origin.terminal !== undefined
  )
    return false;
  return Object.values(parent.capabilities.invocations).some(
    (invocation) =>
      invocation.toolCallId === proxy.parentToolCallId &&
      invocation.subagentProviderLifecycle?.childInvocationId === proxy.childInvocationId &&
      invocation.subagentProviderLifecycle.childSession?.childThreadId === proxy.childThreadId &&
      invocation.subagentProviderLifecycle.childSession.grantDigest === proxy.grantDigest &&
      invocation.subagentProviderLifecycle.childSession.terminalImport === undefined,
  );
}

function matchesChildApproval(
  child: Readonly<RuntimeState>,
  proxy: Readonly<KiteChildApprovalProxyRecord>,
): boolean {
  const pending = child.pendingApprovals.get(proxy.childInteractionId);
  const tool = child.tools.calls[proxy.childToolCallId];
  return Boolean(
    pending &&
      tool &&
      pending.toolCallId === proxy.childToolCallId &&
      pending.generation === proxy.childGeneration &&
      pending.route === 'user' &&
      pending.status !== 'rejected' &&
      pending.status !== 'expired' &&
      tool.createdAtTurnId === child.turn.turnId &&
      child.revision >= proxy.childRequestRevision,
  );
}

/** Project only a parent-scoped, unhandled approval. Child identity remains private. */
export function projectChildApprovalProxy(input: {
  readonly parentState: Readonly<RuntimeState>;
  readonly childState: Readonly<RuntimeState>;
  readonly proxy: Readonly<KiteChildApprovalProxyRecord>;
}): RuntimeApprovalInteraction | null {
  const { parentState, childState, proxy } = input;
  if (
    proxy.status !== 'pending' ||
    !matchesChildOrigin(parentState, childState, proxy) ||
    !matchesChildApproval(childState, proxy)
  )
    return null;
  const projected = projectRuntimeClientInteraction(
    childState,
    {
      type: 'request_tool_approval',
      interactionId: proxy.childInteractionId,
      toolCallId: proxy.childToolCallId,
    },
    { sessionRevision: childState.revision },
  );
  if (projected?.kind !== 'approval' || projected.generation !== proxy.childGeneration) return null;
  return Object.freeze({
    ...projected,
    interactionId: proxy.proxyInteractionId,
    sessionRevision: parentState.revision,
    grants: Object.freeze(['approve_once'] as const),
    owner: Object.freeze({
      kind: 'subagent_tool' as const,
      toolCallId: proxy.childToolCallId,
      subagentId: proxy.childInvocationId,
      parentToolCallId: proxy.parentToolCallId,
    }),
  });
}

/** The same bounded projection for a cold Store-only parent Session view. */
export function projectStoredChildApprovals(input: {
  readonly parentState: Readonly<RuntimeState>;
  readonly listPending: (
    parentSessionId: string,
    limit: number,
    afterProxyInteractionId?: string,
  ) => readonly KiteChildApprovalProxyRecord[];
  readonly readChildState: (childThreadId: string) => Readonly<RuntimeState> | null;
}): readonly RuntimeApprovalInteraction[] {
  const approvals: RuntimeApprovalInteraction[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = input.listPending(input.parentState.session.threadId, 100, cursor);
    for (const proxy of page) {
      const childState = input.readChildState(proxy.childThreadId);
      if (!childState) continue;
      const projected = projectChildApprovalProxy({
        parentState: input.parentState,
        childState,
        proxy,
      });
      if (projected) approvals.push(projected);
    }
    if (page.length < 100) return Object.freeze(approvals);
    cursor = page.at(-1)!.proxyInteractionId;
  }
}

export type ChildApprovalRecoveryAction =
  | { readonly kind: 'wait_for_parent' }
  | { readonly kind: 'apply_parent_decision'; readonly decision: 'approve_once' | 'reject' }
  | { readonly kind: 'resume_authorized_tool' }
  | { readonly kind: 'settled' }
  | { readonly kind: 'recovery_required'; readonly reason: string };

/** Inspect persisted facts only. This function never dispatches a Tool or replays a Model. */
export function classifyChildApprovalRecovery(input: {
  readonly parentState: Readonly<RuntimeState>;
  readonly childState: Readonly<RuntimeState>;
  readonly proxy: Readonly<KiteChildApprovalProxyRecord>;
}): ChildApprovalRecoveryAction {
  const { parentState, childState, proxy } = input;
  const blocked = (reason: string): ChildApprovalRecoveryAction => ({
    kind: 'recovery_required',
    reason,
  });
  if (!matchesChildOrigin(parentState, childState, proxy))
    return blocked('child_approval_lineage_changed');
  if (proxy.status === 'unknown') return blocked('child_approval_unknown');
  const tool = childState.tools.calls[proxy.childToolCallId];
  if (!tool || tool.createdAtTurnId !== childState.turn.turnId)
    return blocked('child_approval_tool_changed');
  const model = tool.modelInvocationId
    ? childState.modelInvocations[tool.modelInvocationId]
    : undefined;
  if (
    !model ||
    model.status !== 'completed' ||
    !model.responseArtifact ||
    model.dispatchCertainty === 'unknown' ||
    childState.recoveryState.kind !== 'normal'
  )
    return blocked('child_approval_model_response_unavailable');
  if (
    Object.values(childState.tools.calls).some(
      (candidate) =>
        candidate.toolCallId !== proxy.childToolCallId && candidate.status === 'running',
    )
  )
    return blocked('other_child_tool_attempt_in_progress');
  if (tool.status === 'running') return blocked('child_tool_attempt_in_progress');
  if (['succeeded', 'failed', 'rejected', 'cancelled', 'exhausted'].includes(tool.status))
    return proxy.status === 'applied'
      ? { kind: 'settled' }
      : blocked('child_tool_terminal_without_approval_application');
  if (proxy.status === 'pending')
    return matchesChildApproval(childState, proxy)
      ? { kind: 'wait_for_parent' }
      : blocked('child_approval_pending_state_changed');
  if (proxy.status === 'decided')
    return matchesChildApproval(childState, proxy) && proxy.decision
      ? { kind: 'apply_parent_decision', decision: proxy.decision }
      : blocked('child_approval_decision_state_changed');
  if (proxy.status !== 'applied') return blocked('child_approval_state_invalid');
  if (proxy.decision === 'reject') return { kind: 'settled' };
  if (
    proxy.decision === 'approve_once' &&
    tool.status === 'authorized_queued' &&
    !Object.values(childState.capabilities.invocations).some(
      (invocation) =>
        invocation.toolCallId === proxy.childToolCallId && invocation.status !== 'recorded',
    )
  )
    return { kind: 'resume_authorized_tool' };
  return blocked('child_approval_applied_tool_state_changed');
}
