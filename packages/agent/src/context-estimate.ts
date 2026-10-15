import type { ModelRequest } from '@kite-ai/ai';

/** Approximate cl100k accounting of the saved request, never Provider billing or admission. */
export interface ContextTokenEstimate {
  systemTokens: number;
  transcriptTokens: number;
  toolSchemaTokens: number;
  framingTokens: number;
  totalInputTokens: number;
}
export interface ModelContextEstimate {
  estimate: ContextTokenEstimate;
  contextWindowTokens?: number;
  reservedOutputTokens?: number;
  providerSafetyMarginTokens: number;
  usableInputTokens?: number;
  utilization?: number;
}
const positive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/** Pure display estimate. Capabilities must be explicit facts from the original frozen Model. */
export function estimateModelContext(
  request: Pick<ModelRequest, 'messages' | 'tools'>,
  capabilities: { contextWindowTokens?: unknown; maxOutputTokens?: unknown } = {},
  requestMaxOutputTokens?: number,
): ModelContextEstimate {
  // Preserve the original lazy vocabulary: ordinary startup does not initialize it.
  const { countTokens } =
    require('gpt-tokenizer/encoding/cl100k_base') as typeof import('gpt-tokenizer/encoding/cl100k_base');
  let systemTokens = 0,
    transcriptTokens = 0;
  for (const message of request.messages) {
    const tokens =
      countTokens(message.content) +
      (message.toolCalls?.length ? countTokens(JSON.stringify(message.toolCalls)) : 0) +
      (message.toolCallId ? countTokens(message.toolCallId) : 0);
    if (message.role === 'system') systemTokens += tokens;
    else transcriptTokens += tokens;
  }
  const toolSchemaTokens = request.tools.reduce(
    (total, tool) =>
      total +
      countTokens(
        JSON.stringify({
          name: tool.id,
          description: tool.description,
          inputSchema: tool.inputSchema,
        }),
      ),
    0,
  );
  const framingTokens = request.messages.length * 4 + request.tools.length * 8;
  const estimate = {
    systemTokens,
    transcriptTokens,
    toolSchemaTokens,
    framingTokens,
    totalInputTokens: systemTokens + transcriptTokens + toolSchemaTokens + framingTokens,
  };
  const contextWindowTokens = positive(capabilities.contextWindowTokens)
    ? capabilities.contextWindowTokens
    : undefined;
  const reservedOutputTokens = positive(requestMaxOutputTokens)
    ? requestMaxOutputTokens
    : positive(capabilities.maxOutputTokens)
      ? capabilities.maxOutputTokens
      : undefined;
  const budgetKnown = contextWindowTokens !== undefined && reservedOutputTokens !== undefined;
  const providerSafetyMarginTokens = budgetKnown
    ? Math.max(1024, Math.floor(contextWindowTokens * 0.02))
    : 0;
  const usableInputTokens = budgetKnown
    ? Math.max(0, contextWindowTokens - reservedOutputTokens - providerSafetyMarginTokens)
    : undefined;
  return {
    estimate,
    ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
    ...(reservedOutputTokens === undefined ? {} : { reservedOutputTokens }),
    providerSafetyMarginTokens,
    ...(usableInputTokens === undefined ? {} : { usableInputTokens }),
    ...(usableInputTokens && usableInputTokens > 0
      ? { utilization: estimate.totalInputTokens / usableInputTokens }
      : {}),
  };
}
