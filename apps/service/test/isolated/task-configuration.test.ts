import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import type { Json } from '@kite-ai/agent/extensions';
import { taskToolCapability } from '@kite-ai/agent/permissions';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { privateDirectory } from '../../../../tests/fixtures/test-filesystem';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { createPermissionManagement } from '../../src/permission-management';
import { createTaskConfiguration } from '../../src/task-configuration';

async function until<T>(read: () => Promise<T | undefined>) {
  const end = Date.now() + 7000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error('task_configuration_deadline');
    await Bun.sleep(5);
  }
}
function endpoint(role = 'worker') {
  const requests: Record<string, unknown>[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Record<string, unknown>;
      requests.push(body);
      const messages = body.messages as { role: string; content: string | null }[];
      const parent =
        body.model === 'parent' &&
        messages.some(
          (message) =>
            message.role === 'user' && ['work', 'New task: second'].includes(message.content ?? ''),
        );
      const cut = parent
        ? messages.reduce(
            (found, message, at) =>
              message.role === 'user' &&
              ['work', 'New task: second'].includes(message.content ?? '')
                ? at
                : found,
            -1,
          )
        : -1;
      const results = messages.slice(cut + 1).filter((message) => message.role === 'tool');
      const names =
        (body.tools as { function: { name: string } }[] | undefined)?.map(
          (tool) => tool.function.name,
        ) ?? [];
      let call: { name: string; input: Json } | undefined;
      if (parent && names.includes('spawn_agent')) {
        let agentId: string | undefined;
        try {
          agentId = JSON.parse(results[0]?.content ?? '{}').agent_id;
        } catch {
          /* Prior rejection. */
        }
        const calls: { name: string; input: Json }[] = [
          {
            name: 'spawn_agent',
            input: {
              prompt: 'read full actual input',
              ...(role === 'worker' ? {} : { preset: role }),
            },
          },
          { name: 'wait_agent_events', input: { wait_ms: 4000 } },
          { name: 'list_agents', input: agentId ? { agent_ids: [agentId] } : {} },
        ];
        call = calls[results.length];
      } else if (!parent && !results.length)
        call = { name: 'read_file', input: { path: 'input.txt' } };
      const chunk = (delta: unknown, reason: string | null) =>
        `data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
      return new Response(
        chunk(
          call
            ? {
                tool_calls: [
                  {
                    index: 0,
                    id: `call-${requests.length}`,
                    type: 'function',
                    function: { name: call.name, arguments: JSON.stringify(call.input) },
                  },
                ],
              }
            : { content: 'actual task response' },
          null,
        ) +
          chunk({}, call ? 'tool_calls' : 'stop') +
          'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  return {
    requests,
    baseURL: `http://127.0.0.1:${server.port}/v1`,
    close: () => server.stop(true),
  };
}
async function fixture(
  options: {
    roles?: boolean;
    mode?: 'full' | 'accept_edits';
    deny?: 'task' | 'carrier';
    defaultRole?: 'plan' | 'review';
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'kite-default-task-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'input.txt'), 'actual complete private input');
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'new' });
  privateDirectory(profile.profilePath);
  const a = endpoint(options.defaultRole),
    b = endpoint();
  const configurationPath = join(profile.profilePath, 'config.jsonc');
  const configuration = {
    modelId: 'parent',
    models: [
      { id: 'parent', provider: 'compatible', model: 'parent', baseURL: a.baseURL },
      { id: 'child', provider: 'compatible', model: 'child-v1', baseURL: a.baseURL },
    ],
    tools: [
      'task.spawn',
      'task.list',
      'task.events',
      'task.interrupt',
      'files.read',
      ...(options.defaultRole ? ['files.write'] : []),
    ].map((id) => ({
      id,
      definitionVersion: id === 'files.read' ? '4' : id === 'files.write' ? '2' : '1',
    })),
  };
  writeFileSync(configurationPath, JSON.stringify(configuration));
  let roleVersion = '1';
  function host() {
    return createDefaultProcessConfiguration({
      userConfigurationPath: profile.profilePath + '/config.jsonc',
      profile,
      child:
        options.roles === false
          ? []
          : options.defaultRole
            ? undefined
            : [{ id: 'worker', version: roleVersion, modelId: 'child', toolIds: ['files.read'] }],
      permissionPolicy: {
        readPolicy: () => ({
          mode: options.mode ?? 'full',
          workspaceTrust: true,
          revision: 'trusted-task-host',
          allowed: [
            { kind: 'model' as const, definitionId: 'parent', definitionVersion: '1' },
            { kind: 'model' as const, definitionId: 'child', definitionVersion: '1' },
            { kind: 'tool' as const, definitionId: 'files.read', definitionVersion: '4' },
            ...['task.spawn', 'task.list', 'task.events', 'task.interrupt']
              .filter((id) => id !== (options.deny === 'task' ? 'task.spawn' : options.deny))
              .map((id) => ({ kind: 'tool' as const, definitionId: id, definitionVersion: '1' })),
            ...(options.deny === 'carrier'
              ? []
              : [
                  {
                    kind: 'job' as const,
                    definitionId: `agent/${options.defaultRole ?? 'worker'}`,
                    definitionVersion: roleVersion,
                  },
                ]),
          ],
        }),
      },
    });
  }
  let store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
  let current = host();
  let runtime = createRuntime({
    ...current,
    store,
    permissions: current.permissions!,
    modelConcurrency: 1,
  });
  current.permissionManagement?.(runtime);
  const expectedStoreId = (await store.getMetadata()).storeId;
  const base = { expectedStoreId, sessionId: 's', subjectId: 'user' };
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'private',
    rootUri: pathToFileURL(workspace).href,
  });
  await runtime.createSession({ ...base, commandId: 'create', workspaceId: 'w', title: 'task' });
  const control = createPermissionManagement({ runtime, profile });
  const activeMode = await control.readMode(base);
  await control.setMode({
    ...base,
    commandId: 'fixture-live-mode',
    mode: options.mode ?? 'full',
    makeDefault: false,
    ifRevision: activeMode.revision,
    ifDefaultRevision: activeMode.defaultRevision,
  });
  return {
    get runtime() {
      return runtime;
    },
    get store() {
      return store;
    },
    configurationPath,
    configuration,
    a,
    b,
    workspace,
    base,
    submit: (id = 'work', content = id) =>
      runtime.submitCommand({
        ...base,
        commandId: id,
        request: { kind: 'run.start', content },
      }),
    done: (id = 'work') => runtime.waitForCommand(id, { timeoutMs: 7000 }),
    async approve(definitionId: string, commandId: string) {
      const card = await until(async () =>
        (
          await store.listInteractions({ expectedStoreId, sessionId: 's', state: 'pending' })
        ).interactions.find((row) => row.definitionId === definitionId),
      );
      await runtime.answerInteraction({
        ...base,
        presentationSessionId: 's',
        commandId,
        interactionId: card.id,
        expectedRevision: card.revision,
        answer: { kind: 'approval', decision: 'approve' },
      });
      return card;
    },
    async reopen(version: string) {
      await runtime.close();
      roleVersion = version;
      store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
      current = host();
      runtime = createRuntime({
        ...current,
        store,
        permissions: current.permissions!,
        modelConcurrency: 1,
      });
      current.permissionManagement?.(runtime);
    },
    async close() {
      await runtime.close();
      a.close();
      b.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('default Task uses one global factory and the actual shared Loop/model slot; exact record/read/wait facts do not replay a child', async () => {
  const f = await fixture();
  try {
    expect(
      f.runtime.getExtensionCatalogue().filter((row) => row.extensionId === 'builtin.task'),
    ).toHaveLength(1);
    await f.submit();
    const command = await f.done();
    expect(command.status).toBe('applied');
    await until(async () => {
      const child = (await f.store.listExecutions('s')).find((row) => row.childSessionId !== null);
      return child?.status === 'succeeded' ? child : undefined;
    });
    const children = (await f.store.listExecutions('s')).filter(
      (row) => row.childSessionId !== null,
    );
    expect(children).toHaveLength(1);
    expect(children[0]!.definitionVersion).toBe('1');
    expect(children[0]!.status).toBe('succeeded');
    const directory = await f.store.listStableAgents({
      expectedStoreId: f.base.expectedStoreId,
      sessionId: 's',
      extensionId: 'builtin.task',
      subjectId: f.base.subjectId,
    });
    expect(directory.items).toHaveLength(1);
    expect(directory.items[0]).toMatchObject({
      agentId: children[0]!.childSessionId,
      assignmentSource: { content: 'read full actual input' },
      ref: { executionId: children[0]!.id },
    });
    expect(
      (await f.store.listExecutions(children[0]!.childSessionId!)).filter(
        (row) => row.definitionId === 'files.read',
      ),
    ).toHaveLength(1);
    const operations = await f.store.listExecutions('s');
    expect(operations.filter((row) => row.definitionId === 'task.spawn')).toHaveLength(1);
    expect(operations.find((row) => row.definitionId === 'task.events')?.status).toBe('succeeded');
    expect(operations.find((row) => row.definitionId === 'task.list')?.status).toBe('succeeded');
    const first = f.a.requests[0]!.tools as { function: { name: string } }[];
    expect(first.filter((tool) => tool.function.name === 'spawn_agent')).toHaveLength(1);
    const calls = f.a.requests.length;
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    await f.store.getView('s');
    await f.store.getView(children[0]!.childSessionId!);
    expect(await f.submit()).toEqual(command);
    expect(f.a.requests).toHaveLength(calls);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect(readFileSync(join(f.workspace, 'input.txt'), 'utf8')).toBe(
      'actual complete private input',
    );
    expect((await f.store.getView('s')).runs[0]!.configuration).toMatchObject({
      snapshot: {
        task: {
          available: true,
          roles: [{ id: 'worker', configurationId: 'worker', configurationVersion: '1' }],
        },
      },
    });
  } finally {
    await f.close();
  }
}, 15000);

test('Task Tool approval does not authorize its exact child carrier Job; both ordinary cards retain real effects and once-only dispatch', async () => {
  const f = await fixture({ mode: 'accept_edits' });
  try {
    await f.submit();
    const tool = await f.approve('task.spawn', 'approve-tool');
    expect(tool.request).toMatchObject({ policy: { effects: ['unknown', 'record_write'] } });
    expect(f.a.requests.filter((row) => row.model !== 'parent')).toHaveLength(0);
    const carrier = await f.approve('agent/worker', 'approve-carrier');
    expect(carrier.executionId).not.toBe(tool.executionId);
    expect(carrier.request).toMatchObject({ policy: { effects: ['unknown'] } });
    await f.done();
    expect(
      (await f.store.listExecutions('s')).filter(
        (row) => row.childSessionId !== null && row.status === 'succeeded',
      ),
    ).toHaveLength(1);
    expect(
      (
        await f.store.listInteractions({ expectedStoreId: f.base.expectedStoreId, sessionId: 's' })
      ).interactions.filter((row) => row.kind === 'approval'),
    ).toHaveLength(2);
  } finally {
    await f.close();
  }
}, 15000);

test('current parent policy can deny Task or its carrier without any child Provider effect', async () => {
  for (const deny of ['task', 'carrier'] as const) {
    const f = await fixture({ deny });
    try {
      await f.submit();
      await f.done();
      expect(f.a.requests.filter((row) => row.model !== 'parent')).toHaveLength(0);
      expect(
        (await f.store.listExecutions('s')).filter(
          (row) => row.childSessionId !== null && row.status === 'succeeded',
        ),
      ).toHaveLength(0);
    } finally {
      await f.close();
    }
  }
}, 15000);

test('JSONC cannot invent roles or Tool versions; no-role Task selection rejects locally before any Model Provider', async () => {
  const noRole = await fixture({ roles: false });
  try {
    writeFileSync(
      noRole.configurationPath,
      JSON.stringify({
        ...noRole.configuration,
        child: [{ id: 'worker', version: '1', permissions: 'full' }],
      }),
    );
    await noRole.submit();
    const command = await noRole.done();
    expect(command.status).toBe('rejected');
    expect(command.receipt).toMatchObject({ reason: 'task_role_unavailable' });
    expect(noRole.a.requests).toHaveLength(0);
  } finally {
    await noRole.close();
  }
  const version = await fixture();
  try {
    writeFileSync(
      version.configurationPath,
      JSON.stringify({
        ...version.configuration,
        tools: [{ id: 'task.spawn', definitionVersion: 'wrong' }],
      }),
    );
    await version.submit();
    const command = await version.done();
    expect(command.status).toBe('rejected');
    expect(command.receipt).toMatchObject({ reason: 'tool_definition_version_unavailable' });
    expect(version.a.requests).toHaveLength(0);
  } finally {
    await version.close();
  }
  expect(createTaskConfiguration([]).extension).toBeUndefined();
  for (const id of [
    'task.execute',
    'send_message',
    'followup_task',
    'list_agents',
    'interrupt_agent',
    'wait_agents',
    'wait_agent',
  ]) {
    expect(() => createTaskConfiguration([]).validateSelection([id])).toThrow(
      'task_role_unavailable',
    );
  }
  const task = createTaskConfiguration([{ id: 'worker', version: '1' }]);
  expect(task.snapshot.tools.map((row) => row.id).sort()).toEqual(
    [
      'task',
      'task.execute',
      'task_read',
      'task_wait',
      'task_cancel',
      'send_message',
      'followup_task',
      'list_agents',
      'interrupt_agent',
      'wait_agents',
      'wait_agent',
      'task.spawn',
      'task.message',
      'task.follow_up',
      'task.events',
      'task.list',
      'task.interrupt',
    ].sort(),
  );
  for (const id of ['list_agents', 'wait_agents', 'wait_agent']) {
    expect(taskToolCapability(id)).toEqual({ effects: ['read'], safeRead: true });
    expect(task.tools.get(id)?.version).toBe('1');
    expect(task.tools.get(id)?.inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
    });
  }
  expect(taskToolCapability('interrupt_agent')).toEqual({ effects: ['unknown'], safeRead: false });
  expect(task.tools.get('interrupt_agent')?.inputSchema).toMatchObject({
    required: ['taskId', 'targetRunId', 'commandId'],
    additionalProperties: false,
  });
  expect(taskToolCapability('send_message')).toEqual({
    effects: ['unknown', 'record_write'],
    safeRead: false,
  });
  expect(taskToolCapability('followup_task')).toEqual({
    effects: ['unknown', 'record_write'],
    safeRead: false,
  });
});

test('a new trusted role version and SDK route bind only new Run work; original Task record and child definition stay unchanged', async () => {
  const f = await fixture();
  try {
    await f.submit();
    await f.done();
    const old = (await f.store.listExecutions('s')).find((row) => row.childSessionId !== null)!;
    const originalDirectory = await f.store.listStableAgents({
      expectedStoreId: f.base.expectedStoreId,
      sessionId: 's',
      extensionId: 'builtin.task',
      subjectId: f.base.subjectId,
    });
    const originalAssignment = originalDirectory.items[0]!.assignmentSource;
    f.configuration.models[1]!.model = 'child-v2';
    f.configuration.models[1]!.baseURL = f.b.baseURL;
    writeFileSync(f.configurationPath, JSON.stringify(f.configuration));
    await f.reopen('2');
    await f.submit('second', 'New task: second');
    const command = await f.done('second');
    const receipt = command.receipt as { businessCommandId: string; runId: string };
    expect(command.status).toBe('applied');
    const run = (await f.store.getRun(receipt.runId))!;
    expect(run).toMatchObject({
      originCommandId: receipt.businessCommandId,
      rootWorkCommandId: command.id,
      status: 'completed',
    });
    const model = (await f.store.listExecutions('s')).find(
      (execution) => execution.kind === 'model' && execution.runId === run.id,
    );
    expect(model).toMatchObject({
      originCommandId: receipt.businessCommandId,
      rootWorkCommandId: command.id,
    });
    const next = (await f.store.listExecutions('s')).find(
      (row) => row.childSessionId !== null && row.id !== old.id,
    )!;
    expect(old.definitionVersion).toBe('1');
    expect(next.definitionVersion).toBe('2');
    expect(next.status).toBe('succeeded');
    expect(f.b.requests.every((row) => row.model === 'child-v2')).toBe(true);
    expect(f.b.requests.length).toBeGreaterThan(0);
    const afterDirectory = await f.store.listStableAgents({
      expectedStoreId: f.base.expectedStoreId,
      sessionId: 's',
      extensionId: 'builtin.task',
      subjectId: f.base.subjectId,
    });
    expect(afterDirectory.items[0]!.assignmentSource).toEqual(originalAssignment);
    expect(afterDirectory.items[0]!.ref.executionId).toBe(old.id);
    expect((await f.store.getView('s')).runs[1]!.configuration).toMatchObject({
      snapshot: { task: { roles: [{ id: 'worker', configurationVersion: '2' }] } },
    });
  } finally {
    await f.close();
  }
}, 15000);

test('selected collaboration additions expose exact closed schemas to the real SDK without extra child work', async () => {
  const f = await fixture();
  try {
    const ids = ['task.list', 'task.interrupt', 'task.events', 'task.message', 'task.follow_up'];
    writeFileSync(
      f.configurationPath,
      JSON.stringify({
        ...f.configuration,
        tools: [
          ...f.configuration.tools,
          ...ids
            .filter((id) => !f.configuration.tools.some((tool) => tool.id === id))
            .map((id) => ({ id, definitionVersion: '1' })),
        ],
      }),
    );
    await f.submit();
    await f.done();
    const tools = f.a.requests.find((request) => request.model === 'parent')!.tools as {
      function: { name: string; parameters: Record<string, unknown> };
    }[];
    for (const id of ids) {
      const actual = tools.find(
        (tool) =>
          tool.function.name ===
          (
            {
              'task.list': 'list_agents',
              'task.interrupt': 'interrupt_agent',
              'task.events': 'wait_agent_events',
              'task.message': 'send_agent_message',
              'task.follow_up': 'follow_up_agent',
            } as Record<string, string>
          )[id],
      );
      expect(actual).toBeDefined();
      expect(actual?.function.parameters).toMatchObject({
        type: 'object',
        additionalProperties: false,
      });
    }
    expect(
      tools.find((tool) => tool.function.name === 'interrupt_agent')?.function.parameters.required,
    ).toEqual(['agent_id']);
    expect(
      (await f.store.listExecutions('s')).filter((row) => row.childSessionId !== null),
    ).toHaveLength(1);
    expect(f.a.requests.filter((request) => request.model === 'child-v1')).toHaveLength(2);
  } finally {
    await f.close();
  }
}, 10000);

test('default plan and review run through the real Task carrier and expose only frozen parent-selected reads', async () => {
  for (const role of ['plan', 'review'] as const) {
    const f = await fixture({ defaultRole: role });
    try {
      await f.submit();
      expect((await f.done()).status).toBe('applied');
      const carrier = await until(async () =>
        (await f.store.listExecutions('s')).find(
          (row) => row.definitionId === `agent/${role}` && row.status === 'succeeded',
        ),
      );
      expect(carrier.childSessionId).toBeTruthy();
      expect(carrier.originStoreId).toBe(f.base.expectedStoreId);
      const parent = (await f.store.listExecutions('s')).find(
        (row) => row.id === carrier.parentExecutionId,
      )!;
      expect(parent.definitionId).toBe('task.spawn');
      expect(carrier.rootWorkCommandId).toBe(parent.rootWorkCommandId);
      expect(carrier.rootWorkSeq).toBe(parent.rootWorkSeq);
      const child = await f.store.getView(carrier.childSessionId!);
      expect(child.session.parentSessionId).toBe('s');
      expect(child.runs[0]!.configuration).toMatchObject({
        snapshot: { roleId: role, roleVersion: '1', roleToolIds: ['files.read'] },
        tools: [{ id: 'files.read', version: '4', extensionId: 'builtin.files' }],
      });
      const childRequests = f.a.requests.filter((request) =>
        (request.messages as { role: string; content: unknown }[]).some(
          (message) => message.role === 'user' && message.content === 'read full actual input',
        ),
      );
      expect(childRequests).toHaveLength(2);
      for (const request of childRequests) {
        expect(
          (request.tools as { function: { name: string } }[]).map((tool) => tool.function.name),
        ).toEqual(['read_file']);
      }
      const executions = await f.store.listExecutions(carrier.childSessionId!);
      expect(
        executions
          .filter((row) => row.kind === 'tool')
          .map((row) => [row.definitionId, row.status]),
      ).toEqual([['files.read', 'succeeded']]);
      const directory = await f.store.listStableAgents({
        expectedStoreId: f.base.expectedStoreId,
        sessionId: 's',
        extensionId: 'builtin.task',
        subjectId: f.base.subjectId,
      });
      expect(directory.items[0]).toMatchObject({
        agentId: carrier.childSessionId,
        assignmentSource: { content: 'read full actual input' },
        ref: { executionId: carrier.id },
      });
      expect(readFileSync(join(f.workspace, 'input.txt'), 'utf8')).toBe(
        'actual complete private input',
      );
    } finally {
      await f.close();
    }
  }
}, 15000);
