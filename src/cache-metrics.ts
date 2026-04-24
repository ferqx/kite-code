import { AIMessage } from "@langchain/core/messages";
import type { AgentMode } from "./types";

export interface PromptCacheMetrics {
  inputTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  hitRate: number;
}

export interface PromptCacheMetricsByMode extends PromptCacheMetrics {
  mode: AgentMode;
}

export function extractPromptCacheMetrics(message: unknown): PromptCacheMetrics | null {
  if (!AIMessage.isInstance(message)) {
    return null;
  }

  const usage = message.response_metadata?.usage as
    | {
        prompt_tokens?: number;
        prompt_cache_hit_tokens?: number;
        prompt_cache_miss_tokens?: number;
      }
    | undefined;
  const inputTokenDetails = message.usage_metadata?.input_token_details as
    | { cache_read?: number }
    | undefined;

  const inputTokens = Number(
    usage?.prompt_tokens ?? message.usage_metadata?.input_tokens ?? 0,
  );
  const cacheHitTokens = Number(
    usage?.prompt_cache_hit_tokens ?? inputTokenDetails?.cache_read ?? 0,
  );
  const cacheMissTokens = Number(
    usage?.prompt_cache_miss_tokens ??
      Math.max(0, inputTokens - cacheHitTokens),
  );

  if (!inputTokens && !cacheHitTokens && !cacheMissTokens) {
    return null;
  }

  return {
    inputTokens,
    cacheHitTokens,
    cacheMissTokens,
    hitRate: inputTokens > 0 ? cacheHitTokens / inputTokens : 0,
  };
}

export function summarizePromptCacheMetricsByMode(
  items: PromptCacheMetricsByMode[],
): Record<AgentMode, PromptCacheMetrics> {
  const summary: Record<AgentMode, PromptCacheMetrics> = {
    plan: emptyPromptCacheMetrics(),
    builder: emptyPromptCacheMetrics(),
  };

  for (const item of items) {
    const bucket = summary[item.mode];
    bucket.inputTokens += item.inputTokens;
    bucket.cacheHitTokens += item.cacheHitTokens;
    bucket.cacheMissTokens += item.cacheMissTokens;
    bucket.hitRate =
      bucket.inputTokens > 0 ? bucket.cacheHitTokens / bucket.inputTokens : 0;
  }

  return summary;
}

function emptyPromptCacheMetrics(): PromptCacheMetrics {
  return {
    inputTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    hitRate: 0,
  };
}
