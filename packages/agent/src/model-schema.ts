import Ajv, { type ValidateFunction } from 'ajv';
import { SchemaCache, schemaCacheKey } from './schema-cache';
import type { JsonSchema } from './storage/types';

const compiled = new SchemaCache<ValidateFunction>();

/** Pure validators only: never cache arguments, policy, filesystem or authorization facts. */
export function compileModelSchema(schema: JsonSchema | boolean): ValidateFunction {
  const key = schemaCacheKey(schema);
  const prior = key === undefined ? undefined : compiled.get(key);
  if (prior) return prior;
  // Each schema retains its own Ajv registry, including $id and local $ref.
  // A private clone prevents a caller's later schema mutation poisoning reuse.
  const validate = new Ajv({ allErrors: false, strict: false }).compile(
    key === undefined ? schema : JSON.parse(key),
  );
  if (key !== undefined) compiled.set(key, validate);
  return validate;
}
