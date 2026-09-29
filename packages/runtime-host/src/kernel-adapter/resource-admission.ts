import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type {
  RuntimeEffect,
  KernelEvent as RuntimeEvent,
  AgentState as RuntimeState,
} from '@kite-ai/agent-kernel';
import type { ModelInvocationEnvelope } from '@kite-ai/runtime-spi';
import {
  type ActiveResourceBudgetRuntimeState,
  type BudgetReservation,
  type ConcurrencyWaiter,
  committedResourceUsage,
  createZeroResourceUsage,
  fundingBudgetForReservation,
  fundingBudgetForRun,
  type ResourceBudgetRuntimeState,
  type ResourceUsage,
  reduceResourceBudgetState,
} from './resource-budget';

export type RuntimeBudgetAdmissionReason =
  | 'admitted'
  | 'budget_unconfigured'
  | 'persistence_unavailable'
  | 'budget_exhausted'
  | 'reconciliation_required'
  | 'tool_concurrency_saturated'
  | 'shell_concurrency_saturated';

export interface RuntimeBudgetAdmissionPlan {
  status: 'admitted' | 'waiting' | 'denied' | 'not_required';
  reason: RuntimeBudgetAdmissionReason;
  effect: RuntimeEffect;
  preparationEvents: RuntimeEvent[];
  dispatchEvents: RuntimeEvent[];
  reservationIds: string[];
  waitDeadlineAt?: string;
  /** Exact undispatched Tool whose durable concurrency waiter expired. */
  timedOutToolCallId?: string;
  /** Exact undispatched Tool that cannot fit the remaining cumulative budget. */
  budgetDeniedToolCallId?: string;
}

export interface ModelResourcePreparationPlan {
  budget: ModelInvocationEnvelope['resource']['budget'];
  preparationEvents: RuntimeEvent[];
  maxOutputTokens?: number;
}

export interface BoundedFollowupModelResourcePlan extends ModelResourcePreparationPlan {
  turnReservationId: string;
  /** Persist immediately before the new child turn receives execution authority. */
  turnDispatchEvent: Extract<RuntimeEvent, { type: 'resource_budget.dispatch_started' }>;
}

/**
 * Plan one explicit Gateway-owned model reservation after its Surface is
 * frozen. The caller atomically persists these events with
 * model.invocation_prepared; dispatch_started deliberately remains absent.
 */
export function planModelInvocationResource(
  state: RuntimeState,
  input: {
    invocationId: string;
    inputTokens: number;
    requestedMaxOutputTokens?: number;
    resourceKind: 'model' | 'compaction' | 'verification';
    parentReservationId?: string;
    /** Reserved after-turn report budget replaced atomically by this exact Surface. */
    replaceReservationId?: string;
    now?: Date;
  },
): ModelResourcePreparationPlan {
  if (!Number.isSafeInteger(input.inputTokens) || input.inputTokens < 0) {
    throw new DescendantResourceAdmissionError(
      'budget_exhausted',
      'Model Surface input estimate is invalid.',
    );
  }
  const linkedReservationId = input.parentReservationId ?? input.replaceReservationId;
  const linkedBudget = linkedReservationId
    ? fundingBudgetForReservation(state, linkedReservationId)
    : undefined;
  if (linkedReservationId && !linkedBudget)
    throw new DescendantResourceAdmissionError('reconciliation_required');
  if (!linkedBudget && state.resourceBudget.status === 'unconfigured') {
    return {
      budget: { kind: 'no_budget', reason: 'resource_budget_disabled' },
      preparationEvents: [],
      ...(input.requestedMaxOutputTokens
        ? { maxOutputTokens: input.requestedMaxOutputTokens }
        : {}),
    };
  }
  if (!linkedBudget && state.resourceBudget.status !== 'active') {
    throw new DescendantResourceAdmissionError('budget_unconfigured');
  }
  const successorBudget =
    input.replaceReservationId &&
    !input.parentReservationId &&
    linkedBudget &&
    state.resourceBudget.status === 'active' &&
    linkedBudget.runId !== state.resourceBudget.runId
      ? state.resourceBudget
      : undefined;
  let budget =
    successorBudget ?? linkedBudget ?? (state.resourceBudget as ActiveResourceBudgetRuntimeState);
  if (
    input.parentReservationId &&
    input.replaceReservationId &&
    !budget.reservations[input.replaceReservationId]
  )
    throw new DescendantResourceAdmissionError('reconciliation_required');
  const unresolvedAttempt = (reservation: BudgetReservation): boolean =>
    reservation.state === 'unknown' &&
    !(
      reservation.resourceKind === 'subagent' &&
      reservation.executableUpperBound.independentFollowupTurn === true &&
      reservation.executableUpperBound.durationOnlyChildRun === true
    );
  // A prior independent child may have an unknown result. Its immutable
  // reservation still consumes its concurrency slot, but does not authorize
  // replay and does not prevent a distinct parent Model invocation.
  if (
    Object.values(budget.reservations).some(unresolvedAttempt) ||
    (successorBudget !== undefined &&
      linkedBudget !== undefined &&
      Object.values(linkedBudget.reservations).some(unresolvedAttempt))
  ) {
    throw new DescendantResourceAdmissionError('reconciliation_required');
  }
  if (input.parentReservationId) {
    const parent = budget.reservations[input.parentReservationId];
    if (
      !parent ||
      (parent.state !== 'dispatch_started' &&
        !(parent.resourceKind === 'subagent' && parent.state === 'reconciled'))
    ) {
      throw new DescendantResourceAdmissionError('reconciliation_required');
    }
  }
  const preparationEvents: RuntimeEvent[] = [];
  let replacementCeiling: BudgetReservation | undefined;
  if (input.replaceReservationId) {
    const replacementBudget = linkedBudget ?? budget;
    const placeholder = replacementBudget.reservations[input.replaceReservationId];
    if (
      placeholder?.state !== 'reserved' ||
      placeholder.resourceKind !== 'model' ||
      placeholder.parentReservationId !== undefined
    ) {
      throw new DescendantResourceAdmissionError('reconciliation_required');
    }
    replacementCeiling = placeholder;
    const release: RuntimeEvent = {
      type: 'resource_budget.released',
      reservationId: placeholder.reservationId,
    };
    const releasedBudget = reduceResourceBudgetState(
      replacementBudget,
      release as Extract<RuntimeEvent, { type: 'resource_budget.released' }>,
    ) as ActiveResourceBudgetRuntimeState;
    if (replacementBudget === budget) budget = releasedBudget;
    preparationEvents.push(release);
  }
  const committed = committedResourceUsage(budget);
  const durationOnly = budget.budget.durationOnlyChildRun === true;
  const remainingInput = Math.min(
    durationOnly
      ? Number.MAX_SAFE_INTEGER
      : budget.budget.maxRunInputTokens - committed.counters.inputTokens,
    durationOnly
      ? Number.MAX_SAFE_INTEGER
      : (replacementCeiling?.executableUpperBound.counters.inputTokens ?? Number.MAX_SAFE_INTEGER),
  );
  const remainingOutput = Math.min(
    durationOnly
      ? Number.MAX_SAFE_INTEGER
      : budget.budget.maxRunOutputTokens - committed.counters.outputTokens,
    durationOnly
      ? Number.MAX_SAFE_INTEGER
      : (replacementCeiling?.executableUpperBound.counters.outputTokens ?? Number.MAX_SAFE_INTEGER),
  );
  const maxOutputTokens = durationOnly
    ? input.requestedMaxOutputTokens
    : Math.min(input.requestedMaxOutputTokens ?? remainingOutput, remainingOutput);
  if (maxOutputTokens !== undefined && maxOutputTokens <= 0)
    throw new DescendantResourceAdmissionError('budget_exhausted');
  // The Provider may count more prompt tokens than the local tokenizer. If the
  // remaining Run budget cannot fund the full 2x envelope, stop before dispatch
  // instead of persisting a response that cannot be reconciled afterwards.
  const inputTokenUpperBound = durationOnly ? 0 : input.inputTokens * 2;
  if (
    !durationOnly &&
    (!Number.isSafeInteger(inputTokenUpperBound) || inputTokenUpperBound > remainingInput)
  ) {
    throw new DescendantResourceAdmissionError('budget_exhausted');
  }
  const usage = createZeroResourceUsage('versioned_upper_bound', 'model-surface-v2');
  usage.counters.modelRequests = 1;
  // Provider tokenizers and wire-level tool framing can exceed the local
  // cl100k frozen-surface estimate. Reserve a bounded 2x envelope while the
  // total Run input budget remains the hard ceiling.
  if (durationOnly) {
    usage.unboundedModelTokens = true;
  } else {
    usage.counters.inputTokens = inputTokenUpperBound;
    usage.counters.outputTokens = maxOutputTokens!;
  }
  const reservation: BudgetReservation = {
    version: 1,
    reservationId: crypto.randomUUID(),
    runId: budget.runId,
    invocationId: `model-invocation:${input.invocationId}`,
    ...(input.parentReservationId ? { parentReservationId: input.parentReservationId } : {}),
    resourceKind: input.resourceKind,
    executableUpperBound: usage,
    state: 'reserved',
  };
  try {
    reduceResourceBudgetState(budget, { type: 'resource_budget.reserved', reservation });
  } catch (error) {
    throw new DescendantResourceAdmissionError(
      'budget_exhausted',
      error instanceof Error ? error.message : String(error),
    );
  }
  return {
    budget: {
      kind: 'reservation',
      reservationId: reservation.reservationId,
      parentReservationId: reservation.parentReservationId ?? null,
    },
    preparationEvents: [...preparationEvents, { type: 'resource_budget.reserved', reservation }],
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  };
}

/**
 * Exchange one undispatched TriggerTurn backup for the first frozen model
 * Surface of a new child turn. The single reducer event is the only release
 * path; a denied plan leaves the backup held.
 */
export function planBoundedFollowupModelResource(
  state: RuntimeState,
  input: {
    fundingRunId: string;
    fundingDeadlineAt: string;
    backupReservationId: string;
    turnReservationId: string;
    replacementReservationId: string;
    invocationId: string;
    inputTokens: number;
    /** Already committed target Run ceiling that the source allotment must cover. */
    minimumInputTokensUpperBound?: number;
    requestedMaxOutputTokens?: number;
    now?: Date;
  },
): BoundedFollowupModelResourcePlan {
  const budget = fundingBudgetForRun(state, input.fundingRunId);
  if (!budget) throw new DescendantResourceAdmissionError('budget_unconfigured');
  if (budget.deadlineAt !== input.fundingDeadlineAt)
    throw new DescendantResourceAdmissionError('reconciliation_required');
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime()) || now.getTime() >= Date.parse(budget.deadlineAt))
    throw new DescendantResourceAdmissionError('budget_exhausted', 'Funding run deadline elapsed.');
  if (Object.values(budget.reservations).some((item) => item.state === 'unknown'))
    throw new DescendantResourceAdmissionError('reconciliation_required');
  const backup = budget.reservations[input.backupReservationId];
  if (
    backup?.state !== 'reserved' ||
    backup.resourceKind !== 'subagent' ||
    backup.runId !== input.fundingRunId
  )
    throw new DescendantResourceAdmissionError('reconciliation_required');
  if (
    !Number.isSafeInteger(input.inputTokens) ||
    input.inputTokens < 0 ||
    !Number.isSafeInteger(input.inputTokens * 2) ||
    (input.minimumInputTokensUpperBound !== undefined &&
      (!Number.isSafeInteger(input.minimumInputTokensUpperBound) ||
        input.minimumInputTokensUpperBound < 0))
  )
    throw new DescendantResourceAdmissionError(
      'budget_exhausted',
      'Model input estimate is invalid.',
    );
  const maxOutputTokens =
    input.requestedMaxOutputTokens ?? backup.executableUpperBound.counters.outputTokens;
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0)
    throw new DescendantResourceAdmissionError(
      'budget_exhausted',
      'Model output bound is invalid.',
    );
  const turnUsage = createZeroResourceUsage('versioned_upper_bound', 'followup-child-turn-v1');
  turnUsage.counters.turns = 1;
  turnUsage.gauges.activeSubagents = 1;
  const usage = createZeroResourceUsage('versioned_upper_bound', 'followup-model-surface-v1');
  usage.counters.modelRequests = 1;
  usage.counters.inputTokens = Math.max(
    input.inputTokens * 2,
    input.minimumInputTokensUpperBound ?? 0,
  );
  usage.counters.outputTokens = maxOutputTokens;
  const turnReservation: BudgetReservation = {
    version: 1,
    reservationId: input.turnReservationId,
    runId: input.fundingRunId,
    invocationId: `followup-turn:${input.invocationId}`,
    replacesReservationId: input.backupReservationId,
    resourceKind: 'subagent',
    executableUpperBound: turnUsage,
    state: 'reserved',
  };
  const replacement: BudgetReservation = {
    version: 1,
    reservationId: input.replacementReservationId,
    runId: input.fundingRunId,
    invocationId: `model-invocation:${input.invocationId}`,
    parentReservationId: input.turnReservationId,
    replacesReservationId: input.backupReservationId,
    resourceKind: 'model',
    executableUpperBound: usage,
    state: 'reserved',
  };
  const event: RuntimeEvent = {
    type: 'resource_budget.bounded_replaced',
    reservationId: input.backupReservationId,
    turnReservation,
    replacement,
  };
  try {
    reduceResourceBudgetState(budget, event);
  } catch (error) {
    throw new DescendantResourceAdmissionError(
      'budget_exhausted',
      error instanceof Error ? error.message : String(error),
    );
  }
  return {
    budget: {
      kind: 'reservation',
      reservationId: replacement.reservationId,
      parentReservationId: turnReservation.reservationId,
    },
    preparationEvents: [event],
    maxOutputTokens,
    turnReservationId: turnReservation.reservationId,
    turnDispatchEvent: {
      type: 'resource_budget.dispatch_started',
      reservationId: turnReservation.reservationId,
    },
  };
}

export interface DescendantBudgetReservation {
  reservationId: string;
  maxOutputTokens?: number;
}

export interface DescendantResourceAdmission {
  reserveModel(input: {
    invocationKey: string;
    inputTokens: number;
    requestedMaxOutputTokens?: number;
  }): Promise<DescendantBudgetReservation>;
  reconcileModel(input: {
    reservationId: string;
    inputTokens: number;
    outputTokens: number;
  }): Promise<void>;
  reserveTool(input: {
    invocationKey: string;
    toolKind: string;
    shell: boolean;
    artifactBytes?: number;
    signal?: AbortSignal;
  }): Promise<DescendantBudgetReservation>;
  reconcileTool(input: { reservationId: string; artifactBytes?: number }): Promise<void>;
  markUnknown(reservationId: string): Promise<void>;
  markLocalProviderAdmissionDenied(reservationId: string): Promise<void>;
}

export class DescendantResourceAdmissionError extends Error {
  readonly reason: Exclude<RuntimeBudgetAdmissionReason, 'admitted'>;

  constructor(
    reason: Exclude<RuntimeBudgetAdmissionReason, 'admitted'>,
    message = `Sub-agent resource admission denied: ${reason}.`,
  ) {
    super(message);
    this.name = 'DescendantResourceAdmissionError';
    this.reason = reason;
  }
}

class DescendantAdmissionProjectionConflict extends Error {
  constructor() {
    super('Concurrent resource admission changed the ledger projection.');
    this.name = 'DescendantAdmissionProjectionConflict';
  }
}

interface PlannedInvocation {
  invocationId: string;
  toolCallId?: string;
  resourceKind: BudgetReservation['resourceKind'];
  requiredPermits: ConcurrencyWaiter['requiredPermits'] | readonly [];
  upperBound: ResourceUsage;
}

function workspacePath(state: RuntimeState, path: string): string | undefined {
  const root = resolve(state.session.workspace);
  const candidate = isAbsolute(path) ? resolve(path) : resolve(root, path);
  return candidate === root || candidate.startsWith(`${root}/`) ? candidate : undefined;
}

function artifactUpperBound(state: RuntimeState, toolCallId: string): number {
  const call = state.tools.calls[toolCallId];
  if (!call || state.resourceBudget.status !== 'active') return 0;
  if (state.resourceBudget.budget.durationOnlyChildRun === true && call.name !== 'task') return 0;
  const committed = committedResourceUsage(state.resourceBudget);
  const remaining = state.resourceBudget.budget.maxArtifactBytes - committed.counters.artifactBytes;
  if (call.name === 'task') {
    // Private delegated task input is not a workspace output artifact.
    return 0;
  }
  if (call.name === 'followup_task') {
    // The Tool writes no workspace Artifact. Its child turn has a separate
    // source-owned backup; charging the remaining bytes here would count them twice.
    return 0;
  }
  if (['send_message', 'interrupt_agent', 'task_cancel'].includes(call.name)) {
    // Agent control changes mailbox/task state, not a workspace Artifact.
    return 0;
  }
  if (!call.sideEffect) return 0;
  if (call.name === 'write_file') {
    const content =
      call.args && typeof call.args === 'object' && 'content' in call.args
        ? (call.args as { content?: unknown }).content
        : undefined;
    return typeof content === 'string' ? Buffer.byteLength(content) : remaining;
  }
  if (call.name === 'edit_file') {
    const args =
      call.args && typeof call.args === 'object'
        ? (call.args as { path?: unknown; old_string?: unknown; new_string?: unknown })
        : {};
    const path = typeof args.path === 'string' ? workspacePath(state, args.path) : undefined;
    try {
      const before = path ? readFileSync(path, 'utf8') : '';
      const oldText = typeof args.old_string === 'string' ? args.old_string : '';
      const newText = typeof args.new_string === 'string' ? args.new_string : '';
      return Buffer.byteLength(before) - Buffer.byteLength(oldText) + Buffer.byteLength(newText);
    } catch {
      return remaining;
    }
  }
  // An opaque side effect may write an Artifact even when no capacity is
  // left. A zero upper bound would incorrectly authorize that Tool.
  return Math.max(1, remaining);
}

function upperBoundForTool(state: RuntimeState, toolCallId: string): ResourceUsage {
  const usage = createZeroResourceUsage('versioned_upper_bound', 'runtime-effect-v1');
  usage.counters.toolInvocations = 1;
  // A Tool does not acquire a writer-count slot. A code Sub-agent acquires
  // its own allotment when its independent execution starts.
  usage.counters.artifactBytes = Math.max(0, artifactUpperBound(state, toolCallId));
  if (
    state.resourceBudget.status === 'active' &&
    state.resourceBudget.budget.durationOnlyChildRun === true &&
    state.tools.calls[toolCallId]?.name !== 'task'
  )
    usage.unboundedArtifactBytes = true;
  return usage;
}

function plannedInvocations(state: RuntimeState, effect: RuntimeEffect): PlannedInvocation[] {
  // Model-bearing effects reserve from the exact frozen Surface inside
  // ModelInvocationGateway. The runner must not create a second coarse
  // reservation before that Surface exists.
  if (
    effect.type === 'call_model' ||
    effect.type === 'compact_context' ||
    effect.type === 'run_auto_review'
  ) {
    return [];
  }
  if (effect.type === 'request_provider_action') {
    const usage = createZeroResourceUsage('versioned_upper_bound', 'runtime-effect-v1');
    usage.counters.toolInvocations = 1;
    return [
      {
        invocationId: `provider-recovery:${effect.interactionId}`,
        resourceKind: 'mcp',
        requiredPermits: [],
        upperBound: usage,
      },
    ];
  }
  if (
    effect.type === 'run_verification' ||
    effect.type === 'repair_verification' ||
    effect.type === 'run_verification_compensation'
  ) {
    const usage = createZeroResourceUsage('versioned_upper_bound', 'runtime-effect-v1');
    usage.counters.toolInvocations = 1;
    return [
      {
        invocationId: `verification:${effect.verificationId}:${effect.type}`,
        resourceKind: 'verification',
        requiredPermits: [],
        upperBound: usage,
      },
    ];
  }
  if (effect.type !== 'run_tools') return [];
  return effect.toolCallIds.flatMap((toolCallId) => {
    const call = state.tools.calls[toolCallId];
    // A concurrently suspended sibling is requeued only so the Runtime can
    // present its already-created approval interaction. No Sub-agent or tool
    // dispatch occurs, so this effect must not consume another reservation.
    if (call?.name === 'task' && call.status === 'queued' && state.suspendedSubagents[toolCallId]) {
      return [];
    }
    const resourceKind =
      call?.name === 'task'
        ? ('subagent' as const)
        : call?.name === 'activate_skill' ||
            call?.name === 'read_skill_reference' ||
            call?.name === 'complete_skill'
          ? ('skill' as const)
          : call?.name.startsWith('mcp__')
            ? ('mcp' as const)
            : ('tool' as const);
    const taskInvocationPrefix = `tool:${toolCallId}`;
    const approvedPending = [...state.pendingApprovals.values()].find(
      (pending) =>
        pending.toolCallId === toolCallId &&
        pending.status === 'authorized_queued' &&
        pending.dispatchState === 'before_dispatch' &&
        pending.receiptId !== undefined,
    );
    const preApprovalReservation =
      state.resourceBudget.status === 'active'
        ? Object.values(state.resourceBudget.reservations).find(
            (reservation) =>
              reservation.invocationId === taskInvocationPrefix &&
              reservation.state === 'reconciled',
          )
        : undefined;
    const completedTaskAttempts =
      call?.name === 'task' &&
      state.suspendedSubagents[toolCallId] &&
      state.resourceBudget.status === 'active'
        ? Object.values(state.resourceBudget.reservations).filter(
            (reservation) =>
              reservation.resourceKind === 'subagent' &&
              reservation.state === 'reconciled' &&
              (reservation.invocationId === taskInvocationPrefix ||
                reservation.invocationId.startsWith(`${taskInvocationPrefix}:resume:`)),
          ).length
        : 0;
    return [
      {
        invocationId:
          completedTaskAttempts > 0
            ? `${taskInvocationPrefix}:resume:${completedTaskAttempts}`
            : approvedPending && preApprovalReservation
              ? `${taskInvocationPrefix}:approval:${approvedPending.receiptId}`
              : taskInvocationPrefix,
        toolCallId,
        resourceKind,
        requiredPermits:
          state.resourceBudget.status === 'active' &&
          state.resourceBudget.budget.durationOnlyChildRun === true
            ? []
            : call?.sideEffect &&
                ![
                  'task',
                  'followup_task',
                  'send_message',
                  'interrupt_agent',
                  'task_cancel',
                ].includes(call.name)
              ? ['artifact_capacity']
              : [],
        upperBound: upperBoundForTool(state, toolCallId),
      },
    ];
  });
}

function activeBudget(state: RuntimeState): ActiveResourceBudgetRuntimeState | undefined {
  return state.resourceBudget.status === 'active' ? state.resourceBudget : undefined;
}

/**
 * Create a durable child-admission handle for one dispatched Sub-agent
 * reservation. Every child model/tool invocation receives its own linked
 * reservation and is persisted before dispatch through `persistEvent`.
 */
export function createDescendantResourceAdmission(input: {
  state: RuntimeState;
  parentReservationId: string;
  getState?(): Readonly<RuntimeState>;
  persistEvent(event: RuntimeEvent): Promise<boolean>;
  persistEvents(events: RuntimeEvent[]): Promise<boolean>;
  persistLateResourceReconciliation?(
    event: Extract<RuntimeEvent, { type: 'resource_budget.reconciled' }>,
  ): Promise<boolean>;
  signal?: AbortSignal;
  now?(): Date;
}): DescendantResourceAdmission {
  const parentBudget = fundingBudgetForReservation(input.state, input.parentReservationId);
  if (!parentBudget) {
    throw new DescendantResourceAdmissionError(
      'budget_unconfigured',
      'Shared resource budget is unavailable.',
    );
  }
  const parent = parentBudget.reservations[input.parentReservationId];
  if (parent?.resourceKind !== 'subagent' || parent.state !== 'dispatch_started') {
    throw new DescendantResourceAdmissionError(
      'reconciliation_required',
      'Sub-agent parent reservation is not dispatch-started.',
    );
  }
  let projected = parentBudget;
  let mutationTail = Promise.resolve();
  let projectionRevision = 0;
  const projectionListeners = new Set<() => void>();

  const notifyProjectionChange = () => {
    projectionRevision += 1;
    for (const listener of projectionListeners) listener();
    projectionListeners.clear();
  };

  const refreshProjected = (): ActiveResourceBudgetRuntimeState => {
    const latestState = input.getState?.();
    const latest = latestState ? fundingBudgetForRun(latestState, projected.runId) : undefined;
    if (latestState && !latest)
      throw new DescendantResourceAdmissionError(
        'reconciliation_required',
        'Funding Run is no longer retained.',
      );
    if (latest) projected = latest;
    if (projected.status !== 'active') {
      throw new DescendantResourceAdmissionError(
        'budget_unconfigured',
        'Shared resource budget became inactive.',
      );
    }
    return projected;
  };

  const withMutation = <T>(mutate: () => Promise<T>): Promise<T> => {
    const result = mutationTail.then(mutate, mutate);
    mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const persist = async (event: RuntimeEvent): Promise<void> => {
    refreshProjected();
    let next: ResourceBudgetRuntimeState;
    try {
      next = reduceResourceBudgetState(projected, event as never);
    } catch (error) {
      throw new DescendantResourceAdmissionError(
        'budget_exhausted',
        error instanceof Error ? error.message : String(error),
      );
    }
    const revisionBeforePersist = input.getState?.().revision;
    let applied: boolean;
    try {
      applied = await input.persistEvent(event);
    } catch (error) {
      if (revisionBeforePersist != null && input.getState?.().revision !== revisionBeforePersist) {
        throw new DescendantAdmissionProjectionConflict();
      }
      throw new DescendantResourceAdmissionError(
        'persistence_unavailable',
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!applied) {
      throw new DescendantResourceAdmissionError(
        'reconciliation_required',
        'Sub-agent resource reservation lost its active Runtime lease.',
      );
    }
    if (next.status !== 'active') {
      throw new DescendantResourceAdmissionError(
        'budget_unconfigured',
        'Shared resource budget became inactive.',
      );
    }
    projected = next;
    notifyProjectionChange();
  };

  const persistBatch = async (events: RuntimeEvent[]): Promise<void> => {
    if (events.length === 0) return;
    refreshProjected();
    let next: ResourceBudgetRuntimeState = projected;
    try {
      for (const event of events) next = reduceResourceBudgetState(next, event as never);
    } catch (error) {
      throw new DescendantResourceAdmissionError(
        'budget_exhausted',
        error instanceof Error ? error.message : String(error),
      );
    }
    const revisionBeforePersist = input.getState?.().revision;
    let applied: boolean;
    try {
      applied = await input.persistEvents(events);
    } catch (error) {
      if (revisionBeforePersist != null && input.getState?.().revision !== revisionBeforePersist) {
        throw new DescendantAdmissionProjectionConflict();
      }
      throw new DescendantResourceAdmissionError(
        'persistence_unavailable',
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!applied) {
      throw new DescendantResourceAdmissionError(
        'reconciliation_required',
        'Sub-agent resource transaction lost its active Runtime lease.',
      );
    }
    if (next.status !== 'active') {
      throw new DescendantResourceAdmissionError(
        'budget_unconfigured',
        'Shared resource budget became inactive.',
      );
    }
    projected = next;
    notifyProjectionChange();
  };

  const assertParentStillOwned = (budget: ActiveResourceBudgetRuntimeState): void => {
    if (Object.values(budget.reservations).some((reservation) => reservation.state === 'unknown')) {
      throw new DescendantResourceAdmissionError(
        'reconciliation_required',
        'Sub-agent resource ledger contains an unknown reservation.',
      );
    }
    const currentParent = budget.reservations[parent.reservationId];
    if (
      currentParent?.resourceKind !== 'subagent' ||
      (currentParent.state !== 'dispatch_started' && currentParent.state !== 'reconciled')
    ) {
      throw new DescendantResourceAdmissionError(
        'reconciliation_required',
        'Sub-agent parent reservation is no longer owned by this Run.',
      );
    }
  };

  const now = (): Date => input.now?.() ?? new Date();

  const assertBeforeRunDeadline = (
    budget: ActiveResourceBudgetRuntimeState,
    observedAt: Date,
  ): void => {
    if (observedAt.getTime() < Date.parse(budget.deadlineAt)) return;
    throw new DescendantResourceAdmissionError(
      'budget_exhausted',
      'The shared run deadline elapsed before descendant dispatch.',
    );
  };

  const descendantInvocationId = (invocationKey: string): string =>
    `descendant:${parent.invocationId}:${invocationKey}`;

  const reserveDirect = async (
    invocationKey: string,
    resourceKind: BudgetReservation['resourceKind'],
    upperBound: ResourceUsage,
  ): Promise<DescendantBudgetReservation> => {
    while (true) {
      try {
        return await withMutation(async () => {
          const budget = refreshProjected();
          // Background task dispatch settles the parent Tool reservation as soon as
          // ownership transfers to the background runtime. The admission object was
          // created while that reservation was dispatch-started, so its descendants
          // may continue against the same durable parent until it is explicitly released.
          assertParentStillOwned(budget);
          assertBeforeRunDeadline(budget, now());
          const reservation: BudgetReservation = {
            version: 1,
            reservationId: crypto.randomUUID(),
            runId: budget.runId,
            invocationId: descendantInvocationId(invocationKey),
            parentReservationId: parent.reservationId,
            resourceKind,
            executableUpperBound: upperBound,
            state: 'reserved',
          };
          await persist({ type: 'resource_budget.reserved', reservation });
          await persist({
            type: 'resource_budget.dispatch_started',
            reservationId: reservation.reservationId,
          });
          return {
            reservationId: reservation.reservationId,
            ...(upperBound.counters.outputTokens > 0
              ? { maxOutputTokens: upperBound.counters.outputTokens }
              : {}),
          };
        });
      } catch (error) {
        if (error instanceof DescendantAdmissionProjectionConflict) continue;
        throw error;
      }
    }
  };

  const waitForProjectionChange = async (
    deadlineAt: string,
    signal: AbortSignal | undefined,
  ): Promise<'changed' | 'timed_out' | 'aborted'> => {
    if (signal?.aborted) return 'aborted';
    const remainingMs = Date.parse(deadlineAt) - Date.now();
    if (remainingMs <= 0) return 'timed_out';
    const observedRevision = projectionRevision;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: 'changed' | 'timed_out' | 'aborted') => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        projectionListeners.delete(onProjectionChange);
        signal?.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const onProjectionChange = () => finish('changed');
      const onAbort = () => finish('aborted');
      projectionListeners.add(onProjectionChange);
      const timer = setTimeout(
        () => finish(Date.now() >= Date.parse(deadlineAt) ? 'timed_out' : 'changed'),
        Math.min(25, remainingMs),
      );
      signal?.addEventListener('abort', onAbort, { once: true });
      if (projectionRevision !== observedRevision) finish('changed');
    });
  };

  const reconcile = async (reservationId: string, actual: ResourceUsage): Promise<void> => {
    await withMutation(async () => {
      refreshProjected();
      const event = { type: 'resource_budget.reconciled', reservationId, actual } as const;
      let next: ResourceBudgetRuntimeState;
      try {
        next = reduceResourceBudgetState(projected, event);
      } catch (error) {
        throw new DescendantResourceAdmissionError(
          'reconciliation_required',
          error instanceof Error ? error.message : String(error),
        );
      }
      let applied = false;
      const revisionBeforePersist = input.getState?.().revision;
      try {
        applied = await input.persistEvent(event);
      } catch (error) {
        const projectionChanged =
          revisionBeforePersist != null && input.getState?.().revision !== revisionBeforePersist;
        if (!projectionChanged) {
          throw new DescendantResourceAdmissionError(
            'persistence_unavailable',
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      if (!applied && input.persistLateResourceReconciliation) {
        try {
          applied = await input.persistLateResourceReconciliation(event);
        } catch (error) {
          throw new DescendantResourceAdmissionError(
            'persistence_unavailable',
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      if (!applied) {
        throw new DescendantResourceAdmissionError(
          'reconciliation_required',
          'Sub-agent resource reconciliation could not be persisted.',
        );
      }
      const latestState = input.getState?.();
      const latest = latestState ? fundingBudgetForRun(latestState, projected.runId) : undefined;
      if (latestState && !latest)
        throw new DescendantResourceAdmissionError(
          'reconciliation_required',
          'Funding Run is no longer retained.',
        );
      if (next.status !== 'active') {
        throw new DescendantResourceAdmissionError(
          'reconciliation_required',
          'Sub-agent resource reconciliation produced an inactive ledger.',
        );
      }
      projected = latest ?? next;
      notifyProjectionChange();
    });
  };

  const cancelWaiter = async (invocationId: string): Promise<void> => {
    await withMutation(async () => {
      const budget = refreshProjected();
      if (budget.waiters[invocationId]?.state !== 'waiting') return;
      await persist({ type: 'resource_budget.waiter_cancelled', invocationId });
    });
  };

  const persistWithProjectionRetry = async (event: RuntimeEvent): Promise<void> => {
    while (true) {
      try {
        await withMutation(() => persist(event));
        return;
      } catch (error) {
        if (error instanceof DescendantAdmissionProjectionConflict) continue;
        throw error;
      }
    }
  };

  const reserveToolWithFifo = async (
    invocation: PlannedInvocation,
    signal: AbortSignal | undefined,
  ): Promise<DescendantBudgetReservation> => {
    while (true) {
      const attempt = await withMutation(async () => {
        const budget = refreshProjected();
        assertParentStillOwned(budget);
        const unresolved = Object.values(budget.reservations).find(
          (reservation) =>
            reservation.invocationId === invocation.invocationId && reservation.state === 'unknown',
        );
        if (unresolved) {
          throw new DescendantResourceAdmissionError('reconciliation_required');
        }
        const attemptTime = now();
        const storedWaiter = budget.waiters[invocation.invocationId];
        const existingWaiter = storedWaiter?.state === 'waiting' ? storedWaiter : undefined;
        if (existingWaiter && invocation.requiredPermits.length === 0) {
          await persist({
            type: 'resource_budget.waiter_cancelled',
            invocationId: invocation.invocationId,
          });
          return { status: 'retry' as const };
        }
        if (existingWaiter && Date.parse(existingWaiter.deadlineAt) <= attemptTime.getTime()) {
          await persist({
            type: 'resource_budget.waiter_timed_out',
            invocationId: invocation.invocationId,
          });
          throw new DescendantResourceAdmissionError(saturationReason(invocation));
        }
        assertBeforeRunDeadline(budget, attemptTime);
        const reservation = reservationFor(budget, invocation, parent.reservationId);
        let candidate: ActiveResourceBudgetRuntimeState = budget;
        const preparationEvents: RuntimeEvent[] = [];
        if (existingWaiter && isQueueHead(budget, invocation)) {
          const promoted = {
            type: 'resource_budget.waiter_promoted',
            invocationId: invocation.invocationId,
          } as const;
          candidate = reduceResourceBudgetState(
            candidate,
            promoted,
          ) as ActiveResourceBudgetRuntimeState;
          preparationEvents.push(promoted);
        } else if (!isQueueHead(budget, invocation)) {
          const waiter = existingWaiter ?? waiterFor(budget, invocation, attemptTime);
          if (!existingWaiter) {
            await persist({ type: 'resource_budget.waiter_enqueued', waiter });
          }
          return { status: 'waiting' as const, deadlineAt: waiter.deadlineAt };
        }
        try {
          candidate = reduceResourceBudgetState(candidate, {
            type: 'resource_budget.reserved',
            reservation,
          }) as ActiveResourceBudgetRuntimeState;
        } catch {
          if (!canFitWithoutConcurrency(budget, reservation)) {
            throw new DescendantResourceAdmissionError('budget_exhausted');
          }
          if (invocation.requiredPermits.length === 0)
            throw new DescendantResourceAdmissionError('budget_exhausted');
          const waiter = existingWaiter ?? waiterFor(budget, invocation, attemptTime);
          if (!existingWaiter) {
            await persist({ type: 'resource_budget.waiter_enqueued', waiter });
          }
          return { status: 'waiting' as const, deadlineAt: waiter.deadlineAt };
        }
        preparationEvents.push({ type: 'resource_budget.reserved', reservation });
        await persistBatch(preparationEvents);
        await persist({
          type: 'resource_budget.dispatch_started',
          reservationId: reservation.reservationId,
        });
        return {
          status: 'reserved' as const,
          reservation: { reservationId: reservation.reservationId },
        };
      }).catch((error: unknown) => {
        if (error instanceof DescendantAdmissionProjectionConflict) {
          return { status: 'retry' as const };
        }
        throw error;
      });
      if (attempt.status === 'retry') continue;
      if (attempt.status === 'reserved') return attempt.reservation;
      const waited = await waitForProjectionChange(attempt.deadlineAt, signal);
      if (waited !== 'aborted') continue;
      try {
        await cancelWaiter(invocation.invocationId);
      } catch {
        // The outer cancellation transaction owns cleanup if the effect lease is already stale.
      }
      const abortError = new Error('Sub-agent resource wait was cancelled.');
      abortError.name = 'AbortError';
      throw abortError;
    }
  };

  return {
    async reserveModel(request) {
      const budget = refreshProjected();
      const committed = committedResourceUsage(budget);
      const remainingOutput =
        budget.budget.durationOnlyChildRun === true
          ? Number.MAX_SAFE_INTEGER
          : budget.budget.maxRunOutputTokens - committed.counters.outputTokens;
      const outputTokens =
        budget.budget.durationOnlyChildRun === true
          ? request.requestedMaxOutputTokens
          : Math.min(request.requestedMaxOutputTokens ?? remainingOutput, remainingOutput);
      if (outputTokens !== undefined && outputTokens <= 0) {
        throw new DescendantResourceAdmissionError(
          'budget_exhausted',
          'Sub-agent model output budget is exhausted.',
        );
      }
      const usage = createZeroResourceUsage('versioned_upper_bound', 'descendant-runtime-v1');
      usage.counters.modelRequests = 1;
      if (budget.budget.durationOnlyChildRun === true) {
        usage.unboundedModelTokens = true;
      } else {
        usage.counters.inputTokens = request.inputTokens;
        usage.counters.outputTokens = outputTokens!;
      }
      return reserveDirect(request.invocationKey, 'model', usage);
    },
    async reconcileModel(request) {
      const usage = createZeroResourceUsage();
      usage.counters.modelRequests = 1;
      usage.counters.inputTokens = request.inputTokens;
      usage.counters.outputTokens = request.outputTokens;
      await reconcile(request.reservationId, usage);
    },
    async reserveTool(request) {
      const budget = refreshProjected();
      const usage = createZeroResourceUsage('versioned_upper_bound', 'descendant-runtime-v1');
      usage.counters.toolInvocations = 1;
      if (budget.budget.durationOnlyChildRun === true) {
        usage.unboundedArtifactBytes = true;
      } else {
        const committed = committedResourceUsage(budget);
        const remainingArtifactBytes =
          budget.budget.maxArtifactBytes - committed.counters.artifactBytes;
        usage.counters.artifactBytes =
          request.artifactBytes ??
          (request.toolKind === 'write_file' || request.toolKind === 'edit_file'
            ? remainingArtifactBytes
            : 0);
      }
      return reserveToolWithFifo(
        {
          invocationId: descendantInvocationId(request.invocationKey),
          resourceKind: request.toolKind.startsWith('mcp__') ? 'mcp' : 'tool',
          requiredPermits: [],
          upperBound: usage,
        },
        request.signal ?? input.signal,
      );
    },
    async reconcileTool(request) {
      const usage = createZeroResourceUsage();
      usage.counters.toolInvocations = 1;
      usage.counters.artifactBytes = request.artifactBytes ?? 0;
      await reconcile(request.reservationId, usage);
    },
    async markUnknown(reservationId) {
      await persistWithProjectionRetry({ type: 'resource_budget.unknown', reservationId });
    },
    async markLocalProviderAdmissionDenied(reservationId) {
      await persistWithProjectionRetry({
        type: 'resource_budget.released',
        reservationId,
        proof: 'local_pre_dispatch_failure',
      });
    },
  };
}

function waitingInFifoOrder(budget: ActiveResourceBudgetRuntimeState): ConcurrencyWaiter[] {
  return Object.values(budget.waiters ?? {})
    .filter((waiter) => waiter.state === 'waiting')
    .sort((left, right) => left.sequence - right.sequence);
}

function isQueueHead(
  budget: ActiveResourceBudgetRuntimeState,
  invocation: PlannedInvocation,
): boolean {
  if (invocation.requiredPermits.length === 0) return true;
  const waiting = waitingInFifoOrder(budget);
  const own = budget.waiters?.[invocation.invocationId];
  // A restored legacy waiter keeps its FIFO position until the planner
  // replaces its permit type before admission.
  const permits = own?.state === 'waiting' ? own.requiredPermits : invocation.requiredPermits;
  if (permits[0] === 'artifact_capacity') {
    const artifactHead = waiting.find(
      (waiter) => waiter.requiredPermits[0] === 'artifact_capacity',
    );
    return artifactHead === undefined || artifactHead.invocationId === invocation.invocationId;
  }
  if (permits[0] === 'writer') {
    const writerHead = waiting.find((waiter) => waiter.requiredPermits[0] === 'writer');
    return writerHead === undefined || writerHead.invocationId === invocation.invocationId;
  }
  const legacyWaiting = waiting.filter((waiter) => waiter.requiredPermits[0] === 'tool');
  if (!own) return legacyWaiting.length === 0;
  const toolHead = legacyWaiting[0]?.invocationId === own.invocationId;
  const shellHead =
    permits.length < 2 ||
    legacyWaiting.find((waiter) => waiter.requiredPermits.length === 2)?.invocationId ===
      own.invocationId;
  return toolHead && shellHead;
}

function reservationFor(
  budget: ActiveResourceBudgetRuntimeState,
  invocation: PlannedInvocation,
  parentReservationId?: string,
): BudgetReservation {
  return {
    version: 1,
    reservationId: crypto.randomUUID(),
    runId: budget.runId,
    invocationId: invocation.invocationId,
    ...(parentReservationId ? { parentReservationId } : {}),
    resourceKind: invocation.resourceKind,
    executableUpperBound: invocation.upperBound,
    state: 'reserved',
  };
}

function canFitWithoutConcurrency(
  budget: ActiveResourceBudgetRuntimeState,
  reservation: BudgetReservation,
): boolean {
  const withoutConcurrency: BudgetReservation = {
    ...reservation,
    executableUpperBound: {
      ...reservation.executableUpperBound,
      gauges: {
        ...reservation.executableUpperBound.gauges,
        activeSubagents: 0,
        activeWriters: 0,
        activeToolInvocations: 0,
        activeShellInvocations: 0,
      },
    },
  };
  try {
    reduceResourceBudgetState(budget, {
      type: 'resource_budget.reserved',
      reservation: withoutConcurrency,
    });
    return true;
  } catch {
    return false;
  }
}

function canFitAfterInFlightArtifacts(
  budget: ActiveResourceBudgetRuntimeState,
  reservation: BudgetReservation,
): boolean {
  const reservations = Object.fromEntries(
    Object.entries(budget.reservations).map(([id, pending]) => {
      if (
        (pending.state !== 'reserved' && pending.state !== 'dispatch_started') ||
        pending.executableUpperBound.counters.artifactBytes === 0
      )
        return [id, pending];
      return [
        id,
        {
          ...pending,
          executableUpperBound: {
            ...pending.executableUpperBound,
            counters: { ...pending.executableUpperBound.counters, artifactBytes: 0 },
          },
        },
      ];
    }),
  ) as ActiveResourceBudgetRuntimeState['reservations'];
  // This is only a feasibility projection. The durable upper bounds stay in
  // place until their actual use is known; a waiting Tool is rechecked then.
  return canFitWithoutConcurrency({ ...budget, reservations }, reservation);
}

function saturationReason(
  invocation: PlannedInvocation,
): Extract<
  RuntimeBudgetAdmissionReason,
  'budget_exhausted' | 'tool_concurrency_saturated' | 'shell_concurrency_saturated'
> {
  if (invocation.requiredPermits[0] === 'artifact_capacity') return 'budget_exhausted';
  return invocation.requiredPermits.length === 2
    ? 'shell_concurrency_saturated'
    : 'tool_concurrency_saturated';
}

function waiterFor(
  budget: ActiveResourceBudgetRuntimeState,
  invocation: PlannedInvocation,
  now: Date,
): ConcurrencyWaiter {
  const deadline = Math.min(
    now.getTime() + budget.budget.maxConcurrencyWaitMs,
    Date.parse(budget.deadlineAt),
  );
  return {
    version: 1,
    runId: budget.runId,
    invocationId: invocation.invocationId,
    requiredPermits: invocation.requiredPermits as ConcurrencyWaiter['requiredPermits'],
    sequence: budget.nextWaiterSequence ?? 0,
    enqueuedAt: now.toISOString(),
    deadlineAt: new Date(deadline).toISOString(),
    state: 'waiting',
  };
}

/**
 * Plan an atomic admission transaction. The caller persists preparationEvents
 * together, then persists dispatchEvents before invoking any external code.
 */
export function planRuntimeBudgetAdmission(
  state: RuntimeState,
  effect: RuntimeEffect,
  now = new Date(),
): RuntimeBudgetAdmissionPlan {
  const invocations = plannedInvocations(state, effect);
  if (invocations.length === 0) {
    return {
      status: 'not_required',
      reason: 'admitted',
      effect,
      preparationEvents: [],
      dispatchEvents: [],
      reservationIds: [],
    };
  }
  const initial = activeBudget(state);
  if (!initial) {
    return {
      status: 'denied',
      reason: 'budget_unconfigured',
      effect,
      preparationEvents: [],
      dispatchEvents: [],
      reservationIds: [],
    };
  }

  let projected: ResourceBudgetRuntimeState = initial;
  const preparationEvents: RuntimeEvent[] = [];
  const dispatchEvents: RuntimeEvent[] = [];
  const reservationIds: string[] = [];
  const admittedToolCallIds: string[] = [];
  let blocked:
    | {
        reason: RuntimeBudgetAdmissionPlan['reason'];
        deadlineAt?: string;
        toolCallId?: string;
        waiterInvocationId?: string;
      }
    | undefined;

  for (const invocation of invocations) {
    if (projected.status !== 'active') throw new Error('Budget projection became inactive.');
    const previous = Object.values(projected.reservations).find(
      (reservation) =>
        reservation.invocationId === invocation.invocationId && reservation.state !== 'released',
    );
    if (previous?.state === 'reserved' && previous.resourceKind === invocation.resourceKind) {
      if (Date.parse(projected.deadlineAt) <= now.getTime()) {
        blocked = { reason: 'budget_exhausted' };
        break;
      }
      // Reservation preparation was durable, but dispatch was not. Resume
      // with the same upper bound and identity instead of creating another.
      dispatchEvents.push({
        type: 'resource_budget.dispatch_started',
        reservationId: previous.reservationId,
      });
      reservationIds.push(previous.reservationId);
      if (effect.type === 'run_tools' && invocation.toolCallId)
        admittedToolCallIds.push(invocation.toolCallId);
      continue;
    }
    if (previous) {
      // dispatch_started may already have caused an external effect. Neither
      // replay nor a local Tool failure is safe until recovery confirms it.
      blocked = { reason: 'reconciliation_required' };
      break;
    }
    const storedWaiter = projected.waiters?.[invocation.invocationId];
    let existingWaiter = storedWaiter?.state === 'waiting' ? storedWaiter : undefined;
    if (
      existingWaiter &&
      (invocation.requiredPermits.length === 0 ||
        existingWaiter.requiredPermits[0] !== invocation.requiredPermits[0])
    ) {
      const cancelled = {
        type: 'resource_budget.waiter_cancelled',
        invocationId: invocation.invocationId,
      } as const;
      preparationEvents.push(cancelled);
      projected = reduceResourceBudgetState(
        projected,
        cancelled,
      ) as ActiveResourceBudgetRuntimeState;
      existingWaiter = undefined;
    }
    if (existingWaiter && Date.parse(existingWaiter.deadlineAt) <= now.getTime()) {
      const timedOutEvent = {
        type: 'resource_budget.waiter_timed_out',
        invocationId: invocation.invocationId,
      } as const;
      // Discard any earlier speculative reservations in this plan. The
      // Service first settles this exact undispatched Tool, then replans the
      // remaining queue against the fresh ledger.
      return {
        status: 'waiting',
        reason: saturationReason(invocation),
        effect,
        preparationEvents: [timedOutEvent],
        dispatchEvents: [],
        reservationIds: [],
        ...(invocation.toolCallId ? { timedOutToolCallId: invocation.toolCallId } : {}),
      };
    }
    if (!isQueueHead(projected, invocation)) {
      const waiter = existingWaiter ?? waiterFor(projected, invocation, now);
      if (!existingWaiter) {
        const event: RuntimeEvent = { type: 'resource_budget.waiter_enqueued', waiter };
        preparationEvents.push(event);
        projected = reduceResourceBudgetState(projected, event);
      }
      blocked = { reason: saturationReason(invocation), deadlineAt: waiter.deadlineAt };
      break;
    }

    const reservation = reservationFor(projected, invocation);
    const reserveEvent: RuntimeEvent = { type: 'resource_budget.reserved', reservation };
    try {
      let candidate: ActiveResourceBudgetRuntimeState = projected;
      let promote: RuntimeEvent | undefined;
      if (existingWaiter) {
        promote = {
          type: 'resource_budget.waiter_promoted',
          invocationId: invocation.invocationId,
        };
        candidate = reduceResourceBudgetState(
          candidate,
          promote as Extract<RuntimeEvent, { type: 'resource_budget.waiter_promoted' }>,
        ) as ActiveResourceBudgetRuntimeState;
      }
      candidate = reduceResourceBudgetState(
        candidate,
        reserveEvent as Extract<RuntimeEvent, { type: 'resource_budget.reserved' }>,
      ) as ActiveResourceBudgetRuntimeState;
      if (promote) preparationEvents.push(promote);
      preparationEvents.push(reserveEvent);
      projected = candidate;
      dispatchEvents.push({
        type: 'resource_budget.dispatch_started',
        reservationId: reservation.reservationId,
      });
      reservationIds.push(reservation.reservationId);
      if (effect.type === 'run_tools') {
        if (!invocation.toolCallId) {
          throw new Error('Tool admission is missing its durable toolCallId.');
        }
        admittedToolCallIds.push(invocation.toolCallId);
      }
    } catch {
      const activeProjected = projected;
      if (
        !canFitWithoutConcurrency(activeProjected, reservation) &&
        !(
          invocation.requiredPermits[0] === 'artifact_capacity' &&
          canFitAfterInFlightArtifacts(activeProjected, reservation)
        )
      ) {
        blocked = {
          reason: 'budget_exhausted',
          toolCallId: invocation.toolCallId,
          ...(existingWaiter ? { waiterInvocationId: invocation.invocationId } : {}),
        };
        break;
      }
      if (invocation.requiredPermits.length === 0) {
        blocked = {
          reason: 'budget_exhausted',
          toolCallId: invocation.toolCallId,
          ...(existingWaiter ? { waiterInvocationId: invocation.invocationId } : {}),
        };
        break;
      }
      const waiter = existingWaiter ?? waiterFor(activeProjected, invocation, now);
      if (!existingWaiter) {
        const enqueue: RuntimeEvent = { type: 'resource_budget.waiter_enqueued', waiter };
        preparationEvents.push(enqueue);
        projected = reduceResourceBudgetState(activeProjected, enqueue);
      }
      blocked = { reason: saturationReason(invocation), deadlineAt: waiter.deadlineAt };
      break;
    }
  }

  if (blocked?.reason === 'budget_exhausted' && effect.type === 'run_tools' && blocked.toolCallId) {
    // The requested Tool never dispatched. Keep the hard budget gate, but
    // return its denial to the model as that Tool's result instead of ending
    // an otherwise funded Agent Run. Replan other Tools afterward.
    return {
      status: 'denied',
      reason: 'budget_exhausted',
      effect,
      preparationEvents: blocked.waiterInvocationId
        ? [{ type: 'resource_budget.waiter_cancelled', invocationId: blocked.waiterInvocationId }]
        : [],
      dispatchEvents: [],
      reservationIds: [],
      budgetDeniedToolCallId: blocked.toolCallId,
    };
  }

  if (blocked?.deadlineAt && effect.type === 'run_tools' && projected.status === 'active') {
    let queueState: ActiveResourceBudgetRuntimeState = projected;
    for (const invocation of invocations) {
      if (
        (invocation.toolCallId && admittedToolCallIds.includes(invocation.toolCallId)) ||
        invocation.requiredPermits.length === 0 ||
        queueState.waiters?.[invocation.invocationId]
      ) {
        continue;
      }
      const waiter = waiterFor(queueState, invocation, now);
      const enqueue: RuntimeEvent = { type: 'resource_budget.waiter_enqueued', waiter };
      preparationEvents.push(enqueue);
      queueState = reduceResourceBudgetState(
        queueState,
        enqueue,
      ) as ActiveResourceBudgetRuntimeState;
    }
    projected = queueState;
  }

  if (reservationIds.length > 0) {
    return {
      status: 'admitted',
      reason: 'admitted',
      effect:
        effect.type === 'run_tools' ? { ...effect, toolCallIds: admittedToolCallIds } : effect,
      preparationEvents,
      dispatchEvents,
      reservationIds,
      ...(blocked?.deadlineAt ? { waitDeadlineAt: blocked.deadlineAt } : {}),
    };
  }
  return {
    status:
      !blocked?.deadlineAt &&
      (blocked?.reason === 'budget_exhausted' || blocked?.reason === 'reconciliation_required')
        ? 'denied'
        : 'waiting',
    reason: blocked?.reason ?? 'budget_exhausted',
    effect,
    preparationEvents,
    dispatchEvents: [],
    reservationIds: [],
    ...(blocked?.deadlineAt ? { waitDeadlineAt: blocked.deadlineAt } : {}),
  };
}

export function actualUsageForReservation(
  state: RuntimeState,
  reservation: BudgetReservation,
  terminalEvents: RuntimeEvent[] = [],
): ResourceUsage {
  const usage = createZeroResourceUsage();
  usage.counters.modelRequests =
    reservation.resourceKind === 'model' ||
    reservation.resourceKind === 'compaction' ||
    reservation.invocationId.startsWith('auto-review:')
      ? 1
      : 0;
  usage.counters.toolInvocations =
    !reservation.invocationId.startsWith('auto-review:') &&
    ['tool', 'mcp', 'skill', 'subagent', 'verification'].includes(reservation.resourceKind)
      ? 1
      : 0;
  usage.counters.turns = reservation.executableUpperBound.counters.turns;
  const modelResponse = terminalEvents.find(
    (event): event is Extract<RuntimeEvent, { type: 'model.responded' }> =>
      event.type === 'model.responded',
  );
  usage.counters.inputTokens =
    modelResponse?.inputTokens ?? reservation.executableUpperBound.counters.inputTokens;
  usage.counters.outputTokens =
    modelResponse?.outputTokens ?? reservation.executableUpperBound.counters.outputTokens;
  const approvalReceipt = [...state.approvalReceipts.values()].find(
    (receipt) =>
      reservation.invocationId === `tool:${receipt.toolCallId}:approval:${receipt.receiptId}`,
  );
  const toolCallId = approvalReceipt
    ? approvalReceipt.toolCallId
    : reservation.invocationId.startsWith('tool:')
      ? reservation.invocationId.slice('tool:'.length)
      : undefined;
  const awaitingPreDispatchApproval =
    toolCallId !== undefined &&
    (state.tools.calls[toolCallId]?.status === 'awaiting_approval' ||
      state.tools.calls[toolCallId]?.status === 'awaiting_auto_review') &&
    [...state.pendingApprovals.values()].some(
      (pending) =>
        pending.toolCallId === toolCallId &&
        ((pending.route === 'user' && pending.status === 'awaiting_user') ||
          (pending.route === 'auto' &&
            (pending.status === 'queued_auto' || pending.status === 'auto_reviewing'))) &&
        pending.receiptId === undefined &&
        (pending.dispatchState === undefined || pending.dispatchState === 'before_dispatch'),
    );
  if (awaitingPreDispatchApproval) usage.counters.toolInvocations = 0;
  const fileChanges = terminalEvents.filter(
    (event): event is Extract<RuntimeEvent, { type: 'tool.file_change' }> =>
      event.type === 'tool.file_change' && event.toolCallId === toolCallId,
  );
  if (fileChanges.length > 0) {
    const paths = new Set(fileChanges.map((event) => workspacePath(state, event.path)));
    usage.counters.artifactBytes = [...paths].reduce((total, path) => {
      if (!path) return total;
      try {
        return total + statSync(path).size;
      } catch {
        return total;
      }
    }, 0);
  } else if (
    !awaitingPreDispatchApproval &&
    reservation.executableUpperBound.counters.artifactBytes > 0
  ) {
    usage.counters.artifactBytes = reservation.executableUpperBound.counters.artifactBytes;
  }
  return usage;
}

export function reconciliationEventsForReservations(
  state: RuntimeState,
  reservationIds: string[],
  terminalEvents: RuntimeEvent[] = [],
): Array<Extract<RuntimeEvent, { type: 'resource_budget.reconciled' }>> {
  return reservationIds
    .filter(
      (reservationId) =>
        !terminalEvents.some(
          (event) =>
            event.type === 'resource_budget.released' &&
            event.reservationId === reservationId &&
            event.proof === 'local_pre_dispatch_failure',
        ),
    )
    .map((reservationId) => {
      const reservation = fundingBudgetForReservation(state, reservationId)?.reservations[
        reservationId
      ];
      if (!reservation)
        throw new Error(`Missing reservation ${reservationId} during reconciliation.`);
      return {
        type: 'resource_budget.reconciled' as const,
        reservationId,
        actual: actualUsageForReservation(state, reservation, terminalEvents),
      };
    })
    .filter((event) => {
      const reservation = fundingBudgetForReservation(state, event.reservationId)?.reservations[
        event.reservationId
      ];
      return reservation?.state === 'dispatch_started' || reservation?.state === 'unknown';
    });
}
