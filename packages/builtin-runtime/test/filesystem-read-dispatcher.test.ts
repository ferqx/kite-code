import { describe, expect, test } from 'bun:test';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import {
  type BuiltinOperationExecutionValueV1,
  createBuiltinPreparedToolDispatchAdapterV1,
  createBuiltinRuntimeModules,
  createBuiltinToolCatalogProjectionV1,
  createBuiltinToolPipelineCallbacksV1,
  digestCapabilityBindingValueV1,
  verifyBuiltinWorkspaceFilesystemTerminalV1,
} from '@kite/builtin-runtime';
import {
  type BuiltinWorkspaceFilesystemRuntimeV1,
  createBuiltinWorkspaceFilesystemReadDispatcherV1,
  LocalWorkspaceFilesystemProviderV1,
  WorkspaceFilesystemGrantAuthorityV1,
} from '@kite/builtin-runtime/filesystem';
import { createProtectedPathEvaluatorV1 } from '@kite/builtin-runtime/sandbox';
import type {
  CapabilityToolKindV1,
  ExecutionReceiptV1,
  NonDynamicOperationIdV1,
  PreparedToolInvocationV1,
  RuntimeJsonValueV1,
  ToolPipelineAttemptAcknowledgementV1,
  ToolPipelineResolutionContextV1,
  WorkspaceFilesystemDurableEvidencePortV1,
  WorkspaceFilesystemIntentDraftV1,
  WorkspaceFilesystemPersistedIntentV1,
  WorkspaceFilesystemProviderV1,
} from '@kite/runtime-spi';
import { createRuntimeModuleRegistryV1 } from '@kite/runtime-spi';

const FIXED_NOW = new Date('2026-08-22T00:00:00.000Z');
const DYNAMIC_REVISION = 'd'.repeat(64);
const FILESYSTEM_SOURCE_DIRECTORY = existsSync(join(process.cwd(), 'src/filesystem/evidence.ts'))
  ? 'src/filesystem'
  : 'packages/builtin-runtime/src/filesystem';

function freezeDeep<Value>(value: Value, seen = new WeakSet<object>()): Value {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && 'value' in descriptor) freezeDeep(descriptor.value, seen);
  }
  return Object.freeze(value);
}

function preparedFixture(name: 'read_file' | 'search_files' | 'search_content', args: object) {
  const workspace = realpathSync(process.cwd());
  const registry = createRuntimeModuleRegistryV1(createBuiltinRuntimeModules());
  const projection = createBuiltinToolCatalogProjectionV1(registry.snapshot(), {
    turnContext: { workspace },
  });
  const callbacks = createBuiltinToolPipelineCallbacksV1(projection);
  const context: ToolPipelineResolutionContextV1 = {
    currentTurnId: 'turn-fsr',
    availabilityContext: { workspace },
    bindings: [],
    descriptors: [],
    disclosures: [],
    builtinProjectionRevision: projection.revision,
    dynamicCatalogRevision: DYNAMIC_REVISION,
  };
  const resolved = callbacks.resolve(
    {
      schema: 'kite.tool-pipeline-stage.v1',
      stage: 'snapshot',
      toolCallId: `call-${name}`,
      name,
      rawArguments: args as RuntimeJsonValueV1,
      argumentOrigin: 'model_public',
      createdAtTurnId: 'turn-fsr',
      modelMessageId: 'message-fsr',
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
    operationId: entry.operationId as NonDynamicOperationIdV1,
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
    policyDigest: digestCapabilityBindingValueV1({ name, kind: 'policy' }),
    authorizationDigest: digestCapabilityBindingValueV1({ name, kind: 'authorization' }),
    admissionDigest: digestCapabilityBindingValueV1({ name, kind: 'admission' }),
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
    toolKind: entry.kind as CapabilityToolKindV1,
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
  }) satisfies Readonly<PreparedToolInvocationV1>;
  expect(callbacks.verifyPreparedIdentity(prepared)).toEqual({ valid: true });
  return { workspace, projection, callbacks, prepared };
}

function acknowledgement(
  prepared: Readonly<PreparedToolInvocationV1>,
  attempt: number,
): Readonly<ToolPipelineAttemptAcknowledgementV1> {
  const identity = prepared.identity;
  return freezeDeep({
    acknowledged: true as const,
    attempt: {
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

function durableEvidence(
  mode: 'valid' | 'throw' | 'invalid' | 'clone' = 'valid',
): WorkspaceFilesystemDurableEvidencePortV1 & {
  readonly calls: number;
  readonly last: Readonly<WorkspaceFilesystemPersistedIntentV1> | undefined;
} {
  let calls = 0;
  let last: Readonly<WorkspaceFilesystemPersistedIntentV1> | undefined;
  const issued = new WeakSet<object>();
  return {
    get calls() {
      return calls;
    },
    get last() {
      return last;
    },
    persistIntent: async <
      TArguments extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
      TRequest extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
    >(
      draft: Readonly<WorkspaceFilesystemIntentDraftV1<TArguments, TRequest>>,
    ): Promise<Readonly<WorkspaceFilesystemPersistedIntentV1<TArguments, TRequest>>> => {
      calls += 1;
      if (mode === 'throw') throw new Error('State26 intent persistence uncertain');
      const persisted = freezeDeep({
        schema: 'kite.workspace-filesystem-pipeline.v1' as const,
        status: 'durably_persisted' as const,
        prepared: draft.prepared,
        acknowledgement: acknowledgement(draft.prepared, draft.record.attempt),
        operation:
          mode === 'clone' ? freezeDeep(structuredClone(draft.operation)) : draft.operation,
        record: mode === 'clone' ? freezeDeep(structuredClone(draft.record)) : draft.record,
      });
      issued.add(persisted);
      last = persisted;
      return persisted;
    },
    verifyPersistedIntent: (persisted) =>
      mode !== 'invalid' && issued.has(persisted)
        ? { valid: true as const }
        : { valid: false as const, code: 'intent_not_issued' as const },
  };
}

function runtimeFixture(workspace: string) {
  let providerCalls = 0;
  let grantId = 0;
  const grants = new WorkspaceFilesystemGrantAuthorityV1({
    integrityKey: new Uint8Array(32).fill(7),
    now: () => FIXED_NOW.getTime(),
    idSource: () => `grant-${++grantId}`,
  });
  const local = new LocalWorkspaceFilesystemProviderV1(grants.verifier());
  const provider: WorkspaceFilesystemProviderV1 = {
    observe: async (input) => {
      providerCalls += 1;
      return local.observe(input);
    },
    prepareMutation: (input) => local.prepareMutation(input),
    commitMutation: (input) => local.commitMutation(input),
  };
  const runtime: BuiltinWorkspaceFilesystemRuntimeV1 = {
    canonicalWorkspace: workspace,
    provider,
    grants,
    preimageArtifacts: {
      write: () => {
        throw new Error('read-only fixture cannot write preimages');
      },
    },
  };
  return {
    runtime,
    get providerCalls() {
      return providerCalls;
    },
  };
}

function createDispatcher(
  fixture: ReturnType<typeof preparedFixture>,
  runtime: BuiltinWorkspaceFilesystemRuntimeV1,
  durable: WorkspaceFilesystemDurableEvidencePortV1,
) {
  const protectedPathEvaluator = createProtectedPathEvaluatorV1({
    workspaceRoot: fixture.workspace,
    mode: 'deny',
  });
  return createBuiltinWorkspaceFilesystemReadDispatcherV1({
    prepared: fixture.prepared,
    verifyPreparedIdentity: fixture.callbacks.verifyPreparedIdentity,
    runtime,
    durableEvidence: durable,
    protectedPathEvaluator,
    protectedPathRevision: 'protected-path-fsr-v1',
    actorIdentity: { threadId: 'thread-fsr', actorId: 'actor-fsr' },
    now: () => new Date(FIXED_NOW),
  });
}

function executionValue(
  path: string,
  result: Awaited<ReturnType<ReturnType<typeof createDispatcher>['dispatch']>>,
): BuiltinOperationExecutionValueV1 {
  if (!result.ok || result.observation.kind !== 'read_file' || !result.filesystemObservation) {
    throw new Error('authentic read result missing');
  }
  return freezeDeep({
    schema: 'kite.builtin-operation-result.v1' as const,
    ok: true,
    stdout: result.observation.content,
    stderr: '',
    resultMeta: {},
    filesystemObservation: result.filesystemObservation,
    path,
    totalLines: result.observation.totalLines,
  }) as unknown as BuiltinOperationExecutionValueV1;
}

function receipt(
  prepared: Readonly<PreparedToolInvocationV1>,
  value: BuiltinOperationExecutionValueV1,
): ExecutionReceiptV1<BuiltinOperationExecutionValueV1> {
  return {
    invocationId: prepared.identity.invocationId,
    attemptId: prepared.identity.attemptId,
    providerId: prepared.identity.providerId,
    executorRevision: prepared.identity.executorRevision ?? 'missing-executor',
    requestDigest: 'request-fsr',
    status: 'succeeded',
    dispatchCertainty: 'attempted',
    cleanupCertainty: 'not_required',
    value,
  };
}

describe('Builtin Workspace filesystem read dispatcher', () => {
  test('persists exact raw-path intent before Provider and binds the cloned terminal', async () => {
    const fixture = preparedFixture('read_file', { path: './README.md' });
    const runtime = runtimeFixture(fixture.workspace);
    const durable = durableEvidence();
    const dispatcher = createDispatcher(fixture, runtime.runtime, durable);
    const operation = freezeDeep({
      kind: 'read_file' as const,
      path: './README.md',
      pathScope: 'workspace_only' as const,
    });
    const read = await dispatcher.dispatch(operation);
    expect(read.ok).toBe(true);
    expect(runtime.providerCalls).toBe(1);
    expect(durable.calls).toBe(1);
    expect(durable.last?.operation.path).toBe('./README.md');
    expect(durable.last?.prepared).toBe(fixture.prepared);
    if (!read.ok) throw new Error(read.failure.code);
    expect(read.filesystemObservation).toBeDefined();

    const sourceValue = executionValue(operation.path, read);
    const adapter = createBuiltinPreparedToolDispatchAdapterV1({
      projection: fixture.projection,
      verifyPreparedIdentity: fixture.callbacks.verifyPreparedIdentity,
      port: { dispatch: async () => receipt(fixture.prepared, sourceValue) },
    });
    const terminal = await adapter.dispatch(fixture.prepared);
    expect(terminal).toMatchObject({
      status: 'success',
      structuredContent: { path: './README.md', filesystemObservation: {} },
    });
    const sourceObservation = sourceValue.filesystemObservation;
    const clonedObservation = (
      terminal.structuredContent as Readonly<Record<string, RuntimeJsonValueV1>>
    ).filesystemObservation;
    expect(clonedObservation).toEqual(sourceObservation);
    expect(clonedObservation).not.toBe(sourceObservation);
    expect(
      verifyBuiltinWorkspaceFilesystemTerminalV1({
        acknowledgement: durable.last!.acknowledgement,
        result: terminal,
      }),
    ).toMatchObject({ valid: true, observation: clonedObservation });
    expect(
      verifyBuiltinWorkspaceFilesystemTerminalV1({
        acknowledgement: freezeDeep(structuredClone(durable.last!.acknowledgement)),
        result: terminal,
      }),
    ).toEqual({ valid: false, code: 'acknowledgement_mismatch' });
    expect(
      verifyBuiltinWorkspaceFilesystemTerminalV1({
        acknowledgement: durable.last!.acknowledgement,
        result: freezeDeep(structuredClone(terminal)),
      }),
    ).toEqual({ valid: false, code: 'terminal_not_issued' });
  });

  test('keeps both search operations observation-free', async () => {
    const cases = [
      {
        name: 'search_files' as const,
        args: { path: FILESYSTEM_SOURCE_DIRECTORY, pattern: '*evidence.ts' },
        operation: {
          kind: 'search_files' as const,
          path: FILESYSTEM_SOURCE_DIRECTORY,
          pathScope: 'workspace_only' as const,
          pattern: '*evidence.ts',
        },
      },
      {
        name: 'search_content' as const,
        args: { path: `${FILESYSTEM_SOURCE_DIRECTORY}/evidence.ts`, pattern: 'filesystem intent' },
        operation: {
          kind: 'search_content' as const,
          path: `${FILESYSTEM_SOURCE_DIRECTORY}/evidence.ts`,
          pathScope: 'workspace_only' as const,
          pattern: 'filesystem intent',
        },
      },
    ];
    for (const item of cases) {
      const fixture = preparedFixture(item.name, item.args);
      const runtime = runtimeFixture(fixture.workspace);
      const durable = durableEvidence();
      const result = await createDispatcher(fixture, runtime.runtime, durable).dispatch(
        freezeDeep(item.operation),
      );
      expect(result.ok).toBe(true);
      expect(result).not.toHaveProperty('filesystemObservation');
      expect(runtime.providerCalls).toBe(1);
      expect(durable.calls).toBe(1);
    }
  });

  test('throws on persistence uncertainty, invalid verification, or cloned evidence before Provider', async () => {
    for (const mode of ['throw', 'invalid', 'clone'] as const) {
      const fixture = preparedFixture('read_file', { path: 'README.md' });
      const runtime = runtimeFixture(fixture.workspace);
      const durable = durableEvidence(mode);
      const dispatch = createDispatcher(fixture, runtime.runtime, durable).dispatch({
        kind: 'read_file',
        path: 'README.md',
        pathScope: 'workspace_only',
      });
      await expect(dispatch).rejects.toMatchObject({
        code: mode === 'throw' ? 'intent_persistence_failed' : 'intent_verification_failed',
      });
      expect(runtime.providerCalls).toBe(0);
    }
  });

  test('rejects missing, forged, and cross-prepared source observations before cloning', async () => {
    const fixture = preparedFixture('read_file', { path: 'README.md' });
    const runtime = runtimeFixture(fixture.workspace);
    const durable = durableEvidence();
    const read = await createDispatcher(fixture, runtime.runtime, durable).dispatch({
      kind: 'read_file',
      path: 'README.md',
      pathScope: 'workspace_only',
    });
    if (!read.ok) throw new Error(read.failure.code);
    const authentic = executionValue('README.md', read);
    const dispatchValue = async (
      prepared: Readonly<PreparedToolInvocationV1>,
      value: BuiltinOperationExecutionValueV1,
    ) =>
      createBuiltinPreparedToolDispatchAdapterV1({
        projection: fixture.projection,
        verifyPreparedIdentity: fixture.callbacks.verifyPreparedIdentity,
        port: { dispatch: async () => receipt(prepared, value) },
      }).dispatch(prepared);

    const authenticRecord = authentic as unknown as Readonly<Record<string, RuntimeJsonValueV1>>;
    const { filesystemObservation: _missing, ...withoutObservation } = authenticRecord;
    void _missing;
    await expect(
      dispatchValue(
        fixture.prepared,
        freezeDeep(withoutObservation) as unknown as BuiltinOperationExecutionValueV1,
      ),
    ).rejects.toMatchObject({ code: 'observation_missing' });

    const forged = freezeDeep({
      ...authenticRecord,
      filesystemObservation: structuredClone(authenticRecord.filesystemObservation),
    }) as unknown as BuiltinOperationExecutionValueV1;
    await expect(dispatchValue(fixture.prepared, forged)).rejects.toMatchObject({
      code: 'observation_not_issued',
    });

    const crossPrepared = freezeDeep(structuredClone(fixture.prepared));
    await expect(dispatchValue(crossPrepared, authentic)).rejects.toMatchObject({
      code: 'prepared_identity_mismatch',
    });

    await expect(
      dispatchValue(
        fixture.prepared,
        freezeDeep({
          ...authenticRecord,
          path: 'other.md',
        }) as unknown as BuiltinOperationExecutionValueV1,
      ),
    ).rejects.toMatchObject({ code: 'provider_evidence_mismatch' });

    let cloneEnumerationCount = 0;
    const cloneBomb = new Proxy<Record<string, RuntimeJsonValueV1>>(
      {},
      {
        ownKeys: () => {
          cloneEnumerationCount += 1;
          if (cloneEnumerationCount > 1) throw new Error('clone failed');
          return [];
        },
      },
    );
    const cloneFailingValue = {
      ...authenticRecord,
      resultMeta: cloneBomb,
    } as unknown as BuiltinOperationExecutionValueV1;
    await expect(dispatchValue(fixture.prepared, cloneFailingValue)).rejects.toThrow(
      'clone failed',
    );
    expect(cloneEnumerationCount).toBe(2);
  });

  test('contains no Host, Kernel, App, Core, Store, or registry authority', async () => {
    for (const relative of [
      '../src/filesystem/read-dispatcher.ts',
      '../src/filesystem/observation-authority.ts',
    ]) {
      const source = await Bun.file(new URL(relative, import.meta.url)).text();
      expect(source).not.toMatch(/@kite\/(?:runtime-host|agent-kernel)|#app|@\/core/u);
      expect(source).not.toContain('createRuntimeModuleRegistryV1');
      expect(source).not.toContain('RuntimeStore');
    }
  });
});
