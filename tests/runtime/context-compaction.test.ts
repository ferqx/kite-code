import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { executeContextCompaction } from '../../src/core/controllers/compaction-controller';
import { expectedCompactionSourceDigest } from '../../src/core/model/compaction-summary';
import type { ContextTokenEstimate } from '../../src/core/model/context-budget';
import {
  buildContextProjection,
  type ContextProjectionEnvironment,
  digestProjectionEnvironment,
  serializeToolDescriptors,
} from '../../src/core/model/context-projection';
import type { ContextCompactionCheckpoint } from '../../src/core/runtime/context-compaction';
import {
  createContextCorrectnessBlock,
  normalizeContextRuntimeState,
} from '../../src/core/runtime/context-compaction';
import type { ContextCompactionRequestedEvent, RuntimeEvent } from '../../src/core/runtime/events';
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
  return `Retain this fact (${sourceDigest}, ${firstMessageId}, ${lastMessageId}).`;
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
      turnId: 'turn-historical',
      ordinal: 0,
      createdAt: '2026-07-20T00:00:00.000Z',
      content: 'retain this fact '.repeat(1_200),
    },
    {
      kind: 'user',
      messageId: 'message-2',
      turnId: initial.turn.turnId,
      ordinal: 1,
      createdAt: '2026-07-20T00:00:01.000Z',
      content: 'current live work',
    },
  ];
  return reduceRuntimeState(initial, {
    type: 'context.compaction_requested',
    compactionId: 'compact-1',
    reason: 'auto',
    requestedAtRevision: initial.revision,
    requestedAtTurnId: initial.turn.turnId,
    force: false,
    estimate,
  });
}

function validCheckpoint(
  state: ReturnType<typeof requestedState>,
  reason: ContextCompactionCheckpoint['reason'],
  sourceRevision: number,
  summaryText = 'A compact narrative.',
): ContextCompactionCheckpoint {
  const before = buildContextProjection({ role: 'agent', state }).estimate.totalInputTokens;
  const checkpoint: ContextCompactionCheckpoint = {
    compactionId: 'compact-1',
    version: 1,
    sourceRevision,
    sourceDigest: expectedCompactionSourceDigest(undefined, [state.transcript.messages[0]!]),
    coveredThroughMessageId: 'message-1',
    coveredThroughTurnId: 'turn-historical',
    summary: summaryText,
    inputTokensBefore: before,
    inputTokensAfter: 0,
    reason,
    createdAt: '2026-07-20T00:00:01.000Z',
  };
  return {
    ...checkpoint,
    inputTokensAfter: buildContextProjection({
      role: 'agent',
      state,
      candidateCheckpoint: checkpoint,
    }).estimate.totalInputTokens,
  };
}

describe('eventized context compaction', () => {
  test('persists a pending request and schedules it after higher-priority work', () => {
    const state = requestedState();
    expect(state.context.pendingCompaction).toMatchObject({
      compactionId: 'compact-1',
      reason: 'auto',
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
    const progress: Array<string | undefined> = [];
    const events = await executeContextCompaction({
      state,
      compactionId: 'compact-1',
      onProgress: (phase) => progress.push(phase),
      compact: async ({ sourceRevision, pending }) =>
        validCheckpoint(state, pending.reason, sourceRevision, summary('sha256:source')),
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('context.compaction_completed');
    expect(events[0]).toHaveProperty('durationMs');
    expect(progress).toEqual(['preparing', 'summarizing', 'validating', undefined]);
    expect((events[0] as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(0);

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

  test.each([
    'manual',
    'auto',
  ] as const)('%s success emits all three ephemeral phases and clears the spinner', async (reason) => {
    const state = requestedState();
    state.context.pendingCompaction!.reason = reason;
    const progress: Array<string | undefined> = [];
    const events = await executeContextCompaction({
      state,
      compactionId: 'compact-1',
      onProgress: (phase) => progress.push(phase),
      compact: async ({ sourceRevision, pending }) =>
        validCheckpoint(state, pending.reason, sourceRevision),
    });
    expect(events[0]?.type).toBe('context.compaction_completed');
    expect(progress).toEqual(['preparing', 'summarizing', 'validating', undefined]);
  });

  test('environment-stale model results terminate the durable request without a checkpoint', async () => {
    const state = requestedState();
    let generation = 0;
    const progress: Array<string | undefined> = [];
    const events = await executeContextCompaction({
      state,
      compactionId: 'compact-1',
      resolveProjectionEnvironment: () => ({
        serializedTools: [],
        activeSkillInstructions: `generation-${generation++}`,
        workflowSkills: [],
      }),
      onProgress: (phase) => progress.push(phase),
      compact: async ({ sourceRevision, pending }) => {
        return {
          compactionId: pending.compactionId,
          version: 1,
          sourceRevision,
          sourceDigest: 'sha256:source',
          coveredThroughMessageId: 'message-1',
          coveredThroughTurnId: state.turn.turnId,
          summary: summary('sha256:source'),
          inputTokensBefore: 2_000,
          inputTokensAfter: 500,
          reason: pending.reason,
          createdAt: '2026-07-20T00:00:01.000Z',
        };
      },
    });
    expect(events).toEqual([
      expect.objectContaining({
        type: 'context.compaction_failed',
        errorKind: 'stale_context',
        retryable: true,
      }),
    ]);
    const failedState = reduceRuntimeState(state, events[0]!);
    expect(failedState.context.pendingCompaction).toBeUndefined();
    expect(failedState.context.activeCheckpoint).toBeUndefined();
    expect(progress).toEqual(['preparing', 'summarizing', 'validating', undefined]);
  });

  test.each([
    'manual',
    'auto',
  ] as const)('%s failures clear ephemeral progress without persisting it', async (reason) => {
    const state = requestedState();
    state.context.pendingCompaction!.reason = reason;
    const progress: Array<string | undefined> = [];
    const events = await executeContextCompaction({
      state,
      compactionId: 'compact-1',
      onProgress: (phase) => progress.push(phase),
      compact: async () => {
        throw new Error('provider failed');
      },
    });
    expect(events).toHaveLength(1);
    expect(progress).toEqual(['preparing', 'summarizing', undefined]);
    expect(JSON.stringify(events)).not.toContain('preparing');
  });

  test('records typed failures and rejects stale compaction results through the kernel lease', () => {
    const state = requestedState();
    const failed = reduceRuntimeState(state, {
      type: 'context.compaction_failed',
      compactionId: 'compact-1',
      sourceRevision: state.revision,
      errorKind: 'invalid_candidate',
      message: 'bad summary',
      retryable: false,
    });
    expect(failed.context.pendingCompaction).toBeUndefined();
    expect(failed.context.lastFailure?.errorKind).toBe('invalid_candidate');

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
          errorKind: 'invalid_candidate',
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
          reason: pending.reason,
          createdAt: '2026-07-20T00:00:01.000Z',
        }),
      }),
    ).toMatchObject([{ type: 'context.compaction_failed', errorKind: 'unsafe_boundary' }]);
  });

  test('rejects a checkpoint with fabricated token savings', async () => {
    const state = requestedState();
    const checkpoint = validCheckpoint(state, 'auto', state.revision);
    const events = await executeContextCompaction({
      state,
      compactionId: 'compact-1',
      compact: async () => ({
        ...checkpoint,
        inputTokensBefore: checkpoint.inputTokensBefore + 10_000,
        inputTokensAfter: checkpoint.inputTokensAfter,
      }),
    });

    expect(events).toMatchObject([
      { type: 'context.compaction_failed', errorKind: 'invalid_candidate', retryable: false },
    ]);
  });
});

// ── PR 1: Durable event JSON safety ──

describe('PR 1 — durable event JSON safety', () => {
  test('every durable context event survives an exact JSON roundtrip', () => {
    const checkpoint = {
      compactionId: 'compact-roundtrip',
      version: 1 as const,
      sourceRevision: 4,
      sourceDigest: 'sha256:roundtrip',
      coveredThroughMessageId: 'message-1',
      coveredThroughTurnId: 'turn-1',
      summary: '# Restored narrative',
      inputTokensBefore: 4_000,
      inputTokensAfter: 1_000,
      reason: 'manual' as const,
      createdAt: '2026-07-22T00:00:00.000Z',
    };
    const events: RuntimeEvent[] = [
      {
        type: 'context.compaction_requested',
        compactionId: checkpoint.compactionId,
        reason: 'manual',
        requestedAtRevision: 4,
        requestedAtTurnId: 'turn-1',
        force: false,
        estimate: requestedState().context.pendingCompaction!.estimate,
      },
      {
        type: 'context.compaction_completed',
        compactionId: checkpoint.compactionId,
        sourceRevision: 4,
        checkpoint,
        durationMs: 25,
      },
      {
        type: 'context.compaction_failed',
        compactionId: 'compact-failed',
        sourceRevision: 5,
        errorKind: 'summary_model_failed',
        message: 'provider unavailable',
        retryable: true,
        durationMs: 10,
      },
      { type: 'context.compaction_reset', checkpointId: checkpoint.compactionId, reason: 'manual' },
      {
        type: 'context.hard_blocked',
        reason: 'unrecoverable_checkpoint',
        sourceDigest: checkpoint.sourceDigest,
        message: 'invalid checkpoint',
        createdAtTurnId: 'turn-1',
      },
      {
        type: 'context.hard_block_cleared',
        reason: 'unrecoverable_checkpoint',
        sourceDigest: checkpoint.sourceDigest,
      },
    ];

    expect(JSON.parse(JSON.stringify(events))).toEqual(events);
  });

  test('context runtime state and narrative checkpoint survive JSON roundtrip', () => {
    const state = requestedState();
    const checkpoint = {
      compactionId: 'compact-1',
      version: 1 as const,
      sourceRevision: state.revision,
      sourceDigest: 'sha256:source',
      coveredThroughMessageId: 'message-1',
      coveredThroughTurnId: state.turn.turnId,
      summary: '# Decisions\n\nContinue the rollout.',
      inputTokensBefore: 4_000,
      inputTokensAfter: 1_500,
      reason: 'manual' as const,
      createdAt: '2026-07-22T00:00:00.000Z',
    };
    const completed = reduceRuntimeState(state, {
      type: 'context.compaction_completed',
      compactionId: checkpoint.compactionId,
      sourceRevision: state.revision,
      checkpoint,
    });
    const restored = JSON.parse(JSON.stringify(completed)) as typeof completed;
    expect(restored.context).toEqual(completed.context);
    expect(restored.transcript).toEqual(completed.transcript);
  });

  test('corrupted persisted narrative checkpoint fails closed', () => {
    const state = requestedState();
    state.context.activeCheckpoint = {
      compactionId: 'corrupt',
      version: 1,
      sourceRevision: state.revision,
      sourceDigest: 'sha256:corrupt',
      coveredThroughMessageId: 'message-1',
      coveredThroughTurnId: state.turn.turnId,
      summary: '   ',
      inputTokensBefore: 1_000,
      inputTokensAfter: 2_000,
      reason: 'manual',
      createdAt: '2026-07-22T00:00:00.000Z',
    };

    const normalized = normalizeContextRuntimeState(state.context);
    expect(normalized.activeCheckpoint).toBeUndefined();
    expect(normalized.hardBlock).toMatchObject({
      reason: 'unrecoverable_checkpoint',
      sourceDigest: 'sha256:corrupt',
    });
  });

  test('ContextCompactionRequestedEvent survives JSON roundtrip', () => {
    const event: ContextCompactionRequestedEvent = {
      type: 'context.compaction_requested',
      compactionId: 'compact-1',
      reason: 'auto',
      requestedAtRevision: 5,
      requestedAtTurnId: 'turn-1',
      force: false,
      estimate: {
        systemTokens: 100,
        toolSchemaTokens: 50,
        transcriptTokens: 500,
        summaryTokens: 0,
        dynamicRuntimeTokens: 30,
        framingTokens: 10,
        totalInputTokens: 690,
      },
    };

    expect(() => JSON.stringify(event)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(event)) as ContextCompactionRequestedEvent;
    expect(parsed.type).toBe('context.compaction_requested');
    expect(parsed.compactionId).toBe('compact-1');
    expect(parsed.reason).toBe('auto');
    // tools must not exist on the event
    expect('tools' in parsed).toBe(false);
  });

  test('Runtime correctness hard-block reason survives JSON roundtrip', () => {
    const event: RuntimeEvent = {
      type: 'context.hard_blocked',
      reason: 'unrecoverable_checkpoint',
      sourceDigest: 'sha256:checkpoint',
      message: 'checkpoint cannot be recovered',
      createdAtTurnId: 'turn-1',
    };
    const parsed = JSON.parse(JSON.stringify(event)) as RuntimeEvent;
    expect(parsed).toEqual(event);
  });

  test('restored development state drops reasons and blocks outside the current schema', () => {
    const state = requestedState();
    const legacyContext = {
      ...state.context,
      pendingCompaction: {
        ...state.context.pendingCompaction!,
        reason: 'legacy-capacity-reason',
        force: true,
      },
      hardBlock: {
        reason: 'hard_limit',
        sourceDigest: 'legacy',
        message: 'capacity estimate',
        createdAtTurnId: state.turn.turnId,
      },
    } as unknown as typeof state.context;

    const normalized = normalizeContextRuntimeState(legacyContext);
    expect(normalized.pendingCompaction).toBeUndefined();
    expect(normalized.hardBlock).toBeUndefined();
  });

  test('PendingContextCompaction has no tools field', () => {
    const state = requestedState();
    const pending = state.context.pendingCompaction;
    expect(pending).toBeDefined();
    // tools must NOT exist in pending state
    expect((pending as unknown as Record<string, unknown>).tools).toBeUndefined();
    // JSON roundtrip must succeed
    expect(() => JSON.stringify(pending)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(pending));
    expect(parsed.tools).toBeUndefined();
  });

  test('serializeToolDescriptors strips functions and runtime objects', () => {
    const tools = {
      read_file: {
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
        execute: () => 'result',
        someClosure: () => 42,
        zodInstance: { _def: 'zod-object' },
      },
      shell_execute: {
        description: 'Run a shell command',
        parameters: { type: 'object', properties: { cmd: { type: 'string' } } },
        execute: async () => ({ stdout: 'ok' }),
      },
    };

    const descriptors = serializeToolDescriptors(tools as unknown as Record<string, unknown>);
    expect(descriptors).toHaveLength(2);

    for (const d of descriptors) {
      // Must be pure data — no functions
      expect(JSON.stringify(d)).not.toContain('"execute"');
      expect(typeof d.schemaDigest).toBe('string');
      expect(d.schemaDigest.length).toBe(64); // SHA-256 hex
      expect(typeof d.name).toBe('string');
      expect(typeof d.inputSchema).toBe('object');
    }

    // Descriptors survive JSON roundtrip
    const roundtripped = JSON.parse(JSON.stringify(descriptors));
    expect(roundtripped).toHaveLength(2);
    expect(roundtripped[0].name).toBeDefined();
    expect(roundtripped[0].schemaDigest).toBeDefined();
  });

  test('serializeToolDescriptors skips tools without input schema', () => {
    const tools = {
      no_schema: { description: 'no schema here', execute: () => {} },
      has_schema: {
        description: 'has schema',
        parameters: { type: 'object' },
        execute: () => {},
      },
    };

    const descriptors = serializeToolDescriptors(tools as unknown as Record<string, unknown>);
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]!.name).toBe('has_schema');
  });

  test('digestProjectionEnvironment is deterministic', () => {
    const makeEnv = (): ContextProjectionEnvironment => ({
      serializedTools: [
        {
          name: 'read_file',
          description: 'Read a file',
          inputSchema: { type: 'object' },
          schemaDigest: createHash('sha256')
            .update(
              JSON.stringify({
                name: 'read_file',
                description: 'Read a file',
                inputSchema: { type: 'object' },
              }),
            )
            .digest('hex'),
        },
      ],
      workflowSkills: [{ capabilityId: 'skill-1', description: 'Test skill' }],
    });

    const env1 = makeEnv();
    const env2 = makeEnv();
    expect(digestProjectionEnvironment(env1)).toBe(digestProjectionEnvironment(env2));
    expect(digestProjectionEnvironment(env1)).toHaveLength(64);
  });

  test('digestProjectionEnvironment changes when tools differ', () => {
    const env1: ContextProjectionEnvironment = {
      serializedTools: [
        {
          name: 'tool-a',
          schemaDigest: 'aaa',
          inputSchema: {},
        },
      ],
      workflowSkills: [],
    };
    const env2: ContextProjectionEnvironment = {
      serializedTools: [
        {
          name: 'tool-b',
          schemaDigest: 'bbb',
          inputSchema: {},
        },
      ],
      workflowSkills: [],
    };

    expect(digestProjectionEnvironment(env1)).not.toBe(digestProjectionEnvironment(env2));
  });
});

// ── PR 6: Hard block + thrash state machine ──

describe('PR 6 — hard block and thrash breaker', () => {
  test('correctness block factory requires auditable invariant evidence', () => {
    expect(() =>
      createContextCorrectnessBlock({
        reason: 'runtime_invariant_violation',
        sourceDigest: '',
        message: 'broken',
        createdAtTurnId: 'turn-1',
      }),
    ).toThrow();
  });

  test('recovery clears only the matching correctness block', () => {
    const blocked = reduceRuntimeState(requestedState(), {
      type: 'context.hard_blocked',
      reason: 'unsafe_context_projection',
      sourceDigest: 'projection-v1',
      message: 'pairing failed',
      createdAtTurnId: 'turn-1',
    });
    const mismatch = reduceRuntimeState(blocked, {
      type: 'context.hard_block_cleared',
      reason: 'unsafe_context_projection',
      sourceDigest: 'projection-v2',
    });
    expect(mismatch.context.hardBlock).toBeDefined();
    const recovered = reduceRuntimeState(mismatch, {
      type: 'context.hard_block_cleared',
      reason: 'unsafe_context_projection',
      sourceDigest: 'projection-v1',
    });
    expect(recovered.context.hardBlock).toBeUndefined();
  });
  test('auto low gain does NOT create hard block', () => {
    const state = requestedState();
    const failed = reduceRuntimeState(state, {
      type: 'context.compaction_failed',
      compactionId: 'compact-1',
      sourceRevision: state.revision,
      errorKind: 'insufficient_reduction',
      message: 'low gain',
      retryable: false,
    });
    expect(failed.context.hardBlock).toBeUndefined();
    expect(failed.context.autoGuard.consecutiveLowGain).toBe(1);
    expect(failed.context.autoGuard.disabledUntilManualAction).toBe(false); // 1 < 2
  });

  test('repeated auto low gain still does not create a hard block', () => {
    const state = requestedState();
    const first = reduceRuntimeState(state, {
      type: 'context.compaction_failed',
      compactionId: 'compact-1',
      sourceRevision: state.revision,
      errorKind: 'insufficient_reduction',
      message: 'low gain',
      retryable: false,
    });
    first.context.pendingCompaction = {
      ...state.context.pendingCompaction!,
      compactionId: 'compact-2',
    };
    const second = reduceRuntimeState(first, {
      type: 'context.compaction_failed',
      compactionId: 'compact-2',
      sourceRevision: first.revision,
      errorKind: 'insufficient_reduction',
      message: 'low gain again',
      retryable: false,
    });
    expect(second.context.hardBlock).toBeUndefined();
    expect(second.context.autoGuard.disabledUntilManualAction).toBe(true);
  });

  test('manual failure does NOT create hard block', () => {
    const state = requestedState();
    const manualState = {
      ...state,
      context: {
        ...state.context,
        pendingCompaction: { ...state.context.pendingCompaction!, reason: 'manual' as const },
      },
    };
    const failed = reduceRuntimeState(manualState, {
      type: 'context.compaction_failed',
      compactionId: 'compact-1',
      sourceRevision: manualState.revision,
      errorKind: 'insufficient_reduction',
      message: 'not enough',
      retryable: false,
    });
    expect(failed.context.hardBlock).toBeUndefined();
    expect(failed.context.autoGuard.consecutiveLowGain).toBe(0);
  });

  test('hard block persists across unrelated events', () => {
    let current = reduceRuntimeState(requestedState(), {
      type: 'context.hard_blocked',
      reason: 'runtime_invariant_violation',
      sourceDigest: 'source',
      message: 'invariant failed',
      createdAtTurnId: 'turn-1',
    });
    expect(current.context.hardBlock).toBeDefined();
    // Unrelated event should not clear the block
    current = reduceRuntimeState(current, {
      type: 'user.message_appended',
      messageId: 'unrelated',
      content: 'hello',
    });
    expect(current.context.hardBlock).toBeDefined();
  });

  test('correctness hard block rejects both manual and auto compaction', () => {
    const state = requestedState();
    state.context.hardBlock = {
      reason: 'unsafe_context_projection',
      sourceDigest: 'source',
      message: 'projection is unsafe',
      createdAtTurnId: state.turn.turnId,
    };
    state.context.pendingCompaction = {
      ...state.context.pendingCompaction!,
      compactionId: 'recover',
      reason: 'manual',
    };
    expect(decideNextEffect(state).type).toBe('recovery_blocked');
    state.context.pendingCompaction.reason = 'auto';
    expect(decideNextEffect(state).type).toBe('recovery_blocked');
  });

  test('thrash breaker disables proactive auto after 2 consecutive low-gain', () => {
    const state = requestedState();
    // First low gain
    const current = reduceRuntimeState(state, {
      type: 'context.compaction_failed',
      compactionId: 'compact-1',
      sourceRevision: state.revision,
      errorKind: 'insufficient_reduction',
      message: 'low gain 1',
      retryable: false,
    });
    expect(current.context.autoGuard.consecutiveLowGain).toBe(1);
    expect(current.context.autoGuard.disabledUntilManualAction).toBe(false);
    // Second low gain
    current.context.pendingCompaction = {
      compactionId: 'compact-2',
      reason: 'auto',
      requestedAtRevision: current.revision,
      requestedAtTurnId: current.turn.turnId,
      force: false,
      estimate: state.context.pendingCompaction!.estimate,
    };
    const second = reduceRuntimeState(current, {
      type: 'context.compaction_failed',
      compactionId: 'compact-2',
      sourceRevision: state.revision + 1,
      errorKind: 'insufficient_reduction',
      message: 'low gain 2',
      retryable: false,
    });
    expect(second.context.autoGuard.consecutiveLowGain).toBe(2);
    expect(second.context.autoGuard.disabledUntilManualAction).toBe(true);
  });

  test('successful manual compaction clears the automatic thrash breaker', () => {
    const state = requestedState();
    state.context.pendingCompaction = {
      ...state.context.pendingCompaction!,
      reason: 'manual',
    };
    state.context.autoGuard = {
      recentAutomaticCompactions: [{ turnIndex: 1, reductionRatio: 0.05, tokensAfter: 9_000 }],
      consecutiveLowGain: 2,
      disabledUntilManualAction: true,
      recoveryAttempted: true,
    };
    const checkpoint = {
      compactionId: 'compact-1',
      version: 1 as const,
      sourceRevision: state.revision,
      sourceDigest: 'sha256:source',
      coveredThroughMessageId: 'message-1',
      coveredThroughTurnId: state.turn.turnId,
      summary: summary('sha256:source'),
      inputTokensBefore: 4_000,
      inputTokensAfter: 2_000,
      reason: 'manual' as const,
      createdAt: '2026-07-20T00:00:01.000Z',
    };
    const completed = reduceRuntimeState(state, {
      type: 'context.compaction_completed',
      compactionId: 'compact-1',
      sourceRevision: state.revision,
      checkpoint,
    });
    expect(completed.context.autoGuard).toEqual({
      recentAutomaticCompactions: [],
      consecutiveLowGain: 0,
      disabledUntilManualAction: false,
      recoveryAttempted: false,
    });
  });

  test('context.hard_blocked event sets durable hard block', () => {
    const state = requestedState();
    const result = reduceRuntimeState(state, {
      type: 'context.hard_blocked',
      reason: 'corrupted_event_tail',
      sourceDigest: 'abc',
      message: 'event tail is corrupted',
      createdAtTurnId: state.turn.turnId,
    });
    expect(result.context.hardBlock?.reason).toBe('corrupted_event_tail');
    expect(result.context.hardBlock?.sourceDigest).toBe('abc');
  });
});
