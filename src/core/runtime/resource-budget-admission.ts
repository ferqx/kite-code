import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { RuntimeEffect } from './effects';
import type { RuntimeEvent } from './events';
import {
  type ActiveResourceBudgetRuntimeStateV1,
  type BudgetReservationV1,
  type ConcurrencyWaiterV1,
  committedResourceUsageV1,
  createZeroResourceUsageV1,
  type ResourceBudgetRuntimeStateV1,
  type ResourceUsageV1,
  reduceResourceBudgetStateV1,
} from './resource-budget';
import type { RuntimeState } from './state';

export type RuntimeBudgetAdmissionReasonV1 =
  | 'admitted'
  | 'budget_unconfigured'
  | 'budget_exhausted'
  | 'reconciliation_required'
  | 'tool_concurrency_saturated'
  | 'shell_concurrency_saturated';

export interface RuntimeBudgetAdmissionPlanV1 {
  status: 'admitted' | 'waiting' | 'denied' | 'not_required';
  reason: RuntimeBudgetAdmissionReasonV1;
  effect: RuntimeEffect;
  preparationEvents: RuntimeEvent[];
  dispatchEvents: RuntimeEvent[];
  reservationIds: string[];
  waitDeadlineAt?: string;
}

export interface DescendantBudgetReservationV1 {
  reservationId: string;
  maxOutputTokens?: number;
}

export interface DescendantResourceAdmissionV1 {
  reserveModel(input: {
    invocationKey: string;
    inputTokens: number;
    requestedMaxOutputTokens?: number;
  }): Promise<DescendantBudgetReservationV1>;
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
  }): Promise<DescendantBudgetReservationV1>;
  reconcileTool(input: { reservationId: string; artifactBytes?: number }): Promise<void>;
  markUnknown(reservationId: string): Promise<void>;
  markLocalProviderAdmissionDenied(reservationId: string): Promise<void>;
}

export class DescendantResourceAdmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DescendantResourceAdmissionError';
  }
}

interface PlannedInvocation {
  invocationId: string;
  toolCallId?: string;
  resourceKind: BudgetReservationV1['resourceKind'];
  requiredPermits: readonly ('tool' | 'shell_invocation')[];
  upperBound: ResourceUsageV1;
}

function workspacePath(state: RuntimeState, path: string): string | undefined {
  const root = resolve(state.session.workspace);
  const candidate = isAbsolute(path) ? resolve(path) : resolve(root, path);
  return candidate === root || candidate.startsWith(`${root}/`) ? candidate : undefined;
}

function artifactUpperBound(state: RuntimeState, toolCallId: string): number {
  const call = state.tools.calls[toolCallId];
  if (!call?.sideEffect || state.resourceBudget.status !== 'active') return 0;
  const committed = committedResourceUsageV1(state.resourceBudget);
  const remaining = state.resourceBudget.budget.maxArtifactBytes - committed.counters.artifactBytes;
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
  return remaining;
}

function upperBoundForTool(state: RuntimeState, toolCallId: string): ResourceUsageV1 {
  const usage = createZeroResourceUsageV1('versioned_upper_bound', 'runtime-effect-v1');
  usage.counters.toolInvocations = 1;
  usage.gauges.activeToolInvocations = 1;
  const call = state.tools.calls[toolCallId];
  if (call?.name === 'shell_execute') usage.gauges.activeShellInvocations = 1;
  if (call?.sideEffect) usage.gauges.activeWriters = 1;
  if (call?.name === 'task') {
    // The parent owns only Sub-agent concurrency/lifecycle. Descendant model,
    // tool, shell and MCP invocations reserve independently in the shared
    // ledger so the parent cannot hide multiple calls behind one coarse cap.
    usage.gauges.activeToolInvocations = 0;
    usage.gauges.activeSubagents = 1;
  }
  usage.counters.artifactBytes = Math.max(0, artifactUpperBound(state, toolCallId));
  return usage;
}

function plannedInvocations(state: RuntimeState, effect: RuntimeEffect): PlannedInvocation[] {
  if (effect.type === 'call_model') {
    const usage = createZeroResourceUsageV1('versioned_upper_bound', 'runtime-effect-v1');
    usage.counters.modelRequests = 1;
    if (state.resourceBudget.status === 'active') {
      const committed = committedResourceUsageV1(state.resourceBudget);
      usage.counters.inputTokens =
        effect.resourceEstimate?.inputTokens ??
        state.resourceBudget.budget.maxRunInputTokens - committed.counters.inputTokens;
      usage.counters.outputTokens =
        effect.resourceEstimate?.maxOutputTokens ??
        state.resourceBudget.budget.maxRunOutputTokens - committed.counters.outputTokens;
      usage.counters.turns = Object.values(state.resourceBudget.reservations).some((reservation) =>
        reservation.invocationId.startsWith(`model:${state.turn.turnId}:`),
      )
        ? 0
        : 1;
    }
    return [
      {
        invocationId: `model:${state.turn.turnId}:${state.transcript.messages.length}`,
        resourceKind: 'model',
        requiredPermits: [],
        upperBound: usage,
      },
    ];
  }
  if (effect.type === 'compact_context') {
    const usage = createZeroResourceUsageV1('versioned_upper_bound', 'runtime-effect-v1');
    usage.counters.modelRequests = 1;
    if (state.resourceBudget.status === 'active') {
      const committed = committedResourceUsageV1(state.resourceBudget);
      usage.counters.inputTokens = Math.min(
        state.context.pendingCompaction?.estimate.totalInputTokens ?? 0,
        state.resourceBudget.budget.maxRunInputTokens - committed.counters.inputTokens,
      );
      usage.counters.outputTokens = Math.min(
        6_000,
        state.resourceBudget.budget.maxRunOutputTokens - committed.counters.outputTokens,
      );
    }
    return [
      {
        invocationId: `compaction:${effect.compactionId}`,
        resourceKind: 'compaction',
        requiredPermits: [],
        upperBound: usage,
      },
    ];
  }
  if (effect.type === 'run_auto_review') {
    const usage = createZeroResourceUsageV1('versioned_upper_bound', 'runtime-effect-v1');
    usage.counters.modelRequests = 1;
    if (state.resourceBudget.status === 'active') {
      const committed = committedResourceUsageV1(state.resourceBudget);
      usage.counters.inputTokens = Math.min(
        32_000,
        state.resourceBudget.budget.maxRunInputTokens - committed.counters.inputTokens,
      );
      usage.counters.outputTokens = Math.min(
        4_000,
        state.resourceBudget.budget.maxRunOutputTokens - committed.counters.outputTokens,
      );
    }
    return [
      {
        invocationId: `auto-review:${effect.reviewId}`,
        resourceKind: 'verification',
        requiredPermits: [],
        upperBound: usage,
      },
    ];
  }
  if (effect.type === 'request_provider_action') {
    const usage = createZeroResourceUsageV1('versioned_upper_bound', 'runtime-effect-v1');
    usage.counters.toolInvocations = 1;
    usage.gauges.activeToolInvocations = 1;
    return [
      {
        invocationId: `provider-recovery:${effect.interactionId}`,
        resourceKind: 'mcp',
        requiredPermits: ['tool'],
        upperBound: usage,
      },
    ];
  }
  if (
    effect.type === 'run_verification' ||
    effect.type === 'repair_verification' ||
    effect.type === 'run_verification_compensation'
  ) {
    const usage = createZeroResourceUsageV1('versioned_upper_bound', 'runtime-effect-v1');
    usage.counters.toolInvocations = 1;
    usage.gauges.activeToolInvocations = 1;
    return [
      {
        invocationId: `verification:${effect.verificationId}:${effect.type}`,
        resourceKind: 'verification',
        requiredPermits: ['tool'],
        upperBound: usage,
      },
    ];
  }
  if (effect.type !== 'run_tools') return [];
  return effect.toolCallIds.map((toolCallId) => {
    const call = state.tools.calls[toolCallId];
    const shell = call?.name === 'shell_execute';
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
    return {
      invocationId:
        completedTaskAttempts > 0
          ? `${taskInvocationPrefix}:resume:${completedTaskAttempts}`
          : taskInvocationPrefix,
      toolCallId,
      resourceKind,
      requiredPermits: shell ? (['tool', 'shell_invocation'] as const) : (['tool'] as const),
      upperBound: upperBoundForTool(state, toolCallId),
    };
  });
}

function activeBudget(state: RuntimeState): ActiveResourceBudgetRuntimeStateV1 | undefined {
  return state.resourceBudget.status === 'active' ? state.resourceBudget : undefined;
}

/**
 * Create a durable child-admission handle for one dispatched Sub-agent
 * reservation. Every child model/tool invocation receives its own linked
 * reservation and is persisted before dispatch through `persistEvent`.
 */
export function createDescendantResourceAdmissionV1(input: {
  state: RuntimeState;
  parentReservationId: string;
  persistEvent(event: RuntimeEvent): Promise<boolean>;
}): DescendantResourceAdmissionV1 {
  if (input.state.resourceBudget.status !== 'active') {
    throw new DescendantResourceAdmissionError('Shared resource budget is unavailable.');
  }
  const parent = input.state.resourceBudget.reservations[input.parentReservationId];
  if (parent?.resourceKind !== 'subagent' || parent.state !== 'dispatch_started') {
    throw new DescendantResourceAdmissionError(
      'Sub-agent parent reservation is not dispatch-started.',
    );
  }
  let projected = input.state.resourceBudget;

  const persist = async (event: RuntimeEvent): Promise<void> => {
    let next: ResourceBudgetRuntimeStateV1;
    try {
      next = reduceResourceBudgetStateV1(projected, event as never);
    } catch (error) {
      throw new DescendantResourceAdmissionError(
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!(await input.persistEvent(event))) {
      throw new DescendantResourceAdmissionError(
        'Sub-agent resource reservation lost its active Runtime lease.',
      );
    }
    if (next.status !== 'active') {
      throw new DescendantResourceAdmissionError('Shared resource budget became inactive.');
    }
    projected = next;
  };

  const reserve = async (
    invocationKey: string,
    resourceKind: BudgetReservationV1['resourceKind'],
    upperBound: ResourceUsageV1,
  ): Promise<DescendantBudgetReservationV1> => {
    const reservation: BudgetReservationV1 = {
      version: 1,
      reservationId: crypto.randomUUID(),
      runId: projected.runId,
      invocationId: `descendant:${parent.invocationId}:${invocationKey}`,
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
  };

  const reconcile = async (reservationId: string, actual: ResourceUsageV1): Promise<void> => {
    await persist({ type: 'resource_budget.reconciled', reservationId, actual });
  };

  return {
    async reserveModel(request) {
      const committed = committedResourceUsageV1(projected);
      const remainingOutput = projected.budget.maxRunOutputTokens - committed.counters.outputTokens;
      const outputTokens = Math.min(
        request.requestedMaxOutputTokens ?? remainingOutput,
        remainingOutput,
      );
      if (outputTokens <= 0) {
        throw new DescendantResourceAdmissionError('Sub-agent model output budget is exhausted.');
      }
      const usage = createZeroResourceUsageV1('versioned_upper_bound', 'descendant-runtime-v1');
      usage.counters.modelRequests = 1;
      usage.counters.inputTokens = request.inputTokens;
      usage.counters.outputTokens = outputTokens;
      return reserve(request.invocationKey, 'model', usage);
    },
    async reconcileModel(request) {
      const usage = createZeroResourceUsageV1();
      usage.counters.modelRequests = 1;
      usage.counters.inputTokens = request.inputTokens;
      usage.counters.outputTokens = request.outputTokens;
      await reconcile(request.reservationId, usage);
    },
    async reserveTool(request) {
      const usage = createZeroResourceUsageV1('versioned_upper_bound', 'descendant-runtime-v1');
      usage.counters.toolInvocations = 1;
      const committed = committedResourceUsageV1(projected);
      const remainingArtifactBytes =
        projected.budget.maxArtifactBytes - committed.counters.artifactBytes;
      usage.counters.artifactBytes =
        request.artifactBytes ??
        (request.toolKind === 'write_file' || request.toolKind === 'edit_file'
          ? remainingArtifactBytes
          : 0);
      usage.gauges.activeToolInvocations = 1;
      if (request.shell) usage.gauges.activeShellInvocations = 1;
      return reserve(
        request.invocationKey,
        request.toolKind.startsWith('mcp__') ? 'mcp' : 'tool',
        usage,
      );
    },
    async reconcileTool(request) {
      const usage = createZeroResourceUsageV1();
      usage.counters.toolInvocations = 1;
      usage.counters.artifactBytes = request.artifactBytes ?? 0;
      await reconcile(request.reservationId, usage);
    },
    async markUnknown(reservationId) {
      await persist({ type: 'resource_budget.unknown', reservationId });
    },
    async markLocalProviderAdmissionDenied(reservationId) {
      await persist({
        type: 'resource_budget.released',
        reservationId,
        proof: 'local_provider_admission_denied',
      });
    },
  };
}

function waitingInFifoOrder(budget: ActiveResourceBudgetRuntimeStateV1): ConcurrencyWaiterV1[] {
  return Object.values(budget.waiters ?? {})
    .filter((waiter) => waiter.state === 'waiting')
    .sort((left, right) => left.sequence - right.sequence);
}

function isQueueHead(
  budget: ActiveResourceBudgetRuntimeStateV1,
  invocation: PlannedInvocation,
): boolean {
  if (invocation.requiredPermits.length === 0) return true;
  const waiting = waitingInFifoOrder(budget);
  const own = budget.waiters?.[invocation.invocationId];
  if (!own) return waiting.length === 0;
  const toolHead = waiting[0]?.invocationId === own.invocationId;
  const shellHead =
    invocation.requiredPermits.length < 2 ||
    waiting.find((waiter) => waiter.requiredPermits.length === 2)?.invocationId ===
      own.invocationId;
  return toolHead && shellHead;
}

function reservationFor(
  budget: ActiveResourceBudgetRuntimeStateV1,
  invocation: PlannedInvocation,
): BudgetReservationV1 {
  return {
    version: 1,
    reservationId: crypto.randomUUID(),
    runId: budget.runId,
    invocationId: invocation.invocationId,
    resourceKind: invocation.resourceKind,
    executableUpperBound: invocation.upperBound,
    state: 'reserved',
  };
}

function canFitWithoutConcurrency(
  budget: ActiveResourceBudgetRuntimeStateV1,
  reservation: BudgetReservationV1,
): boolean {
  const withoutConcurrency: BudgetReservationV1 = {
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
    reduceResourceBudgetStateV1(budget, {
      type: 'resource_budget.reserved',
      reservation: withoutConcurrency,
    });
    return true;
  } catch {
    return false;
  }
}

function saturationReason(
  invocation: PlannedInvocation,
): Extract<
  RuntimeBudgetAdmissionReasonV1,
  'tool_concurrency_saturated' | 'shell_concurrency_saturated'
> {
  return invocation.requiredPermits.length === 2
    ? 'shell_concurrency_saturated'
    : 'tool_concurrency_saturated';
}

function waiterFor(
  budget: ActiveResourceBudgetRuntimeStateV1,
  invocation: PlannedInvocation,
  now: Date,
): ConcurrencyWaiterV1 {
  const deadline = Math.min(
    now.getTime() + budget.budget.maxConcurrencyWaitMs,
    Date.parse(budget.deadlineAt),
  );
  return {
    version: 1,
    runId: budget.runId,
    invocationId: invocation.invocationId,
    requiredPermits: invocation.requiredPermits as ConcurrencyWaiterV1['requiredPermits'],
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
export function planRuntimeBudgetAdmissionV1(
  state: RuntimeState,
  effect: RuntimeEffect,
  now = new Date(),
): RuntimeBudgetAdmissionPlanV1 {
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
  if (now.getTime() >= Date.parse(initial.deadlineAt)) {
    return {
      status: 'denied',
      reason: 'budget_exhausted',
      effect,
      preparationEvents: [],
      dispatchEvents: [],
      reservationIds: [],
    };
  }

  let projected: ResourceBudgetRuntimeStateV1 = initial;
  const preparationEvents: RuntimeEvent[] = [];
  const dispatchEvents: RuntimeEvent[] = [];
  const reservationIds: string[] = [];
  const admittedToolCallIds: string[] = [];
  let blocked:
    | {
        reason: RuntimeBudgetAdmissionPlanV1['reason'];
        deadlineAt?: string;
      }
    | undefined;

  for (const invocation of invocations) {
    if (projected.status !== 'active') throw new Error('Budget projection became inactive.');
    const unresolved = Object.values(projected.reservations).find(
      (reservation) =>
        reservation.invocationId === invocation.invocationId && reservation.state === 'unknown',
    );
    if (unresolved) {
      blocked = { reason: 'reconciliation_required' };
      break;
    }
    const existingWaiter = projected.waiters?.[invocation.invocationId];
    if (existingWaiter && Date.parse(existingWaiter.deadlineAt) <= now.getTime()) {
      const timedOutEvent = {
        type: 'resource_budget.waiter_timed_out',
        invocationId: invocation.invocationId,
      } as const;
      preparationEvents.push(timedOutEvent);
      projected = reduceResourceBudgetStateV1(projected, timedOutEvent);
      blocked = { reason: saturationReason(invocation) };
      break;
    }
    if (!isQueueHead(projected, invocation)) {
      const waiter = existingWaiter ?? waiterFor(projected, invocation, now);
      if (!existingWaiter) {
        const event: RuntimeEvent = { type: 'resource_budget.waiter_enqueued', waiter };
        preparationEvents.push(event);
        projected = reduceResourceBudgetStateV1(projected, event);
      }
      blocked = { reason: saturationReason(invocation), deadlineAt: waiter.deadlineAt };
      break;
    }

    const reservation = reservationFor(projected, invocation);
    const reserveEvent: RuntimeEvent = { type: 'resource_budget.reserved', reservation };
    try {
      let candidate: ActiveResourceBudgetRuntimeStateV1 = projected;
      let promote: RuntimeEvent | undefined;
      if (existingWaiter) {
        promote = {
          type: 'resource_budget.waiter_promoted',
          invocationId: invocation.invocationId,
        };
        candidate = reduceResourceBudgetStateV1(
          candidate,
          promote as Extract<RuntimeEvent, { type: 'resource_budget.waiter_promoted' }>,
        ) as ActiveResourceBudgetRuntimeStateV1;
      }
      candidate = reduceResourceBudgetStateV1(
        candidate,
        reserveEvent as Extract<RuntimeEvent, { type: 'resource_budget.reserved' }>,
      ) as ActiveResourceBudgetRuntimeStateV1;
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
      if (!canFitWithoutConcurrency(activeProjected, reservation)) {
        blocked = { reason: 'budget_exhausted' };
        break;
      }
      const waiter = existingWaiter ?? waiterFor(activeProjected, invocation, now);
      if (!existingWaiter) {
        const enqueue: RuntimeEvent = { type: 'resource_budget.waiter_enqueued', waiter };
        preparationEvents.push(enqueue);
        projected = reduceResourceBudgetStateV1(activeProjected, enqueue);
      }
      blocked = { reason: saturationReason(invocation), deadlineAt: waiter.deadlineAt };
      break;
    }
  }

  if (blocked?.deadlineAt && effect.type === 'run_tools' && projected.status === 'active') {
    let queueState: ActiveResourceBudgetRuntimeStateV1 = projected;
    for (const invocation of invocations) {
      if (
        (invocation.toolCallId && admittedToolCallIds.includes(invocation.toolCallId)) ||
        queueState.waiters?.[invocation.invocationId]
      ) {
        continue;
      }
      const waiter = waiterFor(queueState, invocation, now);
      const enqueue: RuntimeEvent = { type: 'resource_budget.waiter_enqueued', waiter };
      preparationEvents.push(enqueue);
      queueState = reduceResourceBudgetStateV1(
        queueState,
        enqueue,
      ) as ActiveResourceBudgetRuntimeStateV1;
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
      blocked?.reason === 'budget_exhausted' || blocked?.reason === 'reconciliation_required'
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

export function actualUsageForReservationV1(
  state: RuntimeState,
  reservation: BudgetReservationV1,
  terminalEvents: RuntimeEvent[] = [],
): ResourceUsageV1 {
  const usage = createZeroResourceUsageV1();
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
  const toolCallId = reservation.invocationId.startsWith('tool:')
    ? reservation.invocationId.slice('tool:'.length)
    : undefined;
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
  } else if (reservation.executableUpperBound.counters.artifactBytes > 0) {
    usage.counters.artifactBytes = reservation.executableUpperBound.counters.artifactBytes;
  }
  return usage;
}

export function reconciliationEventsForReservationsV1(
  state: RuntimeState,
  reservationIds: string[],
  terminalEvents: RuntimeEvent[] = [],
): Array<Extract<RuntimeEvent, { type: 'resource_budget.reconciled' }>> {
  if (state.resourceBudget.status !== 'active') return [];
  return reservationIds.map((reservationId) => {
    const reservation = state.resourceBudget.reservations[reservationId];
    if (!reservation)
      throw new Error(`Missing reservation ${reservationId} during reconciliation.`);
    return {
      type: 'resource_budget.reconciled' as const,
      reservationId,
      actual: actualUsageForReservationV1(state, reservation, terminalEvents),
    };
  });
}
