import {
  type CapabilityArtifactWriter,
  capabilityResultDigest,
  capabilityResultEvidenceDigest,
  projectBuiltinToolResultDigests,
} from '@kite-ai/builtin-runtime';
import { digestCapabilityValue } from '@kite-ai/builtin-runtime/capability';
import { createBuiltinCapabilityVerificationRequest } from '@kite-ai/builtin-runtime/verification';
import type { CapabilityResult } from '@kite-ai/runtime-contract';
import type { StateRuntimeEvent, StateRuntimeState } from '@kite-ai/runtime-host';
import {
  type RuntimeHostToolExecutionResult,
  runtimeHostStateAdmitRecoveryAttempt,
  runtimeHostStateClassifyFailure,
  runtimeHostStateClassifyToolOutcome,
  runtimeHostStateIsFailureKind,
  runtimeHostStatePlanReviewSiblingCancellations,
  runtimeHostStateRecordRecoveryFailure,
  runtimeHostStateToolFailureInstanceId,
  runtimeHostStateToolInvocationFingerprint,
  type StateClassifiedFailure,
} from '@kite-ai/runtime-host/kernel-adapter';
import type {
  CapabilityToolTerminalFailure,
  CapabilityToolTerminalResult,
  PreparedToolInvocation,
  PreparedToolInvocationIdentity,
  RuntimeJsonValue,
  SandboxPreparationArtifactPort,
  ToolPipelineAttemptAcknowledgement,
  ToolPipelineReceiptCommit,
  ToolPipelineRetryableCommit,
  ToolPipelineSuspensionCommit,
  ToolPipelineUnknownOutcome,
} from '@kite-ai/runtime-spi';
import { resourceAdmissionFailureEvent } from '#kite-cli/bootstrap/runtime/resource-admission-terminal';
import type { AppToolPipelinePreparedRequest } from '#kite-cli/bootstrap/runtime/tool-pipeline-prepared';
import { createAppToolPipelineSandboxLifecycle } from '#kite-cli/bootstrap/runtime/tool-pipeline-sandbox-lifecycle';
import {
  assertAcknowledgementState,
  assertOpenAcknowledgement,
  assertSupportedAcknowledgement,
} from './acknowledgement-validator';
import { assertRecordedState, invocationRecordedEvent } from './attempt-recorder';
import {
  type AppStateToolPipelinePersistence,
  AppStateToolPipelinePersistenceError,
  type CreateAppStateToolPipelinePersistenceInput,
  type StateBuiltinOperationStructuredContent,
} from './contracts';
import {
  type AuthenticatedFilesystemObservation,
  verifyTerminalFilesystemObservation,
} from './filesystem-evidence';
import { createFilesystemMutationPersistence } from './filesystem-mutation';
import { isPreparedRequest } from './prepared-request-validator';
import { capabilityResultFromTerminal, readStructuredContent } from './receipt-committer';
import {
  boundedUnknownReason,
  includesAcknowledgedRevision,
  persistExact,
  stateTimestamp,
} from './recovery-committer';
import { commitTaskSubagentSuspension, taskSubagentRecoveryEvent } from './subagent-suspension';
import {
  exactTaskResourceAdmissionFailure,
  fileChangeEvent,
  providerActionRequiredEvent,
} from './terminal-event-projector';

export * from './contracts';

export function createAppStateToolPipelinePersistence(
  input: Readonly<CreateAppStateToolPipelinePersistenceInput>,
): AppStateToolPipelinePersistence {
  assertCompositionInput(input);
  const issuedAcknowledgements = new WeakSet<object>();
  const acknowledgementsByPrepared = new WeakMap<
    object,
    Readonly<ToolPipelineAttemptAcknowledgement>
  >();
  const preparedByAcknowledgement = new WeakMap<object, Readonly<PreparedToolInvocation>>();
  const settledAcknowledgements = new WeakSet<object>();
  const filesystemMutation = createFilesystemMutationPersistence({
    input,
    acknowledgementsByPrepared,
    issuedAcknowledgements,
    settledAcknowledgements,
  });

  const recordAttempt = async (
    prepared: Readonly<PreparedToolInvocation>,
  ): Promise<Readonly<ToolPipelineAttemptAcknowledgement>> => {
    const identity = assertSupportedPreparedIdentity(prepared);
    const request = readPreparedRequest(prepared);
    const before = input.getState();
    const existing = before.capabilities.invocations[identity.invocationId];
    assertPreparedState(prepared, identity, request, before, existing);

    const attempt = (existing?.attemptsStarted ?? 0) + 1;
    const expectedAttemptId = `${identity.invocationId}:attempt:${attempt}`;
    if (identity.attemptId !== expectedAttemptId) {
      throw new AppStateToolPipelinePersistenceError(
        'attempt_identity_mismatch',
        'Prepared attemptId does not match the State next attempt suffix.',
      );
    }

    const now = stateTimestamp(input.now());
    const recordedAt = existing?.recordedAt ?? now;
    const persistedStartedAt = existing?.startedAt ?? now;
    const toolCall = before.tools.calls[identity.toolCallId];
    const events: StateRuntimeEvent[] = [];
    if (!existing) events.push(invocationRecordedEvent(identity, request, recordedAt));
    events.push({
      type: 'capability.execution_started',
      invocationId: identity.invocationId,
      startedAt: now,
      attempt,
    });
    if (
      toolCall?.status === 'queued' ||
      toolCall?.status === 'approved' ||
      toolCall?.status === 'authorized_queued'
    ) {
      events.push({ type: 'tool.started', toolCallId: identity.toolCallId, createdAt: now });
    }

    await persistExact(input.persistAttemptStartEvents, events, 'attempt_start');
    const after = input.getState();
    assertRecordedState(
      after,
      before,
      events.length,
      identity,
      request,
      attempt,
      recordedAt,
      persistedStartedAt,
    );

    const acknowledgement = Object.freeze({
      acknowledged: true,
      attempt: Object.freeze({
        invocationId: identity.invocationId,
        attemptId: identity.attemptId,
        attempt,
        toolCallId: identity.toolCallId,
        turnId: identity.turnId,
        modelMessageId: identity.modelMessageId,
        argumentOrigin: identity.argumentOrigin,
        providerId: identity.providerId,
        operationId: identity.operationId,
        capabilityId: identity.capabilityId,
        capabilityRevision: identity.capabilityRevision,
        descriptorRevision: identity.descriptorRevision,
        parserRevision: identity.parserRevision,
        executorRevision: identity.executorRevision,
        argumentsDigest: identity.argumentsDigest,
        schemaDigest: identity.schemaDigest,
        effectiveEffectsDigest: identity.effectiveEffectsDigest,
        builtinProjectionRevision: identity.builtinProjectionRevision,
        dynamicCatalogRevision: identity.dynamicCatalogRevision,
        runtimeWrapperProviderId: identity.isDynamicMcp ? identity.runtimeWrapper.providerId : null,
        runtimeWrapperCapabilityRevision: identity.isDynamicMcp
          ? identity.runtimeWrapper.capabilityRevision
          : null,
        runtimeWrapperExecutorRevision: identity.isDynamicMcp
          ? identity.runtimeWrapper.executorRevision
          : null,
        runtimeWrapperSchemaDigest: identity.isDynamicMcp
          ? identity.runtimeWrapper.schemaDigest
          : null,
        runtimeWrapperBuiltinProjectionRevision: identity.isDynamicMcp
          ? identity.runtimeWrapper.builtinProjectionRevision
          : null,
        policyDigest: identity.policyDigest,
        authorizationDigest: identity.authorizationDigest,
        admissionDigest: identity.admissionDigest,
        idempotencyKey: identity.idempotencyKey,
        recordedAt,
        startedAt: now,
      }),
    });
    issuedAcknowledgements.add(acknowledgement);
    acknowledgementsByPrepared.set(prepared, acknowledgement);
    preparedByAcknowledgement.set(acknowledgement, prepared);
    return acknowledgement;
  };

  const recordUnknown = async (unknown: Readonly<ToolPipelineUnknownOutcome>): Promise<void> => {
    const identity = assertSupportedAcknowledgement(unknown);
    assertOpenAcknowledgement(
      issuedAcknowledgements,
      settledAcknowledgements,
      unknown.acknowledgement,
    );
    const before = input.getState();
    const invocation = assertAcknowledgementState(before, identity);
    const finishedAt = stateTimestamp(input.now());
    const reason = boundedUnknownReason(unknown.code);
    const events: StateRuntimeEvent[] = [
      {
        type: 'capability.execution_unknown',
        invocationId: identity.invocationId,
        reason,
        finishedAt,
      },
      {
        type: 'tool.failed',
        toolCallId: identity.toolCallId,
        failure: runtimeHostStateClassifyFailure(
          identity.operationId === 'mcp:dynamic_tool' && unknown.code === 'terminal_commit_failed'
            ? 'persistence_unavailable'
            : 'unknown',
          reason,
        ),
      },
    ];
    await persistExact(input.persistTerminalRecoveryEvents, events, 'terminal_recovery');
    const after = input.getState();
    if (
      !includesAcknowledgedRevision(after, before, events.length) ||
      after.capabilities.invocations[identity.invocationId]?.status !== 'unknown' ||
      after.capabilities.invocations[identity.invocationId]?.finishedAt !== finishedAt ||
      after.tools.calls[identity.toolCallId]?.status !== 'failed' ||
      invocation.status !== 'running'
    ) {
      throw new AppStateToolPipelinePersistenceError(
        'acknowledgement_mismatch',
        'State unknown terminal acknowledgement did not commit the exact invocation.',
      );
    }
    settledAcknowledgements.add(unknown.acknowledgement);
  };

  const commitRetryable = async (
    commit: Readonly<ToolPipelineRetryableCommit<StateBuiltinOperationStructuredContent>>,
  ): Promise<void> => {
    const identity = assertSupportedAcknowledgement(commit);
    assertOpenAcknowledgement(
      issuedAcknowledgements,
      settledAcknowledgements,
      commit.acknowledgement,
    );
    const prepared = preparedByAcknowledgement.get(commit.acknowledgement);
    if (!prepared) {
      throw new AppStateToolPipelinePersistenceError('acknowledgement_mismatch');
    }
    const request = readPreparedRequest(prepared);
    const failure = commit.result.failure;
    if (
      identity.operationId !== 'mcp:dynamic_tool' ||
      request.retryEligibility !== 'safe_read_candidate' ||
      commit.replaySafety !== 'safe_read' ||
      commit.result.status !== 'error' ||
      failure?.code !== 'provider_unavailable' ||
      failure.retryable !== true ||
      !isExactDynamicMcpRetryableFailureValue(commit.result.structuredContent, failure)
    ) {
      throw new AppStateToolPipelinePersistenceError(
        'retryable_commit_failed',
        'Only an exact Dynamic MCP safe-read provider failure may authorize another attempt.',
      );
    }

    const before = input.getState();
    assertAcknowledgementState(before, identity);
    const call = before.tools.calls[identity.toolCallId];
    if (
      call?.status !== 'running' ||
      call.createdAtTurnId !== identity.turnId ||
      call.modelMessageId !== identity.modelMessageId
    ) {
      throw new AppStateToolPipelinePersistenceError('acknowledgement_mismatch');
    }
    const classifiedFailure = runtimeHostStateClassifyFailure(
      'provider_unavailable',
      failure.message,
    );
    const outcome = runtimeHostStateClassifyToolOutcome({
      status: 'failed',
      failure: classifiedFailure,
      authority: Object.freeze({
        dispatchState: 'started' as const,
        externalEffects: 'none' as const,
        replaySafety: 'safe_read' as const,
      }),
      toolAdvice: Object.freeze({
        disposition: 'retry_once' as const,
        maximumAdditionalCalls: 1 as const,
        safeAutomaticRetry: true,
      }),
    });
    if (
      outcome.status !== 'failed' ||
      outcome.recovery.disposition !== 'retry_once' ||
      outcome.recovery.maximumAdditionalCalls !== 1 ||
      outcome.recovery.safeAutomaticRetry !== true
    ) {
      throw new AppStateToolPipelinePersistenceError('retryable_commit_failed');
    }
    const invocationFingerprint =
      call.invocationFingerprint ??
      runtimeHostStateToolInvocationFingerprint({
        toolName: call.name,
        parsedArgs: call.args,
      });
    const recoveryOf = runtimeHostStateToolFailureInstanceId({
      toolCallId: identity.toolCallId,
      invocationFingerprint,
      outcome,
    });
    const candidateJournal = runtimeHostStateRecordRecoveryFailure(before.toolRecovery, {
      toolCallId: identity.toolCallId,
      toolName: call.name,
      invocationFingerprint,
      modelMessageId: call.modelMessageId,
      outcome,
      ...(call.taskId ? { taskId: call.taskId } : {}),
      turnId: call.createdAtTurnId,
    });
    const admission = runtimeHostStateAdmitRecoveryAttempt(candidateJournal, {
      toolCallId: identity.toolCallId,
      toolName: call.name,
      invocationFingerprint,
      modelMessageId: call.modelMessageId,
      mode: 'automatic_retry',
      ...(call.taskId ? { taskId: call.taskId } : {}),
      turnId: call.createdAtTurnId,
    });
    if (!admission.admitted || admission.recoveryOf !== recoveryOf) {
      throw new AppStateToolPipelinePersistenceError(
        'retryable_commit_failed',
        'State recovery policy did not admit the exact safe-read retry.',
      );
    }
    const retryEvent: StateRuntimeEvent = {
      type: 'tool.retry_recorded',
      toolCallId: identity.toolCallId,
      failure: classifiedFailure,
      outcome: Object.freeze({
        ...outcome,
        lineage: Object.freeze({ failureInstanceId: recoveryOf }),
      }),
      recoveryOf,
      retryAttempt: 1,
    };
    await persistExact(input.persistReceiptEvents, [retryEvent], 'retry_evidence');
    const after = input.getState();
    const invocation = after.capabilities.invocations[identity.invocationId];
    const afterCall = after.tools.calls[identity.toolCallId];
    const failureRecord = after.toolRecovery.failures[recoveryOf];
    if (
      !includesAcknowledgedRevision(after, before, 1) ||
      invocation?.status !== 'running' ||
      invocation.attemptsStarted !== identity.attempt ||
      afterCall?.status !== 'running' ||
      afterCall.recoveryOf !== recoveryOf ||
      afterCall.recoveryMode !== 'automatic_retry' ||
      failureRecord?.failureInstanceId !== recoveryOf ||
      failureRecord.automaticRetryAttempts !== 1
    ) {
      throw new AppStateToolPipelinePersistenceError(
        'retryable_commit_failed',
        'State did not acknowledge the exact safe-read retry evidence.',
      );
    }
    settledAcknowledgements.add(commit.acknowledgement);
  };

  const commitTerminal = async (
    commit: Readonly<ToolPipelineReceiptCommit<StateBuiltinOperationStructuredContent>>,
  ): Promise<void> => {
    const identity = assertSupportedAcknowledgement(commit);
    assertOpenAcknowledgement(
      issuedAcknowledgements,
      settledAcknowledgements,
      commit.acknowledgement,
    );
    const before = input.getState();
    assertAcknowledgementState(before, identity);
    const { runtimeEvents, value } = readStructuredContent(commit.result);
    const taskRecoveryEvent =
      identity.operationId === 'builtin:task'
        ? taskSubagentRecoveryEvent(value, before, identity, 'invalid_terminal_result')
        : undefined;
    const topLevelTaskRecoveryEvents = runtimeEvents.filter(
      (event): event is Extract<StateRuntimeEvent, { type: 'subagent.recovery_journal_merged' }> =>
        event.type === 'subagent.recovery_journal_merged',
    );
    if (
      identity.operationId === 'builtin:task' &&
      (topLevelTaskRecoveryEvents.length > 1 ||
        (taskRecoveryEvent === undefined && topLevelTaskRecoveryEvents.length > 0) ||
        topLevelTaskRecoveryEvents.some(
          (event) =>
            event.toolCallId !== identity.toolCallId ||
            (taskRecoveryEvent !== undefined && !sameJson(event, taskRecoveryEvent)),
        ))
    ) {
      throw new AppStateToolPipelinePersistenceError(
        'invalid_terminal_result',
        'Task recovery evidence must match the exact nested Builtin journal.',
      );
    }
    const taskRecoveryEvents =
      identity.operationId === 'builtin:task' ? (taskRecoveryEvent ? [taskRecoveryEvent] : []) : [];
    const persistedRuntimeEvents =
      identity.operationId === 'builtin:task'
        ? runtimeEvents.filter((event) => event.type !== 'subagent.recovery_journal_merged')
        : runtimeEvents;
    const filesystemObservation = verifyTerminalFilesystemObservation(
      input.verifyBuiltinWorkspaceFilesystemTerminal,
      commit,
      value,
      identity,
    );
    if (commit.result.status === 'unknown' || (commit.result.status === 'success') !== value.ok) {
      throw new AppStateToolPipelinePersistenceError(
        'invalid_terminal_result',
        'Unknown or contradictory Builtin terminal results must enter unknown recovery.',
      );
    }
    const prepared = preparedByAcknowledgement.get(commit.acknowledgement);
    const fileChange = fileChangeEvent(prepared, commit.result, value, identity);
    const taskResourceAdmissionFailure = exactTaskResourceAdmissionFailure(value, identity);
    const toolTerminal = toolTerminalEvent(
      commit.result,
      value,
      identity,
      taskResourceAdmissionFailure
        ? resourceAdmissionFailureEvent(taskResourceAdmissionFailure.reason, before).failure
        : undefined,
    );
    const providerAction = providerActionRequiredEvent(
      input.providerAction,
      prepared,
      commit.result,
      identity,
    );
    const capabilityResult = capabilityResultFromTerminal(commit.result, value);
    let artifact: ReturnType<CapabilityArtifactWriter['write']>;
    try {
      artifact = input.capabilityArtifactWriter.write(identity.invocationId, capabilityResult);
    } catch (error) {
      throw new AppStateToolPipelinePersistenceError(
        'artifact_write_failed',
        error instanceof Error ? error.message : 'Capability result artifact write failed.',
      );
    }

    const finishedAt = stateTimestamp(input.now());
    const capabilityTerminal = capabilityTerminalEvent(
      commit.result,
      value,
      identity.invocationId,
      artifact,
      finishedAt,
      capabilityResult,
      filesystemObservation,
    );
    const preparedRequest = prepared ? readPreparedRequest(prepared) : undefined;
    const verificationEvent =
      identity.operationId === 'mcp:dynamic_tool' && input.verificationEnabled !== false
        ? (() => {
            if (!preparedRequest) {
              throw new AppStateToolPipelinePersistenceError(
                'acknowledgement_mismatch',
                'Dynamic MCP verification requires its prepared request facts.',
              );
            }
            return preparedRequest.receiptRequirement !== 'effect_receipt'
              ? undefined
              : createBuiltinCapabilityVerificationRequest({
                  invocationId: identity.invocationId,
                  capabilityId: identity.capabilityId,
                  mode: 'required',
                  ...(preparedRequest.taskId ? { taskId: preparedRequest.taskId } : {}),
                  requestedAt: finishedAt,
                });
          })()
        : undefined;
    const events: StateRuntimeEvent[] = [
      capabilityTerminal,
      ...taskRecoveryEvents,
      ...persistedRuntimeEvents,
      ...(fileChange ? [fileChange] : []),
      ...(verificationEvent ? [verificationEvent] : []),
      toolTerminal,
      ...(providerAction ? [providerAction] : []),
    ];
    await persistExact(input.persistReceiptEvents, events, 'receipt_evidence');
    const after = input.getState();
    assertTerminalState(
      after,
      before,
      events.length,
      identity,
      commit.result.status,
      artifact,
      capabilityResultDigest(capabilityResult),
      capabilityResultEvidenceDigest(capabilityResult),
      finishedAt,
      filesystemObservation,
    );
    settledAcknowledgements.add(commit.acknowledgement);
  };

  const commitSuspension = async (
    commit: Readonly<ToolPipelineSuspensionCommit<StateBuiltinOperationStructuredContent>>,
  ): Promise<void> => {
    const identity = assertSupportedAcknowledgement(commit);
    assertOpenAcknowledgement(
      issuedAcknowledgements,
      settledAcknowledgements,
      commit.acknowledgement,
    );
    const before = input.getState();
    assertAcknowledgementState(before, identity);
    if (identity.operationId === 'builtin:task') {
      await commitTaskSubagentSuspension({
        commit,
        identity,
        before,
        prepared: preparedByAcknowledgement.get(commit.acknowledgement),
        input,
      });
      settledAcknowledgements.add(commit.acknowledgement);
      return;
    }
    if (
      identity.operationId !== 'builtin:write_plan' ||
      identity.toolCallId !== commit.suspension.toolCallId ||
      commit.suspension.kind !== 'plan_review'
    ) {
      throw new AppStateToolPipelinePersistenceError('invalid_suspension_result');
    }
    const { runtimeEvents, value } = readStructuredContent(commit.result);
    if (
      commit.result.status !== 'success' ||
      !value.ok ||
      value.filesystemObservation !== undefined ||
      runtimeEvents.length !== 1 ||
      runtimeEvents[0]?.type !== 'plan.review_requested' ||
      JSON.stringify(runtimeEvents[0]) !== JSON.stringify(commit.suspension.event)
    ) {
      throw new AppStateToolPipelinePersistenceError(
        'invalid_suspension_result',
        'Plan review suspension must carry one exact successful Builtin result and review event.',
      );
    }
    const reviewEvent = runtimeEvents[0];
    const capabilityResult = capabilityResultFromTerminal(commit.result, value);
    let artifact: ReturnType<CapabilityArtifactWriter['write']>;
    try {
      artifact = input.capabilityArtifactWriter.write(identity.invocationId, capabilityResult);
    } catch (error) {
      throw new AppStateToolPipelinePersistenceError(
        'artifact_write_failed',
        error instanceof Error ? error.message : 'Capability result artifact write failed.',
      );
    }
    const recordedAt = stateTimestamp(input.now());
    const resultDigest = capabilityResultDigest(capabilityResult);
    const evidenceDigest = capabilityResultEvidenceDigest(capabilityResult);
    const siblingCancellationDecisions = runtimeHostStatePlanReviewSiblingCancellations(
      before,
      identity.toolCallId,
    );
    const siblingCancellations = siblingCancellationDecisions.map(
      (decision): StateRuntimeEvent => ({
        type: 'tool.cancelled',
        toolCallId: decision.toolCallId,
        reason: decision.reason,
      }),
    );
    const events: StateRuntimeEvent[] = [
      {
        type: 'capability.execution_result_recorded',
        invocationId: identity.invocationId,
        resultDigest,
        evidenceDigest,
        recordedAt,
        artifact,
      },
      reviewEvent,
      ...siblingCancellations,
    ];
    await persistExact(input.persistReceiptEvents, events, 'suspension_evidence');
    const after = input.getState();
    assertSuspendedState(
      after,
      before,
      events.length,
      identity,
      artifact,
      resultDigest,
      evidenceDigest,
      siblingCancellationDecisions.map((decision) => decision.toolCallId),
    );
    settledAcknowledgements.add(commit.acknowledgement);
  };

  return Object.freeze({
    recordAttempt,
    recordUnknown,
    commitRetryable,
    commitTerminal,
    commitSuspension,
    workspaceFilesystemEvidence: Object.freeze({
      persistIntent: filesystemMutation.persistIntent,
      verifyPersistedIntent: filesystemMutation.verifyPersistedIntent,
    }),
    workspaceFilesystemMutationEvidence: Object.freeze({
      persistIntent: filesystemMutation.persistMutationIntent,
      verifyPersistedIntent: filesystemMutation.verifyPersistedMutationIntent,
      persistMutationReady: filesystemMutation.persistMutationReady,
      verifyPersistedMutationReady: filesystemMutation.verifyPersistedMutationReady,
    }),
    workspaceFilesystemEditObservation: Object.freeze({
      findLatestAuthenticRead: filesystemMutation.findLatestAuthenticRead,
      verifyLatestAuthenticRead: filesystemMutation.verifyLatestAuthenticRead,
    }),
    createSandboxLifecycle: ({
      prepared,
      artifacts,
    }: {
      readonly prepared: Readonly<PreparedToolInvocation>;
      readonly artifacts: SandboxPreparationArtifactPort;
    }) =>
      createAppToolPipelineSandboxLifecycle({
        prepared,
        artifacts,
        getState: input.getState,
        persistEvents: input.persistReceiptEvents,
        now: input.now,
        resolveOpenAcknowledgement: (candidate) => {
          if (candidate !== prepared) return null;
          const acknowledgement = acknowledgementsByPrepared.get(candidate);
          return acknowledgement &&
            issuedAcknowledgements.has(acknowledgement) &&
            !settledAcknowledgements.has(acknowledgement)
            ? acknowledgement
            : null;
        },
      }),
  });
}

function isExactDynamicMcpRetryableFailureValue(
  value: StateBuiltinOperationStructuredContent | undefined,
  failure: Readonly<CapabilityToolTerminalFailure>,
): boolean {
  if (!value || !isJsonRecord(value)) return false;
  const valueKeys = Object.keys(value).sort();
  if (
    valueKeys.length !== 5 ||
    valueKeys.join(',') !== 'ok,resultMeta,schema,stderr,stdout' ||
    value.schema !== 'kite.builtin-operation-result.v1' ||
    value.ok !== false ||
    value.stdout !== '' ||
    value.stderr !== failure.message ||
    !isJsonRecord(value.resultMeta)
  ) {
    return false;
  }
  const resultMetaKeys = Object.keys(value.resultMeta);
  const providerFailure = value.resultMeta.providerFailure;
  return (
    resultMetaKeys.length === 1 &&
    resultMetaKeys[0] === 'providerFailure' &&
    isJsonRecord(providerFailure) &&
    Object.keys(providerFailure).sort().join(',') === 'code,retryable' &&
    providerFailure.code === failure.code &&
    providerFailure.retryable === true
  );
}

function assertCompositionInput(input: Readonly<CreateAppStateToolPipelinePersistenceInput>): void {
  if (
    !input ||
    typeof input.getState !== 'function' ||
    typeof input.persistAttemptStartEvents !== 'function' ||
    typeof input.persistTerminalRecoveryEvents !== 'function' ||
    typeof input.persistReceiptEvents !== 'function' ||
    typeof input.now !== 'function' ||
    !input.capabilityArtifactWriter ||
    typeof input.capabilityArtifactWriter.write !== 'function'
  ) {
    throw new AppStateToolPipelinePersistenceError('persistence_unavailable');
  }
}

function assertSupportedPreparedIdentity(
  prepared: Readonly<PreparedToolInvocation>,
): Readonly<PreparedToolInvocationIdentity> {
  const identity = prepared.identity;
  if (identity.isDynamicMcp) {
    if (
      identity.operationId !== 'mcp:dynamic_tool' ||
      identity.executionFamily !== 'mcp' ||
      identity.executionMechanism !== 'mcp' ||
      identity.visibility !== 'internal' ||
      identity.modelVisible !== false ||
      identity.exposedToolName !== null ||
      identity.builtinProjectionRevision !== null ||
      identity.dynamicCatalogRevision.length === 0 ||
      identity.executorRevision !== null ||
      identity.bindingId === null ||
      identity.subject.bindingId !== identity.bindingId
    ) {
      throw new AppStateToolPipelinePersistenceError('unsupported_operation');
    }
    return identity;
  }
  const isTask = identity.operationId === 'builtin:task';
  if (
    (!isTask &&
      (identity.executionFamily === 'subagent' || identity.executionMechanism === 'subagent')) ||
    identity.executionMechanism === 'user_input' ||
    identity.operationId === 'builtin:ask_user' ||
    identity.exposedToolName === 'ask_user' ||
    (isTask &&
      (identity.executionFamily !== 'subagent' ||
        identity.executionMechanism !== 'subagent' ||
        identity.exposedToolName !== 'task' ||
        identity.modelVisible !== true))
  ) {
    throw new AppStateToolPipelinePersistenceError('unsupported_operation');
  }
  if (identity.builtinProjectionRevision === null || identity.dynamicCatalogRevision !== null) {
    throw new AppStateToolPipelinePersistenceError('attempt_identity_mismatch');
  }
  return identity;
}

function readPreparedRequest(
  prepared: Readonly<PreparedToolInvocation>,
): Readonly<AppToolPipelinePreparedRequest> {
  const request = prepared.input.request;
  if (!isPreparedRequest(request)) {
    throw new AppStateToolPipelinePersistenceError(
      'invalid_prepared_request',
      'State persistence requires the typed App prepared request facts.',
    );
  }
  return request;
}

function assertPreparedState(
  prepared: Readonly<PreparedToolInvocation>,
  identity: Readonly<PreparedToolInvocationIdentity>,
  request: Readonly<AppToolPipelinePreparedRequest>,
  state: Readonly<StateRuntimeState>,
  existing: Readonly<StateRuntimeState['capabilities']['invocations'][string]> | undefined,
): void {
  if (
    prepared.input.invocationId !== identity.invocationId ||
    prepared.input.attemptId !== identity.attemptId ||
    prepared.input.toolCallId !== identity.toolCallId ||
    digestCapabilityValue(prepared.input.arguments) !== identity.argumentsDigest ||
    digestCapabilityValue(request.effectiveEffects) !== identity.effectiveEffectsDigest ||
    identity.authorizationDigest === null ||
    identity.turnId !== state.turn.turnId
  ) {
    throw new AppStateToolPipelinePersistenceError('attempt_identity_mismatch');
  }
  const toolCall = state.tools.calls[identity.toolCallId];
  if (
    !toolCall ||
    !['queued', 'approved', 'authorized_queued', 'running'].includes(toolCall.status) ||
    toolCall.name !==
      (identity.isDynamicMcp ? identity.subject.exposedToolName : identity.exposedToolName) ||
    toolCall.createdAtTurnId !== identity.turnId ||
    toolCall.modelMessageId !== identity.modelMessageId
  ) {
    throw new AppStateToolPipelinePersistenceError(
      'attempt_identity_mismatch',
      'Prepared identity does not match the active State Tool call.',
    );
  }
  if (existing && existing.toolCallId !== identity.toolCallId) {
    throw new AppStateToolPipelinePersistenceError('invocation_collision');
  }
  if (existing && !['recorded', 'running'].includes(existing.status)) {
    throw new AppStateToolPipelinePersistenceError('terminal_invocation');
  }
  if (
    existing?.subagentProviderLifecycle &&
    existing.subagentProviderLifecycle.status !== 'cleanup_completed'
  ) {
    throw new AppStateToolPipelinePersistenceError('subagent_lifecycle_pending');
  }
}

function capabilityTerminalEvent(
  result: Readonly<CapabilityToolTerminalResult<StateBuiltinOperationStructuredContent>>,
  value: Readonly<StateBuiltinOperationStructuredContent>,
  invocationId: string,
  artifact: ReturnType<CapabilityArtifactWriter['write']>,
  finishedAt: string,
  capabilityResult: CapabilityResult,
  filesystemObservation?: Readonly<AuthenticatedFilesystemObservation>,
): Extract<
  StateRuntimeEvent,
  { type: 'capability.execution_succeeded' | 'capability.execution_failed' }
> {
  const base = {
    invocationId,
    resultDigest: capabilityResultDigest(capabilityResult),
    evidenceDigest: capabilityResultEvidenceDigest(capabilityResult),
    finishedAt,
    artifact,
    ...(filesystemObservation ? { filesystemObservation } : {}),
  };
  if (result.status === 'success') {
    return {
      type: 'capability.execution_succeeded',
      ...base,
    };
  }
  return {
    type: 'capability.execution_failed',
    ...base,
    error: result.failure?.message ?? (value.stderr || 'Builtin operation failed.'),
  };
}

function toolTerminalEvent(
  result: Readonly<CapabilityToolTerminalResult<StateBuiltinOperationStructuredContent>>,
  value: Readonly<StateBuiltinOperationStructuredContent>,
  identity: Readonly<ToolPipelineAttemptAcknowledgement['attempt']>,
  resourceAdmissionFailure?: Readonly<StateClassifiedFailure>,
): StateRuntimeEvent {
  const meta = resultMetaForToolEvent(value);
  if (resourceAdmissionFailure) {
    return {
      type: 'tool.failed',
      toolCallId: identity.toolCallId,
      failure: resourceAdmissionFailure,
    };
  }
  if (result.status === 'cancelled') {
    return {
      type: 'tool.cancelled',
      toolCallId: identity.toolCallId,
      reason: result.failure?.message ?? (value.stderr || 'Tool execution was cancelled.'),
    };
  }
  if (result.status !== 'success' && isRejectedResult(result)) {
    return {
      type: 'tool.rejected',
      toolCallId: identity.toolCallId,
      reason: result.failure?.message ?? (value.stderr || 'Tool execution was rejected.'),
    };
  }
  if (
    result.status !== 'success' &&
    !(result.failure?.code === 'builtin_operation_failed' && value.ok === false)
  ) {
    return {
      type: 'tool.failed',
      toolCallId: identity.toolCallId,
      failure: classifyToolFailure(result),
    };
  }
  const status =
    value.terminationReason === 'timed_out'
      ? ('exhausted' as const)
      : value.ok
        ? 'success'
        : 'error';
  const exitCode = meta.exitCode ?? 0;
  const resultMeta = {
    ...meta,
    ...projectBuiltinToolResultDigests({
      ok: value.ok,
      stdout: value.stdout,
      stderr: value.stderr,
      exitCode,
      status,
      ...(meta.rawResultDigest ? { rawResultDigest: meta.rawResultDigest } : {}),
      ...(meta.truncated === undefined ? {} : { truncated: meta.truncated }),
    }),
  };
  return {
    type: 'tool.finished',
    toolCallId: identity.toolCallId,
    name: identity.operationId.startsWith('builtin:')
      ? identity.operationId.slice('builtin:'.length)
      : identity.operationId,
    result: {
      ok: value.ok,
      command:
        meta.command ??
        (identity.operationId.startsWith('builtin:')
          ? identity.operationId.slice('builtin:'.length)
          : identity.operationId),
      exitCode,
      stdout: value.stdout,
      stderr: value.stderr,
      ...(value.terminationReason ? { terminationReason: value.terminationReason } : {}),
      ...(value.totalLines === undefined ? {} : { totalLines: value.totalLines }),
      resultMeta,
      status,
    },
    ...(value.classifierAdvice
      ? { classifierAdvice: classifierAdviceForToolEvent(value.classifierAdvice) }
      : {}),
  };
}

function resultMetaForToolEvent(value: Readonly<StateBuiltinOperationStructuredContent>): {
  readonly command?: string;
  readonly exitCode?: number;
  readonly path?: string;
  readonly totalLines?: number;
  readonly truncated?: boolean;
  readonly rawResultDigest?: string;
  readonly networkPolicyRevision?: string;
  readonly networkAdmissionDigests?: readonly string[];
  readonly networkFailureCode?: string;
} {
  const source = value.resultMeta;
  const networkAdmissionDigests = Array.isArray(source?.networkAdmissionDigests)
    ? source.networkAdmissionDigests
    : undefined;
  return {
    ...(typeof source?.command === 'string' ? { command: source.command } : {}),
    ...(typeof source?.exitCode === 'number' ? { exitCode: source.exitCode } : {}),
    ...(typeof value.path === 'string' ? { path: value.path } : {}),
    ...(typeof value.totalLines === 'number' ? { totalLines: value.totalLines } : {}),
    ...(typeof source?.truncated === 'boolean' ? { truncated: source.truncated } : {}),
    ...(typeof source?.rawResultDigest === 'string'
      ? { rawResultDigest: source.rawResultDigest }
      : {}),
    ...(typeof source?.networkPolicyRevision === 'string'
      ? { networkPolicyRevision: source.networkPolicyRevision }
      : {}),
    ...(networkAdmissionDigests?.every((digest): digest is string => typeof digest === 'string')
      ? { networkAdmissionDigests: Object.freeze([...networkAdmissionDigests]) }
      : {}),
    ...(typeof source?.networkFailureCode === 'string'
      ? { networkFailureCode: source.networkFailureCode }
      : {}),
  };
}

function classifierAdviceForToolEvent(
  value: Readonly<Record<string, RuntimeJsonValue>>,
): NonNullable<RuntimeHostToolExecutionResult['classifierAdvice']> {
  const disposition = value.disposition;
  return {
    ...(typeof value.detailCode === 'string' ? { detailCode: value.detailCode } : {}),
    ...(disposition === 'never' ||
    disposition === 'correct_args' ||
    disposition === 'retry_once' ||
    disposition === 'alternative' ||
    disposition === 'user_action'
      ? { disposition }
      : {}),
    ...(typeof value.maximumAdditionalCalls === 'number'
      ? { maximumAdditionalCalls: value.maximumAdditionalCalls }
      : {}),
    ...(typeof value.safeAutomaticRetry === 'boolean'
      ? { safeAutomaticRetry: value.safeAutomaticRetry }
      : {}),
    ...(typeof value.requiresNewModelResponse === 'boolean'
      ? { requiresNewModelResponse: value.requiresNewModelResponse }
      : {}),
    ...(typeof value.retryAfterMs === 'number' ? { retryAfterMs: value.retryAfterMs } : {}),
    ...(typeof value.capabilityIntent === 'string'
      ? { capabilityIntent: value.capabilityIntent }
      : {}),
  };
}

function classifyToolFailure(
  result: Readonly<CapabilityToolTerminalResult<StateBuiltinOperationStructuredContent>>,
): StateClassifiedFailure {
  const code = result.failure?.code;
  const kind = code && runtimeHostStateIsFailureKind(code) ? code : 'unknown';
  return runtimeHostStateClassifyFailure(
    kind,
    result.failure?.message ?? 'Builtin operation failed.',
  );
}

function isRejectedResult(
  result: Readonly<CapabilityToolTerminalResult<StateBuiltinOperationStructuredContent>>,
): boolean {
  return (
    result.failure?.code === 'rejected' ||
    result.failure?.code === 'policy_denied' ||
    result.failure?.code === 'approval_rejected'
  );
}

function assertTerminalState(
  after: Readonly<StateRuntimeState>,
  before: Readonly<StateRuntimeState>,
  eventCount: number,
  identity: Readonly<ToolPipelineAttemptAcknowledgement['attempt']>,
  status: CapabilityToolTerminalResult['status'],
  artifact: ReturnType<CapabilityArtifactWriter['write']>,
  resultDigest: string,
  evidenceDigest: string,
  finishedAt: string,
  filesystemObservation?: Readonly<AuthenticatedFilesystemObservation>,
): void {
  const invocation = after.capabilities.invocations[identity.invocationId];
  const expectedStatus = status === 'success' ? 'succeeded' : 'failed';
  if (
    !includesAcknowledgedRevision(after, before, eventCount) ||
    !invocation ||
    invocation.status !== expectedStatus ||
    invocation.toolCallId !== identity.toolCallId ||
    invocation.attemptsStarted !== identity.attempt ||
    invocation.resultDigest !== resultDigest ||
    invocation.evidenceDigest !== evidenceDigest ||
    invocation.artifact?.artifactId !== artifact.artifactId ||
    invocation.artifact?.integrityIdentifier !== artifact.integrityIdentifier ||
    invocation.finishedAt !== finishedAt ||
    (filesystemObservation === undefined
      ? invocation.filesystemObservation !== undefined
      : !sameJson(invocation.filesystemObservation, filesystemObservation))
  ) {
    throw new AppStateToolPipelinePersistenceError(
      'acknowledgement_mismatch',
      'State terminal acknowledgement does not match the committed receipt.',
    );
  }
}

function assertSuspendedState(
  after: Readonly<StateRuntimeState>,
  before: Readonly<StateRuntimeState>,
  eventCount: number,
  identity: Readonly<ToolPipelineAttemptAcknowledgement['attempt']>,
  artifact: ReturnType<CapabilityArtifactWriter['write']>,
  resultDigest: string,
  evidenceDigest: string,
  cancelledToolCallIds: readonly string[],
): void {
  const invocation = after.capabilities.invocations[identity.invocationId];
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
    after.tools.calls[identity.toolCallId]?.status !== 'awaiting_review' ||
    after.interactions.kind !== 'awaiting_review' ||
    after.interactions.toolCallId !== identity.toolCallId ||
    cancelledToolCallIds.some((toolCallId) => after.tools.calls[toolCallId]?.status !== 'cancelled')
  ) {
    throw new AppStateToolPipelinePersistenceError(
      'acknowledgement_mismatch',
      'State suspension acknowledgement does not match the committed review receipt.',
    );
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return digestCapabilityValue(left) === digestCapabilityValue(right);
  } catch {
    return false;
  }
}

function isJsonRecord(
  value: RuntimeJsonValue | undefined,
): value is { readonly [key: string]: RuntimeJsonValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
