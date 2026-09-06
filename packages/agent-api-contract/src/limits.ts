export const AGENT_API_LIMITS = Object.freeze({
  maxMessageBytes: 1_048_576,
  maxDepth: 16,
  maxObjectKeys: 256,
  maxArrayLength: 256,
  maxIdentifierBytes: 128,
  maxPathSegmentBytes: 128,
  maxCursorBytes: 1_024,
  maxShortTextBytes: 256,
  maxDetailBytes: 512,
  maxRunInputBytes: 262_144,
  maxSkillInputBytes: 32_768,
  maxInitialSkills: 32,
  defaultPageLimit: 50,
  maxPageLimit: 200,
  maxWaitMilliseconds: 30_000,
  maxCapabilities: 16,
  maxInteractions: 256,
  maxHistoryItems: 200,
  maxSseChannels: 5,
  maxSseQueueEvents: 256,
});

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const textEncoder = new TextEncoder();

export class AgentApiContractValidationError extends TypeError {
  readonly code = 'invalid_agent_api_contract' as const;

  constructor(message: string) {
    super(message);
    this.name = 'AgentApiContractValidationError';
  }
}

export function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

export function assertUtf8ByteLength(
  value: string,
  maximum: number,
  label: string,
  minimum = 0,
): void {
  const length = utf8ByteLength(value);
  if (length < minimum || length > maximum) {
    throw new AgentApiContractValidationError(
      `${label} must contain ${minimum}-${maximum} UTF-8 bytes`,
    );
  }
}

/**
 * Bounded JSON admission shared by every public request and response codec.
 * It deliberately runs before schema parsing so attacker-controlled getters,
 * prototypes, cycles and deep values never reach Zod.
 */
export function assertAgentApiJsonValue(
  value: unknown,
  options: { readonly maxBytes?: number; readonly maxDepth?: number } = {},
): void {
  const maximumBytes = options.maxBytes ?? AGENT_API_LIMITS.maxMessageBytes;
  const maximumDepth = options.maxDepth ?? AGENT_API_LIMITS.maxDepth;
  const seen = new Set<object>();

  const visit = (candidate: unknown, depth: number): void => {
    if (depth > maximumDepth) {
      throw new AgentApiContractValidationError('Agent API JSON exceeds maximum depth');
    }
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') {
      return;
    }
    if (typeof candidate === 'number') {
      if (
        !Number.isFinite(candidate) ||
        (Number.isInteger(candidate) && !Number.isSafeInteger(candidate))
      ) {
        throw new AgentApiContractValidationError('Agent API JSON contains an unsafe number');
      }
      return;
    }
    if (typeof candidate !== 'object') {
      throw new AgentApiContractValidationError('Agent API JSON contains a non-JSON value');
    }
    if (seen.has(candidate)) {
      throw new AgentApiContractValidationError('Agent API JSON contains a cycle');
    }
    seen.add(candidate);

    const isArray = Array.isArray(candidate);
    const prototype = Object.getPrototypeOf(candidate);
    if (!isArray && prototype !== Object.prototype && prototype !== null) {
      throw new AgentApiContractValidationError('Agent API JSON contains a non-plain object');
    }
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    const keys = Object.keys(descriptors);
    if (isArray && candidate.length > AGENT_API_LIMITS.maxArrayLength) {
      throw new AgentApiContractValidationError('Agent API JSON exceeds maximum array length');
    }
    if (!isArray && keys.length > AGENT_API_LIMITS.maxObjectKeys) {
      throw new AgentApiContractValidationError('Agent API JSON exceeds maximum object key count');
    }
    for (const key of keys) {
      if (FORBIDDEN_KEYS.has(key)) {
        throw new AgentApiContractValidationError('Agent API JSON contains a forbidden object key');
      }
      const descriptor = descriptors[key];
      if (
        !descriptor ||
        (!descriptor.enumerable && !(isArray && key === 'length')) ||
        !('value' in descriptor)
      ) {
        throw new AgentApiContractValidationError(
          'Agent API JSON contains an accessor or non-enumerable property',
        );
      }
      visit(descriptor.value, depth + 1);
    }
  };

  visit(value, 0);
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new AgentApiContractValidationError('Agent API JSON cannot be serialized');
  }
  if (utf8ByteLength(encoded) > maximumBytes) {
    throw new AgentApiContractValidationError('Agent API JSON exceeds maximum message size');
  }
}

/** Fail if a Server value relied on response decoding to strip undeclared fields. */
export function assertSameAgentApiJsonShape(input: unknown, parsed: unknown, label: string): void {
  if (
    input === null ||
    parsed === null ||
    typeof input !== 'object' ||
    typeof parsed !== 'object'
  ) {
    if (!Object.is(input, parsed)) {
      throw new AgentApiContractValidationError(`${label} changed during response encoding`);
    }
    return;
  }
  if (Array.isArray(input) || Array.isArray(parsed)) {
    if (!Array.isArray(input) || !Array.isArray(parsed) || input.length !== parsed.length) {
      throw new AgentApiContractValidationError(`${label} has an undeclared response shape`);
    }
    for (let index = 0; index < input.length; index += 1) {
      assertSameAgentApiJsonShape(input[index], parsed[index], `${label}[${index}]`);
    }
    return;
  }
  const inputObject = input as Record<string, unknown>;
  const parsedObject = parsed as Record<string, unknown>;
  const inputKeys = Object.keys(inputObject).sort();
  const parsedKeys = Object.keys(parsedObject).sort();
  if (
    inputKeys.length !== parsedKeys.length ||
    inputKeys.some((key, index) => key !== parsedKeys[index])
  ) {
    throw new AgentApiContractValidationError(`${label} contains an undeclared response field`);
  }
  for (const key of inputKeys) {
    assertSameAgentApiJsonShape(inputObject[key], parsedObject[key], `${label}.${key}`);
  }
}

/** Reject unknown request fields while allowing a schema parser to materialize defaults. */
export function assertNoUnknownAgentApiJsonFields(
  input: unknown,
  parsed: unknown,
  label: string,
): void {
  if (input === null || typeof input !== 'object') return;
  if (Array.isArray(input)) {
    if (!Array.isArray(parsed) || input.length !== parsed.length) {
      throw new AgentApiContractValidationError(`${label} has an undeclared request shape`);
    }
    for (let index = 0; index < input.length; index += 1) {
      assertNoUnknownAgentApiJsonFields(input[index], parsed[index], `${label}[${index}]`);
    }
    return;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AgentApiContractValidationError(`${label} has an undeclared request shape`);
  }
  const inputObject = input as Record<string, unknown>;
  const parsedObject = parsed as Record<string, unknown>;
  for (const key of Object.keys(inputObject)) {
    if (!Object.hasOwn(parsedObject, key)) {
      throw new AgentApiContractValidationError(`${label}.${key} is not declared`);
    }
    assertNoUnknownAgentApiJsonFields(inputObject[key], parsedObject[key], `${label}.${key}`);
  }
}
