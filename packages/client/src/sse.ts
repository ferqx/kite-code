/** Transport framing only. Applying an event and advancing its business cursor are caller responsibilities. */
export interface SSEEvent {
  readonly event: string;
  readonly data: string;
  /** Explicit id field in this frame; ready/heartbeat frames never inherit it. */
  readonly id?: string;
  /** WHATWG transport last-event-id, distinct from an applied business cursor. */
  readonly lastEventId: string;
}

export interface SSEParserOptions {
  readonly maxEventBytes?: number;
  readonly onRetry?: (milliseconds: number) => void;
}

export class SSEParseError extends Error {
  readonly code = 'sse_event_too_large';
}

/** Incremental UTF-8 decoder, including CR/LF boundaries split across chunks. */
export class SSEParser {
  private readonly decoder = new TextDecoder();
  private readonly maximum: number;
  private readonly options: SSEParserOptions;
  private line = '';
  private eventBytes = 0;
  private skipLF = false;
  private data: string[] = [];
  private eventName = '';
  private frameId: string | undefined;
  private transportId = '';
  private finished = false;

  constructor(options: SSEParserOptions = {}) {
    this.options = options;
    this.maximum = options.maxEventBytes ?? 1024 * 1024;
    if (!Number.isSafeInteger(this.maximum) || this.maximum < 1) {
      throw new RangeError('maxEventBytes must be a positive safe integer.');
    }
  }

  push(chunk: Uint8Array): SSEEvent[] {
    if (this.finished) throw new Error('SSE parser is already finished.');
    return this.consume(this.decoder.decode(chunk, { stream: true }));
  }

  /** EOF discards any event without its terminating blank line. */
  finish(): SSEEvent[] {
    if (this.finished) return [];
    const events = this.consume(this.decoder.decode());
    this.finished = true;
    this.line = '';
    this.data = [];
    return events;
  }

  private consume(text: string): SSEEvent[] {
    const events: SSEEvent[] = [];
    for (const character of text) {
      if (this.skipLF) {
        this.skipLF = false;
        if (character === '\n') continue;
      }
      if (character === '\r' || character === '\n') {
        const event = this.finishLine();
        if (event) events.push(event);
        this.skipLF = character === '\r';
      } else {
        const codePoint = character.codePointAt(0)!;
        this.eventBytes +=
          codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
        if (this.eventBytes > this.maximum)
          throw new SSEParseError('SSE event exceeds the local byte limit.');
        this.line += character;
      }
    }
    return events;
  }

  private finishLine(): SSEEvent | undefined {
    const line = this.line;
    this.line = '';
    if (line === '') {
      const event =
        this.data.length === 0
          ? undefined
          : {
              event: this.eventName || 'message',
              data: this.data.join('\n'),
              ...(this.frameId === undefined ? {} : { id: this.frameId }),
              lastEventId: this.transportId,
            };
      this.data = [];
      this.eventName = '';
      this.frameId = undefined;
      this.eventBytes = 0;
      return event;
    }
    if (line.startsWith(':')) return undefined;
    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.data.push(value);
    else if (field === 'event') this.eventName = value;
    else if (field === 'id' && !value.includes('\0')) {
      this.frameId = value;
      this.transportId = value;
    } else if (field === 'retry' && /^[0-9]+$/.test(value)) {
      const milliseconds = Number(value);
      if (Number.isSafeInteger(milliseconds)) this.options.onRetry?.(milliseconds);
    }
    return undefined;
  }
}

/** Disposing this reader closes observation only; it never issues an execution command. */
export async function* readSSE(
  body: ReadableStream<Uint8Array>,
  options: SSEParserOptions & { readonly signal?: AbortSignal } = {},
): AsyncGenerator<SSEEvent> {
  options.signal?.throwIfAborted();
  const reader = body.getReader();
  const parser = new SSEParser(options);
  const abort = () => {
    void reader.cancel(options.signal?.reason).catch(() => {});
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      options.signal?.throwIfAborted();
      const chunk = await reader.read();
      options.signal?.throwIfAborted();
      if (chunk.done) {
        yield* parser.finish();
        return;
      }
      yield* parser.push(chunk.value);
    }
  } finally {
    options.signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export const MAX_CURSOR_SEQUENCE = 9223372036854775807n;

/** Strict JSON decimal sequence parsing; never round a SQLite sequence through Number. */
export function parseCursorSequence(value: string): bigint {
  if (typeof value !== 'string' || value.length > 19 || !/^(0|[1-9][0-9]*)$/.test(value))
    throw new RangeError('Invalid cursor sequence.');
  const sequence = BigInt(value);
  if (sequence > MAX_CURSOR_SEQUENCE)
    throw new RangeError('Cursor sequence exceeds signed SQLite 64-bit range.');
  return sequence;
}

export function validateCursorBounds(input: {
  readonly sequence: string;
  readonly replayFloor: string;
  readonly lastChangeCursor: string;
}): 'valid' | 'expired' | 'ahead' {
  const sequence = parseCursorSequence(input.sequence);
  const floor = parseCursorSequence(input.replayFloor);
  const high = parseCursorSequence(input.lastChangeCursor);
  if (floor > high) throw new RangeError('Invalid cursor retention bounds.');
  return sequence < floor ? 'expired' : sequence > high ? 'ahead' : 'valid';
}
