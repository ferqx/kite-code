import { expect, test } from 'bun:test';
import type { ModelRequest } from '@kite-ai/ai';
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import Ajv from 'ajv';
import { createPlanningValidation } from '../../../src/business/planning';
import type { ToolDefinition } from '../../../src/extensions';
import { createModelToolSurface, modelToolCall } from '../../../src/model-tools';
import type { Json, JsonSchema } from '../../../src/storage/types';
import type { WorkspaceFiles } from '../../../src/tools/files';
import { createFileTools } from '../../../src/tools/files-tools';

function surface(tools: readonly ToolDefinition[]) {
  const request: ModelRequest = {
    modelId: 'fixture',
    requestId: 'request',
    messages: [],
    tools: tools.map((tool) => ({
      id: tool.id,
      definitionVersion: tool.version,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  };
  return createModelToolSurface(request, new Map(tools.map((tool) => [tool.id, tool])));
}
function tool(inputSchema: JsonSchema, id = 'fixture', rename = true): ToolDefinition {
  return {
    id,
    version: '1',
    description: 'fixture',
    model: { name: id, ...(rename ? { snakeCase: true } : {}) },
    inputSchema,
    execute: async () => ({ outcome: 'succeeded', content: 'ok' }),
  };
}
function call(model: ReturnType<typeof surface>, name: string, args: Json) {
  return model.decode({ id: 'call', name, arguments: JSON.stringify(args) });
}
const structured: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { oldText: { type: 'string' } },
  required: ['oldText'],
};

test('coexisting root and allOf declarations reject public field collisions before a request is returned', () => {
  const camel: JsonSchema = {
    properties: { firstName: { type: 'string' } },
    required: ['firstName'],
  };
  const literal: JsonSchema = {
    properties: { first_name: { type: 'string' } },
    required: ['first_name'],
  };
  const schemas: JsonSchema[] = [
    { type: 'object', allOf: [camel, literal] },
    { type: 'object', ...camel, allOf: [literal] },
    { type: 'object', ...literal, allOf: [{ allOf: [camel] }] },
    {
      type: 'object',
      allOf: [{ properties: { input: camel } }, { properties: { input: literal } }],
    },
    {
      type: 'object',
      properties: { rows: { type: 'array', items: { allOf: [camel, literal] } } },
    },
  ];
  for (const inputSchema of schemas) {
    expect(() => surface([tool(inputSchema)])).toThrow('model_tool_parameter_collision');
  }
});

test('allOf siblings collide with declarations inside alternatives in either traversal order', () => {
  const alternative: JsonSchema = {
    oneOf: [
      {
        properties: { kind: { const: 'camel' }, firstName: { type: 'string' } },
        required: ['kind', 'firstName'],
      },
      {
        properties: { kind: { const: 'other' }, otherValue: { type: 'string' } },
        required: ['kind', 'otherValue'],
      },
    ],
  };
  const sibling: JsonSchema = {
    properties: { first_name: { type: 'string' } },
    required: ['first_name'],
  };
  for (const branches of [
    [alternative, sibling],
    [sibling, alternative],
  ]) {
    for (const inputSchema of [
      { type: 'object', allOf: branches },
      {
        type: 'object',
        allOf: branches.map((branch) => ({ properties: { input: branch } })),
      },
    ] as JsonSchema[]) {
      expect(() => surface([tool(inputSchema)])).toThrow('model_tool_parameter_collision');
    }
  }
});

test('nested alternatives remain reversible when an allOf sibling repeats the same original field', () => {
  const branches: JsonSchema[] = [
    {
      oneOf: [
        {
          properties: { kind: { const: 'camel' }, firstName: { type: 'string' } },
          required: ['kind', 'firstName'],
        },
        {
          properties: { kind: { const: 'other' }, otherValue: { type: 'string' } },
          required: ['kind', 'otherValue'],
        },
      ],
    },
    { properties: { firstName: { minLength: 1 } } },
  ];
  for (const allOf of [branches, [...branches].reverse()]) {
    const model = surface([tool({ type: 'object', allOf })]);
    for (const input of [
      { kind: 'camel', first_name: 'value' },
      { kind: 'other', other_value: 'value' },
    ] as Json[]) {
      const saved = call(model, 'fixture', input);
      expect(saved.model?.error).toBeUndefined();
      expect(JSON.parse(saved.arguments)).toEqual(
        (input as Record<string, Json>).kind === 'camel'
          ? { kind: 'camel', firstName: 'value' }
          : { kind: 'other', otherValue: 'value' },
      );
      expect(JSON.parse(modelToolCall(saved).arguments)).toEqual(input);
    }
  }
});

test('repeated allOf declarations of one original field retain a single reversible rule', () => {
  const model = surface([
    tool({
      type: 'object',
      properties: { oldText: { type: 'string' }, input: {} },
      allOf: [
        { properties: { oldText: { type: 'string' } }, required: ['oldText'] },
        { properties: { oldText: { minLength: 1 } } },
      ],
    }),
  ]);
  const input = { old_text: 'value', input: { oldText: 'opaque', old_text: 'also opaque' } };
  const saved = call(model, 'fixture', input);
  expect(saved.model?.error).toBeUndefined();
  expect(JSON.parse(saved.arguments)).toEqual({ oldText: 'value', input: input.input });
  expect(saved.model?.parameters).toEqual([{ path: ['oldText'], name: 'old_text' }]);
  expect(JSON.parse(modelToolCall(saved).arguments)).toEqual(input);
});

test('mutually exclusive oneOf declarations may share a public name for different original fields', () => {
  const model = surface([
    tool({
      type: 'object',
      oneOf: [
        {
          properties: { kind: { const: 'camel' }, firstName: { type: 'string' } },
          required: ['kind', 'firstName'],
        },
        {
          properties: { kind: { const: 'literal' }, first_name: { type: 'string' } },
          required: ['kind', 'first_name'],
        },
      ],
    }),
  ]);
  for (const kind of ['camel', 'literal']) {
    const input = { kind, first_name: 'value' };
    const saved = call(model, 'fixture', input);
    expect(saved.model?.error).toBeUndefined();
    expect(JSON.parse(saved.arguments)).toEqual({
      kind,
      [kind === 'camel' ? 'firstName' : 'first_name']: 'value',
    });
    expect(JSON.parse(modelToolCall(saved).arguments)).toEqual(input);
  }
});

test('conditional and oneOf branches preserve opaque inputs and persist only activated rules', () => {
  const schema: JsonSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['kind', 'input'],
    properties: { kind: { enum: ['structured', 'opaque'] }, input: {} },
    allOf: [
      {
        if: { properties: { kind: { const: 'structured' } } },
        // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional keyword.
        then: { properties: { input: structured } },
      },
    ],
  };
  for (const inputSchema of [
    schema,
    {
      oneOf: [
        {
          ...schema,
          allOf: undefined,
          properties: { kind: { const: 'structured' }, input: structured },
        },
        { ...schema, allOf: undefined, properties: { kind: { const: 'opaque' }, input: {} } },
      ],
    },
  ].map((value) => JSON.parse(JSON.stringify(value)) as JsonSchema)) {
    const model = surface([tool(inputSchema)]);
    const opaque = { kind: 'opaque', input: { old_text: 'business key', oldText: 'another key' } };
    const saved = call(model, 'fixture', opaque);
    expect(saved.model?.error).toBeUndefined();
    expect(JSON.parse(saved.arguments)).toEqual(opaque);
    expect(saved.model?.parameters).toBeUndefined();
    const publicInput = { kind: 'structured', input: { old_text: 'replace me' } };
    const changed = call(model, 'fixture', publicInput);
    expect(JSON.parse(changed.arguments)).toEqual({
      kind: 'structured',
      input: { oldText: 'replace me' },
    });
    expect(changed.model?.parameters).toEqual([{ path: ['input', 'oldText'], name: 'old_text' }]);
    expect(JSON.parse(modelToolCall(changed).arguments)).toEqual(publicInput);
  }
});

test('array branches record exact indexes and never rename opaque sibling data', () => {
  const model = surface([
    tool({
      type: 'object',
      properties: {
        checks: {
          type: 'array',
          items: {
            oneOf: [
              {
                type: 'object',
                properties: { kind: { const: 'structured' }, input: structured },
                required: ['kind', 'input'],
              },
              {
                type: 'object',
                properties: { kind: { const: 'opaque' }, input: {} },
                required: ['kind', 'input'],
              },
            ],
          },
        },
      },
    }),
  ]);
  const args = {
    checks: [
      { kind: 'structured', input: { old_text: 'one' } },
      { kind: 'opaque', input: { old_text: 'two' } },
    ],
  };
  const saved = call(model, 'fixture', args);
  expect(JSON.parse(saved.arguments).checks).toEqual([
    { kind: 'structured', input: { oldText: 'one' } },
    { kind: 'opaque', input: { old_text: 'two' } },
  ]);
  expect(saved.model?.parameters).toEqual([
    { path: ['checks', '0', 'input', 'oldText'], name: 'old_text' },
  ]);
  expect(JSON.parse(modelToolCall(saved).arguments)).toEqual(args);
});

test('ambiguous anyOf transformations fail without altering the original arguments', () => {
  const model = surface([tool({ anyOf: [structured, { type: 'object' }] })]);
  const saved = call(model, 'fixture', { old_text: 'opaque or structured' });
  expect(saved.model?.error).toBe('invalid_tool_arguments');
  expect(JSON.parse(saved.arguments)).toEqual({ old_text: 'opaque or structured' });
});

test('tool schema registries are independent and name-only schemas are not recompiled', () => {
  const schema: JsonSchema = {
    $id: 'local://tool-input',
    type: 'object',
    properties: { oldText: { type: 'string' } },
  };
  const projected = surface([tool(schema, 'first'), tool(schema, 'second')]);
  expect(JSON.parse(call(projected, 'first', { old_text: 'a' }).arguments)).toEqual({
    oldText: 'a',
  });
  expect(JSON.parse(call(projected, 'second', { old_text: 'b' }).arguments)).toEqual({
    oldText: 'b',
  });
  // Remote schemas may use a dialect understood by their owner; pure name projection must not compile it.
  const remote = surface([
    tool({ ...schema, $schema: 'https://json-schema.org/draft/2020-12/schema' }, 'remote', false),
  ]);
  expect(call(remote, 'remote', { oldText: 'unchanged' }).arguments).toBe(
    '{"oldText":"unchanged"}',
  );
});

test('name-only MCP projection preserves legal empty fields, composed schemas and exact remote arguments', () => {
  const inputSchema: JsonSchema = {
    type: 'object',
    properties: { '': { type: 'string' }, payload: {} },
    required: ['', 'payload'],
    allOf: [
      {
        properties: { remoteValue: { type: 'string' } },
        anyOf: [{ required: ['remoteValue'] }, { properties: { payload: { type: 'object' } } }],
      },
    ],
  };
  const args = '{ "": "remote", "remoteValue": "unchanged", "payload": {"oldText":"opaque"} }';
  expect(
    ListToolsResultSchema.safeParse({ tools: [{ name: 'remote', inputSchema }] }).success,
  ).toBe(true);
  // Match the existing MCP owner's schema validator; empty property names are legal there.
  expect(
    new Ajv({ strict: false, allErrors: false, validateFormats: false }).compile(inputSchema)(
      JSON.parse(args),
    ),
  ).toBe(true);
  const model = surface([tool(inputSchema, 'remote', false)]);
  expect(model.tools[0]!.inputSchema).toEqual(inputSchema);
  expect(model.tools[0]!.inputSchema).not.toBe(inputSchema);
  expect(model.tools[0]!.inputSchema.properties).not.toBe(inputSchema.properties);
  const saved = model.decode({ id: 'remote-call', name: 'remote', arguments: args });
  expect(saved.model?.error).toBeUndefined();
  expect(saved.model?.parameters).toBeUndefined();
  expect(saved.arguments).toBe(args);
  expect(modelToolCall(saved)).toEqual({ id: 'remote-call', name: 'remote', arguments: args });
});

test('existing planning oneOf and file write composition remain callable', () => {
  const planning = createPlanningValidation().extension.tools!;
  const files = createFileTools({} as WorkspaceFiles);
  const model = surface([...planning, ...files]);
  const checks: Record<string, Json>[] = [
    { kind: 'command', input: { expected_exit_code: 'opaque' }, expected_exit_code: 0 },
    {
      kind: 'mcp',
      checker_id: 'checker',
      input: { checker_id: 'opaque' },
      target: {
        execution_id: 'execution',
        attempt: 1,
        definition_id: 'fixture',
        definition_version: '1',
        input_digest: 'digest',
        result_revision: 'revision',
      },
      schema: {},
    },
  ];
  const saved = call(model, 'define_validation_checks', { run_id: 'run', checks });
  expect(saved.model?.error).toBeUndefined();
  expect(JSON.parse(saved.arguments).checks[0]).toEqual({
    kind: 'command',
    input: checks[0]!.input,
    expectedExitCode: 0,
  });
  expect(
    call(model, 'write_file', { path: 'new.txt', content: 'hello', base: null }).model?.error,
  ).toBeUndefined();
  expect(
    call(model, 'write_file', {
      path: 'new.txt',
      content: 'hello',
      content_artifact: {},
      base: null,
    }).model?.error,
  ).toBe('invalid_tool_arguments');
});

test('renamed declarations in predicates reject explicitly and history-only projection stays visible', () => {
  expect(() =>
    surface([tool({ type: 'object', if: { properties: { oldText: { const: 'x' } } } })]),
  ).toThrow('model_tool_schema_predicate_unsupported');
  const saved = call(
    surface([{ ...tool(structured), model: { name: 'public_fixture', snakeCase: true } }]),
    'public_fixture',
    { old_text: 'original' },
  );
  expect(saved.name).toBe('fixture');
  const request: ModelRequest = {
    modelId: 'fixture',
    requestId: 'next',
    tools: [],
    messages: [{ role: 'assistant', content: '', toolCalls: [saved] }],
  };
  const projected = createModelToolSurface(request, new Map());
  expect(projected.changed).toBe(true);
  expect(projected.request.messages[0]!.toolCalls).toEqual([
    { id: 'call', name: 'public_fixture', arguments: '{"old_text":"original"}' },
  ]);
});

test('open structured schemas do not accept old internal field aliases', () => {
  const model = surface([tool({ type: 'object', properties: { oldText: { type: 'string' } } })]);
  expect(call(model, 'fixture', { oldText: 'old alias' }).model?.error).toBe(
    'invalid_tool_arguments',
  );
  expect(
    call(model, 'fixture', { old_text: 'current', extra: { oldText: 'opaque' } }).model?.error,
  ).toBeUndefined();
});
