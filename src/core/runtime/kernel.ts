// ── Agent Runtime Kernel 核心协调器 / Agent Runtime Kernel core coordinator ──
// AgentKernel 封装 RuntimeState 管理、事件管道和策略决策。
// RuntimeState、事件持久化和效果执行调度的统一入口。
//
// AgentKernel encapsulates RuntimeState management, event pipeline,
// and policy decisions.  Single entry point for state, persistence, and effect dispatch.

import { createHash } from 'node:crypto';
import type { ModelArtifactStoreV1 } from '@/core/model/model-artifacts';
import { canonicalModelJsonV1 } from '@/core/model/surface-canonicalizer';
import {
  type CapabilityArtifactReaderV1,
  readBoundCapabilityArtifactV1,
} from '@/core/persistence/capability-artifacts';
import { PrivateArtifactStorageError } from '@/core/persistence/private-immutable-artifacts';
import { assertAuthorizationElevation, createModePolicy } from '@/core/policies/mode-policy';
import type { RuntimePolicy } from '@/core/policies/runtime-policy';
import type { AuthorizationSource } from '@/core/types';
import type { AuthorizationMode, InteractionMode } from '@/protocol/events';
import {
  eventsForRuntimeAction,
  type RuntimeActionResult,
  type RuntimeUserAction,
} from './actions';
import type { RuntimeEffect, RuntimeEffectLease } from './effects';
import type { RuntimeEvent, RuntimeEventEnvelope } from './events';
import { createLiveRuntimeIdSourceV1, type RuntimeIdSourceV1 } from './id-source';
import { assertRuntimeStateInvariants } from './invariants';
import { reduceRuntimeState } from './reducer';
import { decideNextEffect } from './scheduler';
import {
  createInitialRuntimeState,
  getEffectiveInteractionMode,
  RUNTIME_STATE_FORMAT_EPOCH,
  RUNTIME_STATE_SCHEMA_VERSION,
  type RuntimeState,
} from './state';
import {
  assertRuntimeStoreCanOpen,
  createRuntimeStore,
  type RuntimeEventMetadata,
  type RuntimeRestoreBoundary,
  type RuntimeStore,
  type StoredEvent,
} from './store';
import { normalizeTerminalRuntimeEventV1 } from './terminal-outcome';
import { normalizeCurrentToolOutcomeEventV1 } from './tool-outcome-events';

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
  /** Explicit evaluation determinism source; production callers use the live default. */
  runtimeIdSource?: RuntimeIdSourceV1;
}

/** Executes an effect and returns facts for the Kernel to reduce/persist. */
export type RuntimeEffectEventSink = (event: RuntimeEvent) => void;

/**
 * An effect is owned elsewhere and must be retried instead of being mistaken
 * for a terminal empty result.  This is deliberately distinct from `[]`:
 * the latter remains the legacy "no facts" executor contract.
 */
export interface RuntimeEffectDeferred extends Array<RuntimeEvent> {
  deferred: {
    reason: string;
    retryAfterMs: number;
  };
}

export function deferredRuntimeEffect(reason: string, retryAfterMs: number): RuntimeEffectDeferred {
  return Object.assign([], { deferred: { reason, retryAfterMs } });
}

export function isRuntimeEffectDeferred(result: RuntimeEvent[]): result is RuntimeEffectDeferred {
  return 'deferred' in result;
}

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
  private readonly runtimeIdSource: RuntimeIdSourceV1;

  constructor(config: KernelConfig) {
    this.store = config.store;
    this.state = config.initialState;
    this.sandboxAvailable = config.sandboxAvailable ?? false;
    this.runtimeIdSource = config.runtimeIdSource ?? createLiveRuntimeIdSourceV1();
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
    const completedEvents = this.attachSuspendedCapabilityTerminals(events);
    for (const event of completedEvents) {
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
    const runnerId = this.runtimeIdSource.next('kernel_runner');
    this.activeRunnerId = runnerId;
    return runnerId;
  }

  /** Release a runner lease only if it still belongs to the caller. */
  releaseRunner(runnerId: string): void {
    if (this.activeRunnerId === runnerId) this.activeRunnerId = null;
  }

  beginEffect(effect: RuntimeEffect): RuntimeEffectLease {
    return {
      effectId: this.runtimeIdSource.next('kernel_effect'),
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
    this.assertToolTerminalBatch(lease, events);
    this.processEventBatch(events);
    lease.expectedRevision = this.state.revision;
    return true;
  }

  private assertToolTerminalBatch(lease: RuntimeEffectLease, events: RuntimeEvent[]): void {
    if (lease.effect.type !== 'run_tools') return;
    const capabilityTerminals = events.filter(
      (
        event,
      ): event is Extract<
        RuntimeEvent,
        {
          type:
            | 'capability.execution_succeeded'
            | 'capability.execution_failed'
            | 'capability.execution_unknown';
        }
      > =>
        event.type === 'capability.execution_succeeded' ||
        event.type === 'capability.execution_failed' ||
        event.type === 'capability.execution_unknown',
    );
    for (const terminal of capabilityTerminals) {
      const invocation = this.state.capabilities.invocations[terminal.invocationId];
      if (!invocation?.receiptRequirement) continue;
      if (
        (terminal.type === 'capability.execution_succeeded' ||
          terminal.type === 'capability.execution_failed') &&
        (!terminal.artifact ||
          !('kind' in terminal.artifact) ||
          terminal.artifact.kind !== 'capability_result')
      ) {
        throw new Error('Governed capability terminal requires a private result Artifact.');
      }
      const matchingToolTerminal = events.some(
        (event) =>
          (event.type === 'tool.finished' ||
            event.type === 'tool.failed' ||
            event.type === 'tool.rejected' ||
            event.type === 'tool.cancelled') &&
          event.toolCallId === invocation.toolCallId,
      );
      if (!matchingToolTerminal) {
        throw new Error('Capability receipt and Tool terminal must commit in one atomic batch.');
      }
    }
    for (const event of events) {
      if (event.type === 'verification.requested') {
        const sourceIds = event.spec.checks.flatMap((check) => {
          if (check.type === 'schema' && check.subject.kind === 'capability_artifact') {
            return [check.subject.invocationId];
          }
          if (check.type === 'mcp_read_after_write' || check.type === 'external_reference') {
            return [check.invocationId];
          }
          return check.type === 'reviewer' ? (check.invocationIds ?? []) : [];
        });
        for (const invocationId of sourceIds) {
          const invocation = this.state.capabilities.invocations[invocationId];
          if (!invocation?.receiptRequirement) continue;
          if (
            !capabilityTerminals.some(
              (terminal) =>
                terminal.type === 'capability.execution_succeeded' &&
                terminal.invocationId === invocationId,
            )
          ) {
            throw new Error('Verification cannot reference an uncommitted capability receipt.');
          }
        }
      }
    }
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
        new Date(this.runtimeIdSource.now()).toISOString(),
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
    if (
      event.type === 'capability.execution_started' ||
      event.type === 'capability.execution_succeeded' ||
      event.type === 'capability.execution_failed' ||
      event.type === 'capability.execution_unknown'
    ) {
      const invocation = state.capabilities.invocations[event.invocationId];
      if (!invocation || !lease.effect.toolCallIds.includes(invocation.toolCallId)) return false;
      const call = state.tools.calls[invocation.toolCallId];
      return (
        call?.name === 'shell_execute' &&
        (call.status === 'queued' || call.status === 'approved' || call.status === 'running')
      );
    }
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
      case 'capability.invocation_recorded':
        return call.status === 'queued' || call.status === 'approved' || call.status === 'running';
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
        if (isRuntimeEffectDeferred(events)) {
          return { type: 'busy', reason: events.deferred.reason };
        }
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

  /**
   * A Runtime-owned interaction may outlive the adapter effect that created it.
   * Close its prepared capability receipt in the same atomic action batch as
   * the eventual Tool terminal; missing prepared evidence becomes unknown.
   */
  private attachSuspendedCapabilityTerminals(events: RuntimeEvent[]): RuntimeEvent[] {
    const output: RuntimeEvent[] = [];
    for (const event of events) {
      const toolTerminal =
        event.type === 'tool.finished' ||
        event.type === 'tool.failed' ||
        event.type === 'tool.rejected' ||
        event.type === 'tool.cancelled';
      if (!toolTerminal) {
        output.push(event);
        continue;
      }
      const invocation = Object.values(this.state.capabilities.invocations).find(
        (candidate) =>
          candidate.toolCallId === event.toolCallId &&
          candidate.status === 'running' &&
          Boolean(candidate.receiptRequirement),
      );
      if (
        !invocation ||
        output.some(
          (candidate) =>
            (candidate.type === 'capability.execution_succeeded' ||
              candidate.type === 'capability.execution_failed' ||
              candidate.type === 'capability.execution_unknown') &&
            candidate.invocationId === invocation.invocationId,
        )
      ) {
        output.push(event);
        continue;
      }
      const finishedAt = new Date(this.runtimeIdSource.now()).toISOString();
      if (!invocation.artifact || !invocation.resultDigest || !invocation.evidenceDigest) {
        output.push({
          type: 'capability.execution_unknown',
          invocationId: invocation.invocationId,
          reason: 'Suspended Tool terminal has no committed capability result evidence.',
          finishedAt,
        });
      } else if (event.type === 'tool.finished' && event.result.ok) {
        output.push({
          type: 'capability.execution_succeeded',
          invocationId: invocation.invocationId,
          resultDigest: invocation.resultDigest,
          evidenceDigest: invocation.evidenceDigest,
          finishedAt,
          artifact: invocation.artifact,
          ...(invocation.externalReferences
            ? { externalReferences: invocation.externalReferences }
            : {}),
        });
      } else {
        const error =
          event.type === 'tool.finished'
            ? event.result.stderr || 'Suspended Tool interaction did not succeed.'
            : event.type === 'tool.failed'
              ? event.failure.message
              : event.reason;
        output.push({
          type: 'capability.execution_failed',
          invocationId: invocation.invocationId,
          error,
          resultDigest: invocation.resultDigest,
          evidenceDigest: invocation.evidenceDigest,
          finishedAt,
          artifact: invocation.artifact,
        });
      }
      output.push(event);
    }
    return output;
  }

  private createEnvelope(
    event: RuntimeEvent,
    revision: number,
    normalizationState: RuntimeState = this.state,
  ): RuntimeEventEnvelope {
    const occurredAt = new Date(this.runtimeIdSource.now()).toISOString();
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
  modelArtifactEvidence?: ModelArtifactEvidenceAvailabilityV1;
  capabilityArtifactEvidence?: CapabilityArtifactReaderV1;
  runtimeIdSource?: RuntimeIdSourceV1;
}): AgentKernel {
  assertRuntimeStoreCanOpen(params.storePath, params.threadId);
  const store = createRuntimeStore(params.storePath);
  let restoredState: RuntimeState;
  try {
    restoredState = restoreRuntimeStateFromStore({ ...params, store }).state;
  } catch (error) {
    store.close();
    throw error;
  }

  const runtimeIdSource = params.runtimeIdSource ?? createLiveRuntimeIdSourceV1();
  const kernel = new AgentKernel({
    store,
    initialState: restoredState,
    interactionMode: params.interactionMode ?? 'accept_edits',
    sandboxAvailable: params.sandboxAvailable,
    runtimeIdSource,
  });
  // A persisted intent without a terminal provider result is deliberately not
  // replayed.  Record the uncertainty durably so a later reconciliation/user
  // decision can resolve it without issuing a duplicate external write.
  for (const invocation of Object.values(kernel.getState().capabilities.invocations)) {
    if (invocation.status !== 'recorded' && invocation.status !== 'running') continue;
    // A suspended task adapter has a durable continuation and remains resumable;
    // it is not an orphaned external dispatch merely because the process restarted.
    if (kernel.getState().suspendedSubagents[invocation.toolCallId]) continue;
    const suspendedCall = kernel.getState().tools.calls[invocation.toolCallId];
    if (
      suspendedCall &&
      (suspendedCall.status === 'awaiting_review' ||
        suspendedCall.status === 'awaiting_approval' ||
        suspendedCall.status === 'awaiting_auto_review' ||
        suspendedCall.status === 'awaiting_user_input')
    ) {
      continue;
    }
    kernel.processEvent({
      type: 'capability.execution_unknown',
      invocationId: invocation.invocationId,
      reason: 'Runtime recovered after invocation intent was persisted without a terminal result.',
      finishedAt: new Date(runtimeIdSource.now()).toISOString(),
    });
  }
  const evidenceUncertainReservations = new Set<string>();
  for (const invocation of Object.values(kernel.getState().modelInvocations)) {
    if (invocation.status === 'completed' && !invocation.modelEvidenceUnavailable) {
      const evidenceFailure = verifyCompletedModelInvocationEvidenceV1(
        invocation,
        params.modelArtifactEvidence,
      );
      if (evidenceFailure) {
        kernel.processEvent({
          type: 'model.invocation_evidence_unavailable',
          invocationId: invocation.invocationId,
          reasonCode: evidenceFailure,
        });
      }
      continue;
    }
    if (invocation.status !== 'prepared' && invocation.status !== 'dispatching') continue;
    const evidenceFailure = verifyPendingModelInvocationEvidenceV1(
      invocation,
      params.modelArtifactEvidence,
    );
    kernel.processEvent({
      type: 'model.invocation_interrupted',
      invocationId: invocation.invocationId,
      dispatchCertainty: invocation.status === 'prepared' ? 'none' : 'unknown',
      reasonCode: 'runtime_restored',
    });
    if (
      invocation.status === 'dispatching' &&
      evidenceFailure &&
      invocation.budget.kind === 'reservation'
    ) {
      evidenceUncertainReservations.add(invocation.budget.reservationId);
    }
  }
  const recoveredBudget = kernel.getState().resourceBudget;
  if (recoveredBudget.status === 'active') {
    for (const reservation of Object.values(recoveredBudget.reservations)) {
      if (reservation.state === 'reserved') {
        kernel.processEvent(
          evidenceUncertainReservations.has(reservation.reservationId)
            ? {
                type: 'resource_budget.unknown',
                reservationId: reservation.reservationId,
              }
            : {
                type: 'resource_budget.released',
                reservationId: reservation.reservationId,
              },
        );
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

export type ModelArtifactEvidenceAvailabilityV1 =
  | {
      status: 'available';
      reader: Pick<ModelArtifactStoreV1, 'readSurface' | 'readResponse'>;
    }
  | { status: 'unavailable'; reason: 'key_unavailable' };

function verifyPendingModelInvocationEvidenceV1(
  invocation: RuntimeState['modelInvocations'][string],
  evidence: ModelArtifactEvidenceAvailabilityV1 | undefined,
): 'artifact_missing' | 'artifact_corrupt' | 'key_unavailable' | undefined {
  if (!evidence) return undefined;
  if (evidence.status === 'unavailable') return evidence.reason;
  try {
    const surface = evidence.reader.readSurface(invocation.surfaceArtifact);
    if (
      invocation.surfaceArtifact.integrityIdentifier !== invocation.surfaceIntegrityIdentifier ||
      surface.route.routeFingerprint !== invocation.routeFingerprint
    ) {
      return 'artifact_corrupt';
    }
    return undefined;
  } catch (error) {
    return modelArtifactEvidenceFailureReasonV1(error);
  }
}

function verifyCompletedModelInvocationEvidenceV1(
  invocation: RuntimeState['modelInvocations'][string],
  evidence: ModelArtifactEvidenceAvailabilityV1 | undefined,
): 'artifact_missing' | 'artifact_corrupt' | 'key_unavailable' | undefined {
  if (!evidence) return undefined;
  const surfaceFailure = verifyPendingModelInvocationEvidenceV1(invocation, evidence);
  if (surfaceFailure) return surfaceFailure;
  if (evidence.status === 'unavailable') return evidence.reason;
  if (!invocation.responseArtifact) return 'artifact_corrupt';
  try {
    const response = evidence.reader.readResponse(invocation.responseArtifact);
    const surface = evidence.reader.readSurface(invocation.surfaceArtifact);
    if (
      response.invocationId !== invocation.invocationId ||
      response.surfaceIntegrityIdentifier !== invocation.surfaceIntegrityIdentifier ||
      canonicalModelJsonV1(response.route) !== canonicalModelJsonV1(surface.route)
    ) {
      return 'artifact_corrupt';
    }
    return undefined;
  } catch (error) {
    return modelArtifactEvidenceFailureReasonV1(error);
  }
}

function modelArtifactEvidenceFailureReasonV1(
  error: unknown,
): 'artifact_missing' | 'artifact_corrupt' | 'key_unavailable' {
  if (error instanceof PrivateArtifactStorageError) {
    if (error.code === 'artifact_missing') return 'artifact_missing';
    if (error.code === 'key_unavailable') return 'key_unavailable';
  }
  return 'artifact_corrupt';
}

interface RuntimeRestoreResult {
  state: RuntimeState;
  restoreBoundary: RuntimeRestoreBoundary;
}

function incompatibleRuntimeState(freshState: RuntimeState, snapshot: unknown): RuntimeState {
  const candidate = snapshot as { schemaVersion?: unknown; formatEpoch?: unknown };
  return {
    ...freshState,
    recoveryState: {
      kind: 'incompatible',
      schemaVersion: typeof candidate?.schemaVersion === 'number' ? candidate.schemaVersion : null,
      formatEpoch: typeof candidate?.formatEpoch === 'string' ? candidate.formatEpoch : null,
    },
  };
}

/** Restore only the exact current Runtime format. Historical formats fail closed. */
export function restoreRuntimeStateFromStore(params: {
  store: RuntimeStore;
  threadId: string;
  userId: string;
  workspace: string;
  interactionMode?: InteractionMode;
  authorizationMode?: AuthorizationMode;
  authorizationSource?: AuthorizationSource;
  phase?: 'planning' | 'building';
  capabilityArtifactEvidence?: CapabilityArtifactReaderV1;
  runtimeIdSource?: RuntimeIdSourceV1;
}): RuntimeRestoreResult {
  const freshState = createInitialRuntimeState({
    threadId: params.threadId,
    userId: params.userId,
    workspace: params.workspace,
    interactionMode: params.interactionMode ?? 'accept_edits',
    authorizationMode: params.authorizationMode,
    authorizationSource: params.authorizationSource,
    phase: params.phase,
    runtimeIdSource: params.runtimeIdSource,
  });
  const snapshotRecord = params.store.loadSnapshotRecord<unknown>(params.threadId);
  const lastEventPosition = params.store.getLastEventPosition(params.threadId);
  const restoreBoundary: RuntimeRestoreBoundary = {
    snapshot: snapshotRecord?.metadata ?? null,
    lastEventPosition,
  };

  if (!snapshotRecord) {
    return {
      state:
        lastEventPosition === 0
          ? freshState
          : {
              ...freshState,
              recoveryState: {
                kind: 'corrupted',
                reason: 'Runtime events exist without a current-format snapshot.',
              },
            },
      restoreBoundary,
    };
  }

  const candidate = snapshotRecord.state as {
    schemaVersion?: unknown;
    formatEpoch?: unknown;
    session?: { threadId?: unknown };
  };
  if (
    candidate.schemaVersion !== RUNTIME_STATE_SCHEMA_VERSION ||
    snapshotRecord.metadata.schemaVersion !== RUNTIME_STATE_SCHEMA_VERSION ||
    candidate.formatEpoch !== RUNTIME_STATE_FORMAT_EPOCH
  ) {
    return {
      state: incompatibleRuntimeState(freshState, snapshotRecord.state),
      restoreBoundary,
    };
  }

  let state = snapshotRecord.state as RuntimeState;
  try {
    if (candidate.session?.threadId !== params.threadId) {
      throw new Error('Runtime snapshot belongs to another thread.');
    }
    if (snapshotRecord.metadata.eventPosition > lastEventPosition) {
      throw new Error('Runtime snapshot event position exceeds the last durable event position.');
    }
    // MS-04 is an additive evidence migration inside the current format epoch.
    // Snapshots written earlier in the same epoch have no model invocation index.
    // Normalize only that absent additive field; no historical Surface is inferred.
    if (!('modelInvocations' in (state as unknown as Record<string, unknown>))) {
      state = { ...state, modelInvocations: {} };
    }
    assertRuntimeStateInvariants(state);
    state = replayCurrentTail(
      state,
      params.store.loadEventsStrict(params.threadId, snapshotRecord.metadata.eventPosition),
      params.threadId,
    );
    if (params.capabilityArtifactEvidence) {
      assertRestoredFilesystemArtifactEvidenceV1(state, params.capabilityArtifactEvidence);
    }
  } catch (error) {
    return {
      state: {
        ...freshState,
        recoveryState: {
          kind: 'corrupted',
          reason: error instanceof Error ? error.message : String(error),
        },
      },
      restoreBoundary,
    };
  }

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
  return { state, restoreBoundary };
}

function assertRestoredFilesystemArtifactEvidenceV1(
  state: Readonly<RuntimeState>,
  reader: CapabilityArtifactReaderV1,
): void {
  for (const invocation of Object.values(state.capabilities.invocations)) {
    if (!invocation.filesystemObservation) continue;
    if (
      invocation.status !== 'succeeded' ||
      !invocation.artifact ||
      !invocation.resultDigest ||
      !invocation.evidenceDigest
    ) {
      throw new Error(
        `Filesystem invocation ${invocation.invocationId} has incomplete Artifact evidence.`,
      );
    }
    readBoundCapabilityArtifactV1(reader, invocation.artifact, {
      invocationId: invocation.invocationId,
      resultDigest: invocation.resultDigest,
      evidenceDigest: invocation.evidenceDigest,
      filesystemObservation: invocation.filesystemObservation,
    });
  }
}

function replayCurrentTail(
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
      appliedEventIds: [...reduced.appliedEventIds, entry.event_id].slice(-4096),
    };
    assertRuntimeStateInvariants(current);
  }
  return current;
}
