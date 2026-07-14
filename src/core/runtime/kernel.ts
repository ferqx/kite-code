// ── Agent Runtime Kernel 核心协调器 / Agent Runtime Kernel core coordinator ──
// AgentKernel 封装 RuntimeState 管理、事件管道和策略决策。
// RuntimeState、事件持久化和效果执行调度的统一入口。
//
// AgentKernel encapsulates RuntimeState management, event pipeline,
// and policy decisions.  Single entry point for state, persistence, and effect dispatch.

import { createHash } from 'node:crypto';
import { defaultPlanArtifactStore } from '@/core/persistence/plan-artifacts';
import { createModePolicy } from '@/core/policies/mode-policy';
import type { RuntimePolicy } from '@/core/policies/runtime-policy';
import type { AuthorizationSource } from '@/core/types';
import type { AuthorizationMode, InteractionMode } from '@/protocol/events';
import {
  eventsForRuntimeAction,
  type RuntimeActionResult,
  type RuntimeUserAction,
} from './actions';
import type { RuntimeEffect, RuntimeEffectLease } from './effects';
import {
  isRuntimeEventEnvelope,
  type RuntimeEvent,
  type RuntimeEventEnvelope,
  type RuntimeEventInput,
} from './events';
import { assertRuntimeStateInvariants } from './invariants';
import { reduceRuntimeState } from './reducer';
import { decideNextEffect } from './scheduler';
import {
  computePlanStructuralDigest,
  createInitialRuntimeState,
  getEffectiveInteractionMode,
  RUNTIME_STATE_SCHEMA_VERSION,
  type RuntimeState,
} from './state';
import {
  createRuntimeStore,
  type RuntimeEventMetadata,
  type RuntimeStore,
  type StoredEvent,
} from './store';

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
  processEvent(event: RuntimeEventInput): { status: 'applied' | 'duplicate'; eventId: string } {
    const envelope = this.createEnvelope(event, this.state.revision + 1);
    if (this.appliedEventIds.has(envelope.eventId)) {
      return { status: 'duplicate', eventId: envelope.eventId };
    }

    const nextState = this.reduceEnvelope(this.state, envelope);
    // Atomic persist events + snapshot before publishing the new in-memory state.
    this.store.appendEventsAndSnapshot(this.state.session.threadId, [envelope.payload], nextState, [
      this.metadataFor(envelope),
    ]);
    this.state = nextState;
    this.appliedEventIds.add(envelope.eventId);
    if (envelope.payload.type === 'run.completed') {
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
  processEventBatch(events: RuntimeEventInput[]): void {
    if (events.length === 0) return;
    let nextState = this.state;
    const payloads: RuntimeEvent[] = [];
    const metadata: RuntimeEventMetadata[] = [];
    const batchEventIds: string[] = [];
    const batchSeen = new Set(this.appliedEventIds);
    for (const event of events) {
      const envelope = this.createEnvelope(event, nextState.revision + 1);
      if (batchSeen.has(envelope.eventId)) continue;
      nextState = this.reduceEnvelope(nextState, envelope);
      payloads.push(envelope.payload);
      metadata.push(this.metadataFor(envelope));
      batchSeen.add(envelope.eventId);
      batchEventIds.push(envelope.eventId);
    }
    if (payloads.length === 0) return;
    this.store.appendEventsAndSnapshot(this.state.session.threadId, payloads, nextState, metadata);
    this.state = nextState;
    for (const eventId of batchEventIds) this.appliedEventIds.add(eventId);
  }

  /**
   * 批量处理多个 RuntimeEvent。
   * Process multiple RuntimeEvents in batch.
   */
  processEvents(events: RuntimeEventInput[]): void {
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
  applyEffectResult(lease: RuntimeEffectLease, events: RuntimeEventInput[]): boolean {
    if (lease.expectedRevision !== this.state.revision || lease.turnId !== this.state.turn.turnId) {
      return false;
    }
    this.processEventBatch(events);
    return true;
  }

  /**
   * Apply one event produced while an effect is still running.
   * Streaming events advance the lease revision so the final effect result
   * remains subject to the same stale-result check as a batch result.
   */
  applyEffectEvent(lease: RuntimeEffectLease, event: RuntimeEventInput): boolean {
    if (lease.expectedRevision !== this.state.revision || lease.turnId !== this.state.turn.turnId) {
      return false;
    }
    this.processEvent(event);
    lease.expectedRevision = this.state.revision;
    return true;
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
  applyAction(action: RuntimeUserAction): RuntimeActionResult {
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
          interactionId: action.interactionId,
          reason,
        },
      };
    }
    this.processEventBatch(events);
    return { status: 'applied', events };
  }

  private createEnvelope(event: RuntimeEventInput, revision: number): RuntimeEventEnvelope {
    if (isRuntimeEventEnvelope(event)) {
      if (event.threadId !== this.state.session.threadId) {
        throw new Error(`Runtime event thread mismatch: ${event.threadId}.`);
      }
      return event;
    }
    const serialized = JSON.stringify(event);
    const eventId = createHash('sha256').update(serialized).digest('hex');
    return {
      eventId,
      threadId: this.state.session.threadId,
      revision,
      occurredAt: new Date().toISOString(),
      payload: event,
    };
  }

  private reduceEnvelope(state: RuntimeState, envelope: RuntimeEventEnvelope): RuntimeState {
    if (envelope.revision !== state.revision + 1) {
      throw new Error(
        `Runtime revision mismatch: expected ${state.revision + 1}, received ${envelope.revision}.`,
      );
    }
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
  const lastEventPosition = store.getLastEventPosition(params.threadId);
  if (snapshotRecord && snapshotRecord.metadata.eventPosition > lastEventPosition) {
    recoveryReason = `Runtime snapshot event position ${snapshotRecord.metadata.eventPosition} exceeds the last event position ${lastEventPosition}.`;
  }
  if (!recoveryReason && lastEventPosition > 0) {
    try {
      const allEvents = store.loadEventsStrict(params.threadId);
      const snapshotPosition = snapshotRecord?.metadata.eventPosition ?? 0;
      const tail = allEvents.filter((entry) => entry.id > snapshotPosition);
      if (migratedState && snapshotRecord) {
        migratedState = replayPersistedTail(migratedState, tail, params.threadId);
      }
    } catch (error) {
      recoveryReason = error instanceof Error ? error.message : String(error);
    }
  }
  const initialState =
    !recoveryReason &&
    incompatibleSchemaVersion == null &&
    migratedState?.session.threadId === params.threadId
      ? migratedState
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

  if (migratedState && migratedState !== restoredState && initialState === migratedState) {
    store.saveSnapshot(params.threadId, migratedState);
  }

  const kernel = new AgentKernel({
    store,
    initialState,
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
  return kernel;
}

function replayPersistedTail(
  state: RuntimeState,
  tail: StoredEvent[],
  threadId: string,
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
    const reduced = reduceRuntimeState(current, entry.event);
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

function migrateRuntimeState(snapshot: RuntimeState): RuntimeState | null {
  if (snapshot.schemaVersion === RUNTIME_STATE_SCHEMA_VERSION)
    return normalizeRuntimeMetadata(snapshot);
  if (snapshot.schemaVersion < 2 || snapshot.schemaVersion > RUNTIME_STATE_SCHEMA_VERSION)
    return null;

  const legacyApprovalInteraction =
    snapshot.schemaVersion < 4 && snapshot.interactions.kind === 'awaiting_tool_approval'
      ? snapshot.interactions
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
    ...normalizeRuntimeMetadata(snapshot),
    schemaVersion: RUNTIME_STATE_SCHEMA_VERSION,
    suspendedSubagents: snapshot.suspendedSubagents ?? {},
    capabilities: {
      catalogRevision: snapshot.capabilities?.catalogRevision ?? '',
      bindings: snapshot.capabilities?.bindings ?? {},
      invocations: snapshot.capabilities?.invocations ?? {},
    },
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

function normalizeRuntimeMetadata(state: RuntimeState): RuntimeState {
  const raw = state as RuntimeState & {
    revision?: number;
    appliedEventIds?: string[];
    recoveryState?: RuntimeState['recoveryState'];
  };
  return {
    ...state,
    revision: Number.isInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0,
    appliedEventIds: Array.isArray(raw.appliedEventIds) ? raw.appliedEventIds.slice(-4096) : [],
    recoveryState: raw.recoveryState ?? { kind: 'normal' },
    capabilities: {
      catalogRevision: state.capabilities?.catalogRevision ?? '',
      bindings: state.capabilities?.bindings ?? {},
      invocations: state.capabilities?.invocations ?? {},
    },
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
