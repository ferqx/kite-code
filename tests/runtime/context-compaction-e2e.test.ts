import { describe, expect, test } from 'bun:test';
import { executeContextCompaction } from '../../src/core/controllers/compaction-controller';
import type { ContextTokenEstimate } from '../../src/core/model/context-budget';
import { AgentKernel } from '../../src/core/runtime/kernel';
import { reduceRuntimeState } from '../../src/core/runtime/reducer';
import { decideNextEffect } from '../../src/core/runtime/scheduler';
import { createInitialRuntimeState } from '../../src/core/runtime/state';
import { createRuntimeStore } from '../../src/core/runtime/store';

const estimate: ContextTokenEstimate = {
  systemTokens: 10,
  toolSchemaTokens: 10,
  transcriptTokens: 5_000,
  summaryTokens: 0,
  dynamicRuntimeTokens: 10,
  framingTokens: 10,
  totalInputTokens: 5_040,
};

function requested(reason: 'manual' | 'auto' = 'manual') {
  const state = createInitialRuntimeState({ threadId: 'e2e', userId: 'u', workspace: '/ws' });
  state.transcript.messages = [
    {
      kind: 'user',
      messageId: 'message-1',
      turnId: state.turn.turnId,
      ordinal: 0,
      createdAt: '2026-07-22T00:00:00.000Z',
      content: 'Continue context compaction.',
    },
  ];
  return reduceRuntimeState(state, {
    type: 'context.compaction_requested',
    compactionId: 'compact-1',
    reason,
    requestedAtRevision: state.revision,
    requestedAtTurnId: state.turn.turnId,
    force: false,
    estimate,
  });
}

describe('narrative compaction e2e', () => {
  test('request → scheduler → executor → reducer activates one narrative checkpoint', async () => {
    const state = requested();
    expect(decideNextEffect(state)).toEqual({ type: 'compact_context', compactionId: 'compact-1' });
    const events = await executeContextCompaction({
      state,
      compactionId: 'compact-1',
      compact: async ({ sourceRevision, pending }) => ({
        compactionId: pending.compactionId,
        version: 1,
        sourceRevision,
        sourceDigest: 'digest',
        coveredThroughMessageId: 'message-1',
        coveredThroughTurnId: state.turn.turnId,
        summary: '# Historical work\n\nContinue context compaction.',
        inputTokensBefore: 5_000,
        inputTokensAfter: 1_000,
        reason: pending.reason,
        createdAt: '2026-07-22T00:00:01.000Z',
      }),
    });
    expect(events).toHaveLength(1);
    const completed = reduceRuntimeState(state, events[0]!);
    expect(completed.context.activeCheckpoint?.summary).toStartWith('# Historical work');
    expect(completed.transcript.messages).toEqual(state.transcript.messages);
  });

  test('manual and auto use the same reduction acceptance', async () => {
    for (const reason of ['manual', 'auto'] as const) {
      const state = requested(reason);
      const events = await executeContextCompaction({
        state,
        compactionId: 'compact-1',
        compact: async ({ sourceRevision, pending }) => ({
          compactionId: pending.compactionId,
          version: 1,
          sourceRevision,
          sourceDigest: 'digest',
          coveredThroughMessageId: 'message-1',
          coveredThroughTurnId: state.turn.turnId,
          summary: 'A valid narrative.',
          inputTokensBefore: 5_000,
          inputTokensAfter: 4_500,
          reason: pending.reason,
          createdAt: '2026-07-22T00:00:01.000Z',
        }),
      });
      expect(events[0]).toMatchObject({
        type: 'context.compaction_failed',
        errorKind: 'insufficient_reduction',
      });
    }
  });

  test('auto failure gates the normal model for this turn and releases on the next turn', async () => {
    const state = requested('auto');
    const [event] = await executeContextCompaction({
      state,
      compactionId: 'compact-1',
      compact: async () => {
        throw new Error('provider rejected summary');
      },
    });
    expect(event).toMatchObject({
      type: 'context.compaction_failed',
      errorKind: 'summary_model_failed',
      requestedAtTurnId: state.turn.turnId,
    });

    const failed = reduceRuntimeState(state, event!);
    expect(decideNextEffect(failed)).toEqual({ type: 'stop' });

    const next = reduceRuntimeState(failed, { type: 'turn.started', turnId: 'next-turn' });
    expect(decideNextEffect(next)).toEqual({ type: 'call_model' });
  });

  test('revision-stale results are rejected by the Kernel lease', () => {
    const state = requested();
    const kernel = new AgentKernel({
      store: createRuntimeStore(':memory:'),
      initialState: state,
      interactionMode: 'accept_edits',
    });
    const lease = kernel.beginEffect({ type: 'compact_context', compactionId: 'compact-1' });
    kernel.processEvent({ type: 'user.message_appended', messageId: 'new', content: 'new work' });
    expect(kernel.applyEffectResult(lease, [])).toBe(false);
    kernel.close();
  });

  test('reset removes checkpoint projection without changing transcript', () => {
    const state = requested();
    state.context.activeCheckpoint = {
      compactionId: 'active',
      version: 1,
      sourceRevision: 0,
      sourceDigest: 'digest',
      coveredThroughMessageId: 'message-1',
      coveredThroughTurnId: state.turn.turnId,
      summary: 'Narrative.',
      inputTokensBefore: 5_000,
      inputTokensAfter: 1_000,
      reason: 'manual',
      createdAt: '2026-07-22T00:00:01.000Z',
    };
    const transcript = state.transcript.messages;
    const reset = reduceRuntimeState(state, {
      type: 'context.compaction_reset',
      checkpointId: 'active',
      reason: 'manual',
    });
    expect(reset.context.activeCheckpoint).toBeUndefined();
    expect(reset.transcript.messages).toBe(transcript);
  });
});
