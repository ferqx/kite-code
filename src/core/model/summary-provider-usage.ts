/**
 * Provider counters observed for a SummaryCompact request.
 *
 * This intentionally carries only numeric accounting metadata. It must never
 * contain provider response content, prompts, summaries, or tool payloads.
 */
export interface SummaryProviderUsageV1 {
  inputTokens?: number;
  outputTokens?: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
}

export function hasReconciledSummaryProviderUsageV1(
  usage: SummaryProviderUsageV1 | undefined,
): usage is SummaryProviderUsageV1 & { inputTokens: number; outputTokens: number } {
  const inputTokens = usage?.inputTokens;
  const outputTokens = usage?.outputTokens;
  return (
    typeof inputTokens === 'number' &&
    Number.isSafeInteger(inputTokens) &&
    inputTokens >= 0 &&
    typeof outputTokens === 'number' &&
    Number.isSafeInteger(outputTokens) &&
    outputTokens >= 0
  );
}

export function hasSummaryProviderUsageV1(
  usage: SummaryProviderUsageV1 | undefined,
): usage is SummaryProviderUsageV1 {
  return (
    Number.isSafeInteger(usage?.inputTokens) ||
    Number.isSafeInteger(usage?.outputTokens) ||
    Number.isSafeInteger(usage?.cacheHitTokens) ||
    Number.isSafeInteger(usage?.cacheMissTokens)
  );
}
