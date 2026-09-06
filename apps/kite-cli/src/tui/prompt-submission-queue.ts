/**
 * Client-local ordering for ordinary TUI prompts.
 *
 * The Session identity is captured at enqueue time. Each returned Promise
 * retains its own failure while the internal tail absorbs that failure only
 * for the purpose of admitting the next queued prompt.
 */
export class TuiPromptSubmissionQueue {
  readonly #tails = new Map<string, Promise<void>>();
  readonly #pending = new Map<string, number>();

  enqueue<T>(sessionId: string, submit: (sessionId: string) => Promise<T>): Promise<T> {
    const tail = this.#tails.get(sessionId) ?? Promise.resolve();
    this.#pending.set(sessionId, (this.#pending.get(sessionId) ?? 0) + 1);
    const scheduled = tail.then(() => submit(sessionId));
    const settled = scheduled.then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(sessionId, settled);
    void settled.finally(() => {
      const remaining = (this.#pending.get(sessionId) ?? 1) - 1;
      if (remaining > 0) this.#pending.set(sessionId, remaining);
      else this.#pending.delete(sessionId);
      if (this.#tails.get(sessionId) === settled) this.#tails.delete(sessionId);
    });
    return scheduled;
  }

  hasPending(sessionId: string): boolean {
    return (this.#pending.get(sessionId) ?? 0) > 0;
  }
}

export function ensureTuiPromptSession(options: {
  readonly submittedSessionId: string;
  readonly getActiveSessionId: () => string;
  readonly createSession: () => string;
}): { readonly sessionId: string; readonly created: boolean } {
  const existing = options.submittedSessionId || options.getActiveSessionId();
  if (existing) return Object.freeze({ sessionId: existing, created: false });
  const sessionId = options.createSession();
  if (!sessionId) throw new Error('TUI Runtime did not create an initial Session.');
  return Object.freeze({ sessionId, created: true });
}

export function observeTuiPromptSubmission(options: {
  readonly queued: boolean;
  readonly submit: () => Promise<void>;
  readonly onQueued: () => void;
  readonly onFailure: (error: unknown) => void;
}): void {
  if (options.queued) options.onQueued();
  void Promise.resolve().then(options.submit).catch(options.onFailure);
}
