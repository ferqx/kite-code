import { createHash } from 'node:crypto';

export interface RuntimeSealedChildGrantPayload {
  readonly sealedGrantJson: string;
  readonly sealedGrantByteLength: number;
  readonly sealedGrantDigest: `sha256:${string}`;
}

const MAX_SEALED_GRANT_BYTES = 128 * 1024;

function canonical(value: unknown, seen: Set<object>): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Sealed child grant has a non-finite number.');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object' || seen.has(value))
    throw new Error('Sealed child grant is not finite JSON data.');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length)
        throw new Error('Sealed child grant array is sparse or extended.');
      return `[${value.map((item) => canonical(item, seen)).join(',')}]`;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      throw new Error('Sealed child grant object is not plain JSON data.');
    const fields = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(fields).sort((left, right) => left.localeCompare(right));
    if (
      Object.getOwnPropertySymbols(value).length > 0 ||
      keys.some((key) => !fields[key]?.enumerable || !Object.hasOwn(fields[key]!, 'value'))
    )
      throw new Error('Sealed child grant has hidden or computed fields.');
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(fields[key]!.value, seen)}`).join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

export function canonicalSealedChildGrantJson(grant: unknown): string {
  return canonical(grant, new Set<object>());
}

export function sealChildGrantPayload(grant: unknown): RuntimeSealedChildGrantPayload {
  const sealedGrantJson = canonicalSealedChildGrantJson(grant);
  const sealedGrantByteLength = Buffer.byteLength(sealedGrantJson, 'utf8');
  if (sealedGrantByteLength < 1 || sealedGrantByteLength > MAX_SEALED_GRANT_BYTES)
    throw new Error('Sealed child grant exceeds its private Artifact bound.');
  const sealedGrantDigest =
    `sha256:${createHash('sha256').update(sealedGrantJson).digest('hex')}` as const;
  return Object.freeze({ sealedGrantJson, sealedGrantByteLength, sealedGrantDigest });
}
