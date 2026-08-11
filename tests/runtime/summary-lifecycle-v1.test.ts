import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSummarySourceIdentityForCurrentPrefixV1,
  createSummaryRequestedEventV1,
  createSummaryStartBatchKeyV1,
} from '@/core/model/progressive-context-orchestrator';
import type { RuntimeEvent } from '@/core/runtime/events';
import { prepareRuntimeEffectV2 } from '@/core/runtime/executor';
import { AgentKernel, createAgentKernel } from '@/core/runtime/kernel';
import { reduceRuntimeState } from '@/core/runtime/reducer';
import {
  createZeroResourceUsageV1,
  LIMITED_RESOURCE_BUDGET_V1,
} from '@/core/runtime/resource-budget';
import { planRuntimeBudgetAdmissionV1 } from '@/core/runtime/resource-budget-admission';
import { createInitialRuntimeState } from '@/core/runtime/state';
import { createRuntimeStore } from '@/core/runtime/store';
import { createMockModel } from '../mock-model';

const estimate = {
  systemTokens: 10,
  toolSchemaTokens: 0,
  transcriptTokens: 10_000,
  summaryTokens: 0,
  dynamicRuntimeTokens: 10,
  framingTokens: 10,
  totalInputTokens: 10_030,
};

describe('summary lifecycle v1 recovery', () => {
  test('the production preparer turns known 90% pressure into one atomic auto summary effect', () => {
    let state = createInitialRuntimeState({
      threadId: 'auto-summary-preparation',
      userId: 'u',
      workspace: '/workspace',
    });
    state.transcript.messages = Array.from({ length: 8 }, (_, index) => ({
      kind: 'user' as const,
      messageId: `message-${index}`,
      turnId: `turn-${index}`,
      content: `settled ${index} ${'large context '.repeat(500)}`,
    }));
    state.revision = 1;
    state.lastAppliedEventId = 'e'.repeat(64);
    state.appliedEventIds = ['e'.repeat(64)];
    state.context.lastTranscriptProducingEventCutV1 = {
      revision: 1,
      eventId: 'e'.repeat(64),
    };
    const startedAt = new Date();
    state = reduceRuntimeState(state, {
      type: 'resource_budget.configured',
      runId: 'auto-summary-run',
      startedAt: startedAt.toISOString(),
      deadlineAt: new Date(
        startedAt.getTime() + LIMITED_RESOURCE_BUDGET_V1.maxRunDurationMs,
      ).toISOString(),
      budget: LIMITED_RESOURCE_BUDGET_V1,
    });
    const dependencies = {
      config: {
        providerName: 'test',
        providerType: 'openai-compatible' as const,
        apiKey: 'test',
        baseURL: 'http://localhost:1',
        modelName: 'test',
        sandbox: { enabled: true },
        modelCapabilities: { contextWindowTokens: 12_000, maxOutputTokens: 1_000 },
        features: { resourceBudgetV1: true, contextCompactionAutoV1: true },
      },
      model: createMockModel([]),
    };
    const capabilityPreparation = prepareRuntimeEffectV2(
      { type: 'call_model' },
      state,
      dependencies,
    );
    state = capabilityPreparation.preparationEvents.reduce(reduceRuntimeState, state);
    const prepared = prepareRuntimeEffectV2({ type: 'call_model' }, state, dependencies);
    expect(prepared.preparationEvents).toEqual([]);
    expect(prepared.effect).toMatchObject({
      type: 'compact_context',
      summaryRequest: {
        type: 'context.summary_requested_v1',
        attempt: { reason: 'auto', trigger: 'auto_pressure' },
      },
    });
  });

  test('an auto started crash becomes one unknown resolution state and never redispatches', () => {
    const directory = mkdtempSync(join(tmpdir(), 'openpx-summary-recovery-'));
    const storePath = join(directory, 'runtime.db');
    try {
      const store = createRuntimeStore(storePath);
      const state = createInitialRuntimeState({
        threadId: 'summary-recovery',
        userId: 'u',
        workspace: '/workspace',
      });
      state.transcript.messages = Array.from({ length: 8 }, (_, index) => ({
        kind: 'user' as const,
        messageId: `message-${index}`,
        turnId: `turn-${index}`,
        content: `settled source ${index} ${'context '.repeat(100)}`,
      }));
      const kernel = new AgentKernel({
        store,
        initialState: state,
        interactionMode: 'accept_edits',
      });
      const startedAt = new Date();
      kernel.processEvent({
        type: 'resource_budget.configured',
        runId: 'summary-run',
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
        attemptId: 'auto-attempt',
        compactionId: 'auto-compaction',
      });
      const effect = {
        type: 'compact_context' as const,
        compactionId: 'auto-compaction',
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
        event.type === 'resource_budget.reserved' ||
        event.type === 'resource_budget.dispatch_started'
          ? { ...event, summaryStartBatchKey: startBatchKey }
          : event,
      );
      startEvents.push({
        type: 'context.summary_dispatch_started_v1',
        attemptId: requested.attempt.attemptId,
        startBatchKey,
      });
      expect(() => kernel.processEventBatch(startEvents.slice(0, 2))).toThrow('partial batch');
      expect(() => kernel.processEvent(requested)).toThrow('one atomic batch');
      expect(kernel.applyEffectResult(lease, startEvents)).toBe(true);
      const startedLifecycle = kernel.getState().context.summaryLifecycle;
      if (startedLifecycle.kind !== 'started') throw new Error('started lifecycle expected');
      expect(Object.values(startedLifecycle.startedReceipt ?? {})).toHaveLength(5);
      expect(
        Object.values(startedLifecycle.startedReceipt ?? {})
          .slice(1)
          .every((eventId) => typeof eventId === 'string' && /^[a-f0-9]{64}$/.test(eventId)),
      ).toBe(true);
      kernel.close();

      const restored = createAgentKernel({
        threadId: 'summary-recovery',
        userId: 'u',
        workspace: '/workspace',
        storePath,
      });
      expect(restored.getState().context.summaryLifecycle.kind).toBe(
        'resource_resolution_required',
      );
      expect(restored.getState().resourceBudget.status).toBe('active');
      if (restored.getState().resourceBudget.status === 'active') {
        expect(restored.getState().resourceBudget.reservations[reservationId]?.state).toBe(
          'unknown',
        );
      }
      const actual = createZeroResourceUsageV1();
      actual.counters.modelRequests = 1;
      actual.counters.inputTokens = 1_000;
      actual.counters.outputTokens = 100;
      const resolving = restored.getState().context.summaryLifecycle;
      if (resolving.kind !== 'resource_resolution_required') {
        throw new Error('resolution lifecycle expected');
      }
      expect(resolving.continuation.turnId).toBe(restored.getState().turn.turnId);
      expect(buildSummarySourceIdentityForCurrentPrefixV1(restored.getState())).toEqual(
        resolving.continuation.summarySourceIdentity,
      );
      expect(
        restored.applyLateResourceReconciliation([
          { type: 'resource_budget.reconciled', reservationId, actual },
        ]),
      ).toBe(false);
      expect(restored.applyLateSummaryResourceResolutionV1({ reservationId, actual })).toBe(true);
      expect(restored.getState().context.summaryLifecycle.kind).toBe('normal_reprepare_required');
      const resolvedLifecycle = restored.getState().context.summaryLifecycle;
      if (resolvedLifecycle.kind !== 'normal_reprepare_required') {
        throw new Error('resolved lifecycle expected');
      }
      expect(resolvedLifecycle.receipt.origin.kind).toBe('late_resolution');
      if (resolvedLifecycle.receipt.origin.kind === 'late_resolution') {
        expect(resolvedLifecycle.receipt.origin.resourceReconciledEventId).toMatch(
          /^[a-f0-9]{64}$/,
        );
      }
      expect(restored.applyLateSummaryResourceResolutionV1({ reservationId, actual })).toBe(false);
      const reprepare = restored.getState().context.summaryLifecycle;
      if (reprepare.kind !== 'normal_reprepare_required') {
        throw new Error('normal reprepare expected');
      }
      const primaryRequestId = 'continuation-primary-request';
      const primaryAdmission = planRuntimeBudgetAdmissionV1(restored.getState(), {
        type: 'call_model',
        primaryRequestId,
        resourceEstimate: { inputTokens: 500, maxOutputTokens: 100 },
      });
      if (primaryAdmission.status !== 'admitted') throw new Error('primary admission expected');
      const primaryLease = restored.beginEffect(primaryAdmission.effect);
      const primaryReservation = primaryAdmission.preparationEvents.find(
        (event) => event.type === 'resource_budget.reserved',
      );
      if (primaryReservation?.type !== 'resource_budget.reserved') {
        throw new Error('primary reservation expected');
      }
      const consumptionKey = {
        version: 1 as const,
        generation: restored.getProducerGeneration(),
        consumptionBatchId: 'continuation-consumption',
        attemptId: reprepare.receipt.attemptId,
        compactionId: reprepare.receipt.compactionId,
        continuation: reprepare.receipt.continuation,
        originReceipt: reprepare.receipt,
        primaryEffectLeaseId: primaryLease.effectId,
        primaryInvocationId: primaryReservation.reservation.invocationId,
        primaryRequestId,
        resourceReservationId: primaryReservation.reservation.reservationId,
      };
      const primaryStart = [
        ...primaryAdmission.preparationEvents,
        ...primaryAdmission.dispatchEvents,
      ].map(
        (event): RuntimeEvent =>
          event.type === 'resource_budget.reserved' ||
          event.type === 'resource_budget.dispatch_started'
            ? { ...event, normalReprepareConsumptionKey: consumptionKey }
            : event,
      );
      primaryStart.push({ type: 'context.normal_reprepare_consumed_v1', consumptionKey });
      restored.processEventBatch(primaryStart);
      expect(restored.getState().context.summaryLifecycle).toMatchObject({
        kind: 'idle',
        lastConsumption: { primaryRequestId },
      });
      restored.close();

      const afterPrimaryCrash = createAgentKernel({
        threadId: 'summary-recovery',
        userId: 'u',
        workspace: '/workspace',
        storePath,
      });
      expect(afterPrimaryCrash.getState().turn.status).toBe('aborted');
      if (afterPrimaryCrash.getState().resourceBudget.status === 'active') {
        expect(
          afterPrimaryCrash.getState().resourceBudget.reservations[
            consumptionKey.resourceReservationId
          ]?.state,
        ).toBe('unknown');
      }
      const recoveryTail = afterPrimaryCrash
        .loadEvents('summary-recovery')
        .slice(-3)
        .map((entry) => entry.event.type);
      expect(recoveryTail).toEqual(['run.error', 'resource_budget.unknown', 'turn.aborted']);
      afterPrimaryCrash.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
