import { describe, expect, test } from 'bun:test';
import {
  BUILTIN_MODEL_OPERATION_BY_PURPOSE_V1,
  BuiltinModelEffectCoordinatorV1,
  type BuiltinModelOperationAttemptV1,
  type BuiltinModelOperationExecutionPortV1,
  type BuiltinPrimaryModelCompletionV1,
  type BuiltinPrimaryModelContextMetricsV1,
  type BuiltinPrimaryModelStateV1,
  createChatModel,
  type ModelArtifactWriterV1,
  ModelInvocationGatewayV1,
  type ModelInvocationPersistenceV1,
  type ModelResponseSourceV1,
  type ModelRuntimeConfigV1,
} from '@kite/builtin-runtime/model';
import {
  MODEL_ATTEMPT_OUTCOME_SCHEMA_V1,
  type ModelAttemptOutcomeV1,
  type PrivateArtifactRefV1,
} from '@kite/runtime-spi';

const CONFIG: ModelRuntimeConfigV1 = Object.freeze({
  apiKey: 'primary-effect-fixture-key',
  baseURL: 'https://primary-effect-fixture.invalid/v1',
  modelName: 'primary-effect-fixture',
  providerName: 'primary-effect-fixture',
  providerType: 'openai-compatible',
  sandbox: Object.freeze({ enabled: false }),
});

const MODEL = createChatModel(CONFIG);

function successfulOutcome(): ModelAttemptOutcomeV1 {
  return {
    schema: MODEL_ATTEMPT_OUTCOME_SCHEMA_V1,
    kind: 'success',
    response: {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'primary response' }],
      },
      finishReason: 'stop',
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5, cacheReadTokens: null },
      providerMetadata: { responseId: 'primary-response', rawFinishReason: 'stop' },
    },
    nativeReplayState: null,
  };
}

function artifactRef<K extends 'model_surface' | 'model_response'>(
  kind: K,
): PrivateArtifactRefV1 & { kind: K } {
  return {
    artifactId: `primary-${kind}`,
    kind,
    integrityIdentifier: 'hmac-sha256:primary-effect-fixture',
    byteLength: 1,
  };
}

function stateWithHistory(turns = 3): BuiltinPrimaryModelStateV1 {
  return {
    activeTaskId: null,
    tasks: {},
    revision: 7,
    session: {
      workspace: '/workspace',
      threadId: 'primary-thread',
      projectId: 'project_primary_test',
    },
    turn: { turnId: `turn-${turns - 1}`, turnIndex: turns - 1, status: 'completed' },
    transcript: {
      messages: Array.from({ length: turns }, (_, index) => ({
        kind: 'user' as const,
        messageId: `message-${index}`,
        turnId: `turn-${index}`,
        ordinal: index,
        createdAt: `2026-08-21T00:00:0${index}.000Z`,
        content: 'primary effect context '.repeat(200),
      })),
    },
    context: {
      autoGuard: {
        recentAutomaticCompactions: [],
        consecutiveLowGain: 0,
        disabledUntilManualAction: false,
        recoveryAttempted: false,
      },
    },
    interactions: { kind: 'idle' },
    tools: { calls: {} },
    authorization: { mode: 'default' },
    mode: 'accept_edits',
  };
}

function projectionEnvironment() {
  return {
    serializedTools: [],
    workflowSkills: [],
    promptContractVersion: 'legacy' as const,
    sandboxBackend: 'none' as const,
  };
}

function persistence(
  state: BuiltinPrimaryModelStateV1,
): ModelInvocationPersistenceV1<BuiltinPrimaryModelStateV1> {
  return {
    getState: () => state,
    persistEvents: async () => true,
  };
}

function createGatewayFixture() {
  let operationCalls = 0;
  let sourceCalls = 0;
  let invocationOrdinal = 0;
  let purpose: string | undefined;
  const source: ModelResponseSourceV1 = Object.freeze({
    attempt: async () => {
      sourceCalls += 1;
      return successfulOutcome();
    },
  });
  const operationExecution: BuiltinModelOperationExecutionPortV1 = Object.freeze({
    execute: async (attempt: BuiltinModelOperationAttemptV1) => {
      operationCalls += 1;
      purpose = attempt.purpose;
      expect(attempt.operationId).toBe(BUILTIN_MODEL_OPERATION_BY_PURPOSE_V1.primary_agent);
      expect(attempt.purpose).toBe('primary_agent');
      return attempt.attempt();
    },
  });
  const artifacts: ModelArtifactWriterV1 = {
    writeSurface: () => artifactRef('model_surface'),
    writeResponse: () => artifactRef('model_response'),
  };
  const gateway = new ModelInvocationGatewayV1({
    artifacts,
    source,
    operationExecution,
    runtimeIdSource: {
      next: () => `primary-invocation-${++invocationOrdinal}`,
      now: () => 10_000,
    },
    now: () => 10_000,
    sleep: async () => {},
  });
  return {
    gateway,
    counts: () => ({ operationCalls, sourceCalls, purpose }),
  };
}

function baseInput(state = stateWithHistory()) {
  return {
    config: CONFIG,
    model: MODEL,
    state,
    tools: {},
    projectionEnvironment: projectionEnvironment(),
    capabilityBindingFacts: {
      catalogRevision: 'dynamic-mcp-skills-v1',
      bindings: [],
      disclosures: [],
    },
    providerDataAdmission: () => ({
      admitted: true,
      reason: 'admitted' as const,
      routeAlias: 'test',
      maxWorkspaceDataClassification: 'confidential' as const,
    }),
    autoCompaction: { masterEnabled: false },
    now: () => 10_000,
    finalize: (
      completion: BuiltinPrimaryModelCompletionV1,
      contextMetrics: BuiltinPrimaryModelContextMetricsV1,
    ) => ({
      events: [],
      value: { completion, contextMetrics },
    }),
  };
}

describe('Builtin primary Model effect execution', () => {
  test('returns automatic compaction before Gateway, operation, or source dispatch', async () => {
    const fixture = createGatewayFixture();
    const coordinator = new BuiltinModelEffectCoordinatorV1(fixture.gateway);
    const result = await coordinator.executePrimaryModelEffectV1({
      ...baseInput(),
      config: {
        ...CONFIG,
        compaction: {
          autoMode: 'live',
          compactAfterEstimatedTokens: 1,
          minimumReductionRatio: 0,
        },
      },
      autoCompaction: {
        masterEnabled: true,
        compactionId: 'compaction-from-facts',
      },
      persistence: undefined,
    });

    expect(result.kind).toBe('automatic_compaction');
    if (result.kind === 'automatic_compaction') {
      expect(result.terminal).toMatchObject({
        type: 'context.compaction_requested',
        compactionId: 'compaction-from-facts',
        requestedAtRevision: 7,
        requestedAtTurnId: 'turn-2',
      });
      expect(Object.isFrozen(result.contextMetrics)).toBe(true);
      expect(Object.isFrozen(result.terminal)).toBe(true);
    }
    expect(fixture.counts()).toEqual({ operationCalls: 0, sourceCalls: 0, purpose: undefined });
  });

  test('rejects a resource estimate mismatch before any external dispatch', async () => {
    const fixture = createGatewayFixture();
    const coordinator = new BuiltinModelEffectCoordinatorV1(fixture.gateway);

    await expect(
      coordinator.executePrimaryModelEffectV1({
        ...baseInput(),
        resourceAdmission: { inputTokens: 1, maxOutputTokens: 20 },
        persistence: persistence(stateWithHistory()),
      }),
    ).rejects.toThrow('projection changed after resource admission');
    expect(fixture.counts()).toEqual({ operationCalls: 0, sourceCalls: 0, purpose: undefined });
  });

  test('rejects missing persistence only on the dispatching path', async () => {
    const fixture = createGatewayFixture();
    const coordinator = new BuiltinModelEffectCoordinatorV1(fixture.gateway);

    await expect(
      coordinator.executePrimaryModelEffectV1({
        ...baseInput(),
        persistence: undefined,
      }),
    ).rejects.toThrow('ModelInvocationGateway execution context is unavailable');
    expect(fixture.counts()).toEqual({ operationCalls: 0, sourceCalls: 0, purpose: undefined });
  });

  test('passes provider denial to the Gateway before operation/source dispatch', async () => {
    const fixture = createGatewayFixture();
    const coordinator = new BuiltinModelEffectCoordinatorV1(fixture.gateway);

    await expect(
      coordinator.executePrimaryModelEffectV1({
        ...baseInput(),
        providerDataAdmission: () => ({
          admitted: false,
          reason: 'provider_data_classification_denied',
          routeAlias: 'primary-denied',
        }),
        persistence: persistence(stateWithHistory()),
      }),
    ).rejects.toThrow('provider_data_classification_denied');
    expect(fixture.counts()).toEqual({ operationCalls: 0, sourceCalls: 0, purpose: undefined });
  });

  test('uses the coordinator Gateway once for primary_agent and preserves stable metrics', async () => {
    const fixture = createGatewayFixture();
    const coordinator = new BuiltinModelEffectCoordinatorV1(fixture.gateway);
    const input = {
      ...baseInput(),
      persistence: persistence(stateWithHistory()),
    };
    const first = await coordinator.executePrimaryModelEffectV1(input);
    const second = await coordinator.executePrimaryModelEffectV1(input);

    expect(first.kind).toBe('completed');
    expect(second.kind).toBe('completed');
    if (first.kind === 'completed' && second.kind === 'completed') {
      expect(first.value.contextMetrics).toEqual(second.value.contextMetrics);
      expect(first.value.contextMetrics).toMatchObject({ type: 'model.context_metrics' });
      expect(first.value.completion).toMatchObject({
        invocationId: 'primary-invocation-1',
        messageId: 'primary-response',
        durationMs: 0,
        text: 'primary response',
        inputTokens: 2,
        outputTokens: 3,
      });
    }
    expect(fixture.counts()).toEqual({
      operationCalls: 2,
      sourceCalls: 2,
      purpose: 'primary_agent',
    });
  });
});
