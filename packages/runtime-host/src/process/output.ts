import { BoundedOutputBuffer } from './stream-output';

/**
 * Drain one supervised process stream. The return value is a bounded terminal
 * preview; the progress callback receives every decoded chunk so its owner can
 * persist the complete output for cursor reads.
 */
export async function readRuntimeHostProcessOutput(
  stream: ReadableStream<Uint8Array>,
  onLine?: (line: string) => void,
  stopSignal?: AbortSignal,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const output = new BoundedOutputBuffer();
  let stopped = false;
  const stop = () => {
    stopped = true;
    void reader.cancel();
  };
  stopSignal?.addEventListener('abort', stop, { once: true });
  if (stopSignal?.aborted) stop();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done || stopped) break;
      const text = decoder.decode(value, { stream: true });
      output.append(text);
      onLine?.(text);
    }
    if (!stopped) {
      const flushed = decoder.decode();
      if (flushed) {
        output.append(flushed);
        onLine?.(flushed);
      }
    }
  } catch (error) {
    if (!stopped) throw error;
  } finally {
    stopSignal?.removeEventListener('abort', stop);
    try {
      reader.releaseLock();
    } catch {
      // The transport may have released the reader while cancelling.
    }
  }
  return output.value();
}
