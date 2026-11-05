import Ajv, { type ValidateFunction } from 'ajv';
import type { JsonSchema } from './storage/types';

const maximumEntries = 128;
const maximumKeyBytes = 1024 * 1024;
const maximumEntryBytes = 64 * 1024;
const compiled = new Map<string, ValidateFunction>();
let keyBytes = 0;

// Only JSON data has a content identity. Accessors, custom prototypes, sparse
// arrays and oversized schemas retain the original uncached compilation path.
function cacheKey(schema: JsonSchema | boolean): string | undefined {
  const seen = new Set<object>();
  let budget = maximumEntryBytes;
  function data(value: unknown, depth: number): boolean {
    if (--budget < 0 || depth > 64) return false;
    if (value === null || typeof value === 'boolean') return true;
    if (typeof value === 'string') {
      budget -= Buffer.byteLength(value);
      return budget >= 0;
    }
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value !== 'object' || seen.has(value)) return false;
    if (
      Array.isArray(value)
        ? Object.getPrototypeOf(value) !== Array.prototype
        : ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    )
      return false;
    seen.add(value);
    const entries = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).some((key) => typeof key !== 'string')) return false;
    if (
      Array.isArray(value) &&
      (Object.keys(value).length !== value.length ||
        Object.keys(value).some((key, index) => key !== String(index)))
    )
      return false;
    for (const [key, descriptor] of Object.entries(entries)) {
      if (Array.isArray(value) && key === 'length') continue;
      budget -= Buffer.byteLength(key);
      if (!descriptor.enumerable || !('value' in descriptor) || !data(descriptor.value, depth + 1))
        return false;
    }
    seen.delete(value);
    return budget >= 0;
  }
  if (!data(schema, 0)) return;
  const key = JSON.stringify(schema);
  if (Buffer.byteLength(key) <= maximumEntryBytes) return key;
  return undefined;
}

/** Pure validators only: never cache arguments, policy, filesystem or authorization facts. */
export function compileModelSchema(schema: JsonSchema | boolean): ValidateFunction {
  const key = cacheKey(schema);
  const prior = key === undefined ? undefined : compiled.get(key);
  if (prior) {
    compiled.delete(key!);
    compiled.set(key!, prior);
    return prior;
  }
  // Each schema retains its own Ajv registry, including $id and local $ref.
  // A private clone prevents a caller's later schema mutation poisoning reuse.
  const validate = new Ajv({ allErrors: false, strict: false }).compile(
    key === undefined ? schema : JSON.parse(key),
  );
  if (key !== undefined) {
    const bytes = Buffer.byteLength(key);
    while (compiled.size >= maximumEntries || keyBytes + bytes > maximumKeyBytes) {
      const oldest = compiled.keys().next().value!;
      keyBytes -= Buffer.byteLength(oldest);
      compiled.delete(oldest);
    }
    compiled.set(key, validate);
    keyBytes += bytes;
  }
  return validate;
}
