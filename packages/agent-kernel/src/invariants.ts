import { childThreadIdForToolAttempt, sameChildTaskArtifactRef } from './child-session';
import { sha256Hex } from './hash';
import { isToolOutcome } from './normalization';
import {
  type AgentState,
  APPLIED_EVENT_ID_TAIL_LIMIT,
  RUNTIME_STATE_FORMAT_EPOCH,
  RUNTIME_STATE_SCHEMA_VERSION,
} from './state';

export class AgentInvariantError extends Error {
  readonly code = 'RUNTIME_INVARIANT_VIOLATION';

  constructor(message: string) {
    super(message);
    this.name = 'AgentInvariantError';
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new AgentInvariantError(message);
}

function assertUnique(values: readonly string[], label: string): void {
  assert(new Set(values).size === values.length, `${label} contains duplicate ids.`);
}

type UnknownRecord = Readonly<Record<string, unknown>>;

function record(value: unknown): UnknownRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function stringValue(value: UnknownRecord | undefined, field: string): string | undefined {
  const candidate = value?.[field];
  return typeof candidate === 'string' ? candidate : undefined;
}

function numberValue(value: UnknownRecord | undefined, field: string): number | undefined {
  const candidate = value?.[field];
  return typeof candidate === 'number' ? candidate : undefined;
}

function recordValue(value: UnknownRecord | undefined, field: string): UnknownRecord | undefined {
  return record(value?.[field]);
}

function validTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
  );
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const serialized = JSON.stringify(value);
    assert(serialized !== undefined, 'value is not JSON serializable.');
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.entries(value as UnknownRecord)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
    .join(',')}}`;
}

function digestValue(value: unknown): string {
  return sha256Hex(stableStringify(value));
}

function exactShape(value: UnknownRecord | undefined, keys: readonly string[]): boolean {
  if (!value) return false;
  const expected = new Set(keys);
  return (
    Object.keys(value).length === expected.size &&
    Object.keys(value).every((key) => expected.has(key))
  );
}

function assertToolOutcome(value: unknown, label: string): void {
  assert(isToolOutcome(value), `${label} has an invalid canonical ToolOutcome.`);
}

function assertResourceBudget(state: AgentState): void {
  if (state.resourceBudget.status === 'unconfigured') {
    assert(
      Object.keys(state.resourceBudget.reservations).length === 0,
      'unconfigured budget has reservations.',
    );
    return;
  }
  const active = state.resourceBudget;
  assert(
    active.runId.length > 0 &&
      validTimestamp(active.startedAt) &&
      validTimestamp(active.deadlineAt),
    'active resource budget identity/timestamps are invalid.',
  );
  const totalWait = active.totalRequiredChildWaitMs ?? 0;
  assert(
    Number.isSafeInteger(totalWait) &&
      totalWait >= 0 &&
      Date.parse(active.deadlineAt) - Date.parse(active.startedAt) <=
        active.budget.maxRunDurationMs + totalWait,
    'required child wait exceeds the active Run duration.',
  );
  const validTaskIds = (ids: readonly string[]): boolean =>
    Array.isArray(ids) &&
    ids.length > 0 &&
    ids.every(
      (id, index) =>
        typeof id === 'string' && id.length > 0 && (index === 0 || ids[index - 1]! < id),
    );
  if (active.requiredChildWait)
    assert(
      validTimestamp(active.requiredChildWait.startedAt) &&
        Date.parse(active.requiredChildWait.startedAt) >= Date.parse(active.startedAt) &&
        validTaskIds(active.requiredChildWait.taskIds),
      'active required child wait is invalid.',
    );
  if (active.lastRequiredChildWait)
    assert(
      validTimestamp(active.lastRequiredChildWait.startedAt) &&
        validTimestamp(active.lastRequiredChildWait.endedAt) &&
        Date.parse(active.lastRequiredChildWait.endedAt) >=
          Date.parse(active.lastRequiredChildWait.startedAt) &&
        validTaskIds(active.lastRequiredChildWait.taskIds),
      'last required child wait is invalid.',
    );
  const budget = record(active.budget);
  assert(budget?.version === 1, 'resource budget version is invalid.');
  const budgetFields = [
    'maxRunDurationMs',
    'maxTurns',
    'maxModelRequests',
    'maxToolInvocations',
    'maxRunInputTokens',
    'maxRunOutputTokens',
    'maxConcurrentSubagents',
    'maxConcurrentWriters',
    'maxConcurrentToolInvocations',
    'maxConcurrentShellInvocations',
    'maxConcurrencyWaitMs',
    'maxArtifactBytes',
  ];
  const zeroAllowedBudgetFields = new Set([
    'maxToolInvocations',
    'maxArtifactBytes',
    'maxConcurrentSubagents',
    'maxConcurrentWriters',
    'maxConcurrentToolInvocations',
    'maxConcurrentShellInvocations',
  ]);
  assert(
    budgetFields.every(
      (field) =>
        Number.isSafeInteger(numberValue(budget, field)) &&
        (numberValue(budget, field) ?? -1) >= (zeroAllowedBudgetFields.has(field) ? 0 : 1),
    ),
    'resource budget limits are invalid.',
  );
  assert(
    budget.unboundedToolInvocations === undefined ||
      (budget.unboundedToolInvocations === true && budget.maxToolInvocations === 0),
    'unbounded Tool budget marker is invalid.',
  );
  assert(
    (numberValue(budget, 'maxConcurrentShellInvocations') ?? 0) <=
      (numberValue(budget, 'maxConcurrentToolInvocations') ?? -1),
    'shell concurrency exceeds tool concurrency.',
  );
  assert(
    (numberValue(budget, 'maxConcurrentWriters') ?? 0) <=
      (numberValue(budget, 'maxConcurrentToolInvocations') ?? -1),
    'writer concurrency exceeds tool concurrency.',
  );
  assertUsage(record(active.reconciledUsage), 'reconciled usage', 'actual');
  assert(
    Number.isSafeInteger(active.nextWaiterSequence) && active.nextWaiterSequence >= 0,
    'resource budget waiter sequence is invalid.',
  );
  const sequences = new Set<number>();
  let delegatedToolInvocations = 0;
  for (const [reservationId, reservationValue] of Object.entries(active.reservations)) {
    const reservation = record(reservationValue);
    assert(
      reservation != null &&
        Object.keys(reservation).every((key) =>
          [
            'version',
            'reservationId',
            'runId',
            'invocationId',
            'parentReservationId',
            'replacesReservationId',
            'resourceKind',
            'executableUpperBound',
            'actual',
            'state',
          ].includes(key),
        ) &&
        [
          'version',
          'reservationId',
          'runId',
          'invocationId',
          'resourceKind',
          'executableUpperBound',
          'state',
        ].every((key) => Object.hasOwn(reservation, key)),
      'resource reservation shape is invalid.',
    );
    assert(
      stringValue(reservation, 'reservationId') === reservationId &&
        stringValue(reservation, 'runId') === active.runId &&
        stringValue(reservation, 'invocationId') != null,
      'resource reservation identity is invalid.',
    );
    assert(
      numberValue(reservation, 'version') === 1 &&
        [
          'model',
          'tool',
          'mcp',
          'skill',
          'subagent',
          'verification',
          'compaction',
          'artifact',
        ].includes(stringValue(reservation, 'resourceKind') ?? ''),
      'resource reservation metadata is invalid.',
    );
    assert(
      ['queued', 'reserved', 'dispatch_started', 'reconciled', 'released', 'unknown'].includes(
        stringValue(reservation, 'state') ?? '',
      ),
      'resource reservation state is invalid.',
    );
    if (stringValue(reservation, 'state') === 'queued') {
      const upper = recordValue(reservation, 'executableUpperBound');
      assert(
        stringValue(reservation, 'resourceKind') === 'subagent' &&
          (((stringValue(reservation, 'reservationId') ?? '').startsWith('child-allotment:') &&
            stringValue(reservation, 'invocationId') ===
              stringValue(reservation, 'reservationId')) ||
            /^backup_[a-f0-9]{64}$/u.test(stringValue(reservation, 'reservationId') ?? '')) &&
          reservation.parentReservationId === undefined &&
          reservation.actual === undefined &&
          numberValue(recordValue(upper, 'gauges'), 'activeSubagents') === 1,
        'queued sub-agent reservation identity is invalid.',
      );
    }
    assertUsage(
      recordValue(reservation, 'executableUpperBound'),
      'reservation upper bound',
      'versioned_upper_bound',
    );
    const childUpper = recordValue(reservation, 'executableUpperBound');
    if (childUpper?.unboundedToolInvocations === true)
      assert(
        reservation.resourceKind === 'subagent' &&
          ((reservation.reservationId === reservation.invocationId &&
            (stringValue(reservation, 'reservationId') ?? '').startsWith('child-allotment:')) ||
            (/^backup_[a-f0-9]{64}$/u.test(stringValue(reservation, 'reservationId') ?? '') &&
              childUpper.independentFollowupTurn === true)),
        'unbounded Tool upper bound requires exact child funding.',
      );
    if (childUpper?.independentFollowupTurn === true)
      assert(
        reservation.resourceKind === 'subagent' &&
          /^backup_[a-f0-9]{64}$/u.test(stringValue(reservation, 'reservationId') ?? '') &&
          childUpper.unboundedToolInvocations === true,
        'independent followup turn requires exact backup funding.',
      );
    if (childUpper?.independentChildTurnDeadline === true)
      assert(
        reservation.resourceKind === 'subagent' &&
          reservation.reservationId === reservation.invocationId &&
          (stringValue(reservation, 'reservationId') ?? '').startsWith('child-allotment:'),
        'independent child deadline requires an exact child allotment.',
      );
    const actual = recordValue(reservation, 'actual');
    if (actual) {
      assertUsage(actual, 'reservation actual usage', 'actual');
      assertUsageWithin(
        actual,
        recordValue(reservation, 'executableUpperBound'),
        'reservation actual exceeds executable upper bound.',
      );
      if (childUpper?.unboundedToolInvocations === true && reservation.state === 'reconciled')
        delegatedToolInvocations +=
          numberValue(recordValue(actual, 'counters'), 'toolInvocations') ?? 0;
    }
    const parent = stringValue(reservation, 'parentReservationId');
    if (parent)
      assert(
        parent !== reservationId && active.reservations[parent] !== undefined,
        'resource reservation parent is invalid.',
      );
    const replaced = stringValue(reservation, 'replacesReservationId');
    if (replaced)
      assert(
        replaced !== reservationId &&
          active.reservations[replaced]?.state === 'released' &&
          active.reservations[replaced]?.resourceKind === 'subagent',
        'resource reservation replacement is invalid.',
      );
  }
  assert(
    Number.isSafeInteger(delegatedToolInvocations) &&
      delegatedToolInvocations <= active.reconciledUsage.counters.toolInvocations,
    'delegated Tool audit total disagrees with reconciled child receipts.',
  );
  for (const [waiterId, waiterValue] of Object.entries(active.waiters)) {
    const waiter = record(waiterValue);
    assert(
      waiter != null &&
        exactShape(waiter, [
          'version',
          'runId',
          'invocationId',
          'requiredPermits',
          'sequence',
          'enqueuedAt',
          'deadlineAt',
          'state',
        ]),
      'resource waiter shape is invalid.',
    );
    assert(
      stringValue(waiter, 'invocationId') === waiterId &&
        stringValue(waiter, 'runId') === active.runId &&
        numberValue(waiter, 'version') === 1,
      'resource waiter identity is invalid.',
    );
    const sequence = numberValue(waiter, 'sequence');
    assert(
      Number.isSafeInteger(sequence) && (sequence ?? -1) >= 0 && !sequences.has(sequence!),
      'resource waiter sequence is invalid.',
    );
    sequences.add(sequence!);
    assert(
      Array.isArray(waiter.requiredPermits) &&
        (waiter.requiredPermits.length === 1 || waiter.requiredPermits.length === 2) &&
        waiter.requiredPermits[0] === 'tool' &&
        (waiter.requiredPermits.length === 1 || waiter.requiredPermits[1] === 'shell_invocation'),
      'resource waiter permits are invalid.',
    );
    assert(
      validTimestamp(waiter.enqueuedAt) &&
        validTimestamp(waiter.deadlineAt) &&
        waiter.deadlineAt > waiter.enqueuedAt &&
        ['waiting', 'promoted', 'cancelled', 'timed_out'].includes(
          stringValue(waiter, 'state') ?? '',
        ),
      'resource waiter timing/state is invalid.',
    );
  }
  assert(
    committedUsageWithinBudget(active),
    'committed resource usage exceeds the effective budget.',
  );
}

function assertRetainedResourceBudgets(state: AgentState): void {
  const retained = state.retainedResourceBudgets;
  assert(
    retained != null && typeof retained === 'object' && !Array.isArray(retained),
    'retained resource budgets must be a map.',
  );
  const reservationIds = new Set<string>();
  const waiterIds = new Set<string>();
  const ledgers = [
    ...(state.resourceBudget.status === 'active' ? [state.resourceBudget] : []),
    ...Object.values(retained),
  ];
  for (const [runId, ledger] of Object.entries(retained)) {
    assert(
      runId.length > 0 && ledger?.status === 'active' && ledger.runId === runId,
      'retained resource budget identity is invalid.',
    );
    assert(
      state.resourceBudget.status !== 'active' || state.resourceBudget.runId !== runId,
      'current and retained resource budget Run IDs overlap.',
    );
    assertResourceBudget({ ...state, resourceBudget: ledger });
    assert(
      Object.values(ledger.reservations).some((reservation) =>
        ['queued', 'reserved', 'dispatch_started', 'unknown'].includes(reservation.state),
      ) || Object.values(ledger.waiters).some((waiter) => waiter.state === 'waiting'),
      'retained resource budget has no unsettled authority.',
    );
  }
  for (const ledger of ledgers) {
    for (const id of Object.keys(ledger.reservations)) {
      assert(!reservationIds.has(id), 'resource reservation ID appears in more than one ledger.');
      reservationIds.add(id);
    }
    for (const id of Object.keys(ledger.waiters)) {
      assert(!waiterIds.has(id), 'resource waiter ID appears in more than one ledger.');
      waiterIds.add(id);
    }
  }
}

function assertUsage(
  value: UnknownRecord | undefined,
  label: string,
  source: 'actual' | 'versioned_upper_bound',
): void {
  assert(
    value != null &&
      ['counters', 'gauges', 'source'].every((key) => Object.hasOwn(value, key)) &&
      Object.keys(value).every((key) =>
        [
          'counters',
          'gauges',
          'source',
          'estimatorVersion',
          'unboundedToolInvocations',
          'independentChildTurnDeadline',
          'independentFollowupTurn',
        ].includes(key),
      ),
    `${label} shape is invalid.`,
  );
  assert(stringValue(value, 'source') === source, `${label} source is invalid.`);
  const counters = recordValue(value, 'counters');
  const gauges = recordValue(value, 'gauges');
  assert(counters != null && gauges != null, `${label} counters/gauges are required.`);
  for (const field of [
    'turns',
    'modelRequests',
    'toolInvocations',
    'inputTokens',
    'outputTokens',
    'artifactBytes',
    'elapsedRunMs',
    'activeSubagents',
    'activeWriters',
    'activeToolInvocations',
    'activeShellInvocations',
  ])
    assert(
      Number.isSafeInteger(numberValue(counters, field) ?? numberValue(gauges, field)) &&
        (numberValue(counters, field) ?? numberValue(gauges, field) ?? -1) >= 0,
      `${label} has invalid ${field}.`,
    );
  if (source === 'versioned_upper_bound')
    assert(
      typeof value.estimatorVersion === 'string' && value.estimatorVersion.length > 0,
      `${label} estimator version is required.`,
    );
  else
    assert(
      value.estimatorVersion === undefined,
      `${label} actual usage cannot have estimator version.`,
    );
  assert(
    (value.unboundedToolInvocations === undefined ||
      (source === 'versioned_upper_bound' &&
        value.unboundedToolInvocations === true &&
        numberValue(counters, 'toolInvocations') === 0)) &&
      (value.independentChildTurnDeadline === undefined ||
        (source === 'versioned_upper_bound' && value.independentChildTurnDeadline === true)) &&
      (value.independentFollowupTurn === undefined ||
        (source === 'versioned_upper_bound' && value.independentFollowupTurn === true)),
    `${label} authority marker is invalid.`,
  );
}

function assertUsageWithin(
  actual: UnknownRecord | undefined,
  upper: UnknownRecord | undefined,
  message: string,
): void {
  assert(actual != null && upper != null, message);
  for (const field of [
    'turns',
    'modelRequests',
    'toolInvocations',
    'inputTokens',
    'outputTokens',
    'artifactBytes',
  ])
    if (field !== 'toolInvocations' || upper.unboundedToolInvocations !== true)
      assert(
        (numberValue(recordValue(actual, 'counters'), field) ?? 0) <=
          (numberValue(recordValue(upper, 'counters'), field) ?? -1),
        message,
      );
  for (const field of [
    'elapsedRunMs',
    'activeSubagents',
    'activeWriters',
    'activeToolInvocations',
    'activeShellInvocations',
  ])
    assert(
      (numberValue(recordValue(actual, 'gauges'), field) ?? 0) <=
        (numberValue(recordValue(upper, 'gauges'), field) ?? -1),
      message,
    );
}

function committedUsageWithinBudget(
  active: AgentState['resourceBudget'] & { status: 'active' },
): boolean {
  const budget = record(active.budget);
  if (!budget) return false;
  const counterLimits: Readonly<Record<string, string>> = {
    turns: 'maxTurns',
    modelRequests: 'maxModelRequests',
    toolInvocations: 'maxToolInvocations',
    inputTokens: 'maxRunInputTokens',
    outputTokens: 'maxRunOutputTokens',
    artifactBytes: 'maxArtifactBytes',
  };
  const gaugeLimits: Readonly<Record<string, string>> = {
    elapsedRunMs: 'maxRunDurationMs',
    activeSubagents: 'maxConcurrentSubagents',
    activeWriters: 'maxConcurrentWriters',
    activeToolInvocations: 'maxConcurrentToolInvocations',
    activeShellInvocations: 'maxConcurrentShellInvocations',
  };
  const counterSums: Record<string, number> = {
    turns: 0,
    modelRequests: 0,
    toolInvocations: 0,
    inputTokens: 0,
    outputTokens: 0,
    artifactBytes: 0,
  };
  const gaugeSums: Record<string, number> = {
    elapsedRunMs: 0,
    activeSubagents: 0,
    activeWriters: 0,
    activeToolInvocations: 0,
    activeShellInvocations: 0,
  };
  const add = (usage: UnknownRecord | undefined): void => {
    if (!usage) return;
    for (const field of Object.keys(counterSums))
      counterSums[field] =
        (counterSums[field] ?? 0) + (numberValue(recordValue(usage, 'counters'), field) ?? 0);
    for (const field of Object.keys(gaugeSums)) {
      const value = numberValue(recordValue(usage, 'gauges'), field) ?? 0;
      gaugeSums[field] =
        field === 'elapsedRunMs'
          ? Math.max(gaugeSums[field] ?? 0, value)
          : (gaugeSums[field] ?? 0) + value;
    }
  };
  add(record(active.reconciledUsage));
  for (const reservation of Object.values(active.reservations)) {
    const state = stringValue(record(reservation), 'state');
    const upper = recordValue(record(reservation), 'executableUpperBound');
    if (['reserved', 'dispatch_started', 'unknown'].includes(state ?? '')) add(upper);
    else if (state === 'queued') {
      const counters = recordValue(upper, 'counters');
      const gauges = recordValue(upper, 'gauges');
      for (const field of Object.keys(counterSums))
        counterSums[field] = (counterSums[field] ?? 0) + (numberValue(counters, field) ?? 0);
      gaugeSums.elapsedRunMs = Math.max(
        gaugeSums.elapsedRunMs ?? 0,
        numberValue(gauges, 'elapsedRunMs') ?? 0,
      );
    }
  }
  const delegatedToolInvocations = Object.values(active.reservations).reduce(
    (total, reservation) =>
      total +
      (reservation.state === 'reconciled' &&
      reservation.executableUpperBound.unboundedToolInvocations === true
        ? (reservation.actual?.counters.toolInvocations ?? 0)
        : 0),
    0,
  );
  return (
    Object.entries(counterLimits).every(
      ([field, limit]) =>
        (field === 'toolInvocations' && budget.unboundedToolInvocations === true) ||
        counterSums[field]! - (field === 'toolInvocations' ? delegatedToolInvocations : 0) <=
          (numberValue(budget, limit) ?? -1),
    ) &&
    Object.entries(gaugeLimits).every(
      ([field, limit]) => gaugeSums[field]! <= (numberValue(budget, limit) ?? -1),
    )
  );
}

function assertRecoveryJournal(state: AgentState): void {
  assert(
    state.recoveryState.kind === 'normal' || state.turn.status === 'aborted',
    'recovery state must be normal before execution.',
  );
  for (const failureId of state.toolRecovery.order) {
    const failure = record(state.toolRecovery.failures[failureId]);
    assert(failure != null, `recovery failure ${failureId} is missing.`);
    assert(
      stringValue(failure, 'failureInstanceId') === failureId,
      `recovery failure ${failureId} identity is invalid.`,
    );
    assert(
      stringValue(failure, 'toolCallId') != null && stringValue(failure, 'toolName') != null,
      `recovery failure ${failureId} tool identity is invalid.`,
    );
    const fingerprint = stringValue(failure, 'invocationFingerprint');
    assert(
      fingerprint != null && fingerprint.length > 0,
      `recovery failure ${failureId} invocation fingerprint is required.`,
    );
    assert(
      ['unresolved', 'recovered', 'exhausted'].includes(stringValue(failure, 'status') ?? ''),
      `recovery failure ${failureId} status is invalid.`,
    );
    assertToolOutcome(failure.outcome, `recovery failure ${failureId}`);
    const failureOutcome = recordValue(recordValue(failure, 'outcome'), 'failure');
    assert(
      sha256Hex(
        stableStringify({
          detailCode: stringValue(failureOutcome, 'detailCode') ?? 'success',
          invocationFingerprint: fingerprint,
          status: stringValue(recordValue(failure, 'outcome'), 'status'),
          toolCallId: stringValue(failure, 'toolCallId'),
        }),
      ) === failureId,
      `recovery failure ${failureId} does not match its canonical material.`,
    );
    assert(
      Number.isSafeInteger(numberValue(failure, 'modelCorrectionAttempts')) &&
        (numberValue(failure, 'modelCorrectionAttempts') ?? -1) >= 0,
      `recovery failure ${failureId} correction count is invalid.`,
    );
    assert(
      Number.isSafeInteger(numberValue(failure, 'automaticRetryAttempts')) &&
        (numberValue(failure, 'automaticRetryAttempts') ?? -1) >= 0,
      `recovery failure ${failureId} retry count is invalid.`,
    );
    assert(
      Number.isSafeInteger(numberValue(failure, 'progressRevision')) &&
        (numberValue(failure, 'progressRevision') ?? -1) >= 0,
      `recovery failure ${failureId} progress revision is invalid.`,
    );
    const lineage =
      recordValue(failure, 'outcome') && recordValue(recordValue(failure, 'outcome'), 'lineage');
    const recoveryOf = stringValue(lineage, 'recoveryOf');
    if (recoveryOf)
      assert(
        recoveryOf !== failureId && state.toolRecovery.failures[recoveryOf] != null,
        `recovery failure ${failureId} lineage is dangling.`,
      );
    if (recoveryOf) {
      const parent = record(state.toolRecovery.failures[recoveryOf]);
      assert(
        parent != null &&
          (numberValue(parent, 'modelCorrectionAttempts') ?? 0) <=
            (numberValue(failure, 'modelCorrectionAttempts') ?? -1) &&
          (numberValue(parent, 'automaticRetryAttempts') ?? 0) <=
            (numberValue(failure, 'automaticRetryAttempts') ?? -1),
        `recovery failure ${failureId} attempt counters regress across lineage.`,
      );
    }
  }
}

function validString(value: unknown, maximum = 4096): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    !value.includes('\0')
  );
}

function validBareDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function validPrefixedDigest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function validPrivateArtifact(value: unknown, kind: string): boolean {
  const artifact = record(value);
  return (
    artifact != null &&
    exactShape(artifact, ['artifactId', 'kind', 'integrityIdentifier', 'byteLength']) &&
    stringValue(artifact, 'kind') === kind &&
    /^pa_[a-f0-9]{64}$/u.test(stringValue(artifact, 'artifactId') ?? '') &&
    /^sha256:[a-f0-9]{64}$/u.test(stringValue(artifact, 'integrityIdentifier') ?? '') &&
    Number.isSafeInteger(numberValue(artifact, 'byteLength')) &&
    (numberValue(artifact, 'byteLength') ?? 0) > 0
  );
}

export function isValidFilesystemIntent(value: unknown): boolean {
  const intent = record(value);
  if (
    !intent ||
    !exactShape(intent, [
      'attempt',
      'capabilityRevision',
      'argumentsDigest',
      'admissionDigest',
      'operationDigest',
      'searchBoundaryDigest',
      'lexicalTargetDigest',
      'canonicalWorkspaceDigest',
      'protectedPathRevision',
      'approvalSummaryDigest',
      'effectiveEffectsDigest',
      'intentDigest',
      'recordedAt',
    ]) ||
    !Number.isSafeInteger(numberValue(intent, 'attempt')) ||
    (numberValue(intent, 'attempt') ?? 0) < 1 ||
    !validBareDigest(intent.capabilityRevision) ||
    !validBareDigest(intent.argumentsDigest) ||
    !validBareDigest(intent.admissionDigest) ||
    !validPrefixedDigest(intent.operationDigest) ||
    (intent.searchBoundaryDigest !== null && !validPrefixedDigest(intent.searchBoundaryDigest)) ||
    !validPrefixedDigest(intent.lexicalTargetDigest) ||
    !validPrefixedDigest(intent.canonicalWorkspaceDigest) ||
    !validString(intent.protectedPathRevision) ||
    !validPrefixedDigest(intent.approvalSummaryDigest) ||
    !validBareDigest(intent.effectiveEffectsDigest) ||
    !validPrefixedDigest(intent.intentDigest) ||
    !validTimestamp(intent.recordedAt)
  )
    return false;
  const { intentDigest: _intentDigest, ...unsigned } = intent;
  return intent.intentDigest === `sha256:${digestValue(unsigned)}`;
}

export function isValidFilesystemReady(value: unknown): boolean {
  const ready = record(value);
  if (
    !ready ||
    !exactShape(ready, [
      'attempt',
      'intentDigest',
      'operationDigest',
      'targetIdentityDigest',
      'preimageDigest',
      'preimageArtifact',
      'readyDigest',
      'readyAt',
    ])
  )
    return false;
  if (
    !Number.isSafeInteger(numberValue(ready, 'attempt')) ||
    (numberValue(ready, 'attempt') ?? 0) < 1 ||
    !validPrefixedDigest(ready.intentDigest) ||
    !validPrefixedDigest(ready.operationDigest) ||
    !validPrefixedDigest(ready.targetIdentityDigest) ||
    (ready.preimageDigest !== null && !validPrefixedDigest(ready.preimageDigest)) ||
    !validPrivateArtifact(ready.preimageArtifact, 'filesystem_preimage') ||
    !validPrefixedDigest(ready.readyDigest) ||
    !validTimestamp(ready.readyAt)
  )
    return false;
  const { readyDigest: _readyDigest, ...unsigned } = ready;
  return ready.readyDigest === `sha256:${digestValue(unsigned)}`;
}

export function isValidFilesystemObservation(value: unknown): boolean {
  const observation = record(value);
  return (
    !!observation &&
    exactShape(observation, [
      'actorIdentityDigest',
      'lexicalTargetDigest',
      'canonicalTargetDigest',
      'targetIdentityDigest',
      'contentDigest',
    ]) &&
    validBareDigest(observation.actorIdentityDigest) &&
    validPrefixedDigest(observation.lexicalTargetDigest) &&
    validPrefixedDigest(observation.canonicalTargetDigest) &&
    validPrefixedDigest(observation.targetIdentityDigest) &&
    validPrefixedDigest(observation.contentDigest)
  );
}

export function isValidSandboxIntent(value: unknown): boolean {
  const intent = record(value);
  if (
    !intent ||
    !exactShape(intent, [
      'attempt',
      'toolCallId',
      'capabilityId',
      'capabilityRevision',
      'canonicalWorkspace',
      'effectiveEffectsDigest',
      'admissionDigest',
      'preparationDigest',
      'commandDigest',
      'executionBoundaryDigest',
      'resourceSemantics',
      'intentDigest',
      'recordedAt',
    ]) ||
    !Number.isSafeInteger(numberValue(intent, 'attempt')) ||
    (numberValue(intent, 'attempt') ?? 0) < 1 ||
    !validString(intent.toolCallId) ||
    !validString(intent.capabilityId) ||
    !validString(intent.capabilityRevision) ||
    !validString(intent.canonicalWorkspace) ||
    !validString(intent.effectiveEffectsDigest) ||
    !validString(intent.admissionDigest) ||
    !validString(intent.preparationDigest) ||
    !validString(intent.commandDigest) ||
    !validString(intent.executionBoundaryDigest) ||
    intent.resourceSemantics !== 'allocating' ||
    !validBareDigest(intent.intentDigest) ||
    !validTimestamp(intent.recordedAt)
  )
    return false;
  // State 27 binds the preparation facts, while the event timestamp remains
  // envelope metadata. Keep this byte-for-byte aligned with the existing
  // Runtime contract validator and its persisted Store 4 records.
  const { intentDigest: _intentDigest, recordedAt: _recordedAt, ...unsigned } = intent;
  return intent.intentDigest === digestValue(unsigned);
}

export function isValidSandboxReady(value: unknown): boolean {
  const ready = record(value);
  if (
    !ready ||
    !exactShape(ready, [
      'attempt',
      'intentDigest',
      'preparationDigest',
      'commandDigest',
      'planDigest',
      'backend',
      'backendCapabilitiesDigest',
      'enforcement',
      'resourceSemantics',
      'cleanupDigest',
      'preparationArtifact',
      'readyDigest',
      'readyAt',
    ])
  )
    return false;
  if (
    !Number.isSafeInteger(numberValue(ready, 'attempt')) ||
    (numberValue(ready, 'attempt') ?? 0) < 1 ||
    !validString(ready.intentDigest) ||
    !validString(ready.preparationDigest) ||
    !validString(ready.commandDigest) ||
    !validString(ready.planDigest) ||
    !['seatbelt', 'bubblewrap', 'windows_restricted_token', 'none'].includes(
      stringValue(ready, 'backend') ?? '',
    ) ||
    !validString(ready.backendCapabilitiesDigest) ||
    !['full', 'partial'].includes(stringValue(ready, 'enforcement') ?? '') ||
    !['pure', 'allocating'].includes(stringValue(ready, 'resourceSemantics') ?? '') ||
    !validString(ready.cleanupDigest) ||
    !validPrivateArtifact(ready.preparationArtifact, 'sandbox_preparation') ||
    !validBareDigest(ready.readyDigest) ||
    !validTimestamp(ready.readyAt)
  )
    return false;
  // As with the intent record, readyAt is event metadata rather than part of
  // the State 27 preparation authority digest.
  const { readyDigest: _readyDigest, readyAt: _readyAt, ...unsigned } = ready;
  return ready.readyDigest === digestValue(unsigned);
}

function assertCapabilityLifecycleEvidence(
  state: AgentState,
  invocationId: string,
  invocation: UnknownRecord,
  status: string | undefined,
): void {
  const lifecycle = recordValue(invocation, 'subagentProviderLifecycle');
  if (!lifecycle) return;
  assert(
    ['builtin:task', 'builtin:activate_skill'].includes(
      stringValue(invocation, 'capabilityId') ?? '',
    ) && ['running', 'succeeded', 'failed', 'unknown'].includes(status ?? ''),
    `governed Subagent invocation ${invocationId} has invalid Provider lifecycle evidence.`,
  );
  assert(
    Number.isSafeInteger(numberValue(lifecycle, 'attempt')) &&
      numberValue(lifecycle, 'attempt') === numberValue(invocation, 'attemptsStarted') &&
      (numberValue(lifecycle, 'attempt') ?? 0) > 0 &&
      ['start', 'resume'].includes(stringValue(lifecycle, 'purpose') ?? '') &&
      validString(lifecycle.childInvocationId) &&
      /^sha256:[a-f0-9]{64}$/u.test(stringValue(lifecycle, 'dispatchIntentDigest') ?? '') &&
      validTimestamp(lifecycle.recordedAt) &&
      validPrivateArtifact(lifecycle.taskArtifact, 'subagent_task'),
    `governed Subagent invocation ${invocationId} has invalid Provider lifecycle evidence.`,
  );
  const handlePresent =
    lifecycle.handleArtifact !== undefined ||
    lifecycle.handleIntegrityIdentifier !== undefined ||
    lifecycle.handleRecordedAt !== undefined;
  const observationPresent =
    lifecycle.observationStatus !== undefined || lifecycle.observedAt !== undefined;
  const cleanupPresent =
    lifecycle.cleanupAttempt !== undefined ||
    lifecycle.cleanupKind !== undefined ||
    lifecycle.cleanupStartedAt !== undefined ||
    lifecycle.cleanupConfirmed !== undefined ||
    lifecycle.cleanupCompletedAt !== undefined;
  const hasHandle =
    validPrivateArtifact(lifecycle.handleArtifact, 'subagent_handle') &&
    /^sha256:[a-f0-9]{64}$/u.test(stringValue(lifecycle, 'handleIntegrityIdentifier') ?? '') &&
    validTimestamp(lifecycle.handleRecordedAt);
  const hasObservation =
    ['completed', 'failed', 'interrupted', 'cancelled', 'exhausted', 'blocked'].includes(
      stringValue(lifecycle, 'observationStatus') ?? '',
    ) && validTimestamp(lifecycle.observedAt);
  const hasCleanup =
    Number.isSafeInteger(numberValue(lifecycle, 'cleanupAttempt')) &&
    (numberValue(lifecycle, 'cleanupAttempt') ?? 0) > 0 &&
    ['undispatched', 'handle_reconcile'].includes(stringValue(lifecycle, 'cleanupKind') ?? '') &&
    validTimestamp(lifecycle.cleanupStartedAt);
  assert(
    (!handlePresent || hasHandle) &&
      (!observationPresent || hasObservation) &&
      (!cleanupPresent || hasCleanup),
    `governed Subagent invocation ${invocationId} has invalid Provider lifecycle evidence.`,
  );
  const lifecycleStatus = stringValue(lifecycle, 'status');
  assert(
    [
      'intent_recorded',
      'handle_recorded',
      'observed',
      'cleanup_pending',
      'cleanup_completed',
    ].includes(lifecycleStatus ?? ''),
    `governed Subagent invocation ${invocationId} has invalid Provider lifecycle evidence.`,
  );
  if (lifecycleStatus === 'intent_recorded')
    assert(
      !handlePresent && !observationPresent && !cleanupPresent,
      `governed Subagent invocation ${invocationId} has invalid Provider lifecycle evidence.`,
    );
  if (lifecycleStatus === 'handle_recorded')
    assert(
      hasHandle && !observationPresent && !cleanupPresent,
      `governed Subagent invocation ${invocationId} has invalid Provider lifecycle evidence.`,
    );
  if (lifecycleStatus === 'observed')
    assert(
      hasHandle && hasObservation && !cleanupPresent,
      `governed Subagent invocation ${invocationId} has invalid Provider lifecycle evidence.`,
    );
  if (lifecycleStatus === 'cleanup_pending')
    assert(
      hasCleanup && lifecycle.cleanupConfirmed !== true,
      `governed Subagent invocation ${invocationId} has invalid Provider lifecycle evidence.`,
    );
  if (lifecycleStatus === 'cleanup_completed')
    assert(
      hasCleanup &&
        lifecycle.cleanupConfirmed === true &&
        validTimestamp(lifecycle.cleanupCompletedAt),
      `governed Subagent invocation ${invocationId} has invalid Provider lifecycle evidence.`,
    );
  const backgroundResult = recordValue(lifecycle, 'backgroundResult');
  const childLink = recordValue(lifecycle, 'childSession');
  const recoveryDiagnostic = childLink && recordValue(childLink, 'recoveryDiagnostic');
  if (recoveryDiagnostic)
    assert(
      exactShape(recoveryDiagnostic, ['diagnosticCode', 'observedAt']) &&
        ['recovery_blocked', 'evidence_inconsistent'].includes(
          stringValue(recoveryDiagnostic, 'diagnosticCode') ?? '',
        ) &&
        validTimestamp(recoveryDiagnostic.observedAt) &&
        stringValue(childLink, 'childThreadId') ===
          childThreadIdForToolAttempt({
            parentSessionId: state.session.threadId,
            parentInvocationId: invocationId,
            parentToolCallId: stringValue(invocation, 'toolCallId') ?? '',
            attempt: numberValue(lifecycle, 'attempt') ?? 0,
          }),
      `governed Subagent invocation ${invocationId} has invalid recovery diagnostic.`,
    );
  if (backgroundResult) {
    const afterTurn = recordValue(backgroundResult, 'afterTurn');
    const childSession = recordValue(lifecycle, 'childSession');
    const terminalImport = childSession && recordValue(childSession, 'terminalImport');
    const independentChildResult =
      lifecycleStatus === 'intent_recorded' &&
      !!terminalImport &&
      Number.isSafeInteger(numberValue(terminalImport, 'terminalRevision')) &&
      (numberValue(terminalImport, 'terminalRevision') ?? -1) >= 0 &&
      (stringValue(terminalImport, 'status') === 'failed' ||
        stringValue(terminalImport, 'status') === 'cancelled' ||
        (numberValue(terminalImport, 'terminalRevision') ?? 0) >= 1) &&
      /^sha256:[a-f0-9]{64}$/u.test(stringValue(terminalImport, 'terminalReceiptDigest') ?? '') &&
      [
        'completed',
        'failed',
        'cancelled',
        'interrupted',
        'exhausted',
        'suspended',
        'unknown',
      ].includes(stringValue(terminalImport, 'status') ?? '') &&
      validPrivateArtifact(terminalImport.resultRef, 'subagent_task') &&
      stringValue(recordValue(terminalImport, 'resultRef') ?? {}, 'integrityIdentifier') ===
        stringValue(backgroundResult, 'artifactIntegrityIdentifier') &&
      stringValue(childSession, 'originRunId') === stringValue(backgroundResult, 'originRunId') &&
      stringValue(childSession, 'originTurnId') === stringValue(backgroundResult, 'originTurnId') &&
      stringValue(childSession, 'originToolCallId') ===
        stringValue(backgroundResult, 'originToolCallId') &&
      stringValue(childSession, 'childThreadId') ===
        childThreadIdForToolAttempt({
          parentSessionId: state.session.threadId,
          parentInvocationId: invocationId,
          parentToolCallId: stringValue(invocation, 'toolCallId') ?? '',
          attempt: numberValue(lifecycle, 'attempt') ?? 0,
        }) &&
      sameChildTaskArtifactRef(childSession.taskArtifactRef, lifecycle.taskArtifact) &&
      stringValue(childSession, 'taskArtifactDigest') ===
        stringValue(recordValue(lifecycle, 'taskArtifact'), 'integrityIdentifier') &&
      stringValue(backgroundResult, 'notificationId') ===
        `subagent:${String(backgroundResult.taskId)}:${String(backgroundResult.artifactIntegrityIdentifier)}`;
    assert(
      (childSession ? independentChildResult : lifecycleStatus === 'cleanup_completed') &&
        exactShape(backgroundResult, [
          'taskId',
          'notificationId',
          'artifactIntegrityIdentifier',
          ...(backgroundResult.checkpointRef ? ['checkpointRef'] : []),
          'originRunId',
          'originTurnId',
          'originToolCallId',
          'attempt',
          'admissionRevision',
          ...(afterTurn ? ['afterTurn'] : []),
        ]) &&
        stringValue(backgroundResult, 'taskId') === stringValue(lifecycle, 'childInvocationId') &&
        validString(backgroundResult.notificationId) &&
        /^sha256:[a-f0-9]{64}$/u.test(
          stringValue(backgroundResult, 'artifactIntegrityIdentifier') ?? '',
        ) &&
        (backgroundResult.checkpointRef === undefined ||
          validPrivateArtifact(backgroundResult.checkpointRef, 'subagent_checkpoint')) &&
        validString(backgroundResult.originRunId) &&
        stringValue(backgroundResult, 'originToolCallId') ===
          stringValue(invocation, 'toolCallId') &&
        numberValue(backgroundResult, 'attempt') === numberValue(lifecycle, 'attempt') &&
        Number.isSafeInteger(numberValue(backgroundResult, 'admissionRevision')) &&
        Number(numberValue(backgroundResult, 'admissionRevision')) >= 0 &&
        state.tools.calls[stringValue(invocation, 'toolCallId') ?? '']?.createdAtTurnId ===
          stringValue(backgroundResult, 'originTurnId'),
      `governed Subagent invocation ${invocationId} has invalid background result authority.`,
    );
    if (afterTurn) {
      assert(
        exactShape(afterTurn, [
          'reservationId',
          'admissionRevision',
          'eventId',
          'wakeKey',
          'runId',
          'phase',
          'status',
          'cancelRequested',
        ]) &&
          validString(afterTurn.reservationId) &&
          Number.isSafeInteger(afterTurn.admissionRevision) &&
          Number(afterTurn.admissionRevision) >= 0 &&
          validString(afterTurn.runId) &&
          (afterTurn.phase === 'planning' || afterTurn.phase === 'building') &&
          ['completed', 'failed', 'cancelled', 'interrupted', 'exhausted', 'suspended'].includes(
            String(afterTurn.status),
          ) &&
          typeof afterTurn.cancelRequested === 'boolean' &&
          /^[a-f0-9]{64}$/u.test(stringValue(afterTurn, 'eventId') ?? '') &&
          /^[a-f0-9]{64}$/u.test(stringValue(afterTurn, 'wakeKey') ?? ''),
        `governed Subagent invocation ${invocationId} has invalid after-turn authority.`,
      );
    }
  }
}

function assertModelInvocations(state: AgentState): void {
  for (const [invocationId, invocationValue] of Object.entries(state.modelInvocations)) {
    const invocation = invocationValue as unknown as UnknownRecord;
    const allowedKeys = new Set([
      'attempts',
      'admission',
      'budget',
      'dispatchCertainty',
      'estimatedInputTokens',
      'finishReason',
      'interruptionReason',
      'invocationId',
      'limits',
      'modelEvidenceUnavailable',
      'parentInvocationId',
      'parentToolCallId',
      'preparedStateRevision',
      'purpose',
      'responseArtifact',
      'routeFingerprint',
      'status',
      'surfaceArtifact',
      'surfaceIntegrityIdentifier',
    ]);
    assert(
      Object.keys(invocation).every((key) => allowedKeys.has(key)),
      `model invocation ${invocationId} contains an unknown current-format field.`,
    );
    const retiredAdmission = recordValue(invocation, 'admission');
    if (retiredAdmission) {
      assert(
        Object.keys(retiredAdmission).sort().join(',') ===
          'admitted,payloadClassificationDigest,providerAdmissionRevision,routeIdentityDigest' &&
          (retiredAdmission.providerAdmissionRevision === null ||
            typeof retiredAdmission.providerAdmissionRevision === 'string') &&
          /^sha256:[0-9a-f]{64}$/u.test(
            stringValue(retiredAdmission, 'routeIdentityDigest') ?? '',
          ) &&
          /^sha256:[0-9a-f]{64}$/u.test(
            stringValue(retiredAdmission, 'payloadClassificationDigest') ?? '',
          ) &&
          typeof retiredAdmission.admitted === 'boolean',
        `model invocation ${invocationId} legacy admission evidence is invalid.`,
      );
    }
    assert(
      stringValue(invocation, 'invocationId') === invocationId,
      'model invocation identity is invalid.',
    );
    const estimatedInputTokens = numberValue(invocation, 'estimatedInputTokens');
    if (Object.hasOwn(invocation, 'estimatedInputTokens'))
      assert(
        Number.isSafeInteger(estimatedInputTokens) && (estimatedInputTokens ?? -1) >= 0,
        `model invocation ${invocationId} frozen input estimate is invalid.`,
      );
    const status = stringValue(invocation, 'status');
    assert(
      ['prepared', 'dispatching', 'completed', 'interrupted'].includes(status ?? ''),
      `model invocation ${invocationId} status is invalid.`,
    );
    const attempts = numberValue(invocation, 'attempts');
    const limits = recordValue(invocation, 'limits');
    assert(
      Number.isSafeInteger(attempts) &&
        (attempts ?? -1) >= 0 &&
        limits != null &&
        Number.isSafeInteger(numberValue(limits, 'maxAttempts')),
      `model invocation ${invocationId} attempt evidence is invalid.`,
    );
    assert(
      (attempts ?? 0) <= (numberValue(limits, 'maxAttempts') ?? -1),
      `model invocation ${invocationId} exceeds max attempts.`,
    );
    if (status === 'prepared')
      assert(attempts === 0, `prepared model invocation ${invocationId} has attempts.`);
    if (status === 'dispatching' || status === 'completed')
      assert((attempts ?? 0) > 0, `dispatched model invocation ${invocationId} lacks attempt.`);
    if (status === 'completed')
      assert(
        stringValue(recordValue(invocation, 'responseArtifact'), 'kind') === 'model_response',
        `completed model invocation ${invocationId} lacks response artifact.`,
      );
    if (status === 'interrupted')
      assert(
        ['none', 'attempted', 'unknown'].includes(
          stringValue(invocation, 'dispatchCertainty') ?? '',
        ),
        `interrupted model invocation ${invocationId} certainty is invalid.`,
      );
  }
}

function assertCapabilityInvocations(state: AgentState): void {
  const capabilities = record(state.capabilities);
  const invocations = recordValue(capabilities, 'invocations') ?? {};
  for (const [invocationId, value] of Object.entries(invocations)) {
    const invocation = record(value);
    assert(invocation != null, `capability invocation ${invocationId} is not an object.`);
    assert(
      stringValue(invocation, 'invocationId') === invocationId,
      'capability invocation identity is invalid.',
    );
    const status = stringValue(invocation, 'status');
    assert(
      ['recorded', 'running', 'succeeded', 'failed', 'unknown'].includes(status ?? ''),
      `capability invocation ${invocationId} status is invalid.`,
    );
    const receiptRequirement = stringValue(invocation, 'receiptRequirement');
    if (!receiptRequirement) {
      assert(
        recordValue(invocation, 'subagentProviderLifecycle') === undefined,
        `governed Subagent invocation ${invocationId} has invalid Provider lifecycle evidence.`,
      );
      continue;
    }
    if (receiptRequirement) {
      assert(
        ['observation_receipt', 'effect_receipt', 'control_receipt', 'not_applicable'].includes(
          receiptRequirement,
        ),
        `capability invocation ${invocationId} receipt requirement is invalid.`,
      );
      if (status !== 'recorded')
        assert(
          Number.isSafeInteger(numberValue(invocation, 'attemptsStarted')) &&
            (numberValue(invocation, 'attemptsStarted') ?? 0) > 0,
          `capability invocation ${invocationId} lacks attempt evidence.`,
        );
      assert(
        validString(invocation.admissionDigest),
        `capability invocation ${invocationId} lacks admission digest.`,
      );
    }
    if (stringValue(invocation, 'resultDigest') || recordValue(invocation, 'artifact')) {
      assert(
        stringValue(invocation, 'resultDigest') != null &&
          stringValue(invocation, 'evidenceDigest') != null &&
          stringValue(recordValue(invocation, 'artifact'), 'kind') === 'capability_result',
        `capability invocation ${invocationId} result evidence is incomplete.`,
      );
    }
    const filesystemIntent = recordValue(invocation, 'filesystemIntent');
    const filesystemReady = recordValue(invocation, 'filesystemMutationReady');
    if (filesystemIntent) {
      assert(
        isValidFilesystemIntent(filesystemIntent) &&
          status !== 'recorded' &&
          numberValue(filesystemIntent, 'attempt') === numberValue(invocation, 'attemptsStarted') &&
          stringValue(filesystemIntent, 'capabilityRevision') ===
            stringValue(invocation, 'capabilityRevision') &&
          stringValue(filesystemIntent, 'argumentsDigest') ===
            stringValue(invocation, 'argumentsDigest') &&
          stringValue(filesystemIntent, 'admissionDigest') ===
            stringValue(invocation, 'admissionDigest') &&
          stringValue(filesystemIntent, 'effectiveEffectsDigest') ===
            stringValue(invocation, 'effectiveEffectsDigest'),
        `filesystem invocation ${invocationId} intent evidence is invalid.`,
      );
    }
    if (filesystemReady) {
      assert(
        isValidFilesystemReady(filesystemReady) &&
          filesystemIntent != null &&
          status !== 'recorded' &&
          numberValue(filesystemReady, 'attempt') === numberValue(filesystemIntent, 'attempt') &&
          stringValue(filesystemReady, 'intentDigest') ===
            stringValue(filesystemIntent, 'intentDigest'),
        `filesystem invocation ${invocationId} ready evidence is invalid.`,
      );
    }
    const filesystemObservation = recordValue(invocation, 'filesystemObservation');
    if (filesystemObservation) {
      assert(
        isValidFilesystemObservation(filesystemObservation) &&
          status === 'succeeded' &&
          recordValue(invocation, 'artifact') != null &&
          filesystemIntent != null,
        `filesystem invocation ${invocationId} observation evidence is invalid.`,
      );
      const capabilityId = stringValue(invocation, 'capabilityId');
      const expectedEffect =
        capabilityId === 'builtin:read_file'
          ? 'read'
          : capabilityId === 'builtin:write_file' || capabilityId === 'builtin:edit_file'
            ? 'write'
            : undefined;
      assert(
        expectedEffect != null,
        `filesystem invocation ${invocationId} has an unsupported observation capability.`,
      );
      assert(
        stringValue(invocation, 'effectiveEffectsDigest') ===
          digestValue({ filesystem: expectedEffect, network: 'none', externalState: 'none' }),
        `filesystem invocation ${invocationId} observation effect authority is invalid.`,
      );
      assert(
        stringValue(invocation, 'receiptRequirement') ===
          (expectedEffect === 'read' ? 'observation_receipt' : 'effect_receipt'),
        `filesystem invocation ${invocationId} observation receipt authority is invalid.`,
      );
      assert(
        stringValue(filesystemIntent, 'lexicalTargetDigest') ===
          stringValue(filesystemObservation, 'lexicalTargetDigest'),
        `filesystem invocation ${invocationId} observation target is inconsistent.`,
      );
      if (expectedEffect === 'read') {
        assert(
          filesystemReady === undefined,
          `filesystem read invocation ${invocationId} cannot carry mutation-ready evidence.`,
        );
      } else {
        assert(
          filesystemReady != null &&
            numberValue(filesystemReady, 'attempt') ===
              numberValue(invocation, 'attemptsStarted') &&
            numberValue(filesystemReady, 'attempt') === numberValue(filesystemIntent, 'attempt') &&
            stringValue(filesystemReady, 'intentDigest') ===
              stringValue(filesystemIntent, 'intentDigest') &&
            stringValue(filesystemReady, 'operationDigest') ===
              stringValue(filesystemIntent, 'operationDigest'),
          `filesystem invocation ${invocationId} observation lacks mutation-ready authority.`,
        );
      }
    }
    const sandboxIntent = recordValue(invocation, 'sandboxPreparationIntent');
    const sandboxReady = recordValue(invocation, 'sandboxPreparationReady');
    if (sandboxIntent)
      assert(
        isValidSandboxIntent(sandboxIntent) &&
          status !== 'recorded' &&
          numberValue(sandboxIntent, 'attempt') === numberValue(invocation, 'attemptsStarted') &&
          stringValue(sandboxIntent, 'toolCallId') === stringValue(invocation, 'toolCallId') &&
          stringValue(sandboxIntent, 'capabilityId') === stringValue(invocation, 'capabilityId') &&
          stringValue(sandboxIntent, 'capabilityRevision') ===
            stringValue(invocation, 'capabilityRevision') &&
          stringValue(sandboxIntent, 'effectiveEffectsDigest') ===
            stringValue(invocation, 'effectiveEffectsDigest') &&
          stringValue(sandboxIntent, 'admissionDigest') ===
            stringValue(invocation, 'admissionDigest'),
        `sandbox invocation ${invocationId} intent evidence is invalid.`,
      );
    if (sandboxReady)
      assert(
        isValidSandboxReady(sandboxReady) &&
          status !== 'recorded' &&
          sandboxIntent != null &&
          numberValue(sandboxReady, 'attempt') === numberValue(sandboxIntent, 'attempt') &&
          stringValue(sandboxReady, 'intentDigest') === stringValue(sandboxIntent, 'intentDigest'),
        `sandbox invocation ${invocationId} ready evidence is invalid.`,
      );
    assertCapabilityLifecycleEvidence(state, invocationId, invocation, status);
    const toolCallId = stringValue(invocation, 'toolCallId');
    if (status === 'recorded' || status === 'running') {
      const call = toolCallId ? state.tools.calls[toolCallId] : undefined;
      assert(
        !call ||
          !['succeeded', 'failed', 'rejected', 'cancelled', 'exhausted'].includes(call.status),
        `capability invocation ${invocationId} outlives terminal Tool.`,
      );
    }
    if (
      (status === 'succeeded' || status === 'failed') &&
      !stringValue(invocation, 'reconciliation')
    ) {
      assert(
        stringValue(recordValue(invocation, 'artifact'), 'kind') === 'capability_result',
        `terminal capability invocation ${invocationId} lacks result artifact.`,
      );
    }
  }
}

function assertProviderReadiness(state: AgentState): void {
  for (const [readinessKey, value] of Object.entries(state.providerReadiness)) {
    const readiness = value as unknown as UnknownRecord;
    assert(
      stringValue(readiness, 'readinessKey') === readinessKey,
      'provider readiness identity is invalid.',
    );
    assert(
      stringValue(readiness, 'lifecycleId') != null &&
        stringValue(readiness, 'providerId') != null &&
        stringValue(readiness, 'routeRevision') != null,
      'provider readiness identity is incomplete.',
    );
    assert(
      ['prepared', 'attempted', 'ready', 'failed'].includes(stringValue(readiness, 'status') ?? ''),
      'provider readiness status is invalid.',
    );
    const attempts = numberValue(readiness, 'attempts');
    const maxAttempts = numberValue(readiness, 'maxAttempts');
    assert(
      Number.isSafeInteger(maxAttempts) &&
        (maxAttempts ?? 0) > 0 &&
        Number.isSafeInteger(attempts) &&
        (attempts ?? -1) >= 0 &&
        (attempts ?? 0) <= (maxAttempts ?? -1),
      'provider readiness attempt evidence is invalid.',
    );
    if (stringValue(readiness, 'status') === 'prepared')
      assert(attempts === 0, 'prepared provider readiness has attempts.');
    if (stringValue(readiness, 'status') === 'attempted')
      assert((attempts ?? 0) > 0, 'attempted provider readiness lacks attempts.');
    if (stringValue(readiness, 'status') === 'failed')
      assert(recordValue(readiness, 'failure') != null, 'failed provider readiness lacks failure.');
    const waiters = recordValue(readiness, 'waiters') ?? {};
    for (const [waiterId, waiterValue] of Object.entries(waiters)) {
      const waiter = record(waiterValue);
      assert(
        waiter != null &&
          stringValue(waiter, 'waiterId') === waiterId &&
          stringValue(waiter, 'toolCallId') != null,
        'provider readiness waiter is invalid.',
      );
    }
  }
}

function assertContextState(state: AgentState): void {
  const context = record(state.context);
  const autoGuard = recordValue(context, 'autoGuard');
  assert(autoGuard != null, 'context autoGuard is required.');
  assert(
    Array.isArray(autoGuard.recentAutomaticCompactions),
    'context autoGuard history is invalid.',
  );
  assert(
    Number.isSafeInteger(numberValue(autoGuard, 'consecutiveLowGain')) &&
      (numberValue(autoGuard, 'consecutiveLowGain') ?? -1) >= 0,
    'context autoGuard low-gain counter is invalid.',
  );
  assert(
    typeof autoGuard.disabledUntilManualAction === 'boolean' &&
      typeof autoGuard.recoveryAttempted === 'boolean',
    'context autoGuard flags are invalid.',
  );
  const history = recordValue(context, 'history');
  assert(history == null || Array.isArray(history), 'context compaction history is invalid.');
  assert((history?.length ?? 0) <= 128, 'context compaction history exceeds its bound.');
  const pending = recordValue(context, 'pendingCompaction');
  if (pending) {
    assert(
      validString(pending.compactionId) &&
        Number.isSafeInteger(numberValue(pending, 'requestedAtRevision')) &&
        (numberValue(pending, 'requestedAtRevision') ?? -1) >= 0 &&
        validString(pending.requestedAtTurnId),
      'pending compaction identity is invalid.',
    );
    const estimate = recordValue(pending, 'estimate');
    assert(
      estimate != null &&
        Number.isFinite(numberValue(estimate, 'totalInputTokens')) &&
        (numberValue(estimate, 'totalInputTokens') ?? -1) >= 0,
      'pending compaction token estimate is invalid.',
    );
  }
  const checkpoint = recordValue(context, 'activeCheckpoint');
  if (checkpoint) {
    assert(
      numberValue(checkpoint, 'version') === 1 &&
        validString(checkpoint.summary) &&
        validString(checkpoint.compactionId) &&
        validString(checkpoint.sourceDigest),
      'active context checkpoint identity is invalid.',
    );
    const before = numberValue(checkpoint, 'inputTokensBefore');
    const after = numberValue(checkpoint, 'inputTokensAfter');
    assert(
      Number.isSafeInteger(before) &&
        Number.isSafeInteger(after) &&
        after! < before! &&
        before! - after! >= 1024,
      'active context checkpoint must save at least 1024 tokens.',
    );
    const boundaryId = stringValue(checkpoint, 'coveredThroughMessageId');
    const boundary = state.transcript.messages.find(
      (message) => stringValue(record(message), 'messageId') === boundaryId,
    );
    assert(
      boundary != null &&
        stringValue(record(boundary), 'turnId') === stringValue(checkpoint, 'coveredThroughTurnId'),
      'active context checkpoint boundary is inconsistent.',
    );
  }
}

function assertProviderAdmission(state: AgentState): void {
  const admission = record(state.providerAdmission);
  const pending = Array.isArray(admission?.pending)
    ? admission.pending.map(record).filter((value): value is UnknownRecord => value != null)
    : [];
  const providerIds = pending.map((entry) => stringValue(entry, 'providerId') ?? '');
  assertUnique(providerIds, 'pending provider admissions');
  const waivers = recordValue(admission, 'waivers') ?? {};
  for (const providerId of providerIds)
    assert(
      recordValue(waivers, providerId) == null,
      `provider ${providerId} cannot be pending and waived.`,
    );
  const interaction = record(state.interactions);
  if (stringValue(interaction, 'kind') === 'awaiting_provider_admission') {
    const first = pending[0];
    assert(
      first != null &&
        stringValue(first, 'interactionId') === stringValue(interaction, 'interactionId') &&
        stringValue(first, 'providerId') === stringValue(interaction, 'providerId'),
      'provider admission interaction must match the first pending provider.',
    );
  } else
    assert(
      pending.length === 0,
      'pending provider admission requires an active admission interaction.',
    );
}

function assertSkillFrames(state: AgentState): void {
  const frames = recordValue(state.skills as unknown as UnknownRecord, 'frames') ?? {};
  for (const [activationId, value] of Object.entries(frames)) {
    const frame = record(value);
    assert(
      frame != null &&
        stringValue(frame, 'activationId') === activationId &&
        state.tasks[stringValue(frame, 'taskId') ?? ''] != null,
      `Skill frame ${activationId} references an invalid task.`,
    );
    const status = stringValue(frame, 'status');
    if (status === 'active')
      assert(
        frame.closedAt === undefined && frame.closeReason === undefined,
        `Active Skill frame ${activationId} is closed.`,
      );
    else
      assert(
        ['closed', 'invalidated'].includes(status ?? '') &&
          validString(frame.closedAt) &&
          validString(frame.closeReason),
        `Closed Skill frame ${activationId} lacks closure facts.`,
      );
  }
}

function verificationSpecValid(spec: UnknownRecord): boolean {
  if (
    numberValue(spec, 'schemaVersion') !== 1 ||
    !validString(spec.verificationId) ||
    !validString(spec.subject)
  )
    return false;
  const repair = recordValue(spec, 'repair');
  if (
    !repair ||
    !Number.isSafeInteger(numberValue(repair, 'maxAttempts')) ||
    (numberValue(repair, 'maxAttempts') ?? -1) < 0
  )
    return false;
  if (!Array.isArray(spec.checks) || spec.checks.length === 0) return false;
  const ids = new Set<string>();
  for (const rawCheck of spec.checks) {
    const check = record(rawCheck);
    if (
      !check ||
      !validString(check.checkId) ||
      ids.has(check.checkId) ||
      ![
        'file_assertion',
        'command',
        'schema',
        'mcp_read_after_write',
        'external_reference',
        'receipt',
        'reviewer',
      ].includes(stringValue(check, 'type') ?? '')
    )
      return false;
    ids.add(check.checkId);
    if (
      check.type === 'file_assertion' &&
      (!validString(check.path) ||
        (check.assertion === 'sha256_equals' && !validString(check.expectedDigest)))
    )
      return false;
    if (check.type === 'command' && !validString(check.command)) return false;
    if (
      check.type === 'mcp_read_after_write' &&
      (!validString(check.invocationId) ||
        !validString(check.capabilityId) ||
        !validString(check.capabilityRevision))
    )
      return false;
    if (check.type === 'external_reference' && !validString(check.invocationId)) return false;
    if (check.type === 'receipt' && !validString(check.invocationId)) return false;
    if (check.type === 'reviewer' && !validString(check.instructions)) return false;
  }
  return true;
}

function assertProviderAndInteractionLinks(state: AgentState): void {
  const interaction = record(state.interactions);
  const kind = stringValue(interaction, 'kind');
  const toolCallId =
    kind === 'awaiting_provider_action' || kind === 'awaiting_provider_admission' || kind === 'idle'
      ? undefined
      : stringValue(interaction, 'toolCallId');
  if (toolCallId) {
    const call = state.tools.calls[toolCallId];
    assert(
      call != null &&
        !['succeeded', 'failed', 'rejected', 'cancelled', 'exhausted'].includes(call.status),
      `interaction references terminal or missing tool ${toolCallId}.`,
    );
    const required =
      kind === 'awaiting_user_input'
        ? 'awaiting_user_input'
        : kind === 'awaiting_review'
          ? 'awaiting_review'
          : kind === 'awaiting_tool_approval'
            ? 'awaiting_approval'
            : kind === 'awaiting_auto_review'
              ? 'awaiting_auto_review'
              : undefined;
    if (required)
      assert(
        call.status === required,
        `interaction ${kind} references a tool with the wrong status.`,
      );
  }
  if (kind === 'awaiting_provider_action') {
    const originating = stringValue(interaction, 'originatingToolCallId');
    const call = originating ? state.tools.calls[originating] : undefined;
    assert(call?.status === 'failed', 'provider action must reference a terminal failed tool.');
    assert(
      !state.tools.queue.includes(originating ?? '') &&
        !state.tools.active.includes(originating ?? ''),
      'provider action must not requeue its originating tool.',
    );
  }
}

function assertVerificationRecords(state: AgentState): void {
  const records = recordValue(record(state.verification), 'records') ?? {};
  for (const [verificationId, value] of Object.entries(records)) {
    const verification = value as UnknownRecord;
    assert(
      stringValue(verification, 'verificationId') === verificationId,
      'verification identity is invalid.',
    );
    const spec = recordValue(verification, 'spec');
    assert(
      spec != null &&
        numberValue(spec, 'schemaVersion') === 1 &&
        stringValue(spec, 'verificationId') === verificationId &&
        stringValue(spec, 'subject') != null,
      `verification ${verificationId} spec is invalid.`,
    );
    assert(
      Array.isArray(spec.checks) && spec.checks.length > 0,
      `verification ${verificationId} needs checks.`,
    );
    assert(
      Number.isSafeInteger(numberValue(verification, 'attempts')) &&
        (numberValue(verification, 'attempts') ?? -1) >= 0 &&
        Number.isSafeInteger(numberValue(verification, 'repairAttempts')) &&
        (numberValue(verification, 'repairAttempts') ?? -1) >= 0,
      `verification ${verificationId} counters are invalid.`,
    );
    assert(
      [
        'pending',
        'running',
        'passed',
        'failed',
        'inconclusive',
        'repair_pending',
        'waived',
        'budget_exhausted',
        'compensating',
        'compensated',
      ].includes(stringValue(verification, 'status') ?? ''),
      `verification ${verificationId} status is invalid.`,
    );
    if (
      stringValue(verification, 'status') !== 'budget_exhausted' ||
      !Array.isArray(verification.diagnostics) ||
      verification.diagnostics.length === 0
    )
      assert(verificationSpecValid(spec), `verification ${verificationId} spec is invalid.`);
    if (stringValue(verification, 'status') === 'waived')
      assert(
        stringValue(recordValue(verification, 'waiver'), 'actor') === 'user',
        `verification ${verificationId} waiver is invalid.`,
      );
  }
}

function validOpaquePrivateRef(value: unknown, kind: string): boolean {
  const candidate = record(value);
  if (!candidate) return false;
  const keys = Object.keys(candidate).sort();
  return (
    keys.join(',') === 'artifactId,byteLength,integrityIdentifier,kind' &&
    stringValue(candidate, 'kind') === kind &&
    /^pa_[0-9a-f]{64}$/u.test(stringValue(candidate, 'artifactId') ?? '') &&
    /^sha256:[0-9a-f]{64}$/u.test(stringValue(candidate, 'integrityIdentifier') ?? '') &&
    Number.isSafeInteger(numberValue(candidate, 'byteLength')) &&
    (numberValue(candidate, 'byteLength') ?? 0) > 0
  );
}

function assertSuspendedSubagents(state: AgentState): void {
  for (const [toolCallId, value] of Object.entries(state.suspendedSubagents)) {
    const suspended = value as unknown as UnknownRecord;
    const blockedTool = recordValue(suspended, 'blockedTool');
    const blockedKeys = blockedTool ? Object.keys(blockedTool).sort() : [];
    const expectedBlockedKeys = [
      'reasonCode',
      'toolCallId',
      ...(blockedTool?.runtimeToolCallId === undefined ? [] : ['runtimeToolCallId']),
      'toolName',
    ].sort();
    assert(
      stringValue(suspended, 'storage') === 'private_artifact_v1' &&
        Object.keys(suspended).length === 9 &&
        stringValue(suspended, 'subagentId') != null &&
        ['explore', 'plan', 'code', 'review'].includes(stringValue(suspended, 'role') ?? '') &&
        /^continuation-[0-9a-f]{64}$/u.test(stringValue(suspended, 'continuationId') ?? '') &&
        Number.isSafeInteger(numberValue(suspended, 'modelInvocationOrdinal')) &&
        (numberValue(suspended, 'modelInvocationOrdinal') ?? -1) >= 0 &&
        stringValue(suspended, 'parentInvocationId') != null &&
        Number.isSafeInteger(numberValue(suspended, 'parentAttempt')) &&
        (numberValue(suspended, 'parentAttempt') ?? 0) > 0 &&
        validOpaquePrivateRef(suspended.continuationArtifact, 'subagent_continuation') &&
        blockedTool != null &&
        blockedKeys.length === expectedBlockedKeys.length &&
        blockedKeys.every((key, index) => key === expectedBlockedKeys[index]) &&
        stringValue(blockedTool, 'toolCallId') != null &&
        stringValue(blockedTool, 'toolName') != null &&
        ['SUBAGENT_TOOL_REQUIRES_APPROVAL', 'SUBAGENT_TOOL_REQUIRES_AUTO_REVIEW'].includes(
          stringValue(blockedTool, 'reasonCode') ?? '',
        ),
      `private suspended subagent ${toolCallId} has invalid continuation evidence.`,
    );
  }
}

function assertApprovalQueue(state: AgentState): void {
  assert(state.pendingApprovals instanceof Map, 'pending approval queue must be a Map.');
  assert(state.sessionCommandGrants instanceof Map, 'session command grants must be a Map.');
  assert(state.approvalReceipts instanceof Map, 'approval receipts must be a Map.');
  assert(
    state.activeApprovalId === null || state.pendingApprovals.has(state.activeApprovalId),
    'active approval focus must identify a queued approval.',
  );
  assert(
    Number.isSafeInteger(state.nextQueueSequence) && state.nextQueueSequence >= 0,
    'approval queue sequence is invalid.',
  );
  assert(
    Number.isSafeInteger(state.approvalGeneration) && state.approvalGeneration >= 0,
    'approval generation is invalid.',
  );
  const sequences = new Set<number>();
  for (const [interactionId, pending] of state.pendingApprovals) {
    assert(
      interactionId.length > 0 && pending.interactionId === interactionId,
      'approval identity is invalid.',
    );
    assert(pending.toolCallId.length > 0, 'approval tool identity is required.');
    const hasSubagentOwner =
      pending.childSubagentId !== undefined ||
      pending.parentToolCallId !== undefined ||
      pending.childToolCallId !== undefined;
    if (hasSubagentOwner) {
      assert(
        typeof pending.parentToolCallId === 'string' && pending.parentToolCallId.length > 0,
        'subagent approval parent owner identity is required.',
      );
      assert(
        typeof pending.childSubagentId === 'string' && pending.childSubagentId.length > 0,
        'subagent approval child identity is required.',
      );
      assert(
        typeof pending.childToolCallId === 'string' && pending.childToolCallId.length > 0,
        'subagent approval child tool owner identity is required.',
      );
    }
    assert(pending.route === 'user' || pending.route === 'auto', 'approval route is invalid.');
    assert(
      typeof pending.fullModeBypassEligible === 'boolean',
      'approval Full-mode eligibility is invalid.',
    );
    assert(
      typeof pending.fullModePolicyBypassAllowed === 'boolean',
      'approval Full-mode policy eligibility is invalid.',
    );
    assert(typeof pending.bindingDigest === 'string', 'approval binding digest is invalid.');
    assert(
      Number.isSafeInteger(pending.sequence) && pending.sequence >= 0,
      'approval sequence is invalid.',
    );
    assert(!sequences.has(pending.sequence), 'approval queue sequence is duplicated.');
    sequences.add(pending.sequence);
    assert(
      Number.isSafeInteger(pending.generation) && pending.generation >= 0,
      'approval generation is invalid.',
    );
    assert(
      typeof pending.createdAt === 'string' && pending.createdAt.length > 0,
      'approval createdAt is invalid.',
    );
    assert(
      [
        'queued_auto',
        'auto_reviewing',
        'authorized_queued',
        'queued_user',
        'awaiting_user',
        'approving',
        'running',
        'succeeded',
        'failed',
        'cancelled',
        'rejected',
        'expired',
      ].includes(pending.status),
      'approval status is invalid.',
    );
  }
  for (const [grantKey, grant] of state.sessionCommandGrants) {
    assert(grantKey.length > 0 && grant.grantKey === grantKey, 'session grant key is invalid.');
    assert(grant.grant === 'same_command', 'session grant kind is invalid.');
    assert(
      [
        grant.sessionId,
        grant.threadId,
        grant.workspace,
        grant.canonicalWorkspaceIdentity,
        grant.cwd,
        grant.executor,
        grant.environment,
        grant.scope,
        grant.effects,
        grant.parserRevision,
        grant.commandDigest,
        grant.createdAt,
      ].every((value) => typeof value === 'string' && value.length > 0),
      'session grant subject is incomplete.',
    );
  }
  for (const [receiptId, receipt] of state.approvalReceipts) {
    assert(
      receiptId.length > 0 && receipt.receiptId === receiptId,
      'approval receipt identity is invalid.',
    );
    assert(
      receipt.interactionId.length > 0 && receipt.toolCallId.length > 0,
      'approval receipt binding is invalid.',
    );
    assert(
      Number.isSafeInteger(receipt.generation) && receipt.generation >= 0,
      'approval receipt generation is invalid.',
    );
    assert(
      receipt.grant === 'approve_once' || receipt.grant === 'same_command',
      'approval receipt grant is invalid.',
    );
    assert(
      ['authorized_queued', 'running', 'terminal', 'unknown'].includes(receipt.status),
      'approval receipt status is invalid.',
    );
  }
}

function isCanonicalValue(value: unknown, ancestors: Set<object>): boolean {
  // Optional State 27 properties are represented as undefined in memory and
  // omitted by JSON.stringify at the persistence boundary.
  if (value === undefined) return true;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0);
  if (typeof value !== 'object') return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.every((entry) => isCanonicalValue(entry, ancestors));
    if (value instanceof Map) {
      return [...value.entries()].every(
        ([key, entry]) =>
          typeof key === 'string' &&
          isCanonicalValue(key, ancestors) &&
          isCanonicalValue(entry, ancestors),
      );
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return Object.values(descriptors).every(
      (descriptor) =>
        'value' in descriptor &&
        descriptor.enumerable &&
        isCanonicalValue(descriptor.value, ancestors),
    );
  } finally {
    ancestors.delete(value);
  }
}

function nonCanonicalPath(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): string | undefined {
  if (
    value === undefined ||
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  )
    return undefined;
  if (typeof value === 'number')
    return Number.isFinite(value) && !Object.is(value, -0) ? undefined : path;
  if (typeof value !== 'object' || ancestors.has(value))
    return typeof value === 'object' ? undefined : path;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (const [index, entry] of value.entries()) {
        const invalid = nonCanonicalPath(entry, `${path}[${index}]`, ancestors);
        if (invalid) return invalid;
      }
      return undefined;
    }
    if (value instanceof Map) {
      for (const [key, entry] of value.entries()) {
        if (typeof key !== 'string') return `${path}.<key>`;
        const invalid = nonCanonicalPath(entry, `${path}.${key}`, ancestors);
        if (invalid) return invalid;
      }
      return undefined;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return path;
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!('value' in descriptor) || !descriptor.enumerable) return `${path}.${key}`;
      const invalid = nonCanonicalPath(descriptor.value, `${path}.${key}`, ancestors);
      if (invalid) return invalid;
    }
    return undefined;
  } finally {
    ancestors.delete(value);
  }
}

/** Validate the complete State 27 snapshot before Host persistence. */
export function assertAgentStateInvariants(state: AgentState): void {
  assert(
    state.schemaVersion === RUNTIME_STATE_SCHEMA_VERSION &&
      state.formatEpoch === RUNTIME_STATE_FORMAT_EPOCH,
    'runtime state format must match State 27 and the current epoch.',
  );
  assert(Number.isSafeInteger(state.revision) && state.revision >= 0, 'revision is invalid.');
  assert(
    Number.isSafeInteger(state.interactionModeRevision) && state.interactionModeRevision >= 0,
    'interaction mode revision is invalid.',
  );
  assertApprovalQueue(state);
  assertUnique(state.appliedEventIds, 'applied event ids');
  assert(
    state.appliedEventIds.length <= APPLIED_EVENT_ID_TAIL_LIMIT,
    'applied event id tail exceeds 4096 entries.',
  );
  if (state.lastAppliedEventId !== undefined) {
    assert(
      state.appliedEventIds.includes(state.lastAppliedEventId),
      'lastAppliedEventId must be present in the bounded tail.',
    );
  }
  assert(state.session.threadId.length > 0, 'session threadId is required.');
  assert(state.session.userId.length > 0, 'session userId is required.');
  assert(state.session.workspace.length > 0, 'session workspace is required.');
  assert(state.turn.turnId.length > 0, 'turnId is required.');
  assert(
    Number.isSafeInteger(state.turn.turnIndex) && state.turn.turnIndex >= 0,
    'turn index is invalid.',
  );
  assert(
    state.turn.status === 'active' ||
      state.turn.status === 'completed' ||
      state.turn.status === 'aborted',
    'turn status is invalid.',
  );
  if (state.turn.status === 'aborted')
    assert(Boolean(state.turn.abortReason), 'aborted turn reason is required.');
  assert(state.toolRecovery?.schemaVersion === 1, 'tool recovery journal schema must be v1.');
  assert(state.modelInvocations != null, 'model invocation state is required.');
  assert(state.providerReadiness != null, 'provider readiness state is required.');
  assert(state.completionGuard != null, 'completion guard state is required.');
  if (state.completionGuard.waitingReason) {
    const reason = state.completionGuard.waitingReason;
    const ids =
      reason.kind === 'required_background'
        ? reason.taskIds
        : reason.kind === 'required_shell'
          ? reason.shellIds
          : undefined;
    assert(
      Array.isArray(ids) &&
        ids.length > 0 &&
        ids.every((id, index, values) => id.length > 0 && values.indexOf(id) === index) &&
        (reason.kind !== 'required_shell' || typeof reason.modelRespondedAfterWait === 'boolean'),
      'completion guard waiting reason is invalid.',
    );
  }
  assertResourceBudget(state);
  assertRetainedResourceBudgets(state);
  assert(!state.activeFollowupTurn || state.childSessionOrigin, 'followup requires child origin.');
  if (state.childSessionOrigin) {
    const origin = state.childSessionOrigin;
    const followup = state.activeFollowupTurn;
    if (followup)
      assert(
        origin.terminal?.status === 'completed' &&
          followup.sourceSessionId === origin.parentSessionId &&
          validString(followup.submissionId) &&
          validString(followup.targetRunId) &&
          validString(followup.taskId) &&
          followup.taskId !== origin.childInvocationId &&
          validPrivateArtifact(followup.checkpointRef, 'subagent_checkpoint') &&
          validPrivateArtifact(followup.grantRef, 'agent_followup_grant') &&
          followup.grantRef.integrityIdentifier === followup.grantDigest &&
          /^sha256:[a-f0-9]{64}$/u.test(followup.grantDigest),
        'child followup continuation identity is invalid.',
      );
    assert(
      state.session.threadId ===
        childThreadIdForToolAttempt({
          parentSessionId: origin.parentSessionId,
          parentInvocationId: origin.parentInvocationId,
          parentToolCallId: origin.parentToolCallId,
          attempt: origin.attempt,
        }) &&
        /^sha256:[a-f0-9]{64}$/u.test(origin.grantDigest) &&
        /^sha256:[a-f0-9]{64}$/u.test(origin.delegatedUpperBoundDigest) &&
        origin.delegatedReservationId.length > 0 &&
        origin.fundingRunId.length > 0 &&
        Number.isFinite(Date.parse(origin.deadlineAt)),
      'child Session origin is invalid.',
    );
    if (origin.terminal)
      assert(
        (state.terminalOutcome !== undefined ||
          (followup !== undefined &&
            state.activeTaskId === followup.taskId &&
            state.turn.turnId === followup.targetRunId &&
            state.turn.status === 'active') ||
          (origin.terminal.status === 'cancelled' &&
            state.turn.status === 'aborted' &&
            state.turn.abortCause === 'user' &&
            origin.terminal.cleanupConfirmed === true)) &&
          (origin.terminal.cleanupConfirmed === true ||
            (origin.terminal.status === 'unknown' &&
              origin.terminal.cleanupConfirmed === false &&
              state.terminalOutcome?.status === 'unknown' &&
              state.terminalOutcome.knownExternalEffects === 'unknown' &&
              state.turn.status !== 'active')) &&
          Number.isSafeInteger(origin.terminal.sealedRevision) &&
          origin.terminal.sealedRevision >= 1,
        'child Session terminal seal is invalid.',
      );
  }
  assertRecoveryJournal(state);
  assertModelInvocations(state);
  assertCapabilityInvocations(state);
  assertProviderReadiness(state);
  assertContextState(state);
  assertVerificationRecords(state);
  assertProviderAdmission(state);
  assertSkillFrames(state);
  assertProviderAndInteractionLinks(state);
  assertSuspendedSubagents(state);
  for (const message of state.transcript.messages) {
    const candidate = message as unknown as UnknownRecord;
    assert(stringValue(candidate, 'messageId') != null, 'transcript message identity is required.');
    assert(
      stringValue(candidate, 'turnId') != null,
      'transcript message turn identity is required.',
    );
    assert(
      Number.isSafeInteger(numberValue(candidate, 'ordinal')) &&
        (numberValue(candidate, 'ordinal') ?? -1) >= 0,
      'transcript message ordinal is invalid.',
    );
    assert(validTimestamp(candidate.createdAt), 'transcript message timestamp is invalid.');
  }
  assert(
    state.resourceBudget.status === 'unconfigured' || state.resourceBudget.status === 'active',
    'resource budget status is invalid.',
  );
  assert(
    state.resourceBudget.status === 'unconfigured'
      ? Object.keys(state.resourceBudget.reservations).length === 0
      : Number.isSafeInteger(state.resourceBudget.nextWaiterSequence) &&
          state.resourceBudget.nextWaiterSequence >= 0,
    'resource budget shape is invalid.',
  );
  assert(
    /^[a-f0-9]{64}$/u.test(state.toolRecovery.identityKey),
    'recovery identity key is invalid.',
  );
  assert(state.toolRecovery.schemaVersion === 1, 'tool recovery journal schema is invalid.');
  assertUnique(state.toolRecovery.order, 'tool recovery order');
  assert(state.toolRecovery.order.length <= 128, 'tool recovery order exceeds its bound.');
  assert(
    Number.isSafeInteger(state.toolRecovery.progressRevision) &&
      state.toolRecovery.progressRevision >= 0,
    'recovery progress revision is invalid.',
  );
  assert(
    Number.isSafeInteger(state.toolRecovery.qualityGuard.observedFailures) &&
      state.toolRecovery.qualityGuard.observedFailures >= 0,
    'recovery quality guard is invalid.',
  );
  assert(
    Number.isSafeInteger(state.autoReview.consecutiveRejects) &&
      state.autoReview.consecutiveRejects >= 0,
    'auto-review reject count is invalid.',
  );
  assert(
    state.autoReview.rejectionHistory.every(
      (entry) =>
        Number.isSafeInteger(entry.timestamp) &&
        entry.timestamp >= 0 &&
        entry.toolName.length > 0 &&
        entry.reason.length > 0,
    ),
    'auto-review rejection history is invalid.',
  );
  assertUnique(state.tools.queue, 'tool queue');
  assertUnique(state.tools.active, 'active tools');
  for (const taskId of Object.keys(state.tasks)) {
    assert(state.tasks[taskId]!.taskId === taskId, 'task map key does not match task identity.');
    assert(
      ['active', 'completed', 'failed', 'cancelled'].includes(state.tasks[taskId]!.status),
      'task status is invalid.',
    );
    assert(
      state.tasks[taskId]!.startedAtTurnId.length > 0,
      'task start turn identity is required.',
    );
  }
  if (state.activeTaskId !== null) {
    assert(state.tasks[state.activeTaskId] !== undefined, 'active task must exist in task map.');
  }
  const activeTaskIds = Object.values(state.tasks)
    .filter((task) => task.status === 'active')
    .map((task) => task.taskId);
  assert(activeTaskIds.length <= 1, 'runtime may contain only one active task.');
  assert(
    state.activeTaskId === null
      ? activeTaskIds.length === 0
      : activeTaskIds[0] === state.activeTaskId,
    'activeTaskId must identify the unique active task.',
  );
  const activeIds = new Set(state.tools.active);
  for (const toolCallId of [...state.tools.queue, ...state.tools.active]) {
    const call = state.tools.calls[toolCallId];
    assert(call != null, `tool ${toolCallId} is referenced but has no call record.`);
    assert(
      !['succeeded', 'failed', 'rejected', 'cancelled', 'exhausted'].includes(call.status),
      `terminal tool ${toolCallId} remains scheduled.`,
    );
    assert(
      !(activeIds.has(toolCallId) && state.tools.queue.includes(toolCallId)),
      `tool ${toolCallId} is queued and active.`,
    );
  }
  for (const call of Object.values(state.tools.calls)) {
    assert(call.toolCallId.length > 0 && call.name.length > 0, 'tool call identity is invalid.');
    if (call.outcome !== undefined) assertToolOutcome(call.outcome, `tool ${call.toolCallId}`);
    if (call.recoveryOf)
      assert(
        state.toolRecovery.failures[call.recoveryOf] != null ||
          ['succeeded', 'failed', 'rejected', 'cancelled', 'exhausted'].includes(call.status),
        `tool ${call.toolCallId} recovery lineage is missing.`,
      );
  }
  const interactionKind = record(state.interactions)?.kind;
  assert(
    typeof interactionKind === 'string' &&
      [
        'idle',
        'awaiting_user_input',
        'awaiting_review',
        'awaiting_tool_approval',
        'awaiting_auto_review',
        'awaiting_provider_action',
        'awaiting_provider_admission',
      ].includes(interactionKind),
    'interaction kind is invalid.',
  );
  const interactionToolId = stringValue(record(state.interactions), 'toolCallId');
  if (interactionToolId) {
    const call = state.tools.calls[interactionToolId];
    assert(call != null, `interaction references missing tool ${interactionToolId}.`);
    const requiredStatus =
      interactionKind === 'awaiting_user_input'
        ? 'awaiting_user_input'
        : interactionKind === 'awaiting_review'
          ? 'awaiting_review'
          : interactionKind === 'awaiting_tool_approval'
            ? 'awaiting_approval'
            : interactionKind === 'awaiting_auto_review'
              ? 'awaiting_auto_review'
              : undefined;
    if (requiredStatus)
      assert(
        call.status === requiredStatus,
        `interaction ${interactionKind} references a tool with the wrong status.`,
      );
  }
  const invalidPath = nonCanonicalPath(state, 'state', new Set<object>());
  assert(
    isCanonicalValue(state, new Set<object>()) && invalidPath === undefined,
    `state contains non-canonical or executable data at ${invalidPath}.`,
  );
}
