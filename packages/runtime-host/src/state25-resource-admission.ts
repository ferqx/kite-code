import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type {
  RuntimeEffect,
  KernelEvent as RuntimeEvent,
  AgentState as RuntimeState,
} from '@kite/agent-kernel';
import type { ModelInvocationEnvelopeV1 } from '@kite/runtime-spi';
import {
  type ActiveResourceBudgetRuntimeStateV1,
  type BudgetReservationV1,
  type ConcurrencyWaiterV1,
  committedResourceUsageV1,
  createZeroResourceUsageV1,
  type ResourceBudgetRuntimeStateV1,
  type ResourceUsageV1,
  reduceResourceBudgetStateV1,
} from './state25-resource-budget';

export type RuntimeBudgetAdmissionReasonV1 =
  | 'admitted'
  | 'budget_unconfigured'
  | 'persistence_unavailable'
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

export interface ModelResourcePreparationPlanV1 {
  budget: ModelInvocationEnvelopeV1['resource']['budget'];
  preparationEvents: RuntimeEvent[];
  maxOutputTokens?: number;
}

/**
 * Plan one explicit Gateway-owned model reservation after its Surface is
 * frozen. The caller atomically persists these events with
 * model.invocation_prepared; dispatch_started deliberately remains absent.
 */
export function planModelInvocationResourceV1(
  state: RuntimeState,
  input: {
    invocationId: string;
    inputTokens: number;
    requestedMaxOutputTokens?: number;
    resourceKind: 'model' | 'compaction' | 'verification';
    parentReservationId?: string;
    now?: Date;
  },
): ModelResourcePreparationPlanV1 {
  if (!Number.isSafeInteger(input.inputTokens) || input.inputTokens < 0) {
    throw new DescendantResourceAdmissionError(
      'budget_exhausted',
      'Model Surface input estimate is invalid.',
    );
  }
  if (state.resourceBudget.status === 'unconfigured') {
    return {
      budget: { kind: 'no_budget', reason: 'resource_budget_disabled' },
      preparationEvents: [],
      ...(input.requestedMaxOutputTokens
        ? { maxOutputTokens: input.requestedMaxOutputTokens }
        : {}),
    };
  }
  if (state.resourceBudget.status !== 'active') {
    throw new DescendantResourceAdmissionError('budget_unconfigured');
  }
  const budget = state.resourceBudget;
  if (Object.values(budget.reservations).some((reservation) => reservation.state === 'unknown')) {
    throw new DescendantResourceAdmissionError('reconciliation_required');
  }
  if ((input.now ?? new Date()).getTime() >= Date.parse(budget.deadlineAt)) {
    throw new DescendantResourceAdmissionError('budget_exhausted');
  }
  if (input.parentReservationId) {
    const parent = budget.reservations[input.parentReservationId];
    if (parent?.state !== 'dispatch_started') {
      throw new DescendantResourceAdmissionError('reconciliation_required');
    }
  }
  const committed = committedResourceUsageV1(budget);
  const remainingOutput = budget.budget.maxRunOutputTokens - committed.counters.outputTokens;
  const maxOutputTokens = Math.min(
    input.requestedMaxOutputTokens ?? remainingOutput,
    remainingOutput,
  );
  if (maxOutputTokens <= 0) throw new DescendantResourceAdmissionError('budget_exhausted');
  const usage = createZeroResourceUsageV1('versioned_upper_bound', 'model-surface-v1');
  usage.counters.modelRequests = 1;
  usage.counters.inputTokens = input.inputTokens;
  usage.counters.outputTokens = maxOutputTokens;
  const reservation: BudgetReservationV1 = {
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
    reduceResourceBudgetStateV1(budget, { type: 'resource_budget.reserved', reservation });
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
    preparationEvents: [{ type: 'resource_budget.reserved', reservation }],
    maxOutputTokens,
  };
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
    signal?: AbortSignal;
  }): Promise<DescendantBudgetReservationV1>;
  reconcileTool(input: { reservationId: string; artifactBytes?: number }): Promise<void>;
  markUnknown(reservationId: string): Promise<void>;
  markLocalProviderAdmissionDenied(reservationId: string): Promise<void>;
}

export class DescendantResourceAdmissionError extends Error {
  readonly reason: Exclude<RuntimeBudgetAdmissionReasonV1, 'admitted'>;

  constructor(
    reason: Exclude<RuntimeBudgetAdmissionReasonV1, 'admitted'>,
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
  // Model-bearing effects reserve from the exact frozen Surface inside
  // ModelInvocationGatewayV1. The runner must not create a second coarse
  // reservation before that Surface exists.
  if (
    effect.type === 'call_model' ||
    effect.type === 'compact_context' ||
    effect.type === 'run_auto_review'
  ) {
    return [];
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
  return effect.toolCallIds.flatMap((toolCallId) => {
    const call = state.tools.calls[toolCallId];
    // A concurrently suspended sibling is requeued only so the Runtime can
    // present its already-created approval interaction. No Sub-agent or tool
    // dispatch occurs, so this effect must not consume another reservation.
    if (call?.name === 'task' && call.status === 'queued' && state.suspendedSubagents[toolCallId]) {
      return [];
    }
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
    return [
      {
        invocationId:
          completedTaskAttempts > 0
            ? `${taskInvocationPrefix}:resume:${completedTaskAttempts}`
            : taskInvocationPrefix,
        toolCallId,
        resourceKind,
        requiredPermits: shell ? (['tool', 'shell_invocation'] as const) : (['tool'] as const),
        upperBound: upperBoundForTool(state, toolCallId),
      },
    ];
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
  getState?(): Readonly<RuntimeState>;
  persistEvent(event: RuntimeEvent): Promise<boolean>;
  persistEvents(events: RuntimeEvent[]): Promise<boolean>;
  persistLateResourceReconciliation?(
    event: Extract<RuntimeEvent, { type: 'resource_budget.reconciled' }>,
  ): Promise<boolean>;
  signal?: AbortSignal;
  now?(): Date;
}): DescendantResourceAdmissionV1 {
  if (input.state.resourceBudget.status !== 'active') {
    throw new DescendantResourceAdmissionError(
      'budget_unconfigured',
      'Shared resource budget is unavailable.',
    );
  }
  const parent = input.state.resourceBudget.reservations[input.parentReservationId];
  if (parent?.resourceKind !== 'subagent' || parent.state !== 'dispatch_started') {
    throw new DescendantResourceAdmissionError(
      'reconciliation_required',
      'Sub-agent parent reservation is not dispatch-started.',
    );
  }
  let projected = input.state.resourceBudget;
  let mutationTail = Promise.resolve();
  let projectionRevision = 0;
  const projectionListeners = new Set<() => void>();

  const notifyProjectionChange = () => {
    projectionRevision += 1;
    for (const listener of projectionListeners) listener();
    projectionListeners.clear();
  };

  const refreshProjected = (): ActiveResourceBudgetRuntimeStateV1 => {
    const latest = input.getState?.().resourceBudget;
    if (latest?.status === 'active' && latest.runId === projected.runId) projected = latest;
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
    let next: ResourceBudgetRuntimeStateV1;
    try {
      next = reduceResourceBudgetStateV1(projected, event as never);
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
    let next: ResourceBudgetRuntimeStateV1 = projected;
    try {
      for (const event of events) next = reduceResourceBudgetStateV1(next, event as never);
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

  const assertParentDispatchStarted = (budget: ActiveResourceBudgetRuntimeStateV1): void => {
    const currentParent = budget.reservations[parent.reservationId];
    if (currentParent?.resourceKind !== 'subagent' || currentParent.state !== 'dispatch_started') {
      throw new DescendantResourceAdmissionError(
        'reconciliation_required',
        'Sub-agent parent reservation is no longer dispatch-started.',
      );
    }
  };

  const now = (): Date => input.now?.() ?? new Date();

  const assertRunDeadline = (budget: ActiveResourceBudgetRuntimeStateV1): void => {
    if (now().getTime() >= Date.parse(budget.deadlineAt)) {
      throw new DescendantResourceAdmissionError(
        'budget_exhausted',
        'Sub-agent run deadline was reached before dispatch.',
      );
    }
  };

  const descendantInvocationId = (invocationKey: string): string =>
    `descendant:${parent.invocationId}:${invocationKey}`;

  const reserveDirect = async (
    invocationKey: string,
    resourceKind: BudgetReservationV1['resourceKind'],
    upperBound: ResourceUsageV1,
  ): Promise<DescendantBudgetReservationV1> => {
    while (true) {
      try {
        return await withMutation(async () => {
          const budget = refreshProjected();
          assertParentDispatchStarted(budget);
          assertRunDeadline(budget);
          const reservation: BudgetReservationV1 = {
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

  const reconcile = async (reservationId: string, actual: ResourceUsageV1): Promise<void> => {
    await withMutation(async () => {
      refreshProjected();
      const event = { type: 'resource_budget.reconciled', reservationId, actual } as const;
      let next: ResourceBudgetRuntimeStateV1;
      try {
        next = reduceResourceBudgetStateV1(projected, event);
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
      const latest = input.getState?.().resourceBudget;
      if (next.status !== 'active') {
        throw new DescendantResourceAdmissionError(
          'reconciliation_required',
          'Sub-agent resource reconciliation produced an inactive ledger.',
        );
      }
      projected = latest?.status === 'active' && latest.runId === projected.runId ? latest : next;
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
  ): Promise<DescendantBudgetReservationV1> => {
    while (true) {
      const attempt = await withMutation(async () => {
        const budget = refreshProjected();
        assertParentDispatchStarted(budget);
        const unresolved = Object.values(budget.reservations).find(
          (reservation) =>
            reservation.invocationId === invocation.invocationId && reservation.state === 'unknown',
        );
        if (unresolved) {
          throw new DescendantResourceAdmissionError('reconciliation_required');
        }
        assertRunDeadline(budget);
        const attemptTime = now();
        const existingWaiter = budget.waiters[invocation.invocationId];
        if (existingWaiter && Date.parse(existingWaiter.deadlineAt) <= attemptTime.getTime()) {
          await persist({
            type: 'resource_budget.waiter_timed_out',
            invocationId: invocation.invocationId,
          });
          throw new DescendantResourceAdmissionError(saturationReason(invocation));
        }
        const reservation = reservationFor(budget, invocation, parent.reservationId);
        let candidate: ActiveResourceBudgetRuntimeStateV1 = budget;
        const preparationEvents: RuntimeEvent[] = [];
        if (existingWaiter && isQueueHead(budget, invocation)) {
          const promoted = {
            type: 'resource_budget.waiter_promoted',
            invocationId: invocation.invocationId,
          } as const;
          candidate = reduceResourceBudgetStateV1(
            candidate,
            promoted,
          ) as ActiveResourceBudgetRuntimeStateV1;
          preparationEvents.push(promoted);
        } else if (!isQueueHead(budget, invocation)) {
          const waiter = existingWaiter ?? waiterFor(budget, invocation, attemptTime);
          if (!existingWaiter) {
            await persist({ type: 'resource_budget.waiter_enqueued', waiter });
          }
          return { status: 'waiting' as const, deadlineAt: waiter.deadlineAt };
        }
        try {
          candidate = reduceResourceBudgetStateV1(candidate, {
            type: 'resource_budget.reserved',
            reservation,
          }) as ActiveResourceBudgetRuntimeStateV1;
        } catch {
          if (!canFitWithoutConcurrency(budget, reservation)) {
            throw new DescendantResourceAdmissionError('budget_exhausted');
          }
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
      const committed = committedResourceUsageV1(budget);
      const remainingOutput = budget.budget.maxRunOutputTokens - committed.counters.outputTokens;
      const outputTokens = Math.min(
        request.requestedMaxOutputTokens ?? remainingOutput,
        remainingOutput,
      );
      if (outputTokens <= 0) {
        throw new DescendantResourceAdmissionError(
          'budget_exhausted',
          'Sub-agent model output budget is exhausted.',
        );
      }
      const usage = createZeroResourceUsageV1('versioned_upper_bound', 'descendant-runtime-v1');
      usage.counters.modelRequests = 1;
      usage.counters.inputTokens = request.inputTokens;
      usage.counters.outputTokens = outputTokens;
      return reserveDirect(request.invocationKey, 'model', usage);
    },
    async reconcileModel(request) {
      const usage = createZeroResourceUsageV1();
      usage.counters.modelRequests = 1;
      usage.counters.inputTokens = request.inputTokens;
      usage.counters.outputTokens = request.outputTokens;
      await reconcile(request.reservationId, usage);
    },
    async reserveTool(request) {
      const budget = refreshProjected();
      const usage = createZeroResourceUsageV1('versioned_upper_bound', 'descendant-runtime-v1');
      usage.counters.toolInvocations = 1;
      const committed = committedResourceUsageV1(budget);
      const remainingArtifactBytes =
        budget.budget.maxArtifactBytes - committed.counters.artifactBytes;
      usage.counters.artifactBytes =
        request.artifactBytes ??
        (request.toolKind === 'write_file' || request.toolKind === 'edit_file'
          ? remainingArtifactBytes
          : 0);
      usage.gauges.activeToolInvocations = 1;
      if (request.shell) usage.gauges.activeShellInvocations = 1;
      return reserveToolWithFifo(
        {
          invocationId: descendantInvocationId(request.invocationKey),
          resourceKind: request.toolKind.startsWith('mcp__') ? 'mcp' : 'tool',
          requiredPermits: request.shell ? ['tool', 'shell_invocation'] : ['tool'],
          upperBound: usage,
        },
        request.signal ?? input.signal,
      );
    },
    async reconcileTool(request) {
      const usage = createZeroResourceUsageV1();
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
  parentReservationId?: string,
): BudgetReservationV1 {
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
