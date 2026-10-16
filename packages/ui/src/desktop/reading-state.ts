import type { ReadingState } from './Conversation';
import type { Message } from './types';

const MAX_ENTRIES = 32;
const MAX_BYTES = 256 * 1024;
const MAX_EXPANDED = 512;

/** Retain reading data only; readers and their DOM always belong to the current page. */
export class ReadingStateCache {
  private readonly entries = new Map<string, { state: ReadingState; bytes: number }>();
  private bytes = 0;

  get(key: string): ReadingState | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.state;
  }

  save(key: string, value: ReadingState): void {
    const previous = this.entries.get(key);
    if (previous) this.bytes -= previous.bytes;
    this.entries.delete(key);
    const state = {
      ...value,
      expanded: Object.fromEntries(Object.entries(value.expanded).slice(-MAX_EXPANDED)),
    };
    const bytes = (key.length + JSON.stringify(state).length) * 2;
    if (bytes > MAX_BYTES) return;
    this.entries.set(key, { state, bytes });
    this.bytes += bytes;
    while (this.entries.size > MAX_ENTRIES || this.bytes > MAX_BYTES) {
      const oldest = this.entries.keys().next().value!;
      this.bytes -= this.entries.get(oldest)!.bytes;
      this.entries.delete(oldest);
    }
  }
}

export function pruneReadingState(
  state: ReadingState,
  messages: readonly Message[],
  activeTurnId?: string,
): ReadingState {
  const valid = new Set<string>();
  const addTurn = (id: string) => {
    valid.add(`turn:${id}:complete`);
    valid.add(`turn:${id}:process`);
  };
  if (activeTurnId) addTurn(activeTurnId);
  for (const message of messages) {
    valid.add(message.id);
    valid.add(`activity:${message.id}`);
    if (message.turnId) addTurn(message.turnId);
    for (const step of message.steps ?? []) valid.add(`subagent-step:${step.id}`);
  }
  return {
    ...state,
    expanded: Object.fromEntries(
      Object.entries(state.expanded)
        .filter(([id]) => valid.has(id))
        .slice(-MAX_EXPANDED),
    ),
  };
}
