import { createHash } from 'node:crypto';
import type { Json } from './extensions';
import { canonicalJson } from './json';
import { AgentError } from './storage/types';

/** A scoped position, never a grant. Domain readers still validate the original stored range. */
const scopeDigest = (scope: Json) =>
  createHash('sha256').update(canonicalJson(scope)).digest('base64url');
export function modelCursor(scope: Json, position: Json): string {
  const cursor = Buffer.from(canonicalJson([scopeDigest(scope), position])).toString('base64url');
  if (cursor.length > 4096) throw new AgentError('invalid_cursor');
  return cursor;
}
export function readModelCursor(value: Json, scope: Json): Json {
  try {
    if (typeof value !== 'string' || !value || value.length > 4096) throw Error();
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) throw Error();
    const decoded = JSON.parse(bytes.toString('utf8'));
    if (!Array.isArray(decoded) || decoded.length !== 2 || decoded[0] !== scopeDigest(scope))
      throw Error();
    return decoded[1];
  } catch {
    throw new AgentError('invalid_cursor');
  }
}
