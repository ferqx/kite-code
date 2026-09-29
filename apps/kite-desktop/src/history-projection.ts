import type { RuntimeHistorySessionTranscript } from '@kite-ai/runtime-contract';
import { HistoryMessageBuilder, type Message, projectHistoricalEvent } from './presentation';

export interface DesktopCacheMetrics {
  readonly cacheHitTokens: number;
  readonly cacheMissTokens: number;
}

export function addCacheMetrics(
  current: DesktopCacheMetrics | undefined,
  event: RuntimeHistorySessionTranscript['records'][number]['events'][number],
): DesktopCacheMetrics | undefined {
  if (event.type !== 'model.cache') return current;
  return {
    cacheHitTokens: (current?.cacheHitTokens ?? 0) + event.cacheHitTokens,
    cacheMissTokens: (current?.cacheMissTokens ?? 0) + event.cacheMissTokens,
  };
}

export function projectCacheMetrics(
  records: RuntimeHistorySessionTranscript['records'],
): DesktopCacheMetrics | undefined {
  let metrics: DesktopCacheMetrics | undefined;
  for (const record of records) {
    for (const event of record.events) metrics = addCacheMetrics(metrics, event);
  }
  return metrics;
}

/** Yield between bounded batches without publishing partial historical pages. */
export async function projectHistory(
  records: RuntimeHistorySessionTranscript['records'],
  previous: readonly Message[],
  signal: AbortSignal,
): Promise<readonly Message[]> {
  const builder = new HistoryMessageBuilder();
  let started = performance.now();
  let count = 0;
  for (const record of records) {
    for (const event of record.events) {
      signal.throwIfAborted();
      projectHistoricalEvent(builder, event, {
        ...record.identity,
        occurredAt: record.occurredAt,
      });
      if (++count === 200 || performance.now() - started >= 8) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        signal.throwIfAborted();
        started = performance.now();
        count = 0;
      }
    }
  }
  const byId = new Map(previous.map((message) => [message.id, message]));
  const messages = builder.messages;
  let unchanged = messages.length === previous.length;
  const shared: Message[] = [];
  for (let index = 0; index < messages.length; index++) {
    let next = messages[index]!;
    const old = byId.get(next.id);
    if (next.role === 'thinking' && old?.thinkingStartedAt !== undefined) {
      next = {
        ...next,
        thinkingStartedAt: old.thinkingStartedAt,
        ...(old.thinkingEndedAt !== undefined ? { thinkingEndedAt: old.thinkingEndedAt } : {}),
      };
    }
    const message = old && equalDisplayValue(old, next) ? old : next;
    shared.push(message);
    unchanged &&= message === previous[index];
    if (++count === 200 || performance.now() - started >= 8) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      signal.throwIfAborted();
      started = performance.now();
      count = 0;
    }
  }
  signal.throwIfAborted();
  return unchanged ? previous : shared;
}

// Message fields contain JSON-safe presentation data, including nested tool arguments.
function equalDisplayValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every(
    (key) =>
      Object.hasOwn(right, key) &&
      equalDisplayValue(
        (left as Record<string, unknown>)[key],
        (right as Record<string, unknown>)[key],
      ),
  );
}
