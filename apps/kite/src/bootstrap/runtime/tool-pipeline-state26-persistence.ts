import {
  type BuiltinOperationExecutionValueV1,
  type BuiltinWorkspaceFilesystemTerminalVerificationResultV1,
  type BuiltinWorkspaceFilesystemTerminalVerifierV1,
  type CapabilityArtifactWriterV1,
  capabilityResultDigestV1,
  capabilityResultEvidenceDigestV1,
  createBuiltinCapabilityVerificationRequestV1,
  digestCapabilityValueV1,
  isBuiltinOperationExecutionValueV1,
  projectBuiltinToolResultDigestsV1,
} from '@kite/builtin-runtime';
import type { CapabilityFailure, CapabilityResult } from '@kite/runtime-contract';
import {
  type RuntimeHostToolExecutionResultV1,
  runtimeHostState26AdmitCurrentRuntimeEventV1,
  runtimeHostState26AdmitRecoveryAttemptV1,
  runtimeHostState26ClassifyFailureV1,
  runtimeHostState26ClassifyToolOutcomeV1,
  runtimeHostState26IsFailureKindV1,
  runtimeHostState26NormalizeToolRecoveryJournalV1,
  runtimeHostState26PlanReviewSiblingCancellationsV1,
  runtimeHostState26RecordRecoveryFailureV1,
  runtimeHostState26ToolFailureInstanceIdV1,
  runtimeHostState26ToolInvocationFingerprintV1,
  runtimeHostState26ToolRecoveryJournalInvalidV1,
  type State26ClassifiedFailureV1,
  type State26RuntimeEventV1,
  type State26RuntimeStateV1,
} from '@kite/runtime-host';
import type {
  CapabilityEffectsV1,
  CapabilityToolTerminalFailureV1,
  CapabilityToolTerminalResultV1,
  PreparedToolInvocationIdentityV1,
  PreparedToolInvocationV1,
  PrivateSuspendedSubagentRecordV1,
  RuntimeJsonValueV1,
  SandboxPreparationArtifactPortV1,
  SandboxPreparationLifecycleV1,
  ToolPipelineAttemptAcknowledgementV1,
  ToolPipelinePersistenceV1,
  ToolPipelineReceiptCommitV1,
  ToolPipelineReceiptRequirementV1,
  ToolPipelineRetryableCommitV1,
  ToolPipelineRetryEligibilityV1,
  ToolPipelineSuspendedExecutionResultV1,
  ToolPipelineSuspensionCommitV1,
  ToolPipelineTaskSubagentSuspensionV1,
  ToolPipelineUnknownOutcomeV1,
  WorkspaceFilesystemDurableEvidencePortV1,
  WorkspaceFilesystemEditObservationPortV1,
  WorkspaceFilesystemEditObservationQueryResultV1,
  WorkspaceFilesystemEditObservationQueryV1,
  WorkspaceFilesystemIntentDraftV1,
  WorkspaceFilesystemMutationDurableEvidencePortV1,
  WorkspaceFilesystemMutationIntentDraftV1,
  WorkspaceFilesystemMutationReadyDraftV1,
  WorkspaceFilesystemPersistedIntentV1,
  WorkspaceFilesystemPersistedMutationIntentV1,
  WorkspaceFilesystemPersistedMutationReadyV1,
  WorkspaceFilesystemPreparedMutationEvidenceV1,
} from '@kite/runtime-spi';
import { WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_V1 } from '@kite/runtime-spi';
import { resourceAdmissionFailureEventV1 } from './resource-admission-terminal';
import type { AppToolPipelinePreparedRequestV1 } from './tool-pipeline-prepared';
import { createAppToolPipelineSandboxLifecycleV1 } from './tool-pipeline-sandbox-lifecycle';

export const APP_STATE26_TOOL_PIPELINE_PERSISTENCE_SCHEMA_V1 =
  'kite.app-state26-tool-pipeline-persistence.v1' as const;

/** State26 consumes the Builtin-owned neutral result; App defines no second schema. */
export type State26BuiltinOperationStructuredContentV1 = BuiltinOperationExecutionValueV1;
type AuthenticatedFilesystemObservationV1 = Extract<
  BuiltinWorkspaceFilesystemTerminalVerificationResultV1,
  { readonly valid: true }
>['observation'];

export interface AppState26ToolPipelinePersistenceV1
  extends ToolPipelinePersistenceV1<State26BuiltinOperationStructuredContentV1> {
  /** Same-instance post-ack filesystem evidence; it owns no Provider semantics. */
  readonly workspaceFilesystemEvidence: WorkspaceFilesystemDurableEvidencePortV1;
  /** Same-instance mutation intent/ready evidence; Builtin remains the mutation semantic owner. */
  readonly workspaceFilesystemMutationEvidence: WorkspaceFilesystemMutationDurableEvidencePortV1;
  /** State26 scan only; Builtin validates the returned Artifact and decides stale_read. */
  readonly workspaceFilesystemEditObservation: WorkspaceFilesystemEditObservationPortV1;
  /** Creates the six-stage sandbox lifecycle only after this exact attempt is open. */
  readonly createSandboxLifecycle: (input: {
    readonly prepared: Readonly<PreparedToolInvocationV1>;
    readonly artifacts: SandboxPreparationArtifactPortV1;
  }) => SandboxPreparationLifecycleV1;
}

export interface CreateAppState26ToolPipelinePersistenceInputV1 {
  readonly getState: () => Readonly<State26RuntimeStateV1>;
  readonly persistAttemptStartEvents: (events: State26RuntimeEventV1[]) => Promise<boolean>;
  readonly persistTerminalRecoveryEvents: (events: State26RuntimeEventV1[]) => Promise<boolean>;
  readonly persistReceiptEvents: (events: State26RuntimeEventV1[]) => Promise<boolean>;
  readonly now: () => string;
  readonly capabilityArtifactWriter: CapabilityArtifactWriterV1;
  /** Required before committing any terminal carrying Builtin filesystem evidence. */
  readonly verifyBuiltinWorkspaceFilesystemTerminal?: BuiltinWorkspaceFilesystemTerminalVerifierV1;
  /** App-owned presentation sideband; Builtin remains the provider-failure classifier. */
  readonly providerAction?: Readonly<{
    enabled: boolean;
    createInteractionId: () => string;
  }>;
  /** App feature fact controlling dynamic MCP verification planning. */
  readonly verificationEnabled?: boolean;
}

export type AppState26ToolPipelinePersistenceErrorCodeV1 =
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

export class AppState26ToolPipelinePersistenceErrorV1 extends Error {
  readonly code: AppState26ToolPipelinePersistenceErrorCodeV1;

  constructor(code: AppState26ToolPipelinePersistenceErrorCodeV1, message?: string) {
    super(message ?? appState26ToolPipelinePersistenceMessageV1(code));
    this.name = 'AppState26ToolPipelinePersistenceErrorV1';
    this.code = code;
  }
}

export function createAppState26ToolPipelinePersistenceV1(
  input: Readonly<CreateAppState26ToolPipelinePersistenceInputV1>,
): AppState26ToolPipelinePersistenceV1 {
  assertCompositionInputV1(input);
  const issuedAcknowledgements = new WeakSet<object>();
  const acknowledgementsByPrepared = new WeakMap<
    object,
    Readonly<ToolPipelineAttemptAcknowledgementV1>
  >();
  const preparedByAcknowledgement = new WeakMap<object, Readonly<PreparedToolInvocationV1>>();
  const issuedFilesystemIntents = new WeakSet<object>();
  const filesystemIntentBindings = new WeakMap<
    object,
    Readonly<{
      prepared: Readonly<PreparedToolInvocationV1>;
      acknowledgement: Readonly<ToolPipelineAttemptAcknowledgementV1>;
      operation: Readonly<WorkspaceFilesystemPersistedIntentV1['operation']>;
      record: Readonly<WorkspaceFilesystemPersistedIntentV1['record']>;
    }>
  >();
  const issuedFilesystemMutationIntents = new WeakSet<object>();
  const filesystemMutationIntentBindings = new WeakMap<
    object,
    Readonly<{
      prepared: Readonly<PreparedToolInvocationV1>;
      acknowledgement: Readonly<ToolPipelineAttemptAcknowledgementV1>;
      operation: Readonly<WorkspaceFilesystemPersistedMutationIntentV1['operation']>;
      record: Readonly<WorkspaceFilesystemPersistedMutationIntentV1['record']>;
    }>
  >();
  const issuedFilesystemMutationReadies = new WeakSet<object>();
  const filesystemMutationReadyBindings = new WeakMap<
    object,
    Readonly<{
      intent: Readonly<WorkspaceFilesystemPersistedMutationIntentV1>;
      preparedEvidence: Readonly<WorkspaceFilesystemPreparedMutationEvidenceV1>;
      preimageArtifact: Readonly<WorkspaceFilesystemPersistedMutationReadyV1['preimageArtifact']>;
      record: Readonly<WorkspaceFilesystemPersistedMutationReadyV1['record']>;
    }>
  >();
  const issuedFilesystemEditObservations = new WeakSet<object>();
  const filesystemEditObservationBindings = new WeakMap<
    object,
    Readonly<{
      query: Readonly<WorkspaceFilesystemEditObservationQueryV1>;
      result: Readonly<WorkspaceFilesystemEditObservationQueryResultV1>;
    }>
  >();
  const settledAcknowledgements = new WeakSet<object>();

  const recordAttempt = async (
    prepared: Readonly<PreparedToolInvocationV1>,
  ): Promise<Readonly<ToolPipelineAttemptAcknowledgementV1>> => {
    const identity = assertSupportedPreparedIdentityV1(prepared);
    const request = readPreparedRequestV1(prepared);
    const before = input.getState();
    const existing = before.capabilities.invocations[identity.invocationId];
    assertPreparedStateV1(prepared, identity, request, before, existing);

    const attempt = (existing?.attemptsStarted ?? 0) + 1;
    const expectedAttemptId = `${identity.invocationId}:attempt:${attempt}`;
    if (identity.attemptId !== expectedAttemptId) {
      throw new AppState26ToolPipelinePersistenceErrorV1(
        'attempt_identity_mismatch',
        'Prepared attemptId does not match the State26 next attempt suffix.',
      );
    }

    const now = state26TimestampV1(input.now());
    const recordedAt = existing?.recordedAt ?? now;
    const persistedStartedAt = existing?.startedAt ?? now;
    const toolCall = before.tools.calls[identity.toolCallId];
    const events: State26RuntimeEventV1[] = [];
    if (!existing) events.push(invocationRecordedEventV1(identity, request, recordedAt));
    events.push({
      type: 'capability.execution_started',
      invocationId: identity.invocationId,
      startedAt: now,
      attempt,
    });
    if (toolCall?.status === 'queued' || toolCall?.status === 'approved') {
      events.push({ type: 'tool.started', toolCallId: identity.toolCallId, createdAt: now });
    }

    await persistExactV1(input.persistAttemptStartEvents, events, 'attempt_start');
    const after = input.getState();
    assertRecordedStateV1(
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

  const persistFilesystemIntent: WorkspaceFilesystemDurableEvidencePortV1['persistIntent'] = async (
    draft,
  ) => {
    const acknowledgement = acknowledgementsByPrepared.get(draft.prepared);
    if (
      draft.schema !== WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_V1 ||
      !acknowledgement ||
      !issuedAcknowledgements.has(acknowledgement) ||
      settledAcknowledgements.has(acknowledgement)
    ) {
      throw new AppState26ToolPipelinePersistenceErrorV1('filesystem_intent_invalid');
    }
    const identity = acknowledgement.attempt;
    assertFilesystemIntentDraftV1(draft, identity);
    const before = input.getState();
    assertAcknowledgementStateV1(before, identity);
    await persistExactV1(
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
      !includesAcknowledgedRevisionV1(after, before, 1) ||
      invocation?.status !== 'running' ||
      invocation.attemptsStarted !== identity.attempt ||
      !sameJsonV1(invocation.filesystemIntent, draft.record)
    ) {
      throw new AppState26ToolPipelinePersistenceErrorV1('filesystem_intent_commit_failed');
    }
    const persisted = Object.freeze({
      schema: WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_V1,
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

  const verifyPersistedFilesystemIntent: WorkspaceFilesystemDurableEvidencePortV1['verifyPersistedIntent'] =
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
        assertOpenAcknowledgementV1(
          issuedAcknowledgements,
          settledAcknowledgements,
          intent.acknowledgement,
        );
        const state = input.getState();
        const attempt = intent.acknowledgement.attempt;
        const invocation = assertAcknowledgementStateV1(state, attempt);
        if (!sameJsonV1(invocation.filesystemIntent, intent.record)) {
          return Object.freeze({ valid: false, code: 'durable_state_mismatch' as const });
        }
      } catch {
        return Object.freeze({ valid: false, code: 'attempt_identity_mismatch' as const });
      }
      return Object.freeze({ valid: true as const });
    };

  const persistFilesystemMutationIntent: WorkspaceFilesystemMutationDurableEvidencePortV1['persistIntent'] =
    async (draft) => {
      const acknowledgement = acknowledgementsByPrepared.get(draft.prepared);
      if (
        draft.schema !== WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_V1 ||
        !acknowledgement ||
        !issuedAcknowledgements.has(acknowledgement) ||
        settledAcknowledgements.has(acknowledgement)
      ) {
        throw new AppState26ToolPipelinePersistenceErrorV1('filesystem_intent_invalid');
      }
      const identity = acknowledgement.attempt;
      assertFilesystemMutationIntentDraftV1(draft, identity);
      const before = input.getState();
      assertAcknowledgementStateV1(before, identity);
      await persistExactV1(
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
        !includesAcknowledgedRevisionV1(after, before, 1) ||
        invocation?.status !== 'running' ||
        invocation.attemptsStarted !== identity.attempt ||
        !sameJsonV1(invocation.filesystemIntent, draft.record)
      ) {
        throw new AppState26ToolPipelinePersistenceErrorV1('filesystem_intent_commit_failed');
      }
      const persisted = Object.freeze({
        schema: WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_V1,
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

  const verifyPersistedFilesystemMutationIntent: WorkspaceFilesystemMutationDurableEvidencePortV1['verifyPersistedIntent'] =
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
        assertOpenAcknowledgementV1(
          issuedAcknowledgements,
          settledAcknowledgements,
          intent.acknowledgement,
        );
        const invocation = assertAcknowledgementStateV1(
          input.getState(),
          intent.acknowledgement.attempt,
        );
        if (!sameJsonV1(invocation.filesystemIntent, intent.record)) {
          return Object.freeze({ valid: false, code: 'durable_state_mismatch' as const });
        }
      } catch {
        return Object.freeze({ valid: false, code: 'attempt_identity_mismatch' as const });
      }
      return Object.freeze({ valid: true as const });
    };

  const persistFilesystemMutationReady: WorkspaceFilesystemMutationDurableEvidencePortV1['persistMutationReady'] =
    async (draft) => {
      const intentBinding = filesystemMutationIntentBindings.get(draft.intent);
      if (
        draft.schema !== WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_V1 ||
        !issuedFilesystemMutationIntents.has(draft.intent) ||
        !intentBinding ||
        draft.intent.acknowledgement !== intentBinding.acknowledgement
      ) {
        throw new AppState26ToolPipelinePersistenceErrorV1('filesystem_mutation_ready_invalid');
      }
      assertOpenAcknowledgementV1(
        issuedAcknowledgements,
        settledAcknowledgements,
        draft.intent.acknowledgement,
      );
      assertFilesystemMutationReadyDraftV1(draft);
      const identity = draft.intent.acknowledgement.attempt;
      const before = input.getState();
      assertAcknowledgementStateV1(before, identity);
      await persistExactV1(
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
        !includesAcknowledgedRevisionV1(after, before, 1) ||
        invocation?.status !== 'running' ||
        invocation.attemptsStarted !== identity.attempt ||
        !sameJsonV1(invocation.filesystemIntent, draft.intent.record) ||
        !sameJsonV1(invocation.filesystemMutationReady, draft.record)
      ) {
        throw new AppState26ToolPipelinePersistenceErrorV1(
          'filesystem_mutation_ready_commit_failed',
        );
      }
      const persisted = Object.freeze({
        schema: WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_V1,
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

  const verifyPersistedFilesystemMutationReady: WorkspaceFilesystemMutationDurableEvidencePortV1['verifyPersistedMutationReady'] =
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
        assertOpenAcknowledgementV1(
          issuedAcknowledgements,
          settledAcknowledgements,
          ready.intent.acknowledgement,
        );
        assertFilesystemMutationReadyDraftV1({
          schema: WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_V1,
          intent: ready.intent,
          preparedEvidence: binding.preparedEvidence,
          preimageArtifact: ready.preimageArtifact,
          record: ready.record,
        });
        const invocation = assertAcknowledgementStateV1(
          input.getState(),
          ready.intent.acknowledgement.attempt,
        );
        if (
          !sameJsonV1(invocation.filesystemIntent, ready.intent.record) ||
          !sameJsonV1(invocation.filesystemMutationReady, ready.record)
        ) {
          return Object.freeze({ valid: false, code: 'durable_state_mismatch' as const });
        }
      } catch {
        return Object.freeze({ valid: false, code: 'acknowledgement_identity_mismatch' as const });
      }
      return Object.freeze({ valid: true as const });
    };

  const findLatestFilesystemEditObservation: WorkspaceFilesystemEditObservationPortV1['findLatestAuthenticRead'] =
    async (query) => {
      assertFilesystemEditObservationQueryV1(query);
      const candidate = latestFilesystemObservationInvocationV1(input.getState(), query);
      const result: WorkspaceFilesystemEditObservationQueryResultV1 = candidate
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

  const verifyLatestFilesystemEditObservation: WorkspaceFilesystemEditObservationPortV1['verifyLatestAuthenticRead'] =
    (result) => {
      const binding = filesystemEditObservationBindings.get(result);
      if (!issuedFilesystemEditObservations.has(result) || !binding || binding.result !== result) {
        return Object.freeze({ valid: false, code: 'query_result_not_issued' as const });
      }
      if (result.query !== binding.query) {
        return Object.freeze({ valid: false, code: 'query_identity_mismatch' as const });
      }
      try {
        assertFilesystemEditObservationQueryV1(result.query);
      } catch {
        return Object.freeze({ valid: false, code: 'query_identity_mismatch' as const });
      }
      const current = latestFilesystemObservationInvocationV1(input.getState(), result.query);
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
        !sameJsonV1(current.artifact, result.artifact) ||
        !sameJsonV1(current.filesystemObservation, result.observation)
      ) {
        return Object.freeze({ valid: false, code: 'durable_state_mismatch' as const });
      }
      return Object.freeze({ valid: true as const });
    };

  const recordUnknown = async (unknown: Readonly<ToolPipelineUnknownOutcomeV1>): Promise<void> => {
    const identity = assertSupportedAcknowledgementV1(unknown);
    assertOpenAcknowledgementV1(
      issuedAcknowledgements,
      settledAcknowledgements,
      unknown.acknowledgement,
    );
    const before = input.getState();
    const invocation = assertAcknowledgementStateV1(before, identity);
    const finishedAt = state26TimestampV1(input.now());
    const reason = boundedUnknownReasonV1(unknown.code);
    const events: State26RuntimeEventV1[] = [
      {
        type: 'capability.execution_unknown',
        invocationId: identity.invocationId,
        reason,
        finishedAt,
      },
      {
        type: 'tool.failed',
        toolCallId: identity.toolCallId,
        failure: runtimeHostState26ClassifyFailureV1(
          identity.operationId === 'mcp:dynamic_tool' && unknown.code === 'terminal_commit_failed'
            ? 'persistence_unavailable'
            : 'unknown',
          reason,
        ),
      },
    ];
    await persistExactV1(input.persistTerminalRecoveryEvents, events, 'terminal_recovery');
    const after = input.getState();
    if (
      !includesAcknowledgedRevisionV1(after, before, events.length) ||
      after.capabilities.invocations[identity.invocationId]?.status !== 'unknown' ||
      after.capabilities.invocations[identity.invocationId]?.finishedAt !== finishedAt ||
      after.tools.calls[identity.toolCallId]?.status !== 'failed' ||
      invocation.status !== 'running'
    ) {
      throw new AppState26ToolPipelinePersistenceErrorV1(
        'acknowledgement_mismatch',
        'State26 unknown terminal acknowledgement did not commit the exact invocation.',
      );
    }
    settledAcknowledgements.add(unknown.acknowledgement);
  };

  const commitRetryable = async (
    commit: Readonly<ToolPipelineRetryableCommitV1<State26BuiltinOperationStructuredContentV1>>,
  ): Promise<void> => {
    const identity = assertSupportedAcknowledgementV1(commit);
    assertOpenAcknowledgementV1(
      issuedAcknowledgements,
      settledAcknowledgements,
      commit.acknowledgement,
    );
    const prepared = preparedByAcknowledgement.get(commit.acknowledgement);
    if (!prepared) {
      throw new AppState26ToolPipelinePersistenceErrorV1('acknowledgement_mismatch');
    }
    const request = readPreparedRequestV1(prepared);
    const failure = commit.result.failure;
    if (
      identity.operationId !== 'mcp:dynamic_tool' ||
      request.retryEligibility !== 'safe_read_candidate' ||
      commit.replaySafety !== 'safe_read' ||
      commit.result.status !== 'error' ||
      failure?.code !== 'provider_unavailable' ||
      failure.retryable !== true ||
      !isExactDynamicMcpRetryableFailureValueV1(commit.result.structuredContent, failure)
    ) {
      throw new AppState26ToolPipelinePersistenceErrorV1(
        'retryable_commit_failed',
        'Only an exact Dynamic MCP safe-read provider failure may authorize another attempt.',
      );
    }

    const before = input.getState();
    assertAcknowledgementStateV1(before, identity);
    const call = before.tools.calls[identity.toolCallId];
    if (
      call?.status !== 'running' ||
      call.createdAtTurnId !== identity.turnId ||
      call.modelMessageId !== identity.modelMessageId
    ) {
      throw new AppState26ToolPipelinePersistenceErrorV1('acknowledgement_mismatch');
    }
    const classifiedFailure = runtimeHostState26ClassifyFailureV1(
      'provider_unavailable',
      failure.message,
    );
    const outcome = runtimeHostState26ClassifyToolOutcomeV1({
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
      throw new AppState26ToolPipelinePersistenceErrorV1('retryable_commit_failed');
    }
    const invocationFingerprint =
      call.invocationFingerprint ??
      runtimeHostState26ToolInvocationFingerprintV1({
        key: before.toolRecovery.identityKey,
        toolName: call.name,
        parsedArgs: call.args,
      });
    const recoveryOf = runtimeHostState26ToolFailureInstanceIdV1({
      toolCallId: identity.toolCallId,
      invocationFingerprint,
      outcome,
    });
    const candidateJournal = runtimeHostState26RecordRecoveryFailureV1(before.toolRecovery, {
      toolCallId: identity.toolCallId,
      toolName: call.name,
      invocationFingerprint,
      modelMessageId: call.modelMessageId,
      outcome,
      ...(call.taskId ? { taskId: call.taskId } : {}),
      turnId: call.createdAtTurnId,
    });
    const admission = runtimeHostState26AdmitRecoveryAttemptV1(candidateJournal, {
      toolCallId: identity.toolCallId,
      toolName: call.name,
      invocationFingerprint,
      modelMessageId: call.modelMessageId,
      mode: 'automatic_retry',
      ...(call.taskId ? { taskId: call.taskId } : {}),
      turnId: call.createdAtTurnId,
    });
    if (!admission.admitted || admission.recoveryOf !== recoveryOf) {
      throw new AppState26ToolPipelinePersistenceErrorV1(
        'retryable_commit_failed',
        'State26 recovery policy did not admit the exact safe-read retry.',
      );
    }
    const retryEvent: State26RuntimeEventV1 = {
      type: 'tool.retry_recorded',
      toolCallId: identity.toolCallId,
      failure: classifiedFailure,
      outcomeV1: Object.freeze({
        ...outcome,
        lineage: Object.freeze({ failureInstanceId: recoveryOf }),
      }),
      recoveryOf,
      retryAttempt: 1,
    };
    await persistExactV1(input.persistReceiptEvents, [retryEvent], 'retry_evidence');
    const after = input.getState();
    const invocation = after.capabilities.invocations[identity.invocationId];
    const afterCall = after.tools.calls[identity.toolCallId];
    const failureRecord = after.toolRecovery.failures[recoveryOf];
    if (
      !includesAcknowledgedRevisionV1(after, before, 1) ||
      invocation?.status !== 'running' ||
      invocation.attemptsStarted !== identity.attempt ||
      afterCall?.status !== 'running' ||
      afterCall.recoveryOf !== recoveryOf ||
      afterCall.recoveryMode !== 'automatic_retry' ||
      failureRecord?.failureInstanceId !== recoveryOf ||
      failureRecord.automaticRetryAttempts !== 1
    ) {
      throw new AppState26ToolPipelinePersistenceErrorV1(
        'retryable_commit_failed',
        'State26 did not acknowledge the exact safe-read retry evidence.',
      );
    }
    settledAcknowledgements.add(commit.acknowledgement);
  };

  const commitTerminal = async (
    commit: Readonly<ToolPipelineReceiptCommitV1<State26BuiltinOperationStructuredContentV1>>,
  ): Promise<void> => {
    const identity = assertSupportedAcknowledgementV1(commit);
    assertOpenAcknowledgementV1(
      issuedAcknowledgements,
      settledAcknowledgements,
      commit.acknowledgement,
    );
    const before = input.getState();
    assertAcknowledgementStateV1(before, identity);
    const { runtimeEvents, value } = readStructuredContentV1(commit.result);
    const taskRecoveryEvent =
      identity.operationId === 'builtin:task'
        ? taskSubagentRecoveryEventV1(value, before, identity, 'invalid_terminal_result')
        : undefined;
    const topLevelTaskRecoveryEvents = runtimeEvents.filter(
      (
        event,
      ): event is Extract<State26RuntimeEventV1, { type: 'subagent.recovery_journal_merged' }> =>
        event.type === 'subagent.recovery_journal_merged',
    );
    if (
      identity.operationId === 'builtin:task' &&
      (topLevelTaskRecoveryEvents.length > 1 ||
        (taskRecoveryEvent === undefined && topLevelTaskRecoveryEvents.length > 0) ||
        topLevelTaskRecoveryEvents.some(
          (event) =>
            event.toolCallId !== identity.toolCallId ||
            (taskRecoveryEvent !== undefined && !sameJsonV1(event, taskRecoveryEvent)),
        ))
    ) {
      throw new AppState26ToolPipelinePersistenceErrorV1(
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
    const filesystemObservation = verifyTerminalFilesystemObservationV1(
      input.verifyBuiltinWorkspaceFilesystemTerminal,
      commit,
      value,
      identity,
    );
    if (commit.result.status === 'unknown' || (commit.result.status === 'success') !== value.ok) {
      throw new AppState26ToolPipelinePersistenceErrorV1(
        'invalid_terminal_result',
        'Unknown or contradictory Builtin terminal results must enter unknown recovery.',
      );
    }
    const prepared = preparedByAcknowledgement.get(commit.acknowledgement);
    const fileChange = fileChangeEventV1(prepared, commit.result, value, identity);
    const taskResourceAdmissionFailure = exactTaskResourceAdmissionFailureV1(value, identity);
    const toolTerminal = toolTerminalEventV1(
      commit.result,
      value,
      identity,
      taskResourceAdmissionFailure
        ? resourceAdmissionFailureEventV1(taskResourceAdmissionFailure.reason, before).failure
        : undefined,
    );
    const providerAction = providerActionRequiredEventV1(
      input.providerAction,
      prepared,
      commit.result,
      identity,
    );
    const capabilityResult = capabilityResultFromTerminalV1(commit.result, value);
    let artifact: ReturnType<CapabilityArtifactWriterV1['write']>;
    try {
      artifact = input.capabilityArtifactWriter.write(identity.invocationId, capabilityResult);
    } catch (error) {
      throw new AppState26ToolPipelinePersistenceErrorV1(
        'artifact_write_failed',
        error instanceof Error ? error.message : 'Capability result artifact write failed.',
      );
    }

    const finishedAt = state26TimestampV1(input.now());
    const capabilityTerminal = capabilityTerminalEventV1(
      commit.result,
      value,
      identity.invocationId,
      artifact,
      finishedAt,
      capabilityResult,
      filesystemObservation,
    );
    const preparedRequest = prepared ? readPreparedRequestV1(prepared) : undefined;
    const verificationEvent =
      identity.operationId === 'mcp:dynamic_tool' && input.verificationEnabled !== false
        ? (() => {
            if (!preparedRequest) {
              throw new AppState26ToolPipelinePersistenceErrorV1(
                'acknowledgement_mismatch',
                'Dynamic MCP verification requires its prepared request facts.',
              );
            }
            return preparedRequest.receiptRequirement !== 'effect_receipt'
              ? undefined
              : createBuiltinCapabilityVerificationRequestV1({
                  invocationId: identity.invocationId,
                  capabilityId: identity.capabilityId,
                  mode: 'required',
                  ...(preparedRequest.taskId ? { taskId: preparedRequest.taskId } : {}),
                  requestedAt: finishedAt,
                });
          })()
        : undefined;
    const events: State26RuntimeEventV1[] = [
      capabilityTerminal,
      ...taskRecoveryEvents,
      ...persistedRuntimeEvents,
      ...(fileChange ? [fileChange] : []),
      ...(verificationEvent ? [verificationEvent] : []),
      toolTerminal,
      ...(providerAction ? [providerAction] : []),
    ];
    await persistExactV1(input.persistReceiptEvents, events, 'receipt_evidence');
    const after = input.getState();
    assertTerminalStateV1(
      after,
      before,
      events.length,
      identity,
      commit.result.status,
      artifact,
      capabilityResultDigestV1(capabilityResult),
      capabilityResultEvidenceDigestV1(capabilityResult),
      finishedAt,
      filesystemObservation,
    );
    settledAcknowledgements.add(commit.acknowledgement);
  };

  const commitSuspension = async (
    commit: Readonly<ToolPipelineSuspensionCommitV1<State26BuiltinOperationStructuredContentV1>>,
  ): Promise<void> => {
    const identity = assertSupportedAcknowledgementV1(commit);
    assertOpenAcknowledgementV1(
      issuedAcknowledgements,
      settledAcknowledgements,
      commit.acknowledgement,
    );
    const before = input.getState();
    assertAcknowledgementStateV1(before, identity);
    if (identity.operationId === 'builtin:task') {
      await commitTaskSubagentSuspensionV1({
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
      throw new AppState26ToolPipelinePersistenceErrorV1('invalid_suspension_result');
    }
    const { runtimeEvents, value } = readStructuredContentV1(commit.result);
    if (
      commit.result.status !== 'success' ||
      !value.ok ||
      value.filesystemObservation !== undefined ||
      runtimeEvents.length !== 1 ||
      runtimeEvents[0]?.type !== 'plan.review_requested' ||
      JSON.stringify(runtimeEvents[0]) !== JSON.stringify(commit.suspension.event)
    ) {
      throw new AppState26ToolPipelinePersistenceErrorV1(
        'invalid_suspension_result',
        'Plan review suspension must carry one exact successful Builtin result and review event.',
      );
    }
    const reviewEvent = runtimeEvents[0];
    const capabilityResult = capabilityResultFromTerminalV1(commit.result, value);
    let artifact: ReturnType<CapabilityArtifactWriterV1['write']>;
    try {
      artifact = input.capabilityArtifactWriter.write(identity.invocationId, capabilityResult);
    } catch (error) {
      throw new AppState26ToolPipelinePersistenceErrorV1(
        'artifact_write_failed',
        error instanceof Error ? error.message : 'Capability result artifact write failed.',
      );
    }
    const recordedAt = state26TimestampV1(input.now());
    const resultDigest = capabilityResultDigestV1(capabilityResult);
    const evidenceDigest = capabilityResultEvidenceDigestV1(capabilityResult);
    const siblingCancellationDecisions = runtimeHostState26PlanReviewSiblingCancellationsV1(
      before,
      identity.toolCallId,
    );
    const siblingCancellations = siblingCancellationDecisions.map(
      (decision): State26RuntimeEventV1 => ({
        type: 'tool.cancelled',
        toolCallId: decision.toolCallId,
        reason: decision.reason,
      }),
    );
    const events: State26RuntimeEventV1[] = [
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
    await persistExactV1(input.persistReceiptEvents, events, 'suspension_evidence');
    const after = input.getState();
    assertSuspendedStateV1(
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
      readonly prepared: Readonly<PreparedToolInvocationV1>;
      readonly artifacts: SandboxPreparationArtifactPortV1;
    }) =>
      createAppToolPipelineSandboxLifecycleV1({
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

function isExactDynamicMcpRetryableFailureValueV1(
  value: State26BuiltinOperationStructuredContentV1 | undefined,
  failure: Readonly<CapabilityToolTerminalFailureV1>,
): boolean {
  if (!value || !isJsonRecordV1(value)) return false;
  const valueKeys = Object.keys(value).sort();
  if (
    valueKeys.length !== 5 ||
    valueKeys.join(',') !== 'ok,resultMeta,schema,stderr,stdout' ||
    value.schema !== 'kite.builtin-operation-result.v1' ||
    value.ok !== false ||
    value.stdout !== '' ||
    value.stderr !== failure.message ||
    !isJsonRecordV1(value.resultMeta)
  ) {
    return false;
  }
  const resultMetaKeys = Object.keys(value.resultMeta);
  const providerFailure = value.resultMeta.providerFailure;
  return (
    resultMetaKeys.length === 1 &&
    resultMetaKeys[0] === 'providerFailure' &&
    isJsonRecordV1(providerFailure) &&
    Object.keys(providerFailure).sort().join(',') === 'code,retryable' &&
    providerFailure.code === failure.code &&
    providerFailure.retryable === true
  );
}

interface CommitTaskSubagentSuspensionInputV1 {
  readonly commit: Readonly<
    ToolPipelineSuspensionCommitV1<State26BuiltinOperationStructuredContentV1>
  >;
  readonly identity: Readonly<ToolPipelineAttemptAcknowledgementV1['attempt']>;
  readonly before: Readonly<State26RuntimeStateV1>;
  readonly prepared: Readonly<PreparedToolInvocationV1> | undefined;
  readonly input: Readonly<CreateAppState26ToolPipelinePersistenceInputV1>;
}

/**
 * Commit the task-specific non-terminal hand-off through the same State26
 * receipt batch as every other Tool Pipeline outcome.  This function only
 * projects the already-authenticated Builtin result and suspension facts; it
 * never creates a child runtime, reviewer, continuation, or terminal event.
 */
async function commitTaskSubagentSuspensionV1(
  input: CommitTaskSubagentSuspensionInputV1,
): Promise<void> {
  const suspension = input.commit.suspension;
  if (
    !isTaskSubagentSuspensionV1(suspension) ||
    input.identity.operationId !== 'builtin:task' ||
    input.identity.capabilityId !== 'builtin:task' ||
    input.identity.toolCallId !== suspension.toolCallId
  ) {
    throw new AppState26ToolPipelinePersistenceErrorV1('invalid_suspension_result');
  }

  const structured = readTaskSuspendedContentV1(input.commit.result);
  const recoveryEvent = taskSubagentRecoveryEventV1(
    structured.value,
    input.before,
    input.identity,
    'invalid_suspension_result',
  );
  assertTaskSubagentSuspensionFactsV1(
    input.before,
    input.identity,
    input.prepared,
    suspension,
    structured.value,
    structured.runtimeEvents,
    recoveryEvent,
  );

  const capabilityResult = capabilityResultFromTerminalV1(input.commit.result, structured.value);
  let artifact: ReturnType<CapabilityArtifactWriterV1['write']>;
  try {
    artifact = input.input.capabilityArtifactWriter.write(
      input.identity.invocationId,
      capabilityResult,
    );
  } catch (error) {
    throw new AppState26ToolPipelinePersistenceErrorV1(
      'artifact_write_failed',
      error instanceof Error ? error.message : 'Capability result artifact write failed.',
    );
  }

  const recordedAt = state26TimestampV1(input.input.now());
  const resultDigest = capabilityResultDigestV1(capabilityResult);
  const evidenceDigest = capabilityResultEvidenceDigestV1(capabilityResult);
  const recordedEvent: Extract<
    State26RuntimeEventV1,
    { type: 'capability.execution_result_recorded' }
  > = {
    type: 'capability.execution_result_recorded',
    invocationId: input.identity.invocationId,
    resultDigest,
    evidenceDigest,
    recordedAt,
    artifact,
  };
  const suspendedEvent: Extract<State26RuntimeEventV1, { type: 'subagent.suspended' }> = {
    type: 'subagent.suspended',
    toolCallId: suspension.toolCallId,
    snapshot: suspension.subagent as Extract<
      State26RuntimeEventV1,
      { type: 'subagent.suspended' }
    >['snapshot'],
  };
  const embeddedSuspensionEvent = structured.runtimeEvents.find(
    (event) => event.type === suspension.event.type && sameJsonV1(event, suspension.event),
  );
  const interactionDeferred = input.before.interactions.kind !== 'idle';
  const interactionEvent: State26RuntimeEventV1 = interactionDeferred
    ? { type: 'subagent.approval_deferred', toolCallId: suspension.toolCallId }
    : (embeddedSuspensionEvent ?? (suspension.event as State26RuntimeEventV1));
  const recoveryEvents = recoveryEvent ? [recoveryEvent] : [];
  const events: State26RuntimeEventV1[] = [
    recordedEvent,
    ...recoveryEvents,
    suspendedEvent,
    interactionEvent,
  ];
  await persistExactV1(input.input.persistReceiptEvents, events, 'suspension_evidence');
  const after = input.input.getState();
  assertTaskSubagentSuspendedStateV1(
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

function readTaskSuspendedContentV1(
  result: Readonly<
    ToolPipelineSuspendedExecutionResultV1<State26BuiltinOperationStructuredContentV1>
  >,
): Readonly<{
  readonly value: Readonly<State26BuiltinOperationStructuredContentV1>;
  readonly runtimeEvents: readonly State26RuntimeEventV1[];
}> {
  if (
    result.status !== 'success' ||
    !isBuiltinOperationExecutionValueV1(result.structuredContent)
  ) {
    throw new AppState26ToolPipelinePersistenceErrorV1(
      'invalid_suspension_result',
      'Task suspension requires one successful Builtin operation result.',
    );
  }
  let runtimeEvents: State26RuntimeEventV1[];
  try {
    runtimeEvents = admitRuntimeEventsV1(result.structuredContent.runtimeEvents);
  } catch (error) {
    if (error instanceof AppState26ToolPipelinePersistenceErrorV1) {
      throw new AppState26ToolPipelinePersistenceErrorV1(
        'invalid_suspension_result',
        'Task suspension runtime events are not valid State26 events.',
      );
    }
    throw error;
  }
  return Object.freeze({ value: result.structuredContent, runtimeEvents });
}

function assertTaskSubagentSuspensionFactsV1(
  before: Readonly<State26RuntimeStateV1>,
  identity: Readonly<ToolPipelineAttemptAcknowledgementV1['attempt']>,
  prepared: Readonly<PreparedToolInvocationV1> | undefined,
  suspension: Readonly<ToolPipelineTaskSubagentSuspensionV1>,
  value: Readonly<State26BuiltinOperationStructuredContentV1>,
  runtimeEvents: readonly State26RuntimeEventV1[],
  recoveryEvent:
    | Extract<State26RuntimeEventV1, { type: 'subagent.recovery_journal_merged' }>
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
        privateSuspendedSubagentParentMatchesV1(previousSuspension, suspension.parent);
  if (
    !parentMatches ||
    !modeMatches ||
    !isTaskPreparedInputV1(prepared, identity) ||
    !call ||
    call.name !== 'task' ||
    call.status !== 'running' ||
    !isExactPrivateSuspendedSubagentRecordV1(suspension.subagent) ||
    suspension.subagent.parentInvocationId !== suspension.parent.invocationId ||
    suspension.subagent.parentAttempt !== suspension.parent.attempt ||
    !isExactTaskBlockedToolIdentityV1(suspension.blockedTool) ||
    suspension.subagent.blockedTool.toolCallId !== suspension.blockedTool.toolCallId ||
    (suspension.subagent.blockedTool.runtimeToolCallId ?? null) !==
      suspension.blockedTool.runtimeToolCallId ||
    suspension.subagent.blockedTool.toolName !== suspension.blockedTool.toolName ||
    !isTaskSuspensionEventV1(suspension.event, suspension) ||
    !taskSubagentResultMatchesSuspensionV1(value, suspension)
  ) {
    throw new AppState26ToolPipelinePersistenceErrorV1(
      'invalid_suspension_result',
      'Task suspension facts do not match the current State26 parent attempt.',
    );
  }

  const interactionEvents = runtimeEvents.filter(
    (event) => event.type === 'approval.requested' || event.type === 'auto_review.requested',
  );
  const embeddedEventCount = interactionEvents.filter((event) =>
    sameJsonV1(event, suspension.event),
  ).length;
  const embeddedRecoveryEvents = runtimeEvents.filter(
    (
      event,
    ): event is Extract<State26RuntimeEventV1, { type: 'subagent.recovery_journal_merged' }> =>
      event.type === 'subagent.recovery_journal_merged',
  );
  if (
    interactionEvents.some((event) => !sameJsonV1(event, suspension.event)) ||
    embeddedEventCount > 1 ||
    embeddedRecoveryEvents.length > 1 ||
    (recoveryEvent === undefined && embeddedRecoveryEvents.length > 0) ||
    (recoveryEvent !== undefined &&
      embeddedRecoveryEvents.some((event) => !sameJsonV1(event, recoveryEvent))) ||
    runtimeEvents.some(
      (event) =>
        event.type !== 'subagent.recovery_journal_merged' && !sameJsonV1(event, suspension.event),
    ) ||
    (interactionEvents.length > 0 && embeddedEventCount !== 1)
  ) {
    throw new AppState26ToolPipelinePersistenceErrorV1(
      'invalid_suspension_result',
      'Task suspension runtime events must contain only the exact Builtin review event.',
    );
  }
}

function taskSubagentRecoveryEventV1(
  value: Readonly<State26BuiltinOperationStructuredContentV1>,
  before: Readonly<State26RuntimeStateV1>,
  identity: Readonly<ToolPipelineAttemptAcknowledgementV1['attempt']>,
  failureCode: 'invalid_suspension_result' | 'invalid_terminal_result',
): Extract<State26RuntimeEventV1, { type: 'subagent.recovery_journal_merged' }> | undefined {
  if (!isJsonRecordV1(value.subagentResult)) return undefined;
  if (!Object.hasOwn(value.subagentResult, 'toolRecovery')) return undefined;
  const rawJournal = value.subagentResult.toolRecovery;
  if (!isRuntimeJsonV1(rawJournal)) {
    throw new AppState26ToolPipelinePersistenceErrorV1(
      failureCode,
      'Builtin task recovery journal is not JSON-safe State26 data.',
    );
  }
  let normalized: ReturnType<typeof runtimeHostState26NormalizeToolRecoveryJournalV1>;
  try {
    normalized = runtimeHostState26NormalizeToolRecoveryJournalV1(
      rawJournal,
      before.toolRecovery.identityKey,
    );
  } catch {
    throw new AppState26ToolPipelinePersistenceErrorV1(
      failureCode,
      'Builtin task recovery journal could not be normalized.',
    );
  }
  if (runtimeHostState26ToolRecoveryJournalInvalidV1(normalized)) {
    throw new AppState26ToolPipelinePersistenceErrorV1(
      failureCode,
      'Builtin task recovery journal is invalid for the current State26 identity.',
    );
  }
  const candidate = {
    type: 'subagent.recovery_journal_merged' as const,
    toolCallId: identity.toolCallId,
    journal: normalized,
  };
  try {
    const admitted = runtimeHostState26AdmitCurrentRuntimeEventV1(candidate);
    if (admitted.type !== 'subagent.recovery_journal_merged') {
      throw new Error('wrong State26 recovery event type');
    }
    return admitted;
  } catch {
    throw new AppState26ToolPipelinePersistenceErrorV1(
      failureCode,
      'Builtin task recovery event failed State26 admission.',
    );
  }
}

function isTaskPreparedInputV1(
  prepared: Readonly<PreparedToolInvocationV1> | undefined,
  identity: Readonly<ToolPipelineAttemptAcknowledgementV1['attempt']>,
): boolean {
  if (
    !prepared ||
    prepared.identity.invocationId !== identity.invocationId ||
    prepared.identity.attemptId !== identity.attemptId ||
    prepared.identity.toolCallId !== identity.toolCallId ||
    prepared.identity.operationId !== 'builtin:task' ||
    prepared.identity.argumentOrigin !== 'runtime_private' ||
    !isJsonRecordV1(prepared.input.arguments)
  ) {
    return false;
  }
  const taskArtifact = prepared.input.arguments.taskArtifact;
  if (!isJsonRecordV1(taskArtifact)) return false;
  return (
    Object.keys(taskArtifact).sort().join(',') ===
      'artifactId,byteLength,integrityIdentifier,kind' &&
    typeof taskArtifact.artifactId === 'string' &&
    /^pa_[0-9a-f]{64}$/u.test(taskArtifact.artifactId) &&
    taskArtifact.kind === 'subagent_task_request' &&
    typeof taskArtifact.integrityIdentifier === 'string' &&
    /^hmac-sha256:[0-9a-f]{64}$/u.test(taskArtifact.integrityIdentifier) &&
    typeof taskArtifact.byteLength === 'number' &&
    Number.isSafeInteger(taskArtifact.byteLength) &&
    taskArtifact.byteLength > 0
  );
}

function assertTaskSubagentSuspendedStateV1(
  after: Readonly<State26RuntimeStateV1>,
  before: Readonly<State26RuntimeStateV1>,
  eventCount: number,
  identity: Readonly<ToolPipelineAttemptAcknowledgementV1['attempt']>,
  suspension: Readonly<ToolPipelineTaskSubagentSuspensionV1>,
  artifact: ReturnType<CapabilityArtifactWriterV1['write']>,
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
    !includesAcknowledgedRevisionV1(after, before, eventCount) ||
    !invocation ||
    invocation.status !== 'running' ||
    invocation.toolCallId !== identity.toolCallId ||
    invocation.attemptsStarted !== identity.attempt ||
    invocation.resultDigest !== resultDigest ||
    invocation.evidenceDigest !== evidenceDigest ||
    invocation.artifact?.artifactId !== artifact.artifactId ||
    invocation.artifact?.integrityIdentifier !== artifact.integrityIdentifier ||
    !sameJsonV1(after.suspendedSubagents[identity.toolCallId], suspension.subagent) ||
    (interactionDeferred
      ? call?.status !== 'queued' || !sameJsonV1(after.interactions, before.interactions)
      : (suspension.event.type === 'approval.requested'
          ? call?.status !== 'awaiting_approval'
          : call?.status !== 'awaiting_auto_review') ||
        after.interactions.kind !== expectedInteraction.kind ||
        after.interactions.interactionId !== expectedInteraction.interactionId ||
        after.interactions.toolCallId !== expectedInteraction.toolCallId)
  ) {
    throw new AppState26ToolPipelinePersistenceErrorV1(
      'acknowledgement_mismatch',
      'State26 task suspension acknowledgement does not match the committed evidence.',
    );
  }
}

function isTaskSubagentSuspensionV1(
  value: Readonly<unknown>,
): value is Readonly<ToolPipelineTaskSubagentSuspensionV1> {
  if (!isRuntimeJsonV1(value) || !isJsonRecordV1(value)) return false;
  const keys = Object.keys(value).sort();
  return (
    keys.join(',') ===
      'blockedTool,event,executionMode,kind,operationId,parent,schema,subagent,toolCallId' &&
    value.schema === 'kite.tool-pipeline-stage.v1' &&
    value.kind === 'task_subagent' &&
    value.operationId === 'builtin:task' &&
    (value.executionMode === 'start' || value.executionMode === 'resume') &&
    typeof value.toolCallId === 'string' &&
    isJsonRecordV1(value.parent) &&
    isJsonRecordV1(value.subagent) &&
    isJsonRecordV1(value.blockedTool) &&
    isJsonRecordV1(value.event)
  );
}

function isExactTaskBlockedToolIdentityV1(value: unknown): boolean {
  if (!isRuntimeJsonV1(value) || !isJsonRecordV1(value)) return false;
  const keys = Object.keys(value).sort();
  return (
    keys.join(',') === 'argumentsDigest,commandDigest,runtimeToolCallId,toolCallId,toolName' &&
    nonEmptyStringV1(value.toolCallId) &&
    (value.runtimeToolCallId === null || nonEmptyStringV1(value.runtimeToolCallId)) &&
    nonEmptyStringV1(value.toolName) &&
    nonEmptyStringV1(value.argumentsDigest) &&
    (value.commandDigest === null || nonEmptyStringV1(value.commandDigest))
  );
}

function isExactPrivateSuspendedSubagentRecordV1(
  value: unknown,
): value is Readonly<PrivateSuspendedSubagentRecordV1> {
  if (!isRuntimeJsonV1(value) || !isJsonRecordV1(value)) return false;
  const keys = Object.keys(value).sort();
  const continuationArtifact = value.continuationArtifact;
  const blockedTool = value.blockedTool;
  if (
    keys.join(',') !==
      'blockedTool,continuationArtifact,continuationId,modelInvocationOrdinal,parentAttempt,parentInvocationId,role,storage,subagentId' ||
    value.storage !== 'private_artifact_v1' ||
    !nonEmptyStringV1(value.subagentId) ||
    !['explore', 'plan', 'code', 'review'].includes(String(value.role)) ||
    typeof value.continuationId !== 'string' ||
    !/^continuation-[0-9a-f]{64}$/u.test(value.continuationId) ||
    typeof value.modelInvocationOrdinal !== 'number' ||
    !Number.isSafeInteger(value.modelInvocationOrdinal) ||
    value.modelInvocationOrdinal < 0 ||
    !nonEmptyStringV1(value.parentInvocationId) ||
    typeof value.parentAttempt !== 'number' ||
    !Number.isSafeInteger(value.parentAttempt) ||
    value.parentAttempt < 1 ||
    !isJsonRecordV1(continuationArtifact) ||
    Object.keys(continuationArtifact).sort().join(',') !==
      'artifactId,byteLength,integrityIdentifier,kind' ||
    typeof continuationArtifact.artifactId !== 'string' ||
    !/^pa_[0-9a-f]{64}$/u.test(continuationArtifact.artifactId) ||
    continuationArtifact.kind !== 'subagent_continuation' ||
    typeof continuationArtifact.integrityIdentifier !== 'string' ||
    !/^hmac-sha256:[0-9a-f]{64}$/u.test(continuationArtifact.integrityIdentifier) ||
    typeof continuationArtifact.byteLength !== 'number' ||
    !Number.isSafeInteger(continuationArtifact.byteLength) ||
    continuationArtifact.byteLength < 1 ||
    !isJsonRecordV1(blockedTool)
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
    nonEmptyStringV1(blockedTool.toolCallId) &&
    nonEmptyStringV1(blockedTool.toolName) &&
    (blockedTool.runtimeToolCallId === undefined || nonEmptyStringV1(blockedTool.runtimeToolCallId))
  );
}

function privateSuspendedSubagentParentMatchesV1(
  value: unknown,
  parent: Readonly<ToolPipelineTaskSubagentSuspensionV1['parent']>,
): boolean {
  return (
    isExactPrivateSuspendedSubagentRecordV1(value) &&
    value.parentInvocationId === parent.invocationId &&
    value.parentAttempt + 1 === parent.attempt
  );
}

function isTaskSuspensionEventV1(
  value: unknown,
  suspension: Readonly<ToolPipelineTaskSubagentSuspensionV1>,
): boolean {
  if (!isRuntimeJsonV1(value) || !isJsonRecordV1(value)) return false;
  let admitted: State26RuntimeEventV1;
  try {
    admitted = runtimeHostState26AdmitCurrentRuntimeEventV1(value);
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

function taskSubagentResultMatchesSuspensionV1(
  value: Readonly<State26BuiltinOperationStructuredContentV1>,
  suspension: Readonly<ToolPipelineTaskSubagentSuspensionV1>,
): boolean {
  if (value.ok !== false || !isJsonRecordV1(value.subagentResult)) return false;
  const subagentResult = value.subagentResult;
  const blocked = subagentResult.blocked;
  if (!isJsonRecordV1(blocked)) return false;
  const continuation = blocked.continuation;
  if (!isJsonRecordV1(continuation)) return false;
  const blockedArguments = blocked.args;
  const blockedCommand = blocked.command;
  const continuationBlockedTool = continuation.blockedTool;
  if (
    !isJsonRecordV1(blockedArguments) ||
    typeof blockedCommand !== 'string' ||
    !isJsonRecordV1(continuationBlockedTool) ||
    !isJsonRecordV1(continuationBlockedTool.args) ||
    typeof continuationBlockedTool.command !== 'string'
  ) {
    return false;
  }
  const argumentsDigest = digestCapabilityValueV1(blockedArguments);
  const commandDigest =
    blockedCommand.trim().length > 0 ? digestCapabilityValueV1(blockedCommand.trim()) : null;
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
    digestCapabilityValueV1(continuationBlockedTool.args) === argumentsDigest &&
    continuationBlockedTool.command === blockedCommand &&
    subagentResult.terminalStatus === 'suspended'
  );
}

function assertCompositionInputV1(
  input: Readonly<CreateAppState26ToolPipelinePersistenceInputV1>,
): void {
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
    throw new AppState26ToolPipelinePersistenceErrorV1('persistence_unavailable');
  }
}

function assertFilesystemIntentDraftV1(
  draft: Readonly<WorkspaceFilesystemIntentDraftV1>,
  identity: Readonly<ToolPipelineAttemptAcknowledgementV1['attempt']>,
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
    throw new AppState26ToolPipelinePersistenceErrorV1('filesystem_intent_invalid');
  }
}

function assertFilesystemMutationIntentDraftV1(
  draft: Readonly<WorkspaceFilesystemMutationIntentDraftV1>,
  identity: Readonly<ToolPipelineAttemptAcknowledgementV1['attempt']>,
): void {
  const prepared = draft.prepared;
  const operation = draft.operation;
  const record = draft.record;
  const request = prepared.input.request;
  const argumentsValue = prepared.input.arguments;
  const operationId = String(operation.operationId);
  const expectedKind = operationId === 'builtin:write_file' ? 'write_file' : 'edit_file';
  const validArguments = isJsonRecordV1(argumentsValue);
  const argumentsMatch =
    validArguments && operation.path === argumentsValue.path
      ? operation.kind === 'write_file'
        ? operation.content === argumentsValue.content
        : operation.oldString === argumentsValue.old_string &&
          operation.newString === argumentsValue.new_string &&
          operation.replaceAll === argumentsValue.replace_all
      : false;
  const preparedRequest = isPreparedRequestV1(request) ? request : undefined;
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
    throw new AppState26ToolPipelinePersistenceErrorV1('filesystem_intent_invalid');
  }
}

function assertFilesystemMutationReadyDraftV1(
  draft: Readonly<WorkspaceFilesystemMutationReadyDraftV1>,
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
    evidence.schema !== WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_V1 ||
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
    throw new AppState26ToolPipelinePersistenceErrorV1('filesystem_mutation_ready_invalid');
  }
}

function assertFilesystemEditObservationQueryV1(
  query: Readonly<WorkspaceFilesystemEditObservationQueryV1>,
): void {
  const keys = Object.keys(query).sort();
  const expected = ['actorIdentityDigest', 'lexicalTargetDigest', 'schema'];
  if (
    !Object.isFrozen(query) ||
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index]) ||
    query.schema !== WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_V1 ||
    !/^[a-f0-9]{64}$/u.test(query.actorIdentityDigest) ||
    !/^sha256:[a-f0-9]{64}$/u.test(query.lexicalTargetDigest)
  ) {
    throw new AppState26ToolPipelinePersistenceErrorV1('filesystem_edit_observation_invalid');
  }
}

function assertSupportedPreparedIdentityV1(
  prepared: Readonly<PreparedToolInvocationV1>,
): Readonly<PreparedToolInvocationIdentityV1> {
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
      throw new AppState26ToolPipelinePersistenceErrorV1('unsupported_operation');
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
    throw new AppState26ToolPipelinePersistenceErrorV1('unsupported_operation');
  }
  if (identity.builtinProjectionRevision === null || identity.dynamicCatalogRevision !== null) {
    throw new AppState26ToolPipelinePersistenceErrorV1('attempt_identity_mismatch');
  }
  return identity;
}

function readPreparedRequestV1(
  prepared: Readonly<PreparedToolInvocationV1>,
): Readonly<AppToolPipelinePreparedRequestV1> {
  const request = prepared.input.request;
  if (!isPreparedRequestV1(request)) {
    throw new AppState26ToolPipelinePersistenceErrorV1(
      'invalid_prepared_request',
      'State26 persistence requires the typed App prepared request facts.',
    );
  }
  return request;
}

function assertPreparedStateV1(
  prepared: Readonly<PreparedToolInvocationV1>,
  identity: Readonly<PreparedToolInvocationIdentityV1>,
  request: Readonly<AppToolPipelinePreparedRequestV1>,
  state: Readonly<State26RuntimeStateV1>,
  existing: Readonly<State26RuntimeStateV1['capabilities']['invocations'][string]> | undefined,
): void {
  if (
    prepared.input.invocationId !== identity.invocationId ||
    prepared.input.attemptId !== identity.attemptId ||
    prepared.input.toolCallId !== identity.toolCallId ||
    digestCapabilityValueV1(prepared.input.arguments) !== identity.argumentsDigest ||
    digestCapabilityValueV1(request.effectiveEffects) !== identity.effectiveEffectsDigest ||
    identity.authorizationDigest === null ||
    identity.turnId !== state.turn.turnId
  ) {
    throw new AppState26ToolPipelinePersistenceErrorV1('attempt_identity_mismatch');
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
    throw new AppState26ToolPipelinePersistenceErrorV1(
      'attempt_identity_mismatch',
      'Prepared identity does not match the active State26 Tool call.',
    );
  }
  if (existing && existing.toolCallId !== identity.toolCallId) {
    throw new AppState26ToolPipelinePersistenceErrorV1('invocation_collision');
  }
  if (existing && !['recorded', 'running'].includes(existing.status)) {
    throw new AppState26ToolPipelinePersistenceErrorV1('terminal_invocation');
  }
  if (
    existing?.subagentProviderLifecycle &&
    existing.subagentProviderLifecycle.status !== 'cleanup_completed'
  ) {
    throw new AppState26ToolPipelinePersistenceErrorV1('subagent_lifecycle_pending');
  }
}

function invocationRecordedEventV1(
  identity: Readonly<PreparedToolInvocationIdentityV1>,
  request: Readonly<AppToolPipelinePreparedRequestV1>,
  recordedAt: string,
): Extract<State26RuntimeEventV1, { type: 'capability.invocation_recorded' }> {
  const event: Extract<State26RuntimeEventV1, { type: 'capability.invocation_recorded' }> = {
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

function assertRecordedStateV1(
  after: Readonly<State26RuntimeStateV1>,
  before: Readonly<State26RuntimeStateV1>,
  eventCount: number,
  identity: Readonly<PreparedToolInvocationIdentityV1>,
  request: Readonly<AppToolPipelinePreparedRequestV1>,
  attempt: number,
  recordedAt: string,
  startedAt: string,
): void {
  const invocation = after.capabilities.invocations[identity.invocationId];
  if (
    !includesAcknowledgedRevisionV1(after, before, eventCount) ||
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
    throw new AppState26ToolPipelinePersistenceErrorV1(
      'acknowledgement_mismatch',
      'State26 attempt acknowledgement does not match the committed invocation.',
    );
  }
}

function assertSupportedAcknowledgementV1(
  input: Readonly<
    | ToolPipelineUnknownOutcomeV1
    | ToolPipelineReceiptCommitV1
    | ToolPipelineRetryableCommitV1
    | ToolPipelineSuspensionCommitV1
  >,
): Readonly<ToolPipelineAttemptAcknowledgementV1['attempt']> {
  const acknowledgement = input.acknowledgement;
  const attempt = acknowledgement?.attempt;
  if (
    acknowledgement?.acknowledged !== true ||
    !attempt ||
    !nonEmptyStringV1(attempt.invocationId) ||
    !nonEmptyStringV1(attempt.attemptId) ||
    !Number.isSafeInteger(attempt.attempt) ||
    attempt.attempt < 1 ||
    !nonEmptyStringV1(attempt.toolCallId) ||
    !nonEmptyStringV1(attempt.turnId) ||
    !nonEmptyStringV1(attempt.modelMessageId) ||
    !nonEmptyStringV1(attempt.providerId) ||
    !nonEmptyStringV1(attempt.operationId) ||
    !nonEmptyStringV1(attempt.capabilityId) ||
    !nonEmptyStringV1(attempt.capabilityRevision) ||
    !nonEmptyStringV1(attempt.descriptorRevision) ||
    !nonEmptyStringV1(attempt.argumentsDigest) ||
    !nonEmptyStringV1(attempt.schemaDigest) ||
    !nonEmptyStringV1(attempt.effectiveEffectsDigest) ||
    (attempt.argumentOrigin !== 'model_public' && attempt.argumentOrigin !== 'runtime_private') ||
    attempt.authorizationDigest === null ||
    !nonEmptyStringV1(attempt.authorizationDigest) ||
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
    throw new AppState26ToolPipelinePersistenceErrorV1('acknowledgement_mismatch');
  }
  return attempt;
}

function assertOpenAcknowledgementV1(
  issuedAcknowledgements: WeakSet<object>,
  settledAcknowledgements: WeakSet<object>,
  acknowledgement: Readonly<ToolPipelineAttemptAcknowledgementV1>,
): void {
  if (
    !issuedAcknowledgements.has(acknowledgement) ||
    settledAcknowledgements.has(acknowledgement)
  ) {
    throw new AppState26ToolPipelinePersistenceErrorV1(
      'acknowledgement_mismatch',
      'State26 persistence rejected an acknowledgement not issued by this owner.',
    );
  }
}

function assertAcknowledgementStateV1(
  state: Readonly<State26RuntimeStateV1>,
  identity: Readonly<ToolPipelineAttemptAcknowledgementV1['attempt']>,
): Readonly<State26RuntimeStateV1['capabilities']['invocations'][string]> {
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
    throw new AppState26ToolPipelinePersistenceErrorV1(
      'acknowledgement_mismatch',
      'State26 acknowledgement is not the current running invocation.',
    );
  }
  return invocation;
}

function readStructuredContentV1(
  result: Readonly<
    | CapabilityToolTerminalResultV1<State26BuiltinOperationStructuredContentV1>
    | ToolPipelineSuspendedExecutionResultV1<State26BuiltinOperationStructuredContentV1>
  >,
): Readonly<{
  value: Readonly<State26BuiltinOperationStructuredContentV1>;
  runtimeEvents: readonly State26RuntimeEventV1[];
}> {
  const value = result.structuredContent;
  if (!isBuiltinOperationExecutionValueV1(value)) {
    throw new AppState26ToolPipelinePersistenceErrorV1('invalid_terminal_result');
  }
  return Object.freeze({ value, runtimeEvents: admitRuntimeEventsV1(value.runtimeEvents) });
}

function capabilityResultFromTerminalV1(
  result: Readonly<
    | CapabilityToolTerminalResultV1<State26BuiltinOperationStructuredContentV1>
    | ToolPipelineSuspendedExecutionResultV1<State26BuiltinOperationStructuredContentV1>
  >,
  value: Readonly<State26BuiltinOperationStructuredContentV1>,
): CapabilityResult {
  const content = result.content.map((entry) => {
    if (!isJsonRecordV1(entry)) {
      throw new AppState26ToolPipelinePersistenceErrorV1(
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
  if (providerMeta !== undefined && !isJsonRecordV1(providerMeta)) {
    throw new AppState26ToolPipelinePersistenceErrorV1(
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

function verifyTerminalFilesystemObservationV1(
  verifier: BuiltinWorkspaceFilesystemTerminalVerifierV1 | undefined,
  commit: Readonly<ToolPipelineReceiptCommitV1<State26BuiltinOperationStructuredContentV1>>,
  value: Readonly<State26BuiltinOperationStructuredContentV1>,
  identity: Readonly<ToolPipelineAttemptAcknowledgementV1['attempt']>,
): Readonly<AuthenticatedFilesystemObservationV1> | undefined {
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
    throw new AppState26ToolPipelinePersistenceErrorV1(
      'invalid_terminal_result',
      'A successful filesystem terminal must carry an authentic filesystem observation.',
    );
  }
  if (candidate === undefined) return undefined;
  if (!verifier) {
    throw new AppState26ToolPipelinePersistenceErrorV1(
      'invalid_terminal_result',
      'Filesystem observation requires the injected Builtin terminal verifier.',
    );
  }
  let verification: ReturnType<BuiltinWorkspaceFilesystemTerminalVerifierV1>;
  try {
    verification = verifier(commit);
  } catch {
    throw new AppState26ToolPipelinePersistenceErrorV1(
      'invalid_terminal_result',
      'Builtin filesystem terminal verification failed.',
    );
  }
  if (
    !verification.valid ||
    !observationOperation ||
    commit.result.status !== 'success' ||
    !value.ok ||
    !isExactFilesystemObservationV1(candidate) ||
    !isExactFilesystemObservationV1(verification.observation) ||
    verification.observation !== candidate ||
    !sameJsonV1(verification.observation, candidate)
  ) {
    throw new AppState26ToolPipelinePersistenceErrorV1(
      'invalid_terminal_result',
      'Builtin filesystem terminal observation authority did not match the exact terminal.',
    );
  }
  return verification.observation;
}

interface LatestFilesystemObservationInvocationV1 {
  readonly invocationId: string;
  readonly attemptsStarted: number;
  readonly capabilityRevision: string;
  readonly finishedAt: string;
  readonly resultDigest: string;
  readonly evidenceDigest: string;
  readonly artifact: NonNullable<
    State26RuntimeStateV1['capabilities']['invocations'][string]['artifact']
  >;
  readonly filesystemObservation: NonNullable<
    State26RuntimeStateV1['capabilities']['invocations'][string]['filesystemObservation']
  >;
}

function latestFilesystemObservationInvocationV1(
  state: Readonly<State26RuntimeStateV1>,
  query: Readonly<WorkspaceFilesystemEditObservationQueryV1>,
): Readonly<LatestFilesystemObservationInvocationV1> | null {
  let latest: Readonly<LatestFilesystemObservationInvocationV1> | undefined;
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
        digestCapabilityValueV1({
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

function isExactFilesystemObservationV1(
  value: RuntimeJsonValueV1 | undefined,
): value is Readonly<AuthenticatedFilesystemObservationV1> {
  if (!isJsonRecordV1(value)) return false;
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

function capabilityTerminalEventV1(
  result: Readonly<CapabilityToolTerminalResultV1<State26BuiltinOperationStructuredContentV1>>,
  value: Readonly<State26BuiltinOperationStructuredContentV1>,
  invocationId: string,
  artifact: ReturnType<CapabilityArtifactWriterV1['write']>,
  finishedAt: string,
  capabilityResult: CapabilityResult,
  filesystemObservation?: Readonly<AuthenticatedFilesystemObservationV1>,
): Extract<
  State26RuntimeEventV1,
  { type: 'capability.execution_succeeded' | 'capability.execution_failed' }
> {
  const base = {
    invocationId,
    resultDigest: capabilityResultDigestV1(capabilityResult),
    evidenceDigest: capabilityResultEvidenceDigestV1(capabilityResult),
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

function toolTerminalEventV1(
  result: Readonly<CapabilityToolTerminalResultV1<State26BuiltinOperationStructuredContentV1>>,
  value: Readonly<State26BuiltinOperationStructuredContentV1>,
  identity: Readonly<ToolPipelineAttemptAcknowledgementV1['attempt']>,
  resourceAdmissionFailure?: Readonly<State26ClassifiedFailureV1>,
): State26RuntimeEventV1 {
  const meta = resultMetaForToolEventV1(value);
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
  if (result.status !== 'success' && isRejectedResultV1(result)) {
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
      failure: classifyToolFailureV1(result),
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
    ...projectBuiltinToolResultDigestsV1({
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
    ...(value.classifierAdviceV1
      ? { classifierAdviceV1: classifierAdviceForToolEventV1(value.classifierAdviceV1) }
      : {}),
  };
}

const TASK_RESOURCE_ADMISSION_REASONS_V1 = Object.freeze([
  'budget_unconfigured',
  'persistence_unavailable',
  'budget_exhausted',
  'reconciliation_required',
  'tool_concurrency_saturated',
  'shell_concurrency_saturated',
] as const);

function exactTaskResourceAdmissionFailureV1(
  value: Readonly<State26BuiltinOperationStructuredContentV1>,
  identity: Readonly<ToolPipelineAttemptAcknowledgementV1['attempt']>,
):
  | Readonly<{
      reason: (typeof TASK_RESOURCE_ADMISSION_REASONS_V1)[number];
      message: string;
    }>
  | undefined {
  if (identity.operationId !== 'builtin:task' || !isJsonRecordV1(value.subagentResult)) {
    return undefined;
  }
  const candidate = value.subagentResult.resourceAdmissionFailure;
  if (candidate === undefined) return undefined;
  if (
    value.ok !== false ||
    !isJsonRecordV1(candidate) ||
    JSON.stringify(Object.keys(candidate).sort()) !==
      JSON.stringify([
        'childInvocationId',
        'message',
        'parentInvocationId',
        'parentToolCallId',
        'reason',
      ]) ||
    !TASK_RESOURCE_ADMISSION_REASONS_V1.includes(
      candidate.reason as (typeof TASK_RESOURCE_ADMISSION_REASONS_V1)[number],
    ) ||
    typeof candidate.message !== 'string' ||
    candidate.message.length === 0 ||
    candidate.parentInvocationId !== identity.invocationId ||
    candidate.parentToolCallId !== identity.toolCallId ||
    typeof candidate.childInvocationId !== 'string' ||
    candidate.childInvocationId.length === 0
  ) {
    throw new AppState26ToolPipelinePersistenceErrorV1(
      'invalid_terminal_result',
      'Task resource admission failure did not match its exact parent attempt identity.',
    );
  }
  return Object.freeze({
    reason: candidate.reason as (typeof TASK_RESOURCE_ADMISSION_REASONS_V1)[number],
    message: candidate.message,
  });
}

function fileChangeEventV1(
  prepared: Readonly<PreparedToolInvocationV1> | undefined,
  result: Readonly<CapabilityToolTerminalResultV1<State26BuiltinOperationStructuredContentV1>>,
  value: Readonly<State26BuiltinOperationStructuredContentV1>,
  identity: Readonly<ToolPipelineAttemptAcknowledgementV1['attempt']>,
): Extract<State26RuntimeEventV1, { type: 'tool.file_change' }> | undefined {
  const mutationOperation =
    identity.operationId === 'builtin:write_file' || identity.operationId === 'builtin:edit_file';
  if (!mutationOperation || result.status !== 'success' || !value.ok) return undefined;
  const argumentsValue = prepared?.input.arguments;
  const path =
    isJsonRecordV1(argumentsValue) && typeof argumentsValue.path === 'string'
      ? argumentsValue.path
      : undefined;
  if (!prepared || !path || value.path !== path) {
    throw new AppState26ToolPipelinePersistenceErrorV1(
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

function providerActionRequiredEventV1(
  composition: CreateAppState26ToolPipelinePersistenceInputV1['providerAction'],
  prepared: Readonly<PreparedToolInvocationV1> | undefined,
  result: Readonly<CapabilityToolTerminalResultV1<State26BuiltinOperationStructuredContentV1>>,
  identity: Readonly<ToolPipelineAttemptAcknowledgementV1['attempt']>,
): Extract<State26RuntimeEventV1, { type: 'provider.action_required' }> | undefined {
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
    throw new AppState26ToolPipelinePersistenceErrorV1(
      'invalid_terminal_result',
      'Confirmed MCP provider action is missing its exact prepared provider identity.',
    );
  }
  const interactionId = composition.createInteractionId();
  if (!interactionId || interactionId.length > 512 || /\p{Cc}/u.test(interactionId)) {
    throw new AppState26ToolPipelinePersistenceErrorV1(
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

function resultMetaForToolEventV1(value: Readonly<State26BuiltinOperationStructuredContentV1>): {
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

function classifierAdviceForToolEventV1(
  value: Readonly<Record<string, RuntimeJsonValueV1>>,
): NonNullable<RuntimeHostToolExecutionResultV1['classifierAdviceV1']> {
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

function classifyToolFailureV1(
  result: Readonly<CapabilityToolTerminalResultV1<State26BuiltinOperationStructuredContentV1>>,
): State26ClassifiedFailureV1 {
  const code = result.failure?.code;
  const kind = code && runtimeHostState26IsFailureKindV1(code) ? code : 'unknown';
  return runtimeHostState26ClassifyFailureV1(
    kind,
    result.failure?.message ?? 'Builtin operation failed.',
  );
}

function isRejectedResultV1(
  result: Readonly<CapabilityToolTerminalResultV1<State26BuiltinOperationStructuredContentV1>>,
): boolean {
  return (
    result.failure?.code === 'rejected' ||
    result.failure?.code === 'policy_denied' ||
    result.failure?.code === 'approval_rejected'
  );
}

function assertTerminalStateV1(
  after: Readonly<State26RuntimeStateV1>,
  before: Readonly<State26RuntimeStateV1>,
  eventCount: number,
  identity: Readonly<ToolPipelineAttemptAcknowledgementV1['attempt']>,
  status: CapabilityToolTerminalResultV1['status'],
  artifact: ReturnType<CapabilityArtifactWriterV1['write']>,
  resultDigest: string,
  evidenceDigest: string,
  finishedAt: string,
  filesystemObservation?: Readonly<AuthenticatedFilesystemObservationV1>,
): void {
  const invocation = after.capabilities.invocations[identity.invocationId];
  const expectedStatus = status === 'success' ? 'succeeded' : 'failed';
  if (
    !includesAcknowledgedRevisionV1(after, before, eventCount) ||
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
      : !sameJsonV1(invocation.filesystemObservation, filesystemObservation))
  ) {
    throw new AppState26ToolPipelinePersistenceErrorV1(
      'acknowledgement_mismatch',
      'State26 terminal acknowledgement does not match the committed receipt.',
    );
  }
}

function assertSuspendedStateV1(
  after: Readonly<State26RuntimeStateV1>,
  before: Readonly<State26RuntimeStateV1>,
  eventCount: number,
  identity: Readonly<ToolPipelineAttemptAcknowledgementV1['attempt']>,
  artifact: ReturnType<CapabilityArtifactWriterV1['write']>,
  resultDigest: string,
  evidenceDigest: string,
  cancelledToolCallIds: readonly string[],
): void {
  const invocation = after.capabilities.invocations[identity.invocationId];
  if (
    !includesAcknowledgedRevisionV1(after, before, eventCount) ||
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
    throw new AppState26ToolPipelinePersistenceErrorV1(
      'acknowledgement_mismatch',
      'State26 suspension acknowledgement does not match the committed review receipt.',
    );
  }
}

/**
 * A Host effect may acknowledge independent sibling tool facts before this
 * caller resumes from its persistence await. The exact invocation/tool facts
 * below prove this batch; the global revision therefore has to include the
 * acknowledged batch, not equal it exclusively.
 */
function includesAcknowledgedRevisionV1(
  after: Readonly<State26RuntimeStateV1>,
  before: Readonly<State26RuntimeStateV1>,
  eventCount: number,
): boolean {
  return after.revision >= before.revision + eventCount;
}

async function persistExactV1(
  persist: (events: State26RuntimeEventV1[]) => Promise<boolean>,
  events: State26RuntimeEventV1[],
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
    throw new AppState26ToolPipelinePersistenceErrorV1(
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
    throw new AppState26ToolPipelinePersistenceErrorV1(
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

function state26TimestampV1(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) {
    throw new AppState26ToolPipelinePersistenceErrorV1('persistence_unavailable');
  }
  return value;
}

function boundedUnknownReasonV1(code: ToolPipelineUnknownOutcomeV1['code']): string {
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

function appState26ToolPipelinePersistenceMessageV1(
  code: AppState26ToolPipelinePersistenceErrorCodeV1,
): string {
  switch (code) {
    case 'invalid_prepared_request':
      return 'State26 Tool Pipeline prepared request facts are invalid.';
    case 'unsupported_operation':
      return 'State26 Tool Pipeline persistence does not own this operation family.';
    case 'attempt_identity_mismatch':
      return 'State26 Tool Pipeline attempt identity does not match prepared facts.';
    case 'invocation_collision':
      return 'State26 Tool Pipeline invocation identity collided with another Tool call.';
    case 'terminal_invocation':
      return 'A terminal State26 Tool invocation cannot start another attempt.';
    case 'subagent_lifecycle_pending':
      return 'A pending Subagent Provider lifecycle blocks another attempt.';
    case 'persistence_unavailable':
      return 'State26 Tool Pipeline persistence is unavailable.';
    case 'persistence_stale':
      return 'State26 Tool Pipeline persistence became stale before acknowledgement.';
    case 'acknowledgement_mismatch':
      return 'State26 Tool Pipeline acknowledgement does not match State26 state.';
    case 'filesystem_intent_invalid':
      return 'State26 filesystem intent does not match the acknowledged prepared attempt.';
    case 'filesystem_intent_commit_failed':
      return 'State26 filesystem intent could not be durably acknowledged.';
    case 'filesystem_mutation_ready_invalid':
      return 'State26 filesystem mutation ready evidence is invalid.';
    case 'filesystem_mutation_ready_commit_failed':
      return 'State26 filesystem mutation ready evidence could not be durably acknowledged.';
    case 'filesystem_edit_observation_invalid':
      return 'State26 filesystem edit observation query is invalid.';
    case 'invalid_terminal_result':
      return 'State26 Tool Pipeline terminal result is invalid.';
    case 'invalid_suspension_result':
      return 'State26 Tool Pipeline suspension result is invalid.';
    case 'artifact_write_failed':
      return 'Capability result Artifact could not be durably written.';
    case 'terminal_commit_failed':
      return 'State26 Tool Pipeline terminal receipt could not be committed.';
    case 'retryable_commit_failed':
      return 'State26 Tool Pipeline safe-read retry evidence could not be committed.';
    case 'suspension_commit_failed':
      return 'State26 Tool Pipeline suspension evidence could not be committed.';
  }
}

function isPreparedRequestV1(
  value: RuntimeJsonValueV1 | undefined,
): value is AppToolPipelinePreparedRequestV1 & RuntimeJsonValueV1 {
  if (!isJsonRecordV1(value)) return false;
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
    isPolicyEffectsV1(value.policyEffects) &&
    isCapabilityEffectsV1(value.effectiveEffects) &&
    isReceiptRequirementV1(value.receiptRequirement) &&
    isRetryEligibilityV1(value.retryEligibility) &&
    nullableStringV1(value.taskId) &&
    nullableStringV1(value.planId) &&
    nullableStringV1(value.planStepId) &&
    (value.capabilityRequestFacts === null || isRuntimeJsonV1(value.capabilityRequestFacts))
  );
}

function sameJsonV1(left: unknown, right: unknown): boolean {
  try {
    return digestCapabilityValueV1(left) === digestCapabilityValueV1(right);
  } catch {
    return false;
  }
}

function isPolicyEffectsV1(value: RuntimeJsonValueV1 | undefined): boolean {
  if (!isJsonRecordV1(value)) return false;
  const allowed = new Set(['network', 'externalRead', 'externalWrite', 'uncertainEffects']);
  return Object.entries(value).every(([key, item]) => allowed.has(key) && item === true);
}

function isCapabilityEffectsV1(
  value: RuntimeJsonValueV1 | undefined,
): value is CapabilityEffectsV1 & RuntimeJsonValueV1 {
  if (!isJsonRecordV1(value)) return false;
  return (
    effectLevelV1(value.filesystem) &&
    effectLevelV1(value.network) &&
    effectLevelV1(value.externalState)
  );
}

function effectLevelV1(value: RuntimeJsonValueV1 | undefined): boolean {
  return (
    value === 'none' ||
    value === 'read' ||
    value === 'write' ||
    value === 'destructive' ||
    value === 'unknown'
  );
}

function isReceiptRequirementV1(
  value: RuntimeJsonValueV1 | undefined,
): value is ToolPipelineReceiptRequirementV1 {
  return (
    value === 'observation_receipt' ||
    value === 'effect_receipt' ||
    value === 'control_receipt' ||
    value === 'not_applicable'
  );
}

function isRetryEligibilityV1(
  value: RuntimeJsonValueV1 | undefined,
): value is ToolPipelineRetryEligibilityV1 {
  return (
    value === 'none' || value === 'safe_read_candidate' || value === 'idempotency_key_candidate'
  );
}

function nullableStringV1(value: RuntimeJsonValueV1 | undefined): value is string | null {
  return value === null || typeof value === 'string';
}

function nonEmptyStringV1(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isJsonRecordV1(
  value: RuntimeJsonValueV1 | undefined,
): value is { readonly [key: string]: RuntimeJsonValueV1 } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isRuntimeJsonV1(value: unknown): value is RuntimeJsonValueV1 {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((entry) => isRuntimeJsonV1(entry));
  if (typeof value !== 'object') return false;
  return Object.values(value).every((entry) => isRuntimeJsonV1(entry));
}

function admitRuntimeEventsV1(
  events: readonly RuntimeJsonValueV1[] | undefined,
): State26RuntimeEventV1[] {
  if (events === undefined) return [];
  const admitted: State26RuntimeEventV1[] = [];
  for (const event of events) {
    let admittedEvent: State26RuntimeEventV1;
    try {
      admittedEvent = runtimeHostState26AdmitCurrentRuntimeEventV1(event);
    } catch {
      throw new AppState26ToolPipelinePersistenceErrorV1(
        'invalid_terminal_result',
        'Builtin runtimeEvents must be valid State26 JSON event objects.',
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
      throw new AppState26ToolPipelinePersistenceErrorV1(
        'invalid_terminal_result',
        'Builtin runtimeEvents cannot provide a second capability, Tool terminal, or file-change owner.',
      );
    }
    admitted.push(admittedEvent);
  }
  return admitted;
}
