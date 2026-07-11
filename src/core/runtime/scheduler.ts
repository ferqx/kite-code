import type { RuntimeEffect } from './effects';
import type { RuntimeState } from './state';

/**
 * The only runtime scheduler.  It deliberately depends on RuntimeState only:
 * callers must encode every externally visible transition as a RuntimeEvent
 * before asking for the next effect.
 *
 * v2: single-tool scheduling — runs one tool at a time so interaction barriers
 * (exit_plan_mode, ask_user, approval.requested) naturally interrupt the queue
 * before sibling tool calls execute.
 */
export function decideNextEffect(state: RuntimeState): RuntimeEffect {
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
  // When an interaction-creating tool (exit_plan_mode, ask_user, approval) is reached,
  // the scheduler naturally stops before sibling tool calls execute.
  const nextRunnable = state.tools.queue.find((id) => {
    const call = state.tools.calls[id];
    return call?.status === 'queued' || call?.status === 'approved';
  });
  if (nextRunnable) return { type: 'run_tools', toolCallIds: [nextRunnable] };

  if (state.transcript.final) return { type: 'emit_final' };

  return { type: 'call_model' };
}
