import { createHash } from 'node:crypto';
import {
  type Node as JsonNode,
  type ParseError,
  parseTree,
  printParseErrorCode,
} from 'jsonc-parser';

const DOMAIN_SEPARATOR_PREFIX = 'kite-code-release-v1\0';
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const UTF8_ENCODER = new TextEncoder();

export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalJsonError';
  }
}

/**
 * RFC 8785-like JSON canonicalization for release identities.
 *
 * It deliberately accepts only the JSON data model: no `undefined`, non-finite
 * numbers, bigint, sparse arrays, accessors, custom prototypes, symbol keys, or
 * lone UTF-16 surrogates. Object keys are ordered by UTF-16 code units and
 * numbers use ECMAScript JSON serialization, matching the JCS primitives.
 */
export function canonicalJson(value: unknown): string {
  return serializeCanonical(value, new Set<object>(), '$');
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
  return UTF8_ENCODER.encode(canonicalJson(value));
}

/** Parse one strict JSON document and reject duplicate keys at every depth. */
export function parseStrictJson(input: string | Uint8Array): unknown {
  const text = decodeUtf8(input);
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, {
    allowTrailingComma: false,
    disallowComments: true,
    allowEmptyContent: false,
  });
  if (!root || errors.length > 0) {
    const first = errors[0];
    const detail = first
      ? `${printParseErrorCode(first.error)} at byte ${first.offset}`
      : 'empty document';
    throw new CanonicalJsonError(`Invalid JSON: ${detail}.`);
  }
  rejectDuplicateKeys(root, '$');

  try {
    const parsed = JSON.parse(text) as unknown;
    canonicalJson(parsed);
    return parsed;
  } catch (error) {
    if (error instanceof CanonicalJsonError) throw error;
    throw new CanonicalJsonError(
      `Invalid JSON: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
}

/**
 * Parse a canonical JSON document. Whitespace, alternate escaping, alternate
 * number spellings, BOMs, key reordering, and duplicate keys all fail closed.
 */
export function parseCanonicalJson(input: string | Uint8Array): unknown {
  const original = typeof input === 'string' ? UTF8_ENCODER.encode(input) : new Uint8Array(input);
  const parsed = parseStrictJson(original);
  const rebuilt = canonicalJsonBytes(parsed);
  if (!bytesEqual(original, rebuilt)) {
    throw new CanonicalJsonError('JSON bytes are not in canonical form.');
  }
  return parsed;
}

export function sha256Digest(input: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(input).digest('hex')}`;
}

/** Hash a canonical input under an explicit, non-empty release identity domain. */
export function sha256DomainSeparated(
  domain: string,
  input: string | Uint8Array,
): `sha256:${string}` {
  if (!domain || domain.includes('\0')) {
    throw new CanonicalJsonError('Hash domain must be non-empty and cannot contain NUL.');
  }
  const hash = createHash('sha256');
  hash.update(DOMAIN_SEPARATOR_PREFIX);
  hash.update(domain);
  hash.update('\0');
  hash.update(input);
  return `sha256:${hash.digest('hex')}`;
}

function serializeCanonical(value: unknown, ancestors: Set<object>, path: string): string {
  if (value === null) return 'null';
  if (typeof value === 'string') {
    assertValidUnicode(value, path);
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new CanonicalJsonError(`${path} contains a non-finite number.`);
    }
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') {
    throw new CanonicalJsonError(`${path} contains a non-JSON ${typeof value} value.`);
  }
  if (ancestors.has(value)) {
    throw new CanonicalJsonError(`${path} contains a circular reference.`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new CanonicalJsonError(`${path} contains symbol keys.`);
      }
      const allowedKeys = new Set(['length']);
      for (let index = 0; index < value.length; index += 1) allowedKeys.add(String(index));
      if (Object.getOwnPropertyNames(value).some((key) => !allowedKeys.has(key))) {
        throw new CanonicalJsonError(`${path} contains non-JSON array properties.`);
      }
      const entries: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (!descriptor) {
          throw new CanonicalJsonError(`${path}[${index}] is a sparse array entry.`);
        }
        if (!descriptor.enumerable || !('value' in descriptor)) {
          throw new CanonicalJsonError(`${path}[${index}] must be an enumerable data value.`);
        }
        entries.push(serializeCanonical(descriptor.value, ancestors, `${path}[${index}]`));
      }
      return `[${entries.join(',')}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalJsonError(`${path} must be a plain JSON object.`);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new CanonicalJsonError(`${path} contains symbol keys.`);
    }

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors).sort(compareUtf16CodeUnits);
    const entries = keys.map((key) => {
      assertValidUnicode(key, `${path} key`);
      const descriptor = descriptors[key];
      if (!descriptor || !('value' in descriptor)) {
        throw new CanonicalJsonError(`${path}.${key} must not be an accessor.`);
      }
      if (!descriptor.enumerable) {
        throw new CanonicalJsonError(`${path}.${key} must be enumerable.`);
      }
      return `${JSON.stringify(key)}:${serializeCanonical(descriptor.value, ancestors, `${path}.${key}`)}`;
    });
    return `{${entries.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function rejectDuplicateKeys(node: JsonNode, path: string): void {
  if (node.type === 'object') {
    const keys = new Set<string>();
    for (const property of node.children ?? []) {
      const keyNode = property.children?.[0];
      const valueNode = property.children?.[1];
      if (!keyNode || typeof keyNode.value !== 'string' || !valueNode) {
        throw new CanonicalJsonError(`Invalid object member at ${path}.`);
      }
      const key = keyNode.value;
      if (keys.has(key)) {
        throw new CanonicalJsonError(`Duplicate JSON key ${JSON.stringify(key)} at ${path}.`);
      }
      keys.add(key);
      rejectDuplicateKeys(valueNode, `${path}.${key}`);
    }
    return;
  }
  if (node.type === 'array') {
    for (const [index, child] of (node.children ?? []).entries()) {
      rejectDuplicateKeys(child, `${path}[${index}]`);
    }
  }
}

function decodeUtf8(input: string | Uint8Array): string {
  if (typeof input === 'string') return input;
  try {
    return UTF8_DECODER.decode(input);
  } catch {
    throw new CanonicalJsonError('JSON document is not valid UTF-8.');
  }
}

function assertValidUnicode(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new CanonicalJsonError(`${path} contains a lone high surrogate.`);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new CanonicalJsonError(`${path} contains a lone low surrogate.`);
    }
  }
}

function compareUtf16CodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}
