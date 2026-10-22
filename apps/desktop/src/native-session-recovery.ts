type Work = () => unknown | Promise<unknown>;
type Entry = { work: Work; attempts: number; timer?: ReturnType<typeof setTimeout> };

/** One read per key at a time; capped backoff keeps transient failures recoverable. */
export class NativeSessionRecovery {
  private entries = new Map<string, Entry>();
  private running = new Map<string, Entry>();
  private readonly delays: readonly number[];
  constructor(delays: readonly number[] = [250, 1000, 3000, 15000]) {
    this.delays = delays;
  }

  has(key: string) {
    return this.entries.has(key);
  }

  reconcile(work: ReadonlyMap<string, Work>) {
    for (const [key, entry] of this.entries)
      if (!work.has(key)) {
        clearTimeout(entry.timer);
        this.entries.delete(key);
      }
    for (const [key, action] of work) {
      const entry = this.entries.get(key);
      if (entry) entry.work = action;
      else {
        const next: Entry = { work: action, attempts: 0 };
        this.entries.set(key, next);
        this.schedule(key, next);
      }
    }
  }

  private schedule(key: string, entry: Entry) {
    const delay = this.delays[Math.min(entry.attempts, this.delays.length - 1)];
    if (delay === undefined || this.entries.get(key) !== entry) return;
    entry.timer = setTimeout(async () => {
      if (this.entries.get(key) !== entry) return;
      // Revoked scopes keep only a same-key tombstone. Their pending IPC reads
      // must not consume the recovery budget of the newly selected scope.
      let active = 0;
      for (const runningKey of this.running.keys()) if (this.entries.has(runningKey)) active++;
      if (active >= 2 || this.running.has(key)) {
        this.schedule(key, entry);
        return;
      }
      entry.attempts++;
      this.running.set(key, entry);
      try {
        await entry.work();
      } catch {
        // Preserve the durable original identity and its unresolved outcome.
      } finally {
        if (this.running.get(key) === entry) this.running.delete(key);
        this.schedule(key, entry);
      }
    }, delay);
  }

  close() {
    this.reconcile(new Map());
  }
}
