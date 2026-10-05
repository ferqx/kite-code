import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixedModel, type ModelAdapter, type ModelEvent } from '@kite-ai/ai';
import { createRuntime } from '../../../../src';
import type { Extension, Json, OperationRef, ToolDefinition } from '../../../../src/extensions';
import { createTaskExtension } from '../../../../src/extensions/task';
import { openSqliteStore } from '../../../../src/sqlite';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
function call(name: string, input: Json): ModelEvent[] {
  return [
    { type: 'tool_call', id: crypto.randomUUID(), name, arguments: JSON.stringify(input) },
    { ...finish, reason: 'tool_calls' },
  ];
}
async function fixture(
  extension: Extension,
  sequence: ModelEvent[][],
  deny = false,
  childOverride?: ModelAdapter,
  childTool?: ToolDefinition,
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-task-leaf-')));
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' });
  const parent = createFixedModel(sequence);
  const child = createFixedModel([[{ type: 'text_delta', text: 'actual child result' }, finish]]);
  const runtime = createRuntime({
    store,
    model: parent,
    modelId: 'parent',
    modelConcurrency: 1,
    permissions: {
      async authorize(request) {
        return { allowed: !(deny && request.definitionId.startsWith('agent/')), revision: '1' };
      },
    },
    extensions: [
      { ...extension, tools: [...(extension.tools ?? []), ...(childTool ? [childTool] : [])] },
    ],
    childConfigurations: [
      {
        id: 'trusted-reader',
        version: '1',
        model: childOverride ?? child,
        modelId: 'child',
        toolIds: childTool ? [childTool.id] : [],
        snapshot: {},
      },
    ],
  });
  const expectedStoreId = (await store.getMetadata()).storeId;
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'temp',
    rootUri: `file://${root}`,
  });
  await runtime.createSession({
    expectedStoreId,
    sessionId: 's',
    workspaceId: 'w',
    commandId: 'create',
    subjectId: 'owner',
    title: 'task',
  });
  return {
    directory: root,
    store,
    runtime,
    parent,
    child,
    async run() {
      await runtime.submitCommand({
        expectedStoreId,
        sessionId: 's',
        commandId: 'run',
        subjectId: 'owner',
        request: { kind: 'run.start', content: 'task' },
      });
      await runtime.waitForCommand('run', { timeoutMs: 5000 });
    },
    async close() {
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
function extension() {
  return createTaskExtension({
    roles: [
      { id: 'reader', configurationId: 'trusted-reader', description: 'Trusted readonly child' },
    ],
  });
}

test('actual ordinary Task creates one same-key child, waits through the shared Loop, and rereads immutable facts', async () => {
  const original = extension();
  const definition = original.tools![0]!;
  let first: OperationRef | undefined;
  const wrapped: Extension = {
    ...original,
    tools: [
      {
        ...definition,
        async execute(input, context) {
          const one = await definition.execute(input, context);
          const two = await definition.execute(input, context);
          expect(two.details).toEqual(one.details);
          first = (one.details as { ref: unknown }).ref as OperationRef;
          return one;
        },
      },
      ...original.tools!.slice(1),
    ],
  };
  const f = await fixture(wrapped, [
    call('task', { key: 'one', role: 'reader', input: { content: 'read' } }),
    call('task_wait', { taskId: 'one', timeoutMs: 4000 }),
    call('task_read', { taskId: 'one' }),
    [finish],
  ]);
  try {
    await f.run();
    expect(f.child.requests).toHaveLength(1);
    const run = (await f.store.getView(first!.childSessionId!)).runs[0]!;
    expect(run.status).toBe('completed');
    expect(run.deadlineAt! - run.createdAt).toBe(1800000);
    expect((await f.store.getExecution(first!.executionId!))?.status).toBe('succeeded');
    expect(
      (await f.store.listExecutions('s')).filter((e) => e.definitionId === 'agent/trusted-reader'),
    ).toHaveLength(1);
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    await f.store.getView(first!.childSessionId!);
    await f.store.getView(first!.childSessionId!);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect(f.child.requests).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 10000);

test('model cannot choose an unregistered configuration or evade parent denial using a trusted Task role', async () => {
  const f = await fixture(
    extension(),
    [
      call('task', { key: 'bad', role: 'evil', input: {} }),
      call('task', { key: 'denied', role: 'reader', input: { content: 'read' } }),
      [finish],
    ],
    true,
  );
  try {
    await f.run();
    expect(f.child.requests).toHaveLength(0);
    const tools = (await f.store.listExecutions('s')).filter((e) => e.definitionId === 'task');
    expect(tools[0]?.status).toBe('failed');
    const jobs = (await f.store.listExecutions('s')).filter(
      (e) => e.definitionId === 'agent/trusted-reader',
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.status).toBe('failed');
  } finally {
    await f.close();
  }
}, 10000);

test('caller mutation cannot rewrite the sealed role configuration mapping', () => {
  const roles = [{ id: 'reader', configurationId: 'trusted-reader', description: 'reader' }];
  const task = createTaskExtension({ roles });
  roles[0]!.id = 'evil';
  roles[0]!.configurationId = 'evil';
  expect(task.tools![0]!.inputSchema).toMatchObject({ properties: { role: { enum: ['reader'] } } });
  expect(() => createTaskExtension({ roles: [] })).toThrow('invalid_task_roles');
});

function gateModel() {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const tool: ToolDefinition = {
    id: 'task.fixture_gate',
    version: '1',
    description: 'Actual harmless Tool gate',
    inputSchema: { type: 'object' },
    async execute(_input, { signal }) {
      calls++;
      started();
      let abort!: () => void;
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      try {
        await Promise.race([gate, cancelled]);
        return { outcome: 'succeeded', content: 'released' };
      } finally {
        signal.removeEventListener('abort', abort);
      }
    },
  };
  const model = createFixedModel([call(tool.id, {}), [finish]]);
  return {
    model,
    tool,
    ready,
    release,
    get calls() {
      return calls;
    },
  };
}
test('detached Task survives parent completion and exact cancel is requested then confirmed by real carrier settlement', async () => {
  const child = gateModel();
  const original = extension();
  const task = original.tools![0]!;
  let ref!: OperationRef;
  const wrapped: Extension = {
    ...original,
    tools: [
      {
        ...task,
        async execute(input, context) {
          const response = await task.execute(input, context);
          ref = (response.details as { ref: unknown }).ref as OperationRef;
          await child.ready;
          return response;
        },
      },
      ...original.tools!.slice(1),
    ],
  };
  const f = await fixture(
    wrapped,
    [
      call('task', {
        key: 'bg',
        role: 'reader',
        input: { content: 'work' },
        cancellation: 'detached',
        resultDisposition: 'background',
      }),
      [finish],
    ],
    false,
    child.model,
    child.tool,
  );
  try {
    await f.run();
    expect((await f.store.getView('s')).runs[0]?.status).toBe('completed');
    expect((await f.store.getView(ref.childSessionId!)).runs[0]?.status).toBe('running');
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    await f.store.getView(ref.childSessionId!);
    expect(child.calls).toBe(1);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    await f.runtime.cancelExecution({
      expectedStoreId: ref.originStoreId,
      sessionId: 's',
      subjectId: 'owner',
      commandId: 'cancel-bg',
      executionId: ref.executionId!,
    });
    const end = Date.now() + 5000;
    while (
      !['cancelled', 'failed', 'outcome_unknown'].includes(
        (await f.store.getExecution(ref.executionId!))!.status,
      )
    ) {
      if (Date.now() > end) throw new Error('carrier settlement missing');
      await Bun.sleep(5);
    }
    expect((await f.store.getExecution(ref.executionId!))?.status).toBe('outcome_unknown');
    expect((await f.store.getView(ref.childSessionId!)).runs[0]?.status).toBe('cancelled');
    expect(child.calls).toBe(1);
  } finally {
    child.release();
    await f.close();
  }
}, 10000);

test('default three Task slots fail the fourth before any child Session or Provider exists', async () => {
  const gate = gateModel();
  const reusable: ModelAdapter = {
    async *stream(request) {
      if (request.messages.some((message) => message.role === 'tool')) {
        yield finish;
        return;
      }
      for (const event of call(gate.tool.id, {})) yield event;
    },
  };
  const inputs = [1, 2, 3, 4].map((n) =>
    call('task', {
      key: `child${n}`,
      role: 'reader',
      input: { content: 'work' },
      cancellation: 'detached',
      resultDisposition: 'background',
    }),
  );
  const f = await fixture(extension(), [...inputs, [finish]], false, reusable, gate.tool);
  try {
    await f.run();
    const carriers = (await f.store.listExecutions('s')).filter(
      (execution) => execution.childSessionId,
    );
    expect(carriers).toHaveLength(3);
    const rejectedTask = (await f.store.listExecutions('s'))
      .filter((execution) => execution.definitionId === 'task')
      .at(-1)!;
    expect(rejectedTask.status).toBe('failed');
    expect(rejectedTask.result).toMatchObject({
      outcome: 'failed',
      content: 'child_capacity_full',
      details: { childCreated: false },
    });
    expect(
      await f.store.getExtensionRecord({
        sessionId: 's',
        extensionId: 'builtin.task',
        key: 'task/child4',
      }),
    ).toBeNull();
    const Database = (await import('bun:sqlite')).Database;
    const db = new Database(join(f.directory, 'data', 'test', 'core.db'), { readonly: true });
    try {
      expect(
        (db.query("SELECT count(*) AS n FROM session WHERE parent_id='s'").get() as { n: number })
          .n,
      ).toBe(3);
    } finally {
      db.close();
    }
    const views = await Promise.all(
      carriers.map((carrier) => f.store.getView(carrier.childSessionId!)),
    );
    expect(views.every((view) => view.runs.length === 1 && view.runs[0]?.isActive)).toBe(true);
    expect(
      views.reduce(
        (count, view) =>
          count +
          view.executions.filter(
            (execution) => execution.kind === 'model' && execution.status === 'succeeded',
          ).length,
        0,
      ),
    ).toBe(3);
  } finally {
    gate.release();
    await f.close();
  }
}, 10000);
