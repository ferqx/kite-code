import { describe, expect, test } from 'bun:test';
import type { AgentConfig } from '../../src/core/config';
import {
  compactResetPreflight,
  currentContextPreflight,
  inspectManualContextCompaction,
  manualContextCompactionEvent,
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
    expect(manualContextCompactionEvent({ state, config })).toMatchObject({
      type: 'context.compaction_requested',
      reason: 'manual',
      force: false,
    });
  });

  test('custom instructions are carried through the request event', () => {
    const state = createInitialRuntimeState({
      threadId: 'manual-custom',
      userId: 'user',
      workspace: '/workspace',
    });
    const event = manualContextCompactionEvent({
      state,
      config,
      customInstructions: 'focus on auth module changes',
    });
    expect(event).toMatchObject({
      type: 'context.compaction_requested',
      reason: 'manual',
      force: false,
      customInstructions: 'focus on auth module changes',
    });
    // No custom instructions → field absent
    const plain = manualContextCompactionEvent({ state, config });
    expect(plain).not.toHaveProperty('customInstructions');
  });

  test('manual requests never gain force semantics from a correctness hard block', () => {
    const state = createInitialRuntimeState({
      threadId: 'manual-recovery',
      userId: 'user',
      workspace: '/workspace',
    });
    state.context.hardBlock = {
      reason: 'runtime_invariant_violation',
      sourceDigest: 'source',
      message: 'blocked',
      createdAtTurnId: state.turn.turnId,
    };
    const event = manualContextCompactionEvent({ state, config });
    expect(event).toMatchObject({ reason: 'manual', force: false });
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
