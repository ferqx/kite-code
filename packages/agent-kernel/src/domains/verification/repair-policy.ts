import { numberField, recordField, stringField } from '../../reducer-utils';
import type { AgentState } from '../../state';

export function verificationRepairsAreUnbounded(state: AgentState): boolean {
  return (
    state.resourceBudget.status === 'active' &&
    (state.resourceBudget.budget.unboundedCumulativeUsage === true ||
      state.resourceBudget.budget.durationOnlyChildRun === true)
  );
}

/** Old quota exhaustion can resume after migration; invalid specifications cannot. */
export function canResumeQuotaExhaustedVerification(
  state: AgentState,
  record: Readonly<Record<string, unknown>>,
): boolean {
  const repair = recordField(recordField(record, 'spec') ?? {}, 'repair');
  const maxAttempts = numberField(repair ?? {}, 'maxAttempts');
  return (
    verificationRepairsAreUnbounded(state) &&
    stringField(record, 'mode') === 'required' &&
    stringField(record, 'status') === 'budget_exhausted' &&
    (record.diagnostics === undefined ||
      (Array.isArray(record.diagnostics) && record.diagnostics.length === 0)) &&
    maxAttempts !== undefined &&
    (numberField(record, 'repairAttempts') ?? 0) >= maxAttempts
  );
}
