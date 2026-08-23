import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type BuiltinOperationExecutionValue,
  CapabilityArtifactStore,
  type CreateBuiltinWorkspaceFilesystemMutationDispatcherInput,
  capabilityResultDigest,
  capabilityResultEvidenceDigest,
  createBuiltinPreparedToolDispatchAdapter,
  createBuiltinRuntimeModules,
  createBuiltinToolCatalogProjection,
  createBuiltinToolPipelineCallbacks,
  digestCapabilityBindingValue,
} from '@kite/builtin-runtime';
import {
  BuiltinWorkspaceFilesystemMutationCommitUnknownError,
  type BuiltinWorkspaceFilesystemRuntime,
  createBuiltinWorkspaceFilesystemMutationDispatcher,
  FilesystemPreimageArtifactStore,
  LocalWorkspaceFilesystemProvider,
  WorkspaceFilesystemGrantAuthority,
} from '@kite/builtin-runtime/filesystem';
import { createProtectedPathEvaluator } from '@kite/builtin-runtime/sandbox';
import type {
  CapabilityArtifactRef,
  CapabilityResult,
  WorkspaceFilesystemObservationRecord,
} from '@kite/runtime-contract';
import type {
  CapabilityToolKind,
  ExecutionReceipt,
  NonDynamicOperationId,
  PreparedToolInvocation,
  RuntimeJsonValue,
  ToolPipelineAttemptAcknowledgement,
  ToolPipelineResolutionContext,
  WorkspaceFilesystemEditObservationPort,
  WorkspaceFilesystemEditObservationQueryResult,
  WorkspaceFilesystemMutationDurableEvidencePort,
  WorkspaceFilesystemMutationIntentDraft,
  WorkspaceFilesystemMutationOperation,
  WorkspaceFilesystemPersistedMutationIntent,
  WorkspaceFilesystemPersistedMutationReady,
  WorkspaceFilesystemProvider,
} from '@kite/runtime-spi';
import { createRuntimeModuleRegistry } from '@kite/runtime-spi';

const FIXED_NOW = new Date('2026-08-22T00:00:00.000Z');

type MutationName = 'write_file' | 'edit_file';
type DurableMode =
  | 'valid'
  | 'intent_throw'
  | 'intent_invalid'
  | 'intent_clone'
  | 'ready_throw'
  | 'ready_invalid'
  | 'ready_clone';
type EditMode = 'valid' | 'missing' | 'stale' | 'artifact_invalid' | 'clone';

function freezeDeep<Value>(value: Value, seen = new WeakSet<object>()): Value {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && 'value' in descriptor) freezeDeep(descriptor.value, seen);
  }
  return Object.freeze(value);
}

function mutationPreparedFixture(name: MutationName, workspace: string) {
  const args =
    name === 'write_file'
      ? { path: './notes.txt', content: 'after\n' }
      : { path: './notes.txt', old_string: 'before', new_string: 'after', replace_all: false };
  const registry = createRuntimeModuleRegistry(createBuiltinRuntimeModules());
  const projection = createBuiltinToolCatalogProjection(registry.snapshot(), {
    turnContext: { workspace },
  });
  const callbacks = createBuiltinToolPipelineCallbacks(projection);
  const context: ToolPipelineResolutionContext = {
    currentTurnId: 'turn-mutation',
    availabilityContext: { workspace },
    bindings: [],
    descriptors: [],
    disclosures: [],
    builtinProjectionRevision: projection.revision,
    dynamicCatalogRevision: 'd'.repeat(64),
  };
  const resolved = callbacks.resolve(
    {
      schema: 'kite.tool-pipeline-stage.v1',
      stage: 'snapshot',
      toolCallId: `call-${name}`,
      name,
      rawArguments: args as unknown as RuntimeJsonValue,
      argumentOrigin: 'model_public',
      createdAtTurnId: 'turn-mutation',
      modelMessageId: 'message-mutation',
      bindingId: null,
      capabilityId: null,
      capabilityRevision: null,
    },
    context,
  );
  if (!resolved.ok) throw new Error(resolved.failure.code);
  const validated = callbacks.validate(resolved.value);
  if (!validated.ok) throw new Error(validated.failure.code);
  const classified = callbacks.classify(validated.value);
  if (!classified.ok) throw new Error(classified.failure.code);
  const entry = projection.entries.find(
    (candidate) => candidate.visibility === 'model' && candidate.name === name,
  );
  if (entry?.visibility !== 'model') throw new Error(`${name} entry missing`);
  const invocationId = `invocation-${name}`;
  const identity = {
    invocationId,
    attemptId: `${invocationId}:attempt:1`,
    toolCallId: resolved.value.call.toolCallId,
    turnId: resolved.value.call.createdAtTurnId,
    modelMessageId: resolved.value.call.modelMessageId,
    argumentOrigin: resolved.value.call.argumentOrigin,
    providerId: entry.providerId,
    operationId: entry.operationId as NonDynamicOperationId,
    executionFamily: 'builtin' as const,
    executionMechanism: entry.executionMechanism,
    capabilityId: entry.capabilityId,
    capabilityRevision: entry.revision,
    descriptorRevision: entry.descriptor.revision,
    parserRevision: entry.parser.parserRevision,
    executorRevision: entry.executorRevision,
    argumentsDigest: validated.value.request.argumentsDigest,
    schemaDigest: validated.value.request.schemaDigest,
    effectiveEffectsDigest: classified.value.effectiveEffectsDigest,
    policyDigest: digestCapabilityBindingValue({ name, kind: 'policy' }),
    authorizationDigest: digestCapabilityBindingValue({ name, kind: 'authorization' }),
    admissionDigest: digestCapabilityBindingValue({ name, kind: 'admission' }),
    idempotencyKeyArgument: null,
    idempotencyKey: null,
    bindingId: null,
    visibility: 'model' as const,
    modelVisible: true as const,
    exposedToolName: entry.name,
    builtinProjectionRevision: projection.revision,
    dynamicCatalogRevision: null,
    nestedCapabilityId: null,
    nestedCapabilityRevision: null,
    nestedCatalogRevision: null,
    isDynamicMcp: false as const,
    toolKind: entry.kind as CapabilityToolKind,
  };
  const prepared = freezeDeep({
    identity,
    input: {
      invocationId,
      attemptId: identity.attemptId,
      toolCallId: identity.toolCallId,
      arguments: validated.value.request.arguments,
      facts: validated.value.domainData,
      binding: null,
    },
  }) satisfies Readonly<PreparedToolInvocation>;
  expect(callbacks.verifyPreparedIdentity(prepared)).toEqual({ valid: true });
  return { workspace, projection, callbacks, prepared, operation: args };
}

function acknowledgement(
  prepared: Readonly<PreparedToolInvocation>,
): Readonly<ToolPipelineAttemptAcknowledgement> {
  const identity = prepared.identity;
  return freezeDeep({
    acknowledged: true as const,
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
      dynamicCatalogRevision: identity.dynamicCatalogRevision,
      runtimeWrapperProviderId: null,
      runtimeWrapperCapabilityRevision: null,
      runtimeWrapperExecutorRevision: null,
      runtimeWrapperSchemaDigest: null,
      runtimeWrapperBuiltinProjectionRevision: null,
      policyDigest: identity.policyDigest,
      authorizationDigest: identity.authorizationDigest,
      admissionDigest: identity.admissionDigest,
      idempotencyKey: identity.idempotencyKey,
      recordedAt: FIXED_NOW.toISOString(),
      startedAt: FIXED_NOW.toISOString(),
    },
  });
}

function mutationOperation(name: MutationName): WorkspaceFilesystemMutationOperation {
  return name === 'write_file'
    ? {
        kind: 'write_file',
        path: './notes.txt',
        pathScope: 'workspace_only',
        content: 'after\n',
      }
    : {
        kind: 'edit_file',
        path: './notes.txt',
        pathScope: 'workspace_only',
        oldString: 'before',
        newString: 'after',
        replaceAll: false,
      };
}

function mutationDurable(
  prepared: Readonly<PreparedToolInvocation>,
  mode: DurableMode,
): WorkspaceFilesystemMutationDurableEvidencePort & {
  readonly intentCalls: number;
  readonly readyCalls: number;
  readonly lastIntent?: Readonly<WorkspaceFilesystemPersistedMutationIntent>;
  readonly lastReady?: Readonly<WorkspaceFilesystemPersistedMutationReady>;
} {
  let intentCalls = 0;
  let readyCalls = 0;
  let lastIntent: Readonly<WorkspaceFilesystemPersistedMutationIntent> | undefined;
  let lastReady: Readonly<WorkspaceFilesystemPersistedMutationReady> | undefined;
  const issuedIntents = new WeakSet<object>();
  const issuedReady = new WeakSet<object>();
  return {
    get intentCalls() {
      return intentCalls;
    },
    get readyCalls() {
      return readyCalls;
    },
    get lastIntent() {
      return lastIntent;
    },
    get lastReady() {
      return lastReady;
    },
    persistIntent: async <
      TArguments extends RuntimeJsonValue = RuntimeJsonValue,
      TRequest extends RuntimeJsonValue = RuntimeJsonValue,
    >(
      draft: Readonly<WorkspaceFilesystemMutationIntentDraft<TArguments, TRequest>>,
    ): Promise<Readonly<WorkspaceFilesystemPersistedMutationIntent<TArguments, TRequest>>> => {
      intentCalls += 1;
      if (mode === 'intent_throw') throw new Error('intent uncertainty');
      const operation =
        mode === 'intent_clone' ? freezeDeep(structuredClone(draft.operation)) : draft.operation;
      const record =
        mode === 'intent_clone' ? freezeDeep(structuredClone(draft.record)) : draft.record;
      const persisted = freezeDeep({
        schema: 'kite.workspace-filesystem-pipeline.v1' as const,
        status: 'durably_persisted' as const,
        prepared: draft.prepared,
        acknowledgement: acknowledgement(prepared),
        operation,
        record,
      });
      issuedIntents.add(persisted);
      lastIntent = persisted;
      return persisted;
    },
    verifyPersistedIntent: (value) =>
      mode !== 'intent_invalid' && mode !== 'intent_clone' && issuedIntents.has(value)
        ? { valid: true as const }
        : { valid: false as const, code: 'intent_not_issued' as const },
    persistMutationReady: async (draft) => {
      readyCalls += 1;
      if (mode === 'ready_throw') throw new Error('ready uncertainty');
      const persisted = freezeDeep({
        schema: 'kite.workspace-filesystem-pipeline.v1' as const,
        status: 'durably_persisted' as const,
        intent: draft.intent,
        preimageArtifact: draft.preimageArtifact,
        record: mode === 'ready_clone' ? freezeDeep(structuredClone(draft.record)) : draft.record,
      });
      issuedReady.add(persisted);
      lastReady = persisted;
      return persisted;
    },
    verifyPersistedMutationReady: (value) =>
      mode !== 'ready_invalid' && mode !== 'ready_clone' && issuedReady.has(value)
        ? { valid: true as const }
        : { valid: false as const, code: 'ready_not_issued' as const },
  };
}

interface FixtureOptions {
  readonly durableMode?: DurableMode;
  readonly editMode?: EditMode;
  readonly preimageFailure?: boolean;
  readonly commitThrow?: boolean;
  readonly checkpointThrow?: boolean;
}

function fixture(name: MutationName, options: FixtureOptions = {}) {
  const workspace = mkdtempSync(join(tmpdir(), 'kite-builtin-mutation-'));
  if (name === 'edit_file') writeFileSync(join(workspace, 'notes.txt'), 'before\n');
  const prepared = mutationPreparedFixture(name, workspace);
  const grants = new WorkspaceFilesystemGrantAuthority({
    now: () => FIXED_NOW.getTime(),
    idSource: (() => {
      let id = 0;
      return () => `mutation-grant-${++id}`;
    })(),
  });
  const local = new LocalWorkspaceFilesystemProvider(grants.verifier());
  const artifactWorkspace = mkdtempSync(join(tmpdir(), 'kite-builtin-artifacts-'));
  const preimageRoot = join(artifactWorkspace, 'filesystem-preimages');
  const capabilityRoot = join(artifactWorkspace, 'capability-artifacts');
  const preimageStore = new FilesystemPreimageArtifactStore({
    root: preimageRoot,
  });
  const capabilityStore = new CapabilityArtifactStore({
    root: capabilityRoot,
  });
  const protectedPathEvaluator = createProtectedPathEvaluator({
    workspaceRoot: workspace,
    mode: 'deny',
  });
  let prepareCalls = 0;
  let commitCalls = 0;
  let preimageProjectionCalls = 0;
  let postimageProjectionCalls = 0;
  let priorObservation:
    | {
        readonly observation: Readonly<WorkspaceFilesystemObservationRecord>;
        readonly artifact: Readonly<CapabilityArtifactRef>;
        readonly resultDigest: string;
        readonly evidenceDigest: string;
      }
    | undefined;
  const provider: WorkspaceFilesystemProvider = {
    observe: (input) => local.observe(input),
    prepareMutation: async (input) => {
      prepareCalls += 1;
      const result = await local.prepareMutation(input);
      if (result.ok && name === 'edit_file') {
        const evidence = result.observation.targetEvidence;
        const contentDigest =
          options.editMode === 'stale'
            ? `sha256:${'f'.repeat(64)}`
            : (result.observation.preimage.contentDigest ?? `sha256:${'e'.repeat(64)}`);
        const observation = freezeDeep({
          actorIdentityDigest: actorDigest(),
          lexicalTargetDigest: evidence.lexicalTargetDigest,
          canonicalTargetDigest: evidence.canonicalTargetDigest,
          targetIdentityDigest: evidence.targetIdentityDigest,
          contentDigest,
        });
        const capabilityResult = {
          status: 'success' as const,
          content: [],
          structuredContent: freezeDeep({
            path: './notes.txt',
            filesystemObservation: observation,
          }),
        } satisfies CapabilityResult;
        const artifact = capabilityStore.write('prior-read-invocation', capabilityResult);
        priorObservation = {
          observation,
          artifact,
          resultDigest: capabilityResultDigest(capabilityResult),
          evidenceDigest: capabilityResultEvidenceDigest(capabilityResult),
        };
      }
      return result;
    },
    commitMutation: async (input) => {
      commitCalls += 1;
      if (options.commitThrow) throw new Error('commit certainty lost');
      return local.commitMutation(input);
    },
  };
  const runtime: BuiltinWorkspaceFilesystemRuntime = {
    canonicalWorkspace: protectedPathEvaluator.workspaceRoot,
    provider,
    grants,
    preimageArtifacts: options.preimageFailure
      ? {
          write: () => {
            throw new Error('preimage write failed');
          },
        }
      : preimageStore,
    capabilityArtifacts: capabilityStore,
  };
  const durable = mutationDurable(prepared.prepared, options.durableMode ?? 'valid');
  const editObservation: WorkspaceFilesystemEditObservationPort = {
    findLatestAuthenticRead: async (query) => {
      if (options.editMode === 'missing' || !priorObservation) {
        return { status: 'missing', code: 'read_required', query };
      }
      const result: WorkspaceFilesystemEditObservationQueryResult = {
        status: 'found',
        query,
        invocationId: 'prior-read-invocation',
        attempt: 1,
        capabilityRevision: 'prior-read-revision',
        resultDigest:
          options.editMode === 'artifact_invalid'
            ? `sha256:${'0'.repeat(64)}`
            : priorObservation.resultDigest,
        evidenceDigest: priorObservation.evidenceDigest,
        artifact: priorObservation.artifact,
        observation: priorObservation.observation,
      };
      return options.editMode === 'clone' ? structuredClone(result) : result;
    },
    verifyLatestAuthenticRead: (_result) =>
      options.editMode === 'clone'
        ? { valid: false, code: 'query_result_not_issued' }
        : { valid: true },
  };
  const input: CreateBuiltinWorkspaceFilesystemMutationDispatcherInput = {
    prepared: prepared.prepared,
    verifyPreparedIdentity: prepared.callbacks.verifyPreparedIdentity,
    runtime,
    durableEvidence: durable,
    editObservation,
    protectedPathEvaluator,
    protectedPathRevision: 'protected-path-mutation-v1',
    actorIdentity: { threadId: 'thread-mutation', actorId: 'actor-mutation' },
    checkpointProjection: {
      recordPreimage: () => {
        preimageProjectionCalls += 1;
        if (options.checkpointThrow) throw new Error('legacy preimage projection failed');
      },
      recordPostimage: () => {
        postimageProjectionCalls += 1;
        if (options.checkpointThrow) throw new Error('legacy postimage projection failed');
      },
    },
    now: () => new Date(FIXED_NOW),
  };
  function actorDigest(): string {
    return digestCapabilityBindingValue({
      schema: 'kite.workspace-filesystem-actor.v1',
      threadId: 'thread-mutation',
      actorIdentity: 'actor-mutation',
    });
  }
  return {
    ...prepared,
    runtime,
    input,
    durable,
    operation: mutationOperation(name),
    get prepareCalls() {
      return prepareCalls;
    },
    get commitCalls() {
      return commitCalls;
    },
    get preimageProjectionCalls() {
      return preimageProjectionCalls;
    },
    get postimageProjectionCalls() {
      return postimageProjectionCalls;
    },
    readContent: () => readFileSync(join(workspace, 'notes.txt'), 'utf8'),
  };
}

function executionReceipt(
  prepared: Readonly<PreparedToolInvocation>,
  value: BuiltinOperationExecutionValue,
): ExecutionReceipt<BuiltinOperationExecutionValue> {
  return {
    invocationId: prepared.identity.invocationId,
    attemptId: prepared.identity.attemptId,
    providerId: prepared.identity.providerId,
    executorRevision: prepared.identity.executorRevision ?? 'executor-missing',
    requestDigest: prepared.identity.argumentsDigest,
    status: 'succeeded',
    dispatchCertainty: 'attempted',
    cleanupCertainty: 'not_required',
    value,
  };
}

async function terminalFor(
  fixtureValue: ReturnType<typeof fixture>,
  result: Awaited<
    ReturnType<ReturnType<typeof createBuiltinWorkspaceFilesystemMutationDispatcher>['dispatch']>
  >,
) {
  if (!result.ok || !result.filesystemObservation) throw new Error('mutation observation missing');
  const value = freezeDeep({
    schema: 'kite.builtin-operation-result.v1' as const,
    ok: true,
    stdout: 'mutation',
    stderr: '',
    resultMeta: {},
    filesystemObservation: result.filesystemObservation,
    path: './notes.txt',
  }) as unknown as BuiltinOperationExecutionValue;
  const adapter = createBuiltinPreparedToolDispatchAdapter({
    projection: fixtureValue.projection,
    verifyPreparedIdentity: fixtureValue.callbacks.verifyPreparedIdentity,
    port: { dispatch: async () => executionReceipt(fixtureValue.prepared, value) },
  });
  return adapter.dispatch(fixtureValue.prepared);
}

describe('Builtin Workspace filesystem mutation dispatcher', () => {
  test('write_file performs prepare/ready/commit exactly once without a prior read', async () => {
    const value = fixture('write_file');
    const result = await createBuiltinWorkspaceFilesystemMutationDispatcher(value.input).dispatch(
      value.operation,
    );
    expect(result.ok).toBe(true);
    expect(value.prepareCalls).toBe(1);
    expect(value.commitCalls).toBe(1);
    expect(value.durable.intentCalls).toBe(1);
    expect(value.durable.readyCalls).toBe(1);
    expect(value.durable.lastReady?.record.readyAt).toBe(FIXED_NOW.toISOString());
    expect(value.preimageProjectionCalls).toBe(1);
    expect(value.postimageProjectionCalls).toBe(1);
    expect(value.readContent()).toBe('after\n');
    expect(value.durable.lastIntent?.operation.path).toBe('./notes.txt');
    expect(result.ok && result.filesystemObservation).toBeDefined();
  });

  test('legacy checkpoint projection remains best-effort and never authorizes mutation', async () => {
    const value = fixture('write_file', { checkpointThrow: true });
    const result = await createBuiltinWorkspaceFilesystemMutationDispatcher(value.input).dispatch(
      value.operation,
    );
    expect(result.ok).toBe(true);
    expect(value.commitCalls).toBe(1);
    expect(value.preimageProjectionCalls).toBe(1);
    expect(value.postimageProjectionCalls).toBe(1);
  });

  test('edit_file accepts only an authentic same-actor read Artifact and detects stale content', async () => {
    const valid = fixture('edit_file', { editMode: 'valid' });
    const result = await createBuiltinWorkspaceFilesystemMutationDispatcher(valid.input).dispatch(
      valid.operation,
    );
    expect(result.ok).toBe(true);
    expect(valid.prepareCalls).toBe(1);
    expect(valid.commitCalls).toBe(1);
    expect(valid.readContent()).toBe('after\n');

    const stale = fixture('edit_file', { editMode: 'stale' });
    const staleResult = await createBuiltinWorkspaceFilesystemMutationDispatcher(
      stale.input,
    ).dispatch(stale.operation);
    expect(staleResult).toMatchObject({ ok: false, failure: { code: 'stale_read' } });
    expect(stale.prepareCalls).toBe(1);
    expect(stale.commitCalls).toBe(0);
  });

  test('missing or forged read evidence fails closed before commit', async () => {
    for (const editMode of ['missing', 'artifact_invalid', 'clone'] as const) {
      const value = fixture('edit_file', { editMode });
      const result = await createBuiltinWorkspaceFilesystemMutationDispatcher(value.input).dispatch(
        value.operation,
      );
      expect(result).toMatchObject({ ok: false });
      expect(value.prepareCalls).toBe(1);
      expect(value.commitCalls).toBe(0);
    }
  });

  test('intent and ready uncertainty never reaches Provider commit', async () => {
    const intentFailure = fixture('write_file', { durableMode: 'intent_throw' });
    await expect(
      createBuiltinWorkspaceFilesystemMutationDispatcher(intentFailure.input).dispatch(
        intentFailure.operation,
      ),
    ).rejects.toMatchObject({ code: 'intent_persistence_failed' });
    expect(intentFailure.prepareCalls).toBe(0);

    for (const durableMode of [
      'intent_invalid',
      'intent_clone',
      'ready_throw',
      'ready_invalid',
      'ready_clone',
    ] as const) {
      const value = fixture('write_file', { durableMode });
      const result = createBuiltinWorkspaceFilesystemMutationDispatcher(value.input).dispatch(
        value.operation,
      );
      if (durableMode === 'intent_invalid' || durableMode === 'intent_clone') {
        await expect(result).rejects.toMatchObject({ code: 'intent_verification_failed' });
        expect(value.prepareCalls).toBe(0);
      } else {
        await expect(result).rejects.toMatchObject({
          code:
            durableMode === 'ready_throw'
              ? 'ready_persistence_failed'
              : 'ready_verification_failed',
        });
        expect(value.prepareCalls).toBe(1);
      }
      expect(value.commitCalls).toBe(0);
    }
  });

  test('preimage Artifact failure blocks ready and commit; Provider commit throw is typed unknown', async () => {
    const artifactFailure = fixture('write_file', { preimageFailure: true });
    const result = await createBuiltinWorkspaceFilesystemMutationDispatcher(
      artifactFailure.input,
    ).dispatch(artifactFailure.operation);
    expect(result).toMatchObject({ ok: false, failure: { code: 'operation_failed' } });
    expect(artifactFailure.prepareCalls).toBe(1);
    expect(artifactFailure.commitCalls).toBe(0);
    expect(artifactFailure.preimageProjectionCalls).toBe(0);

    const unknown = fixture('write_file', { commitThrow: true });
    await expect(
      createBuiltinWorkspaceFilesystemMutationDispatcher(unknown.input).dispatch(unknown.operation),
    ).rejects.toBeInstanceOf(BuiltinWorkspaceFilesystemMutationCommitUnknownError);
    expect(unknown.commitCalls).toBe(1);
    expect(unknown.preimageProjectionCalls).toBe(1);
    expect(unknown.postimageProjectionCalls).toBe(0);
  });

  test('successful mutation observation binds the exact cloned terminal and rejects forged/failed terminals', async () => {
    const value = fixture('write_file');
    const dispatcher = createBuiltinWorkspaceFilesystemMutationDispatcher(value.input);
    const result = await dispatcher.dispatch(value.operation);
    const terminal = await terminalFor(value, result);
    expect(terminal).toMatchObject({
      status: 'success',
      structuredContent: { path: './notes.txt' },
    });
    const verified = await terminalFor(value, result);
    expect(verified).toMatchObject({ status: 'success' });

    if (!result.ok || !result.filesystemObservation) throw new Error('observation missing');
    const forgedValue = freezeDeep({
      schema: 'kite.builtin-operation-result.v1' as const,
      ok: true,
      stdout: 'mutation',
      stderr: '',
      resultMeta: {},
      filesystemObservation: structuredClone(result.filesystemObservation),
      path: './notes.txt',
    }) as unknown as BuiltinOperationExecutionValue;
    const forgedAdapter = createBuiltinPreparedToolDispatchAdapter({
      projection: value.projection,
      verifyPreparedIdentity: value.callbacks.verifyPreparedIdentity,
      port: { dispatch: async () => executionReceipt(value.prepared, forgedValue) },
    });
    await expect(forgedAdapter.dispatch(value.prepared)).rejects.toMatchObject({
      code: 'observation_not_issued',
    });

    const failedValue = freezeDeep({
      schema: 'kite.builtin-operation-result.v1' as const,
      ok: false,
      stdout: '',
      stderr: 'failed',
      resultMeta: {},
      filesystemObservation: forgedValue.filesystemObservation,
      path: './notes.txt',
    }) as unknown as BuiltinOperationExecutionValue;
    const failedAdapter = createBuiltinPreparedToolDispatchAdapter({
      projection: value.projection,
      verifyPreparedIdentity: value.callbacks.verifyPreparedIdentity,
      port: { dispatch: async () => executionReceipt(value.prepared, failedValue) },
    });
    await expect(failedAdapter.dispatch(value.prepared)).rejects.toMatchObject({
      code: 'observation_not_issued',
    });
  });

  test('mutation source stays Builtin-only and has no fallback/registry authority', async () => {
    const source = await Bun.file(
      new URL('../src/filesystem/mutation-dispatcher.ts', import.meta.url),
    ).text();
    expect(source).not.toMatch(/@kite\/(?:runtime-host|agent-kernel)|#app|@\/core/u);
    expect(source).not.toContain('createRuntimeModuleRegistry');
    expect(source).not.toContain('RuntimeStore');
    expect(source).not.toContain('catchOld');
  });
});
