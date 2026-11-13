import { createFixedModel } from '@kite-ai/ai';
import Ajv from 'ajv';
import { expect, test } from '#kite-test';
import type { Extension } from '../../../src/extensions';
import { createShellJob } from '../../../src/jobs/shell';
import { createRuntime } from '../../../src/runtime';
import { InputSchemaCompiler, schemaCacheKey } from '../../../src/schema-cache';
import type { Store } from '../../../src/storage/port';
import type { JsonSchema } from '../../../src/storage/types';
import { createShellExtension } from '../../../src/tools/shell';

function frozen<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
const independent = (minimum = 2) => frozen({ type: 'number', minimum });

test('immutable anonymous clones share exact content, preserve property order and all errors', async () => {
  const compiler = new InputSchemaCompiler();
  const schema = frozen({
    type: 'object',
    properties: { first: { type: 'string' }, second: { type: 'number' } },
    required: ['first', 'second'],
    additionalProperties: false,
  });
  const validate = compiler.compile(schema);
  expect(compiler.compile(frozen(structuredClone(schema)))).toBe(validate);
  const invalid = { first: 1, second: 'two', extra: true };
  const old = new Ajv({ allErrors: true, strict: false }).compile(schema);
  expect(validate(invalid)).toBe(old(invalid));
  expect(validate.errors).toEqual(old.errors);
  expect(validate.errors).toHaveLength(3);
  expect(compiler.compile(independent(2))).not.toBe(compiler.compile(independent(3)));
  expect(compiler.compile(frozen({ minimum: 2, type: 'number' }))).not.toBe(
    compiler.compile(independent(2)),
  );
  const concurrent = await Promise.all(
    Array.from({ length: 20 }, async () => compiler.compile(frozen(structuredClone(schema)))),
  );
  expect(new Set(concurrent)).toEqual(new Set([validate]));
  expect(validate({ first: 'one', second: 2 })).toBe(true);
});

test('LRU eviction bounds content retention while live object identities keep their original validator', () => {
  const compiler = new InputSchemaCompiler();
  const retained = independent(10001);
  const original = compiler.compile(retained);
  for (let index = 0; index < 140; index++) compiler.compile(independent(11000 + index));
  expect(compiler.compile(retained)).toBe(original);
  expect(compiler.compile(independent(10001))).not.toBe(original);
  const large = frozen({ type: 'number', description: 'x'.repeat(60000) });
  const first = compiler.compile(large);
  for (let index = 0; index < 19; index++) compiler.compile(frozen({ ...large, minimum: index }));
  expect(compiler.compile(large)).toBe(first);
  expect(compiler.compile(frozen({ ...large }))).not.toBe(first);
  const oversized = frozen({ type: 'number', description: 'x'.repeat(70000) });
  expect(schemaCacheKey(oversized, true)).toBeUndefined();
  const fallback = compiler.compile(oversized);
  expect(compiler.compile(oversized)).toBe(fallback);
  expect(fallback('two')).toBe(false);
});

test('mutable and only-root-frozen const and enum schemas preserve original referenced values', () => {
  for (const rootOnly of [false, true]) {
    for (const kind of ['const', 'enum', 'loopEnum'] as const) {
      const compiler = new InputSchemaCompiler();
      const values =
        kind === 'loopEnum'
          ? Array.from({ length: 201 }, (_, index) => ({ value: String(index) }))
          : [{ value: 'before' }];
      const schema: JsonSchema = kind === 'const' ? { const: values[0]! } : { enum: values };
      if (rootOnly) Object.freeze(schema);
      const old = new Ajv({ allErrors: true, strict: false }).compile(schema);
      const validate = compiler.compile(schema);
      expect(schemaCacheKey(schema, true)).toBeUndefined();
      expect(validate({ value: values[0]!.value })).toBe(true);
      values[0]!.value = 'after';
      expect(validate({ value: 'after' })).toBe(old({ value: 'after' }));
      expect(validate({ value: 'before' })).toBe(old({ value: 'before' }));
      expect(validate({ value: 'after' })).toBe(true);
      expect(compiler.compile(schema)).toBe(validate);
    }
  }
});

test('identity lookup precedes mutated fallback eligibility and never aliases same-ID different schemas', () => {
  const compiler = new InputSchemaCompiler();
  const schema: Record<string, unknown> = { type: 'string' };
  const original = compiler.compile(schema as JsonSchema);
  schema.type = 'number';
  schema.$id = 'urn:kite:later';
  schema.$ref = 'urn:kite:missing';
  Object.freeze(schema);
  expect(compiler.compile(schema as JsonSchema)).toBe(original);
  expect(original('original')).toBe(true);
  expect(original(2)).toBe(false);
  const named: Record<string, unknown> = { $id: 'urn:kite:identity', type: 'string' };
  const namedOriginal = compiler.compile(named as JsonSchema);
  delete named.$id;
  Object.freeze(named);
  expect(compiler.compile(named as JsonSchema)).toBe(namedOriginal);
  expect(compiler.compile(independent(2))(2)).toBe(true);
  expect(compiler.compile(independent(3))(2)).toBe(false);
});

test('named, nested and local references keep shared registry resolution, conflicts and errors', () => {
  const compiler = new InputSchemaCompiler();
  const named = frozen({ $id: 'urn:kite:registered', type: 'integer', minimum: 2 });
  compiler.compile(named);
  const reference = frozen({ $ref: 'urn:kite:registered' });
  const validate = compiler.compile(reference);
  expect(validate(2)).toBe(true);
  expect(validate('two')).toBe(false);
  expect(compiler.compile(reference)).toBe(validate);
  expect(() => compiler.compile(frozen({ $id: 'urn:kite:registered', type: 'string' }))).toThrow(
    'already exists',
  );
  expect(() => compiler.compile(frozen({ $ref: 'urn:kite:missing' }))).toThrow('resolve reference');
  const nested = frozen({
    $id: 'urn:kite:container',
    definitions: { item: { $id: 'urn:kite:nested', type: 'string' } },
    $ref: '#/definitions/item',
  });
  expect(compiler.compile(nested)('nested')).toBe(true);
  expect(compiler.compile(frozen({ $ref: 'urn:kite:nested' }))('nested')).toBe(true);
  for (const keyword of [
    '$id',
    '$ref',
    '$schema',
    '$dynamicRef',
    '$recursiveRef',
    '$anchor',
    '$dynamicAnchor',
    '$recursiveAnchor',
  ])
    expect(
      schemaCacheKey(frozen({ properties: { value: { [keyword]: 'original' } } }), true),
    ).toBeUndefined();
  const dialect = frozen({ $schema: 'http://json-schema.org/draft-07/schema#', type: 'string' });
  expect(compiler.compile(dialect)('original')).toBe(true);
  expect(compiler.compile(true)('anything')).toBe(true);
  const never = compiler.compile(false);
  expect(never('anything')).toBe(false);
  expect(compiler.compile(false)).toBe(never);
  expect(() => compiler.compile(frozen({ type: 'not-a-type' }))).toThrow();
});

test('cache inspection invokes no getters and exotic schemas retain the original compiler path', () => {
  let reads = 0;
  const schema = Object.freeze({
    get type() {
      reads++;
      return 'string';
    },
  });
  expect(schemaCacheKey(schema, true)).toBeUndefined();
  expect(reads).toBe(0);
  const old = new Ajv({ allErrors: true, strict: false });
  const oldBefore = reads;
  const expected = old.compile(schema);
  const oldReads = reads - oldBefore;
  const compiler = new InputSchemaCompiler();
  const before = reads;
  const validate = compiler.compile(schema);
  expect(reads - before).toBe(oldReads);
  const compiledReads = reads;
  expect(compiler.compile(schema)).toBe(validate);
  expect(reads).toBe(compiledReads);
  expect(validate('string')).toBe(expected('string'));
  expect(validate(1)).toBe(expected(1));
  const sparse = frozen({ enum: Array(2) });
  expect(schemaCacheKey(sparse, true)).toBeUndefined();
});

test('actual Runtime-sealed Shell execute, launch and command schemas qualify without running a command', async () => {
  const extension = createShellExtension({ job: createShellJob({ cwd: '/fixture', env: {} }) });
  const runtime = createRuntime({
    store: { async close() {} } as Store,
    model: createFixedModel([]),
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'fixture' };
      },
    },
    extensions: [extension],
  });
  try {
    const sealed = (runtime as unknown as { extensions: readonly Extension[] }).extensions[0]!;
    const definitions = [...(sealed.tools ?? []), ...(sealed.jobs ?? [])];
    const compiler = new InputSchemaCompiler();
    for (const id of ['shell.execute', 'shell.launch', 'shell.command']) {
      const definition = definitions.find((entry) => entry.id === id)!;
      expect(definition).toBeDefined();
      expect(schemaCacheKey(definition.inputSchema, true)).toBeDefined();
      const validate = compiler.compile(definition.inputSchema);
      expect(compiler.compile(frozen(structuredClone(definition.inputSchema)))).toBe(validate);
    }
  } finally {
    await runtime.close();
  }
});
