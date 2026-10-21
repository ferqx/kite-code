import type { Json, ModelMessage, ModelRequest } from '@kite-ai/ai';
import { canonicalJson } from './json';

/** A measured original input, supplied only after its route and scope have been verified. */
export interface ContextTokenBaseline {
  readonly executionId: string;
  readonly request: Pick<ModelRequest, 'modelId' | 'messages' | 'tools'>;
  readonly inputTokens: number;
}

export interface ContextTokenProjection {
  source: 'reported_baseline' | 'local_estimate';
  measuredInputTokens: number;
  estimatedInputTokens: number;
  totalInputTokens: number;
  baselineExecutionId?: string;
}

/** An unchanged measured request may acquire new messages, including insertions before trailing sources. */
export function projectModelContext(
  request: Pick<ModelRequest, 'modelId' | 'messages' | 'tools'>,
  baseline?: ContextTokenBaseline,
): ContextTokenProjection {
  const fallback = (): ContextTokenProjection => {
    const tokens = estimateModelContext(request).estimate.totalInputTokens;
    return {
      source: 'local_estimate',
      measuredInputTokens: 0,
      estimatedInputTokens: tokens,
      totalInputTokens: tokens,
    };
  };
  if (
    !baseline ||
    !Number.isSafeInteger(baseline.inputTokens) ||
    baseline.inputTokens < 0 ||
    baseline.request.modelId !== request.modelId ||
    canonicalJson(JSON.parse(JSON.stringify(baseline.request.tools)) as Json) !==
      canonicalJson(JSON.parse(JSON.stringify(request.tools)) as Json)
  )
    return fallback();
  const same = (a: ModelMessage, b: ModelMessage) =>
    a.role === b.role &&
    a.content === b.content &&
    JSON.stringify(a.images ?? []) === JSON.stringify(b.images ?? []) &&
    a.toolCallId === b.toolCallId &&
    (a.toolCalls?.length ?? 0) === (b.toolCalls?.length ?? 0) &&
    (a.toolCalls ?? []).every((call, index) => {
      const other = b.toolCalls?.[index];
      return (
        other?.id === call.id && other.name === call.name && other.arguments === call.arguments
      );
    }) &&
    JSON.stringify(a.sourceIds ?? []) === JSON.stringify(b.sourceIds ?? []);
  const added: ModelMessage[] = [];
  let matched = 0;
  for (const message of request.messages) {
    const previous = baseline.request.messages[matched];
    if (previous && same(previous, message)) matched++;
    else added.push(message);
  }
  // Deletions, edits, rewinds and compaction cannot inherit the old measured count.
  if (matched !== baseline.request.messages.length) return fallback();
  const estimated = estimateModelContext({ messages: added, tools: [] }).estimate.totalInputTokens;
  const total = baseline.inputTokens + estimated;
  if (!Number.isSafeInteger(total)) return fallback();
  return {
    source: 'reported_baseline',
    measuredInputTokens: baseline.inputTokens,
    estimatedInputTokens: estimated,
    totalInputTokens: total,
    baselineExecutionId: baseline.executionId,
  };
}

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

/** Pure local estimate. Capabilities must be explicit facts from the original frozen Model. */
export function estimateModelContext(
  request: Pick<ModelRequest, 'messages' | 'tools'>,
  capabilities: { contextWindowTokens?: unknown; maxOutputTokens?: unknown } = {},
  requestMaxOutputTokens?: number,
): ModelContextEstimate {
  // Preserve the original lazy vocabulary: ordinary startup does not initialize it.
  const { countTokens } =
    require('gpt-tokenizer/encoding/cl100k_base') as typeof import('gpt-tokenizer/encoding/cl100k_base');
  // BPE on one multi-megabyte word can grow quadratically. Display accounting
  // includes every character, but bounds each tokenizer input. Counts at long
  // chunk seams are approximate; short strings retain the original tokenization.
  const chunkCharacters = 1024;
  const counts = new Map<string, number>();
  const countText = (text: string) => {
    let total = 0;
    for (let start = 0; start < text.length; ) {
      let end = Math.min(start + chunkCharacters, text.length);
      // Never turn one Unicode scalar into two replacement characters.
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
      const chunk = text.slice(start, end);
      let count = counts.get(chunk);
      if (count === undefined) {
        count = countTokens(chunk);
        if (counts.size === 128) counts.delete(counts.keys().next().value!);
        counts.set(chunk, count);
      }
      total += count;
      start = end;
    }
    return total;
  };
  let systemTokens = 0,
    transcriptTokens = 0;
  for (const message of request.messages) {
    const tokens =
      countText(message.content) +
      (message.toolCalls?.length ? countText(JSON.stringify(message.toolCalls)) : 0) +
      (message.toolCallId ? countText(message.toolCallId) : 0);
    if (message.role === 'system') systemTokens += tokens;
    else transcriptTokens += tokens;
  }
  const toolSchemaTokens = request.tools.reduce(
    (total, tool) =>
      total +
      countText(
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
