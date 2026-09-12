import type { Message } from './presentation';

const MAX_ENTRIES = 12;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;

interface CachedHistory {
  readonly workspaceDigest: string;
  readonly messages: readonly Message[];
  readonly hasLoadedHistory: true;
  readonly bytes: number;
}

/** Only inactive histories live here. Taking a history transfers ownership to the view. */
export class SessionHistoryCache {
  readonly #entries = new Map<string, CachedHistory>();
  #bytes = 0;

  take(sessionId: string): CachedHistory | undefined {
    const entry = this.#entries.get(sessionId);
    if (entry) {
      this.#entries.delete(sessionId);
      this.#bytes -= entry.bytes;
    }
    return entry;
  }

  save(sessionId: string, workspaceDigest: string, messages: readonly Message[]): void {
    this.take(sessionId);
    const bytes = estimateBytes(messages) + sessionId.length * 2 + workspaceDigest.length * 2;
    if (bytes > MAX_ENTRY_BYTES) return;
    this.#entries.set(sessionId, { workspaceDigest, messages, hasLoadedHistory: true, bytes });
    this.#bytes += bytes;
    while (this.#entries.size > MAX_ENTRIES || this.#bytes > MAX_BYTES) {
      this.take(this.#entries.keys().next().value!);
    }
  }

  clear(): void {
    this.#entries.clear();
    this.#bytes = 0;
  }
}

/** Conservative retained-payload estimate, not a measurement of the JavaScript heap. */
function estimateBytes(value: unknown): number {
  if (typeof value === 'string') return 16 + value.length * 2;
  if (value === null || typeof value !== 'object') return 8;
  let bytes = 32;
  for (const [key, child] of Object.entries(value)) {
    bytes += 16 + key.length * 2 + estimateBytes(child);
    // Once ineligible, avoid scanning the rest of a very large tool payload.
    if (bytes > MAX_ENTRY_BYTES) return bytes;
  }
  return bytes;
}
