import { ClientError, type ModelOutputSnapshot, verifyModelOutputSnapshot } from '@kite-ai/client';
import { readNativeBodyChunks } from './native-body-chunks';
import type { NativeBridge, NativeModelBodyOpen } from './native-bridge';
import { NativeMarkdownOwner } from './native-markdown';

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
type NativeModelBodyKind = 'modelOutput' | 'modelInput';
const bodyReadQueues = new WeakMap<NativeBridge, Map<NativeModelBodyKind, Promise<void>>>();

/** Match Main's single body lease without retaining completed snapshots in the queue. */
async function acquireBodyRead(input: NativeModelBodyRead, kind: NativeModelBodyKind) {
  input.signal.throwIfAborted();
  let queue = bodyReadQueues.get(input.bridge);
  if (!queue) {
    queue = new Map();
    bodyReadQueues.set(input.bridge, queue);
  }
  const previous = queue.get(kind) ?? Promise.resolve();
  let complete!: () => void;
  const released = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const tail = previous.then(() => released);
  queue.set(kind, tail);
  const release = () => {
    complete();
    void tail.then(() => {
      if (queue.get(kind) === tail) queue.delete(kind);
    });
  };
  let abort: (() => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      abort = () => reject(input.signal.reason);
      input.signal.addEventListener('abort', abort, { once: true });
      previous.then(resolve);
    });
    input.signal.throwIfAborted();
    return release;
  } catch (cause) {
    release();
    throw cause;
  } finally {
    if (abort) input.signal.removeEventListener('abort', abort);
  }
}
export async function readNativeModelOutput(
  input: NativeModelBodyRead,
): Promise<ModelOutputSnapshot> {
  const snapshot = await readNativeModelBody(input, 'modelOutput', verifyModelOutputSnapshot);
  const owner = new NativeMarkdownOwner(input.signal);
  try {
    await owner.prepare(snapshot);
    input.signal.throwIfAborted();
    if (!input.isCurrent()) throw new ClientError('model_output_view_changed');
    return snapshot;
  } catch (cause) {
    owner.dispose();
    throw cause;
  }
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
  kind: NativeModelBodyKind,
  verify: (value: unknown, signal: AbortSignal) => Promise<S>,
): Promise<S> {
  const code = (value: string) =>
    kind === 'modelInput' ? value.replace('model_output_', 'model_input_') : value;
  const readId = crypto.randomUUID();
  const check = () => {
    input.signal.throwIfAborted();
    if (!input.isCurrent()) throw new ClientError(code('model_output_view_changed'));
  };
  check();
  const release = await acquireBodyRead(input, kind);
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
    const bytes = await readNativeBodyChunks({
      byteLength: Number(opened.wireBytes),
      readId,
      kind: `${kind}.chunk`,
      read: (offset, limit) =>
        input.bridge.request({
          method: `${kind}.read`,
          generation: input.generation,
          readId,
          offset,
          limit,
        }),
      check,
      invalid: () => new ClientError(code('model_output_chunk_invalid')),
    });
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
    release();
  }
}
