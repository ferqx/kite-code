// ── Agent Runtime Kernel 核心协调器 / Agent Runtime Kernel core coordinator ──
// AgentKernel 封装 RuntimeState 管理、事件管道和策略决策。
// RuntimeState、事件持久化和效果执行调度的统一入口。
//
// AgentKernel encapsulates RuntimeState management, event pipeline,
// and policy decisions.  Single entry point for state, persistence, and effect dispatch.

import { createHash } from 'node:crypto';
import {
  assertContextPrimarySuccessBatchV2,
  validateRestoredContextReclaimStateV1,
} from '@/core/model/context-reclaim-commit';
import { deriveCheckpointV3ReboundV1 } from '@/core/model/context-working-set';
import {
  buildSummarySourceIdentityForCurrentPrefixV1,
  type ProviderDispatchEntryGuardV1,
} from '@/core/model/progressive-context-orchestrator';
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
import {
  isRuntimeEventEnvelope,
  type RuntimeEvent,
  type RuntimeEventEnvelope,
  type RuntimeEventInput,
} from './events';
import { classifyFailure } from './failures';
import { assertRuntimeStateInvariants } from './invariants';
import { isLegacyCheckpointV2, readLegacyCheckpointV2ReadOnly } from './legacy-slice-b-reader';
import { reduceRuntimeState } from './reducer';
import { createLegacyResourceBudgetStateV1, type ResourceUsageV1 } from './resource-budget';
import {
  assertCanonicalRuntimeEventEnvelopeV24,
  buildRuntimeEventEnvelopeV24,
  canonicalRuntimeEventEnvelopeBytesV24,
  isEphemeralRuntimeEventV24,
  type RuntimeEventEnvelopeV24,
  runtimeEventCausationIdV24,
} from './runtime-event-v24';
import {
  advanceRuntimeStorageFormatV24,
  bindMigratedRuntimeLedgerEvidenceV24,
  createMigratedRuntimeStorageFormatV24,
} from './runtime-storage-v24';
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
  type RuntimeMigrationIdentityV1,
  type RuntimePersistenceIdentityV1,
  type RuntimeStore,
  type StoredEvent,
} from './store';
import { assertSummaryLifecycleBatchV1 } from './summary-lifecycle-v1';
import { failedTerminalOutcomeV1, normalizeTerminalRuntimeEventV1 } from './terminal-outcome';
import {
  assertToolTerminalControlBatchV2,
  finalizeToolTerminalBatchV2,
  finalizeToolTerminalEventV2,
  isSupportedLegacySchemaVersionV22,
  validateRestoredTerminalStateV2,
  validateVerifiedToolTerminalEventV2,
} from './tool-terminal-v2';

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
  /** Trusted terminal projection mode resolved from registered feature flags. */
  toolResultProjectionMode?: 'compat_v1' | 'budget_v2';
  /** Exact Store base observed while constructing/restoring this Kernel. */
  persistenceIdentity?: RuntimePersistenceIdentityV1;
}

/** Executes an effect and returns facts for the Kernel to reduce/persist. */
export type RuntimeEffectEventSink = (event: RuntimeEvent) => void;

export type RuntimeEffectExecutor = (
  effect: RuntimeEffect,
  state: Readonly<RuntimeState>,
  emit?: RuntimeEffectEventSink,
  context?: {
    effectLeaseId?: string;
    producerGeneration?: number;
    summaryDispatchEntryGuard?: ProviderDispatchEntryGuardV1;
    reservationIds: readonly string[];
    getState?(): Readonly<RuntimeState>;
    persistEvent(event: RuntimeEvent): Promise<boolean>;
    persistEvents(events: RuntimeEvent[]): Promise<boolean>;
    persistLateResourceReconciliation?(
      event: Extract<RuntimeEvent, { type: 'resource_budget.reconciled' }>,
    ): Promise<boolean>;
  },
) => Promise<RuntimeEvent[]>;

function invalidModelToolCalls(
  event: RuntimeEvent,
): Array<{ id: string; name: string; args: Record<string, unknown> }> {
  if (event.type !== 'model.responded') return [];
  return (event.toolCalls ?? []).filter(
    (call): call is { id: string; name: string; args: Record<string, unknown> } =>
      call.args !== null &&
      typeof call.args === 'object' &&
      !Array.isArray(call.args) &&
      typeof (call.args as Record<string, unknown>)._parse_error === 'string',
  );
}

/**
 * Invalid Provider tool arguments are a successful Provider response but not a
 * successful tool dispatch.  The response and its canonical queued/failed
 * facts therefore have to share one Store transaction.  This validator also
 * runs over replay tails, so a crash cannot restore an orphan assistant Tool
 * Call without its matching Runtime call and Tool Result.
 */
function assertInvalidModelToolCallClosureV2(events: RuntimeEvent[]): void {
  for (let responseIndex = 0; responseIndex < events.length; responseIndex++) {
    const response = events[responseIndex]!;
    if (response.type !== 'model.responded') continue;
    const invalidCalls = invalidModelToolCalls(response);
    if (invalidCalls.length === 0) continue;
    if (response.contextEvidence || response.ownedToolQueue) {
      throw new Error('An invalid model Tool Call cannot enter a primary success branch.');
    }
    const nextResponseIndex = events.findIndex(
      (candidate, index) => index > responseIndex && candidate.type === 'model.responded',
    );
    const boundary = nextResponseIndex === -1 ? events.length : nextResponseIndex;
    let previousTerminalIndex = responseIndex;
    for (const call of invalidCalls) {
      const queueIndexes = events
        .slice(responseIndex + 1, boundary)
        .flatMap((candidate, offset) =>
          candidate.type === 'tool.queued' && candidate.toolCallId === call.id
            ? [responseIndex + 1 + offset]
            : [],
        );
      const terminalIndexes = events
        .slice(responseIndex + 1, boundary)
        .flatMap((candidate, offset) =>
          candidate.type === 'tool.failed' && candidate.toolCallId === call.id
            ? [responseIndex + 1 + offset]
            : [],
        );
      if (queueIndexes.length !== 1 || terminalIndexes.length !== 1) {
        throw new Error(
          `Invalid model Tool Call '${call.id}' lacks one exact queued/failed closure.`,
        );
      }
      const queueIndex = queueIndexes[0]!;
      const terminalIndex = terminalIndexes[0]!;
      const queue = events[queueIndex]!;
      const terminal = events[terminalIndex]!;
      if (
        queue.type !== 'tool.queued' ||
        terminal.type !== 'tool.failed' ||
        queueIndex <= previousTerminalIndex ||
        terminalIndex !== queueIndex + 1 ||
        queue.modelMessageId !== response.messageId ||
        queue.name !== call.name ||
        JSON.stringify(queue.args) !== JSON.stringify(call.args) ||
        terminal.failure?.kind !== 'model_invalid_tool_args'
      ) {
        throw new Error(
          `Invalid model Tool Call '${call.id}' has a non-canonical terminal closure.`,
        );
      }
      previousTerminalIndex = terminalIndex;
    }
  }
}

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
  private readonly toolResultProjectionMode: 'compat_v1' | 'budget_v2';
  private persistenceIdentity: RuntimePersistenceIdentityV1;
  private readonly appliedEventIds: Set<string>;
  private readonly summaryDispatchGuards = new Map<
    string,
    {
      guard: ProviderDispatchEntryGuardV1;
      generation: number;
      startBatchId: string;
      attemptId: string;
    }
  >();
  private activeRunnerId: string | null = null;

  constructor(config: KernelConfig) {
    this.store = config.store;
    this.state = config.initialState;
    this.sandboxAvailable = config.sandboxAvailable ?? false;
    this.toolResultProjectionMode = config.toolResultProjectionMode ?? 'compat_v1';
    this.persistenceIdentity =
      config.persistenceIdentity ??
      config.store.loadPersistenceIdentity(config.initialState.session.threadId);
    this.appliedEventIds = new Set(config.initialState.appliedEventIds ?? []);
  }

  // ── 事件处理 / Event processing ──

  /**
   * 处理单个 RuntimeEvent：reduce → persist。
   * Process a single RuntimeEvent: reduce → persist.
   */
  processEvent(event: RuntimeEventInput): {
    status: 'applied' | 'duplicate';
    eventId: string;
  } {
    const payload = isRuntimeEventEnvelope(event) ? event.payload : event;
    if (isEphemeralRuntimeEventV24(payload)) {
      return {
        status: 'applied',
        eventId: createHash('sha256')
          .update('ephemeral-runtime-event:v24\0')
          .update(JSON.stringify(payload))
          .digest('hex'),
      };
    }
    assertContextPrimarySuccessBatchV2([payload], this.state);
    assertSummaryLifecycleBatchV1([payload], this.state);
    assertInvalidModelToolCallClosureV2([payload]);
    assertToolTerminalControlBatchV2([payload], this.state);
    const normalizedInput = isRuntimeEventEnvelope(event)
      ? event
      : event.type === 'tool.finished' ||
          event.type === 'tool.failed' ||
          event.type === 'tool.rejected' ||
          event.type === 'tool.cancelled'
        ? finalizeToolTerminalEventV2(this.state, event, this.toolResultProjectionMode)
        : event;
    const envelope = this.createEnvelope(normalizedInput, this.state.revision + 1);
    if (this.appliedEventIds.has(envelope.eventId)) {
      return { status: 'duplicate', eventId: envelope.eventId };
    }

    const summaryGuardEffectId = this.assertSummaryDispatchGuardAuthority([envelope.payload]);
    const nextState = this.reduceEnvelope(this.state, envelope);
    // Atomic persist events + snapshot before publishing the new in-memory state.
    this.persistenceIdentity = this.store.appendEventsAndSnapshot(
      this.state.session.threadId,
      [envelope.payload],
      nextState,
      [this.metadataFor(envelope)],
      undefined,
      this.persistenceIdentity,
    );
    this.state = nextState;
    if (summaryGuardEffectId) this.summaryDispatchGuards.delete(summaryGuardEffectId);
    this.appliedEventIds.add(envelope.eventId);
    if (envelope.payload.type === 'turn.completed') {
      this.store.saveNamedSnapshot(
        this.state.session.threadId,
        `turn-${envelope.payload.turnId}-${this.store.getLastEventPosition(this.state.session.threadId)}`,
        this.state,
        undefined,
        this.persistenceIdentity,
      );
      this.persistenceIdentity = this.store.loadPersistenceIdentity(this.state.session.threadId);
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
    const durableEvents = events.filter(
      (event) => !isEphemeralRuntimeEventV24(isRuntimeEventEnvelope(event) ? event.payload : event),
    );
    if (durableEvents.length === 0) return;
    const summaryGuardEffectId = this.assertSummaryDispatchGuardAuthority(
      durableEvents.map((event) => (isRuntimeEventEnvelope(event) ? event.payload : event)),
    );
    assertContextPrimarySuccessBatchV2(
      durableEvents.map((event) => (isRuntimeEventEnvelope(event) ? event.payload : event)),
      this.state,
    );
    assertSummaryLifecycleBatchV1(
      durableEvents.map((event) => (isRuntimeEventEnvelope(event) ? event.payload : event)),
      this.state,
    );
    assertInvalidModelToolCallClosureV2(
      durableEvents.map((event) => (isRuntimeEventEnvelope(event) ? event.payload : event)),
    );
    assertToolTerminalControlBatchV2(
      durableEvents.map((event) => (isRuntimeEventEnvelope(event) ? event.payload : event)),
      this.state,
    );
    let nextState = this.state;
    const payloads: RuntimeEvent[] = [];
    const metadata: RuntimeEventMetadata[] = [];
    const batchEventIds: string[] = [];
    const batchSeen = new Set(this.appliedEventIds);
    for (const event of durableEvents) {
      let normalizedInput = isRuntimeEventEnvelope(event)
        ? event
        : event.type === 'tool.finished' ||
            event.type === 'tool.failed' ||
            event.type === 'tool.rejected' ||
            event.type === 'tool.cancelled'
          ? finalizeToolTerminalEventV2(nextState, event, this.toolResultProjectionMode)
          : event;
      if (!isRuntimeEventEnvelope(normalizedInput)) {
        if (normalizedInput.type === 'context.normal_resource_resolution_required_v1') {
          const resourceReservationId = normalizedInput.resourceReservationId;
          const unknownIndex = payloads.findIndex(
            (payload) =>
              payload.type === 'resource_budget.unknown' &&
              payload.reservationId === resourceReservationId,
          );
          if (unknownIndex >= 0) {
            normalizedInput = {
              ...normalizedInput,
              resourceUnknownEventId: metadata[unknownIndex]!.eventId,
            };
          }
        } else if (normalizedInput.type === 'context.normal_reprepare_required_v1') {
          const receipt = normalizedInput.receipt;
          if (receipt.origin.kind === 'summary_terminal') {
            const terminalBatchId = receipt.origin.terminalBatchId;
            const terminalIndex = payloads.findIndex(
              (payload) =>
                (payload.type === 'context.summary_completed_v1' ||
                  payload.type === 'context.summary_failed_v1' ||
                  payload.type === 'context.summary_unknown_external_outcome_v1') &&
                payload.terminalBatchKey.terminalBatchId === terminalBatchId,
            );
            const resourceIndex = payloads.findIndex(
              (payload) =>
                (payload.type === 'resource_budget.reconciled' ||
                  payload.type === 'resource_budget.released' ||
                  payload.type === 'resource_budget.unknown') &&
                payload.summaryTerminalBatchKey?.terminalBatchId === terminalBatchId,
            );
            if (terminalIndex >= 0 && resourceIndex >= 0) {
              normalizedInput = {
                ...normalizedInput,
                receipt: {
                  ...receipt,
                  origin: {
                    ...receipt.origin,
                    terminalEventId: metadata[terminalIndex]!.eventId,
                    resourceTerminalEventId: metadata[resourceIndex]!.eventId,
                  },
                },
              };
            }
          } else {
            const resolutionBatchId = receipt.origin.resolutionBatchId;
            const resourceIndex = payloads.findIndex(
              (payload) =>
                payload.type === 'resource_budget.reconciled' &&
                payload.summaryResolutionBatchKey?.resolutionBatchId === resolutionBatchId,
            );
            if (resourceIndex >= 0) {
              normalizedInput = {
                ...normalizedInput,
                receipt: {
                  ...receipt,
                  origin: {
                    ...receipt.origin,
                    resourceReconciledEventId: metadata[resourceIndex]!.eventId,
                  },
                },
              };
            }
          }
        }
      }
      const envelope = this.createEnvelope(normalizedInput, nextState.revision + 1);
      if (batchSeen.has(envelope.eventId)) continue;
      const summaryStarted =
        envelope.payload.type === 'context.summary_dispatch_started_v1'
          ? envelope.payload
          : undefined;
      const summaryStartReceipt =
        summaryStarted &&
        nextState.context.summaryLifecycle.kind === 'requested' &&
        nextState.context.summaryLifecycle.requestedEventId
          ? (() => {
              const reservedIndex = payloads.findIndex(
                (payload) =>
                  payload.type === 'resource_budget.reserved' &&
                  payload.reservation.reservationId ===
                    summaryStarted.startBatchKey.dispatchStart.resourceReservationId,
              );
              const dispatchIndex = payloads.findIndex(
                (payload) =>
                  payload.type === 'resource_budget.dispatch_started' &&
                  payload.reservationId ===
                    summaryStarted.startBatchKey.dispatchStart.resourceReservationId,
              );
              if (reservedIndex < 0 || dispatchIndex < 0) return undefined;
              return {
                version: 1 as const,
                requestedEventId: nextState.context.summaryLifecycle.requestedEventId!,
                resourceReservedEventId: metadata[reservedIndex]!.eventId,
                resourceDispatchStartedEventId: metadata[dispatchIndex]!.eventId,
                summaryDispatchStartedEventId: envelope.eventId,
              };
            })()
          : undefined;
      nextState = this.reduceEnvelope(nextState, envelope, {
        deferInvariant: true,
        summaryStartReceipt,
      });
      payloads.push(envelope.payload);
      metadata.push(this.metadataFor(envelope));
      batchSeen.add(envelope.eventId);
      batchEventIds.push(envelope.eventId);
    }
    if (payloads.length === 0) return;
    assertRuntimeStateInvariants(nextState);
    this.persistenceIdentity = this.store.appendEventsAndSnapshot(
      this.state.session.threadId,
      payloads,
      nextState,
      metadata,
      undefined,
      this.persistenceIdentity,
    );
    this.state = nextState;
    if (summaryGuardEffectId) this.summaryDispatchGuards.delete(summaryGuardEffectId);
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
        undefined,
        this.persistenceIdentity,
      );
      this.persistenceIdentity = this.store.loadPersistenceIdentity(this.state.session.threadId);
    }
  }

  /**
   * 批量处理多个 RuntimeEvent。
   * Process multiple RuntimeEvents in batch.
   */
  processEvents(events: RuntimeEventInput[]): void {
    this.processEventBatch(events);
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

  /** Bind one process-local callback-entry guard to its durable Summary start. */
  registerSummaryDispatchEntryGuard(
    lease: RuntimeEffectLease,
    guard: ProviderDispatchEntryGuardV1,
  ): void {
    const lifecycle = this.state.context.summaryLifecycle;
    if (
      lease.effect.type !== 'compact_context' ||
      !this.isEffectLeaseCurrent(lease) ||
      lifecycle.kind !== 'started' ||
      lifecycle.startBatchKey.dispatchStart.summaryEffectLeaseId !== lease.effectId ||
      guard.currentState() !== 'open' ||
      this.summaryDispatchGuards.has(lease.effectId)
    ) {
      throw new Error('Summary dispatch guard does not bind the current durable effect start.');
    }
    this.summaryDispatchGuards.set(lease.effectId, {
      guard,
      generation: this.persistenceIdentity.generation,
      startBatchId: lifecycle.startBatchKey.startBatchId,
      attemptId: lifecycle.attempt.attemptId,
    });
  }

  private assertSummaryDispatchGuardAuthority(events: readonly RuntimeEvent[]): string | undefined {
    const terminal = events.find(
      (event) =>
        event.type === 'context.summary_completed_v1' ||
        event.type === 'context.summary_failed_v1' ||
        event.type === 'context.summary_unknown_external_outcome_v1',
    ) as
      | Extract<
          RuntimeEvent,
          {
            type:
              | 'context.summary_completed_v1'
              | 'context.summary_failed_v1'
              | 'context.summary_unknown_external_outcome_v1';
          }
        >
      | undefined;
    const dispatchStart = terminal?.terminalBatchKey.dispatchStart;
    if (!terminal || !dispatchStart) return undefined;
    if (terminal.terminalBatchKey.admission.stage === 'indeterminate_after_crash') {
      return undefined;
    }
    const authority = this.summaryDispatchGuards.get(dispatchStart.summaryEffectLeaseId);
    const lifecycle = this.state.context.summaryLifecycle;
    if (
      !authority ||
      authority.generation !== this.persistenceIdentity.generation ||
      authority.startBatchId !== dispatchStart.startBatchId ||
      authority.attemptId !== terminal.attemptId ||
      lifecycle.kind !== 'started' ||
      lifecycle.attempt.attemptId !== terminal.attemptId ||
      lifecycle.startBatchKey.dispatchStart.summaryEffectLeaseId !==
        dispatchStart.summaryEffectLeaseId
    ) {
      throw new Error('Summary terminal lacks its process-local dispatch guard authority.');
    }
    const expectedGuardState =
      terminal.type !== 'context.summary_unknown_external_outcome_v1' &&
      terminal.providerDispatchState === 'not_entered'
        ? 'closed_without_entry'
        : 'entered';
    if (authority.guard.currentState() !== expectedGuardState) {
      throw new Error('Summary terminal conflicts with callback-entry guard state.');
    }
    const admission = terminal.terminalBatchKey.admission;
    if (
      admission.stage === 'not_completed' &&
      admission.proof.guardNonce !== authority.guard.nonce
    ) {
      throw new Error('Summary zero-execution proof does not bind the registered guard nonce.');
    }
    return dispatchStart.summaryEffectLeaseId;
  }

  getProducerGeneration(): number {
    return this.persistenceIdentity.generation;
  }

  /** Apply an effect result only if no newer event changed the state. */
  applyEffectResult(lease: RuntimeEffectLease, events: RuntimeEventInput[]): boolean {
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
      if (
        this.state.context.summaryLifecycle.kind === 'resource_resolution_required' &&
        this.state.context.summaryLifecycle.resourceReservationId === event.reservationId
      )
        return false;
      return reservation?.state === 'dispatch_started' || reservation?.state === 'unknown';
    });
    if (!valid) return false;
    this.processEventBatch(events);
    return true;
  }

  /** Settle a Summary result whose effect lease lost a Runtime revision race. */
  applyStaleSummarySettlementV1(events: RuntimeEvent[]): RuntimeEvent[] | false {
    const lifecycle = this.state.context.summaryLifecycle;
    if (lifecycle.kind !== 'started') return false;
    const terminal = events.find(
      (event) =>
        event.type === 'context.summary_completed_v1' ||
        event.type === 'context.summary_failed_v1' ||
        event.type === 'context.summary_unknown_external_outcome_v1',
    );
    const resource = events.find(
      (event) =>
        event.type === 'resource_budget.reconciled' ||
        event.type === 'resource_budget.released' ||
        event.type === 'resource_budget.unknown',
    );
    if (
      !terminal ||
      !resource ||
      terminal.attemptId !== lifecycle.attempt.attemptId ||
      terminal.terminalBatchKey.compactionId !== lifecycle.attempt.compactionId ||
      resource.reservationId !== lifecycle.startBatchKey.dispatchStart.resourceReservationId ||
      resource.summaryTerminalBatchKey?.terminalBatchId !==
        terminal.terminalBatchKey.terminalBatchId
    )
      return false;

    const currentSource = buildSummarySourceIdentityForCurrentPrefixV1(this.state);
    const sourceStillCurrent =
      currentSource != null &&
      JSON.stringify(currentSource) === JSON.stringify(lifecycle.attempt.summarySourceIdentity);
    const staleTerminal: RuntimeEvent = {
      type: 'context.summary_failed_v1',
      attemptId: lifecycle.attempt.attemptId,
      terminalBatchKey: terminal.terminalBatchKey,
      errorKind: sourceStillCurrent ? 'stale_runtime_revision' : 'stale_source',
      message: sourceStillCurrent
        ? 'Summary result became stale after a Runtime control revision.'
        : 'Summary result became stale after new transcript source was committed.',
      providerDispatchState:
        terminal.terminalBatchKey.admission.stage === 'not_completed' ? 'not_entered' : 'entered',
    };
    const settlement: RuntimeEvent[] = [staleTerminal, resource];
    if (lifecycle.attempt.reason === 'auto' && lifecycle.continuation) {
      if (resource.type === 'resource_budget.unknown') {
        settlement.push({
          type: 'context.normal_resource_resolution_required_v1',
          attempt: lifecycle.attempt,
          terminalBatchKey: terminal.terminalBatchKey,
          continuation: lifecycle.continuation,
          resourceReservationId: resource.reservationId,
          resourceUnknownEventId: terminal.terminalBatchKey.terminalBatchId,
        });
      } else if (!sourceStillCurrent) {
        settlement.push({
          type: 'context.normal_continuation_superseded_v1',
          attemptId: lifecycle.attempt.attemptId,
          reason: 'new_source',
        });
      } else {
        settlement.push({
          type: 'context.normal_reprepare_required_v1',
          receipt: {
            version: 1,
            generation: this.persistenceIdentity.generation,
            attemptId: lifecycle.attempt.attemptId,
            compactionId: lifecycle.attempt.compactionId,
            continuation: lifecycle.continuation,
            origin: {
              kind: 'summary_terminal',
              terminalBatchId: terminal.terminalBatchKey.terminalBatchId,
              terminalEventId: terminal.terminalBatchKey.terminalBatchId,
              resourceTerminalEventId: terminal.terminalBatchKey.terminalBatchId,
            },
          },
        });
      }
    }
    this.processEventBatch(settlement);
    return settlement;
  }

  /** Dedicated bounded owner for an auto-Summary unknown resource outcome. */
  applyLateSummaryResourceResolutionV1(input: {
    reservationId: string;
    actual: ResourceUsageV1;
  }): boolean {
    const lifecycle = this.state.context.summaryLifecycle;
    const budget = this.state.resourceBudget;
    if (
      lifecycle.kind !== 'resource_resolution_required' ||
      budget.status !== 'active' ||
      lifecycle.resourceReservationId !== input.reservationId ||
      budget.reservations[input.reservationId]?.state !== 'unknown' ||
      lifecycle.continuation.turnId !== this.state.turn.turnId
    )
      return false;
    const currentSource = buildSummarySourceIdentityForCurrentPrefixV1(this.state);
    if (
      !currentSource ||
      JSON.stringify(currentSource) !== JSON.stringify(lifecycle.continuation.summarySourceIdentity)
    )
      return false;
    const resolutionBatchId = crypto.randomUUID();
    const actualUsageDigest = createHash('sha256')
      .update('summary-resolution-actual-usage:v1\0')
      .update(JSON.stringify(input.actual))
      .digest('hex');
    const summaryResolutionBatchKey = {
      version: 1 as const,
      resolutionBatchId,
      causationId: lifecycle.terminalBatchKey.terminalBatchId,
      generation: this.persistenceIdentity.generation,
      attemptId: lifecycle.attempt.attemptId,
      compactionId: lifecycle.attempt.compactionId,
      originalTerminalBatchId: lifecycle.terminalBatchKey.terminalBatchId,
      resourceReservationId: input.reservationId,
      resourceUnknownEventId: lifecycle.resourceUnknownEventId,
      continuation: lifecycle.continuation,
      actualUsageDigest,
    };
    this.processEventBatch([
      {
        type: 'resource_budget.reconciled',
        reservationId: input.reservationId,
        actual: input.actual,
        summaryResolutionBatchKey,
      },
      {
        type: 'context.normal_reprepare_required_v1',
        summaryResolutionBatchKey,
        receipt: {
          version: 1,
          generation: this.persistenceIdentity.generation,
          attemptId: lifecycle.attempt.attemptId,
          compactionId: lifecycle.attempt.compactionId,
          continuation: lifecycle.continuation,
          origin: {
            kind: 'late_resolution',
            originalTerminalBatchId: lifecycle.terminalBatchKey.terminalBatchId,
            resolutionBatchId,
            resourceUnknownEventId: lifecycle.resourceUnknownEventId,
            resourceReconciledEventId: resolutionBatchId,
          },
        },
      },
    ]);
    return true;
  }

  private hasLateTerminalEventForCancelledTool(
    lease: RuntimeEffectLease,
    inputs: RuntimeEventInput[],
  ): boolean {
    if (lease.effect.type !== 'run_tools') return false;
    return inputs.some((input) => {
      const event = isRuntimeEventEnvelope(input) ? input.payload : input;
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
  applyEffectEvent(lease: RuntimeEffectLease, event: RuntimeEventInput): boolean {
    if (!this.isEffectEventCurrent(lease, event)) return false;
    this.processEvent(event);
    lease.expectedRevision = this.state.revision;
    return true;
  }

  private isConcurrentShellBatchCurrent(
    lease: RuntimeEffectLease,
    inputs: RuntimeEventInput[],
  ): boolean {
    let projectedState = this.state;
    for (const input of inputs) {
      if (!this.isConcurrentShellEventCurrent(lease, input, projectedState)) return false;
      const event = isRuntimeEventEnvelope(input) ? input.payload : input;
      projectedState = reduceRuntimeState(projectedState, event);
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
    input: RuntimeEventInput,
    state: RuntimeState = this.state,
  ): boolean {
    if (lease.turnId !== state.turn.turnId || lease.effect.type !== 'run_tools') return false;
    const event = isRuntimeEventEnvelope(input) ? input.payload : input;
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
  isEffectEventCurrent(lease: RuntimeEffectLease, event: RuntimeEventInput): boolean {
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
      return {
        type: 'busy',
        reason: 'A runtime runner is already active for this thread.',
      };
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
    const combined = finalizeToolTerminalBatchV2(
      this.state,
      [...events, ...additionalEvents],
      this.toolResultProjectionMode,
    );
    this.processEventBatch(combined);
    return { status: 'applied', events: combined };
  }

  private createEnvelope(event: RuntimeEventInput, revision: number): RuntimeEventEnvelope {
    if (isRuntimeEventEnvelope(event)) {
      assertCanonicalRuntimeEventEnvelopeV24(event);
      if (event.threadId !== this.state.session.threadId) {
        throw new Error(`Runtime event thread mismatch: ${event.threadId}.`);
      }
      if (event.generation !== this.persistenceIdentity.generation) {
        throw new Error(`Runtime event generation mismatch: ${event.generation}.`);
      }
      return event;
    }
    const normalizedEvent = normalizeTerminalRuntimeEventV1(event);
    const occurredAt = new Date().toISOString();
    const payload =
      (normalizedEvent.type === 'user.message_appended' ||
        normalizedEvent.type === 'model.responded' ||
        normalizedEvent.type === 'tool.finished') &&
      !normalizedEvent.createdAt
        ? { ...normalizedEvent, createdAt: occurredAt }
        : normalizedEvent;
    return buildRuntimeEventEnvelopeV24({
      threadId: this.state.session.threadId,
      generation: this.persistenceIdentity.generation,
      revision,
      occurredAt,
      causationId: runtimeEventCausationIdV24(payload),
      payload,
    });
  }

  private reduceEnvelope(
    state: RuntimeState,
    envelope: RuntimeEventEnvelope,
    options: {
      deferInvariant?: boolean;
      summaryStartReceipt?: import('./context-compaction').SummaryStartedReceiptV1;
    } = {},
  ): RuntimeState {
    assertCanonicalRuntimeEventEnvelopeV24(envelope);
    if (envelope.revision !== state.revision + 1) {
      throw new Error(
        `Runtime revision mismatch: expected ${state.revision + 1}, received ${envelope.revision}.`,
      );
    }
    if (
      envelope.payload.type === 'tool.finished' ||
      envelope.payload.type === 'tool.failed' ||
      envelope.payload.type === 'tool.rejected' ||
      envelope.payload.type === 'tool.cancelled'
    ) {
      validateVerifiedToolTerminalEventV2(state, envelope.payload, this.toolResultProjectionMode);
    }
    this.assertRuntimeEventAdmission(envelope.payload);
    const reduced = reduceRuntimeState(state, envelope.payload, {
      eventId: envelope.eventId,
      ...(options.summaryStartReceipt ? { summaryStartReceipt: options.summaryStartReceipt } : {}),
    });
    const transcriptAdvanced =
      reduced.transcript.messages.length > state.transcript.messages.length;
    const nextState: RuntimeState = {
      ...reduced,
      ...(transcriptAdvanced
        ? {
            context: {
              ...reduced.context,
              lastTranscriptProducingEventCutV1: {
                revision: envelope.revision,
                eventId: envelope.eventId,
              },
            },
          }
        : {}),
      revision: envelope.revision,
      lastAppliedEventId: envelope.eventId,
      appliedEventIds: [...(reduced.appliedEventIds ?? []), envelope.eventId].slice(-4096),
      storageFormat: advanceRuntimeStorageFormatV24({
        current: state.storageFormat,
        eventId: envelope.eventId,
        canonicalBytes: Buffer.byteLength(canonicalRuntimeEventEnvelopeBytesV24(envelope), 'utf8'),
      }),
    };
    if (!options.deferInvariant) assertRuntimeStateInvariants(nextState);
    return nextState;
  }

  /** Enforce authorization invariants for mutable live-control events. */
  private assertRuntimeEventAdmission(event: RuntimeEvent): void {
    if (
      event.type === 'context.compaction_refill_observed' ||
      event.type === 'context.compaction_guard_carried_forward' ||
      event.type === 'context.compaction_guard_reset' ||
      (event.type === 'context.compaction_requested' && event.reason === 'auto') ||
      (event.type === 'context.compaction_completed' &&
        (event.checkpoint.reason === 'auto' || isLegacyCheckpointV2(event.checkpoint)))
    ) {
      throw new Error('Superseded Slice B events are accepted only by read-only restore.');
    }
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
    assertCanonicalRuntimeEventEnvelopeV24(envelope);
    return {
      eventId: envelope.eventId,
      revision: envelope.revision,
      causationId: envelope.causationId,
      occurredAt: envelope.occurredAt,
      schemaVersion: 24,
      generation: envelope.generation,
      canonicalBytes: Buffer.byteLength(canonicalRuntimeEventEnvelopeBytesV24(envelope), 'utf8'),
    };
  }

  // ── 持久化 / Persistence ──

  /**
   * 保存当前状态的快照到 EventStore。
   * Save a snapshot of the current state to the EventStore.
   */
  saveSnapshot(): void {
    this.persistenceIdentity = this.store.appendEventsAndSnapshot(
      this.state.session.threadId,
      [],
      this.state,
      [],
      undefined,
      this.persistenceIdentity,
    );
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
    this.store.saveNamedSnapshot(
      this.state.session.threadId,
      name,
      this.state,
      undefined,
      this.persistenceIdentity,
    );
    this.persistenceIdentity = this.store.loadPersistenceIdentity(this.state.session.threadId);
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
  toolResultProjectionMode?: 'compat_v1' | 'budget_v2';
}): AgentKernel {
  const store = createRuntimeStore(params.storePath);
  let restored: ReturnType<typeof restoreAndCommitRuntimeStateV22>;
  try {
    restored = restoreAndCommitRuntimeStateV22({ ...params, store });
  } catch (error) {
    store.close();
    throw error;
  }

  const kernel = new AgentKernel({
    store,
    initialState: restored.state,
    interactionMode: params.interactionMode ?? 'accept_edits',
    sandboxAvailable: params.sandboxAvailable,
    toolResultProjectionMode: params.toolResultProjectionMode,
    persistenceIdentity: restored.persistenceIdentity,
  });
  const checkpointRebound = deriveCheckpointV3ReboundV1({
    state: kernel.getState(),
    generation: kernel.getProducerGeneration(),
  });
  if (checkpointRebound) kernel.processEvent(checkpointRebound);
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
    const recoveredSummary = kernel.getState().context.summaryLifecycle;
    const handledSummaryReservations = new Set<string>();
    if (
      recoveredSummary.kind === 'idle' &&
      recoveredSummary.lastConsumption &&
      kernel.getState().turn.status === 'active'
    ) {
      const consumption = recoveredSummary.lastConsumption;
      const reservation = recoveredBudget.reservations[consumption.resourceReservationId];
      if (reservation?.state === 'dispatch_started') {
        const failure = classifyFailure(
          'unknown',
          'Continuation primary outcome is unknown after Runtime recovery.',
        );
        kernel.processEventBatch([
          {
            type: 'run.error',
            message: failure.message,
            recoverable: false,
            failure,
            turnId: consumption.continuation.turnId,
            outcome: failedTerminalOutcomeV1(failure, { knownExternalEffects: 'unknown' }),
          },
          {
            type: 'resource_budget.unknown',
            reservationId: consumption.resourceReservationId,
          },
          {
            type: 'turn.aborted',
            turnId: consumption.continuation.turnId,
            reason: failure.message,
            cause: 'error',
          },
        ]);
        handledSummaryReservations.add(consumption.resourceReservationId);
      }
    }
    if (recoveredSummary.kind === 'started') {
      const reservationId = recoveredSummary.startBatchKey.dispatchStart.resourceReservationId;
      const reservation = recoveredBudget.reservations[reservationId];
      if (reservation?.state === 'dispatch_started') {
        const terminalBatchId = crypto.randomUUID();
        const terminalBatchKey = {
          terminalBatchId,
          causationId: recoveredSummary.startBatchKey.startBatchId,
          attemptId: recoveredSummary.attempt.attemptId,
          compactionId: recoveredSummary.attempt.compactionId,
          summarySourceIdentity: recoveredSummary.attempt.summarySourceIdentity,
          requestedAtRevision: recoveredSummary.attempt.requestedAtRevision,
          requestedAtTurnId: recoveredSummary.attempt.requestedAtTurnId,
          sourceProducingEventCutV1: recoveredSummary.attempt.sourceProducingEventCutV1,
          dispatchStart: recoveredSummary.startBatchKey.dispatchStart,
          admission: { stage: 'indeterminate_after_crash' as const },
        };
        const recoveryEvents: RuntimeEvent[] = [
          {
            type: 'context.summary_unknown_external_outcome_v1',
            attemptId: recoveredSummary.attempt.attemptId,
            terminalBatchKey,
          },
          {
            type: 'resource_budget.unknown',
            reservationId,
            summaryTerminalBatchKey: terminalBatchKey,
          },
        ];
        if (recoveredSummary.attempt.reason === 'auto' && recoveredSummary.continuation) {
          recoveryEvents.push({
            type: 'context.normal_resource_resolution_required_v1',
            attempt: recoveredSummary.attempt,
            terminalBatchKey,
            continuation: recoveredSummary.continuation,
            resourceReservationId: reservationId,
            resourceUnknownEventId: terminalBatchId,
          });
        }
        kernel.processEventBatch(recoveryEvents);
        handledSummaryReservations.add(reservationId);
      }
    }
    for (const reservation of Object.values(recoveredBudget.reservations)) {
      if (handledSummaryReservations.has(reservation.reservationId)) continue;
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

/** Publish a pure migration candidate with bounded stale reloads, then restore the committed head. */
export function restoreAndCommitRuntimeStateV22(
  params: Parameters<typeof restoreRuntimeStateFromStore>[0],
  maxAttempts = 8,
): ReturnType<typeof restoreRuntimeStateFromStore> {
  let restored = restoreRuntimeStateFromStore(params);
  migrationAttempt: for (
    let attempt = 0;
    restored.migrationCandidate && attempt < maxAttempts;
    attempt += 1
  ) {
    let build: ReturnType<RuntimeStore['advanceRuntimeV24MigrationBuildV1']> | undefined;
    // 50k event rows plus 50k eager named-cut proofs require at most
    // 13 + 13 bounded 4096-row passes. Keep a small fixed margin without
    // turning restore into an unbounded loop.
    for (let chunk = 0; chunk < 32; chunk += 1) {
      build = params.store.advanceRuntimeV24MigrationBuildV1(
        params.threadId,
        restored.migrationCandidate.identity,
      );
      if (build.status === 'stale') {
        restored = restoreRuntimeStateFromStore(params);
        continue migrationAttempt;
      }
      if (build.status === 'complete') break;
    }
    if (build?.status !== 'complete') {
      throw new Error('Runtime v24 migration exceeded its bounded resumable build window.');
    }
    let storageFormat = bindMigratedRuntimeLedgerEvidenceV24({
      current: restored.migrationCandidate.state.storageFormat,
      legacyEvidence: build.evidence,
    });
    for (const metadata of restored.migrationCandidate.metadata) {
      if (!metadata.eventId || !metadata.canonicalBytes) {
        throw new Error('Runtime migration closure lacks canonical ledger evidence.');
      }
      storageFormat = advanceRuntimeStorageFormatV24({
        current: storageFormat,
        eventId: metadata.eventId,
        canonicalBytes: metadata.canonicalBytes,
      });
    }
    const candidateState = {
      ...restored.migrationCandidate.state,
      storageFormat,
    };
    if (
      params.store.compareAndSaveMigratedSnapshot(
        params.threadId,
        restored.migrationCandidate.identity,
        candidateState,
        restored.migrationCandidate.events,
        restored.migrationCandidate.metadata,
      ) === 'saved'
    ) {
      return restoreRuntimeStateFromStore(params);
    }
    restored = restoreRuntimeStateFromStore(params);
  }
  if (restored.migrationCandidate) {
    throw new Error('Runtime migration source changed repeatedly before exact-head commit.');
  }
  return restored;
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
  persistenceIdentity: RuntimePersistenceIdentityV1;
  migrationCandidate: {
    state: RuntimeState;
    identity: RuntimeMigrationIdentityV1;
    events: RuntimeEvent[];
    metadata: RuntimeEventMetadata[];
  } | null;
} {
  const store = params.store;
  const observedPersistence = store.loadPersistenceIdentity(params.threadId);
  const observedGeneration = observedPersistence.generation;
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
  let migratedState: RuntimeState | null = null;
  let migrationEvents: RuntimeEvent[] = [];
  let migrationMetadata: RuntimeEventMetadata[] = [];
  const incompatibleSchemaVersion =
    restoredState &&
    restoredState.schemaVersion !== RUNTIME_STATE_SCHEMA_VERSION &&
    restoredState.schemaVersion !== 23 &&
    restoredState.schemaVersion !== 22 &&
    !isSupportedLegacySchemaVersionV22(restoredState.schemaVersion)
      ? restoredState.schemaVersion
      : undefined;
  let recoveryReason: string | undefined;
  let observedHead: RuntimeMigrationIdentityV1['observedHead'] = {
    eventPosition: 0,
    revision: 0,
    eventId: null,
  };
  const lastEventPosition = store.getLastEventPosition(params.threadId);
  let allEvents: StoredEvent[] = [];
  if (snapshotRecord && snapshotRecord.metadata.eventPosition > lastEventPosition) {
    recoveryReason = `Runtime snapshot event position ${snapshotRecord.metadata.eventPosition} exceeds the last event position ${lastEventPosition}.`;
  }
  if (!recoveryReason && lastEventPosition > 0) {
    try {
      allEvents = store.loadEventsStrict(params.threadId);
      const lastObserved = allEvents.at(-1);
      observedHead = lastObserved
        ? {
            eventPosition: lastObserved.id,
            revision: lastObserved.revision ?? 0,
            eventId: lastObserved.event_id ?? null,
          }
        : observedHead;
    } catch (error) {
      recoveryReason = error instanceof Error ? error.message : String(error);
    }
  }
  if (!recoveryReason && snapshotRecord) {
    try {
      validateSnapshotPrefixV22(snapshotRecord, allEvents, observedGeneration);
    } catch (error) {
      recoveryReason = error instanceof Error ? error.message : String(error);
    }
  }
  if (!recoveryReason && restoredState && incompatibleSchemaVersion == null && snapshotRecord) {
    try {
      const snapshotPosition = snapshotRecord.metadata.eventPosition;
      migratedState = migrateRuntimeState(restoredState, {
        sourceSnapshot: snapshotRecord.metadata,
        prefixEvents: allEvents.filter((entry) => entry.id <= snapshotPosition),
      });
      if (migratedState && restoredState.schemaVersion < 17) {
        migratedState = restoreLegacyTurnLifecycle(
          migratedState,
          allEvents.filter((entry) => entry.id <= snapshotPosition),
        );
      }
      if (migratedState) {
        migratedState = replayPersistedTail(
          migratedState,
          allEvents.filter((entry) => entry.id > snapshotPosition),
          params.threadId,
          restoredState.schemaVersion,
          observedGeneration,
        );
        const migrationClosure = closeLegacyPendingCompactionV23({
          state: migratedState,
          sourceSchemaVersion: restoredState.schemaVersion,
          observedHead,
          allEvents,
          threadId: params.threadId,
          generation: observedGeneration,
        });
        migratedState = migrationClosure.state;
        migrationEvents = migrationClosure.events;
        migrationMetadata = migrationClosure.metadata;
        const ledgerBase = migratedState.storageFormat.ledgerBase;
        const branchAuthority =
          (ledgerBase.kind === 'fork_rebound_v24' || ledgerBase.kind === 'verified_named_v24') &&
          ledgerBase.branchMutationReceiptId
            ? store.loadBranchMutationAuthorityV1(
                params.threadId,
                observedGeneration,
                ledgerBase.branchMutationReceiptId,
              )
            : null;
        validateRestoredTerminalStateV2(migratedState, observedHead.eventPosition, allEvents, {
          allowBranchNormalizedLegacyBase: branchAuthority != null,
        });
        validateRuntimeNamedEventReferencesV24(migratedState, allEvents, observedGeneration);
        validateRestoredContextReclaimStateV1(migratedState);
      }
    } catch (error) {
      recoveryReason = error instanceof Error ? error.message : String(error);
      migratedState = null;
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
              authorization: {
                ...state.authorization,
                mode: params.authorizationMode,
              },
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
    persistenceIdentity: {
      generation: observedGeneration,
      writeEpoch: observedPersistence.writeEpoch,
      format: observedPersistence.format,
      lifecycle: observedPersistence.lifecycle,
      sourceSnapshot: snapshotRecord?.metadata ?? null,
      observedHead,
    } satisfies RuntimePersistenceIdentityV1,
    migrationCandidate:
      !recoveryReason &&
      restoredState &&
      restoredState.schemaVersion >= 2 &&
      restoredState.schemaVersion < RUNTIME_STATE_SCHEMA_VERSION &&
      migratedState &&
      migratedState.session.threadId === params.threadId &&
      snapshotRecord
        ? {
            state: migratedState,
            identity: {
              generation: observedGeneration,
              writeEpoch: observedPersistence.writeEpoch,
              format: observedPersistence.format,
              lifecycle: observedPersistence.lifecycle,
              sourceSnapshot: snapshotRecord.metadata,
              observedHead,
            },
            events: migrationEvents,
            metadata: migrationMetadata,
          }
        : null,
  };
}

function validateRuntimeNamedEventReferencesV24(
  state: Readonly<RuntimeState>,
  events: readonly StoredEvent[],
  generation: number,
): void {
  if (state.schemaVersion < 24) return;
  const byId = new Map(
    events.flatMap((entry) =>
      entry.event_id && entry.producer_generation === generation
        ? [[entry.event_id, entry] as const]
        : [],
    ),
  );
  const requireType = (eventId: string, types: readonly RuntimeEvent['type'][], label: string) => {
    const entry = byId.get(eventId);
    if (!entry || !types.includes(entry.event.type)) {
      throw new Error(`${label} does not resolve to its exact current-generation event role.`);
    }
    return entry;
  };
  const lifecycle = state.context.summaryLifecycle;
  if (lifecycle.kind === 'requested' && lifecycle.requestedEventId) {
    requireType(lifecycle.requestedEventId, ['context.summary_requested_v1'], 'Summary request');
  }
  if (lifecycle.kind === 'started' && lifecycle.startedReceipt) {
    const ordered = [
      requireType(
        lifecycle.startedReceipt.requestedEventId,
        ['context.summary_requested_v1'],
        'Summary start request',
      ),
      requireType(
        lifecycle.startedReceipt.resourceReservedEventId,
        ['resource_budget.reserved'],
        'Summary reservation',
      ),
      requireType(
        lifecycle.startedReceipt.resourceDispatchStartedEventId,
        ['resource_budget.dispatch_started'],
        'Summary resource dispatch',
      ),
      requireType(
        lifecycle.startedReceipt.summaryDispatchStartedEventId,
        ['context.summary_dispatch_started_v1'],
        'Summary dispatch',
      ),
    ];
    if (
      ordered.some(
        (entry, index) => index > 0 && (entry.revision ?? 0) <= (ordered[index - 1]?.revision ?? 0),
      )
    ) {
      throw new Error('Summary start receipt event roles are not in canonical revision order.');
    }
  }
  if (lifecycle.kind === 'resource_resolution_required') {
    requireType(
      lifecycle.resourceUnknownEventId,
      ['resource_budget.unknown'],
      'Summary unknown-resource receipt',
    );
  }
  const validateOrigin = (
    origin: import('./context-compaction').NormalReprepareReceiptV1['origin'],
  ) => {
    if (origin.kind === 'summary_terminal') {
      requireType(
        origin.terminalEventId,
        [
          'context.summary_completed_v1',
          'context.summary_failed_v1',
          'context.summary_unknown_external_outcome_v1',
        ],
        'Summary terminal receipt',
      );
      requireType(
        origin.resourceTerminalEventId,
        ['resource_budget.reconciled', 'resource_budget.released', 'resource_budget.unknown'],
        'Summary resource terminal receipt',
      );
    } else {
      requireType(
        origin.resourceUnknownEventId,
        ['resource_budget.unknown'],
        'Summary late-resolution unknown receipt',
      );
      requireType(
        origin.resourceReconciledEventId,
        ['resource_budget.reconciled'],
        'Summary late-resolution reconciliation receipt',
      );
    }
  };
  if (lifecycle.kind === 'normal_reprepare_required') validateOrigin(lifecycle.receipt.origin);
  if (lifecycle.kind === 'idle' && lifecycle.lastConsumption) {
    validateOrigin(lifecycle.lastConsumption.originReceipt.origin);
    const consumed = events.find(
      (entry) =>
        entry.producer_generation === generation &&
        entry.event.type === 'context.normal_reprepare_consumed_v1' &&
        entry.event.consumptionKey.consumptionBatchId ===
          lifecycle.lastConsumption?.consumptionBatchId,
    );
    if (!consumed) {
      throw new Error('Continuation consumption ownership lacks its exact durable event.');
    }
  }
}

function closeLegacyPendingCompactionV23(input: {
  state: RuntimeState;
  sourceSchemaVersion: number;
  observedHead: RuntimeMigrationIdentityV1['observedHead'];
  allEvents: StoredEvent[];
  threadId: string;
  generation: number;
}): { state: RuntimeState; events: RuntimeEvent[]; metadata: RuntimeEventMetadata[] } {
  if (
    (input.sourceSchemaVersion !== 21 && input.sourceSchemaVersion !== 22) ||
    !input.state.context.pendingCompaction
  ) {
    return { state: input.state, events: [], metadata: [] };
  }
  const pending = input.state.context.pendingCompaction;
  const durableTerminal = [...input.allEvents]
    .reverse()
    .map((entry) => entry.event)
    .find(
      (event) =>
        (event.type === 'context.compaction_completed' ||
          event.type === 'context.compaction_failed') &&
        event.compactionId === pending.compactionId,
    );
  let state = durableTerminal ? reduceRuntimeState(input.state, durableTerminal) : input.state;
  if (!state.context.pendingCompaction) {
    return { state, events: [], metadata: [] };
  }
  const reservation =
    state.resourceBudget.status === 'active'
      ? Object.values(state.resourceBudget.reservations).find(
          (candidate) => candidate.invocationId === `compaction:${pending.compactionId}`,
        )
      : undefined;
  const dispatched =
    reservation?.state === 'dispatch_started' ||
    reservation?.state === 'unknown' ||
    reservation?.state === 'reconciled';
  const event: RuntimeEvent = dispatched
    ? {
        type: 'context.compaction_unknown_external_outcome',
        compactionId: pending.compactionId,
        sourceRevision: state.revision,
        ...(reservation ? { reservationId: reservation.reservationId } : {}),
      }
    : {
        type: 'context.compaction_migration_cancelled',
        compactionId: pending.compactionId,
        sourceRevision: state.revision,
        outcome: 'not_dispatched',
      };
  const revision = input.observedHead.revision + 1;
  const envelope = buildRuntimeEventEnvelopeV24({
    threadId: input.threadId,
    generation: input.generation,
    revision,
    occurredAt: new Date(0).toISOString(),
    payload: event,
  });
  const eventId = envelope.eventId;
  state = {
    ...reduceRuntimeState(state, event),
    revision,
    lastAppliedEventId: eventId,
    appliedEventIds: [...state.appliedEventIds, eventId].slice(-4096),
    storageFormat: advanceRuntimeStorageFormatV24({
      current: state.storageFormat,
      eventId,
      canonicalBytes: Buffer.byteLength(canonicalRuntimeEventEnvelopeBytesV24(envelope), 'utf8'),
    }),
  };
  return {
    state,
    events: [event],
    metadata: [
      {
        eventId,
        revision,
        occurredAt: envelope.occurredAt,
        schemaVersion: 24,
        generation: input.generation,
        canonicalBytes: Buffer.byteLength(canonicalRuntimeEventEnvelopeBytesV24(envelope), 'utf8'),
      },
    ],
  };
}

function validateSnapshotPrefixV22(
  snapshotRecord: {
    state: RuntimeState;
    metadata: import('./store').RuntimeSnapshotMetadata;
  },
  allEvents: StoredEvent[],
  activeGeneration: number,
): void {
  const { state, metadata } = snapshotRecord;
  if (metadata.schemaVersion !== state.schemaVersion) {
    throw new Error(
      `Runtime snapshot schema mismatch: metadata ${metadata.schemaVersion}, state ${state.schemaVersion}.`,
    );
  }
  if (state.schemaVersion < 22) return;
  if (metadata.stateRevision !== state.revision) {
    throw new Error(
      `Schema-v22 snapshot revision mismatch: metadata ${metadata.stateRevision}, state ${state.revision}.`,
    );
  }
  const prefix = allEvents.filter((entry) => entry.id <= metadata.eventPosition);
  if (state.schemaVersion === 24) {
    const storage = state.storageFormat;
    if (
      storage?.format !== 'v24_strict' ||
      storage.ledgerBase.baseRevision + storage.tailEventCount !== state.revision ||
      storage.tailEventCount > prefix.length
    ) {
      throw new Error('Schema-v24 snapshot ledger base is inconsistent.');
    }
    const tail = storage.tailEventCount === 0 ? [] : prefix.slice(-storage.tailEventCount);
    const tailIds: string[] = [];
    for (const [index, entry] of tail.entries()) {
      if (
        !entry.event_id ||
        !/^[a-f0-9]{64}$/.test(entry.event_id) ||
        entry.revision !== storage.ledgerBase.baseRevision + index + 1 ||
        tailIds.includes(entry.event_id)
      ) {
        throw new Error('Schema-v24 canonical tail is invalid.');
      }
      const envelope = {
        schemaVersion: 24 as const,
        generation: entry.producer_generation,
        threadId: entry.thread_id,
        eventId: entry.event_id,
        revision: entry.revision,
        causationId: entry.causation_id ?? null,
        occurredAt: entry.occurred_at,
        payload: entry.event,
      } as RuntimeEventEnvelopeV24;
      if (
        entry.producer_generation !== activeGeneration ||
        entry.canonical_bytes == null ||
        entry.canonical_bytes < 1
      ) {
        throw new Error('Schema-v24 canonical tail ownership evidence is invalid.');
      }
      assertCanonicalRuntimeEventEnvelopeV24(envelope);
      if (
        entry.canonical_bytes !==
        Buffer.byteLength(canonicalRuntimeEventEnvelopeBytesV24(envelope), 'utf8')
      ) {
        throw new Error('Schema-v24 canonical tail byte evidence is invalid.');
      }
      tailIds.push(entry.event_id);
    }
    if (
      JSON.stringify(state.appliedEventIds) !== JSON.stringify(tailIds.slice(-4096)) ||
      (tailIds.length > 0
        ? state.lastAppliedEventId !== tailIds.at(-1)
        : state.lastAppliedEventId !== undefined)
    ) {
      throw new Error('Schema-v24 applied event ledger does not match its canonical tail.');
    }
    return;
  }
  const head = prefix.at(-1);
  if (
    (metadata.eventPosition === 0 && (prefix.length !== 0 || state.revision !== 0)) ||
    (metadata.eventPosition > 0 &&
      (!head ||
        head.id !== metadata.eventPosition ||
        head.revision !== state.revision ||
        (state.revision > 0
          ? !head.event_id || head.event_id !== state.lastAppliedEventId
          : head.event_id != null || state.lastAppliedEventId !== undefined)))
  ) {
    throw new Error('Schema-v22 snapshot cut does not match its durable event prefix head.');
  }
  const prefixEventIds: string[] = [];
  let observedV22Metadata = false;
  for (const entry of prefix) {
    const hasV22Metadata = Boolean(entry.event_id) || entry.revision !== 0;
    if (!hasV22Metadata) {
      if (observedV22Metadata) {
        throw new Error('Schema-v22 snapshot prefix cannot return to legacy event metadata.');
      }
      continue;
    }
    observedV22Metadata = true;
    if (
      !entry.event_id ||
      entry.revision !== prefixEventIds.length + 1 ||
      prefixEventIds.includes(entry.event_id)
    ) {
      throw new Error('Schema-v22 snapshot prefix lacks unique, contiguous event metadata.');
    }
    prefixEventIds.push(entry.event_id);
  }
  const expectedAppliedEventIds = prefixEventIds.slice(-4096);
  if (JSON.stringify(state.appliedEventIds ?? []) !== JSON.stringify(expectedAppliedEventIds)) {
    throw new Error('Schema-v22 snapshot appliedEventIds do not match its durable prefix.');
  }
  if (metadata.eventPosition === 0 && state.lastAppliedEventId !== undefined) {
    throw new Error('Schema-v22 empty snapshot cannot name a last applied event.');
  }
}

function replayPersistedTail(
  state: RuntimeState,
  tail: StoredEvent[],
  threadId: string,
  sourceSchemaVersion: number,
  activeGeneration: number,
): RuntimeState {
  let current = state;
  if (sourceSchemaVersion >= 22) {
    assertInvalidModelToolCallClosureV2(tail.map((entry) => entry.event));
  }
  const legacySourceVersion = isSupportedLegacySchemaVersionV22(sourceSchemaVersion)
    ? sourceSchemaVersion
    : undefined;
  for (let tailIndex = 0; tailIndex < tail.length; tailIndex++) {
    const entry = tail[tailIndex]!;
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
    const durableEnvelope =
      sourceSchemaVersion >= 24
        ? {
            schemaVersion: 24 as const,
            generation: entry.producer_generation,
            threadId: entry.thread_id,
            eventId: entry.event_id,
            revision: entry.revision,
            causationId: entry.causation_id ?? null,
            occurredAt: entry.occurred_at,
            payload: entry.event,
          }
        : undefined;
    if (durableEnvelope) {
      if (
        durableEnvelope.generation !== activeGeneration ||
        entry.canonical_bytes == null ||
        entry.canonical_bytes < 1
      ) {
        throw new Error(`Runtime event ${entry.id} lacks canonical v24 ownership evidence.`);
      }
      assertCanonicalRuntimeEventEnvelopeV24(durableEnvelope as RuntimeEventEnvelopeV24);
      if (
        entry.canonical_bytes !==
        Buffer.byteLength(
          canonicalRuntimeEventEnvelopeBytesV24(durableEnvelope as RuntimeEventEnvelopeV24),
          'utf8',
        )
      ) {
        throw new Error(`Runtime event ${entry.id} canonical byte evidence is invalid.`);
      }
    }
    const replayEvent =
      sourceSchemaVersion < 24 &&
      entry.event.type === 'context.compaction_completed' &&
      isLegacyCheckpointV2(entry.event.checkpoint)
        ? {
            ...entry.event,
            checkpoint: readLegacyCheckpointV2ReadOnly({
              checkpoint: entry.event.checkpoint,
              state: current,
            }),
          }
        : entry.event;
    const terminalEvent =
      replayEvent.type === 'tool.finished' ||
      replayEvent.type === 'tool.failed' ||
      replayEvent.type === 'tool.rejected' ||
      replayEvent.type === 'tool.cancelled'
        ? replayEvent
        : undefined;
    const persistedTerminal =
      legacySourceVersion !== undefined &&
      terminalEvent !== undefined &&
      !terminalEvent.modelResult;
    const existingMessage = persistedTerminal
      ? current.transcript.messages.find(
          (message) => message.kind === 'tool' && message.toolCallId === terminalEvent.toolCallId,
        )
      : undefined;
    const existingMigration =
      existingMessage?.kind === 'tool' ? existingMessage.resultMeta?.terminalMigration : undefined;
    const event = persistedTerminal
      ? {
          ...replayEvent,
          modelResult: {
            kind: 'legacy_unverified' as const,
            migratedFromSchemaVersion:
              existingMigration?.migratedFromSchemaVersion ?? legacySourceVersion,
            originalEventPosition: existingMigration?.originalEventPosition ?? entry.id,
          },
        }
      : replayEvent;
    if (event.type === 'model.responded' && event.contextEvidence) {
      const branchLength = event.contextEvidence.reclaimReceiptDigest === 'none' ? 2 : 3;
      const branch = tail
        .slice(tailIndex, tailIndex + branchLength)
        .map((candidate) => candidate.event);
      assertContextPrimarySuccessBatchV2(branch, current);
    } else if (
      event.type === 'context.reclaim_commit_advanced' ||
      (event.type === 'resource_budget.reconciled' && event.terminalBatchId)
    ) {
      const previous = tail[tailIndex - 1]?.event;
      const validContinuation =
        (previous?.type === 'model.responded' &&
          previous.contextEvidence?.terminalBatchId ===
            (event.type === 'context.reclaim_commit_advanced'
              ? event.terminalBatchId
              : event.terminalBatchId)) ||
        (previous?.type === 'context.reclaim_commit_advanced' &&
          event.type === 'resource_budget.reconciled' &&
          previous.terminalBatchId === event.terminalBatchId);
      if (!validContinuation) {
        throw new Error(`Runtime event ${entry.id} is a standalone primary branch continuation.`);
      }
    }
    if (
      event.type === 'tool.finished' ||
      event.type === 'tool.failed' ||
      event.type === 'tool.rejected' ||
      event.type === 'tool.cancelled'
    ) {
      if (event.modelResult?.kind === 'verified_v2') {
        validateVerifiedToolTerminalEventV2(current, event);
      } else if (
        current.schemaVersion >= 22 &&
        !(
          legacySourceVersion !== undefined &&
          event.modelResult?.kind === 'legacy_unverified' &&
          event.modelResult.migratedFromSchemaVersion === sourceSchemaVersion &&
          (event.modelResult.originalEventPosition === entry.id ||
            event.modelResult.originalEventPosition === existingMigration?.originalEventPosition)
        )
      ) {
        throw new Error(`Runtime event ${entry.id} is missing a verified schema-v22 terminal.`);
      }
    }
    const reduced = reduceRuntimeState(current, event);
    const transcriptAdvanced =
      reduced.transcript.messages.length > current.transcript.messages.length;
    current = {
      ...reduced,
      ...(transcriptAdvanced
        ? {
            context: {
              ...reduced.context,
              lastTranscriptProducingEventCutV1: {
                revision: entry.revision,
                eventId: entry.event_id,
              },
            },
          }
        : {}),
      revision: entry.revision,
      lastAppliedEventId: entry.event_id,
      appliedEventIds: [...(reduced.appliedEventIds ?? []), entry.event_id].slice(-4096),
      ...(durableEnvelope
        ? {
            storageFormat: advanceRuntimeStorageFormatV24({
              current: reduced.storageFormat,
              eventId: entry.event_id,
              canonicalBytes: entry.canonical_bytes!,
            }),
          }
        : {}),
    };
    if (sourceSchemaVersion >= 24) {
      assertRuntimeStateInvariants(current);
    }
  }
  if (sourceSchemaVersion < 24 && current.schemaVersion === 24) {
    const { storageFormat: _storageFormat, ...canonicalCurrent } = current;
    const canonicalPreV24State = {
      ...canonicalCurrent,
      schemaVersion: 23,
    };
    current = {
      ...current,
      lastAppliedEventId: undefined,
      appliedEventIds: [],
      storageFormat: createMigratedRuntimeStorageFormatV24({
        sourceSchemaVersion: 23,
        stateRevision: current.revision,
        canonicalPreV24State: JSON.stringify(canonicalPreV24State),
      }),
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
      turn = {
        turnId: turn.turnId,
        turnIndex: turn.turnIndex,
        status: 'active',
      };
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

function migrateRuntimeState(
  snapshot: RuntimeState,
  migrationSource: {
    sourceSnapshot: import('./store').RuntimeSnapshotMetadata;
    prefixEvents: StoredEvent[];
  },
): RuntimeState | null {
  const normalizedSnapshot = snapshot;

  if (snapshot.schemaVersion === RUNTIME_STATE_SCHEMA_VERSION)
    return normalizeRuntimeMetadata(normalizedSnapshot);
  if (snapshot.schemaVersion === 23) {
    return migrateRuntimeStateV23ToV24(normalizedSnapshot);
  }
  if (snapshot.schemaVersion === 22) {
    return migrateRuntimeStateV23ToV24(migrateRuntimeStateV22ToV23(normalizedSnapshot));
  }
  if (!isSupportedLegacySchemaVersionV22(snapshot.schemaVersion)) return null;

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
    ...normalizeRuntimeMetadata(normalizedSnapshot, true),
    schemaVersion: 22,
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
    suspendedSubagents: snapshot.suspendedSubagents ?? {},
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

  return migrateRuntimeStateV23ToV24(
    migrateRuntimeStateV22ToV23(
      normalizeLegacyPlanDocuments(
        normalizeLegacySnapshotTerminalResults(
          migratedState,
          snapshot.schemaVersion,
          migrationSource.sourceSnapshot.eventPosition,
          migrationSource.prefixEvents,
        ),
      ),
    ),
  );
}

/** Explicit second phase: v2..v21 first normalize to v22, then v22 upgrades to v23. */
function migrateRuntimeStateV22ToV23(snapshot: RuntimeState): RuntimeState {
  if (snapshot.schemaVersion !== 22) {
    throw new Error(`Expected a schema-v22 migration source, received ${snapshot.schemaVersion}.`);
  }
  const normalized = normalizeRuntimeMetadata(snapshot);
  return {
    ...normalized,
    schemaVersion: 23,
    context: normalized.context,
  };
}

/** Explicit, pure v23→v24 cutover. Store CAS publishes this candidate atomically. */
function migrateRuntimeStateV23ToV24(snapshot: RuntimeState): RuntimeState {
  if (snapshot.schemaVersion !== 23) {
    throw new Error(`Expected a schema-v23 migration source, received ${snapshot.schemaVersion}.`);
  }
  const { storageFormat: _legacyStorageFormat, ...preV24 } = snapshot as RuntimeState & {
    storageFormat?: unknown;
  };
  const normalized = normalizeRuntimeMetadata(snapshot);
  return {
    ...normalized,
    schemaVersion: RUNTIME_STATE_SCHEMA_VERSION,
    lastAppliedEventId: undefined,
    appliedEventIds: [],
    storageFormat: createMigratedRuntimeStorageFormatV24({
      sourceSchemaVersion: 23,
      stateRevision: snapshot.revision,
      canonicalPreV24State: JSON.stringify(preV24),
    }),
    context: normalized.context,
  };
}

type LegacyTerminalSourceV22 = {
  toolCallId: string;
  terminalKind: 'tool.finished' | 'tool.failed' | 'tool.rejected' | 'tool.cancelled';
  eventPosition: number;
  sourceEvent: RuntimeEvent;
  directTerminal: boolean;
};

function legacyTerminalSourceV22(entry: StoredEvent): LegacyTerminalSourceV22 | undefined {
  const event = entry.event;
  switch (event.type) {
    case 'tool.finished':
    case 'tool.failed':
    case 'tool.rejected':
    case 'tool.cancelled':
      return {
        toolCallId: event.toolCallId,
        terminalKind: event.type,
        eventPosition: entry.id,
        sourceEvent: event,
        directTerminal: true,
      };
    case 'approval.rejected':
      return event.toolCallId
        ? {
            toolCallId: event.toolCallId,
            terminalKind: 'tool.rejected',
            eventPosition: entry.id,
            sourceEvent: event,
            directTerminal: false,
          }
        : undefined;
    case 'auto_review.completed':
      return event.result.ok && !event.result.approved
        ? {
            toolCallId: event.toolCallId,
            terminalKind: 'tool.rejected',
            eventPosition: entry.id,
            sourceEvent: event,
            directTerminal: false,
          }
        : undefined;
    case 'provider.action_required':
      return {
        toolCallId: event.originatingToolCallId,
        terminalKind: 'tool.failed',
        eventPosition: entry.id,
        sourceEvent: event,
        directTerminal: false,
      };
    case 'user_input.answered':
    case 'user_input.cancelled':
      return {
        toolCallId: event.toolCallId,
        terminalKind: 'tool.finished',
        eventPosition: entry.id,
        sourceEvent: event,
        directTerminal: false,
      };
    case 'plan.review_cancelled':
      return event.toolCallId
        ? {
            toolCallId: event.toolCallId,
            terminalKind: 'tool.cancelled',
            eventPosition: entry.id,
            sourceEvent: event,
            directTerminal: false,
          }
        : undefined;
    default:
      return undefined;
  }
}

function legacySourceMatchesStatus(
  status: import('./state').ToolCallStatus,
  source: LegacyTerminalSourceV22,
): boolean {
  if (source.terminalKind === 'tool.finished') {
    return status === 'succeeded' || status === 'failed' || status === 'exhausted';
  }
  if (source.terminalKind === 'tool.failed') return status === 'failed';
  if (source.terminalKind === 'tool.rejected') return status === 'rejected';
  return status === 'cancelled';
}

function selectLegacyTerminalSourceV22(
  toolCallId: string,
  status: import('./state').ToolCallStatus,
  sources: LegacyTerminalSourceV22[],
): LegacyTerminalSourceV22 {
  let candidates = sources.filter((source) => legacySourceMatchesStatus(status, source));
  const direct = candidates.filter((source) => source.directTerminal);
  if (direct.length > 0) candidates = direct;
  if (candidates.length === 0) {
    throw new Error(`Legacy Tool Result '${toolCallId}' lacks a proven event position.`);
  }
  const first = candidates[0]!;
  if (
    candidates.some(
      (candidate) =>
        candidate.terminalKind !== first.terminalKind ||
        JSON.stringify(candidate.sourceEvent) !== JSON.stringify(first.sourceEvent),
    )
  ) {
    throw new Error(`Legacy Tool Result '${toolCallId}' has conflicting terminal events.`);
  }
  return first;
}

function normalizeLegacySnapshotTerminalResults(
  state: RuntimeState,
  sourceSchemaVersion: import('./tool-terminal-v2').SupportedLegacySchemaVersionV22,
  cutoverEventPosition: number,
  prefixEvents: StoredEvent[],
): RuntimeState {
  const sourcesByCall = new Map<string, LegacyTerminalSourceV22[]>();
  for (const entry of prefixEvents) {
    if (entry.id <= 0 || entry.id > cutoverEventPosition) continue;
    const source = legacyTerminalSourceV22(entry);
    if (!source) continue;
    const sources = sourcesByCall.get(source.toolCallId) ?? [];
    sources.push(source);
    sourcesByCall.set(source.toolCallId, sources);
  }

  const canonicalByCall = new Map<
    string,
    Extract<RuntimeState['transcript']['messages'][number], { kind: 'tool' }>
  >();
  const retainedMessages: RuntimeState['transcript']['messages'] = [];
  for (const message of state.transcript.messages) {
    if (message.kind !== 'tool') {
      retainedMessages.push(message);
      continue;
    }
    const existing = canonicalByCall.get(message.toolCallId);
    if (existing) {
      if (existing.content !== message.content || existing.ok !== message.ok) {
        throw new Error(`Legacy tool '${message.toolCallId}' has conflicting canonical results.`);
      }
      continue;
    }
    canonicalByCall.set(message.toolCallId, message);
    retainedMessages.push(message);
  }

  const nextCalls = { ...state.tools.calls };
  const normalizedMessages = retainedMessages.map((message) => {
    if (message.kind !== 'tool') return message;
    const call = state.tools.calls[message.toolCallId];
    if (
      !call ||
      !['succeeded', 'failed', 'rejected', 'cancelled', 'exhausted'].includes(call.status)
    ) {
      throw new Error(`Legacy Tool Result '${message.toolCallId}' lacks one settled call.`);
    }
    const first = selectLegacyTerminalSourceV22(
      message.toolCallId,
      call.status,
      sourcesByCall.get(message.toolCallId) ?? [],
    );
    const migration = {
      kind: 'legacy_unverified' as const,
      migratedFromSchemaVersion: sourceSchemaVersion,
      originalEventPosition: first.eventPosition,
    };
    const resultMeta = {
      ...normalizeToolResultMetaProvenance(message.resultMeta, true),
      terminalKind: first.terminalKind,
      terminalMigration: migration,
    };
    nextCalls[message.toolCallId] = {
      ...call,
      result: {
        ...(call.result ?? {
          ok: message.ok,
          summary: call.error ?? `Legacy ${first.terminalKind} result`,
        }),
        ok: message.ok,
        resultMeta,
      },
    };
    return { ...message, resultMeta };
  });

  for (const [toolCallId, call] of Object.entries(nextCalls)) {
    if (!['succeeded', 'failed', 'rejected', 'cancelled', 'exhausted'].includes(call.status))
      continue;
    if (!canonicalByCall.has(toolCallId)) {
      const source = selectLegacyTerminalSourceV22(
        toolCallId,
        call.status,
        sourcesByCall.get(toolCallId) ?? [],
      );
      if (source.sourceEvent.type !== 'provider.action_required') {
        throw new Error(`Legacy settled tool '${toolCallId}' lacks its canonical Tool Result.`);
      }
      const migration = {
        kind: 'legacy_unverified' as const,
        migratedFromSchemaVersion: sourceSchemaVersion,
        originalEventPosition: source.eventPosition,
      };
      const resultMeta = {
        digestScope: 'legacy_unknown' as const,
        terminalKind: source.terminalKind,
        terminalMigration: migration,
      };
      const content = call.error ?? 'MCP provider action is required.';
      nextCalls[toolCallId] = {
        ...call,
        result: {
          ...(call.result ?? { ok: false, summary: content }),
          ok: false,
          resultMeta,
        },
      };
      normalizedMessages.push({
        kind: 'tool',
        messageId: `tool-${toolCallId}`,
        turnId: state.turn.turnId,
        ordinal: normalizedMessages.length,
        createdAt: new Date(0).toISOString(),
        toolCallId,
        name: call.name,
        content,
        ok: false,
        resultMeta,
      });
    }
  }

  return {
    ...state,
    tools: { ...state.tools, calls: nextCalls },
    transcript: {
      ...state.transcript,
      messages: normalizedMessages.map((message, ordinal) => ({
        ...message,
        ordinal,
      })),
    },
  };
}

function normalizeRuntimeMetadata(
  state: RuntimeState,
  forceLegacyProvenance = false,
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
  const legacyContext = raw.context as
    | (RuntimeState['context'] & {
        activeCheckpoint?: unknown;
        history?: Array<{ kind?: string; checkpoint?: unknown }>;
        autoGuard?: unknown;
        autoGuardV2?: unknown;
      })
    | undefined;
  const activeCheckpoint = isLegacyCheckpointV2(legacyContext?.activeCheckpoint)
    ? readLegacyCheckpointV2ReadOnly({
        checkpoint: legacyContext.activeCheckpoint,
        state,
      })
    : legacyContext?.activeCheckpoint;
  const contextWithoutLegacyGuard = legacyContext
    ? Object.fromEntries(
        Object.entries(legacyContext).filter(
          ([key]) => key !== 'autoGuard' && key !== 'autoGuardV2',
        ),
      )
    : undefined;
  const contextInput = contextWithoutLegacyGuard
    ? ({
        ...contextWithoutLegacyGuard,
        ...(activeCheckpoint ? { activeCheckpoint } : { activeCheckpoint: undefined }),
        history: (legacyContext?.history ?? []).filter(
          (entry) => entry.kind !== 'completed' || !isLegacyCheckpointV2(entry.checkpoint),
        ),
      } as RuntimeState['context'])
    : undefined;
  return {
    ...state,
    revision: Number.isInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0,
    appliedEventIds: Array.isArray(raw.appliedEventIds) ? raw.appliedEventIds.slice(-4096) : [],
    recoveryState: raw.recoveryState ?? { kind: 'normal' },
    context: normalizeContextRuntimeState(contextInput),
    resourceBudget: normalizeResourceBudgetMetadata(
      raw.resourceBudget ?? createLegacyResourceBudgetStateV1(17),
    ),
    turn: {
      ...state.turn,
      status:
        raw.turn.status === 'completed' || raw.turn.status === 'aborted'
          ? raw.turn.status
          : 'active',
    },
    tools: {
      ...state.tools,
      calls: Object.fromEntries(
        Object.entries(state.tools.calls).map(([toolCallId, call]) => [
          toolCallId,
          call.result
            ? {
                ...call,
                result: {
                  ...call.result,
                  resultMeta: normalizeToolResultMetaProvenance(
                    call.result.resultMeta,
                    forceLegacyProvenance,
                  ),
                },
              }
            : call,
        ]),
      ),
    },
    transcript: {
      ...state.transcript,
      messages: (state.transcript?.messages ?? []).map((message, ordinal) => {
        const normalized = {
          ...message,
          messageId:
            message.messageId ??
            (message.kind === 'tool'
              ? `tool-${message.toolCallId}`
              : `legacy-${state.session.threadId}-${ordinal}`),
          turnId: message.turnId ?? state.turn.turnId,
          ordinal: Number.isInteger(message.ordinal) ? message.ordinal : ordinal,
          createdAt: message.createdAt ?? new Date(0).toISOString(),
        };
        return message.kind === 'tool'
          ? {
              ...normalized,
              resultMeta: normalizeToolResultMetaProvenance(
                message.resultMeta,
                forceLegacyProvenance,
              ),
            }
          : normalized;
      }),
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
  };
}

function normalizeToolResultMetaProvenance(
  resultMeta: import('./state').ToolResultMeta | undefined,
  forceLegacyProvenance = false,
): import('./state').ToolResultMeta {
  const {
    toolResultReceipt: _toolResultReceipt,
    terminalIdentity: _terminalIdentity,
    terminalKind: _terminalKind,
    terminalMigration: _terminalMigration,
    ...legacySafe
  } = resultMeta ?? {};
  if (forceLegacyProvenance) {
    return { ...legacySafe, digestScope: 'legacy_unknown' };
  }
  return {
    ...(resultMeta ?? {}),
    digestScope:
      resultMeta?.digestScope === 'raw' || resultMeta?.digestScope === 'projected'
        ? resultMeta.digestScope
        : 'legacy_unknown',
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
function normalizeLegacyPlanDocuments(state: RuntimeState): RuntimeState {
  let changed = false;
  const tasks = Object.fromEntries(
    Object.entries(state.tasks).map(([taskId, task]) => {
      const normalize = (document: import('@/protocol/events').PlanDocument) => {
        if (document.structuralDigest) return document;
        changed = true;
        return {
          ...document,
          structuralDigest: computePlanStructuralDigest(document),
        };
      };
      const planning = task.planning;
      const nextPlanning =
        'document' in planning && planning.document
          ? { ...planning, document: normalize(planning.document) }
          : planning;
      const planHistory = task.planHistory.map(normalize);
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
