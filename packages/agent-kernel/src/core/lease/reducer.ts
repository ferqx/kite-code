import { requiredBackgroundTaskIds } from '../../completion';
import type { KernelEvent } from '../../events';
import { eventRecord, stringField } from '../../reducer-utils';
import type {
  AgentProviderReadinessState,
  AgentResourceBudgetActiveState,
  AgentResourceBudgetState,
  AgentState,
  ResourceBudget,
  ResourceReservation,
  ResourceUsage,
  ResourceWaiter,
} from '../../state';
import { epochMillisecondsToIsoUtc } from './utc-iso';

const BUDGET_FIELDS = [
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
] as const;

const COUNTER_FIELDS = [
  'turns',
  'modelRequests',
  'toolInvocations',
  'inputTokens',
  'outputTokens',
  'artifactBytes',
] as const;

const GAUGE_FIELDS = [
  'elapsedRunMs',
  'activeSubagents',
  'activeWriters',
  'activeToolInvocations',
  'activeShellInvocations',
] as const;

const RESOURCE_KINDS = [
  'model',
  'tool',
  'mcp',
  'skill',
  'subagent',
  'verification',
  'compaction',
  'artifact',
] as const;

function nonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new Error(`${field} must be non-empty.`);
}

function nonNegativeInteger(value: unknown, field: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`${field} must be a non-negative safe integer.`);
}

function positiveInteger(value: unknown, field: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${field} must be a positive safe integer.`);
}

function exactTaskIds(value: readonly string[], expected: readonly string[]): boolean {
  return (
    value.length > 0 &&
    value.length === expected.length &&
    value.every(
      (id, index) =>
        typeof id === 'string' &&
        id.length > 0 &&
        (index === 0 || value[index - 1]! < id) &&
        id === expected[index],
    )
  );
}

function hasMarkedRequiredChildFunding(
  state: AgentState,
  ledger: AgentResourceBudgetActiveState,
  taskId: string,
): boolean {
  return Object.values(state.tools.calls).some((call) => {
    if (call.name !== 'task' || call.result?.resultMeta?.taskId !== taskId) return false;
    return Object.values(state.capabilities.invocations).some((invocation) => {
      const link = invocation.subagentProviderLifecycle?.childSession;
      if (
        invocation.toolCallId !== call.toolCallId ||
        !link ||
        link.originToolCallId !== call.toolCallId ||
        link.originRunId !== ledger.runId ||
        link.disposition !== 'required'
      )
        return false;
      const delegated = ledger.reservations[link.delegatedReservationId];
      return (
        delegated?.resourceKind === 'subagent' &&
        delegated.executableUpperBound.independentChildTurnDeadline === true &&
        ['queued', 'reserved', 'dispatch_started'].includes(delegated.state)
      );
    });
  });
}

function assertResourceBudget(value: ResourceBudget): void {
  if (value == null || typeof value !== 'object' || value.version !== 1)
    throw new Error('Unsupported ResourceBudget version.');
  const candidate = value as unknown as Record<string, unknown>;
  const zeroAllowed = new Set<keyof ResourceBudget>([
    ...(value.durationOnlyChildRun === true || value.unboundedCumulativeUsage === true
      ? ([
          'maxTurns',
          'maxModelRequests',
          'maxRunInputTokens',
          'maxRunOutputTokens',
          'maxConcurrencyWaitMs',
          'maxArtifactBytes',
        ] as const)
      : []),
    'maxToolInvocations',
    'maxArtifactBytes',
    'maxConcurrentSubagents',
    'maxConcurrentWriters',
    'maxConcurrentToolInvocations',
    'maxConcurrentShellInvocations',
  ]);
  for (const field of BUDGET_FIELDS)
    if (zeroAllowed.has(field)) nonNegativeInteger(candidate[field], field);
    else positiveInteger(candidate[field], field);
  if (
    value.unboundedToolInvocations !== undefined &&
    (value.unboundedToolInvocations !== true || value.maxToolInvocations !== 0)
  )
    throw new Error('Unbounded Tool budget must use a zero numeric placeholder.');
  if (value.unboundedCumulativeUsage !== undefined && value.unboundedCumulativeUsage !== true)
    throw new Error('Unbounded cumulative budget marker is invalid.');
  if (
    value.durationOnlyChildRun !== undefined &&
    (value.durationOnlyChildRun !== true ||
      [
        'maxTurns',
        'maxModelRequests',
        'maxToolInvocations',
        'maxRunInputTokens',
        'maxRunOutputTokens',
        'maxArtifactBytes',
      ].some((field) => (value as unknown as Record<string, number>)[field] !== 0))
  )
    throw new Error('Duration-only child budget requires zero cumulative placeholders.');
  if (value.maxConcurrentShellInvocations > value.maxConcurrentToolInvocations)
    throw new Error('Shell concurrency must not exceed tool concurrency.');
  if (value.maxConcurrentWriters > value.maxConcurrentToolInvocations)
    throw new Error('Writer concurrency must not exceed tool concurrency.');
}

function assertResourceUsage(value: ResourceUsage): void {
  if (value == null || typeof value !== 'object') throw new Error('Resource usage is invalid.');
  const candidate = value as unknown as Record<string, unknown>;
  const counters = candidate.counters;
  const gauges = candidate.gauges;
  if (counters == null || typeof counters !== 'object')
    throw new Error('Resource usage counters are invalid.');
  if (gauges == null || typeof gauges !== 'object')
    throw new Error('Resource usage gauges are invalid.');
  for (const field of COUNTER_FIELDS)
    nonNegativeInteger((counters as Record<string, unknown>)[field], field);
  for (const field of GAUGE_FIELDS)
    nonNegativeInteger((gauges as Record<string, unknown>)[field], field);
  if (value.source === 'versioned_upper_bound')
    nonEmpty(value.estimatorVersion, 'estimatorVersion');
  if (value.source === 'actual' && value.estimatorVersion !== undefined)
    throw new Error('Actual usage must not declare estimatorVersion.');
  if (value.source !== 'actual' && value.source !== 'versioned_upper_bound')
    throw new Error('Resource usage source is invalid.');
  if (
    (value.unboundedToolInvocations !== undefined &&
      (value.source !== 'versioned_upper_bound' ||
        value.unboundedToolInvocations !== true ||
        value.counters.toolInvocations !== 0)) ||
    (value.unboundedArtifactBytes !== undefined &&
      (value.source !== 'versioned_upper_bound' ||
        value.unboundedArtifactBytes !== true ||
        value.counters.artifactBytes !== 0)) ||
    (value.unboundedModelTokens !== undefined &&
      (value.source !== 'versioned_upper_bound' ||
        value.unboundedModelTokens !== true ||
        value.counters.inputTokens !== 0 ||
        value.counters.outputTokens !== 0)) ||
    (value.independentChildTurnDeadline !== undefined &&
      (value.source !== 'versioned_upper_bound' || value.independentChildTurnDeadline !== true)) ||
    (value.independentFollowupTurn !== undefined &&
      (value.source !== 'versioned_upper_bound' || value.independentFollowupTurn !== true)) ||
    (value.durationOnlyChildRun !== undefined &&
      (value.source !== 'versioned_upper_bound' ||
        value.durationOnlyChildRun !== true ||
        COUNTER_FIELDS.some((field) => value.counters[field] !== 0)))
  )
    throw new Error('Resource usage authority markers are invalid.');
}

function withinUpperBound(actual: ResourceUsage, upper: ResourceUsage): boolean {
  return (
    COUNTER_FIELDS.every(
      (field) =>
        upper.durationOnlyChildRun === true ||
        (field === 'artifactBytes' && upper.unboundedArtifactBytes === true) ||
        ((field === 'inputTokens' || field === 'outputTokens') &&
          upper.unboundedModelTokens === true) ||
        (field === 'toolInvocations' && upper.unboundedToolInvocations === true) ||
        actual.counters[field] <= upper.counters[field],
    ) && GAUGE_FIELDS.every((field) => actual.gauges[field] <= upper.gauges[field])
  );
}

function withinBudget(
  usage: ResourceUsage,
  budget: ResourceBudget,
  delegatedToolInvocations = 0,
): boolean {
  const unbounded =
    budget.durationOnlyChildRun === true || budget.unboundedCumulativeUsage === true;
  return (
    Number.isSafeInteger(delegatedToolInvocations) &&
    delegatedToolInvocations >= 0 &&
    delegatedToolInvocations <= usage.counters.toolInvocations &&
    (unbounded || usage.counters.turns <= budget.maxTurns) &&
    (unbounded || usage.counters.modelRequests <= budget.maxModelRequests) &&
    (unbounded ||
      budget.unboundedToolInvocations === true ||
      usage.counters.toolInvocations - delegatedToolInvocations <= budget.maxToolInvocations) &&
    (unbounded || usage.counters.inputTokens <= budget.maxRunInputTokens) &&
    (unbounded || usage.counters.outputTokens <= budget.maxRunOutputTokens) &&
    (unbounded || usage.counters.artifactBytes <= budget.maxArtifactBytes) &&
    usage.gauges.elapsedRunMs <= budget.maxRunDurationMs &&
    usage.gauges.activeSubagents <= budget.maxConcurrentSubagents &&
    usage.gauges.activeWriters <= budget.maxConcurrentWriters &&
    usage.gauges.activeToolInvocations <= budget.maxConcurrentToolInvocations &&
    usage.gauges.activeShellInvocations <= budget.maxConcurrentShellInvocations
  );
}

function delegatedToolInvocations(active: AgentResourceBudgetActiveState): number {
  return Object.values(active.reservations).reduce(
    (total, reservation) =>
      total +
      (reservation.state === 'reconciled' &&
      reservation.executableUpperBound.unboundedToolInvocations === true
        ? (reservation.actual?.counters.toolInvocations ?? 0)
        : 0),
    0,
  );
}

function zeroUsage(): ResourceUsage {
  return {
    counters: {
      turns: 0,
      modelRequests: 0,
      toolInvocations: 0,
      inputTokens: 0,
      outputTokens: 0,
      artifactBytes: 0,
    },
    gauges: {
      elapsedRunMs: 0,
      activeSubagents: 0,
      activeWriters: 0,
      activeToolInvocations: 0,
      activeShellInvocations: 0,
    },
    source: 'actual',
  };
}

function addUsage(left: ResourceUsage, right: ResourceUsage): ResourceUsage {
  const source =
    left.source === 'actual' && right.source === 'actual'
      ? ('actual' as const)
      : ('versioned_upper_bound' as const);
  return {
    counters: {
      turns: left.counters.turns + right.counters.turns,
      modelRequests: left.counters.modelRequests + right.counters.modelRequests,
      toolInvocations: left.counters.toolInvocations + right.counters.toolInvocations,
      inputTokens: left.counters.inputTokens + right.counters.inputTokens,
      outputTokens: left.counters.outputTokens + right.counters.outputTokens,
      artifactBytes: left.counters.artifactBytes + right.counters.artifactBytes,
    },
    gauges: {
      elapsedRunMs: Math.max(left.gauges.elapsedRunMs, right.gauges.elapsedRunMs),
      activeSubagents: left.gauges.activeSubagents + right.gauges.activeSubagents,
      activeWriters: left.gauges.activeWriters + right.gauges.activeWriters,
      activeToolInvocations: left.gauges.activeToolInvocations + right.gauges.activeToolInvocations,
      activeShellInvocations:
        left.gauges.activeShellInvocations + right.gauges.activeShellInvocations,
    },
    source,
    ...(source === 'versioned_upper_bound'
      ? {
          estimatorVersion: left.estimatorVersion ?? right.estimatorVersion ?? 'composed-v1',
          ...(left.unboundedToolInvocations || right.unboundedToolInvocations
            ? { unboundedToolInvocations: true as const }
            : {}),
        }
      : {}),
  };
}

function committedUsage(state: AgentResourceBudgetActiveState): ResourceUsage {
  let usage = state.reconciledUsage;
  for (const reservation of Object.values(state.reservations)) {
    if (['reserved', 'dispatch_started', 'unknown'].includes(reservation.state))
      usage = addUsage(usage, reservation.executableUpperBound);
    else if (reservation.state === 'queued')
      usage = addUsage(usage, {
        ...reservation.executableUpperBound,
        gauges: {
          ...reservation.executableUpperBound.gauges,
          activeSubagents: 0,
          activeWriters: 0,
          activeToolInvocations: 0,
          activeShellInvocations: 0,
        },
      });
  }
  return usage;
}

function assertReservation(value: ResourceReservation): void {
  if (value == null || typeof value !== 'object' || value.version !== 1)
    throw new Error('Unsupported ResourceReservation version.');
  nonEmpty(value.reservationId, 'reservationId');
  nonEmpty(value.runId, 'runId');
  nonEmpty(value.invocationId, 'invocationId');
  if (value.parentReservationId === value.reservationId)
    throw new Error('A reservation cannot be its own parent.');
  if (value.replacesReservationId === value.reservationId)
    throw new Error('A reservation cannot replace itself.');
  if (!RESOURCE_KINDS.includes(value.resourceKind))
    throw new Error('Reservation resource kind is invalid.');
  assertResourceUsage(value.executableUpperBound);
  if (value.executableUpperBound.source !== 'versioned_upper_bound')
    throw new Error('executableUpperBound must use versioned_upper_bound usage.');
  if (
    value.executableUpperBound.unboundedToolInvocations === true &&
    !(
      value.resourceKind === 'subagent' &&
      ((value.reservationId.startsWith('child-allotment:') &&
        value.invocationId === value.reservationId) ||
        (/^backup_[a-f0-9]{64}$/u.test(value.reservationId) &&
          value.executableUpperBound.independentFollowupTurn === true))
    )
  )
    throw new Error('Unbounded Tool upper bound requires an exact child funding reservation.');
  if (
    value.executableUpperBound.independentFollowupTurn === true &&
    (value.resourceKind !== 'subagent' ||
      !/^backup_[a-f0-9]{64}$/u.test(value.reservationId) ||
      value.executableUpperBound.unboundedToolInvocations !== true)
  )
    throw new Error('Independent followup turn requires an exact marked backup.');
  if (
    value.executableUpperBound.independentChildTurnDeadline === true &&
    (value.resourceKind !== 'subagent' ||
      !value.reservationId.startsWith('child-allotment:') ||
      value.invocationId !== value.reservationId)
  )
    throw new Error('Independent child deadline requires an exact child allotment.');
  if (
    value.executableUpperBound.durationOnlyChildRun === true &&
    (value.resourceKind !== 'subagent' ||
      !(
        (value.reservationId.startsWith('child-allotment:') &&
          value.invocationId === value.reservationId &&
          value.executableUpperBound.independentChildTurnDeadline === true) ||
        (/^backup_[a-f0-9]{64}$/u.test(value.reservationId) &&
          value.executableUpperBound.independentFollowupTurn === true)
      ))
  )
    throw new Error('Duration-only authority requires exact independent child funding.');
  if (
    value.executableUpperBound.unboundedArtifactBytes === true &&
    !['tool', 'mcp', 'skill'].includes(value.resourceKind)
  )
    throw new Error('Unbounded Artifact authority requires a Tool reservation.');
  if (
    value.executableUpperBound.unboundedModelTokens === true &&
    !['model', 'compaction', 'verification'].includes(value.resourceKind)
  )
    throw new Error('Unbounded Model token authority requires a Model reservation.');
  if (
    value.state === 'queued' &&
    (value.resourceKind !== 'subagent' ||
      !(
        (value.reservationId.startsWith('child-allotment:') &&
          value.invocationId === value.reservationId) ||
        /^backup_[a-f0-9]{64}$/u.test(value.reservationId)
      ) ||
      value.parentReservationId !== undefined ||
      value.actual !== undefined ||
      value.executableUpperBound.gauges.activeSubagents !== 1)
  )
    throw new Error('Only an exact finite child allotment or TriggerTurn backup may be queued.');
  if (value.actual) {
    assertResourceUsage(value.actual);
    if (
      value.actual.source !== 'actual' ||
      !withinUpperBound(value.actual, value.executableUpperBound)
    )
      throw new Error('Reservation actual usage exceeds its executable upper bound.');
  }
}

function activeState(state: AgentResourceBudgetState): AgentResourceBudgetActiveState {
  if (state.status !== 'active')
    throw new Error(`Resource budget ledger is ${state.status}; execution is blocked.`);
  return state;
}

function replaceReservation(
  state: AgentResourceBudgetActiveState,
  reservation: ResourceReservation,
): AgentResourceBudgetActiveState {
  return {
    ...state,
    reservations: { ...state.reservations, [reservation.reservationId]: reservation },
  };
}

function settleReservation(
  state: AgentResourceBudgetActiveState,
  reservation: ResourceReservation,
): AgentResourceBudgetActiveState {
  if (state.externalizedClosedReservations !== true) return replaceReservation(state, reservation);
  const { [reservation.reservationId]: _settled, ...reservations } = state.reservations;
  return { ...state, reservations };
}

function activeReservationsAfterExternalization(
  reservations: Readonly<Record<string, ResourceReservation>>,
): Readonly<Record<string, ResourceReservation>> {
  return Object.fromEntries(
    Object.entries(reservations).filter(
      ([, reservation]) => reservation.state !== 'reconciled' && reservation.state !== 'released',
    ),
  );
}

/** Lift only this Run's direct, unsettled cumulative reservations during upgrade. */
function removeCumulativeReservationUpperBounds(
  reservations: Readonly<Record<string, ResourceReservation>>,
): Readonly<Record<string, ResourceReservation>> {
  return Object.fromEntries(
    Object.entries(reservations).map(([id, reservation]) => {
      if (
        reservation.parentReservationId !== undefined ||
        !['reserved', 'dispatch_started', 'unknown'].includes(reservation.state)
      )
        return [id, reservation];
      const upper = reservation.executableUpperBound;
      if (['tool', 'mcp', 'skill'].includes(reservation.resourceKind))
        return [
          id,
          {
            ...reservation,
            executableUpperBound: {
              ...upper,
              counters: { ...upper.counters, artifactBytes: 0 },
              unboundedArtifactBytes: true as const,
            },
          },
        ];
      if (['model', 'compaction', 'verification'].includes(reservation.resourceKind))
        return [
          id,
          {
            ...reservation,
            executableUpperBound: {
              ...upper,
              counters: { ...upper.counters, inputTokens: 0, outputTokens: 0 },
              unboundedModelTokens: true as const,
            },
          },
        ];
      return [id, reservation];
    }),
  );
}

function isResourceBudgetEvent(type: KernelEvent['type']): boolean {
  return type.startsWith('resource_budget.');
}

function hasUnsettledBudgetAuthority(ledger: AgentResourceBudgetActiveState): boolean {
  return (
    Object.values(ledger.reservations).some(
      (reservation) =>
        reservation.state === 'queued' ||
        reservation.state === 'reserved' ||
        reservation.state === 'dispatch_started' ||
        reservation.state === 'unknown',
    ) || Object.values(ledger.waiters).some((waiter) => waiter.state === 'waiting')
  );
}

function ledgerForRun(
  state: AgentState,
  runId: string,
): AgentResourceBudgetActiveState | undefined {
  if (state.resourceBudget.status === 'active' && state.resourceBudget.runId === runId)
    return state.resourceBudget;
  return state.retainedResourceBudgets[runId];
}

function ledgerForReservation(
  state: AgentState,
  reservationId: string,
): AgentResourceBudgetActiveState {
  if (
    state.resourceBudget.status === 'unconfigured' &&
    Object.keys(state.retainedResourceBudgets).length === 0
  )
    throw new Error('Resource budget ledger is unconfigured.');
  const matches = [
    ...(state.resourceBudget.status === 'active' ? [state.resourceBudget] : []),
    ...Object.values(state.retainedResourceBudgets),
  ].filter((ledger) => ledger.reservations[reservationId] !== undefined);
  if (matches.length === 0) throw new Error(`Unknown reservation ${reservationId}.`);
  if (matches.length > 1)
    throw new Error(`Reservation ${reservationId} has ambiguous funding Runs.`);
  return matches[0]!;
}

function ledgerForWaiter(state: AgentState, invocationId: string): AgentResourceBudgetActiveState {
  const matches = [
    ...(state.resourceBudget.status === 'active' ? [state.resourceBudget] : []),
    ...Object.values(state.retainedResourceBudgets),
  ].filter((ledger) => ledger.waiters[invocationId] !== undefined);
  if (matches.length === 0) throw new Error(`Unknown concurrency waiter ${invocationId}.`);
  if (matches.length > 1) throw new Error(`Waiter ${invocationId} has ambiguous funding Runs.`);
  return matches[0]!;
}

function budgetLedgerForEvent(
  state: AgentState,
  event: KernelEvent,
): AgentResourceBudgetActiveState {
  const payload = eventRecord(event);
  if (
    event.type === 'resource_budget.required_child_wait_started' ||
    event.type === 'resource_budget.required_child_wait_ended'
  ) {
    const runId = stringField(payload, 'runId');
    const ledger = runId ? ledgerForRun(state, runId) : undefined;
    if (!ledger) throw new Error('Required child wait funding Run is unavailable.');
    return ledger;
  }
  if (event.type === 'resource_budget.reserved') {
    const candidate = payload.reservation as ResourceReservation;
    const ledger = ledgerForRun(state, candidate.runId);
    if (!ledger) throw new Error(`Funding Run ${candidate.runId} has no budget ledger.`);
    const duplicate = [
      ...(state.resourceBudget.status === 'active' ? [state.resourceBudget] : []),
      ...Object.values(state.retainedResourceBudgets),
    ].some((item) => item !== ledger && item.reservations[candidate.reservationId] !== undefined);
    if (duplicate) throw new Error('Reservation ID is already owned by another funding Run.');
    return ledger;
  }
  if (event.type === 'resource_budget.waiter_enqueued') {
    const waiter = payload.waiter as ResourceWaiter;
    const ledger = ledgerForRun(state, waiter.runId);
    if (!ledger) throw new Error(`Funding Run ${waiter.runId} has no budget ledger.`);
    return ledger;
  }
  if (
    event.type === 'resource_budget.waiter_promoted' ||
    event.type === 'resource_budget.waiter_cancelled' ||
    event.type === 'resource_budget.waiter_timed_out'
  )
    return ledgerForWaiter(state, String(payload.invocationId));
  return ledgerForReservation(state, String(payload.reservationId));
}

function withBudgetLedger(state: AgentState, ledger: AgentResourceBudgetActiveState): AgentState {
  if (state.resourceBudget.status === 'active' && state.resourceBudget.runId === ledger.runId)
    return { ...state, resourceBudget: ledger };
  if (!state.retainedResourceBudgets[ledger.runId])
    throw new Error(`Funding Run ${ledger.runId} is no longer retained.`);
  const retained = { ...state.retainedResourceBudgets };
  if (hasUnsettledBudgetAuthority(ledger)) retained[ledger.runId] = ledger;
  else delete retained[ledger.runId];
  return { ...state, retainedResourceBudgets: retained };
}

function isReadinessEvent(type: KernelEvent['type']): boolean {
  return type.startsWith('provider.readiness_');
}

/** Resource leases and provider readiness are owned by the fixed lease reducer. */
export function reduceLeaseState(state: AgentState, event: KernelEvent): AgentState {
  const payload = eventRecord(event);

  if (isResourceBudgetEvent(event.type)) {
    if (event.type === 'resource_budget.configured') {
      const runId = payload.runId;
      const startedAt = payload.startedAt;
      const deadlineAt = payload.deadlineAt;
      const budget = payload.budget as ResourceBudget;
      assertResourceBudget(budget);
      if (state.childSessionOrigin !== undefined && budget.unboundedCumulativeUsage === true)
        throw new Error('A child Run cannot use primary unbounded cumulative authority.');
      nonEmpty(runId, 'runId');
      if (typeof startedAt !== 'string' || typeof deadlineAt !== 'string')
        throw new Error('Resource budget timestamps are invalid.');
      const started = Date.parse(startedAt);
      const deadline = Date.parse(deadlineAt);
      if (!Number.isFinite(started) || !Number.isFinite(deadline) || deadline <= started)
        throw new Error('Resource budget timestamps are invalid.');
      if (deadline - started > budget.maxRunDurationMs)
        throw new Error('Resource budget deadline exceeds maxRunDurationMs.');
      if (state.resourceBudget.status === 'active') {
        if (
          state.resourceBudget.runId === runId &&
          state.resourceBudget.startedAt === startedAt &&
          state.resourceBudget.deadlineAt === deadlineAt &&
          JSON.stringify(state.resourceBudget.budget) === JSON.stringify(budget)
        )
          return state;
        if (state.retainedResourceBudgets[runId])
          throw new Error('A retained funding Run cannot be configured again.');
      }
      const prior = state.resourceBudget.status === 'active' ? state.resourceBudget : undefined;
      const retainedResourceBudgets =
        prior && hasUnsettledBudgetAuthority(prior)
          ? { ...state.retainedResourceBudgets, [prior.runId]: prior }
          : state.retainedResourceBudgets;
      return {
        ...state,
        retainedResourceBudgets,
        resourceBudget: {
          status: 'active',
          runId,
          startedAt,
          deadlineAt,
          budget,
          reconciledUsage: zeroUsage(),
          ...(budget.unboundedCumulativeUsage === true || budget.durationOnlyChildRun === true
            ? { externalizedClosedReservations: true as const }
            : {}),
          reservations: {},
          waiters: {},
          nextWaiterSequence: 0,
        },
      };
    }

    if (event.type === 'resource_budget.cumulative_limits_removed') {
      const active = activeState(state.resourceBudget);
      if (active.runId !== event.runId)
        throw new Error('Cumulative limit removal Run identity mismatch.');
      if (state.childSessionOrigin !== undefined || active.budget.durationOnlyChildRun === true)
        throw new Error('Cumulative limit removal is only valid for a primary Run.');
      if (active.budget.unboundedCumulativeUsage === true) return state;
      return {
        ...state,
        resourceBudget: {
          ...active,
          budget: { ...active.budget, unboundedCumulativeUsage: true },
          externalizedClosedReservations: true,
          reservations: activeReservationsAfterExternalization(
            removeCumulativeReservationUpperBounds(active.reservations),
          ),
        },
      };
    }

    const active = activeState(budgetLedgerForEvent(state, event));
    if (event.type === 'resource_budget.required_child_wait_started') {
      if (
        state.resourceBudget.status !== 'active' ||
        state.resourceBudget.runId !== event.runId ||
        state.turn.status !== 'active'
      )
        throw new Error('Required child wait needs the current active Run.');
      const waiting = state.completionGuard.waitingReason;
      const expected = waiting?.kind === 'required_background' ? [...waiting.taskIds].sort() : [];
      if (
        !Array.isArray(event.taskIds) ||
        !exactTaskIds(event.taskIds, expected) ||
        !exactTaskIds(event.taskIds, [...requiredBackgroundTaskIds(state)].sort()) ||
        event.taskIds.some((taskId) => !hasMarkedRequiredChildFunding(state, active, taskId))
      )
        throw new Error('Required child wait needs an accepted funded completion blocker.');
      if (
        active.requiredChildWait?.startedAt === event.at &&
        JSON.stringify(active.requiredChildWait.taskIds) === JSON.stringify(event.taskIds)
      )
        return state;
      if (active.requiredChildWait) throw new Error('Required child wait is already active.');
      const started = Date.parse(event.at);
      if (
        !Number.isSafeInteger(started) ||
        started < Date.parse(active.startedAt) ||
        started > Date.parse(active.deadlineAt)
      )
        throw new Error('Required child wait start is outside the active Run deadline.');
      return withBudgetLedger(state, {
        ...active,
        requiredChildWait: { startedAt: event.at, taskIds: [...event.taskIds] },
      });
    }
    if (event.type === 'resource_budget.required_child_wait_ended') {
      const previous = active.requiredChildWait;
      if (
        active.lastRequiredChildWait?.endedAt === event.at &&
        JSON.stringify(active.lastRequiredChildWait.taskIds) === JSON.stringify(event.taskIds)
      )
        return state;
      if (
        state.resourceBudget.status !== 'active' ||
        state.resourceBudget.runId !== event.runId ||
        state.turn.status !== 'active' ||
        !previous ||
        !Array.isArray(event.taskIds) ||
        !exactTaskIds(event.taskIds, previous.taskIds) ||
        requiredBackgroundTaskIds(state).length > 0
      )
        throw new Error('Required child wait cannot end before its children settle.');
      const ended = Date.parse(event.at);
      const elapsed = ended - Date.parse(previous.startedAt);
      const total = (active.totalRequiredChildWaitMs ?? 0) + elapsed;
      const deadline = Date.parse(active.deadlineAt) + elapsed;
      const extendedDeadlineAt = epochMillisecondsToIsoUtc(deadline);
      if (
        !Number.isSafeInteger(ended) ||
        !Number.isSafeInteger(elapsed) ||
        elapsed < 0 ||
        !Number.isSafeInteger(total) ||
        !extendedDeadlineAt
      )
        throw new Error('Required child wait duration is invalid.');
      return withBudgetLedger(state, {
        ...active,
        deadlineAt: extendedDeadlineAt,
        totalRequiredChildWaitMs: total,
        requiredChildWait: undefined,
        lastRequiredChildWait: {
          startedAt: previous.startedAt,
          endedAt: event.at,
          taskIds: [...previous.taskIds],
        },
      });
    }
    if (event.type === 'resource_budget.waiter_enqueued') {
      const waiter = payload.waiter as ResourceWaiter;
      if (waiter == null || typeof waiter !== 'object')
        throw new Error('Concurrency waiter is invalid.');
      nonEmpty(waiter.runId, 'runId');
      nonEmpty(waiter.invocationId, 'invocationId');
      if (waiter.version !== 1 || waiter.state !== 'waiting')
        throw new Error('A new concurrency waiter must be version 1 and waiting.');
      if (waiter.runId !== active.runId) throw new Error('Concurrency waiter runId mismatch.');
      if (waiter.sequence !== active.nextWaiterSequence)
        throw new Error('Concurrency waiter sequence must be the next durable FIFO sequence.');
      if (Date.parse(waiter.deadlineAt) <= Date.parse(waiter.enqueuedAt))
        throw new Error('Concurrency waiter deadline must be after enqueue time.');
      if (Date.parse(waiter.deadlineAt) > Date.parse(active.deadlineAt))
        throw new Error('Concurrency waiter deadline exceeds the persisted run deadline.');
      const existing = active.waiters[waiter.invocationId];
      if (
        Object.values(state.retainedResourceBudgets).some(
          (ledger) => ledger !== active && ledger.waiters[waiter.invocationId] !== undefined,
        ) ||
        (state.resourceBudget.status === 'active' &&
          state.resourceBudget !== active &&
          state.resourceBudget.waiters[waiter.invocationId] !== undefined)
      )
        throw new Error('Concurrency waiter identity is already owned by another funding Run.');
      if (existing) {
        if (JSON.stringify(existing) === JSON.stringify(waiter)) return state;
        throw new Error('Concurrency waiter invocation was reused with different facts.');
      }
      return withBudgetLedger(state, {
        ...active,
        waiters: { ...active.waiters, [waiter.invocationId]: waiter },
        nextWaiterSequence: active.nextWaiterSequence + 1,
      });
    }

    if (
      event.type === 'resource_budget.waiter_promoted' ||
      event.type === 'resource_budget.waiter_cancelled' ||
      event.type === 'resource_budget.waiter_timed_out'
    ) {
      const invocationId = payload.invocationId;
      nonEmpty(invocationId, 'invocationId');
      const waiter = active.waiters[invocationId];
      if (!waiter) throw new Error(`Unknown concurrency waiter ${invocationId}.`);
      const targetState =
        event.type === 'resource_budget.waiter_promoted'
          ? 'promoted'
          : event.type === 'resource_budget.waiter_cancelled'
            ? 'cancelled'
            : 'timed_out';
      if (waiter.state === targetState) return state;
      if (waiter.state !== 'waiting') throw new Error(`Cannot change a ${waiter.state} waiter.`);
      return withBudgetLedger(state, {
        ...active,
        waiters: {
          ...active.waiters,
          [invocationId]: { ...waiter, state: targetState },
        },
      });
    }

    if (event.type === 'resource_budget.reserved') {
      if (active.requiredChildWait)
        throw new Error('Parent resource dispatch is suspended for required child turns.');
      const candidate = payload.reservation as ResourceReservation;
      assertReservation(candidate);
      if (
        candidate.executableUpperBound.unboundedArtifactBytes === true &&
        active.budget.durationOnlyChildRun !== true &&
        active.budget.unboundedCumulativeUsage !== true
      )
        throw new Error('Unbounded Artifact authority requires an unbounded cumulative Run.');
      if (
        candidate.executableUpperBound.unboundedModelTokens === true &&
        active.budget.durationOnlyChildRun !== true &&
        active.budget.unboundedCumulativeUsage !== true
      )
        throw new Error('Unbounded Model token authority requires an unbounded cumulative Run.');
      if (candidate.replacesReservationId)
        throw new Error('Bounded replacements require the atomic replacement event.');
      if (candidate.state !== 'reserved' && candidate.state !== 'queued')
        throw new Error('A new reservation must be reserved or queued.');
      if (candidate.state === 'queued' && candidate.resourceKind !== 'subagent')
        throw new Error('Only a child allotment may be queued.');
      if (candidate.runId !== active.runId) throw new Error('Reservation runId mismatch.');
      if (
        candidate.parentReservationId &&
        !active.reservations[candidate.parentReservationId] &&
        !active.externalizedClosedReservations
      )
        throw new Error('Parent reservation must exist in the shared ledger.');
      const existing = active.reservations[candidate.reservationId];
      if (existing) {
        if (JSON.stringify(existing) === JSON.stringify(candidate)) return state;
        throw new Error('Reservation idempotency key was reused with different facts.');
      }
      if (
        Object.values(active.reservations).some(
          (item) => item.invocationId === candidate.invocationId && item.state !== 'released',
        )
      )
        throw new Error('Invocation already has a non-released reservation.');
      const next = replaceReservation(active, candidate);
      if (!withinBudget(committedUsage(next), next.budget, delegatedToolInvocations(next)))
        throw new Error('Resource budget exhausted before dispatch.');
      return withBudgetLedger(state, next);
    }

    if (event.type === 'resource_budget.bounded_replaced') {
      const reservationId = payload.reservationId;
      nonEmpty(reservationId, 'reservationId');
      const turnReservation = payload.turnReservation as ResourceReservation;
      const replacement = payload.replacement as ResourceReservation;
      const otherLedgers = [
        ...(state.resourceBudget.status === 'active' && state.resourceBudget !== active
          ? [state.resourceBudget]
          : []),
        ...Object.values(state.retainedResourceBudgets).filter((ledger) => ledger !== active),
      ];
      if (
        otherLedgers.some(
          (ledger) =>
            ledger.reservations[turnReservation.reservationId] !== undefined ||
            ledger.reservations[replacement.reservationId] !== undefined,
        )
      )
        throw new Error('Bounded replacement ID is already owned by another funding Run.');
      assertReservation(turnReservation);
      assertReservation(replacement);
      if (
        turnReservation.state !== 'reserved' ||
        turnReservation.resourceKind !== 'subagent' ||
        turnReservation.actual !== undefined ||
        turnReservation.parentReservationId !== undefined ||
        turnReservation.replacesReservationId !== reservationId ||
        turnReservation.runId !== active.runId ||
        turnReservation.executableUpperBound.counters.turns !== 1 ||
        turnReservation.executableUpperBound.gauges.activeSubagents !== 1 ||
        COUNTER_FIELDS.some(
          (field) =>
            field !== 'turns' && turnReservation.executableUpperBound.counters[field] !== 0,
        ) ||
        GAUGE_FIELDS.some(
          (field) =>
            field !== 'activeSubagents' && turnReservation.executableUpperBound.gauges[field] !== 0,
        )
      )
        throw new Error('Bounded replacement requires one held child-turn reservation.');
      if (
        replacement.state !== 'reserved' ||
        replacement.resourceKind !== 'model' ||
        replacement.actual !== undefined
      )
        throw new Error('A bounded replacement must be a reserved model invocation.');
      if (
        replacement.parentReservationId !== turnReservation.reservationId ||
        replacement.executableUpperBound.counters.turns !== 0 ||
        replacement.executableUpperBound.counters.modelRequests !== 1 ||
        COUNTER_FIELDS.some(
          (field) =>
            !['modelRequests', 'inputTokens', 'outputTokens'].includes(field) &&
            replacement.executableUpperBound.counters[field] !== 0,
        ) ||
        GAUGE_FIELDS.some((field) => replacement.executableUpperBound.gauges[field] !== 0)
      )
        throw new Error(
          'Bounded replacement must cover one first model request beneath the child turn.',
        );
      if (replacement.runId !== active.runId)
        throw new Error('Bounded replacement runId mismatch.');
      if (replacement.replacesReservationId !== reservationId)
        throw new Error('Bounded replacement must identify its held backup.');
      if (
        replacement.reservationId === reservationId ||
        turnReservation.reservationId === reservationId ||
        replacement.reservationId === turnReservation.reservationId
      )
        throw new Error('Bounded replacement must use a new reservation identity.');
      const held = active.reservations[reservationId];
      if (!held) throw new Error(`Unknown reservation ${reservationId}.`);
      if (held.runId !== active.runId || held.resourceKind !== 'subagent')
        throw new Error('Bounded replacement requires a same-run sub-agent backup.');
      const existing = active.reservations[replacement.reservationId];
      const existingTurn = active.reservations[turnReservation.reservationId];
      if (held.state === 'released' && existing && existingTurn) {
        const { state: _state, actual: _actual, ...existingIdentity } = existing;
        const {
          state: _replacementState,
          actual: _replacementActual,
          ...replacementIdentity
        } = replacement;
        const { state: _turnState, actual: _turnActual, ...existingTurnIdentity } = existingTurn;
        const { state: _newTurnState, actual: _newTurnActual, ...turnIdentity } = turnReservation;
        if (
          JSON.stringify(existingIdentity) === JSON.stringify(replacementIdentity) &&
          JSON.stringify(existingTurnIdentity) === JSON.stringify(turnIdentity)
        )
          return state;
        throw new Error('Bounded replacement replay conflicts with existing reservation.');
      }
      if (held.state !== 'reserved')
        throw new Error('Only a held, undispatched reservation can be replaced.');
      if (existing || existingTurn)
        throw new Error('Bounded replacement identity is already used.');
      if (
        Object.values(active.reservations).some(
          (item) =>
            (item.invocationId === replacement.invocationId ||
              item.invocationId === turnReservation.invocationId) &&
            item.state !== 'released',
        )
      )
        throw new Error('Invocation already has a non-released reservation.');
      if (turnReservation.invocationId === replacement.invocationId)
        throw new Error('Bounded replacement invocation identities must differ.');
      if (
        !withinUpperBound(
          addUsage(turnReservation.executableUpperBound, replacement.executableUpperBound),
          held.executableUpperBound,
        )
      )
        throw new Error('Bounded replacement exceeds the held upper bound.');
      const { [reservationId]: _archivedHeld, ...otherReservations } = active.reservations;
      const next: AgentResourceBudgetActiveState = {
        ...active,
        reservations: {
          ...(active.externalizedClosedReservations ? otherReservations : active.reservations),
          ...(active.externalizedClosedReservations
            ? {}
            : { [reservationId]: { ...held, state: 'released' } }),
          [turnReservation.reservationId]: turnReservation,
          [replacement.reservationId]: replacement,
        },
      };
      if (!withinBudget(committedUsage(next), next.budget, delegatedToolInvocations(next)))
        throw new Error('Resource budget exhausted before bounded replacement.');
      return withBudgetLedger(state, next);
    }

    const reservationId = payload.reservationId;
    nonEmpty(reservationId, 'reservationId');
    const reservation = active.reservations[reservationId];
    if (!reservation) throw new Error(`Unknown reservation ${reservationId}.`);
    let next = active;
    switch (event.type) {
      case 'resource_budget.child_slot_acquired': {
        if (reservation.state === 'reserved') return state;
        if (reservation.state !== 'queued' || reservation.resourceKind !== 'subagent')
          throw new Error('Only a queued sub-agent reservation can acquire a slot.');
        next = replaceReservation(active, { ...reservation, state: 'reserved' });
        if (!withinBudget(committedUsage(next), next.budget, delegatedToolInvocations(next)))
          throw new Error('Child concurrency slot is unavailable.');
        break;
      }
      case 'resource_budget.dispatch_started':
        if (reservation.state === 'dispatch_started') return state;
        if (reservation.state !== 'reserved')
          throw new Error(`Cannot dispatch a ${reservation.state} reservation.`);
        next = replaceReservation(active, { ...reservation, state: 'dispatch_started' });
        break;
      case 'resource_budget.reconciled': {
        const actual = payload.actual as ResourceUsage;
        assertResourceUsage(actual);
        if (
          actual.source !== 'actual' ||
          !withinUpperBound(actual, reservation.executableUpperBound)
        )
          throw new Error('Reconciliation exceeds the executable upper bound.');
        if (reservation.state === 'reconciled') {
          if (JSON.stringify(reservation.actual) === JSON.stringify(actual)) return state;
          throw new Error('Reconciliation idempotency key was reused with different usage.');
        }
        if (reservation.state !== 'dispatch_started' && reservation.state !== 'unknown')
          throw new Error(`Cannot reconcile a ${reservation.state} reservation.`);
        next = {
          ...settleReservation(active, { ...reservation, actual, state: 'reconciled' }),
          reconciledUsage: addUsage(active.reconciledUsage, actual),
        };
        if (!withinBudget(committedUsage(next), next.budget, delegatedToolInvocations(next)))
          throw new Error('Reconciled usage exceeds the effective resource budget.');
        break;
      }
      case 'resource_budget.released': {
        if (reservation.state === 'released') return state;
        const proof = stringField(payload, 'proof');
        if (
          reservation.state !== 'queued' &&
          reservation.state !== 'reserved' &&
          !(reservation.state === 'dispatch_started' && proof === 'local_pre_dispatch_failure')
        )
          throw new Error('Only a proven undispatched reservation can be released.');
        next = settleReservation(active, { ...reservation, state: 'released' });
        break;
      }
      case 'resource_budget.unknown':
        if (reservation.state === 'unknown') return state;
        if (reservation.state !== 'dispatch_started' && reservation.state !== 'reserved')
          throw new Error('Only a pending reservation can become unknown.');
        next = replaceReservation(active, { ...reservation, state: 'unknown' });
        break;
      default:
        return state;
    }
    return withBudgetLedger(state, next);
  }

  if (!isReadinessEvent(event.type)) return state;
  const readinessKey = stringField(payload, 'readinessKey');
  if (!readinessKey) return state;
  const current = state.providerReadiness[readinessKey];

  if (event.type === 'provider.readiness_intent_recorded') {
    const lifecycleId = stringField(payload, 'lifecycleId');
    if (
      current?.lifecycleId === lifecycleId ||
      (current && current.status !== 'ready' && current.status !== 'failed')
    )
      return state;
    const readiness: AgentProviderReadinessState = {
      readinessKey,
      lifecycleId: lifecycleId ?? '',
      providerId: stringField(payload, 'providerId') ?? '',
      routeRevision: stringField(payload, 'routeRevision') ?? '',
      executionBoundaryDigest: stringField(payload, 'executionBoundaryDigest') ?? '',
      status: 'prepared',
      requestedAt: stringField(payload, 'requestedAt') ?? '',
      expiresAt: stringField(payload, 'expiresAt') ?? '',
      maxAttempts: Number(payload.maxAttempts ?? 0),
      attempts: 0,
      waiters: {},
    };
    return {
      ...state,
      providerReadiness: { ...state.providerReadiness, [readinessKey]: readiness },
    };
  }

  if (event.type === 'provider.readiness_waiter_registered') {
    if (!current || current.lifecycleId !== stringField(payload, 'lifecycleId')) return state;
    const waiterId = stringField(payload, 'waiterId');
    if (!waiterId || current.waiters[waiterId]) return state;
    return {
      ...state,
      providerReadiness: {
        ...state.providerReadiness,
        [readinessKey]: {
          ...current,
          waiters: {
            ...current.waiters,
            [waiterId]: {
              waiterId,
              toolCallId: stringField(payload, 'toolCallId') ?? '',
              registeredAt: stringField(payload, 'registeredAt') ?? '',
            },
          },
        },
      },
    };
  }

  if (event.type === 'provider.readiness_attempt_started') {
    const attempt = Number(payload.attempt ?? 0);
    const maxAttempts = Number(payload.maxAttempts ?? 0);
    if (
      !current ||
      current.lifecycleId !== stringField(payload, 'lifecycleId') ||
      (current.status !== 'prepared' && current.status !== 'failed') ||
      maxAttempts !== current.maxAttempts ||
      attempt !== current.attempts + 1 ||
      attempt > maxAttempts
    )
      return state;
    return {
      ...state,
      providerReadiness: {
        ...state.providerReadiness,
        [readinessKey]: {
          ...current,
          status: 'attempted',
          attempts: attempt,
          dispatchCertainty: 'attempted',
          failure: undefined,
        },
      },
    };
  }

  if (event.type === 'provider.readiness_succeeded') {
    if (
      !current ||
      current.lifecycleId !== stringField(payload, 'lifecycleId') ||
      (current.status !== 'prepared' && current.status !== 'attempted')
    )
      return state;
    return {
      ...state,
      providerReadiness: {
        ...state.providerReadiness,
        [readinessKey]: {
          ...current,
          status: 'ready',
          readyAt: stringField(payload, 'readyAt') ?? '',
          expiresAt: stringField(payload, 'expiresAt') ?? '',
          providerDirectoryRevision: stringField(payload, 'providerDirectoryRevision') ?? '',
          failure: undefined,
        },
      },
    };
  }

  if (event.type === 'provider.readiness_failed') {
    const dispatchCertainty = stringField(payload, 'dispatchCertainty');
    if (
      !current ||
      current.lifecycleId !== stringField(payload, 'lifecycleId') ||
      (dispatchCertainty === 'attempted'
        ? current.status !== 'attempted'
        : current.status !== 'prepared')
    )
      return state;
    return {
      ...state,
      providerReadiness: {
        ...state.providerReadiness,
        [readinessKey]: {
          ...current,
          status: 'failed',
          failure: payload.failure as AgentProviderReadinessState['failure'],
          dispatchCertainty: dispatchCertainty === 'attempted' ? 'attempted' : 'none',
        },
      },
    };
  }

  return state;
}
