import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aiMessage } from '@/core/messages';
import {
  CONTEXT_RECLAIM_LIVE_POLICY_V2,
  type PreparedContextRequestReadyV2,
  prepareContextRequestV2,
} from '@/core/model/context-preparation-v2';
import type { ContextProjectionEnvironment } from '@/core/model/context-projection';
import {
  assertContextPrimarySuccessBatchV2,
  createContextPrimarySuccessBranchV2,
  digestContextReclaimCommitV1,
  proposeContextReclaimCommitV1,
  validateRestoredContextReclaimStateV1,
} from '@/core/model/context-reclaim-commit';
import type { ResolvedModelCapabilities } from '@/core/model/model-capabilities';
import { runRuntimeAgent } from '@/core/runtime/agent';
import type { RuntimeEvent } from '@/core/runtime/events';
import { AgentKernel } from '@/core/runtime/kernel';
import { reduceRuntimeState } from '@/core/runtime/reducer';
import {
  type BudgetReservationV1,
  createZeroResourceUsageV1,
  LIMITED_RESOURCE_BUDGET_V1,
} from '@/core/runtime/resource-budget';
import { createInitialRuntimeState, type RuntimeState } from '@/core/runtime/state';
import { createRuntimeStore } from '@/core/runtime/store';
import { projectedModelContentDigest } from '@/core/tools/registry/projection';
import type { ToolResultBudgetReceiptV2 } from '@/core/tools/result-budget-v2';
import { createMockModel } from '../mock-model';

function receipt(content: string): ToolResultBudgetReceiptV2 {
  return {
    version: 2,
    projectionMode: 'budget_v2',
    policyId: 'read-file-lines:v2',
    toolIdentity: 'builtin:read_file',
    bindingDigest: 'b'.repeat(64),
    projectorId: 'read-line-window:v1',
    projectorRevision: 'line-window-projector:v2',
    validatorId: 'line-window-validator:v2',
    rawResultDigest: 'a'.repeat(64),
    modelContentDigest: projectedModelContentDigest(content),
    modelContentUtf8Bytes: Buffer.byteLength(content, 'utf8'),
  };
}

function preparedFixture(): {
  state: RuntimeState;
  prepared: PreparedContextRequestReadyV2;
  environment: ContextProjectionEnvironment;
  capabilities: ResolvedModelCapabilities;
} {
  const state = createInitialRuntimeState({
    threadId: 'context-reclaim-commit',
    userId: 'u',
    workspace: '/workspace',
  });
  for (let index = 0; index < 2; index++) {
    const toolCallId = `read-${index}`;
    const messageId = `assistant-${index}`;
    const toolMessageId = `tool-${index}`;
    const turnId = `old-${index}`;
    const path = `src/${index}.ts`;
    const content = `1|${'historical bounded content '.repeat(800)}`;
    const resultMeta = {
      path,
      rawResultDigest: 'a'.repeat(64),
      modelContentDigest: projectedModelContentDigest(content),
      digestScope: 'raw' as const,
      toolResultReceipt: receipt(content),
    };
    state.transcript.messages.push(
      {
        kind: 'assistant',
        messageId,
        turnId,
        content: '',
        toolCalls: [{ id: toolCallId, name: 'read_file', args: { path, limit: 10 } }],
      },
      {
        kind: 'tool',
        messageId: toolMessageId,
        turnId,
        toolCallId,
        name: 'read_file',
        content,
        ok: true,
        resultMeta,
      },
    );
    state.tools.calls[toolCallId] = {
      toolCallId,
      modelMessageId: messageId,
      name: 'read_file',
      args: { path, limit: 10 },
      status: 'succeeded',
      createdAtTurnId: turnId,
      effectClass: 'read_only',
      sideEffect: false,
      result: { ok: true, summary: 'read', resultMeta },
    };
  }
  const environment: ContextProjectionEnvironment = {
    serializedTools: [],
    workflowSkills: [],
  };
  const capabilities: ResolvedModelCapabilities = {
    providerName: 'fixture',
    modelName: 'fixture',
    contextWindowTokens: 8_000,
    contextWindowSource: 'explicit_config',
    maxOutputTokens: 512,
    maxOutputTokensSource: 'explicit_config',
    streaming: true,
  };
  const prepared = prepareContextRequestV2({
    purpose: 'normal',
    state,
    environment,
    capabilities,
    requestedMaxOutputTokens: 256,
    promptAffectingParameters: { temperature: 0 },
    toolResultBudgetPolicyId: 'tool-result-budget-registry:v2',
    reclaimPolicyId: CONTEXT_RECLAIM_LIVE_POLICY_V2.policyId,
    reclaimMode: 'live',
  });
  if (!('proposedReclaimPlan' in prepared) || !prepared.proposedReclaimPlan)
    throw new Error('expected proposed reclaim plan');
  return { state, prepared, environment, capabilities };
}

function withReservation(state: RuntimeState): RuntimeState {
  let next = reduceRuntimeState(state, {
    type: 'resource_budget.configured',
    runId: 'run-1',
    startedAt: '2026-08-10T00:00:00.000Z',
    deadlineAt: '2026-08-10T00:30:00.000Z',
    budget: LIMITED_RESOURCE_BUDGET_V1,
  });
  const upperBound = createZeroResourceUsageV1('versioned_upper_bound', 'context-v2');
  upperBound.counters.modelRequests = 1;
  upperBound.counters.inputTokens = 10_000;
  upperBound.counters.outputTokens = 256;
  const reservation: BudgetReservationV1 = {
    version: 1,
    reservationId: 'reservation-1',
    runId: 'run-1',
    invocationId: 'model:fixture',
    resourceKind: 'model',
    executableUpperBound: upperBound,
    state: 'reserved',
  };
  next = reduceRuntimeState(next, {
    type: 'resource_budget.reserved',
    reservation,
  });
  return reduceRuntimeState(next, {
    type: 'resource_budget.dispatch_started',
    reservationId: reservation.reservationId,
  });
}

function branch(input: { withCommit: boolean }) {
  const fixture = preparedFixture();
  const proposed = proposeContextReclaimCommitV1({
    ...fixture,
    plan: fixture.prepared.proposedReclaimPlan!,
  });
  const actual = createZeroResourceUsageV1();
  actual.counters.modelRequests = 1;
  const events = createContextPrimarySuccessBranchV2({
    prepared: fixture.prepared,
    requestId: 'request-1',
    effectLeaseId: 'lease-1',
    reservationId: 'reservation-1',
    admittedRequestDigest: 'd'.repeat(64),
    response: {
      type: 'model.responded',
      messageId: 'response-1',
      text: 'done',
    },
    reconciliation: {
      type: 'resource_budget.reconciled',
      reservationId: 'reservation-1',
      actual,
    },
    terminalBatchId: 'batch-1',
    ...(input.withCommit ? { proposedCommit: proposed } : {}),
  });
  return { ...fixture, proposed, events };
}

describe('ContextReclaimCommitV1', () => {
  test('persists only the closed two-event no-advance branch', () => {
    const { state, events } = branch({ withCommit: false });
    expect(events).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain('historical bounded content');
    expect(() => assertContextPrimarySuccessBatchV2(events, state)).not.toThrow();
  });

  test('atomically advances a verified three-event branch and clears pending evidence', () => {
    const { state, proposed, events } = branch({ withCommit: true });
    const initialState = withReservation(state);
    const kernel = new AgentKernel({
      store: createRuntimeStore(':memory:'),
      initialState,
      interactionMode: 'accept_edits',
    });
    kernel.processEventBatch(events);
    expect(kernel.getState().context.reclaimCommit).toEqual(proposed);
    expect(kernel.getState().context.pendingPrimaryReclaim).toBeUndefined();
    expect(digestContextReclaimCommitV1(proposed)).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(proposed)).not.toContain('src/');
    expect(Buffer.byteLength(JSON.stringify(events), 'utf8')).toBeLessThan(16 * 1_024);
  });

  test('rejects missing, reordered, mismatched and standalone advance branches', () => {
    const { state, events } = branch({ withCommit: true });
    expect(() => assertContextPrimarySuccessBatchV2(events.slice(0, 2), state)).toThrow();
    expect(() =>
      assertContextPrimarySuccessBatchV2([events[1]!, events[0]!, events[2]!], state),
    ).toThrow();
    const mismatch = structuredClone(events);
    const response = mismatch[0];
    if (response?.type !== 'model.responded' || !response.contextEvidence)
      throw new Error('expected response evidence');
    response.contextEvidence = {
      ...response.contextEvidence,
      admittedRequestDigest: 'e'.repeat(64),
    };
    expect(() => assertContextPrimarySuccessBatchV2(mismatch, state)).toThrow();
    expect(() => assertContextPrimarySuccessBatchV2([events[1]!], state)).toThrow();
  });

  test('cache epoch ignores revision/time but changes with cache-affecting environment', () => {
    const first = branch({ withCommit: true }).proposed;
    const fixture = preparedFixture();
    fixture.state.revision += 9;
    fixture.state.turn.turnIndex += 1;
    const same = proposeContextReclaimCommitV1({
      ...fixture,
      plan: fixture.prepared.proposedReclaimPlan!,
    });
    expect(same.cacheEpochId).toBe(first.cacheEpochId);

    const changedPrepared: PreparedContextRequestReadyV2 = {
      ...fixture.prepared,
      sourceIdentity: {
        ...fixture.prepared.sourceIdentity,
        cacheAffectingEnvironmentDigest: 'f'.repeat(64),
      },
    };
    const changed = proposeContextReclaimCommitV1({
      state: fixture.state,
      prepared: changedPrepared,
      plan: changedPrepared.proposedReclaimPlan!,
    });
    expect(changed.cacheEpochId).not.toBe(first.cacheEpochId);
  });

  test('replays an accepted commit below trigger without proposing it again', () => {
    const fixture = preparedFixture();
    const commit = proposeContextReclaimCommitV1({
      ...fixture,
      plan: fixture.prepared.proposedReclaimPlan!,
    });
    fixture.state.context.reclaimCommit = commit;
    const prepared = prepareContextRequestV2({
      purpose: 'normal',
      state: fixture.state,
      environment: fixture.environment,
      capabilities: {
        ...fixture.capabilities,
        contextWindowTokens: 1_000_000,
      },
      requestedMaxOutputTokens: 256,
      promptAffectingParameters: { temperature: 0 },
      toolResultBudgetPolicyId: 'tool-result-budget-registry:v2',
      reclaimPolicyId: CONTEXT_RECLAIM_LIVE_POLICY_V2.policyId,
      reclaimMode: 'live',
    });
    if (!('effectiveProjection' in prepared)) throw new Error('expected prepared context');
    expect(prepared.rawProjection.preflight.status).toBe('normal');
    expect(prepared.reclaimApplication.kind).toBe('applied_commit');
    expect(prepared.proposedReclaimPlan).toBeUndefined();
    expect(prepared.effectiveProjection.providerMessages).not.toEqual(
      prepared.rawProjection.providerMessages,
    );
  });

  test('accepts a complete restored receipt and rejects snapshot tampering', () => {
    const fixture = branch({ withCommit: true });
    const advance = fixture.events[1];
    if (advance?.type !== 'context.reclaim_commit_advanced')
      throw new Error('expected advance event');
    const restored = structuredClone(fixture.state);
    restored.context.reclaimCommit = advance.commit;
    restored.context.lastReclaimReceipt = advance.receipt;
    expect(() => validateRestoredContextReclaimStateV1(restored)).not.toThrow();
    restored.context.lastReclaimReceipt = {
      ...advance.receipt,
      admittedRequestDigest: 'f'.repeat(64),
    };
    expect(() => validateRestoredContextReclaimStateV1(restored)).toThrow(
      'lacks its exact applied receipt',
    );
  });

  test('L3 checkpoint replacement and reset explicitly invalidate an L2 commit', () => {
    const fixture = branch({ withCommit: true });
    const advance = fixture.events[1];
    if (advance?.type !== 'context.reclaim_commit_advanced')
      throw new Error('expected advance event');
    const committed = structuredClone(fixture.state);
    committed.context.reclaimCommit = advance.commit;
    committed.context.lastReclaimReceipt = advance.receipt;
    const requested = reduceRuntimeState(committed, {
      type: 'context.compaction_requested',
      compactionId: 'l3-replaces-l2',
      reason: 'manual',
      requestedAtRevision: committed.revision,
      requestedAtTurnId: committed.turn.turnId,
      force: false,
      estimate: fixture.prepared.rawProjection.estimate,
    });
    const checkpoint = {
      compactionId: 'l3-replaces-l2',
      version: 1 as const,
      sourceRevision: committed.revision,
      sourceDigest: 'checkpoint-source',
      coveredThroughMessageId: 'tool-1',
      coveredThroughTurnId: 'old-1',
      summary: 'bounded checkpoint',
      inputTokensBefore: 4_000,
      inputTokensAfter: 1_000,
      reason: 'manual' as const,
      createdAt: '2026-08-10T00:00:00.000Z',
    };
    const completed = reduceRuntimeState(requested, {
      type: 'context.compaction_completed',
      compactionId: checkpoint.compactionId,
      sourceRevision: checkpoint.sourceRevision,
      checkpoint,
      durationMs: 1,
    });
    expect(completed.context.reclaimCommit).toBeUndefined();
    expect(completed.context.lastReclaimReceipt).toBeUndefined();

    const resetSource = structuredClone(completed);
    resetSource.context.reclaimCommit = advance.commit;
    resetSource.context.lastReclaimReceipt = advance.receipt;
    const reset = reduceRuntimeState(resetSource, {
      type: 'context.compaction_reset',
      checkpointId: checkpoint.compactionId,
      reason: 'manual',
    });
    expect(reset.context.activeCheckpoint).toBeUndefined();
    expect(reset.context.reclaimCommit).toBeUndefined();
    expect(reset.context.lastReclaimReceipt).toBeUndefined();
  });

  test('production runner persists the exact two-event off branch', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'openpx-primary-branch-'));
    const storePath = join(directory, 'runtime.db');
    try {
      const model = createMockModel([{ message: aiMessage({ content: 'prepared answer' }) }]);
      const observed: RuntimeEvent[] = [];
      for await (const event of runRuntimeAgent(
        {
          task: 'answer once',
          threadId: 'primary-branch-production',
          userId: 'u',
          workspace: directory,
          runtimeStorePath: storePath,
          model,
          config: {
            apiKey: 'unused',
            baseURL: 'https://example.invalid',
            modelName: 'fixture',
            providerName: 'fixture',
            providerType: 'openai-compatible',
            features: { resourceBudgetV1: true },
            sandbox: { enabled: false },
          },
        },
        {
          requestAction: async () => ({
            type: 'cancel',
            interactionId: 'unused',
          }),
        },
      )) {
        observed.push(event);
      }
      const responseIndex = observed.findIndex((event) => event.type === 'model.responded');
      const response = observed[responseIndex];
      const reconciliation = observed[responseIndex + 1];
      expect(response?.type).toBe('model.responded');
      expect(
        response?.type === 'model.responded'
          ? response.contextEvidence?.reclaimReceiptDigest
          : undefined,
      ).toBe('none');
      expect(reconciliation).toMatchObject({
        type: 'resource_budget.reconciled',
        terminalBatchId:
          response?.type === 'model.responded'
            ? response.contextEvidence?.terminalBatchId
            : undefined,
      });
      expect(model.callCount.count).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('production runner atomically materializes a valid tool queue from its primary response', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'openpx-owned-tool-queue-'));
    const storePath = join(directory, 'runtime.db');
    writeFileSync(join(directory, 'note.txt'), 'bounded fixture\n', 'utf8');
    try {
      const model = createMockModel([
        {
          message: aiMessage({
            content: '',
            tool_calls: [
              {
                id: 'read-owned',
                name: 'read_file',
                args: { path: 'note.txt' },
              },
            ],
          }),
        },
        { message: aiMessage({ content: 'read complete' }) },
      ]);
      const observed: RuntimeEvent[] = [];
      for await (const event of runRuntimeAgent(
        {
          task: 'read the note',
          threadId: 'owned-tool-queue-production',
          userId: 'u',
          workspace: directory,
          runtimeStorePath: storePath,
          model,
          config: {
            apiKey: 'unused',
            baseURL: 'https://example.invalid',
            modelName: 'fixture',
            providerName: 'fixture',
            providerType: 'openai-compatible',
            features: {
              resourceBudgetV1: true,
              toolResultBudgetV2: true,
            },
            sandbox: { enabled: false },
          },
        },
        {
          requestAction: async () => ({
            type: 'cancel',
            interactionId: 'unused',
          }),
        },
      )) {
        observed.push(event);
      }

      const firstResponse = observed.find(
        (event) =>
          event.type === 'model.responded' &&
          event.toolCalls?.some((call) => call.id === 'read-owned'),
      );
      expect(firstResponse).toMatchObject({
        type: 'model.responded',
        ownedToolQueue: [{ toolCallId: 'read-owned', name: 'read_file' }],
      });
      expect(
        observed.some((event) => event.type === 'tool.queued' && event.toolCallId === 'read-owned'),
      ).toBe(false);
      expect(
        observed.some(
          (event) => event.type === 'tool.finished' && event.toolCallId === 'read-owned',
        ),
      ).toBe(true);
      expect(model.callCount.count).toBe(2);

      const store = createRuntimeStore(storePath);
      const restored = store.loadSnapshot<RuntimeState>('owned-tool-queue-production');
      store.close();
      expect(restored?.tools.calls['read-owned']?.status).toBe('succeeded');
      expect(
        restored?.transcript.messages.some(
          (message) => message.kind === 'tool' && message.toolCallId === 'read-owned',
        ),
      ).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
