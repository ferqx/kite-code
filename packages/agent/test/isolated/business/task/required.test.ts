import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelAdapter, ModelEvent, ModelRequest } from '@kite-ai/ai';
import { createRuntime } from '../../../../src';
import type { Extension, Json } from '../../../../src/extensions';
import { createTaskExtension } from '../../../../src/extensions/task';
import { openSqliteStore } from '../../../../src/sqlite';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const call = (name: string, input: unknown): ModelEvent[] => [
  { type: 'tool_call', id: crypto.randomUUID(), name, arguments: JSON.stringify(input) },
  { ...finish, reason: 'tool_calls' },
];
test('followup_task creates a new required carrier in the same child Session and waits for its exact result', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-task-followup-required-')));
  const store = await openSqliteStore({ dataRoot: join(directory, 'data'), profile: 'test' });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let childModels = 0;
  const requests: ModelRequest[] = [];
  const hold: Extension = {
    id: 'hold',
    version: '1',
    apiMajor: 1,
    tools: [
      {
        id: 'hold',
        version: '1',
        description: 'finite harmless follow-up barrier',
        inputSchema: { type: 'object', additionalProperties: false },
        async execute() {
          await gate;
          return { outcome: 'succeeded', content: 'follow-up finished' };
        },
      },
    ],
  };
  const child: ModelAdapter = {
    async *stream() {
      childModels++;
      for (const event of childModels === 2 ? call('hold', {}) : [finish]) yield event;
    },
  };
  const parent: ModelAdapter = {
    async *stream(request) {
      requests.push(structuredClone(request));
      let events: ModelEvent[] = [finish];
      if (requests.length === 1)
        events = call('task', {
          key: 'initial',
          role: 'reader',
          input: { content: 'first' },
          resultDisposition: 'background',
        });
      if (requests.length === 2) events = call('task_wait', { taskId: 'initial' });
      if (requests.length === 3) events = call('task_read', { taskId: 'initial' });
      if (requests.length === 4) {
        const message = request.messages.filter((message) => message.role === 'tool').at(-1)!;
        const view = JSON.parse(message.content).agent;
        events = call('followup_task', {
          taskId: 'initial',
          key: 'next',
          afterRunId: view.run.id,
          contextSelectionId: view.contextSelectionId,
          content: 'second',
        });
      }
      for (const event of events) yield event;
    },
  };
  const runtime = createRuntime({
    store,
    model: parent,
    modelId: 'parent',
    modelConcurrency: 1,
    extensions: [
      createTaskExtension({
        roles: [{ id: 'reader', configurationId: 'child', description: 'trusted' }],
      }),
      hold,
    ],
    childConfigurations: [
      {
        id: 'child',
        version: '1',
        model: child,
        modelId: 'child',
        toolIds: ['hold'],
        snapshot: {},
      },
    ],
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
  });
  try {
    const expectedStoreId = (await store.getMetadata()).storeId;
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'private',
      rootUri: `file://${directory}`,
    });
    await runtime.createSession({
      expectedStoreId,
      sessionId: 'root',
      workspaceId: 'w',
      subjectId: 'owner',
      commandId: 'create',
      title: 'follow-up',
    });
    await runtime.submitCommand({
      expectedStoreId,
      sessionId: 'root',
      subjectId: 'owner',
      commandId: 'work',
      request: { kind: 'run.start', content: 'follow up then finish' },
    });
    const waiting = await until(
      () => store.getView('root'),
      (view) => view.runs[0]?.waitingForResults.length === 1,
    );
    expect(requests).toHaveLength(5);
    expect(waiting.runs[0]?.requirements).toHaveLength(1);
    const carriers = waiting.executions.filter((execution) => execution.childSessionId);
    expect(carriers).toHaveLength(2);
    expect(carriers[0]!.childSessionId).toBe(carriers[1]!.childSessionId);
    const childView = await store.getView(carriers[0]!.childSessionId!);
    expect(childView.runs).toHaveLength(2);
    expect(childView.runs.filter((run) => run.isActive)).toHaveLength(1);
    release();
    await runtime.waitForCommand('work', { timeoutMs: 5000 });
    const final = await store.getView('root');
    expect(final.runs[0]?.status).toBe('completed');
    expect(requests).toHaveLength(6);
    const accepted = final.executions.filter((execution) => execution.resultAcceptance);
    expect(accepted).toHaveLength(2);
    expect(
      accepted.every((execution) => execution.resultAcceptance?.runId === final.runs[0]!.id),
    ).toBe(true);
  } finally {
    release();
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 15000);
async function until<T>(read: () => Promise<T>, check: (value: T) => boolean): Promise<T> {
  const end = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (check(value)) return value;
    if (Date.now() > end) throw new Error('actual state barrier timeout');
    await Bun.sleep(5);
  }
}
test('default required children hold the same completion candidate, staggered results cause no polling Model, and exact low-trust results are accepted once', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-task-required-')));
  const store = await openSqliteStore({ dataRoot: join(directory, 'data'), profile: 'test' });
  const releases = new Map<string, () => void>();
  const requests: ModelRequest[] = [];
  let childModels = 0;
  const hold: Extension = {
    id: 'hold',
    version: '1',
    apiMajor: 1,
    tools: [
      {
        id: 'hold',
        version: '1',
        description: 'harmless barrier',
        inputSchema: {
          type: 'object',
          properties: { key: { type: 'string' } },
          required: ['key'],
          additionalProperties: false,
        },
        async execute(input) {
          const key = String((input as Record<string, Json>).key);
          await new Promise<void>((resolve) => releases.set(key, resolve));
          return { outcome: 'succeeded', content: `held ${key}` };
        },
      },
    ],
  };
  const child: ModelAdapter = {
    async *stream(request) {
      childModels++;
      if (request.messages.some((message) => message.role === 'tool')) {
        yield { type: 'text_delta', text: 'child settled result' };
        yield finish;
        return;
      }
      const input = JSON.parse(
        request.messages.find((message) => message.role === 'user')!.content,
      );
      for (const event of call('hold', { key: input.content })) yield event;
    },
  };
  const parent: ModelAdapter = {
    async *stream(request) {
      requests.push(structuredClone(request));
      const count = requests.length;
      const events =
        count <= 2
          ? call('task', {
              key: `child${count}`,
              role: 'reader',
              input: { content: String(count) },
              cancellation: 'detached',
            })
          : [finish];
      for (const event of events) yield event;
    },
  };
  const runtime = createRuntime({
    store,
    model: parent,
    modelId: 'parent',
    modelConcurrency: 1,
    extensions: [
      createTaskExtension({
        roles: [{ id: 'reader', configurationId: 'child', description: 'trusted' }],
      }),
      hold,
    ],
    childConfigurations: [
      {
        id: 'child',
        version: '1',
        model: child,
        modelId: 'child',
        toolIds: ['hold'],
        snapshot: {},
      },
    ],
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
  });
  try {
    const expectedStoreId = (await store.getMetadata()).storeId;
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'private',
      rootUri: `file://${directory}`,
    });
    await runtime.createSession({
      expectedStoreId,
      sessionId: 'root',
      workspaceId: 'w',
      subjectId: 'owner',
      commandId: 'create',
      title: 'required',
    });
    await runtime.submitCommand({
      expectedStoreId,
      sessionId: 'root',
      subjectId: 'owner',
      commandId: 'work',
      request: { kind: 'run.start', content: 'delegate two then finish' },
    });
    const waiting = await until(
      () => store.getView('root'),
      (view) =>
        view.runs[0]?.status === 'waiting_execution' &&
        view.runs[0].waitingForResults.length === 2 &&
        releases.size === 2,
    );
    const runId = waiting.runs[0]!.id;
    expect(requests).toHaveLength(3);
    expect(waiting.runs[0]?.requirements).toHaveLength(2);
    expect(releases.size).toBe(2);
    releases.get('1')!();
    await until(
      () => store.getView('root'),
      (view) =>
        view.executions.some(
          (execution) => execution.childSessionId && execution.status === 'succeeded',
        ),
    );
    const one = await until(
      () =>
        store.getSelectedContext({
          expectedStoreId,
          sessionId: 'root',
          sourceLimit: 20,
          messageLimit: 20,
          byteLimit: 8 * 1024 * 1024,
        }),
      (page) => page.resultSources.length === 1,
    );
    expect(requests).toHaveLength(3);
    expect((await store.getRun(runId))?.isActive).toBe(true);
    releases.get('2')!();
    await runtime.waitForCommand('work', { timeoutMs: 8000 });
    expect(requests).toHaveLength(4);
    const view = await store.getView('root');
    expect(view.runs).toHaveLength(1);
    expect(view.runs[0]?.id).toBe(runId);
    expect(view.runs[0]?.status).toBe('completed');
    expect(childModels).toBe(4);
    const selected = await store.getSelectedContext({
      expectedStoreId,
      sessionId: 'root',
      sourceLimit: 20,
      messageLimit: 20,
      byteLimit: 8 * 1024 * 1024,
    });
    expect(selected.resultSources).toHaveLength(2);
    expect(new Set(selected.resultSources.map((source) => source.id)).size).toBe(2);
    expect(selected.resultSources.map((source) => source.id)).toContain(one.resultSources[0]!.id);
    for (const source of selected.resultSources) {
      const messages = requests[3]!.messages.filter((message) =>
        message.sourceIds?.includes(source.id),
      );
      expect(messages).toHaveLength(1);
      expect(messages[0]!.role).toBe('user');
    }
    const cursor = (await store.getMetadata()).lastChangeCursor;
    await store.getSelectedContext({ expectedStoreId, sessionId: 'root' });
    expect((await store.getMetadata()).lastChangeCursor).toBe(cursor);
  } finally {
    for (const release of releases.values()) release();
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 15000);

test('known failed required child is accepted as a failure source and parent can truthfully complete', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-task-failed-required-')));
  const store = await openSqliteStore({ dataRoot: join(directory, 'data'), profile: 'test' });
  const requests: ModelRequest[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const child: ModelAdapter = {
    async *stream() {
      await gate;
      yield { type: 'text_delta', text: 'partial before fixed failure' };
      throw new Error('harmless fixed child failure');
    },
  };
  const parent: ModelAdapter = {
    async *stream(request) {
      requests.push(structuredClone(request));
      for (const event of requests.length === 1
        ? call('task', {
            key: 'failure',
            role: 'reader',
            input: { content: 'fail honestly' },
            cancellation: 'detached',
          })
        : [finish])
        yield event;
    },
  };
  const runtime = createRuntime({
    store,
    model: parent,
    modelId: 'parent',
    modelConcurrency: 1,
    extensions: [
      createTaskExtension({
        roles: [{ id: 'reader', configurationId: 'child', description: 'trusted' }],
      }),
    ],
    childConfigurations: [
      { id: 'child', version: '1', model: child, modelId: 'child', toolIds: [], snapshot: {} },
    ],
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
  });
  try {
    const expectedStoreId = (await store.getMetadata()).storeId;
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'private',
      rootUri: `file://${directory}`,
    });
    await runtime.createSession({
      expectedStoreId,
      sessionId: 'root',
      workspaceId: 'w',
      subjectId: 'owner',
      commandId: 'create',
      title: 'failure',
    });
    await runtime.submitCommand({
      expectedStoreId,
      sessionId: 'root',
      subjectId: 'owner',
      commandId: 'work',
      request: { kind: 'run.start', content: 'delegate then report accurately' },
    });
    await until(
      () => store.getView('root'),
      (view) =>
        view.executions.some(
          (execution) => execution.childSessionId && execution.status === 'running',
        ),
    );
    release();
    await runtime.waitForCommand('work', { timeoutMs: 8000 });
    const view = await store.getView('root');
    expect(view.runs[0]?.status).toBe('completed');
    const carrier = view.executions.find((execution) => execution.childSessionId)!;
    expect(carrier.status).toBe('failed');
    expect(carrier.resultAcceptance?.runId).toBe(view.runs[0]!.id);
    const selected = await store.getSelectedContext({ expectedStoreId, sessionId: 'root' });
    expect(selected.resultSources).toHaveLength(1);
    expect((selected.resultSources[0]!.result as Record<string, Json>).outcome).toBe('failed');
    expect(
      requests
        .at(-1)!
        .messages.some(
          (message) =>
            message.role === 'user' && message.sourceIds?.includes(selected.resultSources[0]!.id),
        ),
    ).toBe(true);
    const cursor = (await store.getMetadata()).lastChangeCursor;
    await store.getSelectedContext({ expectedStoreId, sessionId: 'root' });
    expect((await store.getMetadata()).lastChangeCursor).toBe(cursor);
  } finally {
    release();
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 15000);

for (const wake of ['terminal', 'input', 'include', 'timeout'] as const)
  test(`task_wait ${wake} wakes without cancelling other current-owner detached targets`, async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-task-wait-any-')));
    const store = await openSqliteStore({ dataRoot: join(directory, 'data'), profile: 'test' });
    const releases = new Map<string, () => void>();
    let parentModels = 0;
    const hold: Extension = {
      id: 'hold',
      version: '1',
      apiMajor: 1,
      tools: [
        {
          id: 'hold',
          version: '1',
          description: 'harmless wait barrier',
          inputSchema: {
            type: 'object',
            properties: { key: { type: 'string' } },
            required: ['key'],
            additionalProperties: false,
          },
          async execute(input) {
            await new Promise<void>((resolve) =>
              releases.set(String((input as Record<string, Json>).key), resolve),
            );
            return { outcome: 'succeeded', content: 'settled' };
          },
        },
      ],
    };
    const child: ModelAdapter = {
      async *stream(request) {
        if (request.messages.some((message) => message.role === 'tool')) {
          yield finish;
          return;
        }
        for (const event of call('hold', {
          key: JSON.parse(request.messages.find((message) => message.role === 'user')!.content)
            .content,
        }))
          yield event;
      },
    };
    const parent: ModelAdapter = {
      async *stream() {
        parentModels++;
        for (const event of parentModels <= 2
          ? call('task', {
              key: `child${parentModels}`,
              role: 'reader',
              input: { content: String(parentModels) },
              cancellation: 'detached',
              resultDisposition: 'background',
            })
          : parentModels === 3
            ? call('task_wait', {
                taskIds: ['child1', 'child2'],
                timeoutMs: wake === 'timeout' ? 0 : 30000,
              })
            : [finish])
          yield event;
      },
    };
    const runtime = createRuntime({
      store,
      model: parent,
      modelId: 'parent',
      modelConcurrency: 1,
      extensions: [
        createTaskExtension({
          roles: [{ id: 'reader', configurationId: 'child', description: 'trusted' }],
        }),
        hold,
      ],
      childConfigurations: [
        {
          id: 'child',
          version: '1',
          model: child,
          modelId: 'child',
          toolIds: ['hold'],
          snapshot: {},
        },
      ],
      permissions: {
        async authorize() {
          return { allowed: true, revision: '1' };
        },
      },
    });
    try {
      const expectedStoreId = (await store.getMetadata()).storeId;
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'private',
        rootUri: `file://${directory}`,
      });
      await runtime.createSession({
        expectedStoreId,
        sessionId: 'root',
        workspaceId: 'w',
        subjectId: 'owner',
        commandId: 'create',
        title: 'wait any',
      });
      await runtime.submitCommand({
        expectedStoreId,
        sessionId: 'root',
        subjectId: 'owner',
        commandId: 'work',
        request: { kind: 'run.start', content: 'wait for first result' },
      });
      const waiting = await until(
        () => store.getView('root'),
        (view) =>
          view.executions.some(
            (execution) =>
              execution.definitionId === 'task_wait' &&
              (execution.status === 'dispatching' ||
                (wake === 'timeout' && execution.status === 'succeeded')),
          ) && releases.size === 2,
      );
      if (wake !== 'timeout') expect(parentModels).toBe(3);
      if (wake === 'terminal') releases.get('1')!();
      else if (wake === 'input')
        await runtime.submitCommand({
          expectedStoreId,
          sessionId: 'root',
          subjectId: 'owner',
          commandId: 'steer-wait',
          request: {
            kind: 'input.steer',
            targetRunId: waiting.runs[0]!.id,
            contextSelectionId: waiting.session.contextSelectionId,
            content: 'new guide without cancelling children',
          },
        });
      if (wake === 'include') {
        const source = waiting.executions.find(
          (execution) => execution.definitionId === 'task' && execution.status === 'succeeded',
        )!;
        await runtime.includeResult({
          expectedStoreId,
          sessionId: 'root',
          subjectId: 'owner',
          commandId: 'include-wait',
          expectedContextSelectionId: waiting.session.contextSelectionId,
          targetRunId: waiting.runs[0]!.id,
          executionId: source.id,
          resultRevision: source.resultRevision,
        });
      }
      await runtime.waitForCommand('work', { timeoutMs: 8000 });
      const view = await store.getView('root');
      expect(parentModels).toBe(4);
      expect(view.runs[0]?.status).toBe('completed');
      const waited = view.executions.find((execution) => execution.definitionId === 'task_wait')!;
      expect(waited.status).toBe('succeeded');
      const details = (waited.result as Record<string, Json>).details as Record<string, Json>;
      expect(details.reason).toBe(wake === 'include' ? 'input' : wake);
      if (wake === 'include')
        expect((await store.getCommand('include-wait'))!.status).toBe('applied');
      expect(details.timedOut).toBe(wake === 'timeout');
      const carriers = view.executions.filter((execution) => execution.childSessionId);
      expect(carriers.filter((execution) => execution.status === 'succeeded')).toHaveLength(
        wake === 'terminal' ? 1 : 0,
      );
      const remaining = carriers.find((execution) => execution.status === 'running')!;
      expect(remaining.cancelRequestedAt).toBeNull();
      expect(view.runs[0]?.requirements).toHaveLength(0);
    } finally {
      for (const release of releases.values()) release();
      await runtime.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15000);

test('unknown required carrier produces one status-only diagnosis Model and never accepts or completes its obligation', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-task-unknown-required-')));
  const store = await openSqliteStore({ dataRoot: join(directory, 'data'), profile: 'test' });
  const database = new Database(join(directory, 'data', 'test', 'core.db'));
  const requests: ModelRequest[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const child: ModelAdapter = {
    async *stream() {
      await gate;
      yield finish;
    },
  };
  const parent: ModelAdapter = {
    async *stream(request) {
      requests.push(structuredClone(request));
      for (const event of requests.length === 1
        ? call('task', {
            key: 'unknown',
            role: 'reader',
            input: { content: 'bounded commit failure' },
            cancellation: 'detached',
          })
        : [finish])
        yield event;
    },
  };
  const runtime = createRuntime({
    store,
    model: parent,
    modelId: 'parent',
    modelConcurrency: 1,
    extensions: [
      createTaskExtension({
        roles: [{ id: 'reader', configurationId: 'child', description: 'trusted' }],
      }),
    ],
    childConfigurations: [
      { id: 'child', version: '1', model: child, modelId: 'child', toolIds: [], snapshot: {} },
    ],
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
  });
  try {
    const expectedStoreId = (await store.getMetadata()).storeId;
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'private',
      rootUri: `file://${directory}`,
    });
    await runtime.createSession({
      expectedStoreId,
      sessionId: 'root',
      workspaceId: 'w',
      subjectId: 'owner',
      commandId: 'create',
      title: 'unknown',
    });
    database.run(
      "CREATE TRIGGER child_finish_fault BEFORE UPDATE OF is_active ON run WHEN OLD.session_id<>'root' AND NEW.is_active=0 BEGIN SELECT RAISE(ABORT,'harmless terminal commit fault'); END",
    );
    await runtime.submitCommand({
      expectedStoreId,
      sessionId: 'root',
      subjectId: 'owner',
      commandId: 'work',
      request: { kind: 'run.start', content: 'diagnose unknown truthfully' },
    });
    await until(
      () => store.getView('root'),
      (view) =>
        view.executions.some(
          (execution) => execution.childSessionId && execution.status === 'running',
        ),
    );
    release();
    await runtime.waitForCommand('work', { timeoutMs: 8000 });
    const view = await store.getView('root');
    expect(view.runs[0]?.status).toBe('failed');
    expect(view.runs[0]?.reason).toBe('necessary_condition_unsatisfied');
    const carrier = view.executions.find((execution) => execution.childSessionId)!;
    expect(carrier.status).toBe('outcome_unknown');
    expect(carrier.resultAcceptance).toBeNull();
    expect(carrier.delivery).toBe('pending');
    const selected = await store.getSelectedContext({ expectedStoreId, sessionId: 'root' });
    expect(selected.resultSources).toHaveLength(1);
    const diagnosis = selected.resultSources[0]!;
    expect((diagnosis.result as Record<string, Json>).outcome).toBe('outcome_unknown');
    expect((diagnosis.result as Record<string, Json>).content).toBe(
      'required_operation_settlement',
    );
    expect(
      requests.filter((request) =>
        request.messages.some((message) => message.sourceIds?.includes(diagnosis.id)),
      ),
    ).toHaveLength(1);
    const cursor = (await store.getMetadata()).lastChangeCursor;
    await store.getSelectedContext({ expectedStoreId, sessionId: 'root' });
    await store.getExecution(carrier.id);
    expect((await store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect((await store.getView('root')).runs[0]?.requirements).toHaveLength(1);
  } finally {
    release();
    database.run('DROP TRIGGER IF EXISTS child_finish_fault');
    database.close();
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 15000);

for (const disposition of ['required', 'background'] as const)
  test(`${disposition} cancelled Task keeps suppressed delivery; only exact required settlement gets one status-only source`, async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-task-cancel-settlement-')));
    const store = await openSqliteStore({ dataRoot: join(directory, 'data'), profile: 'test' });
    const requests: ModelRequest[] = [];
    let toolStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      toolStarted = resolve;
    });
    const hold: Extension = {
      id: 'hold',
      version: '1',
      apiMajor: 1,
      tools: [
        {
          id: 'hold',
          version: '1',
          description: 'harmless cancellation barrier',
          inputSchema: { type: 'object' },
          async execute(_input, { signal }) {
            toolStarted();
            await new Promise<void>((resolve) => {
              signal.addEventListener('abort', () => resolve(), { once: true });
              if (signal.aborted) resolve();
            });
            return {
              outcome: 'cancelled',
              content: 'untrusted external body must not be auto included',
            };
          },
        },
        {
          id: 'wait_started',
          version: '1',
          description: 'resource-free actual child start gate',
          inputSchema: { type: 'object' },
          async execute() {
            await started;
            return { outcome: 'succeeded', content: 'started' };
          },
        },
      ],
    };
    const child: ModelAdapter = {
      async *stream() {
        for (const event of call('hold', {})) yield event;
      },
    };
    const parent: ModelAdapter = {
      async *stream(request) {
        requests.push(structuredClone(request));
        for (const event of requests.length === 1
          ? call('task', {
              key: 'cancel',
              role: 'reader',
              input: { content: 'cancel exactly' },
              resultDisposition: disposition,
            })
          : requests.length === 2
            ? call('wait_started', {})
            : requests.length === 3
              ? call('task_cancel', { taskId: 'cancel', commandId: 'cancel-exact' })
              : [finish])
          yield event;
      },
    };
    const runtime = createRuntime({
      store,
      model: parent,
      modelId: 'parent',
      modelConcurrency: 1,
      extensions: [
        createTaskExtension({
          roles: [{ id: 'reader', configurationId: 'child', description: 'trusted' }],
        }),
        hold,
      ],
      childConfigurations: [
        {
          id: 'child',
          version: '1',
          model: child,
          modelId: 'child',
          toolIds: ['hold'],
          snapshot: {},
        },
      ],
      permissions: {
        async authorize() {
          return { allowed: true, revision: '1' };
        },
      },
    });
    try {
      const expectedStoreId = (await store.getMetadata()).storeId;
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'private',
        rootUri: `file://${directory}`,
      });
      await runtime.createSession({
        expectedStoreId,
        sessionId: 'root',
        workspaceId: 'w',
        subjectId: 'owner',
        commandId: 'create',
        title: 'cancel settlement',
      });
      await runtime.submitCommand({
        expectedStoreId,
        sessionId: 'root',
        subjectId: 'owner',
        commandId: 'work',
        request: { kind: 'run.start', content: 'cancel child then report status' },
      });
      await runtime.waitForCommand('work', { timeoutMs: 8000 });
      const view = await until(
        () => store.getView('root'),
        (current) =>
          current.executions.some(
            (execution) => execution.childSessionId && execution.status === 'cancelled',
          ),
      );
      expect(view.runs[0]?.status).toBe('completed');
      const carrier = view.executions.find((execution) => execution.childSessionId)!;
      expect(carrier.delivery).toBe('suppressed');
      expect(carrier.deliveryReason).toBe('execution_cancel');
      const selected = await store.getSelectedContext({ expectedStoreId, sessionId: 'root' });
      expect(selected.resultSources).toHaveLength(disposition === 'required' ? 1 : 0);
      if (disposition === 'required') {
        expect(carrier.resultAcceptance?.runId).toBe(view.runs[0]!.id);
        const result = selected.resultSources[0]!.result as Record<string, Json>;
        expect(result.outcome).toBe('cancelled');
        expect(result.content).toBe('required_operation_settlement');
        expect(JSON.stringify(result)).not.toContain('untrusted external body');
        expect(
          requests.filter((request) =>
            request.messages.some((message) =>
              message.sourceIds?.includes(selected.resultSources[0]!.id),
            ),
          ),
        ).toHaveLength(1);
      } else expect(carrier.resultAcceptance).toBeNull();
      const cursor = (await store.getMetadata()).lastChangeCursor;
      await store.getSelectedContext({ expectedStoreId, sessionId: 'root' });
      expect((await store.getMetadata()).lastChangeCursor).toBe(cursor);
    } finally {
      await runtime.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15000);

for (const domain of ['attached_tool', 'independent_job'] as const)
  test(`required child settlement preserves unknown ${domain} supervision domain`, async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-task-child-unknown-')));
    const store = await openSqliteStore({ dataRoot: join(directory, 'data'), profile: 'test' });
    const requests: ModelRequest[] = [];
    let unknownEffects = 0;
    let jobTerminal!: () => void;
    const terminal = new Promise<void>((resolve) => {
      jobTerminal = resolve;
    });
    const effect: Extension = {
      id: 'effect',
      version: '1',
      apiMajor: 1,
      tools: [
        {
          id: 'effect',
          version: '1',
          description: 'harmless unknown fact',
          inputSchema: { type: 'object' },
          async execute() {
            unknownEffects++;
            return { outcome: 'outcome_unknown', content: 'uncertain harmless effect' };
          },
        },
        {
          id: 'launch',
          version: '1',
          description: 'independent harmless Job',
          inputSchema: { type: 'object' },
          async execute(_input, context) {
            await context.operations.ensure({
              key: 'independent',
              cancellation: 'detached',
              request: {
                kind: 'job',
                definitionId: 'background',
                definitionVersion: '1',
                input: {},
              },
            });
            await terminal;
            return {
              outcome: 'succeeded',
              content: 'independent Job retained its own unknown supervision',
            };
          },
        },
      ],
      jobs: [
        {
          id: 'background',
          version: '1',
          description: 'independent unknown fact',
          inputSchema: { type: 'object' },
          async start() {
            unknownEffects++;
            return { reference: { id: 'harmless' } };
          },
          async *observe() {
            yield {
              type: 'terminal',
              supervision: 'ended',
              result: { outcome: 'outcome_unknown', content: 'independent uncertain effect' },
            };
            jobTerminal();
          },
          async cancel() {
            return { status: 'already_finished' };
          },
          async dispose() {},
        },
      ],
    };
    const child: ModelAdapter = {
      async *stream(request) {
        for (const event of request.messages.some((message) => message.role === 'tool')
          ? [finish]
          : call(domain === 'attached_tool' ? 'effect' : 'launch', {}))
          yield event;
      },
    };
    const parent: ModelAdapter = {
      async *stream(request) {
        requests.push(structuredClone(request));
        for (const event of requests.length === 1
          ? call('task', {
              key: 'unknown-domain',
              role: 'reader',
              input: { content: 'preserve original effect domain' },
              cancellation: 'detached',
            })
          : [finish])
          yield event;
      },
    };
    const runtime = createRuntime({
      store,
      model: parent,
      modelId: 'parent',
      modelConcurrency: 1,
      extensions: [
        createTaskExtension({
          roles: [{ id: 'reader', configurationId: 'child', description: 'trusted' }],
        }),
        effect,
      ],
      childConfigurations: [
        {
          id: 'child',
          version: '1',
          model: child,
          modelId: 'child',
          toolIds: ['effect', 'launch'],
          snapshot: {},
        },
      ],
      permissions: {
        async authorize() {
          return { allowed: true, revision: '1' };
        },
      },
    });
    try {
      const expectedStoreId = (await store.getMetadata()).storeId;
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'private',
        rootUri: `file://${directory}`,
      });
      await runtime.createSession({
        expectedStoreId,
        sessionId: 'root',
        workspaceId: 'w',
        subjectId: 'owner',
        commandId: 'create',
        title: 'unknown domain',
      });
      await runtime.submitCommand({
        expectedStoreId,
        sessionId: 'root',
        subjectId: 'owner',
        commandId: 'work',
        request: { kind: 'run.start', content: 'report child settlement accurately' },
      });
      await runtime.waitForCommand('work', { timeoutMs: 8000 });
      const view = await store.getView('root');
      const carrier = view.executions.find((execution) => execution.childSessionId)!;
      const childView = await store.getView(carrier.childSessionId!);
      expect(unknownEffects).toBe(1);
      expect(childView.executions.some((execution) => execution.status === 'outcome_unknown')).toBe(
        true,
      );
      expect(carrier.status).toBe(domain === 'attached_tool' ? 'outcome_unknown' : 'succeeded');
      expect(childView.runs[0]?.status).toBe(domain === 'attached_tool' ? 'failed' : 'completed');
      expect(view.runs[0]?.status).toBe(domain === 'attached_tool' ? 'failed' : 'completed');
      const selected = await store.getSelectedContext({ expectedStoreId, sessionId: 'root' });
      expect(selected.resultSources).toHaveLength(1);
      expect(
        requests.filter((request) =>
          request.messages.some((message) =>
            message.sourceIds?.includes(selected.resultSources[0]!.id),
          ),
        ),
      ).toHaveLength(1);
      if (domain === 'attached_tool') {
        expect(carrier.resultAcceptance).toBeNull();
        expect((carrier.result as Record<string, Json>).details).toMatchObject({
          status: 'failed',
          originalOutcome: 'failed',
          childSettlement: 'attached_effect_unknown',
        });
        expect((selected.resultSources[0]!.result as Record<string, Json>).outcome).toBe(
          'outcome_unknown',
        );
      } else expect(carrier.resultAcceptance?.runId).toBe(view.runs[0]!.id);
    } finally {
      jobTerminal();
      await runtime.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15000);
