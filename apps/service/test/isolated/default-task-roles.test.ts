import { AgentError } from '@kite-ai/agent';
import type { ToolContext } from '@kite-ai/agent/extensions';
import { createFileTools, type WorkspaceFiles } from '@kite-ai/agent/files';
import { expect, test } from '#kite-test';
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
      id === 'files.read' ? '4' : id === 'files.search' ? '4' : id === 'files.glob' ? '2' : '1',
    extensionId: id.endsWith('_path')
      ? 'builtin.files.path'
      : id.startsWith('files.')
        ? 'builtin.files'
        : id.startsWith('shell.')
          ? 'builtin.shell'
          : id.startsWith('planning.')
            ? 'builtin.planning'
            : id.startsWith('task.')
              ? 'builtin.task'
              : id === 'execution_evidence.read'
                ? 'builtin.execution-evidence'
                : id === 'web_fetch'
                  ? 'builtin.web'
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

test('default general and explore bind only actual parent definitions', async () => {
  expect(defaultTaskRoles.map((role) => role.id)).toEqual(['general', 'explore']);
  const task = createTaskConfiguration(defaultTaskRoles);
  expect(task.snapshot.roles.map((role) => role.id)).toEqual(['general', 'explore']);
  expect([...task.tools.keys()].sort()).toEqual([
    'task.events',
    'task.follow_up',
    'task.interrupt',
    'task.list',
    'task.message',
    'task.spawn',
  ]);
  const spawn = task.tools.get('task.spawn')!;
  expect(spawn.description).toContain('Default role general: General delegated work');
  expect(spawn.inputSchema).toMatchObject({
    properties: {
      preset: {
        enum: ['general', 'explore'],
        description: expect.stringContaining('Shell uses the inherited permissions and sandbox'),
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
    'files.search',
    'files.write',
    'shell.launch',
    'shell.stop',
    'shell.read',
    'mcp.unreviewed',
    'planning.update',
  ];
  for (const role of ['general']) {
    const result = await configured.resolveChildRunConfiguration!(input(role, parent));
    expect(result.modelId).toBe('actual-parent');
    expect(result.toolIds).toEqual(parent);
  }
  for (const role of ['explore']) {
    const readonly = await configured.resolveChildRunConfiguration!(input(role, parent));
    expect(readonly.toolIds).toEqual(['files.read', 'shell.launch', 'shell.stop', 'shell.read']);
    expect(readonly.modelId).toBe('actual-parent');
  }
  expect(configured.childConfigurations![1]!.inputSchema).toMatchObject({
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
  for (const role of ['general', 'explore']) {
    const request = input(role, ['ask_user', 'planning.read', 'files.read', 'shell.launch']);
    const tools = (request.parentRun!.configuration as { tools: { extensionId: string }[] }).tools;
    tools[0]!.extensionId = 'builtin.ask-user';
    const result = await configured.resolveChildRunConfiguration!(request);
    expect(result.toolIds).not.toContain('ask_user');
    expect(result.toolIds).toContain('planning.read');
    expect(result.toolIds).toContain('files.read');
    expect(result.toolIds).toContain('shell.launch');
  }
});

test('public spawn presets retain current builtin file discovery definitions and reject untrusted bindings', async () => {
  // Construction is pure: use the actual definitions without performing file IO.
  const current = createFileTools({} as WorkspaceFiles).map(({ id, version }) => ({
    extensionId: 'builtin.files',
    id,
    version,
  }));
  const spawn = createTaskConfiguration(defaultTaskRoles).tools.get('task.spawn')!;
  const configured = createChildConfiguration({
    roles: defaultTaskRoles,
    async resolve(_input, selection) {
      return { model, snapshot: null, modelId: selection.modelId, toolIds: selection.role.toolIds };
    },
  });
  for (const role of ['explore']) {
    let selected: string | undefined;
    const result = await spawn.execute({ prompt: 'Inspect the current files.', preset: role }, {
      executionId: `spawn-${role}`,
      operations: {
        async ensure({ request }) {
          if (request.kind !== 'agent') throw new Error('expected_agent_request');
          selected = request.configurationId;
          return { childSessionId: `child-${role}` };
        },
      },
    } as ToolContext);
    expect(result.outcome).toBe('succeeded');
    expect(selected).toBe(role);
    const request = input(selected!, []);
    const resolve = (parentTools: typeof current) =>
      configured.resolveChildRunConfiguration!({
        ...request,
        parentTools,
        parentRun: {
          ...request.parentRun!,
          configuration: { modelId: 'actual-parent', tools: parentTools },
        },
      });
    expect((await resolve(current)).toolIds).toEqual(['files.read']);
    expect(
      (await resolve(current.map((tool) => ({ ...tool, extensionId: 'custom.same-name' }))))
        .toolIds,
    ).toEqual([]);
    expect(
      (await resolve(current.map((tool) => ({ ...tool, version: 'future' })))).toolIds,
    ).toEqual([]);
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
    unknown.resolveChildRunConfiguration!(input('general', ['files.read'])),
  ).rejects.toMatchObject({ code: 'child_tool_binding_mismatch' });
});

test('explore rejects unknown owners, future versions and prepared mutation additions', async () => {
  for (const role of ['explore']) {
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
    tools.tools[4]!.version = 'future';
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

test('general is both the omitted default and an explicit preset while removed presets never start work', async () => {
  const task = createTaskConfiguration([...defaultTaskRoles].reverse());
  const spawn = task.tools.get('task.spawn')!;
  const selected: string[] = [];
  const context = {
    executionId: 'select-role',
    operations: {
      async ensure({ request }) {
        if (request.kind !== 'agent') throw new Error('expected_agent_request');
        selected.push(request.configurationId);
        return { childSessionId: `child-${selected.length}` };
      },
    },
  } as ToolContext;
  for (const preset of [undefined, 'general', 'explore']) {
    expect(
      (
        await spawn.execute(
          { prompt: 'Inspect this task.', ...(preset ? { preset } : {}) },
          context,
        )
      ).outcome,
    ).toBe('succeeded');
  }
  expect(selected).toEqual(['general', 'general', 'explore']);
  for (const preset of ['worker', 'code', 'plan', 'review']) {
    expect(await spawn.execute({ prompt: 'Do not start this.', preset }, context)).toMatchObject({
      outcome: 'failed',
      details: { accepted: false, error: { code: 'invalid_request' } },
    });
  }
  expect(selected).toHaveLength(3);
});

test('explore retains parent-selected communication, cancellation, evidence and Web with exact builtin identities', async () => {
  const configured = createChildConfiguration({
    roles: defaultTaskRoles,
    async resolve(_input, selection) {
      expect(selection.inheritDynamicMcp).toBe(false);
      return { model, snapshot: null, modelId: selection.modelId, toolIds: selection.role.toolIds };
    },
  });
  const retained = ['task.message', 'shell.stop', 'execution_evidence.read', 'web_fetch'];
  const request = input('explore', [
    ...retained,
    'task.events',
    'task.spawn',
    'task.list',
    'task.follow_up',
    'task.interrupt',
    'files.write',
    'mcp.unreviewed',
  ]);
  expect((await configured.resolveChildRunConfiguration!(request)).toolIds).toEqual(retained);
  expect((await configured.resolveChildRunConfiguration!(input('explore', []))).toolIds).toEqual(
    [],
  );
  for (const override of [{ extensionId: 'custom.same-name' }, { version: 'future' }]) {
    const parentTools = request.parentTools!.map((tool) => ({ ...tool, ...override }));
    expect(
      (await configured.resolveChildRunConfiguration!({ ...request, parentTools })).toolIds,
    ).toEqual([]);
  }
});

test('trusted custom roles retain their declaration order, explicit default and preset selection', async () => {
  const declarations = [
    { id: 'custom-first', version: '1' },
    { id: 'custom-second', version: '1' },
  ];
  const task = createTaskConfiguration(declarations);
  const spawn = task.tools.get('task.spawn')!;
  expect(spawn.description).toContain('Default role custom-first:');
  expect(spawn.inputSchema).toMatchObject({
    properties: { preset: { enum: ['custom-first', 'custom-second'] } },
  });
  expect(Object.keys(task.snapshot)).toEqual(['available', 'roles', 'tools']);
  expect(task.snapshot.roles).toEqual(
    declarations.map(({ id, version }) => ({
      id,
      configurationId: id,
      configurationVersion: version,
    })),
  );
  const explicit = createTaskConfiguration(declarations, {
    defaultRole: 'custom-second',
    presets: ['custom-second'],
  });
  const explicitSpawn = explicit.tools.get('task.spawn')!;
  expect(explicitSpawn.description).toContain('Default role custom-second:');
  expect(explicitSpawn.inputSchema).toMatchObject({
    properties: { preset: { enum: ['custom-second'] } },
  });
  const selected: string[] = [];
  const context = {
    executionId: 'trusted-explicit-custom',
    operations: {
      async ensure({ request }) {
        if (request.kind !== 'agent') throw Error('expected_agent_request');
        selected.push(request.configurationId);
        return { childSessionId: 'trusted-custom' };
      },
    },
  } as ToolContext;
  expect(
    (await explicitSpawn.execute({ prompt: 'Complete the assigned work.' }, context)).outcome,
  ).toBe('succeeded');
  expect(
    await explicitSpawn.execute(
      { prompt: 'Do not accept an unselected preset.', preset: 'custom-first' },
      context,
    ),
  ).toMatchObject({ outcome: 'failed' });
  expect(selected).toEqual(['custom-second']);
  expect(createTaskConfiguration([]).snapshot).toEqual({ available: false, roles: [], tools: [] });
});
