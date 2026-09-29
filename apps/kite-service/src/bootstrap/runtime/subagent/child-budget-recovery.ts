import { DEFAULT_SUBAGENT_TIMEOUT_MS } from '@kite-ai/builtin-runtime/subagent';
import {
  assertChildBudgetWithinDelegation,
  assertResourceBudget,
  fundingBudgetForRun,
  type ResourceBudget,
} from '@kite-ai/runtime-host/kernel-adapter';
import { childDelegatedUpperBoundDigest } from '@kite-ai/runtime-host/storage';
import type { KiteSessionAppServerStorageOwner } from '../../kite-session-app-server-storage';
import type { RuntimeState } from '../state-runtime';

type ChildIntent = Pick<
  NonNullable<ReturnType<KiteSessionAppServerStorageOwner['readChildSessionIntent']>>,
  | 'childThreadId'
  | 'parentSessionId'
  | 'fundingRunId'
  | 'delegatedReservationId'
  | 'delegatedUpperBoundDigest'
  | 'delegatedUpperBoundJson'
  | 'deadlineAt'
  | 'disposition'
  | 'role'
>;

/** Recover the exact persisted child authority without trusting a lost receipt-time object. */
export function recoverChildDelegatedBudget(input: {
  readonly intent: ChildIntent;
  readonly parentState: Readonly<RuntimeState>;
  readonly grantIssuedAtMs: number;
  readonly nowMs: number;
}): Readonly<{ childBudget: ResourceBudget; childDeadlineAt: string }> {
  const { intent, parentState, grantIssuedAtMs, nowMs } = input;
  const ledger = fundingBudgetForRun(parentState, intent.fundingRunId);
  const reservation = ledger?.reservations[intent.delegatedReservationId];
  let persistedUpper: unknown;
  try {
    persistedUpper = JSON.parse(intent.delegatedUpperBoundJson);
  } catch {
    throw new Error('Child budget recovery has no valid persisted upper bound.');
  }
  const upper = reservation?.executableUpperBound;
  const independentTurnDeadline = upper?.independentChildTurnDeadline === true;
  const durationOnlyChildRun = upper?.durationOnlyChildRun === true;
  const parentDeadlineMs = Date.parse(intent.deadlineAt);
  const maximumChildDeadlineMs = grantIssuedAtMs + (upper?.gauges.elapsedRunMs ?? NaN);
  const deadlineMs = independentTurnDeadline
    ? nowMs + (upper?.gauges.elapsedRunMs ?? NaN)
    : Math.min(parentDeadlineMs, maximumChildDeadlineMs);
  const duration = deadlineMs - nowMs;
  if (
    (intent.disposition !== 'required' && intent.disposition !== 'after_turn') ||
    parentState.session.threadId !== intent.parentSessionId ||
    !ledger ||
    ledger.deadlineAt !== intent.deadlineAt ||
    (reservation?.state !== 'reserved' && reservation?.state !== 'queued') ||
    reservation.runId !== intent.fundingRunId ||
    reservation.invocationId !== `child-allotment:${intent.childThreadId}` ||
    reservation.resourceKind !== 'subagent' ||
    !upper ||
    upper.source !== 'versioned_upper_bound' ||
    JSON.stringify(upper) !== intent.delegatedUpperBoundJson ||
    JSON.stringify(persistedUpper) !== intent.delegatedUpperBoundJson ||
    childDelegatedUpperBoundDigest(upper) !== intent.delegatedUpperBoundDigest ||
    !Number.isSafeInteger(grantIssuedAtMs) ||
    !Number.isSafeInteger(nowMs) ||
    grantIssuedAtMs < 0 ||
    nowMs < grantIssuedAtMs ||
    !Number.isSafeInteger(parentDeadlineMs) ||
    !Number.isSafeInteger(maximumChildDeadlineMs) ||
    // The parent ledger remains finite. Only its exact, digest-bound child-allotment
    // reservation may delegate an uncapped child Tool counter (Host/Kernel enforce this).
    (independentTurnDeadline &&
      (reservation?.reservationId !== `child-allotment:${intent.childThreadId}` ||
        reservation.invocationId !== reservation.reservationId ||
        upper?.unboundedToolInvocations !== true ||
        upper.gauges.elapsedRunMs !== DEFAULT_SUBAGENT_TIMEOUT_MS)) ||
    (durationOnlyChildRun &&
      (!independentTurnDeadline ||
        Object.values(upper?.counters ?? {}).some((value) => value !== 0))) ||
    !Number.isSafeInteger(duration) ||
    duration < 1
  )
    throw new Error('Child budget recovery has no live exact delegation.');

  const childBudget: ResourceBudget = {
    version: 1,
    maxRunDurationMs: Math.min(upper.gauges.elapsedRunMs, duration),
    maxTurns: durationOnlyChildRun ? 0 : Math.min(upper.counters.turns, ledger.budget.maxTurns),
    maxModelRequests: durationOnlyChildRun
      ? 0
      : Math.min(upper.counters.modelRequests, ledger.budget.maxModelRequests),
    maxToolInvocations: independentTurnDeadline
      ? 0
      : Math.min(upper.counters.toolInvocations, ledger.budget.maxToolInvocations),
    ...(independentTurnDeadline ? { unboundedToolInvocations: true as const } : {}),
    ...(durationOnlyChildRun ? { durationOnlyChildRun: true as const } : {}),
    maxRunInputTokens: durationOnlyChildRun
      ? 0
      : Math.min(upper.counters.inputTokens, ledger.budget.maxRunInputTokens),
    maxRunOutputTokens: durationOnlyChildRun
      ? 0
      : Math.min(upper.counters.outputTokens, ledger.budget.maxRunOutputTokens),
    maxArtifactBytes: durationOnlyChildRun
      ? 0
      : Math.min(upper.counters.artifactBytes, ledger.budget.maxArtifactBytes),
    // The Kernel budget schema requires positive concurrency values. The
    // child Tool router forbids nested Task; role permissions govern writes.
    maxConcurrentSubagents: 1,
    maxConcurrentWriters: durationOnlyChildRun
      ? Number.MAX_SAFE_INTEGER
      : intent.role === 'code'
        ? Math.min(upper.gauges.activeWriters, ledger.budget.maxConcurrentWriters)
        : 1,
    // A duration-only child has no local Tool or Shell concurrency ceiling.
    maxConcurrentToolInvocations: durationOnlyChildRun
      ? Number.MAX_SAFE_INTEGER
      : independentTurnDeadline
        ? 1
        : Math.min(upper.gauges.activeToolInvocations, ledger.budget.maxConcurrentToolInvocations),
    maxConcurrentShellInvocations: durationOnlyChildRun ? Number.MAX_SAFE_INTEGER : 0,
    maxConcurrencyWaitMs: durationOnlyChildRun
      ? duration
      : Math.min(ledger.budget.maxConcurrencyWaitMs, duration),
  };
  assertResourceBudget(childBudget);
  const childDeadlineAt = new Date(deadlineMs).toISOString();
  if (reservation.state === 'reserved')
    assertChildBudgetWithinDelegation({
      reservation,
      childBudget,
      childStartedAt: new Date(nowMs).toISOString(),
      childDeadlineAt,
      fundingDeadlineAt: intent.deadlineAt,
      childMaySpawn: false,
      childMayWrite: intent.role === 'code',
    });
  return Object.freeze({ childBudget: Object.freeze(childBudget), childDeadlineAt });
}
