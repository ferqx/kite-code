import { expect, test } from 'bun:test';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import type { ToolContext } from '@kite-ai/agent/extensions';
import { createFileTools, createWorkspaceFiles } from '@kite-ai/agent/files';
import { createMcpAdapter, createMcpLifecycle } from '@kite-ai/agent/mcp';
import { createPlanningValidation } from '@kite-ai/agent/planning';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createCompatibleModelBinding, createSdkModelAdapter } from '@kite-ai/ai/sdk';
import { createMcpToolsSearchTool } from '../../../packages/agent/src/mcp/tools-search';
import { createModelToolSurface } from '../../../packages/agent/src/model-tools';
import { createMockModelServer, type MockChatRequest } from './fixtures';
import { originalModelToolName, projectOriginalModelToolCall } from './model-tool-contract';
import { migrateOriginalToolCall } from './original-tool-contract';

test('actual SDK mock calls execute real Runtime Files tools with original identities, complete baselines and persisted inputs', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kite-model-tools-runtime-')));
  const scope = { workspace: root, home: root };
  const server = createMockModelServer();
  server.bindWorkspace(scope);
  server.setResponses([
    {
      message: {
        tool_calls: [
          {
            id: 'original-read',
            name: 'read_file',
            args: { path: 'sample.txt', offset: 2, limit: 1 },
          },
        ],
      },
    },
    {
      expectedRequest: {
        toolResults: [{ toolCallId: 'original-read', contentIncludes: ['second'] }],
      },
      message: {
        tool_calls: [
          {
            id: 'original-write',
            name: 'write_file',
            args: { path: 'sample.txt', content: 'full 🪁\nsecond\n' },
          },
        ],
      },
    },
    {
      expectedRequest: {
        toolResults: [{ toolCallId: 'original-write', contentIncludes: ['sample.txt'] }],
      },
      message: {
        tool_calls: [
          {
            id: 'original-edit',
            name: 'edit_file',
            args: { path: 'sample.txt', old_string: 'full 🪁', new_string: 'changed 雪' },
          },
        ],
      },
    },
    {
      expectedRequest: {
        toolResults: [{ toolCallId: 'original-edit', contentIncludes: ['sample.txt'] }],
      },
      message: {
        tool_calls: [{ id: 'original-glob', name: 'search_files', args: { pattern: '*.txt' } }],
      },
    },
    {
      expectedRequest: {
        toolResults: [{ toolCallId: 'original-glob', contentIncludes: ['sample.txt'] }],
      },
      message: {
        tool_calls: [
          {
            id: 'original-search',
            name: 'grep',
            args: { pattern: 'changed 雪', path: 'sample.txt' },
          },
        ],
      },
    },
    {
      expectedRequest: {
        toolResults: [{ toolCallId: 'original-search', contentIncludes: ['changed 雪'] }],
      },
      message: { content: 'All real tools finished.' },
    },
  ]);
  await writeFile(join(root, 'sample.txt'), 'first\nsecond\nthird\n');
  const profile = { dataRoot: join(root, 'data'), profile: 'fixture' };
  const store = await openSqliteStore(profile);
  const files = createWorkspaceFiles({ root });
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    modelId: 'fixture',
    model: createSdkModelAdapter({
      models: new Map([
        ['fixture', createCompatibleModelBinding({ baseURL: server.baseURL, modelId: 'mock' })],
      ]),
    }),
    extensions: [{ id: 'builtin.files', version: '1', apiMajor: 1, tools: createFileTools(files) }],
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'owned' };
      },
    },
  });
  try {
    const expectedStoreId = (await store.getMetadata()).storeId;
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'owned',
      rootUri: pathToFileURL(root).href,
    });
    const input = { expectedStoreId, subjectId: 'owner', sessionId: 's' };
    await runtime.createSession({
      ...input,
      commandId: 'create',
      workspaceId: 'w',
      title: 'fixture',
    });
    await runtime.submitCommand({
      ...input,
      commandId: 'work',
      request: { kind: 'run.start', content: 'Exercise original calls exactly once.' },
    });
    const command = await runtime.waitForCommand('work', { timeoutMs: 10000 });
    expect(command.status).toBe('applied');
    expect((await store.getRun((command.receipt as { runId: string }).runId))?.status).toBe(
      'completed',
    );
    expect(await readFile(join(root, 'sample.txt'), 'utf8')).toBe('changed 雪\nsecond\n');
    const executions = (await store.listExecutions('s')).filter((row) => row.kind === 'tool');
    expect(executions.map((row) => [row.callId, row.definitionId, row.status])).toEqual([
      ['original-read', 'files.read', 'succeeded'],
      ['original-write', 'files.write', 'succeeded'],
      ['original-edit', 'files.edit', 'succeeded'],
      ['original-glob', 'files.glob', 'succeeded'],
      ['original-search', 'files.search', 'succeeded'],
    ]);
    expect(executions[0]!.input).toEqual({ path: 'sample.txt', offset: 2, limit: 1 });
    expect(executions[1]!.input).toMatchObject({
      base: { hash: expect.stringMatching(/^[a-f0-9]{64}$/), size: 19 },
    });
    expect(executions[2]!.input).toMatchObject({
      find: 'full 🪁',
      replace: 'changed 雪',
      occurrences: 1,
    });
    expect(executions[4]!.input).toEqual({
      text: 'changed 雪',
      mode: 'content',
      path: 'sample.txt',
    });
    expect(
      server.getToolContractMigrations().map(({ emitted }) => [emitted.id, emitted.name]),
    ).toEqual([
      ['original-read', 'read_file'],
      ['original-write', 'write_file'],
      ['original-edit', 'edit_file'],
      ['original-glob', 'glob_files'],
      ['original-search', 'search_content'],
    ]);
    expect(server.getToolContractMigrations()[0]!.emitted.args).toEqual({
      path: 'sample.txt',
      start_line: 2,
      max_lines: 1,
    });
    expect(server.getRequests()).toHaveLength(6);
    expect(server.getRequests()[0]!.body.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ function: expect.objectContaining({ name: 'read_file' }) }),
      ]),
    );
    expect(() => server.assertComplete()).not.toThrow();
  } finally {
    await runtime.close();
    await files.close();
    await store.close();
    server.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 20000);

test('planning and MCP metadata round-trip exact CAS and connection identity without changing opaque data', () => {
  const tools = [
    ...createPlanningValidation().extension.tools!,
    ...createMcpLifecycle({ servers: [] }).extension.tools!,
  ];
  const request: MockChatRequest = { body: {}, messages: [] };
  const cases = [
    {
      id: 'plan',
      name: 'planning.write',
      args: {
        planId: 'exact',
        expectedVersion: null,
        title: 'Goal',
        body: 'Full body 🪁',
        steps: [{ id: 'one', title: 'Exact step' }],
      },
    },
    {
      id: 'review',
      name: 'planning.review',
      args: { planId: 'exact', version: 1, digest: 'a'.repeat(64) },
    },
    {
      id: 'resource',
      name: 'mcp.resources.read',
      args: {
        serverId: 'server',
        connectionKey: 'connection',
        configDigest: 'a'.repeat(64),
        generation: 1,
        uri: 'fixture://full',
        catalogueExecutionId: 'original-catalogue',
        descriptorDigest: 'b'.repeat(64),
      },
    },
  ];
  for (const call of cases) {
    const emitted = projectOriginalModelToolCall(call, request);
    expect(emitted.id).toBe(call.id);
    expect(emitted.name).toBe(tools.find((tool) => tool.id === call.name)!.model!.name);
    const tool = tools.find((tool) => tool.id === call.name)!;
    const surface = createModelToolSurface(
      {
        modelId: 'fixture',
        requestId: call.id,
        messages: [],
        tools: [{ id: tool.id, definitionVersion: tool.version, inputSchema: tool.inputSchema }],
      },
      new Map([[tool.id, tool]]),
    );
    expect(
      JSON.parse(
        surface.decode({
          id: emitted.id,
          name: emitted.name,
          arguments: JSON.stringify(emitted.args),
        }).arguments,
      ),
    ).toEqual(call.args);
  }
  expect(projectOriginalModelToolCall(cases[0]!, request).args).toMatchObject({
    plan_id: 'exact',
    expected_version: null,
    steps: [{ id: 'one', title: 'Exact step' }],
  });
  expect(projectOriginalModelToolCall(cases[2]!, request).args).toMatchObject({
    connection_key: 'connection',
    catalogue_execution_id: 'original-catalogue',
    descriptor_digest: 'b'.repeat(64),
  });
  expect(() =>
    projectOriginalModelToolCall({ id: 'hidden', name: 'task.execute', args: {} }, request),
  ).toThrow('original_task_requires_public_collaboration_migration');
  const publicTask = {
    id: 'public',
    name: 'spawn_agent',
    args: { prompt: 'Original task', task_name: 'Child', preset: 'code' },
  };
  expect(projectOriginalModelToolCall(publicTask, request)).toEqual(publicTask);
  expect(originalModelToolName('shell.execute', request)).toBe('shell_execute');
  expect(() =>
    originalModelToolName('shell.execute', {
      body: {
        tools: [{ function: { name: 'shell_execute' } }, { function: { name: 'shell_execute' } }],
      },
      messages: [],
    }),
  ).toThrow('original_tool_model_declaration_ambiguous');
  expect(
    projectOriginalModelToolCall(
      {
        id: 'shell',
        name: 'shell.execute',
        args: { key: 'original', command: 'echo safe', timeoutMs: 1000 },
      },
      request,
    ),
  ).toEqual({
    id: 'shell',
    name: 'shell_execute',
    args: { key: 'original', command: 'echo safe', execution_timeout_ms: 1000 },
  });
});

test('dynamic MCP adopts the actual frozen public name and preserves remote JSON; invalid JSON bytes remain raw', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kite-model-mcp-')));
  const server = createMockModelServer();
  const ledger = join(root, 'ledger');
  const catalogue = join(root, 'catalogue');
  await writeFile(
    catalogue,
    JSON.stringify([
      {
        name: 'RemoteEcho',
        description: 'Remote',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['CamelKey'],
          properties: { CamelKey: {} },
        },
      },
    ]),
  );
  const adapter = createMcpAdapter({
    id: 'closed',
    transport: {
      type: 'stdio',
      command: process.execPath,
      args: [join(import.meta.dir, '../../fixtures/mcp-leaf/stdio.ts'), ledger, catalogue, ''],
      cwd: root,
      env: { PATH: process.env.PATH ?? '' },
    },
  });
  const remote = adapter.scope('original');
  try {
    server.bindWorkspace({ workspace: root, home: root });
    server.setResponses([
      {
        message: {
          invalid_tool_calls: [{ id: 'bad', name: 'shell_execute', args: '{"command": "ls' }],
        },
        toolContinuation: 'aborted',
      },
    ]);
    const result = await fetch(`${server.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [], stream: false }),
    });
    expect((await result.json()).choices[0].message.tool_calls).toEqual([
      {
        id: 'bad',
        type: 'function',
        function: { name: 'shell_execute', arguments: '{"command": "ls' },
      },
    ]);
    expect(() => server.assertComplete()).not.toThrow();
    const tool = (await remote.snapshotTools())[0]!;
    const search = createMcpToolsSearchTool('store', 'session', [
      { serverId: 'closed', label: 'closed', tools: [tool], async assertFresh() {} },
    ]);
    const found = await search.execute({ query: 'Remote' }, {
      signal: new AbortController().signal,
      executionId: 'search',
      sessionId: 'session',
      async getExecution() {
        return {
          kind: 'tool',
          originStoreId: 'store',
          sessionId: 'session',
          definitionId: search.id,
          definitionVersion: search.version,
        };
      },
    } as unknown as ToolContext);
    expect(found.outcome).toBe('succeeded');
    const request: MockChatRequest = {
      body: { tools: [{ function: { name: tool.model!.name } }] },
      messages: [
        {
          role: 'tool',
          content: found.content,
        },
      ],
    };
    const original = {
      id: 'mcp-original',
      name: 'mcp__closed__RemoteEcho',
      args: { CamelKey: { keepThis: 'full 🪁' } },
    };
    const call = await migrateOriginalToolCall(original, { workspace: root, home: root }, request);
    expect(call).toEqual({ ...original, name: tool.id });
    expect(projectOriginalModelToolCall(call, request)).toEqual({
      ...call,
      name: tool.model!.name,
    });
    const emitted = projectOriginalModelToolCall(call, request);
    const surface = createModelToolSurface(
      {
        modelId: 'fixture',
        requestId: 'original',
        messages: [],
        tools: [{ id: tool.id, definitionVersion: tool.version, inputSchema: tool.inputSchema }],
      },
      new Map([[tool.id, tool]]),
    );
    const decoded = surface.decode({
      id: emitted.id,
      name: emitted.name,
      arguments: JSON.stringify(emitted.args),
    });
    expect(decoded.name).toBe(tool.id);
    expect(
      await tool.execute(JSON.parse(decoded.arguments), {
        signal: new AbortController().signal,
      } as ToolContext),
    ).toMatchObject({ outcome: 'succeeded' });
    expect(
      (await readFile(ledger, 'utf8'))
        .split('\n')
        .filter((line) => line.startsWith('effect:'))
        .map((line) => JSON.parse(line.slice(7))),
    ).toEqual([{ name: 'RemoteEcho', arguments: original.args }]);
    expect(() =>
      projectOriginalModelToolCall(call, { body: {}, messages: request.messages }),
    ).toThrow('original_mcp_tool_source_unavailable');
    const migrated = await migrateOriginalToolCall(
      { id: 'bad-contract', name: 'read_file', args: { path: 'file', offset: 0 } },
      { workspace: root, home: root },
    );
    expect(() => projectOriginalModelToolCall(migrated, request)).toThrow(
      'original_tool_model_projection_changed_input',
    );
  } finally {
    await remote.release();
    await adapter.close();
    server.stop();
    await rm(root, { recursive: true, force: true });
  }
});
