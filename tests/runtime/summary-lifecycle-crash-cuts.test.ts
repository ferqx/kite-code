import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVerifiedContextCheckpointV3 } from '@/core/model/context-checkpoint-v3';
import {
  buildSummarySourceIdentityForCurrentPrefixV1,
  createSummaryRequestedEventV1,
  createSummaryStartBatchKeyV1,
  ProviderDispatchEntryGuardV1,
} from '@/core/model/progressive-context-orchestrator';
import type { RuntimeEvent } from '@/core/runtime/events';
import { AgentKernel, createAgentKernel } from '@/core/runtime/kernel';
import {
  createZeroResourceUsageV1,
  LIMITED_RESOURCE_BUDGET_V1,
} from '@/core/runtime/resource-budget';
import {
  finalizeRuntimeEffectTerminalBatchV1,
  planRuntimeBudgetAdmissionV1,
} from '@/core/runtime/resource-budget-admission';
import { createInitialRuntimeState } from '@/core/runtime/state';
import { createRuntimeStore } from '@/core/runtime/store';

const estimate = {
  systemTokens: 10,
  toolSchemaTokens: 0,
  transcriptTokens: 10_000,
  summaryTokens: 0,
  dynamicRuntimeTokens: 10,
  framingTokens: 10,
  totalInputTokens: 10_030,
};

function openStartedSummary(directory: string, threadId: string) {
  const storePath = join(directory, 'runtime.db');
  const state = createInitialRuntimeState({ threadId, userId: 'u', workspace: '/workspace' });
  state.transcript.messages = Array.from({ length: 8 }, (_, index) => ({
    kind: 'user' as const,
    messageId: `message-${index}`,
    turnId: `turn-${index}`,
    content: `settled source ${index} ${'context '.repeat(100)}`,
  }));
  const kernel = new AgentKernel({
    store: createRuntimeStore(storePath),
    initialState: state,
    interactionMode: 'accept_edits',
  });
  const startedAt = new Date();
  kernel.processEvent({
    type: 'resource_budget.configured',
    runId: `${threadId}-run`,
    startedAt: startedAt.toISOString(),
    deadlineAt: new Date(
      startedAt.getTime() + LIMITED_RESOURCE_BUDGET_V1.maxRunDurationMs,
    ).toISOString(),
    budget: LIMITED_RESOURCE_BUDGET_V1,
  });
  const sourceIdentity = buildSummarySourceIdentityForCurrentPrefixV1(kernel.getState());
  if (!sourceIdentity) throw new Error('source identity expected');
  const requested = createSummaryRequestedEventV1({
    state: kernel.getState(),
    reason: 'auto',
    sourceIdentity,
    estimate,
    attemptId: `${threadId}-attempt`,
    compactionId: `${threadId}-compaction`,
  });
  const effect = {
    type: 'compact_context' as const,
    compactionId: requested.attempt.compactionId,
    resourceEstimate: { inputTokens: estimate.totalInputTokens, maxOutputTokens: 6_000 },
    summaryRequest: requested,
  };
  const admission = planRuntimeBudgetAdmissionV1(kernel.getState(), effect);
  if (admission.status !== 'admitted') throw new Error('summary admission expected');
  const lease = kernel.beginEffect(admission.effect);
  const reservationId = admission.reservationIds[0]!;
  const startBatchKey = createSummaryStartBatchKeyV1({
    state: kernel.getState(),
    effectLeaseId: lease.effectId,
    resourceReservationId: reservationId,
    expectedMaxOutputTokens: 6_000,
    attemptOverride: requested.attempt,
  });
  const startEvents: RuntimeEvent[] = [
    requested,
    ...admission.preparationEvents,
    ...admission.dispatchEvents,
  ].map((event) =>
    event.type === 'resource_budget.reserved' || event.type === 'resource_budget.dispatch_started'
      ? { ...event, summaryStartBatchKey: startBatchKey }
      : event,
  );
  startEvents.push({
    type: 'context.summary_dispatch_started_v1',
    attemptId: requested.attempt.attemptId,
    startBatchKey,
  });
  return { storePath, kernel, requested, lease, reservationId, startBatchKey, startEvents };
}

function commitStartedSummary(input: ReturnType<typeof openStartedSummary>) {
  expect(input.kernel.applyEffectResult(input.lease, input.startEvents)).toBe(true);
  const guard = new ProviderDispatchEntryGuardV1();
  input.kernel.registerSummaryDispatchEntryGuard(input.lease, guard);
  expect(guard.tryEnter()).toBe(true);
  return guard;
}

function commitSuccessfulSummary(input: ReturnType<typeof openStartedSummary>) {
  const state = input.kernel.getState();
  const checkpoint = createVerifiedContextCheckpointV3({
    state,
    checkpointId: `${state.session.threadId}-checkpoint`,
    compactionId: input.requested.attempt.compactionId,
    reason: 'auto',
    coveredThroughMessageId: 'message-7',
    summary: '# Verified crash-cut summary',
    inputTokensBefore: 10_000,
    inputTokensAfter: 1_000,
    routeIdentityDigest: 'a'.repeat(64),
    sourceProducingEventCutV1: input.requested.attempt.sourceProducingEventCutV1,
    createdAt: new Date(1).toISOString(),
  });
  const terminalBatchKey = {
    terminalBatchId: `${state.session.threadId}-terminal`,
    causationId: input.startBatchKey.startBatchId,
    attemptId: input.requested.attempt.attemptId,
    compactionId: input.requested.attempt.compactionId,
    summarySourceIdentity: input.requested.attempt.summarySourceIdentity,
    requestedAtRevision: input.requested.attempt.requestedAtRevision,
    requestedAtTurnId: input.requested.attempt.requestedAtTurnId,
    sourceProducingEventCutV1: input.requested.attempt.sourceProducingEventCutV1,
    dispatchStart: input.startBatchKey.dispatchStart,
    admission: {
      stage: 'admitted' as const,
      evidence: {
        admittedRequestDigest: input.startBatchKey.dispatchStart.preparedSummaryRequestIdentity,
        finalPayloadDigest: input.startBatchKey.dispatchStart.expectedPayloadDigest,
        providerDataAdmissionReceiptDigest: input.startBatchKey.dispatchStart.expectedPayloadDigest,
        finalMaxOutputTokens: input.startBatchKey.dispatchStart.expectedMaxOutputTokens,
        finalToolSetSchemaDigest: input.startBatchKey.dispatchStart.expectedToolSetSchemaDigest,
      },
    },
  };
  const terminal: RuntimeEvent = {
    type: 'context.summary_completed_v1',
    attemptId: input.requested.attempt.attemptId,
    terminalBatchKey,
    checkpoint,
    providerUsage: { inputTokens: 1_000, outputTokens: 100 },
    providerDispatchState: 'entered',
  };
  if (!input.requested.continuation) throw new Error('auto continuation expected');
  const continuation: RuntimeEvent = {
    type: 'context.normal_reprepare_required_v1',
    receipt: {
      version: 1,
      generation: input.kernel.getProducerGeneration(),
      attemptId: input.requested.attempt.attemptId,
      compactionId: input.requested.attempt.compactionId,
      continuation: input.requested.continuation,
      origin: {
        kind: 'summary_terminal',
        terminalBatchId: terminalBatchKey.terminalBatchId,
        terminalEventId: terminalBatchKey.terminalBatchId,
        resourceTerminalEventId: terminalBatchKey.terminalBatchId,
      },
    },
  };
  const batch = finalizeRuntimeEffectTerminalBatchV1(
    input.kernel.getState(),
    [input.reservationId],
    [terminal, continuation],
  );
  expect(input.kernel.applyEffectResult(input.lease, batch)).toBe(true);
}

function restore(input: ReturnType<typeof openStartedSummary>) {
  return createAgentKernel({
    threadId: input.kernel.getState().session.threadId,
    userId: 'u',
    workspace: '/workspace',
    storePath: input.storePath,
  });
}

describe('summary lifecycle v1 six crash cuts', () => {
  test('cut 1: before request leaves no durable Summary attempt to replay', () => {
    const directory = mkdtempSync(join(tmpdir(), 'openpx-summary-cut-1-'));
    try {
      const storePath = join(directory, 'runtime.db');
      createRuntimeStore(storePath).close();
      const kernel = createAgentKernel({
        threadId: 'summary-cut-1',
        userId: 'u',
        workspace: '/workspace',
        storePath,
      });
      expect(kernel.getState().context.summaryLifecycle.kind).toBe('idle');
      kernel.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('cut 2: reservation/dispatch before Summary start cannot persist as a partial batch', () => {
    const directory = mkdtempSync(join(tmpdir(), 'openpx-summary-cut-2-'));
    try {
      const input = openStartedSummary(directory, 'summary-cut-2');
      expect(() => input.kernel.processEventBatch(input.startEvents.slice(0, 2))).toThrow(
        'partial batch',
      );
      expect(() => input.kernel.processEventBatch(input.startEvents.slice(0, 3))).toThrow(
        'partial batch',
      );
      expect(input.kernel.getState().context.summaryLifecycle.kind).toBe('idle');
      input.kernel.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('cut 3: dispatch-started without terminal restores exactly once as unknown', () => {
    const directory = mkdtempSync(join(tmpdir(), 'openpx-summary-cut-3-'));
    try {
      const input = openStartedSummary(directory, 'summary-cut-3');
      commitStartedSummary(input);
      input.kernel.close();
      const recovered = restore(input);
      expect(recovered.getState().context.summaryLifecycle.kind).toBe(
        'resource_resolution_required',
      );
      const types = recovered
        .loadEvents('summary-cut-3')
        .map((entry) => entry.event.type)
        .filter((type) => type === 'context.summary_unknown_external_outcome_v1');
      expect(types).toHaveLength(1);
      recovered.close();
      const second = restore(input);
      expect(
        second
          .loadEvents('summary-cut-3')
          .filter((entry) => entry.event.type === 'context.summary_unknown_external_outcome_v1'),
      ).toHaveLength(1);
      second.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('cut 4: the terminal batch has no durable before/after split', () => {
    const directory = mkdtempSync(join(tmpdir(), 'openpx-summary-cut-4-'));
    try {
      const input = openStartedSummary(directory, 'summary-cut-4');
      commitStartedSummary(input);
      const usage = createZeroResourceUsageV1();
      expect(() =>
        input.kernel.processEvent({
          type: 'resource_budget.reconciled',
          reservationId: input.reservationId,
          actual: usage,
        }),
      ).toThrow();
      expect(input.kernel.getState().context.summaryLifecycle.kind).toBe('started');
      input.kernel.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('cut 5: checkpoint activation before primary reservation restores fresh reprepare only', () => {
    const directory = mkdtempSync(join(tmpdir(), 'openpx-summary-cut-5-'));
    try {
      const input = openStartedSummary(directory, 'summary-cut-5');
      commitStartedSummary(input);
      commitSuccessfulSummary(input);
      expect(input.kernel.getState().context.summaryLifecycle.kind).toBe(
        'normal_reprepare_required',
      );
      const activeCheckpoint = input.kernel.getState().context.activeCheckpoint;
      const checkpointId =
        activeCheckpoint?.version === 3 ? activeCheckpoint.checkpointId : undefined;
      input.kernel.close();
      const recovered = restore(input);
      expect(recovered.getState().context.summaryLifecycle.kind).toBe('normal_reprepare_required');
      const recoveredCheckpoint = recovered.getState().context.activeCheckpoint;
      expect(
        recoveredCheckpoint?.version === 3 ? recoveredCheckpoint.checkpointId : undefined,
      ).toBe(checkpointId);
      expect(
        recovered
          .loadEvents('summary-cut-5')
          .filter((entry) => entry.event.type === 'context.summary_dispatch_started_v1'),
      ).toHaveLength(1);
      recovered.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('cut 6: primary dispatch consumes continuation once and recovery never redispatches it', () => {
    const directory = mkdtempSync(join(tmpdir(), 'openpx-summary-cut-6-'));
    try {
      const input = openStartedSummary(directory, 'summary-cut-6');
      commitStartedSummary(input);
      commitSuccessfulSummary(input);
      const lifecycle = input.kernel.getState().context.summaryLifecycle;
      if (lifecycle.kind !== 'normal_reprepare_required') throw new Error('reprepare expected');
      const primaryRequestId = 'summary-cut-6-primary';
      const admission = planRuntimeBudgetAdmissionV1(input.kernel.getState(), {
        type: 'call_model',
        primaryRequestId,
        resourceEstimate: { inputTokens: 500, maxOutputTokens: 100 },
      });
      if (admission.status !== 'admitted') throw new Error('primary admission expected');
      const lease = input.kernel.beginEffect(admission.effect);
      const reservation = admission.preparationEvents.find(
        (event) => event.type === 'resource_budget.reserved',
      );
      if (reservation?.type !== 'resource_budget.reserved') throw new Error('reservation expected');
      const consumptionKey = {
        version: 1 as const,
        generation: input.kernel.getProducerGeneration(),
        consumptionBatchId: 'summary-cut-6-consumption',
        attemptId: lifecycle.receipt.attemptId,
        compactionId: lifecycle.receipt.compactionId,
        continuation: lifecycle.receipt.continuation,
        originReceipt: lifecycle.receipt,
        primaryEffectLeaseId: lease.effectId,
        primaryInvocationId: reservation.reservation.invocationId,
        primaryRequestId,
        resourceReservationId: reservation.reservation.reservationId,
      };
      const start: RuntimeEvent[] = [
        ...admission.preparationEvents,
        ...admission.dispatchEvents,
      ].map((event) =>
        event.type === 'resource_budget.reserved' ||
        event.type === 'resource_budget.dispatch_started'
          ? { ...event, normalReprepareConsumptionKey: consumptionKey }
          : event,
      );
      start.push({ type: 'context.normal_reprepare_consumed_v1', consumptionKey });
      input.kernel.processEventBatch(start);
      expect(() => input.kernel.processEventBatch(start)).toThrow();
      input.kernel.close();
      const recovered = restore(input);
      expect(recovered.getState().turn.status).toBe('aborted');
      expect(
        recovered
          .loadEvents('summary-cut-6')
          .filter((entry) => entry.event.type === 'context.normal_reprepare_consumed_v1'),
      ).toHaveLength(1);
      expect(
        recovered
          .loadEvents('summary-cut-6')
          .filter((entry) => entry.event.type === 'resource_budget.unknown'),
      ).toHaveLength(1);
      recovered.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
