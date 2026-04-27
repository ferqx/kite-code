import { AIMessage } from "@langchain/core/messages";
import type { WorkspaceAccess } from "./types";

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
      Math.max(0, inputTokens - cacheHitTokens),
  );

  // 三项均为零视为无效（非 LLM 消息） / Return null if all three are zero (not an LLM message)
  if (!inputTokens && !cacheHitTokens && !cacheMissTokens) {
    return null;
  }

  return {
    inputTokens,
    cacheHitTokens,
    cacheMissTokens,
    // 避免除零 / Avoid division by zero
    hitRate: inputTokens > 0 ? cacheHitTokens / inputTokens : 0,
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
