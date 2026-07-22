import { describe, expect, test } from 'bun:test';
import type { AgentConfig } from '../../src/core/config';
import { invokeRuntimeModel } from '../../src/core/controllers/model-controller';
import { aiMessage } from '../../src/core/messages';
import type { ContextPreflight, ContextTokenEstimate } from '../../src/core/model/context-budget';
import { decideAutomaticContextCompaction } from '../../src/core/model/context-compaction-decision';
import { manualContextCompactionEvent } from '../../src/core/model/context-compaction-manual';
import { reduceRuntimeState } from '../../src/core/runtime/reducer';
import { createInitialRuntimeState, type RuntimeState } from '../../src/core/runtime/state';
import { createMockModel } from '../mock-model';

function estimate(totalInputTokens: number): ContextTokenEstimate {
  return {
    systemTokens: 100,
    toolSchemaTokens: 100,
    transcriptTokens: totalInputTokens - 400,
    summaryTokens: 0,
    dynamicRuntimeTokens: 100,
    framingTokens: 100,
    totalInputTokens,
  };
}

function preflight(
  status: 'compact_due' | 'hard_limit',
  totalInputTokens = 9_000,
): ContextPreflight {
  return {
    estimate: estimate(totalInputTokens),
    usableInputTokens: 10_000,
    reservedOutputTokens: 1_000,
    providerSafetyMarginTokens: 500,
    utilization: totalInputTokens / 10_000,
    status,
    targetTokens: 5_500,
  };
}

function historicalState(): RuntimeState {
  const state = createInitialRuntimeState({
    threadId: 'auto-compaction',
    userId: 'user',
    workspace: '/workspace',
  });
  state.transcript.messages = Array.from({ length: 6 }, (_, index) => ({
    kind: 'user' as const,
    messageId: `message-${index}`,
    turnId: `turn-${index}`,
    ordinal: index,
    createdAt: `2026-07-20T00:00:0${index}.000Z`,
    content: `history-${index} ${'context '.repeat(2_000)}`,
  }));
  state.turn.turnIndex = 6;
  return state;
}

function config(): AgentConfig {
  return {
    apiKey: 'test',
    baseURL: 'http://localhost',
    modelName: 'mock',
    providerName: 'mock',
    providerType: 'openai-compatible',
    sandbox: { enabled: false },
    features: {
      contextCompactionV2: true,
      contextCompactionAutoV1: true,
    },
    modelKwargs: {
      contextWindowTokens: 8_000,
      maxOutputTokens: 1_000,
      providerSafetyMarginTokens: 500,
    },
    compaction: { autoMode: 'live' },
  };
}

describe('automatic context compaction', () => {
  test('requests auto compaction only when eligibility and cooldown allow it', () => {
    const state = historicalState();
    expect(
      decideAutomaticContextCompaction({
        state,
        preflight: preflight('compact_due'),
        mode: 'live',
      }),
    ).toMatchObject({ action: 'request_compaction', reason: 'auto' });

    state.context.lastCompactionTurnIndex = 5;
    expect(
      decideAutomaticContextCompaction({
        state,
        preflight: preflight('hard_limit'),
        mode: 'live',
      }),
    ).toEqual({ action: 'invoke' });
  });

  test('hard-limit diagnostics never bypass cooldown or block without a safe boundary', () => {
    const state = historicalState();
    state.interactions = {
      kind: 'awaiting_user_input',
      interactionId: 'input',
      toolCallId: 'ask',
      request: { question: 'Continue?', options: [], allow_free_text: true },
    };
    expect(
      decideAutomaticContextCompaction({
        state,
        preflight: preflight('hard_limit'),
        mode: 'live',
      }),
    ).toEqual({ action: 'invoke' });
  });

  test('off and shadow modes invoke the provider while live emits reason=auto', async () => {
    const state = historicalState();
    for (const mode of ['off', 'shadow'] as const) {
      const currentConfig = config();
      currentConfig.compaction = { autoMode: mode };
      const mock = createMockModel([{ message: aiMessage({ content: `called-${mode}` }) }]);
      const events = await invokeRuntimeModel({ model: mock, state, config: currentConfig });
      expect(mock.callCount.count).toBe(1);
      expect(events.some((event) => event.type === 'context.compaction_requested')).toBe(false);
    }

    const liveMock = createMockModel([{ message: aiMessage({ content: 'must not be called' }) }]);
    const liveEvents = await invokeRuntimeModel({ model: liveMock, state, config: config() });
    expect(liveMock.callCount.count).toBe(0);
    expect(liveEvents).toContainEqual(
      expect.objectContaining({
        type: 'context.compaction_requested',
        reason: 'auto',
        force: false,
      }),
    );
    expect(liveEvents).toContainEqual(
      expect.objectContaining({ type: 'model.context_metrics', status: 'hard_limit' }),
    );
  });

  test('absolute token trigger works when utilization is unknown', () => {
    const state = historicalState();
    const unknown = {
      ...preflight('compact_due'),
      utilization: undefined,
      status: 'unknown' as const,
    };
    expect(
      decideAutomaticContextCompaction({
        state,
        preflight: unknown,
        mode: 'live',
        triggerTokens: 8_000,
      }),
    ).toMatchObject({ action: 'request_compaction', reason: 'auto' });
  });

  test('auto compaction failure records breaker state without creating a hard block', () => {
    const requested = reduceRuntimeState(historicalState(), {
      type: 'context.compaction_requested',
      compactionId: 'auto-failure',
      reason: 'auto',
      requestedAtRevision: 0,
      requestedAtTurnId: 'turn-5',
      force: false,
      estimate: estimate(9_000),
    });
    requested.revision = 10;
    const failed = reduceRuntimeState(requested, {
      type: 'context.compaction_failed',
      compactionId: 'auto-failure',
      sourceRevision: 10,
      errorKind: 'insufficient_reduction',
      message: 'still too large',
      retryable: true,
    });
    expect(failed.context.hardBlock).toBeUndefined();
    expect(failed.context.autoGuard.consecutiveLowGain).toBe(1);
  });

  test('does not infer compaction or hard block from a provider 400-style failure', async () => {
    const state = historicalState();
    const mock = createMockModel([
      {
        message: aiMessage({ content: 'overflow' }),
        error: 'maximum context length exceeded',
      },
    ]);
    const wideConfig = config();
    wideConfig.modelKwargs = { contextWindowTokens: 128_000, maxOutputTokens: 1_000 };
    await expect(invokeRuntimeModel({ model: mock, state, config: wideConfig })).rejects.toThrow(
      'maximum context length exceeded',
    );
    expect(state.context.pendingCompaction).toBeUndefined();
    expect(state.context.hardBlock).toBeUndefined();
    expect(manualContextCompactionEvent({ state, config: wideConfig })).toMatchObject({
      type: 'context.compaction_requested',
      reason: 'manual',
    });
  });

  test('projects an active checkpoint plus live tail and accounts summary tokens separately', async () => {
    const state = historicalState();
    state.context.activeCheckpoint = {
      compactionId: 'active',
      version: 1,
      sourceRevision: 1,
      sourceDigest: 'source-digest',
      coveredThroughMessageId: 'message-2',
      coveredThroughTurnId: 'turn-2',
      summary: {
        version: 1,
        objective: 'Continue the task.',
        userConstraints: [],
        decisions: [],
        completedWork: [],
        observations: [],
        failures: [],
        pendingWork: [],
        unresolvedQuestions: [],
        recentUserIntent: 'Continue',
        provenance: {
          firstMessageId: 'message-0',
          lastMessageId: 'message-2',
          sourceDigest: 'source-digest',
          mandatoryFactIds: [],
        },
      },
      inputTokensBefore: 20_000,
      inputTokensAfter: 8_000,
      targetTokens: 10_000,
      reason: 'auto',
      createdAt: '2026-07-20T00:00:00.000Z',
    };
    const mock = createMockModel([{ message: aiMessage({ content: 'continued' }) }]);
    const wideConfig = config();
    wideConfig.modelKwargs = { contextWindowTokens: 128_000, maxOutputTokens: 1_000 };
    const events = await invokeRuntimeModel({ model: mock, state, config: wideConfig });
    const metrics = events.find((event) => event.type === 'model.context_metrics');
    expect(metrics?.type).toBe('model.context_metrics');
    if (metrics?.type === 'model.context_metrics') {
      expect(metrics.estimate.summaryTokens).toBeGreaterThan(0);
      expect(metrics.estimate.transcriptTokens).toBeLessThan(8_000);
    }
    expect(mock.callCount.count).toBe(1);
  });

  test('compaction and reset do not clear a Runtime correctness hard block', () => {
    const state = reduceRuntimeState(historicalState(), {
      type: 'context.hard_blocked',
      reason: 'runtime_invariant_violation',
      sourceDigest: 'source',
      message: 'invariant failed',
      createdAtTurnId: 'turn-5',
    });
    const withCheckpoint = {
      ...state,
      context: { ...state.context, activeCheckpoint: { compactionId: 'old-cp' } as never },
    };
    const reset = reduceRuntimeState(withCheckpoint as RuntimeState, {
      type: 'context.compaction_reset',
      checkpointId: 'old-cp',
      reason: 'manual',
    });
    expect(reset.context.hardBlock?.reason).toBe('runtime_invariant_violation');
  });
});
