import type { RuntimeEvent } from '../bootstrap/runtime/state-runtime';

export const RUNTIME_PRESENTATION_FRAME_MS_ = 50;
const MAX_BUFFERED_TOOL_PROGRESS_CHARS_ = 16 * 1024;
const TOOL_PROGRESS_TRUNCATED_MARKER_ = '… progress truncated … ';

type PresentationSink = (event: RuntimeEvent) => void;
type ToolProgressEvent = Extract<RuntimeEvent, { type: 'tool.progress' }> & {
  lineCount?: number;
};

/**
 * Shared live-presentation framing used by both the legacy SessionRuntime seam and the concrete
 * Service bridge. Durable State order is untouched; only cumulative ephemeral display packets are
 * coalesced to the canonical client cadence.
 */
export class RuntimePresentationFrame {
  #model: {
    sink: PresentationSink | null;
    text?: Extract<RuntimeEvent, { type: 'model.text_delta' }>;
    reasoning?: Extract<RuntimeEvent, { type: 'model.reasoning_delta' }>;
    timer: ReturnType<typeof setTimeout> | null;
  } = { sink: null, timer: null };
  #tools: {
    sink: PresentationSink | null;
    events: Map<string, ToolProgressEvent>;
    timer: ReturnType<typeof setTimeout> | null;
  } = { sink: null, events: new Map(), timer: null };

  /** Return true when the event belongs to the ephemeral presentation stream. */
  push(event: RuntimeEvent, sink: PresentationSink): boolean {
    if (event.type === 'model.text_delta' || event.type === 'model.reasoning_delta') {
      this.#flushTools();
      this.#model.sink = sink;
      if (event.type === 'model.text_delta') this.#model.text = event;
      else this.#model.reasoning = event;
      this.#model.timer ??= setTimeout(() => this.#flushModel(), RUNTIME_PRESENTATION_FRAME_MS_);
      return true;
    }
    if (event.type === 'model.reasoning_completed') {
      this.#flushModel();
      sink(event);
      return true;
    }
    if (event.type === 'tool.progress') {
      this.#flushModel();
      this.#tools.sink = sink;
      const key = `${event.toolCallId}\0${event.stream}`;
      const previous = this.#tools.events.get(key);
      this.#tools.events.set(key, previous ? mergeToolProgress(previous, event) : normalize(event));
      this.#tools.timer ??= setTimeout(() => this.#flushTools(), RUNTIME_PRESENTATION_FRAME_MS_);
      return true;
    }
    return false;
  }

  flush(): void {
    this.#flushModel();
    this.#flushTools();
  }

  clear(): void {
    if (this.#model.timer) clearTimeout(this.#model.timer);
    if (this.#tools.timer) clearTimeout(this.#tools.timer);
    this.#model = { sink: null, timer: null };
    this.#tools = { sink: null, events: new Map(), timer: null };
  }

  #flushModel(): void {
    const buffered = this.#model;
    if (buffered.timer) clearTimeout(buffered.timer);
    this.#model = { sink: null, timer: null };
    if (!buffered.sink) return;
    if (buffered.reasoning) buffered.sink(buffered.reasoning);
    if (buffered.text) buffered.sink(buffered.text);
  }

  #flushTools(): void {
    const buffered = this.#tools;
    if (buffered.timer) clearTimeout(buffered.timer);
    this.#tools = { sink: null, events: new Map(), timer: null };
    if (!buffered.sink) return;
    for (const event of buffered.events.values()) buffered.sink(event);
  }
}

function boundToolProgressChunk(chunk: string): string {
  if (chunk.length <= MAX_BUFFERED_TOOL_PROGRESS_CHARS_) return chunk;
  const available = Math.max(
    1,
    MAX_BUFFERED_TOOL_PROGRESS_CHARS_ - TOOL_PROGRESS_TRUNCATED_MARKER_.length,
  );
  let tail = chunk.slice(-available);
  const firstBoundary = tail.indexOf('\n');
  if (firstBoundary >= 0) tail = tail.slice(firstBoundary + 1);
  return `${TOOL_PROGRESS_TRUNCATED_MARKER_}${tail}`;
}

function normalize(event: ToolProgressEvent): ToolProgressEvent {
  return {
    ...event,
    chunk: boundToolProgressChunk(event.chunk),
    lineCount: event.lineCount ?? event.chunk.split('\n').length,
  };
}

function mergeToolProgress(
  previous: ToolProgressEvent,
  next: ToolProgressEvent,
): ToolProgressEvent {
  return {
    ...next,
    chunk: boundToolProgressChunk(`${previous.chunk}\n${next.chunk}`),
    lineCount:
      (previous.lineCount ?? previous.chunk.split('\n').length) +
      (next.lineCount ?? next.chunk.split('\n').length),
  };
}
