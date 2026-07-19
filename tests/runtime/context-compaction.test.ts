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
  toolSchemaTokens: 20,
  transcriptTokens: 900,
  summaryTokens: 0,
  dynamicRuntimeTokens: 20,
  framingTokens: 50,
  totalInputTokens: 1_000,
};

function summary(sourceDigest: string, firstMessageId = 'message-1', lastMessageId = 'message-1') {
  return {
    version: 1 as const,
    objective: 'retain this fact',
    userConstraints: [],
    decisions: [],
    completedWork: [],
    observations: [],
    failures: [],
    pendingWork: [],
    unresolvedQuestions: [],
    recentUserIntent: 'retain this fact',
    provenance: {
      firstMessageId,
      lastMessageId,
      sourceDigest,
      mandatoryFactIds: [],
    },
  };
}

function requestedState() {
  const initial = createInitialRuntimeState({
    threadId: 'compaction',
    userId: 'user',
    workspace: '/workspace',
  });
  initial.transcript.messages = [
    {
      kind: 'user',
      messageId: 'message-1',
      turnId: initial.turn.turnId,
      ordinal: 0,
      createdAt: '2026-07-20T00:00:00.000Z',
      content: 'retain this fact',
    },
  ];
  return reduceRuntimeState(initial, {
    type: 'context.compaction_requested',
    compactionId: 'compact-1',
    reason: 'auto_soft',
    requestedAtRevision: initial.revision,
    requestedAtTurnId: initial.turn.turnId,
    force: false,
    estimate,
  });
}

describe('eventized context compaction', () => {
  test('persists a pending request and schedules it after higher-priority work', () => {
    const state = requestedState();
    expect(state.context.pendingCompaction).toMatchObject({
      compactionId: 'compact-1',
      reason: 'auto_soft',
    });
    expect(decideNextEffect(state)).toEqual({
      type: 'compact_context',
      compactionId: 'compact-1',
    });

    state.tools.calls.tool = {
      toolCallId: 'tool',
      modelMessageId: 'model',
      name: 'read_file',
      args: {},
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue = ['tool'];
    expect(decideNextEffect(state)).toEqual({ type: 'run_tools', toolCallIds: ['tool'] });

    state.tools.queue = [];
    state.transcript.final = 'done';
    expect(decideNextEffect(state)).toEqual({ type: 'emit_final' });
  });

  test('controller completes a valid leased checkpoint and reducer activates it', async () => {
    const state = requestedState();
    const events = await executeContextCompaction({
      state,
      compactionId: 'compact-1',
      compact: async ({ sourceRevision, pending }) => ({
        compactionId: pending.compactionId,
        version: 1,
        sourceRevision,
        sourceDigest: 'sha256:source',
        coveredThroughMessageId: 'message-1',
        coveredThroughTurnId: state.turn.turnId,
        summary: summary('sha256:source'),
        inputTokensBefore: 1_000,
        inputTokensAfter: 400,
        targetTokens: 550,
        reason: pending.reason,
        createdAt: '2026-07-20T00:00:01.000Z',
      }),
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('context.compaction_completed');

    const completed = reduceRuntimeState(state, events[0]!);
    expect(completed.context.pendingCompaction).toBeUndefined();
    expect(completed.context.activeCheckpoint?.compactionId).toBe('compact-1');
    expect(completed.context.history.at(-1)?.kind).toBe('completed');

    const reset = reduceRuntimeState(completed, {
      type: 'context.compaction_reset',
      checkpointId: 'compact-1',
      reason: 'manual',
    });
    expect(reset.context.activeCheckpoint).toBeUndefined();
    expect(reset.context.history.at(-1)).toEqual({
      kind: 'reset',
      compactionId: 'compact-1',
      reason: 'manual',
    });
  });

  test('records typed failures and rejects stale compaction results through the kernel lease', () => {
    const state = requestedState();
    const failed = reduceRuntimeState(state, {
      type: 'context.compaction_failed',
      compactionId: 'compact-1',
      sourceRevision: state.revision,
      errorKind: 'invalid_schema',
      message: 'bad summary',
      retryable: false,
    });
    expect(failed.context.pendingCompaction).toBeUndefined();
    expect(failed.context.lastFailure?.errorKind).toBe('invalid_schema');

    const store = createRuntimeStore(':memory:');
    const kernel = new AgentKernel({
      store,
      initialState: state,
      interactionMode: 'accept_edits',
    });
    const lease = kernel.beginEffect({ type: 'compact_context', compactionId: 'compact-1' });
    kernel.processEvent({
      type: 'user.message_appended',
      messageId: 'newer',
      content: 'new source revision',
    });
    expect(
      kernel.applyEffectResult(lease, [
        {
          type: 'context.compaction_failed',
          compactionId: 'compact-1',
          sourceRevision: lease.expectedRevision,
          errorKind: 'stale_source',
          message: 'stale',
          retryable: true,
        },
      ]),
    ).toBe(false);
    expect(kernel.getState().context.pendingCompaction?.compactionId).toBe('compact-1');
    kernel.close();
  });

  test('maps missing implementations and invalid boundaries to typed failures', async () => {
    const state = requestedState();
    expect(await executeContextCompaction({ state, compactionId: 'compact-1' })).toMatchObject([
      { type: 'context.compaction_failed', errorKind: 'summary_model_failed' },
    ]);
    expect(
      await executeContextCompaction({
        state,
        compactionId: 'compact-1',
        compact: async ({ sourceRevision, pending }) => ({
          compactionId: pending.compactionId,
          version: 1,
          sourceRevision,
          sourceDigest: 'digest',
          coveredThroughMessageId: 'missing',
          coveredThroughTurnId: state.turn.turnId,
          summary: summary('digest', 'missing', 'missing'),
          inputTokensBefore: 1_000,
          inputTokensAfter: 400,
          targetTokens: 550,
          reason: pending.reason,
          createdAt: '2026-07-20T00:00:01.000Z',
        }),
      }),
    ).toMatchObject([{ type: 'context.compaction_failed', errorKind: 'unsafe_boundary' }]);
  });
});
