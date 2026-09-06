import type { RuntimeEvent, RuntimeState } from './state-runtime';

export type RuntimeInteractionOwner = Extract<
  RuntimeEvent,
  { readonly type: 'approval.requested' }
>['owner'];

type PendingApproval =
  RuntimeState['pendingApprovals'] extends ReadonlyMap<string, infer Entry> ? Entry : never;

/** One owner projection shared by queue, settlement, replay, and Client interaction DTOs. */
export function runtimeInteractionOwnerForPending(
  pending: Readonly<PendingApproval>,
): RuntimeInteractionOwner {
  if (pending.childSubagentId && pending.parentToolCallId) {
    if (!pending.childToolCallId) {
      throw new Error('Subagent approval is missing its stable child owner identity.');
    }
    return {
      kind: 'subagent_tool',
      // The owner is the stable model/admission child identity.  A
      // namespaced runtimeToolCallId is only an execution binding and may be
      // absent before child admission.
      toolCallId: pending.childToolCallId,
      subagentId: pending.childSubagentId,
      parentToolCallId: pending.parentToolCallId,
    };
  }
  return { kind: 'root_tool', toolCallId: pending.toolCallId };
}

export function rootToolInteractionOwner(toolCallId: string): RuntimeInteractionOwner {
  return { kind: 'root_tool', toolCallId };
}

export function subagentToolInteractionOwner(input: {
  readonly subagentId: string;
  readonly parentToolCallId: string;
  readonly toolCallId: string;
}): RuntimeInteractionOwner {
  return { kind: 'subagent_tool', ...input };
}
