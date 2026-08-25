import { describe, expect, test } from 'bun:test';
import type {
  BuiltinOperationExecutionValue,
  BuiltinPreparedToolDispatchInput,
} from '@kite-ai/builtin-runtime';
import {
  BUILTIN_PREPARED_CALL_FACTS_SCHEMA_,
  BuiltinPreparedToolDispatchError,
  createBuiltinPreparedTaskDispatchAdapter,
  createBuiltinPreparedToolDispatchAdapter,
  createBuiltinRuntimeModules,
  createBuiltinToolCatalogProjection,
  digestCapabilityBindingValue,
  projectBuiltinDynamicMcpExecutionReceiptTerminalResult,
  projectBuiltinExecutionReceiptTerminalResult,
  projectBuiltinOperationTerminalResult,
} from '@kite-ai/builtin-runtime';
import type {
  CapabilityTurnContext,
  DynamicMcpPreparedToolInvocationIdentity,
  ExecutionReceipt,
  NonDynamicOperationId,
  NonDynamicPreparedToolInvocationIdentity,
  PreparedToolInvocation,
  RuntimeJsonValue,
  ToolPipelinePreparedIdentityVerifier,
} from '@kite-ai/runtime-spi';
import { createRuntimeModuleRegistry } from '@kite-ai/runtime-spi';

const turnContext: CapabilityTurnContext = Object.freeze({
  hasTaskAdapter: true,
  hasGitBroker: true,
  brokeredGitFeatureRevision: 'brokered-git-r1',
  toolSearchEnabled: true,
  activeSkillFrameIds: ['frame-1'],
  availableSkillIds: ['skill-1'],
  featureFlags: {
    brokeredGit: true,
    skillWorkflow: true,
    skillActivation: true,
  },
});

function projection() {
  const registry = createRuntimeModuleRegistry(createBuiltinRuntimeModules());
  return createBuiltinToolCatalogProjection(registry, { turnContext });
}

function freezeDeep<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && 'value' in descriptor) freezeDeep(descriptor.value, seen);
  }
  return Object.freeze(value);
}

function operationValue(
  ok: boolean,
  stdout = ok ? 'done' : '',
  stderr = ok ? '' : 'operation failed',
  terminationReason?: BuiltinOperationExecutionValue['terminationReason'],
): BuiltinOperationExecutionValue {
  return Object.freeze({
    schema: 'kite.builtin-operation-result.v1',
    ok,
    stdout,
    stderr,
    resultMeta: Object.freeze({}),
    ...(terminationReason ? { terminationReason } : {}),
  }) as BuiltinOperationExecutionValue;
}

function executionReceipt(
  preparedInput: Readonly<PreparedToolInvocation>,
  value: BuiltinOperationExecutionValue | undefined,
  overrides: Partial<ExecutionReceipt<BuiltinOperationExecutionValue>> = {},
): ExecutionReceipt<BuiltinOperationExecutionValue> {
  const identity = preparedInput.identity;
  return {
    invocationId: identity.invocationId,
    attemptId: identity.attemptId,
    providerId: identity.providerId,
    executorRevision: identity.executorRevision ?? 'executor-1',
    requestDigest: 'request-1',
    status: 'succeeded',
    dispatchCertainty: 'attempted',
    cleanupCertainty: 'not_required',
    ...(value ? { value } : {}),
    ...overrides,
  };
}

function identityForEntry(
  entry: ReturnType<typeof projection>['entries'][number],
): NonDynamicPreparedToolInvocationIdentity {
  if (entry.visibility !== 'model' || !entry.name) {
    throw new Error(`Expected model entry: ${entry.operationId}`);
  }
  if (entry.kind === 'internal_runtime') {
    throw new Error(`Expected a model-visible tool kind: ${entry.operationId}`);
  }
  return {
    invocationId: 'invocation-1',
    attemptId: 'attempt-1',
    toolCallId: 'call-1',
    turnId: 'turn-1',
    modelMessageId: 'message-1',
    argumentOrigin: 'model_public',
    providerId: entry.providerId,
    operationId: entry.operationId as NonDynamicOperationId,
    executionFamily: entry.executionMechanism === 'subagent' ? 'subagent' : 'builtin',
    executionMechanism: entry.executionMechanism,
    capabilityId: entry.capabilityId,
    capabilityRevision: entry.revision,
    descriptorRevision: entry.descriptor.revision,
    parserRevision: entry.parser.parserRevision,
    executorRevision: entry.executorRevision,
    argumentsDigest: 'arguments-1',
    schemaDigest: entry.inputSchemaDigest ?? 'schema-1',
    effectiveEffectsDigest: 'effects-1',
    policyDigest: 'policy-1',
    authorizationDigest: 'authorization-1',
    admissionDigest: 'admission-1',
    idempotencyKeyArgument: null,
    idempotencyKey: null,
    bindingId: null,
    visibility: 'model',
    modelVisible: true,
    exposedToolName: entry.name,
    builtinProjectionRevision: 'projection-placeholder',
    dynamicCatalogRevision: null,
    nestedCapabilityId: null,
    nestedCapabilityRevision: null,
    nestedCatalogRevision: null,
    isDynamicMcp: false,
    toolKind: entry.kind,
  };
}

function prepared(
  projectionValue: ReturnType<typeof projection>,
  operationId: string,
  overrides: Partial<NonDynamicPreparedToolInvocationIdentity> = {},
): Readonly<PreparedToolInvocation> {
  const entry = projectionValue.entries.find((candidate) => candidate.operationId === operationId);
  if (!entry) throw new Error(`Missing test entry: ${operationId}`);
  const identity = {
    ...identityForEntry(entry),
    builtinProjectionRevision: projectionValue.revision,
    ...overrides,
  } satisfies NonDynamicPreparedToolInvocationIdentity;
  return freezeDeep({
    identity,
    input: {
      invocationId: identity.invocationId,
      attemptId: identity.attemptId,
      toolCallId: identity.toolCallId,
      arguments: { path: 'README.md' },
      binding: null,
    },
  });
}

function dynamicPrepared(): Readonly<PreparedToolInvocation> {
  const identity: DynamicMcpPreparedToolInvocationIdentity = {
    invocationId: 'invocation-1',
    attemptId: 'attempt-1',
    toolCallId: 'call-1',
    turnId: 'turn-1',
    modelMessageId: 'message-1',
    argumentOrigin: 'model_public',
    providerId: 'mcp-provider',
    operationId: 'mcp:dynamic_tool',
    executionFamily: 'mcp',
    executionMechanism: 'mcp',
    capabilityId: 'mcp:server:tool',
    capabilityRevision: 'subject-revision',
    descriptorRevision: 'subject-descriptor',
    parserRevision: 'subject-parser',
    executorRevision: null,
    argumentsDigest: 'arguments-1',
    schemaDigest: 'schema-1',
    effectiveEffectsDigest: 'effects-1',
    policyDigest: 'policy-1',
    authorizationDigest: 'authorization-1',
    admissionDigest: 'admission-1',
    idempotencyKeyArgument: null,
    idempotencyKey: null,
    bindingId: 'binding-1',
    visibility: 'internal',
    modelVisible: false,
    exposedToolName: null,
    builtinProjectionRevision: null,
    dynamicCatalogRevision: 'dynamic-catalog-1',
    isDynamicMcp: true,
    subject: {
      capabilityId: 'mcp:server:tool',
      capabilityRevision: 'subject-revision',
      descriptorRevision: 'subject-descriptor',
      providerId: 'mcp-provider',
      exposedToolName: 'mcp__server__tool',
      dynamicCatalogRevision: 'dynamic-catalog-1',
      bindingId: 'binding-1',
    },
    runtimeWrapper: {
      operationId: 'mcp:dynamic_tool',
      capabilityId: 'mcp:dynamic_tool',
      providerId: 'builtin-runtime-model',
      capabilityRevision: 'wrapper-revision',
      executorRevision: 'wrapper-executor',
      schemaDigest: 'wrapper-schema',
      builtinProjectionRevision: 'wrapper-projection',
    },
  };
  return freezeDeep({
    identity,
    input: {
      invocationId: identity.invocationId,
      attemptId: identity.attemptId,
      toolCallId: identity.toolCallId,
      arguments: { capability_id: 'mcp:server:tool', arguments: {} },
      binding: null,
    },
  });
}

function adapterFixture(
  preparedInput: Readonly<PreparedToolInvocation>,
  verify: ToolPipelinePreparedIdentityVerifier = () => ({ valid: true }),
) {
  let dispatchCalls = 0;
  let received: Readonly<BuiltinPreparedToolDispatchInput> | undefined;
  const adapter = createBuiltinPreparedToolDispatchAdapter({
    projection: projection(),
    verifyPreparedIdentity: verify,
    port: {
      dispatch: async (input) => {
        dispatchCalls += 1;
        received = input;
        return executionReceipt(input.prepared, operationValue(true));
      },
    },
  });
  return {
    adapter,
    prepared: preparedInput,
    verify,
    get dispatchCalls() {
      return dispatchCalls;
    },
    get received() {
      return received;
    },
  };
}

function privateTaskPrepared(
  projectionValue: ReturnType<typeof projection>,
  overrides: Partial<NonDynamicPreparedToolInvocationIdentity> = {},
  argumentsValue: Record<string, unknown> = {
    name: 'Inspect prepared dispatch',
    subagent_type: 'explore',
    taskArtifact: {
      artifactId: `pa_${'a'.repeat(64)}`,
      kind: 'subagent_task_request',
      integrityIdentifier: `sha256:${'b'.repeat(64)}`,
      byteLength: 32,
    },
  },
): Readonly<PreparedToolInvocation> {
  const entry = projectionValue.entries.find(
    (candidate) => candidate.visibility === 'model' && candidate.operationId === 'builtin:task',
  );
  if (entry?.visibility !== 'model') throw new Error('Missing task catalog entry.');
  const canonical = entry.parser.canonicalize(argumentsValue);
  const classification = entry.classifyEffects(canonical);
  const schemaDigest = entry.parser.schemaDigest ?? entry.inputSchemaDigest;
  if (!schemaDigest) throw new Error('Missing task runtime schema digest.');
  const canonicalRecord = canonical as Readonly<Record<string, RuntimeJsonValue>>;
  if (typeof canonicalRecord.subagent_type !== 'string') {
    throw new Error('Missing task subagent role.');
  }
  const identity: NonDynamicPreparedToolInvocationIdentity = {
    ...identityForEntry(entry),
    argumentOrigin: 'runtime_private',
    executionFamily: 'subagent',
    executionMechanism: 'subagent',
    parserRevision: entry.parser.parserRevision,
    argumentsDigest: digestCapabilityBindingValue(canonical),
    schemaDigest,
    effectiveEffectsDigest: digestCapabilityBindingValue(classification.effectiveEffects),
    builtinProjectionRevision: projectionValue.revision,
    ...overrides,
  };
  const facts = {
    schema: BUILTIN_PREPARED_CALL_FACTS_SCHEMA_,
    toolCallId: identity.toolCallId,
    callCreatedAtTurnId: identity.turnId,
    modelMessageId: identity.modelMessageId,
    argumentOrigin: 'runtime_private',
    dynamicCatalogRevision: null,
    approvalSummary: entry.projectApprovalSummary(canonical),
    privateTaskProjection: true,
    subagentRole: canonicalRecord.subagent_type,
    nestedCapabilityId: null,
    nestedCapabilityRevision: null,
    nestedSkill: null,
  } as const;
  return freezeDeep({
    identity,
    input: {
      invocationId: identity.invocationId,
      attemptId: identity.attemptId,
      toolCallId: identity.toolCallId,
      arguments: canonical,
      binding: null,
      facts,
    },
  });
}

describe('Builtin prepared dispatch adapter', () => {
  test('returns the exact verifier reference and dispatches through the neutral port', async () => {
    const catalog = projection();
    const input = prepared(catalog, 'builtin:shell_execute');
    const fixture = adapterFixture(input);

    expect(fixture.adapter.verifyPreparedIdentity).toBe(fixture.verify);
    expect(fixture.adapter.verifyPreparedIdentity(input)).toEqual({ valid: true });
    const result = await fixture.adapter.dispatch(input);

    expect(fixture.dispatchCalls).toBe(1);
    expect(fixture.received?.operationId).toBe('builtin:shell_execute');
    expect(fixture.received?.executionMechanism).toBe('shell');
    expect(fixture.received?.prepared).toBe(input);
    expect(result).toMatchObject({ status: 'success', structuredContent: { ok: true } });
    expect(Object.isFrozen(fixture.received)).toBe(true);
  });

  test('leaves verifier failure and single-use claim ownership to Host', async () => {
    const input = prepared(projection(), 'builtin:read_file');
    const fixture = adapterFixture(input, () => ({ valid: false, code: 'identity_mismatch' }));

    expect(fixture.adapter.verifyPreparedIdentity(input)).toEqual({
      valid: false,
      code: 'identity_mismatch',
    });
    expect(fixture.dispatchCalls).toBe(0);
    expect('approved' in fixture.adapter || 'claimed' in fixture.adapter).toBe(false);
  });

  test('rejects mutable or projection-mismatched packets before the port', async () => {
    const catalog = projection();
    const input = prepared(catalog, 'builtin:read_file');
    const fixture = adapterFixture(input);
    const mutable = {
      ...input,
      input: { ...input.input, arguments: { path: 'tampered' } },
    } as Readonly<PreparedToolInvocation>;
    await expect(fixture.adapter.dispatch(mutable)).rejects.toMatchObject({
      code: 'invalid_prepared_input',
    });

    const mismatched = prepared(catalog, 'builtin:read_file', { exposedToolName: 'write_file' });
    await expect(fixture.adapter.dispatch(mismatched)).rejects.toMatchObject({
      code: 'identity_mismatch',
    });
    expect(fixture.dispatchCalls).toBe(0);
  });

  test('rejects dynamic MCP, ask_user, and subagent boundaries without fallback', async () => {
    const catalog = projection();
    let dispatchCalls = 0;
    const adapter = createBuiltinPreparedToolDispatchAdapter({
      projection: catalog,
      verifyPreparedIdentity: () => true,
      port: {
        dispatch: async (input) => {
          dispatchCalls += 1;
          return executionReceipt(input.prepared, operationValue(true));
        },
      },
    });

    const dynamic = dynamicPrepared();
    expect(adapter.verifyPreparedIdentity(dynamic)).toBe(true);
    await expect(adapter.dispatch(dynamic)).rejects.toMatchObject({
      code: 'unsupported_operation',
    });

    for (const operationId of ['builtin:ask_user'] as const) {
      const boundary = prepared(catalog, operationId);
      expect(adapter.verifyPreparedIdentity(boundary)).toBe(true);
      await expect(adapter.dispatch(boundary)).rejects.toMatchObject({
        code: 'unsupported_operation',
      });
    }
    expect(dispatchCalls).toBe(0);
  });

  test('task adapter preserves the exact verifier reference and dispatches one private task', async () => {
    const catalog = projection();
    const input = privateTaskPrepared(catalog);
    const verify: ToolPipelinePreparedIdentityVerifier = () => ({ valid: true });
    let dispatchCalls = 0;
    let received: Readonly<BuiltinPreparedToolDispatchInput> | undefined;
    const adapter = createBuiltinPreparedTaskDispatchAdapter({
      projection: catalog,
      verifyPreparedIdentity: verify,
      port: {
        dispatch: async (value) => {
          dispatchCalls += 1;
          received = value;
          const blockedValue = Object.freeze({
            ...(operationValue(true, 'child blocked') as unknown as Record<string, unknown>),
            subagentResult: Object.freeze({ kind: 'blocked', continuationDigest: 'digest-1' }),
          }) as unknown as BuiltinOperationExecutionValue;
          return executionReceipt(value.prepared, blockedValue);
        },
      },
    });

    expect(adapter.verifyPreparedIdentity).toBe(verify);
    const result = await adapter.dispatch(input);
    expect(dispatchCalls).toBe(1);
    expect(received?.operationId).toBe('builtin:task');
    expect(received?.executionMechanism).toBe('subagent');
    expect(received?.prepared).toBe(input);
    expect(result).toMatchObject({
      status: 'success',
      structuredContent: {
        ok: true,
        subagentResult: { kind: 'blocked', continuationDigest: 'digest-1' },
      },
    });
  });

  test('task adapter rejects public/parser/schema/effects/identity drift before the port', async () => {
    const catalog = projection();
    let dispatchCalls = 0;
    const adapter = createBuiltinPreparedTaskDispatchAdapter({
      projection: catalog,
      verifyPreparedIdentity: () => ({ valid: true }),
      port: {
        dispatch: async (value) => {
          dispatchCalls += 1;
          return executionReceipt(value.prepared, operationValue(true));
        },
      },
    });

    const taskEntry = catalog.entries.find(
      (candidate) => candidate.visibility === 'model' && candidate.operationId === 'builtin:task',
    );
    if (taskEntry?.visibility !== 'model') throw new Error('Missing task catalog entry.');
    const publicInput = privateTaskPrepared(
      catalog,
      { argumentOrigin: 'model_public' },
      {
        name: 'Inspect public dispatch',
        subagent_type: 'explore',
        task: 'public model task',
      },
    );
    const validPrivateInput = privateTaskPrepared(catalog);
    const missingArtifact = freezeDeep({
      ...validPrivateInput,
      input: {
        ...validPrivateInput.input,
        arguments: { subagent_type: 'explore' },
      },
    }) as Readonly<PreparedToolInvocation>;
    const inputIdentityDrift = freezeDeep({
      ...validPrivateInput,
      input: { ...validPrivateInput.input, attemptId: 'forged-attempt' },
    }) as Readonly<PreparedToolInvocation>;
    const driftCases = [
      publicInput,
      missingArtifact,
      inputIdentityDrift,
      privateTaskPrepared(catalog, {
        parserRevision: taskEntry.modelParser?.parserRevision ?? 'forged-model-parser',
      }),
      privateTaskPrepared(catalog, { schemaDigest: 'forged-schema' }),
      privateTaskPrepared(catalog, { effectiveEffectsDigest: 'forged-effects' }),
      privateTaskPrepared(catalog, { capabilityRevision: 'forged-revision' }),
      privateTaskPrepared(catalog, { builtinProjectionRevision: 'forged-projection' }),
      privateTaskPrepared(catalog, { nestedCapabilityId: 'forged-nested' }),
    ];
    for (const candidate of driftCases) {
      await expect(adapter.dispatch(candidate)).rejects.toMatchObject({
        code: 'identity_mismatch',
      });
    }
    expect(dispatchCalls).toBe(0);
  });

  test('task adapter rejects unavailable task projection and receipt identity drift', async () => {
    const unavailableTurnContext = Object.freeze({ ...turnContext, hasTaskAdapter: false });
    const registry = createRuntimeModuleRegistry(createBuiltinRuntimeModules());
    const unavailable = createBuiltinToolCatalogProjection(registry, {
      turnContext: unavailableTurnContext,
    });
    const unavailableInput = privateTaskPrepared(unavailable);
    let unavailableCalls = 0;
    const unavailableAdapter = createBuiltinPreparedTaskDispatchAdapter({
      projection: unavailable,
      verifyPreparedIdentity: () => true,
      port: {
        dispatch: async (value) => {
          unavailableCalls += 1;
          return executionReceipt(value.prepared, operationValue(true));
        },
      },
    });
    await expect(unavailableAdapter.dispatch(unavailableInput)).rejects.toMatchObject({
      code: 'tool_unavailable',
    });
    expect(unavailableCalls).toBe(0);

    const catalog = projection();
    const input = privateTaskPrepared(catalog);
    let receiptCalls = 0;
    const receiptAdapter = createBuiltinPreparedTaskDispatchAdapter({
      projection: catalog,
      verifyPreparedIdentity: () => true,
      port: {
        dispatch: async (value) => {
          receiptCalls += 1;
          return executionReceipt(value.prepared, operationValue(true), {
            providerId: 'forged-provider',
          });
        },
      },
    });
    await expect(receiptAdapter.dispatch(input)).rejects.toMatchObject({
      code: 'identity_mismatch',
    });
    expect(receiptCalls).toBe(1);
  });

  test('ordinary adapter continues to reject Task and the candidate has no second authority', async () => {
    const catalog = projection();
    const input = privateTaskPrepared(catalog);
    let ordinaryCalls = 0;
    const ordinary = createBuiltinPreparedToolDispatchAdapter({
      projection: catalog,
      verifyPreparedIdentity: () => true,
      port: {
        dispatch: async (value) => {
          ordinaryCalls += 1;
          return executionReceipt(value.prepared, operationValue(true));
        },
      },
    });
    await expect(ordinary.dispatch(input)).rejects.toMatchObject({
      code: 'unsupported_operation',
    });
    expect(ordinaryCalls).toBe(0);

    const source = await Bun.file(
      new URL('../src/builtin-prepared-dispatch-adapter.ts', import.meta.url),
    ).text();
    expect(source).not.toContain('@kite-ai/runtime-host');
    expect(source).not.toContain('@kite-ai/agent-kernel');
    expect(source).not.toContain('createRuntimeModuleRegistry');
    expect(source).not.toContain('createBuiltinToolCatalogProjection(');
    expect(source).not.toContain('catch-old');
  });

  test('does not add a second exact-once authority to the Host bundle', () => {
    const input = prepared(projection(), 'builtin:read_file');
    const fixture = adapterFixture(input);
    expect(fixture.adapter.verifyPreparedIdentity).toBe(fixture.verify);
    expect(fixture.dispatchCalls).toBe(0);
  });

  test('projects existing Builtin operation success and failure facts into neutral terminal results', () => {
    const success = projectBuiltinOperationTerminalResult(operationValue(true, 'output'));
    expect(success).toMatchObject({
      status: 'success',
      content: [{ type: 'text', text: 'output' }],
      structuredContent: { schema: 'kite.builtin-operation-result.v1', ok: true },
    });

    const failure = projectBuiltinOperationTerminalResult(operationValue(false, '', 'denied'));
    expect(failure).toMatchObject({
      status: 'error',
      failure: { code: 'builtin_operation_failed', message: 'denied', retryable: false },
      structuredContent: { ok: false },
    });
  });

  test('projects valid coordination/runtime-action domain failures as rejected only on the entry path', async () => {
    const cases = [
      ['builtin:tool_search', 'coordination'],
      ['builtin:update_plan', 'runtime_action'],
      ['builtin:read_file', 'computer'],
    ] as const;

    for (const [operationId, expectedKind] of cases) {
      const catalog = projection();
      const entry = catalog.entries.find((candidate) => candidate.operationId === operationId);
      expect(entry?.kind).toBe(expectedKind);
      const input = prepared(catalog, operationId);
      let dispatchCalls = 0;
      const adapter = createBuiltinPreparedToolDispatchAdapter({
        projection: catalog,
        verifyPreparedIdentity: () => true,
        port: {
          dispatch: async ({ prepared: received }) => {
            dispatchCalls += 1;
            return executionReceipt(received, operationValue(false, '', 'bounded domain denial'));
          },
        },
      });

      const result = await adapter.dispatch(input);
      expect(result).toMatchObject({
        status: 'error',
        failure: {
          code: expectedKind === 'computer' ? 'builtin_operation_failed' : 'rejected',
          message: 'bounded domain denial',
          details: { ok: false, stderr: 'bounded domain denial' },
        },
      });
      expect(dispatchCalls).toBe(1);
    }

    // The exported projector has no projection-entry kind and therefore keeps
    // its standalone compatibility behavior.
    expect(
      projectBuiltinOperationTerminalResult(operationValue(false, '', 'bounded domain denial')),
    ).toMatchObject({
      failure: { code: 'builtin_operation_failed' },
    });
  });

  test('does not relabel a failed child model execution as a policy rejection', async () => {
    const catalog = projection();
    const input = privateTaskPrepared(catalog);
    const adapter = createBuiltinPreparedTaskDispatchAdapter({
      projection: catalog,
      verifyPreparedIdentity: () => true,
      port: {
        dispatch: async ({ prepared: received }) =>
          executionReceipt(
            received,
            Object.freeze({
              ...(operationValue(false, '', 'Sub-agent execution failed.') as unknown as Record<
                string,
                unknown
              >),
              subagentResult: Object.freeze({
                ok: false,
                terminalStatus: 'failed',
                summary: 'Sub-agent execution failed.',
              }),
            }) as unknown as BuiltinOperationExecutionValue,
          ),
      },
    });

    await expect(adapter.dispatch(input)).resolves.toMatchObject({
      status: 'error',
      failure: { code: 'builtin_operation_failed' },
    });
  });

  test('keeps cancellation precedence and never relabels provider failure or unknown receipts as rejection', async () => {
    const catalog = projection();
    const input = prepared(catalog, 'builtin:tool_search');
    let dispatchCalls = 0;
    const adapter = createBuiltinPreparedToolDispatchAdapter({
      projection: catalog,
      verifyPreparedIdentity: () => true,
      port: {
        dispatch: async ({ prepared: received }) => {
          dispatchCalls += 1;
          return executionReceipt(
            received,
            operationValue(false, '', 'cancelled by caller', 'cancelled'),
          );
        },
      },
    });
    const cancelled = await adapter.dispatch(input);
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      failure: { code: 'builtin_operation_failed', message: 'cancelled by caller' },
    });
    expect(dispatchCalls).toBe(1);

    for (const receiptStatus of ['failed', 'unknown'] as const) {
      let providerCalls = 0;
      const providerAdapter = createBuiltinPreparedToolDispatchAdapter({
        projection: catalog,
        verifyPreparedIdentity: () => true,
        port: {
          dispatch: async ({ prepared: received }) => {
            providerCalls += 1;
            return executionReceipt(received, undefined, {
              status: receiptStatus,
              failure: {
                code: `provider_${receiptStatus}`,
                message: `provider ${receiptStatus} diagnostic`,
                retryable: false,
              },
            });
          },
        },
      });
      const result = await providerAdapter.dispatch(input);
      expect(result).toMatchObject({
        status: receiptStatus === 'failed' ? 'error' : 'unknown',
        failure: { code: `provider_${receiptStatus}` },
      });
      expect(providerCalls).toBe(1);
    }
  });

  test('preserves every JSON-safe Builtin operation result field in structured content and details', () => {
    const successValue = Object.freeze({
      schema: 'kite.builtin-operation-result.v1' as const,
      ok: true,
      stdout: 'output',
      stderr: '',
      resultMeta: Object.freeze({ exitCode: 0 }),
      runtimeEvents: Object.freeze([
        Object.freeze({ type: 'capability.search_completed', count: 1 }),
      ]),
      capabilityResult: Object.freeze({ capability: 'read_file', result: 'ok' }),
      subagentResult: Object.freeze({ childStatus: 'completed' }),
      filesystemObservation: Object.freeze({ path: 'README.md', changed: false }),
      classifierAdvice: Object.freeze({ risk: 'read' }),
      terminationReason: 'sandbox_denied' as const,
      path: 'README.md',
      totalLines: 4,
    }) as BuiltinOperationExecutionValue;
    const success = projectBuiltinOperationTerminalResult(successValue);
    expect(success.structuredContent).toEqual(successValue);

    const failureValue = Object.freeze({
      schema: 'kite.builtin-operation-result.v1' as const,
      ok: false,
      stdout: '',
      stderr: 'denied',
      resultMeta: Object.freeze({ exitCode: 1 }),
      runtimeEvents: Object.freeze([
        Object.freeze({ type: 'capability.search_completed', count: 1 }),
      ]),
      capabilityResult: Object.freeze({ capability: 'read_file', result: 'denied' }),
      subagentResult: Object.freeze({ childStatus: 'failed' }),
      filesystemObservation: Object.freeze({ path: 'README.md', changed: false }),
      classifierAdvice: Object.freeze({ risk: 'unknown' }),
      terminationReason: 'cancelled' as const,
      path: 'README.md',
      totalLines: 4,
    }) as BuiltinOperationExecutionValue;
    const failure = projectBuiltinOperationTerminalResult(failureValue);
    expect(failure.structuredContent).toEqual(failureValue);
    expect(failure.failure?.details).toEqual(failureValue);
  });

  test('preserves all five confirmed receipt statuses without converting them to Host unknown', async () => {
    const statuses = [
      ['succeeded', 'success'],
      ['failed', 'error'],
      ['cancelled', 'cancelled'],
      ['timed_out', 'error'],
      ['unknown', 'unknown'],
    ] as const;
    for (const [receiptStatus, terminalStatus] of statuses) {
      const catalog = projection();
      const input = prepared(catalog, 'builtin:shell_execute');
      const adapter = createBuiltinPreparedToolDispatchAdapter({
        projection: catalog,
        verifyPreparedIdentity: () => true,
        port: {
          dispatch: async ({ prepared: received }) =>
            executionReceipt(
              received,
              receiptStatus === 'succeeded' ? operationValue(true, 'done') : undefined,
              {
                status: receiptStatus,
                failure: {
                  code: `provider_${receiptStatus}`,
                  message: `provider ${receiptStatus} diagnostic`,
                  retryable: receiptStatus === 'unknown',
                },
              },
            ),
        },
      });

      const result = await adapter.dispatch(input);
      expect(result.status).toBe(terminalStatus);
      if (receiptStatus === 'succeeded') {
        expect(result.structuredContent).toMatchObject({ ok: true });
      } else {
        expect(result.failure).toMatchObject({
          code: `provider_${receiptStatus}`,
          message: `provider ${receiptStatus} diagnostic`,
          retryable: receiptStatus === 'unknown',
        });
      }
    }
  });

  test('rejects receipt identity drift without returning terminal authority', async () => {
    const catalog = projection();
    const input = prepared(catalog, 'builtin:read_file');
    for (const overrides of [
      { invocationId: 'forged-invocation' },
      { attemptId: 'forged-attempt' },
      { providerId: 'forged-provider' },
      { executorRevision: 'forged-executor' },
    ] satisfies readonly Partial<ExecutionReceipt<BuiltinOperationExecutionValue>>[]) {
      const adapter = createBuiltinPreparedToolDispatchAdapter({
        projection: catalog,
        verifyPreparedIdentity: () => true,
        port: {
          dispatch: async ({ prepared: received }) =>
            executionReceipt(received, operationValue(true), overrides),
        },
      });

      await expect(adapter.dispatch(input)).rejects.toMatchObject({ code: 'identity_mismatch' });
    }
  });

  test('bounds provider failures and never exposes a raw diagnostic object', () => {
    const receipt = executionReceipt(prepared(projection(), 'builtin:read_file'), undefined, {
      status: 'failed',
      failure: {
        code: 'provider/secret value',
        message: { raw: 'Error: secret detail' } as unknown as string,
        retryable: true,
      },
    });
    const result = projectBuiltinExecutionReceiptTerminalResult(receipt);
    expect(result).toMatchObject({
      status: 'error',
      failure: {
        code: 'provider_secret_value',
        message: 'Builtin capability execution failed.',
        retryable: true,
      },
    });
    expect(JSON.stringify(result)).not.toContain('raw');
    expect(JSON.stringify(result)).not.toContain('Error: secret detail');
  });

  test('projects confirmed MCP read provider failures into a canonical Builtin value', async () => {
    const catalog = projection();
    const input = prepared(catalog, 'builtin:read_mcp_resource');
    const adapter = createBuiltinPreparedToolDispatchAdapter({
      projection: catalog,
      verifyPreparedIdentity: () => true,
      port: {
        dispatch: async ({ prepared: received }) =>
          executionReceipt(received, undefined, {
            status: 'failed',
            failure: {
              code: 'provider_auth_required',
              message: 'Login required.',
              retryable: false,
            },
          }),
      },
    });

    const terminal = await adapter.dispatch(input);
    expect(terminal).toMatchObject({
      status: 'error',
      structuredContent: {
        schema: 'kite.builtin-operation-result.v1',
        ok: false,
        stdout: '',
        stderr: 'Login required.',
        resultMeta: {
          providerFailure: { code: 'provider_auth_required', retryable: false },
        },
      },
      failure: {
        code: 'provider_auth_required',
        message: 'Login required.',
        retryable: false,
      },
    });
    expect(Object.isFrozen(terminal.structuredContent)).toBe(true);
  });

  test('projects only an exact dynamic MCP wrapper failure into a canonical Builtin value', () => {
    const catalog = projection();
    const entry = catalog.entries.find(
      (candidate) =>
        candidate.visibility === 'internal' && candidate.operationId === 'mcp:dynamic_tool',
    );
    if (entry?.visibility !== 'internal' || !entry.inputSchemaDigest) {
      throw new Error('Missing dynamic MCP wrapper entry.');
    }
    const base = dynamicPrepared();
    if (!base.identity.isDynamicMcp) throw new Error('Expected dynamic MCP fixture.');
    const input = freezeDeep({
      ...base,
      identity: {
        ...base.identity,
        runtimeWrapper: {
          operationId: 'mcp:dynamic_tool' as const,
          capabilityId: 'mcp:dynamic_tool',
          providerId: entry.providerId,
          capabilityRevision: entry.revision,
          executorRevision: entry.executorRevision,
          schemaDigest: entry.inputSchemaDigest,
          builtinProjectionRevision: catalog.revision,
        },
      },
    }) as Readonly<PreparedToolInvocation>;
    const receipt = executionReceipt(input, undefined, {
      providerId: entry.providerId,
      executorRevision: entry.executorRevision,
      status: 'failed',
      failure: {
        code: 'provider_unavailable',
        message: 'Dynamic provider unavailable.',
        retryable: true,
      },
    });

    const terminal = projectBuiltinDynamicMcpExecutionReceiptTerminalResult(receipt, entry, input);
    expect(terminal).toMatchObject({
      status: 'error',
      structuredContent: {
        schema: 'kite.builtin-operation-result.v1',
        ok: false,
        stdout: '',
        stderr: 'Dynamic provider unavailable.',
        resultMeta: {
          providerFailure: { code: 'provider_unavailable', retryable: true },
        },
      },
      failure: {
        code: 'provider_unavailable',
        message: 'Dynamic provider unavailable.',
        retryable: true,
      },
    });
    expect(Object.isFrozen(terminal.structuredContent)).toBe(true);
    expect(() =>
      projectBuiltinDynamicMcpExecutionReceiptTerminalResult(
        receipt,
        entry,
        structuredClone(input),
      ),
    ).toThrow(BuiltinPreparedToolDispatchError);
    expect(() =>
      projectBuiltinDynamicMcpExecutionReceiptTerminalResult(
        receipt,
        entry,
        freezeDeep({
          ...input,
          identity: {
            ...input.identity,
            runtimeWrapper: {
              ...(input.identity.isDynamicMcp ? input.identity.runtimeWrapper : {}),
              executorRevision: 'forged-executor',
            },
          },
        }) as Readonly<PreparedToolInvocation>,
      ),
    ).toThrow(BuiltinPreparedToolDispatchError);
  });

  test('accepts JSON-safe shared values but rejects an actual cycle', () => {
    const shared = { planId: 'plan-1' };
    const value = {
      schema: 'kite.builtin-operation-result.v1',
      ok: true,
      stdout: 'done',
      stderr: '',
      resultMeta: {},
      runtimeEvents: [
        { type: 'plan.progress_updated', plan: shared },
        { type: 'plan.completed', plan: shared },
      ],
    } as unknown as BuiltinOperationExecutionValue;
    const result = projectBuiltinExecutionReceiptTerminalResult(
      executionReceipt(prepared(projection(), 'builtin:read_file'), value),
    );
    expect(result.status).toBe('success');
    expect(JSON.stringify(result)).toContain('plan.completed');

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const cyclicValue = {
      schema: 'kite.builtin-operation-result.v1',
      ok: true,
      stdout: 'done',
      stderr: '',
      resultMeta: cyclic,
    } as unknown as BuiltinOperationExecutionValue;
    expect(() =>
      projectBuiltinExecutionReceiptTerminalResult(
        executionReceipt(prepared(projection(), 'builtin:read_file'), cyclicValue),
      ),
    ).toThrow();
  });

  test('does not create a second registry or import forbidden authority owners', async () => {
    const source = await Bun.file(
      new URL('../src/builtin-prepared-dispatch-adapter.ts', import.meta.url),
    ).text();
    expect(source).not.toContain('@kite-ai/runtime-host');
    expect(source).not.toContain('@kite-ai/agent-kernel');
    expect(source).not.toContain('createRuntimeModuleRegistry');
    expect(source).not.toContain('CapabilityExecutionPort');
    expect(source).not.toContain('catch-old');
  });
});
