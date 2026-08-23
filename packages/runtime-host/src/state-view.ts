import {
  type AgentState,
  activeSkillFramesForCurrentWorkV1,
  decideCompletion,
  getActivePlanning,
  getActiveTask,
  getEffectiveInteractionMode,
  interactionBelongsToCurrentWorkV1,
  interactionToolCallV1,
  toolCallBelongsToCurrentWorkV1,
} from '@kite/agent-kernel';

export const runtimeHostStateDecideCompletionV1 = decideCompletion;

/** Host-facing read-only selectors over the exact State Kernel shape. */
export function runtimeHostStateActiveTaskV1(state: Readonly<AgentState>) {
  return getActiveTask(state);
}

export function runtimeHostStateActivePlanningV1(state: Readonly<AgentState>) {
  return getActivePlanning(state);
}

export function runtimeHostStateEffectiveInteractionModeV1(state: Readonly<AgentState>) {
  return getEffectiveInteractionMode(state);
}

export function runtimeHostStateInteractionBelongsToCurrentWorkV1(
  state: Readonly<AgentState>,
): boolean {
  return interactionBelongsToCurrentWorkV1(state);
}

export function runtimeHostStateActiveSkillFramesV1(state: Readonly<AgentState>) {
  return activeSkillFramesForCurrentWorkV1(state);
}

export function runtimeHostStateInteractionToolCallV1(state: Readonly<AgentState>) {
  return interactionToolCallV1(state);
}

export function runtimeHostStateToolCallBelongsToCurrentWorkV1(
  state: Readonly<AgentState>,
  call: Parameters<typeof toolCallBelongsToCurrentWorkV1>[1],
): boolean {
  return toolCallBelongsToCurrentWorkV1(state, call);
}
