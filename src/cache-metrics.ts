import { AIMessage } from "@langchain/core/messages";

export interface PromptCacheMetrics {
  inputTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
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
  };
}
