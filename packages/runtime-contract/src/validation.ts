/** Bounds shared by client-safe Contract validators. */
export const RUNTIME_CLIENT_MAX_IDENTIFIER_LENGTH = 512;
export const RUNTIME_CLIENT_MAX_TEXT_LENGTH = 65_536;
export const RUNTIME_CLIENT_MAX_ARRAY_LENGTH = 256;
export const RUNTIME_CLIENT_MAX_OBJECT_KEYS = 128;
export const RUNTIME_CLIENT_MAX_JSON_DEPTH = 16;

export function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

export function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

export function isBoundedString(
  value: unknown,
  maximum = RUNTIME_CLIENT_MAX_TEXT_LENGTH,
): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    !/\p{Cc}/u.test(value)
  );
}

/**
 * User-authored command and client-safe presentation text may contain normal
 * line delimiters. Addressable identities continue to use `isBoundedString`
 * so control characters cannot become part of an identity.
 */
export function isBoundedUserText(
  value: unknown,
  maximum = RUNTIME_CLIENT_MAX_TEXT_LENGTH,
): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    ![...value].some(
      (character) =>
        /\p{Cc}/u.test(character) && character !== '\n' && character !== '\r' && character !== '\t',
    )
  );
}

export function isIdentifier(value: unknown): value is string {
  return isBoundedString(value, RUNTIME_CLIENT_MAX_IDENTIFIER_LENGTH);
}

export function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Rejects non-JSON values, cycles, oversized containers, and deep structures. */
export function isJsonSafeValue(value: unknown, depth = 0, seen = new Set<object>()): boolean {
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') return value.length <= RUNTIME_CLIENT_MAX_TEXT_LENGTH;
  if (typeof value === 'number') {
    return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
  }
  if (depth >= RUNTIME_CLIENT_MAX_JSON_DEPTH || typeof value !== 'object' || value === null)
    return false;
  if (seen.has(value)) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return (
        value.length <= RUNTIME_CLIENT_MAX_ARRAY_LENGTH &&
        value.every((entry) => isJsonSafeValue(entry, depth + 1, seen))
      );
    }
    if (!isRecord(value)) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors);
    if (
      keys.length > RUNTIME_CLIENT_MAX_OBJECT_KEYS ||
      keys.some((key) => key === '__proto__' || key === 'constructor' || key === 'prototype')
    ) {
      return false;
    }
    return keys.every((key) => {
      const descriptor = descriptors[key];
      return Boolean(
        descriptor && 'value' in descriptor && isJsonSafeValue(descriptor.value, depth + 1, seen),
      );
    });
  } finally {
    seen.delete(value);
  }
}
