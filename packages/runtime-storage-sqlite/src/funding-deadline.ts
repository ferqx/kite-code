type RecordValue = Readonly<Record<string, unknown>>;

function unlimitedPrimary(ledger: RecordValue, snapshot: RecordValue): boolean {
  const budget = ledger.budget as RecordValue | undefined;
  return (
    snapshot.childSessionOrigin === undefined &&
    ledger.deadlineAt === null &&
    budget?.unboundedRunDuration === true &&
    budget.unboundedCumulativeUsage === true &&
    budget.durationOnlyChildRun !== true &&
    budget.maxRunDurationMs === 0
  );
}

/** Store independently validates the funding identity; malformed or child null never means infinity. */
export function storedFundingDeadlineMatches(
  ledger: RecordValue,
  deadline: string | null,
  snapshot: RecordValue,
): boolean {
  if (deadline === null) return unlimitedPrimary(ledger, snapshot);
  if (!Number.isFinite(Date.parse(deadline))) return false;
  return (
    ledger.deadlineAt === deadline ||
    (unlimitedPrimary(ledger, snapshot) && ledger.previousDeadlineAt === deadline)
  );
}

export function storedFundingDeadlineMs(ledger: RecordValue, snapshot: RecordValue): number {
  if (unlimitedPrimary(ledger, snapshot)) return Infinity;
  return typeof ledger.deadlineAt === 'string' ? Date.parse(ledger.deadlineAt) : NaN;
}

/** Admission JSON carries an epoch number or null; only its original funding ledger can validate it. */
export function storedAdmissionDeadlineMs(
  ledger: RecordValue,
  deadline: unknown,
  snapshot: RecordValue,
): number {
  if (deadline === null) return unlimitedPrimary(ledger, snapshot) ? Infinity : NaN;
  if (
    typeof deadline !== 'number' ||
    !Number.isSafeInteger(deadline) ||
    !Number.isFinite(new Date(deadline).getTime())
  )
    return NaN;
  return storedFundingDeadlineMatches(ledger, new Date(deadline).toISOString(), snapshot)
    ? deadline
    : NaN;
}
