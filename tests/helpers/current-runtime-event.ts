import type { RuntimeEvent } from '../../src/core/runtime/events';
import { createInitialRuntimeState } from '../../src/core/runtime/state';
import { isToolOutcomeV1 } from '../../src/core/runtime/tool-outcome';
import { normalizeCurrentToolOutcomeEventV1 } from '../../src/core/runtime/tool-outcome-events';

const TEST_OCCURRED_AT = '2026-08-15T00:00:00.000Z';

/**
 * Test boundary for Runtime events consumed outside AgentKernel.
 * Production events receive the same canonical outcome before persistence.
 */
export function currentRuntimeEvent(event: RuntimeEvent): RuntimeEvent {
  if ('outcomeV1' in event && isToolOutcomeV1(event.outcomeV1)) return event;

  const state = createInitialRuntimeState({
    threadId: 'current-event-test',
    userId: 'test-user',
    workspace: '/workspace',
  });
  const toolCallId = 'toolCallId' in event ? event.toolCallId : undefined;
  if (typeof toolCallId === 'string') {
    const name = event.type === 'tool.finished' ? event.name : 'test_tool';
    state.tools.calls[toolCallId] = {
      toolCallId,
      modelMessageId: 'test-model-message',
      name,
      args: {},
      status:
        event.type === 'approval.rejected' || event.type === 'auto_review.completed'
          ? 'awaiting_approval'
          : 'running',
      createdAtTurnId: state.turn.turnId,
      queuedAt: TEST_OCCURRED_AT,
      startedAt:
        event.type === 'approval.rejected' || event.type === 'auto_review.completed'
          ? undefined
          : TEST_OCCURRED_AT,
      approvalRequestedAt:
        event.type === 'approval.rejected' || event.type === 'auto_review.completed'
          ? TEST_OCCURRED_AT
          : undefined,
      sideEffect: name === 'shell_execute',
    };
    if (event.type !== 'approval.rejected' && event.type !== 'auto_review.completed') {
      state.tools.active.push(toolCallId);
    }
  }

  return normalizeCurrentToolOutcomeEventV1(event, state, TEST_OCCURRED_AT);
}

export function currentRuntimeEvents(events: RuntimeEvent[]): RuntimeEvent[] {
  return events.map(currentRuntimeEvent);
}
