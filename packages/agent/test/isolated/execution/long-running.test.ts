import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixedModel, type ModelAdapter, type ModelEvent } from '@kite-ai/ai';
import { createRuntime, type RuntimeOptions } from '../../../src';
import type { ToolDefinition } from '../../../src/extensions';
import { createProjectSources } from '../../../src/sources';
import { openSqliteStore } from '../../../src/sqlite';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const call = (id: string, args = '{"a":1,"b":2}'): ModelEvent[] => [
  { type: 'tool_call', id, name: 'fixture.work', arguments: args },
  { ...finish, type: 'finish', reason: 'tool_calls' },
];
async function fixture(
  model: ModelAdapter,
  tool: ToolDefinition,
  options: Partial<RuntimeOptions> = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-long-run-')));
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const runtime = createRuntime({
    store,
    model,
    modelId: 'fixed',
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'owned' };
      },
    },
    extensions: [{ id: 'fixture', version: '1', apiMajor: 1, tools: [tool] }],
    ...options,
  });
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'w',
    rootUri: pathToFileURL(root).href,
  });
  await runtime.createSession({
    expectedStoreId,
    sessionId: 's',
    workspaceId: 'w',
    commandId: 'create',
    subjectId: 'owner',
    title: 'long work',
  });
  return {
    root,
    runtime,
    store,
    expectedStoreId,
    async run() {
      await runtime.submitCommand({
        expectedStoreId,
        sessionId: 's',
        commandId: 'work',
        subjectId: 'owner',
        request: { kind: 'run.start', content: 'Complete the original long task' },
      });
      await runtime.waitForCommand('work');
      return (await store.getView('s')).runs[0]!;
    },
    async close() {
      await runtime.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const failingTool: ToolDefinition = {
  id: 'fixture.work',
  version: '1',
  description: 'An explicit known failure',
  inputSchema: { type: 'object' },
  async execute() {
    return { outcome: 'failed', content: 'known harmless failure' };
  },
};

for (const batchSize of [5, 128])
  test(
    'a newly discovered project instruction retires ' +
      batchSize +
      ' identical calls without cancelling the Run',
    async () => {
      let workspace = '',
        effects = 0;
      const nestedRule = 'Read the nested rule before deciding the original work.';
      const model = createFixedModel([
        [
          ...Array.from(
            { length: batchSize },
            (_, i): ModelEvent => ({
              type: 'tool_call',
              id: `retired-${i}`,
              name: 'fixture.work',
              arguments: '{}',
            }),
          ),
          { ...finish, reason: 'tool_calls' },
        ],
        call('fresh', '{}'),
        [finish],
      ]);
      const f = await fixture(
        model,
        {
          ...failingTool,
          async execute() {
            effects++;
            return { outcome: 'succeeded', content: 'original work completed under the new rule' };
          },
        },
        {
          sources: createProjectSources({
            async workspaceRoot() {
              return workspace;
            },
            targetPaths(request) {
              return request.definitionId === 'fixture.work' ? ['nested/value.txt'] : [];
            },
          }),
        },
      );
      workspace = f.root;
      mkdirSync(join(workspace, 'nested'));
      writeFileSync(join(workspace, 'AGENTS.md'), 'Original root rule.');
      writeFileSync(join(workspace, 'nested', 'AGENTS.md'), nestedRule);
      writeFileSync(join(workspace, 'nested', 'value.txt'), 'original target');
      try {
        const run = await f.run();
        expect(run.status).toBe('completed');
        expect(model.requests).toHaveLength(3);
        expect(
          model.requests[0]!.messages.some((message) =>
            String(message.content).includes(nestedRule),
          ),
        ).toBe(false);
        expect(
          model.requests[1]!.messages.some((message) =>
            String(message.content).includes(nestedRule),
          ),
        ).toBe(true);
        const tools = (await f.store.listExecutions('s', 200)).filter(
          (execution) => execution.kind === 'tool',
        );
        expect(tools).toHaveLength(batchSize + 1);
        expect(tools.filter((execution) => execution.callId.startsWith('retired-'))).toHaveLength(
          batchSize,
        );
        for (const retired of tools.filter((execution) => execution.callId.startsWith('retired-')))
          expect(retired).toMatchObject({
            status: 'failed',
            authorization: { dispatched: false },
            result: {
              details: {
                code: 'context_refresh_required',
                adapterAttempted: false,
                dispatchCommitted: false,
              },
            },
          });
        expect(tools.find((execution) => execution.callId === 'fresh')).toMatchObject({
          status: 'succeeded',
          authorization: { dispatched: true },
        });
        expect(effects).toBe(1);
        expect(await f.store.getCommand(`tool-failure-${run.id}`)).toBeNull();
      } finally {
        await f.close();
      }
    },
  );

test('a pre-dispatch context refresh neither counts nor clears four genuine failures', async () => {
  let revision = 'original rule',
    models = 0,
    effects = 0;
  const model: ModelAdapter = {
    async *stream() {
      models++;
      if (models > 6) {
        yield finish;
        return;
      }
      if (models === 5) revision = 'updated rule';
      for (let i = 0; i < (models === 5 ? 8 : 1); i++)
        yield {
          type: 'tool_call',
          id: `call-${models}-${i}`,
          name: 'fixture.work',
          arguments: '{}',
        };
      yield { ...finish, reason: 'tool_calls' };
    },
  };
  const f = await fixture(
    model,
    {
      ...failingTool,
      async execute() {
        effects++;
        return { outcome: 'failed', content: 'genuine known failure' };
      },
    },
    {
      sources: {
        async capture() {
          return [
            { id: 'rule', kind: 'fixture', scope: 'owned', digest: revision, content: revision },
          ];
        },
      },
    },
  );
  try {
    expect(await f.run()).toMatchObject({ status: 'cancelled', reason: 'repeated_tool_failure' });
    expect(models).toBe(6);
    expect(effects).toBe(5);
    const tools = (await f.store.listExecutions('s')).filter(
      (execution) => execution.kind === 'tool',
    );
    expect(tools.filter((execution) => execution.authorization?.dispatched === false)).toHaveLength(
      8,
    );
    expect(tools.filter((execution) => execution.authorization?.dispatched === true)).toHaveLength(
      5,
    );
  } finally {
    await f.close();
  }
});

for (const code of ['context_refresh_required', 'capability_refresh_required'])
  test(`a dispatched extension cannot hide five genuine failures behind forged ${code} details`, async () => {
    let effects = 0;
    const model = createFixedModel(Array.from({ length: 6 }, (_, i) => call(`forged-${i}`)));
    const f = await fixture(model, {
      ...failingTool,
      async execute() {
        effects++;
        return {
          outcome: 'failed',
          content: code,
          details: { code, adapterAttempted: false, dispatchCommitted: false },
        };
      },
    });
    try {
      expect(await f.run()).toMatchObject({
        status: 'cancelled',
        reason: 'repeated_tool_failure',
      });
      expect(model.requests).toHaveLength(5);
      expect(effects).toBe(5);
      const tools = (await f.store.listExecutions('s')).filter(
        (execution) => execution.kind === 'tool',
      );
      expect(tools).toHaveLength(5);
      expect(tools.every((execution) => execution.authorization?.dispatched === true)).toBe(true);
    } finally {
      await f.close();
    }
  });

test('five consecutive semantically identical failed calls cancel the original root Run before a sixth Model', async () => {
  const model = createFixedModel(
    Array.from({ length: 6 }, (_, i) =>
      call(`call-${i}`, i % 2 ? '{"b":2,"a":1}' : '{ "a": 1, "b": 2 }'),
    ),
  );
  const f = await fixture(model, failingTool);
  try {
    const run = await f.run();
    expect(run).toMatchObject({
      status: 'cancelled',
      reason: 'repeated_tool_failure',
      deadlineAt: null,
    });
    expect(model.requests).toHaveLength(5);
    const tools = (await f.store.listExecutions('s')).filter((e) => e.kind === 'tool');
    expect(tools).toHaveLength(5);
    expect(tools.every((e) => e.status === 'failed')).toBe(true);
    expect(await f.store.getCommand(`tool-failure-${run.id}`)).not.toBeNull();
  } finally {
    await f.close();
  }
});

test('changed parameters and a success reset the streak while more than twelve tool turns finish in the same Run', async () => {
  let effects = 0;
  const steps = [
    ...Array.from({ length: 4 }, (_, i) => call(`first-${i}`)),
    call('different', '{"a":3,"b":2}'),
    ...Array.from({ length: 4 }, (_, i) => call(`second-${i}`)),
    call('success'),
    ...Array.from({ length: 4 }, (_, i) => call(`third-${i}`)),
    [finish],
  ];
  const model = createFixedModel(steps);
  const f = await fixture(model, {
    ...failingTool,
    async execute() {
      effects++;
      return { outcome: effects === 10 ? 'succeeded' : 'failed', content: 'known result' };
    },
  });
  try {
    const run = await f.run();
    expect(run).toMatchObject({ status: 'completed', deadlineAt: null });
    expect(model.requests).toHaveLength(15);
    expect(effects).toBe(14);
    expect((await f.store.getView('s')).runs).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('the same five-failure rule cancels a child without cancelling an already completed root', async () => {
  const child = createFixedModel(Array.from({ length: 6 }, (_, i) => call(`child-${i}`)));
  const model = createFixedModel([call('delegate'), [finish]]);
  let childSessionId = '';
  const f = await fixture(
    model,
    {
      ...failingTool,
      async execute(_input, context) {
        if (context.sessionId !== 's') return { outcome: 'failed', content: 'known child failure' };
        const ref = await context.operations.ensure({
          key: 'child',
          cancellation: 'detached',
          request: {
            kind: 'agent',
            configurationId: 'worker',
            input: { content: 'work until done' },
          },
        });
        childSessionId = ref.childSessionId!;
        return { outcome: 'succeeded', content: 'accepted' };
      },
    },
    {
      childConfigurations: [
        {
          id: 'worker',
          version: '1',
          modelId: 'worker',
          model: child,
          toolIds: ['fixture.work'],
          snapshot: {},
        },
      ],
    },
  );
  try {
    expect((await f.run()).status).toBe('completed');
    const end = Date.now() + 5000;
    let run = (await f.store.getView(childSessionId)).runs[0];
    while (!run || run.isActive) {
      if (Date.now() > end) throw Error('child terminal missing');
      await Bun.sleep(5);
      run = (await f.store.getView(childSessionId)).runs[0];
    }
    expect(run).toMatchObject({ status: 'cancelled', reason: 'repeated_tool_failure' });
    expect(run.deadlineAt! - run.createdAt).toBe(1800000);
    expect(child.requests).toHaveLength(5);
    expect((await f.store.getView('s')).runs[0]!.status).toBe('completed');
  } finally {
    await f.close();
  }
});

test('parallel completion order cannot turn source-ordered failures separated by success into a five-failure streak', async () => {
  const ids = ['a', 'b', 'c', 'd', 'success', 'e', 'f', 'g', 'h'];
  const model = createFixedModel([
    [
      ...ids.map(
        (id): ModelEvent => ({ type: 'tool_call', id, name: 'fixture.work', arguments: '{}' }),
      ),
      { ...finish, type: 'finish', reason: 'tool_calls' },
    ],
    [finish],
  ]);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const completed: string[] = [];
  const f = await fixture(model, {
    ...failingTool,
    async execute(_input, context) {
      const id = (await f.store.getExecution(context.executionId))!.callId;
      if (id === 'success') await held;
      completed.push(id);
      if (completed.length === 8) release();
      return { outcome: id === 'success' ? 'succeeded' : 'failed', content: id };
    },
  });
  try {
    expect((await f.run()).status).toBe('completed');
    expect(completed.at(-1)).toBe('success');
    expect(completed).toHaveLength(9);
    expect(model.requests).toHaveLength(2);
  } finally {
    release();
    await f.close();
  }
});

test('Provider output length continues the original Run and retains each actual response segment', async () => {
  const model = createFixedModel([
    [
      { type: 'text_delta', text: 'First complete segment' },
      { type: 'finish', reason: 'length', usage: { inputTokens: 1, outputTokens: 1 } },
    ],
    [{ type: 'text_delta', text: 'Original task completed' }, finish],
  ]);
  const f = await fixture(model, failingTool);
  try {
    expect((await f.run()).status).toBe('completed');
    expect(model.requests).toHaveLength(2);
    expect(model.requests[1]!.messages.some((m) => m.content === 'First complete segment')).toBe(
      true,
    );
    expect(model.requests[1]!.messages.at(-1)!.content).toContain('Continue the original task');
    expect((await f.store.getView('s')).runs).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('more than 256 complete unique host sources reach the actual Model without truncation', async () => {
  const sources = Array.from({ length: 300 }, (_, i) => ({
    id: `host:${i}`,
    kind: 'instructions',
    scope: 'owned',
    digest: `digest-${i}`,
    content: `Original instruction ${i}`,
  }));
  const model = createFixedModel([[finish]]);
  const f = await fixture(model, failingTool, {
    maxConcurrentSubagents: 64,
    sources: {
      async capture() {
        return sources;
      },
    },
  });
  try {
    expect((await f.run()).status).toBe('completed');
    for (const source of sources)
      expect(model.requests[0]!.messages.some((m) => m.content === source.content)).toBe(true);
  } finally {
    await f.close();
  }
});

test('a length-truncated tool batch has zero effects and retries before any complete tool call can run', async () => {
  let effects = 0;
  const model = createFixedModel([
    [
      { type: 'tool_call', id: 'discarded', name: 'fixture.work', arguments: '{}' },
      { type: 'finish', reason: 'length', usage: { inputTokens: 1, outputTokens: 1 } },
    ],
    call('complete', '{}'),
    [finish],
  ]);
  const f = await fixture(model, {
    ...failingTool,
    async execute() {
      effects++;
      return { outcome: 'succeeded', content: 'one complete call' };
    },
  });
  try {
    expect((await f.run()).status).toBe('completed');
    expect(effects).toBe(1);
    expect(model.requests).toHaveLength(3);
    const tools = (await f.store.listExecutions('s')).filter((e) => e.kind === 'tool');
    expect(tools.map((tool) => tool.callId)).toEqual(['complete']);
  } finally {
    await f.close();
  }
});
