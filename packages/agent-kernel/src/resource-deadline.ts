/** Mathematical comparison of validated deadline identities; null means no Run deadline. */
export function resourceDeadlineMs(deadlineAt: string | null): number {
  return deadlineAt === null ? Infinity : Date.parse(deadlineAt);
}

/** Match a sealed funding deadline against its same-Run ledger, including a proven upgrade. */
export function fundingDeadlineMatches(
  ledger: {
    readonly deadlineAt: string | null;
    readonly previousDeadlineAt?: string;
    readonly budget: {
      readonly unboundedRunDuration?: true;
      readonly unboundedCumulativeUsage?: true;
      readonly durationOnlyChildRun?: true;
    };
  },
  deadlineAt: string | null,
): boolean {
  if (deadlineAt === null)
    return (
      ledger.deadlineAt === null &&
      ledger.budget.unboundedRunDuration === true &&
      ledger.budget.unboundedCumulativeUsage === true &&
      ledger.budget.durationOnlyChildRun !== true
    );
  return (
    ledger.deadlineAt === deadlineAt ||
    (ledger.deadlineAt === null &&
      ledger.budget.unboundedRunDuration === true &&
      ledger.budget.unboundedCumulativeUsage === true &&
      ledger.budget.durationOnlyChildRun !== true &&
      ledger.previousDeadlineAt === deadlineAt)
  );
}
