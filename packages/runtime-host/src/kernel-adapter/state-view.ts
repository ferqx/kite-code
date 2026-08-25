import {
  type AgentState,
  activeSkillFramesForCurrentWork,
  decideCompletion,
  getActivePlanning,
  getActiveTask,
  getEffectiveInteractionMode,
  interactionBelongsToCurrentWork,
  interactionToolCall,
  toolCallBelongsToCurrentWork,
} from '@kite-ai/agent-kernel';

export const runtimeHostStateDecideCompletion = decideCompletion;

/** Host-facing read-only selectors over the exact State Kernel shape. */
export function runtimeHostStateActiveTask(state: Readonly<AgentState>) {
  return getActiveTask(state);
}

export function runtimeHostStateActivePlanning(state: Readonly<AgentState>) {
  return getActivePlanning(state);
}

export function runtimeHostStateEffectiveInteractionMode(state: Readonly<AgentState>) {
  return getEffectiveInteractionMode(state);
}

export function runtimeHostStateInteractionBelongsToCurrentWork(
  state: Readonly<AgentState>,
): boolean {
  return interactionBelongsToCurrentWork(state);
}

export function runtimeHostStateActiveSkillFrames(state: Readonly<AgentState>) {
  return activeSkillFramesForCurrentWork(state);
}

export function runtimeHostStateInteractionToolCall(state: Readonly<AgentState>) {
  return interactionToolCall(state);
}

export function runtimeHostStateToolCallBelongsToCurrentWork(
  state: Readonly<AgentState>,
  call: Parameters<typeof toolCallBelongsToCurrentWork>[1],
): boolean {
  return toolCallBelongsToCurrentWork(state, call);
}
