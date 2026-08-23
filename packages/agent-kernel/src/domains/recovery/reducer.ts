import type { KernelEvent } from '../../events';
import { isToolOutcomeV1 } from '../../normalization';
import {
  mergeToolRecoveryJournalsV1,
  recordRecoveryFailureV1,
  recordRecoveryInvocationV1,
  recordToolOwnedProgressV1,
  type ToolOutcomeV1,
  type ToolRecoveryJournalV1,
  toolInvocationFingerprintV1,
} from '../../recovery';
import {
  asJsonObject,
  eventRecord,
  nonEmptyStringField,
  recordField,
  stringField,
} from '../../reducer-utils';
import type { AgentState, AgentTranscriptMessage } from '../../state';

const EPOCH_CREATED_AT = '1970-01-01T00:00:00.000Z';

function recoveryProjection(outcome: ToolOutcomeV1) {
  const recovery = outcome.recovery;
  const modelFixable =
    recovery.requiresNewModelResponse &&
    (recovery.disposition === 'correct_args' || recovery.disposition === 'alternative');
  const nextStep =
    recovery.disposition === 'correct_args'
      ? 'Explain the failure, correct the arguments once in the next model response, and continue.'
      : recovery.disposition === 'alternative'
        ? 'Explain the failure and choose a different available capability without replaying this invocation.'
        : recovery.disposition === 'user_action'
          ? 'Explain the required user action and wait for an authoritative user or provider resolution.'
          : recovery.disposition === 'retry_once'
            ? 'Do not issue a model-owned replay; Runtime owns the single safe automatic retry.'
            : 'Explain the failure and continue without retrying or assuming the tool succeeded.';
  return {
    retryable: recovery.disposition === 'retry_once',
    model_fixable: modelFixable,
    recovery_disposition: recovery.disposition,
    maximum_additional_calls: recovery.maximumAdditionalCalls,
    next_step: nextStep,
  };
}

function appendSupplementalToolTranscript(
  state: AgentState,
  call: AgentState['tools']['calls'][string],
  event: KernelEvent,
  outcome: ToolOutcomeV1,
): AgentState['transcript'] {
  if (
    state.transcript.messages.some(
      (message) => message.kind === 'tool' && message.toolCallId === call.toolCallId,
    )
  ) {
    return state.transcript;
  }
  const payload = eventRecord(event);
  const failure = recordField(payload, 'failure') ?? {};
  const result = recordField(payload, 'result') ?? {};
  const reason =
    stringField(payload, 'reason') ??
    stringField(result, 'reason') ??
    stringField(failure, 'message') ??
    '';
  const projected = recoveryProjection(outcome);
  const isAutoReview = event.type === 'auto_review.completed';
  const content = {
    ok: false,
    rejected: true,
    error: {
      kind: isAutoReview
        ? (outcome.failure?.kind ?? 'auto_review_rejected')
        : (stringField(failure, 'kind') ?? 'approval_rejected'),
      ...(isAutoReview ? {} : { message: reason }),
      retryable: projected.retryable,
      model_fixable: projected.model_fixable,
      recovery_disposition: projected.recovery_disposition,
      maximum_additional_calls: projected.maximum_additional_calls,
    },
    next_step: projected.next_step,
  };
  const message = asJsonObject<AgentTranscriptMessage>({
    kind: 'tool',
    messageId: `tool-${call.toolCallId}`,
    turnId: state.turn.turnId,
    ordinal: state.transcript.messages.length,
    createdAt: isAutoReview
      ? (stringField(payload, 'createdAt') ?? EPOCH_CREATED_AT)
      : EPOCH_CREATED_AT,
    toolCallId: call.toolCallId,
    name: call.name,
    content: JSON.stringify(content),
    ok: false,
  });
  return {
    ...state.transcript,
    messages: [...state.transcript.messages, message].map((candidate, ordinal) => ({
      ...candidate,
      ordinal,
    })),
  };
}

function clearSuspendedSubagent(
  state: AgentState,
  toolCallId: string,
  isTaskCall: boolean,
): AgentState['suspendedSubagents'] {
  if (!isTaskCall || !state.suspendedSubagents[toolCallId]) return state.suspendedSubagents;
  const { [toolCallId]: _snapshot, ...remaining } = state.suspendedSubagents;
  return remaining;
}

/** Recovery journal facts have a single fixed owner and bounded tail updates. */
export function reduceRecoveryState(state: AgentState, event: KernelEvent): AgentState {
  switch (event.type) {
    case 'subagent.suspended': {
      const payload = eventRecord(event);
      const toolCallId = nonEmptyStringField(payload, 'toolCallId');
      const snapshot = recordField(payload, 'snapshot');
      const call = toolCallId ? state.tools.calls[toolCallId] : undefined;
      if (!toolCallId || !snapshot || call?.name !== 'task') return state;
      return {
        ...state,
        suspendedSubagents: {
          ...state.suspendedSubagents,
          [toolCallId]: asJsonObject(snapshot),
        },
      };
    }
    case 'subagent.approval_deferred': {
      const payload = eventRecord(event);
      const toolCallId = nonEmptyStringField(payload, 'toolCallId');
      const call = toolCallId ? state.tools.calls[toolCallId] : undefined;
      if (
        !toolCallId ||
        call?.name !== 'task' ||
        call.status !== 'running' ||
        !state.suspendedSubagents[toolCallId]
      )
        return state;
      return {
        ...state,
        tools: {
          ...state.tools,
          calls: {
            ...state.tools.calls,
            [toolCallId]: { ...call, status: 'queued' },
          },
          queue: state.tools.queue.includes(toolCallId)
            ? state.tools.queue
            : [...state.tools.queue, toolCallId],
          active: state.tools.active.filter((id) => id !== toolCallId),
        },
      };
    }
    case 'subagent.recovery_journal_merged': {
      const payload = eventRecord(event);
      const toolCallId = nonEmptyStringField(payload, 'toolCallId');
      const journal = payload.journal;
      const call = toolCallId ? state.tools.calls[toolCallId] : undefined;
      if (
        !toolCallId ||
        call?.name !== 'task' ||
        !journal ||
        typeof journal !== 'object' ||
        Array.isArray(journal)
      )
        return state;
      const merged = mergeToolRecoveryJournalsV1(
        state.toolRecovery,
        journal as ToolRecoveryJournalV1,
        state.toolRecovery.identityKey,
        {
          taskId: call.taskId ?? state.activeTaskId ?? undefined,
          turnId: call.createdAtTurnId,
        },
      );
      return { ...state, toolRecovery: merged };
    }
    // These are durable diagnostic/projection notifications, not State26 facts.
    case 'runtime.cancellation_diagnostic':
    case 'subagent.cache_metrics':
    case 'subagent.completed':
    case 'subagent.failed':
    case 'subagent.started':
    case 'subagent.step':
    case 'subagent.tool_result':
      return state;
    default:
      break;
  }

  if (
    event.type !== 'tool.finished' &&
    event.type !== 'tool.failed' &&
    event.type !== 'tool.rejected' &&
    event.type !== 'tool.cancelled' &&
    event.type !== 'tool.retry_recorded' &&
    event.type !== 'approval.rejected' &&
    event.type !== 'auto_review.completed'
  )
    return state;

  const payload = eventRecord(event);
  const toolCallId = nonEmptyStringField(payload, 'toolCallId');
  if (!toolCallId) return state;
  const call = state.tools.calls[toolCallId];
  if (!call) return state;
  if (
    (event.type === 'tool.finished' ||
      event.type === 'tool.failed' ||
      event.type === 'tool.rejected' ||
      event.type === 'tool.cancelled' ||
      event.type === 'tool.retry_recorded') &&
    (call.status === 'succeeded' ||
      call.status === 'failed' ||
      call.status === 'rejected' ||
      call.status === 'cancelled' ||
      call.status === 'exhausted')
  ) {
    return state;
  }
  const outcomeValue = payload.outcomeV1;
  if (!isToolOutcomeV1(outcomeValue)) return state;
  const outcome = outcomeValue as ToolOutcomeV1;
  const invocationFingerprint =
    call.invocationFingerprint ??
    toolInvocationFingerprintV1({
      toolName: call.name,
      parsedArgs: call.args,
    });
  let journal = state.toolRecovery as unknown as ToolRecoveryJournalV1;
  if (event.type === 'tool.finished' && outcome.status === 'success') {
    journal = recordToolOwnedProgressV1(journal, {
      kind: 'receipt',
      referenceId: toolCallId,
      ...(call.recoveryOf ? { resolvesFailureIds: [call.recoveryOf] } : {}),
    });
  } else {
    journal = recordRecoveryFailureV1(journal, {
      toolCallId,
      toolName: call.name,
      invocationFingerprint,
      modelMessageId: call.modelMessageId,
      outcome,
      taskId: call.taskId,
      turnId: call.createdAtTurnId,
    });
    if (event.type === 'tool.retry_recorded') {
      const recoveryOf = nonEmptyStringField(payload, 'recoveryOf');
      if (!recoveryOf) return state;
      journal = recordRecoveryInvocationV1(journal, {
        toolCallId,
        recoveryOf,
        mode: 'automatic_retry',
      });
    }
  }
  const supplementalTerminal =
    (event.type === 'approval.rejected' || event.type === 'auto_review.completed') &&
    call.status === 'rejected';
  const cleanedTools = supplementalTerminal
    ? {
        ...state.tools,
        queue: state.tools.queue.filter((id) => id !== toolCallId),
        active: state.tools.active.filter((id) => id !== toolCallId),
      }
    : state.tools;
  return {
    ...state,
    ...(supplementalTerminal
      ? {
          tools: cleanedTools,
          transcript: appendSupplementalToolTranscript(state, call, event, outcome),
          suspendedSubagents: clearSuspendedSubagent(state, toolCallId, call.name === 'task'),
        }
      : {}),
    toolRecovery: journal as unknown as AgentState['toolRecovery'],
  };
}
