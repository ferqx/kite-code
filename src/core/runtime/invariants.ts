// ── Runtime 状态不变量 / Runtime state invariants ──

import { canonicalContextDigestV3 } from '@/core/model/context-checkpoint-v3';
import { validateVerificationSpec } from '@/core/verification/spec';
import { assertResourceBudgetRuntimeStateV1 } from './resource-budget';
import type { RuntimeState, ToolCallStatus } from './state';

const TERMINAL_TOOL_STATUSES = new Set<ToolCallStatus>([
  'succeeded',
  'failed',
  'rejected',
  'cancelled',
  'exhausted',
]);

export class RuntimeInvariantError extends Error {
  readonly code = 'RUNTIME_INVARIANT_VIOLATION';

  constructor(message: string) {
    super(message);
    this.name = 'RuntimeInvariantError';
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new RuntimeInvariantError(message);
}

function assertUnique(values: string[], label: string): void {
  assert(new Set(values).size === values.length, `${label} contains duplicate tool ids.`);
}

function interactionToolId(state: RuntimeState): string | undefined {
  const interaction = state.interactions;
  return interaction.kind === 'idle' ||
    interaction.kind === 'awaiting_provider_action' ||
    interaction.kind === 'awaiting_provider_admission'
    ? undefined
    : interaction.toolCallId;
}

/**
 * Validate the complete persisted RuntimeState before it is committed.
 * This is intentionally strict at the Kernel boundary and reusable by fuzz tests.
 */
export function assertRuntimeStateInvariants(state: RuntimeState): void {
  assert(state.schemaVersion === 24, 'runtime state must use schema v24.');
  assert(
    state.storageFormat?.format === 'v24_strict' &&
      state.storageFormat.canonicalEventRegistryId === 'runtime-event-registry:v24',
    'runtime state must use the strict v24 event registry.',
  );
  assert(
    state.storageFormat.ledgerBase.nextRevision === state.storageFormat.ledgerBase.baseRevision + 1,
    'runtime event ledger base revision is inconsistent.',
  );
  assert(
    state.revision >= 0 && Number.isInteger(state.revision),
    'revision must be a non-negative integer.',
  );
  assertUnique(state.appliedEventIds, 'applied event ids');
  if (state.lastAppliedEventId) {
    assert(
      state.appliedEventIds.includes(state.lastAppliedEventId),
      'lastAppliedEventId must be present in appliedEventIds.',
    );
  }
  assert(
    state.recoveryState.kind === 'normal' || state.turn.status === 'aborted',
    'recovery state must be normal before execution.',
  );
  assert(
    state.turn.status === 'active' ||
      state.turn.status === 'completed' ||
      state.turn.status === 'aborted',
    'turn status must be a known lifecycle value.',
  );
  if (state.turn.status === 'aborted') {
    assert(Boolean(state.turn.abortReason), 'aborted turn reason is required.');
  }
  assertUnique(state.tools.queue, 'tool queue');
  assertUnique(state.tools.active, 'active tools');
  assert(state.context != null, 'context runtime state is required.');
  assertResourceBudgetRuntimeStateV1(state.resourceBudget);
  assert(state.context.history.length <= 128, 'context compaction history exceeds its bound.');
  if (state.context.pendingCompaction) {
    const pending = state.context.pendingCompaction;
    assert(pending.reason === 'manual', 'only manual compaction may remain pending.');
    assert(Boolean(pending.compactionId), 'pending compaction id is required.');
    assert(
      Number.isInteger(pending.requestedAtRevision) && pending.requestedAtRevision >= 0,
      'pending compaction source revision must be a non-negative integer.',
    );
    assert(Boolean(pending.requestedAtTurnId), 'pending compaction turn id is required.');
    assert(
      Number.isFinite(pending.estimate.totalInputTokens) && pending.estimate.totalInputTokens >= 0,
      'pending compaction token estimate must be non-negative.',
    );
  }
  if (state.context.activeCheckpoint) {
    const checkpoint = state.context.activeCheckpoint;
    assert(checkpoint.summary.trim().length > 0, 'active context summary must be non-empty.');
    assert(Boolean(checkpoint.compactionId), 'active context checkpoint id is required.');
    if (checkpoint.version === 3) {
      assert(
        Boolean(checkpoint.source.sourceRangeDigest),
        'active context checkpoint digest is required.',
      );
      assert(
        checkpoint.inputTokensAfter < checkpoint.inputTokensBefore &&
          checkpoint.inputTokensBefore - checkpoint.inputTokensAfter >= 1_024,
        'active context checkpoint must save at least 1024 tokens.',
      );
    }
    const coveredThroughMessageId =
      checkpoint.version === 3
        ? checkpoint.source.coveredThroughMessageId
        : checkpoint.coveredThroughMessageId;
    const coveredThroughTurnId =
      checkpoint.version === 3
        ? checkpoint.source.coveredThroughTurnId
        : checkpoint.coveredThroughTurnId;
    const boundary = state.transcript.messages.find(
      (message) => message.messageId === coveredThroughMessageId,
    );
    assert(boundary != null, 'active context checkpoint boundary must exist in the transcript.');
    assert(
      boundary.turnId === coveredThroughTurnId,
      'active context checkpoint boundary turn is inconsistent.',
    );
    if (checkpoint.version === 3 && state.context.projectionBaseIdentity) {
      assert(
        state.context.projectionBaseIdentity ===
          `checkpoint:${checkpoint.checkpointId}:${checkpoint.source.sourceRangeDigest}`,
        'checkpoint projection base identity is inconsistent.',
      );
    }
  }
  const summaryLifecycle = state.context.summaryLifecycle;
  if (summaryLifecycle.kind !== 'idle') {
    const attempt =
      summaryLifecycle.kind === 'normal_reprepare_required' ? undefined : summaryLifecycle.attempt;
    if (attempt) {
      assert(
        Boolean(attempt.attemptId && attempt.compactionId),
        'summary attempt identity is required.',
      );
      assert(
        Number.isSafeInteger(attempt.sourceProducingEventCutV1.revision) &&
          attempt.sourceProducingEventCutV1.revision >= 1 &&
          /^[a-f0-9]{64}$/.test(attempt.sourceProducingEventCutV1.eventId),
        'summary source-producing event cut is invalid.',
      );
      if (summaryLifecycle.kind === 'requested') {
        assert(
          /^[a-f0-9]{64}$/.test(summaryLifecycle.requestedEventId ?? ''),
          'requested summary lacks its canonical event receipt.',
        );
      }
      if (summaryLifecycle.kind === 'started') {
        const receipt = summaryLifecycle.startedReceipt;
        assert(
          receipt != null &&
            [
              receipt.requestedEventId,
              receipt.resourceReservedEventId,
              receipt.resourceDispatchStartedEventId,
              receipt.summaryDispatchStartedEventId,
            ].every((eventId) => /^[a-f0-9]{64}$/.test(eventId)),
          'started summary lacks its closed canonical start receipt.',
        );
      }
      const continuation =
        'continuation' in summaryLifecycle ? summaryLifecycle.continuation : undefined;
      assert(
        (attempt.reason === 'auto' && continuation != null) ||
          (attempt.reason === 'manual' && continuation == null),
        'summary continuation does not match its trigger.',
      );
    }
    if (summaryLifecycle.kind === 'resource_resolution_required') {
      assert(
        summaryLifecycle.attempt.reason === 'auto',
        'resource-resolution lifecycle is auto-only.',
      );
      assert(
        /^[a-f0-9]{64}$/.test(summaryLifecycle.resourceUnknownEventId),
        'summary resolution lifecycle lacks its unknown resource event.',
      );
    }
    if (summaryLifecycle.kind === 'normal_reprepare_required') {
      assert(
        Number.isSafeInteger(summaryLifecycle.receipt.generation) &&
          summaryLifecycle.receipt.generation >= 1,
        'normal reprepare receipt generation is invalid.',
      );
      const origin = summaryLifecycle.receipt.origin;
      const originEventIds =
        origin.kind === 'summary_terminal'
          ? [origin.terminalEventId, origin.resourceTerminalEventId]
          : [origin.resourceUnknownEventId, origin.resourceReconciledEventId];
      assert(
        originEventIds.every((eventId) => /^[a-f0-9]{64}$/.test(eventId)),
        'normal reprepare origin references an unavailable event.',
      );
    }
  }
  if (summaryLifecycle.kind === 'idle' && summaryLifecycle.lastConsumption) {
    assert(
      summaryLifecycle.lastConsumption.generation >= 1 &&
        summaryLifecycle.lastConsumption.primaryRequestId.length > 0 &&
        summaryLifecycle.lastConsumption.resourceReservationId.length > 0,
      'normal continuation consumption receipt is invalid.',
    );
  }
  if (state.context.lastDetach) {
    const { checksum, ...body } = state.context.lastDetach;
    assert(
      checksum === canonicalContextDigestV3('normal-reprepare-consumption-detach:v1', body),
      'normal continuation detach checksum is invalid.',
    );
    assert(
      state.context.lastDetach.targetThreadId === state.session.threadId &&
        state.context.lastDetach.targetGeneration >= 1,
      'normal continuation detach target ownership is invalid.',
    );
    if (state.context.lastDetach.primaryState === 'in_flight') {
      assert(
        [
          state.context.lastDetach.runErrorEventId,
          state.context.lastDetach.resourceTerminalEventId,
          state.context.lastDetach.turnAbortedEventId,
        ].every((eventId) => typeof eventId === 'string' && /^[a-f0-9]{64}$/.test(eventId)),
        'in-flight continuation detach lacks its terminal quartet references.',
      );
    }
  }

  const activeIds = new Set(state.tools.active);
  for (const toolCallId of state.tools.queue) {
    assert(!activeIds.has(toolCallId), `tool ${toolCallId} cannot be queued and active.`);
  }

  for (const toolCallId of [...state.tools.queue, ...state.tools.active]) {
    const call = state.tools.calls[toolCallId];
    assert(call != null, `tool ${toolCallId} is referenced but has no call record.`);
    assert(
      !TERMINAL_TOOL_STATUSES.has(call.status),
      `terminal tool ${toolCallId} remains scheduled.`,
    );
  }

  const activeTask = state.activeTaskId ? state.tasks[state.activeTaskId] : undefined;
  const activeTaskIds = Object.values(state.tasks)
    .filter((task) => task.status === 'active')
    .map((task) => task.taskId);
  assert(activeTaskIds.length <= 1, 'runtime may contain only one active task.');
  assert(
    state.activeTaskId == null
      ? activeTaskIds.length === 0
      : activeTaskIds[0] === state.activeTaskId,
    'activeTaskId must identify the unique active task.',
  );
  if (state.activeTaskId) {
    assert(activeTask != null, `active task ${state.activeTaskId} does not exist.`);
    assert(activeTask.status === 'active', `active task ${state.activeTaskId} is not active.`);
    assert(
      JSON.stringify(activeTask.planning) === JSON.stringify(state.planning),
      `planning mirror is out of sync for task ${state.activeTaskId}.`,
    );
  }

  const interactionTool = interactionToolId(state);
  if (interactionTool) {
    const call = state.tools.calls[interactionTool];
    assert(call != null, `interaction references missing tool ${interactionTool}.`);
    assert(
      !TERMINAL_TOOL_STATUSES.has(call.status),
      `interaction references terminal tool ${interactionTool}.`,
    );
  }

  if (state.interactions.kind === 'awaiting_user_input') {
    assert(
      state.tools.calls[state.interactions.toolCallId]?.status === 'awaiting_user_input',
      'user input interaction must reference an awaiting_user_input tool.',
    );
  }
  if (state.interactions.kind === 'awaiting_review') {
    assert(
      state.tools.calls[state.interactions.toolCallId]?.status === 'awaiting_review',
      'plan review interaction must reference an awaiting_review tool.',
    );
  }
  if (state.interactions.kind === 'awaiting_tool_approval') {
    assert(
      state.tools.calls[state.interactions.toolCallId]?.status === 'awaiting_approval',
      'tool approval interaction must reference an awaiting_approval tool.',
    );
  }
  if (state.interactions.kind === 'awaiting_auto_review') {
    assert(
      state.tools.calls[state.interactions.toolCallId]?.status === 'awaiting_auto_review',
      'auto review interaction must reference an awaiting_auto_review tool.',
    );
  }
  if (state.interactions.kind === 'awaiting_provider_action') {
    const toolCallId = state.interactions.originatingToolCallId;
    assert(
      state.tools.calls[toolCallId]?.status === 'failed',
      'provider action must reference a terminal failed tool.',
    );
    assert(
      !state.tools.queue.includes(toolCallId) && !state.tools.active.includes(toolCallId),
      'provider action must not requeue its originating tool.',
    );
  }
  const pendingProviderIds = state.providerAdmission.pending.map((entry) => entry.providerId);
  assertUnique(pendingProviderIds, 'pending provider admissions');
  for (const providerId of pendingProviderIds) {
    assert(
      !state.providerAdmission.waivers[providerId],
      `provider ${providerId} cannot be pending and waived.`,
    );
  }
  if (state.interactions.kind === 'awaiting_provider_admission') {
    const current = state.providerAdmission.pending[0];
    assert(
      current?.interactionId === state.interactions.interactionId &&
        current.providerId === state.interactions.providerId,
      'provider admission interaction must match the first pending provider.',
    );
  } else {
    assert(
      state.providerAdmission.pending.length === 0,
      'pending provider admission requires an active admission interaction.',
    );
  }
  for (const frame of Object.values(state.skills.frames)) {
    assert(
      state.tasks[frame.taskId] != null,
      `Skill frame ${frame.activationId} references a missing task.`,
    );
    if (frame.status === 'active') {
      assert(
        !frame.closedAt && !frame.closeReason,
        `Active Skill frame ${frame.activationId} is closed.`,
      );
    } else {
      assert(
        Boolean(frame.closedAt && frame.closeReason),
        `Closed Skill frame ${frame.activationId} lacks closure facts.`,
      );
    }
  }
  for (const [verificationId, verification] of Object.entries(state.verification.records)) {
    assert(
      verification.verificationId === verificationId &&
        verification.spec.verificationId === verificationId,
      `Verification ${verificationId} identity is inconsistent.`,
    );
    assert(
      verification.attempts >= 0 && verification.repairAttempts >= 0,
      `Verification ${verificationId} attempt counters must be non-negative.`,
    );
    if (verification.status !== 'budget_exhausted' || !verification.diagnostics?.length) {
      assert(
        validateVerificationSpec(verification.spec).length === 0,
        `Verification ${verificationId} has an invalid spec.`,
      );
    }
    if (verification.status === 'waived') {
      assert(
        verification.waiver?.actor === 'user',
        `Verification ${verificationId} has an invalid waiver.`,
      );
    }
  }
}
