import type { Socket } from 'node:net';
import {
  KITE_LIFECYCLE_MAX_BYTES,
  KITE_LIFECYCLE_REQUEST,
  KITE_LIFECYCLE_SCHEMA,
  KITE_LIFECYCLE_TIMEOUT_MS,
  type KiteLifecycleRequest,
  type KiteLifecycleResponse,
} from '@kite-ai/kite-local-runtime/client';

/** Classifies before Runtime decoding. A connection selects exactly one protocol. */
export async function serveKiteLifecycleOrRuntime(
  socket: Socket,
  dispatch: (request: KiteLifecycleRequest) => Promise<KiteLifecycleResponse>,
  runtime: () => Promise<void>,
): Promise<void> {
  try {
    const buffered = await new Promise<Buffer>((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      const timer = setTimeout(
        () => done(new Error('First frame timeout.')),
        KITE_LIFECYCLE_TIMEOUT_MS,
      );
      const onError = () => done(new Error('Connection closed.'));
      const done = (error?: Error) => {
        clearTimeout(timer);
        socket.off('data', onData);
        socket.off('error', onError);
        socket.off('close', onError);
        socket.pause();
        if (error) reject(error);
        else resolve(buffer);
      };
      const onData = (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        const newline = buffer.indexOf(10);
        if (newline >= 0 && newline <= KITE_LIFECYCLE_MAX_BYTES) done();
        else if (buffer.length > KITE_LIFECYCLE_MAX_BYTES)
          done(new Error('First frame too large.'));
      };
      socket.on('data', onData);
      socket.once('error', onError);
      socket.once('close', onError);
      socket.resume();
    });
    const frame = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(buffered.subarray(0, buffered.indexOf(10))),
    ) as Record<string, unknown>;
    if (!('schema' in frame)) {
      socket.unshift(buffered);
      const done = runtime();
      socket.resume();
      await done;
      return;
    }
    const parsed = KITE_LIFECYCLE_REQUEST.safeParse(frame);
    const response = parsed.success
      ? await dispatch(parsed.data)
      : {
          schema: KITE_LIFECYCLE_SCHEMA,
          requestId: frame.requestId,
          operation: 'error',
          code: frame.schema === KITE_LIFECYCLE_SCHEMA ? 'invalid_request' : 'unsupported',
        };
    const bytes = Buffer.from(`${JSON.stringify(response)}\n`);
    if (bytes.length > KITE_LIFECYCLE_MAX_BYTES) throw new Error('Lifecycle response too large.');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('Lifecycle write timeout.'));
      }, KITE_LIFECYCLE_TIMEOUT_MS);
      socket.end(bytes, () => {
        clearTimeout(timer);
        resolve();
      });
    });
  } catch {
    socket.destroy();
  }
}
