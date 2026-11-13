import { expect, test } from '#kite-test';
import { compressionPresentationSchema, toolResultPresentationSchema } from '../src';

test('compression observation is optional, finite and closed; local comparison never masquerades as usage', () => {
  expect(compressionPresentationSchema.parse({ adopted: false })).toEqual({ adopted: false });
  const recorded = {
    adopted: true,
    accounting: { basis: 'local-context-estimate-v1', beforeTokens: 1000, afterTokens: 300 },
    triggerTokens: 800,
    triggerBasis: 'reported_baseline',
    measuredInputTokens: 700,
    estimatedInputTokens: 100,
  } as const;
  expect(compressionPresentationSchema.parse(recorded)).toEqual(recorded);
  for (const accounting of [
    { basis: 'provider-usage', beforeTokens: 1000, afterTokens: 300 },
    { basis: 'local-context-estimate-v1', beforeTokens: -1, afterTokens: 300 },
    { basis: 'local-context-estimate-v1', beforeTokens: 1.5, afterTokens: 300 },
    {
      basis: 'local-context-estimate-v1',
      beforeTokens: Number.MAX_SAFE_INTEGER + 1,
      afterTokens: 300,
    },
    { basis: 'local-context-estimate-v1', beforeTokens: 1000, afterTokens: NaN },
    { basis: 'local-context-estimate-v1', beforeTokens: 1000, afterTokens: 300, private: 'NO' },
  ])
    expect(compressionPresentationSchema.safeParse({ adopted: true, accounting }).success).toBe(
      false,
    );
  expect(compressionPresentationSchema.safeParse({ ...recorded, inputTokens: 999 }).success).toBe(
    false,
  );
});

test('typed Tool presentation rejects arbitrary details, guessed media sources and private metadata', () => {
  expect(
    toolResultPresentationSchema.parse({
      kind: 'browser',
      operation: 'snapshot',
      text: 'original',
    }),
  ).toEqual({ kind: 'browser', operation: 'snapshot', text: 'original' });
  for (const item of [
    { kind: 'browser', operation: 'snapshot', src: 'file:///private/current.png' },
    { kind: 'shell', operation: 'read', authorization: { allowed: true } },
    { kind: 'task', operation: 'spawn', configuration: { private: 'NO' } },
    { kind: 'file', operation: 'read', details: { private: 'NO' } },
    { kind: 'future_unknown', content: 'unknown' },
  ])
    expect(toolResultPresentationSchema.safeParse(item).success).toBe(false);
});
