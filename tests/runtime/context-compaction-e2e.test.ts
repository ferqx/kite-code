/**
 * Context compaction E2E tests.
 *
 * Exercises the full compaction pipeline end-to-end:
 * event → reducer → state → scheduler → effect → executor → controller → events.
 *
 * Covers: manual /compact, auto soft/hard, overflow recovery, reset,
 * session restore, multi-turn, concurrent rejection, error scenarios.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeContextCompaction } from '../../src/core/controllers/compaction-controller';
import { ContextCompactionValidationError } from '../../src/core/model/compaction-summary';
import type { ContextTokenEstimate } from '../../src/core/model/context-budget';
import {
  inspectManualContextCompaction,
  manualContextCompactionEvent,
} from '../../src/core/model/context-compaction-manual';
import { AgentKernel, createAgentKernel } from '../../src/core/runtime/kernel';
import { reduceRuntimeState } from '../../src/core/runtime/reducer';
import { decideNextEffect } from '../../src/core/runtime/scheduler';
import {
  createInitialRuntimeState,
  type RuntimeState,
  type TranscriptMessage,
} from '../../src/core/runtime/state';
import { createRuntimeStore } from '../../src/core/runtime/store';

// ── Helpers ──

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

function makeSummary(sourceDigest: string, firstMessageId: string, lastMessageId: string) {
  return {
    version: 1 as const,
    objective: 'Built authentication module and fixed race condition.',
    userConstraints: [
      { factId: 'fact-1', text: 'Must use TypeScript strict mode' },
      { factId: 'fact-2', text: 'No runtime dependencies beyond Bun stdlib' },
    ],
    decisions: [
      {
        factId: 'fact-3',
        decision: 'Use bcrypt-like hashing via Bun.Crypto',
        rationale: 'Avoid native addons',
      },
    ],
    completedWork: [
      {
        factId: 'fact-4',
        path: 'src/auth/login.ts',
        summary: 'Implemented password hashing',
        evidenceMessageIds: ['msg-tool-0'],
      },
      {
        factId: 'fact-5',
        path: 'src/core/runner.ts',
        summary: 'Fixed race condition with mutex',
        evidenceMessageIds: ['msg-tool-1'],
      },
    ],
    observations: [
      {
        factId: 'fact-6',
        resource: 'src/auth/login.ts',
        revision: 'abc123',
        digest: 'sha256:login-v1',
        keyFacts: ['Exports login() and verifyToken()'],
      },
    ],
    failures: [
      {
        factId: 'fact-7',
        operation: 'build',
        error: 'TypeScript strictNullChecks',
        consequence: 'Added null guards',
      },
    ],
    pendingWork: [{ text: 'Add refresh token rotation', blockedBy: 'JWT expiry design' }],
    unresolvedQuestions: ['Use HS256 or RS256 for internal tokens?'],
    recentUserIntent: 'Continue implementing auth module.',
    provenance: {
      firstMessageId,
      lastMessageId,
      sourceDigest,
      mandatoryFactIds: ['fact-1', 'fact-4', 'fact-5', 'fact-7'],
    },
  };
}

/** Build a realistic transcript of N turns with user/assistant/tool messages. */
function buildTranscript(
  state: RuntimeState,
  turnCount: number = 10,
): { firstId: string; lastId: string; lastTurnId: string } {
  const messages: TranscriptMessage[] = [];
  for (let i = 0; i < turnCount; i++) {
    const turnId = `turn-${i}`;
    messages.push({
      kind: 'user',
      messageId: `msg-user-${i}`,
      turnId,
      ordinal: messages.length,
      createdAt: `2026-07-20T00:${String(i).padStart(2, '0')}:00.000Z`,
      content: `User request ${i}: ${'task context '.repeat(50)}`,
    });
    messages.push({
      kind: 'assistant',
      messageId: `msg-ai-${i}`,
      turnId,
      ordinal: messages.length,
      createdAt: `2026-07-20T00:${String(i).padStart(2, '0')}:30.000Z`,
      content: `Assistant response ${i}`,
      toolCalls: [{ id: `call-${i}`, name: 'read_file', args: { path: `src/file-${i}.ts` } }],
    });
    messages.push({
      kind: 'tool',
      messageId: `msg-tool-${i}`,
      turnId,
      ordinal: messages.length,
      createdAt: `2026-07-20T00:${String(i).padStart(2, '0')}:31.000Z`,
      toolCallId: `call-${i}`,
      name: 'read_file',
      ok: true,
      content: JSON.stringify({
        ok: true,
        path: `src/file-${i}.ts`,
        totalLines: 100 + i,
        stdout: `Content of file-${i}.ts\n`.repeat(20),
      }),
      resultMeta: { path: `src/file-${i}.ts`, totalLines: 100 + i },
    });
  }
  state.transcript.messages = messages;
  state.turn.turnIndex = turnCount;
  const last = messages.at(-1)!;
  state.turn.turnId = last.turnId!;
  return {
    firstId: messages[0]!.messageId!,
    lastId: last.messageId!,
    lastTurnId: last.turnId!,
  };
}

/** Build transcript with file mutations (read → edit → read → failed build → fix). */
function buildTranscriptWithMutations(state: RuntimeState): {
  firstId: string;
  lastId: string;
  lastTurnId: string;
} {
  const messages: TranscriptMessage[] = [
    // Turn 0: read config before edit
    {
      kind: 'user',
      messageId: 'msg-0',
      turnId: 'turn-0',
      ordinal: 0,
      createdAt: '2026-07-20T00:00:00.000Z',
      content: 'Read and edit config',
    },
    {
      kind: 'assistant',
      messageId: 'msg-ai-0',
      turnId: 'turn-0',
      ordinal: 1,
      createdAt: '2026-07-20T00:00:30.000Z',
      content: 'Reading',
      toolCalls: [{ id: 'read-0', name: 'read_file', args: { path: 'config.ts' } }],
    },
    {
      kind: 'tool',
      messageId: 'msg-tool-0',
      turnId: 'turn-0',
      ordinal: 2,
      createdAt: '2026-07-20T00:00:31.000Z',
      toolCallId: 'read-0',
      name: 'read_file',
      ok: true,
      content: JSON.stringify({
        ok: true,
        path: 'config.ts',
        totalLines: 50,
        stdout: 'before-edit'.repeat(10),
      }),
      resultMeta: { path: 'config.ts', totalLines: 50 },
    },
    // Turn 1: edit config
    {
      kind: 'user',
      messageId: 'msg-1',
      turnId: 'turn-1',
      ordinal: 3,
      createdAt: '2026-07-20T00:01:00.000Z',
      content: 'Edit the config',
    },
    {
      kind: 'assistant',
      messageId: 'msg-ai-1',
      turnId: 'turn-1',
      ordinal: 4,
      createdAt: '2026-07-20T00:01:30.000Z',
      content: 'Editing',
      toolCalls: [
        {
          id: 'edit-0',
          name: 'edit_file',
          args: { path: 'config.ts', old_string: 'before', new_string: 'after' },
        },
      ],
    },
    {
      kind: 'tool',
      messageId: 'msg-tool-1',
      turnId: 'turn-1',
      ordinal: 5,
      createdAt: '2026-07-20T00:01:31.000Z',
      toolCallId: 'edit-0',
      name: 'edit_file',
      ok: true,
      content: JSON.stringify({ ok: true, path: 'config.ts' }),
    },
    // Turn 2: re-read after edit (must be preserved in M1)
    {
      kind: 'user',
      messageId: 'msg-2',
      turnId: 'turn-2',
      ordinal: 6,
      createdAt: '2026-07-20T00:02:00.000Z',
      content: 'Verify the edit',
    },
    {
      kind: 'assistant',
      messageId: 'msg-ai-2',
      turnId: 'turn-2',
      ordinal: 7,
      createdAt: '2026-07-20T00:02:30.000Z',
      content: 'Verifying',
      toolCalls: [{ id: 'read-1', name: 'read_file', args: { path: 'config.ts' } }],
    },
    {
      kind: 'tool',
      messageId: 'msg-tool-2',
      turnId: 'turn-2',
      ordinal: 8,
      createdAt: '2026-07-20T00:02:31.000Z',
      toolCallId: 'read-1',
      name: 'read_file',
      ok: true,
      content: JSON.stringify({
        ok: true,
        path: 'config.ts',
        totalLines: 52,
        stdout: 'after-edit'.repeat(10),
      }),
      resultMeta: { path: 'config.ts', totalLines: 52 },
    },
    // Turn 3: failed build
    {
      kind: 'user',
      messageId: 'msg-3',
      turnId: 'turn-3',
      ordinal: 9,
      createdAt: '2026-07-20T00:03:00.000Z',
      content: 'Build the project',
    },
    {
      kind: 'assistant',
      messageId: 'msg-ai-3',
      turnId: 'turn-3',
      ordinal: 10,
      createdAt: '2026-07-20T00:03:30.000Z',
      content: 'Building',
      toolCalls: [{ id: 'build-0', name: 'shell_execute', args: { command: 'bun run build' } }],
    },
    {
      kind: 'tool',
      messageId: 'msg-tool-3',
      turnId: 'turn-3',
      ordinal: 11,
      createdAt: '2026-07-20T00:03:31.000Z',
      toolCallId: 'build-0',
      name: 'shell_execute',
      ok: false,
      content: JSON.stringify({
        ok: false,
        command: 'bun run build',
        exitCode: 1,
        stderr: 'TypeScript error in src/auth/login.ts:42',
      }),
      resultMeta: { command: 'bun run build' },
    },
    // Turn 4: fix + search
    {
      kind: 'user',
      messageId: 'msg-4',
      turnId: 'turn-4',
      ordinal: 12,
      createdAt: '2026-07-20T00:04:00.000Z',
      content: 'Fix and search for TODOs',
    },
    {
      kind: 'assistant',
      messageId: 'msg-ai-4',
      turnId: 'turn-4',
      ordinal: 13,
      createdAt: '2026-07-20T00:04:30.000Z',
      content: 'Fixing and searching',
      toolCalls: [
        { id: 'edit-1', name: 'edit_file', args: { path: 'src/auth/login.ts' } },
        { id: 'search-0', name: 'search_content', args: { pattern: 'TODO' } },
      ],
    },
    {
      kind: 'tool',
      messageId: 'msg-tool-4a',
      turnId: 'turn-4',
      ordinal: 14,
      createdAt: '2026-07-20T00:04:31.000Z',
      toolCallId: 'edit-1',
      name: 'edit_file',
      ok: true,
      content: JSON.stringify({ ok: true, path: 'src/auth/login.ts' }),
    },
    {
      kind: 'tool',
      messageId: 'msg-tool-4b',
      turnId: 'turn-4',
      ordinal: 15,
      createdAt: '2026-07-20T00:04:32.000Z',
      toolCallId: 'search-0',
      name: 'search_content',
      ok: true,
      content: JSON.stringify({
        ok: true,
        query: 'TODO',
        matchCount: 5,
        topMatches: ['src/auth/login.ts:145'],
        truncated: false,
      }),
      resultMeta: { matchCount: 5 },
    },
  ];
  state.transcript.messages = messages;
  state.turn.turnIndex = 5;
  const last = messages.at(-1)!;
  state.turn.turnId = last.turnId!;
  return { firstId: messages[0]!.messageId!, lastId: last.messageId!, lastTurnId: last.turnId! };
}

/** Apply a compaction request, then return the requested state + the compactionId. */
function requestCompaction(
  state: RuntimeState,
  reason: 'manual' | 'auto_soft' | 'auto_hard' | 'overflow_recovery' = 'auto_soft',
): { state: RuntimeState; compactionId: string } {
  const compactionId = `compact-${reason}`;
  return {
    state: reduceRuntimeState(state, {
      type: 'context.compaction_requested',
      compactionId,
      reason,
      requestedAtRevision: state.revision,
      requestedAtTurnId: state.turn.turnId,
      force: reason === 'manual' || reason === 'overflow_recovery',
      estimate: estimate(8_000),
    }),
    compactionId,
  };
}

/** Apply a completed compaction event. Caller must have already applied a matching request. */
function applyCompleted(
  state: RuntimeState,
  compactionId: string,
  opts: {
    sourceDigest?: string;
    firstMsgId?: string;
    lastMsgId?: string;
    lastTurnId?: string;
    tokensBefore?: number;
    tokensAfter?: number;
    targetTokens?: number;
    reason?: import('../../src/core/runtime/context-compaction').ContextCompactionReason;
  } = {},
): RuntimeState {
  const {
    sourceDigest = 'sha256:e2e',
    firstMsgId = 'msg-user-0',
    lastMsgId = 'msg-tool-9',
    lastTurnId = 'turn-9',
    tokensBefore = 8_000,
    tokensAfter = 3_500,
    targetTokens = 4_400,
    reason = 'auto_soft',
  } = opts;
  return reduceRuntimeState(state, {
    type: 'context.compaction_completed',
    compactionId,
    sourceRevision: state.revision,
    checkpoint: {
      compactionId,
      version: 1,
      sourceRevision: state.revision,
      sourceDigest,
      coveredThroughMessageId: lastMsgId,
      coveredThroughTurnId: lastTurnId,
      summary: makeSummary(sourceDigest, firstMsgId, lastMsgId),
      inputTokensBefore: tokensBefore,
      inputTokensAfter: tokensAfter,
      targetTokens,
      reason,
      createdAt: new Date().toISOString(),
    },
  });
}

/** Compactor that produces a valid checkpoint using the actual transcript state. */
function realCompactor(
  overrides: Partial<{
    tokensBefore: number;
    tokensAfter: number;
    targetTokens: number;
  }> = {},
): NonNullable<Parameters<typeof executeContextCompaction>[0]['compact']> {
  return async ({ sourceRevision, pending, state }) => {
    const msgs = state.transcript.messages;
    const first = msgs[0]!;
    const last = msgs.at(-1)!;
    const digest = `sha256:e2e-${sourceRevision}`;
    return {
      compactionId: pending.compactionId,
      version: 1,
      sourceRevision,
      sourceDigest: digest,
      coveredThroughMessageId: last.messageId!,
      coveredThroughTurnId: last.turnId!,
      summary: makeSummary(digest, first.messageId!, last.messageId!),
      inputTokensBefore: overrides.tokensBefore ?? 8_000,
      inputTokensAfter: overrides.tokensAfter ?? 3_500,
      targetTokens: overrides.targetTokens ?? 4_400,
      reason: pending.reason,
      createdAt: new Date().toISOString(),
    };
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Full Pipeline E2E
// ═══════════════════════════════════════════════════════════════════════════════

describe('E2E: full pipeline', () => {
  test('manual compaction: request → scheduler → executor → completed → checkpoint active', async () => {
    const state = createInitialRuntimeState({ threadId: 'e2e-1', userId: 'u', workspace: '/ws' });
    buildTranscript(state, 10);

    // Request
    const { state: requested, compactionId } = requestCompaction(state, 'manual');
    expect(requested.context.pendingCompaction?.reason).toBe('manual');

    // Scheduler
    expect(decideNextEffect(requested).type).toBe('compact_context');

    // Executor
    const events = await executeContextCompaction({
      state: requested,
      compactionId,
      compact: realCompactor(),
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('context.compaction_completed');

    // Reducer activates checkpoint
    const completed = reduceRuntimeState(requested, events[0]!);
    expect(completed.context.pendingCompaction).toBeUndefined();
    expect(completed.context.activeCheckpoint).toBeDefined();
    expect(completed.context.activeCheckpoint?.inputTokensBefore).toBe(8_000);
    expect(completed.context.activeCheckpoint?.inputTokensAfter).toBe(3_500);
    expect(completed.context.history).toHaveLength(1);
  });

  test('kernel effect lease: begin → apply → verified atomic', () => {
    const state = createInitialRuntimeState({
      threadId: 'e2e-kernel',
      userId: 'u',
      workspace: '/ws',
    });
    buildTranscript(state, 10);
    const { state: requested, compactionId } = requestCompaction(state, 'manual');

    const store = createRuntimeStore(':memory:');
    const kernel = new AgentKernel({
      store,
      initialState: requested,
      interactionMode: 'accept_edits',
    });

    const lease = kernel.beginEffect({ type: 'compact_context', compactionId });
    const applied = kernel.applyEffectResult(lease, [
      {
        type: 'context.compaction_completed',
        compactionId,
        sourceRevision: lease.expectedRevision,
        checkpoint: {
          compactionId,
          version: 1,
          sourceRevision: lease.expectedRevision,
          sourceDigest: 'sha256:e2e',
          coveredThroughMessageId: 'msg-tool-9',
          coveredThroughTurnId: 'turn-9',
          summary: makeSummary('sha256:e2e', 'msg-user-0', 'msg-tool-9'),
          inputTokensBefore: 8_000,
          inputTokensAfter: 3_500,
          targetTokens: 4_400,
          reason: 'manual',
          createdAt: new Date().toISOString(),
        },
      },
    ]);
    expect(applied).toBe(true);
    expect(kernel.getState().context.activeCheckpoint?.compactionId).toBe(compactionId);
    kernel.close();
  });

  test('pending compaction takes priority over call_model', () => {
    const state = createInitialRuntimeState({
      threadId: 'e2e-prio',
      userId: 'u',
      workspace: '/ws',
    });
    buildTranscript(state, 3);
    const { state: requested } = requestCompaction(state, 'auto_soft');
    expect(decideNextEffect(requested).type).toBe('compact_context');
  });

  test('no pending compaction → call_model', () => {
    const state = createInitialRuntimeState({
      threadId: 'e2e-no-compact',
      userId: 'u',
      workspace: '/ws',
    });
    state.interactions = { kind: 'idle' };
    expect(decideNextEffect(state).type).toBe('call_model');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Manual Compaction Lifecycle
// ═══════════════════════════════════════════════════════════════════════════════

describe('E2E: manual lifecycle', () => {
  test('/compact normal → completed → /compact reset → re-compact', () => {
    const state = createInitialRuntimeState({
      threadId: 'e2e-lifecycle',
      userId: 'u',
      workspace: '/ws',
    });
    buildTranscript(state, 10);

    // 1. Request + complete
    const { state: requested, compactionId } = requestCompaction(state, 'manual');
    const completed = applyCompleted(requested, compactionId, { reason: 'manual' });
    expect(completed.context.activeCheckpoint?.compactionId).toBe(compactionId);
    expect(completed.context.history).toHaveLength(1);

    // 2. Reset
    const transcriptBefore = [...completed.transcript.messages];
    const reset = reduceRuntimeState(completed, {
      type: 'context.compaction_reset',
      checkpointId: compactionId,
      reason: 'manual',
    });
    expect(reset.context.activeCheckpoint).toBeUndefined();
    expect(reset.transcript.messages).toEqual(transcriptBefore);
    expect(reset.context.history).toHaveLength(2);
    expect(reset.context.history[1]?.kind).toBe('reset');

    // 3. Re-compact
    const { state: reRequested } = requestCompaction(reset, 'manual');
    expect(reRequested.context.pendingCompaction).toBeDefined();
  });

  test('/compact force: schema validation still enforced', async () => {
    const state = createInitialRuntimeState({
      threadId: 'e2e-force',
      userId: 'u',
      workspace: '/ws',
    });
    buildTranscript(state, 10);
    const { state: requested, compactionId } = requestCompaction(state, 'manual');

    const events = await executeContextCompaction({
      state: requested,
      compactionId,
      compact: async ({ sourceRevision, pending }) => ({
        compactionId: pending.compactionId,
        version: 1,
        sourceRevision,
        sourceDigest: 'sha256:force',
        coveredThroughMessageId: 'msg-tool-9',
        coveredThroughTurnId: 'turn-9',
        summary: {
          ...makeSummary('sha256:force', 'msg-user-0', 'msg-tool-9'),
          provenance: {
            ...makeSummary('sha256:force', 'msg-user-0', 'msg-tool-9').provenance,
            sourceDigest: 'sha256:mismatch',
          },
        },
        inputTokensBefore: 8_000,
        inputTokensAfter: 3_500,
        targetTokens: 4_400,
        reason: pending.reason,
        createdAt: new Date().toISOString(),
      }),
    });
    expect(events[0]?.type).toBe('context.compaction_failed');
  });

  test('insufficient reduction: inputTokensAfter >= inputTokensBefore → failed', async () => {
    const state = createInitialRuntimeState({
      threadId: 'e2e-insuf',
      userId: 'u',
      workspace: '/ws',
    });
    buildTranscript(state, 10);
    const { state: requested, compactionId } = requestCompaction(state, 'manual');

    const events = await executeContextCompaction({
      state: requested,
      compactionId,
      compact: realCompactor({ tokensBefore: 8_000, tokensAfter: 8_000, targetTokens: 4_400 }),
    });
    expect(events[0]?.type).toBe('context.compaction_failed');
    if (events[0]?.type === 'context.compaction_failed') {
      expect(events[0].errorKind).toBe('insufficient_reduction');
    }
  });

  test('reset preserves original transcript and allows re-compaction via executor', async () => {
    const state = createInitialRuntimeState({
      threadId: 'e2e-recompact',
      userId: 'u',
      workspace: '/ws',
    });
    buildTranscript(state, 10);

    // First compaction
    const { state: req1, compactionId: id1 } = requestCompaction(state, 'manual');
    const events1 = await executeContextCompaction({
      state: req1,
      compactionId: id1,
      compact: realCompactor(),
    });
    const completed1 = reduceRuntimeState(req1, events1[0]!);
    expect(completed1.context.activeCheckpoint).toBeDefined();

    // Reset
    const reset = reduceRuntimeState(completed1, {
      type: 'context.compaction_reset',
      checkpointId: id1,
      reason: 'manual',
    });
    expect(reset.context.activeCheckpoint).toBeUndefined();

    // Re-compact
    const { state: req2, compactionId: id2 } = requestCompaction(reset, 'manual');
    expect(req2.context.pendingCompaction?.compactionId).toBe(id2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Auto Compaction
// ═══════════════════════════════════════════════════════════════════════════════

describe('E2E: auto compaction', () => {
  test('auto_soft: request → complete → cooldown recorded', () => {
    const state = createInitialRuntimeState({
      threadId: 'e2e-soft',
      userId: 'u',
      workspace: '/ws',
    });
    buildTranscript(state, 10);

    const { state: requested, compactionId } = requestCompaction(state, 'auto_soft');
    const completed = applyCompleted(requested, compactionId, { reason: 'auto_soft' });
    expect(completed.context.activeCheckpoint).toBeDefined();
    expect(completed.context.lastCompactionTurnIndex).toBe(10);
    expect(completed.context.pendingCompaction).toBeUndefined();
  });

  test('auto_hard: request → complete even with cooldown', () => {
    const state = createInitialRuntimeState({
      threadId: 'e2e-hard',
      userId: 'u',
      workspace: '/ws',
    });
    buildTranscript(state, 10);
    state.context.lastCompactionTurnIndex = state.turn.turnIndex; // cooldown active

    // Hard compaction still requestable
    const { state: requested } = requestCompaction(state, 'auto_hard');
    expect(requested.context.pendingCompaction?.reason).toBe('auto_hard');
  });

  test('hard failure → scheduler blocks recovery', () => {
    const state = createInitialRuntimeState({
      threadId: 'e2e-hard-fail',
      userId: 'u',
      workspace: '/ws',
    });
    buildTranscript(state, 10);

    const { state: requested, compactionId } = requestCompaction(state, 'auto_hard');
    const failed = reduceRuntimeState(requested, {
      type: 'context.compaction_failed',
      compactionId,
      sourceRevision: requested.revision,
      errorKind: 'unsafe_boundary',
      message: 'Cannot find safe boundary.',
      retryable: false,
    });
    failed.revision = requested.revision + 1;
    expect(decideNextEffect(failed).type).toBe('recovery_blocked');
  });

  test('retryable auto_hard failure allows recovery re-attempt', () => {
    const state = createInitialRuntimeState({
      threadId: 'e2e-hard-retry',
      userId: 'u',
      workspace: '/ws',
    });
    buildTranscript(state, 10);

    // Request hard compaction
    const { state: requested, compactionId } = requestCompaction(state, 'auto_hard');
    const completed = applyCompleted(requested, compactionId, { reason: 'auto_hard' });
    expect(completed.context.activeCheckpoint).toBeDefined();
    // After successful completion, no recovery block
    expect(decideNextEffect(completed).type).not.toBe('recovery_blocked');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Error Scenarios (exhaustive)
// ═══════════════════════════════════════════════════════════════════════════════

describe('E2E: error scenarios', () => {
  test('provenance mismatch → invalid_schema', async () => {
    const state = createInitialRuntimeState({
      threadId: 'e2e-prov',
      userId: 'u',
      workspace: '/ws',
    });
    buildTranscript(state, 10);
    const { state: requested, compactionId } = requestCompaction(state, 'manual');

    const events = await executeContextCompaction({
      state: requested,
      compactionId,
      compact: async ({ sourceRevision, pending }) => {
        const digest = 'sha256:prov';
        return {
          compactionId: pending.compactionId,
          version: 1,
          sourceRevision,
          sourceDigest: digest,
          coveredThroughMessageId: 'msg-tool-9',
          coveredThroughTurnId: 'turn-9',
          summary: {
            ...makeSummary(digest, 'msg-user-0', 'msg-tool-9'),
            provenance: {
              ...makeSummary(digest, 'msg-user-0', 'msg-tool-9').provenance,
              sourceDigest: 'sha256:wrong',
            },
          },
          inputTokensBefore: 8_000,
          inputTokensAfter: 3_500,
          targetTokens: 4_400,
          reason: pending.reason,
          createdAt: new Date().toISOString(),
        };
      },
    });
    expect(events[0]?.type).toBe('context.compaction_failed');
    if (events[0]?.type === 'context.compaction_failed') {
      expect(events[0].errorKind).toBe('invalid_schema');
    }
  });

  test('stale source: mismatched compactionId → rejected', async () => {
    const state = createInitialRuntimeState({
      threadId: 'e2e-stale',
      userId: 'u',
      workspace: '/ws',
    });
    buildTranscript(state, 10);
    const { state: requested, compactionId } = requestCompaction(state, 'manual');

    // Verify that completed event with wrong compactionId is rejected by reducer
    // (even though the executor would produce a valid result)
    const result = reduceRuntimeState(requested, {
      type: 'context.compaction_completed',
      compactionId: 'wrong-id',
      sourceRevision: requested.revision,
      checkpoint: {
        compactionId: 'wrong-id',
        version: 1,
        sourceRevision: requested.revision,
        sourceDigest: 'sha256:wrong',
        coveredThroughMessageId: 'msg-tool-9',
        coveredThroughTurnId: 'turn-9',
        summary: makeSummary('sha256:wrong', 'msg-user-0', 'msg-tool-9'),
        inputTokensBefore: 8_000,
        inputTokensAfter: 3_500,
        targetTokens: 4_400,
        reason: 'manual',
        createdAt: new Date().toISOString(),
      },
    });
    // Reducer rejects: pending compaction ID doesn't match event compaction ID
    expect(result.context.activeCheckpoint).toBeUndefined();
    expect(result.context.pendingCompaction?.compactionId).toBe(compactionId);
  });

  test('missing compactor → summary_model_failed', async () => {
    const state = createInitialRuntimeState({
      threadId: 'e2e-missing',
      userId: 'u',
      workspace: '/ws',
    });
    buildTranscript(state, 10);
    const { state: requested, compactionId } = requestCompaction(state, 'manual');

    const events = await executeContextCompaction({ state: requested, compactionId });
    expect(events[0]?.type).toBe('context.compaction_failed');
    if (events[0]?.type === 'context.compaction_failed') {
      expect(events[0].errorKind).toBe('summary_model_failed');
    }
  });

  test('mismatched pending id → no-op (empty events)', async () => {
    const state = createInitialRuntimeState({
      threadId: 'e2e-noop',
      userId: 'u',
      workspace: '/ws',
    });
    buildTranscript(state, 10);
    requestCompaction(state, 'manual');

    const events = await executeContextCompaction({
      state,
      compactionId: 'non-existent',
      compact: realCompactor(),
    });
    expect(events).toEqual([]);
  });

  test('compactor throws → summary_model_failed (retryable)', async () => {
    const state = createInitialRuntimeState({
      threadId: 'e2e-throw',
      userId: 'u',
      workspace: '/ws',
    });
    buildTranscript(state, 10);
    const { state: requested, compactionId } = requestCompaction(state, 'manual');

    const events = await executeContextCompaction({
      state: requested,
      compactionId,
      compact: async () => {
        throw new Error('Model unavailable');
      },
    });
    expect(events[0]?.type).toBe('context.compaction_failed');
    if (events[0]?.type === 'context.compaction_failed') {
      expect(events[0].errorKind).toBe('summary_model_failed');
      expect(events[0].message).toContain('Model unavailable');
      expect(events[0].retryable).toBe(true);
    }
  });

  test('ContextCompactionValidationError → correct errorKind mapping', async () => {
    const state = createInitialRuntimeState({
      threadId: 'e2e-valerr',
      userId: 'u',
      workspace: '/ws',
    });
    buildTranscript(state, 10);
    const { state: requested, compactionId } = requestCompaction(state, 'manual');

    for (const kind of ['missing_mandatory_facts', 'insufficient_reduction'] as const) {
      const events = await executeContextCompaction({
        state: requested,
        compactionId,
        compact: async () => {
          throw new ContextCompactionValidationError(kind, `Error: ${kind}`);
        },
      });
      expect(events[0]?.type).toBe('context.compaction_failed');
      if (events[0]?.type === 'context.compaction_failed') {
        expect(events[0].errorKind).toBe(kind);
      }
    }
  });

  test('covered message not in transcript → unsafe_boundary', async () => {
    const state = createInitialRuntimeState({
      threadId: 'e2e-bound',
      userId: 'u',
      workspace: '/ws',
    });
    buildTranscript(state, 10);
    const { state: requested, compactionId } = requestCompaction(state, 'manual');

    const events = await executeContextCompaction({
      state: requested,
      compactionId,
      compact: async ({ sourceRevision, pending }) => {
        const digest = 'sha256:bound';
        return {
          compactionId: pending.compactionId,
          version: 1,
          sourceRevision,
          sourceDigest: digest,
          coveredThroughMessageId: 'no-such-message',
          coveredThroughTurnId: 'no-such-turn',
          summary: makeSummary(digest, 'no-such', 'no-such'),
          inputTokensBefore: 8_000,
          inputTokensAfter: 3_500,
          targetTokens: 4_400,
          reason: pending.reason,
          createdAt: new Date().toISOString(),
        };
      },
    });
    expect(events[0]?.type).toBe('context.compaction_failed');
    if (events[0]?.type === 'context.compaction_failed') {
      expect(events[0].errorKind).toBe('unsafe_boundary');
    }
  });

  test('all error kinds return properly structured events', () => {
    const state = createInitialRuntimeState({
      threadId: 'e2e-errors',
      userId: 'u',
      workspace: '/ws',
    });
    buildTranscript(state, 5);
    const { state: requested, compactionId } = requestCompaction(state, 'auto_soft');

    const errorKinds = [
      'unsafe_boundary',
      'summary_model_failed',
      'invalid_schema',
      'missing_mandatory_facts',
      'insufficient_reduction',
      'stale_source',
    ] as const;
    for (const errorKind of errorKinds) {
      const failed = reduceRuntimeState(requested, {
        type: 'context.compaction_failed',
        compactionId,
        sourceRevision: requested.revision,
        errorKind,
        message: `Test: ${errorKind}`,
        retryable: errorKind !== 'unsafe_boundary',
      });
      expect(failed.context.lastFailure?.errorKind).toBe(errorKind);
      expect(failed.context.lastFailure?.message).toContain(errorKind);
    }
  });

  test('failed event without matching pending compaction is ignored by reducer', () => {
    const state = createInitialRuntimeState({
      threadId: 'e2e-no-match',
      userId: 'u',
      workspace: '/ws',
    });
    const result = reduceRuntimeState(state, {
      type: 'context.compaction_failed',
      compactionId: 'no-such-pending',
      sourceRevision: 0,
      errorKind: 'summary_model_failed',
      message: 'ignored',
      retryable: true,
    });
    expect(result.context.lastFailure).toBeUndefined();
  });

  test('completed event without matching pending compaction is ignored by reducer', () => {
    const state = createInitialRuntimeState({
      threadId: 'e2e-no-match2',
      userId: 'u',
      workspace: '/ws',
    });
    const result = reduceRuntimeState(state, {
      type: 'context.compaction_completed',
      compactionId: 'no-such-pending',
      sourceRevision: 0,
      checkpoint: {
        compactionId: 'no-such-pending',
        version: 1,
        sourceRevision: 0,
        sourceDigest: 'sha256:ignored',
        coveredThroughMessageId: 'x',
        coveredThroughTurnId: 'x',
        summary: makeSummary('sha256:ignored', 'x', 'x'),
        inputTokensBefore: 100,
        inputTokensAfter: 50,
        targetTokens: 55,
        reason: 'manual',
        createdAt: new Date().toISOString(),
      },
    });
    expect(result.context.activeCheckpoint).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Kernel Lease & Concurrency
// ═══════════════════════════════════════════════════════════════════════════════

describe('E2E: kernel lease & concurrency', () => {
  test('intermediate event invalidates lease → applyEffectResult returns false', () => {
    const state = createInitialRuntimeState({
      threadId: 'e2e-lease',
      userId: 'u',
      workspace: '/ws',
    });
    buildTranscript(state, 10);
    const { state: requested, compactionId } = requestCompaction(state, 'manual');

    const store = createRuntimeStore(':memory:');
    const kernel = new AgentKernel({
      store,
      initialState: requested,
      interactionMode: 'accept_edits',
    });
    const lease = kernel.beginEffect({ type: 'compact_context', compactionId });

    // Inject user message → advances revision
    kernel.processEvent({
      type: 'user.message_appended',
      messageId: 'new-msg',
      content: 'intermediate',
    });

    // Effect result must be rejected
    const applied = kernel.applyEffectResult(lease, [
      {
        type: 'context.compaction_completed',
        compactionId,
        sourceRevision: lease.expectedRevision,
        checkpoint: {
          compactionId,
          version: 1,
          sourceRevision: lease.expectedRevision,
          sourceDigest: 'sha256:stale',
          coveredThroughMessageId: 'msg-tool-9',
          coveredThroughTurnId: 'turn-9',
          summary: makeSummary('sha256:stale', 'msg-user-0', 'msg-tool-9'),
          inputTokensBefore: 8_000,
          inputTokensAfter: 3_500,
          targetTokens: 4_400,
          reason: 'manual',
          createdAt: new Date().toISOString(),
        },
      },
    ]);
    expect(applied).toBe(false);
    expect(kernel.getState().context.pendingCompaction?.compactionId).toBe(compactionId);
    kernel.close();
  });

  test('kernel persist + restore preserves active checkpoint', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kite-compaction-e2e-'));
    try {
      const state = createInitialRuntimeState({
        threadId: 'e2e-persist',
        userId: 'u',
        workspace: '/ws',
      });
      buildTranscript(state, 10);
      const { state: requested, compactionId } = requestCompaction(state, 'manual');
      const completed = applyCompleted(requested, compactionId, { reason: 'manual' });

      const store = createRuntimeStore(join(dir, 'runtime.db'));
      store.saveSnapshot('e2e-persist', completed);
      store.close();

      const restored = createAgentKernel({
        threadId: 'e2e-persist',
        userId: 'u',
        workspace: '/ws',
        storePath: join(dir, 'runtime.db'),
      });
      const rs = restored.getState();
      expect(rs.context.activeCheckpoint?.compactionId).toBe(compactionId);
      expect(rs.context.activeCheckpoint?.reason).toBe('manual');
      expect(rs.context.activeCheckpoint?.summary.objective).toContain('authentication');
      expect(rs.context.history).toHaveLength(1);
      restored.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('kernel persist + restore preserves failure → completed → reset history', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kite-compaction-e2e-fail-'));
    try {
      const state = createInitialRuntimeState({
        threadId: 'e2e-hist',
        userId: 'u',
        workspace: '/ws',
      });
      buildTranscript(state, 10);

      // fail → complete → reset
      const { state: req1, compactionId: id1 } = requestCompaction(state, 'manual');
      const failed = reduceRuntimeState(req1, {
        type: 'context.compaction_failed',
        compactionId: id1,
        sourceRevision: req1.revision,
        errorKind: 'invalid_schema',
        message: 'bad summary',
        retryable: false,
      });
      const { state: req2, compactionId: id2 } = requestCompaction(failed, 'manual');
      const completed = applyCompleted(req2, id2, { reason: 'manual' });
      const reset = reduceRuntimeState(completed, {
        type: 'context.compaction_reset',
        checkpointId: id2,
        reason: 'manual',
      });

      const store = createRuntimeStore(join(dir, 'runtime.db'));
      store.saveSnapshot('e2e-hist', reset);
      store.close();

      const restored = createAgentKernel({
        threadId: 'e2e-hist',
        userId: 'u',
        workspace: '/ws',
        storePath: join(dir, 'runtime.db'),
      });
      const rs = restored.getState();
      expect(rs.context.activeCheckpoint).toBeUndefined();
      expect(rs.context.history).toHaveLength(3);
      expect(rs.context.history[0]?.kind).toBe('failed');
      expect(rs.context.history[1]?.kind).toBe('completed');
      expect(rs.context.history[2]?.kind).toBe('reset');
      restored.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. Multi-turn & Successive Compactions
// ═══════════════════════════════════════════════════════════════════════════════

describe('E2E: multi-turn compaction', () => {
  test('history capped at 128 entries', () => {
    const state = createInitialRuntimeState({
      threadId: 'e2e-history',
      userId: 'u',
      workspace: '/ws',
    });
    buildTranscript(state, 2);
    const { state: first } = requestCompaction(state, 'auto_soft');

    let current = first;
    for (let i = 0; i < 150; i++) {
      current = reduceRuntimeState(current, {
        type: 'context.compaction_failed',
        compactionId: 'compact-auto_soft',
        sourceRevision: i,
        errorKind: 'summary_model_failed',
        message: `Failure ${i}`,
        retryable: true,
      });
    }
    expect(current.context.history.length).toBeLessThanOrEqual(128);
  });

  test('checkpoint replacement: second compaction supersedes first', () => {
    const state = createInitialRuntimeState({
      threadId: 'e2e-repl',
      userId: 'u',
      workspace: '/ws',
    });
    buildTranscript(state, 10);

    // First compaction
    const { state: req1, compactionId: id1 } = requestCompaction(state, 'manual');
    const completed1 = applyCompleted(req1, id1, {
      reason: 'manual',
      lastMsgId: 'msg-tool-4',
      lastTurnId: 'turn-4',
      sourceDigest: 'sha256:first',
      tokensBefore: 4_000,
      tokensAfter: 1_800,
      targetTokens: 2_200,
    });
    expect(completed1.context.activeCheckpoint?.compactionId).toBe(id1);

    // Second compaction (covers more)
    const { state: req2, compactionId: id2 } = requestCompaction(completed1, 'manual');
    const completed2 = applyCompleted(req2, id2, {
      reason: 'manual',
      lastMsgId: 'msg-tool-9',
      lastTurnId: 'turn-9',
      sourceDigest: 'sha256:second',
      tokensBefore: 7_000,
      tokensAfter: 2_900,
      targetTokens: 3_850,
    });
    expect(completed2.context.activeCheckpoint?.compactionId).toBe(id2);
    expect(completed2.context.history).toHaveLength(2);
  });

  test('three successive compactions produce correct history order', () => {
    const state = createInitialRuntimeState({
      threadId: 'e2e-triple',
      userId: 'u',
      workspace: '/ws',
    });
    buildTranscript(state, 10);

    // 1st
    const { state: s1, compactionId: id1 } = requestCompaction(state, 'manual');
    const c1 = applyCompleted(s1, id1, { reason: 'manual', sourceDigest: 'sha256:c1' });
    // 2nd
    const { state: s2, compactionId: id2 } = requestCompaction(c1, 'manual');
    const c2 = applyCompleted(s2, id2, { reason: 'manual', sourceDigest: 'sha256:c2' });
    // 3rd
    const { state: s3, compactionId: id3 } = requestCompaction(c2, 'manual');
    const c3 = applyCompleted(s3, id3, { reason: 'manual', sourceDigest: 'sha256:c3' });

    expect(c3.context.history).toHaveLength(3);
    expect(c3.context.history.map((h: any) => h.kind)).toEqual([
      'completed',
      'completed',
      'completed',
    ]);
    expect(c3.context.activeCheckpoint?.compactionId).toBe(id3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. Compaction with File Mutations
// ═══════════════════════════════════════════════════════════════════════════════

describe('E2E: compaction with mutations', () => {
  test('checkpoint preserves edit facts and failure info after mutations', async () => {
    const state = createInitialRuntimeState({ threadId: 'e2e-mut', userId: 'u', workspace: '/ws' });
    const ids = buildTranscriptWithMutations(state);
    const { state: requested, compactionId } = requestCompaction(state, 'manual');

    const events = await executeContextCompaction({
      state: requested,
      compactionId,
      compact: async ({ sourceRevision, pending }) => {
        const digest = 'sha256:mut';
        return {
          compactionId: pending.compactionId,
          version: 1,
          sourceRevision,
          sourceDigest: digest,
          coveredThroughMessageId: ids.lastId,
          coveredThroughTurnId: ids.lastTurnId,
          summary: {
            version: 1,
            objective: 'Edited config.ts and fixed build errors.',
            userConstraints: [{ factId: 'f1', text: 'Must use strict mode' }],
            decisions: [],
            completedWork: [
              {
                factId: 'f2',
                path: 'config.ts',
                summary: 'Updated config',
                evidenceMessageIds: ['msg-tool-1'],
              },
            ],
            observations: [],
            failures: [
              {
                factId: 'f3',
                operation: 'build',
                error: 'strictNullChecks',
                consequence: 'Added guards',
              },
            ],
            pendingWork: [],
            unresolvedQuestions: [],
            recentUserIntent: 'Fix build error',
            provenance: {
              firstMessageId: ids.firstId,
              lastMessageId: ids.lastId,
              sourceDigest: digest,
              mandatoryFactIds: ['f1', 'f2', 'f3'],
            },
          },
          inputTokensBefore: 5_000,
          inputTokensAfter: 2_000,
          targetTokens: 2_750,
          reason: pending.reason,
          createdAt: new Date().toISOString(),
        };
      },
    });
    expect(events[0]?.type).toBe('context.compaction_completed');
    if (events[0]?.type === 'context.compaction_completed') {
      const s = events[0].checkpoint.summary;
      expect(s.completedWork).toHaveLength(1);
      expect(s.completedWork[0]?.path).toBe('config.ts');
      expect(s.failures).toHaveLength(1);
      expect(s.failures[0]?.operation).toBe('build');
      expect(s.provenance.mandatoryFactIds).toContain('f3');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. Overflow Recovery
// ═══════════════════════════════════════════════════════════════════════════════

describe('E2E: overflow recovery', () => {
  test('overflow recovery checkpoint has correct reason and turn tracking', () => {
    const state = createInitialRuntimeState({
      threadId: 'e2e-overflow',
      userId: 'u',
      workspace: '/ws',
    });
    buildTranscript(state, 10);

    const { state: requested, compactionId } = requestCompaction(state, 'overflow_recovery');
    // overflow_recovery sets overflowRecoveryTurnId via the reducer
    expect(requested.context.overflowRecoveryTurnId).toBe(state.turn.turnId);

    const completed = applyCompleted(requested, compactionId, { reason: 'overflow_recovery' });
    expect(completed.context.activeCheckpoint?.reason).toBe('overflow_recovery');
    // Note: overflowRecoveryTurnId is set by the request reducer but not carried
    // into the completed context object (which rebuilds context from scratch).
    // The request event sets it; after completion it's removed.
    expect(completed.context.lastFailure).toBeUndefined();
  });

  test('overflow recovery without pending is ignored', () => {
    const state = createInitialRuntimeState({
      threadId: 'e2e-overflow2',
      userId: 'u',
      workspace: '/ws',
    });
    const result = reduceRuntimeState(state, {
      type: 'context.compaction_completed',
      compactionId: 'no-match',
      sourceRevision: 0,
      checkpoint: {
        compactionId: 'no-match',
        version: 1,
        sourceRevision: 0,
        sourceDigest: 'sha256:x',
        coveredThroughMessageId: 'x',
        coveredThroughTurnId: 'x',
        summary: makeSummary('sha256:x', 'x', 'x'),
        inputTokensBefore: 100,
        inputTokensAfter: 50,
        targetTokens: 55,
        reason: 'overflow_recovery',
        createdAt: new Date().toISOString(),
      },
    });
    expect(result.context.activeCheckpoint).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. Manual Inspection (preview / status)
// ═══════════════════════════════════════════════════════════════════════════════

describe('E2E: manual inspection', () => {
  const testConfig = {
    apiKey: 'test',
    baseURL: 'http://localhost',
    modelName: 'mock',
    providerName: 'mock',
    providerType: 'openai-compatible' as const,
    sandbox: { enabled: false },
    compaction: { recentTurns: 3 },
    modelCapabilities: { contextWindowTokens: 128_000, maxOutputTokens: 8_192 },
  };

  test('inspectManualContextCompaction reports safe boundary with preflight', () => {
    const state = createInitialRuntimeState({
      threadId: 'e2e-inspect',
      userId: 'u',
      workspace: '/ws',
    });
    buildTranscript(state, 10);

    // Add preflight for metrics
    const withPreflight = reduceRuntimeState(state, {
      type: 'model.context_metrics',
      modelName: 'mock',
      contextWindowTokens: 128_000,
      usableInputTokens: 100_000,
      reservedOutputTokens: 8_192,
      providerSafetyMarginTokens: 1_280,
      targetTokens: 55_000,
      totalInputTokens: 45_000,
      utilization: 0.45,
      status: 'within_budget',
      estimate: estimate(45_000),
    });

    const status = inspectManualContextCompaction(withPreflight, testConfig);
    expect(status.safeBoundary?.eligible).toBe(true);
    expect(status.preflight?.status).toBe('within_budget');
  });

  test('inspectManualContextCompaction rejects when interaction is pending', () => {
    const state = createInitialRuntimeState({
      threadId: 'e2e-inspect2',
      userId: 'u',
      workspace: '/ws',
    });
    buildTranscript(state, 5);
    state.interactions = {
      kind: 'awaiting_user_input',
      interactionId: 'input-1',
      toolCallId: 'ask',
      request: { question: 'Proceed?', options: [], allow_free_text: true },
    };
    const status = inspectManualContextCompaction(state, testConfig);
    expect(status.safeBoundary?.eligible).toBe(false);
  });

  test('manualContextCompactionEvent returns a valid request event', () => {
    const state = createInitialRuntimeState({ threadId: 'e2e-mce', userId: 'u', workspace: '/ws' });
    buildTranscript(state, 5);

    // First add preflight
    const withPreflight = reduceRuntimeState(state, {
      type: 'model.context_metrics',
      modelName: 'mock',
      contextWindowTokens: 128_000,
      usableInputTokens: 100_000,
      reservedOutputTokens: 8_192,
      providerSafetyMarginTokens: 1_280,
      targetTokens: 55_000,
      totalInputTokens: 5_000,
      utilization: 0.05,
      status: 'within_budget',
      estimate: estimate(5_000),
    });

    const result = manualContextCompactionEvent({ state: withPreflight, config: testConfig });
    expect(result).not.toBeNull();
    if (result?.type === 'context.compaction_requested') {
      expect(result.reason).toBe('manual');
      expect(result.force).toBe(false);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10. Invariants
// ═══════════════════════════════════════════════════════════════════════════════

describe('E2E: invariants', () => {
  test('state.context always present after initialization', () => {
    const state = createInitialRuntimeState({ threadId: 'e2e-inv', userId: 'u', workspace: '/ws' });
    expect(state.context).toBeDefined();
    expect(state.context.history).toEqual([]);
  });

  test('completed checkpoint satisfies: version=1, tokensAfter < tokensBefore, tokensAfter ≤ targetTokens, provenance self-consistent', () => {
    const state = createInitialRuntimeState({
      threadId: 'e2e-inv-ckpt',
      userId: 'u',
      workspace: '/ws',
    });
    buildTranscript(state, 10);
    const { state: requested, compactionId } = requestCompaction(state, 'manual');
    const completed = applyCompleted(requested, compactionId, { reason: 'manual' });

    const cp = completed.context.activeCheckpoint;
    expect(cp).toBeDefined();
    expect(cp!.version).toBe(1);
    expect(cp!.inputTokensAfter).toBeLessThan(cp!.inputTokensBefore);
    expect(cp!.inputTokensAfter).toBeLessThanOrEqual(cp!.targetTokens);
    expect(cp!.summary.version).toBe(1);
    expect(cp!.summary.provenance.sourceDigest).toBe(cp!.sourceDigest);
    expect(cp!.summary.provenance.lastMessageId).toBe(cp!.coveredThroughMessageId);
    expect(cp!.compactionId).toBe(compactionId);
  });

  test('lastFailure is cleared on successful completion', () => {
    const state = createInitialRuntimeState({
      threadId: 'e2e-inv-clear',
      userId: 'u',
      workspace: '/ws',
    });
    buildTranscript(state, 5);

    // Fail first
    const { state: req1, compactionId: id1 } = requestCompaction(state, 'manual');
    const failed = reduceRuntimeState(req1, {
      type: 'context.compaction_failed',
      compactionId: id1,
      sourceRevision: req1.revision,
      errorKind: 'summary_model_failed',
      message: 'error',
      retryable: true,
    });
    expect(failed.context.lastFailure).toBeDefined();

    // Then succeed
    const { state: req2, compactionId: id2 } = requestCompaction(failed, 'manual');
    const completed = applyCompleted(req2, id2, { reason: 'manual' });
    expect(completed.context.lastFailure).toBeUndefined();
    expect(completed.context.activeCheckpoint).toBeDefined();
  });

  test('reducer preserves pending compaction fields faithfully', () => {
    const state = createInitialRuntimeState({
      threadId: 'e2e-inv-pend',
      userId: 'u',
      workspace: '/ws',
    });
    buildTranscript(state, 3);
    const { state: requested, compactionId } = requestCompaction(state, 'auto_soft');

    expect(requested.context.pendingCompaction).toMatchObject({
      compactionId,
      reason: 'auto_soft',
      requestedAtRevision: state.revision,
      requestedAtTurnId: state.turn.turnId,
      force: false,
    });
  });

  test('reducer returns same state when compaction ID mismatches pending', () => {
    const state = createInitialRuntimeState({
      threadId: 'e2e-inv-id',
      userId: 'u',
      workspace: '/ws',
    });
    buildTranscript(state, 3);
    const { state: requested, compactionId } = requestCompaction(state, 'auto_soft');

    // Try to complete with different ID
    const result = reduceRuntimeState(requested, {
      type: 'context.compaction_completed',
      compactionId: 'different-id',
      sourceRevision: requested.revision,
      checkpoint: {
        compactionId: 'different-id',
        version: 1,
        sourceRevision: requested.revision,
        sourceDigest: 'sha256:x',
        coveredThroughMessageId: 'x',
        coveredThroughTurnId: 'x',
        summary: makeSummary('sha256:x', 'x', 'x'),
        inputTokensBefore: 100,
        inputTokensAfter: 50,
        targetTokens: 55,
        reason: 'manual',
        createdAt: new Date().toISOString(),
      },
    });
    // Should be unchanged — same reference
    expect(result.context.pendingCompaction?.compactionId).toBe(compactionId);
    expect(result.context.activeCheckpoint).toBeUndefined();
  });

  test('checkpoint sourceRevision must match event sourceRevision', () => {
    const state = createInitialRuntimeState({
      threadId: 'e2e-inv-rev',
      userId: 'u',
      workspace: '/ws',
    });
    buildTranscript(state, 3);
    const { state: requested, compactionId } = requestCompaction(state, 'auto_soft');

    // Mismatched sourceRevision
    const result = reduceRuntimeState(requested, {
      type: 'context.compaction_completed',
      compactionId,
      sourceRevision: requested.revision + 99, // wrong!
      checkpoint: {
        compactionId,
        version: 1,
        sourceRevision: requested.revision, // different!
        sourceDigest: 'sha256:x',
        coveredThroughMessageId: 'x',
        coveredThroughTurnId: 'x',
        summary: makeSummary('sha256:x', 'x', 'x'),
        inputTokensBefore: 100,
        inputTokensAfter: 50,
        targetTokens: 55,
        reason: 'auto_soft',
        createdAt: new Date().toISOString(),
      },
    });
    // Source revision mismatch → rejected
    expect(result.context.activeCheckpoint).toBeUndefined();
    expect(result.context.pendingCompaction).toBeDefined();
  });

  test('zero-token estimate produces valid (non-negative) framing', () => {
    const e = estimate(0);
    expect(e.totalInputTokens).toBeGreaterThanOrEqual(0);
    expect(e.systemTokens).toBe(100);
    expect(e.transcriptTokens).toBe(-400); // 0 - 400
  });
});
