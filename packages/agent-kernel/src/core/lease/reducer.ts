import type { KernelEvent } from '../../events';
import { eventRecord, stringField } from '../../reducer-utils';
import type {
  AgentProviderReadinessState,
  AgentResourceBudgetActiveState,
  AgentResourceBudgetState,
  AgentState,
  ResourceBudgetV1,
  ResourceReservationV1,
  ResourceUsageV1,
  ResourceWaiterV1,
} from '../../state';

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

function assertResourceBudget(value: ResourceBudgetV1): void {
  if (value == null || typeof value !== 'object' || value.version !== 1)
    throw new Error('Unsupported ResourceBudget version.');
  const candidate = value as unknown as Record<string, unknown>;
  for (const field of BUDGET_FIELDS) positiveInteger(candidate[field], field);
  if (value.maxConcurrentShellInvocations > value.maxConcurrentToolInvocations)
    throw new Error('Shell concurrency must not exceed tool concurrency.');
  if (value.maxConcurrentWriters > value.maxConcurrentToolInvocations)
    throw new Error('Writer concurrency must not exceed tool concurrency.');
}

function assertResourceUsage(value: ResourceUsageV1): void {
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

function zeroUsage(): ResourceUsageV1 {
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

function committedUsage(state: AgentResourceBudgetActiveState): ResourceUsageV1 {
  let usage = state.reconciledUsage;
  for (const reservation of Object.values(state.reservations)) {
    if (['reserved', 'dispatch_started', 'unknown'].includes(reservation.state))
      usage = addUsage(usage, reservation.executableUpperBound);
  }
  return usage;
}

function assertReservation(value: ResourceReservationV1): void {
  if (value == null || typeof value !== 'object' || value.version !== 1)
    throw new Error('Unsupported ResourceReservation version.');
  nonEmpty(value.reservationId, 'reservationId');
  nonEmpty(value.runId, 'runId');
  nonEmpty(value.invocationId, 'invocationId');
  if (value.parentReservationId === value.reservationId)
    throw new Error('A reservation cannot be its own parent.');
  if (!RESOURCE_KINDS.includes(value.resourceKind))
    throw new Error('Reservation resource kind is invalid.');
  assertResourceUsage(value.executableUpperBound);
  if (value.executableUpperBound.source !== 'versioned_upper_bound')
    throw new Error('executableUpperBound must use versioned_upper_bound usage.');
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
  reservation: ResourceReservationV1,
): AgentResourceBudgetActiveState {
  return {
    ...state,
    reservations: { ...state.reservations, [reservation.reservationId]: reservation },
  };
}

function isResourceBudgetEvent(type: KernelEvent['type']): boolean {
  return type.startsWith('resource_budget.');
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
      const budget = payload.budget as ResourceBudgetV1;
      assertResourceBudget(budget);
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
        throw new Error('An active resource budget cannot be replaced.');
      }
      return {
        ...state,
        resourceBudget: {
          status: 'active',
          runId,
          startedAt,
          deadlineAt,
          budget,
          reconciledUsage: zeroUsage(),
          reservations: {},
          waiters: {},
          nextWaiterSequence: 0,
        },
      };
    }

    const active = activeState(state.resourceBudget);
    if (event.type === 'resource_budget.waiter_enqueued') {
      const waiter = payload.waiter as ResourceWaiterV1;
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
      if (existing) {
        if (JSON.stringify(existing) === JSON.stringify(waiter)) return state;
        throw new Error('Concurrency waiter invocation was reused with different facts.');
      }
      return {
        ...state,
        resourceBudget: {
          ...active,
          waiters: { ...active.waiters, [waiter.invocationId]: waiter },
          nextWaiterSequence: active.nextWaiterSequence + 1,
        },
      };
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
      return {
        ...state,
        resourceBudget: {
          ...active,
          waiters: {
            ...active.waiters,
            [invocationId]: { ...waiter, state: targetState },
          },
        },
      };
    }

    if (event.type === 'resource_budget.reserved') {
      const candidate = payload.reservation as ResourceReservationV1;
      assertReservation(candidate);
      if (candidate.state !== 'reserved') throw new Error('A new reservation must be reserved.');
      if (candidate.runId !== active.runId) throw new Error('Reservation runId mismatch.');
      if (candidate.parentReservationId && !active.reservations[candidate.parentReservationId])
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
      if (!withinBudget(committedUsage(next), active.budget))
        throw new Error('Resource budget exhausted before dispatch.');
      return { ...state, resourceBudget: next };
    }

    const reservationId = payload.reservationId;
    nonEmpty(reservationId, 'reservationId');
    const reservation = active.reservations[reservationId];
    if (!reservation) throw new Error(`Unknown reservation ${reservationId}.`);
    let next = active;
    switch (event.type) {
      case 'resource_budget.dispatch_started':
        if (reservation.state === 'dispatch_started') return state;
        if (reservation.state !== 'reserved')
          throw new Error(`Cannot dispatch a ${reservation.state} reservation.`);
        next = replaceReservation(active, { ...reservation, state: 'dispatch_started' });
        break;
      case 'resource_budget.reconciled': {
        const actual = payload.actual as ResourceUsageV1;
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
          ...replaceReservation(active, { ...reservation, actual, state: 'reconciled' }),
          reconciledUsage: addUsage(active.reconciledUsage, actual),
        };
        if (!withinBudget(committedUsage(next), active.budget))
          throw new Error('Reconciled usage exceeds the effective resource budget.');
        break;
      }
      case 'resource_budget.released': {
        if (reservation.state === 'released') return state;
        const proof = stringField(payload, 'proof');
        if (
          reservation.state !== 'reserved' &&
          !(reservation.state === 'dispatch_started' && proof === 'local_provider_admission_denied')
        )
          throw new Error('Only a proven undispatched reservation can be released.');
        next = replaceReservation(active, { ...reservation, state: 'released' });
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
    return { ...state, resourceBudget: next };
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
