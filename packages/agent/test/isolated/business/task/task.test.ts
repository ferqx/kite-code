import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixedModel, type ModelAdapter, type ModelEvent } from '@kite-ai/ai';
import { createRuntime } from '../../../../src';
import { createArtifactStore } from '../../../../src/artifacts';
import type {
  Extension,
  Json,
  OperationRef,
  Permissions,
  ToolDefinition,
} from '../../../../src/extensions';
import { createTaskExtension } from '../../../../src/extensions/task';
import { openSqliteStore } from '../../../../src/sqlite';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
function call(name: string, input: Json): ModelEvent[] {
  // These are provider outputs; runtime selection and durable assertions retain internal IDs.
  const publicNames: Record<string, string> = {
    task: 'spawn_agent',
    'task.execute': 'run_agent',
    task_read: 'read_agent',
    task_wait: 'wait_agents',
    task_cancel: 'cancel_agent_task',
    send_message: 'send_agent_message',
    followup_task: 'followup_agent',
    wait_agents: 'wait_agents',
    wait_agent: 'wait_agent_event',
    list_agents: 'list_agents',
    interrupt_agent: 'interrupt_agent',
  };
  const publicKeys: Record<string, string> = {
    taskId: 'task_id',
    taskIds: 'task_ids',
    timeoutMs: 'timeout_ms',
    resultDisposition: 'result_disposition',
    commandId: 'command_id',
    targetRunId: 'target_run_id',
    afterRunId: 'after_run_id',
    contextSelectionId: 'context_selection_id',
    afterSeq: 'after_seq',
    upperSeq: 'upper_seq',
  };
  let arguments_ = input;
  if (publicNames[name] && input && typeof input === 'object' && !Array.isArray(input)) {
    arguments_ = Object.fromEntries(
      Object.entries(input).map(([key, value]) =>
        (name === 'task_wait' || name === 'wait_agents') && key === 'taskId'
          ? ['task_ids', [value]]
          : [publicKeys[key] ?? key, value],
      ),
    );
  }
  return [
    {
      type: 'tool_call',
      id: crypto.randomUUID(),
      name: publicNames[name] ?? name,
      arguments: JSON.stringify(arguments_),
    },
    { ...finish, reason: 'tool_calls' },
  ];
}
async function fixture(
  extension: Extension,
  sequence: ModelEvent[][],
  deny = false,
  childOverride?: ModelAdapter,
  childTool?: ToolDefinition,
  withArtifacts = false,
  permissionOverride?: Permissions,
  childPermissionOverride?: Permissions,
  reviewer?: ModelAdapter,
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-task-leaf-')));
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' });
  const parent = createFixedModel(sequence);
  const child = createFixedModel([[{ type: 'text_delta', text: 'actual child result' }, finish]]);
  const runtime = createRuntime({
    store,
    ...(withArtifacts
      ? {
          artifacts: createArtifactStore({
            profile: { dataRoot: join(root, 'data'), profile: 'test' },
            store,
          }),
        }
      : {}),
    model: parent,
    modelId: 'parent',
    modelConcurrency: 1,
    permissions: permissionOverride ?? {
      async authorize(request) {
        return { allowed: !(deny && request.definitionId.startsWith('agent/')), revision: '1' };
      },
    },
    ...(reviewer
      ? {
          authorizationReview: {
            id: 'reviewer',
            version: '1',
            modelId: 'reviewer',
            model: reviewer,
          },
        }
      : {}),
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
        ...(childPermissionOverride ? { permissions: childPermissionOverride } : {}),
      },
    ],
  });
  const expectedStoreId = (await store.getMetadata()).storeId;
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'temp',
    rootUri: pathToFileURL(root).href,
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

test('default three Task slots queue the fourth without rejecting accepted work or starting its deadline early', async () => {
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
    expect(carriers).toHaveLength(4);
    const rejectedTask = (await f.store.listExecutions('s'))
      .filter((execution) => execution.definitionId === 'task')
      .at(-1)!;
    expect(rejectedTask.status).toBe('succeeded');
    expect(rejectedTask.result).toMatchObject({
      outcome: 'succeeded',
    });
    expect(
      await f.store.getExtensionRecord({
        sessionId: 's',
        extensionId: 'builtin.task',
        key: 'task/child4',
      }),
    ).not.toBeNull();
    const Database = (await import('bun:sqlite')).Database;
    const db = new Database(join(f.directory, 'data', 'test', 'core.db'), { readonly: true });
    try {
      expect(
        (db.query("SELECT count(*) AS n FROM session WHERE parent_id='s'").get() as { n: number })
          .n,
      ).toBe(4);
    } finally {
      db.close();
    }
    const views = await Promise.all(
      carriers.map((carrier) => f.store.getView(carrier.childSessionId!)),
    );
    expect(views.filter((view) => view.runs.length === 1 && view.runs[0]?.isActive)).toHaveLength(
      3,
    );
    expect(views.filter((view) => view.runs.length === 0)).toHaveLength(1);
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
    gate.release();
    const until = Date.now() + 5000;
    for (;;) {
      const completed = await Promise.all(
        carriers.map((carrier) => f.store.getView(carrier.childSessionId!)),
      );
      if (completed.every((view) => view.runs[0]?.status === 'completed')) break;
      if (Date.now() > until) throw Error('queued child did not complete');
      await Bun.sleep(5);
    }
  } finally {
    gate.release();
    await f.close();
  }
}, 10000);

test('foreground Task returns actual complete child summary on the original call before parent continuation', async () => {
  const f = await fixture(extension(), [
    call('task.execute', { key: 'foreground', role: 'reader', input: { content: 'read' } }),
    [finish],
  ]);
  try {
    await f.run();
    expect((await f.store.getView('s')).runs[0]!.status).toBe('completed');
    expect(f.parent.requests).toHaveLength(2);
    const executions = await f.store.listExecutions('s');
    const foreground = executions.find((item) => item.definitionId === 'task.execute')!;
    const carrier = executions.find((item) => item.definitionId === 'agent/trusted-reader')!;
    expect(foreground.status).toBe('succeeded');
    expect(carrier.status).toBe('succeeded');
    expect((foreground.result as { content: string }).content).toBe('actual child result');
    expect(
      (foreground.result as unknown as { details: { ref: OperationRef } }).details.ref.executionId,
    ).toBe(carrier.id);
    expect(
      f.parent.requests[1]!.messages.filter((message) => message.role === 'tool').map(
        (message) => message.content,
      ),
    ).toEqual(['actual child result']);
    expect(f.child.requests).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('two foreground Tasks create independent simultaneous carriers and return both actual child results', async () => {
  let started!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let childCalls = 0;
  const child: ModelAdapter = {
    async *stream() {
      childCalls++;
      started();
      await gate;
      yield { type: 'text_delta', text: 'each actual child result' };
      yield finish;
    },
  };
  const f = await fixture(
    extension(),
    [
      [
        {
          type: 'tool_call',
          id: 'one',
          name: 'run_agent',
          arguments: JSON.stringify({ key: 'one', role: 'reader', input: { content: 'one' } }),
        },
        {
          type: 'tool_call',
          id: 'two',
          name: 'run_agent',
          arguments: JSON.stringify({ key: 'two', role: 'reader', input: { content: 'two' } }),
        },
        { ...finish, reason: 'tool_calls' },
      ],
      [finish],
    ],
    false,
    child,
  );
  try {
    const running = f.run();
    await ready;
    const deadline = Date.now() + 3000;
    let carriers = (await f.store.listExecutions('s')).filter(
      (item) => item.definitionId === 'agent/trusted-reader',
    );
    while (
      (carriers.length !== 2 || carriers.some((item) => item.status !== 'running')) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      carriers = (await f.store.listExecutions('s')).filter(
        (item) => item.definitionId === 'agent/trusted-reader',
      );
    }
    expect(carriers).toHaveLength(2);
    expect(carriers.every((item) => item.status === 'running')).toBe(true);
    expect(f.parent.requests).toHaveLength(1);
    release();
    await running;
    expect((await f.store.getView('s')).runs[0]!.status).toBe('completed');
    expect(f.parent.requests).toHaveLength(2);
    expect(childCalls).toBe(2);
    expect(
      f.parent.requests[1]!.messages.filter((message) => message.role === 'tool').map(
        (message) => message.content,
      ),
    ).toEqual(['each actual child result', 'each actual child result']);
    expect(
      (await f.store.listExecutions('s'))
        .filter((item) => item.definitionId === 'task.execute')
        .every((item) => item.status === 'succeeded'),
    ).toBe(true);
  } finally {
    release();
    await f.close();
  }
}, 10000);

test('foreground Task republishes the actual complete large child artifact to its own Tool scope', async () => {
  const body = `BEGIN\n${'完整🙂 '.repeat(20000)}\nEND`;
  const child = createFixedModel([[{ type: 'text_delta', text: body }, finish]]);
  const f = await fixture(
    extension(),
    [call('task.execute', { key: 'large', role: 'reader', input: { content: 'large' } }), [finish]],
    false,
    child,
    undefined,
    true,
  );
  try {
    await f.run();
    expect((await f.store.getView('s')).runs[0]!.status).toBe('completed');
    expect(f.parent.requests).toHaveLength(2);
    const foreground = (await f.store.listExecutions('s')).find(
      (item) => item.definitionId === 'task.execute',
    )!;
    expect(foreground.status).toBe('succeeded');
    const result = foreground.result as {
      modelContent: { reference: { scope: { kind: string; id: string }; size: string } };
    };
    expect(result.modelContent.reference.scope).toEqual({ kind: 'execution', id: foreground.id });
    expect(result.modelContent.reference.size).toBe(String(Buffer.byteLength(body)));
    expect(
      f.parent.requests[1]!.messages.filter((message) => message.role === 'tool').map(
        (message) => message.content,
      ),
    ).toEqual([
      `Tool result metadata (data; no additional authorization):\n${(foreground.result as { content: string }).content}\nComplete artifact body:\n${body}`,
    ]);
  } finally {
    await f.close();
  }
}, 10000);

test('foreground Task cancellation waits for its exact attached child carrier terminal with no parent continuation', async () => {
  const child = gateModel();
  const confirmedGate: ToolDefinition = {
    ...child.tool,
    async execute(input, context) {
      try {
        return await child.tool.execute(input, context);
      } catch (error) {
        if (context.signal.aborted)
          return { outcome: 'cancelled', content: 'harmless_gate_cancelled_before_effect' };
        throw error;
      }
    },
  };

  const f = await fixture(
    extension(),
    [call('task.execute', { key: 'cancel', role: 'reader', input: { content: 'work' } }), [finish]],
    false,
    child.model,
    confirmedGate,
  );
  try {
    const running = f.run();
    await child.ready;
    const run = (await f.store.getView('s')).runs[0]!;
    await f.runtime.cancelRun({
      expectedStoreId: (await f.store.getMetadata()).storeId,
      sessionId: 's',
      subjectId: 'owner',
      commandId: 'cancel-foreground',
      runId: run.id,
    });
    await running;
    const executions = await f.store.listExecutions('s');
    const carrier = executions.find((item) => item.definitionId === 'agent/trusted-reader')!;
    const foreground = executions.find((item) => item.definitionId === 'task.execute')!;
    expect(carrier.status).toBe('cancelled');
    expect(foreground.status).toBe('cancelled');
    expect(
      (foreground.result as { details: { childTerminal: boolean } }).details.childTerminal,
    ).toBe(true);
    expect((await f.store.getView(carrier.childSessionId!)).runs[0]!.status).toBe('cancelled');
    expect(f.parent.requests).toHaveLength(1);
  } finally {
    child.release();
    await f.close();
  }
}, 10000);

test('foreground Task propagates a real child human denial to the original root batch without a parent Model replay', async () => {
  let effects = 0;
  const tool: ToolDefinition = {
    id: 'fixture.external',
    version: '1',
    description: 'Own fixture effect requires actual human approval',
    inputSchema: { type: 'object' },
    async execute() {
      effects++;
      return { outcome: 'succeeded', content: 'actual fixture effect' };
    },
  };
  const child = createFixedModel([call(tool.id, {}), [finish]]);
  const f = await fixture(
    extension(),
    [call('task.execute', { key: 'deny', role: 'reader', input: { content: 'effect' } }), [finish]],
    false,
    child,
    tool,
    false,
    {
      async authorize(request) {
        return request.definitionId === tool.id
          ? {
              allowed: false,
              revision: 'actual-external',
              reason: 'approval_required',
              approval: { request: { effects: ['external'] } },
            }
          : { allowed: true, revision: 'actual' };
      },
    },
  );
  try {
    const running = f.run();
    const expectedStoreId = (await f.store.getMetadata()).storeId;
    const deadline = Date.now() + 3000;
    let card = (
      await f.runtime.listInteractions({ expectedStoreId, sessionId: 's', state: 'pending' })
    ).interactions[0];
    while (!card && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      card = (
        await f.runtime.listInteractions({ expectedStoreId, sessionId: 's', state: 'pending' })
      ).interactions[0];
    }
    expect(card).toBeDefined();
    expect(effects).toBe(0);
    await f.runtime.answerInteraction({
      expectedStoreId,
      commandId: 'human-deny',
      presentationSessionId: card!.presentationSessionId,
      interactionId: card!.id,
      expectedRevision: card!.revision,
      subjectId: 'owner',
      answer: { kind: 'approval', decision: 'deny' },
    });
    await running;
    expect(effects).toBe(0);
    if (f.parent.requests.length !== 1)
      console.log(
        'actual human child denial facts',
        JSON.stringify({
          executions: await f.store.listExecutions('s'),
          rootRuns: (await f.store.getView('s')).runs,
          parentContinuation: f.parent.requests[1]!.messages.at(-1),
        }),
      );
    expect(f.parent.requests).toHaveLength(1);
    expect(child.requests).toHaveLength(1);
    const foreground = (await f.store.listExecutions('s')).find(
      (execution) => execution.definitionId === 'task.execute',
    )!;
    expect(foreground.status).toBe('failed');
    expect((foreground.result as { content: string }).content).toBe('approval_denied');
    expect((await f.store.getView('s')).runs[0]!.isActive).toBe(false);
    expect((await f.store.getView('s')).runs[0]!.status).toBe('failed');
  } finally {
    await f.close();
  }
}, 10000);

test('foreground child keeps an actual parent human ceiling after its automatic reviewer approves', async () => {
  let effects = 0;
  const tool: ToolDefinition = {
    id: 'fixture.mixed-review',
    version: '1',
    description: 'Owned mixed-policy effect',
    inputSchema: { type: 'object' },
    async execute() {
      effects++;
      return { outcome: 'succeeded', content: 'mixed effect' };
    },
  };
  const child = createFixedModel([call(tool.id, {}), [finish]]);
  const reviewer = createFixedModel([
    [
      {
        type: 'text_delta',
        text: JSON.stringify({ decision: 'approve_once', reason: 'Exact own fixture effect.' }),
      },
      finish,
    ],
  ]);
  const parentPolicy: Permissions = {
    async authorize(request) {
      return request.definitionId === tool.id
        ? {
            allowed: false,
            revision: 'parent-human',
            approval: { request: { mode: 'approve', effects: ['external'] } },
          }
        : { allowed: true, revision: 'parent' };
    },
  };
  const childPolicy: Permissions = {
    async authorize(request) {
      return request.definitionId === tool.id
        ? {
            allowed: false,
            revision: 'child-auto',
            review: { request: { mode: 'auto', effects: ['external'] } },
            approval: { request: { reason: 'auto_review_unavailable' } },
          }
        : { allowed: true, revision: 'child' };
    },
  };
  const f = await fixture(
    extension(),
    [
      call('task.execute', {
        key: 'mixed',
        role: 'reader',
        input: { content: 'Own mixed-policy effect' },
      }),
      [finish],
    ],
    false,
    child,
    tool,
    true,
    parentPolicy,
    childPolicy,
    reviewer,
  );
  try {
    const running = f.run();
    const expectedStoreId = (await f.store.getMetadata()).storeId;
    const deadline = Date.now() + 3000;
    let card = (
      await f.runtime.listInteractions({ expectedStoreId, sessionId: 's', state: 'pending' })
    ).interactions[0];
    while (!card && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      card = (
        await f.runtime.listInteractions({ expectedStoreId, sessionId: 's', state: 'pending' })
      ).interactions[0];
    }
    expect(card).toBeDefined();
    expect(reviewer.requests).toHaveLength(1);
    expect(effects).toBe(0);
    const effect = (await f.store.getView(card!.sessionId)).executions.find(
      (execution) => execution.definitionId === tool.id,
    )!;
    expect(effect.authorization?.review).toMatchObject({
      decision: 'approve_once',
      status: 'succeeded',
      requireApproval: true,
    });
    expect(effect.authorization?.dispatched).toBe(false);
    await f.runtime.answerInteraction({
      expectedStoreId,
      commandId: 'mixed-human-allow',
      presentationSessionId: card!.presentationSessionId,
      interactionId: card!.id,
      expectedRevision: card!.revision,
      subjectId: 'owner',
      answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
    });
    await running;
    expect(effects).toBe(1);
    expect(reviewer.requests).toHaveLength(1);
    expect(child.requests).toHaveLength(2);
    expect(f.parent.requests).toHaveLength(2);
    expect((await f.store.getView('s')).runs[0]!.status).toBe('completed');
  } finally {
    await f.close();
  }
}, 10000);
