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
  resourceDeadlineMs,
} from '@kite-ai/runtime-host/kernel-adapter';
import type { RuntimeEvent, RuntimeState } from '../state-runtime';

type RunningTaskTerminal = Extract<RuntimeEvent, { type: 'tool.finished' }>;
type ChildRole = 'explore' | 'plan' | 'code' | 'review';

/** Reserve only the child execution slot and deadline in the parent ledger.
 * The child Run clock starts at activation; its cumulative work is not charged
 * against the parent's model, token, turn or Artifact counters.
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
  const originalDeadline = resourceDeadlineMs(ledger.deadlineAt);
  // The parent must still own a live funding Run when it accepts the Task.
  // Each child Run later starts its own 30-minute clock at activation.
  // Child creation is rejected at capacity;
  // no child Session or execution lease is created for an unadmitted request.
  const duration = DEFAULT_SUBAGENT_TIMEOUT_MS;
  if (
    (ledger.deadlineAt !== null && !Number.isSafeInteger(originalDeadline)) ||
    originalDeadline <= now ||
    !Number.isSafeInteger(now + duration)
  )
    throw new Error('Child allotment parent deadline has expired.');
  const deadlineAt = new Date(now + duration).toISOString();
  const toolActual = actualUsageForReservation(state, transient, [toolFinished]);
  const actual = {
    ...toolActual,
    counters: { ...toolActual.counters, artifactBytes: 0 },
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
  const slotAvailable = committed.gauges.activeSubagents < ledger.budget.maxConcurrentSubagents;
  if (!slotAvailable) throw new Error('Sub-agent concurrency capacity is full.');
  const childBudget: ResourceBudget = {
    version: 1,
    maxRunDurationMs: duration,
    maxTurns: 0,
    maxModelRequests: 0,
    maxToolInvocations: 0,
    unboundedToolInvocations: true,
    durationOnlyChildRun: true,
    maxRunInputTokens: 0,
    maxRunOutputTokens: 0,
    maxArtifactBytes: 0,
    maxConcurrentSubagents: 1,
    maxConcurrentWriters: Number.MAX_SAFE_INTEGER,
    maxConcurrentToolInvocations: Number.MAX_SAFE_INTEGER,
    maxConcurrentShellInvocations: Number.MAX_SAFE_INTEGER,
    maxConcurrencyWaitMs: duration,
  };
  assertResourceBudget(childBudget);
  const reservationId = `child-allotment:${childThreadId}`;
  if (projected.reservations[reservationId])
    throw new Error('Child allotment identity is already reserved.');
  const upper = createZeroResourceUsage('versioned_upper_bound', 'child-delegated-allotment-v2');
  upper.unboundedToolInvocations = true;
  upper.independentChildTurnDeadline = true;
  upper.durationOnlyChildRun = true;
  upper.gauges.elapsedRunMs = duration;
  upper.gauges.activeSubagents = 1;
  const reservation: BudgetReservation = {
    version: 1,
    reservationId,
    runId: ledger.runId,
    invocationId: reservationId,
    resourceKind: 'subagent',
    executableUpperBound: upper,
    state: 'reserved',
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
