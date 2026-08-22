import { describe, expect, test } from 'bun:test';
import {
  BUILTIN_MODEL_OPERATION_BY_PURPOSE_V1,
  BuiltinModelEffectCoordinatorV1,
  type BuiltinModelOperationAttemptV1,
  type BuiltinModelOperationExecutionPortV1,
  createChatModel,
  humanMessage,
  type ModelArtifactWriterV1,
  ModelInvocationGatewayV1,
  type ModelInvocationPersistenceV1,
  type ModelInvocationStateViewV1,
  type ModelResponseSourceV1,
  type ModelRuntimeConfigV1,
} from '@kite/builtin-runtime/model';
import {
  MODEL_ATTEMPT_OUTCOME_SCHEMA_V1,
  type ModelAttemptOutcomeV1,
  type PrivateArtifactRefV1,
} from '@kite/runtime-spi';

const CONFIG: ModelRuntimeConfigV1 = Object.freeze({
  apiKey: 'subagent-effect-fixture-key',
  baseURL: 'https://subagent-effect-fixture.invalid/v1',
  modelName: 'subagent-effect-fixture',
  providerName: 'subagent-effect-fixture',
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
        content: [{ type: 'text', text: 'subagent response' }],
      },
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13, cacheReadTokens: 6 },
      providerMetadata: { responseId: 'subagent-response', rawFinishReason: 'stop' },
    },
    nativeReplayState: null,
  };
}

function artifactRef<K extends 'model_surface' | 'model_response'>(
  kind: K,
): PrivateArtifactRefV1 & { kind: K } {
  return {
    artifactId: `subagent-${kind}`,
    kind,
    integrityIdentifier: 'hmac-sha256:subagent-effect-fixture',
    byteLength: 1,
  };
}

function persistence(options: { rejectCompletion?: boolean } = {}): ModelInvocationPersistenceV1 {
  const state: ModelInvocationStateViewV1 = Object.freeze({
    revision: 12,
    session: { threadId: 'subagent-thread' },
    turn: { turnId: 'subagent-turn' },
    resourceBudget: { status: 'unconfigured' },
  });
  return {
    getState: () => state,
    persistEvents: async (events) =>
      !(
        options.rejectCompletion &&
        events.some((event) => event.type === 'model.invocation_completed')
      ),
  };
}

function createFixture(options: { operationMismatch?: boolean; rejectCompletion?: boolean } = {}) {
  let operationCalls = 0;
  let sourceCalls = 0;
  let invocationOrdinal = 0;
  let observedOperationId: string | undefined;
  let observedModel: unknown;
  const source: ModelResponseSourceV1 = Object.freeze({
    attempt: async (input: Parameters<ModelResponseSourceV1['attempt']>[0]) => {
      sourceCalls += 1;
      observedModel = input.model;
      return successfulOutcome();
    },
  });
  const operationExecution: BuiltinModelOperationExecutionPortV1 = Object.freeze({
    execute: async (attempt: BuiltinModelOperationAttemptV1) => {
      operationCalls += 1;
      observedOperationId = attempt.operationId;
      if (options.operationMismatch) throw new Error('subagent operation identity mismatch');
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
      next: () => `subagent-invocation-${++invocationOrdinal}`,
      now: () => 2_000,
    },
    now: () => 2_000,
    sleep: async () => {},
  });
  return {
    gateway,
    persistence: persistence({ rejectCompletion: options.rejectCompletion }),
    counts: () => ({ operationCalls, sourceCalls, observedOperationId, observedModel }),
  };
}

function baseInput(fixture: ReturnType<typeof createFixture>) {
  return {
    config: CONFIG,
    model: MODEL,
    tools: {},
    messages: [humanMessage('Inspect the bounded child task.')],
    persistence: fixture.persistence,
    provenance: {
      parentInvocationId: 'parent-invocation',
      parentToolCallId: 'parent-tool-call',
      contextCheckpointId: 'checkpoint-12',
      promptContractVersion: 'prompt-contract-v2',
      projectionEnvironment: {
        role: 'explore',
        projectInstructions: null,
        workspaceAccess: 'write',
        phase: 'building',
      },
      capabilityBindings: [],
    },
    maxOutputTokens: 64,
    estimatedInputTokens: 32,
    providerDataPolicyRequired: false,
    parentReservationId: 'parent-reservation',
  };
}

describe('Builtin subagent model effect', () => {
  test('uses the coordinator Gateway and model:subagent operation exactly once', async () => {
    const fixture = createFixture();
    const coordinator = new BuiltinModelEffectCoordinatorV1(fixture.gateway);

    const result = await coordinator.executeSubagentModelStepV1(baseInput(fixture));

    expect(result).toMatchObject({
      invocationId: 'subagent-invocation-1',
      message: { type: 'ai', content: 'subagent response' },
      cacheMetrics: {
        inputTokens: 10,
        cacheHitTokens: 6,
        cacheMissTokens: 4,
        hitRate: 0.6,
      },
    });
    expect(fixture.counts()).toMatchObject({
      operationCalls: 1,
      sourceCalls: 1,
      observedOperationId: BUILTIN_MODEL_OPERATION_BY_PURPOSE_V1.subagent,
    });
  });

  test('fails closed with missing persistence before operation/source dispatch', async () => {
    const fixture = createFixture();
    const coordinator = new BuiltinModelEffectCoordinatorV1(fixture.gateway);

    await expect(
      coordinator.executeSubagentModelStepV1({
        ...baseInput(fixture),
        persistence: undefined,
      }),
    ).rejects.toThrow('ModelInvocationGateway execution context is unavailable');
    expect(fixture.counts()).toMatchObject({ operationCalls: 0, sourceCalls: 0 });
  });

  test('fails closed on Provider denial before operation/source dispatch', async () => {
    const fixture = createFixture();
    const coordinator = new BuiltinModelEffectCoordinatorV1(fixture.gateway);

    await expect(
      coordinator.executeSubagentModelStepV1({
        ...baseInput(fixture),
        providerDataPolicyRequired: true,
        providerDataAdmission: () => ({
          admitted: false,
          reason: 'provider_data_classification_denied',
          routeAlias: 'subagent-denied',
        }),
      }),
    ).rejects.toThrow('provider_data_classification_denied');
    expect(fixture.counts()).toMatchObject({ operationCalls: 0, sourceCalls: 0 });
  });

  test('fails closed on operation identity mismatch before source dispatch', async () => {
    const fixture = createFixture({ operationMismatch: true });
    const coordinator = new BuiltinModelEffectCoordinatorV1(fixture.gateway);

    await expect(coordinator.executeSubagentModelStepV1(baseInput(fixture))).rejects.toThrow(
      'operation identity mismatch',
    );
    expect(fixture.counts()).toMatchObject({ operationCalls: 1, sourceCalls: 0 });
  });

  test('does not expose a normalized response when completion commit fails', async () => {
    const fixture = createFixture({ rejectCompletion: true });
    const coordinator = new BuiltinModelEffectCoordinatorV1(fixture.gateway);
    let result: unknown;

    await expect(
      coordinator.executeSubagentModelStepV1(baseInput(fixture)).then((value) => {
        result = value;
        return value;
      }),
    ).rejects.toThrow('acknowledgement was rejected');
    expect(result).toBeUndefined();
    expect(fixture.counts()).toMatchObject({ operationCalls: 1, sourceCalls: 1 });
  });
});
