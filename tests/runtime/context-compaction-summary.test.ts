import { describe, expect, test } from 'bun:test';
import {
  createNarrativeContextCompactor,
  normalizeCompactionSummary,
  serializeCompactionSummary,
} from '../../src/core/model/compaction-summary';
import { findSafeCompactionBoundary } from '../../src/core/model/compaction-v2';
import type { ContextTokenEstimate } from '../../src/core/model/context-budget';
import { createVerifiedContextCheckpointV3 } from '../../src/core/model/context-checkpoint-v3';
import { buildContextProjection } from '../../src/core/model/context-projection';
import { createInitialRuntimeState, type RuntimeState } from '../../src/core/runtime/state';
import { projectedModelContentDigest } from '../../src/core/tools/registry/projection';
import {
  type ToolResultBudgetReceiptV2,
  toolResultDigestV2,
} from '../../src/core/tools/result-budget-v2';

const estimate: ContextTokenEstimate = {
  systemTokens: 100,
  toolSchemaTokens: 0,
  transcriptTokens: 20_000,
  summaryTokens: 0,
  dynamicRuntimeTokens: 100,
  framingTokens: 100,
  totalInputTokens: 20_300,
};

function successfulSummary(summary: string) {
  return { summary, finishReason: 'stop' };
}

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
  state.revision = 1;
  state.lastAppliedEventId = 'e'.repeat(64);
  state.appliedEventIds = ['e'.repeat(64)];
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

function offloadReceipt(content: string): ToolResultBudgetReceiptV2 {
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

function stateWithOversizedEligibleReadBlocks(): RuntimeState {
  const state = createInitialRuntimeState({
    threadId: 'oversized-eligible-summary',
    userId: 'user',
    workspace: '/workspace',
  });
  state.revision = 1;
  state.lastAppliedEventId = 'e'.repeat(64);
  state.appliedEventIds = ['e'.repeat(64)];
  for (let index = 0; index < 4; index++) {
    const toolCallId = `read-${index}`;
    const content = `result-${index} ${'large settled read result '.repeat(3_200)}`;
    const receipt = offloadReceipt(content);
    state.transcript.messages.push(
      {
        kind: 'assistant',
        messageId: `assistant-${index}`,
        turnId: `turn-${index}`,
        content: `Settled read ${index}.`,
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
          rawResultDigest: receipt.rawResultDigest,
          modelContentDigest: receipt.modelContentDigest,
          digestScope: 'raw',
          toolResultReceipt: receipt,
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

describe('narrative context compaction', () => {
  test('uses one model call and creates a lightweight Markdown checkpoint', async () => {
    const state = stateWithHistory();
    const requests: string[] = [];
    const compact = createNarrativeContextCompactor({
      generate: async (request) => {
        requests.push(request.input);
        return successfulSummary(
          '# Goal\n\nContinue the implementation and preserve verification results.',
        );
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
    expect(checkpoint.source.coveredThroughMessageId).toBe('message-5');
  });

  test('normalizes and XML-escapes the sole summary frame deterministically', () => {
    expect(normalizeCompactionSummary('  a\r\n<b> & c  ')).toBe('a\n<b> & c');
    expect(serializeCompactionSummary('  a\r\n</compacted_history> & c  ')).toBe(
      '<compacted_history>\na\n&lt;/compacted_history&gt; &amp; c\n</compacted_history>',
    );
  });

  test('legacy checkpoint input is independently recomputed from the complete safe prefix', async () => {
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
        return successfulSummary('Updated narrative with the new work.');
      },
    });
    const checkpoint = await compact({
      state,
      pending: pending(state),
      sourceRevision: state.revision,
    });
    expect(request).not.toContain('Previous narrative.');
    expect(request).toContain('message-1');
    expect(request).toContain('message-3');
    expect(checkpoint.baseCheckpoint).toBeUndefined();
    expect(checkpoint.source.coveredThroughMessageId).toBe('message-7');
  });

  test('keeps a stable single-checkpoint digest chain across 20 incremental replacements', async () => {
    const state = stateWithHistory(12);
    for (const message of state.transcript.messages) {
      if (message.kind === 'user') message.content += ' additional context'.repeat(300);
    }
    const compact = createNarrativeContextCompactor({
      generate: async () =>
        successfulSummary(`Updated narrative ${state.transcript.messages.length}.`),
      // This fixture deliberately verifies checkpoint-chain semantics over
      // repeated full-prefix rewrites. Production's conservative cost gate is
      // covered separately below.
      maxSummaryInputToReductionRatio: 1_000_000,
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
      expect(checkpoint.baseCheckpoint?.checkpointId).toBe(
        previousId ? `${previousId}:v3` : undefined,
      );
      expect(checkpoint.compactionId).toBe(compactionId);
      expect(checkpoint.source.sourceRangeDigest).not.toBe(
        state.context.activeCheckpoint?.version === 3
          ? state.context.activeCheckpoint.source.sourceRangeDigest
          : undefined,
      );
      digests.add(checkpoint.source.sourceRangeDigest);
      state.context.activeCheckpoint = checkpoint;
      previousId = compactionId;
      for (let offset = 0; offset < 8; offset++) {
        const ordinal = state.transcript.messages.length;
        state.transcript.messages.push({
          kind: 'user',
          messageId: `message-${ordinal}`,
          turnId: `turn-${ordinal}`,
          ordinal,
          createdAt: new Date(Date.UTC(2026, 6, 22, 0, 1, ordinal)).toISOString(),
          content: `Increment ${index}-${offset}: ${'new settled context '.repeat(250)}`,
        });
      }
    }
    expect(digests).toHaveLength(20);
    expect(state.context.activeCheckpoint?.compactionId).toBe('chain-19');
  });

  test('rejects empty, truncated, tool-call, and oversized narratives', async () => {
    const state = stateWithHistory();
    const cases = [
      [{ summary: '   ', finishReason: 'stop' }, 'empty_summary'],
      [{ summary: 'partial', finishReason: 'length' }, 'truncated_summary'],
      [{ summary: 'partial', finishReason: 'max_tokens' }, 'truncated_summary'],
      [{ summary: 'partial', finishReason: 'max_output_tokens' }, 'truncated_summary'],
      [{ summary: 'partial', finishReason: 'token_limit' }, 'truncated_summary'],
      [{ summary: 'partial', finishReason: 'content_filter' }, 'truncated_summary'],
      [{ summary: 'partial', finishReason: undefined }, 'truncated_summary'],
      [{ summary: 'text', finishReason: 'stop', hasToolCalls: true }, 'unexpected_tool_call'],
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

  test('retains redacted Provider usage when a returned summary is rejected', async () => {
    const state = stateWithHistory();
    const compact = createNarrativeContextCompactor({
      generate: async () => ({
        summary: '   ',
        finishReason: 'stop',
        inputTokens: 12_000,
        outputTokens: 48,
        cacheHitTokens: 11_500,
        cacheMissTokens: 500,
      }),
    });
    await expect(
      compact({ state, pending: pending(state), sourceRevision: state.revision }),
    ).rejects.toMatchObject({
      kind: 'empty_summary',
      providerUsage: {
        inputTokens: 12_000,
        outputTokens: 48,
        cacheHitTokens: 11_500,
        cacheMissTokens: 500,
      },
    });
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
    for (const message of state.transcript.messages) {
      if (message.kind === 'user') message.content = 'hello';
    }
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

  test('does not re-send a large full prefix for a small marginal reduction', async () => {
    const state = stateWithHistory(20);
    state.context.activeCheckpoint = createVerifiedContextCheckpointV3({
      state,
      checkpointId: 'base:v3',
      compactionId: 'base',
      reason: 'manual',
      coveredThroughMessageId: 'message-15',
      summary: 'Previously verified history.',
      inputTokensBefore: 100_000,
      inputTokensAfter: 2_000,
      routeIdentityDigest: 'a'.repeat(64),
      sourceProducingEventCutV1: { revision: 1, eventId: 'e'.repeat(64) },
      createdAt: '2026-07-22T00:00:00.000Z',
    });
    let calls = 0;
    const compact = createNarrativeContextCompactor({
      generate: async () => {
        calls++;
        return 'unreachable';
      },
    });

    await expect(
      compact({ state, pending: pending(state), sourceRevision: state.revision }),
    ).rejects.toMatchObject({
      kind: 'insufficient_reduction',
      message: expect.stringContaining('input tokens for at most'),
    });
    expect(calls).toBe(0);
  });

  test('does not pay for a summary when a large atomic recent block cannot fit Working Set', async () => {
    const state = stateWithHistory(5);
    state.transcript.messages.push({
      kind: 'user',
      messageId: 'large-atomic-message',
      turnId: 'large-atomic-turn',
      ordinal: 5,
      createdAt: '2026-07-22T00:00:06.000Z',
      content: 'atomic '.repeat(40_000),
    });
    let calls = 0;
    const compact = createNarrativeContextCompactor({
      generate: async () => {
        calls++;
        return 'unreachable';
      },
    });

    await expect(
      compact({ state, pending: pending(state), sourceRevision: state.revision }),
    ).rejects.toMatchObject({
      kind: 'insufficient_reduction',
      message: expect.stringContaining('recent_window_exceeds_capacity'),
    });
    expect(calls).toBe(0);
  });

  test('can create V3 when eligible covered read blocks need L2.5 projection offload', async () => {
    const state = stateWithOversizedEligibleReadBlocks();
    const before = JSON.stringify(state.transcript);
    const projectionEnvironment = {
      serializedTools: [{ name: 'read_file', inputSchema: {}, schemaDigest: 'a'.repeat(64) }],
      workflowSkills: [],
      oversizedBlockOffloadV1: true,
    };
    let calls = 0;
    const compact = createNarrativeContextCompactor({
      generate: async () => {
        calls++;
        return successfulSummary(
          '# Settled reads\n\nReplay a read only if the digest detail is needed.',
        );
      },
      maxSummaryInputToReductionRatio: 5,
    });
    const checkpoint = await compact({
      state,
      pending: pending(state),
      sourceRevision: state.revision,
      projectionEnvironment,
    });
    expect(calls).toBe(1);
    expect(checkpoint.inputTokensAfter).toBeLessThan(checkpoint.inputTokensBefore);
    expect(JSON.stringify(state.transcript)).toBe(before);
    state.context.activeCheckpoint = checkpoint;
    const projection = buildContextProjection({
      role: 'agent',
      state,
      serializedTools: projectionEnvironment.serializedTools,
      workflowSkills: projectionEnvironment.workflowSkills,
      projectionEnvironment,
    });
    expect(projection.summaryMessages).toHaveLength(1);
    expect(
      projection.transcriptMessages.some((message) =>
        String((message as unknown as { content?: unknown }).content).includes(
          'tool-result-offload:v1',
        ),
      ),
    ).toBe(true);
  });

  test('does not use custom instructions to rewrite an already-covered checkpoint', async () => {
    const state = stateWithHistory(3);
    state.context.activeCheckpoint = createVerifiedContextCheckpointV3({
      state,
      checkpointId: 'base:v3',
      compactionId: 'base',
      reason: 'manual',
      coveredThroughMessageId: 'message-2',
      summary: 'Existing narrative.',
      inputTokensBefore: 8_000,
      inputTokensAfter: 2_000,
      routeIdentityDigest: 'a'.repeat(64),
      sourceProducingEventCutV1: { revision: 1, eventId: 'e'.repeat(64) },
      createdAt: '2026-07-22T00:00:00.000Z',
    });
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
    const state = stateWithHistory(10);
    state.turn.turnId = 'turn-9';
    let request = '';
    const compact = createNarrativeContextCompactor({
      generate: async (value) => {
        request = value.input;
        return successfulSummary('Settled historical narrative.');
      },
    });
    const checkpoint = await compact({
      state,
      pending: pending(state),
      sourceRevision: state.revision,
    });
    expect(request).toContain('message-1');
    expect(request).not.toContain('message-9');
    expect(checkpoint.source.coveredThroughMessageId).toBe('message-8');
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
        sourceRevision: 1,
      }),
    ).rejects.toMatchObject({ kind: 'summary_aborted' });
  });

  test('fails closed before Provider dispatch when a tool result crosses turns', async () => {
    const state = stateWithHistory(0);
    state.transcript.messages = [
      {
        kind: 'assistant',
        messageId: 'assistant-call',
        turnId: 'turn-call',
        ordinal: 0,
        createdAt: '2026-07-22T00:00:00.000Z',
        content: '',
        toolCalls: [{ id: 'call-1', name: 'read_file', args: { path: 'a.ts' } }],
      },
      {
        kind: 'tool',
        messageId: 'tool-result',
        turnId: 'turn-result',
        ordinal: 1,
        createdAt: '2026-07-22T00:00:01.000Z',
        toolCallId: 'call-1',
        name: 'read_file',
        content: 'file contents',
        ok: true,
      },
    ];
    let calls = 0;
    const compact = createNarrativeContextCompactor({
      generate: async () => {
        calls++;
        return successfulSummary('unreachable');
      },
    });

    await expect(
      compact({ state, pending: pending(state), sourceRevision: state.revision }),
    ).rejects.toMatchObject({ kind: 'unsafe_boundary' });
    expect(calls).toBe(0);
  });
});
