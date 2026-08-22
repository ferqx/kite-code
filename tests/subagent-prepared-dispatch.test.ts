import { describe, expect, test } from 'bun:test';
import type { BuiltinOperationExecutionValueV1 } from '@kite/builtin-runtime';
import {
  BUILTIN_PREPARED_CALL_FACTS_SCHEMA_V1,
  createBuiltinPreparedTaskDispatchAdapterV1,
  createBuiltinRuntimeModules,
  createBuiltinToolCatalogProjectionV1,
  digestCapabilityBindingValueV1,
} from '@kite/builtin-runtime';
import type {
  ExecutionReceiptV1,
  NonDynamicOperationIdV1,
  NonDynamicPreparedToolInvocationIdentityV1,
  PreparedToolInvocationV1,
  RuntimeJsonValueV1,
  ToolPipelineAttemptAcknowledgementV1,
  ToolPipelineOutcomeDispatchV1,
  ToolPipelinePersistenceV1,
} from '@kite/runtime-spi';
import { createAppToolPipelineAttemptCompositionV1 } from '#app/bootstrap/runtime/tool-pipeline-attempt-composition';
import { createRuntimeModuleRegistryV1 } from '#runtime-spi';

const TURN_ID = 'turn-subagent-prepared-dispatch';
const THREAD_ID = 'thread-subagent-prepared-dispatch';
const WORKSPACE = '/workspace';
const REGISTRY = createRuntimeModuleRegistryV1(createBuiltinRuntimeModules());
const PROJECTION = createBuiltinToolCatalogProjectionV1(REGISTRY.snapshot()).forTurn({
  workspace: WORKSPACE,
  threadId: THREAD_ID,
  turnId: TURN_ID,
  phase: 'building',
  hasTaskAdapter: true,
});
type ProjectionEntryV1 = (typeof PROJECTION.entries)[number];
type TaskCatalogEntryV1 = Omit<
  Extract<ProjectionEntryV1, { visibility: 'model' }>,
  'name' | 'inputSchemaDigest' | 'kind'
> & {
  readonly name: string;
  readonly inputSchemaDigest: string;
  readonly kind: Exclude<ProjectionEntryV1['kind'], 'internal_runtime'>;
};

function assertTaskEntryV1(
  entry: ProjectionEntryV1 | undefined,
): asserts entry is TaskCatalogEntryV1 {
  if (
    entry?.visibility !== 'model' ||
    entry.operationId !== 'builtin:task' ||
    entry.kind === 'internal_runtime' ||
    typeof entry.name !== 'string' ||
    !entry.inputSchemaDigest
  ) {
    throw new Error('Builtin task catalog fixture is unavailable.');
  }
}
const taskEntryCandidate = PROJECTION.entries.find(
  (entry) => entry.visibility === 'model' && entry.operationId === 'builtin:task',
);
assertTaskEntryV1(taskEntryCandidate);
const TASK_ENTRY: TaskCatalogEntryV1 = taskEntryCandidate;

const TASK_ARGUMENTS = Object.freeze({
  subagent_type: 'code' as const,
  taskArtifact: Object.freeze({
    artifactId: `pa_${'a'.repeat(64)}`,
    kind: 'subagent_task_request' as const,
    integrityIdentifier: `hmac-sha256:${'b'.repeat(64)}`,
    byteLength: 32,
  }),
});

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

function operationValue(): BuiltinOperationExecutionValueV1 {
  return freezeDeep({
    schema: 'kite.builtin-operation-result.v1' as const,
    ok: true,
    stdout: 'fixture child completed',
    stderr: '',
    resultMeta: {},
  });
}

function preparedTask(
  overrides: Partial<NonDynamicPreparedToolInvocationIdentityV1> = {},
  argumentsValue: RuntimeJsonValueV1 = TASK_ARGUMENTS,
): Readonly<PreparedToolInvocationV1> {
  const canonical = TASK_ENTRY.parser.canonicalize(argumentsValue);
  if (typeof canonical !== 'object' || canonical === null || Array.isArray(canonical)) {
    throw new Error('Task parser did not produce an object.');
  }
  const canonicalRecord = canonical as Readonly<Record<string, RuntimeJsonValueV1>>;
  const role = canonicalRecord.subagent_type;
  if (typeof role !== 'string') throw new Error('Task parser did not produce a role.');
  const classification = TASK_ENTRY.classifyEffects(canonical);
  const schemaDigest = TASK_ENTRY.parser.schemaDigest ?? TASK_ENTRY.inputSchemaDigest;
  const identity: NonDynamicPreparedToolInvocationIdentityV1 = {
    invocationId: 'invocation-task-1',
    attemptId: 'invocation-task-1:attempt:1',
    toolCallId: 'task-call',
    turnId: TURN_ID,
    modelMessageId: 'model-message',
    argumentOrigin: 'runtime_private',
    providerId: TASK_ENTRY.providerId,
    operationId: TASK_ENTRY.operationId as NonDynamicOperationIdV1,
    executionFamily: 'subagent',
    executionMechanism: 'subagent',
    capabilityId: TASK_ENTRY.capabilityId,
    capabilityRevision: TASK_ENTRY.revision,
    descriptorRevision: TASK_ENTRY.descriptor.revision,
    parserRevision: TASK_ENTRY.parser.parserRevision,
    executorRevision: TASK_ENTRY.executorRevision,
    argumentsDigest: digestCapabilityBindingValueV1(canonical),
    schemaDigest,
    effectiveEffectsDigest: digestCapabilityBindingValueV1(classification.effectiveEffects),
    policyDigest: 'policy-task-1',
    authorizationDigest: 'authorization-task-1',
    admissionDigest: 'admission-task-1',
    idempotencyKeyArgument: TASK_ENTRY.execution?.idempotencyKeyArgument ?? null,
    idempotencyKey: null,
    bindingId: null,
    visibility: 'model',
    modelVisible: true,
    exposedToolName: TASK_ENTRY.name,
    builtinProjectionRevision: PROJECTION.revision,
    dynamicCatalogRevision: null,
    nestedCapabilityId: null,
    nestedCapabilityRevision: null,
    nestedCatalogRevision: null,
    isDynamicMcp: false,
    toolKind: TASK_ENTRY.kind,
    ...overrides,
  };
  const facts = {
    schema: BUILTIN_PREPARED_CALL_FACTS_SCHEMA_V1,
    toolCallId: identity.toolCallId,
    callCreatedAtTurnId: identity.turnId,
    modelMessageId: identity.modelMessageId,
    argumentOrigin: 'runtime_private' as const,
    dynamicCatalogRevision: null,
    approvalSummary: TASK_ENTRY.projectApprovalSummary(canonical),
    privateTaskProjection: true,
    subagentRole: role,
    nestedCapabilityId: null,
    nestedCapabilityRevision: null,
    nestedSkill: null,
  };
  const effectiveEffects = {
    filesystem: classification.effectiveEffects.filesystem,
    network: classification.effectiveEffects.network,
    externalState: classification.effectiveEffects.externalState,
  };
  const request = {
    schema: 'kite.tool-pipeline-prepared-request.v1' as const,
    authorizationKind: 'approved_call' as const,
    grantUsed: 'approve_once' as const,
    policyEffects: {},
    effectiveEffects,
    receiptRequirement: 'observation_receipt' as const,
    retryEligibility: 'none' as const,
    taskId: null,
    planId: null,
    planStepId: null,
    capabilityRequestFacts: null,
  };
  return freezeDeep({
    identity,
    input: {
      invocationId: identity.invocationId,
      attemptId: identity.attemptId,
      toolCallId: identity.toolCallId,
      arguments: canonical,
      request,
      binding: null,
      facts,
    },
  });
}

function preparedWithFacts(
  prepared: Readonly<PreparedToolInvocationV1>,
  facts: RuntimeJsonValueV1,
): Readonly<PreparedToolInvocationV1> {
  return freezeDeep({
    ...prepared,
    input: {
      ...prepared.input,
      facts,
    },
  });
}

function executionReceipt(
  prepared: Readonly<PreparedToolInvocationV1>,
  value: BuiltinOperationExecutionValueV1,
): ExecutionReceiptV1<RuntimeJsonValueV1> {
  return {
    invocationId: prepared.identity.invocationId,
    attemptId: prepared.identity.attemptId,
    providerId: TASK_ENTRY.providerId,
    executorRevision: TASK_ENTRY.executorRevision,
    requestDigest: digestCapabilityBindingValueV1(prepared.input.arguments),
    status: 'succeeded',
    dispatchCertainty: 'attempted',
    cleanupCertainty: 'not_required',
    value,
  };
}

function acknowledgement(
  prepared: Readonly<PreparedToolInvocationV1>,
): ToolPipelineAttemptAcknowledgementV1 {
  const identity = prepared.identity;
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
      recordedAt: '2026-08-21T00:00:00.000Z',
      startedAt: '2026-08-21T00:00:00.000Z',
    },
  };
}

function fixture(
  options: {
    readonly prepared?: Readonly<PreparedToolInvocationV1>;
    readonly verify?: (prepared: Readonly<PreparedToolInvocationV1>) => boolean;
    readonly persist?: boolean;
    readonly hostStatus?: ExecutionReceiptV1['status'];
  } = {},
) {
  const prepared = options.prepared ?? preparedTask();
  let suppliedPortCalls = 0;
  let childCalls = 0;
  const adapter = createBuiltinPreparedTaskDispatchAdapterV1({
    projection: PROJECTION,
    verifyPreparedIdentity: options.verify ?? (() => true),
    port: {
      dispatch: async (input) => {
        suppliedPortCalls += 1;
        if (options.hostStatus === 'unknown') throw new Error('supplied port failure');
        childCalls += 1;
        return executionReceipt(input.prepared, operationValue());
      },
    },
  });
  const events: string[] = [];
  let recordCalls = 0;
  let dispatchCalls = 0;
  let commitCalls = 0;
  let unknownCalls = 0;
  const persistence: ToolPipelinePersistenceV1 = {
    recordAttempt: async (candidate) => {
      events.push('record');
      recordCalls += 1;
      if (options.persist === false) {
        const recorded = acknowledgement(candidate);
        return {
          ...recorded,
          attempt: { ...recorded.attempt, attemptId: 'tampered-attempt' },
        };
      }
      return acknowledgement(candidate);
    },
    recordUnknown: async () => {
      events.push('unknown');
      unknownCalls += 1;
    },
    commitTerminal: async () => {
      events.push('commit');
      commitCalls += 1;
    },
    commitSuspension: async () => {
      throw new Error('Task fixture does not suspend.');
    },
  };
  const dispatch: ToolPipelineOutcomeDispatchV1 = {
    verifyPreparedIdentity: adapter.verifyPreparedIdentity,
    dispatch: async (candidate) => {
      dispatchCalls += 1;
      const terminal = await adapter.dispatch(candidate);
      return { kind: 'committed', terminal };
    },
  };
  const composition = createAppToolPipelineAttemptCompositionV1({ persistence, dispatch });
  const authority = composition.prepare(prepared.identity, prepared.input);
  return {
    adapter,
    composition,
    authority,
    counters: {
      get host() {
        return suppliedPortCalls;
      },
      get child() {
        return childCalls;
      },
      get record() {
        return recordCalls;
      },
      get dispatch() {
        return dispatchCalls;
      },
      get commit() {
        return commitCalls;
      },
      get unknown() {
        return unknownCalls;
      },
    },
    events,
  };
}

describe('prepared Builtin Task dispatch', () => {
  test('uses one acknowledged Host invocation and one child runtime execution', async () => {
    const value = fixture();
    const result = await value.composition.execute(value.authority);

    expect(result.kind).toBe('committed');
    expect(value.counters.record).toBe(1);
    expect(value.counters.dispatch).toBe(1);
    expect(value.counters.host).toBe(1);
    expect(value.counters.child).toBe(1);
    expect(value.counters.commit).toBe(1);
    expect(value.events).toEqual(['record', 'commit']);
  });

  test('preserves the exact Builtin verifier reference and rejects a second Host attempt', async () => {
    const prepared = preparedTask();
    let verifierCalls = 0;
    const value = fixture({
      prepared,
      verify: (candidate) => {
        verifierCalls += 1;
        return candidate.identity.invocationId === prepared.identity.invocationId;
      },
    });

    expect(value.composition.verifyPreparedIdentity).toBe(value.adapter.verifyPreparedIdentity);
    await value.composition.execute(value.authority);
    expect(verifierCalls).toBe(1);
    expect(value.counters.host).toBe(1);
    await expect(value.composition.execute(value.authority)).rejects.toMatchObject({
      code: 'duplicate_attempt',
    });
    expect(value.counters.host).toBe(1);
  });

  test.each([
    'missing private task facts',
    'public argument origin',
    'identity revision mismatch',
  ])('rejects Task identity drift before Host and child: %s', async (name) => {
    const base = preparedTask();
    const prepared =
      name === 'missing private task facts'
        ? preparedWithFacts(base, {})
        : name === 'public argument origin'
          ? preparedTask({ argumentOrigin: 'model_public' })
          : preparedTask({ capabilityRevision: 'tampered-capability-revision' });
    const value = fixture({ prepared });
    await expect(value.adapter.dispatch(prepared)).rejects.toBeTruthy();
    expect(value.counters.host).toBe(0);
    expect(value.counters.child).toBe(0);
  });

  test('rejects tampered or mutable packets before the supplied Host port', async () => {
    const value = fixture();
    const mutable = {
      ...value.authority,
      input: {
        ...value.authority.input,
        arguments: { ...TASK_ARGUMENTS, tampered: true },
      },
    } as Readonly<PreparedToolInvocationV1>;
    await expect(value.adapter.dispatch(mutable)).rejects.toBeTruthy();
    expect(value.counters.host).toBe(0);
    expect(value.counters.child).toBe(0);
  });

  test('fails closed before dispatch when identity verification or persistence acknowledgement fails', async () => {
    const identityFailure = fixture({ verify: () => false });
    await expect(
      identityFailure.composition.execute(identityFailure.authority),
    ).rejects.toMatchObject({
      code: 'verification_failed',
    });
    expect(identityFailure.counters.record).toBe(0);
    expect(identityFailure.counters.dispatch).toBe(0);
    expect(identityFailure.counters.host).toBe(0);
    expect(identityFailure.counters.child).toBe(0);

    const persistenceFailure = fixture({ persist: false });
    await expect(
      persistenceFailure.composition.execute(persistenceFailure.authority),
    ).rejects.toMatchObject({
      code: 'acknowledgement_failed',
    });
    expect(persistenceFailure.counters.record).toBe(1);
    expect(persistenceFailure.counters.dispatch).toBe(0);
    expect(persistenceFailure.counters.host).toBe(0);
    expect(persistenceFailure.counters.child).toBe(0);
  });

  test('keeps prepared packet deeply frozen across the acknowledged seam', async () => {
    const value = fixture();
    expect(Object.isFrozen(value.authority)).toBe(true);
    expect(Object.isFrozen(value.authority.identity)).toBe(true);
    expect(Object.isFrozen(value.authority.input)).toBe(true);
    expect(Object.isFrozen(value.authority.input.arguments)).toBe(true);
    expect(Reflect.set(value.authority.input.arguments as object, 'task', 'tampered')).toBe(false);
    await value.composition.execute(value.authority);
    expect(value.counters.host).toBe(1);
    expect(value.counters.child).toBe(1);
  });

  test('does not fall back after a post-ack Host failure', async () => {
    const value = fixture({ hostStatus: 'unknown' });
    await expect(value.composition.execute(value.authority)).rejects.toMatchObject({
      code: 'unknown_outcome',
    });
    expect(value.counters.record).toBe(1);
    expect(value.counters.dispatch).toBe(1);
    expect(value.counters.host).toBe(1);
    expect(value.counters.child).toBe(0);
    expect(value.counters.unknown).toBe(1);
  });
});
