// ── Runtime 状态不变量 / Runtime state invariants ──

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
  assert(state.context.autoGuard != null, 'context autoGuard is required.');
  assert(state.context.history.length <= 128, 'context compaction history exceeds its bound.');
  if (state.context.pendingCompaction) {
    const pending = state.context.pendingCompaction;
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
    assert(checkpoint.version === 1, 'active context checkpoint version must be 1.');
    assert(checkpoint.summary.trim().length > 0, 'active context summary must be non-empty.');
    assert(Boolean(checkpoint.compactionId), 'active context checkpoint id is required.');
    assert(Boolean(checkpoint.sourceDigest), 'active context checkpoint digest is required.');
    assert(
      checkpoint.inputTokensAfter < checkpoint.inputTokensBefore &&
        checkpoint.inputTokensBefore - checkpoint.inputTokensAfter >= 1_024,
      'active context checkpoint must save at least 1024 tokens.',
    );
    const boundary = state.transcript.messages.find(
      (message) => message.messageId === checkpoint.coveredThroughMessageId,
    );
    assert(boundary != null, 'active context checkpoint boundary must exist in the transcript.');
    assert(
      boundary.turnId === checkpoint.coveredThroughTurnId,
      'active context checkpoint boundary turn is inconsistent.',
    );
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

  for (const [toolCallId, claim] of Object.entries(state.subagentResumeClaims)) {
    const call = state.tools.calls[toolCallId];
    const snapshot = state.suspendedSubagents[toolCallId];
    assert(
      call?.name === 'task',
      `subagent resume claim ${toolCallId} must belong to a task call.`,
    );
    assert(
      call.status === 'running',
      `subagent resume claim ${toolCallId} must keep its parent task running.`,
    );
    assert(
      snapshot != null,
      `subagent resume claim ${toolCallId} is missing its continuation snapshot.`,
    );
    assert(
      snapshot.subagentId === claim.subagentId &&
        snapshot.blockedTool.toolCallId === claim.childToolCallId,
      `subagent resume claim ${toolCallId} does not match its continuation identity.`,
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
