import { describe, expect, test } from 'bun:test';
import type { ContextTokenEstimate } from '@kite/builtin-runtime/model';
import {
  createNarrativeContextCompactor,
  findSafeCompactionBoundary,
  normalizeCompactionSummary,
  serializeCompactionSummary,
} from '@kite/builtin-runtime/model';
import { createRuntimeHostState25InitialStateV1, type RuntimeState } from '@kite/runtime-host';

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
  const state = createRuntimeHostState25InitialStateV1({
    recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
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
    state.transcript.messages = state.transcript.messages.map((message) =>
      message.kind === 'user'
        ? { ...message, content: `${message.content}${' additional context'.repeat(300)}` }
        : message,
    );
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
      state.transcript.messages = [
        ...state.transcript.messages,
        {
          kind: 'user',
          messageId: `message-${ordinal}`,
          turnId: `turn-${ordinal}`,
          ordinal,
          createdAt: new Date(Date.UTC(2026, 6, 22, 0, 1, ordinal)).toISOString(),
          content: `Increment ${index}: ${'new settled context '.repeat(700)}`,
        },
      ];
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

  test('rejects low-gain history before invoking the summary Provider', async () => {
    const state = stateWithHistory(2);
    state.transcript.messages = state.transcript.messages.map((message) =>
      message.kind === 'user' ? { ...message, content: 'hello' } : message,
    );
    let calls = 0;
    const compact = createNarrativeContextCompactor({
      generate: async () => {
        calls++;
        return 'unreachable';
      },
    });

    await expect(
      compact({ state, pending: pending(state), sourceRevision: state.revision }),
    ).rejects.toMatchObject({ kind: 'insufficient_reduction' });
    expect(calls).toBe(0);
  });

  test('does not use custom instructions to rewrite an already-covered checkpoint', async () => {
    const state = stateWithHistory(3);
    state.context.activeCheckpoint = {
      compactionId: 'base',
      version: 1,
      sourceRevision: 0,
      sourceDigest: 'base-digest',
      coveredThroughMessageId: 'message-2',
      coveredThroughTurnId: 'turn-2',
      summary: 'Existing narrative.',
      inputTokensBefore: 8_000,
      inputTokensAfter: 2_000,
      reason: 'manual',
      createdAt: '2026-07-22T00:00:00.000Z',
    };
    let calls = 0;
    const compact = createNarrativeContextCompactor({
      generate: async () => {
        calls++;
        return 'unreachable';
      },
    });

    await expect(
      compact({
        state,
        pending: pending(state, 'focus on unfinished work'),
        sourceRevision: state.revision,
      }),
    ).rejects.toMatchObject({
      kind: 'insufficient_reduction',
      message: 'No new messages to compact.',
    });
    expect(calls).toBe(0);
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

  test('protects the current active manual turn and compacts only settled history', async () => {
    const state = stateWithHistory(3);
    state.turn.turnId = 'turn-2';
    let request = '';
    const compact = createNarrativeContextCompactor({
      generate: async (value) => {
        request = value.input;
        return 'Settled historical narrative.';
      },
    });
    const checkpoint = await compact({
      state,
      pending: pending(state),
      sourceRevision: state.revision,
    });
    expect(request).toContain('message-1');
    expect(request).not.toContain('message-2');
    expect(checkpoint.coveredThroughMessageId).toBe('message-1');
  });

  test('rejects a summary request that cannot fit the selected model window', async () => {
    const state = stateWithHistory();
    let calls = 0;
    const compact = createNarrativeContextCompactor({
      modelContextWindowTokens: 2_000,
      maxSummaryTokens: 1_000,
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

  test('classifies ordinary AbortError instances as cancellation', async () => {
    const compact = createNarrativeContextCompactor({
      generate: async () => {
        const error = new Error('cancelled');
        error.name = 'AbortError';
        throw error;
      },
    });
    await expect(
      compact({
        state: stateWithHistory(),
        pending: pending(stateWithHistory()),
        sourceRevision: 0,
      }),
    ).rejects.toMatchObject({ kind: 'summary_aborted' });
  });
});
