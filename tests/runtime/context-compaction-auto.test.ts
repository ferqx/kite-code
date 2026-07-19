import { describe, expect, test } from 'bun:test';
import type { AgentConfig } from '../../src/core/config';
import { invokeRuntimeModel } from '../../src/core/controllers/model-controller';
import { aiMessage } from '../../src/core/messages';
import type { ContextPreflight, ContextTokenEstimate } from '../../src/core/model/context-budget';
import {
  decideAutomaticContextCompaction,
  isProviderContextOverflow,
} from '../../src/core/model/context-compaction-decision';
import { reduceRuntimeState } from '../../src/core/runtime/reducer';
import { decideNextEffect } from '../../src/core/runtime/scheduler';
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

function preflight(status: 'soft' | 'hard', totalInputTokens = 9_000): ContextPreflight {
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
  };
}

describe('automatic context compaction', () => {
  test('requests soft compaction only when estimated gain and cooldown allow it', () => {
    const state = historicalState();
    expect(
      decideAutomaticContextCompaction({
        state,
        preflight: preflight('soft'),
        enabled: true,
      }),
    ).toMatchObject({ action: 'request_compaction', reason: 'auto_soft' });

    state.context.lastCompactionTurnIndex = 5;
    expect(
      decideAutomaticContextCompaction({
        state,
        preflight: preflight('soft'),
        enabled: true,
      }),
    ).toEqual({ action: 'invoke' });
  });

  test('hard preflight ignores cooldown but fails closed without a safe boundary', () => {
    const state = historicalState();
    state.context.lastCompactionTurnIndex = state.turn.turnIndex;
    expect(
      decideAutomaticContextCompaction({
        state,
        preflight: preflight('hard'),
        enabled: true,
      }),
    ).toMatchObject({ action: 'request_compaction', reason: 'auto_hard' });

    state.interactions = {
      kind: 'awaiting_user_input',
      interactionId: 'input',
      toolCallId: 'ask',
      request: { question: 'Continue?', options: [], allow_free_text: true },
    };
    expect(
      decideAutomaticContextCompaction({
        state,
        preflight: preflight('hard'),
        enabled: true,
      }),
    ).toMatchObject({ action: 'block' });
  });

  test('model preflight emits a durable hard request without invoking the provider', async () => {
    const state = historicalState();
    const mock = createMockModel([{ message: aiMessage({ content: 'must not be called' }) }]);
    const events = await invokeRuntimeModel({ model: mock, state, config: config() });
    expect(mock.callCount.count).toBe(0);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'context.compaction_requested',
        reason: 'auto_hard',
        force: false,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'model.context_metrics', status: 'hard' }),
    );
    expect(events.some((event) => event.type === 'model.requested')).toBe(false);
  });

  test('hard compaction failure blocks an immediate repeat model call', () => {
    const requested = reduceRuntimeState(historicalState(), {
      type: 'context.compaction_requested',
      compactionId: 'hard',
      reason: 'auto_hard',
      requestedAtRevision: 0,
      requestedAtTurnId: 'turn-5',
      force: false,
      estimate: estimate(9_000),
    });
    requested.revision = 10;
    const failed = reduceRuntimeState(requested, {
      type: 'context.compaction_failed',
      compactionId: 'hard',
      sourceRevision: 10,
      errorKind: 'insufficient_reduction',
      message: 'still too large',
      retryable: true,
    });
    failed.revision = 11;
    expect(decideNextEffect(failed)).toMatchObject({
      type: 'recovery_blocked',
      reason: expect.stringContaining('still too large'),
    });
  });

  test('recognizes provider overflow without treating unrelated failures as overflow', () => {
    expect(isProviderContextOverflow(new Error('maximum context length exceeded'))).toBe(true);
    expect(isProviderContextOverflow({ code: 'context_length_exceeded' })).toBe(true);
    expect(isProviderContextOverflow({ status: 413 })).toBe(true);
    expect(isProviderContextOverflow(new Error('rate limit exceeded'))).toBe(false);
  });

  test('converts provider overflow into one recovery request per turn', async () => {
    const state = historicalState();
    const mock = createMockModel([
      {
        message: aiMessage({ content: 'overflow' }),
        error: 'maximum context length exceeded',
      },
    ]);
    const wideConfig = config();
    wideConfig.modelKwargs = { contextWindowTokens: 128_000, maxOutputTokens: 1_000 };
    const first = await invokeRuntimeModel({ model: mock, state, config: wideConfig });
    expect(first).toContainEqual(
      expect.objectContaining({
        type: 'context.compaction_requested',
        reason: 'overflow_recovery',
        force: true,
      }),
    );
    const recovered = first.reduce(reduceRuntimeState, state);
    expect(recovered.context.overflowRecoveryTurnId).toBe(state.turn.turnId);
    await expect(
      invokeRuntimeModel({ model: mock, state: recovered, config: wideConfig }),
    ).rejects.toThrow(/context overflow persisted/i);
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
      reason: 'auto_soft',
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
});
