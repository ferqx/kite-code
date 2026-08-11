import { describe, expect, test } from 'bun:test';
import {
  deriveBranchLifecycleMutationV1,
  executeForkBranchMutationV1,
} from '@/core/runtime/branch-mutation-v1';
import { reduceRuntimeState } from '@/core/runtime/reducer';
import {
  createZeroResourceUsageV1,
  LIMITED_RESOURCE_BUDGET_V1,
} from '@/core/runtime/resource-budget';
import { planRuntimeBudgetAdmissionV1 } from '@/core/runtime/resource-budget-admission';
import { buildRuntimeEventEnvelopeV24 } from '@/core/runtime/runtime-event-v24';
import { createInitialRuntimeState } from '@/core/runtime/state';

describe('branch lifecycle mutation v1', () => {
  test('retries contention once with the exact same opaque candidate', () => {
    const candidates: unknown[] = [];
    const store = {
      forkSessionV1(
        _sourceThreadId: string,
        _snapshotId: string,
        _targetThreadId: string,
        candidate?: unknown,
      ) {
        candidates.push(candidate);
        return candidates.length === 1
          ? ({ status: 'contention_timeout' } as const)
          : ({ status: 'committed', receiptId: 'a'.repeat(64), targetGeneration: 3 } as const);
      },
      resolveBranchMutationCompletionV1() {
        throw new Error('ACK resolution must not run for a precommit contention retry.');
      },
    };

    expect(executeForkBranchMutationV1(store, 'source', 'cut', 'target')).toEqual({
      status: 'committed',
      receiptId: 'a'.repeat(64),
      targetGeneration: 3,
    });
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toBe(candidates[1]);
    expect(candidates[0]).toMatchObject({ version: 1 });
    expect((candidates[0] as { nonceHex: string }).nonceHex).toMatch(/^[a-f0-9]{32}$/);
  });

  test('closes an in-flight continuation as one target-generation quartet', () => {
    let state = createInitialRuntimeState({
      threadId: 'branch-target',
      userId: 'u',
      workspace: '/workspace',
    });
    const startedAt = new Date();
    state = reduceRuntimeState(state, {
      type: 'resource_budget.configured',
      runId: 'branch-run',
      startedAt: startedAt.toISOString(),
      deadlineAt: new Date(
        startedAt.getTime() + LIMITED_RESOURCE_BUDGET_V1.maxRunDurationMs,
      ).toISOString(),
      budget: LIMITED_RESOURCE_BUDGET_V1,
    });
    const admission = planRuntimeBudgetAdmissionV1(state, {
      type: 'call_model',
      primaryRequestId: 'primary-request',
      resourceEstimate: { inputTokens: 100, maxOutputTokens: 50 },
    });
    if (admission.status !== 'admitted') throw new Error('admission expected');
    for (const event of [...admission.preparationEvents, ...admission.dispatchEvents]) {
      state = reduceRuntimeState(state, event);
    }
    const reservation = admission.preparationEvents.find(
      (event) => event.type === 'resource_budget.reserved',
    );
    if (reservation?.type !== 'resource_budget.reserved') throw new Error('reservation expected');
    const consumption = {
      version: 1 as const,
      generation: 1,
      consumptionBatchId: 'consumption',
      attemptId: 'attempt',
      compactionId: 'compaction',
      continuation: {
        version: 1 as const,
        turnId: state.turn.turnId,
        requestedAtRevision: 0,
        summarySourceIdentity: {
          version: 1 as const,
          firstMessageId: 'first',
          coveredThroughMessageId: 'last',
          coveredThroughTurnId: state.turn.turnId,
          canonicalSourceDigest: 'a'.repeat(64),
          sourceProjectionPolicyId: 'checkpoint-v3-source:v1' as const,
        },
      },
      originReceipt: {
        version: 1 as const,
        generation: 1,
        attemptId: 'attempt',
        compactionId: 'compaction',
        continuation: {
          version: 1 as const,
          turnId: state.turn.turnId,
          requestedAtRevision: 0,
          summarySourceIdentity: {
            version: 1 as const,
            firstMessageId: 'first',
            coveredThroughMessageId: 'last',
            coveredThroughTurnId: state.turn.turnId,
            canonicalSourceDigest: 'a'.repeat(64),
            sourceProjectionPolicyId: 'checkpoint-v3-source:v1' as const,
          },
        },
        origin: {
          kind: 'summary_terminal' as const,
          terminalBatchId: 'terminal',
          terminalEventId: 'b'.repeat(64),
          resourceTerminalEventId: 'c'.repeat(64),
        },
      },
      primaryEffectLeaseId: 'lease',
      primaryInvocationId: reservation.reservation.invocationId,
      primaryRequestId: 'primary-request',
      resourceReservationId: reservation.reservation.reservationId,
    };
    state.context.summaryLifecycle = { kind: 'idle', lastConsumption: consumption };
    const occurredAt = new Date(1).toISOString();
    const selectedSourceEnvelopes = [
      { ...admission.preparationEvents[0]!, normalReprepareConsumptionKey: consumption },
      { ...admission.dispatchEvents[0]!, normalReprepareConsumptionKey: consumption },
      { type: 'context.normal_reprepare_consumed_v1' as const, consumptionKey: consumption },
    ].map((payload, index) =>
      buildRuntimeEventEnvelopeV24({
        threadId: 'branch-source',
        generation: 3,
        revision: index + 1,
        occurredAt,
        payload,
      }),
    );
    const derived = deriveBranchLifecycleMutationV1({
      state,
      reason: 'fork',
      receiptId: 'd'.repeat(64),
      sourceThreadId: 'branch-source',
      targetThreadId: 'branch-target',
      sourceGeneration: 3,
      targetGeneration: 4,
      selectedCutDigest: 'e'.repeat(64),
      requestDigest: 'f'.repeat(64),
      selectedSourceEnvelopes,
      occurredAt,
    });
    expect(derived.events.map((event) => event.type)).toEqual([
      'run.error',
      'resource_budget.unknown',
      'turn.aborted',
      'context.normal_reprepare_consumption_detached_v1',
    ]);
    expect(derived.metadata.every((entry) => entry.generation === 4)).toBe(true);
    expect(derived.state.context.summaryLifecycle).toEqual({ kind: 'idle' });
    expect(derived.state.context.lastDetach?.receiptId).toBe('d'.repeat(64));
    expect(derived.state.turn.status).toBe('aborted');
    expect(derived.receipt).toMatchObject({
      receiptId: 'd'.repeat(64),
      manifest: { kind: 'in_flight_quartet' },
      terminalClosure: { kind: 'none' },
    });
    expect(derived.completion).toMatchObject({
      receiptId: 'd'.repeat(64),
      requestDigest: 'f'.repeat(64),
    });
  });

  test('copies exact settled success evidence into BCTC and writes only one detach', () => {
    let state = createInitialRuntimeState({
      threadId: 'settled-target',
      userId: 'u',
      workspace: '/workspace',
    });
    const startedAt = new Date();
    state = reduceRuntimeState(state, {
      type: 'resource_budget.configured',
      runId: 'settled-run',
      startedAt: startedAt.toISOString(),
      deadlineAt: new Date(
        startedAt.getTime() + LIMITED_RESOURCE_BUDGET_V1.maxRunDurationMs,
      ).toISOString(),
      budget: LIMITED_RESOURCE_BUDGET_V1,
    });
    const admission = planRuntimeBudgetAdmissionV1(state, {
      type: 'call_model',
      primaryRequestId: 'settled-primary-request',
      resourceEstimate: { inputTokens: 100, maxOutputTokens: 50 },
    });
    if (admission.status !== 'admitted') throw new Error('admission expected');
    for (const event of [...admission.preparationEvents, ...admission.dispatchEvents]) {
      state = reduceRuntimeState(state, event);
    }
    const reserved = admission.preparationEvents.find(
      (event) => event.type === 'resource_budget.reserved',
    );
    if (reserved?.type !== 'resource_budget.reserved') throw new Error('reservation expected');
    const continuation = {
      version: 1 as const,
      turnId: state.turn.turnId,
      requestedAtRevision: 0,
      summarySourceIdentity: {
        version: 1 as const,
        firstMessageId: 'first',
        coveredThroughMessageId: 'last',
        coveredThroughTurnId: state.turn.turnId,
        canonicalSourceDigest: '1'.repeat(64),
        sourceProjectionPolicyId: 'checkpoint-v3-source:v1' as const,
      },
    };
    const originReceipt = {
      version: 1 as const,
      generation: 7,
      attemptId: 'settled-attempt',
      compactionId: 'settled-compaction',
      continuation,
      origin: {
        kind: 'summary_terminal' as const,
        terminalBatchId: 'summary-terminal',
        terminalEventId: '2'.repeat(64),
        resourceTerminalEventId: '3'.repeat(64),
      },
    };
    const consumption = {
      version: 1 as const,
      generation: 7,
      consumptionBatchId: 'settled-consumption',
      attemptId: originReceipt.attemptId,
      compactionId: originReceipt.compactionId,
      continuation,
      originReceipt,
      primaryEffectLeaseId: 'settled-lease',
      primaryInvocationId: reserved.reservation.invocationId,
      primaryRequestId: 'settled-primary-request',
      resourceReservationId: reserved.reservation.reservationId,
    };
    const terminalBatchId = 'settled-terminal-batch';
    const primaryTerminal = {
      type: 'model.responded' as const,
      messageId: 'settled-response',
      text: 'done',
      contextEvidence: {
        version: 2 as const,
        purpose: 'primary' as const,
        terminalBatchId,
        requestId: consumption.primaryRequestId,
        effectLeaseId: consumption.primaryEffectLeaseId,
        reservationId: consumption.resourceReservationId,
        preparedDigest: '4'.repeat(64),
        sourceIdentityDigest: '5'.repeat(64),
        requestIdentityDigest: '6'.repeat(64),
        finalProviderPayloadDigest: '7'.repeat(64),
        admittedRequestDigest: '8'.repeat(64),
        reclaimReceiptDigest: 'none' as const,
      },
    };
    const resourceTerminal = {
      type: 'resource_budget.reconciled' as const,
      reservationId: consumption.resourceReservationId,
      terminalBatchId,
      actual: createZeroResourceUsageV1(),
    };
    state = reduceRuntimeState(state, primaryTerminal);
    state = reduceRuntimeState(state, resourceTerminal);
    state.context.summaryLifecycle = { kind: 'idle', lastConsumption: consumption };
    const occurredAt = '2026-08-11T00:01:00.000Z';
    const selectedSourceEnvelopes = [
      { ...admission.preparationEvents[0]!, normalReprepareConsumptionKey: consumption },
      { ...admission.dispatchEvents[0]!, normalReprepareConsumptionKey: consumption },
      { type: 'context.normal_reprepare_consumed_v1' as const, consumptionKey: consumption },
      primaryTerminal,
      resourceTerminal,
    ].map((payload, index) =>
      buildRuntimeEventEnvelopeV24({
        threadId: 'settled-source',
        generation: 7,
        revision: index + 1,
        occurredAt,
        payload,
      }),
    );
    const derived = deriveBranchLifecycleMutationV1({
      state,
      reason: 'fork',
      receiptId: '9'.repeat(64),
      sourceThreadId: 'settled-source',
      targetThreadId: 'settled-target',
      sourceGeneration: 7,
      targetGeneration: 8,
      selectedCutDigest: 'a'.repeat(64),
      requestDigest: 'b'.repeat(64),
      selectedSourceEnvelopes,
      occurredAt,
    });
    expect(derived.events.map((event) => event.type)).toEqual([
      'context.normal_reprepare_consumption_detached_v1',
    ]);
    expect(derived.receipt?.manifest.kind).toBe('settled_detach');
    expect(derived.terminalClosure?.terminal.kind).toBe('success');
    expect(derived.terminalClosure?.terminal.envelopes).toHaveLength(5);
    expect(
      derived.terminalClosure?.terminal.envelopes.every(
        ({ envelope }) => envelope.threadId === 'settled-source' && envelope.generation === 7,
      ),
    ).toBe(true);
    expect(derived.state.context.lastDetach?.primaryState).toBe('settled_success');
  });
});
