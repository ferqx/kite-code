import { describe, expect, test } from 'bun:test';
import {
  createBuiltinRuntimeModules,
  createBuiltinToolCatalogProjection,
} from '@kite/builtin-runtime';
import {
  BUILTIN_MODEL_OPERATION_BY_PURPOSE_,
  type BuiltinModelOperationAttempt,
} from '@kite/builtin-runtime/model';
import { createRuntimeHostCapabilityExecutionPortFromSnapshot } from '@kite/runtime-host';
import {
  type CapabilityExecutionPort,
  createRuntimeModuleRegistry,
  MODEL_ATTEMPT_OUTCOME_SCHEMA_,
  MODEL_INVOCATION_PURPOSES_,
  type ModelAttemptOutcome,
} from '@kite/runtime-spi';
import { createKiteModelOperationExecutionPort } from '#app/bootstrap/model-operation-execution';

const OUTCOME: ModelAttemptOutcome = Object.freeze({
  schema: MODEL_ATTEMPT_OUTCOME_SCHEMA_,
  kind: 'success',
  response: Object.freeze({
    message: Object.freeze({
      role: 'assistant',
      content: Object.freeze([{ type: 'text' as const, text: 'ok' }]),
    }),
    finishReason: 'stop',
    usage: Object.freeze({
      inputTokens: 2,
      outputTokens: 1,
      totalTokens: 3,
      cacheReadTokens: null,
    }),
    providerMetadata: Object.freeze({
      responseId: 'kite-model-operation-response',
      rawFinishReason: 'stop',
    }),
  }),
  nativeReplayState: null,
});

function attempt(
  purpose: (typeof MODEL_INVOCATION_PURPOSES_)[number],
  ordinal: number,
  invoke: () => Promise<ModelAttemptOutcome>,
): BuiltinModelOperationAttempt {
  return Object.freeze({
    operationId: BUILTIN_MODEL_OPERATION_BY_PURPOSE_[purpose],
    purpose,
    invocationId: `model-invocation-${ordinal}`,
    attemptOrdinal: 1,
    threadId: 'thread-model-operation',
    turnId: 'turn-model-operation',
    stateRevision: ordinal,
    surfaceDigest: `sha256:${String(ordinal).padStart(64, '0')}`,
    input: Object.freeze({
      purpose,
      invocation_id: `model-invocation-${ordinal}`,
      attempt_ordinal: 1,
      thread_id: 'thread-model-operation',
      turn_id: 'turn-model-operation',
      state_revision: ordinal,
      surface_digest: `sha256:${String(ordinal).padStart(64, '0')}`,
    }),
    signal: new AbortController().signal,
    attempt: invoke,
  });
}

function composition() {
  const registry = createRuntimeModuleRegistry(createBuiltinRuntimeModules());
  const projection = createBuiltinToolCatalogProjection(registry.snapshot());
  const host = createRuntimeHostCapabilityExecutionPortFromSnapshot(registry.snapshot());
  let hostCalls = 0;
  const countedHost: CapabilityExecutionPort = Object.freeze({
    invoke: (invocation: Parameters<CapabilityExecutionPort['invoke']>[0]) => {
      hostCalls += 1;
      return host.invoke(invocation);
    },
  });
  return {
    execution: createKiteModelOperationExecutionPort(countedHost, projection),
    hostCalls: () => hostCalls,
  };
}

describe('Kite Builtin Model operation execution composition', () => {
  test('routes all five purposes through one supplied Host port exactly once', async () => {
    const composed = composition();
    let sourceCalls = 0;
    for (const [index, purpose] of MODEL_INVOCATION_PURPOSES_.entries()) {
      const outcome = await composed.execution.execute(
        attempt(purpose, index + 1, async () => {
          sourceCalls += 1;
          return OUTCOME;
        }),
      );
      expect(outcome).toBe(OUTCOME);
    }
    expect(composed.hostCalls()).toBe(5);
    expect(sourceCalls).toBe(5);
  });

  test('rejects purpose, input, and replayed attempt identity before another source call', async () => {
    const composed = composition();
    let sourceCalls = 0;
    const primary = attempt('primary_agent', 1, async () => {
      sourceCalls += 1;
      return OUTCOME;
    });
    await expect(
      composed.execution.execute({
        ...primary,
        operationId: 'model:compaction',
      }),
    ).rejects.toThrow('purpose mismatch');
    expect(composed.hostCalls()).toBe(0);
    expect(sourceCalls).toBe(0);

    await expect(
      composed.execution.execute({
        ...primary,
        input: [] as unknown as BuiltinModelOperationAttempt['input'],
      }),
    ).rejects.toThrow('input is invalid');
    expect(composed.hostCalls()).toBe(0);
    expect(sourceCalls).toBe(0);

    await expect(composed.execution.execute(primary)).resolves.toBe(OUTCOME);
    await expect(composed.execution.execute(primary)).rejects.toMatchObject({
      code: 'attempt_already_claimed',
    });
    expect(composed.hostCalls()).toBe(2);
    expect(sourceCalls).toBe(1);
  });
});
