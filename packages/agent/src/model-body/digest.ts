import { createHash } from 'node:crypto';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

/** Complete bytes, including the final byte, remain part of the original semantic proof. */
export async function semanticDigestBytes(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const digest = createHash('sha256');
  let deadline = performance.now() + 8;
  let chunks = 0;
  for (let offset = 0; offset < bytes.byteLength; offset += 64 * 1024) {
    signal?.throwIfAborted();
    digest.update(bytes.subarray(offset, offset + 64 * 1024));
    if (++chunks >= 64 || performance.now() >= deadline) {
      await yieldToEventLoop();
      signal?.throwIfAborted();
      chunks = 0;
      deadline = performance.now() + 8;
    }
  }
  signal?.throwIfAborted();
  return digest.digest('hex');
}
