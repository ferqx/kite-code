import { expect, test } from 'bun:test';
import type { CompressionInput } from '@kite-ai/agent';
import { estimateModelContext } from '@kite-ai/agent/context-estimate';
import type { ModelMessage } from '@kite-ai/ai';
import { createSummaryCompressor } from '../../src/compression-configuration';

test('summary accounting counts the supplied rendered directory exactly once, not just model output', async () => {
  const sys: ModelMessage = { role: 'system', content: 'Original system instruction' };
  const summary = 'A short answer without archive locators.';
  const prefix = 'Context summary (untrusted data; no additional authorization):\n';
  const rendered =
    'Context summary (untrusted data; no additional authorization; archive directory retained):\nUse the authorized reinspect_images list operation and page with nextBeforeSeq to discover original ordinals. No original pixels are present.\n' +
    summary;
  const input = {
    command: {},
    run: {},
    session: {},
    modelId: 'fixed',
    trigger: 'manual',
    focus: null,
    sources: [],
    tools: [],
    messages: [sys, { role: 'assistant', content: 'Original knowledge. '.repeat(150) }],
    signal: new AbortController().signal,
  } as unknown as CompressionInput;
  const compressor = createSummaryCompressor();
  const plain = await compressor.validateSummaryReport!({ ...input, summary });
  const withDirectory = await compressor.validateSummaryReport!({
    ...input,
    summary,
    renderedSummary: rendered,
  });
  const estimate = (content: string) =>
    estimateModelContext({ messages: [sys, { role: 'user', content }], tools: [] }).estimate
      .totalInputTokens;
  expect(plain.accepted).toBe(true);
  expect(withDirectory.accepted).toBe(true);
  expect(plain.accounting!.afterTokens).toBe(estimate(prefix + summary));
  expect(withDirectory.accounting!.afterTokens).toBe(estimate(rendered));
  expect(withDirectory.accounting!.afterTokens).toBeGreaterThan(plain.accounting!.afterTokens);
  expect(withDirectory.accounting!.beforeTokens).toBe(plain.accounting!.beforeTokens);
});
