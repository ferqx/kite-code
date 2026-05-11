import { AIMessage } from "@langchain/core/messages";
import type { WorkspaceAccess } from "../protocol/events";

/** 提示缓存命中指标 / Prompt cache hit metrics */
export interface PromptCacheMetrics {
  /** 输入 token 数 / Input token count */
  inputTokens: number;
  /** 缓存命中 token 数 / Cache hit token count */
  cacheHitTokens: number;
  /** 缓存未命中 token 数 / Cache miss token count */
  cacheMissTokens: number;
  /** 缓存命中率 / Cache hit rate (0-1) */
  hitRate: number;
}

/** coding 场景 prompt cache 命中率目标 / Prompt cache target for coding scenarios */
export const PROMPT_CACHE_STANDARD_TARGET_HIT_RATE = 0.95;

/** 默认跳过的 warmup 调用数量 / Default warmup calls excluded from standard evaluation */
const DEFAULT_PROMPT_CACHE_WARMUP_CALLS = 1;

/** 默认最小有效样本 token 数，避免短对话误判 / Default minimum measured tokens to avoid short-context misjudgment */
const DEFAULT_PROMPT_CACHE_MINIMUM_MEASURED_INPUT_TOKENS = 8000;

/** prompt cache 标准汇总 / Prompt cache standard summary */
export interface PromptCacheStandardSummary extends PromptCacheMetrics {
  /** 已观察到的缓存指标调用数 / Observed metric call count */
  totalCalls: number;
  /** 被视为 warmup 的调用数 / Calls treated as warmup */
  warmupCalls: number;
  /** 计入标准判断的调用数 / Calls included in standard evaluation */
  measuredCalls: number;
  /** 目标命中率 / Target hit rate */
  targetHitRate: number;
  /** 最小有效计入输入 token 数 / Minimum measured input tokens before judging */
  minimumMeasuredInputTokens: number;
  /** 当前样本量是否足够判断 / Whether measured token volume is enough to judge */
  hasEnoughMeasuredTokens: boolean;
  /** 是否达到目标；无计入调用时为 null / Whether target is met; null when no measured calls exist */
  meetsTarget: boolean | null;
}

/** 单次 cache_metrics 事件上的标准评估 / Standard evaluation attached to one cache_metrics event */
export interface PromptCacheStandardEvaluation {
  /** 当前缓存指标调用序号，从 1 开始 / Current metric call index, starting from 1 */
  callIndex: number;
  /** 当前调用是否为 warmup / Whether current call is warmup */
  isWarmup: boolean;
  /** 当前调用是否计入标准判断 / Whether current call is included in standard evaluation */
  includedInStandard: boolean;
  /** 目标命中率 / Target hit rate */
  targetHitRate: number;
  /** 最小有效计入输入 token 数 / Minimum measured input tokens before judging */
  minimumMeasuredInputTokens: number;
  /** 当前 run 的累计标准汇总 / Accumulated standard summary for current run */
  summary: PromptCacheStandardSummary;
}

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
    input?.minimumMeasuredInputTokens ??
    DEFAULT_PROMPT_CACHE_MINIMUM_MEASURED_INPUT_TOKENS;
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

      const hitRate =
        totals.inputTokens > 0 ? totals.cacheHitTokens / totals.inputTokens : 0;
      const hasEnoughMeasuredTokens =
        totals.inputTokens >= minimumMeasuredInputTokens;
      const meetsTarget =
        totals.measuredCalls > 0 && hasEnoughMeasuredTokens
          ? hitRate >= targetHitRate
          : null;

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

/** 按工作区访问权限分组的缓存指标 / Cache metrics grouped by workspace access */
export interface PromptCacheMetricsByWorkspaceAccess extends PromptCacheMetrics {
  /** 工作区访问权限 / Workspace access */
  workspaceAccess: WorkspaceAccess;
}

/** 从 AIMessage 元数据中提取 provider 缓存指标 / Extract provider cache metrics from AIMessage metadata */
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

/** 按工作区访问权限汇总缓存指标 / Summarize cache metrics by workspace access */
export function summarizePromptCacheMetricsByWorkspaceAccess(
  items: PromptCacheMetricsByWorkspaceAccess[],
): Record<WorkspaceAccess, PromptCacheMetrics> {
  const summary: Record<WorkspaceAccess, PromptCacheMetrics> = {
    "read-only": emptyPromptCacheMetrics(),
    write: emptyPromptCacheMetrics(),
  };

  for (const item of items) {
    const bucket = summary[item.workspaceAccess];
    bucket.inputTokens += item.inputTokens;
    bucket.cacheHitTokens += item.cacheHitTokens;
    bucket.cacheMissTokens += item.cacheMissTokens;
    // 聚合后重新计算命中率 / Recalculate hit rate after aggregation
    bucket.hitRate =
      bucket.inputTokens > 0 ? bucket.cacheHitTokens / bucket.inputTokens : 0;
  }

  return summary;
}

/** 生成空的缓存指标对象 / Generate empty cache metrics object */
function emptyPromptCacheMetrics(): PromptCacheMetrics {
  return {
    inputTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    hitRate: 0,
  };
}
