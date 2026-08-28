/**
 * Small, dependency-free validation primitives for the closed App Control
 * payloads.  Keeping these checks here makes every route codec exact without
 * introducing a generic RPC or a runtime/UI dependency into this package.
 */

export type JsonObject = { readonly [key: string]: unknown };

export class KiteAppContractValidationError extends Error {
  readonly code = 'invalid_app_contract' as const;

  constructor(message: string) {
    super(message);
    this.name = 'KiteAppContractValidationError';
  }
}

export interface ExactJsonCodec<Value> {
  readonly schema: string;
  encode(value: Value): JsonObject;
  decode(input: unknown): Value;
}

export function exactCodec<Value>(input: {
  readonly schema: string;
  readonly decode: (input: unknown) => Value;
  readonly encode: (value: Value) => JsonObject;
}): ExactJsonCodec<Value> {
  return Object.freeze({
    schema: input.schema,
    decode: input.decode,
    encode(value: Value): JsonObject {
      // Reject unchecked objects with extra fields before the field-specific
      // encoder can omit them. Same-process adapters must preserve the exact
      // boundary enforced by a serialized transport.
      input.decode(value);
      const encoded = input.encode(value);
      // Validate encoders as well as decoders.  A caller that obtained a
      // value through an unchecked cast cannot emit a malformed payload.
      input.decode(encoded);
      return encoded;
    },
  });
}

export function exactObject(
  input: unknown,
  allowedKeys: readonly string[],
  label: string,
): JsonObject {
  if (!isPlainJsonObject(input)) invalid(`${label} must be a plain JSON object.`);
  const value = input as JsonObject;
  const expected = [...allowedKeys].sort();
  const actual = Object.keys(value).sort();
  if (actual.some((key) => !expected.includes(key))) {
    invalid(`${label} contains an unknown field.`);
  }
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      invalid(`${label}.${key} must be an enumerable JSON value.`);
    }
  }
  return value;
}

export function hasOwn(value: JsonObject, key: string): boolean {
  return Object.hasOwn(value, key);
}

export function required(value: JsonObject, key: string, label: string): unknown {
  if (!hasOwn(value, key)) invalid(`${label}.${key} is required.`);
  return value[key];
}

export function optional(value: JsonObject, key: string): unknown {
  return hasOwn(value, key) ? value[key] : undefined;
}

export function stringValue(
  value: unknown,
  label: string,
  limits: { readonly min?: number; readonly max: number } = { max: 512 },
): string {
  if (typeof value !== 'string') invalid(`${label} must be a string.`);
  const min = limits.min ?? 0;
  if (value.length < min || value.length > limits.max) {
    invalid(`${label} must contain ${min}-${limits.max} UTF-16 code units.`);
  }
  return value;
}

export function nonEmptyString(value: unknown, label: string, max = 512): string {
  return stringValue(value, label, { min: 1, max });
}

export function safeIdentifier(value: unknown, label: string, max = 256): string {
  const result = nonEmptyString(value, label, max);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(result)) {
    invalid(`${label} must be a bounded identity.`);
  }
  return result;
}

export function sha256Digest(value: unknown, label: string): `sha256:${string}` {
  const result = stringValue(value, label, { min: 71, max: 71 });
  if (!/^sha256:[a-f0-9]{64}$/u.test(result)) invalid(`${label} must be a sha256 digest.`);
  return result as `sha256:${string}`;
}

export function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') invalid(`${label} must be a boolean.`);
  return value;
}

export function integerValue(
  value: unknown,
  label: string,
  limits: { readonly min?: number; readonly max?: number } = {},
): number {
  if (!Number.isSafeInteger(value)) invalid(`${label} must be a safe integer.`);
  const min = limits.min ?? Number.MIN_SAFE_INTEGER;
  const max = limits.max ?? Number.MAX_SAFE_INTEGER;
  if ((value as number) < min || (value as number) > max) {
    invalid(`${label} is outside its allowed range.`);
  }
  return value as number;
}

export function finiteNumber(
  value: unknown,
  label: string,
  limits: { readonly min?: number; readonly max?: number } = {},
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    invalid(`${label} must be a finite number.`);
  }
  const min = limits.min ?? Number.NEGATIVE_INFINITY;
  const max = limits.max ?? Number.POSITIVE_INFINITY;
  if ((value as number) < min || (value as number) > max) {
    invalid(`${label} is outside its allowed range.`);
  }
  return value as number;
}

export function enumValue<Value extends string>(
  value: unknown,
  label: string,
  allowed: readonly Value[],
): Value {
  if (typeof value !== 'string' || !allowed.includes(value as Value)) {
    invalid(`${label} has an unsupported value.`);
  }
  return value as Value;
}

export function arrayValue<Value>(
  value: unknown,
  label: string,
  decode: (value: unknown, index: number) => Value,
  maximum = 256,
): readonly Value[] {
  if (!Array.isArray(value)) invalid(`${label} must be an array.`);
  if (value.length > maximum) invalid(`${label} exceeds its maximum length.`);
  const decoded: Value[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) invalid(`${label} must not be sparse.`);
    decoded.push(decode(value[index], index));
  }
  return Object.freeze(decoded);
}

export function invalid(message: string): never {
  throw new KiteAppContractValidationError(message);
}

function isPlainJsonObject(value: unknown): value is JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}
