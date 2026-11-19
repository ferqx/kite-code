import type { NativeWebSearchObservation as Observation } from './index';
import { ModelAttemptError } from './model-attempt';

type Data = Record<string, unknown>;
const object = (value: unknown): Data | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Data)
    : undefined;
const id = (value: unknown): value is string =>
  typeof value === 'string' && /^[\w.-]{1,256}$/.test(value);
const index = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const bounded = (value: unknown, limit: number) =>
  typeof value === 'string' && value.length <= limit ? value : undefined;
const fail = () => {
  throw new ModelAttemptError('stream_incomplete');
};

/** The API calls these character indexes but does not specify the unit on every path.
 * Do not guess across an astral character when both scalar and UTF-16 slices fit. */
function citationRange(text: string, points: string[], start: unknown, end: unknown, url: string) {
  if (!index(start) || !index(end) || end <= start) return undefined;
  const boundary = (n: number) =>
    n === 0 || n === text.length || !(text.charCodeAt(n) >= 0xdc00 && text.charCodeAt(n) <= 0xdfff);
  const utf =
    end <= text.length && boundary(start) && boundary(end) ? ([start, end] as const) : undefined;
  const scalar =
    end <= points.length
      ? ([points.slice(0, start).join('').length, points.slice(0, end).join('').length] as const)
      : undefined;
  if (!utf) return scalar;
  if (!scalar || (utf[0] === scalar[0] && utf[1] === scalar[1])) return utf;
  // A fully enclosed Markdown link with the exact annotation URL can disambiguate the indexes.
  const marker = (range: readonly [number, number]) => {
    const v = text.slice(...range);
    return /^\[[^\]\r\n]*\]\([^\r\n]*\)$/.test(v) && v.endsWith(`](${url})`);
  };
  return marker(utf) !== marker(scalar) ? (marker(utf) ? utf : scalar) : undefined;
}
function link(value: unknown) {
  const url = bounded(value, 4096);
  if (!url) return;
  try {
    const parsed = new URL(url);
    if (['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password)
      return url;
  } catch {
    /* Untrusted external data. */
  }
  return undefined;
}

/** Per-request wire observations; the provider (never a local Tool) executes every such item. */
export class NativeWebSearchStream {
  readonly calls = new Map<string, 'searching' | 'completed' | 'failed' | 'incomplete'>();
  readonly positions = new Map<string, number>();
  private readonly items = new Map<number, string>();
  private readonly sources = new Set<string>();
  private readonly blocks = new Map<
    string,
    { order: number; content: number; text?: string; citations: Data[] }
  >();
  private readonly pending = new Map<string, Data[]>();
  private readonly unique = new Set<string>();
  private chars = 0;
  private evidenceBytes = 0;
  private displayed: string | undefined = '';
  terminal = false;
  invalid = false;
  truncated = false;

  seenSearch() {
    return this.calls.size > 0;
  }
  text(delta: string) {
    if (this.displayed === undefined) return;
    this.displayed =
      this.displayed.length + delta.length <= 262144 ? this.displayed + delta : undefined;
  }
  private recordItem(item: Data, position: number) {
    if (!id(item.id)) return fail();
    if (this.items.size >= 512 && !this.positions.has(item.id)) return fail();
    if (
      (this.positions.has(item.id) && this.positions.get(item.id) !== position) ||
      (this.items.has(position) && this.items.get(position) !== item.id)
    )
      return fail();
    this.positions.set(item.id, position);
    this.items.set(position, item.id);
    if (item.type === 'function_call' && id(item.call_id))
      this.positions.set(item.call_id, position);
  }
  private *item(item: Data, position: number, done: boolean): Generator<Observation> {
    this.recordItem(item, position);
    if (item.type === 'web_search_call') {
      const callId = item.id as string;
      const action = object(item.action);
      const status = !done
        ? 'searching'
        : item.status === 'completed' &&
            ['search', 'open_page', 'find_in_page'].includes(String(action?.type))
          ? 'completed'
          : item.status === 'failed'
            ? 'failed'
            : 'incomplete';
      const previous = this.calls.get(callId);
      if (status !== previous) {
        if (previous && previous !== 'searching') return fail();
        this.calls.set(callId, status);
        const query =
          bounded(action?.query, 1024) ??
          (Array.isArray(action?.queries) ? bounded(action.queries[0], 1024) : undefined);
        yield { kind: 'activity', callId, status, ...(query ? { query } : {}) };
      }
      if (status === 'completed' && Array.isArray(action?.sources)) {
        for (const row of action.sources) {
          const url = link(object(row)?.url);
          if (!url || this.sources.has(url)) continue;
          if (this.sources.size >= 64) {
            this.truncated = true;
            break;
          }
          this.sources.add(url);
          yield { kind: 'source', url };
        }
      }
    } else if (done && item.type === 'message' && Array.isArray(item.content)) {
      for (let content = 0; content < item.content.length; content++) {
        const part = object(item.content[content]);
        if (part?.type !== 'output_text') continue;
        const key = `${item.id}:${content}`;
        if (this.blocks.has(key)) continue;
        if (this.blocks.size >= 256) {
          this.truncated = true;
          break;
        }
        const text = bounded(part.text, 16384);
        this.chars += text?.length ?? 0;
        if (!text || this.chars > 262144) this.truncated = true;
        this.blocks.set(key, {
          order: position,
          content,
          text: this.chars <= 262144 ? text : undefined,
          citations: this.annotations(part.annotations, this.pending.get(key)),
        });
      }
    }
  }
  private annotations(value: unknown, previous: Data[] = []): Data[] {
    const result = previous.slice();
    if (Array.isArray(value))
      for (const raw of value) {
        if (result.length >= 64) {
          this.truncated = true;
          break;
        }
        const a = object(raw);
        const url = link(a?.url);
        if (a?.type !== 'url_citation' || !url) continue;
        const title = bounded(a.title, 512);
        const sanitized = {
          url,
          title,
          start: index(a.start_index) ? a.start_index : undefined,
          end: index(a.end_index) ? a.end_index : undefined,
        };
        const size = url.length + (title?.length ?? 0);
        if (this.evidenceBytes + size > 128 * 1024) {
          this.truncated = true;
          break;
        }
        this.evidenceBytes += size;
        result.push(sanitized);
      }
    return result;
  }
  *read(value: unknown): Generator<Observation> {
    const chunk = object(value);
    if (!chunk) return;
    if (chunk.type === 'response.output_item.added' || chunk.type === 'response.output_item.done') {
      const item = object(chunk.item);
      if (!item || !index(chunk.output_index)) return fail();
      yield* this.item(item, chunk.output_index, chunk.type === 'response.output_item.done');
    } else if (
      chunk.type === 'response.output_text.annotation.added' &&
      id(chunk.item_id) &&
      index(chunk.content_index)
    ) {
      const key = `${chunk.item_id}:${chunk.content_index}`;
      if (this.pending.has(key) || this.pending.size < 256)
        this.pending.set(key, this.annotations([chunk.annotation], this.pending.get(key)));
    } else if (
      chunk.type === 'response.completed' ||
      chunk.type === 'response.incomplete' ||
      chunk.type === 'response.failed'
    ) {
      const response = object(chunk.response);
      if (Array.isArray(response?.output)) {
        for (const [position, value] of response.output.entries()) {
          const item = object(value);
          if (item) yield* this.item(item, position, true);
        }
      }
      this.terminal =
        chunk.type === 'response.completed' &&
        (!response?.status || response.status === 'completed');
      if (!this.terminal) this.invalid = true;
    }
  }
  *citations(): Generator<Observation> {
    const blocks = [...this.blocks.values()].sort(
      (a, b) => a.order - b.order || a.content - b.content,
    );
    const exact =
      blocks.every((b) => b.text !== undefined) &&
      this.displayed !== undefined &&
      blocks.map((b) => b.text).join('') === this.displayed;
    let offset = 0;
    let projected = 0;
    for (const [blockIndex, b] of blocks.entries()) {
      const text = b.text;
      const points = text === undefined ? [] : [...text];
      for (const a of b.citations) {
        const url = a.url as string;
        const key = JSON.stringify([blockIndex, url, a.start, a.end]);
        if (this.unique.has(key)) continue;
        if (this.unique.size >= 128) {
          this.truncated = true;
          return;
        }
        this.unique.add(key);
        const common = {
          kind: 'citation' as const,
          url,
          ...(typeof a.title === 'string' ? { title: a.title } : {}),
        };
        const range =
          text === undefined || !exact
            ? undefined
            : citationRange(text, points, a.start, a.end, url);
        if (text !== undefined && range) projected += text.length * 4;
        if (projected > 512 * 1024) this.truncated = true;
        if (!range || text === undefined || projected > 512 * 1024) yield common;
        else
          yield {
            ...common,
            blockIndex,
            blockStartUtf16: offset,
            text,
            startUtf16: range[0],
            endUtf16: range[1],
          };
      }
      offset += text?.length ?? 0;
    }
  }
  /** Sort by provider output slots, not by arrival/completion order. Repeated provider
   * tool results must never turn into duplicate web_search_call items on replay. */
  continuation<T>(parts: readonly T[]): T[] {
    const found = new Map<string, Set<string>>();
    const filtered: { part: T; position: number; order: number }[] = [];
    for (const part of parts) {
      const row = object(part);
      const meta = object(object(row?.providerOptions)?.openai);
      const itemId = row?.toolCallId ?? meta?.itemId;
      const position = typeof itemId === 'string' ? this.positions.get(itemId) : undefined;
      if (position === undefined || typeof itemId !== 'string') return fail();
      let order = 0;
      if (this.calls.has(itemId)) {
        const kind = row?.type;
        if (
          row?.toolName !== 'web_search' ||
          (kind !== 'tool-call' && kind !== 'tool-result') ||
          (kind === 'tool-call' && row?.providerExecuted !== true)
        )
          return fail();
        const seen = found.get(itemId) ?? new Set<string>();
        if (seen.has(kind)) continue;
        seen.add(kind);
        found.set(itemId, seen);
        order = kind === 'tool-result' ? 1 : 0;
      } else if (row?.providerExecuted || row?.type === 'tool-result') return fail();
      filtered.push({ part, position, order });
    }
    if ([...this.calls].some(([id, status]) => status === 'completed' && found.get(id)?.size !== 2))
      return fail();
    return filtered.sort((a, b) => a.position - b.position || a.order - b.order).map((e) => e.part);
  }
  assertComplete(required: boolean) {
    if ([...this.calls.values()].includes('failed'))
      throw Object.assign(new Error('search_failed'), { retrySafety: 'unsafe' });
    if ([...this.calls.values()].includes('incomplete'))
      throw Object.assign(new Error('search_incomplete'), { retrySafety: 'unsafe' });
    if (!this.terminal || this.invalid || [...this.calls.values()].some((s) => s !== 'completed'))
      return fail();
    if (required && !this.seenSearch()) throw new Error('search_not_performed');
  }
}

/** Bound actual bytes as they arrive (including oversized error bodies and unclosed SSE lines). */
export function boundSearchResponse(response: Response, limit: number): Response {
  const body = response.body;
  if (!body) return response;
  let size = 0;
  const stream = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > limit) {
          controller.error(new Error('web_search_response_limit'));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
