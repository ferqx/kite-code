export type InvocationCancellationKind =
  | 'external_abort'
  | 'deadline_exceeded'
  | 'first_byte_timeout'
  | 'idle_timeout';

export class InvocationCancellationError extends Error {
  readonly kind: InvocationCancellationKind;

  constructor(kind: InvocationCancellationKind, message: string) {
    super(message);
    this.kind = kind;
    this.name = kind === 'external_abort' ? 'AbortError' : 'TimeoutError';
  }
}

export interface InvocationDeadline {
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
  readonly reason: InvocationCancellationError | undefined;
  remainingMs(): number;
  cancel(kind: InvocationCancellationKind, message?: string): void;
  dispose(): void;
}

function defaultMessage(kind: InvocationCancellationKind): string {
  switch (kind) {
    case 'external_abort':
      return 'Invocation cancelled by caller.';
    case 'deadline_exceeded':
      return 'Invocation total deadline exceeded.';
    case 'first_byte_timeout':
      return 'Invocation first-byte deadline exceeded.';
    case 'idle_timeout':
      return 'Invocation idle deadline exceeded.';
  }
}

/** Compose an external signal with one absolute deadline while preserving the first cause. */
export function createInvocationDeadline(input: {
  deadlineAt: number;
  signal?: AbortSignal;
  now?: () => number;
}): InvocationDeadline {
  const now = input.now ?? Date.now;
  const controller = new AbortController();
  let firstReason: InvocationCancellationError | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const cancel = (kind: InvocationCancellationKind, message = defaultMessage(kind)) => {
    if (firstReason) return;
    firstReason = new InvocationCancellationError(kind, message);
    controller.abort(firstReason);
  };
  const onExternalAbort = () =>
    cancel(
      'external_abort',
      input.signal?.reason instanceof Error
        ? input.signal.reason.message
        : defaultMessage('external_abort'),
    );

  if (input.signal?.aborted) {
    onExternalAbort();
  } else {
    input.signal?.addEventListener('abort', onExternalAbort, { once: true });
  }

  const remainingMs = () => Math.max(0, input.deadlineAt - now());
  if (!firstReason) {
    const remaining = remainingMs();
    if (remaining === 0) {
      cancel('deadline_exceeded');
    } else {
      timer = setTimeout(() => cancel('deadline_exceeded'), remaining);
    }
  }

  return {
    deadlineAt: input.deadlineAt,
    signal: controller.signal,
    get reason() {
      return firstReason;
    },
    remainingMs,
    cancel,
    dispose() {
      if (timer) clearTimeout(timer);
      input.signal?.removeEventListener('abort', onExternalAbort);
    },
  };
}

/** Resettable phase timer that reports into the invocation's first-cause controller. */
export function createDeadlinePhaseTimer(
  deadline: InvocationDeadline,
  kind: 'first_byte_timeout' | 'idle_timeout',
  timeoutMs: number,
): { reset(): void; dispose(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reset = () => {
    if (timer) clearTimeout(timer);
    if (deadline.signal.aborted) return;
    const remaining = Math.min(timeoutMs, deadline.remainingMs());
    if (remaining <= 0) {
      deadline.cancel('deadline_exceeded');
      return;
    }
    timer = setTimeout(() => deadline.cancel(kind), remaining);
  };
  reset();
  return {
    reset,
    dispose() {
      if (timer) clearTimeout(timer);
    },
  };
}

/** Enforce terminal cancellation even when an adapter ignores AbortSignal cooperatively. */
export async function awaitAbortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw signal.reason;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}
