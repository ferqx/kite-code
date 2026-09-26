import { describe, expect, test } from 'bun:test';
import {
  compileModelSurface,
  createChatModel,
  humanMessage,
  type ModelArtifactWriter,
  ModelInvocationGateway,
  type ModelInvocationPersistence,
  type ModelResponseSource,
  type ModelRuntimeConfig,
} from '@kite-ai/builtin-runtime/model';
import { MODEL_ATTEMPT_OUTCOME_SCHEMA_, type PrivateArtifactRef } from '@kite-ai/runtime-spi';

const config: ModelRuntimeConfig = {
  apiKey: 'admission-test-key',
  baseURL: 'https://admission.invalid/v1',
  modelName: 'admission-test',
  providerName: 'admission-test',
  providerType: 'openai-compatible',
  sandbox: { enabled: false },
};
const model = createChatModel(config);
const provenance = {
  promptContractVersion: 'test',
  projectionEnvironmentDigest: 'sha256:test',
  capabilityBindingDigest: 'sha256:test',
} as const;

function ref<K extends 'model_surface' | 'model_response'>(
  kind: K,
): PrivateArtifactRef & { kind: K } {
  return {
    artifactId: `admission-${kind}`,
    kind,
    integrityIdentifier: 'sha256:admission-test',
    byteLength: 1,
  };
}

function fixture(admitted = true, maxOutputTokens?: number) {
  const order: string[] = [];
  const batches: Array<{
    invocationId: string;
    events: readonly { type: string }[];
    preparationId: string;
  }> = [];
  const artifacts: ModelArtifactWriter = {
    writeSurface: () => {
      order.push('surface');
      return ref('model_surface');
    },
    writeResponse: () => ref('model_response'),
  };
  const source: ModelResponseSource = {
    attempt: async () => {
      order.push('provider');
      return {
        schema: MODEL_ATTEMPT_OUTCOME_SCHEMA_,
        kind: 'success',
        response: {
          message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: null },
          providerMetadata: { responseId: 'admission-response', rawFinishReason: 'stop' },
        },
        nativeReplayState: null,
      };
    },
  };
  const gateway = new ModelInvocationGateway({
    artifacts,
    source,
    operationExecution: { execute: (attempt) => attempt.attempt() },
    runtimeIdSource: { next: () => 'admission-invocation-1', now: () => 1_000 },
    planResource: (_state, input) => {
      order.push(`plan:${input.invocationId}:${input.inputTokens}`);
      return {
        budget: { kind: 'no_budget', reason: 'resource_budget_disabled' },
        preparationEvents: [{ type: 'fixture.resource_prepared' }],
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      };
    },
  });
  const persistence: ModelInvocationPersistence = {
    getState: () => ({
      revision: 1,
      session: { threadId: 'admission-thread' },
      turn: { turnId: 'admission-turn' },
      resourceBudget: { status: 'unconfigured' },
    }),
    persistEvents: async (events) => {
      order.push(`events:${events.map((event) => event.type).join(',')}`);
      return true;
    },
    persistAdmission: async ({ invocationId, events, mailPreparation }) => {
      order.push('admission');
      batches.push({ invocationId, events, preparationId: mailPreparation.preparationId });
      return admitted;
    },
  };
  const invoke = (
    prepareSurface: Parameters<ModelInvocationGateway['invoke']>[0]['prepareSurface'],
  ) => gateway.invoke({ model, prepareSurface, persistence, provenance, resourceKind: 'model' });
  return { invoke, order, batches, persistence };
}

describe('Gateway prepared Surface admission', () => {
  test('allocates once, compiles before publication, and atomically acknowledges mail with model preparation', async () => {
    const value = fixture();
    let prepareCalls = 0;
    const pending = await value.invoke((invocationId) => {
      prepareCalls += 1;
      value.order.push(`prepare:${invocationId}`);
      return {
        compiled: compileModelSurface({
          purpose: 'subagent',
          config,
          model,
          messages: [
            humanMessage({ id: 'mail-1', name: 'agent_message', content: 'escaped mail' }),
          ],
          tools: {},
          estimatedInputTokens: 8,
        }),
        mailPreparation: { preparationId: 'batch-1' },
      };
    });
    expect(pending.invocationId).toBe('admission-invocation-1');
    expect(prepareCalls).toBe(1);
    expect(value.order.slice(0, 4)).toEqual([
      'prepare:admission-invocation-1',
      'surface',
      'plan:admission-invocation-1:8',
      'admission',
    ]);
    expect(value.order.indexOf('admission')).toBeLessThan(value.order.indexOf('provider'));
    expect(value.batches).toEqual([
      {
        invocationId: 'admission-invocation-1',
        events: [
          expect.objectContaining({ type: 'fixture.resource_prepared' }),
          expect.objectContaining({ type: 'model.invocation_prepared', estimatedInputTokens: 8 }),
        ],
        preparationId: 'batch-1',
      },
    ]);
    expect(JSON.stringify(value.batches)).not.toContain('escaped mail');
    await pending.commit();
  });

  test('rejected admission cannot dispatch or fall back to ordinary event persistence', async () => {
    const value = fixture(false);
    await expect(
      value.invoke(() => ({
        compiled: compileModelSurface({
          purpose: 'subagent',
          config,
          model,
          messages: [humanMessage('mail')],
          tools: {},
        }),
        mailPreparation: { preparationId: 'batch-2' },
      })),
    ).rejects.toThrow('admission acknowledgement was rejected');
    expect(value.order).toEqual(['surface', expect.stringMatching(/^plan:/u), 'admission']);
  });

  test('rejects an invalid opaque descriptor before Surface publication', async () => {
    const value = fixture();
    await expect(
      value.invoke(() => ({
        compiled: compileModelSurface({
          purpose: 'subagent',
          config,
          model,
          messages: [humanMessage('mail')],
          tools: {},
        }),
        mailPreparation: { preparationId: 'batch-3', body: 'private' } as never,
      })),
    ).rejects.toThrow('preparation identity is invalid');
    expect(value.order).toEqual([]);
  });

  test('rejects a prepared Surface beyond its planned output ceiling before admission or dispatch', async () => {
    const value = fixture(true, 4);
    await expect(
      value.invoke(() => ({
        compiled: compileModelSurface({
          purpose: 'subagent',
          config,
          model,
          messages: [humanMessage('mail')],
          tools: {},
          maxOutputTokens: 8,
        }),
        mailPreparation: { preparationId: 'batch-4' },
      })),
    ).rejects.toThrow('exceeds its admitted output reservation');
    expect(value.order).toEqual(['surface', expect.stringMatching(/^plan:/u)]);
    expect(value.batches).toHaveLength(0);
  });
});
