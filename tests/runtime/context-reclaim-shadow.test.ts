import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentConfig } from '@/core/config';
import { invokeRuntimeModel } from '@/core/controllers/model-controller';
import { aiMessage } from '@/core/messages';
import {
  createReclaimShadowCollector,
  type ReclaimShadowSampleV1,
} from '@/core/model/context-reclaim-shadow';
import { prepareRuntimeEffectForBudgetV1 } from '@/core/runtime/executor';
import { createInitialRuntimeState, type RuntimeState } from '@/core/runtime/state';
import { projectedModelContentDigest } from '@/core/tools/registry/projection';
import type { ToolResultBudgetReceiptV2 } from '@/core/tools/result-budget-v2';
import { createMockModel } from '../mock-model';

function verifiedReceipt(content: string): ToolResultBudgetReceiptV2 {
  return {
    version: 2,
    projectionMode: 'budget_v2',
    policyId: 'test-budget:v2',
    toolIdentity: 'builtin:read_file',
    bindingDigest: 'd'.repeat(64),
    projectorId: 'read-line-window:v1',
    projectorRevision: 'test-projector:v1',
    validatorId: 'test-validator:v1',
    rawResultDigest: 'a'.repeat(64),
    modelContentDigest: projectedModelContentDigest(content),
    modelContentUtf8Bytes: Buffer.byteLength(content, 'utf8'),
    continuation: { kind: 'line_byte_cursor_v2', status: 'completed' },
  };
}

function historicalToolState(workspace: string): RuntimeState {
  const state = createInitialRuntimeState({
    threadId: 'context-reclaim-shadow',
    userId: 'user',
    workspace,
  });
  const content = `1|${'large historical read result '.repeat(900)}`;
  state.transcript.messages = [
    {
      kind: 'assistant',
      messageId: 'assistant-old-read',
      turnId: 'historical-turn',
      ordinal: 0,
      createdAt: '2026-08-09T00:00:00.000Z',
      content: '',
      toolCalls: [{ id: 'read-old', name: 'read_file', args: { path: 'src/large.ts' } }],
    },
    {
      kind: 'tool',
      messageId: 'tool-read-old',
      turnId: 'historical-turn',
      ordinal: 1,
      createdAt: '2026-08-09T00:00:01.000Z',
      toolCallId: 'read-old',
      name: 'read_file',
      content,
      ok: true,
      resultMeta: {
        path: 'src/large.ts',
        totalLines: 900,
        rawResultDigest: 'a'.repeat(64),
        modelContentDigest: projectedModelContentDigest(content),
        digestScope: 'raw',
        toolResultReceipt: verifiedReceipt(content),
      },
    },
  ];
  state.tools.calls['read-old'] = {
    toolCallId: 'read-old',
    modelMessageId: 'assistant-old-read',
    name: 'read_file',
    args: { path: 'src/large.ts' },
    status: 'succeeded',
    createdAtTurnId: 'historical-turn',
    effectClass: 'read_only',
    sideEffect: false,
    result: {
      ok: true,
      summary: 'read',
      resultMeta: {
        path: 'src/large.ts',
        totalLines: 900,
        rawResultDigest: 'a'.repeat(64),
        modelContentDigest: projectedModelContentDigest(content),
        digestScope: 'raw',
        toolResultReceipt: verifiedReceipt(content),
      },
    },
  };
  return state;
}

function config(input?: {
  featureEnabled?: boolean;
  reclaimMode?: 'off' | 'shadow';
  withWindow?: boolean;
}): AgentConfig {
  return {
    apiKey: 'unused',
    baseURL: 'https://example.invalid',
    modelName: 'mock',
    providerName: 'mock',
    providerType: 'openai-compatible',
    sandbox: { enabled: false },
    features: { contextReclaimV1: input?.featureEnabled ?? true },
    ...(input?.withWindow === false
      ? {}
      : {
          modelCapabilities: {
            contextWindowTokens: 20_000,
            maxOutputTokens: 500,
          },
        }),
    compaction: {
      reclaimMode: input?.reclaimMode ?? 'shadow',
      warningRatio: 0.1,
      compactRatio: 0.9,
      hardRatio: 0.95,
    },
  };
}

function capturePrompt(model: ReturnType<typeof createMockModel>): {
  get(): string;
} {
  let prompt = '';
  const raw = model.model as unknown as {
    doGenerate(options: { prompt?: unknown }): Promise<unknown>;
  };
  const original = raw.doGenerate.bind(raw);
  raw.doGenerate = async (options) => {
    prompt = JSON.stringify(options.prompt);
    return original(options);
  };
  return { get: () => prompt };
}

describe('context reclaim shadow integration', () => {
  test('records sanitized warning-pressure evidence without changing Provider payload or calls', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-context-reclaim-shadow-'));
    try {
      const state = historicalToolState(workspace);
      const shadowModel = createMockModel([{ message: aiMessage({ content: 'done' }) }]);
      const offModel = createMockModel([{ message: aiMessage({ content: 'done' }) }]);
      const shadowPrompt = capturePrompt(shadowModel);
      const offPrompt = capturePrompt(offModel);
      const collector = createReclaimShadowCollector(4);
      const shadowConfig = config();
      const offConfig = config({ reclaimMode: 'off' });

      const shadowPrepared = prepareRuntimeEffectForBudgetV1({ type: 'call_model' }, state, {
        config: shadowConfig,
        model: shadowModel,
      });
      const offPrepared = prepareRuntimeEffectForBudgetV1({ type: 'call_model' }, state, {
        config: offConfig,
        model: offModel,
      });
      if (
        shadowPrepared.type !== 'call_model' ||
        !shadowPrepared.resourceEstimate ||
        offPrepared.type !== 'call_model' ||
        !offPrepared.resourceEstimate
      ) {
        throw new Error('Expected model resource preparation.');
      }
      expect(shadowPrepared.resourceEstimate).toEqual(offPrepared.resourceEstimate);
      const shadowEvents = await invokeRuntimeModel({
        model: shadowModel,
        state,
        config: shadowConfig,
        reclaimShadowReporter: collector,
        resourceAdmission: shadowPrepared.resourceEstimate,
      });
      const offEvents = await invokeRuntimeModel({
        model: offModel,
        state,
        config: offConfig,
        resourceAdmission: offPrepared.resourceEstimate,
      });

      expect(shadowModel.callCount.count).toBe(1);
      expect(offModel.callCount.count).toBe(1);
      expect(shadowPrompt.get()).toBe(offPrompt.get());
      expect(shadowEvents.map((event) => event.type)).toEqual(offEvents.map((event) => event.type));
      expect(shadowEvents.find((event) => event.type === 'model.context_metrics')).toMatchObject({
        type: 'model.context_metrics',
        totalInputTokens: shadowPrepared.resourceEstimate.inputTokens,
        status: 'warning',
      });
      expect(shadowEvents.some((event) => event.type.startsWith('context.compaction_'))).toBe(
        false,
      );

      expect(collector.snapshot()).toEqual([
        expect.objectContaining({
          policyId: 'context-reclaim:v1',
          policyVersion: 1,
          mode: 'shadow',
          rawInputTokens: shadowPrepared.resourceEstimate.inputTokens,
          candidateBlockCount: 0,
          candidateCallCount: 0,
          estimatedSavedChars: 0,
          estimatedSavedTokens: 0,
        }),
      ]);
      const serializedSample = JSON.stringify(collector.snapshot());
      expect(serializedSample).not.toContain('src/large.ts');
      expect(serializedSample).not.toContain('read-old');
      expect(serializedSample).not.toContain('aaaa');
      expect(serializedSample).not.toContain('large historical');
      expect(readdirSync(workspace)).toEqual([]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('forces effective off for a disabled flag, off mode, unknown window, or absent reporter', async () => {
    const state = historicalToolState('/workspace');
    for (const currentConfig of [
      config({ featureEnabled: false }),
      config({ reclaimMode: 'off' }),
      config({ withWindow: false }),
    ]) {
      const collector = createReclaimShadowCollector();
      const model = createMockModel([{ message: aiMessage({ content: 'done' }) }]);
      await invokeRuntimeModel({
        model,
        state,
        config: currentConfig,
        reclaimShadowReporter: collector,
      });
      expect(model.callCount.count).toBe(1);
      expect(collector.snapshot()).toEqual([]);
    }

    const normalConfig = config();
    normalConfig.modelCapabilities = {
      contextWindowTokens: 50_000,
      maxOutputTokens: 500,
    };
    normalConfig.compaction = {
      ...normalConfig.compaction,
      warningRatio: 0.99,
      compactRatio: 0.995,
      hardRatio: 0.999,
    };
    const normalCollector = createReclaimShadowCollector();
    const normalModel = createMockModel([{ message: aiMessage({ content: 'done' }) }]);
    const normalEvents = await invokeRuntimeModel({
      model: normalModel,
      state,
      config: normalConfig,
      reclaimShadowReporter: normalCollector,
    });
    expect(normalEvents.find((event) => event.type === 'model.context_metrics')).toMatchObject({
      status: 'normal',
    });
    expect(normalCollector.snapshot()).toEqual([]);

    const noReporterModel = createMockModel([{ message: aiMessage({ content: 'done' }) }]);
    await invokeRuntimeModel({
      model: noReporterModel,
      state,
      config: config(),
    });
    expect(noReporterModel.callCount.count).toBe(1);
  });

  test('collector is bounded, clearable, and drops fields outside the strict DTO', () => {
    const collector = createReclaimShadowCollector(2);
    for (let index = 0; index < 3; index++) {
      collector.record({
        policyId: 'context-reclaim:v1',
        policyVersion: 1,
        mode: 'shadow',
        rawInputTokens: index + 1,
        candidateBlockCount: 1,
        candidateCallCount: 1,
        estimatedSavedChars: 2,
        estimatedSavedTokens: 1,
        rejectionCounts: {},
        durationMs: 1,
        path: '/secret/path',
        digest: 'secret-digest',
        content: 'secret-content',
      } as ReclaimShadowSampleV1 & Record<string, unknown>);
    }
    expect(collector.snapshot().map((sample) => sample.rawInputTokens)).toEqual([2, 3]);
    expect(JSON.stringify(collector.snapshot())).not.toContain('secret');
    collector.clear();
    expect(collector.snapshot()).toEqual([]);

    const invalidCapacity = createReclaimShadowCollector(Number.NaN);
    invalidCapacity.record({
      policyId: 'context-reclaim:v1',
      policyVersion: 1,
      mode: 'shadow',
      rawInputTokens: 1,
      candidateBlockCount: 0,
      candidateCallCount: 0,
      estimatedSavedChars: 0,
      estimatedSavedTokens: 0,
      rejectionCounts: {},
      durationMs: 0,
    });
    invalidCapacity.record({
      policyId: 'context-reclaim:v1',
      policyVersion: 1,
      mode: 'shadow',
      rawInputTokens: 2,
      candidateBlockCount: 0,
      candidateCallCount: 0,
      estimatedSavedChars: 0,
      estimatedSavedTokens: 0,
      rejectionCounts: {},
      durationMs: 0,
    });
    expect(invalidCapacity.snapshot().map((sample) => sample.rawInputTokens)).toEqual([2]);
  });
});
