import type { Store } from '../storage/port';
import { AgentError, type ChangeEvent } from '../storage/types';

interface WakeRegistration {
  cursor: string;
  resolve: (events: ChangeEvent[]) => void;
  reject: (error: unknown) => void;
  cleanup: () => void;
}

/** Bounded wake primitive. Durable Store facts remain authoritative; notifications may be lost. */
export class ChangeWaits {
  private readonly pending = new Set<WakeRegistration>();
  // FIFO permit metadata only: no Job input, result or durable operation is copied here.
  private readonly capacityWaiters = new Set<WakeRegistration>();
  private closed = false;
  private readonly store: Store;
  constructor(store: Store) {
    this.store = store;
  }
  get size() {
    return this.pending.size;
  }
  wait(cursor: string, signal: AbortSignal, timeoutMs: number): Promise<ChangeEvent[]> {
    signal.throwIfAborted();
    if (this.closed) return Promise.reject(new AgentError('runtime_draining'));
    return new Promise((resolve, reject) => {
      let settled = false;
      const abort = () => {
        entry.cleanup();
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        entry.cleanup();
        resolve([]);
      }, timeoutMs);
      const entry = {
        cursor,
        resolve,
        reject,
        cleanup: () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          this.pending.delete(entry);
          this.capacityWaiters.delete(entry);
          this.admit();
        },
      };
      // The original absolute timer covers both capacity waiting and active registration.
      this.capacityWaiters.add(entry);
      signal.addEventListener('abort', abort, { once: true });
      this.admit();
    });
  }
  private admit(): void {
    if (this.closed) return;
    // Reservation and registration are synchronous, so a newly arriving caller cannot steal
    // a released permit from an older waiter or overbook the fixed active bound.
    while (this.pending.size < 64 && this.capacityWaiters.size) {
      const entry = this.capacityWaiters.values().next().value!;
      this.capacityWaiters.delete(entry);
      this.pending.add(entry);
    }
  }
  async poll(): Promise<void> {
    if (!this.pending.size) return;
    const registered = [...this.pending];
    const after = registered.reduce(
      (minimum, entry) => (BigInt(entry.cursor) < BigInt(minimum) ? entry.cursor : minimum),
      registered[0]!.cursor,
    );
    try {
      const page = await this.store.getChanges({ after, limit: 200 });
      for (const entry of registered) {
        if (!this.pending.has(entry)) continue;
        const events = page.events.filter((event) => BigInt(event.cursor) > BigInt(entry.cursor));
        if (!events.length) continue;
        entry.cleanup();
        entry.resolve(events);
      }
    } catch (error) {
      // A trimmed notification range is a wake, never permission to invent a result.
      if (!(error instanceof AgentError) || error.code !== 'cursor_expired') throw error;
      for (const entry of registered) {
        if (!this.pending.has(entry)) continue;
        entry.cleanup();
        entry.resolve([]);
      }
    }
  }
  close() {
    this.closed = true;
    for (const entry of [...this.pending, ...this.capacityWaiters]) {
      entry.cleanup();
      entry.reject(new AgentError('runtime_draining'));
    }
  }
}
