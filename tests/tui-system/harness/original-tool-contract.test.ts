import { expect, test } from 'bun:test';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Json, ToolContext } from '@kite-ai/agent/extensions';
import { createFileTools, createWorkspaceFiles } from '@kite-ai/agent/files';
import { createMockModelServer, parseDraftSavedPlan } from './fixtures';
import { migrateOriginalToolCall } from './original-tool-contract';

async function ownedFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kite-original-tools-')));
  return { root, scope: { workspace: root, home: root } };
}

test('original File calls preserve IDs and execute the real new read/write/edit/glob/search Tools', async () => {
  const { root, scope } = await ownedFixture();
  const files = createWorkspaceFiles({ root });
  const tools = new Map(createFileTools(files).map((tool) => [tool.id, tool]));
  const context = { signal: new AbortController().signal } as ToolContext;
  const execute = async (id: string, name: string, args: Record<string, unknown>) => {
    const migrated = await migrateOriginalToolCall({ id, name, args }, scope);
    expect(migrated.id).toBe(id);
    const tool = tools.get(migrated.name)!;
    expect(tool).toBeDefined();
    const result = await tool.execute(migrated.args as Json, context);
    expect(result.outcome).toBe('succeeded');
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
    expect((await execute('glob', 'glob', { pattern: '*.txt' })).paths).toEqual(['sample.txt']);
    expect((await execute('grep', 'grep', { pattern: 'beta' })).matches[0].content).toBe('beta');
    // Freshness is enforced by the real new Tool, not softened by the fixture.
    const stale = await migrateOriginalToolCall(
      { id: 'stale', name: 'write_file', args: { path: 'sample.txt', content: 'wrong' } },
      scope,
    );
    await writeFile(join(root, 'sample.txt'), 'new actual bytes');
    const result = await tools.get(stale.name)!.execute(stale.args as Json, context);
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
    expect(
      await migrateOriginalToolCall(
        {
          id: 'child-id',
          name: 'task',
          args: { name: 'child', subagent_type: 'explore', task: 'original input' },
        },
        scope,
      ),
    ).toMatchObject({
      id: 'child-id',
      name: 'task.execute',
      args: { role: 'explore', input: { name: 'child', content: 'original input' } },
    });
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
      function: { name: 'files.read', arguments: JSON.stringify({ path: 'sample.txt' }) },
    });
    expect(server.getToolContractMigrations()).toEqual([
      {
        original: { id: 'same-id', name: 'read_file', args: { path: 'sample.txt' } },
        emitted: { id: 'same-id', name: 'files.read', args: { path: 'sample.txt' } },
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
