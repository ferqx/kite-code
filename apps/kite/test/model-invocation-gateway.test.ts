import { describe, expect, test } from 'bun:test';
import type { ModelArtifactWriter } from '@kite-ai/builtin-runtime/model';
import {
  BUILTIN_MODEL_OPERATION_BY_PURPOSE_,
  type CompiledModelSurface,
  compileModelSurface,
  computeModelSurfaceDigest,
  humanMessage,
} from '@kite-ai/builtin-runtime/model';
import {
  createRuntimeHostStateInitialState,
  LIMITED_RESOURCE_BUDGET_,
} from '@kite-ai/runtime-host/kernel-adapter';
import {
  MODEL_INVOCATION_PURPOSES_,
  type ModelInvocationPurpose,
  type ModelResponseRecord,
  type PrivateArtifactRef,
} from '@kite-ai/runtime-spi';
import type { AgentConfig } from '#app/config';
import { reduceRuntimeState } from '#runtime-support/runtime-state-reducer';
import { createMockModel } from '../../../tests/helpers/mock-model';
import { createTestModelInvocationHarness } from '../../../tests/helpers/model-invocation';

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

function compiled(purpose: ModelInvocationPurpose = 'primary_agent') {
  const model = createMockModel([]);
  return {
    model,
    compiled: compileModelSurface({
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
  surface: CompiledModelSurface,
  persistence: ReturnType<typeof createTestModelInvocationHarness>['persistence'],
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
    resourceKind: 'model' as const,
  };
}

function ref<K extends 'model_surface' | 'model_response'>(
  kind: K,
  suffix: string,
): PrivateArtifactRef & { kind: K } {
  return {
    artifactId: `artifact-${suffix}`,
    kind,
    integrityIdentifier: `sha256:${suffix.repeat(64).slice(0, 64)}`,
    byteLength: 1,
  };
}

describe('ModelInvocationGateway', () => {
  test('does not require the retired State Project identity authority', async () => {
    let dispatches = 0;
    const harness = createTestModelInvocationHarness({
      workspace: '/tmp/model-gateway-missing-project',
      preserveMissingProjectIdentity: true,
      transport: async () => {
        dispatches += 1;
        return RESPONSE;
      },
    });
    const fixture = compiled();

    await expect(
      harness.gateway.invoke(invokeInput(fixture.model, fixture.compiled, harness.persistence)),
    ).resolves.toBeDefined();
    expect(dispatches).toBe(1);
  });

  test('does not dispatch when Surface artifact publication fails', async () => {
    let dispatches = 0;
    const artifacts: ModelArtifactWriter = {
      writeSurface: () => {
        throw new Error('surface storage unavailable');
      },
      writeResponse: () => ref('model_response', 'b'),
    };
    const harness = createTestModelInvocationHarness({
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
    const harness = createTestModelInvocationHarness({
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
    const harness = createTestModelInvocationHarness({
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
    expect(harness.events.find((event) => event.type === 'model.retry')).toMatchObject({
      invocationId: expect.any(String),
      failureClassification: 'provider_unavailable',
      providerStatusCode: 503,
      timedOut: false,
    });
  });

  test('starts the retry time budget at the first transient failure', async () => {
    let now = 0;
    let dispatches = 0;
    const harness = createTestModelInvocationHarness({
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

  test('keeps an active streaming attempt alive beyond the inactivity timeout', async () => {
    let dispatches = 0;
    const harness = createTestModelInvocationHarness({
      workspace: '/tmp/model-gateway-stream-activity',
      transport: async (input) => {
        dispatches += 1;
        await Bun.sleep(30);
        if (input.signal?.aborted) throw input.signal.reason;
        input.onActivity?.();
        await Bun.sleep(30);
        if (input.signal?.aborted) throw input.signal.reason;
        input.onActivity?.();
        return RESPONSE;
      },
    });
    const fixture = compiled();

    const pending = await harness.gateway.invoke({
      ...invokeInput(fixture.model, fixture.compiled, harness.persistence),
      limits: { maxAttempts: 1, perAttemptTimeoutMs: 50, totalTimeBudgetMs: 100 },
    });
    await pending.commit();

    expect(dispatches).toBe(1);
    expect(harness.events.at(-1)).toMatchObject({ type: 'model.invocation_completed' });
  });

  test('cancellation wins even when the provider ignores its abort signal', async () => {
    let dispatches = 0;
    const harness = createTestModelInvocationHarness({
      workspace: '/tmp/model-gateway-non-cooperative-provider',
      transport: async () => {
        dispatches += 1;
        return new Promise<never>(() => {});
      },
    });
    const fixture = compiled();
    const controller = new AbortController();

    const invocation = harness.gateway.invoke({
      ...invokeInput(fixture.model, fixture.compiled, harness.persistence),
      signal: controller.signal,
    });
    while (dispatches === 0) await Bun.sleep(1);
    controller.abort(new Error('user cancelled'));

    await expect(invocation).rejects.toThrow('user cancelled');
    expect(harness.events.at(-1)).toMatchObject({
      type: 'model.invocation_interrupted',
      dispatchCertainty: 'attempted',
      reasonCode: 'cancelled',
    });
  });

  test('does not dispatch when cancellation arrives while attempt-start evidence is persisted', async () => {
    let dispatches = 0;
    const controller = new AbortController();
    const harness = createTestModelInvocationHarness({
      workspace: '/tmp/model-gateway-cancel-during-attempt-ack',
      persist: (events) => {
        if (events.some((event) => event.type === 'model.invocation_attempt_started')) {
          controller.abort(new Error('cancelled during attempt acknowledgement'));
        }
        return true;
      },
      transport: async () => {
        dispatches += 1;
        return RESPONSE;
      },
    });
    const fixture = compiled();

    await expect(
      harness.gateway.invoke({
        ...invokeInput(fixture.model, fixture.compiled, harness.persistence),
        signal: controller.signal,
      }),
    ).rejects.toThrow('cancelled during attempt acknowledgement');
    expect(dispatches).toBe(0);
    expect(harness.events.at(-1)).toMatchObject({
      type: 'model.invocation_interrupted',
      dispatchCertainty: 'none',
      reasonCode: 'cancelled',
    });
  });

  test('does not commit a successful response after its caller is cancelled', async () => {
    const controller = new AbortController();
    const harness = createTestModelInvocationHarness({
      workspace: '/tmp/model-gateway-cancel-before-completion-commit',
      transport: async () => RESPONSE,
    });
    const fixture = compiled();
    const pending = await harness.gateway.invoke({
      ...invokeInput(fixture.model, fixture.compiled, harness.persistence),
      signal: controller.signal,
    });

    controller.abort(new Error('cancelled before completion commit'));

    await expect(pending.commit()).rejects.toThrow('cancelled before completion commit');
    expect(harness.events.some((event) => event.type === 'model.invocation_completed')).toBe(false);
    expect(harness.events.at(-1)).toMatchObject({
      type: 'model.invocation_interrupted',
      dispatchCertainty: 'attempted',
      reasonCode: 'cancelled',
    });
  });

  test('keeps cumulative retry suppression separate from reasoning segment identity', async () => {
    const ephemeral: Array<{ type: string; segmentId?: string; text?: string }> = [];
    const harness = createTestModelInvocationHarness({
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
    for (const [statusCode, expectedDispatches, expectedReason, expectedError] of [
      [429, 3, 'attempts_exhausted', 'MODEL_ATTEMPT_RETRYABLE_FAILURE:provider_rate_limited'],
      [401, 1, 'provider_failure', 'MODEL_ATTEMPT_FATAL_FAILURE:provider_rejected'],
    ] as const) {
      let dispatches = 0;
      const harness = createTestModelInvocationHarness({
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
      ).rejects.toThrow(expectedError);
      expect(dispatches).toBe(expectedDispatches);
      expect(harness.events.at(-1)).toMatchObject({
        type: 'model.invocation_interrupted',
        dispatchCertainty: 'attempted',
        reasonCode: expectedReason,
      });
    }
  });

  test('staggers concurrent retries after a shared route returns HTTP 429', async () => {
    let waitingFirstAttempts = 0;
    let releaseFirstAttempts: (() => void) | undefined;
    const firstAttemptsReady = new Promise<void>((resolve) => {
      releaseFirstAttempts = resolve;
    });
    let dispatches = 0;
    const retryDelays: number[] = [];
    const harness = createTestModelInvocationHarness({
      workspace: '/tmp/model-gateway-shared-rate-limit',
      now: () => 0,
      sleep: async (delayMs) => {
        retryDelays.push(delayMs);
      },
      transport: async () => {
        dispatches += 1;
        if (dispatches <= 2) {
          waitingFirstAttempts += 1;
          if (waitingFirstAttempts === 2) releaseFirstAttempts?.();
          await firstAttemptsReady;
          throw Object.assign(new Error('rate limited'), { statusCode: 429 });
        }
        return RESPONSE;
      },
    });
    const fixture = compiled();

    const pending = await Promise.all([
      harness.gateway.invoke({
        ...invokeInput(fixture.model, fixture.compiled, harness.persistence),
        limits: { maxAttempts: 2 },
      }),
      harness.gateway.invoke({
        ...invokeInput(fixture.model, fixture.compiled, harness.persistence),
        limits: { maxAttempts: 2 },
      }),
    ]);
    await Promise.all(pending.map((completion) => completion.commit()));

    expect(retryDelays.sort((left, right) => left - right)).toEqual([500, 1_000]);
    expect(
      harness.events
        .filter((event) => event.type === 'model.retry')
        .map((event) => event.delayMs)
        .sort((left, right) => left - right),
    ).toEqual([500, 1_000]);
  });

  test('rejects request drift after prepared admission without Provider dispatch', async () => {
    let dispatches = 0;
    const fixture = compiled();
    const mutableSurface = structuredClone(fixture.compiled.surface);
    const mutableCompiled: CompiledModelSurface = {
      ...fixture.compiled,
      surface: mutableSurface,
      surfaceDigest: computeModelSurfaceDigest(mutableSurface),
    };
    const startedAt = Date.now() - 1_000;
    const initial = reduceRuntimeState(
      createRuntimeHostStateInitialState({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId: 'gateway-drift',
        userId: 'test',
        workspace: '/tmp/model-gateway-drift',
      }),
      {
        type: 'resource_budget.configured',
        runId: 'gateway-drift-run',
        startedAt: new Date(startedAt).toISOString(),
        deadlineAt: new Date(startedAt + LIMITED_RESOURCE_BUDGET_.maxRunDurationMs).toISOString(),
        budget: LIMITED_RESOURCE_BUDGET_,
      },
    );
    const harness = createTestModelInvocationHarness({
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
      proof: 'local_pre_dispatch_failure',
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
    const harness = createTestModelInvocationHarness({
      workspace: '/tmp/model-gateway-terminal-rejection',
      artifacts: {
        writeSurface: () => ref('model_surface', 'a'),
        writeResponse: (_record: ModelResponseRecord) => {
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
      createRuntimeHostStateInitialState({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId: 'gateway-budget',
        userId: 'test',
        workspace: '/tmp/model-gateway-atomic',
      }),
      {
        type: 'resource_budget.configured',
        runId: 'gateway-run',
        startedAt: new Date(startedAt).toISOString(),
        deadlineAt: new Date(startedAt + LIMITED_RESOURCE_BUDGET_.maxRunDurationMs).toISOString(),
        budget: LIMITED_RESOURCE_BUDGET_,
      },
    );
    const harness = createTestModelInvocationHarness({
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

  test('terminalizes an attempted invocation when synchronous completion finalization fails', async () => {
    let dispatches = 0;
    const harness = createTestModelInvocationHarness({
      workspace: '/tmp/model-gateway-finalizer-fault',
      transport: async () => {
        dispatches += 1;
        return RESPONSE;
      },
    });
    const fixture = compiled();
    const pending = await harness.gateway.invoke(
      invokeInput(fixture.model, fixture.compiled, harness.persistence),
    );
    await expect(
      pending.commitWith(() => {
        throw new Error('private publication failed');
      }),
    ).rejects.toThrow('private publication failed');
    expect(dispatches).toBe(1);
    expect(harness.events.at(-1)).toMatchObject({
      type: 'model.invocation_interrupted',
      invocationId: pending.invocationId,
      dispatchCertainty: 'attempted',
      reasonCode: 'persistence_unavailable',
    });
    expect(harness.getState().modelInvocations[pending.invocationId]).toMatchObject({
      status: 'interrupted',
      interruptionReason: 'persistence_unavailable',
    });
    await expect(pending.commit()).rejects.toThrow('single-use');
    expect(dispatches).toBe(1);
  });

  test('routes all four closed purposes through the same Gateway contract', async () => {
    const operations: string[] = [];
    for (const purpose of MODEL_INVOCATION_PURPOSES_) {
      const harness = createTestModelInvocationHarness({
        workspace: `/tmp/model-gateway-${purpose}`,
        transport: async () => RESPONSE,
        operationExecution: {
          execute: async (operation) => {
            operations.push(`${operation.purpose}:${operation.operationId}`);
            return operation.attempt();
          },
        },
      });
      const fixture = compiled(purpose);
      const pending = await harness.gateway.invoke({
        ...invokeInput(fixture.model, fixture.compiled, harness.persistence),
        resourceKind: purpose === 'context_compaction' ? 'compaction' : 'model',
      });
      await pending.commit();
      expect(harness.events.some((event) => event.type === 'model.invocation_completed')).toBe(
        true,
      );
    }

    expect(operations).toEqual(
      MODEL_INVOCATION_PURPOSES_.map(
        (purpose) => `${purpose}:${BUILTIN_MODEL_OPERATION_BY_PURPOSE_[purpose]}`,
      ),
    );
  });

  test('fails closed before the response source when Model operation selection rejects', async () => {
    let sourceCalls = 0;
    const harness = createTestModelInvocationHarness({
      workspace: '/tmp/model-operation-rejected',
      transport: async () => {
        sourceCalls += 1;
        return RESPONSE;
      },
      operationExecution: {
        execute: () => Promise.reject(new Error('model operation identity rejected')),
      },
    });
    const fixture = compiled('primary_agent');
    await expect(
      harness.gateway.invoke(invokeInput(fixture.model, fixture.compiled, harness.persistence)),
    ).rejects.toThrow('model operation identity rejected');
    expect(sourceCalls).toBe(0);
  });
});
