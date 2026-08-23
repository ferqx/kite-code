import { decideCompletion } from './completion';
import type {
  McpProviderDirectoryStatus,
  McpProviderRecoveryAction,
  RuntimeEffect,
} from './effects';
import {
  type ExecutionTraits,
  executionTraitsMayOverlap,
  selectSchedulableEffectBatch,
} from './execution-traits';
import { isToolRecoveryQualityBlocked } from './recovery';
import { booleanField, isRecord, numberField, recordField, stringField } from './reducer-utils';
import type { AgentState } from './state';

export interface SchedulerFacts {
  readonly traits: Readonly<Record<string, ExecutionTraits>>;
  readonly approval: Readonly<
    Record<string, { readonly allowed: boolean; readonly requiresApproval: boolean }>
  >;
}

/** Bounded concurrency ceilings shared with the public scheduling policy snapshot. */
export const MAX_PARALLEL_READ_TOOLS = 4;
export const MAX_PARALLEL_SUBAGENTS = 4;

const EXECUTION_SCOPE_KINDS = new Set([
  'runtime',
  'workspace',
  'process',
  'network',
  'external_state',
  'subagent',
  'skill',
]);
const EXECUTION_ACCESS = new Set(['read', 'write', 'unknown']);
const EXECUTION_ISOLATION = new Set(['shared', 'exclusive_workspace', 'worktree']);

function plainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return (
    isRecord(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function uniqueStrings(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every(nonEmptyString) && new Set(value).size === value.length
  );
}

function validExecutionTraits(value: unknown): value is ExecutionTraits {
  if (!plainRecord(value)) return false;
  if (
    !exactKeys(
      value,
      [
        'resourceScopes',
        'access',
        'conflictKeys',
        'isolation',
        'causalGroup',
        'interactionBarrier',
        'leaseFenceRequired',
      ],
      ['concurrencyGroup'],
    )
  )
    return false;
  if (
    !Array.isArray(value.resourceScopes) ||
    !value.resourceScopes.every((scope) => {
      if (!plainRecord(scope)) return false;
      return (
        exactKeys(scope, ['kind', 'key']) &&
        typeof scope.kind === 'string' &&
        EXECUTION_SCOPE_KINDS.has(scope.kind) &&
        nonEmptyString(scope.key)
      );
    }) ||
    !EXECUTION_ACCESS.has(String(value.access)) ||
    !uniqueStrings(value.conflictKeys) ||
    !EXECUTION_ISOLATION.has(String(value.isolation)) ||
    !nonEmptyString(value.causalGroup) ||
    typeof value.interactionBarrier !== 'boolean' ||
    typeof value.leaseFenceRequired !== 'boolean'
  )
    return false;
  return value.concurrencyGroup === undefined || nonEmptyString(value.concurrencyGroup);
}

function validApprovalFact(value: unknown): value is {
  readonly allowed: boolean;
  readonly requiresApproval: boolean;
} {
  return (
    plainRecord(value) &&
    exactKeys(value, ['allowed', 'requiresApproval']) &&
    typeof value.allowed === 'boolean' &&
    typeof value.requiresApproval === 'boolean'
  );
}

/** Validate the non-persisted Host projection before it can influence batching. */
export function isValidSchedulerFacts(value: unknown): value is SchedulerFacts {
  if (!plainRecord(value) || !exactKeys(value, ['traits', 'approval'])) return false;
  const traits = value.traits;
  const approval = value.approval;
  if (!plainRecord(traits) || !plainRecord(approval)) return false;
  return (
    Object.entries(traits).every(
      ([effectId, projected]) => nonEmptyString(effectId) && validExecutionTraits(projected),
    ) &&
    Object.entries(approval).every(
      ([effectId, projected]) => nonEmptyString(effectId) && validApprovalFact(projected),
    )
  );
}

function activeVerificationRecords(state: AgentState): readonly Record<string, unknown>[] {
  const records = recordField(state.verification, 'records') ?? {};
  return Object.values(records)
    .map((value) => recordField({ value }, 'value'))
    .filter((value): value is Record<string, unknown> => value != null)
    .filter(
      (value) =>
        stringField(value, 'taskId') == null || stringField(value, 'taskId') === state.activeTaskId,
    )
    .sort((left, right) =>
      (stringField(left, 'requestedAt') ?? '').localeCompare(
        stringField(right, 'requestedAt') ?? '',
      ),
    );
}

function hasActiveSkillFrameForCurrentWork(state: AgentState): boolean {
  return Object.values(state.skills.frames).some(
    (frame) => frame.status === 'active' && frame.taskId === state.activeTaskId,
  );
}

function completionDecision(state: AgentState): RuntimeEffect {
  const decision = decideCompletion(state);
  return decision.status === 'accepted'
    ? { type: 'emit_final' }
    : { type: 'completion_blocked', decision };
}

function toolBelongsToCurrentWork(
  state: AgentState,
  call: AgentState['tools']['calls'][string],
): boolean {
  return call.taskId != null
    ? call.taskId === state.activeTaskId
    : call.createdAtTurnId === state.turn.turnId;
}

function runnableToolIds(state: AgentState): string[] {
  return [...state.tools.queue, ...state.tools.active].filter((toolCallId, index, values) => {
    if (values.indexOf(toolCallId) !== index) return false;
    const call = state.tools.calls[toolCallId];
    return (
      call != null &&
      (call.status === 'queued' || call.status === 'approved') &&
      toolBelongsToCurrentWork(state, call)
    );
  });
}

function schedulerTraits(
  call: AgentState['tools']['calls'][string],
  facts: SchedulerFacts | undefined,
): ExecutionTraits | undefined {
  return facts?.traits[call.toolCallId];
}

function approvalFree(
  call: AgentState['tools']['calls'][string],
  group: string,
  facts: SchedulerFacts | undefined,
): boolean {
  const traits = schedulerTraits(call, facts);
  const approval = facts?.approval[call.toolCallId];
  return (
    traits?.concurrencyGroup === group &&
    traits.interactionBarrier === false &&
    call.status === 'queued' &&
    approval?.allowed === true &&
    approval.requiresApproval !== true
  );
}

function parallelBatch(
  state: AgentState,
  first: string,
  group: string,
  ceiling: number,
  facts: SchedulerFacts | undefined,
): readonly string[] {
  const firstCall = state.tools.calls[first];
  const firstTraits = firstCall ? schedulerTraits(firstCall, facts) : undefined;
  if (!firstCall || !firstTraits || !approvalFree(firstCall, group, facts)) return [first];
  const candidates: Array<{ effectId: string; traits: ExecutionTraits }> = [
    { effectId: first, traits: firstTraits },
  ];
  for (const toolCallId of runnableToolIds(state)) {
    if (toolCallId === first || candidates.length >= ceiling) continue;
    const call = state.tools.calls[toolCallId];
    const traits = call ? schedulerTraits(call, facts) : undefined;
    if (
      !call ||
      !traits ||
      !approvalFree(call, group, facts) ||
      !candidates.every((candidate) => executionTraitsMayOverlap(candidate.traits, traits))
    )
      break;
    candidates.push({ effectId: toolCallId, traits });
  }
  return selectSchedulableEffectBatch(candidates, ceiling);
}

/** The single pure State scheduler. Every branch is a RuntimeEffect union member. */
export function decideNextEffect(state: AgentState, facts?: SchedulerFacts): RuntimeEffect {
  if (state.recoveryState.kind !== 'normal')
    return {
      type: 'recovery_blocked',
      reason: 'Runtime state recovery is not normal.',
      failureKind: state.recoveryState.kind === 'corrupted' ? 'persistence_unavailable' : 'unknown',
    };
  const context = state.context;
  const hardBlock = recordField(context, 'hardBlock');
  if (hardBlock)
    return {
      type: 'recovery_blocked',
      reason: `Runtime context is blocked: ${stringField(hardBlock, 'reason') ?? 'unknown'}.`,
      failureKind: 'unknown',
    };
  if (
    state.toolRecovery.qualityGuard.blocked &&
    state.toolRecovery.qualityGuard.reasonCode === 'journal_invalid'
  )
    return {
      type: 'recovery_blocked',
      reason: 'Runtime tool recovery journal is invalid and cannot safely continue.',
      failureKind: 'persistence_unavailable',
      recoveryCause: 'journal_invalid',
    };
  if (state.turn.status !== 'active') return { type: 'stop' };
  if (facts !== undefined && !isValidSchedulerFacts(facts))
    return {
      type: 'recovery_blocked',
      reason: 'Host scheduling facts are malformed or contain executable data.',
      failureKind: 'persistence_unavailable',
    };
  const unknownInvocation = Object.values(
    recordField(state.capabilities, 'invocations') ?? {},
  ).find((value) => isRecord(value) && stringField(value, 'status') === 'unknown');
  if (unknownInvocation)
    return {
      type: 'recovery_blocked',
      reason: 'Capability invocation has an unknown external outcome.',
      failureKind: 'unknown',
    };

  const interaction = state.interactions;
  const interactionKind = stringField(interaction, 'kind');
  if (
    interactionKind !== 'idle' &&
    interactionKind !== 'awaiting_provider_action' &&
    interactionKind !== 'awaiting_provider_admission'
  ) {
    const interactionToolId = stringField(interaction, 'toolCallId');
    const interactionCall = interactionToolId ? state.tools.calls[interactionToolId] : undefined;
    if (!interactionCall || !toolBelongsToCurrentWork(state, interactionCall))
      return {
        type: 'recovery_blocked',
        reason: 'The active interaction is no longer owned by the current Task.',
        failureKind: 'persistence_unavailable',
      };
  }
  switch (interactionKind) {
    case 'awaiting_user_input':
      return {
        type: 'request_user_input',
        interactionId: stringField(interaction, 'interactionId') ?? '',
        toolCallId: stringField(interaction, 'toolCallId') ?? '',
      };
    case 'awaiting_review':
      return {
        type: 'request_plan_review',
        interactionId: stringField(interaction, 'interactionId') ?? '',
        toolCallId: stringField(interaction, 'toolCallId') ?? '',
      };
    case 'awaiting_tool_approval':
      return {
        type: 'request_tool_approval',
        interactionId: stringField(interaction, 'interactionId') ?? '',
        toolCallId: stringField(interaction, 'toolCallId') ?? '',
      };
    case 'awaiting_auto_review':
      return {
        type: 'run_auto_review',
        reviewId: stringField(interaction, 'interactionId') ?? '',
        toolCallId: stringField(interaction, 'toolCallId') ?? '',
      };
    case 'awaiting_provider_action': {
      const action = stringField(interaction, 'action');
      if (!['login', 'approve', 'retry'].includes(action ?? ''))
        return {
          type: 'recovery_blocked',
          reason: 'Provider action is not a recognized Runtime fact.',
          failureKind: 'persistence_unavailable',
        };
      return {
        type: 'request_provider_action',
        interactionId: stringField(interaction, 'interactionId') ?? '',
        providerId: stringField(interaction, 'providerId') ?? '',
        action: action as McpProviderRecoveryAction,
        originatingToolCallId: stringField(interaction, 'originatingToolCallId') ?? '',
      };
    }
    case 'awaiting_provider_admission': {
      const providerStatus = stringField(interaction, 'providerStatus');
      if (
        ![
          'pending_approval',
          'rejected',
          'disabled',
          'login_required',
          'connecting',
          'ready',
          'degraded',
          'failed',
          'quarantined',
        ].includes(providerStatus ?? '')
      )
        return {
          type: 'recovery_blocked',
          reason: 'Provider admission status is not a recognized Runtime fact.',
          failureKind: 'persistence_unavailable',
        };
      return {
        type: 'request_provider_admission',
        interactionId: stringField(interaction, 'interactionId') ?? '',
        providerId: stringField(interaction, 'providerId') ?? '',
        providerStatus: providerStatus as McpProviderDirectoryStatus,
        retryable: booleanField(interaction, 'retryable') === true,
      };
    }
    default:
      break;
  }

  if (interactionKind === 'idle') {
    const stranded = Object.values(state.tools.calls).find(
      (call) =>
        toolBelongsToCurrentWork(state, call) &&
        [
          'awaiting_user_input',
          'awaiting_review',
          'awaiting_approval',
          'awaiting_auto_review',
        ].includes(call.status),
    );
    if (stranded)
      return {
        type: 'recovery_blocked',
        reason: `Tool ${stranded.toolCallId} is ${stranded.status} without its owning interaction.`,
        failureKind: 'persistence_unavailable',
      };
  }
  const approvedSuspended = state.tools.active.find((toolCallId) => {
    const call = state.tools.calls[toolCallId];
    return (
      call?.status === 'approved' &&
      state.suspendedSubagents[toolCallId] != null &&
      toolBelongsToCurrentWork(state, call)
    );
  });
  if (approvedSuspended) return { type: 'run_tools', toolCallIds: [approvedSuspended] };
  const runnable = runnableToolIds(state);
  if (runnable.length > 0) {
    const first = state.tools.queue.find((id) => runnable.includes(id)) ?? runnable[0]!;
    const firstCall = state.tools.calls[first];
    const firstTraits = firstCall ? schedulerTraits(firstCall, facts) : undefined;
    if (firstCall && approvalFree(firstCall, 'parallel-subagent', facts))
      return {
        type: 'run_tools',
        toolCallIds: parallelBatch(
          state,
          first,
          'parallel-subagent',
          MAX_PARALLEL_SUBAGENTS,
          facts,
        ),
      };
    if (
      firstCall &&
      firstTraits?.access === 'read' &&
      firstCall.effectClass === 'read_only' &&
      firstCall.sideEffect === false &&
      approvalFree(firstCall, 'parallel-read', facts)
    )
      return {
        type: 'run_tools',
        toolCallIds: parallelBatch(state, first, 'parallel-read', MAX_PARALLEL_READ_TOOLS, facts),
      };
    return { type: 'run_tools', toolCallIds: [first] };
  }

  const verificationRecords = activeVerificationRecords(state);
  const latestTranscriptKind = stringField(
    recordField({ value: state.transcript.messages.at(-1) }, 'value') ?? {},
    'kind',
  );
  const executable = verificationRecords.find((value) => {
    const status = stringField(value, 'status');
    return (
      (status === 'pending' || status === 'running') &&
      (stringField(value, 'mode') === 'required' || !state.transcript.final)
    );
  });
  if (executable)
    return {
      type: 'run_verification',
      verificationId: stringField(executable, 'verificationId') ?? '',
    };
  const compensating = verificationRecords.find(
    (value) => stringField(value, 'status') === 'compensating',
  );
  if (compensating)
    return {
      type: 'run_verification_compensation',
      verificationId: stringField(compensating, 'verificationId') ?? '',
    };
  const repairable = verificationRecords.find((value) => {
    const repair = recordField(recordField(value, 'spec') ?? {}, 'repair');
    return (
      stringField(value, 'mode') === 'required' &&
      ['failed', 'inconclusive'].includes(stringField(value, 'status') ?? '') &&
      (numberField(value, 'repairAttempts') ?? 0) < (numberField(repair ?? {}, 'maxAttempts') ?? 0)
    );
  });
  if (repairable)
    return {
      type: 'repair_verification',
      verificationId: stringField(repairable, 'verificationId') ?? '',
    };
  const repairPending = verificationRecords.find(
    (value) => stringField(value, 'status') === 'repair_pending',
  );
  if (repairPending && state.transcript.final && latestTranscriptKind === 'assistant')
    return {
      type: 'run_verification',
      verificationId: stringField(repairPending, 'verificationId') ?? '',
    };
  const blocking = verificationRecords.find(
    (value) =>
      stringField(value, 'mode') === 'required' &&
      ['failed', 'inconclusive', 'budget_exhausted', 'compensated'].includes(
        stringField(value, 'status') ?? '',
      ),
  );
  if (blocking)
    return {
      type: 'request_verification_decision',
      interactionId: stringField(blocking, 'verificationId') ?? '',
      verificationId: stringField(blocking, 'verificationId') ?? '',
    };

  if (state.transcript.final && !hasActiveSkillFrameForCurrentWork(state))
    return completionDecision(state);
  const pendingCompaction = recordField(context, 'pendingCompaction');
  if (pendingCompaction)
    return {
      type: 'compact_context',
      compactionId: stringField(pendingCompaction, 'compactionId') ?? '',
    };
  const lastFailure = recordField(context, 'lastFailure');
  if (
    stringField(lastFailure ?? {}, 'reason') === 'auto' &&
    stringField(lastFailure ?? {}, 'requestedAtTurnId') === state.turn.turnId
  )
    return {
      type: 'recovery_blocked',
      reason: `Automatic context compaction failed: ${stringField(lastFailure ?? {}, 'message') ?? 'unknown failure'}`,
      failureKind: 'compaction_failed',
    };
  if (
    isToolRecoveryQualityBlocked(state.toolRecovery, {
      taskId: state.activeTaskId,
      turnId: state.turn.turnId,
    })
  )
    return {
      type: 'recovery_blocked',
      reason: 'Runtime tool recovery reached the no progress quality ceiling.',
      failureKind: 'loop_exhausted',
      recoveryCause: 'no_progress',
    };
  const assistantEntries = state.transcript.messages
    .map((message, index) => ({ message, index }))
    .reverse();
  const latestAssistant = assistantEntries.find(
    (entry) =>
      stringField(recordField({ value: entry.message }, 'value') ?? {}, 'kind') === 'assistant',
  );
  if (latestAssistant) {
    const assistant = recordField({ value: latestAssistant.message }, 'value');
    const toolCalls = Array.isArray(assistant?.toolCalls) ? assistant.toolCalls : [];
    const approvalRejected = toolCalls.some((toolCall) => {
      if (!isRecord(toolCall)) return false;
      const call = state.tools.calls[stringField(toolCall, 'id') ?? ''];
      return isRecord(call?.failure) && stringField(call.failure, 'kind') === 'approval_rejected';
    });
    const hasNewUser = state.transcript.messages
      .slice(latestAssistant.index + 1)
      .some(
        (message) => stringField(recordField({ value: message }, 'value') ?? {}, 'kind') === 'user',
      );
    if (approvalRejected && !hasNewUser) return { type: 'stop' };
  }
  return { type: 'call_model' };
}

export function selectPendingEffects(
  state: AgentState,
  facts?: SchedulerFacts,
): readonly RuntimeEffect[] {
  return Object.freeze([decideNextEffect(state, facts)]);
}
