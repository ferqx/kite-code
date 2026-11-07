import Ajv, { type ValidateFunction } from 'ajv';
import type { JsonSchema } from './storage/types';

const maximumEntries = 128;
const maximumKeyBytes = 1024 * 1024;
const maximumEntryBytes = 64 * 1024;
const registryKeywords = new Set([
  '$id',
  '$ref',
  '$schema',
  '$dynamicRef',
  '$recursiveRef',
  '$anchor',
  '$dynamicAnchor',
  '$recursiveAnchor',
]);

/** Strong references are bounded; callers decide which schemas can share a validator. */
export class SchemaCache<Value> {
  private readonly entries = new Map<string, Value>();
  private keyBytes = 0;
  get(key: string): Value | undefined {
    const prior = this.entries.get(key);
    if (prior !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, prior);
    }
    return prior;
  }
  set(key: string, value: Value): void {
    if (this.entries.delete(key)) this.keyBytes -= Buffer.byteLength(key);
    const bytes = Buffer.byteLength(key);
    while (this.entries.size >= maximumEntries || this.keyBytes + bytes > maximumKeyBytes) {
      const oldest = this.entries.keys().next().value!;
      this.keyBytes -= Buffer.byteLength(oldest);
      this.entries.delete(oldest);
    }
    this.entries.set(key, value);
    this.keyBytes += bytes;
  }
}

// Only JSON data has a content identity. Accessors, custom prototypes, sparse
// arrays and oversized schemas retain the original uncached compilation path.
export function schemaCacheKey(
  schema: JsonSchema | boolean,
  immutableIndependent = false,
): string | undefined {
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
    if (immutableIndependent && !Object.isFrozen(value)) return false;
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
      if (immutableIndependent && registryKeywords.has(key)) return false;
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

/** Keep registry and mutable-schema semantics; only immutable independent JSON is shared. */
export class InputSchemaCompiler {
  private readonly registry = new Ajv({ allErrors: true, strict: false });
  private readonly identities = new WeakMap<object, ValidateFunction>();
  private readonly compiled = new SchemaCache<ValidateFunction>();

  compile(schema: JsonSchema | boolean): ValidateFunction {
    const object = typeof schema === 'object' && schema !== null ? schema : undefined;
    const original = object && this.identities.get(object);
    if (original) return original;
    let key: string | undefined;
    if (object) {
      try {
        key = schemaCacheKey(schema, true);
      } catch {
        // Cache eligibility must not replace the original compiler's handling of exotic data.
      }
    }
    let validate: ValidateFunction;
    if (key === undefined) validate = this.registry.compile(schema);
    else {
      const prior = this.compiled.get(key);
      if (prior) validate = prior;
      else {
        // Ajv retains generated functions in its ValueScope as well as its schema cache.
        // A separate instance makes eviction release that entire compilation graph.
        validate = new Ajv({ allErrors: true, strict: false }).compile(JSON.parse(key));
        this.compiled.set(key, validate);
      }
    }
    if (object) this.identities.set(object, validate);
    return validate;
  }
}
