import { describe, expect, test } from 'bun:test';
import {
  type ContextCompactor,
  executeContextCompaction,
} from '../../src/core/controllers/compaction-controller';
import type { ContextTokenEstimate } from '../../src/core/model/context-budget';
import { createVerifiedContextCheckpointV3 } from '../../src/core/model/context-checkpoint-v3';
import {
  buildContextProjection,
  type ContextProjectionEnvironment,
  digestProjectionEnvironment,
} from '../../src/core/model/context-projection';
import { selectCheckpointWorkingSetV1 } from '../../src/core/model/context-working-set';
import {
  buildSummarySourceIdentityForCurrentPrefixV1,
  createSummaryRequestedEventV1,
} from '../../src/core/model/progressive-context-orchestrator';
import type { ContextCompactionCheckpoint } from '../../src/core/runtime/context-compaction';
import {
  createRuntimeEffectExecutor,
  prepareRuntimeEffectV2,
} from '../../src/core/runtime/executor';
import { AgentKernel } from '../../src/core/runtime/kernel';
import { reduceRuntimeState } from '../../src/core/runtime/reducer';
import { LIMITED_RESOURCE_BUDGET_V1 } from '../../src/core/runtime/resource-budget';
import { runRuntimeLoop } from '../../src/core/runtime/runner';
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
    ...Array.from({ length: 8 }, (_, index) => ({
      kind: 'user' as const,
      messageId: `message-${index + 1}`,
      turnId: `historical-turn-${index + 1}`,
      ordinal: index,
      createdAt: `2026-07-22T00:00:0${index}.000Z`,
      content: `Continue context compaction ${index}. `.repeat(180),
    })),
    {
      kind: 'user',
      messageId: 'message-current',
      turnId: state.turn.turnId,
      ordinal: 8,
      createdAt: '2026-07-22T00:00:09.000Z',
      content: 'Current work must remain live.',
    },
  ];
  const requested = reduceRuntimeState(state, {
    type: 'context.compaction_requested',
    compactionId: 'compact-1',
    reason,
    requestedAtRevision: state.revision,
    requestedAtTurnId: state.turn.turnId,
    force: false,
    estimate,
  });
  requested.revision = 1;
  requested.lastAppliedEventId = 'e'.repeat(64);
  requested.appliedEventIds = ['e'.repeat(64)];
  return requested;
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
  const build = (after: number) =>
    createVerifiedContextCheckpointV3({
      state,
      checkpointId: 'compact-1:v3',
      compactionId: 'compact-1',
      reason,
      coveredThroughMessageId: 'message-8',
      summary,
      inputTokensBefore: before,
      inputTokensAfter: after,
      routeIdentityDigest: digestProjectionEnvironment(
        environment ?? { serializedTools: [], workflowSkills: [] },
      ),
      sourceProducingEventCutV1: { revision: sourceRevision, eventId: 'e'.repeat(64) },
      createdAt: '2026-07-22T00:00:01.000Z',
    });
  const candidate = build(Math.max(0, before - 1));
  return {
    ...candidate,
    inputTokensAfter: buildContextProjection({
      ...projectionInput,
      candidateCheckpoint: candidate,
    }).estimate.totalInputTokens,
  };
}

function checkpointForSummaryInput(
  input: Parameters<ContextCompactor>[0],
  summary = '# Summary\n\nHistorical context.',
): ContextCompactionCheckpoint {
  const projectionInput = {
    role: 'agent' as const,
    state: input.state,
    projectionEnvironment: input.projectionEnvironment,
    serializedTools: input.projectionEnvironment?.serializedTools,
    activeSkillInstructions: input.projectionEnvironment?.activeSkillInstructions,
    workflowSkills: input.projectionEnvironment?.workflowSkills,
  };
  const before = buildContextProjection(projectionInput).estimate.totalInputTokens;
  const build = (after: number) =>
    createVerifiedContextCheckpointV3({
      state: input.state,
      checkpointId: `${input.pending.compactionId}:v3`,
      compactionId: input.pending.compactionId,
      reason: input.pending.reason,
      coveredThroughMessageId: 'message-8',
      summary,
      inputTokensBefore: before,
      inputTokensAfter: after,
      routeIdentityDigest: digestProjectionEnvironment(
        input.projectionEnvironment ?? { serializedTools: [], workflowSkills: [] },
      ),
      sourceProducingEventCutV1: {
        revision: input.pending.sourceProducingEventCutV1?.revision ?? input.sourceRevision,
        eventId:
          input.pending.sourceProducingEventCutV1?.eventId ?? input.state.lastAppliedEventId!,
      },
      createdAt: '2026-07-22T00:00:10.000Z',
    });
  const candidate = build(before - 1);
  return build(
    buildContextProjection({ ...projectionInput, candidateCheckpoint: candidate }).estimate
      .totalInputTokens,
  );
}

describe('narrative compaction e2e', () => {
  test('new manual lifecycle atomically starts, reconciles, and activates one V3 checkpoint', async () => {
    const base = requested();
    base.context.pendingCompaction = undefined;
    base.revision = 0;
    base.lastAppliedEventId = undefined;
    base.appliedEventIds = [];
    const store = createRuntimeStore(':memory:');
    const kernel = new AgentKernel({
      store,
      initialState: base,
      interactionMode: 'accept_edits',
    });
    const budgetStartedAt = new Date();
    kernel.processEvent({
      type: 'resource_budget.configured',
      runId: 'summary-run',
      startedAt: budgetStartedAt.toISOString(),
      deadlineAt: new Date(
        budgetStartedAt.getTime() + LIMITED_RESOURCE_BUDGET_V1.maxRunDurationMs,
      ).toISOString(),
      budget: LIMITED_RESOURCE_BUDGET_V1,
    });
    const sourceIdentity = buildSummarySourceIdentityForCurrentPrefixV1(kernel.getState());
    if (!sourceIdentity) throw new Error('summary source expected');
    kernel.processEvent(
      createSummaryRequestedEventV1({
        state: kernel.getState(),
        reason: 'manual',
        sourceIdentity,
        estimate,
        attemptId: 'summary-attempt',
        compactionId: 'summary-compaction',
      }),
    );
    let compactorCalls = 0;
    const contextCompactor: ContextCompactor = async (input) => {
      compactorCalls += 1;
      expect(input.dispatchEntryGuard?.tryEnter()).toBe(true);
      const started = kernel.getState().context.summaryLifecycle;
      if (started.kind !== 'started') throw new Error('started summary expected');
      const forgedTerminalKey = {
        terminalBatchId: 'forged-terminal',
        causationId: started.startBatchKey.startBatchId,
        attemptId: started.attempt.attemptId,
        compactionId: started.attempt.compactionId,
        summarySourceIdentity: started.attempt.summarySourceIdentity,
        requestedAtRevision: started.attempt.requestedAtRevision,
        requestedAtTurnId: started.attempt.requestedAtTurnId,
        sourceProducingEventCutV1: started.attempt.sourceProducingEventCutV1,
        dispatchStart: started.startBatchKey.dispatchStart,
        admission: {
          stage: 'not_completed' as const,
          proof: {
            kind: 'prepared_dispatch_not_entered_v1' as const,
            guardNonce: 'forged',
            producerGeneration: kernel.getProducerGeneration(),
            summaryStartBatchId: started.startBatchKey.startBatchId,
          },
        },
      };
      expect(() =>
        kernel.processEventBatch([
          {
            type: 'context.summary_failed_v1',
            attemptId: started.attempt.attemptId,
            terminalBatchKey: forgedTerminalKey,
            errorKind: 'stale_context',
            message: 'forged',
            providerDispatchState: 'not_entered',
          },
          {
            type: 'resource_budget.released',
            reservationId: started.startBatchKey.dispatchStart.resourceReservationId,
            proof: 'prepared_dispatch_not_entered_v1',
            summaryDispatchGuardProof: forgedTerminalKey.admission.proof,
            summaryTerminalBatchKey: forgedTerminalKey,
          },
        ]),
      ).toThrow('callback-entry guard state');
      const projectionInput = {
        role: 'agent' as const,
        state: input.state,
        projectionEnvironment: input.projectionEnvironment,
        serializedTools: input.projectionEnvironment?.serializedTools,
        activeSkillInstructions: input.projectionEnvironment?.activeSkillInstructions,
        workflowSkills: input.projectionEnvironment?.workflowSkills,
      };
      const before = buildContextProjection(projectionInput).estimate.totalInputTokens;
      const build = (after: number) =>
        createVerifiedContextCheckpointV3({
          state: input.state,
          checkpointId: 'summary-compaction:v3',
          compactionId: input.pending.compactionId,
          reason: input.pending.reason,
          coveredThroughMessageId: 'message-8',
          summary: '# Summary\n\nHistorical context.',
          inputTokensBefore: before,
          inputTokensAfter: after,
          routeIdentityDigest: digestProjectionEnvironment(
            input.projectionEnvironment ?? { serializedTools: [], workflowSkills: [] },
          ),
          sourceProducingEventCutV1: {
            revision: input.pending.sourceProducingEventCutV1?.revision ?? input.sourceRevision,
            eventId:
              input.pending.sourceProducingEventCutV1?.eventId ?? input.state.lastAppliedEventId!,
          },
          createdAt: '2026-07-22T00:00:10.000Z',
        });
      const candidate = build(before - 1);
      return {
        checkpoint: build(
          buildContextProjection({ ...projectionInput, candidateCheckpoint: candidate }).estimate
            .totalInputTokens,
        ),
        providerUsage: { inputTokens: 1_200, outputTokens: 80 },
      };
    };
    const dependencies = {
      config: {
        providerName: 'test',
        providerType: 'openai-compatible' as const,
        apiKey: 'test',
        baseURL: 'http://localhost:1',
        modelName: 'test',
        sandbox: { enabled: true },
        features: { resourceBudgetV1: true },
      },
      model: createMockModel([]),
      runtimeStore: store,
      contextCompactor,
    };
    const events = [];
    for await (const event of runRuntimeLoop(
      kernel,
      createRuntimeEffectExecutor(dependencies),
      {
        requestAction: async () => {
          throw new Error('unexpected action');
        },
      },
      10,
      (effect, state) => prepareRuntimeEffectV2(effect, state as never, dependencies),
    )) {
      events.push(event);
      if (event.type === 'resource_budget.reconciled') break;
    }
    expect(events.map((event) => event.type)).toContain('context.summary_dispatch_started_v1');
    expect(events.map((event) => event.type)).toContain('resource_budget.reconciled');
    expect(kernel.getState().context.activeCheckpoint?.version).toBe(3);
    expect(kernel.getState().context.summaryLifecycle.kind).toBe('idle');
    expect(compactorCalls).toBe(1);
    const noNewSource = buildSummarySourceIdentityForCurrentPrefixV1(kernel.getState());
    if (!noNewSource) throw new Error('no-new-source identity expected');
    const revisionBeforeNoop = kernel.getState().revision;
    kernel.processEvent(
      createSummaryRequestedEventV1({
        state: kernel.getState(),
        reason: 'manual',
        sourceIdentity: noNewSource,
        estimate,
        attemptId: 'summary-attempt-noop',
        compactionId: 'summary-compaction-noop',
      }),
    );
    expect(kernel.getState().revision).toBe(revisionBeforeNoop + 1);
    expect(kernel.getState().context.summaryLifecycle.kind).toBe('idle');
    expect(kernel.loadEvents(base.session.threadId).at(-1)?.event.type).toBe(
      'context.summary_requested_v1',
    );
    kernel.close();
  });

  test('stale Summary success settles typed failure and resource outcome without stranding started', async () => {
    const base = requested();
    base.context.pendingCompaction = undefined;
    base.revision = 0;
    base.lastAppliedEventId = undefined;
    base.appliedEventIds = [];
    const store = createRuntimeStore(':memory:');
    const kernel = new AgentKernel({ store, initialState: base, interactionMode: 'accept_edits' });
    const startedAt = new Date();
    kernel.processEvent({
      type: 'resource_budget.configured',
      runId: 'stale-summary-run',
      startedAt: startedAt.toISOString(),
      deadlineAt: new Date(
        startedAt.getTime() + LIMITED_RESOURCE_BUDGET_V1.maxRunDurationMs,
      ).toISOString(),
      budget: LIMITED_RESOURCE_BUDGET_V1,
    });
    const sourceIdentity = buildSummarySourceIdentityForCurrentPrefixV1(kernel.getState());
    if (!sourceIdentity) throw new Error('summary source expected');
    kernel.processEvent(
      createSummaryRequestedEventV1({
        state: kernel.getState(),
        reason: 'manual',
        sourceIdentity,
        estimate,
        attemptId: 'stale-summary-attempt',
        compactionId: 'stale-summary-compaction',
      }),
    );
    const contextCompactor: ContextCompactor = async (input) => {
      expect(input.dispatchEntryGuard?.tryEnter()).toBe(true);
      kernel.processEvent({
        type: 'user.command_invoked',
        commandId: 'concurrent-control',
        command: '/status',
      });
      return {
        checkpoint: checkpointForSummaryInput(input),
        providerUsage: { inputTokens: 1_000, outputTokens: 64 },
      };
    };
    const dependencies = {
      config: {
        providerName: 'test',
        providerType: 'openai-compatible' as const,
        apiKey: 'test',
        baseURL: 'http://localhost:1',
        modelName: 'test',
        sandbox: { enabled: true },
        features: { resourceBudgetV1: true },
      },
      model: createMockModel([]),
      runtimeStore: store,
      contextCompactor,
    };
    const emitted = [];
    for await (const event of runRuntimeLoop(
      kernel,
      createRuntimeEffectExecutor(dependencies),
      {
        requestAction: async () => {
          throw new Error('unexpected action');
        },
      },
      4,
      (effect, state) => prepareRuntimeEffectV2(effect, state as never, dependencies),
    )) {
      emitted.push(event);
      if (event.type === 'resource_budget.reconciled') break;
    }
    expect(emitted.map((event) => event.type)).toContain('context.summary_failed_v1');
    expect(emitted.map((event) => event.type)).not.toContain('context.summary_completed_v1');
    expect(kernel.getState().context.summaryLifecycle.kind).toBe('idle');
    expect(kernel.getState().context.activeCheckpoint).toBeUndefined();
    const reservations = Object.values(
      kernel.getState().resourceBudget.status === 'active'
        ? kernel.getState().resourceBudget.reservations
        : {},
    );
    expect(reservations.some((entry) => entry.state === 'reconciled')).toBe(true);
    kernel.close();
  });

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
    if (events[0]?.type === 'context.compaction_failed') {
      const candidate = checkpointFor(
        state,
        'manual',
        state.revision,
        '# Historical work\n\nContinue context compaction.',
      );
      expect(selectCheckpointWorkingSetV1({ state, checkpoint: candidate })).toMatchObject({
        status: 'available',
      });
    }
    expect(events).toHaveLength(1);
    const completed = reduceRuntimeState(state, events[0]!);
    expect(completed.context.activeCheckpoint?.summary).toStartWith('# Historical work');
    expect(completed.transcript.messages).toEqual(state.transcript.messages);
  });

  test('manual compaction enforces reduction acceptance', async () => {
    const state = requested('manual');
    const events = await executeContextCompaction({
      state,
      compactionId: 'compact-1',
      compact: async ({ sourceRevision, pending }) =>
        checkpointFor(
          state,
          pending.reason,
          sourceRevision,
          state.transcript.messages
            .slice(0, 8)
            .map((message) => String(message.content).trim())
            .join('\n'),
        ),
    });
    expect(events[0]).toMatchObject({
      type: 'context.compaction_failed',
      errorKind: 'insufficient_reduction',
    });
  });

  test('legacy automatic requests are inert and never create a compaction effect', async () => {
    const state = requested('auto');
    expect(state.context.pendingCompaction).toBeUndefined();
    expect(decideNextEffect(state)).toEqual({ type: 'call_model' });
    expect(
      await executeContextCompaction({
        state,
        compactionId: 'compact-1',
        compact: async () => {
          throw new Error('must not dispatch');
        },
      }),
    ).toEqual([]);

    const malformed = requested('manual');
    malformed.context.pendingCompaction!.reason = 'auto';
    expect(decideNextEffect(malformed)).toEqual({ type: 'stop' });
    expect(
      await executeContextCompaction({
        state: malformed,
        compactionId: 'compact-1',
        compact: async () => {
          throw new Error('must not dispatch malformed pending state');
        },
      }),
    ).toEqual([]);
  });

  test('revision-stale results are rejected by the Kernel lease', () => {
    const state = requested();
    const kernel = new AgentKernel({
      store: createRuntimeStore(':memory:'),
      initialState: {
        ...state,
        revision: 0,
        lastAppliedEventId: undefined,
        appliedEventIds: [],
        context: { ...state.context, pendingCompaction: undefined },
      },
      interactionMode: 'accept_edits',
    });
    kernel.processEvent({
      type: 'context.compaction_requested',
      ...state.context.pendingCompaction!,
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
