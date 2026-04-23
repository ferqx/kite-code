import { describe, expect, test } from "bun:test";
import { AIMessage } from "@langchain/core/messages";
import { extractPromptCacheMetrics } from "../src/cache-metrics";

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
    });
  });
});
