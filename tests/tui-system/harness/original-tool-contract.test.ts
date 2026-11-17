import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Json, PublicExecution, ToolContext } from '@kite-ai/agent/extensions';
import { createFileTools, createWorkspaceFiles } from '@kite-ai/agent/files';
import { sessionTitleInstructions } from '../../../packages/agent/src/business/session-title/title';
import { createMockModelServer, type MockChatRequest, parseDraftSavedPlan } from './fixtures';
import { migrateOriginalToolCall, originalToolName } from './original-tool-contract';

async function ownedFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kite-original-tools-')));
  return { root, scope: { workspace: root, home: root } };
}

test('original File calls preserve IDs and execute the current read/write/edit Tools', async () => {
  const { root, scope } = await ownedFixture();
  const files = createWorkspaceFiles({ root });
  const tools = new Map(createFileTools(files).map((tool) => [tool.id, tool]));
  const request: MockChatRequest = { body: {}, messages: [] };
  const executions = new Map<string, PublicExecution>();
  const context = (id: string, name: string): ToolContext => {
    executions.set(id, {
      id,
      originStoreId: 'store',
      sessionId: 'session',
      runId: 'run',
      kind: 'tool',
      extensionId: 'builtin.files',
      definitionId: name,
      definitionVersion: tools.get(name)!.version,
      status: 'running',
      result: null,
      resultRevision: '1',
      authorization: { dispatched: true },
    });
    return {
      signal: new AbortController().signal,
      executionId: id,
      sessionId: 'session',
      runId: 'run',
      getExecution: async (id: string) => executions.get(id) ?? null,
    } as ToolContext;
  };
  const execute = async (id: string, name: string, args: Record<string, unknown>) => {
    const migrated = await migrateOriginalToolCall({ id, name, args }, scope, request);
    expect(migrated.id).toBe(id);
    const tool = tools.get(migrated.name)!;
    expect(tool).toBeDefined();
    const result = await tool.execute(migrated.args as Json, context(id, migrated.name));
    expect(result.outcome).toBe('succeeded');
    Object.assign(executions.get(id)!, { status: 'succeeded', result });
    request.messages.push({ role: 'tool', tool_call_id: id, content: result.content });
    return JSON.parse(result.content);
  };
  try {
    const created = await execute('write', 'write_file', {
      path: 'sample.txt',
      content: 'alpha\nsecond\n',
    });
    expect(created.baseline.hash).toMatch(/^[a-f0-9]{64}$/);
    expect((await execute('read', 'read_file', { path: 'sample.txt' })).content).toBe(
      'alpha\nsecond\n',
    );
    await execute('edit', 'edit_file', {
      path: 'sample.txt',
      old_string: 'alpha',
      new_string: 'beta',
    });
    expect(await readFile(join(root, 'sample.txt'), 'utf8')).toBe('beta\nsecond\n');
    // Freshness is enforced by the real new Tool, not softened by the fixture.
    const stale = await migrateOriginalToolCall(
      { id: 'stale', name: 'write_file', args: { path: 'sample.txt', content: 'wrong' } },
      scope,
      request,
    );
    await writeFile(join(root, 'sample.txt'), 'new actual bytes');
    const result = await tools
      .get(stale.name)!
      .execute(stale.args as Json, context(stale.id, stale.name));
    expect(result.outcome).toBe('failed');
    expect(await readFile(join(root, 'sample.txt'), 'utf8')).toBe('new actual bytes');
  } finally {
    await files.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('non-equivalent shell deadlines, grep regex, unowned baselines and ignored fields fail explicitly', async () => {
  const { root, scope } = await ownedFixture();
  try {
    for (const call of [
      { id: 'timeout', name: 'shell_execute', args: { command: 'echo safe', timeout: 1000 } },
      { id: 'regex', name: 'grep', args: { pattern: 'a.*b' } },
      {
        id: 'outside',
        name: 'write_file',
        args: { path: join(root, '..', 'unowned.txt'), content: 'no' },
      },
      { id: 'ignored', name: 'read_file', args: { path: 'sample.txt', invented: true } },
    ])
      await expect(migrateOriginalToolCall(call, scope)).rejects.toThrow();
    expect(
      await migrateOriginalToolCall(
        { id: 'shell-id', name: 'shell_execute', args: { command: 'echo safe' } },
        scope,
      ),
    ).toMatchObject({ id: 'shell-id', name: 'shell.execute', args: { command: 'echo safe' } });
    expect(originalToolName('task')).toBe('task');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('new workspace and external writes omit baselines while replacement and edit copy only original path references', async () => {
  const { root } = await ownedFixture();
  const scope = { home: root, workspace: join(root, 'workspace') };
  await mkdir(scope.workspace);
  const external = join(root, 'external.txt');
  try {
    for (const path of ['new.txt', external]) {
      const migrated = await migrateOriginalToolCall(
        { id: 'new', name: 'write_file', args: { path, content: 'exact original bytes' } },
        scope,
      );
      expect(migrated).toEqual({
        id: 'new',
        name: 'files.write',
        args: { path, content: 'exact original bytes' },
      });
    }
    await writeFile(external, 'original');
    const call = {
      id: 'replace',
      name: 'write_file',
      args: { path: external, content: 'replacement' },
    };
    const reference = 'file.original-host-reference';
    const body = `Read ${JSON.stringify(external)}; from_line=1; lines=1-1/1; next_line=null; complete file.\nExternal file; outside workspace checkpoints. The reference does not grant write permission.\nbase_ref=${JSON.stringify(reference)}\nContent (8 UTF-8 bytes; starts on next line):\noriginal`;
    const request: MockChatRequest = {
      body: {},
      messages: [{ role: 'tool', tool_call_id: 'original-read', content: body }],
    };
    expect(await migrateOriginalToolCall(call, scope, request)).toEqual({
      ...call,
      name: 'files.write',
      args: { ...call.args, baseRef: reference },
    });
    expect(
      await migrateOriginalToolCall(
        {
          id: 'edit',
          name: 'edit_file',
          args: { path: external, old_string: 'original', new_string: 'edited' },
        },
        scope,
        request,
      ),
    ).toEqual({
      id: 'edit',
      name: 'files.edit',
      args: {
        path: external,
        find: 'original',
        replace: 'edited',
        occurrences: 1,
        baseRef: reference,
      },
    });
    for (const messages of [
      [],
      [{ role: 'user', content: body }],
      [
        {
          role: 'tool',
          content: JSON.stringify({ path: join(root, 'other.txt'), base_ref: reference }),
        },
      ],
      [
        {
          role: 'tool',
          content: `Read ${JSON.stringify(external)}; from_line=1; lines=1-1/1.\nContent (8 UTF-8 bytes; starts on next line):\nbase_ref=${JSON.stringify(reference)}`,
        },
      ],
    ])
      await expect(migrateOriginalToolCall(call, scope, { body: {}, messages })).rejects.toThrow(
        'original_tool_file_reference_unavailable',
      );
    await expect(
      migrateOriginalToolCall({ ...call, args: { ...call.args, base: null } }, scope, request),
    ).rejects.toThrow('original_tool_contract_unmapped');
    expect(await readFile(external, 'utf8')).toBe('original');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('plan fixture copies exact saved references and rejects mismatched versions and digests', async () => {
  const { root, scope } = await ownedFixture();
  const plan = { planId: 'original-plan', version: 2, digest: 'a'.repeat(64) };
  const request: MockChatRequest = {
    body: {},
    messages: [
      {
        role: 'tool',
        tool_call_id: 'saved',
        content: JSON.stringify({ ...plan, plan_ref: 'plan.original-host-reference' }),
      },
    ],
  };
  const submit = {
    id: 'review',
    name: 'write_plan',
    args: {
      action: 'submit',
      plan_id: plan.planId,
      version: plan.version,
      structural_digest: plan.digest,
    },
  };
  try {
    expect(await migrateOriginalToolCall(submit, scope, request)).toEqual({
      id: 'review',
      name: 'planning.review',
      args: { planRef: 'plan.original-host-reference' },
    });
    const save = {
      id: 'save',
      name: 'write_plan',
      args: {
        title: 'Goal',
        body_markdown: 'Original body',
        steps: [{ id: 'one', title: 'Original step' }],
      },
    };
    const created = await migrateOriginalToolCall(save, scope);
    expect(created.args).not.toHaveProperty('expectedVersion');
    expect(created.args).not.toHaveProperty('expectedPlanRef');
    expect(
      await migrateOriginalToolCall(
        { ...save, args: { ...save.args, plan_id: plan.planId, version: 2 } },
        scope,
        request,
      ),
    ).toMatchObject({ args: { expectedPlanRef: 'plan.original-host-reference' } });
    for (const change of [
      { version: 1 },
      { structural_digest: 'b'.repeat(64) },
      { plan_id: 'other-plan' },
    ])
      await expect(
        migrateOriginalToolCall({ ...submit, args: { ...submit.args, ...change } }, scope, request),
      ).rejects.toThrow('original_tool_plan_reference_unavailable');
    await expect(migrateOriginalToolCall(submit, scope)).rejects.toThrow(
      'original_tool_plan_reference_unavailable',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('workspace-bound mock emits migrated input while retaining original queue and real Tool result contracts', async () => {
  const { root, scope } = await ownedFixture();
  const server = createMockModelServer();
  try {
    server.bindWorkspace(scope);
    server.setResponses([
      {
        message: {
          tool_calls: [{ id: 'same-id', name: 'read_file', args: { path: 'sample.txt' } }],
        },
      },
      {
        expectedRequest: {
          toolResults: [{ toolCallId: 'same-id', contentIncludes: ['REAL_RESULT'] }],
        },
        message: { content: 'after real tool' },
      },
    ]);
    const first = await fetch(`${server.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [], stream: false }),
    });
    const body = await first.json();
    expect(body.choices[0].message.tool_calls[0]).toMatchObject({
      id: 'same-id',
      function: { name: 'read_file', arguments: JSON.stringify({ path: 'sample.txt' }) },
    });
    expect(server.getToolContractMigrations()).toEqual([
      {
        original: { id: 'same-id', name: 'read_file', args: { path: 'sample.txt' } },
        emitted: { id: 'same-id', name: 'read_file', args: { path: 'sample.txt' } },
      },
    ]);
    const second = await fetch(`${server.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'tool', tool_call_id: 'same-id', content: 'REAL_RESULT' }],
        stream: false,
      }),
    });
    expect(second.status).toBe(200);
    expect(server.getRequestCount()).toBe(2);
    expect(() => server.assertComplete()).not.toThrow();
    expect(() => server.bindWorkspace(scope)).toThrow();
  } finally {
    server.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('new planning identity is decoded without inventing legacy outcome text', () => {
  expect(
    parseDraftSavedPlan(JSON.stringify({ planId: 'original', version: 3, digest: 'a'.repeat(64) })),
  ).toEqual({ plan_id: 'original', version: 3, structural_digest: 'a'.repeat(64) });
  expect(() => parseDraftSavedPlan(JSON.stringify({ accepted: true }))).toThrow();
});

test('automatic title requests remain visible without consuming ordinary work responses', async () => {
  const server = createMockModelServer();
  server.setResponses([{ message: { content: 'ORIGINAL_WORK_RESULT' } }]);
  const invoke = (messages: Array<{ role: string; content: string }>) =>
    fetch(`${server.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages, tools: [], stream: false }),
    });
  try {
    const title = await invoke([
      { role: 'system', content: sessionTitleInstructions },
      { role: 'user', content: 'Original topic' },
    ]);
    expect(title.status).toBe(200);
    expect((await title.json()).choices[0].message.content).toBe('测试会话');
    expect(server.getRequestCount()).toBe(1);
    expect(server.getWorkRequestCount()).toBe(0);
    const work = await invoke([{ role: 'user', content: 'Original work' }]);
    expect((await work.json()).choices[0].message.content).toBe('ORIGINAL_WORK_RESULT');
    expect(server.getRequestCount()).toBe(2);
    expect(server.getRequests()).toHaveLength(2);
    expect(server.getWorkRequests()).toHaveLength(1);
    expect(server.hasRequestMessage('Original work', 0, 'work')).toBe(true);
    expect(() => server.assertComplete()).not.toThrow();
  } finally {
    server.stop();
  }
});

test('MCP fixture keeps the full original definition across an unambiguous SDK wire name and rejects ambiguous aliases', async () => {
  const { root, scope } = await ownedFixture();
  const serverId = 'a'.repeat(64),
    remoteName = 'remote echo';
  const definition = `mcp.${serverId}.${createHash('sha256').update(JSON.stringify(remoteName)).digest('hex').slice(0, 32)}`;
  const wire = definition.replace(/\./g, '_').slice(0, 64);
  const call = {
    id: 'original-call',
    name: `mcp__closed__${remoteName}`,
    args: { text: 'original' },
  };
  const request = {
    body: { tools: [{ type: 'function', function: { name: wire } }] },
    messages: [
      {
        role: 'user',
        content: JSON.stringify({
          source: 'mcp_selected_connection_refs',
          connections: [
            {
              serverId,
              serverName: 'closed',
              connectionKey: 'original-connection',
              configDigest: 'original-digest',
              generation: 1,
            },
          ],
        }),
      },
    ],
  };
  try {
    expect(await migrateOriginalToolCall(call, scope, request)).toEqual({
      ...call,
      name: definition,
    });
    await expect(
      migrateOriginalToolCall(call, scope, { ...request, messages: [] }),
    ).rejects.toThrow('original_mcp_tool_source_unavailable');
    request.body.tools.push({ type: 'function', function: { name: `${wire.slice(0, 62)}_1` } });
    await expect(migrateOriginalToolCall(call, scope, request)).rejects.toThrow(
      'original_mcp_tool_source_unavailable',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
