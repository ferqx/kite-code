import { describe, expect, test } from 'bun:test';
import {
  canonicalizeCapabilityArguments,
  compileCapabilitySchema,
  validateCapabilityArguments,
} from '@kite/builtin-runtime/skills';

function nestedObjectSchema(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = { type: 'string' };
  for (let index = 0; index < depth; index++) {
    value = { type: 'object', properties: { child: value } };
  }
  return value;
}

function compileOutcome(
  compile: typeof compileCapabilitySchema,
  schema: unknown,
): { ok: true } | { ok: false; diagnostic: string } {
  const result = compile(schema);
  return result.ok ? { ok: true } : result;
}

function objectNodeSchema(nodes: number): Record<string, unknown> {
  return {
    type: 'object',
    allOf: Array.from({ length: nodes - 1 }, () => ({})),
  };
}

function utf8DescriptionSchema(
  byteLimit: number,
  extraCharacters: number,
): Record<string, unknown> {
  const base = { type: 'object', description: '' };
  const baseBytes = Buffer.byteLength(JSON.stringify(base), 'utf8');
  const characters = Math.floor((byteLimit - baseBytes) / 3) + extraCharacters;
  return { type: 'object', description: '界'.repeat(characters) };
}

describe('Builtin capability schema authority cutover', () => {
  const corpus = [
    [
      {
        type: 'object',
        properties: { name: { type: 'string' }, limit: { type: 'integer', default: 10 } },
        required: ['name'],
        additionalProperties: false,
      },
      { ok: true },
    ],
    [
      { type: 'string' },
      {
        ok: false,
        diagnostic: 'P0 supports only object-root JSON Schema Draft-07 inputSchema.',
      },
    ],
    [
      { type: 'object', unknownKeyword: true },
      {
        ok: false,
        diagnostic: 'Unsupported MCP inputSchema: strict mode: unknown keyword: "unknownKeyword"',
      },
    ],
    [
      {
        type: 'object',
        properties: { value: { $ref: '#/definitions/value' } },
        definitions: { value: { type: 'string' } },
      },
      { ok: true },
    ],
    [
      nestedObjectSchema(34),
      {
        ok: false,
        diagnostic: 'MCP inputSchema exceeds the maximum nesting depth of 32.',
      },
    ],
    [
      {
        type: 'object',
        properties: Object.fromEntries(
          Array.from({ length: 1_025 }, (_, index) => [`field_${index}`, { type: 'string' }]),
        ),
      },
      {
        ok: false,
        diagnostic: 'MCP inputSchema has 2052 properties, exceeding the limit of 1024.',
      },
    ],
  ] as const;

  test('keeps the accepted compiler diagnostics stable on the cutover corpus', () => {
    for (const [schema, expected] of corpus) {
      expect(compileOutcome(compileCapabilitySchema, schema)).toEqual(expected);
    }
    const valid = corpus[0][0];
    expect(validateCapabilityArguments(valid, { name: 'kite' })).toBeNull();
    expect(validateCapabilityArguments(valid, {})).toContain('Arguments do not match');
  });

  test('matches canonical defaults, cloning, and stable repeated failure diagnostics', () => {
    const schema = {
      type: 'object',
      properties: { limit: { type: 'integer', default: 10 } },
      additionalProperties: false,
    };
    const args = {};
    expect(canonicalizeCapabilityArguments(schema, args)).toEqual({
      ok: true,
      args: { limit: 10 },
    });
    expect(args).toEqual({});

    const unsupported = { type: 'object', unknownKeyword: true };
    const first = compileOutcome(compileCapabilitySchema, unsupported);
    const second = compileOutcome(compileCapabilitySchema, unsupported);
    expect(first).toEqual(second);
  });

  test('enforces UTF-8 byte and object-node boundaries', () => {
    const utf8AtOrBelowLimit = utf8DescriptionSchema(256 * 1024, 0);
    const utf8OverLimit = utf8DescriptionSchema(256 * 1024, 1);
    expect(Buffer.byteLength(JSON.stringify(utf8AtOrBelowLimit), 'utf8')).toBe(256 * 1024);
    expect(compileOutcome(compileCapabilitySchema, utf8AtOrBelowLimit)).toEqual({ ok: true });
    expect(compileOutcome(compileCapabilitySchema, utf8OverLimit)).toEqual({
      ok: false,
      diagnostic: 'MCP inputSchema exceeds the 256 KiB serialized size limit.',
    });

    expect(compileOutcome(compileCapabilitySchema, objectNodeSchema(4096))).toEqual({ ok: true });
    expect(compileOutcome(compileCapabilitySchema, objectNodeSchema(4097))).toEqual({
      ok: false,
      diagnostic: 'MCP inputSchema has 4097 object nodes, exceeding the limit of 4096.',
    });
  });

  test('keeps Draft-07 references, keyword validation, and unsupported references deterministic', () => {
    const draft07 = {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1, maxLength: 8, pattern: '^[a-z]+$' },
        count: { type: 'integer', minimum: 0, maximum: 10, multipleOf: 1 },
        tags: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 3,
          uniqueItems: true,
        },
        choice: { oneOf: [{ const: 'a' }, { const: 'b' }] },
        metadata: {
          type: 'object',
          propertyNames: { pattern: '^[a-z]+$' },
          additionalProperties: { type: 'string' },
          minProperties: 0,
        },
      },
      required: ['id'],
      additionalProperties: false,
      minProperties: 1,
      maxProperties: 5,
    };
    expect(compileOutcome(compileCapabilitySchema, draft07)).toEqual({ ok: true });

    const negatives: readonly [unknown, string][] = [
      [[], 'MCP tool inputSchema must be a JSON object.'],
      [
        { type: 'object', properties: { value: 1 } },
        'Unsupported MCP inputSchema: schema is invalid: data/properties/value must be object,boolean',
      ],
      [
        { type: 'object', required: 'value' },
        'Unsupported MCP inputSchema: schema is invalid: data/required must be array',
      ],
      [
        { type: 'object', properties: { value: { type: 'bogus' } } },
        'Unsupported MCP inputSchema: schema is invalid: data/properties/value/type must be equal to one of the allowed values, data/properties/value/type must be array, data/properties/value/type must match a schema in anyOf',
      ],
      [
        { type: 'object', properties: { value: { $ref: '#/definitions/missing' } } },
        "Unsupported MCP inputSchema: can't resolve reference #/definitions/missing from id #",
      ],
      [
        {
          type: 'object',
          properties: { value: { $ref: 'https://example.invalid/schema.json#/value' } },
        },
        "Unsupported MCP inputSchema: can't resolve reference https://example.invalid/schema.json#/value from id #",
      ],
    ];
    for (const [schema, diagnostic] of negatives) {
      expect(compileOutcome(compileCapabilitySchema, schema)).toEqual({ ok: false, diagnostic });
    }
  });

  test('rejects cycles with stable diagnostics while accepting shared schema objects', () => {
    const shared = { type: 'string' };
    const sharedSchema = {
      type: 'object',
      properties: { left: shared, right: shared },
      required: ['left', 'right'],
    };
    expect(compileOutcome(compileCapabilitySchema, sharedSchema)).toEqual({ ok: true });

    const cyclic: Record<string, unknown> = { type: 'object' };
    cyclic.self = cyclic;
    const first = compileOutcome(compileCapabilitySchema, cyclic);
    const second = compileOutcome(compileCapabilitySchema, cyclic);
    const expected = {
      ok: false as const,
      diagnostic: 'Unsupported MCP inputSchema: schema must be JSON-serializable.',
    };
    expect(first).toEqual(expected);
    expect(second).toEqual(expected);
  });
});
