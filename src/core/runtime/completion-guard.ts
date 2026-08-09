import type { PlanningState } from '@/protocol/events';
import { getActivePlanning, type RuntimeState, type ToolCallStatus } from './state';

export const COMPLETION_GUARD_V1 = 'completion_guard_v1' as const;

export type CompletionBlockerCode =
  | 'interaction_pending'
  | 'tool_pending'
  | 'subagent_suspended'
  | 'unknown_external_invocation'
  | 'skill_active'
  | 'planning_empty'
  | 'plan_draft_pending'
  | 'plan_review_pending'
  | 'plan_execution_incomplete'
  | 'plan_cancelled';

export type CompletionNextAction =
  | 'wait_for_interaction'
  | 'wait_for_tool'
  | 'wait_for_subagent'
  | 'reconcile_invocation'
  | 'complete_skill'
  | 'save_plan'
  | 'submit_plan'
  | 'wait_for_review'
  | 'complete_plan'
  | 'start_new_task';

export interface CompletionGuardAccepted {
  status: 'accepted';
  version: typeof COMPLETION_GUARD_V1;
}

export interface CompletionGuardBlocked {
  status: 'blocked';
  version: typeof COMPLETION_GUARD_V1;
  code: CompletionBlockerCode;
  nextAction: CompletionNextAction;
  planning: PlanningState['kind'];
  correctionAttempt: number;
  canCorrect: boolean;
}

export type CompletionGuardDecision = CompletionGuardAccepted | CompletionGuardBlocked;

const NON_TERMINAL_TOOL_STATUSES = new Set<ToolCallStatus>([
  'queued',
  'awaiting_user_input',
  'awaiting_review',
  'awaiting_approval',
  'awaiting_auto_review',
  'approved',
  'running',
]);

function blocked(
  state: RuntimeState,
  planning: PlanningState['kind'],
  code: CompletionBlockerCode,
  nextAction: CompletionNextAction,
): CompletionGuardBlocked {
  const correctionAttempt = (state.completionGuard?.correctionAttempts ?? 0) + 1;
  return {
    status: 'blocked',
    version: COMPLETION_GUARD_V1,
    code,
    nextAction,
    planning,
    correctionAttempt,
    canCorrect: correctionAttempt === 1,
  };
}

/**
 * The canonical V1 completion decision. It deliberately uses only durable,
 * currently authoritative state; verification and recovery-evidence gates are
 * added by later decision versions rather than guessed here.
 */
export function decideCompletionV1(state: RuntimeState): CompletionGuardDecision {
  const planning = getActivePlanning(state);
  if (state.interactions.kind !== 'idle') {
    return blocked(state, planning.kind, 'interaction_pending', 'wait_for_interaction');
  }
  if (
    Object.values(state.tools.calls).some((call) => NON_TERMINAL_TOOL_STATUSES.has(call.status))
  ) {
    return blocked(state, planning.kind, 'tool_pending', 'wait_for_tool');
  }
  if (Object.keys(state.suspendedSubagents).length > 0) {
    return blocked(state, planning.kind, 'subagent_suspended', 'wait_for_subagent');
  }
  if (
    Object.values(state.capabilities.invocations).some(
      (invocation) => invocation.status === 'unknown',
    )
  ) {
    return blocked(state, planning.kind, 'unknown_external_invocation', 'reconcile_invocation');
  }
  if (Object.values(state.skills.frames).some((frame) => frame.status === 'active')) {
    return blocked(state, planning.kind, 'skill_active', 'complete_skill');
  }

  switch (planning.kind) {
    case 'building_without_plan':
    case 'completed':
      return { status: 'accepted', version: COMPLETION_GUARD_V1 };
    case 'planning_empty':
      return blocked(state, planning.kind, 'planning_empty', 'save_plan');
    case 'planning_draft':
    case 'replanning_draft':
      return blocked(state, planning.kind, 'plan_draft_pending', 'submit_plan');
    case 'awaiting_review':
      return blocked(state, planning.kind, 'plan_review_pending', 'wait_for_review');
    case 'executing':
      return blocked(state, planning.kind, 'plan_execution_incomplete', 'complete_plan');
    case 'cancelled':
      return blocked(state, planning.kind, 'plan_cancelled', 'start_new_task');
  }
}
