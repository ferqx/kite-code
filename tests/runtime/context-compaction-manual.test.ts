import { describe, expect, test } from 'bun:test';
import type { AgentConfig } from '../../src/core/config';
import {
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
  compaction: { recentTurns: 1 },
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
      lastMessageId: 'message-1',
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

  test('hard-blocked sessions request manual_recovery instead of an unreachable manual compaction', () => {
    const state = createInitialRuntimeState({
      threadId: 'manual-recovery',
      userId: 'user',
      workspace: '/workspace',
    });
    state.context.hardBlock = {
      reason: 'hard_limit',
      sourceDigest: 'source',
      failure: {
        compactionId: 'failed',
        sourceRevision: state.revision,
        errorKind: 'insufficient_reduction',
        message: 'blocked',
        retryable: false,
        reason: 'auto_hard',
      },
      createdAtTurnId: state.turn.turnId,
    };
    const event = manualContextCompactionEvent({ state, config });
    expect(event).toMatchObject({ reason: 'manual_recovery', force: true });
  });

  test('persists the latest full preflight for inspection', () => {
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
      targetTokens: 4_400,
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
    expect(inspectManualContextCompaction(next, config).preflight).toMatchObject({
      usableInputTokens: 8_000,
      reservedOutputTokens: 1_000,
      providerSafetyMarginTokens: 1_000,
      targetTokens: 4_400,
      status: 'compact_due',
    });
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
    });
    expect(preflight.reservedOutputTokens).toBe(2_000);
    expect(preflight.usableInputTokens).toBe(28_976);
  });
});
