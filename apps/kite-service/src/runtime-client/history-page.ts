import type { RuntimeHistorySessionTranscript } from '@kite-ai/runtime-contract';
import { RUNTIME_PROTOCOL_LIMITS } from '@kite-ai/runtime-protocol';

export type KiteHistoryPage = Omit<RuntimeHistorySessionTranscript, 'events'> & {
  readonly type: 'history_session_page';
  readonly nextCursor?: number;
};

/** The Worker returns one bounded protocol page, never its complete transcript. */
export function historyTranscriptPage(
  transcript: RuntimeHistorySessionTranscript,
  afterSequence = 0,
): KiteHistoryPage {
  const { events: _events, records: source, ...metadata } = transcript;
  const records: RuntimeHistorySessionTranscript['records'][number][] = [];
  const page = { type: 'history_session_page' as const, ...metadata, records };
  const byteLength = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
  let bytes = byteLength(page);
  let low = 0;
  let high = source.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (source[middle]!.sequence <= afterSequence) low = middle + 1;
    else high = middle;
  }
  for (let index = low; index < source.length; index++) {
    const record = source[index]!;
    const size = byteLength(record) + 1;
    if (bytes + size > RUNTIME_PROTOCOL_LIMITS.maxMessageBytes - 65_536 || records.length === 512) {
      const last = records.at(-1);
      if (!last) throw new Error('History record exceeds the protocol frame limit.');
      return { ...page, nextCursor: last.sequence };
    }
    records.push(record);
    bytes += size;
  }
  return page;
}
