import { createHash } from 'node:crypto';
import { schemas } from './http/schema';

/** Bounded wire chunks; original Model bodies are never trimmed to the ordinary JSON budget. */
function modelSnapshotResponse(
  kind: 'model-input' | 'model-output',
  input: unknown,
  signal: AbortSignal,
  headers: Record<string, string> = {},
): Response {
  signal.throwIfAborted();
  const schema = kind === 'model-input' ? schemas.ModelInputSnapshot : schemas.ModelOutputSnapshot;
  const bytes = Buffer.from(JSON.stringify(schema.parse(input)));
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (signal.aborted) {
        controller.error(signal.reason);
        return;
      }
      if (offset === bytes.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(offset + 64 * 1024, bytes.byteLength);
      controller.enqueue(Uint8Array.from(bytes.subarray(offset, end)));
      offset = end;
    },
  });
  return new Response(body, {
    headers: {
      ...headers,
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(bytes.byteLength),
      [`x-${kind}-size`]: String(bytes.byteLength),
      [`x-${kind}-hash`]: createHash('sha256').update(bytes).digest('hex'),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

export function modelInputResponse(
  input: unknown,
  signal: AbortSignal,
  headers: Record<string, string> = {},
) {
  return modelSnapshotResponse('model-input', input, signal, headers);
}
export function modelOutputResponse(
  input: unknown,
  signal: AbortSignal,
  headers: Record<string, string> = {},
) {
  return modelSnapshotResponse('model-output', input, signal, headers);
}
