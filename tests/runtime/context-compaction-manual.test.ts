import { describe, expect, test } from 'bun:test';
import type { AgentConfig } from '../../src/core/config';
import {
  buildContextStatusReport,
  compactResetPreflight,
  currentContextPreflight,
  inspectManualContextCompaction,
  manualContextCompactionEvent,
  prepareContextInspectionV2,
} from '../../src/core/model/context-compaction-manual';
import { reduceRuntimeState } from '../../src/core/runtime/reducer';
import { createInitialRuntimeState } from '../../src/core/runtime/state';

const config: AgentConfig = {
  apiKey: 'test',
  baseURL: 'http://localhost',
  modelName: 'manual',
  providerName: 'manual',
  providerType: 'openai-compatible',
  sandbox: { enabled: false },
  modelCapabilities: { contextWindowTokens: 10_000, maxOutputTokens: 1_000 },
  compaction: {},
};

function addStableSummarySource(state: ReturnType<typeof createInitialRuntimeState>): void {
  const eventId = 'a'.repeat(64);
  state.transcript.messages.push({
    kind: 'user',
    messageId: 'stable-source-message',
    turnId: 'settled-source-turn',
    ordinal: 0,
    createdAt: '2026-07-20T00:00:00.000Z',
    content: 'stable source for manual compaction',
  });
  state.revision = 1;
  state.lastAppliedEventId = eventId;
  state.appliedEventIds = [eventId];
  state.context.lastTranscriptProducingEventCutV1 = { revision: 1, eventId };
}

describe('manual context compaction service', () => {
  test('preview/status inspection is read-only and reports a safe historical range', () => {
    const state = createInitialRuntimeState({
      threadId: 'manual',
      userId: 'user',
      workspace: '/workspace',
    });
    state.transcript.messages = Array.from({ length: 3 }, (_, index) => ({
      kind: 'user' as const,
      messageId: `message-${index}`,
      turnId: `turn-${index}`,
      ordinal: index,
      createdAt: '2026-07-20T00:00:00.000Z',
      content: `message ${index}`,
    }));
    const before = structuredClone(state);
    const status = inspectManualContextCompaction(state, config);
    expect(status.safeBoundary).toMatchObject({
      eligible: true,
      firstMessageId: 'message-0',
      lastMessageId: 'message-2',
    });
    expect(state).toEqual(before);
  });

  test('manual compaction request produces correct event shape', () => {
    const state = createInitialRuntimeState({
      threadId: 'manual-request',
      userId: 'user',
      workspace: '/workspace',
    });
    addStableSummarySource(state);
    expect(manualContextCompactionEvent({ state, config })).toMatchObject({
      type: 'context.summary_requested_v1',
      attempt: { reason: 'manual', trigger: 'manual_plain' },
    });
  });

  test('custom instructions are carried through the request event', () => {
    const state = createInitialRuntimeState({
      threadId: 'manual-custom',
      userId: 'user',
      workspace: '/workspace',
    });
    addStableSummarySource(state);
    const event = manualContextCompactionEvent({
      state,
      config,
      customInstructions: 'focus on auth module changes',
    });
    expect(event).toMatchObject({
      type: 'context.summary_requested_v1',
      attempt: {
        reason: 'manual',
        trigger: 'manual_custom',
        customInstructions: 'focus on auth module changes',
      },
    });
    // No custom instructions → field absent
    const plain = manualContextCompactionEvent({ state, config });
    expect(plain).not.toHaveProperty('attempt.customInstructions');
  });

  test('manual requests never gain force semantics from a correctness hard block', () => {
    const state = createInitialRuntimeState({
      threadId: 'manual-recovery',
      userId: 'user',
      workspace: '/workspace',
    });
    addStableSummarySource(state);
    state.context.hardBlock = {
      reason: 'runtime_invariant_violation',
      sourceDigest: 'source',
      message: 'blocked',
      createdAtTurnId: state.turn.turnId,
    };
    const event = manualContextCompactionEvent({ state, config });
    expect(event).toMatchObject({
      type: 'context.summary_requested_v1',
      attempt: { reason: 'manual', trigger: 'manual_plain' },
    });
  });

  test('keeps context metrics informational and recomputes inspection state', () => {
    const state = createInitialRuntimeState({
      threadId: 'manual-metrics',
      userId: 'user',
      workspace: '/workspace',
    });
    const next = reduceRuntimeState(state, {
      type: 'model.context_metrics',
      modelName: 'manual',
      contextWindowTokens: 10_000,
      usableInputTokens: 8_000,
      reservedOutputTokens: 1_000,
      providerSafetyMarginTokens: 1_000,
      totalInputTokens: 6_000,
      utilization: 0.75,
      status: 'compact_due',
      estimate: {
        systemTokens: 100,
        toolSchemaTokens: 100,
        transcriptTokens: 5_500,
        summaryTokens: 0,
        dynamicRuntimeTokens: 100,
        framingTokens: 200,
        totalInputTokens: 6_000,
      },
    });
    expect('lastPreflight' in next.context).toBe(false);
    expect(
      inspectManualContextCompaction(next, config).preflight.estimate.totalInputTokens,
    ).not.toBe(6_000);
  });

  test('uses the live adapter capability view when config has no model window', () => {
    const state = createInitialRuntimeState({
      threadId: 'adapter-capabilities',
      userId: 'user',
      workspace: '/workspace',
    });
    const configWithoutWindow = { ...config, modelCapabilities: undefined };
    const preflight = currentContextPreflight(state, configWithoutWindow, {
      providerName: 'manual',
      modelName: 'manual',
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
      supportsUsageMetadata: true,
      supportsPromptCache: false,
      streaming: false,
    });
    expect(preflight.reservedOutputTokens).toBe(2_000);
    expect(preflight.usableInputTokens).toBe(28_976);
  });

  test('uses the full projection environment for durable manual request estimates', () => {
    const state = createInitialRuntimeState({
      threadId: 'manual-projection',
      userId: 'user',
      workspace: '/workspace',
    });
    addStableSummarySource(state);
    const projectionEnvironment = {
      serializedTools: [
        {
          name: 'large_tool',
          description: 'tool schema '.repeat(400),
          inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
          schemaDigest: 'digest',
        },
      ],
      workflowSkills: [],
    };
    const event = manualContextCompactionEvent({
      state,
      config,
      projectionEnvironment,
    });
    expect(event).toMatchObject({ type: 'context.summary_requested_v1' });
    if (event?.type !== 'context.summary_requested_v1') throw new Error('request expected');
    expect(event.attempt.estimate.systemTokens).toBeGreaterThan(0);
    expect(event.attempt.estimate.toolSchemaTokens).toBeGreaterThan(0);
    expect(event.attempt.estimate.totalInputTokens).toBeGreaterThan(
      event.attempt.estimate.transcriptTokens,
    );
  });

  test('inspection and manual preflight consume one immutable prepared artifact', () => {
    const state = createInitialRuntimeState({
      threadId: 'prepared-manual-inspection',
      userId: 'user',
      workspace: '/workspace',
    });
    addStableSummarySource(state);
    const environment = { serializedTools: [], workflowSkills: [] };
    const capabilities = {
      providerName: 'manual',
      modelName: 'manual',
      contextWindowTokens: 10_000,
      contextWindowSource: 'explicit_config' as const,
      maxOutputTokens: 1_000,
      maxOutputTokensSource: 'explicit_config' as const,
      streaming: false,
    };
    const before = structuredClone(state);
    const prepared = prepareContextInspectionV2({
      state,
      config,
      capabilities,
      environment,
    });
    const report = buildContextStatusReport(state, config, environment, capabilities, prepared);
    const request = manualContextCompactionEvent({
      state,
      config,
      capabilities,
      projectionEnvironment: environment,
      preparedContextV2: prepared,
    });
    expect(prepared.next).toEqual({ kind: 'diagnostic_only' });
    expect(report.projection).toBe(prepared.effectiveProjection);
    expect(report.preflight).toBe(prepared.effectiveProjection.preflight);
    expect(
      request?.type === 'context.summary_requested_v1' ? request.attempt.estimate : undefined,
    ).toBe(prepared.effectiveProjection.estimate);
    expect(state).toEqual(before);
  });

  test('reset is not blocked by local token pressure', () => {
    const state = createInitialRuntimeState({
      threadId: 'reset-capacity',
      userId: 'user',
      workspace: '/workspace',
    });
    state.context.activeCheckpoint = { compactionId: 'checkpoint' } as never;
    expect(compactResetPreflight(state, config)).toEqual({ safe: true });
  });
});
