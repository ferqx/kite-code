import { describe, expect, test } from 'bun:test';
import { createVerifiedContextCheckpointV3 } from '@/core/model/context-checkpoint-v3';
import {
  buildSummarySourceIdentityForCurrentPrefixV1,
  createSummaryStartBatchKeyV1,
  ProviderDispatchEntryGuardV1,
  prepareProgressiveContextDecisionV1,
} from '@/core/model/progressive-context-orchestrator';
import { reduceRuntimeState } from '@/core/runtime/reducer';
import { createInitialRuntimeState } from '@/core/runtime/state';
import { projectedModelContentDigest } from '@/core/tools/registry/projection';
import { type ToolResultBudgetReceiptV2, toolResultDigestV2 } from '@/core/tools/result-budget-v2';

function state() {
  const runtime = createInitialRuntimeState({
    threadId: 'orchestrator',
    userId: 'u',
    workspace: '/workspace',
  });
  runtime.revision = 1;
  runtime.lastAppliedEventId = 'e'.repeat(64);
  runtime.appliedEventIds = ['e'.repeat(64)];
  runtime.transcript.messages = Array.from({ length: 12 }, (_, index) => ({
    kind: 'user' as const,
    messageId: `message-${index}`,
    turnId: `turn-${index}`,
    content: `settled ${index} ${'context '.repeat(200)}`,
  }));
  return runtime;
}

function stateWithOffloadOnlyWorkingSet() {
  const runtime = state();
  const toolCallId = 'oversized-read';
  const content = `settled read ${'large tool result '.repeat(3_200)}`;
  const receipt: ToolResultBudgetReceiptV2 = {
    version: 2 as const,
    projectionMode: 'budget_v2' as const,
    policyId: 'test-budget:v2',
    toolIdentity: 'builtin:read_file',
    bindingDigest: 'a'.repeat(64),
    projectorId: 'read-line-window:v1',
    projectorRevision: 'test-projector:v1',
    validatorId: 'test-validator:v1',
    rawResultDigest: toolResultDigestV2('test-raw:v1', content),
    modelContentDigest: projectedModelContentDigest(content),
    modelContentUtf8Bytes: Buffer.byteLength(content, 'utf8'),
  };
  runtime.transcript.messages.push(
    {
      kind: 'assistant',
      messageId: 'assistant-oversized-read',
      turnId: 'turn-oversized-read',
      content: 'I read the file.',
      toolCalls: [{ id: toolCallId, name: 'read_file', args: { path: 'src/large.ts' } }],
    },
    {
      kind: 'tool',
      messageId: 'tool-oversized-read',
      turnId: 'turn-oversized-read',
      toolCallId,
      name: 'read_file',
      content,
      ok: true,
      resultMeta: {
        path: 'src/large.ts',
        rawResultDigest: receipt.rawResultDigest,
        modelContentDigest: receipt.modelContentDigest,
        digestScope: 'raw',
        toolResultReceipt: receipt,
      },
    },
  );
  runtime.tools.calls[toolCallId] = {
    toolCallId,
    modelMessageId: 'assistant-oversized-read',
    name: 'read_file',
    args: { path: 'src/large.ts' },
    status: 'succeeded',
    createdAtTurnId: 'turn-oversized-read',
    effectClass: 'read_only',
    sideEffect: false,
    result: { ok: true, summary: 'read' },
  };
  runtime.context.activeCheckpoint = createVerifiedContextCheckpointV3({
    state: runtime,
    checkpointId: 'checkpoint:v3',
    compactionId: 'checkpoint',
    reason: 'manual',
    coveredThroughMessageId: 'tool-oversized-read',
    summary: '# Verified history',
    inputTokensBefore: 20_000,
    inputTokensAfter: 4_000,
    routeIdentityDigest: 'a'.repeat(64),
    sourceProducingEventCutV1: { revision: 1, eventId: 'e'.repeat(64) },
    createdAt: new Date(0).toISOString(),
  });
  return runtime;
}

describe('progressive context orchestrator v1', () => {
  test('uses one pure tier order and creates an auto continuation only at known 90% pressure', () => {
    const runtime = state();
    expect(
      prepareProgressiveContextDecisionV1({
        state: runtime,
        pressure: 'warning',
        utilization: 0.95,
        contextWindowTokens: 64_000,
        autoSummaryEnabled: true,
        microAvailable: true,
        microPressure: 'normal',
      }).kind,
    ).toBe('dispatch_micro');

    expect(
      prepareProgressiveContextDecisionV1({
        state: runtime,
        pressure: 'hard_limit',
        utilization: 0.95,
        contextWindowTokens: 64_000,
        autoSummaryEnabled: true,
        microAvailable: true,
        microPressure: 'hard_limit',
      }).kind,
    ).toBe('request_summary');

    const decision = prepareProgressiveContextDecisionV1({
      state: runtime,
      pressure: 'compact_due',
      utilization: 0.95,
      contextWindowTokens: 64_000,
      autoSummaryEnabled: true,
      microAvailable: false,
    });
    expect(decision.kind).toBe('request_summary');
    if (decision.kind !== 'request_summary') return;
    expect(decision.event.attempt.reason).toBe('auto');
    expect(decision.event.continuation?.turnId).toBe(runtime.turn.turnId);

    const requested = reduceRuntimeState(runtime, decision.event);
    expect(requested.context.summaryLifecycle.kind).toBe('requested');
    expect(requested.context.autoSummaryCooldown).toBeUndefined();
    const startBatchKey = createSummaryStartBatchKeyV1({
      state: requested,
      effectLeaseId: 'summary-lease',
      resourceReservationId: 'summary-reservation',
      expectedMaxOutputTokens: 6_000,
    });
    const started = reduceRuntimeState(requested, {
      type: 'context.summary_dispatch_started_v1',
      attemptId: decision.event.attempt.attemptId,
      startBatchKey,
    });
    expect(started.context.autoSummaryCooldown?.nextEligibleSuccessfulPrimaryOrdinal).toBe(3);
  });

  test('manual shares the source request path while same-source and cooldown stay durable', () => {
    const runtime = state();
    const manual = prepareProgressiveContextDecisionV1({
      state: runtime,
      pressure: 'normal',
      autoSummaryEnabled: false,
      microAvailable: false,
      manual: { customInstructions: 'focus on unfinished work' },
    });
    expect(manual.kind).toBe('request_summary');
    if (manual.kind !== 'request_summary') return;
    expect(manual.event.attempt.trigger).toBe('manual_custom');
    expect(manual.event.continuation).toBeUndefined();

    const auto = prepareProgressiveContextDecisionV1({
      state: runtime,
      pressure: 'compact_due',
      utilization: 0.95,
      contextWindowTokens: 64_000,
      autoSummaryEnabled: true,
      microAvailable: false,
    });
    if (auto.kind !== 'request_summary') throw new Error('expected auto request');
    const requested = reduceRuntimeState(runtime, auto.event);
    const startBatchKey = createSummaryStartBatchKeyV1({
      state: requested,
      effectLeaseId: 'summary-lease',
      resourceReservationId: 'summary-reservation',
      expectedMaxOutputTokens: 6_000,
    });
    const attempted = reduceRuntimeState(requested, {
      type: 'context.summary_dispatch_started_v1',
      attemptId: auto.event.attempt.attemptId,
      startBatchKey,
    });
    attempted.context.summaryLifecycle = { kind: 'idle' };
    expect(
      prepareProgressiveContextDecisionV1({
        state: attempted,
        pressure: 'compact_due',
        utilization: 0.95,
        contextWindowTokens: 64_000,
        autoSummaryEnabled: true,
        microAvailable: false,
      }),
    ).toMatchObject({ kind: 'dispatch_raw', reason: 'auto_summary_dedup_or_cooldown' });
  });

  test('keeps L2.5 and Working Set selection on the same effective projection policy', () => {
    const runtime = stateWithOffloadOnlyWorkingSet();
    expect(
      prepareProgressiveContextDecisionV1({
        state: runtime,
        pressure: 'compact_due',
        utilization: 0.95,
        contextWindowTokens: 64_000,
        autoSummaryEnabled: false,
        microAvailable: false,
        workingSetPressure: 'normal',
        oversizedBlockOffloadV1: true,
        availableToolNames: ['read_file'],
      }),
    ).toMatchObject({
      kind: 'dispatch_working_set',
      reason: 'verified_checkpoint_working_set',
    });
  });

  test('dispatch entry and zero-execution close are mutually exclusive and single-use', () => {
    const entered = new ProviderDispatchEntryGuardV1();
    expect(entered.tryEnter()).toBe(true);
    expect(entered.tryEnter()).toBe(false);
    expect(entered.closeWithoutEntry()).toBeNull();
    expect(entered.currentState()).toBe('entered');

    const closed = new ProviderDispatchEntryGuardV1();
    expect(closed.closeWithoutEntry()).toMatchObject({
      proof: 'prepared_dispatch_not_entered_v1',
    });
    expect(closed.closeWithoutEntry()).toBeNull();
    expect(closed.tryEnter()).toBe(false);
    expect(closed.currentState()).toBe('closed_without_entry');
  });

  test('source identity ignores control-only revisions and cooldown needs three successful primaries', () => {
    const runtime = state();
    const source = buildSummarySourceIdentityForCurrentPrefixV1(runtime);
    runtime.revision += 50;
    expect(buildSummarySourceIdentityForCurrentPrefixV1(runtime)).toEqual(source);

    const requestedDecision = prepareProgressiveContextDecisionV1({
      state: runtime,
      pressure: 'compact_due',
      utilization: 0.95,
      contextWindowTokens: 64_000,
      autoSummaryEnabled: true,
      microAvailable: false,
    });
    if (requestedDecision.kind !== 'request_summary') throw new Error('request expected');
    const requested = reduceRuntimeState(runtime, requestedDecision.event);
    const startBatchKey = createSummaryStartBatchKeyV1({
      state: requested,
      effectLeaseId: 'lease',
      resourceReservationId: 'reservation',
      expectedMaxOutputTokens: 6_000,
    });
    const attempted = reduceRuntimeState(requested, {
      type: 'context.summary_dispatch_started_v1',
      attemptId: requestedDecision.event.attempt.attemptId,
      startBatchKey,
    });
    attempted.context.summaryLifecycle = { kind: 'idle' };
    attempted.transcript.messages.push({
      kind: 'user',
      messageId: 'message-new-source',
      turnId: 'turn-new-source',
      content: 'new settled source',
    });
    attempted.context.successfulPrimaryOrdinal = 2;
    expect(
      prepareProgressiveContextDecisionV1({
        state: attempted,
        pressure: 'compact_due',
        utilization: 0.95,
        contextWindowTokens: 64_000,
        autoSummaryEnabled: true,
        microAvailable: false,
      }),
    ).toMatchObject({ kind: 'dispatch_raw', reason: 'auto_summary_dedup_or_cooldown' });
    attempted.context.successfulPrimaryOrdinal = 3;
    expect(
      prepareProgressiveContextDecisionV1({
        state: attempted,
        pressure: 'compact_due',
        utilization: 0.95,
        contextWindowTokens: 64_000,
        autoSummaryEnabled: true,
        microAvailable: false,
      }).kind,
    ).toBe('request_summary');
  });

  test('uses configured cooldown turns instead of the legacy fixed default', () => {
    const runtime = state();
    const requested = prepareProgressiveContextDecisionV1({
      state: runtime,
      pressure: 'compact_due',
      utilization: 0.95,
      contextWindowTokens: 64_000,
      autoSummaryEnabled: true,
      microAvailable: false,
    });
    if (requested.kind !== 'request_summary') throw new Error('request expected');
    const afterRequest = reduceRuntimeState(runtime, requested.event);
    const started = reduceRuntimeState(afterRequest, {
      type: 'context.summary_dispatch_started_v1',
      attemptId: requested.event.attempt.attemptId,
      startBatchKey: createSummaryStartBatchKeyV1({
        state: afterRequest,
        effectLeaseId: 'lease',
        resourceReservationId: 'reservation',
        expectedMaxOutputTokens: 6_000,
      }),
    });
    started.context.summaryLifecycle = { kind: 'idle' };
    started.transcript.messages.push({
      kind: 'user',
      messageId: 'new-source',
      turnId: 'new-turn',
      content: 'new source after attempted auto summary',
    });
    started.context.successfulPrimaryOrdinal = 1;
    expect(
      prepareProgressiveContextDecisionV1({
        state: started,
        pressure: 'compact_due',
        utilization: 0.95,
        contextWindowTokens: 64_000,
        autoSummaryEnabled: true,
        autoCooldownSuccessfulPrimaryTurns: 2,
        microAvailable: false,
      }),
    ).toMatchObject({ kind: 'dispatch_raw', reason: 'auto_summary_dedup_or_cooldown' });
    started.context.successfulPrimaryOrdinal = 2;
    expect(
      prepareProgressiveContextDecisionV1({
        state: started,
        pressure: 'compact_due',
        utilization: 0.95,
        contextWindowTokens: 64_000,
        autoSummaryEnabled: true,
        autoCooldownSuccessfulPrimaryTurns: 2,
        microAvailable: false,
      }).kind,
    ).toBe('request_summary');
  });
});
