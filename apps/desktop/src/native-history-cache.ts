import type { Message } from '@kite-ai/client';

const MAX_ENTRIES = 12;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;

/** Inactive, published data only. Taking an entry transfers ownership to the active view. */
export class NativeHistoryCache {
  private entries = new Map<string, { storeId: string; messages: Message[]; bytes: number }>();
  private bytes = 0;

  private key(storeId: string, sessionId: string) {
    return JSON.stringify([storeId, sessionId]);
  }

  take(storeId: string, sessionId: string): Message[] | undefined {
    return this.remove(this.key(storeId, sessionId))?.messages;
  }

  private remove(key: string) {
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.bytes -= entry.bytes;
    }
    return entry;
  }

  save(storeId: string, sessionId: string, messages: Message[]) {
    const key = this.key(storeId, sessionId);
    this.remove(key);
    const bytes = estimateNativeSnapshotBytes(messages) + key.length * 2;
    if (bytes > MAX_ENTRY_BYTES) return;
    this.entries.set(key, { storeId, messages, bytes });
    this.bytes += bytes;
    while (this.entries.size > MAX_ENTRIES || this.bytes > MAX_BYTES)
      this.remove(this.entries.keys().next().value!);
  }

  evictStore(storeId: string) {
    for (const [key, entry] of this.entries) if (entry.storeId === storeId) this.remove(key);
  }

  clear() {
    this.entries.clear();
    this.bytes = 0;
  }
}

/** Conservative retained-payload estimate, not a JavaScript heap measurement. */
export function estimateNativeSnapshotBytes(value: unknown, limit = MAX_ENTRY_BYTES): number {
  if (typeof value === 'string') return 16 + value.length * 2;
  if (value === null || typeof value !== 'object') return 8;
  let bytes = 32;
  if (Array.isArray(value)) {
    for (const child of value) {
      bytes += 16 + estimateNativeSnapshotBytes(child, limit - bytes - 16);
      if (bytes > limit) break;
    }
  } else {
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      const overhead = 16 + key.length * 2;
      bytes +=
        overhead +
        estimateNativeSnapshotBytes(
          (value as Record<string, unknown>)[key],
          limit - bytes - overhead,
        );
      if (bytes > limit) break;
    }
  }
  return bytes;
}
