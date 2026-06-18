import { describe, expect, test } from 'bun:test';
import { AIMessage } from '@langchain/core/messages';
import {
  createPromptCacheStandardTracker,
  extractPromptCacheMetrics,
} from '../src/core/cache-metrics';
import { normalizeGraphStream } from '../src/core/runner';

// 验证从 AIMessage 响应中提取 prompt cache 指标 / Verify extracting prompt cache metrics from AIMessage responses
describe('extractPromptCacheMetrics', () => {
  // 验证能正确从 DeepSeek 响应元数据中提取缓存命中/未命中 token 数并计算命中率 / Verify extracting cache hit/miss tokens and hit rate from DeepSeek response metadata
  test('reads DeepSeek prompt cache hit and miss tokens from response metadata', () => {
    const message = new AIMessage({
      content: 'ok',
      response_metadata: {
        usage: {
          prompt_tokens: 1000,
          prompt_cache_hit_tokens: 768,
          prompt_cache_miss_tokens: 232,
        },
      },
    });

    // 检查提取的缓存指标（包括命中率 768/1000=0.768）/ Verify extracted cache metrics (including hit rate 768/1000=0.768)
    expect(extractPromptCacheMetrics(message)).toEqual({
      inputTokens: 1000,
      cacheHitTokens: 768,
      cacheMissTokens: 232,
      hitRate: 0.768,
    });
  });

  // 验证 normalizeGraphStream 在流式处理 AI 消息时会发出 cache_metrics 事件 / Verify normalizeGraphStream emits cache_metrics events when processing streamed AI messages
  test('runner emits cache metrics events from streamed AI messages', async () => {
    const ai = new AIMessage({
      content: 'done',
      response_metadata: {
        usage: {
          prompt_tokens: 100,
          prompt_cache_hit_tokens: 80,
          prompt_cache_miss_tokens: 20,
        },
      },
    });

    // 模拟图流输出，包含工作区访问权限信息和 AI 消息 / Simulate graph stream output with workspace access info and AI message
    async function* stream() {
      yield { agent: { workspaceAccess: 'write', messages: [ai], final: 'done' } };
    }

    const events = [];
    for await (const event of normalizeGraphStream(stream())) {
      events.push(event);
    }

    // 检查事件流中应包含按工作区访问权限分类的 cache_metrics 事件，并附带缓存标准评估 / Verify cache_metrics event includes standard evaluation
    expect(events).toContainEqual({
      type: 'cache_metrics',
      data: {
        workspaceAccess: 'write',
        inputTokens: 100,
        cacheHitTokens: 80,
        cacheMissTokens: 20,
        hitRate: 0.8,
        outputTokens: 0,
        cacheWriteTokens: 0,
        standard: {
          callIndex: 1,
          isWarmup: true,
          includedInStandard: false,
          targetHitRate: 0.95,
          minimumMeasuredInputTokens: 8000,
          summary: {
            totalCalls: 1,
            warmupCalls: 1,
            measuredCalls: 0,
            inputTokens: 0,
            cacheHitTokens: 0,
            cacheMissTokens: 0,
            hitRate: 0,
            targetHitRate: 0.95,
            minimumMeasuredInputTokens: 8000,
            hasEnoughMeasuredTokens: false,
            meetsTarget: null,
          },
        },
      },
    });
  });

  // 验证缓存命中标准跳过第一条 warmup，并用后续 token 加权命中率判断是否达到 95% / Verify cache standard excludes warmup and uses token-weighted hit rate
  test('evaluates the 95 percent cache standard on cache_metrics events', async () => {
    const cold = new AIMessage({
      content: 'inspect',
      response_metadata: {
        usage: {
          prompt_tokens: 100,
          prompt_cache_hit_tokens: 0,
          prompt_cache_miss_tokens: 100,
        },
      },
    });
    const warm = new AIMessage({
      content: 'continue',
      response_metadata: {
        usage: {
          prompt_tokens: 300,
          prompt_cache_hit_tokens: 285,
          prompt_cache_miss_tokens: 15,
        },
      },
    });

    async function* stream() {
      yield { agent: { workspaceAccess: 'write', messages: [cold] } };
      yield { agent: { workspaceAccess: 'write', messages: [warm], final: 'done' } };
    }

    const cacheEvents = [];
    for await (const event of normalizeGraphStream(stream())) {
      if (event.type === 'cache_metrics') {
        cacheEvents.push(event.data);
      }
    }

    expect(cacheEvents).toEqual([
      {
        workspaceAccess: 'write',
        inputTokens: 100,
        cacheHitTokens: 0,
        cacheMissTokens: 100,
        hitRate: 0,
        outputTokens: 0,
        cacheWriteTokens: 0,
        standard: {
          callIndex: 1,
          isWarmup: true,
          includedInStandard: false,
          targetHitRate: 0.95,
          minimumMeasuredInputTokens: 8000,
          summary: {
            totalCalls: 1,
            warmupCalls: 1,
            measuredCalls: 0,
            inputTokens: 0,
            cacheHitTokens: 0,
            cacheMissTokens: 0,
            hitRate: 0,
            targetHitRate: 0.95,
            minimumMeasuredInputTokens: 8000,
            hasEnoughMeasuredTokens: false,
            meetsTarget: null,
          },
        },
      },
      {
        workspaceAccess: 'write',
        inputTokens: 300,
        cacheHitTokens: 285,
        cacheMissTokens: 15,
        hitRate: 0.95,
        outputTokens: 0,
        cacheWriteTokens: 0,
        standard: {
          callIndex: 2,
          isWarmup: false,
          includedInStandard: true,
          targetHitRate: 0.95,
          minimumMeasuredInputTokens: 8000,
          summary: {
            totalCalls: 2,
            warmupCalls: 1,
            measuredCalls: 1,
            inputTokens: 300,
            cacheHitTokens: 285,
            cacheMissTokens: 15,
            hitRate: 0.95,
            targetHitRate: 0.95,
            minimumMeasuredInputTokens: 8000,
            hasEnoughMeasuredTokens: false,
            meetsTarget: null,
          },
        },
      },
    ]);
  });

  // 验证小样本不直接给出达标结论，避免短对话误导缓存标准 / Verify short samples do not produce a pass/fail standard result
  test('requires enough measured input tokens before judging the cache standard', () => {
    const tracker = createPromptCacheStandardTracker();

    tracker.record({
      inputTokens: 1000,
      cacheHitTokens: 0,
      cacheMissTokens: 1000,
      hitRate: 0,
    });

    const shortSample = tracker.record({
      inputTokens: 4000,
      cacheHitTokens: 4000,
      cacheMissTokens: 0,
      hitRate: 1,
    });

    expect(shortSample.summary).toMatchObject({
      inputTokens: 4000,
      cacheHitTokens: 4000,
      hitRate: 1,
      minimumMeasuredInputTokens: 8000,
      hasEnoughMeasuredTokens: false,
      meetsTarget: null,
    });

    const largeSample = tracker.record({
      inputTokens: 5000,
      cacheHitTokens: 4600,
      cacheMissTokens: 400,
      hitRate: 0.92,
    });

    expect(largeSample.summary).toMatchObject({
      inputTokens: 9000,
      cacheHitTokens: 8600,
      hitRate: 8600 / 9000,
      minimumMeasuredInputTokens: 8000,
      hasEnoughMeasuredTokens: true,
      meetsTarget: true,
    });
  });

  // 验证标准跟踪器按 token 加权聚合，而不是按请求平均 / Verify standard tracker aggregates by tokens, not request average
  test('tracks the cache standard with weighted token totals', () => {
    const tracker = createPromptCacheStandardTracker({
      minimumMeasuredInputTokens: 0,
    });

    tracker.record({
      inputTokens: 100,
      cacheHitTokens: 0,
      cacheMissTokens: 100,
      hitRate: 0,
    });
    tracker.record({
      inputTokens: 100,
      cacheHitTokens: 50,
      cacheMissTokens: 50,
      hitRate: 0.5,
    });

    expect(
      tracker.record({
        inputTokens: 900,
        cacheHitTokens: 900,
        cacheMissTokens: 0,
        hitRate: 1,
      }),
    ).toEqual({
      callIndex: 3,
      isWarmup: false,
      includedInStandard: true,
      targetHitRate: 0.95,
      minimumMeasuredInputTokens: 0,
      summary: {
        totalCalls: 3,
        warmupCalls: 1,
        measuredCalls: 2,
        inputTokens: 1000,
        cacheHitTokens: 950,
        cacheMissTokens: 50,
        hitRate: 0.95,
        targetHitRate: 0.95,
        minimumMeasuredInputTokens: 0,
        hasEnoughMeasuredTokens: true,
        meetsTarget: true,
      },
    });
  });
});
