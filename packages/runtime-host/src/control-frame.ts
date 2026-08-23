import {
  isRuntimeControlFrameV1,
  RUNTIME_CONTROL_FRAME_SCHEMA_V1,
  type RuntimeControlFrameInputV1,
  type RuntimeControlFrameV1,
} from '@kite/runtime-spi';

/** Create a frozen process-control frame. The inherited pipe/socket is the peer boundary. */
export function createRuntimeControlFrameV1<T>(
  input: RuntimeControlFrameInputV1<T>,
): RuntimeControlFrameV1<T> {
  if (!isRuntimeControlFrameV1(input)) throw new Error('Process frame is invalid.');
  return Object.freeze({ ...input });
}

/** Validate identity and monotonic ordering without inventing a cryptographic trust root. */
export function verifyRuntimeControlFrameV1<T>(input: {
  frame: RuntimeControlFrameV1<T>;
  expectedDomain: string;
  expectedPeerId: string;
  expectedInvocationId: string;
  lastSequence?: number;
}): T {
  const { frame } = input;
  if (
    !isRuntimeControlFrameV1(frame) ||
    frame.schema !== RUNTIME_CONTROL_FRAME_SCHEMA_V1 ||
    frame.domain !== input.expectedDomain ||
    frame.peerId !== input.expectedPeerId ||
    frame.invocationId !== input.expectedInvocationId
  ) {
    throw new Error('Process frame identity mismatch.');
  }
  if (frame.sequence <= (input.lastSequence ?? -1)) {
    throw new Error('Process frame replay detected.');
  }
  return frame.payload;
}
