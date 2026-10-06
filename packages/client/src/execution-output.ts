import { ClientError, decodeResponse } from './decode';
import type { ExecutionOutputPage } from './generated/api';
import { parseCursorSequence } from './sse';

/** Public saved-output coverage. This class performs no I/O and never invents lost bytes. */
export class ExecutionOutputPages {
  private after = '0';
  private upper: string | undefined;
  private done = false;
  private readonly streamEnds = new Map<string, bigint>();
  readonly executionId: string;
  constructor(executionId: string, upperSeq?: string) {
    this.executionId = executionId;
    if (upperSeq !== undefined) parseCursorSequence(upperSeq);
    this.upper = upperSeq;
  }
  get afterSeq() {
    return this.after;
  }
  get upperSeq() {
    return this.upper;
  }
  get complete() {
    return this.done;
  }
  /** Validate a transport retry without advancing the original coverage. */
  preview(value: unknown): ExecutionOutputPage {
    return this.acceptPage(value, false);
  }
  accept(value: unknown): ExecutionOutputPage {
    return this.acceptPage(value, true);
  }
  private acceptPage(value: unknown, advance: boolean): ExecutionOutputPage {
    const fail = (): never => {
      throw new ClientError('execution_output_page_conflict');
    };
    if (this.done) fail();
    let copy: unknown;
    try {
      copy = structuredClone(value);
    } catch {
      throw new ClientError('invalid_response');
    }
    const page = decodeResponse('ExecutionOutputPage', copy),
      highWater = parseCursorSequence(page.highWaterSeq),
      upper = this.upper ?? page.highWaterSeq,
      endOfRead = parseCursorSequence(upper),
      after = parseCursorSequence(this.after);
    if (highWater < endOfRead) fail();
    const ordered = [...page.items].sort((a, b) => {
      const left = parseCursorSequence(a.seq),
        right = parseCursorSequence(b.seq);
      return left < right ? -1 : left > right ? 1 : 0;
    });
    const ordinary = new Set<string>(),
      ends = new Map(this.streamEnds);
    let covered = after;
    for (const item of ordered) {
      const start = parseCursorSequence(item.seq),
        end = parseCursorSequence(item.throughSeq);
      if (
        item.executionId !== this.executionId ||
        start <= after ||
        start > covered + 1n ||
        end < start ||
        end > endOfRead
      )
        fail();
      const dropped = item.droppedBytes === null ? null : parseCursorSequence(item.droppedBytes),
        gap = dropped === null || dropped > 0n || end > start;
      // Coalesced gaps belong to a stream. They may span retained chunks of another
      // stream or overlap another gap; all original facts must remain visible.
      if (gap && (item.content !== '' || dropped === 0n)) fail();
      if (!gap) {
        if (ordinary.has(item.seq)) fail();
        ordinary.add(item.seq);
      }
      const previous = ends.get(item.stream);
      if (previous !== undefined && start <= previous) fail();
      ends.set(item.stream, end);
      if (end > covered) covered = end;
    }
    if ((!ordered.length && covered !== endOfRead) || (covered < endOfRead && covered <= after))
      fail();
    if (advance) {
      this.upper = upper;
      this.after = covered.toString();
      this.done = covered === endOfRead;
      for (const [stream, end] of ends) this.streamEnds.set(stream, end);
    }
    return { ...page, items: ordered };
  }
}
