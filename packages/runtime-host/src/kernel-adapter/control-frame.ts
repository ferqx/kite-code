import {
  isRuntimeControlFrame,
  RUNTIME_CONTROL_FRAME_SCHEMA_,
  type RuntimeControlFrame,
  type RuntimeControlFrameInput,
} from '@kite-ai/runtime-spi';

/** Create a frozen process-control frame. The inherited pipe/socket is the peer boundary. */
export function createRuntimeControlFrame<T>(
  input: RuntimeControlFrameInput<T>,
): RuntimeControlFrame<T> {
  if (!isRuntimeControlFrame(input)) throw new Error('Process frame is invalid.');
  return Object.freeze({ ...input });
}

/** Validate identity and monotonic ordering without inventing a cryptographic trust root. */
export function verifyRuntimeControlFrame<T>(input: {
  frame: RuntimeControlFrame<T>;
  expectedDomain: string;
  expectedPeerId: string;
  expectedInvocationId: string;
  lastSequence?: number;
}): T {
  const { frame } = input;
  if (
    !isRuntimeControlFrame(frame) ||
    frame.schema !== RUNTIME_CONTROL_FRAME_SCHEMA_ ||
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
