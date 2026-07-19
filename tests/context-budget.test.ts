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

  test('classifies utilization against soft and hard ratios', () => {
    const capabilities = {
      providerName: 'test',
      modelName: 'test',
      contextWindowTokens: 10_000,
      maxOutputTokens: 1_000,
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
    expect(preflightModelContext({ estimate: makeEstimate(6_000), capabilities }).status).toBe(
      'soft',
    );
    expect(preflightModelContext({ estimate: makeEstimate(7_500), capabilities }).status).toBe(
      'hard',
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
