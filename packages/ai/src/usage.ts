import type { LanguageModelUsage } from 'ai';
import type { Json, ModelUsage } from './index';

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** Preserve the actual usage object, including fields an SDK schema does not recognize. */
export function compatibleModelUsage(value: unknown): ModelUsage {
  const raw = object(value);
  const inputTokens = count(raw?.prompt_tokens);
  const outputTokens = count(raw?.completion_tokens);
  const totalTokens = count(raw?.total_tokens);
  const cached =
    count(object(raw?.prompt_tokens_details)?.cached_tokens) ?? count(raw?.prompt_cache_hit_tokens);
  const reasoning = count(object(raw?.completion_tokens_details)?.reasoning_tokens);
  return {
    inputTokens: inputTokens ?? null,
    outputTokens: outputTokens ?? null,
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(cached !== undefined && (inputTokens === undefined || cached <= inputTokens)
      ? { cachedInputTokens: cached }
      : {}),
    ...(reasoning !== undefined && (outputTokens === undefined || reasoning <= outputTokens)
      ? { reasoningTokens: reasoning }
      : {}),
    ...(raw ? { raw: JSON.parse(JSON.stringify(raw)) as Record<string, Json> } : {}),
  };
}

/** Opaque SDK Models supply normalized facts; do not guess their wire protocol. */
export function sdkModelUsage(usage: LanguageModelUsage): ModelUsage {
  const inputTokens = count(usage.inputTokens);
  const outputTokens = count(usage.outputTokens);
  const totalTokens = count(usage.totalTokens);
  const cached = count(usage.inputTokenDetails.cacheReadTokens);
  const reasoning = count(usage.outputTokenDetails.reasoningTokens);
  return {
    inputTokens: inputTokens ?? null,
    outputTokens: outputTokens ?? null,
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(cached !== undefined && (inputTokens === undefined || cached <= inputTokens)
      ? { cachedInputTokens: cached }
      : {}),
    ...(reasoning !== undefined && (outputTokens === undefined || reasoning <= outputTokens)
      ? { reasoningTokens: reasoning }
      : {}),
    ...(usage.raw ? { raw: JSON.parse(JSON.stringify(usage.raw)) as Record<string, Json> } : {}),
  };
}
