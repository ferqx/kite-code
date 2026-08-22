import { BoundedOutputBuffer, BoundedProgressLineBuffer } from './stream-output';

/**
 * Drain one supervised process stream with bounded capture and bounded
 * progress-line buffering. Runtime Host owns the generic process lifecycle;
 * callers retain only domain projection callbacks.
 */
export async function readRuntimeHostProcessOutputV1(
  stream: ReadableStream<Uint8Array>,
  onLine?: (line: string) => void,
  stopSignal?: AbortSignal,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const output = new BoundedOutputBuffer();
  const progressLines = new BoundedProgressLineBuffer();
  let stopped = false;
  const stop = () => {
    stopped = true;
    void reader.cancel();
  };
  stopSignal?.addEventListener('abort', stop, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done || stopped) break;
      const text = decoder.decode(value, { stream: true });
      output.append(text);
      if (onLine) progressLines.push(text, onLine);
    }
    if (!stopped) {
      const flushed = decoder.decode();
      if (flushed) {
        output.append(flushed);
        if (onLine) progressLines.push(flushed, onLine);
      }
      if (onLine) progressLines.flush(onLine);
    }
  } catch {
    if (!stopped && onLine) progressLines.flush(onLine);
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
