import { describe, expect, test } from 'bun:test';
import {
  type BuiltinContextCompactionTerminal,
  type BuiltinContextCompactor,
  buildContextProjection,
  ContextCompactionValidationError,
  countTokens,
  createNarrativeContextCompactor,
  decideAutomaticContextCompaction,
  executeBuiltinContextCompaction,
  expectedCompactionSourceDigest,
  findSafeCompactionBoundary,
} from '@kite-ai/builtin-runtime/model';
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

test('narrative compaction restores public Task arguments without exposing private references', async () => {
  const base = stateWithPending();
  const toolCallId = 'historical-task-call';
  const privateRef = 'PRIVATE_TASK_ARTIFACT_REF_SENTINEL_42';
  const task = 'Review the completed implementation and report findings.';
  const state: BuiltinRuntimeStateView = {
    ...base,
    transcript: {
      messages: [
        {
          kind: 'user',
          messageId: 'historical-user',
          turnId: 'settled-turn',
          ordinal: 0,
          createdAt: '2026-08-21T00:00:00.000Z',
          content: `Inspect the implementation. ${'Preserve this settled historical context. '.repeat(800)}`,
        },
        {
          kind: 'assistant',
          messageId: 'historical-assistant',
          turnId: 'settled-turn',
          ordinal: 1,
          createdAt: '2026-08-21T00:00:01.000Z',
          toolCalls: [
            {
              id: toolCallId,
              name: 'task',
              args: {
                name: 'Review implementation',
                subagent_type: 'review',
                taskArtifact: { artifactId: privateRef, kind: 'subagent_task_request' },
              },
            },
          ],
        },
        {
          kind: 'tool',
          messageId: 'historical-tool-result',
          turnId: 'settled-turn',
          ordinal: 2,
          createdAt: '2026-08-21T00:00:02.000Z',
          toolCallId,
          name: 'task',
          content: 'Review completed.',
          ok: true,
        },
      ],
    },
    tools: {
      calls: {
        [toolCallId]: {
          toolCallId,
          modelMessageId: 'historical-assistant',
          args: { taskArtifact: { artifactId: privateRef } },
          status: 'succeeded',
        },
      },
    },
  };
  const requests: string[] = [];
  const compact = createNarrativeContextCompactor({
    generate: async ({ input }) => {
      requests.push(input);
      return 'Completed implementation review.';
    },
  });
  const pending = state.context.pendingCompaction!;
  await compact({
    state,
    pending,
    sourceRevision: state.revision,
    projectionEnvironment: {
      serializedTools: [],
      workflowSkills: [],
      transcriptToolCallArgs: {
        [toolCallId]: { name: 'Review implementation', subagent_type: 'review', task },
      },
    },
  });
  expect(requests).toHaveLength(1);
  expect(requests[0]).toContain(`"task":"${task}"`);
  expect(requests[0]).not.toContain('taskArtifact');
  expect(requests[0]).not.toContain(privateRef);
  await expect(compact({ state, pending, sourceRevision: state.revision })).rejects.toThrow(
    'Private task history could not be restored.',
  );
  expect(requests).toHaveLength(1);
});

test('compaction preserves long instructions and accepts a useful summary above old local limits', async () => {
  const original = stateWithPending();
  const customInstructions = 'Keep this requirement. '.repeat(300);
  const summary = 'fact '.repeat(6_500).trim();
  expect(customInstructions.length).toBeGreaterThan(4_096);
  expect(countTokens(summary)).toBeGreaterThan(6_000);
  const state: BuiltinRuntimeStateView = {
    ...original,
    context: {
      ...original.context,
      pendingCompaction: { ...original.context.pendingCompaction!, customInstructions },
    },
  };
  const requests: Array<{ input: string; maxOutputTokens?: number }> = [];
  const compact = createNarrativeContextCompactor({
    generate: async (request) => {
      requests.push(request);
      return summary;
    },
    maxSummaryTokens: 100,
    maxSummaryInputTokens: 100,
    maxNarrativeTokens: 100,
  });
  const checkpoint = await compact({
    state,
    pending: state.context.pendingCompaction!,
    sourceRevision: state.revision,
  });
  expect(checkpoint.summary).toBe(summary);
  expect(requests[0]?.input).toContain(customInstructions);
  expect(requests[0]?.maxOutputTokens).toBeUndefined();
});

test('compaction accepts a real reduction smaller than the old 1024 token threshold', async () => {
  const original = stateWithPending();
  const state: BuiltinRuntimeStateView = {
    ...original,
    transcript: {
      messages: original.transcript.messages.map((message) => ({
        ...message,
        content: 'A settled fact. '.repeat(30),
      })),
    },
  };
  const compact = createNarrativeContextCompactor({
    generate: async () => 'The settled facts were retained.',
  });
  const checkpoint = await compact({
    state,
    pending: state.context.pendingCompaction!,
    sourceRevision: state.revision,
  });
  const saved = checkpoint.inputTokensBefore - checkpoint.inputTokensAfter;
  expect(saved).toBeGreaterThan(0);
  expect(saved).toBeLessThan(1_024);
});

test('compaction uses the tighter real provider and single-request output capacity', async () => {
  const state = stateWithPending();
  let requestedMaxOutputTokens: number | undefined;
  const compact = createNarrativeContextCompactor({
    generate: async (request) => {
      requestedMaxOutputTokens = request.maxOutputTokens;
      return 'The settled facts were retained.';
    },
    modelMaxOutputTokens: 4_096,
    modelRequestMaxOutputTokens: 2_048,
  });
  await compact({
    state,
    pending: state.context.pendingCompaction!,
    sourceRevision: state.revision,
  });
  expect(requestedMaxOutputTokens).toBe(2_048);
});

test('automatic compaction can run again after prior count and cooldown limits', () => {
  const original = stateWithPending();
  const state: BuiltinRuntimeStateView = {
    ...original,
    context: {
      ...original.context,
      pendingCompaction: undefined,
      lastCompactionTurnIndex: original.turn.turnIndex,
      autoGuard: {
        recentAutomaticCompactions: Array.from({ length: 4 }, (_, index) => ({
          turnIndex: index + 1,
          reductionRatio: 0.01,
          tokensAfter: 10_000,
        })),
        consecutiveLowGain: 3,
        disabledUntilManualAction: true,
        recoveryAttempted: true,
      },
    },
  };
  expect(
    decideAutomaticContextCompaction({
      state,
      mode: 'live',
      preflight: {
        estimate: original.context.pendingCompaction!.estimate,
        providerSafetyMarginTokens: 0,
        usableInputTokens: 20_000,
        utilization: 0.99,
        status: 'compact_due',
      },
    }),
  ).toMatchObject({ action: 'request_compaction', reason: 'auto' });
});

test('automatic compaction does not retry an unchanged failed turn immediately', () => {
  const original = stateWithPending();
  const state: BuiltinRuntimeStateView = {
    ...original,
    context: {
      ...original.context,
      pendingCompaction: undefined,
      lastFailure: {
        retryable: true,
        reason: 'auto',
        requestedAtTurnId: original.turn.turnId,
        sourceDigest: expectedCompactionSourceDigest(
          original.context.activeCheckpoint?.sourceDigest,
          original.transcript.messages,
        ),
      },
    },
  };
  const preflight = {
    estimate: original.context.pendingCompaction!.estimate,
    providerSafetyMarginTokens: 0,
    usableInputTokens: 20_000,
    utilization: 0.99,
    status: 'compact_due' as const,
  };
  expect(decideAutomaticContextCompaction({ state, mode: 'live', preflight })).toEqual({
    action: 'invoke',
  });
  const newTurn = { ...state, turn: { ...state.turn, turnId: 'new-turn', turnIndex: 6 } };
  expect(decideAutomaticContextCompaction({ state: newTurn, mode: 'live', preflight })).toEqual({
    action: 'invoke',
  });
  expect(
    decideAutomaticContextCompaction({
      state: {
        ...newTurn,
        transcript: {
          messages: [
            ...newTurn.transcript.messages,
            {
              kind: 'user',
              messageId: 'new-message',
              turnId: 'new-turn',
              ordinal: newTurn.transcript.messages.length,
              createdAt: '2026-08-21T00:00:07.000Z',
              content: 'New context arrived.',
            },
          ],
        },
      },
      mode: 'live',
      preflight,
    }),
  ).toMatchObject({ action: 'request_compaction' });
});

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
    expect(terminal(lowGain)).toMatchObject({ type: 'context.compaction_completed' });

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
