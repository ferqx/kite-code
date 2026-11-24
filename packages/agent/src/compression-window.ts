import type { ModelMessage } from '@kite-ai/ai';
import { estimateModelContext } from './context-estimate';
import { canonicalJson } from './json';

export interface HistoryPosition {
  readonly seq: string;
  readonly runId?: string | null;
  readonly summary?: true;
  readonly resultSource?: true;
}

export interface CompressionHistory {
  boundInputs?: true;
  boundedCheckpoint?: boolean;
  inputHighWaterSeq?: string;
  previousCoverage?: string;
  previousRecentHistoryTokens?: number;
  positions?: readonly HistoryPosition[];
}

export interface ContextOverflowRecovery {
  readonly executionId: string;
  readonly inputTokens: number;
}

export function inputTokens(messages: readonly ModelMessage[]): number {
  return estimateModelContext({ messages, tools: [] }).estimate.totalInputTokens;
}

/** Pick a prefix in original Store order without cutting a complete provider tool exchange. */
export function selectCompressionCoverage(
  history: readonly ModelMessage[],
  snapshot: CompressionHistory,
  runId: string,
  recentHistoryTokens: number,
): { coveredThroughSeq: string; inputHighWaterSeq: string } | null {
  const { inputHighWaterSeq, positions } = snapshot;
  if (inputHighWaterSeq === undefined || positions?.length !== history.length) return null;
  const previousCoverage = BigInt(snapshot.previousCoverage ?? '0');
  const groups: { from: number; to: number; first: bigint; last: bigint }[] = [];
  let pendingEvidence: bigint | undefined;
  for (let from = 0; from < history.length; ) {
    const message = history[from]!;
    let to = from + 1;
    let first = BigInt(positions[from]!.seq);
    let last = first;
    if (message.role === 'assistant') {
      pendingEvidence = undefined;
      const calls = new Set(message.toolCalls?.map(({ id }) => id));
      while (
        to < history.length &&
        history[to]!.role === 'tool' &&
        calls.has(history[to]!.toolCallId ?? '')
      ) {
        const seq = BigInt(positions[to++]!.seq);
        if (seq < first) first = seq;
        if (seq > last) last = seq;
      }
      if (calls.size && positions[from]!.runId === runId) pendingEvidence = first;
    }
    if (positions[from]!.resultSource && (pendingEvidence === undefined || first < pendingEvidence))
      pendingEvidence = first;
    if (!positions[from]!.summary && last > previousCoverage)
      groups.push({ from, to, first, last });
    from = to;
  }
  const requiredBoundary = pendingEvidence ?? BigInt(inputHighWaterSeq) + 1n;
  let boundary = requiredBoundary;
  let remaining = recentHistoryTokens;
  for (let index = groups.length - 1; index > 0; index--) {
    const group = groups[index]!;
    if (group.first >= boundary) continue;
    const cost = inputTokens(history.slice(group.from, group.to));
    if (cost > remaining) break;
    remaining -= cost;
    boundary = group.first;
  }
  const avoidSplits = (candidate: bigint) => {
    // A user input can be interleaved with the stored members of a batch.
    // Work backwards until the sequence cut excludes every intersecting batch.
    for (;;) {
      const intersecting = groups.find(({ first, last }) => first < candidate && last >= candidate);
      if (!intersecting) return candidate;
      candidate = intersecting.first;
    }
  };
  boundary = avoidSplits(boundary);
  if (!groups.some(({ last }) => last < boundary)) boundary = avoidSplits(requiredBoundary);
  if (boundary <= previousCoverage + 1n || !groups.some(({ last }) => last < boundary)) return null;
  return { coveredThroughSeq: String(boundary - 1n), inputHighWaterSeq };
}

/** Only the summary input is shortened. Original executions and the business tail stay attributable. */
export function shortenSummaryHistory(
  history: readonly ModelMessage[],
  exactInputs: ReadonlySet<ModelMessage>,
): ModelMessage[] {
  return history.map((message) => {
    if (message.content.length <= 4096 || exactInputs.has(message) || message.role === 'system')
      return message;
    return {
      ...message,
      content: canonicalJson({
        historicalExcerpt: true,
        sourceIds: [...(message.sourceIds ?? [])],
        ...(message.toolCallId ? { originalToolCall: message.toolCallId } : {}),
        beginning: message.content.slice(0, 3072),
        ending: message.content.slice(-1024),
      }),
    };
  });
}
