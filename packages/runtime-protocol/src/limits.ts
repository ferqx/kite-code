/** Transport-independent protocol input limits. Carriers may impose stricter limits. */
export const RUNTIME_PROTOCOL_VERSION = 2 as const;
export const RUNTIME_PROTOCOL_SCHEMA = 'kite.runtime-protocol.v2' as const;

export const RUNTIME_PROTOCOL_LIMITS = Object.freeze({
  maxMessageBytes: 1_048_576,
  maxDepth: 32,
  maxRpcIdLength: 128,
  maxIdentifierLength: 256,
  maxTextLength: 65_536,
  maxArrayLength: 10_000,
  maxObjectKeys: 256,
  maxSubscriptions: 64,
  maxInFlightRequests: 64,
  maxOutboundMessages: 256,
});

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export class RuntimeProtocolValidationError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeProtocolValidationError';
  }
}

/**
 * Reject values that cannot have originated from one bounded JSON object.
 * This runs before Zod so schema parsing never walks attacker-controlled
 * prototypes, getters, circular values, or unexpectedly deep structures.
 */
export function assertProtocolJsonValue(value: unknown): void {
  const seen = new Set<object>();
  const visit = (candidate: unknown, depth: number): void => {
    if (depth > RUNTIME_PROTOCOL_LIMITS.maxDepth) {
      throw new RuntimeProtocolValidationError('Protocol JSON exceeds maximum depth');
    }
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean')
      return;
    if (typeof candidate === 'number') {
      if (
        !Number.isFinite(candidate) ||
        (Number.isInteger(candidate) && !Number.isSafeInteger(candidate))
      ) {
        throw new RuntimeProtocolValidationError('Protocol JSON contains an unsafe number');
      }
      return;
    }
    if (typeof candidate !== 'object') {
      throw new RuntimeProtocolValidationError('Protocol JSON contains a non-JSON value');
    }
    if (seen.has(candidate))
      throw new RuntimeProtocolValidationError('Protocol JSON contains a cycle');
    seen.add(candidate);
    const prototype = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null && !Array.isArray(candidate)) {
      throw new RuntimeProtocolValidationError('Protocol JSON contains a non-plain object');
    }
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    const keys = Object.keys(descriptors);
    if (Array.isArray(candidate) && candidate.length > RUNTIME_PROTOCOL_LIMITS.maxArrayLength) {
      throw new RuntimeProtocolValidationError('Protocol JSON exceeds maximum array length');
    }
    if (!Array.isArray(candidate) && keys.length > RUNTIME_PROTOCOL_LIMITS.maxObjectKeys) {
      throw new RuntimeProtocolValidationError('Protocol JSON exceeds maximum object key count');
    }
    for (const key of keys) {
      if (FORBIDDEN_KEYS.has(key)) {
        throw new RuntimeProtocolValidationError('Protocol JSON contains a forbidden object key');
      }
      const descriptor = descriptors[key];
      if (!descriptor || !('value' in descriptor)) {
        throw new RuntimeProtocolValidationError('Protocol JSON contains an accessor property');
      }
      visit(descriptor.value, depth + 1);
    }
  };

  visit(value, 0);
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new RuntimeProtocolValidationError('Protocol JSON cannot be serialized');
  }
  if (new TextEncoder().encode(encoded).byteLength > RUNTIME_PROTOCOL_LIMITS.maxMessageBytes) {
    throw new RuntimeProtocolValidationError('Protocol JSON exceeds maximum message size');
  }
}
