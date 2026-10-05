import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixedModel, type ModelAdapter, type ModelEvent } from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import type { OperationRef, ToolDefinition } from '../../../src/extensions';
import { openSqliteStore } from '../../../src/sqlite';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
async function fact<T>(read: () => Promise<T | undefined>): Promise<T> {
  const end = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error('deadline_fact_missing');
    await Bun.sleep(5);
  }
}
async function fixture(remainingMs: number, child: ModelAdapter, effect?: ToolDefinition) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-child-deadline-'))),
    profile = { dataRoot: join(root, 'data'), profile: 'new' };
  const store = await openSqliteStore(profile),
    db = new Database(join(profile.dataRoot, 'new', 'core.db'));
  const activate = store.activateChildRun.bind(store);
  store.activateChildRun = async (input) => {
    const actual = await activate(input);
    expect(actual.run.deadlineAt! - actual.run.createdAt).toBe(1800000);
    // Only this private fixture changes persisted activation and its exact fixed-duration deadline.
    // There is no public/configurable production short deadline.
    const deadlineAt = Date.now() + remainingMs;
    db.query('UPDATE run SET started_at=?,deadline_at=? WHERE id=?').run(
      deadlineAt - 1800000,
      deadlineAt,
      actual.run.id,
    );
    return { ...actual, run: (await store.getRun(actual.run.id))! };
  };
  let ref: OperationRef | undefined;
  const parent = createFixedModel([
    [
      { type: 'tool_call', id: 'delegate', name: 'fixture.delegate', arguments: '{}' },
      { ...finish, type: 'finish', reason: 'tool_calls' } as ModelEvent,
    ],
    [finish],
  ]);
  const runtime = createRuntime({
    store,
    model: parent,
    modelId: 'parent',
    modelConcurrency: 1,
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'full' };
      },
    },
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'fixture.delegate',
            version: '1',
            description: 'Detached bounded child',
            inputSchema: { type: 'object' },
            async execute(_input, context) {
              ref = await context.operations.ensure({
                key: 'child',
                cancellation: 'detached',
                request: {
                  kind: 'agent',
                  configurationId: 'child',
                  input: { content: 'actual deadline' },
                },
              });
              return { outcome: 'succeeded', content: 'child created' };
            },
          },
          ...(effect ? [effect] : []),
        ],
      },
    ],
    childConfigurations: [
      {
        id: 'child',
        version: '1',
        model: child,
        modelId: 'child',
        toolIds: effect ? [effect.id] : [],
        snapshot: {},
      },
    ],
  });
  const expectedStoreId = (await store.getMetadata()).storeId;
  await runtime.createWorkspace({ expectedStoreId, id: 'w', name: 'w', rootUri: `file://${root}` });
  await runtime.createSession({
    expectedStoreId,
    sessionId: 's',
    workspaceId: 'w',
    commandId: 'create',
    subjectId: 'owner',
    title: 's',
  });
  return {
    store,
    runtime,
    expectedStoreId,
    get ref() {
      return ref;
    },
    submit: () =>
      runtime.submitCommand({
        expectedStoreId,
        sessionId: 's',
        commandId: 'work',
        subjectId: 'owner',
        request: { kind: 'run.start', content: 'delegate' },
      }),
    async close() {
      await runtime.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('persisted expired child deadline prevents its first actual Model while the root Run remains unlimited', async () => {
  const child = createFixedModel([[finish]]),
    f = await fixture(-1, child);
  try {
    await f.submit();
    await f.runtime.waitForCommand('work');
    const ref = await fact(async () => f.ref);
    const run = await fact(async () => {
      const value = (await f.store.getView(ref.childSessionId!)).runs[0];
      return value && !value.isActive ? value : undefined;
    });
    expect(child.requests).toHaveLength(0);
    expect(run.status).toBe('cancelled');
    expect(run.reason).toBe('child_deadline_exceeded');
    expect((await f.store.getView('s')).runs[0]!.deadlineAt).toBeNull();
    expect((await f.store.getView('s')).runs[0]!.status).toBe('completed');
    expect(await f.store.getCommand(`deadline-${run.id}`)).not.toBeNull();
  } finally {
    await f.close();
  }
});

test('actual macOS timer commits exact Run cancellation and aborts an in-flight child Model while retaining its partial body', async () => {
  let calls = 0,
    aborts = 0;
  const child: ModelAdapter = {
    async *stream(_request, { signal }) {
      calls++;
      yield { type: 'text_delta', text: 'persisted deadline partial' };
      await new Promise<void>((resolve) => {
        const abort = () => {
          aborts++;
          resolve();
        };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      signal.throwIfAborted();
      yield finish;
    },
  };
  const f = await fixture(500, child);
  try {
    await f.submit();
    await f.runtime.waitForCommand('work');
    const ref = await fact(async () => f.ref);
    const run = await fact(async () => {
      const value = (await f.store.getView(ref.childSessionId!)).runs[0];
      return value && !value.isActive ? value : undefined;
    });
    expect(calls).toBe(1);
    expect(aborts).toBe(1);
    expect(run.status).toBe('cancelled');
    expect(run.reason).toBe('child_deadline_exceeded');
    expect(
      (await f.store.listMessages(ref.childSessionId!)).some(
        (m) => m.status === 'incomplete' && m.content === 'persisted deadline partial',
      ),
    ).toBe(true);
    expect((await f.store.getView('s')).runs[0]!.status).toBe('completed');
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    await f.runtime.getView(ref.childSessionId!);
    await f.runtime.getView(ref.childSessionId!);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect(calls).toBe(1);
  } finally {
    await f.close();
  }
});

test('deadline signal stops the exact attached in-flight Tool without fabricating its externally unknown outcome or replaying a next Model', async () => {
  let starts = 0,
    stops = 0;
  const child = createFixedModel([
    [
      { type: 'tool_call', id: 'effect', name: 'fixture.effect', arguments: '{}' },
      { ...finish, type: 'finish', reason: 'tool_calls' } as ModelEvent,
    ],
    [finish],
  ]);
  const effect: ToolDefinition = {
    id: 'fixture.effect',
    version: '1',
    description: 'Harmless ledger with an unconfirmed external fact',
    inputSchema: { type: 'object' },
    async execute(_input, { signal }) {
      starts++;
      await new Promise<void>((resolve) => {
        const abort = () => {
          stops++;
          resolve();
        };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      return { outcome: 'outcome_unknown', content: 'unconfirmed effect after deadline' };
    },
  };
  const f = await fixture(500, child, effect);
  try {
    await f.submit();
    await f.runtime.waitForCommand('work');
    const ref = await fact(async () => f.ref);
    const run = await fact(async () => {
      const value = (await f.store.getView(ref.childSessionId!)).runs[0];
      return value && !value.isActive ? value : undefined;
    });
    expect(run.status).toBe('cancelled');
    expect(run.reason).toBe('child_deadline_exceeded');
    expect(starts).toBe(1);
    expect(stops).toBe(1);
    expect(child.requests).toHaveLength(1);
    const tool = (await f.store.listExecutions(ref.childSessionId!)).find(
      (value) => value.kind === 'tool',
    )!;
    expect(tool.status).toBe('outcome_unknown');
    expect(tool.result).toMatchObject({ content: 'unconfirmed effect after deadline' });
    await f.runtime.getView(ref.childSessionId!);
    await f.runtime.getView(ref.childSessionId!);
    expect(starts).toBe(1);
    expect(child.requests).toHaveLength(1);
  } finally {
    await f.close();
  }
});
