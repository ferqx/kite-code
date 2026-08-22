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

export const runtimeHostState26DecideCompletionV1 = decideCompletion;

/** Host-facing read-only selectors over the exact State26 Kernel shape. */
export function runtimeHostState26ActiveTaskV1(state: Readonly<AgentState>) {
  return getActiveTask(state);
}

export function runtimeHostState26ActivePlanningV1(state: Readonly<AgentState>) {
  return getActivePlanning(state);
}

export function runtimeHostState26EffectiveInteractionModeV1(state: Readonly<AgentState>) {
  return getEffectiveInteractionMode(state);
}

export function runtimeHostState26InteractionBelongsToCurrentWorkV1(
  state: Readonly<AgentState>,
): boolean {
  return interactionBelongsToCurrentWorkV1(state);
}

export function runtimeHostState26ActiveSkillFramesV1(state: Readonly<AgentState>) {
  return activeSkillFramesForCurrentWorkV1(state);
}

export function runtimeHostState26InteractionToolCallV1(state: Readonly<AgentState>) {
  return interactionToolCallV1(state);
}

export function runtimeHostState26ToolCallBelongsToCurrentWorkV1(
  state: Readonly<AgentState>,
  call: Parameters<typeof toolCallBelongsToCurrentWorkV1>[1],
): boolean {
  return toolCallBelongsToCurrentWorkV1(state, call);
}
