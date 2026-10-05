import { ClientError, type ModelOutputSnapshot, verifyModelOutputSnapshot } from '@kite-ai/client';
import type { NativeBridge, NativeModelBodyOpen } from './native-bridge';

/** Complete public snapshot over finite IPC; cancellation releases only the view read. */
export type NativeModelBodyRead = {
  bridge: NativeBridge;
  generation: number;
  expectedStoreId: string;
  sessionId: string;
  viewSessionId?: string;
  messageId?: string;
  executionId: string;
  signal: AbortSignal;
  isCurrent: () => boolean;
};
export async function readNativeModelOutput(
  input: NativeModelBodyRead,
): Promise<ModelOutputSnapshot> {
  return readNativeModelBody(input, 'modelOutput', verifyModelOutputSnapshot);
}
export async function readNativeModelBody<
  S extends {
    storeId: string;
    sessionId: string;
    executionId: string;
    bodyHash: string;
    bodyBytes: string;
  },
>(
  input: NativeModelBodyRead,
  kind: 'modelOutput' | 'modelInput',
  verify: (value: unknown, signal: AbortSignal) => Promise<S>,
): Promise<S> {
  const code = (value: string) =>
    kind === 'modelInput' ? value.replace('model_output_', 'model_input_') : value;
  const readId = crypto.randomUUID();
  const check = () => {
    input.signal.throwIfAborted();
    if (!input.isCurrent()) throw new ClientError(code('model_output_view_changed'));
  };
  const close = () =>
    input.bridge
      .request({ method: `${kind}.close`, generation: input.generation, readId })
      .catch(() => {});
  const abort = () => {
    void close();
  };
  input.signal.addEventListener('abort', abort, { once: true });
  try {
    check();
    const raw = await input.bridge.request({
      method: `${kind}.open`,
      generation: input.generation,
      readId,
      expectedStoreId: input.expectedStoreId,
      sessionId: input.viewSessionId ?? input.sessionId,
      executionId: input.executionId,
      ...(kind === 'modelOutput' && input.messageId ? { messageId: input.messageId } : {}),
    });
    check();
    if (!raw || !('readId' in raw) || raw.kind !== `${kind}.opened`)
      throw new ClientError(code('model_output_metadata_invalid'));
    const opened = raw as NativeModelBodyOpen<'modelOutput' | 'modelInput'>;
    if (
      opened.readId !== readId ||
      opened.viewGeneration !== input.generation ||
      opened.storeId !== input.expectedStoreId ||
      opened.sessionId !== input.sessionId ||
      opened.executionId !== input.executionId ||
      !Number.isSafeInteger(opened.viewSelection) ||
      opened.viewSelection < 1 ||
      !/^[1-9][0-9]{0,18}$/.test(opened.wireBytes) ||
      BigInt(opened.wireBytes) > BigInt(Number.MAX_SAFE_INTEGER) ||
      !/^[a-f0-9]{64}$/.test(opened.bodyHash)
    )
      throw new ClientError(code('model_output_metadata_invalid'));
    const bytes = new Uint8Array(Number(opened.wireBytes));
    let offset = 0;
    for (;;) {
      check();
      const chunk = await input.bridge.request({
        method: `${kind}.read`,
        generation: input.generation,
        readId,
        offset,
        limit: 65536,
      });
      check();
      if (
        !chunk ||
        !('readId' in chunk) ||
        !('offset' in chunk) ||
        chunk.kind !== `${kind}.chunk` ||
        chunk.readId !== readId ||
        chunk.offset !== offset ||
        !Number.isSafeInteger(chunk.nextOffset) ||
        typeof chunk.eof !== 'boolean' ||
        typeof chunk.data !== 'string' ||
        chunk.data.length > 87384 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chunk.data)
      )
        throw new ClientError(code('model_output_chunk_invalid'));
      const binary = atob(chunk.data),
        next = offset + binary.length;
      if (
        binary.length > 65536 ||
        next !== chunk.nextOffset ||
        next > bytes.length ||
        (!chunk.eof && binary.length === 0) ||
        chunk.eof !== (next === bytes.length)
      )
        throw new ClientError(code('model_output_chunk_invalid'));
      for (let index = 0; index < binary.length; index++)
        bytes[offset + index] = binary.charCodeAt(index);
      offset = next;
      if (chunk.eof) break;
    }
    check();
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw new ClientError(code('model_output_invalid_body'));
    }
    const snapshot = await verify(parsed, input.signal);
    check();
    if (
      snapshot.storeId !== opened.storeId ||
      snapshot.sessionId !== opened.sessionId ||
      snapshot.executionId !== opened.executionId ||
      snapshot.bodyHash !== opened.bodyHash ||
      snapshot.bodyBytes !== opened.bodyBytes
    )
      throw new ClientError(code('model_output_identity_mismatch'));
    return snapshot;
  } finally {
    input.signal.removeEventListener('abort', abort);
    await close();
  }
}
