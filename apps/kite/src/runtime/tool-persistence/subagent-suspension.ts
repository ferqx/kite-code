import {
  type CapabilityArtifactWriter,
  capabilityResultDigest,
  capabilityResultEvidenceDigest,
  isBuiltinOperationExecutionValue,
} from '@kite/builtin-runtime';
import { digestCapabilityValue } from '@kite/builtin-runtime/capability';
import {
  runtimeHostStateAdmitCurrentRuntimeEvent,
  type StateRuntimeEvent,
  type StateRuntimeState,
} from '@kite/runtime-host';
import {
  runtimeHostStateNormalizeToolRecoveryJournal,
  runtimeHostStateToolRecoveryJournalInvalid,
} from '@kite/runtime-host/kernel-adapter';
import type {
  PreparedToolInvocation,
  PrivateSuspendedSubagentRecord,
  RuntimeJsonValue,
  ToolPipelineAttemptAcknowledgement,
  ToolPipelineSuspendedExecutionResult,
  ToolPipelineSuspensionCommit,
  ToolPipelineTaskSubagentSuspension,
} from '@kite/runtime-spi';
import {
  AppStateToolPipelinePersistenceError,
  type CreateAppStateToolPipelinePersistenceInput,
  type StateBuiltinOperationStructuredContent,
} from './contracts';
import { capabilityResultFromTerminal } from './receipt-committer';
import { includesAcknowledgedRevision, persistExact, stateTimestamp } from './recovery-committer';

interface CommitTaskSubagentSuspensionInput {
  readonly commit: Readonly<ToolPipelineSuspensionCommit<StateBuiltinOperationStructuredContent>>;
  readonly identity: Readonly<ToolPipelineAttemptAcknowledgement['attempt']>;
  readonly before: Readonly<StateRuntimeState>;
  readonly prepared: Readonly<PreparedToolInvocation> | undefined;
  readonly input: Readonly<CreateAppStateToolPipelinePersistenceInput>;
}

/**
 * Commit the task-specific non-terminal hand-off through the same State
 * receipt batch as every other Tool Pipeline outcome.  This function only
 * projects the already-authenticated Builtin result and suspension facts; it
 * never creates a child runtime, reviewer, continuation, or terminal event.
 */
export async function commitTaskSubagentSuspension(
  input: CommitTaskSubagentSuspensionInput,
): Promise<void> {
  const suspension = input.commit.suspension;
  if (
    !isTaskSubagentSuspension(suspension) ||
    input.identity.operationId !== 'builtin:task' ||
    input.identity.capabilityId !== 'builtin:task' ||
    input.identity.toolCallId !== suspension.toolCallId
  ) {
    throw new AppStateToolPipelinePersistenceError('invalid_suspension_result');
  }

  const structured = readTaskSuspendedContent(input.commit.result);
  const recoveryEvent = taskSubagentRecoveryEvent(
    structured.value,
    input.before,
    input.identity,
    'invalid_suspension_result',
  );
  assertTaskSubagentSuspensionFacts(
    input.before,
    input.identity,
    input.prepared,
    suspension,
    structured.value,
    structured.runtimeEvents,
    recoveryEvent,
  );

  const capabilityResult = capabilityResultFromTerminal(input.commit.result, structured.value);
  let artifact: ReturnType<CapabilityArtifactWriter['write']>;
  try {
    artifact = input.input.capabilityArtifactWriter.write(
      input.identity.invocationId,
      capabilityResult,
    );
  } catch (error) {
    throw new AppStateToolPipelinePersistenceError(
      'artifact_write_failed',
      error instanceof Error ? error.message : 'Capability result artifact write failed.',
    );
  }

  const recordedAt = stateTimestamp(input.input.now());
  const resultDigest = capabilityResultDigest(capabilityResult);
  const evidenceDigest = capabilityResultEvidenceDigest(capabilityResult);
  const recordedEvent: Extract<
    StateRuntimeEvent,
    { type: 'capability.execution_result_recorded' }
  > = {
    type: 'capability.execution_result_recorded',
    invocationId: input.identity.invocationId,
    resultDigest,
    evidenceDigest,
    recordedAt,
    artifact,
  };
  const suspendedEvent: Extract<StateRuntimeEvent, { type: 'subagent.suspended' }> = {
    type: 'subagent.suspended',
    toolCallId: suspension.toolCallId,
    snapshot: suspension.subagent as Extract<
      StateRuntimeEvent,
      { type: 'subagent.suspended' }
    >['snapshot'],
  };
  const embeddedSuspensionEvent = structured.runtimeEvents.find(
    (event) => event.type === suspension.event.type && sameJson(event, suspension.event),
  );
  const interactionDeferred = input.before.interactions.kind !== 'idle';
  const interactionEvent: StateRuntimeEvent = interactionDeferred
    ? { type: 'subagent.approval_deferred', toolCallId: suspension.toolCallId }
    : (embeddedSuspensionEvent ?? (suspension.event as StateRuntimeEvent));
  const recoveryEvents = recoveryEvent ? [recoveryEvent] : [];
  const events: StateRuntimeEvent[] = [
    recordedEvent,
    ...recoveryEvents,
    suspendedEvent,
    interactionEvent,
  ];
  await persistExact(input.input.persistReceiptEvents, events, 'suspension_evidence');
  const after = input.input.getState();
  assertTaskSubagentSuspendedState(
    after,
    input.before,
    events.length,
    input.identity,
    suspension,
    artifact,
    resultDigest,
    evidenceDigest,
    interactionDeferred,
  );
}

function readTaskSuspendedContent(
  result: Readonly<ToolPipelineSuspendedExecutionResult<StateBuiltinOperationStructuredContent>>,
): Readonly<{
  readonly value: Readonly<StateBuiltinOperationStructuredContent>;
  readonly runtimeEvents: readonly StateRuntimeEvent[];
}> {
  if (result.status !== 'success' || !isBuiltinOperationExecutionValue(result.structuredContent)) {
    throw new AppStateToolPipelinePersistenceError(
      'invalid_suspension_result',
      'Task suspension requires one successful Builtin operation result.',
    );
  }
  let runtimeEvents: StateRuntimeEvent[];
  try {
    runtimeEvents = admitRuntimeEvents(result.structuredContent.runtimeEvents);
  } catch (error) {
    if (error instanceof AppStateToolPipelinePersistenceError) {
      throw new AppStateToolPipelinePersistenceError(
        'invalid_suspension_result',
        'Task suspension runtime events are not valid State events.',
      );
    }
    throw error;
  }
  return Object.freeze({ value: result.structuredContent, runtimeEvents });
}

function assertTaskSubagentSuspensionFacts(
  before: Readonly<StateRuntimeState>,
  identity: Readonly<ToolPipelineAttemptAcknowledgement['attempt']>,
  prepared: Readonly<PreparedToolInvocation> | undefined,
  suspension: Readonly<ToolPipelineTaskSubagentSuspension>,
  value: Readonly<StateBuiltinOperationStructuredContent>,
  runtimeEvents: readonly StateRuntimeEvent[],
  recoveryEvent:
    | Extract<StateRuntimeEvent, { type: 'subagent.recovery_journal_merged' }>
    | undefined,
): void {
  const call = before.tools.calls[identity.toolCallId];
  const previousSuspension = before.suspendedSubagents[identity.toolCallId];
  const parentMatches =
    suspension.parent.toolCallId === identity.toolCallId &&
    suspension.parent.invocationId === identity.invocationId &&
    suspension.parent.attemptId === identity.attemptId &&
    suspension.parent.attempt === identity.attempt;
  const modeMatches =
    suspension.executionMode === 'start'
      ? previousSuspension === undefined
      : previousSuspension !== undefined &&
        privateSuspendedSubagentParentMatches(previousSuspension, suspension.parent);
  if (
    !parentMatches ||
    !modeMatches ||
    !isTaskPreparedInput(prepared, identity) ||
    !call ||
    call.name !== 'task' ||
    call.status !== 'running' ||
    !isExactPrivateSuspendedSubagentRecord(suspension.subagent) ||
    suspension.subagent.parentInvocationId !== suspension.parent.invocationId ||
    suspension.subagent.parentAttempt !== suspension.parent.attempt ||
    !isExactTaskBlockedToolIdentity(suspension.blockedTool) ||
    suspension.subagent.blockedTool.toolCallId !== suspension.blockedTool.toolCallId ||
    (suspension.subagent.blockedTool.runtimeToolCallId ?? null) !==
      suspension.blockedTool.runtimeToolCallId ||
    suspension.subagent.blockedTool.toolName !== suspension.blockedTool.toolName ||
    !isTaskSuspensionEvent(suspension.event, suspension) ||
    !taskSubagentResultMatchesSuspension(value, suspension)
  ) {
    throw new AppStateToolPipelinePersistenceError(
      'invalid_suspension_result',
      'Task suspension facts do not match the current State parent attempt.',
    );
  }

  const interactionEvents = runtimeEvents.filter(
    (event) => event.type === 'approval.requested' || event.type === 'auto_review.requested',
  );
  const embeddedEventCount = interactionEvents.filter((event) =>
    sameJson(event, suspension.event),
  ).length;
  const embeddedRecoveryEvents = runtimeEvents.filter(
    (event): event is Extract<StateRuntimeEvent, { type: 'subagent.recovery_journal_merged' }> =>
      event.type === 'subagent.recovery_journal_merged',
  );
  if (
    interactionEvents.some((event) => !sameJson(event, suspension.event)) ||
    embeddedEventCount > 1 ||
    embeddedRecoveryEvents.length > 1 ||
    (recoveryEvent === undefined && embeddedRecoveryEvents.length > 0) ||
    (recoveryEvent !== undefined &&
      embeddedRecoveryEvents.some((event) => !sameJson(event, recoveryEvent))) ||
    runtimeEvents.some(
      (event) =>
        event.type !== 'subagent.recovery_journal_merged' && !sameJson(event, suspension.event),
    ) ||
    (interactionEvents.length > 0 && embeddedEventCount !== 1)
  ) {
    throw new AppStateToolPipelinePersistenceError(
      'invalid_suspension_result',
      'Task suspension runtime events must contain only the exact Builtin review event.',
    );
  }
}

export function taskSubagentRecoveryEvent(
  value: Readonly<StateBuiltinOperationStructuredContent>,
  before: Readonly<StateRuntimeState>,
  identity: Readonly<ToolPipelineAttemptAcknowledgement['attempt']>,
  failureCode: 'invalid_suspension_result' | 'invalid_terminal_result',
): Extract<StateRuntimeEvent, { type: 'subagent.recovery_journal_merged' }> | undefined {
  if (!isJsonRecord(value.subagentResult)) return undefined;
  if (!Object.hasOwn(value.subagentResult, 'toolRecovery')) return undefined;
  const rawJournal = value.subagentResult.toolRecovery;
  if (!isRuntimeJson(rawJournal)) {
    throw new AppStateToolPipelinePersistenceError(
      failureCode,
      'Builtin task recovery journal is not JSON-safe State data.',
    );
  }
  let normalized: ReturnType<typeof runtimeHostStateNormalizeToolRecoveryJournal>;
  try {
    normalized = runtimeHostStateNormalizeToolRecoveryJournal(
      rawJournal,
      before.toolRecovery.identityKey,
    );
  } catch {
    throw new AppStateToolPipelinePersistenceError(
      failureCode,
      'Builtin task recovery journal could not be normalized.',
    );
  }
  if (runtimeHostStateToolRecoveryJournalInvalid(normalized)) {
    throw new AppStateToolPipelinePersistenceError(
      failureCode,
      'Builtin task recovery journal is invalid for the current State identity.',
    );
  }
  const candidate = {
    type: 'subagent.recovery_journal_merged' as const,
    toolCallId: identity.toolCallId,
    journal: normalized,
  };
  try {
    const admitted = runtimeHostStateAdmitCurrentRuntimeEvent(candidate);
    if (admitted.type !== 'subagent.recovery_journal_merged') {
      throw new Error('wrong State recovery event type');
    }
    return admitted;
  } catch {
    throw new AppStateToolPipelinePersistenceError(
      failureCode,
      'Builtin task recovery event failed State admission.',
    );
  }
}

function isTaskPreparedInput(
  prepared: Readonly<PreparedToolInvocation> | undefined,
  identity: Readonly<ToolPipelineAttemptAcknowledgement['attempt']>,
): boolean {
  if (
    !prepared ||
    prepared.identity.invocationId !== identity.invocationId ||
    prepared.identity.attemptId !== identity.attemptId ||
    prepared.identity.toolCallId !== identity.toolCallId ||
    prepared.identity.operationId !== 'builtin:task' ||
    prepared.identity.argumentOrigin !== 'runtime_private' ||
    !isJsonRecord(prepared.input.arguments)
  ) {
    return false;
  }
  const taskArtifact = prepared.input.arguments.taskArtifact;
  if (!isJsonRecord(taskArtifact)) return false;
  return (
    Object.keys(taskArtifact).sort().join(',') ===
      'artifactId,byteLength,integrityIdentifier,kind' &&
    typeof taskArtifact.artifactId === 'string' &&
    /^pa_[0-9a-f]{64}$/u.test(taskArtifact.artifactId) &&
    taskArtifact.kind === 'subagent_task_request' &&
    typeof taskArtifact.integrityIdentifier === 'string' &&
    /^sha256:[0-9a-f]{64}$/u.test(taskArtifact.integrityIdentifier) &&
    typeof taskArtifact.byteLength === 'number' &&
    Number.isSafeInteger(taskArtifact.byteLength) &&
    taskArtifact.byteLength > 0
  );
}

function assertTaskSubagentSuspendedState(
  after: Readonly<StateRuntimeState>,
  before: Readonly<StateRuntimeState>,
  eventCount: number,
  identity: Readonly<ToolPipelineAttemptAcknowledgement['attempt']>,
  suspension: Readonly<ToolPipelineTaskSubagentSuspension>,
  artifact: ReturnType<CapabilityArtifactWriter['write']>,
  resultDigest: string,
  evidenceDigest: string,
  interactionDeferred: boolean,
): void {
  const invocation = after.capabilities.invocations[identity.invocationId];
  const call = after.tools.calls[identity.toolCallId];
  const expectedInteraction =
    suspension.event.type === 'approval.requested'
      ? {
          kind: 'awaiting_tool_approval' as const,
          interactionId: suspension.event.interactionId,
          toolCallId: identity.toolCallId,
        }
      : {
          kind: 'awaiting_auto_review' as const,
          interactionId: suspension.event.reviewId,
          toolCallId: identity.toolCallId,
        };
  if (
    !includesAcknowledgedRevision(after, before, eventCount) ||
    !invocation ||
    invocation.status !== 'running' ||
    invocation.toolCallId !== identity.toolCallId ||
    invocation.attemptsStarted !== identity.attempt ||
    invocation.resultDigest !== resultDigest ||
    invocation.evidenceDigest !== evidenceDigest ||
    invocation.artifact?.artifactId !== artifact.artifactId ||
    invocation.artifact?.integrityIdentifier !== artifact.integrityIdentifier ||
    !sameJson(after.suspendedSubagents[identity.toolCallId], suspension.subagent) ||
    (interactionDeferred
      ? call?.status !== 'queued' || !sameJson(after.interactions, before.interactions)
      : (suspension.event.type === 'approval.requested'
          ? call?.status !== 'awaiting_approval'
          : call?.status !== 'awaiting_auto_review') ||
        after.interactions.kind !== expectedInteraction.kind ||
        after.interactions.interactionId !== expectedInteraction.interactionId ||
        after.interactions.toolCallId !== expectedInteraction.toolCallId)
  ) {
    throw new AppStateToolPipelinePersistenceError(
      'acknowledgement_mismatch',
      'State task suspension acknowledgement does not match the committed evidence.',
    );
  }
}

function isTaskSubagentSuspension(
  value: Readonly<unknown>,
): value is Readonly<ToolPipelineTaskSubagentSuspension> {
  if (!isRuntimeJson(value) || !isJsonRecord(value)) return false;
  const keys = Object.keys(value).sort();
  return (
    keys.join(',') ===
      'blockedTool,event,executionMode,kind,operationId,parent,schema,subagent,toolCallId' &&
    value.schema === 'kite.tool-pipeline-stage.v1' &&
    value.kind === 'task_subagent' &&
    value.operationId === 'builtin:task' &&
    (value.executionMode === 'start' || value.executionMode === 'resume') &&
    typeof value.toolCallId === 'string' &&
    isJsonRecord(value.parent) &&
    isJsonRecord(value.subagent) &&
    isJsonRecord(value.blockedTool) &&
    isJsonRecord(value.event)
  );
}

function isExactTaskBlockedToolIdentity(value: unknown): boolean {
  if (!isRuntimeJson(value) || !isJsonRecord(value)) return false;
  const keys = Object.keys(value).sort();
  return (
    keys.join(',') === 'argumentsDigest,commandDigest,runtimeToolCallId,toolCallId,toolName' &&
    nonEmptyString(value.toolCallId) &&
    (value.runtimeToolCallId === null || nonEmptyString(value.runtimeToolCallId)) &&
    nonEmptyString(value.toolName) &&
    nonEmptyString(value.argumentsDigest) &&
    (value.commandDigest === null || nonEmptyString(value.commandDigest))
  );
}

function isExactPrivateSuspendedSubagentRecord(
  value: unknown,
): value is Readonly<PrivateSuspendedSubagentRecord> {
  if (!isRuntimeJson(value) || !isJsonRecord(value)) return false;
  const keys = Object.keys(value).sort();
  const continuationArtifact = value.continuationArtifact;
  const blockedTool = value.blockedTool;
  if (
    keys.join(',') !==
      'blockedTool,continuationArtifact,continuationId,modelInvocationOrdinal,parentAttempt,parentInvocationId,role,storage,subagentId' ||
    value.storage !== 'private_artifact_v1' ||
    !nonEmptyString(value.subagentId) ||
    !['explore', 'plan', 'code', 'review'].includes(String(value.role)) ||
    typeof value.continuationId !== 'string' ||
    !/^continuation-[0-9a-f]{64}$/u.test(value.continuationId) ||
    typeof value.modelInvocationOrdinal !== 'number' ||
    !Number.isSafeInteger(value.modelInvocationOrdinal) ||
    value.modelInvocationOrdinal < 0 ||
    !nonEmptyString(value.parentInvocationId) ||
    typeof value.parentAttempt !== 'number' ||
    !Number.isSafeInteger(value.parentAttempt) ||
    value.parentAttempt < 1 ||
    !isJsonRecord(continuationArtifact) ||
    Object.keys(continuationArtifact).sort().join(',') !==
      'artifactId,byteLength,integrityIdentifier,kind' ||
    typeof continuationArtifact.artifactId !== 'string' ||
    !/^pa_[0-9a-f]{64}$/u.test(continuationArtifact.artifactId) ||
    continuationArtifact.kind !== 'subagent_continuation' ||
    typeof continuationArtifact.integrityIdentifier !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/u.test(continuationArtifact.integrityIdentifier) ||
    typeof continuationArtifact.byteLength !== 'number' ||
    !Number.isSafeInteger(continuationArtifact.byteLength) ||
    continuationArtifact.byteLength < 1 ||
    !isJsonRecord(blockedTool)
  ) {
    return false;
  }
  const blockedKeys = Object.keys(blockedTool).sort();
  const expectedBlockedKeys = [
    'reasonCode',
    'toolCallId',
    'toolName',
    ...(blockedTool.runtimeToolCallId === undefined ? [] : ['runtimeToolCallId']),
  ].sort();
  return (
    blockedKeys.join(',') === expectedBlockedKeys.join(',') &&
    (blockedTool.reasonCode === 'SUBAGENT_TOOL_REQUIRES_APPROVAL' ||
      blockedTool.reasonCode === 'SUBAGENT_TOOL_REQUIRES_AUTO_REVIEW') &&
    nonEmptyString(blockedTool.toolCallId) &&
    nonEmptyString(blockedTool.toolName) &&
    (blockedTool.runtimeToolCallId === undefined || nonEmptyString(blockedTool.runtimeToolCallId))
  );
}

function privateSuspendedSubagentParentMatches(
  value: unknown,
  parent: Readonly<ToolPipelineTaskSubagentSuspension['parent']>,
): boolean {
  return (
    isExactPrivateSuspendedSubagentRecord(value) &&
    value.parentInvocationId === parent.invocationId &&
    value.parentAttempt + 1 === parent.attempt
  );
}

function isTaskSuspensionEvent(
  value: unknown,
  suspension: Readonly<ToolPipelineTaskSubagentSuspension>,
): boolean {
  if (!isRuntimeJson(value) || !isJsonRecord(value)) return false;
  let admitted: StateRuntimeEvent;
  try {
    admitted = runtimeHostStateAdmitCurrentRuntimeEvent(value);
  } catch {
    return false;
  }
  if (admitted.type !== 'approval.requested' && admitted.type !== 'auto_review.requested') {
    return false;
  }
  if (
    admitted.toolCallId !== suspension.toolCallId ||
    (admitted.type === 'approval.requested'
      ? suspension.subagent.blockedTool.reasonCode !== 'SUBAGENT_TOOL_REQUIRES_APPROVAL'
      : suspension.subagent.blockedTool.reasonCode !== 'SUBAGENT_TOOL_REQUIRES_AUTO_REVIEW')
  ) {
    return false;
  }
  const approval = admitted.approval as unknown as Record<string, unknown>;
  return (
    approval.callId ===
      (suspension.blockedTool.runtimeToolCallId ?? suspension.blockedTool.toolCallId) &&
    approval.tool === suspension.blockedTool.toolName &&
    (admitted.type !== 'auto_review.requested' ||
      admitted.toolName === suspension.blockedTool.toolName)
  );
}

function taskSubagentResultMatchesSuspension(
  value: Readonly<StateBuiltinOperationStructuredContent>,
  suspension: Readonly<ToolPipelineTaskSubagentSuspension>,
): boolean {
  if (value.ok !== false || !isJsonRecord(value.subagentResult)) return false;
  const subagentResult = value.subagentResult;
  const blocked = subagentResult.blocked;
  if (!isJsonRecord(blocked)) return false;
  const continuation = blocked.continuation;
  if (!isJsonRecord(continuation)) return false;
  const blockedArguments = blocked.args;
  const blockedCommand = blocked.command;
  const continuationBlockedTool = continuation.blockedTool;
  if (
    !isJsonRecord(blockedArguments) ||
    typeof blockedCommand !== 'string' ||
    !isJsonRecord(continuationBlockedTool) ||
    !isJsonRecord(continuationBlockedTool.args) ||
    typeof continuationBlockedTool.command !== 'string'
  ) {
    return false;
  }
  const argumentsDigest = digestCapabilityValue(blockedArguments);
  const commandDigest =
    blockedCommand.trim().length > 0 ? digestCapabilityValue(blockedCommand.trim()) : null;
  return (
    blocked.reasonCode === suspension.subagent.blockedTool.reasonCode &&
    blocked.toolCallId === suspension.blockedTool.toolCallId &&
    (blocked.runtimeToolCallId ?? null) === suspension.blockedTool.runtimeToolCallId &&
    blocked.toolName === suspension.blockedTool.toolName &&
    suspension.blockedTool.argumentsDigest === argumentsDigest &&
    suspension.blockedTool.commandDigest === commandDigest &&
    continuation.id === suspension.subagent.subagentId &&
    continuation.role === suspension.subagent.role &&
    (continuation.modelInvocationOrdinal ?? 0) === suspension.subagent.modelInvocationOrdinal &&
    continuationBlockedTool.reasonCode === blocked.reasonCode &&
    continuationBlockedTool.toolCallId === blocked.toolCallId &&
    (continuationBlockedTool.runtimeToolCallId ?? null) === (blocked.runtimeToolCallId ?? null) &&
    continuationBlockedTool.toolName === blocked.toolName &&
    digestCapabilityValue(continuationBlockedTool.args) === argumentsDigest &&
    continuationBlockedTool.command === blockedCommand &&
    subagentResult.terminalStatus === 'suspended'
  );
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return digestCapabilityValue(left) === digestCapabilityValue(right);
  } catch {
    return false;
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isJsonRecord(
  value: RuntimeJsonValue | undefined,
): value is { readonly [key: string]: RuntimeJsonValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isRuntimeJson(value: unknown): value is RuntimeJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((entry) => isRuntimeJson(entry));
  if (typeof value !== 'object') return false;
  return Object.values(value).every((entry) => isRuntimeJson(entry));
}

function admitRuntimeEvents(events: readonly RuntimeJsonValue[] | undefined): StateRuntimeEvent[] {
  if (events === undefined) return [];
  const admitted: StateRuntimeEvent[] = [];
  for (const event of events) {
    let admittedEvent: StateRuntimeEvent;
    try {
      admittedEvent = runtimeHostStateAdmitCurrentRuntimeEvent(event);
    } catch {
      throw new AppStateToolPipelinePersistenceError(
        'invalid_terminal_result',
        'Builtin runtimeEvents must be valid State JSON event objects.',
      );
    }
    if (
      admittedEvent.type === 'capability.execution_succeeded' ||
      admittedEvent.type === 'capability.execution_failed' ||
      admittedEvent.type === 'capability.execution_unknown' ||
      admittedEvent.type === 'tool.finished' ||
      admittedEvent.type === 'tool.failed' ||
      admittedEvent.type === 'tool.cancelled' ||
      admittedEvent.type === 'tool.rejected' ||
      admittedEvent.type === 'tool.file_change'
    ) {
      throw new AppStateToolPipelinePersistenceError(
        'invalid_terminal_result',
        'Builtin runtimeEvents cannot provide a second capability, Tool terminal, or file-change owner.',
      );
    }
    admitted.push(admittedEvent);
  }
  return admitted;
}
