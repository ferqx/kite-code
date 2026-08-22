import type {
  AgentResourceBudgetActiveState,
  AgentResourceBudgetState,
  KernelEvent,
  ResourceBudgetV1 as KernelResourceBudgetV1,
  ResourceUsageV1 as KernelResourceUsageV1,
  ResourceReservationState,
  ResourceReservationV1,
  ResourceWaiterV1,
} from '@kite/agent-kernel';

export const RESOURCE_BUDGET_VERSION = 1 as const;

/** Host accounting mechanics consume the exact Kernel-owned State26 DTOs. */
export type ResourceBudgetV1 = KernelResourceBudgetV1;
export type ResourceUsageV1 = KernelResourceUsageV1;
export type BudgetReservationState = ResourceReservationState;
export type BudgetReservationV1 = ResourceReservationV1;
export type ConcurrencyWaiterV1 = ResourceWaiterV1;
export type ActiveResourceBudgetRuntimeStateV1 = AgentResourceBudgetActiveState;
export type ResourceBudgetRuntimeStateV1 = AgentResourceBudgetState;

type MutableResourceUsageV1 = {
  -readonly [K in keyof ResourceUsageV1]: K extends 'counters' | 'gauges'
    ? { -readonly [P in keyof ResourceUsageV1[K]]: ResourceUsageV1[K][P] }
    : ResourceUsageV1[K];
};

type ResourceBudgetEventOf<T extends KernelEvent['type']> = Extract<KernelEvent, { type: T }>;
export type ResourceBudgetConfiguredEvent = ResourceBudgetEventOf<'resource_budget.configured'>;
export type ResourceBudgetReservedEvent = ResourceBudgetEventOf<'resource_budget.reserved'>;
export type ResourceBudgetDispatchStartedEvent =
  ResourceBudgetEventOf<'resource_budget.dispatch_started'>;
export type ResourceBudgetReconciledEvent = ResourceBudgetEventOf<'resource_budget.reconciled'>;
export type ResourceBudgetReleasedEvent = ResourceBudgetEventOf<'resource_budget.released'>;
export type ResourceBudgetUnknownEvent = ResourceBudgetEventOf<'resource_budget.unknown'>;
export type ResourceBudgetWaiterEnqueuedEvent =
  ResourceBudgetEventOf<'resource_budget.waiter_enqueued'>;
export type ResourceBudgetWaiterPromotedEvent =
  ResourceBudgetEventOf<'resource_budget.waiter_promoted'>;
export type ResourceBudgetWaiterCancelledEvent =
  ResourceBudgetEventOf<'resource_budget.waiter_cancelled'>;
export type ResourceBudgetWaiterTimedOutEvent =
  ResourceBudgetEventOf<'resource_budget.waiter_timed_out'>;
export type ResourceBudgetEvent =
  | ResourceBudgetConfiguredEvent
  | ResourceBudgetReservedEvent
  | ResourceBudgetDispatchStartedEvent
  | ResourceBudgetReconciledEvent
  | ResourceBudgetReleasedEvent
  | ResourceBudgetUnknownEvent
  | ResourceBudgetWaiterEnqueuedEvent
  | ResourceBudgetWaiterPromotedEvent
  | ResourceBudgetWaiterCancelledEvent
  | ResourceBudgetWaiterTimedOutEvent;

export const LIMITED_RESOURCE_BUDGET_V1: Readonly<ResourceBudgetV1> = Object.freeze({
  version: 1,
  maxRunDurationMs: 30 * 60 * 1000,
  maxTurns: 30,
  maxModelRequests: 60,
  maxToolInvocations: 250,
  maxRunInputTokens: 1_000_000,
  maxRunOutputTokens: 250_000,
  maxConcurrentSubagents: 2,
  maxConcurrentWriters: 1,
  maxConcurrentToolInvocations: 4,
  maxConcurrentShellInvocations: 1,
  maxConcurrencyWaitMs: 15_000,
  maxArtifactBytes: 256 * 1024 * 1024,
});

export const INTERNAL_RESOURCE_BUDGET_V1: Readonly<ResourceBudgetV1> = Object.freeze({
  version: 1,
  maxRunDurationMs: 60 * 60 * 1000,
  maxTurns: 50,
  maxModelRequests: 100,
  maxToolInvocations: 500,
  maxRunInputTokens: 2_000_000,
  maxRunOutputTokens: 500_000,
  maxConcurrentSubagents: 4,
  maxConcurrentWriters: 2,
  maxConcurrentToolInvocations: 8,
  maxConcurrentShellInvocations: 2,
  maxConcurrencyWaitMs: 30_000,
  maxArtifactBytes: 512 * 1024 * 1024,
});

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

function nonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${field} must be a non-negative safe integer.`);
}

function nonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) throw new Error(`${field} must be non-empty.`);
}

export function assertResourceBudgetV1(value: ResourceBudgetV1): void {
  if (value.version !== 1) throw new Error(`Unsupported ResourceBudget version.`);
  for (const field of BUDGET_FIELDS) {
    if (!Number.isSafeInteger(value[field]) || value[field] <= 0)
      throw new Error(`${field} must be a positive safe integer.`);
  }
  if (value.maxConcurrentShellInvocations > value.maxConcurrentToolInvocations)
    throw new Error('Shell concurrency must not exceed tool concurrency.');
  if (value.maxConcurrentWriters > value.maxConcurrentToolInvocations)
    throw new Error('Writer concurrency must not exceed tool concurrency.');
}

export function assertResourceUsageV1(value: ResourceUsageV1): void {
  for (const field of COUNTER_FIELDS) nonNegativeInteger(value.counters[field], field);
  for (const field of GAUGE_FIELDS) nonNegativeInteger(value.gauges[field], field);
  if (value.source === 'versioned_upper_bound')
    nonEmpty(value.estimatorVersion ?? '', 'estimatorVersion');
  if (value.source === 'actual' && value.estimatorVersion !== undefined)
    throw new Error('Actual usage must not declare estimatorVersion.');
}

export function createZeroResourceUsageV1(
  source: ResourceUsageV1['source'] = 'actual',
  estimatorVersion = 'resource-budget-zero-v1',
): MutableResourceUsageV1 {
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
    source,
    ...(source === 'versioned_upper_bound' ? { estimatorVersion } : {}),
  };
}

export function createUnconfiguredResourceBudgetStateV1(): ResourceBudgetRuntimeStateV1 {
  return { status: 'unconfigured', reservations: {} };
}

export function tightenResourceBudgetV1(
  base: ResourceBudgetV1,
  tightening: Partial<Omit<ResourceBudgetV1, 'version'>>,
): ResourceBudgetV1 {
  assertResourceBudgetV1(base);
  for (const field of BUDGET_FIELDS) {
    const requested = tightening[field];
    if (requested != null && requested > base[field])
      throw new Error(`${field} can only be lowered from the effective release budget.`);
  }
  const result = { ...base, ...tightening, version: 1 as const };
  assertResourceBudgetV1(result);
  return result;
}

function addUsage(left: ResourceUsageV1, right: ResourceUsageV1): ResourceUsageV1 {
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
      ? { estimatorVersion: left.estimatorVersion ?? right.estimatorVersion ?? 'composed-v1' }
      : {}),
  };
}

function withinUpperBound(actual: ResourceUsageV1, upper: ResourceUsageV1): boolean {
  return (
    COUNTER_FIELDS.every((field) => actual.counters[field] <= upper.counters[field]) &&
    GAUGE_FIELDS.every((field) => actual.gauges[field] <= upper.gauges[field])
  );
}

function withinBudget(usage: ResourceUsageV1, budget: ResourceBudgetV1): boolean {
  return (
    usage.counters.turns <= budget.maxTurns &&
    usage.counters.modelRequests <= budget.maxModelRequests &&
    usage.counters.toolInvocations <= budget.maxToolInvocations &&
    usage.counters.inputTokens <= budget.maxRunInputTokens &&
    usage.counters.outputTokens <= budget.maxRunOutputTokens &&
    usage.counters.artifactBytes <= budget.maxArtifactBytes &&
    usage.gauges.elapsedRunMs <= budget.maxRunDurationMs &&
    usage.gauges.activeSubagents <= budget.maxConcurrentSubagents &&
    usage.gauges.activeWriters <= budget.maxConcurrentWriters &&
    usage.gauges.activeToolInvocations <= budget.maxConcurrentToolInvocations &&
    usage.gauges.activeShellInvocations <= budget.maxConcurrentShellInvocations
  );
}

export function committedResourceUsageV1(
  state: ActiveResourceBudgetRuntimeStateV1,
): ResourceUsageV1 {
  let usage = state.reconciledUsage;
  for (const reservation of Object.values(state.reservations)) {
    if (['reserved', 'dispatch_started', 'unknown'].includes(reservation.state))
      usage = addUsage(usage, reservation.executableUpperBound);
  }
  return usage;
}

function assertReservation(value: BudgetReservationV1): void {
  if (value.version !== 1) throw new Error('Unsupported BudgetReservation version.');
  nonEmpty(value.reservationId, 'reservationId');
  nonEmpty(value.runId, 'runId');
  nonEmpty(value.invocationId, 'invocationId');
  if (value.parentReservationId === value.reservationId)
    throw new Error('A reservation cannot be its own parent.');
  assertResourceUsageV1(value.executableUpperBound);
  if (value.executableUpperBound.source !== 'versioned_upper_bound')
    throw new Error('executableUpperBound must use versioned_upper_bound usage.');
  if (value.actual) {
    assertResourceUsageV1(value.actual);
    if (
      value.actual.source !== 'actual' ||
      !withinUpperBound(value.actual, value.executableUpperBound)
    )
      throw new Error('Reservation actual usage exceeds its executable upper bound.');
  }
}

function activeState(state: ResourceBudgetRuntimeStateV1): ActiveResourceBudgetRuntimeStateV1 {
  if (state.status !== 'active')
    throw new Error(`Resource budget ledger is ${state.status}; execution is blocked.`);
  return state;
}

function replaceReservation(
  state: ActiveResourceBudgetRuntimeStateV1,
  reservation: BudgetReservationV1,
): ActiveResourceBudgetRuntimeStateV1 {
  return {
    ...state,
    reservations: { ...state.reservations, [reservation.reservationId]: reservation },
  };
}

export function reduceResourceBudgetStateV1(
  state: ResourceBudgetRuntimeStateV1,
  event: ResourceBudgetEvent,
): ResourceBudgetRuntimeStateV1 {
  if (event.type === 'resource_budget.configured') {
    assertResourceBudgetV1(event.budget);
    nonEmpty(event.runId, 'runId');
    const started = Date.parse(event.startedAt);
    const deadline = Date.parse(event.deadlineAt);
    if (!Number.isFinite(started) || !Number.isFinite(deadline) || deadline <= started)
      throw new Error('Resource budget timestamps are invalid.');
    if (deadline - started > event.budget.maxRunDurationMs)
      throw new Error('Resource budget deadline exceeds maxRunDurationMs.');
    if (state.status === 'active') {
      if (
        state.runId === event.runId &&
        state.startedAt === event.startedAt &&
        state.deadlineAt === event.deadlineAt &&
        JSON.stringify(state.budget) === JSON.stringify(event.budget)
      )
        return state;
      throw new Error('An active resource budget cannot be replaced.');
    }
    return {
      status: 'active',
      runId: event.runId,
      startedAt: event.startedAt,
      deadlineAt: event.deadlineAt,
      budget: event.budget,
      reconciledUsage: createZeroResourceUsageV1(),
      reservations: {},
      waiters: {},
      nextWaiterSequence: 0,
    };
  }

  const active = activeState(state);
  if (event.type === 'resource_budget.waiter_enqueued') {
    const waiter = event.waiter;
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
    if (existing) {
      if (JSON.stringify(existing) === JSON.stringify(waiter)) return active;
      throw new Error('Concurrency waiter invocation was reused with different facts.');
    }
    return {
      ...active,
      waiters: { ...active.waiters, [waiter.invocationId]: waiter },
      nextWaiterSequence: active.nextWaiterSequence + 1,
    };
  }
  if (
    event.type === 'resource_budget.waiter_promoted' ||
    event.type === 'resource_budget.waiter_cancelled' ||
    event.type === 'resource_budget.waiter_timed_out'
  ) {
    const waiter = active.waiters[event.invocationId];
    if (!waiter) throw new Error(`Unknown concurrency waiter ${event.invocationId}.`);
    const targetState =
      event.type === 'resource_budget.waiter_promoted'
        ? 'promoted'
        : event.type === 'resource_budget.waiter_cancelled'
          ? 'cancelled'
          : 'timed_out';
    if (waiter.state === targetState) return active;
    if (waiter.state !== 'waiting') throw new Error(`Cannot change a ${waiter.state} waiter.`);
    return {
      ...active,
      waiters: {
        ...active.waiters,
        [event.invocationId]: { ...waiter, state: targetState },
      },
    };
  }
  if (event.type === 'resource_budget.reserved') {
    const candidate = event.reservation;
    assertReservation(candidate);
    if (candidate.state !== 'reserved') throw new Error('A new reservation must be reserved.');
    if (candidate.runId !== active.runId) throw new Error('Reservation runId mismatch.');
    if (candidate.parentReservationId && !active.reservations[candidate.parentReservationId])
      throw new Error('Parent reservation must exist in the shared ledger.');
    const existing = active.reservations[candidate.reservationId];
    if (existing) {
      if (JSON.stringify(existing) === JSON.stringify(candidate)) return active;
      throw new Error('Reservation idempotency key was reused with different facts.');
    }
    if (
      Object.values(active.reservations).some(
        (item) => item.invocationId === candidate.invocationId && item.state !== 'released',
      )
    )
      throw new Error('Invocation already has a non-released reservation.');
    const next = replaceReservation(active, candidate);
    if (!withinBudget(committedResourceUsageV1(next), active.budget))
      throw new Error('Resource budget exhausted before dispatch.');
    return next;
  }

  const reservation = active.reservations[event.reservationId];
  if (!reservation) throw new Error(`Unknown reservation ${event.reservationId}.`);
  switch (event.type) {
    case 'resource_budget.dispatch_started':
      if (reservation.state === 'dispatch_started') return active;
      if (reservation.state !== 'reserved')
        throw new Error(`Cannot dispatch a ${reservation.state} reservation.`);
      return replaceReservation(active, { ...reservation, state: 'dispatch_started' });
    case 'resource_budget.reconciled': {
      assertResourceUsageV1(event.actual);
      if (
        event.actual.source !== 'actual' ||
        !withinUpperBound(event.actual, reservation.executableUpperBound)
      )
        throw new Error('Reconciliation exceeds the executable upper bound.');
      if (reservation.state === 'reconciled') {
        if (JSON.stringify(reservation.actual) === JSON.stringify(event.actual)) return active;
        throw new Error('Reconciliation idempotency key was reused with different usage.');
      }
      if (reservation.state !== 'dispatch_started' && reservation.state !== 'unknown')
        throw new Error(`Cannot reconcile a ${reservation.state} reservation.`);
      const next = {
        ...replaceReservation(active, {
          ...reservation,
          actual: event.actual,
          state: 'reconciled',
        }),
        reconciledUsage: addUsage(active.reconciledUsage, event.actual),
      };
      if (!withinBudget(committedResourceUsageV1(next), active.budget))
        throw new Error('Reconciled usage exceeds the effective resource budget.');
      return next;
    }
    case 'resource_budget.released':
      if (reservation.state === 'released') return active;
      if (
        reservation.state !== 'reserved' &&
        !(
          reservation.state === 'dispatch_started' &&
          event.proof === 'local_provider_admission_denied'
        )
      ) {
        throw new Error('Only a proven undispatched reservation can be released.');
      }
      return replaceReservation(active, { ...reservation, state: 'released' });
    case 'resource_budget.unknown':
      if (reservation.state === 'unknown') return active;
      if (reservation.state !== 'dispatch_started' && reservation.state !== 'reserved')
        throw new Error('Only a pending reservation can become unknown.');
      return replaceReservation(active, { ...reservation, state: 'unknown' });
  }
}

export function assertResourceBudgetRuntimeStateV1(state: ResourceBudgetRuntimeStateV1): void {
  if (state.status === 'unconfigured') return;
  assertResourceBudgetV1(state.budget);
  nonEmpty(state.runId, 'runId');
  assertResourceUsageV1(state.reconciledUsage);
  if (state.reconciledUsage.source !== 'actual')
    throw new Error('reconciledUsage must contain actual usage.');
  for (const reservation of Object.values(state.reservations)) {
    assertReservation(reservation);
    if (reservation.runId !== state.runId) throw new Error('Reservation belongs to another run.');
    if (reservation.parentReservationId && !state.reservations[reservation.parentReservationId])
      throw new Error('Reservation parent is absent from the shared ledger.');
  }
  const sequences = new Set<number>();
  for (const waiter of Object.values(state.waiters ?? {})) {
    if (waiter.version !== 1 || waiter.runId !== state.runId)
      throw new Error('Concurrency waiter is invalid.');
    nonNegativeInteger(waiter.sequence, 'waiter.sequence');
    if (sequences.has(waiter.sequence))
      throw new Error('Concurrency waiter sequence is not unique.');
    sequences.add(waiter.sequence);
  }
  nonNegativeInteger(state.nextWaiterSequence ?? 0, 'nextWaiterSequence');
  if (!withinBudget(committedResourceUsageV1(state), state.budget))
    throw new Error('Committed resource usage exceeds the effective budget.');
}
