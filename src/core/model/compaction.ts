import type { BaseMessage } from '@/core/messages';
import { countTokens } from '@/core/token-counter';
import type { ContextBudget } from '@/core/types';

// ── 常量 / Constants ──

/** 默认软压缩触发阈值（maxTokens 的比例）/ Default soft compaction threshold (fraction of maxTokens) */
const DEFAULT_COMPACTION_THRESHOLD = 0.75;

/** 计算输出预留 token 数（取 6% 窗口或 16K 的较小值）/ Compute reserved output tokens (min of 6% window or 16K) */
function reservedOutputTokens(maxTokens: number): number {
  return Math.min(16_384, Math.floor(maxTokens * 0.06));
}

// ── Token 估算 & 压缩触发 / Token estimation & compaction trigger ──

/**
 * 估算消息列表的 token 数 / Estimate token count for a message list.
 * @deprecated Use estimateContextTokens() from context-budget.ts for production use.
 */
export function estimateTokens(messages: BaseMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      total += countTokens(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (typeof block === 'string') {
          total += countTokens(block);
        } else if (
          block &&
          typeof block === 'object' &&
          'text' in (block as Record<string, unknown>)
        ) {
          total += countTokens(String((block as Record<string, unknown>).text));
        }
      }
    }
    total += 4;
    const toolCalls = (msg as unknown as Record<string, unknown>).tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        if (tc && typeof tc === 'object') {
          total += countTokens(JSON.stringify(tc));
        }
      }
    }
  }
  return total;
}

/**
 * 判断是否需要 M2 对话摘要压缩。
 *
 * 硬限制：估算 token >= maxTokens - reserved
 * 软限制：估算 token >= maxTokens * threshold
 *
 * @deprecated Use preflightModelContext() from context-budget.ts and
 * decideAutomaticContextCompaction() from context-compaction-decision.ts
 * for production use. This function uses different threshold math and
 * may disagree with the V2 estimator.
 */
export function shouldCompact(
  estimatedTokens: number,
  budget?: ContextBudget,
): { needed: boolean; reason: 'hard' | 'soft' | 'none' } {
  const maxTokens = budget?.maxTokens;
  if (!maxTokens || maxTokens <= 0) {
    return { needed: false, reason: 'none' };
  }

  const threshold = budget.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD;
  const reserved = reservedOutputTokens(maxTokens);

  if (estimatedTokens >= maxTokens - reserved) {
    return { needed: true, reason: 'hard' };
  }
  if (estimatedTokens >= maxTokens * threshold) {
    return { needed: true, reason: 'soft' };
  }
  return { needed: false, reason: 'none' };
}
