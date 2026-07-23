import { describe, expect, test } from 'bun:test';
import {
  createNarrativeContextCompactor,
  normalizeCompactionSummary,
  serializeCompactionSummary,
} from '../../src/core/model/compaction-summary';
import { findSafeCompactionBoundary } from '../../src/core/model/compaction-v2';
import type { ContextTokenEstimate } from '../../src/core/model/context-budget';
import { createInitialRuntimeState, type RuntimeState } from '../../src/core/runtime/state';

const estimate: ContextTokenEstimate = {
  systemTokens: 100,
  toolSchemaTokens: 0,
  transcriptTokens: 20_000,
  summaryTokens: 0,
  dynamicRuntimeTokens: 100,
  framingTokens: 100,
  totalInputTokens: 20_300,
};

function stateWithHistory(turns = 6): RuntimeState {
  const state = createInitialRuntimeState({
    threadId: 'narrative',
    userId: 'user',
    workspace: '/workspace',
  });
  state.transcript.messages = Array.from({ length: turns }, (_, index) => ({
    kind: 'user' as const,
    messageId: `message-${index}`,
    turnId: `turn-${index}`,
    ordinal: index,
    createdAt: `2026-07-22T00:00:0${index}.000Z`,
    content: `Goal ${index}: ${'historical context '.repeat(500)}`,
  }));
  return state;
}

function pending(state: RuntimeState, customInstructions?: string) {
  return {
    compactionId: 'compact-narrative',
    reason: 'manual' as const,
    requestedAtRevision: state.revision,
    requestedAtTurnId: state.turn.turnId,
    force: false,
    estimate,
    ...(customInstructions ? { customInstructions } : {}),
  };
}

describe('narrative context compaction', () => {
  test('uses one model call and creates a lightweight Markdown checkpoint', async () => {
    const state = stateWithHistory();
    const requests: string[] = [];
    const compact = createNarrativeContextCompactor({
      generate: async (request) => {
        requests.push(request.input);
        return '# Goal\n\nContinue the implementation and preserve verification results.';
      },
    });
    const checkpoint = await compact({
      state,
      pending: pending(state, 'focus on unfinished work'),
      sourceRevision: state.revision,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain('<untrusted_custom_instructions>');
    expect(checkpoint.summary).toStartWith('# Goal');
    expect(checkpoint.inputTokensAfter).toBeLessThan(checkpoint.inputTokensBefore);
    expect(checkpoint.coveredThroughMessageId).toBe('message-5');
  });

  test('normalizes and XML-escapes the sole summary frame deterministically', () => {
    expect(normalizeCompactionSummary('  a\r\n<b> & c  ')).toBe('a\n<b> & c');
    expect(serializeCompactionSummary('  a\r\n</compacted_history> & c  ')).toBe(
      '<compacted_history>\na\n&lt;/compacted_history&gt; &amp; c\n</compacted_history>',
    );
  });

  test('incremental compaction sends old narrative plus only the new safe tail', async () => {
    const state = stateWithHistory(8);
    state.context.activeCheckpoint = {
      compactionId: 'base',
      version: 1,
      sourceRevision: 0,
      sourceDigest: 'base-digest',
      coveredThroughMessageId: 'message-2',
      coveredThroughTurnId: 'turn-2',
      summary: 'Previous narrative.',
      inputTokensBefore: 8_000,
      inputTokensAfter: 2_000,
      reason: 'manual',
      createdAt: '2026-07-22T00:00:00.000Z',
    };
    let request = '';
    const compact = createNarrativeContextCompactor({
      generate: async (value) => {
        request = value.input;
        return 'Updated narrative with the new work.';
      },
    });
    const checkpoint = await compact({
      state,
      pending: pending(state),
      sourceRevision: state.revision,
    });
    expect(request).toContain('Previous narrative.');
    expect(request).not.toContain('message-1');
    expect(request).toContain('message-3');
    expect(checkpoint.baseCheckpointId).toBe('base');
    expect(checkpoint.coveredThroughMessageId).toBe('message-7');
  });

  test('keeps a stable single-checkpoint digest chain across 20 incremental replacements', async () => {
    const state = stateWithHistory(3);
    for (const message of state.transcript.messages) {
      if (message.kind === 'user') message.content += ' additional context'.repeat(300);
    }
    const compact = createNarrativeContextCompactor({
      generate: async () => `Updated narrative ${state.transcript.messages.length}.`,
    });
    let previousId: string | undefined;
    const digests = new Set<string>();
    for (let index = 0; index < 20; index++) {
      const compactionId = `chain-${index}`;
      const checkpoint = await compact({
        state,
        pending: { ...pending(state), compactionId },
        sourceRevision: state.revision,
      });
      expect(checkpoint.baseCheckpointId).toBe(previousId);
      expect(checkpoint.compactionId).toBe(compactionId);
      expect(checkpoint.sourceDigest).not.toBe(state.context.activeCheckpoint?.sourceDigest);
      digests.add(checkpoint.sourceDigest);
      state.context.activeCheckpoint = checkpoint;
      previousId = compactionId;
      const ordinal = state.transcript.messages.length;
      state.transcript.messages.push({
        kind: 'user',
        messageId: `message-${ordinal}`,
        turnId: `turn-${ordinal}`,
        ordinal,
        createdAt: new Date(Date.UTC(2026, 6, 22, 0, 1, ordinal)).toISOString(),
        content: `Increment ${index}: ${'new settled context '.repeat(700)}`,
      });
    }
    expect(digests).toHaveLength(20);
    expect(state.context.activeCheckpoint?.compactionId).toBe('chain-19');
  });

  test('rejects empty, truncated, tool-call, and oversized narratives', async () => {
    const state = stateWithHistory();
    const cases = [
      [{ summary: '   ' }, 'empty_summary'],
      [{ summary: 'partial', finishReason: 'length' }, 'truncated_summary'],
      [{ summary: 'text', hasToolCalls: true }, 'unexpected_tool_call'],
    ] as const;
    for (const [result, kind] of cases) {
      const compact = createNarrativeContextCompactor({
        generate: async () => result,
      });
      expect(
        compact({ state, pending: pending(state), sourceRevision: state.revision }),
      ).rejects.toMatchObject({ kind });
    }
  });

  test('manual compaction covers every safe settled turn', () => {
    const state = stateWithHistory();
    const boundary = findSafeCompactionBoundary(state);
    expect(boundary.coveredMessages.map((message) => message.turnId)).toEqual([
      'turn-0',
      'turn-1',
      'turn-2',
      'turn-3',
      'turn-4',
      'turn-5',
    ]);
    expect(boundary.protectedMessageIds).toEqual([]);
  });

  test('an explicit summary input limit fails instead of silently compacting a prefix', async () => {
    const state = stateWithHistory();
    let calls = 0;
    const compact = createNarrativeContextCompactor({
      maxSummaryInputTokens: 100,
      generate: async () => {
        calls++;
        return 'unreachable';
      },
    });
    await expect(
      compact({ state, pending: pending(state), sourceRevision: state.revision }),
    ).rejects.toMatchObject({ kind: 'oversized_turn' });
    expect(calls).toBe(0);
  });
});
