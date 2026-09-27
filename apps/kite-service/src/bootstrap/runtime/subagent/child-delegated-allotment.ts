import { DEFAULT_SUBAGENT_TIMEOUT_MS } from '@kite-ai/builtin-runtime/subagent';
import {
  actualUsageForReservation,
  assertResourceBudget,
  type BudgetReservation,
  committedResourceUsage,
  createZeroResourceUsage,
  type ResourceBudget,
  type ResourceBudgetReconciledEvent,
  type ResourceBudgetReservedEvent,
  reduceResourceBudgetState,
} from '@kite-ai/runtime-host/kernel-adapter';
import type { RuntimeEvent, RuntimeState } from '../state-runtime';

type RunningTaskTerminal = Extract<RuntimeEvent, { type: 'tool.finished' }>;
type ChildRole = 'explore' | 'plan' | 'code' | 'review';

const COUNTERS = [
  ['maxTurns', 'turns'],
  ['maxModelRequests', 'modelRequests'],
  ['maxRunInputTokens', 'inputTokens'],
  ['maxRunOutputTokens', 'outputTokens'],
  ['maxArtifactBytes', 'artifactBytes'],
] as const;

/** Pure parent-ledger admission for one independently budgeted child Session.
 * The receipt reserves a 30-minute ceiling; the child Run clock starts at activation.
 */
export function planChildDelegatedAllotment(input: {
  readonly state: Readonly<RuntimeState>;
  readonly transientReservationId: string;
  readonly toolFinished: RunningTaskTerminal;
  readonly childThreadId: string;
  readonly role: ChildRole;
  readonly taskArtifactBytes: number;
  readonly now: number;
}): Readonly<{
  events: readonly [ResourceBudgetReconciledEvent, ResourceBudgetReservedEvent];
  reservation: BudgetReservation;
  childBudget: ResourceBudget;
  deadlineAt: string;
}> {
  const { state, transientReservationId, toolFinished, childThreadId, role, now } = input;
  const ledger = state.resourceBudget;
  if (ledger.status !== 'active')
    throw new Error('Child allotment requires an active parent budget.');
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !/^child_[a-f0-9]{64}$/u.test(childThreadId) ||
    !['explore', 'plan', 'code', 'review'].includes(role) ||
    !transientReservationId ||
    !Number.isSafeInteger(input.taskArtifactBytes) ||
    input.taskArtifactBytes < 1 ||
    toolFinished.name !== 'task' ||
    toolFinished.result.ok !== true ||
    toolFinished.result.resultMeta?.taskStatus !== 'running' ||
    !['required', 'after_turn'].includes(toolFinished.result.resultMeta.taskDisposition ?? '')
  )
    throw new Error('Child allotment requires one exact running Task receipt.');
  const transient = ledger.reservations[transientReservationId];
  if (
    !transient ||
    transient.runId !== ledger.runId ||
    transient.resourceKind !== 'subagent' ||
    transient.invocationId !== `tool:${toolFinished.toolCallId}` ||
    (transient.state !== 'dispatch_started' && transient.state !== 'unknown')
  )
    throw new Error('Child allotment transient reservation is not reconcilable.');
  const originalDeadline = Date.parse(ledger.deadlineAt);
  // The parent must still own a live funding Run when it accepts the Task.
  // Each child Run later starts its own 30-minute clock at activation.
  // Finite counters remain additive. Limited admits two active children and
  // one queued sibling.
  const divisor = ledger.budget.maxConcurrentSubagents + 2;
  const duration = DEFAULT_SUBAGENT_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(originalDeadline) ||
    originalDeadline <= now ||
    !Number.isSafeInteger(now + duration)
  )
    throw new Error('Child allotment parent deadline has expired.');
  const deadlineAt = new Date(now + duration).toISOString();
  const toolActual = actualUsageForReservation(state, transient, [toolFinished]);
  const actual = {
    ...toolActual,
    counters: { ...toolActual.counters, artifactBytes: input.taskArtifactBytes },
  };
  if (actual.counters.artifactBytes > transient.executableUpperBound.counters.artifactBytes)
    throw new Error('Task Artifact exceeds its parent Tool reservation.');
  if (actual.counters.toolInvocations !== 1 || actual.gauges.activeSubagents !== 0)
    throw new Error('Child allotment transient usage is not the Task Tool receipt.');
  const reconciled: ResourceBudgetReconciledEvent = {
    type: 'resource_budget.reconciled',
    reservationId: transientReservationId,
    actual,
  };
  const projected = reduceResourceBudgetState(ledger, reconciled);
  if (projected.status !== 'active') throw new Error('Child allotment funding ledger closed.');
  const committed = committedResourceUsage(projected);
  const allotments = Object.fromEntries(
    COUNTERS.map(([limit, counter]) => [
      limit,
      Math.min(
        Math.floor(ledger.budget[limit] / divisor),
        ledger.budget[limit] - committed.counters[counter],
      ),
    ]),
  ) as Record<(typeof COUNTERS)[number][0], number>;
  if (COUNTERS.some(([limit]) => !Number.isSafeInteger(allotments[limit]) || allotments[limit] < 1))
    throw new Error('Child allotment has no positive counter budget.');
  const slotAvailable =
    committed.gauges.activeSubagents < ledger.budget.maxConcurrentSubagents &&
    committed.gauges.activeToolInvocations < ledger.budget.maxConcurrentToolInvocations &&
    committed.gauges.activeShellInvocations < ledger.budget.maxConcurrentShellInvocations &&
    (role !== 'code' || committed.gauges.activeWriters < ledger.budget.maxConcurrentWriters);
  const waitMs = Math.min(ledger.budget.maxConcurrencyWaitMs, duration);
  if (waitMs < 1) throw new Error('Child allotment concurrency wait is unavailable.');
  const childBudget: ResourceBudget = {
    version: 1,
    maxRunDurationMs: duration,
    maxTurns: allotments.maxTurns,
    maxModelRequests: allotments.maxModelRequests,
    maxToolInvocations: 0,
    unboundedToolInvocations: true,
    maxRunInputTokens: allotments.maxRunInputTokens,
    maxRunOutputTokens: allotments.maxRunOutputTokens,
    maxArtifactBytes: allotments.maxArtifactBytes,
    maxConcurrentSubagents: 1,
    maxConcurrentWriters: 1,
    maxConcurrentToolInvocations: 1,
    maxConcurrentShellInvocations: 1,
    maxConcurrencyWaitMs: waitMs,
  };
  assertResourceBudget(childBudget);
  const reservationId = `child-allotment:${childThreadId}`;
  if (projected.reservations[reservationId])
    throw new Error('Child allotment identity is already reserved.');
  const upper = createZeroResourceUsage('versioned_upper_bound', 'child-delegated-allotment-v2');
  upper.counters.turns = childBudget.maxTurns;
  upper.counters.modelRequests = childBudget.maxModelRequests;
  upper.unboundedToolInvocations = true;
  upper.independentChildTurnDeadline = true;
  upper.counters.inputTokens = childBudget.maxRunInputTokens;
  upper.counters.outputTokens = childBudget.maxRunOutputTokens;
  upper.counters.artifactBytes = childBudget.maxArtifactBytes;
  upper.gauges.elapsedRunMs = duration;
  upper.gauges.activeSubagents = 1;
  upper.gauges.activeWriters = role === 'code' ? 1 : 0;
  upper.gauges.activeToolInvocations = 1;
  upper.gauges.activeShellInvocations = 1;
  const reservation: BudgetReservation = {
    version: 1,
    reservationId,
    runId: ledger.runId,
    invocationId: reservationId,
    resourceKind: 'subagent',
    executableUpperBound: upper,
    state: slotAvailable ? 'reserved' : 'queued',
  };
  const reserved: ResourceBudgetReservedEvent = { type: 'resource_budget.reserved', reservation };
  reduceResourceBudgetState(projected, reserved);
  return Object.freeze({
    events: Object.freeze([reconciled, reserved] as const),
    reservation,
    childBudget,
    deadlineAt,
  });
}

/** Preserve the new child Run's full clock while retaining legacy receipt deadlines. */
export function childBudgetAtActivation(input: {
  readonly childBudget: ResourceBudget;
  readonly deadlineAt: string;
  readonly startedAt: number;
  readonly independentTurnDeadline?: boolean;
}): ResourceBudget {
  const deadline = Date.parse(input.deadlineAt);
  const remaining = deadline - input.startedAt;
  if (
    !Number.isSafeInteger(input.startedAt) ||
    input.startedAt < 0 ||
    !Number.isSafeInteger(remaining) ||
    (!input.independentTurnDeadline && remaining < 1)
  )
    throw new Error('Child activation deadline has expired.');
  const maxRunDurationMs = input.independentTurnDeadline
    ? input.childBudget.maxRunDurationMs
    : Math.min(input.childBudget.maxRunDurationMs, remaining);
  const result: ResourceBudget = {
    ...input.childBudget,
    maxRunDurationMs,
    maxConcurrencyWaitMs: Math.min(input.childBudget.maxConcurrencyWaitMs, maxRunDurationMs),
  };
  assertResourceBudget(result);
  return Object.freeze(result);
}
