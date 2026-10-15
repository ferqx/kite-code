import type { ToolResult } from '../extensions';
import { AgentError } from '../storage/types';
export class ToolDispatchCancelledError extends Error {
  readonly code = 'tool_dispatch_cancelled';
  constructor(reason: unknown) {
    super('Cancelled before Tool dispatch admission.', { cause: reason });
  }
}

/** The default policy orders admission, never Tool completion or resource ownership. */
export interface ToolDispatchAdmission {
  wait(): Promise<void>;
  dispatched(): void;
  settled(result?: ToolResult, error?: unknown): void;
}
export function createToolDispatchBatch(
  callIds: readonly string[],
  signal: AbortSignal,
  cancel: (reason: unknown) => void,
) {
  const releases: (() => void)[] = [];
  let previous = Promise.resolve();
  const admissions = new Map<string, ToolDispatchAdmission>();
  for (const id of callIds) {
    const predecessor = previous;
    let release!: () => void;
    previous = new Promise<void>((resolve) => {
      release = resolve;
    });
    let released = false;
    const advance = () => {
      if (!released) {
        released = true;
        release();
      }
    };
    admissions.set(id, {
      async wait() {
        if (signal.aborted) throw new ToolDispatchCancelledError(signal.reason);
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            signal.removeEventListener('abort', abort);
            reject(new ToolDispatchCancelledError(signal.reason));
          };
          signal.addEventListener('abort', abort, { once: true });
          predecessor.then(() => {
            signal.removeEventListener('abort', abort);
            resolve();
          });
          if (signal.aborted) abort();
        });
        if (signal.aborted) throw new ToolDispatchCancelledError(signal.reason);
      },
      dispatched: advance,
      settled(result, error) {
        if (released) return;
        if (
          !error &&
          !signal.aborted &&
          result?.outcome === 'failed' &&
          result.content !== 'approval_denied'
        ) {
          // A schema rejection can settle before an earlier interactive Tool. It
          // cannot let the next call jump that still-unresolved admission.
          void predecessor.then(() => {
            if (!signal.aborted) advance();
          });
          return;
        }
        cancel(error ?? new AgentError(result?.content ?? 'tool_dispatch_not_admitted'));
      },
    });
    releases.push(release);
  }
  return {
    forCall: (id: string) => admissions.get(id),
    settled: (id: string, result: ToolResult, dispatched?: boolean) => {
      if (dispatched === true) admissions.get(id)?.dispatched();
      else if (dispatched === false) admissions.get(id)?.settled(result);
      else cancel(new AgentError('tool_dispatch_not_admitted'));
    },
    finish() {
      admissions.clear();
      for (const release of releases) release();
      releases.length = 0;
    },
  };
}
