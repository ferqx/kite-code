import type { AgentState, AgentToolCallState } from './state';

type ToolCallStatus = AgentToolCallState['status'];

const TERMINAL_TOOL_STATUSES: ReadonlySet<ToolCallStatus> = new Set([
  'succeeded',
  'failed',
  'rejected',
  'cancelled',
  'exhausted',
]);

const INTERACTION_OWNED_TOOL_STATUSES: ReadonlySet<ToolCallStatus> = new Set([
  'awaiting_user_input',
  'awaiting_review',
  'awaiting_approval',
  'awaiting_auto_review',
]);

/** Canonical State ownership rule for Task- and turn-scoped Tool calls. */
export function toolCallBelongsToCurrentWork(
  state: Readonly<AgentState>,
  call: Pick<AgentToolCallState, 'taskId' | 'createdAtTurnId'>,
): boolean {
  if (call.taskId != null) return call.taskId === state.activeTaskId;
  return call.createdAtTurnId === state.turn.turnId;
}

export function interactionToolCall(state: Readonly<AgentState>): AgentToolCallState | undefined {
  const interaction = state.interactions;
  if (
    interaction.kind === 'idle' ||
    interaction.kind === 'awaiting_provider_action' ||
    interaction.kind === 'awaiting_provider_admission'
  ) {
    return undefined;
  }
  return state.tools.calls[interaction.toolCallId];
}

export function interactionBelongsToCurrentWork(state: Readonly<AgentState>): boolean {
  if (state.interactions.kind === 'idle') return false;
  if (
    state.interactions.kind === 'awaiting_provider_action' ||
    state.interactions.kind === 'awaiting_provider_admission'
  ) {
    return true;
  }
  const call = interactionToolCall(state);
  return call != null && toolCallBelongsToCurrentWork(state, call);
}

export function hasCurrentSuspendedSubagent(state: Readonly<AgentState>): boolean {
  return Object.keys(state.suspendedSubagents).some((toolCallId) => {
    const call = state.tools.calls[toolCallId];
    return (
      call?.name === 'task' &&
      !TERMINAL_TOOL_STATUSES.has(call.status) &&
      toolCallBelongsToCurrentWork(state, call)
    );
  });
}

export function activeSkillFramesForCurrentWork(state: Readonly<AgentState>) {
  return Object.values(state.skills.frames).filter(
    (frame) => frame.status === 'active' && frame.taskId === state.activeTaskId,
  );
}

export function findStrandedInteractionTool(
  state: Readonly<AgentState>,
): AgentToolCallState | undefined {
  if (state.interactions.kind !== 'idle') return undefined;
  return Object.values(state.tools.calls).find(
    (call) =>
      toolCallBelongsToCurrentWork(state, call) && INTERACTION_OWNED_TOOL_STATUSES.has(call.status),
  );
}
