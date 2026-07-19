import { describe, expect, test } from 'bun:test';
import { humanMessage, systemMessage } from '../src/core/messages';
import {
  addToolSchemasToEstimate,
  estimateContextTokens,
  preflightModelContext,
} from '../src/core/model/context-budget';

describe('full request context estimator', () => {
  test('returns additive component totals including tool schemas and framing', () => {
    const base = estimateContextTokens({
      systemMessages: [systemMessage('stable system prompt')],
      transcriptMessages: [humanMessage('historical transcript')],
      summaryMessages: [humanMessage('checkpoint summary')],
      dynamicRuntimeMessages: [humanMessage('runtime mode and plan')],
    });
    const estimate = addToolSchemasToEstimate(base, {
      read_file: {
        description: 'Read a file',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
        execute: () => undefined,
      },
    });
    expect(estimate.systemTokens).toBeGreaterThan(0);
    expect(estimate.transcriptTokens).toBeGreaterThan(0);
    expect(estimate.summaryTokens).toBeGreaterThan(0);
    expect(estimate.dynamicRuntimeTokens).toBeGreaterThan(0);
    expect(estimate.toolSchemaTokens).toBeGreaterThan(0);
    expect(estimate.totalInputTokens).toBe(
      estimate.systemTokens +
        estimate.toolSchemaTokens +
        estimate.transcriptTokens +
        estimate.summaryTokens +
        estimate.dynamicRuntimeTokens +
        estimate.framingTokens,
    );
  });

  test('classifies utilization against five-level pressure thresholds', () => {
    const capabilities = {
      providerName: 'test',
      modelName: 'test',
      contextWindowTokens: 20_000,
      maxOutputTokens: 2_000,
      supportsUsageMetadata: false,
      supportsPromptCache: false,
    };
    const makeEstimate = (totalInputTokens: number) => ({
      systemTokens: totalInputTokens,
      toolSchemaTokens: 0,
      transcriptTokens: 0,
      summaryTokens: 0,
      dynamicRuntimeTokens: 0,
      framingTokens: 0,
      totalInputTokens,
    });
    // reservedOutputTokens = 2000, providerSafetyMarginTokens = max(1024, 200) = 1024
    // usableInputTokens = 20000 - 2000 - 1024 = 16976
    // 12000/16976 ≈ 0.707 → normal (< 0.80)
    expect(preflightModelContext({ estimate: makeEstimate(12_000), capabilities }).status).toBe(
      'normal',
    );
    // 14000/16976 ≈ 0.825 → warning (≥ 0.80)
    expect(preflightModelContext({ estimate: makeEstimate(14_000), capabilities }).status).toBe(
      'warning',
    );
    // 15200/16976 ≈ 0.895 → compact_due (≥ 0.88)
    expect(preflightModelContext({ estimate: makeEstimate(15_200), capabilities }).status).toBe(
      'compact_due',
    );
    // 16200/16976 ≈ 0.954 → hard_limit (≥ 0.94)
    expect(preflightModelContext({ estimate: makeEstimate(16_200), capabilities }).status).toBe(
      'hard_limit',
    );
  });

  test('reports unknown utilization when the context window is unknown', () => {
    const result = preflightModelContext({
      estimate: {
        systemTokens: 1,
        toolSchemaTokens: 1,
        transcriptTokens: 1,
        summaryTokens: 0,
        dynamicRuntimeTokens: 1,
        framingTokens: 4,
        totalInputTokens: 8,
      },
      capabilities: {
        providerName: 'custom',
        modelName: 'unknown',
        supportsUsageMetadata: false,
        supportsPromptCache: false,
      },
    });
    expect(result.status).toBe('unknown');
    expect(result.utilization).toBeUndefined();
  });
});
