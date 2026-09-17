/** In-process cause for stopping an owned Runtime execution. Never infer it from message text. */
export type RuntimeAbortCause = 'user' | 'error';

export interface RuntimeAbortReason {
  readonly kind: 'runtime_abort';
  readonly cause: RuntimeAbortCause;
  readonly message: string;
}

export function createRuntimeAbortReason(
  cause: RuntimeAbortCause,
  message: string,
): RuntimeAbortReason {
  return { kind: 'runtime_abort', cause, message };
}

export function runtimeAbortCause(reason: unknown): RuntimeAbortCause {
  if (typeof reason !== 'object' || reason === null) return 'error';
  const candidate = reason as Partial<RuntimeAbortReason>;
  return candidate.kind === 'runtime_abort' && candidate.cause === 'user' ? 'user' : 'error';
}

export function runtimeAbortMessage(reason: unknown): string {
  if (typeof reason === 'object' && reason !== null) {
    const candidate = reason as Partial<RuntimeAbortReason>;
    if (
      candidate.kind === 'runtime_abort' &&
      typeof candidate.message === 'string' &&
      candidate.message.trim()
    ) {
      return candidate.message;
    }
  }
  if (reason instanceof Error && reason.message) return reason.message;
  if (typeof reason === 'string' && reason.trim()) return reason;
  return 'Runtime execution was interrupted.';
}
