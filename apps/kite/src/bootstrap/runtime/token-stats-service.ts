export interface TokenStatsValue {
  readonly cacheHitTokens: number;
  readonly cacheMissTokens: number;
  readonly totalTokens: number;
}

export interface TokenStatsStorage {
  save(threadId: string, value: TokenStatsValue): void;
  loadAll(): readonly { sessionId: string; value: TokenStatsValue }[];
}

export class TokenStatsService {
  private readonly cache = new Map<string, TokenStatsValue>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly storage: TokenStatsStorage;
  private readonly debounceMs: number;

  constructor(storage: TokenStatsStorage, debounceMs = 1000) {
    this.storage = storage;
    this.debounceMs = debounceMs;
  }

  loadIfEmpty(): void {
    if (this.cache.size > 0) return;
    for (const entry of this.storage.loadAll()) this.cache.set(entry.sessionId, entry.value);
  }

  get(threadId: string): TokenStatsValue | undefined {
    return this.cache.get(threadId);
  }

  has(threadId: string): boolean {
    return this.cache.has(threadId);
  }

  save(threadId: string, value: TokenStatsValue, immediate = false): void {
    this.cache.set(threadId, value);
    if (immediate) {
      this.flush(threadId, value);
      return;
    }
    const existing = this.timers.get(threadId);
    if (existing) clearTimeout(existing);
    this.timers.set(
      threadId,
      setTimeout(() => {
        this.timers.delete(threadId);
        this.flush(threadId, this.cache.get(threadId) ?? value);
      }, this.debounceMs),
    );
  }

  flushAll(): void {
    for (const [threadId, timer] of this.timers) {
      clearTimeout(timer);
      const value = this.cache.get(threadId);
      if (value) this.flush(threadId, value);
    }
    this.timers.clear();
  }

  private flush(threadId: string, value: TokenStatsValue): void {
    try {
      this.storage.save(threadId, value);
    } catch {
      // Token statistics are best-effort and must not surface persistence errors in the TUI.
    }
  }
}
