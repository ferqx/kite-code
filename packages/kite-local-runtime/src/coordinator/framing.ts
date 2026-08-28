import {
  assertCoordinatorJsonValue,
  COORDINATOR_LIMITS,
  type CoordinatorHandshakeRequest,
  type CoordinatorHandshakeResponse,
  type CoordinatorRequestFrame,
  type CoordinatorResponseFrame,
  decodeCoordinatorHandshakeRequest,
  decodeCoordinatorHandshakeResponse,
  decodeCoordinatorRequestFrame,
  decodeCoordinatorResponseFrame,
} from './codecs';

export const COORDINATOR_FRAME_PREFIX_BYTES = 4;

export type CoordinatorWireFrame =
  | CoordinatorHandshakeRequest
  | CoordinatorHandshakeResponse
  | CoordinatorRequestFrame
  | CoordinatorResponseFrame;

export type CoordinatorFramingErrorCode =
  | 'malformed_frame'
  | 'oversized_frame'
  | 'partial_frame'
  | 'unsupported_frame';

export class CoordinatorFramingError extends TypeError {
  readonly code: CoordinatorFramingErrorCode;

  constructor(code: CoordinatorFramingErrorCode, message: string) {
    super(message);
    this.name = 'CoordinatorFramingError';
    this.code = code;
  }
}

function assertMaxFrameBytes(value: number | undefined): number {
  const maxFrameBytes = value ?? COORDINATOR_LIMITS.maxFrameBytes;
  if (
    !Number.isSafeInteger(maxFrameBytes) ||
    maxFrameBytes < 1 ||
    maxFrameBytes > COORDINATOR_LIMITS.maxFrameBytes
  ) {
    throw new CoordinatorFramingError('oversized_frame', 'Coordinator frame limit is invalid.');
  }
  return maxFrameBytes;
}

/** Decode a complete JSON wire value after the carrier has removed its length prefix. */
export function decodeCoordinatorWireFrame(value: unknown): CoordinatorWireFrame {
  assertCoordinatorJsonValue(value);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CoordinatorFramingError('malformed_frame', 'Coordinator wire frame is malformed.');
  }
  const kind = (value as { readonly kind?: unknown }).kind;
  try {
    if (kind === 'handshake_request') return decodeCoordinatorHandshakeRequest(value);
    if (kind === 'handshake_response') return decodeCoordinatorHandshakeResponse(value);
    if (kind === 'request') return decodeCoordinatorRequestFrame(value);
    if (kind === 'response') return decodeCoordinatorResponseFrame(value);
  } catch {
    throw new CoordinatorFramingError('malformed_frame', 'Coordinator wire frame is malformed.');
  }
  throw new CoordinatorFramingError(
    'unsupported_frame',
    'Coordinator wire frame kind is unsupported.',
  );
}

export function encodeCoordinatorWireFrame(
  value: CoordinatorWireFrame,
  maxFrameBytes = COORDINATOR_LIMITS.maxFrameBytes,
): Uint8Array {
  const limit = assertMaxFrameBytes(maxFrameBytes);
  assertCoordinatorJsonValue(value);
  const frame = decodeCoordinatorWireFrame(value);
  let encoded: Uint8Array;
  try {
    encoded = new TextEncoder().encode(JSON.stringify(frame));
  } catch {
    throw new CoordinatorFramingError(
      'malformed_frame',
      'Coordinator wire frame is not serializable.',
    );
  }
  if (encoded.byteLength > limit) {
    throw new CoordinatorFramingError('oversized_frame', 'Coordinator wire frame is oversized.');
  }
  const result = new Uint8Array(COORDINATOR_FRAME_PREFIX_BYTES + encoded.byteLength);
  new DataView(result.buffer).setUint32(0, encoded.byteLength, false);
  result.set(encoded, COORDINATOR_FRAME_PREFIX_BYTES);
  return result;
}

/**
 * Incremental length-prefixed decoder.  A connection owns one instance; a
 * partial tail is only accepted when the connection remains open.
 */
export class CoordinatorLengthPrefixedFrameDecoder {
  readonly #maxFrameBytes: number;
  #buffer = new Uint8Array(0);

  constructor(maxFrameBytes = COORDINATOR_LIMITS.maxFrameBytes) {
    this.#maxFrameBytes = assertMaxFrameBytes(maxFrameBytes);
  }

  push(chunk: Uint8Array): readonly CoordinatorWireFrame[] {
    if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) return [];
    const merged = new Uint8Array(this.#buffer.byteLength + chunk.byteLength);
    merged.set(this.#buffer);
    merged.set(chunk, this.#buffer.byteLength);
    this.#buffer = merged;

    const frames: CoordinatorWireFrame[] = [];
    while (this.#buffer.byteLength >= COORDINATOR_FRAME_PREFIX_BYTES) {
      const size = new DataView(
        this.#buffer.buffer,
        this.#buffer.byteOffset,
        this.#buffer.byteLength,
      ).getUint32(0, false);
      if (size === 0) {
        throw new CoordinatorFramingError(
          'malformed_frame',
          'Coordinator frame has an empty body.',
        );
      }
      if (size > this.#maxFrameBytes) {
        throw new CoordinatorFramingError('oversized_frame', 'Coordinator frame is oversized.');
      }
      if (this.#buffer.byteLength < COORDINATOR_FRAME_PREFIX_BYTES + size) break;
      const body = this.#buffer.slice(
        COORDINATOR_FRAME_PREFIX_BYTES,
        COORDINATOR_FRAME_PREFIX_BYTES + size,
      );
      this.#buffer = this.#buffer.slice(COORDINATOR_FRAME_PREFIX_BYTES + size);
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
      } catch {
        throw new CoordinatorFramingError(
          'malformed_frame',
          'Coordinator frame JSON is malformed.',
        );
      }
      frames.push(decodeCoordinatorWireFrame(value));
    }
    return frames;
  }

  finish(): void {
    if (this.#buffer.byteLength !== 0) {
      throw new CoordinatorFramingError('partial_frame', 'Coordinator connection ended mid-frame.');
    }
  }
}
