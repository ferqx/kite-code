import type { PlanCompletionEvidenceV1, PlanStep } from '@/protocol/events';
import type { RuntimeState, ToolCallRecord, VerificationRecord } from './state';

const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SAFE_REASON_CODE = /^[a-z][a-z0-9_]{0,63}$/;

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isPlanCompletionEvidenceV1(value: unknown): value is PlanCompletionEvidenceV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['schemaVersion', 'verification', 'execution', 'skipped', 'unresolved'])
  ) {
    return false;
  }
  if (
    value.schemaVersion !== 1 ||
    !Array.isArray(value.verification) ||
    !Array.isArray(value.execution) ||
    !Array.isArray(value.skipped) ||
    !Array.isArray(value.unresolved)
  ) {
    return false;
  }
  return (
    value.verification.every(
      (entry) =>
        isRecord(entry) &&
        hasExactKeys(entry, ['verificationId', 'outcome']) &&
        typeof entry.verificationId === 'string' &&
        SAFE_REFERENCE.test(entry.verificationId) &&
        (entry.outcome === 'passed' || entry.outcome === 'waived'),
    ) &&
    value.execution.every(
      (entry) =>
        isRecord(entry) &&
        hasExactKeys(entry, ['toolCallId', 'outcome']) &&
        typeof entry.toolCallId === 'string' &&
        SAFE_REFERENCE.test(entry.toolCallId) &&
        entry.outcome === 'succeeded',
    ) &&
    value.skipped.every(
      (entry) =>
        isRecord(entry) &&
        hasExactKeys(entry, ['stepId', 'reasonCode']) &&
        typeof entry.stepId === 'string' &&
        SAFE_REFERENCE.test(entry.stepId) &&
        typeof entry.reasonCode === 'string' &&
        SAFE_REASON_CODE.test(entry.reasonCode),
    ) &&
    value.unresolved.every(
      (entry) =>
        isRecord(entry) &&
        hasExactKeys(entry, ['kind', 'referenceId']) &&
        (entry.kind === 'failure' || entry.kind === 'approval') &&
        typeof entry.referenceId === 'string' &&
        SAFE_REFERENCE.test(entry.referenceId),
    )
  );
}

function belongsToActiveTask(
  state: RuntimeState,
  record: Pick<ToolCallRecord, 'taskId'> | Pick<VerificationRecord, 'taskId'>,
): boolean {
  return (
    record.taskId == null || state.activeTaskId == null || record.taskId === state.activeTaskId
  );
}

function relevantEffectCalls(state: RuntimeState): ToolCallRecord[] {
  return Object.values(state.tools.calls).filter(
    (call) => call.sideEffect === true && belongsToActiveTask(state, call),
  );
}

function relevantPendingCalls(state: RuntimeState): ToolCallRecord[] {
  return Object.values(state.tools.calls).filter(
    (call) =>
      belongsToActiveTask(state, call) &&
      [
        'awaiting_user_input',
        'awaiting_review',
        'awaiting_approval',
        'awaiting_auto_review',
      ].includes(call.status),
  );
}

export function projectPlanCompletionEvidenceV1(
  state: RuntimeState,
  steps: readonly PlanStep[],
  skippedReasonCodes: Readonly<Record<string, string>> = {},
): PlanCompletionEvidenceV1 {
  const previous =
    state.planning.kind === 'executing' && state.planning.document.planSchemaVersion === 2
      ? state.planning.document.completionEvidence
      : undefined;
  const priorSkipped = new Map(
    (previous?.skipped ?? []).map((entry) => [entry.stepId, entry.reasonCode]),
  );
  const verification = Object.values(state.verification.records)
    .filter(
      (record) =>
        belongsToActiveTask(state, record) &&
        (record.status === 'passed' || record.status === 'waived'),
    )
    .map((record) => ({
      verificationId: record.verificationId,
      outcome: record.status as 'passed' | 'waived',
    }))
    .sort((left, right) => left.verificationId.localeCompare(right.verificationId));
  const calls = relevantEffectCalls(state);
  const execution = calls
    .filter((call) => call.status === 'succeeded' && call.result?.ok === true)
    .map((call) => ({ toolCallId: call.toolCallId, outcome: 'succeeded' as const }))
    .sort((left, right) => left.toolCallId.localeCompare(right.toolCallId));
  const unresolved = Object.values(state.tools.calls)
    .filter((call) => belongsToActiveTask(state, call))
    .reduce<PlanCompletionEvidenceV1['unresolved']>((entries, call) => {
      if (call.status === 'awaiting_approval') {
        entries.push({ kind: 'approval', referenceId: call.toolCallId });
      }
      if (['failed', 'rejected', 'cancelled', 'exhausted'].includes(call.status)) {
        if (call.sideEffect === true) {
          entries.push({ kind: 'failure', referenceId: call.toolCallId });
        }
      }
      return entries;
    }, [])
    .sort((left, right) =>
      `${left.kind}:${left.referenceId}`.localeCompare(`${right.kind}:${right.referenceId}`),
    );
  const skipped = steps
    .filter((step) => step.status === 'skipped')
    .map((step) => ({
      stepId: step.id,
      reasonCode: skippedReasonCodes[step.id] ?? priorSkipped.get(step.id) ?? '',
    }))
    .sort((left, right) => left.stepId.localeCompare(right.stepId));
  return { schemaVersion: 1, verification, execution, skipped, unresolved };
}

export type PlanCompletionBlocker =
  | 'plan_verification_required'
  | 'plan_effect_evidence_required'
  | 'plan_unresolved_blocker'
  | 'plan_skipped_reason_required';

export function planCompletionBlocker(
  state: RuntimeState,
  evidence: PlanCompletionEvidenceV1,
): PlanCompletionBlocker | null {
  if (state.interactions.kind !== 'idle' || relevantPendingCalls(state).length > 0) {
    return 'plan_unresolved_blocker';
  }
  const requiredVerificationMissing = Object.values(state.verification.records).some(
    (record) =>
      belongsToActiveTask(state, record) &&
      record.mode === 'required' &&
      record.status !== 'passed' &&
      record.status !== 'waived',
  );
  if (requiredVerificationMissing) return 'plan_verification_required';
  if (evidence.skipped.some((entry) => !SAFE_REASON_CODE.test(entry.reasonCode))) {
    return 'plan_skipped_reason_required';
  }
  if (evidence.unresolved.length > 0) return 'plan_unresolved_blocker';
  const effectCalls = relevantEffectCalls(state);
  const activeTask = state.activeTaskId ? state.tasks[state.activeTaskId] : undefined;
  if (
    (activeTask?.sideEffectsStarted === true && evidence.execution.length === 0) ||
    effectCalls.some(
      (call) =>
        call.status !== 'succeeded' ||
        call.result?.ok !== true ||
        !evidence.execution.some((entry) => entry.toolCallId === call.toolCallId),
    )
  ) {
    return 'plan_effect_evidence_required';
  }
  return null;
}

export function planCompletionEvidenceMatchesRuntime(
  state: RuntimeState,
  steps: readonly PlanStep[],
  evidence: PlanCompletionEvidenceV1,
): boolean {
  if (!isPlanCompletionEvidenceV1(evidence)) return false;
  const reasonCodes = Object.fromEntries(
    evidence.skipped.map((entry) => [entry.stepId, entry.reasonCode]),
  );
  return (
    JSON.stringify(projectPlanCompletionEvidenceV1(state, steps, reasonCodes)) ===
    JSON.stringify(evidence)
  );
}
