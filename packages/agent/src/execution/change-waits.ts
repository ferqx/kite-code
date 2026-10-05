import type { Store } from '../storage/port';
import { AgentError, type ChangeEvent } from '../storage/types';

/** Bounded wake primitive. Durable Store facts remain authoritative; notifications may be lost. */
export class ChangeWaits {
  private readonly pending = new Set<{
    cursor: string;
    resolve: (events: ChangeEvent[]) => void;
    reject: (error: unknown) => void;
    cleanup: () => void;
  }>();
  private readonly store: Store;
  constructor(store: Store) {
    this.store = store;
  }
  get size() {
    return this.pending.size;
  }
  wait(cursor: string, signal: AbortSignal, timeoutMs: number): Promise<ChangeEvent[]> {
    signal.throwIfAborted();
    if (this.pending.size >= 64) throw new AgentError('wait_capacity');
    return new Promise((resolve, reject) => {
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
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          this.pending.delete(entry);
        },
      };
      this.pending.add(entry);
      signal.addEventListener('abort', abort, { once: true });
    });
  }
  async poll(): Promise<void> {
    if (!this.pending.size) return;
    const after = [...this.pending].reduce(
      (minimum, entry) => (BigInt(entry.cursor) < BigInt(minimum) ? entry.cursor : minimum),
      [...this.pending][0]!.cursor,
    );
    try {
      const page = await this.store.getChanges({ after, limit: 200 });
      for (const entry of [...this.pending]) {
        const events = page.events.filter((event) => BigInt(event.cursor) > BigInt(entry.cursor));
        if (!events.length) continue;
        entry.cleanup();
        entry.resolve(events);
      }
    } catch (error) {
      // A trimmed notification range is a wake, never permission to invent a result.
      if (!(error instanceof AgentError) || error.code !== 'cursor_expired') throw error;
      for (const entry of [...this.pending]) {
        entry.cleanup();
        entry.resolve([]);
      }
    }
  }
  close() {
    for (const entry of [...this.pending]) {
      entry.cleanup();
      entry.reject(new AgentError('runtime_draining'));
    }
  }
}
