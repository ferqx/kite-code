import type { RuntimeBackgroundExecutionSnapshot } from '@kite-ai/runtime-contract';

/** A directory read pins one projection; control queries always read their own current facts. */
export class BackgroundExecutionPages {
  readonly #snapshots = new Map<
    string,
    { snapshot: RuntimeBackgroundExecutionSnapshot; expiresAt: number }
  >();
  #cleanupTimer: ReturnType<typeof setTimeout> | undefined;

  read(
    binding: string,
    cursor: number | undefined,
    project: () => RuntimeBackgroundExecutionSnapshot,
  ): RuntimeBackgroundExecutionSnapshot {
    const now = Date.now();
    for (const [key, value] of this.#snapshots) {
      if (value.expiresAt <= now) this.#snapshots.delete(key);
    }
    const cached = this.#snapshots.get(binding);
    if (cursor !== undefined && cursor > 0 && cached) {
      cached.expiresAt = now + 30_000;
      this.#snapshots.delete(binding);
      this.#snapshots.set(binding, cached);
      this.#scheduleCleanup();
      return cached.snapshot;
    }
    const snapshot = project();
    this.#snapshots.set(binding, { snapshot, expiresAt: now + 30_000 });
    // This is disposable retention, never an admission or directory-size limit.
    while (this.#snapshots.size > 256) this.#snapshots.delete(this.#snapshots.keys().next().value!);
    this.#scheduleCleanup();
    return snapshot;
  }

  clear(): void {
    if (this.#cleanupTimer !== undefined) clearTimeout(this.#cleanupTimer);
    this.#cleanupTimer = undefined;
    this.#snapshots.clear();
  }

  #scheduleCleanup(): void {
    if (this.#cleanupTimer !== undefined) clearTimeout(this.#cleanupTimer);
    this.#cleanupTimer = undefined;
    if (this.#snapshots.size === 0) return;
    const expiresAt = Math.min(...Array.from(this.#snapshots.values(), (value) => value.expiresAt));
    this.#cleanupTimer = setTimeout(
      () => {
        this.#cleanupTimer = undefined;
        const now = Date.now();
        for (const [key, value] of this.#snapshots) {
          if (value.expiresAt <= now) this.#snapshots.delete(key);
        }
        this.#scheduleCleanup();
      },
      Math.max(1, expiresAt - Date.now()),
    );
    this.#cleanupTimer.unref();
  }
}
