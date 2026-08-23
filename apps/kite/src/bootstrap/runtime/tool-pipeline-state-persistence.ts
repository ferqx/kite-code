import {
  type BuiltinOperationExecutionValue,
  type BuiltinWorkspaceFilesystemTerminalVerificationResult,
  type BuiltinWorkspaceFilesystemTerminalVerifier,
  type CapabilityArtifactWriter,
  capabilityResultDigest,
  capabilityResultEvidenceDigest,
  createBuiltinCapabilityVerificationRequest,
  digestCapabilityValue,
  isBuiltinOperationExecutionValue,
  projectBuiltinToolResultDigests,
} from '@kite/builtin-runtime';
import type { CapabilityFailure, CapabilityResult } from '@kite/runtime-contract';
import {
  type RuntimeHostToolExecutionResult,
  runtimeHostStateAdmitCurrentRuntimeEvent,
  runtimeHostStateAdmitRecoveryAttempt,
  runtimeHostStateClassifyFailure,
  runtimeHostStateClassifyToolOutcome,
  runtimeHostStateIsFailureKind,
  runtimeHostStateNormalizeToolRecoveryJournal,
  runtimeHostStatePlanReviewSiblingCancellations,
  runtimeHostStateRecordRecoveryFailure,
  runtimeHostStateToolFailureInstanceId,
  runtimeHostStateToolInvocationFingerprint,
  runtimeHostStateToolRecoveryJournalInvalid,
  type StateClassifiedFailure,
  type StateRuntimeEvent,
  type StateRuntimeState,
} from '@kite/runtime-host';
import type {
  CapabilityEffects,
  CapabilityToolTerminalFailure,
  CapabilityToolTerminalResult,
  PreparedToolInvocation,
  PreparedToolInvocationIdentity,
  PrivateSuspendedSubagentRecord,
  RuntimeJsonValue,
  SandboxPreparationArtifactPort,
  SandboxPreparationLifecycle,
  ToolPipelineAttemptAcknowledgement,
  ToolPipelinePersistence,
  ToolPipelineReceiptCommit,
  ToolPipelineReceiptRequirement,
  ToolPipelineRetryableCommit,
  ToolPipelineRetryEligibility,
  ToolPipelineSuspendedExecutionResult,
  ToolPipelineSuspensionCommit,
  ToolPipelineTaskSubagentSuspension,
  ToolPipelineUnknownOutcome,
  WorkspaceFilesystemDurableEvidencePort,
  WorkspaceFilesystemEditObservationPort,
  WorkspaceFilesystemEditObservationQuery,
  WorkspaceFilesystemEditObservationQueryResult,
  WorkspaceFilesystemIntentDraft,
  WorkspaceFilesystemMutationDurableEvidencePort,
  WorkspaceFilesystemMutationIntentDraft,
  WorkspaceFilesystemMutationReadyDraft,
  WorkspaceFilesystemPersistedIntent,
  WorkspaceFilesystemPersistedMutationIntent,
  WorkspaceFilesystemPersistedMutationReady,
  WorkspaceFilesystemPreparedMutationEvidence,
} from '@kite/runtime-spi';
import { WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_ } from '@kite/runtime-spi';
import { resourceAdmissionFailureEvent } from './resource-admission-terminal';
import type { AppToolPipelinePreparedRequest } from './tool-pipeline-prepared';
import { createAppToolPipelineSandboxLifecycle } from './tool-pipeline-sandbox-lifecycle';

export const APP_STATE_TOOL_PIPELINE_PERSISTENCE_SCHEMA_ =
  'kite.app-state-tool-pipeline-persistence.v1' as const;

/** State consumes the Builtin-owned neutral result; App defines no second schema. */
export type StateBuiltinOperationStructuredContent = BuiltinOperationExecutionValue;
type AuthenticatedFilesystemObservation = Extract<
  BuiltinWorkspaceFilesystemTerminalVerificationResult,
  { readonly valid: true }
>['observation'];

export interface AppStateToolPipelinePersistence
  extends ToolPipelinePersistence<StateBuiltinOperationStructuredContent> {
  /** Same-instance post-ack filesystem evidence; it owns no Provider semantics. */
  readonly workspaceFilesystemEvidence: WorkspaceFilesystemDurableEvidencePort;
  /** Same-instance mutation intent/ready evidence; Builtin remains the mutation semantic owner. */
  readonly workspaceFilesystemMutationEvidence: WorkspaceFilesystemMutationDurableEvidencePort;
  /** State scan only; Builtin validates the returned Artifact and decides stale_read. */
  readonly workspaceFilesystemEditObservation: WorkspaceFilesystemEditObservationPort;
  /** Creates the six-stage sandbox lifecycle only after this exact attempt is open. */
  readonly createSandboxLifecycle: (input: {
    readonly prepared: Readonly<PreparedToolInvocation>;
    readonly artifacts: SandboxPreparationArtifactPort;
  }) => SandboxPreparationLifecycle;
}

export interface CreateAppStateToolPipelinePersistenceInput {
  readonly getState: () => Readonly<StateRuntimeState>;
  readonly persistAttemptStartEvents: (events: StateRuntimeEvent[]) => Promise<boolean>;
  readonly persistTerminalRecoveryEvents: (events: StateRuntimeEvent[]) => Promise<boolean>;
  readonly persistReceiptEvents: (events: StateRuntimeEvent[]) => Promise<boolean>;
  readonly now: () => string;
  readonly capabilityArtifactWriter: CapabilityArtifactWriter;
  /** Required before committing any terminal carrying Builtin filesystem evidence. */
  readonly verifyBuiltinWorkspaceFilesystemTerminal?: BuiltinWorkspaceFilesystemTerminalVerifier;
  /** App-owned presentation sideband; Builtin remains the provider-failure classifier. */
  readonly providerAction?: Readonly<{
    enabled: boolean;
    createInteractionId: () => string;
  }>;
  /** App feature fact controlling dynamic MCP verification planning. */
  readonly verificationEnabled?: boolean;
}

export type AppStateToolPipelinePersistenceErrorCode =
  | 'invalid_prepared_request'
  | 'unsupported_operation'
  | 'attempt_identity_mismatch'
  | 'invocation_collision'
  | 'terminal_invocation'
  | 'subagent_lifecycle_pending'
  | 'persistence_unavailable'
  | 'persistence_stale'
  | 'acknowledgement_mismatch'
  | 'filesystem_intent_invalid'
  | 'filesystem_intent_commit_failed'
  | 'filesystem_mutation_ready_invalid'
  | 'filesystem_mutation_ready_commit_failed'
  | 'filesystem_edit_observation_invalid'
  | 'invalid_terminal_result'
  | 'invalid_suspension_result'
  | 'artifact_write_failed'
  | 'terminal_commit_failed'
  | 'retryable_commit_failed'
  | 'suspension_commit_failed';

export class AppStateToolPipelinePersistenceError extends Error {
  readonly code: AppStateToolPipelinePersistenceErrorCode;

  constructor(code: AppStateToolPipelinePersistenceErrorCode, message?: string) {
    super(message ?? appStateToolPipelinePersistenceMessage(code));
    this.name = 'AppStateToolPipelinePersistenceError';
    this.code = code;
  }
}

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
  const issuedFilesystemIntents = new WeakSet<object>();
  const filesystemIntentBindings = new WeakMap<
    object,
    Readonly<{
      prepared: Readonly<PreparedToolInvocation>;
      acknowledgement: Readonly<ToolPipelineAttemptAcknowledgement>;
      operation: Readonly<WorkspaceFilesystemPersistedIntent['operation']>;
      record: Readonly<WorkspaceFilesystemPersistedIntent['record']>;
    }>
  >();
  const issuedFilesystemMutationIntents = new WeakSet<object>();
  const filesystemMutationIntentBindings = new WeakMap<
    object,
    Readonly<{
      prepared: Readonly<PreparedToolInvocation>;
      acknowledgement: Readonly<ToolPipelineAttemptAcknowledgement>;
      operation: Readonly<WorkspaceFilesystemPersistedMutationIntent['operation']>;
      record: Readonly<WorkspaceFilesystemPersistedMutationIntent['record']>;
    }>
  >();
  const issuedFilesystemMutationReadies = new WeakSet<object>();
  const filesystemMutationReadyBindings = new WeakMap<
    object,
    Readonly<{
      intent: Readonly<WorkspaceFilesystemPersistedMutationIntent>;
      preparedEvidence: Readonly<WorkspaceFilesystemPreparedMutationEvidence>;
      preimageArtifact: Readonly<WorkspaceFilesystemPersistedMutationReady['preimageArtifact']>;
      record: Readonly<WorkspaceFilesystemPersistedMutationReady['record']>;
    }>
  >();
  const issuedFilesystemEditObservations = new WeakSet<object>();
  const filesystemEditObservationBindings = new WeakMap<
    object,
    Readonly<{
      query: Readonly<WorkspaceFilesystemEditObservationQuery>;
      result: Readonly<WorkspaceFilesystemEditObservationQueryResult>;
    }>
  >();
  const settledAcknowledgements = new WeakSet<object>();

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
    if (toolCall?.status === 'queued' || toolCall?.status === 'approved') {
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

  const persistFilesystemIntent: WorkspaceFilesystemDurableEvidencePort['persistIntent'] = async (
    draft,
  ) => {
    const acknowledgement = acknowledgementsByPrepared.get(draft.prepared);
    if (
      draft.schema !== WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_ ||
      !acknowledgement ||
      !issuedAcknowledgements.has(acknowledgement) ||
      settledAcknowledgements.has(acknowledgement)
    ) {
      throw new AppStateToolPipelinePersistenceError('filesystem_intent_invalid');
    }
    const identity = acknowledgement.attempt;
    assertFilesystemIntentDraft(draft, identity);
    const before = input.getState();
    assertAcknowledgementState(before, identity);
    await persistExact(
      input.persistReceiptEvents,
      [
        {
          type: 'capability.filesystem_intent_recorded',
          invocationId: identity.invocationId,
          ...draft.record,
        },
      ],
      'filesystem_intent',
    );
    const after = input.getState();
    const invocation = after.capabilities.invocations[identity.invocationId];
    if (
      !includesAcknowledgedRevision(after, before, 1) ||
      invocation?.status !== 'running' ||
      invocation.attemptsStarted !== identity.attempt ||
      !sameJson(invocation.filesystemIntent, draft.record)
    ) {
      throw new AppStateToolPipelinePersistenceError('filesystem_intent_commit_failed');
    }
    const persisted = Object.freeze({
      schema: WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_,
      status: 'durably_persisted' as const,
      prepared: draft.prepared,
      acknowledgement,
      operation: draft.operation,
      record: draft.record,
    });
    issuedFilesystemIntents.add(persisted);
    filesystemIntentBindings.set(
      persisted,
      Object.freeze({
        prepared: draft.prepared,
        acknowledgement,
        operation: draft.operation,
        record: draft.record,
      }),
    );
    return persisted;
  };

  const verifyPersistedFilesystemIntent: WorkspaceFilesystemDurableEvidencePort['verifyPersistedIntent'] =
    (intent) => {
      const binding = filesystemIntentBindings.get(intent);
      if (!issuedFilesystemIntents.has(intent) || !binding) {
        return Object.freeze({ valid: false, code: 'intent_not_issued' as const });
      }
      if (
        intent.prepared !== binding.prepared ||
        intent.acknowledgement !== binding.acknowledgement
      ) {
        return Object.freeze({ valid: false, code: 'prepared_identity_mismatch' as const });
      }
      if (intent.operation !== binding.operation || intent.record !== binding.record) {
        return Object.freeze({ valid: false, code: 'operation_identity_mismatch' as const });
      }
      try {
        assertOpenAcknowledgement(
          issuedAcknowledgements,
          settledAcknowledgements,
          intent.acknowledgement,
        );
        const state = input.getState();
        const attempt = intent.acknowledgement.attempt;
        const invocation = assertAcknowledgementState(state, attempt);
        if (!sameJson(invocation.filesystemIntent, intent.record)) {
          return Object.freeze({ valid: false, code: 'durable_state_mismatch' as const });
        }
      } catch {
        return Object.freeze({ valid: false, code: 'attempt_identity_mismatch' as const });
      }
      return Object.freeze({ valid: true as const });
    };

  const persistFilesystemMutationIntent: WorkspaceFilesystemMutationDurableEvidencePort['persistIntent'] =
    async (draft) => {
      const acknowledgement = acknowledgementsByPrepared.get(draft.prepared);
      if (
        draft.schema !== WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_ ||
        !acknowledgement ||
        !issuedAcknowledgements.has(acknowledgement) ||
        settledAcknowledgements.has(acknowledgement)
      ) {
        throw new AppStateToolPipelinePersistenceError('filesystem_intent_invalid');
      }
      const identity = acknowledgement.attempt;
      assertFilesystemMutationIntentDraft(draft, identity);
      const before = input.getState();
      assertAcknowledgementState(before, identity);
      await persistExact(
        input.persistReceiptEvents,
        [
          {
            type: 'capability.filesystem_intent_recorded',
            invocationId: identity.invocationId,
            ...draft.record,
          },
        ],
        'filesystem_intent',
      );
      const after = input.getState();
      const invocation = after.capabilities.invocations[identity.invocationId];
      if (
        !includesAcknowledgedRevision(after, before, 1) ||
        invocation?.status !== 'running' ||
        invocation.attemptsStarted !== identity.attempt ||
        !sameJson(invocation.filesystemIntent, draft.record)
      ) {
        throw new AppStateToolPipelinePersistenceError('filesystem_intent_commit_failed');
      }
      const persisted = Object.freeze({
        schema: WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_,
        status: 'durably_persisted' as const,
        prepared: draft.prepared,
        acknowledgement,
        operation: draft.operation,
        record: draft.record,
      });
      issuedFilesystemMutationIntents.add(persisted);
      filesystemMutationIntentBindings.set(
        persisted,
        Object.freeze({
          prepared: draft.prepared,
          acknowledgement,
          operation: draft.operation,
          record: draft.record,
        }),
      );
      return persisted;
    };

  const verifyPersistedFilesystemMutationIntent: WorkspaceFilesystemMutationDurableEvidencePort['verifyPersistedIntent'] =
    (intent) => {
      const binding = filesystemMutationIntentBindings.get(intent);
      if (!issuedFilesystemMutationIntents.has(intent) || !binding) {
        return Object.freeze({ valid: false, code: 'intent_not_issued' as const });
      }
      if (
        intent.prepared !== binding.prepared ||
        intent.acknowledgement !== binding.acknowledgement
      ) {
        return Object.freeze({ valid: false, code: 'prepared_identity_mismatch' as const });
      }
      if (intent.operation !== binding.operation || intent.record !== binding.record) {
        return Object.freeze({ valid: false, code: 'operation_identity_mismatch' as const });
      }
      try {
        assertOpenAcknowledgement(
          issuedAcknowledgements,
          settledAcknowledgements,
          intent.acknowledgement,
        );
        const invocation = assertAcknowledgementState(
          input.getState(),
          intent.acknowledgement.attempt,
        );
        if (!sameJson(invocation.filesystemIntent, intent.record)) {
          return Object.freeze({ valid: false, code: 'durable_state_mismatch' as const });
        }
      } catch {
        return Object.freeze({ valid: false, code: 'attempt_identity_mismatch' as const });
      }
      return Object.freeze({ valid: true as const });
    };

  const persistFilesystemMutationReady: WorkspaceFilesystemMutationDurableEvidencePort['persistMutationReady'] =
    async (draft) => {
      const intentBinding = filesystemMutationIntentBindings.get(draft.intent);
      if (
        draft.schema !== WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_ ||
        !issuedFilesystemMutationIntents.has(draft.intent) ||
        !intentBinding ||
        draft.intent.acknowledgement !== intentBinding.acknowledgement
      ) {
        throw new AppStateToolPipelinePersistenceError('filesystem_mutation_ready_invalid');
      }
      assertOpenAcknowledgement(
        issuedAcknowledgements,
        settledAcknowledgements,
        draft.intent.acknowledgement,
      );
      assertFilesystemMutationReadyDraft(draft);
      const identity = draft.intent.acknowledgement.attempt;
      const before = input.getState();
      assertAcknowledgementState(before, identity);
      await persistExact(
        input.persistReceiptEvents,
        [
          {
            type: 'capability.filesystem_mutation_ready',
            invocationId: identity.invocationId,
            ...draft.record,
          },
        ],
        'filesystem_mutation_ready',
      );
      const after = input.getState();
      const invocation = after.capabilities.invocations[identity.invocationId];
      if (
        !includesAcknowledgedRevision(after, before, 1) ||
        invocation?.status !== 'running' ||
        invocation.attemptsStarted !== identity.attempt ||
        !sameJson(invocation.filesystemIntent, draft.intent.record) ||
        !sameJson(invocation.filesystemMutationReady, draft.record)
      ) {
        throw new AppStateToolPipelinePersistenceError('filesystem_mutation_ready_commit_failed');
      }
      const persisted = Object.freeze({
        schema: WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_,
        status: 'durably_persisted' as const,
        intent: draft.intent,
        preimageArtifact: draft.preimageArtifact,
        record: draft.record,
      });
      issuedFilesystemMutationReadies.add(persisted);
      filesystemMutationReadyBindings.set(
        persisted,
        Object.freeze({
          intent: draft.intent,
          preparedEvidence: draft.preparedEvidence,
          preimageArtifact: draft.preimageArtifact,
          record: draft.record,
        }),
      );
      return persisted;
    };

  const verifyPersistedFilesystemMutationReady: WorkspaceFilesystemMutationDurableEvidencePort['verifyPersistedMutationReady'] =
    (ready) => {
      const binding = filesystemMutationReadyBindings.get(ready);
      if (!issuedFilesystemMutationReadies.has(ready) || !binding) {
        return Object.freeze({ valid: false, code: 'ready_not_issued' as const });
      }
      if (ready.intent !== binding.intent) {
        return Object.freeze({ valid: false, code: 'intent_identity_mismatch' as const });
      }
      if (
        ready.preimageArtifact !== binding.preimageArtifact ||
        ready.record.preimageArtifact !== binding.preimageArtifact
      ) {
        return Object.freeze({ valid: false, code: 'artifact_identity_mismatch' as const });
      }
      if (ready.record !== binding.record) {
        return Object.freeze({ valid: false, code: 'ready_identity_mismatch' as const });
      }
      try {
        assertOpenAcknowledgement(
          issuedAcknowledgements,
          settledAcknowledgements,
          ready.intent.acknowledgement,
        );
        assertFilesystemMutationReadyDraft({
          schema: WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_,
          intent: ready.intent,
          preparedEvidence: binding.preparedEvidence,
          preimageArtifact: ready.preimageArtifact,
          record: ready.record,
        });
        const invocation = assertAcknowledgementState(
          input.getState(),
          ready.intent.acknowledgement.attempt,
        );
        if (
          !sameJson(invocation.filesystemIntent, ready.intent.record) ||
          !sameJson(invocation.filesystemMutationReady, ready.record)
        ) {
          return Object.freeze({ valid: false, code: 'durable_state_mismatch' as const });
        }
      } catch {
        return Object.freeze({ valid: false, code: 'acknowledgement_identity_mismatch' as const });
      }
      return Object.freeze({ valid: true as const });
    };

  const findLatestFilesystemEditObservation: WorkspaceFilesystemEditObservationPort['findLatestAuthenticRead'] =
    async (query) => {
      assertFilesystemEditObservationQuery(query);
      const candidate = latestFilesystemObservationInvocation(input.getState(), query);
      const result: WorkspaceFilesystemEditObservationQueryResult = candidate
        ? Object.freeze({
            status: 'found' as const,
            query,
            invocationId: candidate.invocationId,
            attempt: candidate.attemptsStarted,
            capabilityRevision: candidate.capabilityRevision,
            resultDigest: candidate.resultDigest!,
            evidenceDigest: candidate.evidenceDigest!,
            artifact: candidate.artifact!,
            observation: candidate.filesystemObservation!,
          })
        : Object.freeze({ status: 'missing' as const, code: 'read_required' as const, query });
      issuedFilesystemEditObservations.add(result);
      filesystemEditObservationBindings.set(result, Object.freeze({ query, result }));
      return result;
    };

  const verifyLatestFilesystemEditObservation: WorkspaceFilesystemEditObservationPort['verifyLatestAuthenticRead'] =
    (result) => {
      const binding = filesystemEditObservationBindings.get(result);
      if (!issuedFilesystemEditObservations.has(result) || !binding || binding.result !== result) {
        return Object.freeze({ valid: false, code: 'query_result_not_issued' as const });
      }
      if (result.query !== binding.query) {
        return Object.freeze({ valid: false, code: 'query_identity_mismatch' as const });
      }
      try {
        assertFilesystemEditObservationQuery(result.query);
      } catch {
        return Object.freeze({ valid: false, code: 'query_identity_mismatch' as const });
      }
      const current = latestFilesystemObservationInvocation(input.getState(), result.query);
      if (result.status === 'missing') {
        return current
          ? Object.freeze({ valid: false, code: 'durable_state_mismatch' as const })
          : Object.freeze({ valid: true as const });
      }
      if (
        !current ||
        current.invocationId !== result.invocationId ||
        current.attemptsStarted !== result.attempt ||
        current.capabilityRevision !== result.capabilityRevision ||
        current.resultDigest !== result.resultDigest ||
        current.evidenceDigest !== result.evidenceDigest ||
        !sameJson(current.artifact, result.artifact) ||
        !sameJson(current.filesystemObservation, result.observation)
      ) {
        return Object.freeze({ valid: false, code: 'durable_state_mismatch' as const });
      }
      return Object.freeze({ valid: true as const });
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
      persistIntent: persistFilesystemIntent,
      verifyPersistedIntent: verifyPersistedFilesystemIntent,
    }),
    workspaceFilesystemMutationEvidence: Object.freeze({
      persistIntent: persistFilesystemMutationIntent,
      verifyPersistedIntent: verifyPersistedFilesystemMutationIntent,
      persistMutationReady: persistFilesystemMutationReady,
      verifyPersistedMutationReady: verifyPersistedFilesystemMutationReady,
    }),
    workspaceFilesystemEditObservation: Object.freeze({
      findLatestAuthenticRead: findLatestFilesystemEditObservation,
      verifyLatestAuthenticRead: verifyLatestFilesystemEditObservation,
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
async function commitTaskSubagentSuspension(
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

function taskSubagentRecoveryEvent(
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

function assertFilesystemIntentDraft(
  draft: Readonly<WorkspaceFilesystemIntentDraft>,
  identity: Readonly<ToolPipelineAttemptAcknowledgement['attempt']>,
): void {
  const prepared = draft.prepared;
  const operation = draft.operation;
  const record = draft.record;
  const identityOperationId = String(identity.operationId);
  const operationId = String(operation.operationId);
  const operationKind = String(operation.kind);
  const expectedKind = identityOperationId.startsWith('builtin:')
    ? identityOperationId.slice('builtin:'.length)
    : '';
  if (
    !Object.isFrozen(prepared) ||
    prepared.identity.invocationId !== identity.invocationId ||
    prepared.identity.attemptId !== identity.attemptId ||
    prepared.identity.toolCallId !== identity.toolCallId ||
    prepared.identity.turnId !== identity.turnId ||
    prepared.identity.modelMessageId !== identity.modelMessageId ||
    String(prepared.identity.operationId) !== identityOperationId ||
    prepared.identity.argumentOrigin !== identity.argumentOrigin ||
    prepared.identity.builtinProjectionRevision !== identity.builtinProjectionRevision ||
    operationId !== identityOperationId ||
    operationKind !== expectedKind ||
    !['read_file', 'search_files', 'search_content'].includes(operationKind) ||
    typeof operation.path !== 'string' ||
    operation.path.length === 0 ||
    record.attempt !== identity.attempt ||
    record.capabilityRevision !== identity.capabilityRevision ||
    record.argumentsDigest !== identity.argumentsDigest ||
    record.admissionDigest !== identity.admissionDigest ||
    record.effectiveEffectsDigest !== identity.effectiveEffectsDigest ||
    typeof record.intentDigest !== 'string' ||
    record.intentDigest.length === 0 ||
    typeof record.operationDigest !== 'string' ||
    record.operationDigest.length === 0 ||
    typeof record.approvalSummaryDigest !== 'string' ||
    record.approvalSummaryDigest.length === 0 ||
    typeof record.recordedAt !== 'string'
  ) {
    throw new AppStateToolPipelinePersistenceError('filesystem_intent_invalid');
  }
}

function assertFilesystemMutationIntentDraft(
  draft: Readonly<WorkspaceFilesystemMutationIntentDraft>,
  identity: Readonly<ToolPipelineAttemptAcknowledgement['attempt']>,
): void {
  const prepared = draft.prepared;
  const operation = draft.operation;
  const record = draft.record;
  const request = prepared.input.request;
  const argumentsValue = prepared.input.arguments;
  const operationId = String(operation.operationId);
  const expectedKind = operationId === 'builtin:write_file' ? 'write_file' : 'edit_file';
  const validArguments = isJsonRecord(argumentsValue);
  const argumentsMatch =
    validArguments && operation.path === argumentsValue.path
      ? operation.kind === 'write_file'
        ? operation.content === argumentsValue.content
        : operation.oldString === argumentsValue.old_string &&
          operation.newString === argumentsValue.new_string &&
          operation.replaceAll === argumentsValue.replace_all
      : false;
  const preparedRequest = isPreparedRequest(request) ? request : undefined;
  const approvedExternal =
    preparedRequest?.policyEffects.externalWrite === true && preparedRequest.grantUsed !== 'none';
  if (
    !Object.isFrozen(prepared) ||
    prepared.identity.isDynamicMcp ||
    prepared.identity.executionFamily !== 'builtin' ||
    prepared.identity.executionMechanism !== 'filesystem' ||
    prepared.identity.invocationId !== identity.invocationId ||
    prepared.identity.attemptId !== identity.attemptId ||
    prepared.identity.toolCallId !== identity.toolCallId ||
    prepared.identity.turnId !== identity.turnId ||
    prepared.identity.modelMessageId !== identity.modelMessageId ||
    String(prepared.identity.operationId) !== operationId ||
    operationId !== String(identity.operationId) ||
    !['builtin:write_file', 'builtin:edit_file'].includes(operationId) ||
    operation.kind !== expectedKind ||
    !argumentsMatch ||
    !preparedRequest ||
    operation.pathScope === 'external_read' ||
    (operation.pathScope === 'approved_external' && !approvedExternal) ||
    record.attempt !== identity.attempt ||
    record.capabilityRevision !== identity.capabilityRevision ||
    record.argumentsDigest !== identity.argumentsDigest ||
    record.admissionDigest !== identity.admissionDigest ||
    record.effectiveEffectsDigest !== identity.effectiveEffectsDigest ||
    typeof record.operationDigest !== 'string' ||
    record.operationDigest.length === 0 ||
    typeof record.intentDigest !== 'string' ||
    record.intentDigest.length === 0 ||
    typeof record.lexicalTargetDigest !== 'string' ||
    record.lexicalTargetDigest.length === 0 ||
    typeof record.approvalSummaryDigest !== 'string' ||
    record.approvalSummaryDigest.length === 0 ||
    typeof record.recordedAt !== 'string'
  ) {
    throw new AppStateToolPipelinePersistenceError('filesystem_intent_invalid');
  }
}

function assertFilesystemMutationReadyDraft(
  draft: Readonly<WorkspaceFilesystemMutationReadyDraft>,
): void {
  const identity = draft.intent.acknowledgement.attempt;
  const operation = draft.intent.operation;
  const evidence = draft.preparedEvidence;
  const record = draft.record;
  const preimageShapeValid = evidence.preimageExisted
    ? typeof evidence.preimageDigest === 'string' && evidence.preimageDigest.length > 0
    : evidence.preimageDigest === null && evidence.preimageByteLength === 0;
  if (
    !Object.isFrozen(draft.intent) ||
    !Object.isFrozen(evidence) ||
    !Object.isFrozen(draft.preimageArtifact) ||
    !Object.isFrozen(record) ||
    evidence.schema !== WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_ ||
    evidence.operationKind !== operation.kind ||
    evidence.operationDigest !== draft.intent.record.operationDigest ||
    evidence.lexicalTargetDigest !== draft.intent.record.lexicalTargetDigest ||
    evidence.lexicalTargetDigest !== draft.intent.record.lexicalTargetDigest ||
    typeof evidence.canonicalTargetDigest !== 'string' ||
    evidence.canonicalTargetDigest.length === 0 ||
    typeof evidence.targetIdentityDigest !== 'string' ||
    evidence.targetIdentityDigest.length === 0 ||
    !Number.isSafeInteger(evidence.preimageByteLength) ||
    evidence.preimageByteLength < 0 ||
    !preimageShapeValid ||
    record.attempt !== identity.attempt ||
    record.intentDigest !== draft.intent.record.intentDigest ||
    record.operationDigest !== evidence.operationDigest ||
    record.targetIdentityDigest !== evidence.targetIdentityDigest ||
    record.preimageDigest !== evidence.preimageDigest ||
    record.preimageArtifact !== draft.preimageArtifact ||
    typeof record.readyDigest !== 'string' ||
    record.readyDigest.length === 0 ||
    typeof record.readyAt !== 'string'
  ) {
    throw new AppStateToolPipelinePersistenceError('filesystem_mutation_ready_invalid');
  }
}

function assertFilesystemEditObservationQuery(
  query: Readonly<WorkspaceFilesystemEditObservationQuery>,
): void {
  const keys = Object.keys(query).sort();
  const expected = ['actorIdentityDigest', 'lexicalTargetDigest', 'schema'];
  if (
    !Object.isFrozen(query) ||
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index]) ||
    query.schema !== WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_ ||
    !/^[a-f0-9]{64}$/u.test(query.actorIdentityDigest) ||
    !/^sha256:[a-f0-9]{64}$/u.test(query.lexicalTargetDigest)
  ) {
    throw new AppStateToolPipelinePersistenceError('filesystem_edit_observation_invalid');
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
    !['queued', 'approved', 'running'].includes(toolCall.status) ||
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

function invocationRecordedEvent(
  identity: Readonly<PreparedToolInvocationIdentity>,
  request: Readonly<AppToolPipelinePreparedRequest>,
  recordedAt: string,
): Extract<StateRuntimeEvent, { type: 'capability.invocation_recorded' }> {
  const event: Extract<StateRuntimeEvent, { type: 'capability.invocation_recorded' }> = {
    type: 'capability.invocation_recorded',
    invocationId: identity.invocationId,
    toolCallId: identity.toolCallId,
    capabilityId: identity.capabilityId,
    capabilityRevision: identity.capabilityRevision,
    ...(request.taskId === null ? {} : { taskId: request.taskId }),
    ...(request.planId === null ? {} : { planId: request.planId }),
    ...(request.planStepId === null ? {} : { planStepId: request.planStepId }),
    argumentsDigest: identity.argumentsDigest,
    authorizationDigest: identity.authorizationDigest!,
    ...(identity.admissionDigest === null ? {} : { admissionDigest: identity.admissionDigest }),
    effectiveEffectsDigest: identity.effectiveEffectsDigest,
    effectiveEffects: request.effectiveEffects,
    receiptRequirement: request.receiptRequirement,
    retryEligibility: request.retryEligibility,
    recordedAt,
    ...(identity.idempotencyKey === null ? {} : { idempotencyKey: identity.idempotencyKey }),
  };
  return event;
}

function assertRecordedState(
  after: Readonly<StateRuntimeState>,
  before: Readonly<StateRuntimeState>,
  eventCount: number,
  identity: Readonly<PreparedToolInvocationIdentity>,
  request: Readonly<AppToolPipelinePreparedRequest>,
  attempt: number,
  recordedAt: string,
  startedAt: string,
): void {
  const invocation = after.capabilities.invocations[identity.invocationId];
  if (
    !includesAcknowledgedRevision(after, before, eventCount) ||
    invocation?.status !== 'running' ||
    invocation.toolCallId !== identity.toolCallId ||
    invocation.capabilityRevision !== identity.capabilityRevision ||
    invocation.argumentsDigest !== identity.argumentsDigest ||
    invocation.authorizationDigest !== identity.authorizationDigest ||
    invocation.admissionDigest !== (identity.admissionDigest ?? undefined) ||
    invocation.effectiveEffectsDigest !== identity.effectiveEffectsDigest ||
    invocation.attemptsStarted !== attempt ||
    invocation.recordedAt !== recordedAt ||
    invocation.startedAt !== startedAt ||
    invocation.idempotencyKey !== (identity.idempotencyKey ?? undefined) ||
    request.receiptRequirement !== invocation.receiptRequirement ||
    request.retryEligibility !== invocation.retryEligibility ||
    after.tools.calls[identity.toolCallId]?.status !== 'running'
  ) {
    throw new AppStateToolPipelinePersistenceError(
      'acknowledgement_mismatch',
      'State attempt acknowledgement does not match the committed invocation.',
    );
  }
}

function assertSupportedAcknowledgement(
  input: Readonly<
    | ToolPipelineUnknownOutcome
    | ToolPipelineReceiptCommit
    | ToolPipelineRetryableCommit
    | ToolPipelineSuspensionCommit
  >,
): Readonly<ToolPipelineAttemptAcknowledgement['attempt']> {
  const acknowledgement = input.acknowledgement;
  const attempt = acknowledgement?.attempt;
  if (
    acknowledgement?.acknowledged !== true ||
    !attempt ||
    !nonEmptyString(attempt.invocationId) ||
    !nonEmptyString(attempt.attemptId) ||
    !Number.isSafeInteger(attempt.attempt) ||
    attempt.attempt < 1 ||
    !nonEmptyString(attempt.toolCallId) ||
    !nonEmptyString(attempt.turnId) ||
    !nonEmptyString(attempt.modelMessageId) ||
    !nonEmptyString(attempt.providerId) ||
    !nonEmptyString(attempt.operationId) ||
    !nonEmptyString(attempt.capabilityId) ||
    !nonEmptyString(attempt.capabilityRevision) ||
    !nonEmptyString(attempt.descriptorRevision) ||
    !nonEmptyString(attempt.argumentsDigest) ||
    !nonEmptyString(attempt.schemaDigest) ||
    !nonEmptyString(attempt.effectiveEffectsDigest) ||
    (attempt.argumentOrigin !== 'model_public' && attempt.argumentOrigin !== 'runtime_private') ||
    attempt.authorizationDigest === null ||
    !nonEmptyString(attempt.authorizationDigest) ||
    attempt.attemptId !== `${attempt.invocationId}:attempt:${attempt.attempt}` ||
    attempt.operationId === 'builtin:ask_user' ||
    (attempt.operationId === 'mcp:dynamic_tool'
      ? attempt.dynamicCatalogRevision === null ||
        attempt.builtinProjectionRevision !== null ||
        attempt.executorRevision !== null ||
        attempt.runtimeWrapperProviderId === null ||
        attempt.runtimeWrapperCapabilityRevision === null ||
        attempt.runtimeWrapperExecutorRevision === null ||
        attempt.runtimeWrapperSchemaDigest === null ||
        attempt.runtimeWrapperBuiltinProjectionRevision === null
      : attempt.dynamicCatalogRevision !== null ||
        attempt.builtinProjectionRevision === null ||
        attempt.runtimeWrapperProviderId !== null ||
        attempt.runtimeWrapperCapabilityRevision !== null ||
        attempt.runtimeWrapperExecutorRevision !== null ||
        attempt.runtimeWrapperSchemaDigest !== null ||
        attempt.runtimeWrapperBuiltinProjectionRevision !== null)
  ) {
    throw new AppStateToolPipelinePersistenceError('acknowledgement_mismatch');
  }
  return attempt;
}

function assertOpenAcknowledgement(
  issuedAcknowledgements: WeakSet<object>,
  settledAcknowledgements: WeakSet<object>,
  acknowledgement: Readonly<ToolPipelineAttemptAcknowledgement>,
): void {
  if (
    !issuedAcknowledgements.has(acknowledgement) ||
    settledAcknowledgements.has(acknowledgement)
  ) {
    throw new AppStateToolPipelinePersistenceError(
      'acknowledgement_mismatch',
      'State persistence rejected an acknowledgement not issued by this owner.',
    );
  }
}

function assertAcknowledgementState(
  state: Readonly<StateRuntimeState>,
  identity: Readonly<ToolPipelineAttemptAcknowledgement['attempt']>,
): Readonly<StateRuntimeState['capabilities']['invocations'][string]> {
  const invocation = state.capabilities.invocations[identity.invocationId];
  if (
    invocation?.status !== 'running' ||
    invocation.toolCallId !== identity.toolCallId ||
    invocation.capabilityId !== identity.capabilityId ||
    invocation.capabilityRevision !== identity.capabilityRevision ||
    invocation.argumentsDigest !== identity.argumentsDigest ||
    invocation.authorizationDigest !== identity.authorizationDigest ||
    invocation.admissionDigest !== (identity.admissionDigest ?? undefined) ||
    invocation.effectiveEffectsDigest !== identity.effectiveEffectsDigest ||
    invocation.attemptsStarted !== identity.attempt
  ) {
    throw new AppStateToolPipelinePersistenceError(
      'acknowledgement_mismatch',
      'State acknowledgement is not the current running invocation.',
    );
  }
  return invocation;
}

function readStructuredContent(
  result: Readonly<
    | CapabilityToolTerminalResult<StateBuiltinOperationStructuredContent>
    | ToolPipelineSuspendedExecutionResult<StateBuiltinOperationStructuredContent>
  >,
): Readonly<{
  value: Readonly<StateBuiltinOperationStructuredContent>;
  runtimeEvents: readonly StateRuntimeEvent[];
}> {
  const value = result.structuredContent;
  if (!isBuiltinOperationExecutionValue(value)) {
    throw new AppStateToolPipelinePersistenceError('invalid_terminal_result');
  }
  return Object.freeze({ value, runtimeEvents: admitRuntimeEvents(value.runtimeEvents) });
}

function capabilityResultFromTerminal(
  result: Readonly<
    | CapabilityToolTerminalResult<StateBuiltinOperationStructuredContent>
    | ToolPipelineSuspendedExecutionResult<StateBuiltinOperationStructuredContent>
  >,
  value: Readonly<StateBuiltinOperationStructuredContent>,
): CapabilityResult {
  const content = result.content.map((entry) => {
    if (!isJsonRecord(entry)) {
      throw new AppStateToolPipelinePersistenceError(
        'invalid_terminal_result',
        'Capability terminal content must contain JSON objects for Artifact storage.',
      );
    }
    return { ...entry };
  });
  const failure = 'failure' in result ? result.failure : undefined;
  const capabilityFailure: CapabilityFailure | undefined = failure
    ? {
        kind: failure.code,
        message: failure.message,
        retryable: failure.retryable,
        modelFixable: failure.modelFixable,
        needsUserIntervention: failure.needsUserIntervention,
        terminatesTurn: failure.terminatesTurn,
        journal: failure.journal,
        ...(failure.parseFailureCode ? { parseFailureCode: failure.parseFailureCode } : {}),
      }
    : undefined;
  const providerMeta = result.providerMeta;
  if (providerMeta !== undefined && !isJsonRecord(providerMeta)) {
    throw new AppStateToolPipelinePersistenceError(
      'invalid_terminal_result',
      'Capability provider metadata must be a JSON object for Artifact storage.',
    );
  }
  return {
    status: result.status,
    content,
    structuredContent: value,
    ...(capabilityFailure ? { error: capabilityFailure } : {}),
    ...(providerMeta === undefined ? {} : { providerMeta: { ...providerMeta } }),
  };
}

function verifyTerminalFilesystemObservation(
  verifier: BuiltinWorkspaceFilesystemTerminalVerifier | undefined,
  commit: Readonly<ToolPipelineReceiptCommit<StateBuiltinOperationStructuredContent>>,
  value: Readonly<StateBuiltinOperationStructuredContent>,
  identity: Readonly<ToolPipelineAttemptAcknowledgement['attempt']>,
): Readonly<AuthenticatedFilesystemObservation> | undefined {
  const candidate = value.filesystemObservation;
  const observationOperation =
    identity.operationId === 'builtin:read_file' ||
    identity.operationId === 'builtin:write_file' ||
    identity.operationId === 'builtin:edit_file';
  if (
    candidate === undefined &&
    observationOperation &&
    commit.result.status === 'success' &&
    value.ok
  ) {
    throw new AppStateToolPipelinePersistenceError(
      'invalid_terminal_result',
      'A successful filesystem terminal must carry an authentic filesystem observation.',
    );
  }
  if (candidate === undefined) return undefined;
  if (!verifier) {
    throw new AppStateToolPipelinePersistenceError(
      'invalid_terminal_result',
      'Filesystem observation requires the injected Builtin terminal verifier.',
    );
  }
  let verification: ReturnType<BuiltinWorkspaceFilesystemTerminalVerifier>;
  try {
    verification = verifier(commit);
  } catch {
    throw new AppStateToolPipelinePersistenceError(
      'invalid_terminal_result',
      'Builtin filesystem terminal verification failed.',
    );
  }
  if (
    !verification.valid ||
    !observationOperation ||
    commit.result.status !== 'success' ||
    !value.ok ||
    !isExactFilesystemObservation(candidate) ||
    !isExactFilesystemObservation(verification.observation) ||
    verification.observation !== candidate ||
    !sameJson(verification.observation, candidate)
  ) {
    throw new AppStateToolPipelinePersistenceError(
      'invalid_terminal_result',
      'Builtin filesystem terminal observation authority did not match the exact terminal.',
    );
  }
  return verification.observation;
}

interface LatestFilesystemObservationInvocation {
  readonly invocationId: string;
  readonly attemptsStarted: number;
  readonly capabilityRevision: string;
  readonly finishedAt: string;
  readonly resultDigest: string;
  readonly evidenceDigest: string;
  readonly artifact: NonNullable<
    StateRuntimeState['capabilities']['invocations'][string]['artifact']
  >;
  readonly filesystemObservation: NonNullable<
    StateRuntimeState['capabilities']['invocations'][string]['filesystemObservation']
  >;
}

function latestFilesystemObservationInvocation(
  state: Readonly<StateRuntimeState>,
  query: Readonly<WorkspaceFilesystemEditObservationQuery>,
): Readonly<LatestFilesystemObservationInvocation> | null {
  let latest: Readonly<LatestFilesystemObservationInvocation> | undefined;
  for (const invocation of Object.values(state.capabilities.invocations)) {
    const observation = invocation.filesystemObservation;
    const expectedEffect =
      invocation.capabilityId === 'builtin:read_file'
        ? 'read'
        : invocation.capabilityId === 'builtin:write_file' ||
            invocation.capabilityId === 'builtin:edit_file'
          ? 'write'
          : null;
    const mutationReady = invocation.filesystemMutationReady;
    const intent = invocation.filesystemIntent;
    if (
      invocation.status !== 'succeeded' ||
      expectedEffect === null ||
      invocation.effectiveEffectsDigest !==
        digestCapabilityValue({
          filesystem: expectedEffect,
          network: 'none',
          externalState: 'none',
        }) ||
      invocation.receiptRequirement !==
        (expectedEffect === 'read' ? 'observation_receipt' : 'effect_receipt') ||
      !Number.isSafeInteger(invocation.attemptsStarted) ||
      (invocation.attemptsStarted ?? 0) < 1 ||
      typeof invocation.finishedAt !== 'string' ||
      typeof invocation.resultDigest !== 'string' ||
      typeof invocation.evidenceDigest !== 'string' ||
      !invocation.artifact ||
      !intent ||
      intent.attempt !== invocation.attemptsStarted ||
      !observation ||
      intent.lexicalTargetDigest !== observation.lexicalTargetDigest ||
      (expectedEffect === 'read'
        ? mutationReady !== undefined
        : !mutationReady ||
          mutationReady.attempt !== invocation.attemptsStarted ||
          mutationReady.intentDigest !== intent.intentDigest ||
          mutationReady.operationDigest !== intent.operationDigest) ||
      observation.actorIdentityDigest !== query.actorIdentityDigest ||
      observation.lexicalTargetDigest !== query.lexicalTargetDigest
    ) {
      continue;
    }
    const candidate = Object.freeze({
      invocationId: invocation.invocationId,
      attemptsStarted: invocation.attemptsStarted,
      capabilityRevision: invocation.capabilityRevision,
      finishedAt: invocation.finishedAt,
      resultDigest: invocation.resultDigest,
      evidenceDigest: invocation.evidenceDigest,
      artifact: invocation.artifact,
      filesystemObservation: observation,
    });
    if (!latest || candidate.finishedAt > latest.finishedAt) latest = candidate;
  }
  return latest ?? null;
}

function isExactFilesystemObservation(
  value: RuntimeJsonValue | undefined,
): value is Readonly<AuthenticatedFilesystemObservation> {
  if (!isJsonRecord(value)) return false;
  const expected = [
    'actorIdentityDigest',
    'canonicalTargetDigest',
    'contentDigest',
    'lexicalTargetDigest',
    'targetIdentityDigest',
  ];
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index]) &&
    expected.every((key) => typeof value[key] === 'string')
  );
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

const TASK_RESOURCE_ADMISSION_REASONS_ = Object.freeze([
  'budget_unconfigured',
  'persistence_unavailable',
  'budget_exhausted',
  'reconciliation_required',
  'tool_concurrency_saturated',
  'shell_concurrency_saturated',
] as const);

function exactTaskResourceAdmissionFailure(
  value: Readonly<StateBuiltinOperationStructuredContent>,
  identity: Readonly<ToolPipelineAttemptAcknowledgement['attempt']>,
):
  | Readonly<{
      reason: (typeof TASK_RESOURCE_ADMISSION_REASONS_)[number];
      message: string;
    }>
  | undefined {
  if (identity.operationId !== 'builtin:task' || !isJsonRecord(value.subagentResult)) {
    return undefined;
  }
  const candidate = value.subagentResult.resourceAdmissionFailure;
  if (candidate === undefined) return undefined;
  if (
    value.ok !== false ||
    !isJsonRecord(candidate) ||
    JSON.stringify(Object.keys(candidate).sort()) !==
      JSON.stringify([
        'childInvocationId',
        'message',
        'parentInvocationId',
        'parentToolCallId',
        'reason',
      ]) ||
    !TASK_RESOURCE_ADMISSION_REASONS_.includes(
      candidate.reason as (typeof TASK_RESOURCE_ADMISSION_REASONS_)[number],
    ) ||
    typeof candidate.message !== 'string' ||
    candidate.message.length === 0 ||
    candidate.parentInvocationId !== identity.invocationId ||
    candidate.parentToolCallId !== identity.toolCallId ||
    typeof candidate.childInvocationId !== 'string' ||
    candidate.childInvocationId.length === 0
  ) {
    throw new AppStateToolPipelinePersistenceError(
      'invalid_terminal_result',
      'Task resource admission failure did not match its exact parent attempt identity.',
    );
  }
  return Object.freeze({
    reason: candidate.reason as (typeof TASK_RESOURCE_ADMISSION_REASONS_)[number],
    message: candidate.message,
  });
}

function fileChangeEvent(
  prepared: Readonly<PreparedToolInvocation> | undefined,
  result: Readonly<CapabilityToolTerminalResult<StateBuiltinOperationStructuredContent>>,
  value: Readonly<StateBuiltinOperationStructuredContent>,
  identity: Readonly<ToolPipelineAttemptAcknowledgement['attempt']>,
): Extract<StateRuntimeEvent, { type: 'tool.file_change' }> | undefined {
  const mutationOperation =
    identity.operationId === 'builtin:write_file' || identity.operationId === 'builtin:edit_file';
  if (!mutationOperation || result.status !== 'success' || !value.ok) return undefined;
  const argumentsValue = prepared?.input.arguments;
  const path =
    isJsonRecord(argumentsValue) && typeof argumentsValue.path === 'string'
      ? argumentsValue.path
      : undefined;
  if (!prepared || !path || value.path !== path) {
    throw new AppStateToolPipelinePersistenceError(
      'invalid_terminal_result',
      'Successful filesystem mutation result did not match its exact prepared lexical path.',
    );
  }
  const preview = (value.stdout || value.stderr).slice(0, 500);
  return {
    type: 'tool.file_change',
    toolCallId: identity.toolCallId,
    path,
    kind: identity.operationId === 'builtin:edit_file' ? 'edit' : 'add',
    ...(preview ? { preview } : {}),
  };
}

function providerActionRequiredEvent(
  composition: CreateAppStateToolPipelinePersistenceInput['providerAction'],
  prepared: Readonly<PreparedToolInvocation> | undefined,
  result: Readonly<CapabilityToolTerminalResult<StateBuiltinOperationStructuredContent>>,
  identity: Readonly<ToolPipelineAttemptAcknowledgement['attempt']>,
): Extract<StateRuntimeEvent, { type: 'provider.action_required' }> | undefined {
  const isDynamicMcp = identity.operationId === 'mcp:dynamic_tool';
  if (
    composition?.enabled !== true ||
    !prepared ||
    (identity.operationId !== 'builtin:read_mcp_resource' && !isDynamicMcp) ||
    result.status === 'success'
  ) {
    return undefined;
  }
  const code = result.failure?.code;
  const action =
    code === 'provider_auth_required'
      ? ('login' as const)
      : code === 'provider_approval_required'
        ? ('approve' as const)
        : code === 'provider_unavailable' && result.failure?.retryable === true
          ? ('retry' as const)
          : undefined;
  if (!action) return undefined;
  const argumentsValue = prepared.input.arguments;
  const providerId = isDynamicMcp
    ? identity.providerId
    : argumentsValue &&
        typeof argumentsValue === 'object' &&
        !Array.isArray(argumentsValue) &&
        'server' in argumentsValue &&
        typeof argumentsValue.server === 'string'
      ? argumentsValue.server
      : '';
  if (!providerId || providerId.length > 512 || /\p{Cc}/u.test(providerId)) {
    throw new AppStateToolPipelinePersistenceError(
      'invalid_terminal_result',
      'Confirmed MCP provider action is missing its exact prepared provider identity.',
    );
  }
  const interactionId = composition.createInteractionId();
  if (!interactionId || interactionId.length > 512 || /\p{Cc}/u.test(interactionId)) {
    throw new AppStateToolPipelinePersistenceError(
      'invalid_terminal_result',
      'Provider action interaction identity is unavailable.',
    );
  }
  return {
    type: 'provider.action_required',
    interactionId,
    providerId,
    action,
    originatingToolCallId: identity.toolCallId,
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

/**
 * A Host effect may acknowledge independent sibling tool facts before this
 * caller resumes from its persistence await. The exact invocation/tool facts
 * below prove this batch; the global revision therefore has to include the
 * acknowledged batch, not equal it exclusively.
 */
function includesAcknowledgedRevision(
  after: Readonly<StateRuntimeState>,
  before: Readonly<StateRuntimeState>,
  eventCount: number,
): boolean {
  return after.revision >= before.revision + eventCount;
}

async function persistExact(
  persist: (events: StateRuntimeEvent[]) => Promise<boolean>,
  events: StateRuntimeEvent[],
  acknowledgement:
    | 'attempt_start'
    | 'terminal_recovery'
    | 'retry_evidence'
    | 'receipt_evidence'
    | 'suspension_evidence'
    | 'filesystem_intent'
    | 'filesystem_mutation_ready',
): Promise<void> {
  let persisted: boolean;
  try {
    persisted = await persist(events);
  } catch (error) {
    throw new AppStateToolPipelinePersistenceError(
      acknowledgement === 'receipt_evidence'
        ? 'terminal_commit_failed'
        : acknowledgement === 'retry_evidence'
          ? 'retryable_commit_failed'
          : acknowledgement === 'suspension_evidence'
            ? 'suspension_commit_failed'
            : acknowledgement === 'filesystem_intent'
              ? 'filesystem_intent_commit_failed'
              : acknowledgement === 'filesystem_mutation_ready'
                ? 'filesystem_mutation_ready_commit_failed'
                : 'persistence_unavailable',
      error instanceof Error ? error.message : `${acknowledgement} persistence failed.`,
    );
  }
  if (!persisted) {
    throw new AppStateToolPipelinePersistenceError(
      acknowledgement === 'receipt_evidence'
        ? 'terminal_commit_failed'
        : acknowledgement === 'retry_evidence'
          ? 'retryable_commit_failed'
          : acknowledgement === 'suspension_evidence'
            ? 'suspension_commit_failed'
            : acknowledgement === 'filesystem_intent'
              ? 'filesystem_intent_commit_failed'
              : acknowledgement === 'filesystem_mutation_ready'
                ? 'filesystem_mutation_ready_commit_failed'
                : 'persistence_stale',
    );
  }
}

function stateTimestamp(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) {
    throw new AppStateToolPipelinePersistenceError('persistence_unavailable');
  }
  return value;
}

function boundedUnknownReason(code: ToolPipelineUnknownOutcome['code']): string {
  const reason = {
    dispatch_failed: 'Tool dispatch failed after the attempt was acknowledged.',
    dispatch_timed_out: 'Tool dispatch timed out after the attempt was acknowledged.',
    dispatch_result_invalid: 'Tool dispatch returned an invalid terminal result.',
    retryable_commit_failed: 'Tool safe-read retry evidence could not be committed.',
    terminal_commit_failed: 'Tool terminal receipt could not be committed.',
    suspension_commit_failed: 'Tool suspension evidence could not be committed.',
  }[code];
  return reason.slice(0, 256);
}

function appStateToolPipelinePersistenceMessage(
  code: AppStateToolPipelinePersistenceErrorCode,
): string {
  switch (code) {
    case 'invalid_prepared_request':
      return 'State Tool Pipeline prepared request facts are invalid.';
    case 'unsupported_operation':
      return 'State Tool Pipeline persistence does not own this operation family.';
    case 'attempt_identity_mismatch':
      return 'State Tool Pipeline attempt identity does not match prepared facts.';
    case 'invocation_collision':
      return 'State Tool Pipeline invocation identity collided with another Tool call.';
    case 'terminal_invocation':
      return 'A terminal State Tool invocation cannot start another attempt.';
    case 'subagent_lifecycle_pending':
      return 'A pending Subagent Provider lifecycle blocks another attempt.';
    case 'persistence_unavailable':
      return 'State Tool Pipeline persistence is unavailable.';
    case 'persistence_stale':
      return 'State Tool Pipeline persistence became stale before acknowledgement.';
    case 'acknowledgement_mismatch':
      return 'State Tool Pipeline acknowledgement does not match State state.';
    case 'filesystem_intent_invalid':
      return 'State filesystem intent does not match the acknowledged prepared attempt.';
    case 'filesystem_intent_commit_failed':
      return 'State filesystem intent could not be durably acknowledged.';
    case 'filesystem_mutation_ready_invalid':
      return 'State filesystem mutation ready evidence is invalid.';
    case 'filesystem_mutation_ready_commit_failed':
      return 'State filesystem mutation ready evidence could not be durably acknowledged.';
    case 'filesystem_edit_observation_invalid':
      return 'State filesystem edit observation query is invalid.';
    case 'invalid_terminal_result':
      return 'State Tool Pipeline terminal result is invalid.';
    case 'invalid_suspension_result':
      return 'State Tool Pipeline suspension result is invalid.';
    case 'artifact_write_failed':
      return 'Capability result Artifact could not be durably written.';
    case 'terminal_commit_failed':
      return 'State Tool Pipeline terminal receipt could not be committed.';
    case 'retryable_commit_failed':
      return 'State Tool Pipeline safe-read retry evidence could not be committed.';
    case 'suspension_commit_failed':
      return 'State Tool Pipeline suspension evidence could not be committed.';
  }
}

function isPreparedRequest(
  value: RuntimeJsonValue | undefined,
): value is AppToolPipelinePreparedRequest & RuntimeJsonValue {
  if (!isJsonRecord(value)) return false;
  const expectedKeys = [
    'schema',
    'authorizationKind',
    'grantUsed',
    'policyEffects',
    'effectiveEffects',
    'receiptRequirement',
    'retryEligibility',
    'taskId',
    'planId',
    'planStepId',
    'capabilityRequestFacts',
  ];
  return (
    Object.keys(value).length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key)) &&
    value.schema === 'kite.tool-pipeline-prepared-request.v1' &&
    (value.authorizationKind === 'policy_allow' || value.authorizationKind === 'approved_call') &&
    (value.grantUsed === 'none' ||
      value.grantUsed === 'approve_once' ||
      value.grantUsed === 'same_command' ||
      value.grantUsed === 'full_access') &&
    isPolicyEffects(value.policyEffects) &&
    isCapabilityEffects(value.effectiveEffects) &&
    isReceiptRequirement(value.receiptRequirement) &&
    isRetryEligibility(value.retryEligibility) &&
    nullableString(value.taskId) &&
    nullableString(value.planId) &&
    nullableString(value.planStepId) &&
    (value.capabilityRequestFacts === null || isRuntimeJson(value.capabilityRequestFacts))
  );
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return digestCapabilityValue(left) === digestCapabilityValue(right);
  } catch {
    return false;
  }
}

function isPolicyEffects(value: RuntimeJsonValue | undefined): boolean {
  if (!isJsonRecord(value)) return false;
  const allowed = new Set(['network', 'externalRead', 'externalWrite', 'uncertainEffects']);
  return Object.entries(value).every(([key, item]) => allowed.has(key) && item === true);
}

function isCapabilityEffects(
  value: RuntimeJsonValue | undefined,
): value is CapabilityEffects & RuntimeJsonValue {
  if (!isJsonRecord(value)) return false;
  return (
    effectLevel(value.filesystem) && effectLevel(value.network) && effectLevel(value.externalState)
  );
}

function effectLevel(value: RuntimeJsonValue | undefined): boolean {
  return (
    value === 'none' ||
    value === 'read' ||
    value === 'write' ||
    value === 'destructive' ||
    value === 'unknown'
  );
}

function isReceiptRequirement(
  value: RuntimeJsonValue | undefined,
): value is ToolPipelineReceiptRequirement {
  return (
    value === 'observation_receipt' ||
    value === 'effect_receipt' ||
    value === 'control_receipt' ||
    value === 'not_applicable'
  );
}

function isRetryEligibility(
  value: RuntimeJsonValue | undefined,
): value is ToolPipelineRetryEligibility {
  return (
    value === 'none' || value === 'safe_read_candidate' || value === 'idempotency_key_candidate'
  );
}

function nullableString(value: RuntimeJsonValue | undefined): value is string | null {
  return value === null || typeof value === 'string';
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
