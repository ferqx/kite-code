/**
 * Client-local ordering for ordinary TUI prompts.
 *
 * The Session identity is captured at enqueue time. Each returned Promise
 * retains its own failure while the internal tail absorbs that failure only
 * for the purpose of admitting the next queued prompt.
 */
export class TuiPromptSubmissionQueue {
  #tail: Promise<void> = Promise.resolve();

  enqueue<T>(sessionId: string, submit: (sessionId: string) => Promise<T>): Promise<T> {
    const scheduled = this.#tail.then(() => submit(sessionId));
    this.#tail = scheduled.then(
      () => undefined,
      () => undefined,
    );
    return scheduled;
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
