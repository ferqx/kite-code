import type { RuntimeEffect } from './effects';
import type { RuntimeState } from './state';
import { contiguousShellBatchIds } from './tool-batches';

/**
 * The only runtime scheduler.  It deliberately depends on RuntimeState only:
 * callers must encode every externally visible transition as a RuntimeEvent
 * before asking for the next effect.
 *
 * Interaction-producing tools still run one at a time so write_plan, ask_user
 * and approval barriers stop sibling execution. Shell calls from one model
 * response are the exception: each contiguous shell segment collects approvals
 * serially, then its approved siblings start in one concurrent batch.
 */
export function decideNextEffect(state: RuntimeState): RuntimeEffect {
  if (state.recoveryState.kind !== 'normal') {
    return {
      type: 'recovery_blocked',
      reason:
        state.recoveryState.kind === 'corrupted'
          ? state.recoveryState.reason
          : `Runtime schema ${state.recoveryState.schemaVersion} is not supported.`,
    };
  }
  // Durable hard blocks represent proven Runtime correctness failures only.
  if (state.context.hardBlock) {
    return {
      type: 'recovery_blocked',
      reason: `Runtime context is blocked by a correctness failure: ${state.context.hardBlock.reason}. Rewind, clear, or start a new session.`,
    };
  }
  if (state.legacyUnrecoverableSubagentApproval) {
    return {
      type: 'subagent.recovery_unavailable',
      ...state.legacyUnrecoverableSubagentApproval,
    };
  }
  const unknownInvocation = Object.values(state.capabilities.invocations).find(
    (invocation) => invocation.status === 'unknown',
  );
  if (unknownInvocation) {
    return {
      type: 'recovery_blocked',
      reason:
        `Capability invocation ${unknownInvocation.invocationId} has an unknown external outcome. ` +
        'Reconcile it or obtain a user decision before continuing.',
    };
  }

  switch (state.interactions.kind) {
    case 'awaiting_user_input':
      return {
        type: 'request_user_input',
        interactionId: state.interactions.interactionId,
        toolCallId: state.interactions.toolCallId,
      };
    case 'awaiting_review':
      return {
        type: 'request_plan_review',
        interactionId: state.interactions.interactionId,
        toolCallId: state.interactions.toolCallId,
      };
    case 'awaiting_tool_approval':
      return {
        type: 'request_tool_approval',
        interactionId: state.interactions.interactionId,
        toolCallId: state.interactions.toolCallId,
      };
    case 'awaiting_auto_review':
      return {
        type: 'run_auto_review',
        reviewId: state.interactions.interactionId,
        toolCallId: state.interactions.toolCallId,
      };
    case 'awaiting_provider_action':
      return {
        type: 'request_provider_action',
        interactionId: state.interactions.interactionId,
        providerId: state.interactions.providerId,
        action: state.interactions.action,
        originatingToolCallId: state.interactions.originatingToolCallId,
      };
    case 'awaiting_provider_admission':
      return {
        type: 'request_provider_admission',
        interactionId: state.interactions.interactionId,
        providerId: state.interactions.providerId,
        providerStatus: state.interactions.providerStatus,
        retryable: state.interactions.retryable,
      };
    case 'idle':
      break;
  }

  // Interaction-producing tools normally run one at a time. Approved sub-agent
  // task tools can remain active while waiting for their continuation, so scan
  // both queue and active lists.
  const isRunnable = (id: string) => {
    const call = state.tools.calls[id];
    const belongsToCurrentTask = call?.taskId == null || call.taskId === state.activeTaskId;
    return belongsToCurrentTask && (call?.status === 'queued' || call?.status === 'approved');
  };
  const nextRunnable = state.tools.queue.find(isRunnable) ?? state.tools.active.find(isRunnable);
  if (nextRunnable) {
    const nextCall = state.tools.calls[nextRunnable];
    if (nextCall?.name === 'shell_execute' && nextCall.modelMessageId) {
      const shellBatch = contiguousShellBatchIds(state, nextRunnable);
      if (shellBatch.length > 1) {
        // A previously approved sibling must not start while another sibling
        // is still waiting for its policy/approval preflight.
        const nextUnprepared = shellBatch.find((id) => state.tools.calls[id]?.status === 'queued');
        if (nextUnprepared) return { type: 'run_tools', toolCallIds: [nextUnprepared] };

        const approvedBatch = shellBatch.filter(
          (id) => state.tools.calls[id]?.status === 'approved',
        );
        if (approvedBatch.length > 0) {
          return { type: 'run_tools', toolCallIds: approvedBatch };
        }
      }
    }
    return { type: 'run_tools', toolCallIds: [nextRunnable] };
  }

  const verificationRecords = Object.values(state.verification.records)
    .filter((record) => !record.taskId || record.taskId === state.activeTaskId)
    .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt));
  const executableVerification = verificationRecords.find(
    (record) =>
      ['pending', 'running'].includes(record.status) &&
      (record.mode === 'required' || !state.transcript.final),
  );
  if (executableVerification) {
    return { type: 'run_verification', verificationId: executableVerification.verificationId };
  }
  const compensating = verificationRecords.find((record) => record.status === 'compensating');
  if (compensating) {
    return { type: 'run_verification_compensation', verificationId: compensating.verificationId };
  }
  const repairable = verificationRecords.find(
    (record) =>
      record.mode === 'required' &&
      (record.status === 'failed' || record.status === 'inconclusive') &&
      record.repairAttempts < record.spec.repair.maxAttempts,
  );
  if (repairable) {
    return { type: 'repair_verification', verificationId: repairable.verificationId };
  }
  const repairPending = verificationRecords.find((record) => record.status === 'repair_pending');
  if (repairPending && state.transcript.final) {
    return { type: 'run_verification', verificationId: repairPending.verificationId };
  }
  const blockingVerification = verificationRecords.find(
    (record) =>
      record.mode === 'required' &&
      ['failed', 'inconclusive', 'budget_exhausted', 'compensated'].includes(record.status),
  );
  if (blockingVerification) {
    return {
      type: 'request_verification_decision',
      interactionId: blockingVerification.verificationId,
      verificationId: blockingVerification.verificationId,
    };
  }

  if (state.transcript.final) {
    const activeSkill = Object.values(state.skills.frames).some(
      (frame) => frame.status === 'active',
    );
    if (!activeSkill) return { type: 'emit_final' };
  }

  if (state.context.pendingCompaction) {
    return {
      type: 'compact_context',
      compactionId: state.context.pendingCompaction.compactionId,
    };
  }

  // An automatic compaction is an admission gate for this turn. If it failed
  // or was cancelled, do not fall through to the oversized normal model call.
  // A new turn gets a new id and therefore runs preflight and may try again.
  if (
    state.context.lastFailure?.reason === 'auto' &&
    state.context.lastFailure.requestedAtTurnId === state.turn.turnId
  ) {
    return { type: 'stop' };
  }

  // When every tool from the latest model response was explicitly rejected
  // by the user (approval_rejected), stop the turn without calling the model
  // again — the user already said no.  Policy denials (policy_denied) and
  // other automatic failures still need a model call so the model can adjust.
  //
  // A new user message after the rejection starts a new turn that must be
  // processed regardless of failure kind.
  const assistantEntries = state.transcript.messages.map((m, idx) => ({ m, idx })).reverse();
  const latestAssistantEntry = assistantEntries.find(
    (
      entry,
    ): entry is {
      m: Extract<(typeof state.transcript.messages)[number], { kind: 'assistant' }>;
      idx: number;
    } => entry.m.kind === 'assistant' && entry.m.toolCalls.length > 0,
  );
  if (latestAssistantEntry) {
    const { m: latestAssistantMsg, idx: latestAssistantIdx } = latestAssistantEntry;
    const allRejectedOrCancelled = latestAssistantMsg.toolCalls.every((tc) => {
      const call = state.tools.calls[tc.id];
      return call?.status === 'rejected' || call?.status === 'cancelled';
    });
    if (allRejectedOrCancelled && latestAssistantMsg.toolCalls.length > 0) {
      const hasNewUserMessageAfter = state.transcript.messages
        .slice(latestAssistantIdx + 1)
        .some((m) => m.kind === 'user');
      if (!hasNewUserMessageAfter) {
        // Only stop for user-driven rejection; policy denials and automatic
        // failures still need a model call so the model can adjust.
        const allUserRejected = latestAssistantMsg.toolCalls.every((tc) => {
          const call = state.tools.calls[tc.id];
          return call?.failure?.kind === 'approval_rejected';
        });
        if (allUserRejected) {
          return { type: 'stop' };
        }
      }
    }
  }

  return { type: 'call_model' };
}
