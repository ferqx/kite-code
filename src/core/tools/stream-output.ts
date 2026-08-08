/** Maximum captured stdout/stderr retained while a shell process is running. */
export const SHELL_CAPTURE_MAX_CHARS = 256 * 1024;

/** Maximum tail retained for one unterminated progress line. */
export const SHELL_PROGRESS_LINE_MAX_CHARS = 16 * 1024;

/**
 * Fixed-memory head+tail accumulator. The producer must still drain its input;
 * only the retained diagnostic projection is bounded.
 */
export class BoundedOutputBuffer {
  private readonly maxChars: number;
  private readonly keep: number;
  private head = '';
  private tail = '';
  private totalChars = 0;
  private truncated = false;

  constructor(maxChars = SHELL_CAPTURE_MAX_CHARS) {
    if (!Number.isSafeInteger(maxChars) || maxChars < 2) {
      throw new Error('BoundedOutputBuffer maxChars must be an integer greater than 1.');
    }
    this.maxChars = maxChars;
    this.keep = Math.floor(maxChars / 2);
  }

  append(text: string): void {
    if (!text) return;
    this.totalChars += text.length;
    if (!this.truncated) {
      const combined = this.head + text;
      if (combined.length <= this.maxChars) {
        this.head = combined;
        return;
      }
      this.head = combined.slice(0, this.keep);
      this.tail = combined.slice(-this.keep);
      this.truncated = true;
      return;
    }
    this.tail = (this.tail + text).slice(-this.keep);
  }

  value(): string {
    if (!this.truncated) return this.head;
    const omitted = Math.max(0, this.totalChars - this.head.length - this.tail.length);
    return `${this.head}\n... [${omitted} chars omitted during shell capture]\n${this.tail}`;
  }

  get isTruncated(): boolean {
    return this.truncated;
  }
}

/**
 * Incremental, bounded line splitter for progress callbacks. It preserves line
 * boundaries across arbitrary transport chunks without retaining an unlimited
 * unterminated line.
 */
export class BoundedProgressLineBuffer {
  private readonly maxLineChars: number;
  private pending = '';
  private omittedChars = 0;

  constructor(maxLineChars = SHELL_PROGRESS_LINE_MAX_CHARS) {
    if (!Number.isSafeInteger(maxLineChars) || maxLineChars < 1) {
      throw new Error('BoundedProgressLineBuffer maxLineChars must be a positive integer.');
    }
    this.maxLineChars = maxLineChars;
  }

  push(text: string, emit: (line: string) => void): void {
    if (!text) return;
    const segments = text.split('\n');
    for (let index = 0; index < segments.length; index += 1) {
      this.appendPartial(segments[index] ?? '');
      if (index < segments.length - 1) {
        emit(this.currentLine());
        this.pending = '';
        this.omittedChars = 0;
      }
    }
  }

  flush(emit: (line: string) => void): void {
    if (!this.pending && this.omittedChars === 0) return;
    emit(this.currentLine());
    this.pending = '';
    this.omittedChars = 0;
  }

  private appendPartial(text: string): void {
    if (!text) return;
    const combined = this.pending + text;
    if (combined.length <= this.maxLineChars) {
      this.pending = combined;
      return;
    }
    const overflow = combined.length - this.maxLineChars;
    this.omittedChars += overflow;
    this.pending = combined.slice(-this.maxLineChars);
  }

  private currentLine(): string {
    const line = this.pending.endsWith('\r') ? this.pending.slice(0, -1) : this.pending;
    return this.omittedChars > 0
      ? `... [${this.omittedChars} earlier chars omitted] ${line}`
      : line;
  }
}
