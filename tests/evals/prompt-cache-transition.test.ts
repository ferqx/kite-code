import { expect, test } from 'bun:test';
import {
  assessPromptCacheTransition,
  runPromptCacheTransitionEval,
} from '@/../scripts/evals/prompt-cache-transition';

test('requires a stable declaration and the canonical 95% measured cache target', () => {
  expect(
    assessPromptCacheTransition({
      declarationsStable: true,
      observations: [
        {
          phase: 'planning',
          isWarmup: true,
          inputTokens: 5_000,
          cacheReadTokens: 0,
          cacheMissTokens: 5_000,
          hitRate: 0,
        },
        {
          phase: 'building',
          isWarmup: true,
          inputTokens: 5_000,
          cacheReadTokens: 1_000,
          cacheMissTokens: 4_000,
          hitRate: 0.2,
        },
        {
          phase: 'planning',
          isWarmup: false,
          inputTokens: 5_000,
          cacheReadTokens: 4_800,
          cacheMissTokens: 200,
          hitRate: 0.96,
        },
        {
          phase: 'building',
          isWarmup: false,
          inputTokens: 5_000,
          cacheReadTokens: 4_800,
          cacheMissTokens: 200,
          hitRate: 0.96,
        },
      ],
    }),
  ).toMatchObject({ status: 'passed', hitRate: 0.96, targetHitRate: 0.95, failures: [] });
});

test('fails closed when phase declarations drift even if Provider caching is high', () => {
  expect(
    assessPromptCacheTransition({
      declarationsStable: false,
      minimumMeasuredInputTokens: 1,
      observations: [
        {
          phase: 'planning',
          isWarmup: true,
          inputTokens: 100,
          cacheReadTokens: 0,
          cacheMissTokens: 100,
          hitRate: 0,
        },
        {
          phase: 'building',
          isWarmup: true,
          inputTokens: 100,
          cacheReadTokens: 100,
          cacheMissTokens: 0,
          hitRate: 1,
        },
        {
          phase: 'building',
          isWarmup: false,
          inputTokens: 100,
          cacheReadTokens: 100,
          cacheMissTokens: 0,
          hitRate: 1,
        },
        {
          phase: 'planning',
          isWarmup: false,
          inputTokens: 100,
          cacheReadTokens: 100,
          cacheMissTokens: 0,
          hitRate: 1,
        },
      ],
    }).failures,
  ).toContain('phase_tool_declarations_changed');
});

test('is opt-in and does not contact the Provider by default', async () => {
  await expect(runPromptCacheTransitionEval({ live: false })).resolves.toMatchObject({
    schema: 'PromptCacheTransitionEvalV1',
    status: 'live_eval_skipped',
    targetHitRate: 0.95,
    contentLogged: false,
  });
});
