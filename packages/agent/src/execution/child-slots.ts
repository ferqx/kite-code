import { AgentError } from '../storage/types';

type Waiter = {
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  signal: AbortSignal;
  abort: () => void;
};
type Group = { limit: number; used: number; waiters: Waiter[] };

/** Direct delegations have a per-Run limit; waiting parents hold no model/process permit. */
export class ChildSlots {
  private readonly groups = new Map<string, Group>();
  /** Reserve before a fail-fast delegation creates durable child identities. No queue is created. */
  tryAcquire(key: string, limit: number, signal: AbortSignal): (() => void) | null {
    signal.throwIfAborted();
    let group = this.groups.get(key);
    if (!group) {
      group = { limit, used: 0, waiters: [] };
      this.groups.set(key, group);
    }
    if (group.limit !== limit) throw new AgentError('child_configuration_changed');
    if (group.used >= limit || group.waiters.length > 0) return null;
    group.used++;
    return this.release(key, group);
  }
  async acquire(key: string, limit: number, signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    let group = this.groups.get(key);
    if (!group) {
      group = { limit, used: 0, waiters: [] };
      this.groups.set(key, group);
    }
    if (group.limit !== limit) throw new AgentError('child_configuration_changed');
    if (group.used < limit) {
      group.used++;
      return this.release(key, group);
    }
    if (group.waiters.length >= 256) throw new AgentError('child_queue_full');
    const current = group;
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        signal,
        abort: () => {
          const index = current.waiters.indexOf(waiter);
          if (index >= 0) current.waiters.splice(index, 1);
          reject(signal.reason);
        },
      };
      current.waiters.push(waiter);
      signal.addEventListener('abort', waiter.abort, { once: true });
      if (signal.aborted) waiter.abort();
    });
  }
  private release(key: string, group: Group): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = group.waiters.shift();
      if (next) {
        next.signal.removeEventListener('abort', next.abort);
        next.resolve(this.release(key, group));
      } else if (--group.used === 0) {
        this.groups.delete(key);
      }
    };
  }
}
