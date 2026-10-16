import { expect, test } from 'bun:test';
import type { ModelRequest } from '@kite-ai/ai';
import { estimateModelContext, projectModelContext } from '../../src/context-estimate';
import { recordedTokenUsage } from '../../src/token-usage';

const original: ModelRequest = {
  modelId: 'unknown/custom',
  requestId: 'old',
  tools: [],
  messages: [
    { role: 'system', content: 'stable instructions' },
    { role: 'user', content: 'original task' },
    { role: 'user', content: 'trailing runtime source', sourceIds: ['runtime'] },
  ],
};
const baseline = { executionId: 'measured', request: original, inputTokens: 50000 };
test('the measured input anchors new assistant/tool content inserted before trailing sources', () => {
  const added = [
    {
      role: 'assistant' as const,
      content: 'answer',
      toolCalls: [{ id: 'c', name: 'read', arguments: '{}' }],
    },
    { role: 'tool' as const, content: '完整🙂result', toolCallId: 'c' },
  ];
  const request = {
    ...original,
    messages: [...original.messages.slice(0, 2), ...added, original.messages[2]!],
  };
  expect(projectModelContext(request, baseline)).toEqual({
    source: 'reported_baseline',
    baselineExecutionId: 'measured',
    measuredInputTokens: 50000,
    estimatedInputTokens: estimateModelContext({ messages: added, tools: [] }).estimate
      .totalInputTokens,
    totalInputTokens:
      50000 + estimateModelContext({ messages: added, tools: [] }).estimate.totalInputTokens,
  });
  expect(projectModelContext(original, { ...baseline, inputTokens: 0 }).totalInputTokens).toBe(0);
});
test('changed model, source, tools, removed or reordered history cannot reuse a measured baseline', () => {
  const variants = [
    { ...original, modelId: 'other' },
    { ...original, messages: original.messages.slice(1) },
    { ...original, messages: [...original.messages].reverse() },
    {
      ...original,
      messages: [
        ...original.messages.slice(0, 2),
        { role: 'user' as const, content: 'changed source' },
      ],
    },
    { ...original, tools: [{ id: 'new', definitionVersion: '1', inputSchema: {} }] },
  ];
  for (const request of variants) {
    const result = projectModelContext(request, baseline);
    expect(result.source).toBe('local_estimate');
    expect(result.baselineExecutionId).toBeUndefined();
    expect(result.totalInputTokens).toBe(estimateModelContext(request).estimate.totalInputTokens);
  }
  for (const inputTokens of [-1, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1])
    expect(projectModelContext(original, { ...baseline, inputTokens }).source).toBe(
      'local_estimate',
    );
  expect(projectModelContext(original).source).toBe('local_estimate');
});
test('cumulative actual usage keeps partial coverage and zero without adding cache twice', () => {
  expect(
    recordedTokenUsage([
      { inputTokens: 10, outputTokens: 2, cachedInputTokens: 4 },
      { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
      { outputTokens: 3 },
      undefined,
    ]),
  ).toEqual({
    executionCount: 4,
    inputTokens: 10,
    outputTokens: 5,
    missingInputCount: 2,
    missingOutputCount: 1,
  });
  expect(
    recordedTokenUsage([{ inputTokens: Number.MAX_SAFE_INTEGER }, { inputTokens: 1 }]).inputTokens,
  ).toBeUndefined();
});
