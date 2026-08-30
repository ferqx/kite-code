import { createConnection, type Socket } from 'node:net';
import {
  decodeKiteLocalNativeRequest,
  decodeKiteLocalNativeResponse,
  encodeKiteLocalNativeFrame,
  KITE_LOCAL_NATIVE_MAX_FRAME_BYTES,
  type KiteLocalNativeRequest,
  type KiteLocalNativeResponse,
  type KiteLocalRuntimeEndpoint,
} from '../service';

const DEFAULT_DEADLINE_MS = 2_000;

export type KiteLocalNativeConnectionErrorCode =
  | 'unavailable'
  | 'deadline_exceeded'
  | 'invalid_response';

export class KiteLocalNativeConnectionError extends Error {
  readonly code: KiteLocalNativeConnectionErrorCode;

  constructor(code: KiteLocalNativeConnectionErrorCode) {
    super('Local Native IPC request failed.');
    this.name = 'KiteLocalNativeConnectionError';
    this.code = code;
  }
}

export interface KiteLocalNativeRequestOptions {
  readonly deadlineMs?: number;
  readonly signal?: AbortSignal;
}

/** One bounded request/response exchange over the per-home native endpoint. */
export async function requestKiteLocalNativeEndpoint(
  endpoint: KiteLocalRuntimeEndpoint,
  request: KiteLocalNativeRequest,
  options: KiteLocalNativeRequestOptions = {},
): Promise<KiteLocalNativeResponse> {
  const validatedRequest = decodeKiteLocalNativeRequest(request);
  const deadlineMs = positiveDeadline(options.deadlineMs);
  if (options.signal?.aborted) throw connectionError('unavailable');
  let socket: Socket;
  try {
    socket = createConnection(endpoint.kind === 'unix' ? endpoint.socket : endpoint.pipeName);
  } catch {
    throw connectionError('unavailable');
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = () => socket.destroy(connectionError('unavailable'));
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await new Promise<KiteLocalNativeResponse>((resolvePromise, reject) => {
      let buffer = Buffer.alloc(0);
      let bytes = 0;
      let settled = false;
      const fail = (error: KiteLocalNativeConnectionError): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      timer = setTimeout(() => {
        fail(connectionError('deadline_exceeded'));
        socket.destroy();
      }, deadlineMs);
      socket.once('connect', () => {
        try {
          socket.write(encodeKiteLocalNativeFrame(validatedRequest));
        } catch {
          fail(connectionError('unavailable'));
          socket.destroy();
        }
      });
      socket.on('data', (chunk: Buffer) => {
        if (settled) return;
        bytes += chunk.byteLength;
        if (bytes > KITE_LOCAL_NATIVE_MAX_FRAME_BYTES) {
          fail(connectionError('invalid_response'));
          socket.destroy();
          return;
        }
        buffer = Buffer.concat([buffer, chunk], bytes);
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) return;
        if (newline !== buffer.byteLength - 1 || buffer.subarray(0, newline).includes(0x0a)) {
          fail(connectionError('invalid_response'));
          socket.destroy();
          return;
        }
        let decoded: KiteLocalNativeResponse;
        try {
          decoded = decodeKiteLocalNativeResponse(
            JSON.parse(buffer.subarray(0, newline).toString('utf8')) as unknown,
          );
          if (decoded.requestId !== validatedRequest.requestId) {
            throw new Error('request identity mismatch');
          }
        } catch {
          fail(connectionError('invalid_response'));
          socket.destroy();
          return;
        }
        settled = true;
        resolvePromise(decoded);
        socket.end();
      });
      socket.once('error', () => fail(connectionError('unavailable')));
      socket.once('end', () => {
        if (!settled) fail(connectionError('invalid_response'));
      });
    });
    return response;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    socket.destroy();
  }
}

function positiveDeadline(value: number | undefined): number {
  const selected = value ?? DEFAULT_DEADLINE_MS;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > 30_000) {
    throw new RangeError('Native IPC deadline must be a positive bounded integer.');
  }
  return selected;
}

function connectionError(code: KiteLocalNativeConnectionErrorCode): KiteLocalNativeConnectionError {
  return new KiteLocalNativeConnectionError(code);
}
