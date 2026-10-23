import { expect, test } from 'bun:test';
import { AgentError } from '@kite-ai/agent';
import { createChildConfiguration } from '../../src/child-configuration';
import { createTaskConfiguration, defaultTaskRoles } from '../../src/task-configuration';

const model = {
  stream() {
    throw new Error('must_not_request_provider');
  },
};
function input(role: string, tools: string[]) {
  const actualTools = tools.map((id) => ({
    id,
    version:
      id === 'files.read'
        ? '4'
        : id === 'files.search'
          ? '4'
          : ['files.read_path', 'files.glob'].includes(id)
            ? '2'
            : '1',
    extensionId: id.endsWith('_path')
      ? 'builtin.files.path'
      : id.startsWith('files.')
        ? 'builtin.files'
        : id.startsWith('shell.')
          ? 'builtin.shell'
          : id.startsWith('planning.')
            ? 'builtin.planning'
            : 'fixture',
  }));
  return {
    configurationId: role,
    signal: new AbortController().signal,
    parentTools: actualTools,
    parentRun: { configuration: { modelId: 'actual-parent', tools: actualTools } },
  } as unknown as Parameters<
    NonNullable<ReturnType<typeof createChildConfiguration>['resolveChildRunConfiguration']>
  >[0];
}

test('default Task roles preserve worker and bind implementation plus three read-only roles to actual parent definitions', async () => {
  expect(defaultTaskRoles.map((role) => role.id)).toEqual([
    'worker',
    'code',
    'explore',
    'plan',
    'review',
  ]);
  const task = createTaskConfiguration(defaultTaskRoles);
  expect(task.snapshot.roles.map((role) => role.id)).toEqual([
    'worker',
    'code',
    'explore',
    'plan',
    'review',
  ]);
  for (const id of ['task', 'task.execute']) {
    const tool = task.tools.get(id)!;
    const schema = tool.inputSchema as {
      properties: { role: { enum: string[]; description: string } };
    };
    expect(schema.properties.role.enum).toEqual(['worker', 'code', 'explore', 'plan', 'review']);
    expect(schema.properties.role.description).toContain('plan: Read-only planning');
    expect(schema.properties.role.description).toContain('review: Read-only code review');
    expect(tool.description).toContain('implementation');
    expect(tool.description).toContain('multiple independent sibling task calls');
  }
  const spawn = task.tools.get('task.spawn')!;
  expect(spawn.description).toContain('Default role worker: General delegated work');
  expect(spawn.inputSchema).toMatchObject({
    properties: {
      preset: {
        enum: ['code', 'explore', 'plan', 'review'],
        description: expect.stringContaining('No modifications or process/network dispatch'),
      },
    },
  });
  const configured = createChildConfiguration({
    roles: defaultTaskRoles,
    async resolve(_input, selection) {
      return { model, snapshot: null, modelId: selection.modelId, toolIds: selection.role.toolIds };
    },
  });
  const parent = [
    'files.read',
    'files.read_path',
    'files.search',
    'files.write',
    'shell.launch',
    'shell.stop',
    'shell.read',
    'mcp.unreviewed',
    'planning.update',
  ];
  for (const role of ['worker', 'code']) {
    const result = await configured.resolveChildRunConfiguration!(input(role, parent));
    expect(result.modelId).toBe('actual-parent');
    expect(result.toolIds).toEqual(parent);
  }
  for (const role of ['explore', 'plan', 'review']) {
    const readonly = await configured.resolveChildRunConfiguration!(input(role, parent));
    expect(readonly.toolIds).toEqual([
      'files.read',
      'files.read_path',
      'files.search',
      'shell.read',
    ]);
    expect(readonly.modelId).toBe('actual-parent');
  }
  expect(configured.childConfigurations![2]!.inputSchema).toMatchObject({
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 120 },
      content: { type: 'string' },
    },
  });
});

test('default children exclude the exact root clarification tool while retaining qualified parent planning reads', async () => {
  const configured = createChildConfiguration({
    roles: defaultTaskRoles,
    async resolve(_input, selection) {
      return { model, snapshot: null, modelId: selection.modelId, toolIds: selection.role.toolIds };
    },
  });
  for (const role of ['worker', 'code', 'explore', 'plan', 'review']) {
    const request = input(role, ['ask_user', 'planning.read', 'files.read', 'shell.launch']);
    const tools = (request.parentRun!.configuration as { tools: { extensionId: string }[] }).tools;
    tools[0]!.extensionId = 'builtin.ask-user';
    const result = await configured.resolveChildRunConfiguration!(request);
    expect(result.toolIds).not.toContain('ask_user');
    expect(result.toolIds).toContain('planning.read');
    expect(result.toolIds).toContain('files.read');
    expect(result.toolIds?.includes('shell.launch')).toBe(role === 'worker' || role === 'code');
  }
});

test('default role binding fails closed on missing parent facts and mutable/unknown child additions', async () => {
  let preparations = 0,
    disposals = 0;
  const configured = createChildConfiguration({
    roles: defaultTaskRoles,
    async resolve(_input, selection) {
      preparations++;
      return {
        model,
        snapshot: null,
        modelId: selection.modelId,
        toolIds: [...selection.role.toolIds!, 'files.write'],
        async dispose() {
          disposals++;
        },
      };
    },
  });
  await expect(
    configured.resolveChildRunConfiguration!({ ...input('explore', []), parentRun: null }),
  ).rejects.toBeInstanceOf(AgentError);
  expect(preparations).toBe(0);
  await expect(
    configured.resolveChildRunConfiguration!(input('explore', ['files.read', 'files.write'])),
  ).rejects.toMatchObject({ code: 'child_tool_binding_mismatch' });
  expect(disposals).toBe(1);
  const unknown = createChildConfiguration({
    roles: defaultTaskRoles,
    async resolve(_input, selection) {
      return { model, snapshot: null, modelId: selection.modelId, toolIds: ['mcp.invented'] };
    },
  });
  await expect(
    unknown.resolveChildRunConfiguration!(input('code', ['files.read'])),
  ).rejects.toMatchObject({ code: 'child_tool_binding_mismatch' });
});

test('all read-only roles reject unknown owners, future versions and prepared mutation additions', async () => {
  for (const role of ['explore', 'plan', 'review']) {
    const configured = createChildConfiguration({
      roles: defaultTaskRoles,
      async resolve(_input, selection) {
        return {
          model,
          snapshot: null,
          modelId: selection.modelId,
          toolIds: selection.role.toolIds,
        };
      },
    });
    const request = input(role, [
      'files.read',
      'files.list',
      'files.write',
      'planning.update',
      'shell.launch',
    ]);
    const tools = request.parentRun!.configuration as {
      tools: { id: string; version: string; extensionId: string }[];
    };
    tools.tools[0]!.extensionId = 'custom.same-name';
    tools.tools[1]!.version = 'future';
    const result = await configured.resolveChildRunConfiguration!(request);
    expect(result.toolIds).toEqual([]);
    const oldSearch = input(role, ['files.search']);
    expect(
      (
        await configured.resolveChildRunConfiguration!({
          ...oldSearch,
          parentTools: oldSearch.parentTools!.map((tool) => ({ ...tool, version: '2' })),
        })
      ).toolIds,
    ).toEqual([]);
    let disposed = 0;
    const escalated = createChildConfiguration({
      roles: defaultTaskRoles,
      async resolve(_input, selection) {
        return {
          model,
          snapshot: null,
          modelId: selection.modelId,
          toolIds: [...selection.role.toolIds!, 'files.write'],
          async dispose() {
            disposed++;
          },
        };
      },
    });
    await expect(
      escalated.resolveChildRunConfiguration!(input(role, ['files.read', 'files.write'])),
    ).rejects.toMatchObject({ code: 'child_tool_binding_mismatch' });
    expect(disposed).toBe(1);
  }
});
