import { describe, expect, test } from 'bun:test';
import type { ContextPreflight, ContextTokenEstimate } from '@kite-ai/builtin-runtime/model';
import {
  aiMessage,
  decideAutomaticContextCompaction,
  manualContextCompactionEvent,
} from '@kite-ai/builtin-runtime/model';
import {
  createRuntimeHostStateInitialState,
  type RuntimeState,
} from '@kite-ai/runtime-host/kernel-adapter';
import type { AgentConfig } from '#kite-service/config';
import { reduceRuntimeState } from '#runtime-support/runtime-state-reducer';
import { createMockModel } from '../../../../tests/helpers/mock-model';
import { projectTestPrimaryModelEffect } from '../../../../tests/helpers/runtime-model';

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
  };
}

function historicalState(): RuntimeState {
  const state = createRuntimeHostStateInitialState({
    recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
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
      contextCompaction: true,
      contextCompactionAuto: true,
    },
    modelCapabilities: {
      contextWindowTokens: 8_000,
      maxOutputTokens: 1_000,
    },
    modelKwargs: {
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
        preflight: { ...preflight('compact_due'), utilization: 0.899 },
        mode: 'live',
      }),
    ).toEqual({ action: 'invoke' });
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
      let requested = 0;
      const events = await projectTestPrimaryModelEffect({
        model: mock,
        state,
        config: currentConfig,
        compactionReporter: {
          recordRequested: () => requested++,
          recordCompleted() {
            throw new Error('shadow/off must not complete compaction');
          },
          recordFailed() {
            throw new Error('shadow/off must not fail compaction');
          },
        },
      });
      expect(mock.callCount.count).toBe(1);
      expect(requested).toBe(0);
      expect(events.some((event) => event.type === 'context.compaction_requested')).toBe(false);
      expect(
        events.some(
          (event) =>
            event.type === 'context.compaction_completed' ||
            event.type === 'context.compaction_failed',
        ),
      ).toBe(false);
      expect(state.context.activeCheckpoint).toBeUndefined();
    }

    const liveMock = createMockModel([{ message: aiMessage({ content: 'must not be called' }) }]);
    const liveEvents = await projectTestPrimaryModelEffect({
      model: liveMock,
      state,
      config: config(),
    });
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
        compactAfterEstimatedTokens: 8_000,
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
    expect(failed.context.lastFailure?.requestedAtTurnId).toBe('turn-5');
  });

  test('a new turn retries a prior auto failure even when cooldown or breaker is active', () => {
    const state = historicalState();
    state.context.lastFailure = {
      compactionId: 'previous-failure',
      sourceRevision: 1,
      errorKind: 'summary_model_failed',
      message: 'provider rejected summary',
      retryable: true,
      reason: 'auto',
      requestedAtTurnId: 'previous-turn',
    };
    state.context.lastCompactionTurnIndex = state.turn.turnIndex;
    state.context.autoGuard.disabledUntilManualAction = true;

    expect(
      decideAutomaticContextCompaction({
        state,
        preflight: preflight('compact_due'),
        mode: 'live',
      }),
    ).toMatchObject({ action: 'request_compaction', reason: 'auto' });
  });

  test('consumes the single new-turn recovery and does not retry forever', () => {
    let state = historicalState();
    state.context.lastFailure = {
      compactionId: 'first-failure',
      sourceRevision: 1,
      errorKind: 'summary_model_failed',
      message: 'provider failed',
      retryable: true,
      reason: 'auto',
      requestedAtTurnId: 'previous-turn',
    };
    const retry = decideAutomaticContextCompaction({
      state,
      preflight: preflight('compact_due'),
      mode: 'live',
    });
    expect(retry).toMatchObject({ action: 'request_compaction' });
    if (retry.action !== 'request_compaction') throw new Error('expected retry');
    state = reduceRuntimeState(state, {
      type: 'context.compaction_requested',
      compactionId: retry.compactionId,
      reason: 'auto',
      requestedAtRevision: state.revision,
      requestedAtTurnId: state.turn.turnId,
      force: false,
      estimate: estimate(9_000),
    });
    state = reduceRuntimeState(state, {
      type: 'context.compaction_failed',
      compactionId: retry.compactionId,
      sourceRevision: state.revision,
      errorKind: 'summary_model_failed',
      message: 'provider failed again',
      retryable: true,
    });
    state = reduceRuntimeState(state, { type: 'turn.started', turnId: 'later-turn' });
    expect(
      decideAutomaticContextCompaction({
        state,
        preflight: preflight('compact_due'),
        mode: 'live',
      }),
    ).toEqual({ action: 'invoke' });
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
    wideConfig.modelCapabilities = { contextWindowTokens: 128_000, maxOutputTokens: 1_000 };
    await expect(
      projectTestPrimaryModelEffect({ model: mock, state, config: wideConfig }),
    ).rejects.toThrow('MODEL_ATTEMPT_FATAL_FAILURE:provider_failure');
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
      summary: 'Continue the task from the compacted historical work.',
      inputTokensBefore: 20_000,
      inputTokensAfter: 8_000,
      reason: 'auto',
      createdAt: '2026-07-20T00:00:00.000Z',
    };
    const mock = createMockModel([{ message: aiMessage({ content: 'continued' }) }]);
    const wideConfig = config();
    wideConfig.modelCapabilities = { contextWindowTokens: 128_000, maxOutputTokens: 1_000 };
    const events = await projectTestPrimaryModelEffect({
      model: mock,
      state,
      config: wideConfig,
    });
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
