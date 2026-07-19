import { describe, expect, test } from 'bun:test';
import {
  type ContextSummaryGenerationRequest,
  createStructuredContextCompactor,
} from '../../src/core/model/compaction-summary';
import {
  chunkCompactionMessages,
  digestCompactionSource,
  findSafeCompactionBoundary,
} from '../../src/core/model/compaction-v2';
import type { ContextTokenEstimate } from '../../src/core/model/context-budget';
import { createInitialRuntimeState, type RuntimeState } from '../../src/core/runtime/state';

const estimate: ContextTokenEstimate = {
  systemTokens: 100,
  toolSchemaTokens: 200,
  transcriptTokens: 9_000,
  summaryTokens: 0,
  dynamicRuntimeTokens: 100,
  framingTokens: 600,
  totalInputTokens: 10_000,
};

function historicalState(): RuntimeState {
  const state = createInitialRuntimeState({
    threadId: 'summary',
    userId: 'user',
    workspace: '/workspace',
  });
  state.activeTaskId = 'task';
  state.tasks.task = {
    taskId: 'task',
    userGoal: 'Implement context compaction safely.',
    status: 'active',
    startedAtTurnId: state.turn.turnId,
    sideEffectsStarted: false,
    planning: { kind: 'building_without_plan' },
    planHistory: [],
  };
  state.transcript.messages = Array.from({ length: 5 }, (_, index) => ({
    kind: 'user' as const,
    messageId: `message-${index}`,
    turnId: `turn-${index}`,
    ordinal: index,
    createdAt: `2026-07-20T00:00:0${index}.000Z`,
    content: `historical-${index} ${'context '.repeat(1_600)}`,
  }));
  return state;
}

function validSummaryFromRequest(request: ContextSummaryGenerationRequest) {
  const payload = JSON.parse(request.input) as {
    deterministicFactLedger: {
      objective: string;
      facts: Array<{ factId: string; text: string }>;
      mandatoryFactIds: string[];
    };
    requiredProvenance: {
      firstMessageId: string;
      lastMessageId: string;
      sourceDigest: string;
      mandatoryFactIds: string[];
    };
  };
  return {
    version: 1 as const,
    objective: payload.deterministicFactLedger.objective,
    userConstraints: payload.deterministicFactLedger.facts.map((fact) => ({
      factId: fact.factId,
      text: fact.text,
    })),
    decisions: [],
    completedWork: [],
    observations: [],
    failures: [],
    pendingWork: [],
    unresolvedQuestions: [],
    recentUserIntent: 'latest protected user intent',
    provenance: payload.requiredProvenance,
  };
}

function pending(state: RuntimeState, reason: 'auto_soft' | 'auto_hard' = 'auto_hard') {
  return {
    compactionId: 'compact-summary',
    reason,
    requestedAtRevision: state.revision,
    requestedAtTurnId: state.turn.turnId,
    force: false,
    estimate,
  };
}

describe('structured context summary', () => {
  test('selects a complete settled prefix and protects recent turns', () => {
    const state = historicalState();
    const boundary = findSafeCompactionBoundary(state, { recentTurns: 2 });
    expect(boundary.eligible).toBe(true);
    expect(boundary.coveredMessages.map((message) => message.turnId)).toEqual([
      'turn-0',
      'turn-1',
      'turn-2',
    ]);
    expect(boundary.protectedMessageIds).toEqual(['message-3', 'message-4']);
  });

  test('never splits an assistant/tool block or an oversized complete turn', () => {
    const state = historicalState();
    state.transcript.messages = [
      {
        kind: 'assistant',
        messageId: 'assistant',
        turnId: 'turn-tool',
        ordinal: 0,
        createdAt: '2026-07-20T00:00:00.000Z',
        toolCalls: [{ id: 'call', name: 'read_file', args: {} }],
      },
      {
        kind: 'tool',
        messageId: 'tool',
        turnId: 'turn-tool',
        ordinal: 1,
        createdAt: '2026-07-20T00:00:01.000Z',
        toolCallId: 'call',
        name: 'read_file',
        content: 'x'.repeat(20_000),
        ok: true,
      },
    ];
    const chunks = chunkCompactionMessages(state.transcript.messages, 100);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.messages.map((message) => message.messageId)).toEqual(['assistant', 'tool']);
    expect(chunks[0]!.tokenCount).toBeGreaterThan(100);
  });

  test('repairs an invalid candidate once and creates a validated checkpoint', async () => {
    const state = historicalState();
    const modes: string[] = [];
    const compactor = createStructuredContextCompactor({
      recentTurns: 1,
      maxSummaryInputTokens: 100_000,
      generate: async (request) => {
        modes.push(request.mode);
        return request.mode === 'summary'
          ? { invalid: true }
          : validSummaryFromRequest({
              ...request,
              input: (JSON.parse(request.input) as { source: string }).source,
            });
      },
    });
    const checkpoint = await compactor({
      state,
      pending: pending(state),
      sourceRevision: state.revision,
    });
    expect(modes).toEqual(['summary', 'repair']);
    expect(checkpoint.summary.provenance.sourceDigest).toBe(checkpoint.sourceDigest);
    expect(checkpoint.coveredThroughMessageId).toBe('message-3');
    expect(checkpoint.inputTokensAfter).toBeLessThanOrEqual(checkpoint.targetTokens);
  });

  test('rejects a schema-valid summary that omits a mandatory fact', async () => {
    const state = historicalState();
    const compactor = createStructuredContextCompactor({
      recentTurns: 1,
      maxSummaryInputTokens: 100_000,
      generate: async (request) => {
        const summary = validSummaryFromRequest(
          request.mode === 'repair'
            ? {
                ...request,
                input: (JSON.parse(request.input) as { source: string }).source,
              }
            : request,
        );
        summary.userConstraints = summary.userConstraints.slice(1);
        return summary;
      },
    });
    await expect(
      compactor({ state, pending: pending(state, 'auto_soft'), sourceRevision: state.revision }),
    ).rejects.toMatchObject({
      kind: 'missing_mandatory_facts',
    });
  });

  test('uses chunk summaries only as merge input and validates the final source digest', async () => {
    const state = historicalState();
    const modes: string[] = [];
    const compactor = createStructuredContextCompactor({
      recentTurns: 1,
      maxSummaryInputTokens: 2_000,
      generate: async (request) => {
        modes.push(request.mode);
        if (request.mode === 'chunk') {
          const chunk = JSON.parse(request.input) as {
            sourceDigest: string;
            messages: unknown[];
          };
          return {
            sourceDigest: chunk.sourceDigest,
            facts: [],
            narrative: `chunk with ${chunk.messages.length} messages`,
          };
        }
        return validSummaryFromRequest(request);
      },
    });
    const checkpoint = await compactor({
      state,
      pending: pending(state),
      sourceRevision: state.revision,
    });
    expect(modes.filter((mode) => mode === 'chunk').length).toBeGreaterThan(1);
    expect(modes.at(-1)).toBe('merge');
    expect(checkpoint.sourceDigest).toBe(
      digestCompactionSource(state.transcript.messages.slice(0, 4)),
    );
    expect(checkpoint.summary.version).toBe(1);
  });

  test('custom instructions are injected into the summary system prompt', async () => {
    const state = historicalState();
    let capturedSystemPrompt = '';
    const compactor = createStructuredContextCompactor({
      recentTurns: 1,
      generate: async (request) => {
        capturedSystemPrompt = request.systemPrompt;
        return validSummaryFromRequest(request);
      },
    });
    await compactor({
      state,
      pending: {
        ...pending(state),
        customInstructions: 'focus on auth module changes',
      },
      sourceRevision: state.revision,
    });
    expect(capturedSystemPrompt).toContain('User instructions for this compaction:');
    expect(capturedSystemPrompt).toContain('focus on auth module changes');
  });

  test('repair path also includes custom instructions in the prompt', async () => {
    const state = historicalState();
    const capturedPrompts: string[] = [];
    const compactor = createStructuredContextCompactor({
      recentTurns: 1,
      generate: async (request) => {
        capturedPrompts.push(request.systemPrompt);
        if (request.mode === 'summary') {
          return 'not-json'; // trigger repair
        }
        // repair mode: parse the original source payload and return valid shape
        if (request.mode === 'repair') {
          const input = JSON.parse(request.input) as { source: string };
          const sourcePayload = JSON.parse(input.source) as {
            deterministicFactLedger: {
              objective: string;
              facts: Array<{ factId: string; text: string }>;
              mandatoryFactIds: string[];
            };
            requiredProvenance: {
              firstMessageId: string;
              lastMessageId: string;
              sourceDigest: string;
              mandatoryFactIds: string[];
            };
          };
          return {
            version: 1 as const,
            objective: sourcePayload.deterministicFactLedger.objective,
            userConstraints: sourcePayload.deterministicFactLedger.facts.map((f) => ({
              factId: f.factId,
              text: f.text,
            })),
            decisions: [],
            completedWork: [],
            observations: [],
            failures: [],
            pendingWork: [],
            unresolvedQuestions: [],
            recentUserIntent: 'repaired',
            provenance: sourcePayload.requiredProvenance,
          };
        }
        return validSummaryFromRequest(request);
      },
    });
    await compactor({
      state,
      pending: { ...pending(state), customInstructions: 'be extremely brief' },
      sourceRevision: state.revision,
    });
    expect(capturedPrompts).toHaveLength(2);
    for (const prompt of capturedPrompts) {
      expect(prompt).toContain('User instructions for this compaction:');
      expect(prompt).toContain('be extremely brief');
    }
  });

  test('no custom instructions → system prompt is baseline only', async () => {
    const state = historicalState();
    let capturedSystemPrompt = '';
    const compactor = createStructuredContextCompactor({
      recentTurns: 1,
      generate: async (request) => {
        capturedSystemPrompt = request.systemPrompt;
        return validSummaryFromRequest(request);
      },
    });
    await compactor({
      state,
      pending: pending(state),
      sourceRevision: state.revision,
    });
    expect(capturedSystemPrompt).not.toContain('User instructions for this compaction:');
  });
});
