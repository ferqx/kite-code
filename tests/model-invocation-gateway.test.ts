import { describe, expect, test } from 'bun:test';
import type { AgentConfig } from '@/core/config';
import { humanMessage } from '@/core/messages';
import type { ModelArtifactWriterV1 } from '@/core/model/invocation-gateway';
import { computeModelSurfaceDigestV1 } from '@/core/model/surface-canonicalizer';
import { type CompiledModelSurfaceV1, compileModelSurfaceV1 } from '@/core/model/surface-compiler';
import { reduceRuntimeState } from '@/core/runtime/reducer';
import { LIMITED_RESOURCE_BUDGET_V1 } from '@/core/runtime/resource-budget';
import { createInitialRuntimeState } from '@/core/runtime/state';
import {
  MODEL_INVOCATION_PURPOSES_V1,
  MODEL_PURPOSE_TO_PROVIDER_DISPATCH_V1,
  type ModelInvocationPurposeV1,
  type ModelResponseRecordV1,
  type PrivateArtifactRefV1,
} from '@/protocol/model-surface';
import { createTestModelInvocationHarnessV1 } from './helpers/model-invocation';
import { createMockModel } from './mock-model';

const CONFIG: AgentConfig = {
  apiKey: 'synthetic-unused-key',
  baseURL: 'https://model-gateway.invalid/v1',
  modelName: 'gateway-fixture',
  providerName: 'fixture',
  providerType: 'openai-compatible',
  sandbox: { enabled: false },
};

const RESPONSE = Object.freeze({
  message: { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'ok' }] },
  finishReason: 'stop' as const,
  usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3, cacheReadTokens: null },
  providerMetadata: { responseId: 'response-fixture', rawFinishReason: 'stop' },
});

function compiled(purpose: ModelInvocationPurposeV1 = 'primary_agent') {
  const model = createMockModel([]);
  return {
    model,
    compiled: compileModelSurfaceV1({
      purpose,
      config: CONFIG,
      model,
      messages: [humanMessage('hello')],
      tools: {},
      transport: 'generate',
    }),
  };
}

function invokeInput(
  model: ReturnType<typeof createMockModel>,
  surface: CompiledModelSurfaceV1,
  persistence: ReturnType<typeof createTestModelInvocationHarnessV1>['persistence'],
) {
  return {
    model,
    compiled: surface,
    persistence,
    provenance: {
      promptContractVersion: 'prompt-contract-fixture-v1',
      projectionEnvironmentDigest: `sha256:${'1'.repeat(64)}` as const,
      capabilityBindingDigest: `sha256:${'2'.repeat(64)}` as const,
    },
    providerDataPolicyRequired: false,
    resourceKind: 'model' as const,
  };
}

function ref<K extends 'model_surface' | 'model_response'>(
  kind: K,
  suffix: string,
): PrivateArtifactRefV1 & { kind: K } {
  return {
    artifactId: `artifact-${suffix}`,
    kind,
    integrityIdentifier: `hmac-sha256:${suffix.repeat(64).slice(0, 64)}`,
    byteLength: 1,
  };
}

describe('ModelInvocationGatewayV1', () => {
  test('does not dispatch when Surface artifact publication fails', async () => {
    let dispatches = 0;
    const artifacts: ModelArtifactWriterV1 = {
      writeSurface: () => {
        throw new Error('surface storage unavailable');
      },
      writeResponse: () => ref('model_response', 'b'),
    };
    const harness = createTestModelInvocationHarnessV1({
      workspace: '/tmp/model-gateway-artifact-failure',
      artifacts,
      transport: async () => {
        dispatches += 1;
        return RESPONSE;
      },
    });
    const fixture = compiled();

    await expect(
      harness.gateway.invoke(invokeInput(fixture.model, fixture.compiled, harness.persistence)),
    ).rejects.toThrow('surface storage unavailable');
    expect(dispatches).toBe(0);
    expect(harness.events).toHaveLength(0);
  });

  test('does not dispatch when prepared evidence is not acknowledged', async () => {
    let dispatches = 0;
    const persistedTypes: string[][] = [];
    const harness = createTestModelInvocationHarnessV1({
      workspace: '/tmp/model-gateway-prepared-rejection',
      persist: (events) => {
        persistedTypes.push(events.map((event) => event.type));
        return !events.some((event) => event.type === 'model.invocation_prepared');
      },
      transport: async () => {
        dispatches += 1;
        return RESPONSE;
      },
    });
    const fixture = compiled();

    await expect(
      harness.gateway.invoke(invokeInput(fixture.model, fixture.compiled, harness.persistence)),
    ).rejects.toThrow('acknowledgement was rejected');
    expect(dispatches).toBe(0);
    expect(persistedTypes).toEqual([['model.invocation_prepared']]);
  });

  test('acknowledges every retry attempt before the corresponding dispatch', async () => {
    const order: string[] = [];
    let dispatches = 0;
    const harness = createTestModelInvocationHarnessV1({
      workspace: '/tmp/model-gateway-retry-order',
      persist: (events) => {
        for (const event of events) {
          if (event.type === 'model.retry') {
            order.push(`retry-${event.attempt}`);
          }
          if (event.type === 'model.invocation_attempt_started') {
            order.push(`ack-${event.attempt}`);
          }
        }
        return true;
      },
      sleep: async () => {
        order.push('sleep');
      },
      transport: async () => {
        dispatches += 1;
        order.push(`dispatch-${dispatches}`);
        if (dispatches === 1) throw Object.assign(new Error('unavailable'), { statusCode: 503 });
        return RESPONSE;
      },
    });
    const fixture = compiled();

    const pending = await harness.gateway.invoke({
      ...invokeInput(fixture.model, fixture.compiled, harness.persistence),
      limits: { maxAttempts: 2 },
    });
    await pending.commit();

    expect(order).toEqual(['ack-1', 'dispatch-1', 'retry-1', 'sleep', 'ack-2', 'dispatch-2']);
    expect(
      harness.events.filter((event) => event.type === 'model.invocation_attempt_started'),
    ).toHaveLength(2);
  });

  test('starts the retry time budget at the first transient failure', async () => {
    let now = 0;
    let dispatches = 0;
    const harness = createTestModelInvocationHarnessV1({
      workspace: '/tmp/model-gateway-retry-budget',
      now: () => now,
      transport: async () => {
        dispatches += 1;
        if (dispatches === 1) {
          now = 120_000;
          throw Object.assign(new Error('late transient failure'), { statusCode: 503 });
        }
        return RESPONSE;
      },
    });
    const fixture = compiled();

    const pending = await harness.gateway.invoke({
      ...invokeInput(fixture.model, fixture.compiled, harness.persistence),
      limits: { maxAttempts: 2, totalTimeBudgetMs: 60_000 },
    });
    await pending.commit();

    expect(dispatches).toBe(2);
  });

  test('keeps cumulative retry suppression separate from reasoning segment identity', async () => {
    const ephemeral: Array<{ type: string; segmentId?: string; text?: string }> = [];
    const harness = createTestModelInvocationHarnessV1({
      workspace: '/tmp/model-gateway-reasoning-segments',
      transport: async (input) => {
        input.onReasoningCumulative?.('first', 'segment-a');
        input.onReasoningCompleted?.('first', 'segment-a');
        input.onReasoningCumulative?.('firstsecond', 'segment-b');
        input.onReasoningCompleted?.('second', 'segment-b');
        return RESPONSE;
      },
    });
    const fixture = compiled();

    const pending = await harness.gateway.invoke({
      ...invokeInput(fixture.model, fixture.compiled, harness.persistence),
      emitEphemeral: (event) => {
        if (event.type === 'model.reasoning_delta' || event.type === 'model.reasoning_completed') {
          ephemeral.push(event);
        }
      },
    });
    await pending.commit();

    expect(ephemeral).toEqual([
      { type: 'model.reasoning_delta', segmentId: 'segment-a', text: 'first' },
      { type: 'model.reasoning_completed', segmentId: 'segment-a', text: 'first' },
      { type: 'model.reasoning_delta', segmentId: 'segment-b', text: 'second' },
      { type: 'model.reasoning_completed', segmentId: 'segment-b', text: 'second' },
    ]);
  });

  test('bounds HTTP 429 retries and never retries a non-transient 4xx', async () => {
    for (const [statusCode, expectedDispatches, expectedReason] of [
      [429, 3, 'attempts_exhausted'],
      [401, 1, 'provider_failure'],
    ] as const) {
      let dispatches = 0;
      const harness = createTestModelInvocationHarnessV1({
        workspace: `/tmp/model-gateway-http-${statusCode}`,
        transport: async () => {
          dispatches += 1;
          throw Object.assign(new Error(`HTTP ${statusCode}`), { statusCode });
        },
      });
      const fixture = compiled();
      await expect(
        harness.gateway.invoke({
          ...invokeInput(fixture.model, fixture.compiled, harness.persistence),
          limits: { maxAttempts: 3 },
        }),
      ).rejects.toThrow(`HTTP ${statusCode}`);
      expect(dispatches).toBe(expectedDispatches);
      expect(harness.events.at(-1)).toMatchObject({
        type: 'model.invocation_interrupted',
        dispatchCertainty: 'attempted',
        reasonCode: expectedReason,
      });
    }
  });

  test('rejects request drift after prepared admission without Provider dispatch', async () => {
    let dispatches = 0;
    const fixture = compiled();
    const mutableSurface = structuredClone(fixture.compiled.surface);
    const mutableCompiled: CompiledModelSurfaceV1 = {
      ...fixture.compiled,
      surface: mutableSurface,
      surfaceDigest: computeModelSurfaceDigestV1(mutableSurface),
    };
    const startedAt = Date.now() - 1_000;
    const initial = reduceRuntimeState(
      createInitialRuntimeState({
        threadId: 'gateway-drift',
        userId: 'test',
        workspace: '/tmp/model-gateway-drift',
      }),
      {
        type: 'resource_budget.configured',
        runId: 'gateway-drift-run',
        startedAt: new Date(startedAt).toISOString(),
        deadlineAt: new Date(startedAt + LIMITED_RESOURCE_BUDGET_V1.maxRunDurationMs).toISOString(),
        budget: LIMITED_RESOURCE_BUDGET_V1,
      },
    );
    const harness = createTestModelInvocationHarnessV1({
      workspace: '/tmp/model-gateway-drift',
      state: initial,
      persist: (events) => {
        if (events.some((event) => event.type === 'model.invocation_prepared')) {
          mutableSurface.request.system = 'drifted-after-admission';
        }
        return true;
      },
      transport: async () => {
        dispatches += 1;
        return RESPONSE;
      },
    });

    await expect(
      harness.gateway.invoke(invokeInput(fixture.model, mutableCompiled, harness.persistence)),
    ).rejects.toThrow('changed after attempt acknowledgement');
    expect(dispatches).toBe(0);
    expect(harness.events.at(-1)).toMatchObject({
      type: 'resource_budget.released',
      proof: 'local_provider_admission_denied',
    });
    expect(harness.events.at(-2)).toMatchObject({
      type: 'model.invocation_interrupted',
      dispatchCertainty: 'none',
      reasonCode: 'surface_identity_changed',
    });
    expect(
      Object.values(
        harness.getState().resourceBudget.status === 'active'
          ? harness.getState().resourceBudget.reservations
          : {},
      ),
    ).toEqual([expect.objectContaining({ state: 'released' })]);
  });

  test('does not expose a response when the completion receipt batch is rejected', async () => {
    let responseWritten = false;
    const rejectedBatches: string[][] = [];
    const harness = createTestModelInvocationHarnessV1({
      workspace: '/tmp/model-gateway-terminal-rejection',
      artifacts: {
        writeSurface: () => ref('model_surface', 'a'),
        writeResponse: (_record: ModelResponseRecordV1) => {
          responseWritten = true;
          return ref('model_response', 'b');
        },
      },
      persist: (events) => {
        if (events.some((event) => event.type === 'model.invocation_completed')) {
          rejectedBatches.push(events.map((event) => event.type));
          return false;
        }
        return true;
      },
      transport: async () => RESPONSE,
    });
    const fixture = compiled();
    const pending = await harness.gateway.invoke(
      invokeInput(fixture.model, fixture.compiled, harness.persistence),
    );

    await expect(
      pending.commitWith((response) => ({
        events: [
          {
            type: 'model.responded',
            messageId: 'uncommitted-message',
            invocationId: response.invocationId,
            text: 'must-not-be-consumed',
          },
        ],
        value: response.message,
      })),
    ).rejects.toThrow('acknowledgement was rejected');
    expect(responseWritten).toBe(true);
    expect(rejectedBatches).toEqual([['model.invocation_completed', 'model.responded']]);
    expect(harness.getState().transcript.messages).toHaveLength(0);
    expect(Object.values(harness.getState().modelInvocations)[0]?.status).toBe('dispatching');
  });

  test('commits completion, primary response-derived events, and reconciliation atomically', async () => {
    const batches: string[][] = [];
    const startedAt = Date.now() - 1_000;
    const initial = reduceRuntimeState(
      createInitialRuntimeState({
        threadId: 'gateway-budget',
        userId: 'test',
        workspace: '/tmp/model-gateway-atomic',
      }),
      {
        type: 'resource_budget.configured',
        runId: 'gateway-run',
        startedAt: new Date(startedAt).toISOString(),
        deadlineAt: new Date(startedAt + LIMITED_RESOURCE_BUDGET_V1.maxRunDurationMs).toISOString(),
        budget: LIMITED_RESOURCE_BUDGET_V1,
      },
    );
    const harness = createTestModelInvocationHarnessV1({
      workspace: '/tmp/model-gateway-atomic',
      state: initial,
      persist: (events) => {
        batches.push(events.map((event) => event.type));
        return true;
      },
      transport: async () => RESPONSE,
    });
    const fixture = compiled();
    const pending = await harness.gateway.invoke(
      invokeInput(fixture.model, fixture.compiled, harness.persistence),
    );
    const invocationId = pending.invocationId;
    const result = await pending.commitWith((response) => ({
      events: [
        {
          type: 'model.responded',
          messageId: 'assistant-atomic',
          invocationId: response.invocationId,
          text: 'ok',
          toolCalls: [{ id: 'call-atomic', name: 'inspect', args: {} }],
        },
        {
          type: 'tool.queued',
          toolCallId: 'call-atomic',
          modelInvocationId: response.invocationId,
          modelMessageId: 'assistant-atomic',
          name: 'inspect',
          args: {},
        },
      ],
      value: 'committed',
    }));

    expect(result).toBe('committed');
    expect(batches.at(-1)).toEqual([
      'model.invocation_completed',
      'model.responded',
      'tool.queued',
      'resource_budget.reconciled',
    ]);
    expect(harness.getState().modelInvocations[invocationId]?.status).toBe('completed');
    expect(harness.getState().tools.calls['call-atomic']?.modelInvocationId).toBe(invocationId);
  });

  test('routes all five closed purposes through the same Gateway contract', async () => {
    const observed: string[] = [];
    for (const purpose of MODEL_INVOCATION_PURPOSES_V1) {
      const harness = createTestModelInvocationHarnessV1({
        workspace: `/tmp/model-gateway-${purpose}`,
        transport: async () => RESPONSE,
      });
      const fixture = compiled(purpose);
      const pending = await harness.gateway.invoke({
        ...invokeInput(fixture.model, fixture.compiled, harness.persistence),
        providerDataPolicyRequired: true,
        providerDataAdmission: (_payload, dispatchPurpose) => {
          observed.push(`${purpose}:${dispatchPurpose}`);
          return {
            admitted: true,
            reason: 'admitted',
            routeAlias: 'fixture',
            policyRevision: 'fixture-policy-v1',
          };
        },
        resourceKind:
          purpose === 'context_compaction'
            ? 'compaction'
            : purpose === 'verification_review'
              ? 'verification'
              : 'model',
      });
      await pending.commit();
      expect(harness.events.some((event) => event.type === 'model.invocation_completed')).toBe(
        true,
      );
    }

    expect(observed).toEqual(
      MODEL_INVOCATION_PURPOSES_V1.map(
        (purpose) => `${purpose}:${MODEL_PURPOSE_TO_PROVIDER_DISPATCH_V1[purpose]}`,
      ),
    );
  });
});
