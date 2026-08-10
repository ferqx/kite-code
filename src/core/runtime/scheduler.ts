import { evaluateToolApproval } from '@/core/policies/approval-policy';
import { decideCompletion, decideCompletionV1 } from './completion-guard';
import type { RuntimeEffect } from './effects';
import { isLegacyPlanContinuationToolAllowed, requiresLegacyPlanReplan } from './plan-continuation';
import { getActivePlanning, getAgentPhase, type RuntimeState, type ToolCallRecord } from './state';
import {
  isToolRecoveryJournalInvalidV1,
  isToolRecoveryQualityBlockedV1,
} from './tool-recovery-journal';

/** Bound resource usage while still allowing independent reads to overlap. */
export const MAX_PARALLEL_READ_TOOLS = 4;

/**
 * Only builtin execution tools with no interaction/control semantics may join
 * a parallel read batch. Dynamic MCP capabilities need their bound descriptor
 * at execution time, so the scheduler keeps them exclusive.
 */
export const PARALLEL_READ_TOOL_NAMES = Object.freeze([
  'read_file',
  'search_content',
  'search_files',
  'list_mcp_resources',
  'list_mcp_tools',
  'read_mcp_resource',
  'web_fetch',
  'shell_execute',
] as const);
const PARALLEL_READ_TOOLS = new Set<string>(PARALLEL_READ_TOOL_NAMES);
const LEGACY_RECOVERY_TERMINAL_FAILURES = new Set(['failed', 'rejected', 'cancelled', 'exhausted']);

function argsRecord(args: unknown): Record<string, unknown> {
  return args && typeof args === 'object' && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
}

function isApprovalFreeParallelRead(state: RuntimeState, call: ToolCallRecord): boolean {
  if (
    call.status !== 'queued' ||
    call.effectClass !== 'read_only' ||
    call.sideEffect !== false ||
    !PARALLEL_READ_TOOLS.has(call.name)
  ) {
    return false;
  }

  const decision = evaluateToolApproval({
    toolName: call.name,
    toolArgs: argsRecord(call.args),
    phase: getAgentPhase(getActivePlanning(state)),
    workspace: state.session.workspace,
    threadId: state.session.threadId,
    authorization: state.authorization,
    capability: {
      effectClass: call.effectClass,
      sideEffect: call.sideEffect,
      classificationReason:
        call.classificationReason ?? 'Runtime queue classified this call as read-only.',
    },
  });
  return decision.allowed && !decision.requiresApproval;
}

function legacyRecoveryResponseFailed(
  state: RuntimeState,
  message: Extract<RuntimeState['transcript']['messages'][number], { kind: 'assistant' }>,
): boolean {
  if (message.toolCalls.length === 0) return true;
  if (message.toolCalls.some((call) => !isLegacyPlanContinuationToolAllowed(call.name))) {
    return true;
  }
  return message.toolCalls.some((call) => {
    const record = state.tools.calls[call.id];
    if (!record) return true;
    if (LEGACY_RECOVERY_TERMINAL_FAILURES.has(record.status)) return true;
    return call.name === 'write_plan' && record.status === 'succeeded';
  });
}

/**
 * The only runtime scheduler.  It deliberately depends on RuntimeState only:
 * callers must encode every externally visible transition as a RuntimeEvent
 * before asking for the next effect.
 *
 * Consecutive calls proven read-only and approval-free may run together.
 * Interaction, write, and unknown calls remain exclusive barriers. A tool that
 * requires approval becomes runnable immediately after its own grant; sibling
 * approvals never form an all-or-nothing execution barrier.
 */
export function decideNextEffect(state: RuntimeState): RuntimeEffect {
  if (state.recoveryState.kind !== 'normal') {
    return {
      type: 'recovery_blocked',
      reason:
        state.recoveryState.kind === 'corrupted'
          ? state.recoveryState.reason
          : `Runtime schema ${state.recoveryState.schemaVersion} is not supported.`,
      failureKind: state.recoveryState.kind === 'corrupted' ? 'persistence_unavailable' : 'unknown',
    };
  }
  // Durable hard blocks represent proven Runtime correctness failures only.
  if (state.context.hardBlock) {
    return {
      type: 'recovery_blocked',
      reason: `Runtime context is blocked by a correctness failure: ${state.context.hardBlock.reason}. Rewind, clear, or start a new session.`,
      failureKind: 'unknown',
    };
  }
  // A corrupt recovery journal is a global correctness hard block. It must
  // outrank every executable/interacting surface, including already queued
  // tools, verification, completion and compaction.
  if (isToolRecoveryJournalInvalidV1(state.toolRecovery)) {
    return {
      type: 'recovery_blocked',
      reason: 'Runtime tool recovery journal is invalid and cannot safely continue.',
      failureKind: 'persistence_unavailable',
      recoveryCause: 'journal_invalid',
    };
  }
  // A terminal turn remains terminal across snapshot recovery and loop
  // re-entry. Only an explicit turn.started event may reopen scheduling.
  if (state.turn.status !== 'active') {
    return { type: 'stop' };
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
      failureKind: 'unknown',
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

  // A recovered V1 execution is historical evidence, not an executable plan.
  // Global reconciliation and interaction barriers above remain authoritative.
  // Only the bounded read/save correction path needed to replace it with V2
  // may cross this gate.
  if (requiresLegacyPlanReplan(state)) {
    const recoveryResponses = state.transcript.messages.filter(
      (message) =>
        message.kind === 'assistant' &&
        message.turnId === state.turn.turnId &&
        message.toolSurface === 'legacy_plan_recovery' &&
        legacyRecoveryResponseFailed(state, message),
    ).length;
    if (recoveryResponses > (state.completionGuard?.correctionAttempts ?? 0)) {
      const decision = decideCompletionV1(state);
      if (decision.status === 'blocked') return { type: 'completion_blocked', decision };
    }
    const runnable = [...state.tools.queue, ...state.tools.active].find((id) => {
      const call = state.tools.calls[id];
      const belongsToCurrentTask = call?.taskId == null || call.taskId === state.activeTaskId;
      return belongsToCurrentTask && (call?.status === 'queued' || call?.status === 'approved');
    });
    if (runnable) return { type: 'run_tools', toolCallIds: [runnable] };
    if (state.context.pendingCompaction) {
      return {
        type: 'compact_context',
        compactionId: state.context.pendingCompaction.compactionId,
      };
    }
    return { type: 'call_model', toolSurface: 'legacy_plan_recovery' };
  }

  // Effect-aware scheduling preserves interaction barriers without forcing
  // independent reads through one global single-tool lane.
  //
  // Normal approval leaves the call in queue and changes its status to approved.
  // Legacy/sub-agent resume paths may instead retain an approved call in active,
  // so both collections remain part of the runnable projection.
  const isRunnable = (id: string) => {
    const call = state.tools.calls[id];
    const belongsToCurrentTask = call?.taskId == null || call.taskId === state.activeTaskId;
    return belongsToCurrentTask && (call?.status === 'queued' || call?.status === 'approved');
  };
  const nextRunnable = state.tools.queue.find(isRunnable) ?? state.tools.active.find(isRunnable);
  if (nextRunnable) {
    const nextCall = state.tools.calls[nextRunnable];
    if (nextCall && isApprovalFreeParallelRead(state, nextCall)) {
      const runnableQueue = state.tools.queue.filter(isRunnable);
      const firstIndex = runnableQueue.indexOf(nextRunnable);
      const batch: string[] = [];
      for (
        let index = firstIndex;
        index >= 0 && index < runnableQueue.length && batch.length < MAX_PARALLEL_READ_TOOLS;
        index++
      ) {
        const id = runnableQueue[index]!;
        const call = state.tools.calls[id];
        if (!call || !isApprovalFreeParallelRead(state, call)) break;
        batch.push(id);
      }
      return { type: 'run_tools', toolCallIds: batch };
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
    if (!activeSkill) {
      const decision = decideCompletion(state);
      return decision.status === 'accepted'
        ? { type: 'emit_final' }
        : { type: 'completion_blocked', decision };
    }
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

  // Any explicit user approval rejection aborts this turn. Policy denials
  // (policy_denied) and other automatic failures still need a model call so
  // the model can adjust.
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
    const hasNewUserMessageAfter = state.transcript.messages
      .slice(latestAssistantIdx + 1)
      .some((m) => m.kind === 'user');
    const anyUserRejected = latestAssistantMsg.toolCalls.some(
      (tc) => state.tools.calls[tc.id]?.failure?.kind === 'approval_rejected',
    );
    if (anyUserRejected && !hasNewUserMessageAfter) {
      return { type: 'stop' };
    }
  }

  if (
    state.toolRecovery.qualityGuard.reasonCode === 'no_progress' &&
    isToolRecoveryQualityBlockedV1(state.toolRecovery, {
      taskId: state.activeTaskId,
      turnId: state.turn.turnId,
    })
  ) {
    return {
      type: 'recovery_blocked',
      reason: 'Runtime tool recovery reached the no progress quality ceiling.',
      failureKind: 'loop_exhausted',
      recoveryCause: 'no_progress',
    };
  }

  return { type: 'call_model' };
}
