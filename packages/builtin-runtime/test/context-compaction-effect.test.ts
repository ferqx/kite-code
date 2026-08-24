import { describe, expect, test } from 'bun:test';
import {
  type BuiltinContextCompactionTerminal,
  type BuiltinContextCompactor,
  buildContextProjection,
  ContextCompactionValidationError,
  executeBuiltinContextCompaction,
  expectedCompactionSourceDigest,
  findSafeCompactionBoundary,
} from '@kite/builtin-runtime/model';
import type {
  BuiltinContextCheckpointView,
  BuiltinRuntimeStateView,
} from '../src/model/runtime-view';

function stateWithPending(
  overrides: Partial<{
    pending: BuiltinRuntimeStateView['context']['pendingCompaction'];
    interactions: string;
  }> = {},
): BuiltinRuntimeStateView {
  return {
    activeTaskId: null,
    tasks: {},
    revision: 7,
    session: { workspace: '/workspace' },
    turn: { turnId: 'turn-5', turnIndex: 5, status: 'completed' },
    transcript: {
      messages: Array.from({ length: 6 }, (_, index) => ({
        kind: 'user' as const,
        messageId: `message-${index}`,
        turnId: `turn-${index}`,
        ordinal: index,
        createdAt: `2026-08-21T00:00:0${index}.000Z`,
        content: `historical context ${'preserve this settled fact '.repeat(500)}`,
      })),
    },
    context: {
      pendingCompaction: overrides.pending ?? {
        compactionId: 'compact-1',
        reason: 'manual',
        requestedAtRevision: 7,
        requestedAtTurnId: 'turn-5',
        force: false,
        estimate: {
          systemTokens: 100,
          toolSchemaTokens: 0,
          transcriptTokens: 20_000,
          summaryTokens: 0,
          dynamicRuntimeTokens: 100,
          framingTokens: 100,
          totalInputTokens: 20_300,
        },
      },
      autoGuard: {
        recentAutomaticCompactions: [],
        consecutiveLowGain: 0,
        disabledUntilManualAction: false,
        recoveryAttempted: false,
      },
    },
    interactions: { kind: overrides.interactions ?? 'idle' },
    tools: { calls: {} },
    authorization: { mode: 'default' },
    mode: 'accept_edits',
  };
}

function validCheckpoint(
  state: BuiltinRuntimeStateView,
  summary = 'A compacted narrative.',
): BuiltinContextCheckpointView {
  const boundary = findSafeCompactionBoundary(state);
  if (!boundary.lastMessageId || !boundary.coveredThroughTurnId) {
    throw new Error('fixture must provide a safe compaction boundary');
  }
  const candidate: BuiltinContextCheckpointView = {
    compactionId: 'compact-1',
    version: 1,
    sourceRevision: state.revision,
    sourceDigest: expectedCompactionSourceDigest(undefined, boundary.coveredMessages),
    coveredThroughMessageId: boundary.lastMessageId,
    coveredThroughTurnId: boundary.coveredThroughTurnId,
    summary,
    inputTokensBefore: 0,
    inputTokensAfter: 0,
    reason: 'manual',
    createdAt: '2026-08-21T00:00:00.000Z',
  };
  const projectionInput = { role: 'agent' as const, state };
  return {
    ...candidate,
    inputTokensBefore: buildContextProjection(projectionInput).estimate.totalInputTokens,
    inputTokensAfter: buildContextProjection({
      ...projectionInput,
      candidateCheckpoint: candidate,
    }).estimate.totalInputTokens,
  };
}

function fixedNow() {
  return () => 1_000;
}

function terminal(
  events: ReadonlyArray<BuiltinContextCompactionTerminal>,
): BuiltinContextCompactionTerminal {
  const value = events[0];
  if (!value) throw new Error('expected terminal event');
  return value;
}

describe('executeBuiltinContextCompaction', () => {
  test('emits a JSON-safe completed terminal DTO with deterministic timing', async () => {
    const state = stateWithPending();
    const progress: Array<string | undefined> = [];
    const reports: string[] = [];
    const checkpoint = validCheckpoint(state);
    const compact: BuiltinContextCompactor = async () => checkpoint;

    const events = await executeBuiltinContextCompaction({
      state,
      compactionId: 'compact-1',
      compact,
      onProgress: (phase) => progress.push(phase),
      reporter: {
        recordRequested: () => {},
        recordCompleted: () => reports.push('completed'),
        recordFailed: () => reports.push('failed'),
      },
      now: fixedNow(),
    });

    expect(terminal(events)).toMatchObject({
      type: 'context.compaction_completed',
      compactionId: 'compact-1',
      sourceRevision: 7,
      checkpoint,
      durationMs: 0,
    });
    expect(progress).toEqual(['preparing', 'summarizing', 'validating', undefined]);
    expect(reports).toEqual(['completed']);
    expect(JSON.parse(JSON.stringify(events))).toEqual(events);
  });

  test('classifies missing compactor, provider denial, and validation failures', async () => {
    const state = stateWithPending();
    const missing = await executeBuiltinContextCompaction({
      state,
      compactionId: 'compact-1',
      now: fixedNow(),
    });
    expect(terminal(missing)).toMatchObject({
      type: 'context.compaction_failed',
      errorKind: 'summary_model_failed',
      retryable: false,
      message: 'No context compactor is configured.',
      durationMs: 0,
    });

    const validation = await executeBuiltinContextCompaction({
      state,
      compactionId: 'compact-1',
      compact: async () => {
        throw new ContextCompactionValidationError('unsafe_boundary', 'unsafe fixture boundary');
      },
      now: fixedNow(),
    });
    expect(terminal(validation)).toMatchObject({
      type: 'context.compaction_failed',
      errorKind: 'unsafe_boundary',
      retryable: false,
      message: 'unsafe fixture boundary',
    });
  });

  test('returns no terminal DTO for a stale request and preserves retryability rules', async () => {
    const state = stateWithPending();
    expect(
      await executeBuiltinContextCompaction({
        state,
        compactionId: 'different-compaction',
        compact: async () => validCheckpoint(state),
        now: fixedNow(),
      }),
    ).toEqual([]);

    const autoState = stateWithPending({
      pending: {
        ...state.context.pendingCompaction!,
        reason: 'auto',
      },
    });
    const lowGain = await executeBuiltinContextCompaction({
      state: autoState,
      compactionId: 'compact-1',
      compact: async () => {
        throw new ContextCompactionValidationError('insufficient_reduction', 'low gain');
      },
      now: fixedNow(),
    });
    expect(terminal(lowGain)).toMatchObject({
      errorKind: 'insufficient_reduction',
      retryable: true,
    });
  });

  test('keeps stale, candidate, envelope, token, low-gain, and generic failures typed', async () => {
    const state = stateWithPending();
    const valid = validCheckpoint(state);
    const environment = { serializedTools: [], workflowSkills: [] };

    let resolverCalls = 0;
    const stale = await executeBuiltinContextCompaction({
      state,
      compactionId: 'compact-1',
      compact: async () => valid,
      resolveProjectionEnvironment: () => {
        resolverCalls += 1;
        return resolverCalls === 1
          ? environment
          : { ...environment, activeSkillInstructions: 'changed' };
      },
      now: fixedNow(),
    });
    expect(terminal(stale)).toMatchObject({ errorKind: 'stale_context', retryable: true });

    const identity = await executeBuiltinContextCompaction({
      state,
      compactionId: 'compact-1',
      compact: async () => ({ ...valid, compactionId: 'different' }),
      now: fixedNow(),
    });
    expect(terminal(identity)).toMatchObject({ errorKind: 'invalid_candidate', retryable: false });

    const boundary = await executeBuiltinContextCompaction({
      state,
      compactionId: 'compact-1',
      compact: async () => ({ ...valid, coveredThroughMessageId: 'missing-message' }),
      now: fixedNow(),
    });
    expect(terminal(boundary)).toMatchObject({ errorKind: 'unsafe_boundary', retryable: false });

    const envelope = await executeBuiltinContextCompaction({
      state,
      compactionId: 'compact-1',
      compact: async () => ({ ...valid, summary: '  unnormalized  ' }),
      now: fixedNow(),
    });
    expect(terminal(envelope)).toMatchObject({ errorKind: 'invalid_candidate', retryable: false });

    const tokens = await executeBuiltinContextCompaction({
      state,
      compactionId: 'compact-1',
      compact: async () => ({ ...valid, inputTokensBefore: valid.inputTokensBefore + 1 }),
      now: fixedNow(),
    });
    expect(terminal(tokens)).toMatchObject({ errorKind: 'invalid_candidate', retryable: false });

    const lowGain = await executeBuiltinContextCompaction({
      state,
      compactionId: 'compact-1',
      compact: async () => {
        const candidate = validCheckpoint(state, 'historical context '.repeat(5_600).trim());
        return candidate;
      },
      now: fixedNow(),
    });
    expect(terminal(lowGain)).toMatchObject({
      errorKind: 'insufficient_reduction',
      retryable: false,
    });

    const generic = await executeBuiltinContextCompaction({
      state,
      compactionId: 'compact-1',
      compact: async () => {
        throw new Error('summary transport failed');
      },
      now: fixedNow(),
    });
    expect(terminal(generic)).toMatchObject({
      errorKind: 'summary_model_failed',
      message: 'summary transport failed',
      retryable: true,
    });
  });
});
