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
  };
}

describe('automatic context compaction', () => {
  test('requests soft compaction only when estimated gain and cooldown allow it', () => {
    const state = historicalState();
    expect(
      decideAutomaticContextCompaction({
        state,
        preflight: preflight('compact_due'),
        enabled: true,
      }),
    ).toMatchObject({ action: 'request_compaction', reason: 'auto_soft' });

    state.context.lastCompactionTurnIndex = 5;
    expect(
      decideAutomaticContextCompaction({
        state,
        preflight: preflight('compact_due'),
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
        preflight: preflight('hard_limit'),
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
        preflight: preflight('hard_limit'),
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
      expect.objectContaining({ type: 'model.context_metrics', status: 'hard_limit' }),
    );
    expect(events.some((event) => event.type === 'model.requested')).toBe(false);
  });

  test('hard compaction failure blocks an immediate repeat model call via durable hardBlock', () => {
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
    // hardBlock should be set on auto_hard + insufficient_reduction
    expect(failed.context.hardBlock).toBeDefined();
    expect(failed.context.hardBlock!.reason).toBe('hard_limit');
    // Even after unrelated revision changes, the block persists.
    failed.revision = 11;
    expect(decideNextEffect(failed)).toMatchObject({
      type: 'recovery_blocked',
      reason: expect.stringContaining('hard-blocked'),
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
    // PR 6: second overflow emits context.hard_blocked event (no longer throws Error)
    const second = await invokeRuntimeModel({ model: mock, state: recovered, config: wideConfig });
    expect(second).toContainEqual(
      expect.objectContaining({
        type: 'context.hard_blocked',
        reason: 'overflow_recovery_failed',
      }),
    );
    const blocked = second.reduce(reduceRuntimeState, recovered);
    expect(blocked.context.hardBlock?.reason).toBe('overflow_recovery_failed');
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

  describe('hard block and thrash breaker', () => {
    test('durable hard block prevents further auto-compaction after hard-limit failure', () => {
      const state = historicalState();
      // Set pending then fail — simulates a real failed compaction attempt.
      const pending: Parameters<typeof reduceRuntimeState>[1] = {
        type: 'context.compaction_requested',
        compactionId: 'cmp-fail',
        reason: 'auto_hard',
        requestedAtRevision: state.revision,
        requestedAtTurnId: state.turn.turnId,
        force: false,
        estimate: estimate(10_000),
      };
      const withPending = reduceRuntimeState(state, pending);
      const withHardBlock = reduceRuntimeState(withPending, {
        type: 'context.compaction_failed',
        compactionId: 'cmp-fail',
        sourceRevision: state.revision,
        errorKind: 'insufficient_reduction',
        message: 'Not enough reduction.',
        retryable: false,
      });

      expect(withHardBlock.context.hardBlock).toBeDefined();
      expect(withHardBlock.context.hardBlock!.reason).toBe('hard_limit');

      // Decision should block.
      const decision = decideAutomaticContextCompaction({
        state: withHardBlock,
        preflight: preflight('hard_limit'),
        enabled: true,
      });
      expect(decision.action).toBe('block');
    });

    test('successful compaction clears hard block', () => {
      const state = historicalState();
      const withPending = reduceRuntimeState(state, {
        type: 'context.compaction_requested',
        compactionId: 'cmp-ok',
        reason: 'auto_hard',
        requestedAtRevision: state.revision,
        requestedAtTurnId: state.turn.turnId,
        force: false,
        estimate: estimate(10_000),
      });
      // Simulate failure first, then success.
      const failed = reduceRuntimeState(withPending, {
        type: 'context.compaction_failed',
        compactionId: 'cmp-ok',
        sourceRevision: state.revision,
        errorKind: 'insufficient_reduction',
        message: 'failed',
        retryable: false,
      });
      expect(failed.context.hardBlock).toBeDefined();

      // Now set up another pending and complete successfully.
      const withPending2 = reduceRuntimeState(failed, {
        type: 'context.compaction_requested',
        compactionId: 'cmp-win',
        reason: 'manual',
        requestedAtRevision: state.revision + 1,
        requestedAtTurnId: state.turn.turnId,
        force: false,
        estimate: estimate(10_000),
      });
      const succeeded = reduceRuntimeState(withPending2, {
        type: 'context.compaction_completed',
        compactionId: 'cmp-win',
        sourceRevision: state.revision + 1,
        checkpoint: {
          compactionId: 'cmp-win',
          version: 1,
          sourceRevision: state.revision + 1,
          sourceDigest: 'abc',
          coveredThroughMessageId: 'msg-3',
          coveredThroughTurnId: 'turn-3',
          summary: { version: 2 } as never,
          inputTokensBefore: 10_000,
          inputTokensAfter: 5_000,
          targetTokens: 6_000,
          reason: 'manual',
          createdAt: new Date().toISOString(),
        },
      });
      expect(succeeded.context.hardBlock).toBeUndefined();
    });

    test('compaction_reset clears hard block', () => {
      const state = historicalState();
      // Set up hard block via failure.
      const withPending = reduceRuntimeState(state, {
        type: 'context.compaction_requested',
        compactionId: 'cmp-fail2',
        reason: 'auto_hard',
        requestedAtRevision: state.revision,
        requestedAtTurnId: state.turn.turnId,
        force: false,
        estimate: estimate(10_000),
      });
      const failed = reduceRuntimeState(withPending, {
        type: 'context.compaction_failed',
        compactionId: 'cmp-fail2',
        sourceRevision: state.revision,
        errorKind: 'insufficient_reduction',
        message: 'failed',
        retryable: false,
      });
      expect(failed.context.hardBlock).toBeDefined();

      // Set active checkpoint and reset
      const withCp = {
        ...failed,
        context: { ...failed.context, activeCheckpoint: { compactionId: 'old-cp' } as never },
      };
      const reset = reduceRuntimeState(withCp as RuntimeState, {
        type: 'context.compaction_reset',
        checkpointId: 'old-cp',
        reason: 'manual',
      });
      expect(reset.context.hardBlock).toBeUndefined();
      expect(reset.context.autoGuard.disabledUntilManualAction).toBe(false);
    });
  });
});
