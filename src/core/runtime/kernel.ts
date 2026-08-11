// ── Agent Runtime Kernel 核心协调器 / Agent Runtime Kernel core coordinator ──
// AgentKernel 封装 RuntimeState 管理、事件管道和策略决策。
// RuntimeState、事件持久化和效果执行调度的统一入口。
//
// AgentKernel encapsulates RuntimeState management, event pipeline,
// and policy decisions.  Single entry point for state, persistence, and effect dispatch.

import { createHash } from 'node:crypto';
import { defaultPlanArtifactStore } from '@/core/persistence/plan-artifacts';
import { assertAuthorizationElevation, createModePolicy } from '@/core/policies/mode-policy';
import type { RuntimePolicy } from '@/core/policies/runtime-policy';
import type { AuthorizationSource } from '@/core/types';
import type { AuthorizationMode, InteractionMode } from '@/protocol/events';
import {
  eventsForRuntimeAction,
  type RuntimeActionResult,
  type RuntimeUserAction,
} from './actions';
import { normalizeContextRuntimeState } from './context-compaction';
import type { RuntimeEffect, RuntimeEffectLease } from './effects';
import type { RuntimeEvent, RuntimeEventEnvelope } from './events';
import { assertRuntimeStateInvariants } from './invariants';
import { reduceRuntimeState, reduceRuntimeStateFromHistoricalSchema } from './reducer';
import { createLegacyResourceBudgetStateV1 } from './resource-budget';
import { decideNextEffect } from './scheduler';
import {
  computePlanStructuralDigest,
  createInitialRuntimeState,
  getEffectiveInteractionMode,
  RUNTIME_STATE_SCHEMA_VERSION,
  type RuntimeState,
  TOOL_OUTCOME_RECOVERY_STATE_SCHEMA_VERSION,
} from './state';
import {
  createRuntimeStore,
  type RuntimeEventMetadata,
  type RuntimeRestoreBoundary,
  RuntimeRevisionConflictError,
  type RuntimeStore,
  type StoredEvent,
} from './store';
import { normalizeTerminalRuntimeEventV1 } from './terminal-outcome';
import { normalizeCurrentToolOutcomeEventV1 } from './tool-outcome-events';
import {
  createToolRecoveryJournalV1,
  normalizeToolRecoveryJournalV1,
} from './tool-recovery-journal';

// ── Kernel 配置 / Kernel configuration ──

/** AgentKernel 初始化参数 / AgentKernel initialization parameters */
export interface KernelConfig {
  /** 运行时状态存储 / Runtime state store */
  store: RuntimeStore;
  /** 初始运行时状态 / Initial runtime state */
  initialState: RuntimeState;
  /** 交互模式 / Interaction mode */
  interactionMode: InteractionMode;
  /** 沙箱是否可用（影响 full mode 行为）/ Whether sandbox is available */
  sandboxAvailable?: boolean;
}

/** Executes an effect and returns facts for the Kernel to reduce/persist. */
export type RuntimeEffectEventSink = (event: RuntimeEvent) => void;

export type RuntimeEffectExecutor = (
  effect: RuntimeEffect,
  state: Readonly<RuntimeState>,
  emit?: RuntimeEffectEventSink,
  context?: {
    reservationIds: readonly string[];
    getState?(): Readonly<RuntimeState>;
    persistEvent(event: RuntimeEvent): Promise<boolean>;
    persistEvents(events: RuntimeEvent[]): Promise<boolean>;
    persistLateResourceReconciliation?(
      event: Extract<RuntimeEvent, { type: 'resource_budget.reconciled' }>,
    ): Promise<boolean>;
  },
) => Promise<RuntimeEvent[]>;

// ── AgentKernel 实现 / AgentKernel implementation ──

/**
 * AgentKernel — 运行时状态的唯一管理入口。
 * AgentKernel — single management entry point for runtime state.
 *
 * 职责 / Responsibilities:
 * - 维护 RuntimeState（通过 reducer 处理事件更新）/ Maintain RuntimeState (update via reducer)
 * - 持久化 RuntimeEvent 到 EventStore / Persist RuntimeEvents to EventStore
 * - 管理 RuntimePolicy（根据 mode 创建策略）/ Manage RuntimePolicy (create policy from mode)
 * - 状态快照保存 / State snapshot persistence
 *
 * 不负责 / Does NOT handle:
 * - 调用模型（由 model-controller 负责）/ Calling the model (model-controller)
 * - 执行工具（由 tool-controller 负责）/ Executing tools (tool-controller)
 * - UI action collection（由 app/provider 负责）/ UI action collection (app/provider)
 */
export class AgentKernel {
  private store: RuntimeStore;
  private state: RuntimeState;
  private sandboxAvailable: boolean;
  private readonly appliedEventIds: Set<string>;
  private lastAppliedEvents: RuntimeEvent[] = [];
  private activeRunnerId: string | null = null;

  constructor(config: KernelConfig) {
    this.store = config.store;
    this.state = config.initialState;
    this.sandboxAvailable = config.sandboxAvailable ?? false;
    this.appliedEventIds = new Set(config.initialState.appliedEventIds ?? []);
  }

  // ── 事件处理 / Event processing ──

  /**
   * 处理单个 RuntimeEvent：reduce → persist。
   * Process a single RuntimeEvent: reduce → persist.
   */
  processEvent(event: RuntimeEvent): { status: 'applied' | 'duplicate'; eventId: string } {
    const envelope = this.createEnvelope(event, this.state.revision + 1);
    if (this.appliedEventIds.has(envelope.eventId)) {
      this.lastAppliedEvents = [];
      return { status: 'duplicate', eventId: envelope.eventId };
    }

    const nextState = this.reduceEnvelope(this.state, envelope);
    // Atomic persist events + snapshot before publishing the new in-memory state.
    this.store.appendEventsAndSnapshot(this.state.session.threadId, [envelope.payload], nextState, [
      this.metadataFor(envelope),
    ]);
    this.state = nextState;
    this.lastAppliedEvents = [envelope.payload];
    this.appliedEventIds.add(envelope.eventId);
    if (envelope.payload.type === 'turn.completed') {
      this.store.saveNamedSnapshot(
        this.state.session.threadId,
        `turn-${envelope.payload.turnId}-${this.store.getLastEventPosition(this.state.session.threadId)}`,
        this.state,
      );
    }
    return { status: 'applied', eventId: envelope.eventId };
  }

  /**
   * 批量处理 RuntimeEvent：reduce → 原子持久化 (events + snapshot)。
   * Process a batch of RuntimeEvents atomically: reduce → persist events and snapshot together.
   *
   * 用于 Plan 审批等需要事件和快照同时落盘的关键路径。
   * Used for critical paths like plan approval where events and snapshot must be durably consistent.
   */
  processEventBatch(events: RuntimeEvent[]): RuntimeEvent[] {
    if (events.length === 0) {
      this.lastAppliedEvents = [];
      return [];
    }
    let nextState = this.state;
    const payloads: RuntimeEvent[] = [];
    const metadata: RuntimeEventMetadata[] = [];
    const batchEventIds: string[] = [];
    const batchSeen = new Set(this.appliedEventIds);
    for (const event of events) {
      const envelope = this.createEnvelope(event, nextState.revision + 1, nextState);
      if (batchSeen.has(envelope.eventId)) continue;
      nextState = this.reduceEnvelope(nextState, envelope);
      payloads.push(envelope.payload);
      metadata.push(this.metadataFor(envelope));
      batchSeen.add(envelope.eventId);
      batchEventIds.push(envelope.eventId);
    }
    if (payloads.length === 0) {
      this.lastAppliedEvents = [];
      return [];
    }
    this.store.appendEventsAndSnapshot(this.state.session.threadId, payloads, nextState, metadata);
    this.state = nextState;
    this.lastAppliedEvents = payloads;
    for (const eventId of batchEventIds) this.appliedEventIds.add(eventId);
    let completedTurn: RuntimeEvent | undefined;
    for (const event of payloads) {
      if (event.type === 'turn.completed') completedTurn = event;
    }
    if (completedTurn?.type === 'turn.completed') {
      this.store.saveNamedSnapshot(
        this.state.session.threadId,
        `turn-${completedTurn.turnId}-${this.store.getLastEventPosition(this.state.session.threadId)}`,
        this.state,
      );
    }
    return payloads;
  }

  /**
   * 批量处理多个 RuntimeEvent。
   * Process multiple RuntimeEvents in batch.
   */
  processEvents(events: RuntimeEvent[]): void {
    for (const event of events) {
      this.processEvent(event);
    }
  }

  // ── 状态访问 / State access ──

  /**
   * 获取当前运行时状态的只读副本。
   * Get a read-only copy of the current runtime state.
   */
  getState(): Readonly<RuntimeState> {
    return this.state;
  }

  /** Canonical payloads from the immediately preceding synchronous apply operation. */
  getLastAppliedEvents(): readonly RuntimeEvent[] {
    return this.lastAppliedEvents;
  }

  /**
   * 获取当前运行时策略（每次基于 state.mode 重新求值）。
   * Get the current runtime policy (re-evaluated from state.mode each call).
   *
   * v2: policy 不再仅在 constructor 创建一次，而是每次基于当前 state.mode 纯函数求值。
   * v2: policy is no longer created once in constructor; re-evaluated from current state.mode each call.
   */
  getPolicy(): RuntimePolicy {
    return createModePolicy(
      getEffectiveInteractionMode(this.state) as InteractionMode,
      this.sandboxAvailable,
    );
  }

  /**
   * 获取当前交互模式。
   * Get the current interaction mode.
   */
  getMode(): InteractionMode {
    return getEffectiveInteractionMode(this.state);
  }

  /** Whether this runtime may grant authorization that requires a sandbox. */
  isSandboxAvailable(): boolean {
    return this.sandboxAvailable;
  }

  /** Acquire the single runner lease for this thread. */
  acquireRunner(): string | null {
    if (this.activeRunnerId) return null;
    const runnerId = crypto.randomUUID();
    this.activeRunnerId = runnerId;
    return runnerId;
  }

  /** Release a runner lease only if it still belongs to the caller. */
  releaseRunner(runnerId: string): void {
    if (this.activeRunnerId === runnerId) this.activeRunnerId = null;
  }

  beginEffect(effect: RuntimeEffect): RuntimeEffectLease {
    return {
      effectId: crypto.randomUUID(),
      expectedRevision: this.state.revision,
      turnId: this.state.turn.turnId,
      effect,
    };
  }

  /** Apply an effect result only if no newer event changed the state. */
  applyEffectResult(lease: RuntimeEffectLease, events: RuntimeEvent[]): boolean {
    if (this.hasLateTerminalEventForCancelledTool(lease, events)) {
      return false;
    }
    const current =
      lease.expectedRevision === this.state.revision && lease.turnId === this.state.turn.turnId;
    const concurrentShellResult =
      !current && events.length > 0 && this.isConcurrentShellBatchCurrent(lease, events);
    if (!current && !concurrentShellResult) {
      return false;
    }
    this.processEventBatch(events);
    lease.expectedRevision = this.state.revision;
    return true;
  }

  /**
   * Persist only bounded resource reconciliation from a stale/cancelled
   * effect. This never accepts a tool/model terminal event and therefore
   * cannot revive scheduling or rewrite a durable terminal outcome.
   */
  applyLateResourceReconciliation(events: RuntimeEvent[]): boolean {
    if (
      events.length === 0 ||
      events.some((event) => event.type !== 'resource_budget.reconciled') ||
      this.state.resourceBudget.status !== 'active'
    ) {
      return false;
    }
    const valid = events.every((event) => {
      if (event.type !== 'resource_budget.reconciled') return false;
      const reservation =
        this.state.resourceBudget.status === 'active'
          ? this.state.resourceBudget.reservations[event.reservationId]
          : undefined;
      return reservation?.state === 'dispatch_started' || reservation?.state === 'unknown';
    });
    if (!valid) return false;
    this.processEventBatch(events);
    return true;
  }

  private hasLateTerminalEventForCancelledTool(
    lease: RuntimeEffectLease,
    inputs: RuntimeEvent[],
  ): boolean {
    if (lease.effect.type !== 'run_tools') return false;
    return inputs.some((event) => {
      if (
        event.type !== 'tool.finished' &&
        event.type !== 'tool.failed' &&
        event.type !== 'tool.rejected'
      ) {
        return false;
      }
      return this.state.tools.calls[event.toolCallId]?.status === 'cancelled';
    });
  }

  /**
   * Apply one event produced while an effect is still running.
   * Streaming events advance the lease revision so the final effect result
   * remains subject to the same stale-result check as a batch result.
   */
  applyEffectEvent(lease: RuntimeEffectLease, event: RuntimeEvent): boolean {
    if (!this.isEffectEventCurrent(lease, event)) return false;
    this.processEvent(event);
    lease.expectedRevision = this.state.revision;
    return true;
  }

  private isConcurrentShellBatchCurrent(
    lease: RuntimeEffectLease,
    inputs: RuntimeEvent[],
  ): boolean {
    let projectedState = this.state;
    for (const event of inputs) {
      if (!this.isConcurrentShellEventCurrent(lease, event, projectedState)) return false;
      const canonicalEvent = this.normalizeCurrentEvent(
        event,
        projectedState,
        new Date().toISOString(),
      );
      projectedState = reduceRuntimeState(projectedState, canonicalEvent);
    }
    return true;
  }

  /**
   * Shell siblings from one model response may keep running while the next
   * sibling is being approved. Their leases therefore tolerate unrelated
   * revision advances, but only for events owned by the same still-live call.
   */
  private isConcurrentShellEventCurrent(
    lease: RuntimeEffectLease,
    event: RuntimeEvent,
    state: RuntimeState = this.state,
  ): boolean {
    if (lease.turnId !== state.turn.turnId || lease.effect.type !== 'run_tools') return false;
    if (!('toolCallId' in event) || typeof event.toolCallId !== 'string') return false;
    if (!lease.effect.toolCallIds.includes(event.toolCallId)) return false;

    const call = state.tools.calls[event.toolCallId];
    if (call?.name !== 'shell_execute') return false;
    switch (event.type) {
      case 'approval.requested':
      case 'auto_review.requested':
        return call.status === 'queued';
      case 'tool.started':
        return call.status === 'queued' || call.status === 'approved';
      case 'tool.progress':
        return call.status === 'running';
      case 'tool.finished':
        return call.status === 'running';
      case 'tool.failed':
      case 'tool.rejected':
        return call.status === 'queued' || call.status === 'approved' || call.status === 'running';
      case 'runtime.cancellation_diagnostic':
        return call.status === 'cancelled' || call.status === 'running';
      default:
        return false;
    }
  }

  /** Validate an in-flight effect without reducing or persisting an event. */
  isEffectLeaseCurrent(lease: RuntimeEffectLease): boolean {
    return (
      lease.expectedRevision === this.state.revision && lease.turnId === this.state.turn.turnId
    );
  }

  /**
   * Validate one in-flight effect event without reducing or persisting it.
   * Ephemeral presentation events use this path so concurrent Shell progress
   * retains the same ownership checks as durable effect events without
   * advancing the Runtime revision.
   */
  isEffectEventCurrent(lease: RuntimeEffectLease, event: RuntimeEvent): boolean {
    return this.isEffectLeaseCurrent(lease) || this.isConcurrentShellEventCurrent(lease, event);
  }

  /**
   * Execute deterministic effects until the runtime needs user input or the
   * supplied executor stops emitting facts.  The executor never receives a
   * mutable state reference and cannot bypass processEvent().
   */
  async run(executor: RuntimeEffectExecutor, maxEffects = 10_000): Promise<RuntimeEffect> {
    const runnerId = this.acquireRunner();
    if (!runnerId) {
      return { type: 'busy', reason: 'A runtime runner is already active for this thread.' };
    }
    try {
      for (let index = 0; index < maxEffects; index++) {
        const effect = decideNextEffect(this.state);
        if (effect.type === 'recovery_blocked') return effect;
        if (effect.type === 'subagent.recovery_unavailable') {
          const lease = this.beginEffect(effect);
          const events = await executor(lease.effect, this.getState());
          if (events.length === 0) return { type: 'stop' };
          if (!this.applyEffectResult(lease, events)) continue;
          continue;
        }
        if (
          effect.type === 'request_user_input' ||
          effect.type === 'request_plan_review' ||
          effect.type === 'request_tool_approval' ||
          effect.type === 'request_verification_decision' ||
          effect.type === 'request_provider_action' ||
          effect.type === 'request_provider_admission' ||
          effect.type === 'stop' ||
          effect.type === 'emit_final'
        ) {
          return effect;
        }
        const lease = this.beginEffect(effect);
        const events = await executor(lease.effect, this.getState());
        if (events.length === 0) return { type: 'stop' };
        if (!this.applyEffectResult(lease, events)) continue;
      }
      throw new Error(`Runtime effect limit (${maxEffects}) exceeded`);
    } finally {
      this.releaseRunner(runnerId);
    }
  }

  /** Apply a user action only when it matches the currently persisted interaction. */
  applyAction(
    action: RuntimeUserAction,
    additionalEvents: RuntimeEvent[] = [],
  ): RuntimeActionResult {
    const events = eventsForRuntimeAction(this.state, action, {
      sandboxAvailable: this.sandboxAvailable,
    });
    if (events.length === 0) {
      const reason =
        this.state.interactions.kind === 'idle'
          ? 'No active interaction accepts this action.'
          : 'The action does not match the active interaction.';
      return {
        status: this.state.interactions.kind === 'idle' ? 'rejected' : 'stale',
        reason,
        telemetry: {
          type: 'runtime.action_ignored',
          ...('interactionId' in action ? { interactionId: action.interactionId } : {}),
          reason,
        },
      };
    }
    const combined = [...events, ...additionalEvents];
    const canonicalEvents = this.processEventBatch(combined);
    return { status: 'applied', events: canonicalEvents };
  }

  private createEnvelope(
    event: RuntimeEvent,
    revision: number,
    normalizationState: RuntimeState = this.state,
  ): RuntimeEventEnvelope {
    const occurredAt = new Date().toISOString();
    const normalizedEvent = this.normalizeCurrentEvent(event, normalizationState, occurredAt);
    const serialized = JSON.stringify(normalizedEvent);
    const eventId = createHash('sha256').update(serialized).digest('hex');
    const payload =
      (normalizedEvent.type === 'user.message_appended' ||
        normalizedEvent.type === 'model.responded' ||
        normalizedEvent.type === 'tool.finished' ||
        normalizedEvent.type === 'tool.failed' ||
        normalizedEvent.type === 'tool.rejected' ||
        normalizedEvent.type === 'tool.cancelled' ||
        normalizedEvent.type === 'tool.queued' ||
        normalizedEvent.type === 'tool.started' ||
        normalizedEvent.type === 'approval.requested' ||
        normalizedEvent.type === 'approval.granted' ||
        normalizedEvent.type === 'approval.rejected' ||
        normalizedEvent.type === 'auto_review.requested' ||
        normalizedEvent.type === 'auto_review.completed') &&
      !normalizedEvent.createdAt
        ? { ...normalizedEvent, createdAt: occurredAt }
        : normalizedEvent;
    return {
      eventId,
      threadId: this.state.session.threadId,
      revision,
      occurredAt,
      payload,
    };
  }

  private normalizeCurrentEvent(
    event: RuntimeEvent,
    normalizationState: RuntimeState,
    occurredAt: string,
  ): RuntimeEvent {
    const runtimeNormalizedEvent = normalizeTerminalRuntimeEventV1(event);
    return normalizeCurrentToolOutcomeEventV1(
      runtimeNormalizedEvent,
      normalizationState,
      occurredAt,
    );
  }

  private reduceEnvelope(state: RuntimeState, envelope: RuntimeEventEnvelope): RuntimeState {
    if (envelope.revision !== state.revision + 1) {
      throw new Error(
        `Runtime revision mismatch: expected ${state.revision + 1}, received ${envelope.revision}.`,
      );
    }
    this.assertRuntimeEventAdmission(envelope.payload);
    const reduced = reduceRuntimeState(state, envelope.payload);
    const nextState: RuntimeState = {
      ...reduced,
      revision: envelope.revision,
      lastAppliedEventId: envelope.eventId,
      appliedEventIds: [...(reduced.appliedEventIds ?? []), envelope.eventId].slice(-4096),
    };
    assertRuntimeStateInvariants(nextState);
    return nextState;
  }

  /** Enforce authorization invariants for mutable live-control events. */
  private assertRuntimeEventAdmission(event: RuntimeEvent): void {
    if (event.type !== 'interaction_mode.changed') return;
    if (!Number.isFinite(Date.parse(event.changedAt))) {
      throw new Error('interaction_mode.changed requires a valid changedAt timestamp.');
    }
    if (event.mode !== 'full') return;
    assertAuthorizationElevation({
      mode: 'full_access',
      source: event.source,
      sandboxAvailable: this.sandboxAvailable,
    });
  }

  private metadataFor(envelope: RuntimeEventEnvelope): RuntimeEventMetadata {
    return {
      eventId: envelope.eventId,
      revision: envelope.revision,
      causationId: envelope.causationId,
      occurredAt: envelope.occurredAt,
    };
  }

  // ── 持久化 / Persistence ──

  /**
   * 保存当前状态的快照到 EventStore。
   * Save a snapshot of the current state to the EventStore.
   */
  saveSnapshot(): void {
    this.store.saveSnapshot(this.state.session.threadId, this.state);
  }

  /**
   * 从 EventStore 加载状态快照。
   * Load a state snapshot from the EventStore.
   *
   * @param threadId - 线程 ID / Thread id
   * @returns 恢复的 RuntimeState，无快照时返回 null
   */
  loadSnapshot(threadId: string): RuntimeState | null {
    return this.store.loadSnapshot<RuntimeState>(threadId);
  }

  /**
   * 加载线程的事件日志。
   * Load event log for a thread.
   *
   * @param threadId - 线程 ID / Thread id
   * @param since - 可选的起始事件 ID / Optional starting event id
   * @returns 事件日志条目数组 / Array of stored events
   */
  loadEvents(threadId: string, since?: number) {
    return this.store.loadEvents(threadId, since);
  }

  /** Save a stable recovery point for rewind/fork without involving Graph checkpoints. */
  saveNamedSnapshot(name: string): void {
    this.store.saveNamedSnapshot(this.state.session.threadId, name, this.state);
  }

  /** Restore a named RuntimeStore recovery point into this Kernel. */
  restoreNamedSnapshot(name: string): boolean {
    const snapshot = this.store.loadNamedSnapshot<RuntimeState>(this.state.session.threadId, name);
    if (!snapshot) return false;
    this.state = snapshot;
    return true;
  }

  // ── 生命周期 / Lifecycle ──

  /**
   * 暴露运行时存储，供辅助持久化（如文件写入前原像，ADR-0042 §4）。
   * Expose the runtime store for auxiliary persistence (e.g. file pre-images).
   */
  get runtimeStore(): RuntimeStore {
    return this.store;
  }

  /**
   * 关闭 kernel（释放 store 连接等）。
   * Close the kernel (release store connections, etc.).
   */
  close(): void {
    this.store.close();
  }
}

// ── 工厂函数 / Factory ──

/**
 * 创建 AgentKernel 实例的便捷工厂。
 * Convenience factory for creating an AgentKernel instance.
 *
 * @param threadId - 线程 ID / Thread id
 * @param userId - 用户 ID / User id
 * @param workspace - 工作目录 / Workspace path
 * @param storePath - RuntimeStore 数据库路径 / RuntimeStore database path
 * @param interactionMode - 交互模式，默认 'accept_edits' / Interaction mode, defaults to 'accept_edits'
 * @param sandboxAvailable - 沙箱是否可用 / Whether sandbox is available
 * @returns 初始化的 AgentKernel 实例 / Initialized AgentKernel instance
 */
export function createAgentKernel(params: {
  threadId: string;
  userId: string;
  workspace: string;
  storePath: string;
  interactionMode?: InteractionMode;
  authorizationMode?: AuthorizationMode;
  authorizationSource?: AuthorizationSource;
  /** 初始执行阶段 / Initial execution phase */
  phase?: 'planning' | 'building';
  sandboxAvailable?: boolean;
}): AgentKernel {
  const store = createRuntimeStore(params.storePath);
  let restoredState: RuntimeState;
  try {
    restoredState = restoreRuntimeStateAndPersistMigration({ ...params, store });
  } catch (error) {
    store.close();
    throw error;
  }

  const kernel = new AgentKernel({
    store,
    initialState: restoredState,
    interactionMode: params.interactionMode ?? 'accept_edits',
    sandboxAvailable: params.sandboxAvailable,
  });
  // A persisted intent without a terminal provider result is deliberately not
  // replayed.  Record the uncertainty durably so a later reconciliation/user
  // decision can resolve it without issuing a duplicate external write.
  for (const invocation of Object.values(kernel.getState().capabilities.invocations)) {
    if (invocation.status !== 'recorded' && invocation.status !== 'running') continue;
    kernel.processEvent({
      type: 'capability.execution_unknown',
      invocationId: invocation.invocationId,
      reason: 'Runtime recovered after invocation intent was persisted without a terminal result.',
      finishedAt: new Date().toISOString(),
    });
  }
  const recoveredBudget = kernel.getState().resourceBudget;
  if (recoveredBudget.status === 'active') {
    for (const reservation of Object.values(recoveredBudget.reservations)) {
      if (reservation.state === 'reserved') {
        kernel.processEvent({
          type: 'resource_budget.released',
          reservationId: reservation.reservationId,
        });
      } else if (reservation.state === 'dispatch_started') {
        kernel.processEvent({
          type: 'resource_budget.unknown',
          reservationId: reservation.reservationId,
        });
      }
    }
    if (kernel.getState().turn.status !== 'active') {
      for (const waiter of Object.values(recoveredBudget.waiters ?? {})) {
        if (waiter.state !== 'waiting') continue;
        kernel.processEvent({
          type: 'resource_budget.waiter_cancelled',
          invocationId: waiter.invocationId,
        });
      }
    }
  }
  return kernel;
}

const MAX_MIGRATION_SNAPSHOT_RETRIES = 8;

/** Restore and CAS-persist a migrated rolling snapshot at the exact observed journal boundary. */
export function restoreRuntimeStateAndPersistMigration(params: {
  store: RuntimeStore;
  threadId: string;
  userId: string;
  workspace: string;
  interactionMode?: InteractionMode;
  authorizationMode?: AuthorizationMode;
  authorizationSource?: AuthorizationSource;
  phase?: 'planning' | 'building';
}): RuntimeState {
  let lastConflict: RuntimeRevisionConflictError | undefined;
  for (let attempt = 0; attempt < MAX_MIGRATION_SNAPSHOT_RETRIES; attempt++) {
    const restored = restoreRuntimeStateFromStore(params);
    if (!restored.migratedSnapshot) return restored.state;
    try {
      params.store.appendEventsAndSnapshot(
        params.threadId,
        [],
        restored.migratedSnapshot,
        undefined,
        undefined,
        restored.restoreBoundary,
      );
      return restored.state;
    } catch (error) {
      if (!(error instanceof RuntimeRevisionConflictError)) throw error;
      lastConflict = error;
    }
  }
  throw (
    lastConflict ??
    new RuntimeRevisionConflictError(
      params.threadId,
      0,
      null,
      `Runtime migration snapshot for ${params.threadId} could not converge after ${MAX_MIGRATION_SNAPSHOT_RETRIES} restore retries.`,
    )
  );
}

/** Strictly restore Runtime state without executing reconciliation side effects. */
export function restoreRuntimeStateFromStore(params: {
  store: RuntimeStore;
  threadId: string;
  userId: string;
  workspace: string;
  interactionMode?: InteractionMode;
  authorizationMode?: AuthorizationMode;
  authorizationSource?: AuthorizationSource;
  phase?: 'planning' | 'building';
}): {
  state: RuntimeState;
  migratedSnapshot: RuntimeState | null;
  restoreBoundary: RuntimeRestoreBoundary;
} {
  const store = params.store;
  const freshState = createInitialRuntimeState({
    threadId: params.threadId,
    userId: params.userId,
    workspace: params.workspace,
    interactionMode: params.interactionMode ?? 'accept_edits',
    authorizationMode: params.authorizationMode,
    authorizationSource: params.authorizationSource,
    phase: params.phase,
  });
  const snapshotRecord = store.loadSnapshotRecord<RuntimeState>(params.threadId);
  const restoredState = snapshotRecord?.state ?? null;
  let migratedState = restoredState ? migrateRuntimeState(restoredState) : null;
  const incompatibleSchemaVersion =
    restoredState &&
    (restoredState.schemaVersion < 2 || restoredState.schemaVersion > RUNTIME_STATE_SCHEMA_VERSION)
      ? restoredState.schemaVersion
      : undefined;
  let recoveryReason: string | undefined;
  let allEvents: StoredEvent[] = [];
  try {
    allEvents = store.loadEventsStrict(params.threadId);
  } catch (error) {
    recoveryReason = error instanceof Error ? error.message : String(error);
  }
  const lastEventPosition = allEvents.at(-1)?.id ?? 0;
  if (snapshotRecord && snapshotRecord.metadata.eventPosition > lastEventPosition) {
    recoveryReason = `Runtime snapshot event position ${snapshotRecord.metadata.eventPosition} exceeds the last event position ${lastEventPosition}.`;
  }
  if (!recoveryReason && lastEventPosition > 0) {
    try {
      const snapshotPosition = snapshotRecord?.metadata.eventPosition ?? 0;
      const tail = allEvents.filter((entry) => entry.id > snapshotPosition);
      if (migratedState && snapshotRecord) {
        if (restoredState && restoredState.schemaVersion < 17) {
          migratedState = restoreLegacyTurnLifecycle(
            migratedState,
            allEvents.filter((entry) => entry.id <= snapshotPosition),
          );
        }
        migratedState = replayPersistedTail(
          migratedState,
          tail,
          params.threadId,
          restoredState?.schemaVersion ?? RUNTIME_STATE_SCHEMA_VERSION,
        );
      }
    } catch (error) {
      recoveryReason = error instanceof Error ? error.message : String(error);
    }
  }
  const initialState =
    !recoveryReason &&
    incompatibleSchemaVersion == null &&
    migratedState?.session.threadId === params.threadId
      ? (() => {
          // A restored snapshot may carry a stale interaction mode from a
          // previous run.  Apply the explicitly-requested params so the
          // restored state reflects the current user intent.
          let state = migratedState;
          if (params.interactionMode && state.mode !== params.interactionMode) {
            state = { ...state, mode: params.interactionMode };
          }
          if (
            params.authorizationMode !== undefined &&
            state.authorization.mode !== params.authorizationMode
          ) {
            state = {
              ...state,
              authorization: { ...state.authorization, mode: params.authorizationMode },
            };
          }
          return state;
        })()
      : incompatibleSchemaVersion != null
        ? {
            ...freshState,
            recoveryState: {
              kind: 'incompatible' as const,
              schemaVersion: incompatibleSchemaVersion,
            },
          }
        : recoveryReason || lastEventPosition > 0
          ? {
              ...freshState,
              recoveryState: {
                kind: 'corrupted' as const,
                reason:
                  recoveryReason ??
                  'Runtime snapshot is missing, invalid, or failed checksum validation.',
              },
            }
          : freshState;

  return {
    state: initialState,
    migratedSnapshot:
      migratedState && migratedState !== restoredState && initialState === migratedState
        ? migratedState
        : null,
    restoreBoundary: {
      snapshot: snapshotRecord?.metadata ?? null,
      lastEventPosition,
    },
  };
}

function replayPersistedTail(
  state: RuntimeState,
  tail: StoredEvent[],
  threadId: string,
  sourceSchemaVersion: number,
): RuntimeState {
  let current = state;
  for (const entry of tail) {
    if (!entry.event_id || !entry.revision || !entry.occurred_at) {
      throw new Error(`Runtime event ${entry.id} is missing envelope metadata.`);
    }
    if (entry.thread_id !== threadId) {
      throw new Error(`Runtime event ${entry.id} belongs to another thread.`);
    }
    if (entry.revision !== current.revision + 1) {
      throw new Error(
        `Runtime event ${entry.id} revision mismatch: expected ${current.revision + 1}, received ${entry.revision}.`,
      );
    }
    const reduced =
      sourceSchemaVersion < RUNTIME_STATE_SCHEMA_VERSION
        ? reduceRuntimeStateFromHistoricalSchema(current, entry.event, sourceSchemaVersion)
        : reduceRuntimeState(current, entry.event);
    current = {
      ...reduced,
      revision: entry.revision,
      lastAppliedEventId: entry.event_id,
      appliedEventIds: [...(reduced.appliedEventIds ?? []), entry.event_id].slice(-4096),
    };
    assertRuntimeStateInvariants(current);
  }
  return current;
}

function restoreLegacyTurnLifecycle(state: RuntimeState, events: StoredEvent[]): RuntimeState {
  let turn = state.turn;
  for (const entry of events) {
    const event = entry.event;
    if (event.type === 'turn.started' && event.turnId === turn.turnId) {
      turn = { turnId: turn.turnId, turnIndex: turn.turnIndex, status: 'active' };
    } else if (event.type === 'turn.completed' && event.turnId === turn.turnId) {
      turn = { ...turn, status: 'completed' };
    } else if (event.type === 'turn.aborted' && event.turnId === turn.turnId) {
      turn = {
        ...turn,
        status: 'aborted',
        abortReason: event.reason,
        ...(event.cause ? { abortCause: event.cause } : {}),
      };
    }
  }
  return turn === state.turn ? state : { ...state, turn };
}

function migrateRuntimeState(snapshot: RuntimeState): RuntimeState | null {
  const normalizedSnapshot = snapshot;

  if (snapshot.schemaVersion === RUNTIME_STATE_SCHEMA_VERSION)
    return normalizeRuntimeMetadata(normalizedSnapshot, snapshot.schemaVersion);
  if (snapshot.schemaVersion < 2 || snapshot.schemaVersion > RUNTIME_STATE_SCHEMA_VERSION)
    return null;

  const legacyApprovalInteraction =
    normalizedSnapshot.schemaVersion < 4 &&
    normalizedSnapshot.interactions.kind === 'awaiting_tool_approval'
      ? normalizedSnapshot.interactions
      : undefined;
  const legacyMarker = legacyApprovalInteraction?.approval.subagentId
    ? {
        toolCallId: legacyApprovalInteraction.toolCallId,
        subagentId: legacyApprovalInteraction.approval.subagentId,
        reason: 'A legacy sub-agent approval cannot be resumed after recovery.',
      }
    : undefined;
  // Build the migrated state before upgrading the version so all v2 fields are
  // preserved and the recovery marker is durable with the schema transition.
  let migratedState: RuntimeState = {
    ...normalizeRuntimeMetadata(normalizedSnapshot, snapshot.schemaVersion),
    schemaVersion: RUNTIME_STATE_SCHEMA_VERSION,
    verification: (normalizedSnapshot as Partial<RuntimeState>).verification ?? { records: {} },
    context: normalizeContextRuntimeState((normalizedSnapshot as Partial<RuntimeState>).context),
    resourceBudget:
      snapshot.schemaVersion >= 18
        ? normalizeResourceBudgetMetadata(
            (snapshot as Partial<RuntimeState>).resourceBudget ??
              createLegacyResourceBudgetStateV1(snapshot.schemaVersion),
          )
        : createLegacyResourceBudgetStateV1(snapshot.schemaVersion),
    providerAdmission: (normalizedSnapshot as Partial<RuntimeState>).providerAdmission ?? {
      pending: [],
      waivers: {},
    },
    capabilities: {
      catalogRevision: snapshot.capabilities?.catalogRevision ?? '',
      bindings: snapshot.capabilities?.bindings ?? {},
      disclosures: snapshot.capabilities?.disclosures ?? {},
      loadedCapabilities: snapshot.capabilities?.loadedCapabilities ?? {},
      ...(snapshot.capabilities?.pendingSearch
        ? { pendingSearch: snapshot.capabilities.pendingSearch }
        : {}),
      invocations: snapshot.capabilities?.invocations ?? {},
    },
    skills: snapshot.skills ?? { catalogRevision: '', frames: {} },
    toolRecovery: (normalizedSnapshot as Partial<RuntimeState>).toolRecovery
      ? normalizeToolRecoveryJournalV1((normalizedSnapshot as Partial<RuntimeState>).toolRecovery)
      : createToolRecoveryJournalV1(),
    ...(legacyMarker ? { legacyUnrecoverableSubagentApproval: legacyMarker } : {}),
  };

  if (snapshot.schemaVersion < 4) {
    const legacyTaskId = `legacy-${snapshot.session.threadId}`;
    const legacyPlanning = snapshot.planning;
    const legacyTask = {
      taskId: legacyTaskId,
      userGoal:
        [...(snapshot.transcript?.messages ?? [])]
          .reverse()
          .find((message) => message.kind === 'user')?.content ?? '',
      status:
        legacyPlanning.kind === 'completed'
          ? ('completed' as const)
          : legacyPlanning.kind === 'cancelled'
            ? ('cancelled' as const)
            : ('active' as const),
      startedAtTurnId: snapshot.turn.turnId,
      sideEffectsStarted: false,
      planning: legacyPlanning,
      planHistory: [],
      ...(legacyPlanning.kind === 'completed'
        ? { completedAtTurnId: legacyPlanning.completedAtTurnId }
        : {}),
    };
    migratedState = {
      ...migratedState,
      activeTaskId: snapshot.activeTaskId ?? (legacyTask.status === 'active' ? legacyTaskId : null),
      tasks:
        snapshot.tasks && Object.keys(snapshot.tasks).length > 0
          ? snapshot.tasks
          : { [legacyTaskId]: legacyTask },
    };
  }

  return materializeLegacyPlanArtifacts(migratedState);
}

function normalizeRuntimeMetadata(
  state: RuntimeState,
  sourceSchemaVersion = state.schemaVersion,
): RuntimeState {
  const raw = state as RuntimeState & {
    revision?: number;
    appliedEventIds?: string[];
    recoveryState?: RuntimeState['recoveryState'];
    context?: RuntimeState['context'];
    resourceBudget?: RuntimeState['resourceBudget'];
    turn: RuntimeState['turn'] & {
      status?: RuntimeState['turn']['status'];
    };
  };
  return {
    ...state,
    revision: Number.isInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0,
    appliedEventIds: Array.isArray(raw.appliedEventIds) ? raw.appliedEventIds.slice(-4096) : [],
    recoveryState: raw.recoveryState ?? { kind: 'normal' },
    context: normalizeContextRuntimeState(raw.context),
    resourceBudget: normalizeResourceBudgetMetadata(
      raw.resourceBudget ?? createLegacyResourceBudgetStateV1(17),
    ),
    toolRecovery:
      sourceSchemaVersion < TOOL_OUTCOME_RECOVERY_STATE_SCHEMA_VERSION
        ? raw.toolRecovery
          ? normalizeToolRecoveryJournalV1(raw.toolRecovery)
          : createToolRecoveryJournalV1()
        : normalizeToolRecoveryJournalV1(raw.toolRecovery),
    turn: {
      ...state.turn,
      status:
        raw.turn.status === 'completed' || raw.turn.status === 'aborted'
          ? raw.turn.status
          : 'active',
    },
    transcript: {
      ...state.transcript,
      messages: (state.transcript?.messages ?? []).map((message, ordinal) => ({
        ...message,
        messageId:
          message.messageId ??
          (message.kind === 'tool'
            ? `tool-${message.toolCallId}`
            : `legacy-${state.session.threadId}-${ordinal}`),
        turnId: message.turnId ?? state.turn.turnId,
        ordinal: Number.isInteger(message.ordinal) ? message.ordinal : ordinal,
        createdAt: message.createdAt ?? new Date(0).toISOString(),
      })),
    },
    capabilities: {
      catalogRevision: state.capabilities?.catalogRevision ?? '',
      bindings: state.capabilities?.bindings ?? {},
      disclosures: state.capabilities?.disclosures ?? {},
      loadedCapabilities: state.capabilities?.loadedCapabilities ?? {},
      ...(state.capabilities?.pendingSearch
        ? { pendingSearch: state.capabilities.pendingSearch }
        : {}),
      invocations: state.capabilities?.invocations ?? {},
    },
    suspendedSubagents: Object.fromEntries(
      Object.entries(state.suspendedSubagents ?? {}).map(([toolCallId, snapshot]) => [
        toolCallId,
        snapshot.toolRecovery
          ? snapshot
          : {
              ...snapshot,
              toolRecovery: (sourceSchemaVersion < TOOL_OUTCOME_RECOVERY_STATE_SCHEMA_VERSION
                ? createToolRecoveryJournalV1()
                : normalizeToolRecoveryJournalV1(undefined)) as unknown as NonNullable<
                RuntimeState['suspendedSubagents'][string]['toolRecovery']
              >,
            },
      ]),
    ),
  };
}

function normalizeResourceBudgetMetadata(
  budget: RuntimeState['resourceBudget'],
): RuntimeState['resourceBudget'] {
  if (budget.status !== 'active') return budget;
  const legacy = budget as RuntimeState['resourceBudget'] & {
    waiters?: Extract<RuntimeState['resourceBudget'], { status: 'active' }>['waiters'];
    nextWaiterSequence?: number;
  };
  return {
    ...budget,
    waiters: legacy.waiters ?? {},
    nextWaiterSequence: legacy.nextWaiterSequence ?? 0,
  };
}

/** Materialize inline legacy PlanDocument bodies without changing their versions. */
function materializeLegacyPlanArtifacts(state: RuntimeState): RuntimeState {
  let changed = false;
  const tasks = Object.fromEntries(
    Object.entries(state.tasks).map(([taskId, task]) => {
      const materialize = (document: import('@/protocol/events').PlanDocument) => {
        if (document.artifact) return document;
        const withDigest = document.structuralDigest
          ? document
          : { ...document, structuralDigest: computePlanStructuralDigest(document) };
        try {
          const artifact = defaultPlanArtifactStore.write(taskId, withDigest);
          changed = true;
          return { ...withDigest, artifact };
        } catch {
          // Keep the legacy inline document usable if the user artifact directory is unavailable.
          return withDigest;
        }
      };
      const planning = task.planning;
      const nextPlanning =
        'document' in planning && planning.document
          ? { ...planning, document: materialize(planning.document) }
          : planning;
      const planHistory = task.planHistory.map(materialize);
      return [taskId, { ...task, planning: nextPlanning, planHistory }] as const;
    }),
  );
  if (!changed) return state;
  const active = state.activeTaskId ? tasks[state.activeTaskId] : undefined;
  return {
    ...state,
    tasks,
    planning: active?.planning ?? state.planning,
  };
}
