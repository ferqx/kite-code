import type { PlanCompletionEvidence } from '@kite-ai/runtime-contract';

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

/** Canonical pure validator for PlanCompletionEvidence. */
export function isPlanCompletionEvidence(value: unknown): value is PlanCompletionEvidence {
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
