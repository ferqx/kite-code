import { expect, test } from 'bun:test';
import { compileModelSchema } from '../../../src/model-schema';
import type { JsonSchema } from '../../../src/storage/types';

test('equal JSON schemas reuse a private validator while same-ID schemas and local references stay isolated', () => {
  const schema: JsonSchema = {
    $id: 'urn:kite:cache-isolation',
    $defs: { item: { type: 'integer', minimum: 2 } },
    $ref: '#/$defs/item',
  };
  const first = compileModelSchema(schema);
  expect(compileModelSchema(structuredClone(schema))).toBe(first);
  expect(first(2)).toBe(true);
  expect(first(1)).toBe(false);
  const other = compileModelSchema({ ...schema, $defs: { item: { type: 'string' } } });
  expect(other).not.toBe(first);
  expect(other('two')).toBe(true);
  expect(other(2)).toBe(false);
  (schema.$defs as Record<string, Record<string, number>>).item!.minimum = 10;
  expect(first(2)).toBe(true);
  expect(compileModelSchema(schema)(2)).toBe(false);
  expect(compileModelSchema({ type: 'integer', minimum: 2 })(2)).toBe(true);
});

test('validator reuse has bounded LRU entries and key bytes without rejecting uncached large schemas', () => {
  const first = compileModelSchema({ type: 'number', minimum: 10001 });
  for (let index = 0; index < 140; index++)
    compileModelSchema({ type: 'number', minimum: 11000 + index });
  expect(compileModelSchema({ type: 'number', minimum: 10001 })).not.toBe(first);
  const large = { type: 'number', description: 'x'.repeat(60000) };
  const initial = compileModelSchema(large);
  for (let index = 0; index < 19; index++) compileModelSchema({ ...large, minimum: index });
  expect(compileModelSchema(large)).not.toBe(initial);
  const oversized = { type: 'number', description: 'x'.repeat(70000) };
  const uncached = compileModelSchema(oversized);
  expect(uncached(2)).toBe(true);
  expect(uncached('two')).toBe(false);
  expect(compileModelSchema(oversized)).not.toBe(uncached);
});

test('schemas with accessors keep the original uncached path and cannot alias a plain-data cache entry', () => {
  const original = compileModelSchema({ type: 'string' });
  const accessor = {
    get type() {
      return 'string';
    },
  };
  const first = compileModelSchema(accessor);
  expect(first).not.toBe(original);
  expect(first('valid')).toBe(true);
  expect(first(1)).toBe(false);
  expect(compileModelSchema(accessor)).not.toBe(first);
});
