import type { RuntimeState, ToolCallRecord, ToolCallStatus } from './state';

const TERMINAL_TOOL_STATUSES: ReadonlySet<ToolCallStatus> = new Set([
  'succeeded',
  'failed',
  'rejected',
  'cancelled',
  'exhausted',
]);

const INTERACTION_OWNED_TOOL_STATUSES = new Set([
  'awaiting_user_input',
  'awaiting_review',
  'awaiting_approval',
  'awaiting_auto_review',
]);

/**
 * Canonical ownership rule for scheduling and completion.
 *
 * Current calls carry taskId. Calls without it are legacy records and remain
 * current only inside the turn that created them.
 */
export function toolCallBelongsToCurrentWork(
  state: Readonly<RuntimeState>,
  call: Pick<ToolCallRecord, 'taskId' | 'createdAtTurnId'>,
): boolean {
  if (call.taskId != null) return call.taskId === state.activeTaskId;
  return call.createdAtTurnId === state.turn.turnId;
}

/** Return the Tool record owned by a Tool-backed interaction, if any. */
export function interactionToolCall(state: Readonly<RuntimeState>): ToolCallRecord | undefined {
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

/**
 * Provider recovery is session-owned. Tool-backed interactions are current
 * only while their Tool belongs to the active Task/legacy turn.
 */
export function interactionBelongsToCurrentWork(state: Readonly<RuntimeState>): boolean {
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

/** Suspended continuations are blockers only through their current parent Tool. */
export function hasCurrentSuspendedSubagent(state: Readonly<RuntimeState>): boolean {
  return Object.keys(state.suspendedSubagents).some((toolCallId) => {
    const call = state.tools.calls[toolCallId];
    return (
      call?.name === 'task' &&
      !TERMINAL_TOOL_STATUSES.has(call.status) &&
      toolCallBelongsToCurrentWork(state, call)
    );
  });
}

/** Active Skill frames are Task-owned and must not leak into successor Tasks. */
export function activeSkillFramesForCurrentWork(state: Readonly<RuntimeState>) {
  return Object.values(state.skills.frames).filter(
    (frame) => frame.status === 'active' && frame.taskId === state.activeTaskId,
  );
}

/** Find a current call that claims an interaction although the interaction lane is idle. */
export function findStrandedInteractionTool(
  state: Readonly<RuntimeState>,
): ToolCallRecord | undefined {
  if (state.interactions.kind !== 'idle') return undefined;
  return Object.values(state.tools.calls).find(
    (call) =>
      toolCallBelongsToCurrentWork(state, call) && INTERACTION_OWNED_TOOL_STATUSES.has(call.status),
  );
}
