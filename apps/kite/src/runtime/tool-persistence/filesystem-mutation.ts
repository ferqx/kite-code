import { digestCapabilityValue } from '@kite/builtin-runtime/capability';
import type {
  PreparedToolInvocation,
  RuntimeJsonValue,
  ToolPipelineAttemptAcknowledgement,
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
import { assertAcknowledgementState, assertOpenAcknowledgement } from './acknowledgement-validator';
import {
  AppStateToolPipelinePersistenceError,
  type CreateAppStateToolPipelinePersistenceInput,
} from './contracts';
import { latestFilesystemObservationInvocation } from './filesystem-evidence';
import { isPreparedRequest } from './prepared-request-validator';
import { includesAcknowledgedRevision, persistExact } from './recovery-committer';

export function createFilesystemMutationPersistence(composition: {
  readonly input: Readonly<CreateAppStateToolPipelinePersistenceInput>;
  readonly acknowledgementsByPrepared: WeakMap<
    object,
    Readonly<ToolPipelineAttemptAcknowledgement>
  >;
  readonly issuedAcknowledgements: WeakSet<object>;
  readonly settledAcknowledgements: WeakSet<object>;
}) {
  const { input, acknowledgementsByPrepared, issuedAcknowledgements, settledAcknowledgements } =
    composition;
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

  return Object.freeze({
    persistIntent: persistFilesystemIntent,
    verifyPersistedIntent: verifyPersistedFilesystemIntent,
    persistMutationIntent: persistFilesystemMutationIntent,
    verifyPersistedMutationIntent: verifyPersistedFilesystemMutationIntent,
    persistMutationReady: persistFilesystemMutationReady,
    verifyPersistedMutationReady: verifyPersistedFilesystemMutationReady,
    findLatestAuthenticRead: findLatestFilesystemEditObservation,
    verifyLatestAuthenticRead: verifyLatestFilesystemEditObservation,
  });
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
    preparedRequest?.policyEffects.externalWrite === true &&
    (preparedRequest.grantUsed !== 'none' || preparedRequest.interactionMode === 'full');
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
