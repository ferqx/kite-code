// ── Runtime 状态不变量 / Runtime state invariants ──

import { validateVerificationSpec } from '@/core/verification/spec';
import { assertResourceBudgetRuntimeStateV1 } from './resource-budget';
import {
  RUNTIME_STATE_FORMAT_EPOCH,
  RUNTIME_STATE_SCHEMA_VERSION,
  type RuntimeState,
  type ToolCallStatus,
} from './state';
import { isToolOutcomeV1 } from './tool-outcome';
import {
  isToolRecoveryJournalInvalidV1,
  normalizeToolRecoveryJournalV1,
  toolFailureInstanceIdV1,
} from './tool-recovery-journal';

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
    state.schemaVersion === RUNTIME_STATE_SCHEMA_VERSION &&
      state.formatEpoch === RUNTIME_STATE_FORMAT_EPOCH,
    'runtime state format must match the current schema and epoch.',
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
  assert(state.toolRecovery?.schemaVersion === 1, 'tool recovery journal schema must be v1.');
  assert(
    /^[a-f0-9]{64}$/u.test(state.toolRecovery.identityKey),
    'tool recovery journal identity key must be canonical private key material.',
  );
  assertUnique(state.toolRecovery.order, 'tool recovery journal order');
  assert(state.toolRecovery.order.length <= 128, 'tool recovery journal exceeds its bound.');
  for (const failureId of state.toolRecovery.order) {
    const failure = state.toolRecovery.failures[failureId];
    assert(failure?.failureInstanceId === failureId, 'tool recovery failure identity is invalid.');
    assert(
      isToolOutcomeV1(failure.outcome),
      `tool recovery failure ${failureId} has an invalid outcome.`,
    );
    assert(
      toolFailureInstanceIdV1({
        toolCallId: failure.toolCallId,
        invocationFingerprint: failure.invocationFingerprint,
        outcome: failure.outcome,
      }) === failureId,
      `tool recovery failure ${failureId} does not match its canonical material.`,
    );
    const recoveryOf = failure.outcome.lineage?.recoveryOf;
    if (recoveryOf) {
      const parent = state.toolRecovery.failures[recoveryOf];
      assert(parent != null && recoveryOf !== failureId, 'tool recovery lineage is dangling.');
      assert(
        parent.modelCorrectionAttempts <= failure.modelCorrectionAttempts &&
          parent.automaticRetryAttempts <= failure.automaticRetryAttempts,
        'tool recovery attempt counters cannot move backwards across lineage.',
      );
    }
  }
  assert(state.context != null, 'context runtime state is required.');
  assertResourceBudgetRuntimeStateV1(state.resourceBudget);
  assert(state.modelInvocations != null, 'model invocation state is required.');
  for (const [invocationId, invocation] of Object.entries(state.modelInvocations)) {
    assert(invocation.invocationId === invocationId, 'model invocation identity is invalid.');
    assert(
      Number.isInteger(invocation.attempts) &&
        invocation.attempts >= 0 &&
        invocation.attempts <= invocation.limits.maxAttempts,
      `model invocation ${invocationId} has invalid attempt evidence.`,
    );
    assert(
      invocation.status === 'prepared' ||
        invocation.status === 'dispatching' ||
        invocation.status === 'completed' ||
        invocation.status === 'interrupted',
      `model invocation ${invocationId} has an invalid status.`,
    );
    if (invocation.status === 'prepared') {
      assert(
        invocation.attempts === 0,
        `prepared invocation ${invocationId} cannot have attempts.`,
      );
    }
    if (invocation.status === 'dispatching' || invocation.status === 'completed') {
      assert(invocation.attempts > 0, `dispatched invocation ${invocationId} needs an attempt.`);
    }
    if (invocation.status === 'completed') {
      assert(
        invocation.responseArtifact?.kind === 'model_response',
        `completed invocation ${invocationId} needs a response Artifact.`,
      );
    }
    if (invocation.status === 'interrupted') {
      assert(
        invocation.dispatchCertainty === 'none' ||
          invocation.dispatchCertainty === 'attempted' ||
          invocation.dispatchCertainty === 'unknown',
        `interrupted invocation ${invocationId} needs dispatch certainty.`,
      );
    }
  }
  for (const [readinessKey, readiness] of Object.entries(state.providerReadiness ?? {})) {
    assert(readiness.readinessKey === readinessKey, 'provider readiness identity is invalid.');
    assert(Boolean(readiness.lifecycleId), 'provider readiness lifecycle id is required.');
    assert(Boolean(readiness.providerId), 'provider readiness provider id is required.');
    assert(Boolean(readiness.routeRevision), 'provider readiness route revision is required.');
    assert(
      Number.isInteger(readiness.maxAttempts) && readiness.maxAttempts > 0,
      'provider readiness max attempts must be positive.',
    );
    assert(
      Number.isInteger(readiness.attempts) &&
        readiness.attempts >= 0 &&
        readiness.attempts <= readiness.maxAttempts,
      'provider readiness attempts are invalid.',
    );
    if (readiness.status === 'prepared') {
      assert(readiness.attempts === 0, 'prepared provider readiness cannot have attempts.');
    }
    if (readiness.status === 'attempted') {
      assert(readiness.attempts > 0, 'attempted provider readiness needs attempt evidence.');
    }
    if (readiness.status === 'failed') {
      assert(readiness.failure != null, 'failed provider readiness needs a classified failure.');
    }
    for (const [waiterId, waiter] of Object.entries(readiness.waiters)) {
      assert(waiter.waiterId === waiterId, 'provider readiness waiter identity is invalid.');
      assert(Boolean(waiter.toolCallId), 'provider readiness waiter tool call is required.');
    }
  }
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
  for (const call of Object.values(state.tools.calls)) {
    if (call.recoveryOf && !TERMINAL_TOOL_STATUSES.has(call.status)) {
      assert(
        state.toolRecovery.failures[call.recoveryOf] != null,
        `live tool ${call.toolCallId} recovery lineage is missing its retained failure instance.`,
      );
    }
    if (call.outcomeV1) {
      assert(isToolOutcomeV1(call.outcomeV1), `tool ${call.toolCallId} has an invalid outcome.`);
    }
  }

  for (const [toolCallId, suspended] of Object.entries(state.suspendedSubagents)) {
    assert(Boolean(suspended.subagentId), `suspended subagent ${toolCallId} requires an id.`);
    assert(Boolean(suspended.task), `suspended subagent ${toolCallId} requires a task.`);
    assert(
      suspended.blockedTool.toolCallId.length > 0 &&
        suspended.blockedTool.toolName.length > 0 &&
        suspended.blockedTool.command.length > 0,
      `suspended subagent ${toolCallId} has incomplete blocked-tool identity.`,
    );
    assert(
      suspended.blockedTool.reasonCode === 'SUBAGENT_TOOL_REQUIRES_APPROVAL' ||
        suspended.blockedTool.reasonCode === 'SUBAGENT_TOOL_REQUIRES_AUTO_REVIEW',
      `suspended subagent ${toolCallId} has an invalid approval route.`,
    );
    const childJournal = normalizeToolRecoveryJournalV1(suspended.toolRecovery);
    assert(
      !isToolRecoveryJournalInvalidV1(childJournal),
      `suspended subagent ${toolCallId} has an invalid recovery journal.`,
    );
    assert(
      childJournal.identityKey === state.toolRecovery.identityKey,
      `suspended subagent ${toolCallId} belongs to another recovery domain.`,
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
