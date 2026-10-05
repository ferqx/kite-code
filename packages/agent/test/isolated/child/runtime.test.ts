import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixedModel, type ModelAdapter, type ModelEvent } from '@kite-ai/ai';
import { type ChildAgentConfiguration, createRuntime } from '../../../src';
import type { OperationRef, ToolDefinition } from '../../../src/extensions';
import { openSqliteStore } from '../../../src/sqlite';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
function call(name: string, input: unknown): ModelEvent[] {
  return [
    { type: 'tool_call', id: crypto.randomUUID(), name, arguments: JSON.stringify(input) },
    { ...finish, reason: 'tool_calls' },
  ];
}
function configuration(
  id: string,
  model: ModelAdapter,
  toolIds: string[] = [],
): ChildAgentConfiguration {
  return {
    id,
    version: '1',
    model,
    modelId: id,
    toolIds,
    snapshot: { fixture: id },
    maxConcurrentSubagents: 1,
  };
}
async function eventually(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(10);
  }
}
function gatedModel(id = 'fixture.block') {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  let cancelled = false;
  const model = createFixedModel([call(id, {}), [finish]]);
  const tool: ToolDefinition = {
    id,
    version: '1',
    description: 'Explicit finite test gate',
    inputSchema: { type: 'object' },
    async execute(_input, { signal }) {
      calls++;
      let listener!: () => void;
      const abort = new Promise<never>((_resolve, reject) => {
        listener = () => {
          cancelled = true;
          reject(signal.reason);
        };
        signal.addEventListener('abort', listener, { once: true });
        if (signal.aborted) listener();
      });
      try {
        await Promise.race([gate, abort]);
        signal.throwIfAborted();
        return { outcome: 'succeeded', content: 'gate released' };
      } finally {
        signal.removeEventListener('abort', listener);
      }
    },
  };
  return {
    model,
    tool,
    release,
    get calls() {
      return calls;
    },
    get cancelled() {
      return cancelled;
    },
  };
}
async function fixture(
  model: ModelAdapter,
  tools: ToolDefinition[],
  children: ChildAgentConfiguration[],
  denyJobs = false,
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-child-runtime-')));
  const profile = { dataRoot: join(root, 'data'), profile: 'new' };
  const store = await openSqliteStore(profile);
  const runtime = createRuntime({
    store,
    model,
    modelId: 'parent',
    modelConcurrency: 1,
    maxConcurrentSubagents: 1,
    permissions: {
      async authorize(request) {
        return { allowed: !(denyJobs && request.definitionId.startsWith('agent/')), revision: '1' };
      },
    },
    extensions: [{ id: 'fixture', version: '1', apiMajor: 1, tools }],
    childConfigurations: children,
  });
  const expectedStoreId = (await store.getMetadata()).storeId;
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'temporary',
    rootUri: `file://${root}`,
  });
  await runtime.createSession({
    expectedStoreId,
    sessionId: 's',
    workspaceId: 'w',
    commandId: 'create',
    subjectId: 'owner',
    title: 'parent',
  });
  return {
    store,
    runtime,
    profile,
    expectedStoreId,
    async submit() {
      return runtime.submitCommand({
        expectedStoreId,
        sessionId: 's',
        commandId: 'run',
        subjectId: 'owner',
        request: { kind: 'run.start', content: 'delegate explicitly' },
      });
    },
    async done() {
      await runtime.waitForCommand('run', { timeoutMs: 5000 });
    },
    async close() {
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
function delegate(execute: ToolDefinition['execute']): ToolDefinition {
  return {
    id: 'fixture.delegate',
    version: '1',
    description: 'Explicit local test delegation',
    inputSchema: { type: 'object' },
    execute,
  };
}
test('one shared model slot permits parent Tool waiting on child; child messages and Model facts stay in its Session', async () => {
  const child = createFixedModel([[{ type: 'text_delta', text: 'verified child' }, finish]]);
  const parent = createFixedModel([call('fixture.delegate', {}), [finish]]);
  let ref: OperationRef | undefined;
  const f = await fixture(
    parent,
    [
      delegate(async (_input, context) => {
        ref = await context.operations.ensure({
          key: 'child',
          request: { kind: 'agent', configurationId: 'child', input: { content: 'check' } },
        });
        const result = await context.operations.wait(ref, {
          signal: context.signal,
          timeoutMs: 4000,
        });
        return { outcome: 'succeeded', content: JSON.stringify(result.result) };
      }),
    ],
    [configuration('child', child)],
  );
  try {
    await f.submit();
    await f.done();
    expect(parent.requests).toHaveLength(2);
    expect(child.requests).toHaveLength(1);
    expect(ref?.childSessionId).toBeString();
    expect((await f.store.getExecution(ref!.executionId!))?.status).toBe('succeeded');
    expect((await f.store.getView(ref!.childSessionId!)).runs[0]?.status).toBe('completed');
    expect(
      (await f.store.listMessages(ref!.childSessionId!)).some(
        (m) => m.content === 'verified child',
      ),
    ).toBe(true);
    expect(
      (await f.store.listMessages('s')).some(
        (m) => m.role === 'assistant' && m.content === 'verified child',
      ),
    ).toBe(false);
    expect(
      (await f.store.listExecutions(ref!.childSessionId!)).filter((e) => e.kind === 'model'),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 10000);

test('detached child outlives completed parent and retains the root OS owner against a peer', async () => {
  const child = gatedModel();
  let ref: OperationRef | undefined;
  const f = await fixture(
    createFixedModel([call('fixture.delegate', {}), [finish]]),
    [
      child.tool,
      delegate(async (_input, context) => {
        ref = await context.operations.ensure({
          key: 'background',
          cancellation: 'detached',
          request: { kind: 'agent', configurationId: 'child', input: { content: 'background' } },
        });
        return { outcome: 'succeeded', content: 'delegated' };
      }),
    ],
    [configuration('child', child.model, [child.tool.id])],
  );
  const peer = await openSqliteStore(f.profile);
  try {
    await f.submit();
    await f.done();
    await eventually(async () => child.calls === 1, 'child start');
    expect((await f.store.getView('s')).runs[0]?.status).toBe('completed');
    expect((await f.store.getView(ref!.childSessionId!)).runs[0]?.isActive).toBe(true);
    expect(await peer.acquireSessionOwner('s', 'peer')).toBeNull();
    let rejected: unknown;
    try {
      await peer.acquireSessionOwner(ref!.childSessionId!, 'peer');
    } catch (error) {
      rejected = error;
    }
    expect((rejected as { code?: string })?.code).toBe('group_root_required');
    child.release();
    await eventually(
      async () => (await f.store.getExecution(ref!.executionId!))?.status === 'succeeded',
      'detached completion',
    );
    expect(child.cancelled).toBe(false);
  } finally {
    child.release();
    await peer.close();
    await f.close();
  }
}, 10000);

test('per-parent limit queues the second child before dispatch; durable root stop prevents its first Model call', async () => {
  const first = gatedModel();
  const second = createFixedModel([[finish]]);
  const refs: OperationRef[] = [];
  const f = await fixture(
    createFixedModel([call('fixture.delegate', {}), [finish]]),
    [
      first.tool,
      delegate(async (_input, context) => {
        for (const id of ['first', 'second'])
          refs.push(
            await context.operations.ensure({
              key: id,
              cancellation: 'detached',
              request: { kind: 'agent', configurationId: id, input: { content: id } },
            }),
          );
        return { outcome: 'succeeded', content: 'created both' };
      }),
    ],
    [configuration('first', first.model, [first.tool.id]), configuration('second', second)],
  );
  try {
    await f.submit();
    await f.done();
    await eventually(async () => first.calls === 1 && refs.length === 2, 'first child start');
    const queued = await f.store.getExecution(refs[1]!.executionId!);
    expect(queued?.status).toBe('planned');
    expect(queued?.reference).toBeNull();
    expect((await f.store.getView(refs[1]!.childSessionId!)).runs).toHaveLength(0);
    expect(second.requests).toHaveLength(0);
    await f.runtime.cancelSession({
      expectedStoreId: f.expectedStoreId,
      sessionId: 's',
      subjectId: 'owner',
      commandId: 'stop-root',
      includeBackground: true,
    });
    await eventually(
      async () => (await f.store.getExecution(refs[0]!.executionId!))?.status === 'outcome_unknown',
      'first child cancellation retains its unconfirmed Tool effect',
    );
    await eventually(
      async () => (await f.store.getExecution(refs[1]!.executionId!))?.status === 'cancelled',
      'queued child cancelled',
    );
    expect(second.requests).toHaveLength(0);
    expect((await f.store.getView(refs[1]!.childSessionId!)).runs).toHaveLength(0);
    expect(first.cancelled).toBe(true);
    expect((await f.store.getView(refs[0]!.childSessionId!)).runs[0]?.status).toBe('cancelled');
  } finally {
    first.release();
    await f.close();
  }
}, 10000);

test('precise cancellation of one child leaves a detached sibling running', async () => {
  const first = gatedModel('fixture.block-first');
  const second = gatedModel('fixture.block-second');
  const refs: OperationRef[] = [];
  const f = await fixture(
    createFixedModel([call('fixture.delegate', {}), [finish]]),
    [
      first.tool,
      second.tool,
      delegate(async (_input, context) => {
        for (const id of ['first', 'second'])
          refs.push(
            await context.operations.ensure({
              key: id,
              cancellation: 'detached',
              request: { kind: 'agent', configurationId: id, input: { content: id } },
            }),
          );
        return { outcome: 'succeeded', content: 'both created' };
      }),
    ],
    [
      configuration('first', first.model, [first.tool.id]),
      configuration('second', second.model, [second.tool.id]),
    ],
  );
  try {
    await f.submit();
    await f.done();
    await eventually(async () => first.calls === 1, 'first started');
    await f.runtime.cancelExecution({
      expectedStoreId: f.expectedStoreId,
      sessionId: 's',
      subjectId: 'owner',
      commandId: 'stop-one',
      executionId: refs[0]!.executionId!,
    });
    await eventually(async () => second.calls === 1, 'sibling admitted after first stop');
    expect(first.cancelled).toBe(true);
    expect(second.cancelled).toBe(false);
    expect((await f.store.getExecution(refs[0]!.executionId!))?.status).toBe('outcome_unknown');
    expect((await f.store.getView(refs[0]!.childSessionId!)).runs[0]?.status).toBe('cancelled');
    expect((await f.store.getExecution(refs[1]!.executionId!))?.cancelRequestedAt).toBeNull();
    second.release();
    await eventually(
      async () => (await f.store.getExecution(refs[1]!.executionId!))?.status === 'succeeded',
      'sibling completed',
    );
  } finally {
    first.release();
    second.release();
    await f.close();
  }
}, 10000);

test('nested child uses the same Loop with independent direct-child slots and more than twelve tool turns', async () => {
  const ledger: number[] = [];
  const refs: OperationRef[] = [];
  const parent = createFixedModel([
    call('fixture.delegate', { configurationId: 'child' }),
    [finish],
  ]);
  const child = createFixedModel([
    call('fixture.delegate', { configurationId: 'grandchild' }),
    ...Array.from({ length: 14 }, (_, turn) => call('fixture.effect', { turn })),
    [finish],
  ]);
  const grandchild = createFixedModel([[finish]]);
  const tool = delegate(async (input, context) => {
    const configurationId = (input as { configurationId: string }).configurationId;
    const ref = await context.operations.ensure({
      key: configurationId,
      request: { kind: 'agent', configurationId, input: { content: 'nested' } },
    });
    refs.push(ref);
    const result = await context.operations.wait(ref, { signal: context.signal, timeoutMs: 4000 });
    return {
      outcome: result.status === 'succeeded' ? 'succeeded' : 'failed',
      content: 'nested finished',
    };
  });
  const effect: ToolDefinition = {
    id: 'fixture.effect',
    version: '1',
    description: 'Harmless local ledger',
    inputSchema: { type: 'object', required: ['turn'], properties: { turn: { type: 'integer' } } },
    async execute(input) {
      ledger.push((input as { turn: number }).turn);
      return { outcome: 'succeeded', content: 'recorded' };
    },
  };
  const f = await fixture(
    parent,
    [tool, effect],
    [
      configuration('child', child, ['fixture.delegate', 'fixture.effect']),
      configuration('grandchild', grandchild),
    ],
  );
  try {
    await f.submit();
    await f.done();
    expect(ledger).toEqual(Array.from({ length: 14 }, (_, i) => i));
    expect(child.requests).toHaveLength(16);
    expect(grandchild.requests).toHaveLength(1);
    expect(parent.requests).toHaveLength(2);
    expect(refs).toHaveLength(2);
    expect((await f.store.getSession(refs[1]!.childSessionId!))?.parentSessionId).toBe(
      refs[0]!.childSessionId!,
    );
    for (const ref of refs)
      expect((await f.store.getExecution(ref.executionId!))?.status).toBe('succeeded');
    expect((await f.store.getView('s')).runs[0]?.status).toBe('completed');
  } finally {
    await f.close();
  }
}, 10000);

test('denied child Job and unknown configuration never call a child Model', async () => {
  for (const mode of ['denied', 'unknown'] as const) {
    const child = createFixedModel([[finish]]);
    let ref: OperationRef | undefined;
    const f = await fixture(
      createFixedModel([call('fixture.delegate', {}), [finish]]),
      [
        delegate(async (_input, context) => {
          ref = await context.operations.ensure({
            key: 'child',
            request: {
              kind: 'agent',
              configurationId: mode === 'unknown' ? 'missing' : 'child',
              input: { content: 'test' },
            },
          });
          const result = await context.operations.wait(ref, {
            signal: context.signal,
            timeoutMs: 4000,
          });
          return {
            outcome: result.status === 'succeeded' ? 'succeeded' : 'failed',
            content: 'checked',
          };
        }),
      ],
      [configuration('child', child)],
      mode === 'denied',
    );
    try {
      await f.submit();
      await f.done();
      expect(child.requests).toHaveLength(0);
      if (mode === 'unknown') {
        expect(ref).toBeUndefined();
        expect(await f.store.listSessions()).toHaveLength(1);
        expect(
          (await f.store.listExecutions('s')).find((e) => e.definitionId === 'fixture.delegate')
            ?.status,
        ).toBe('outcome_unknown');
      } else {
        expect(ref?.childSessionId).toBeString();
        expect((await f.store.getExecution(ref!.executionId!))?.status).toBe('failed');
        expect((await f.store.getView(ref!.childSessionId!)).runs).toHaveLength(0);
      }
    } finally {
      await f.close();
    }
  }
}, 10000);
