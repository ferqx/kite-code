import type { RuntimeEffect } from './effects';
import type { RuntimeState } from './state';

/**
 * The only runtime scheduler.  It deliberately depends on RuntimeState only:
 * callers must encode every externally visible transition as a RuntimeEvent
 * before asking for the next effect.
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

  const runnable = state.tools.queue.filter((id) => {
    const call = state.tools.calls[id];
    return call?.status === 'queued' || call?.status === 'approved';
  });
  if (runnable.length > 0) return { type: 'run_tools', toolCallIds: runnable };

  if (state.transcript.final) return { type: 'emit_final' };

  return { type: 'call_model' };
}
