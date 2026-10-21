import type { Message } from '@kite-ai/client';
import { NativeDisplayCache } from './native-display-cache';
import type { desktopTranscript } from './native-transcript';

type Transcript = ReturnType<typeof desktopTranscript>;
type Reply = { identity: string; text: string } | undefined;

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
      return { ...retained.transcript, turnActivity: input.transcript.turnActivity };
    if (!input.loading && input.complete)
      this.cache.set(input.key, {
        messages: [...input.messages],
        replies: [...input.replies],
        transcript: input.transcript,
      });
    return input.transcript;
  }
}
