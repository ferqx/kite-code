import { AIMessage } from '@langchain/core/messages';
import type {
  PromptCacheMetrics,
  PromptCacheStandardEvaluation,
  PromptCacheStandardSummary,
} from '@/protocol/events';

// Re-export protocol types for backward compatibility
export type { PromptCacheMetrics, PromptCacheStandardEvaluation, PromptCacheStandardSummary };

/** coding 场景 prompt cache 命中率目标 / Prompt cache target for coding scenarios */
export const PROMPT_CACHE_STANDARD_TARGET_HIT_RATE = 0.95;

/** 默认跳过的 warmup 调用数量 / Default warmup calls excluded from standard evaluation */
const DEFAULT_PROMPT_CACHE_WARMUP_CALLS = 1;

/** 默认最小有效样本 token 数，避免短对话误判 / Default minimum measured tokens to avoid short-context misjudgment */
const DEFAULT_PROMPT_CACHE_MINIMUM_MEASURED_INPUT_TOKENS = 8000;

/** prompt cache 标准跟踪器 / Prompt cache standard tracker */
export interface PromptCacheStandardTracker {
  /** 记录一次 provider 返回的缓存指标 / Record one provider cache metric observation */
  record(metrics: PromptCacheMetrics): PromptCacheStandardEvaluation;
}

/** 创建 prompt cache 标准跟踪器 / Create prompt cache standard tracker */
export function createPromptCacheStandardTracker(input?: {
  /** 目标命中率 / Target hit rate */
  targetHitRate?: number;
  /** 跳过的 warmup 调用数 / Warmup call count to exclude */
  warmupCalls?: number;
  /** 最小有效计入输入 token 数 / Minimum measured input tokens before judging */
  minimumMeasuredInputTokens?: number;
}): PromptCacheStandardTracker {
  const targetHitRate = input?.targetHitRate ?? PROMPT_CACHE_STANDARD_TARGET_HIT_RATE;
  const warmupCallLimit = input?.warmupCalls ?? DEFAULT_PROMPT_CACHE_WARMUP_CALLS;
  const minimumMeasuredInputTokens =
    input?.minimumMeasuredInputTokens ?? DEFAULT_PROMPT_CACHE_MINIMUM_MEASURED_INPUT_TOKENS;
  const totals = {
    totalCalls: 0,
    warmupCalls: 0,
    measuredCalls: 0,
    inputTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
  };

  return {
    record(metrics: PromptCacheMetrics): PromptCacheStandardEvaluation {
      totals.totalCalls += 1;
      const callIndex = totals.totalCalls;
      const isWarmup = callIndex <= warmupCallLimit;
      const includedInStandard = !isWarmup;

      if (isWarmup) {
        totals.warmupCalls += 1;
      } else {
        totals.measuredCalls += 1;
        totals.inputTokens += metrics.inputTokens;
        totals.cacheHitTokens += metrics.cacheHitTokens;
        totals.cacheMissTokens += metrics.cacheMissTokens;
      }

      const hitRate = totals.inputTokens > 0 ? totals.cacheHitTokens / totals.inputTokens : 0;
      const hasEnoughMeasuredTokens = totals.inputTokens >= minimumMeasuredInputTokens;
      const meetsTarget =
        totals.measuredCalls > 0 && hasEnoughMeasuredTokens ? hitRate >= targetHitRate : null;

      return {
        callIndex,
        isWarmup,
        includedInStandard,
        targetHitRate,
        minimumMeasuredInputTokens,
        summary: {
          totalCalls: totals.totalCalls,
          warmupCalls: totals.warmupCalls,
          measuredCalls: totals.measuredCalls,
          inputTokens: totals.inputTokens,
          cacheHitTokens: totals.cacheHitTokens,
          cacheMissTokens: totals.cacheMissTokens,
          hitRate,
          targetHitRate,
          minimumMeasuredInputTokens,
          hasEnoughMeasuredTokens,
          meetsTarget,
        },
      };
    },
  };
}
export function extractPromptCacheMetrics(message: unknown): PromptCacheMetrics | null {
  if (!AIMessage.isInstance(message)) {
    return null;
  }

  const usage = message.response_metadata?.usage as
    | {
        prompt_tokens?: number;
        input_tokens?: number;
        prompt_cache_hit_tokens?: number;
        prompt_cache_miss_tokens?: number;
      }
    | undefined;
  const inputTokenDetails = message.usage_metadata?.input_token_details as
    | { cache_read?: number }
    | undefined;

  // 优先从 response_metadata.usage 取 prompt_tokens (OpenAI) 或 input_tokens (Anthropic/DeepSeek v4)，
  // 其次从 usage_metadata.input_tokens (LangChain 标准字段) 取
  // Prefer response_metadata.usage.prompt_tokens (OpenAI) or input_tokens (Anthropic/DeepSeek v4),
  // fall back to usage_metadata.input_tokens (LangChain standard)
  const inputTokens = Number(
    usage?.prompt_tokens ?? usage?.input_tokens ?? message.usage_metadata?.input_tokens ?? 0,
  );
  const cacheHitTokens = Number(
    usage?.prompt_cache_hit_tokens ?? inputTokenDetails?.cache_read ?? 0,
  );
  const cacheMissTokens = Number(
    usage?.prompt_cache_miss_tokens ??
      (inputTokens > cacheHitTokens ? inputTokens - cacheHitTokens : 0),
  );

  // 当 provider 同时返回 hit/miss 字段时，用两者之和作为总输入 token，绕过 prompt_tokens 在不同 provider 下含义不一致的问题
  // Use hit+miss as authoritative total when both fields are present, avoiding provider-specific prompt_tokens semantics
  const totalInputTokens =
    usage?.prompt_cache_hit_tokens != null || usage?.prompt_cache_miss_tokens != null
      ? cacheHitTokens + cacheMissTokens
      : inputTokens;

  // 三项均为零视为无效（非 LLM 消息） / Return null if all three are zero (not an LLM message)
  if (!totalInputTokens && !cacheHitTokens && !cacheMissTokens) {
    return null;
  }

  return {
    inputTokens: totalInputTokens,
    cacheHitTokens,
    cacheMissTokens,
    // 避免除零 / Avoid division by zero
    hitRate: totalInputTokens > 0 ? cacheHitTokens / totalInputTokens : 0,
  };
}
