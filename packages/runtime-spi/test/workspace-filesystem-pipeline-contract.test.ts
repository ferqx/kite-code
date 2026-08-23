import { describe, expect, test } from 'bun:test';
import type {
  CapabilityArtifactRef,
  FilesystemPreimageArtifactRef,
  WorkspaceFilesystemIntentRecord,
  WorkspaceFilesystemMutationReadyRecord,
  WorkspaceFilesystemObservationRecord,
} from '@kite/runtime-contract';
import type { RuntimeJsonValue } from '../src/capability';
import type {
  NonDynamicOperationId,
  NonDynamicPreparedToolInvocationIdentity,
  PreparedToolInvocation,
  ToolPipelineAttemptAcknowledgement,
  ToolRecordedAttemptIdentity,
} from '../src/tool-pipeline';
import {
  WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_,
  type WorkspaceFilesystemDurableEvidencePort,
  type WorkspaceFilesystemEditObservationPort,
  type WorkspaceFilesystemEditObservationQuery,
  type WorkspaceFilesystemEditObservationQueryResult,
  type WorkspaceFilesystemIntentDraft,
  type WorkspaceFilesystemMutationDurableEvidencePort,
  type WorkspaceFilesystemMutationIntentDraft,
  type WorkspaceFilesystemMutationPipelineOperation,
  type WorkspaceFilesystemMutationReadyDraft,
  type WorkspaceFilesystemPersistedIntent,
  type WorkspaceFilesystemPersistedMutationIntent,
  type WorkspaceFilesystemPersistedMutationReady,
  type WorkspaceFilesystemPreparedMutationEvidence,
  type WorkspaceFilesystemReadOperation,
  type WorkspaceFilesystemReadOperationId,
} from '../src/workspace-filesystem-pipeline';

const digest = (prefix: string): string => `${prefix}${'0'.repeat(64 - prefix.length)}`;

function operation(
  operationId: WorkspaceFilesystemReadOperationId,
): WorkspaceFilesystemReadOperation {
  if (operationId === 'builtin:read_file') {
    return {
      kind: 'read_file',
      operationId,
      path: './src/../src/index.ts',
      pathScope: 'workspace_only',
    };
  }
  if (operationId === 'builtin:search_files') {
    return {
      kind: 'search_files',
      operationId,
      path: 'src',
      pathScope: 'workspace_only',
      pattern: '*.ts',
    };
  }
  return {
    kind: 'search_content',
    operationId,
    path: 'src',
    pathScope: 'workspace_only',
    pattern: 'RuntimeJsonValue',
    glob: '*.ts',
  };
}

function preparedIdentity(
  operationId: WorkspaceFilesystemReadOperationId,
): NonDynamicPreparedToolInvocationIdentity {
  return {
    invocationId: 'invocation-1',
    attemptId: 'invocation-1:attempt:1',
    toolCallId: 'call-1',
    turnId: 'turn-1',
    modelMessageId: 'message-1',
    providerId: 'builtin-runtime',
    capabilityId: operationId,
    capabilityRevision: 'capability-revision-1',
    descriptorRevision: 'descriptor-revision-1',
    parserRevision: 'parser-revision-1',
    executorRevision: 'executor-revision-1',
    argumentsDigest: digest('a'),
    schemaDigest: digest('s'),
    effectiveEffectsDigest: digest('e'),
    policyDigest: digest('p'),
    authorizationDigest: digest('u'),
    admissionDigest: digest('m'),
    idempotencyKeyArgument: null,
    idempotencyKey: null,
    bindingId: null,
    argumentOrigin: 'model_public',
    executionFamily: 'builtin',
    executionMechanism: 'filesystem',
    operationId: operationId as NonDynamicOperationId,
    visibility: 'model',
    modelVisible: true,
    exposedToolName: operationId.slice('builtin:'.length),
    isDynamicMcp: false,
    builtinProjectionRevision: 'builtin-projection-1',
    dynamicCatalogRevision: null,
    nestedCapabilityId: null,
    nestedCapabilityRevision: null,
    nestedCatalogRevision: null,
    toolKind: 'computer',
  };
}

function prepared(operationId: WorkspaceFilesystemReadOperationId): PreparedToolInvocation {
  const selected = operation(operationId);
  return {
    identity: preparedIdentity(operationId),
    input: {
      invocationId: 'invocation-1',
      attemptId: 'invocation-1:attempt:1',
      toolCallId: 'call-1',
      arguments: { path: selected.path },
      binding: null,
    },
  };
}

function acknowledgement(
  operationId: WorkspaceFilesystemReadOperationId,
): ToolPipelineAttemptAcknowledgement {
  const identity = preparedIdentity(operationId);
  return {
    acknowledged: true,
    attempt: {
      invocationId: identity.invocationId,
      attemptId: identity.attemptId,
      attempt: 1,
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
      dynamicCatalogRevision: null,
      runtimeWrapperProviderId: null,
      runtimeWrapperCapabilityRevision: null,
      runtimeWrapperExecutorRevision: null,
      runtimeWrapperSchemaDigest: null,
      runtimeWrapperBuiltinProjectionRevision: null,
      policyDigest: identity.policyDigest,
      authorizationDigest: identity.authorizationDigest,
      admissionDigest: identity.admissionDigest,
      idempotencyKey: null,
      recordedAt: '2026-08-22T00:00:00.000Z',
      startedAt: '2026-08-22T00:00:00.000Z',
    } satisfies ToolRecordedAttemptIdentity,
  };
}

function intentRecord() {
  return {
    attempt: 1,
    capabilityRevision: 'capability-revision-1',
    argumentsDigest: digest('a'),
    admissionDigest: digest('m'),
    operationDigest: `sha256:${'1'.repeat(64)}`,
    searchBoundaryDigest: `sha256:${'2'.repeat(64)}`,
    lexicalTargetDigest: `sha256:${'3'.repeat(64)}`,
    canonicalWorkspaceDigest: `sha256:${'4'.repeat(64)}`,
    protectedPathRevision: 'protected-path-revision-1',
    approvalSummaryDigest: `sha256:${'5'.repeat(64)}`,
    effectiveEffectsDigest: digest('e'),
    intentDigest: `sha256:${'6'.repeat(64)}`,
    recordedAt: '2026-08-22T00:00:00.000Z',
  };
}

function persistedIntent(
  operationId: WorkspaceFilesystemReadOperationId,
): WorkspaceFilesystemPersistedIntent {
  return {
    schema: WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_,
    status: 'durably_persisted',
    prepared: prepared(operationId),
    acknowledgement: acknowledgement(operationId),
    operation: operation(operationId),
    record: intentRecord(),
  };
}

describe('runtime SPI Workspace filesystem durable evidence contract', () => {
  test('keeps the read tranche closed and preserves raw lexical path bytes', () => {
    const read = operation('builtin:read_file');
    expect(read.path).toBe('./src/../src/index.ts');

    const invalidOperation: WorkspaceFilesystemReadOperation = {
      // @ts-expect-error mutations cannot enter the read-only evidence seam.
      kind: 'write_file',
      // @ts-expect-error mutation operation ids are excluded.
      operationId: 'builtin:write_file',
      path: 'src/index.ts',
      pathScope: 'workspace_only',
      content: 'forbidden',
    };
    void invalidOperation;
  });

  test('does not let Builtin supply its own attempt acknowledgement', async () => {
    const exactPrepared = prepared('builtin:read_file');
    const draft: WorkspaceFilesystemIntentDraft = {
      schema: WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_,
      prepared: exactPrepared,
      operation: operation('builtin:read_file'),
      record: intentRecord(),
    };
    expect(draft).not.toHaveProperty('acknowledgement');

    const issued = new WeakSet<object>();
    const port: WorkspaceFilesystemDurableEvidencePort = {
      persistIntent: async (candidate) => {
        const persisted = {
          schema: WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_,
          status: 'durably_persisted' as const,
          prepared: candidate.prepared,
          acknowledgement: acknowledgement('builtin:read_file'),
          operation: candidate.operation,
          record: candidate.record,
        };
        issued.add(persisted);
        return persisted;
      },
      verifyPersistedIntent: (candidate) =>
        issued.has(candidate) ? { valid: true } : { valid: false, code: 'intent_not_issued' },
    };
    const persisted = await port.persistIntent(draft);
    expect(persisted.prepared).toBe(exactPrepared);
    expect(persisted.acknowledgement.attempt.providerId).toBe('builtin-runtime');
    expect(persisted.acknowledgement.attempt.argumentOrigin).toBe('model_public');
    expect(persisted.acknowledgement.attempt.builtinProjectionRevision).toBe(
      'builtin-projection-1',
    );
    expect(port.verifyPersistedIntent(persisted)).toEqual({ valid: true });
  });

  test('rejects a structurally identical persisted-intent clone', () => {
    const authentic = persistedIntent('builtin:read_file');
    const issued = new WeakSet<object>([authentic]);
    const verify: WorkspaceFilesystemDurableEvidencePort['verifyPersistedIntent'] = (value) =>
      issued.has(value) ? { valid: true } : { valid: false, code: 'intent_not_issued' };
    const clone = structuredClone(authentic);
    expect(clone).toEqual(authentic);
    expect(verify(authentic)).toEqual({ valid: true });
    expect(verify(clone)).toEqual({ valid: false, code: 'intent_not_issued' });
  });

  test('requires persistence uncertainty to throw before any Provider call', async () => {
    let providerCalls = 0;
    const run = async (port: WorkspaceFilesystemDurableEvidencePort): Promise<void> => {
      const persisted = await port.persistIntent({
        schema: WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_,
        prepared: prepared('builtin:read_file'),
        operation: operation('builtin:read_file'),
        record: intentRecord(),
      });
      if (!port.verifyPersistedIntent(persisted).valid) throw new Error('invalid intent');
      providerCalls += 1;
    };
    const failingPort: WorkspaceFilesystemDurableEvidencePort = {
      persistIntent: async () => {
        throw new Error('State intent acknowledgement is uncertain');
      },
      verifyPersistedIntent: () => ({ valid: false, code: 'intent_not_issued' }),
    };
    await expect(run(failingPort)).rejects.toThrow();
    expect(providerCalls).toBe(0);
  });

  test('keeps the process-local contract package-neutral and non-serializable as authority', async () => {
    const source = await Bun.file(
      new URL('../src/workspace-filesystem-pipeline.ts', import.meta.url),
    ).text();
    expect(source).not.toMatch(/from\s+['"]node:/u);
    expect(source).not.toMatch(/from\s+['"]@kite\/(?!runtime-contract)/u);
    expect(source).not.toMatch(/\b(?:RuntimeHost|RuntimeStore|BuiltinRuntime|AgentState)\b/u);
    expect(JSON.parse(JSON.stringify(persistedIntent('builtin:search_files')))).toEqual(
      persistedIntent('builtin:search_files'),
    );
  });
});

function mutationOperation(
  operationId: 'builtin:write_file' | 'builtin:edit_file',
): WorkspaceFilesystemMutationPipelineOperation {
  if (operationId === 'builtin:write_file') {
    return {
      kind: 'write_file',
      operationId,
      path: './src/index.ts',
      pathScope: 'workspace_only',
      content: 'after\n',
    };
  }
  return {
    kind: 'edit_file',
    operationId,
    path: './src/index.ts',
    pathScope: 'workspace_only',
    oldString: 'before',
    newString: 'after',
    replaceAll: false,
  };
}

function mutationPrepared(
  operationId: 'builtin:write_file' | 'builtin:edit_file',
): PreparedToolInvocation {
  const base = preparedIdentity('builtin:read_file');
  const argumentsDigest = digest(operationId === 'builtin:write_file' ? 'w' : 'd');
  return {
    identity: {
      ...base,
      capabilityId: operationId,
      operationId: operationId as NonDynamicOperationId,
      exposedToolName: operationId.slice('builtin:'.length),
      argumentsDigest,
    },
    input: {
      invocationId: 'invocation-1',
      attemptId: 'invocation-1:attempt:1',
      toolCallId: 'call-1',
      arguments:
        operationId === 'builtin:write_file'
          ? { path: './src/index.ts', content: 'after\n' }
          : {
              path: './src/index.ts',
              oldString: 'before',
              newString: 'after',
              replaceAll: false,
            },
      binding: null,
    },
  };
}

function mutationAcknowledgement(
  operationId: 'builtin:write_file' | 'builtin:edit_file',
): ToolPipelineAttemptAcknowledgement {
  const base = acknowledgement('builtin:read_file');
  return {
    acknowledged: true,
    attempt: {
      ...base.attempt,
      operationId,
      capabilityId: operationId,
      argumentsDigest: digest(operationId === 'builtin:write_file' ? 'w' : 'd'),
      effectiveEffectsDigest: digest('e'),
    },
  };
}

function mutationIntentRecord(
  operationId: 'builtin:write_file' | 'builtin:edit_file',
): WorkspaceFilesystemIntentRecord {
  return {
    ...intentRecord(),
    operationDigest: `sha256:${operationId === 'builtin:write_file' ? '7' : '8'}${'0'.repeat(63)}`,
  };
}

function preparedEvidence(
  operationId: 'builtin:write_file' | 'builtin:edit_file',
): WorkspaceFilesystemPreparedMutationEvidence {
  const preimageExisted = operationId === 'builtin:edit_file';
  return {
    schema: WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_,
    operationKind: operationId.slice('builtin:'.length) as 'write_file' | 'edit_file',
    operationDigest: mutationIntentRecord(operationId).operationDigest,
    lexicalTargetDigest: `sha256:${'3'.repeat(64)}`,
    canonicalTargetDigest: `sha256:${'4'.repeat(64)}`,
    targetIdentityDigest: `sha256:${'5'.repeat(64)}`,
    preimageDigest: preimageExisted ? `sha256:${'9'.repeat(64)}` : null,
    preimageExisted,
    preimageByteLength: preimageExisted ? 7 : 0,
  };
}

function artifactRef(): FilesystemPreimageArtifactRef {
  return {
    artifactId: 'artifact-1',
    kind: 'filesystem_preimage',
    integrityIdentifier: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    byteLength: 7,
  };
}

function mutationReadyRecord(
  operationId: 'builtin:write_file' | 'builtin:edit_file',
  artifact: FilesystemPreimageArtifactRef,
): WorkspaceFilesystemMutationReadyRecord {
  const prepared = preparedEvidence(operationId);
  return {
    attempt: 1,
    intentDigest: mutationIntentRecord(operationId).intentDigest,
    operationDigest: prepared.operationDigest,
    targetIdentityDigest: prepared.targetIdentityDigest,
    preimageDigest: prepared.preimageDigest,
    preimageArtifact: artifact,
    readyDigest: `sha256:${'b'.repeat(64)}`,
    readyAt: '2026-08-22T00:00:00.000Z',
  };
}

function persistedMutationIntent(
  operationId: 'builtin:write_file' | 'builtin:edit_file',
): WorkspaceFilesystemPersistedMutationIntent {
  return {
    schema: WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_,
    status: 'durably_persisted',
    prepared: mutationPrepared(operationId),
    acknowledgement: mutationAcknowledgement(operationId),
    operation: mutationOperation(operationId),
    record: mutationIntentRecord(operationId),
  };
}

function editObservationQuery(): WorkspaceFilesystemEditObservationQuery {
  return {
    schema: WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_,
    actorIdentityDigest: `sha256:${'c'.repeat(64)}`,
    lexicalTargetDigest: `sha256:${'3'.repeat(64)}`,
  };
}

function readObservation(): WorkspaceFilesystemObservationRecord {
  return {
    actorIdentityDigest: editObservationQuery().actorIdentityDigest,
    lexicalTargetDigest: editObservationQuery().lexicalTargetDigest,
    canonicalTargetDigest: `sha256:${'4'.repeat(64)}`,
    targetIdentityDigest: `sha256:${'5'.repeat(64)}`,
    contentDigest: `sha256:${'9'.repeat(64)}`,
  };
}

describe('runtime SPI Workspace filesystem mutation evidence contract', () => {
  test('keeps write/edit closed and does not widen the read operation union', () => {
    const write: WorkspaceFilesystemMutationPipelineOperation =
      mutationOperation('builtin:write_file');
    const edit: WorkspaceFilesystemMutationPipelineOperation =
      mutationOperation('builtin:edit_file');
    expect(write.operationId).toBe('builtin:write_file');
    expect(edit.operationId).toBe('builtin:edit_file');
    // @ts-expect-error write is intentionally excluded from the read evidence port.
    const readOnly: WorkspaceFilesystemReadOperation = write;
    void readOnly;
  });

  test('requires the exact prepared attempt acknowledgement for mutation intent', async () => {
    const candidate: WorkspaceFilesystemMutationIntentDraft = {
      schema: WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_,
      prepared: mutationPrepared('builtin:write_file'),
      operation: mutationOperation('builtin:write_file'),
      record: mutationIntentRecord('builtin:write_file'),
    };
    expect(candidate).not.toHaveProperty('acknowledgement');
    const issued = new WeakSet<object>();
    const port: WorkspaceFilesystemMutationDurableEvidencePort = {
      persistIntent: async <
        TArguments extends RuntimeJsonValue = RuntimeJsonValue,
        TRequest extends RuntimeJsonValue = RuntimeJsonValue,
      >(
        draft: Readonly<WorkspaceFilesystemMutationIntentDraft<TArguments, TRequest>>,
      ): Promise<Readonly<WorkspaceFilesystemPersistedMutationIntent<TArguments, TRequest>>> => {
        const persisted: WorkspaceFilesystemPersistedMutationIntent<TArguments, TRequest> = {
          schema: WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_,
          status: 'durably_persisted' as const,
          prepared: draft.prepared,
          acknowledgement: mutationAcknowledgement('builtin:write_file'),
          operation: draft.operation,
          record: draft.record,
        };
        issued.add(persisted);
        return persisted;
      },
      verifyPersistedIntent: (value) =>
        issued.has(value) ? { valid: true } : { valid: false, code: 'intent_not_issued' },
      persistMutationReady: async () => {
        throw new Error('ready not part of this test');
      },
      verifyPersistedMutationReady: () => ({ valid: false, code: 'ready_not_issued' }),
    };
    const persisted = await port.persistIntent(candidate);
    expect(persisted.acknowledgement.attempt.operationId).toBe('builtin:write_file');
    expect(port.verifyPersistedIntent(persisted)).toEqual({ valid: true });
    expect(port.verifyPersistedIntent(structuredClone(persisted))).toEqual({
      valid: false,
      code: 'intent_not_issued',
    });
  });

  test('ready persistence carries only artifact/ref evidence, never provider preimage content', async () => {
    const intent = persistedMutationIntent('builtin:edit_file');
    const artifact = artifactRef();
    const prepared = preparedEvidence('builtin:edit_file');
    const record = mutationReadyRecord('builtin:edit_file', artifact);
    const issued = new WeakSet<object>();
    const readyPort: WorkspaceFilesystemMutationDurableEvidencePort = {
      persistIntent: async <
        TArguments extends RuntimeJsonValue = RuntimeJsonValue,
        TRequest extends RuntimeJsonValue = RuntimeJsonValue,
      >(
        draft: Readonly<WorkspaceFilesystemMutationIntentDraft<TArguments, TRequest>>,
      ): Promise<Readonly<WorkspaceFilesystemPersistedMutationIntent<TArguments, TRequest>>> => ({
        schema: WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_,
        status: 'durably_persisted',
        prepared: draft.prepared,
        acknowledgement: intent.acknowledgement,
        operation: draft.operation,
        record: draft.record,
      }),
      verifyPersistedIntent: () => ({ valid: true }),
      persistMutationReady: async (draft) => {
        const persisted = {
          schema: WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_,
          status: 'durably_persisted' as const,
          intent: draft.intent,
          preimageArtifact: draft.preimageArtifact,
          record: draft.record,
        } satisfies WorkspaceFilesystemPersistedMutationReady;
        issued.add(persisted);
        expect(draft.preparedEvidence).toBe(prepared);
        return persisted;
      },
      verifyPersistedMutationReady: (value) =>
        issued.has(value) ? { valid: true } : { valid: false, code: 'ready_not_issued' },
    };
    const draft: WorkspaceFilesystemMutationReadyDraft = {
      schema: WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_,
      intent,
      preparedEvidence: prepared,
      preimageArtifact: artifact,
      record,
    };
    const persisted = await readyPort.persistMutationReady(draft);
    expect(persisted).not.toHaveProperty('preparedEvidence');
    expect(persisted).not.toHaveProperty('target');
    expect(persisted).not.toHaveProperty('preimage');
    expect(persisted.preimageArtifact).toBe(artifact);
    expect(persisted.record.preimageArtifact).toBe(artifact);
    expect(readyPort.verifyPersistedMutationReady(persisted)).toEqual({ valid: true });
    expect(readyPort.verifyPersistedMutationReady(structuredClone(persisted))).toEqual({
      valid: false,
      code: 'ready_not_issued',
    });
  });

  test('edit query returns only the latest authentic record or read_required', async () => {
    const query = editObservationQuery();
    const issued = new WeakSet<object>();
    const found: WorkspaceFilesystemEditObservationQueryResult = {
      status: 'found',
      query,
      invocationId: 'read-invocation-1',
      attempt: 1,
      capabilityRevision: 'read-revision-1',
      resultDigest: `sha256:${'d'.repeat(64)}`,
      evidenceDigest: `sha256:${'e'.repeat(64)}`,
      artifact: {
        artifactId: 'capability-artifact-1',
        kind: 'capability_result',
        integrityIdentifier: `sha256:${'1'.repeat(64)}`,
        byteLength: 1,
      } satisfies CapabilityArtifactRef,
      observation: readObservation(),
    };
    // @ts-expect-error authentic found results must carry the runtime-contract Capability Artifact ref.
    const foundWithoutArtifact: WorkspaceFilesystemEditObservationQueryResult = {
      status: 'found',
      query,
      invocationId: 'read-invocation-1',
      attempt: 1,
      capabilityRevision: 'read-revision-1',
      resultDigest: `sha256:${'d'.repeat(64)}`,
      evidenceDigest: `sha256:${'e'.repeat(64)}`,
      observation: readObservation(),
    };
    void foundWithoutArtifact;
    issued.add(found);
    const port: WorkspaceFilesystemEditObservationPort = {
      findLatestAuthenticRead: async () => found,
      verifyLatestAuthenticRead: (value) =>
        issued.has(value) ? { valid: true } : { valid: false, code: 'query_result_not_issued' },
    };
    const result = await port.findLatestAuthenticRead(query);
    expect(result.status).toBe('found');
    expect(port.verifyLatestAuthenticRead(result)).toEqual({ valid: true });
    expect(port.verifyLatestAuthenticRead(structuredClone(result))).toEqual({
      valid: false,
      code: 'query_result_not_issued',
    });
    const missing: WorkspaceFilesystemEditObservationQueryResult = {
      status: 'missing',
      code: 'read_required',
      query,
    };
    expect(missing.code).toBe('read_required');
    const appClassifiedStale: WorkspaceFilesystemEditObservationQueryResult = {
      // @ts-expect-error App only returns latest authentic read or read_required; Builtin owns stale classification.
      status: 'stale',
      // @ts-expect-error Stale classification is not an App query result.
      code: 'stale_read',
      query,
      observation: readObservation(),
    };
    void appClassifiedStale;
    expect(result.status === 'found' && result.observation.contentDigest).not.toBe(
      `sha256:${'f'.repeat(64)}`,
    );
  });

  test('keeps mutation source neutral and excludes Store, State, and package implementations', async () => {
    const source = await Bun.file(
      new URL('../src/workspace-filesystem-pipeline.ts', import.meta.url),
    ).text();
    expect(source).not.toMatch(/from\s+['"]node:/u);
    expect(source).not.toMatch(/from\s+['"]@kite\/(?!runtime-contract)/u);
    expect(source).not.toMatch(
      /\b(?:RuntimeHost|RuntimeStore|BuiltinRuntime|AgentState|WorkspaceFilesystemPreparedMutation|PreimageArtifactPort)\b/u,
    );
    expect(JSON.parse(JSON.stringify(persistedMutationIntent('builtin:write_file')))).toEqual(
      persistedMutationIntent('builtin:write_file'),
    );
  });
});
