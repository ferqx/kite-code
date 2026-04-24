import { describe, expect, test } from "bun:test";
import { AIMessage } from "@langchain/core/messages";
import {
  extractPromptCacheMetrics,
  summarizePromptCacheMetricsByMode,
} from "../src/cache-metrics";
import { normalizeGraphStream } from "../src/runner";

describe("extractPromptCacheMetrics", () => {
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

    expect(extractPromptCacheMetrics(message)).toEqual({
      inputTokens: 1000,
      cacheHitTokens: 768,
      cacheMissTokens: 232,
      hitRate: 0.768,
    });
  });

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

    async function* stream() {
      yield { agent: { mode: "builder", messages: [ai], final: "done" } };
    }

    const events = [];
    for await (const event of normalizeGraphStream(stream())) {
      events.push(event);
    }

    expect(events).toContainEqual({
      type: "cache_metrics",
      data: {
        mode: "builder",
        inputTokens: 100,
        cacheHitTokens: 80,
        cacheMissTokens: 20,
        hitRate: 0.8,
      },
    });
  });

  test("summarizes prompt cache hit rate by agent mode", () => {
    expect(
      summarizePromptCacheMetricsByMode([
        {
          mode: "plan",
          inputTokens: 100,
          cacheHitTokens: 25,
          cacheMissTokens: 75,
          hitRate: 0.25,
        },
        {
          mode: "plan",
          inputTokens: 300,
          cacheHitTokens: 225,
          cacheMissTokens: 75,
          hitRate: 0.75,
        },
        {
          mode: "builder",
          inputTokens: 200,
          cacheHitTokens: 50,
          cacheMissTokens: 150,
          hitRate: 0.25,
        },
      ]),
    ).toEqual({
      plan: {
        inputTokens: 400,
        cacheHitTokens: 250,
        cacheMissTokens: 150,
        hitRate: 0.625,
      },
      builder: {
        inputTokens: 200,
        cacheHitTokens: 50,
        cacheMissTokens: 150,
        hitRate: 0.25,
      },
    });
  });
});
