import type { RuntimeClientEvent } from '@kite-ai/runtime-contract';
import { type Message, projectEvent } from './presentation';

/** Yield between bounded batches without publishing partial historical pages. */
export async function projectHistory(
  events: readonly RuntimeClientEvent[],
  previous: readonly Message[],
  signal: AbortSignal,
): Promise<readonly Message[]> {
  let messages: readonly Message[] = [];
  let started = performance.now();
  let count = 0;
  for (const event of events) {
    signal.throwIfAborted();
    messages = projectEvent(messages, event);
    if (++count === 200 || performance.now() - started >= 8) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      signal.throwIfAborted();
      started = performance.now();
      count = 0;
    }
  }
  const byId = new Map(previous.map((message) => [message.id, message]));
  let unchanged = messages.length === previous.length;
  const shared: Message[] = [];
  for (let index = 0; index < messages.length; index++) {
    const next = messages[index]!;
    const old = byId.get(next.id);
    const message = old && equalDisplayValue(old, next) ? old : next;
    shared.push(message);
    unchanged &&= message === previous[index];
    if (++count === 200 || performance.now() - started >= 8) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      signal.throwIfAborted();
      started = performance.now();
      count = 0;
    }
  }
  signal.throwIfAborted();
  return unchanged ? previous : shared;
}

// Message fields contain JSON-safe presentation data, including nested tool arguments.
function equalDisplayValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every(
    (key) =>
      Object.hasOwn(right, key) &&
      equalDisplayValue(
        (left as Record<string, unknown>)[key],
        (right as Record<string, unknown>)[key],
      ),
  );
}
