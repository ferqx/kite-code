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

/** Recover a finite ceiling without relying on the lost receipt-time budget object. */
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
  const parentDeadlineMs = Date.parse(intent.deadlineAt);
  const maximumChildDeadlineMs = grantIssuedAtMs + (upper?.gauges.elapsedRunMs ?? NaN);
  const deadlineMs = Math.min(parentDeadlineMs, maximumChildDeadlineMs);
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
    !Number.isSafeInteger(duration) ||
    duration < 1
  )
    throw new Error('Child budget recovery has no live exact delegation.');

  const childBudget: ResourceBudget = {
    version: 1,
    maxRunDurationMs: Math.min(upper.gauges.elapsedRunMs, duration),
    maxTurns: Math.min(upper.counters.turns, ledger.budget.maxTurns),
    maxModelRequests: Math.min(upper.counters.modelRequests, ledger.budget.maxModelRequests),
    maxToolInvocations: Math.min(upper.counters.toolInvocations, ledger.budget.maxToolInvocations),
    maxRunInputTokens: Math.min(upper.counters.inputTokens, ledger.budget.maxRunInputTokens),
    maxRunOutputTokens: Math.min(upper.counters.outputTokens, ledger.budget.maxRunOutputTokens),
    maxArtifactBytes: Math.min(upper.counters.artifactBytes, ledger.budget.maxArtifactBytes),
    // The Kernel budget schema requires positive concurrency values. The
    // child Tool router forbids nested Task; only a code role may write.
    maxConcurrentSubagents: 1,
    maxConcurrentWriters:
      intent.role === 'code'
        ? Math.min(upper.gauges.activeWriters, ledger.budget.maxConcurrentWriters)
        : 1,
    maxConcurrentToolInvocations: Math.min(
      upper.gauges.activeToolInvocations,
      ledger.budget.maxConcurrentToolInvocations,
    ),
    maxConcurrentShellInvocations: Math.min(
      upper.gauges.activeShellInvocations,
      ledger.budget.maxConcurrentShellInvocations,
    ),
    maxConcurrencyWaitMs: Math.min(ledger.budget.maxConcurrencyWaitMs, duration),
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
