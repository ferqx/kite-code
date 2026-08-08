import { describe, expect, test } from 'bun:test';
import {
  type ContextCompactor,
  executeContextCompaction,
} from '../../src/core/controllers/compaction-controller';
import { expectedCompactionSourceDigest } from '../../src/core/model/compaction-summary';
import type { ContextTokenEstimate } from '../../src/core/model/context-budget';
import {
  buildContextProjection,
  type ContextProjectionEnvironment,
} from '../../src/core/model/context-projection';
import type { ContextCompactionCheckpoint } from '../../src/core/runtime/context-compaction';
import { createRuntimeEffectExecutor } from '../../src/core/runtime/executor';
import { AgentKernel } from '../../src/core/runtime/kernel';
import { reduceRuntimeState } from '../../src/core/runtime/reducer';
import { decideNextEffect } from '../../src/core/runtime/scheduler';
import { createInitialRuntimeState } from '../../src/core/runtime/state';
import { createRuntimeStore } from '../../src/core/runtime/store';
import { createMockModel } from '../mock-model';

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
      turnId: 'historical-turn',
      ordinal: 0,
      createdAt: '2026-07-22T00:00:00.000Z',
      content: 'Continue context compaction. '.repeat(2_000),
    },
    {
      kind: 'user',
      messageId: 'message-2',
      turnId: state.turn.turnId,
      ordinal: 1,
      createdAt: '2026-07-22T00:00:01.000Z',
      content: 'Current work must remain live.',
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

function checkpointFor(
  state: ReturnType<typeof requested>,
  reason: 'manual' | 'auto',
  sourceRevision: number,
  summary: string,
  environment?: ContextProjectionEnvironment,
): ContextCompactionCheckpoint {
  const projectionInput = {
    role: 'agent' as const,
    state,
    serializedTools: environment?.serializedTools,
    activeSkillInstructions: environment?.activeSkillInstructions,
    workflowSkills: environment?.workflowSkills,
  };
  const before = buildContextProjection(projectionInput).estimate.totalInputTokens;
  const checkpoint: ContextCompactionCheckpoint = {
    compactionId: 'compact-1',
    version: 1,
    sourceRevision,
    sourceDigest: expectedCompactionSourceDigest(undefined, [state.transcript.messages[0]!]),
    coveredThroughMessageId: 'message-1',
    coveredThroughTurnId: 'historical-turn',
    summary,
    inputTokensBefore: before,
    inputTokensAfter: 0,
    reason,
    createdAt: '2026-07-22T00:00:01.000Z',
  };
  return {
    ...checkpoint,
    inputTokensAfter: buildContextProjection({
      ...projectionInput,
      candidateCheckpoint: checkpoint,
    }).estimate.totalInputTokens,
  };
}

describe('narrative compaction e2e', () => {
  test('request → scheduler → executor → reducer activates one narrative checkpoint', async () => {
    const state = requested();
    expect(decideNextEffect(state)).toEqual({ type: 'compact_context', compactionId: 'compact-1' });
    const events = await executeContextCompaction({
      state,
      compactionId: 'compact-1',
      compact: async ({ sourceRevision, pending }) =>
        checkpointFor(
          state,
          pending.reason,
          sourceRevision,
          '# Historical work\n\nContinue context compaction.',
        ),
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
        compact: async ({ sourceRevision, pending }) =>
          checkpointFor(
            state,
            pending.reason,
            sourceRevision,
            String(state.transcript.messages[0]!.content).trim(),
          ),
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

  test('Runtime effect lease suppresses a duplicate compaction dispatch', async () => {
    const state = requested();
    const store = createRuntimeStore(':memory:');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    let compactorCalls = 0;
    const contextCompactor: ContextCompactor = async ({
      sourceRevision,
      pending,
      projectionEnvironment,
    }) => {
      compactorCalls += 1;
      markEntered();
      await gate;
      return checkpointFor(
        state,
        pending.reason,
        sourceRevision,
        'One durable summary.',
        projectionEnvironment,
      );
    };
    const dependencies = {
      config: {
        providerName: 'test',
        providerType: 'openai-compatible' as const,
        apiKey: 'test',
        baseURL: 'http://localhost:1',
        modelName: 'test',
        sandbox: { enabled: true },
      },
      model: createMockModel([]),
      runtimeStore: store,
      contextCompactor,
    };
    const firstExecutor = createRuntimeEffectExecutor(dependencies);
    const secondExecutor = createRuntimeEffectExecutor(dependencies);

    try {
      const first = firstExecutor({ type: 'compact_context', compactionId: 'compact-1' }, state);
      await entered;
      const duplicate = await secondExecutor(
        { type: 'compact_context', compactionId: 'compact-1' },
        state,
      );
      expect(duplicate).toEqual([]);
      expect(compactorCalls).toBe(1);
      release();
      expect(await first).toContainEqual(
        expect.objectContaining({ type: 'context.compaction_completed' }),
      );
    } finally {
      release();
      store.close();
    }
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
