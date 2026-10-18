import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixedModel, type ModelEvent, type ModelRequest } from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import { createArtifactStore } from '../../../src/artifacts';
import type { CompressionInput } from '../../../src/context';
import { projectModelContext } from '../../../src/context-estimate';
import type { AuthorizationRequest, Json, ToolDefinition } from '../../../src/extensions';
import { createTaskExtension } from '../../../src/extensions/task';
import { createModelToolSurface, modelToolCall } from '../../../src/model-tools';
import { openSqliteStore } from '../../../src/sqlite';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
function request(tools: readonly ToolDefinition[]): ModelRequest {
  return {
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
}
const execute: ToolDefinition['execute'] = async () => ({ outcome: 'succeeded', content: 'done' });

test('projected schema and arguments preserve opaque JSON, array fields and conditional requirements', () => {
  const tool: ToolDefinition = {
    id: 'fixture.edit',
    version: '1',
    description: 'Edit exact input',
    model: { name: 'edit_file', snakeCase: true, parameterNames: { oldText: 'old_text' } },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        oldText: { type: 'string' },
        newText: { type: 'string' },
        input: {},
        checks: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['expectedHash'],
            properties: { expectedHash: { type: 'string' }, input: {} },
          },
        },
      },
      allOf: [
        {
          oneOf: [
            { required: ['oldText'], not: { required: ['newText'] } },
            { required: ['newText'] },
          ],
        },
      ],
    },
    execute,
  };
  const surface = createModelToolSurface(request([tool]), new Map([[tool.id, tool]]));
  const args = {
    old_text: 'literal expectedHash camelCase',
    input: { CamelKey: 1 },
    checks: [{ expected_hash: 'abc', input: { KeepThis: true } }],
  };
  const call = surface.decode({ id: 'call', name: 'edit_file', arguments: JSON.stringify(args) });
  expect(JSON.parse(call.arguments)).toEqual({
    oldText: args.old_text,
    input: args.input,
    checks: [{ expectedHash: 'abc', input: { KeepThis: true } }],
  });
  expect(JSON.parse(modelToolCall(call).arguments)).toEqual(args);
  expect(surface.tools[0]!.inputSchema.allOf).toEqual([
    {
      oneOf: [
        { required: ['old_text'], not: { required: ['new_text'] } },
        { required: ['new_text'] },
      ],
    },
  ]);
  expect(
    surface.decode({
      id: 'bad',
      name: 'edit_file',
      arguments: JSON.stringify({ oldText: 'old alias' }),
    }).model?.error,
  ).toBe('invalid_tool_arguments');
  expect(surface.decode({ id: 'malformed', name: 'edit_file', arguments: '{' }).arguments).toBe(
    '{',
  );
});

test('public name and parameter collisions fail before Model I/O', () => {
  const first: ToolDefinition = {
    id: 'one',
    version: '1',
    description: 'one',
    inputSchema: { type: 'object' },
    model: { name: 'same' },
    execute,
  };
  const second = { ...first, id: 'two' };
  expect(() =>
    createModelToolSurface(
      request([first, second]),
      new Map([
        [first.id, first],
        [second.id, second],
      ]),
    ),
  ).toThrow('model_tool_name_collision');
  const fields = {
    ...first,
    model: { name: 'fields', snakeCase: true },
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string' }, run_id: { type: 'string' } },
    },
  };
  expect(() => createModelToolSurface(request([fields]), new Map([[fields.id, fields]]))).toThrow(
    'model_tool_parameter_collision',
  );
});

test('only one child wait entry accepts task targets; event waits have no task parameters', () => {
  const tools = createTaskExtension({
    roles: [{ id: 'worker', configurationId: 'worker', description: 'Bounded work' }],
  }).tools!;
  const surface = createModelToolSurface(
    request(tools),
    new Map(tools.map((tool) => [tool.id, tool])),
  );
  expect(surface.tools.some((tool) => tool.id === 'task_wait')).toBe(false);
  const wait = surface.tools.find((tool) => tool.id === 'wait_agents')!;
  expect(wait.inputSchema.required).toContain('task_ids');
  expect(wait.inputSchema.properties).not.toHaveProperty('task_id');
  const event = surface.tools.find((tool) => tool.id === 'wait_agent_event')!;
  expect(Object.keys(event.inputSchema.properties!)).toEqual(['after_seq', 'timeout_ms']);
  expect(surface.decode({ id: 'hidden', name: 'task_wait', arguments: '{}' }).model?.error).toBe(
    'tool_not_available',
  );
  expect(
    surface.decode({ id: 'singular', name: 'wait_agents', arguments: '{"task_id":"one"}' }).model
      ?.error,
  ).toBe('invalid_tool_arguments');
  expect(
    surface.decode({ id: 'valid', name: 'wait_agents', arguments: '{"task_ids":["one"]}' })
      .arguments,
  ).toBe('{"taskIds":["one"]}');
});

test('real Runtime keeps internal dispatch authority and cold public snapshots while all adapters see the model surface', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-model-tools-')));
  const profile = { dataRoot: join(root, 'data'), profile: 'surface' };
  const opaque = { CamelKey: 'full 😀'.repeat(11000) };
  const publicInput = { command_id: 'original', input: opaque };
  const model = createFixedModel([
    [
      { type: 'tool_call', id: 'valid', name: 'edit_file', arguments: JSON.stringify(publicInput) },
      {
        type: 'tool_call',
        id: 'old-fields',
        name: 'edit_file',
        arguments: '{"commandId":"old","input":{}}',
      },
      {
        type: 'tool_call',
        id: 'old-name',
        name: 'fixture.edit',
        arguments: '{"commandId":"old","input":{}}',
      },
      { type: 'tool_call', id: 'hidden', name: 'hidden_wait', arguments: '{}' },
      { type: 'tool_call', id: 'malformed', name: 'edit_file', arguments: '{' },
      { ...finish, reason: 'tool_calls' },
    ],
    [{ type: 'text_delta', text: 'done' }, finish],
  ]);
  const inputs: Json[] = [],
    authorizations: AuthorizationRequest[] = [];
  const compressionChecks: CompressionInput[] = [];
  const store = await openSqliteStore(profile);
  const artifacts = createArtifactStore({ profile, store });
  const definition: ToolDefinition = {
    id: 'fixture.edit',
    version: '1',
    description: 'Exact edit',
    model: { name: 'edit_file', snakeCase: true },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['commandId', 'input'],
      properties: { commandId: { type: 'string' }, input: {} },
    },
    async execute(input) {
      inputs.push(input);
      return { outcome: 'succeeded', content: 'once' };
    },
  };
  const runtime = createRuntime({
    store,
    artifacts,
    model,
    compressor: {
      id: 'surface-budget',
      version: '1',
      prepare: async () => null,
      async shouldCompress(input) {
        compressionChecks.push(input);
        return false;
      },
    },
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          definition,
          { ...definition, id: 'fixture.hidden', model: { name: 'hidden_wait', hidden: true } },
        ],
      },
    ],
    permissions: {
      async authorize(value) {
        authorizations.push(value);
        return { allowed: true, revision: 'exact' };
      },
    },
  });
  let closed = false;
  let reader: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  let cold: ReturnType<typeof createRuntime> | undefined;
  try {
    const storeId = (await store.getMetadata()).storeId;
    await runtime.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'owned',
      rootUri: pathToFileURL(root).href,
    });
    const scope = { expectedStoreId: storeId, subjectId: 'owner', sessionId: 's' };
    await runtime.createSession({
      ...scope,
      commandId: 'create',
      workspaceId: 'w',
      title: 'surface',
    });
    await runtime.submitCommand({
      ...scope,
      commandId: 'work',
      request: { kind: 'run.start', content: 'edit exactly once' },
    });
    const command = await runtime.waitForCommand('work', { timeoutMs: 5000 });
    expect(command.status).toBe('applied');
    expect((await store.getRun((command.receipt as { runId: string }).runId))?.status).toBe(
      'completed',
    );
    expect(inputs).toEqual([{ commandId: 'original', input: opaque }]);
    const actualTools = model.requests[0]!.tools;
    expect(actualTools.map((tool) => tool.id)).toEqual(['edit_file']);
    expect(actualTools[0]!.inputSchema.properties).toHaveProperty('command_id');
    const history = model.requests[1]!.messages.flatMap((message) => message.toolCalls ?? []);
    const historicalCall = history.find((call) => call.id === 'valid')!;
    expect(historicalCall.name).toBe('edit_file');
    expect(JSON.parse(historicalCall.arguments)).toEqual(publicInput);
    expect(history.every((call) => !Object.hasOwn(call, 'model'))).toBe(true);
    expect(compressionChecks).toHaveLength(2);
    const budget = compressionChecks[1]!;
    expect(budget.tools).toEqual(model.requests[1]!.tools);
    expect(
      projectModelContext(
        { modelId: budget.modelId!, messages: budget.messages, tools: budget.tools! },
        budget.tokenBaseline,
      ),
    ).toMatchObject({ source: 'reported_baseline', measuredInputTokens: 1 });
    expect(
      await runtime.readContextEstimate({ ...scope, executionId: model.requests[1]!.requestId }),
    ).toMatchObject({ source: 'reported_baseline', measuredInputTokens: 1 });
    const executions = await store.listExecutions('s');
    const tool = executions.find((row) => row.kind === 'tool' && row.callId === 'valid')!;
    expect(tool.definitionId).toBe('fixture.edit');
    expect(tool.input).toEqual({ commandId: 'original', input: opaque });
    const toolAuthorizations = authorizations.filter((value) => value.kind === 'tool');
    expect(toolAuthorizations.length).toBeGreaterThan(0);
    for (const authorization of toolAuthorizations)
      expect(authorization).toMatchObject({
        definitionId: 'fixture.edit',
        input: { commandId: 'original', input: opaque },
      });
    const failed = executions.filter((row) => row.kind === 'tool' && row.status === 'failed');
    expect(failed).toHaveLength(4);
    const models = executions.filter((row) => row.kind === 'model');
    for (const row of models) {
      const saved = await runtime.readModelInput({ ...scope, executionId: row.id });
      expect(saved.request).toEqual(model.requests.find((value) => value.requestId === row.id)!);
      expect(saved.metadata.context?.transformationVersion).toBe('2');
      expect(saved.metadata.context).not.toHaveProperty('toolSurface');
    }
    await runtime.close();
    closed = true;
    reader = await openSqliteStore({ ...profile, mode: 'readonly' });
    cold = createRuntime({
      store: reader,
      artifacts: createArtifactStore({ profile, store: reader }),
      permissions: { authorize: async () => ({ allowed: false, revision: 'cold-read-only' }) },
    });
    for (const row of models)
      expect((await cold.readModelInput({ ...scope, executionId: row.id })).request).toEqual(
        model.requests.find((value) => value.requestId === row.id)!,
      );
    expect(inputs).toHaveLength(1);
  } finally {
    if (!closed) await runtime.close();
    await cold?.close();
    if (!cold) await reader?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
