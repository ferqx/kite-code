import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import type { Json } from '@kite-ai/agent/extensions';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createDefaultProcessConfiguration } from '../../src/configuration';
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
function endpoint() {
  const requests: Record<string, unknown>[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Record<string, unknown>;
      requests.push(body);
      const messages = body.messages as { role: string; content: string | null }[];
      const parent = body.model === 'parent';
      const cut = parent
        ? messages.reduce(
            (found, message, at) =>
              message.role === 'user' && ['work', 'second'].includes(message.content ?? '')
                ? at
                : found,
            -1,
          )
        : -1;
      const results = messages.slice(cut + 1).filter((message) => message.role === 'tool');
      const key = parent && messages[cut]?.content === 'second' ? 'second' : 'work';
      const names =
        (body.tools as { function: { name: string } }[] | undefined)?.map(
          (tool) => tool.function.name,
        ) ?? [];
      let call: { name: string; input: Json } | undefined;
      if (parent && names.includes('task')) {
        const calls: { name: string; input: Json }[] = [
          {
            name: 'task',
            input: {
              key,
              role: 'worker',
              input: { content: 'read full actual input' },
              cancellation: 'detached',
            },
          },
          { name: 'task_wait', input: { taskId: key, timeoutMs: 4000 } },
          { name: 'task_read', input: { taskId: key } },
        ];
        call = calls[results.length];
      } else if (!parent && !results.length)
        call = { name: 'files.read', input: { path: 'input.txt' } };
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
  options: { roles?: boolean; mode?: 'full' | 'ask'; deny?: 'task' | 'carrier' } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'kite-default-task-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'input.txt'), 'actual complete private input');
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'new' });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  const a = endpoint(),
    b = endpoint();
  const configurationPath = join(profile.profilePath, 'config.jsonc');
  const configuration = {
    modelId: 'parent',
    models: [
      { id: 'parent', provider: 'compatible', model: 'parent', baseURL: a.baseURL },
      { id: 'child', provider: 'compatible', model: 'child-v1', baseURL: a.baseURL },
    ],
    tools: ['task', 'task_read', 'task_wait', 'task_cancel', 'files.read'].map((id) => ({
      id,
      definitionVersion: id === 'files.read' ? '3' : '1',
    })),
  };
  writeFileSync(configurationPath, JSON.stringify(configuration));
  let roleVersion = '1';
  function host() {
    return createDefaultProcessConfiguration({
      profile,
      child:
        options.roles === false
          ? []
          : [{ id: 'worker', version: roleVersion, modelId: 'child', toolIds: ['files.read'] }],
      permissionPolicy: {
        readPolicy: () => ({
          mode: options.mode ?? 'full',
          workspaceTrust: true,
          revision: 'trusted-task-host',
          allowed: [
            { kind: 'model' as const, definitionId: 'parent', definitionVersion: '1' },
            { kind: 'model' as const, definitionId: 'child', definitionVersion: '1' },
            { kind: 'tool' as const, definitionId: 'files.read', definitionVersion: '3' },
            ...['task', 'task_read', 'task_wait', 'task_cancel']
              .filter((id) => id !== options.deny)
              .map((id) => ({ kind: 'tool' as const, definitionId: id, definitionVersion: '1' })),
            ...(options.deny === 'carrier'
              ? []
              : [
                  {
                    kind: 'job' as const,
                    definitionId: 'agent/worker',
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
    rootUri: `file://${workspace}`,
  });
  await runtime.createSession({ ...base, commandId: 'create', workspaceId: 'w', title: 'task' });
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
    submit: (id = 'work') =>
      runtime.submitCommand({
        ...base,
        commandId: id,
        request: { kind: 'run.start', content: id },
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
    const record = await f.store.getExtensionRecord({
      sessionId: 's',
      extensionId: 'builtin.task',
      key: 'task/work',
    });
    expect(record?.value).toMatchObject({
      role: 'worker',
      ref: {
        childSessionId: children[0]!.childSessionId,
        executionId: children[0]!.id,
        originStoreId: f.base.expectedStoreId,
      },
    });
    expect(
      (await f.store.listExecutions(children[0]!.childSessionId!)).filter(
        (row) => row.definitionId === 'files.read',
      ),
    ).toHaveLength(1);
    const operations = await f.store.listExecutions('s');
    expect(operations.filter((row) => row.definitionId === 'task')).toHaveLength(1);
    expect(operations.find((row) => row.definitionId === 'task_wait')?.status).toBe('succeeded');
    expect(operations.find((row) => row.definitionId === 'task_read')?.status).toBe('succeeded');
    const first = f.a.requests[0]!.tools as { function: { name: string } }[];
    expect(first.filter((tool) => tool.function.name === 'task')).toHaveLength(1);
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
  const f = await fixture({ mode: 'ask' });
  try {
    await f.submit();
    const tool = await f.approve('task', 'approve-tool');
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
        tools: [{ id: 'task', definitionVersion: 'wrong' }],
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
      'task_read',
      'task_wait',
      'task_cancel',
      'send_message',
      'followup_task',
      'list_agents',
      'interrupt_agent',
      'wait_agents',
      'wait_agent',
    ].sort(),
  );
  for (const id of ['list_agents', 'wait_agents', 'wait_agent']) {
    expect(task.describe(id)).toEqual({ effects: ['read'], safeRead: true });
    expect(task.tools.get(id)?.version).toBe('1');
    expect(task.tools.get(id)?.inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
    });
  }
  expect(task.describe('interrupt_agent')).toEqual({ effects: ['unknown'], safeRead: false });
  expect(task.tools.get('interrupt_agent')?.inputSchema).toMatchObject({
    required: ['taskId', 'targetRunId', 'commandId'],
    additionalProperties: false,
  });
  expect(task.describe('send_message')).toEqual({
    effects: ['unknown', 'record_write'],
    safeRead: false,
  });
  expect(task.describe('followup_task')).toEqual({
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
    const record = await f.store.getExtensionRecord({
      sessionId: 's',
      extensionId: 'builtin.task',
      key: 'task/work',
    });
    f.configuration.models[1]!.model = 'child-v2';
    f.configuration.models[1]!.baseURL = f.b.baseURL;
    writeFileSync(f.configurationPath, JSON.stringify(f.configuration));
    await f.reopen('2');
    await f.submit('second');
    await f.done('second');
    const next = (await f.store.listExecutions('s')).find(
      (row) => row.childSessionId !== null && row.id !== old.id,
    )!;
    expect(old.definitionVersion).toBe('1');
    expect(next.definitionVersion).toBe('2');
    expect(next.status).toBe('succeeded');
    expect(f.b.requests.every((row) => row.model === 'child-v2')).toBe(true);
    expect(f.b.requests.length).toBeGreaterThan(0);
    expect(
      await f.store.getExtensionRecord({
        sessionId: 's',
        extensionId: 'builtin.task',
        key: 'task/work',
      }),
    ).toEqual(record);
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
    const ids = ['list_agents', 'interrupt_agent', 'wait_agents', 'wait_agent'];
    writeFileSync(
      f.configurationPath,
      JSON.stringify({
        ...f.configuration,
        tools: [...f.configuration.tools, ...ids.map((id) => ({ id, definitionVersion: '1' }))],
      }),
    );
    await f.submit();
    await f.done();
    const tools = f.a.requests.find((request) => request.model === 'parent')!.tools as {
      function: { name: string; parameters: Record<string, unknown> };
    }[];
    for (const id of ids) {
      const actual = tools.find((tool) => tool.function.name === id);
      expect(actual).toBeDefined();
      expect(actual?.function.parameters).toMatchObject({
        type: 'object',
        additionalProperties: false,
      });
    }
    expect(
      tools.find((tool) => tool.function.name === 'interrupt_agent')?.function.parameters.required,
    ).toEqual(['taskId', 'targetRunId', 'commandId']);
    expect(
      (await f.store.listExecutions('s')).filter((row) => row.childSessionId !== null),
    ).toHaveLength(1);
    expect(f.a.requests.filter((request) => request.model === 'child-v1')).toHaveLength(2);
  } finally {
    await f.close();
  }
}, 10000);
