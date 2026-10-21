import { createHash } from 'node:crypto';

export interface PhysicalAttempt {
  index: number;
  requestId: string | null;
  startedAt: number;
  headersAt: number | null;
  firstByteAt: number | null;
  terminalAt: number | null;
  endedAt: number | null;
  status: number;
  chunks: number;
  bytes: number;
  sha256: string | null;
  terminal: string | null;
  eof: boolean;
  cancelled: boolean;
  failed: boolean;
}
export interface PhysicalTransition {
  at: number;
  active: number;
  indices: number[];
}

/** Only exact completed SSE frames are interpreted. Chunks are always forwarded unchanged. */
export class SseTerminalParser {
  private pending = '';
  private decoder = new TextDecoder();
  private frame: string[] = [];
  feed(bytes: Uint8Array): string | null {
    this.pending += this.decoder.decode(bytes, { stream: true });
    // Preserve a trailing CR until its optional LF arrives in the next chunk.
    let terminal: string | null = null;
    for (;;) {
      const match = /[\r\n]/.exec(this.pending);
      if (!match || (this.pending[match.index] === '\r' && match.index === this.pending.length - 1))
        break;
      const line = this.pending.slice(0, match.index);
      const width =
        this.pending[match.index] === '\r' && this.pending[match.index + 1] === '\n' ? 2 : 1;
      this.pending = this.pending.slice(match.index + width);
      if (line !== '') {
        this.frame.push(line);
        continue;
      }
      const frame = this.frame.join('\n');
      this.frame = [];
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n');
      if (data === '[DONE]') terminal = 'sse_done';
      else if (data) {
        try {
          const value = JSON.parse(data) as {
            type?: unknown;
            choices?: { finish_reason?: unknown }[];
          };
          if (
            ['response.completed', 'response.failed', 'response.incomplete', 'error'].includes(
              String(value.type),
            )
          )
            terminal = String(value.type);
          const reasons = value.choices
            ?.map((choice) => choice.finish_reason)
            .filter((reason) => typeof reason === 'string');
          if (reasons?.length) terminal = `finish_reason:${reasons.join(',')}`;
        } catch {
          /* Unknown frames remain data; never claim their successful finish. */
        }
      }
    }
    return terminal;
  }
}

export function activeAttempt(attempt: PhysicalAttempt): boolean {
  return (
    attempt.status >= 200 &&
    attempt.status < 300 &&
    attempt.firstByteAt !== null &&
    attempt.terminalAt === null &&
    attempt.endedAt === null
  );
}

export function longestContinuous(
  transitions: readonly PhysicalTransition[],
  count: number,
  until: number,
): number {
  let start: number | null = null,
    longest = 0;
  for (const transition of transitions) {
    if (transition.active === count) start ??= transition.at;
    else if (start !== null) {
      longest = Math.max(longest, transition.at - start);
      start = null;
    }
  }
  return Math.max(longest, start === null ? 0 : until - start);
}

/** This observes local real HTTP streams, not remote compute slots or monetary cost. */
export function createPhysicalObserver(now = () => performance.now()) {
  const attempts: PhysicalAttempt[] = [];
  const transitions: PhysicalTransition[] = [];
  function changed() {
    const indices = attempts.filter(activeAttempt).map((attempt) => attempt.index);
    const last = transitions.at(-1);
    if (!last || JSON.stringify(indices) !== JSON.stringify(last.indices))
      transitions.push({ at: now(), active: indices.length, indices });
  }
  function begin(requestId: string | null) {
    const attempt: PhysicalAttempt = {
      index: attempts.length,
      requestId,
      startedAt: now(),
      headersAt: null,
      firstByteAt: null,
      terminalAt: null,
      endedAt: null,
      status: 0,
      chunks: 0,
      bytes: 0,
      sha256: null,
      terminal: null,
      eof: false,
      cancelled: false,
      failed: false,
    };
    attempts.push(attempt);
    return attempt;
  }
  function transportFailed(attempt: PhysicalAttempt) {
    attempt.failed = true;
    attempt.endedAt = now();
    changed();
  }
  function response(attempt: PhysicalAttempt, original: Response): Response {
    attempt.status = original.status;
    attempt.headersAt = now();
    if (!original.body) {
      attempt.eof = true;
      attempt.endedAt = now();
      changed();
      return original;
    }
    const reader = original.body.getReader(),
      parser = new SseTerminalParser(),
      hash = createHash('sha256');
    let ended = false;
    function end() {
      if (!ended) {
        ended = true;
        attempt.endedAt = now();
        attempt.sha256 = hash.digest('hex');
        changed();
      }
    }
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            const item = await reader.read();
            if (item.done) {
              attempt.eof = true;
              end();
              controller.close();
              return;
            }
            attempt.firstByteAt ??= now();
            attempt.chunks++;
            attempt.bytes += item.value.byteLength;
            hash.update(item.value);
            const terminal = parser.feed(item.value);
            if (terminal && attempt.terminalAt === null) {
              attempt.terminal = terminal;
              attempt.terminalAt = now();
            }
            changed();
            controller.enqueue(item.value);
          } catch (error) {
            attempt.failed = true;
            end();
            controller.error(error);
          }
        },
        async cancel(reason) {
          attempt.cancelled = true;
          end();
          await reader.cancel(reason);
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(body, {
      status: original.status,
      statusText: original.statusText,
      headers: original.headers,
    });
  }
  return {
    attempts,
    transitions,
    begin,
    response,
    transportFailed,
    active: () => attempts.filter(activeAttempt),
    longest: (count: number) => longestContinuous(transitions, count, now()),
  };
}
