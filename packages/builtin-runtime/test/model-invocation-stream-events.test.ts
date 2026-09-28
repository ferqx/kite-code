import { describe, expect, test } from 'bun:test';
import {
  type BuiltinModelOperationAttempt,
  type BuiltinModelOperationExecutionPort,
  compileModelSurface,
  createChatModel,
  humanMessage,
  type ModelArtifactWriter,
  ModelInvocationGateway,
  type ModelResponseSource,
  type ModelRuntimeConfig,
} from '@kite-ai/builtin-runtime/model';
import {
  MODEL_ATTEMPT_OUTCOME_SCHEMA_,
  type ModelAttemptOutcome,
  type PrivateArtifactRef,
} from '@kite-ai/runtime-spi';

const CONFIG: ModelRuntimeConfig = Object.freeze({
  apiKey: 'stream-events-fixture-key',
  baseURL: 'https://stream-events-fixture.invalid/v1',
  modelName: 'stream-events-fixture',
  providerName: 'stream-events-fixture',
  providerType: 'openai-compatible',
  sandbox: Object.freeze({ enabled: false }),
});

function artifactRef<K extends 'model_surface' | 'model_response'>(
  kind: K,
): PrivateArtifactRef & { kind: K } {
  return {
    artifactId: `stream-events-${kind}`,
    kind,
    integrityIdentifier: 'sha256:stream-events-fixture',
    byteLength: 1,
  };
}

function successfulOutcome(): ModelAttemptOutcome {
  return {
    schema: MODEL_ATTEMPT_OUTCOME_SCHEMA_,
    kind: 'success',
    response: {
      message: { role: 'assistant', content: [{ type: 'text', text: 'completed' }] },
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: null },
      providerMetadata: { responseId: 'stream-events-response', rawFinishReason: 'stop' },
    },
    nativeReplayState: null,
  };
}

describe('ModelInvocationGateway stream display events', () => {
  test('correlates every display event with the current invocation identity', async () => {
    const source: ModelResponseSource = {
      attempt: async (input) => {
        input.onTextCumulative?.('visible text');
        input.onReasoningCumulative?.('visible reasoning', 'segment-1');
        input.onReasoningCompleted?.('visible reasoning', 'segment-1');
        return successfulOutcome();
      },
    };
    const operationExecution: BuiltinModelOperationExecutionPort = {
      execute: (attempt: BuiltinModelOperationAttempt) => attempt.attempt(),
    };
    const artifacts: ModelArtifactWriter = {
      writeSurface: () => artifactRef('model_surface'),
      writeResponse: () => artifactRef('model_response'),
    };
    const gateway = new ModelInvocationGateway({
      artifacts,
      source,
      operationExecution,
      runtimeIdSource: { next: () => 'streaming-invocation-1', now: () => 1_000 },
      now: () => 1_000,
      sleep: async () => {},
    });
    const emitted: Array<Record<string, unknown>> = [];
    const compiled = compileModelSurface({
      purpose: 'primary_agent',
      config: CONFIG,
      model: createChatModel(CONFIG),
      messages: [humanMessage('Stream the response.')],
      tools: {},
      estimatedInputTokens: 1,
    });

    await gateway.invoke({
      model: createChatModel(CONFIG),
      compiled,
      persistence: {
        getState: () => ({
          revision: 1,
          session: { threadId: 'stream-events-thread' },
          turn: { turnId: 'stream-events-turn' },
          resourceBudget: { status: 'unconfigured' },
        }),
        persistEvents: async () => true,
      },
      provenance: {
        promptContractVersion: 'stream-events-v1',
        projectionEnvironmentDigest: `sha256:${'a'.repeat(64)}`,
        capabilityBindingDigest: `sha256:${'b'.repeat(64)}`,
      },
      resourceKind: 'model',
      emitEphemeral: (event) => emitted.push(event),
    });

    expect(emitted).toEqual([
      { type: 'model.text_delta', requestId: 'streaming-invocation-1', text: 'visible text' },
      {
        type: 'model.reasoning_delta',
        requestId: 'streaming-invocation-1',
        segmentId: 'segment-1',
        text: 'visible reasoning',
      },
      {
        type: 'model.reasoning_completed',
        requestId: 'streaming-invocation-1',
        segmentId: 'segment-1',
        text: 'visible reasoning',
      },
    ]);
  });

  test('does not send a delayed attempt after cancellation', async () => {
    const abort = new AbortController();
    let beginAttempt: (() => void) | undefined;
    const attemptReady = new Promise<void>((resolve) => {
      beginAttempt = resolve;
    });
    let sendCount = 0;
    const gateway = new ModelInvocationGateway({
      artifacts: {
        writeSurface: () => artifactRef('model_surface'),
        writeResponse: () => artifactRef('model_response'),
      },
      source: {
        attempt: async () => {
          sendCount += 1;
          return successfulOutcome();
        },
      },
      operationExecution: {
        execute: async (attempt) => {
          beginAttempt?.();
          await new Promise<void>((resolve) =>
            attempt.signal.addEventListener('abort', () => resolve(), { once: true }),
          );
          return attempt.attempt();
        },
      },
      runtimeIdSource: { next: () => 'cancelled-before-send', now: () => 1_000 },
      now: () => 1_000,
    });
    const compiled = compileModelSurface({
      purpose: 'primary_agent',
      config: CONFIG,
      model: createChatModel(CONFIG),
      messages: [humanMessage('Cancel before sending.')],
      tools: {},
      estimatedInputTokens: 1,
    });
    const pending = gateway.invoke({
      model: createChatModel(CONFIG),
      compiled,
      persistence: {
        getState: () => ({
          revision: 1,
          session: { threadId: 'stream-events-thread' },
          turn: { turnId: 'stream-events-turn' },
          resourceBudget: { status: 'unconfigured' },
        }),
        persistEvents: async () => true,
      },
      provenance: {
        promptContractVersion: 'stream-events-v1',
        projectionEnvironmentDigest: `sha256:${'a'.repeat(64)}`,
        capabilityBindingDigest: `sha256:${'b'.repeat(64)}`,
      },
      resourceKind: 'model',
      signal: abort.signal,
    });
    await attemptReady;
    abort.abort(new Error('Cancelled before HTTP dispatch.'));
    await expect(pending).rejects.toThrow();
    expect(sendCount).toBe(0);
  });

  test('ignores a provider stream callback after local cancellation', async () => {
    const abort = new AbortController();
    let started: (() => void) | undefined;
    const attemptReady = new Promise<void>((resolve) => {
      started = resolve;
    });
    let lateText: ((text: string) => void) | undefined;
    let lateReasoning: ((text: string, segmentId: string) => void) | undefined;
    let lateReasoningCompleted: ((text: string, segmentId: string) => void) | undefined;
    const emitted: Array<Record<string, unknown>> = [];
    const gateway = new ModelInvocationGateway({
      artifacts: {
        writeSurface: () => artifactRef('model_surface'),
        writeResponse: () => artifactRef('model_response'),
      },
      source: {
        attempt: (input) => {
          lateText = input.onTextCumulative;
          lateReasoning = input.onReasoningCumulative;
          lateReasoningCompleted = input.onReasoningCompleted;
          started?.();
          return new Promise<ModelAttemptOutcome>(() => {});
        },
      },
      operationExecution: { execute: (attempt) => attempt.attempt() },
      runtimeIdSource: { next: () => 'cancelled-stream', now: () => 1_000 },
      now: () => 1_000,
    });
    const compiled = compileModelSurface({
      purpose: 'primary_agent',
      config: CONFIG,
      model: createChatModel(CONFIG),
      messages: [humanMessage('Cancel the stream.')],
      tools: {},
      estimatedInputTokens: 1,
    });
    const pending = gateway.invoke({
      model: createChatModel(CONFIG),
      compiled,
      persistence: {
        getState: () => ({
          revision: 1,
          session: { threadId: 'stream-events-thread' },
          turn: { turnId: 'stream-events-turn' },
          resourceBudget: { status: 'unconfigured' },
        }),
        persistEvents: async () => true,
      },
      provenance: {
        promptContractVersion: 'stream-events-v1',
        projectionEnvironmentDigest: `sha256:${'a'.repeat(64)}`,
        capabilityBindingDigest: `sha256:${'b'.repeat(64)}`,
      },
      resourceKind: 'model',
      signal: abort.signal,
      emitEphemeral: (event) => emitted.push(event),
    });
    await attemptReady;
    abort.abort(new Error('Stream cancelled.'));
    await expect(pending).rejects.toThrow();
    lateText?.('late text');
    lateReasoning?.('late reasoning', 'segment-1');
    lateReasoningCompleted?.('late reasoning', 'segment-1');
    expect(emitted).toEqual([]);
  });
});
