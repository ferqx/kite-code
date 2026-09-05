export type RuntimeSessionOperation = 'turn' | 'compaction' | 'rewind';

export interface RuntimeSessionExecution {
  readonly operationId: string;
  readonly operation: RuntimeSessionOperation;
  readonly execute: (signal: AbortSignal, requestAbort: (reason: string) => void) => Promise<void>;
  readonly onSkipped?: (reason: string) => void;
  /** Host has observed the predecessor's durable terminal before cleanup settled. */
  readonly allowQueuedSuccessor?: boolean;
}

interface ScheduledExecution {
  readonly operationId: string;
  readonly controller: AbortController;
  readonly completion: Promise<void>;
}

interface SessionLifecycle {
  tail: Promise<void>;
  readonly scheduled: Map<string, ScheduledExecution>;
  closed: boolean;
}

/**
 * Host-owned per-session execution lifetime. Long-running Provider work is
 * chained outside the command mailbox, while every successor waits for the
 * predecessor's cleanup promise before it can enter the legacy executor.
 */
export class SessionLifecycleSupervisor {
  readonly #sessions = new Map<string, SessionLifecycle>();

  schedule(sessionId: string, input: RuntimeSessionExecution): boolean {
    const lifecycle = this.#session(sessionId);
    if (
      (!input.allowQueuedSuccessor && !this.canSchedule(sessionId)) ||
      lifecycle.scheduled.has(input.operationId)
    )
      return false;
    const controller = new AbortController();
    const completion = lifecycle.tail
      .catch(() => undefined)
      .then(async () => {
        if (controller.signal.aborted) {
          input.onSkipped?.(abortReason(controller.signal));
          return;
        }
        await input.execute(controller.signal, (reason) => controller.abort(reason));
      });
    const scheduled = { operationId: input.operationId, controller, completion };
    lifecycle.scheduled.set(input.operationId, scheduled);
    lifecycle.tail = completion
      .catch(() => undefined)
      .finally(() => {
        if (lifecycle.scheduled.get(input.operationId) === scheduled) {
          lifecycle.scheduled.delete(input.operationId);
        }
      });
    return true;
  }

  abort(sessionId: string, reason: string): void {
    const lifecycle = this.#sessions.get(sessionId);
    if (!lifecycle) return;
    for (const execution of lifecycle.scheduled.values()) {
      execution.controller.abort(reason);
    }
  }

  close(sessionId: string, reason: string): void {
    const lifecycle = this.#session(sessionId);
    lifecycle.closed = true;
    this.abort(sessionId, reason);
  }

  async waitForIdle(sessionId: string): Promise<void> {
    await this.#sessions.get(sessionId)?.tail;
  }

  sessionIds(): readonly string[] {
    return [...this.#sessions.keys()];
  }

  isActive(sessionId: string): boolean {
    return (this.#sessions.get(sessionId)?.scheduled.size ?? 0) > 0;
  }

  canSchedule(sessionId: string): boolean {
    const lifecycle = this.#sessions.get(sessionId);
    if (!lifecycle) return true;
    if (lifecycle.closed) return false;
    return [...lifecycle.scheduled.values()].every(
      (execution) => execution.controller.signal.aborted,
    );
  }

  #session(sessionId: string): SessionLifecycle {
    let lifecycle = this.#sessions.get(sessionId);
    if (!lifecycle) {
      lifecycle = { tail: Promise.resolve(), scheduled: new Map(), closed: false };
      this.#sessions.set(sessionId, lifecycle);
    }
    return lifecycle;
  }
}

function abortReason(signal: AbortSignal): string {
  if (typeof signal.reason === 'string' && signal.reason) return signal.reason;
  if (signal.reason instanceof Error && signal.reason.message) return signal.reason.message;
  return 'Operation cancelled.';
}
