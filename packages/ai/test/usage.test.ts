import { expect, test } from 'bun:test';
import { compatibleModelUsage } from '../src/usage';

test('reported zero takes precedence over a legacy cache alias and absent measurements stay unknown', () => {
  expect(
    compatibleModelUsage({
      prompt_tokens: 100,
      completion_tokens: 0,
      prompt_tokens_details: { cached_tokens: 0 },
      prompt_cache_hit_tokens: 50,
    }),
  ).toMatchObject({ inputTokens: 100, outputTokens: 0, cachedInputTokens: 0 });
  expect(compatibleModelUsage(undefined)).toEqual({ inputTokens: null, outputTokens: null });
  const partial = compatibleModelUsage({ completion_tokens: 7 });
  expect(partial).toEqual({ inputTokens: null, outputTokens: 7, raw: { completion_tokens: 7 } });
  expect(partial.totalTokens).toBeUndefined();
});

test('invalid normalized counts stay unknown while the original usage remains available for inspection', () => {
  const raw = {
    prompt_tokens: -1,
    completion_tokens: 1.5,
    total_tokens: Number.MAX_SAFE_INTEGER + 1,
    prompt_cache_hit_tokens: -2,
    completion_tokens_details: { reasoning_tokens: -3 },
  };
  expect(compatibleModelUsage(raw)).toEqual({ inputTokens: null, outputTokens: null, raw });
  const inconsistent = compatibleModelUsage({
    prompt_tokens: 10,
    completion_tokens: 5,
    prompt_tokens_details: { cached_tokens: 11 },
    completion_tokens_details: { reasoning_tokens: 6 },
  });
  expect(inconsistent.cachedInputTokens).toBeUndefined();
  expect(inconsistent.reasoningTokens).toBeUndefined();
});
