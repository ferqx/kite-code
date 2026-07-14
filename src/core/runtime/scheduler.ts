import type { RuntimeEffect } from './effects';
import type { RuntimeState } from './state';

/**
 * The only runtime scheduler.  It deliberately depends on RuntimeState only:
 * callers must encode every externally visible transition as a RuntimeEvent
 * before asking for the next effect.
 *
 * v2: single-tool scheduling — runs one tool at a time so interaction barriers
 * (write_plan with action=submit, ask_user, approval.requested) naturally interrupt the queue
 * before sibling tool calls execute.
 */
export function decideNextEffect(state: RuntimeState): RuntimeEffect {
  if (state.recoveryState.kind !== 'normal') {
    return {
      type: 'recovery_blocked',
      reason:
        state.recoveryState.kind === 'corrupted'
          ? state.recoveryState.reason
          : `Runtime schema ${state.recoveryState.schemaVersion} is not supported.`,
    };
  }
  if (state.legacyUnrecoverableSubagentApproval) {
    return {
      type: 'subagent.recovery_unavailable',
      ...state.legacyUnrecoverableSubagentApproval,
    };
  }
  const unknownInvocation = Object.values(state.capabilities.invocations).find(
    (invocation) => invocation.status === 'unknown',
  );
  if (unknownInvocation) {
    return {
      type: 'recovery_blocked',
      reason:
        `Capability invocation ${unknownInvocation.invocationId} has an unknown external outcome. ` +
        'Reconcile it or obtain a user decision before continuing.',
    };
  }

  switch (state.interactions.kind) {
    case 'awaiting_user_input':
      return {
        type: 'request_user_input',
        interactionId: state.interactions.interactionId,
        toolCallId: state.interactions.toolCallId,
      };
    case 'awaiting_review':
      return {
        type: 'request_plan_review',
        interactionId: state.interactions.interactionId,
        toolCallId: state.interactions.toolCallId,
      };
    case 'awaiting_tool_approval':
      return {
        type: 'request_tool_approval',
        interactionId: state.interactions.interactionId,
        toolCallId: state.interactions.toolCallId,
      };
    case 'awaiting_auto_review':
      return {
        type: 'run_auto_review',
        reviewId: state.interactions.interactionId,
        toolCallId: state.interactions.toolCallId,
      };
    case 'idle':
      break;
  }

  // Single-tool scheduling: run one tool at a time to support interaction barriers.
  // When an interaction-creating tool (write_plan action=submit, ask_user, approval) is reached,
  // the scheduler naturally stops before sibling tool calls execute.
  //
  // Tools that need approval are moved from queue → active by tool.started before the
  // approval interaction fires.  When approval is granted, the tool is still in active
  // (not queue), so the scheduler must scan both lists.  Without this, approved
  // sub-agent task tools are invisible to the scheduler and call_model runs prematurely.
  const isRunnable = (id: string) => {
    const call = state.tools.calls[id];
    const belongsToCurrentTask = call?.taskId == null || call.taskId === state.activeTaskId;
    return belongsToCurrentTask && (call?.status === 'queued' || call?.status === 'approved');
  };
  const nextRunnable = state.tools.queue.find(isRunnable) ?? state.tools.active.find(isRunnable);
  if (nextRunnable) return { type: 'run_tools', toolCallIds: [nextRunnable] };

  if (state.transcript.final) return { type: 'emit_final' };

  return { type: 'call_model' };
}
