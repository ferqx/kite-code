import {
  decidePlanReviewSiblingCancellationsV1,
  decideReadPlanCommandV1,
  decideUpdatePlanCommandV1,
  decideWritePlanCommandV1,
  emptyPlanCompletionEvidenceV1,
  type PlanCommandStateFactsV1,
  type PlanCompletionBlockerV1,
  planCommandPhaseV1,
  planCompletionBlocker,
  projectPlanCompletionEvidenceV1,
  type ReadPlanCommandV1,
  type UpdatePlanCommandV1,
  type WritePlanCommandV1,
} from '@kite/agent-kernel';
import type { PlanStep } from '@kite/runtime-contract';
import type { RuntimeState } from './state26-initial';

/**
 * Host-owned typed wrapper around the pure State26 plan admission functions.
 *
 * Host does not parse plan documents, persist artifacts, or construct model
 * projections. It only supplies the canonical Kernel facts and exposes the
 * Kernel decisions to the App composition root.
 */
export function runtimeHostState26PlanCommandFactsV1(
  state: Readonly<RuntimeState>,
): PlanCommandStateFactsV1 {
  const taskId = state.activeTaskId == null ? undefined : state.activeTaskId;
  const planning =
    taskId == null ? ({ kind: 'building_without_plan' } as const) : state.tasks[taskId]!.planning;
  return {
    taskId,
    planning,
    phase: planCommandPhaseV1(planning),
    sideEffectsStarted: taskId == null ? false : state.tasks[taskId]!.sideEffectsStarted,
  };
}

export function runtimeHostState26DecideReadPlanCommandV1(
  facts: PlanCommandStateFactsV1,
  command: ReadPlanCommandV1,
) {
  return decideReadPlanCommandV1(facts, command);
}

export function runtimeHostState26DecideWritePlanCommandV1(
  facts: PlanCommandStateFactsV1,
  command: WritePlanCommandV1,
) {
  return decideWritePlanCommandV1(facts, command);
}

export function runtimeHostState26DecideUpdatePlanCommandV1(
  facts: PlanCommandStateFactsV1 & {
    readonly completionBlocker?: PlanCompletionBlockerV1 | null;
  },
  command: UpdatePlanCommandV1,
) {
  return decideUpdatePlanCommandV1(facts, command);
}

export function runtimeHostState26ProjectPlanCompletionEvidenceV1(
  state: Readonly<RuntimeState>,
  steps: readonly PlanStep[],
  skippedReasonCodes: Readonly<Record<string, string>> = {},
) {
  return projectPlanCompletionEvidenceV1(state, steps, skippedReasonCodes);
}

export function runtimeHostState26PlanCompletionBlockerV1(
  state: Readonly<RuntimeState>,
  evidence: Parameters<typeof planCompletionBlocker>[1],
) {
  return planCompletionBlocker(state, evidence);
}

export function runtimeHostState26EmptyPlanCompletionEvidenceV1() {
  return emptyPlanCompletionEvidenceV1();
}

export function runtimeHostState26PlanReviewSiblingCancellationsV1(
  state: Readonly<RuntimeState>,
  openingToolCallId: string,
) {
  return decidePlanReviewSiblingCancellationsV1(state, openingToolCallId);
}
