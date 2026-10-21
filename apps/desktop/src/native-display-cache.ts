import { estimateNativeSnapshotBytes } from './native-history-cache';

/** Bounded display facts only; a hit never grants fresh read or write eligibility. */
export class NativeDisplayCache<T> {
  private entries = new Map<string, { value: T; bytes: number }>();
  private bytes = 0;

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T) {
    const previous = this.entries.get(key);
    if (previous) this.bytes -= previous.bytes;
    this.entries.delete(key);
    const bytes = key.length * 2 + estimateNativeSnapshotBytes(value);
    if (bytes > 4 * 1024 * 1024) return;
    this.entries.set(key, { value, bytes });
    this.bytes += bytes;
    while (this.entries.size > 12 || this.bytes > 16 * 1024 * 1024) {
      const oldest = this.entries.keys().next().value!;
      this.bytes -= this.entries.get(oldest)!.bytes;
      this.entries.delete(oldest);
    }
  }

  delete(key: string) {
    const previous = this.entries.get(key);
    if (previous) this.bytes -= previous.bytes;
    this.entries.delete(key);
  }

  clear() {
    this.entries.clear();
    this.bytes = 0;
  }
}
