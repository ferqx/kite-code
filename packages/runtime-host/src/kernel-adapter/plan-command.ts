import {
  decidePlanReviewSiblingCancellations,
  decideReadPlanCommand,
  decideUpdatePlanCommand,
  decideWritePlanCommand,
  emptyPlanCompletionEvidence,
  type PlanCommandStateFacts,
  type PlanCompletionBlocker,
  planCommandPhase,
  planCompletionBlocker,
  projectPlanCompletionEvidence,
  type ReadPlanCommand,
  type UpdatePlanCommand,
  type WritePlanCommand,
} from '@kite/agent-kernel';
import type { PlanStep } from '@kite/runtime-contract';
import type { RuntimeState } from './initial';

/**
 * Host-owned typed wrapper around the pure State plan admission functions.
 *
 * Host does not parse plan documents, persist artifacts, or construct model
 * projections. It only supplies the canonical Kernel facts and exposes the
 * Kernel decisions to the App composition root.
 */
export function runtimeHostStatePlanCommandFacts(
  state: Readonly<RuntimeState>,
): PlanCommandStateFacts {
  const taskId = state.activeTaskId == null ? undefined : state.activeTaskId;
  const planning =
    taskId == null ? ({ kind: 'building_without_plan' } as const) : state.tasks[taskId]!.planning;
  return {
    taskId,
    planning,
    phase: planCommandPhase(planning),
    sideEffectsStarted: taskId == null ? false : state.tasks[taskId]!.sideEffectsStarted,
  };
}

export function runtimeHostStateDecideReadPlanCommand(
  facts: PlanCommandStateFacts,
  command: ReadPlanCommand,
) {
  return decideReadPlanCommand(facts, command);
}

export function runtimeHostStateDecideWritePlanCommand(
  facts: PlanCommandStateFacts,
  command: WritePlanCommand,
) {
  return decideWritePlanCommand(facts, command);
}

export function runtimeHostStateDecideUpdatePlanCommand(
  facts: PlanCommandStateFacts & {
    readonly completionBlocker?: PlanCompletionBlocker | null;
  },
  command: UpdatePlanCommand,
) {
  return decideUpdatePlanCommand(facts, command);
}

export function runtimeHostStateProjectPlanCompletionEvidence(
  state: Readonly<RuntimeState>,
  steps: readonly PlanStep[],
  skippedReasonCodes: Readonly<Record<string, string>> = {},
) {
  return projectPlanCompletionEvidence(state, steps, skippedReasonCodes);
}

export function runtimeHostStatePlanCompletionBlocker(
  state: Readonly<RuntimeState>,
  evidence: Parameters<typeof planCompletionBlocker>[1],
) {
  return planCompletionBlocker(state, evidence);
}

export function runtimeHostStateEmptyPlanCompletionEvidence() {
  return emptyPlanCompletionEvidence();
}

export function runtimeHostStatePlanReviewSiblingCancellations(
  state: Readonly<RuntimeState>,
  openingToolCallId: string,
) {
  return decidePlanReviewSiblingCancellations(state, openingToolCallId);
}
