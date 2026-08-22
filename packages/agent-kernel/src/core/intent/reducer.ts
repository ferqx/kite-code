import type { KernelEvent } from '../../events';
import { sha256Hex } from '../../hash';
import { isToolOutcomeV1 } from '../../normalization';
import {
  admitRecoveryAttemptV1,
  recordRecoveryInvocationV1,
  type ToolOutcomeV1,
  toolInvocationFingerprintV1,
} from '../../recovery';
import {
  arrayField,
  asJsonObject,
  asJsonValue,
  eventRecord,
  nonEmptyStringField,
  numberField,
  recordField,
  replaceStringInList,
  stringField,
  updateToolCall,
} from '../../reducer-utils';
import type {
  AgentFailureState,
  AgentState,
  AgentToolCallState,
  AgentToolResultMeta,
  AgentToolResultState,
  AgentTranscriptMessage,
  AgentUnknownToolFieldsObservation,
} from '../../state';

const EPOCH_CREATED_AT = '1970-01-01T00:00:00.000Z';

const READ_ONLY_TOOLS = new Set([
  'read_file',
  'search_content',
  'search_files',
  'tool_search',
  'list_mcp_resources',
  'list_mcp_tools',
  'read_mcp_resource',
  'web_fetch',
  'ask_user',
]);
const PLAN_ONLY_TOOLS = new Set(['write_plan', 'update_plan']);
const READ_ONLY_SUBAGENTS = new Set(['explore', 'plan', 'review']);

function unknownToolFields(value: unknown): AgentUnknownToolFieldsObservation | undefined {
  const candidate = recordField({ value }, 'value');
  if (!candidate) return undefined;
  const toolClass = stringField(candidate, 'toolClass');
  const count = numberField(candidate, 'count');
  const schemaRevision = stringField(candidate, 'schemaRevision');
  if (
    typeof candidate.hasUnknown !== 'boolean' ||
    count === undefined ||
    !Number.isSafeInteger(count) ||
    count < 0 ||
    count > 255 ||
    !['builtin_read', 'builtin_write', 'builtin_execute', 'builtin_other', 'mcp_tool'].includes(
      toolClass ?? '',
    ) ||
    !schemaRevision
  )
    return undefined;
  return {
    hasUnknown: candidate.hasUnknown,
    count,
    toolClass: toolClass as AgentUnknownToolFieldsObservation['toolClass'],
    schemaRevision,
  };
}

function isTerminal(status: AgentToolCallState['status']): boolean {
  return ['succeeded', 'failed', 'rejected', 'cancelled', 'exhausted'].includes(status);
}

function withToolMembership(
  state: AgentState,
  toolCallId: string,
  active: boolean,
  queued: boolean,
) {
  return {
    ...state,
    tools: {
      ...state.tools,
      queue: replaceStringInList(state.tools.queue, toolCallId, queued),
      active: replaceStringInList(state.tools.active, toolCallId, active),
    },
  };
}

function effectProjection(
  name: string,
  args: unknown,
): Pick<AgentToolCallState, 'effectClass' | 'sideEffect' | 'classificationReason'> {
  if (READ_ONLY_TOOLS.has(name)) {
    return {
      effectClass: 'read_only',
      sideEffect: false,
      classificationReason: `${name} is a read-only capability.`,
    };
  }
  if (PLAN_ONLY_TOOLS.has(name)) {
    return {
      effectClass: 'plan_only',
      sideEffect: false,
      classificationReason: `${name} changes runtime planning state only.`,
    };
  }
  if (name === 'task') {
    const subagentType =
      args && typeof args === 'object'
        ? (args as Record<string, unknown>).subagent_type
        : undefined;
    if (typeof subagentType === 'string' && READ_ONLY_SUBAGENTS.has(subagentType)) {
      return {
        effectClass: 'read_only',
        sideEffect: false,
        classificationReason: `${subagentType} sub-agent is read-only by role.`,
      };
    }
    return {
      effectClass: 'workspace_write',
      sideEffect: true,
      classificationReason: 'Implementation-capable or unknown sub-agent role.',
    };
  }
  return {
    effectClass: 'unknown',
    sideEffect: true,
    classificationReason: `No safe capability classification exists for ${name}.`,
  };
}

function suppliedEffect(
  payload: Readonly<Record<string, unknown>>,
  name: string,
  args: unknown,
): Pick<AgentToolCallState, 'effectClass' | 'sideEffect' | 'classificationReason'> {
  const effectClass = stringField(payload, 'effectClass');
  const valid =
    effectClass === 'read_only' ||
    effectClass === 'plan_only' ||
    effectClass === 'workspace_write' ||
    effectClass === 'external_side_effect' ||
    effectClass === 'unknown';
  if (!valid) return effectProjection(name, args);
  return {
    effectClass,
    sideEffect:
      typeof payload.sideEffect === 'boolean'
        ? payload.sideEffect
        : effectClass !== 'read_only' && effectClass !== 'plan_only',
    ...(stringField(payload, 'classificationReason')
      ? { classificationReason: stringField(payload, 'classificationReason') }
      : {}),
  };
}

function transcriptMeta(state: AgentState, messageId: string, createdAt?: string) {
  return {
    messageId,
    turnId: state.turn.turnId,
    ordinal: state.transcript.messages.length,
    createdAt: createdAt ?? EPOCH_CREATED_AT,
  };
}

function stringArg(args: unknown, key: string): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function toolExecutionModelContent(result: Readonly<Record<string, unknown>>): string {
  const ok = result.ok === true && (result.status === undefined || result.status === 'success');
  return ok
    ? stringField(result, 'stdout') || stringField(result, 'stderr') || ''
    : stringField(result, 'stderr') || stringField(result, 'stdout') || '';
}

function resultMeta(
  call: AgentToolCallState,
  result: Readonly<Record<string, unknown>>,
  content: string,
): AgentToolResultMeta {
  const supplied = recordField(result, 'resultMeta') ?? {};
  const path =
    stringField(supplied, 'path') ?? stringArg(call.args, 'path') ?? stringArg(call.args, 'uri');
  const suppliedContentDigest = stringField(supplied, 'contentDigest');
  const suppliedModelDigest = stringField(supplied, 'modelContentDigest');
  const truncated = supplied.truncated === true;
  const fallbackDigest = sha256Hex(content);
  const workspaceMutationScope =
    result.ok === true &&
    (call.effectClass === 'workspace_write' ||
      (call.effectClass === 'unknown' && call.sideEffect)) &&
    path
      ? [path]
      : undefined;
  return asJsonObject({
    ...supplied,
    ...(path ? { path } : {}),
    ...(numberField(result, 'totalLines') !== undefined
      ? { totalLines: numberField(result, 'totalLines') }
      : {}),
    ...(stringField(result, 'command') ? { command: stringField(result, 'command') } : {}),
    ...(workspaceMutationScope ? { workspaceMutationScope } : {}),
    contentDigest: suppliedContentDigest ?? suppliedModelDigest ?? fallbackDigest,
    modelContentDigest: suppliedModelDigest ?? suppliedContentDigest ?? fallbackDigest,
    rawResultDigest: truncated
      ? undefined
      : (stringField(supplied, 'rawResultDigest') ?? suppliedContentDigest ?? fallbackDigest),
    digestScope:
      stringField(supplied, 'digestScope') ??
      (truncated ? 'projected' : suppliedContentDigest ? 'raw' : 'legacy_unknown'),
  });
}

function appendToolTranscript(
  state: AgentState,
  message: AgentTranscriptMessage,
): AgentState['transcript'] {
  const messages = [...state.transcript.messages, message];
  if (message.kind === 'tool') {
    const sourceCall = state.tools.calls[message.toolCallId];
    if (sourceCall?.modelMessageId) {
      const positions = messages.flatMap((candidate, index) => {
        if (candidate.kind !== 'tool') return [];
        return state.tools.calls[candidate.toolCallId]?.modelMessageId === sourceCall.modelMessageId
          ? [index]
          : [];
      });
      const ordered = positions
        .map((index) => ({
          index,
          message: messages[index]! as Extract<AgentTranscriptMessage, { kind: 'tool' }>,
        }))
        .sort((left, right) => {
          const leftOrdinal = state.tools.calls[left.message.toolCallId]?.ordinal;
          const rightOrdinal = state.tools.calls[right.message.toolCallId]?.ordinal;
          if (leftOrdinal == null && rightOrdinal == null) return left.index - right.index;
          if (leftOrdinal == null) return 1;
          if (rightOrdinal == null) return -1;
          return leftOrdinal - rightOrdinal || left.index - right.index;
        })
        .map((entry) => entry.message);
      for (const [index, position] of positions.entries()) messages[position] = ordered[index]!;
    }
  }
  return {
    ...state.transcript,
    messages: messages.map((candidate, ordinal) => ({ ...candidate, ordinal })),
  };
}

function clearSuspendedSubagent(state: AgentState, toolCallId: string, isTaskCall: boolean) {
  if (!isTaskCall || !state.suspendedSubagents[toolCallId]) return state.suspendedSubagents;
  const { [toolCallId]: _snapshot, ...remaining } = state.suspendedSubagents;
  return remaining;
}

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

function terminalStatus(
  event: KernelEvent,
  outcome: ToolOutcomeV1 | undefined,
): AgentToolCallState['status'] | undefined {
  if (event.type === 'tool.finished' && outcome) {
    if (outcome.status === 'exhausted') return 'exhausted';
    if (outcome.status === 'cancelled') return 'cancelled';
    return outcome.status === 'success' ? 'succeeded' : 'failed';
  }
  switch (event.type) {
    case 'tool.failed':
      return 'failed';
    case 'tool.rejected':
      return 'rejected';
    case 'tool.cancelled':
      return 'cancelled';
    default:
      return undefined;
  }
}

function canonicalOutcome(payload: Readonly<Record<string, unknown>>): ToolOutcomeV1 | undefined {
  const outcome = payload.outcomeV1;
  return isToolOutcomeV1(outcome) ? (outcome as ToolOutcomeV1) : undefined;
}

function terminalTranscript(
  state: AgentState,
  event: KernelEvent,
  call: AgentToolCallState,
  outcome: ToolOutcomeV1 | undefined,
): AgentTranscriptMessage {
  const payload = eventRecord(event);
  if (event.type === 'tool.finished') {
    const result = recordField(payload, 'result') ?? {};
    const content = toolExecutionModelContent(result);
    return asJsonObject({
      kind: 'tool',
      ...transcriptMeta(state, `tool-${call.toolCallId}`, stringField(payload, 'createdAt')),
      toolCallId: call.toolCallId,
      name: stringField(payload, 'name') ?? call.name,
      content,
      ok: outcome?.status === 'success',
      resultMeta: resultMeta(call, result, content),
    });
  }
  if (event.type === 'tool.cancelled') {
    return asJsonObject({
      kind: 'tool',
      ...transcriptMeta(state, `tool-${call.toolCallId}`),
      toolCallId: call.toolCallId,
      name: call.name,
      content: stringField(payload, 'reason') ?? '',
      ok: false,
    });
  }
  const failure = recordField(payload, 'failure') ?? {};
  const reason = stringField(payload, 'reason') ?? stringField(failure, 'message') ?? '';
  const projected = outcome ? recoveryProjection(outcome) : undefined;
  const failureKind = stringField(failure, 'kind') ?? 'unknown';
  const deferred = failureKind === 'phase_deferred';
  const deniedByPlanning = failureKind === 'phase_denied';
  const content = deferred
    ? {
        ok: false,
        deferred: true,
        reason: 'phase_constraint',
        until_phase: 'building',
        tool: call.name,
        arguments: call.args,
        next_step:
          'Do not retry or request approval while planning. Preserve this command in the plan execution or verification section, then invoke it only after plan approval changes the phase to building.',
      }
    : deniedByPlanning
      ? {
          ok: false,
          rejected: true,
          reason: 'phase_constraint',
          phase: 'planning',
          tool: call.name,
          arguments: call.args,
          message: reason,
          next_step:
            'Do not retry or request approval while planning. Use read-only inspection capabilities and preserve the intended implementation in the plan for execution after plan approval.',
        }
      : {
          ok: false,
          ...(event.type === 'tool.rejected' ? { rejected: true } : {}),
          error: {
            kind: failureKind,
            message:
              event.type === 'tool.rejected' ? reason : (stringField(failure, 'message') ?? reason),
            retryable: projected?.retryable ?? false,
            model_fixable: projected?.model_fixable ?? false,
            recovery_disposition: projected?.recovery_disposition ?? 'never',
            maximum_additional_calls: projected?.maximum_additional_calls ?? 0,
          },
          next_step:
            projected?.next_step ??
            'Explain the failure and continue without retrying or assuming the tool succeeded.',
        };
  return asJsonObject({
    kind: 'tool',
    ...transcriptMeta(state, `tool-${call.toolCallId}`),
    toolCallId: call.toolCallId,
    name: call.name,
    content: JSON.stringify(content),
    ok: false,
  });
}

/** Intent and tool lifecycle facts are reduced only by this fixed reducer. */
export function reduceIntentState(state: AgentState, event: KernelEvent): AgentState {
  const payload = eventRecord(event);
  switch (event.type) {
    case 'tool.queued': {
      const toolCallId = nonEmptyStringField(payload, 'toolCallId');
      const name = nonEmptyStringField(payload, 'name');
      if (!toolCallId || !name || state.tools.calls[toolCallId]) return state;
      const taskId = nonEmptyStringField(payload, 'taskId') ?? state.activeTaskId ?? undefined;
      const modelMessageId = stringField(payload, 'modelMessageId') ?? '';
      const args = asJsonValue(payload.args);
      const invocationFingerprint =
        stringField(payload, 'invocationFingerprint') ??
        toolInvocationFingerprintV1({
          key: state.toolRecovery.identityKey,
          toolName: name,
          parsedArgs: args,
        });
      const recoveryMode =
        stringField(payload, 'recoveryMode') === 'automatic_retry'
          ? ('automatic_retry' as const)
          : ('model_correction' as const);
      const admission = admitRecoveryAttemptV1(state.toolRecovery, {
        toolCallId,
        toolName: name,
        invocationFingerprint,
        modelMessageId,
        mode: recoveryMode,
        taskId,
        turnId: state.turn.turnId,
      });
      const effect = suppliedEffect(payload, name, args);
      const call: AgentToolCallState = {
        toolCallId,
        ...(stringField(payload, 'modelInvocationId')
          ? { modelInvocationId: stringField(payload, 'modelInvocationId') }
          : {}),
        ...(taskId ? { taskId } : {}),
        modelMessageId,
        ...(numberField(payload, 'ordinal') !== undefined
          ? { ordinal: numberField(payload, 'ordinal') }
          : {}),
        name,
        args,
        status: 'queued',
        createdAtTurnId: state.turn.turnId,
        ...(stringField(payload, 'createdAt')
          ? { queuedAt: stringField(payload, 'createdAt') }
          : {}),
        invocationFingerprint,
        ...(admission.recoveryOf ? { recoveryOf: admission.recoveryOf, recoveryMode } : {}),
        recoveryAdmission: admission.admitted ? 'admitted' : admission.detailCode,
        ...(unknownToolFields(payload.unknownFields)
          ? { unknownFields: unknownToolFields(payload.unknownFields) }
          : {}),
        ...(stringField(payload, 'bindingId')
          ? { bindingId: stringField(payload, 'bindingId') }
          : {}),
        ...(stringField(payload, 'capabilityId')
          ? { capabilityId: stringField(payload, 'capabilityId') }
          : {}),
        ...(stringField(payload, 'capabilityRevision')
          ? { capabilityRevision: stringField(payload, 'capabilityRevision') }
          : {}),
        ...effect,
      };
      const toolRecovery =
        admission.admitted && admission.recoveryOf
          ? recordRecoveryInvocationV1(state.toolRecovery, {
              toolCallId,
              recoveryOf: admission.recoveryOf,
              mode: recoveryMode,
            })
          : state.toolRecovery;
      return withToolMembership(
        {
          ...state,
          toolRecovery,
          tools: { ...state.tools, calls: { ...state.tools.calls, [toolCallId]: call } },
        },
        toolCallId,
        false,
        true,
      );
    }
    case 'tool.started': {
      const toolCallId = nonEmptyStringField(payload, 'toolCallId');
      const current = toolCallId ? state.tools.calls[toolCallId] : undefined;
      if (!toolCallId || !current || isTerminal(current.status)) return state;
      const next = updateToolCall(state, toolCallId, (call) =>
        call
          ? {
              ...call,
              status: 'running',
              ...(stringField(payload, 'createdAt')
                ? { startedAt: stringField(payload, 'createdAt') }
                : {}),
            }
          : call,
      );
      return withToolMembership(next, toolCallId, true, false);
    }
    case 'tool.finished':
    case 'tool.failed':
    case 'tool.rejected':
    case 'tool.cancelled': {
      const toolCallId = nonEmptyStringField(payload, 'toolCallId');
      const current = toolCallId ? state.tools.calls[toolCallId] : undefined;
      const outcome = canonicalOutcome(payload);
      const status = terminalStatus(event, outcome);
      if (!toolCallId || !status) return state;
      if (!current) {
        if (event.type !== 'tool.rejected') return state;
        return {
          ...state,
          tools: {
            ...state.tools,
            queue: state.tools.queue.filter((id) => id !== toolCallId),
            active: state.tools.active.filter((id) => id !== toolCallId),
          },
        };
      }
      if (isTerminal(current.status)) return state;
      const resultPayload = recordField(payload, 'result') ?? {};
      const resultOk = outcome?.status === 'success';
      const resultContent = toolExecutionModelContent(resultPayload);
      const failurePayload = recordField(payload, 'failure');
      const failure = failurePayload ? asJsonObject<AgentFailureState>(failurePayload) : undefined;
      const terminalCall: AgentToolCallState =
        event.type === 'tool.finished'
          ? {
              ...current,
              status,
              result: asJsonObject<AgentToolResultState>({
                ok: resultOk,
                summary: `Command: ${stringField(resultPayload, 'command')}, exit code: ${numberField(resultPayload, 'exitCode')}`,
                ...(numberField(resultPayload, 'exitCode') !== undefined
                  ? { exitCode: numberField(resultPayload, 'exitCode') }
                  : {}),
                resultMeta: resultMeta(current, resultPayload, resultContent),
              }),
              ...(outcome ? { outcomeV1: outcome } : {}),
            }
          : {
              ...current,
              status,
              ...(event.type !== 'tool.cancelled' &&
              (stringField(payload, 'reason') ?? stringField(failurePayload ?? {}, 'message'))
                ? {
                    error:
                      stringField(payload, 'reason') ??
                      stringField(failurePayload ?? {}, 'message'),
                  }
                : {}),
              ...(event.type !== 'tool.cancelled' && failure ? { failure } : {}),
              ...(outcome ? { outcomeV1: outcome } : {}),
            };
      const clearsMatchingApproval =
        event.type === 'tool.finished' &&
        current.name === 'task' &&
        state.interactions.kind === 'awaiting_tool_approval' &&
        state.interactions.toolCallId === toolCallId;
      const clearsMatchingUserInput =
        event.type === 'tool.finished' &&
        state.interactions.kind === 'awaiting_user_input' &&
        state.interactions.toolCallId === toolCallId;
      const clearsMatchingInteraction =
        event.type === 'tool.cancelled' &&
        state.interactions.kind !== 'idle' &&
        state.interactions.kind !== 'awaiting_provider_action' &&
        state.interactions.kind !== 'awaiting_provider_admission' &&
        state.interactions.toolCallId === toolCallId;
      return withToolMembership(
        {
          ...state,
          tools: { ...state.tools, calls: { ...state.tools.calls, [toolCallId]: terminalCall } },
          transcript: appendToolTranscript(
            state,
            terminalTranscript(state, event, current, outcome),
          ),
          suspendedSubagents: clearSuspendedSubagent(state, toolCallId, current.name === 'task'),
          ...(clearsMatchingApproval || clearsMatchingUserInput || clearsMatchingInteraction
            ? { interactions: { kind: 'idle' as const } }
            : {}),
        },
        toolCallId,
        false,
        false,
      );
    }
    case 'tool.retry_recorded': {
      const toolCallId = nonEmptyStringField(payload, 'toolCallId');
      const current = toolCallId ? state.tools.calls[toolCallId] : undefined;
      const recoveryOf = nonEmptyStringField(payload, 'recoveryOf');
      if (!toolCallId || !current || isTerminal(current.status) || !recoveryOf) return state;
      return updateToolCall(state, toolCallId, (call) =>
        call ? { ...call, recoveryOf, recoveryMode: 'automatic_retry' } : call,
      );
    }
    case 'network.admission_decided':
    case 'mcp.egress_decided': {
      const toolCallId = nonEmptyStringField(payload, 'toolCallId');
      const decision = recordField(payload, 'decision');
      const decisionToolCallId = decision && nonEmptyStringField(decision, 'toolCallId');
      const current = toolCallId ? state.tools.calls[toolCallId] : undefined;
      if (!toolCallId || !decision || decisionToolCallId !== toolCallId || !current) return state;
      const field =
        event.type === 'network.admission_decided'
          ? 'networkDecisions'
          : 'remoteMcpEgressDecisions';
      const prior = arrayField(current, field) ?? [];
      const digest = nonEmptyStringField(decision, 'receiptDigest');
      if (
        digest &&
        prior.some(
          (entry) =>
            typeof entry === 'object' &&
            entry !== null &&
            stringField(entry, 'receiptDigest') === digest,
        )
      )
        return state;
      return updateToolCall(state, toolCallId, (call) =>
        call ? { ...call, [field]: [...prior, asJsonObject(decision)] } : call,
      );
    }
    case 'tool.progress':
    case 'tool.file_change':
      return state;
    default:
      return state;
  }
}
