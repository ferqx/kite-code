import { describe, expect, test } from 'bun:test';
import {
  BUILTIN_MODEL_OPERATION_BY_PURPOSE_,
  BuiltinModelEffectCoordinator,
  type BuiltinModelEvent,
  type BuiltinModelOperationAttempt,
  type BuiltinModelOperationExecutionPort,
  type BuiltinPrimaryModelCompletion,
  type BuiltinPrimaryModelContextMetrics,
  type BuiltinPrimaryModelState,
  buildContextProjection,
  createChatModel,
  estimateContextTokens,
  humanMessage,
  type ModelArtifactWriter,
  ModelInvocationGateway,
  type ModelInvocationPersistence,
  type ModelResponseSource,
  type ModelResponseSourceAttemptInput,
  type ModelRuntimeConfig,
} from '@kite-ai/builtin-runtime/model';
import {
  MODEL_ATTEMPT_OUTCOME_SCHEMA_,
  type ModelAttemptOutcome,
  type PrivateArtifactRef,
} from '@kite-ai/runtime-spi';

const CONFIG: ModelRuntimeConfig = Object.freeze({
  apiKey: 'primary-effect-fixture-key',
  baseURL: 'https://primary-effect-fixture.invalid/v1',
  modelName: 'primary-effect-fixture',
  providerName: 'primary-effect-fixture',
  providerType: 'openai-compatible',
  sandbox: Object.freeze({ enabled: false }),
});

const MODEL = createChatModel(CONFIG);

function successfulOutcome(): ModelAttemptOutcome {
  return {
    schema: MODEL_ATTEMPT_OUTCOME_SCHEMA_,
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
): PrivateArtifactRef & { kind: K } {
  return {
    artifactId: `primary-${kind}`,
    kind,
    integrityIdentifier: 'sha256:primary-effect-fixture',
    byteLength: 1,
  };
}

function stateWithHistory(turns = 3): BuiltinPrimaryModelState {
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
  state: BuiltinPrimaryModelState,
): ModelInvocationPersistence<BuiltinPrimaryModelState> {
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
  let providerOptions: unknown;
  let surfaceMessages: unknown;
  const source: ModelResponseSource = Object.freeze({
    attempt: async (input: ModelResponseSourceAttemptInput) => {
      sourceCalls += 1;
      providerOptions = input.surface.request.providerOptions;
      surfaceMessages = input.surface.request.messages;
      return successfulOutcome();
    },
  });
  const operationExecution: BuiltinModelOperationExecutionPort = Object.freeze({
    execute: async (attempt: BuiltinModelOperationAttempt) => {
      operationCalls += 1;
      purpose = attempt.purpose;
      expect(attempt.operationId).toBe(BUILTIN_MODEL_OPERATION_BY_PURPOSE_.primary_agent);
      expect(attempt.purpose).toBe('primary_agent');
      return attempt.attempt();
    },
  });
  const artifacts: ModelArtifactWriter = {
    writeSurface: () => artifactRef('model_surface'),
    writeResponse: () => artifactRef('model_response'),
  };
  const gateway = new ModelInvocationGateway({
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
    providerOptions: () => providerOptions,
    surfaceMessages: () => surfaceMessages,
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
      completion: BuiltinPrimaryModelCompletion,
      contextMetrics: BuiltinPrimaryModelContextMetrics,
    ) => ({
      events: [],
      value: { completion, contextMetrics },
    }),
  };
}

describe('Builtin primary Model effect execution', () => {
  test('persists the accepted first-attempt timeout before one Provider dispatch', async () => {
    const fixture = createGatewayFixture();
    const state = stateWithHistory();
    const eventBatches: string[][] = [];
    const limits: Array<{
      perAttemptTimeoutMs: number;
      totalTimeBudgetMs: number;
      maxAttempts: number;
    }> = [];
    const boundedPersistence: ModelInvocationPersistence<
      BuiltinPrimaryModelState,
      BuiltinModelEvent
    > = {
      getState: () => state,
      persistEvents: async (events) => {
        eventBatches.push(events.map((event) => event.type));
        for (const event of events) {
          if (event.type === 'model.invocation_prepared')
            limits.push(event.limits as (typeof limits)[number]);
        }
        return true;
      },
    };
    const result = await new BuiltinModelEffectCoordinator(
      fixture.gateway,
    ).executePrimaryModelEffect({
      ...baseInput(state),
      firstAttemptTimeoutMs: 250,
      persistence: boundedPersistence,
    });
    expect(result.kind).toBe('completed');
    expect(limits).toEqual([{ maxAttempts: 1, perAttemptTimeoutMs: 250, totalTimeBudgetMs: 250 }]);
    expect(
      eventBatches.findIndex((batch) => batch.includes('model.invocation_prepared')),
    ).toBeLessThan(
      eventBatches.findIndex((batch) => batch.includes('model.invocation_attempt_started')),
    );
    expect(fixture.counts().sourceCalls).toBe(1);
  });

  test('rejects an unbounded funded first attempt before Provider dispatch', async () => {
    const fixture = createGatewayFixture();
    const state = stateWithHistory();
    await expect(
      new BuiltinModelEffectCoordinator(fixture.gateway).executePrimaryModelEffect({
        ...baseInput(state),
        firstAttemptTimeoutMs: 0,
        persistence: persistence(state),
      }),
    ).rejects.toThrow('finite positive timeout');
    expect(fixture.counts().sourceCalls).toBe(0);
  });

  test('empty Agent mail keeps the original model projection and budget path', async () => {
    const fixture = createGatewayFixture();
    const state = stateWithHistory();
    const result = await new BuiltinModelEffectCoordinator(
      fixture.gateway,
    ).executePrimaryModelEffect({
      ...baseInput(state),
      config: {
        ...CONFIG,
        modelCapabilities: { contextWindowTokens: 4_096, maxOutputTokens: 64 },
      },
      persistence: persistence(state),
      prepareAgentMail: async () => ({ frames: [] }),
    });
    expect(result.kind).toBe('completed');
    expect(fixture.counts().sourceCalls).toBe(1);
  });
  test('binds one prepared Agent frame to the exact primary invocation before dispatch', async () => {
    const fixture = createGatewayFixture();
    const state = stateWithHistory();
    let admissions = 0;
    const result = await new BuiltinModelEffectCoordinator(
      fixture.gateway,
    ).executePrimaryModelEffect({
      ...baseInput(state),
      persistence: {
        ...persistence(state),
        persistAdmission: async ({ invocationId, events, mailPreparation }) => {
          admissions += 1;
          expect(invocationId).toBe('primary-invocation-1');
          expect(mailPreparation.preparationId).toBe('mailprep_test');
          expect(events.some((event) => event.type === 'model.invocation_prepared')).toBe(true);
          return true;
        },
      },
      prepareAgentMail: async ({ invocationId }) => {
        expect(invocationId).toBe('primary-invocation-1');
        return {
          frames: [
            humanMessage({
              id: 'mail-1',
              name: 'agent_message',
              content: '<agent_message>mail marker</agent_message>',
              response_metadata: { source: 'agent_message' },
            }),
          ],
          preparationId: 'mailprep_test',
        };
      },
    });
    expect(result.kind).toBe('completed');
    expect(admissions).toBe(1);
    expect(fixture.counts().sourceCalls).toBe(1);
    expect(JSON.stringify(fixture.surfaceMessages())).toContain('mail marker');
  });
  test('admits Agent mail within the real model window above the heuristic threshold', async () => {
    const fixture = createGatewayFixture();
    const state = stateWithHistory();
    const frame = humanMessage({
      id: 'mail-near-window',
      name: 'agent_message',
      content: '<agent_message>new evidence</agent_message>',
      response_metadata: { source: 'agent_message' },
    });
    const base = buildContextProjection({
      role: 'agent',
      state,
      ...projectionEnvironment(),
    }).estimate.totalInputTokens;
    const added = estimateContextTokens({
      systemMessages: [],
      transcriptMessages: [frame],
      dynamicRuntimeMessages: [],
    }).totalInputTokens;
    const window = base + added + 64 + 1_024;
    const result = await new BuiltinModelEffectCoordinator(
      fixture.gateway,
    ).executePrimaryModelEffect({
      ...baseInput(state),
      config: {
        ...CONFIG,
        modelCapabilities: { contextWindowTokens: window, maxOutputTokens: 64 },
      },
      persistence: persistence(state),
      prepareAgentMail: async () => ({ frames: [frame] }),
    });
    expect(result.kind).toBe('completed');
    expect(fixture.counts().sourceCalls).toBe(1);
  });
  test('returns automatic compaction before Gateway, operation, or source dispatch', async () => {
    const fixture = createGatewayFixture();
    const coordinator = new BuiltinModelEffectCoordinator(fixture.gateway);
    const result = await coordinator.executePrimaryModelEffect({
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
    const coordinator = new BuiltinModelEffectCoordinator(fixture.gateway);

    await expect(
      coordinator.executePrimaryModelEffect({
        ...baseInput(),
        resourceAdmission: { inputTokens: 1, maxOutputTokens: 20 },
        persistence: persistence(stateWithHistory()),
      }),
    ).rejects.toThrow('projection changed after resource admission');
    await expect(
      coordinator.executePrimaryModelEffect({
        ...baseInput(),
        resourceAdmission: { inputTokens: 1, maxOutputTokens: 20 },
        persistence: persistence(stateWithHistory()),
        prepareAgentMail: async () => ({ frames: [] }),
      }),
    ).rejects.toThrow('projection changed after resource admission');
    expect(fixture.counts()).toEqual({ operationCalls: 0, sourceCalls: 0, purpose: undefined });
  });

  test('rejects missing persistence only on the dispatching path', async () => {
    const fixture = createGatewayFixture();
    const coordinator = new BuiltinModelEffectCoordinator(fixture.gateway);

    await expect(
      coordinator.executePrimaryModelEffect({
        ...baseInput(),
        persistence: undefined,
      }),
    ).rejects.toThrow('ModelInvocationGateway execution context is unavailable');
    expect(fixture.counts()).toEqual({ operationCalls: 0, sourceCalls: 0, purpose: undefined });
  });

  test('uses the coordinator Gateway once for primary_agent and preserves stable metrics', async () => {
    const fixture = createGatewayFixture();
    const coordinator = new BuiltinModelEffectCoordinator(fixture.gateway);
    const input = {
      ...baseInput(),
      persistence: persistence(stateWithHistory()),
    };
    const first = await coordinator.executePrimaryModelEffect(input);
    const second = await coordinator.executePrimaryModelEffect(input);

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

  test('binds configured reasoning effort to the primary Agent Surface', async () => {
    const fixture = createGatewayFixture();
    const coordinator = new BuiltinModelEffectCoordinator(fixture.gateway);
    const reasoningConfig = {
      ...CONFIG,
      reasoningEffort: 'high',
    };

    await coordinator.executePrimaryModelEffect({
      ...baseInput(),
      config: reasoningConfig,
      model: createChatModel(reasoningConfig),
      persistence: persistence(stateWithHistory()),
    });

    expect(fixture.providerOptions()).toMatchObject({
      kind: 'inline',
      value: { openaiCompatible: { reasoningEffort: 'high' } },
    });
  });
});
