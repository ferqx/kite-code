import type { KernelEvent } from '../../events';
import { advanceToolRecoveryResponse } from '../../recovery';
import type { AgentReducerFacts } from '../../reducer';
import {
  booleanField,
  eventRecord,
  isRecord,
  nonEmptyStringField,
  numberField,
  stringField,
} from '../../reducer-utils';
import type {
  AgentContextState,
  AgentModelBudgetState,
  AgentModelInvocationState,
  AgentModelLimitsState,
  AgentPrivateArtifactRef,
  AgentState,
  AgentTranscriptMessage,
  AgentTranscriptToolCall,
  ContextAutoGuardEntry,
  ContextCompactionCheckpoint,
  ContextCompactionErrorKind,
  ContextCompactionFailure,
  ContextCompactionReason,
  ContextHardBlockReason,
  ContextTokenEstimate,
} from '../../state';

const EPOCH_CREATED_AT = '1970-01-01T00:00:00.000Z';
const MAX_AUTO_COMPACTIONS_PER_WINDOW = 3;
const AUTO_COMPACTION_WINDOW_TURNS = 10;
const MAX_CONSECUTIVE_LOW_GAIN = 2;

const COMPACTION_ERROR_KINDS: readonly ContextCompactionErrorKind[] = [
  'unsafe_boundary',
  'oversized_turn',
  'summary_model_failed',
  'summary_aborted',
  'empty_summary',
  'truncated_summary',
  'unexpected_tool_call',
  'stale_context',
  'invalid_candidate',
  'insufficient_reduction',
];

const HARD_BLOCK_REASONS: readonly ContextHardBlockReason[] = [
  'unsafe_context_projection',
  'corrupted_runtime_state',
  'corrupted_event_tail',
  'unrecoverable_checkpoint',
  'runtime_invariant_violation',
];

function isCompactionReason(value: unknown): value is ContextCompactionReason {
  return value === 'manual' || value === 'auto';
}

function isHardBlockReason(value: unknown): value is ContextHardBlockReason {
  return HARD_BLOCK_REASONS.includes(value as ContextHardBlockReason);
}

function isCompactionErrorKind(value: unknown): value is ContextCompactionErrorKind {
  return COMPACTION_ERROR_KINDS.includes(value as ContextCompactionErrorKind);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
  );
}

function objectValue(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return isRecord(value) ? value : undefined;
}

function contextEstimate(value: unknown): ContextTokenEstimate | undefined {
  const candidate = objectValue(value);
  if (!candidate) return undefined;
  const systemTokens = numberField(candidate, 'systemTokens');
  const toolSchemaTokens = numberField(candidate, 'toolSchemaTokens');
  const transcriptTokens = numberField(candidate, 'transcriptTokens');
  const summaryTokens = numberField(candidate, 'summaryTokens');
  const dynamicRuntimeTokens = numberField(candidate, 'dynamicRuntimeTokens');
  const framingTokens = numberField(candidate, 'framingTokens');
  const totalInputTokens = numberField(candidate, 'totalInputTokens');
  if (
    ![
      systemTokens,
      toolSchemaTokens,
      transcriptTokens,
      summaryTokens,
      dynamicRuntimeTokens,
      framingTokens,
      totalInputTokens,
    ].every(isSafeNonNegativeInteger)
  ) {
    return undefined;
  }
  return {
    systemTokens: systemTokens!,
    toolSchemaTokens: toolSchemaTokens!,
    transcriptTokens: transcriptTokens!,
    summaryTokens: summaryTokens!,
    dynamicRuntimeTokens: dynamicRuntimeTokens!,
    framingTokens: framingTokens!,
    totalInputTokens: totalInputTokens!,
  };
}

function parseCheckpoint(value: unknown): ContextCompactionCheckpoint | undefined {
  const candidate = objectValue(value);
  if (!candidate) return undefined;
  const compactionId = nonEmptyStringField(candidate, 'compactionId');
  const version = numberField(candidate, 'version');
  const sourceRevision = numberField(candidate, 'sourceRevision');
  const sourceDigest = nonEmptyStringField(candidate, 'sourceDigest');
  const coveredThroughMessageId = nonEmptyStringField(candidate, 'coveredThroughMessageId');
  const coveredThroughTurnId = nonEmptyStringField(candidate, 'coveredThroughTurnId');
  const summary = stringField(candidate, 'summary');
  const inputTokensBefore = numberField(candidate, 'inputTokensBefore');
  const inputTokensAfter = numberField(candidate, 'inputTokensAfter');
  const reason = candidate.reason;
  const createdAt = stringField(candidate, 'createdAt');
  if (
    !compactionId ||
    version !== 1 ||
    !isSafeNonNegativeInteger(sourceRevision) ||
    !sourceDigest ||
    !coveredThroughMessageId ||
    !coveredThroughTurnId ||
    summary === undefined ||
    !summary.trim() ||
    !isSafeNonNegativeInteger(inputTokensBefore) ||
    !isSafeNonNegativeInteger(inputTokensAfter) ||
    inputTokensAfter >= inputTokensBefore ||
    inputTokensBefore - inputTokensAfter < 1024 ||
    !isCompactionReason(reason) ||
    !createdAt ||
    !isTimestamp(createdAt)
  ) {
    return undefined;
  }
  const modelInvocationId = nonEmptyStringField(candidate, 'modelInvocationId');
  const baseCheckpointId = nonEmptyStringField(candidate, 'baseCheckpointId');
  return {
    compactionId,
    version: 1,
    sourceRevision,
    sourceDigest,
    coveredThroughMessageId,
    coveredThroughTurnId,
    summary,
    inputTokensBefore,
    inputTokensAfter,
    reason,
    createdAt,
    ...(modelInvocationId ? { modelInvocationId } : {}),
    ...(baseCheckpointId ? { baseCheckpointId } : {}),
  };
}

function updateAutoGuard(
  guard: AgentContextState['autoGuard'],
  event:
    | {
        readonly kind: 'completed';
        readonly turnIndex: number;
        readonly reductionRatio: number;
        readonly tokensAfter: number;
      }
    | { readonly kind: 'low_gain' }
    | { readonly kind: 'manual_reset' },
): AgentContextState['autoGuard'] {
  if (event.kind === 'manual_reset') {
    return {
      recentAutomaticCompactions: [],
      consecutiveLowGain: 0,
      disabledUntilManualAction: false,
      recoveryAttempted: false,
    };
  }
  if (event.kind === 'low_gain') {
    const consecutiveLowGain = guard.consecutiveLowGain + 1;
    return {
      ...guard,
      consecutiveLowGain,
      disabledUntilManualAction: consecutiveLowGain >= MAX_CONSECUTIVE_LOW_GAIN,
    };
  }
  const recent: ContextAutoGuardEntry[] = [
    ...guard.recentAutomaticCompactions,
    {
      turnIndex: event.turnIndex,
      reductionRatio: event.reductionRatio,
      tokensAfter: event.tokensAfter,
    },
  ].filter((entry) => event.turnIndex - entry.turnIndex <= AUTO_COMPACTION_WINDOW_TURNS);
  const tooFrequent = recent.length >= MAX_AUTO_COMPACTIONS_PER_WINDOW;
  const refilledFast =
    recent.length >= 2 && recent[recent.length - 2]!.turnIndex >= event.turnIndex - 1;
  return {
    recentAutomaticCompactions: recent,
    consecutiveLowGain: 0,
    disabledUntilManualAction: tooFrequent || refilledFast,
    recoveryAttempted: false,
  };
}

function appendTranscript(state: AgentState, message: AgentTranscriptMessage): AgentState {
  return {
    ...state,
    transcript: {
      ...state.transcript,
      messages: [...state.transcript.messages, message],
    },
  };
}

function parseModelToolCalls(
  payload: Readonly<Record<string, unknown>>,
): readonly AgentTranscriptToolCall[] | undefined {
  if (!Object.hasOwn(payload, 'toolCalls')) return [];
  const raw = payload.toolCalls;
  if (!Array.isArray(raw)) return undefined;
  const calls: AgentTranscriptToolCall[] = [];
  for (const candidateValue of raw) {
    const candidate = objectValue(candidateValue);
    const id = candidate && nonEmptyStringField(candidate, 'id');
    const name = candidate && nonEmptyStringField(candidate, 'name');
    if (!candidate || !id || !name || !Object.hasOwn(candidate, 'args')) return undefined;
    const fingerprint = nonEmptyStringField(candidate, 'canonicalInvocationFingerprint');
    calls.push({
      id,
      name,
      args: candidate.args,
      ...(fingerprint ? { canonicalInvocationFingerprint: fingerprint } : {}),
    });
  }
  return calls;
}

function modelPurpose(value: unknown): AgentModelInvocationState['purpose'] | undefined {
  return value === 'primary_agent' ||
    value === 'context_compaction' ||
    value === 'auto_review' ||
    value === 'subagent'
    ? value
    : undefined;
}

function modelFinishReason(
  value: unknown,
): NonNullable<AgentModelInvocationState['finishReason']> | undefined {
  return value === 'stop' ||
    value === 'length' ||
    value === 'content_filter' ||
    value === 'tool_calls' ||
    value === 'error' ||
    value === 'other' ||
    value === 'unknown'
    ? value
    : undefined;
}

function modelDispatchCertainty(
  value: unknown,
): NonNullable<AgentModelInvocationState['dispatchCertainty']> | undefined {
  return value === 'none' || value === 'attempted' || value === 'unknown' ? value : undefined;
}

function modelInterruptionReason(
  value: unknown,
): NonNullable<AgentModelInvocationState['interruptionReason']> | undefined {
  return value === 'runtime_restored' ||
    value === 'attempts_exhausted' ||
    value === 'cancelled' ||
    value === 'cancelled_before_dispatch' ||
    value === 'attempt_timeout' ||
    value === 'provider_failure' ||
    value === 'surface_identity_changed' ||
    value === 'persistence_unavailable'
    ? value
    : undefined;
}

function modelEvidenceReason(
  value: unknown,
): NonNullable<AgentModelInvocationState['modelEvidenceUnavailable']> | undefined {
  return value === 'artifact_missing' || value === 'artifact_corrupt' ? value : undefined;
}

function privateArtifact<K extends 'model_surface' | 'model_response'>(
  value: unknown,
  kind: K,
): (AgentPrivateArtifactRef & { readonly kind: K }) | undefined {
  const candidate = objectValue(value);
  const artifactId = candidate && nonEmptyStringField(candidate, 'artifactId');
  const integrityIdentifier = candidate && nonEmptyStringField(candidate, 'integrityIdentifier');
  const byteLength = candidate && numberField(candidate, 'byteLength');
  if (
    !candidate ||
    candidate.kind !== kind ||
    !artifactId ||
    !integrityIdentifier ||
    byteLength === undefined ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0
  ) {
    return undefined;
  }
  return { kind, artifactId, integrityIdentifier, byteLength };
}

function modelBudget(value: unknown): AgentModelBudgetState | undefined {
  const candidate = objectValue(value);
  if (!candidate) return undefined;
  if (candidate.kind === 'no_budget' && candidate.reason === 'resource_budget_disabled') {
    return { kind: 'no_budget', reason: 'resource_budget_disabled' };
  }
  if (candidate.kind !== 'reservation') return undefined;
  const reservationId = nonEmptyStringField(candidate, 'reservationId');
  const parentReservationId = candidate.parentReservationId;
  if (!reservationId || (parentReservationId !== null && typeof parentReservationId !== 'string')) {
    return undefined;
  }
  return {
    kind: 'reservation',
    reservationId,
    parentReservationId: parentReservationId as string | null,
  };
}

function modelLimits(value: unknown): AgentModelLimitsState | undefined {
  const candidate = objectValue(value);
  const maxAttempts = candidate && numberField(candidate, 'maxAttempts');
  const perAttemptTimeoutMs = candidate && numberField(candidate, 'perAttemptTimeoutMs');
  const totalTimeBudgetMs = candidate && numberField(candidate, 'totalTimeBudgetMs');
  if (
    maxAttempts === undefined ||
    perAttemptTimeoutMs === undefined ||
    totalTimeBudgetMs === undefined ||
    !Number.isSafeInteger(maxAttempts) ||
    !Number.isSafeInteger(perAttemptTimeoutMs) ||
    !Number.isSafeInteger(totalTimeBudgetMs) ||
    maxAttempts < 1 ||
    perAttemptTimeoutMs < 0 ||
    totalTimeBudgetMs < 0
  ) {
    return undefined;
  }
  return { maxAttempts, perAttemptTimeoutMs, totalTimeBudgetMs };
}

/** Context checkpoints and transcript facts have one fixed State owner. */
export function reduceContextState(
  state: AgentState,
  event: KernelEvent,
  facts: AgentReducerFacts = {},
): AgentState {
  const payload = eventRecord(event);
  switch (event.type) {
    case 'context.compaction_requested': {
      const compactionId = nonEmptyStringField(payload, 'compactionId');
      const requestedAtRevision = numberField(payload, 'requestedAtRevision');
      const requestedAtTurnId = nonEmptyStringField(payload, 'requestedAtTurnId');
      const estimate = contextEstimate(payload.estimate);
      if (
        !compactionId ||
        (state.context.pendingCompaction &&
          state.context.pendingCompaction.compactionId !== compactionId) ||
        !isCompactionReason(payload.reason) ||
        !isSafeNonNegativeInteger(requestedAtRevision) ||
        !requestedAtTurnId ||
        !estimate
      ) {
        return state;
      }
      const consumesRecovery =
        payload.reason === 'auto' &&
        state.context.lastFailure?.reason === 'auto' &&
        state.context.lastFailure.retryable &&
        state.context.lastFailure.requestedAtTurnId !== requestedAtTurnId;
      const customInstructions = nonEmptyStringField(payload, 'customInstructions');
      return {
        ...state,
        context: {
          ...state.context,
          pendingCompaction: {
            compactionId,
            reason: payload.reason,
            requestedAtRevision,
            requestedAtTurnId,
            force: false,
            estimate,
            ...(customInstructions ? { customInstructions } : {}),
          },
          lastFailure: undefined,
          autoGuard: consumesRecovery
            ? { ...state.context.autoGuard, recoveryAttempted: true }
            : state.context.autoGuard,
        },
      };
    }
    case 'context.compaction_completed': {
      const compactionId = nonEmptyStringField(payload, 'compactionId');
      const sourceRevision = numberField(payload, 'sourceRevision');
      const checkpoint = parseCheckpoint(payload.checkpoint);
      if (
        !compactionId ||
        !state.context.pendingCompaction ||
        state.context.pendingCompaction.compactionId !== compactionId ||
        !isSafeNonNegativeInteger(sourceRevision) ||
        !checkpoint ||
        checkpoint.compactionId !== compactionId ||
        checkpoint.sourceRevision !== sourceRevision
      ) {
        return state;
      }
      const reductionRatio =
        checkpoint.inputTokensBefore > 0
          ? 1 - checkpoint.inputTokensAfter / checkpoint.inputTokensBefore
          : 0;
      return {
        ...state,
        context: {
          ...state.context,
          activeCheckpoint: checkpoint,
          pendingCompaction: undefined,
          lastFailure: undefined,
          history: [...state.context.history, { kind: 'completed' as const, checkpoint }].slice(
            -128,
          ),
          lastCompactionTurnIndex: state.turn.turnIndex,
          autoGuard:
            checkpoint.reason === 'auto'
              ? updateAutoGuard(state.context.autoGuard, {
                  kind: 'completed',
                  turnIndex: state.turn.turnIndex,
                  reductionRatio,
                  tokensAfter: checkpoint.inputTokensAfter,
                })
              : updateAutoGuard(state.context.autoGuard, { kind: 'manual_reset' }),
        },
      };
    }
    case 'context.compaction_failed': {
      const compactionId = nonEmptyStringField(payload, 'compactionId');
      const sourceRevision = numberField(payload, 'sourceRevision');
      const message = stringField(payload, 'message');
      const retryable = booleanField(payload, 'retryable');
      const pending = state.context.pendingCompaction;
      if (
        !compactionId ||
        !pending ||
        pending.compactionId !== compactionId ||
        !isSafeNonNegativeInteger(sourceRevision) ||
        !isCompactionErrorKind(payload.errorKind) ||
        message === undefined ||
        !message.trim() ||
        retryable === undefined
      ) {
        return state;
      }
      const requestedAtTurnId = Object.hasOwn(payload, 'requestedAtTurnId')
        ? nonEmptyStringField(payload, 'requestedAtTurnId')
        : undefined;
      if (Object.hasOwn(payload, 'requestedAtTurnId') && !requestedAtTurnId) return state;
      const failure: ContextCompactionFailure = {
        compactionId,
        sourceRevision,
        errorKind: payload.errorKind,
        message,
        retryable,
        reason: pending.reason,
        requestedAtTurnId: requestedAtTurnId ?? pending.requestedAtTurnId,
      };
      const isAutoLowGain =
        pending.reason === 'auto' && payload.errorKind === 'insufficient_reduction';
      return {
        ...state,
        context: {
          ...state.context,
          pendingCompaction: undefined,
          lastFailure: failure,
          autoGuard: isAutoLowGain
            ? updateAutoGuard(state.context.autoGuard, { kind: 'low_gain' })
            : state.context.autoGuard,
          history: [...state.context.history, { kind: 'failed' as const, failure }].slice(-128),
        },
      };
    }
    case 'context.compaction_reset': {
      const checkpointId = nonEmptyStringField(payload, 'checkpointId');
      if (
        !checkpointId ||
        payload.reason !== 'manual' ||
        state.context.activeCheckpoint?.compactionId !== checkpointId
      ) {
        return state;
      }
      return {
        ...state,
        context: {
          ...state.context,
          activeCheckpoint: undefined,
          autoGuard: updateAutoGuard(state.context.autoGuard, { kind: 'manual_reset' }),
          history: [
            ...state.context.history,
            { kind: 'reset' as const, compactionId: checkpointId, reason: 'manual' as const },
          ].slice(-128),
        },
      };
    }
    case 'context.hard_blocked': {
      const reason = payload.reason;
      const sourceDigest = nonEmptyStringField(payload, 'sourceDigest');
      const message = stringField(payload, 'message');
      const createdAtTurnId = nonEmptyStringField(payload, 'createdAtTurnId');
      if (
        !isHardBlockReason(reason) ||
        !sourceDigest ||
        message === undefined ||
        !message.trim() ||
        !createdAtTurnId
      ) {
        return state;
      }
      return {
        ...state,
        context: {
          ...state.context,
          hardBlock: {
            reason,
            sourceDigest,
            message: message.trim(),
            createdAtTurnId,
          },
        },
      };
    }
    case 'context.hard_block_cleared': {
      const reason = payload.reason;
      const sourceDigest = nonEmptyStringField(payload, 'sourceDigest');
      const block = state.context.hardBlock;
      if (
        !isHardBlockReason(reason) ||
        !sourceDigest ||
        !block ||
        block.reason !== reason ||
        block.sourceDigest !== sourceDigest
      ) {
        return state;
      }
      return { ...state, context: { ...state.context, hardBlock: undefined } };
    }
    case 'user.message_appended': {
      const messageId = nonEmptyStringField(payload, 'messageId');
      const content = stringField(payload, 'content');
      const userGoal = stringField(payload, 'userGoal') ?? content;
      const createdAt = Object.hasOwn(payload, 'createdAt')
        ? stringField(payload, 'createdAt')
        : EPOCH_CREATED_AT;
      if (!messageId || content === undefined || !createdAt || !isTimestamp(createdAt)) {
        return state;
      }
      let nextState =
        state.activeTaskId === null && facts.allocatedTaskId
          ? {
              ...state,
              activeTaskId: facts.allocatedTaskId,
              tasks: {
                ...state.tasks,
                [facts.allocatedTaskId]: {
                  taskId: facts.allocatedTaskId,
                  userGoal: userGoal ?? content,
                  status: 'active' as const,
                  startedAtTurnId: state.turn.turnId,
                  sideEffectsStarted: false,
                  planning: { kind: 'building_without_plan' as const },
                  planHistory: [],
                },
              },
            }
          : state;
      const activeTask = nextState.activeTaskId
        ? nextState.tasks[nextState.activeTaskId]
        : undefined;
      nextState =
        activeTask && userGoal && userGoal.length > 0
          ? {
              ...nextState,
              tasks: {
                ...nextState.tasks,
                [activeTask.taskId]: { ...activeTask, userGoal },
              },
            }
          : nextState;
      return appendTranscript(
        {
          ...nextState,
          completionGuard: { correctionAttempts: 0 },
          terminalOutcome: undefined,
          transcript: { ...nextState.transcript, final: undefined },
        },
        {
          kind: 'user',
          messageId,
          turnId: nextState.turn.turnId,
          ordinal: nextState.transcript.messages.length,
          createdAt,
          content,
        },
      );
    }
    case 'model.responded': {
      const messageId = nonEmptyStringField(payload, 'messageId');
      const toolCalls = parseModelToolCalls(payload);
      const text = Object.hasOwn(payload, 'text') ? stringField(payload, 'text') : undefined;
      const reasoningText = Object.hasOwn(payload, 'reasoningText')
        ? stringField(payload, 'reasoningText')
        : undefined;
      const createdAt = Object.hasOwn(payload, 'createdAt')
        ? stringField(payload, 'createdAt')
        : EPOCH_CREATED_AT;
      if (
        !messageId ||
        !toolCalls ||
        (Object.hasOwn(payload, 'text') && text === undefined) ||
        (Object.hasOwn(payload, 'reasoningText') && reasoningText === undefined) ||
        !createdAt ||
        !isTimestamp(createdAt)
      ) {
        return state;
      }
      const toolRecovery = advanceToolRecoveryResponse(state.toolRecovery, {
        taskId: state.activeTaskId,
        turnId: state.turn.turnId,
        modelMessageId: messageId,
        toolCalls: toolCalls.map(({ id, name }) => ({ id, name })),
      });
      const message: AgentTranscriptMessage = {
        kind: 'assistant',
        messageId,
        turnId: state.turn.turnId,
        ordinal: state.transcript.messages.length,
        createdAt,
        ...(text === undefined ? {} : { content: text }),
        ...(reasoningText === undefined ? {} : { reasoningText }),
        toolCalls,
      };
      return appendTranscript(
        {
          ...state,
          toolRecovery,
          transcript: {
            ...state.transcript,
            final: toolCalls.length > 0 ? undefined : (text ?? state.transcript.final),
          },
        },
        message,
      );
    }
    case 'model.invocation_prepared': {
      const invocationId = nonEmptyStringField(payload, 'invocationId');
      const purpose = modelPurpose(payload.purpose);
      const surfaceArtifact = privateArtifact(payload.surfaceArtifact, 'model_surface');
      const surfaceIntegrityIdentifier = nonEmptyStringField(payload, 'surfaceIntegrityIdentifier');
      const routeFingerprint = nonEmptyStringField(payload, 'routeFingerprint');
      const budget = modelBudget(payload.budget);
      const limits = modelLimits(payload.limits);
      const preparedStateRevision = numberField(payload, 'preparedStateRevision');
      const parentInvocationId = payload.parentInvocationId;
      const parentToolCallId = payload.parentToolCallId;
      if (
        !invocationId ||
        state.modelInvocations[invocationId] ||
        !purpose ||
        !surfaceArtifact ||
        !surfaceIntegrityIdentifier ||
        !routeFingerprint ||
        !budget ||
        !limits ||
        !isSafeNonNegativeInteger(preparedStateRevision) ||
        (parentInvocationId !== null && typeof parentInvocationId !== 'string') ||
        (parentToolCallId !== null && typeof parentToolCallId !== 'string')
      ) {
        return state;
      }
      return {
        ...state,
        modelInvocations: {
          ...state.modelInvocations,
          [invocationId!]: {
            invocationId,
            purpose,
            status: 'prepared',
            surfaceArtifact,
            surfaceIntegrityIdentifier,
            routeFingerprint,
            budget,
            limits,
            preparedStateRevision,
            parentInvocationId: parentInvocationId as string | null,
            parentToolCallId: parentToolCallId as string | null,
            attempts: 0,
          },
        },
      };
    }
    case 'model.invocation_attempt_started': {
      const invocationId = nonEmptyStringField(payload, 'invocationId');
      const invocation = invocationId ? state.modelInvocations[invocationId] : undefined;
      const attempt = numberField(payload, 'attempt');
      const maxAttempts = numberField(payload, 'maxAttempts');
      if (
        !invocation ||
        (invocation.status !== 'prepared' && invocation.status !== 'dispatching') ||
        !isSafeNonNegativeInteger(attempt) ||
        attempt < 1 ||
        !isSafeNonNegativeInteger(maxAttempts) ||
        maxAttempts !== invocation.limits.maxAttempts ||
        attempt !== invocation.attempts + 1 ||
        attempt > maxAttempts
      ) {
        return state;
      }
      return {
        ...state,
        modelInvocations: {
          ...state.modelInvocations,
          [invocationId!]: {
            ...invocation,
            status: 'dispatching',
            attempts: attempt,
            dispatchCertainty: 'attempted',
          },
        },
      };
    }
    case 'model.invocation_completed': {
      const invocationId = nonEmptyStringField(payload, 'invocationId');
      const invocation = invocationId ? state.modelInvocations[invocationId] : undefined;
      const responseArtifact = privateArtifact(payload.responseArtifact, 'model_response');
      const finishReason = modelFinishReason(payload.finishReason);
      if (
        invocation?.status !== 'dispatching' ||
        invocation.attempts < 1 ||
        !responseArtifact ||
        !finishReason
      ) {
        return state;
      }
      return {
        ...state,
        modelInvocations: {
          ...state.modelInvocations,
          [invocationId!]: {
            ...invocation,
            status: 'completed',
            responseArtifact,
            finishReason,
          },
        },
      };
    }
    case 'model.invocation_interrupted': {
      const invocationId = nonEmptyStringField(payload, 'invocationId');
      const invocation = invocationId ? state.modelInvocations[invocationId] : undefined;
      const dispatchCertainty = modelDispatchCertainty(payload.dispatchCertainty);
      const interruptionReason = modelInterruptionReason(payload.reasonCode);
      if (
        !invocation ||
        (invocation.status !== 'prepared' && invocation.status !== 'dispatching') ||
        !dispatchCertainty ||
        !interruptionReason
      ) {
        return state;
      }
      return {
        ...state,
        modelInvocations: {
          ...state.modelInvocations,
          [invocationId!]: {
            ...invocation,
            status: 'interrupted',
            dispatchCertainty,
            interruptionReason,
          },
        },
      };
    }
    case 'model.invocation_evidence_unavailable': {
      const invocationId = nonEmptyStringField(payload, 'invocationId');
      const invocation = invocationId ? state.modelInvocations[invocationId] : undefined;
      const reasonCode = modelEvidenceReason(payload.reasonCode);
      if (invocation?.status !== 'completed' || !reasonCode) return state;
      return {
        ...state,
        modelInvocations: {
          ...state.modelInvocations,
          [invocationId!]: {
            ...invocation,
            modelEvidenceUnavailable: reasonCode,
          },
        },
      };
    }
    // Model deltas and cache metrics are ephemeral projections.
    case 'model.requested':
    case 'model.reasoning_delta':
    case 'model.reasoning_completed':
    case 'model.text_delta':
    case 'model.retry':
    case 'model.cache_metrics':
    case 'model.context_metrics':
      return state;
    default:
      return state;
  }
}
