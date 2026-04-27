import { describe, expect, test } from "bun:test";
import { AIMessage } from "@langchain/core/messages";
import {
  extractPromptCacheMetrics,
  summarizePromptCacheMetricsByWorkspaceAccess,
} from "../src/shared/cache-metrics";
import { normalizeGraphStream } from "../src/app/runner";

// 验证从 AIMessage 响应中提取 prompt cache 指标 / Verify extracting prompt cache metrics from AIMessage responses
describe("extractPromptCacheMetrics", () => {
  // 验证能正确从 DeepSeek 响应元数据中提取缓存命中/未命中 token 数并计算命中率 / Verify extracting cache hit/miss tokens and hit rate from DeepSeek response metadata
  test("reads DeepSeek prompt cache hit and miss tokens from response metadata", () => {
    const message = new AIMessage({
      content: "ok",
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
  test("runner emits cache metrics events from streamed AI messages", async () => {
    const ai = new AIMessage({
      content: "done",
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
      yield { agent: { workspaceAccess: "write", messages: [ai], final: "done" } };
    }

    const events = [];
    for await (const event of normalizeGraphStream(stream())) {
      events.push(event);
    }

    // 检查事件流中应包含按工作区访问权限分类的 cache_metrics 事件 / Verify event stream contains access-specific cache_metrics event
    expect(events).toContainEqual({
      type: "cache_metrics",
      data: {
        workspaceAccess: "write",
        inputTokens: 100,
        cacheHitTokens: 80,
        cacheMissTokens: 20,
        hitRate: 0.8,
      },
    });
  });

  // 验证按工作区访问权限汇总多条缓存指标的聚合结果 / Verify aggregating cache metrics by workspace access
  test("summarizes prompt cache hit rate by workspace access", () => {
    // read-only 两条记录：100+300=400 输入 token, 25+225=250 命中, 75+75=150 未命中 / Two read-only entries
    // write 一条记录：200 输入 token, 50 命中, 150 未命中 / One write entry
    expect(
      summarizePromptCacheMetricsByWorkspaceAccess([
        {
          workspaceAccess: "read-only",
          inputTokens: 100,
          cacheHitTokens: 25,
          cacheMissTokens: 75,
          hitRate: 0.25,
        },
        {
          workspaceAccess: "read-only",
          inputTokens: 300,
          cacheHitTokens: 225,
          cacheMissTokens: 75,
          hitRate: 0.75,
        },
        {
          workspaceAccess: "write",
          inputTokens: 200,
          cacheHitTokens: 50,
          cacheMissTokens: 150,
          hitRate: 0.25,
        },
      ]),
    ).toEqual({
      "read-only": {
        inputTokens: 400,
        cacheHitTokens: 250,
        cacheMissTokens: 150,
        hitRate: 0.625,
      },
      write: {
        inputTokens: 200,
        cacheHitTokens: 50,
        cacheMissTokens: 150,
        hitRate: 0.25,
      },
    });
  });
});
