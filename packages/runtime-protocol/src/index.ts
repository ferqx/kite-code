import { RUNTIME_PROTOCOL_MESSAGE_SCHEMA_ } from './codecs';
import { assertProtocolJsonValue } from './limits';

export * from './codecs';
export * from './generation';
export * from './limits';
export * from './mappers';

/** Decode one complete logical message; carriers own framing, not this package. */
export function decodeRuntimeProtocolMessage(value: unknown) {
  assertProtocolJsonValue(value);
  return RUNTIME_PROTOCOL_MESSAGE_SCHEMA_.parse(value);
}

/** Non-throwing form for endpoints that translate codec failures into JSON-RPC errors. */
export function safeDecodeRuntimeProtocolMessage(value: unknown) {
  try {
    return { success: true as const, data: decodeRuntimeProtocolMessage(value) };
  } catch (error) {
    return { success: false as const, error };
  }
}
