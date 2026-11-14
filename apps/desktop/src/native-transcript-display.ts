import type { Message } from '@kite-ai/client';
import { NativeDisplayCache } from './native-display-cache';
import type { desktopTranscript } from './native-transcript';

type Transcript = ReturnType<typeof desktopTranscript>;
type Reply = { identity: string; text: string } | undefined;

function executionMetadata(previous: Transcript, current: Transcript): Transcript['messages'] {
  const lifecycle = (message: Transcript['messages'][number]) =>
    message.tracePending ||
    ['turn_timing', 'turn_terminal', 'turn_failure', 'model_connection'].includes(
      message.systemKind ?? '',
    );
  const turns = new Set(
    current.messages
      .filter((message) => message.systemKind === 'turn_timing')
      .map((message) => message.turnId),
  );
  if (!turns.size) return previous.messages;
  const fresh = new Map(current.messages.map((message) => [message.id, message]));
  const messages = previous.messages.flatMap((message) => {
    if (!turns.has(message.turnId)) return [message];
    const next = fresh.get(message.id);
    if (lifecycle(message)) return next ? [next] : [];
    if (!next) return [message];
    // Preserve verified tool grouping while the metadata/body readers are held.
    // Keep the observed model phase current independently of tool metadata.
    return [
      {
        ...message,
        settled: next.settled,
        streaming: next.streaming,
        finalReply: next.finalReply,
        copyText: next.copyText,
      },
    ];
  });
  const ids = new Set(messages.map((message) => message.id));
  for (const [index, message] of current.messages.entries()) {
    if (!lifecycle(message) || ids.has(message.id)) continue;
    // A new execution row keeps its place before the following saved history.
    const following = current.messages.slice(index + 1).find((item) => ids.has(item.id));
    const position = following
      ? messages.findIndex((item) => item.id === following.id)
      : messages.length;
    messages.splice(position, 0, message);
    ids.add(message.id);
  }
  return messages;
}

/** Public snapshots are immutable JSON. Compare every field without copying large bodies. */
function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) =>
        Object.hasOwn(right, key) &&
        sameValue((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
    )
  );
}

/** Retain verified grouping only; current readers and actions keep their independent admission. */
export class NativeTranscriptDisplay {
  private readonly cache = new NativeDisplayCache<{
    messages: readonly Message[];
    replies: readonly Reply[];
    transcript: Transcript;
  }>();
  private bridge: unknown;
  private boundary: string | undefined;

  project(input: {
    bridge: unknown;
    boundary: string;
    key?: string;
    messages: readonly Message[];
    replies: readonly Reply[];
    transcript: Transcript;
    loading: boolean;
    unavailable: boolean;
    complete: boolean;
  }): Transcript {
    if (this.bridge !== input.bridge || this.boundary !== input.boundary) {
      this.cache.clear();
      this.bridge = input.bridge;
      this.boundary = input.boundary;
    }
    if (!input.key) return input.transcript;
    if (input.unavailable) {
      this.cache.delete(input.key);
      return input.transcript;
    }
    const retained = this.cache.get(input.key);
    if (
      input.loading &&
      retained &&
      sameValue(retained.messages, input.messages) &&
      sameValue(retained.replies, input.replies)
    )
      return {
        ...retained.transcript,
        messages: executionMetadata(retained.transcript, input.transcript),
        turnActivity: input.transcript.turnActivity,
      };
    if (!input.loading && input.complete)
      this.cache.set(input.key, {
        messages: [...input.messages],
        replies: [...input.replies],
        transcript: input.transcript,
      });
    return input.transcript;
  }
}
