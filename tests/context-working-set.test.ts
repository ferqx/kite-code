import { describe, expect, test } from 'bun:test';
import { createVerifiedContextCheckpointV3 } from '@/core/model/context-checkpoint-v3';
import { serializeFramesToMessages } from '@/core/model/context-serializer';
import {
  deriveCheckpointV3ReboundV1,
  selectCheckpointWorkingSetV1,
} from '@/core/model/context-working-set';
import { reduceRuntimeState } from '@/core/runtime/reducer';
import { createInitialRuntimeState, type RuntimeState } from '@/core/runtime/state';
import { projectedModelContentDigest } from '@/core/tools/registry/projection';
import { type ToolResultBudgetReceiptV2, toolResultDigestV2 } from '@/core/tools/result-budget-v2';

const EVENT_ID = 'e'.repeat(64);

function fixture(blocks = 160): RuntimeState {
  const state = createInitialRuntimeState({
    threadId: 'working-set',
    userId: 'u',
    workspace: '/workspace',
  });
  state.revision = 1;
  state.lastAppliedEventId = EVENT_ID;
  state.appliedEventIds = [EVENT_ID];
  state.transcript.messages = Array.from({ length: blocks }, (_, index) => ({
    kind: 'user' as const,
    messageId: `message-${index}`,
    turnId: `turn-${index}`,
    content: `settled-${index}-${'historical context '.repeat(60)}`,
  }));
  return state;
}

function checkpoint(state: RuntimeState, boundary: number | string = 139) {
  return createVerifiedContextCheckpointV3({
    state,
    checkpointId: 'checkpoint:v3',
    compactionId: 'checkpoint',
    reason: 'manual',
    coveredThroughMessageId: typeof boundary === 'number' ? `message-${boundary}` : boundary,
    summary: '# Verified history\n\nSettled work is summarized.',
    inputTokensBefore: 20_000,
    inputTokensAfter: 4_000,
    routeIdentityDigest: 'a'.repeat(64),
    sourceProducingEventCutV1: { revision: 1, eventId: EVENT_ID },
    createdAt: new Date(0).toISOString(),
  });
}

function receipt(content: string): ToolResultBudgetReceiptV2 {
  return {
    version: 2,
    projectionMode: 'budget_v2',
    policyId: 'test-budget:v2',
    toolIdentity: 'builtin:read_file',
    bindingDigest: 'a'.repeat(64),
    projectorId: 'read-line-window:v1',
    projectorRevision: 'test-projector:v1',
    validatorId: 'test-validator:v1',
    rawResultDigest: toolResultDigestV2('test-raw:v1', content),
    modelContentDigest: projectedModelContentDigest(content),
    modelContentUtf8Bytes: Buffer.byteLength(content, 'utf8'),
  };
}

function oversizedReadFixture(contentRepeats = 3_200): RuntimeState {
  const state = createInitialRuntimeState({
    threadId: 'oversized-working-set',
    userId: 'u',
    workspace: '/workspace',
  });
  state.revision = 1;
  state.lastAppliedEventId = EVENT_ID;
  state.appliedEventIds = [EVENT_ID];
  for (let index = 0; index < 4; index++) {
    const toolCallId = `read-${index}`;
    const content = `line ${index}: ${'large settled read result '.repeat(contentRepeats)}`;
    const resultReceipt = receipt(content);
    state.transcript.messages.push(
      {
        kind: 'assistant',
        messageId: `assistant-${index}`,
        turnId: `turn-${index}`,
        content: `Settled read result ${index}.`,
        toolCalls: [{ id: toolCallId, name: 'read_file', args: { path: `src/${index}.ts` } }],
      },
      {
        kind: 'tool',
        messageId: `tool-${index}`,
        turnId: `turn-${index}`,
        toolCallId,
        name: 'read_file',
        content,
        ok: true,
        resultMeta: {
          path: `src/${index}.ts`,
          rawResultDigest: resultReceipt.rawResultDigest,
          modelContentDigest: resultReceipt.modelContentDigest,
          digestScope: 'raw',
          toolResultReceipt: resultReceipt,
        },
      },
    );
    state.tools.calls[toolCallId] = {
      toolCallId,
      modelMessageId: `assistant-${index}`,
      name: 'read_file',
      args: { path: `src/${index}.ts` },
      status: 'succeeded',
      createdAtTurnId: `turn-${index}`,
      effectClass: 'read_only',
      sideEffect: false,
      result: { ok: true, summary: 'read' },
    };
  }
  return state;
}

describe('checkpoint working set v1', () => {
  test('preserves the half-open interval property across varied coverage and tails', () => {
    for (let sample = 0; sample < 48; sample += 1) {
      const total = 80 + (sample % 41);
      const boundary = 30 + (sample % 37);
      const state = fixture(total);
      const result = selectCheckpointWorkingSetV1({
        state,
        checkpoint: checkpoint(state, boundary),
        contextWindowTokens: 64_000,
      });
      expect(result.status).toBe('available');
      if (result.status !== 'available') continue;
      const ids = serializeFramesToMessages(result.frames).map(
        (message) => (message as unknown as { messageId?: string }).messageId,
      );
      expect(ids).toEqual(
        Array.from(
          { length: total - result.recentBlockStart },
          (_, index) => `message-${result.recentBlockStart + index}`,
        ),
      );
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.filter((id) => id === `message-${boundary + 1}`)).toHaveLength(1);
    }
  });

  test('projects checkpoint + [w,c) + [c,n) with every tail block exactly once', () => {
    const state = fixture();
    const result = selectCheckpointWorkingSetV1({
      state,
      checkpoint: checkpoint(state),
      contextWindowTokens: 64_000,
    });
    expect(result.status).toBe('available');
    if (result.status !== 'available') return;
    expect(result.checkpointBlockBoundary).toBe(140);
    expect(result.recentBlockStart).toBeLessThan(result.checkpointBlockBoundary);
    const ids = serializeFramesToMessages(result.frames).map(
      (message) => (message as unknown as { messageId?: string }).messageId,
    );
    const expected = Array.from(
      { length: 160 - result.recentBlockStart },
      (_, index) => `message-${result.recentBlockStart + index}`,
    );
    expect(ids).toEqual(expected);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id === 'message-140')).toHaveLength(1);
    expect(state.transcript.messages).toHaveLength(160);
  });

  test('independently recomputes first and incremental prefixes beyond 128 blocks', () => {
    const state = fixture(220);
    const first = checkpoint(state, 139);
    const incremental = createVerifiedContextCheckpointV3({
      state,
      checkpointId: 'checkpoint-2:v3',
      compactionId: 'checkpoint-2',
      reason: 'manual',
      coveredThroughMessageId: 'message-199',
      summary: '# New verified history',
      inputTokensBefore: 30_000,
      inputTokensAfter: 5_000,
      routeIdentityDigest: 'b'.repeat(64),
      sourceProducingEventCutV1: { revision: 1, eventId: EVENT_ID },
      createdAt: new Date(1).toISOString(),
      baseCheckpoint: first,
    });
    const selected = selectCheckpointWorkingSetV1({ state, checkpoint: incremental });
    expect(selected.status).toBe('available');
    if (selected.status === 'available') expect(selected.checkpointBlockBoundary).toBe(200);
  });

  test('a verified fork base requires one child-owned rebound before Working Set is available', () => {
    const state = fixture(80);
    state.context.activeCheckpoint = checkpoint(state, 59);
    state.context.projectionBaseIdentity = undefined;
    state.lastAppliedEventId = undefined;
    state.appliedEventIds = [];
    state.storageFormat = {
      ...state.storageFormat,
      ledgerBase: { ...state.storageFormat.ledgerBase, kind: 'fork_rebound_v24' },
    };
    expect(
      selectCheckpointWorkingSetV1({ state, checkpoint: state.context.activeCheckpoint }),
    ).toMatchObject({ status: 'unavailable', reason: 'checkpoint_event_cut_unavailable' });
    const rebound = deriveCheckpointV3ReboundV1({ state, generation: 2 });
    expect(rebound?.type).toBe('context.checkpoint_v3_rebound_v1');
    expect(rebound?.checkpoint.source.sourceProducingEventCutV1).not.toEqual(
      state.context.activeCheckpoint?.version === 3
        ? state.context.activeCheckpoint.source.sourceProducingEventCutV1
        : undefined,
    );
    expect(rebound?.proof.generation).toBe(2);
    expect(rebound?.proof.ledgerBaseId).toBe(state.storageFormat.ledgerBase.baseId);
    const reboundState = rebound ? reduceRuntimeState(state, rebound) : state;
    expect(
      selectCheckpointWorkingSetV1({
        state: reboundState,
        checkpoint: reboundState.context.activeCheckpoint,
      }),
    ).toMatchObject({ status: 'available' });
  });

  test('legacy, incomplete proof, tamper, future cut and unsafe barriers fail closed', () => {
    const state = fixture(40);
    expect(selectCheckpointWorkingSetV1({ state, checkpoint: { version: 1 } })).toEqual({
      status: 'unavailable',
      reason: 'missing_v3_checkpoint',
    });
    const valid = checkpoint(state, 30);
    expect(
      selectCheckpointWorkingSetV1({
        state,
        checkpoint: { ...valid, summary: `${valid.summary} tampered` },
      }),
    ).toEqual({ status: 'unavailable', reason: 'checkpoint_tampered' });
    expect(
      selectCheckpointWorkingSetV1({
        state,
        checkpoint: {
          ...valid,
          source: {
            ...valid.source,
            sourceProducingEventCutV1: { revision: 2, eventId: EVENT_ID },
          },
        },
      }),
    ).toEqual({ status: 'unavailable', reason: 'checkpoint_future_cut' });
    state.interactions = {
      kind: 'awaiting_user_input',
      interactionId: 'interaction',
      toolCallId: 'tool',
      request: { interactionId: 'interaction', prompt: 'answer' },
    } as unknown as RuntimeState['interactions'];
    expect(selectCheckpointWorkingSetV1({ state, checkpoint: valid })).toEqual({
      status: 'unavailable',
      reason: 'unsafe_runtime_barrier',
    });
  });

  test('a checkpoint that reaches the active turn or a nonterminal covered tool is a barrier', () => {
    const active = fixture(40);
    active.transcript.messages[30] = {
      kind: 'user',
      messageId: 'message-30',
      turnId: active.turn.turnId,
      content: 'active turn must remain in the tail',
    };
    expect(
      selectCheckpointWorkingSetV1({ state: active, checkpoint: checkpoint(active, 30) }),
    ).toEqual({
      status: 'unavailable',
      reason: 'unsafe_runtime_barrier',
    });

    const pending = fixture(40);
    pending.tools.calls['pending-call'] = {
      toolCallId: 'pending-call',
      modelMessageId: 'message-20',
      name: 'read_file',
      args: {},
      status: 'awaiting_user_input',
      createdAtTurnId: 'turn-20',
    };
    expect(
      selectCheckpointWorkingSetV1({ state: pending, checkpoint: checkpoint(pending, 30) }),
    ).toEqual({
      status: 'unavailable',
      reason: 'unsafe_runtime_barrier',
    });
  });

  test('offloads only eligible complete W tool blocks when the default raw window cannot fit', () => {
    const state = oversizedReadFixture();
    const raw = selectCheckpointWorkingSetV1({ state, checkpoint: checkpoint(state, 'tool-3') });
    expect(raw).toEqual({ status: 'unavailable', reason: 'recent_window_exceeds_capacity' });
    const before = JSON.stringify(state.transcript);
    const selected = selectCheckpointWorkingSetV1({
      state,
      checkpoint: checkpoint(state, 'tool-3'),
      oversizedBlockOffloadV1: true,
      availableToolNames: ['read_file'],
    });
    expect(selected.status).toBe('available');
    if (selected.status !== 'available') return;
    expect(selected.oversizedBlockOffload?.policyId).toBe('oversized-block-offload:v1');
    expect(selected.oversizedBlockOffload?.offloadedBlockCount).toBeGreaterThan(0);
    expect(selected.oversizedBlockOffload?.offloadedToolResultCount).toBe(
      selected.oversizedBlockOffload?.offloadedBlockCount,
    );
    expect(JSON.stringify(state.transcript)).toBe(before);
    const projected = serializeFramesToMessages(selected.frames).map((message) => {
      const item = message as unknown as { content?: unknown };
      return typeof item.content === 'string' ? item.content : JSON.stringify(item.content);
    });
    expect(projected.some((content) => content.includes('tool-result-offload:v1'))).toBe(true);
    expect(
      projected.filter((content) => content.includes('large settled read result')),
    ).toHaveLength(4 - selected.oversizedBlockOffload!.offloadedBlockCount);
  });

  test('never offloads an uncovered tail block', () => {
    const state = oversizedReadFixture();
    state.transcript.messages.push({
      kind: 'user',
      messageId: 'tail',
      turnId: 'tail-turn',
      content: 'tail must remain raw',
    });
    const selected = selectCheckpointWorkingSetV1({
      state,
      checkpoint: checkpoint(state, 'tool-3'),
      oversizedBlockOffloadV1: true,
      availableToolNames: ['read_file'],
    });
    expect(selected.status).toBe('available');
    if (selected.status !== 'available') return;
    expect(
      serializeFramesToMessages(selected.frames).some(
        (message) =>
          (message as unknown as { messageId?: string }).messageId === 'tail' &&
          (message as unknown as { content?: unknown }).content === 'tail must remain raw',
      ),
    ).toBe(true);
  });

  test('keeps the existing no-dispatch boundary when the replay tool is unavailable', () => {
    const state = oversizedReadFixture();
    expect(
      selectCheckpointWorkingSetV1({
        state,
        checkpoint: checkpoint(state, 'tool-3'),
        oversizedBlockOffloadV1: true,
        availableToolNames: [],
      }),
    ).toEqual({ status: 'unavailable', reason: 'recent_window_exceeds_capacity' });
  });

  test('keeps the flag-off Working Set payload byte-identical when no offload is needed', () => {
    const state = oversizedReadFixture(1);
    const baseline = selectCheckpointWorkingSetV1({
      state,
      checkpoint: checkpoint(state, 'tool-3'),
    });
    const enabled = selectCheckpointWorkingSetV1({
      state,
      checkpoint: checkpoint(state, 'tool-3'),
      oversizedBlockOffloadV1: true,
      availableToolNames: ['read_file'],
    });
    expect(baseline.status).toBe('available');
    expect(enabled.status).toBe('available');
    if (baseline.status !== 'available' || enabled.status !== 'available') return;
    expect(enabled.oversizedBlockOffload).toBeUndefined();
    expect(JSON.stringify(serializeFramesToMessages(enabled.frames))).toBe(
      JSON.stringify(serializeFramesToMessages(baseline.frames)),
    );
  });
});
