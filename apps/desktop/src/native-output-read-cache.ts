import { estimateNativeSnapshotBytes } from './native-history-cache';

/** Bounded, current-observation display snapshots. Never used to authorize an operation. */
export class NativeOutputReadCache {
  private values = new Map<string, { value: unknown; bytes: number }>();
  private pending = new Map<string, Promise<unknown>>();
  private bytes = 0;
  private selection = '';
  private selectionEpoch = 0;
  private roots = new Set<string>();
  private version = 0;
  private unpublished = false;
  private listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  readonly snapshot = () => this.version;

  cover(roots: readonly string[]) {
    if (roots.length === this.roots.size && roots.every((root) => this.roots.has(root))) return;
    this.roots = new Set(roots);
    this.version++;
    this.unpublished = true;
  }

  valid(root: string) {
    return this.roots.has(root);
  }

  /** Publish after commit so inactive retained React trees also revoke their old display. */
  publish() {
    if (!this.unpublished) return;
    this.unpublished = false;
    for (const listener of this.listeners) listener();
  }

  select(key: string) {
    if (this.selection === key) return this.selectionEpoch;
    this.selection = key;
    this.selectionEpoch++;
    // An old A request is not an observation of a later A selection.
    this.pending.clear();
    return this.selectionEpoch;
  }

  /** A visibility probe is not a read and must not promote an offscreen window in the LRU. */
  peek<T>(key: string): T | undefined {
    return this.values.get(key)?.value as T | undefined;
  }

  get<T>(key: string): T | undefined {
    const entry = this.values.get(key);
    if (!entry) return undefined;
    this.values.delete(key);
    this.values.set(key, entry);
    return entry.value as T;
  }

  set<T>(key: string, value: T) {
    const previous = this.values.get(key);
    if (previous) this.bytes -= previous.bytes;
    this.values.delete(key);
    const bytes = key.length * 2 + estimateNativeSnapshotBytes(value);
    if (bytes > 4 * 1024 * 1024) return;
    this.values.set(key, { value, bytes });
    this.bytes += bytes;
    while (this.values.size > 256 || this.bytes > 16 * 1024 * 1024) {
      const oldest = this.values.keys().next().value!;
      this.bytes -= this.values.get(oldest)!.bytes;
      this.values.delete(oldest);
    }
  }

  async read<T>(key: string, load: () => Promise<T>): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) return cached;
    const existing = this.pending.get(key);
    if (existing) return existing as Promise<T>;
    const epoch = this.selectionEpoch;
    const pending = load().then((value) => {
      if (epoch === this.selectionEpoch) this.set(key, value);
      return value;
    });
    // Reads still work under pressure; only sharing/retention is bounded.
    if (this.pending.size < 128) this.pending.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.pending.get(key) === pending) this.pending.delete(key);
    }
  }
}
