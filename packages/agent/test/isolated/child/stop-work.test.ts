import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixedModel, type ModelAdapter, type ModelEvent } from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import type { OperationRef, ToolDefinition } from '../../../src/extensions';
import { openSqliteStore } from '../../../src/sqlite';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const calls = (...entries: { name: string; scope?: string }[]): ModelEvent[] => [
  ...entries.map(({ name, scope }) => ({
    type: 'tool_call' as const,
    id: crypto.randomUUID(),
    name,
    arguments: JSON.stringify(scope ? { scope } : {}),
  })),
  { ...finish, reason: 'tool_calls' },
];
function gate() {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release };
}
async function until(check: () => Promise<boolean>, label: string) {
  const end = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() >= end) throw Error(`stop_work_fixture_timeout:${label}`);
    await Bun.sleep(5);
  }
}
async function waitGate(ready: Promise<void>, signal: AbortSignal) {
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    await Promise.race([ready, cancelled]);
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

test('a real general child stop_work cancels only its original attached work and preserves its succeeded result', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-child-stop-work-')));
  const profile = { dataRoot: join(root, 'data'), profile: 'owned' };
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  const base = { expectedStoreId, subjectId: 'owner' };
  const gates = new Map(
    ['stop-child', 'attached-child', 'detached-child', 'foreign', 'new-message'].map((scope) => [
      scope,
      gate(),
    ]),
  );
  const entered = new Set<string>();
  const aborted = new Set<string>();
  const effects: string[] = [];
  const children = new Map<string, OperationRef>();
  const parentModel = createFixedModel([
    calls({ name: 'fixture.delegate' }, { name: 'fixture.effect', scope: 'unstarted-sibling' }),
    [finish],
  ]);
  const foreignModel = createFixedModel([
    calls({ name: 'fixture.hold', scope: 'foreign' }),
    calls({ name: 'fixture.effect', scope: 'foreign' }),
    [finish],
  ]);
  const nextModel = createFixedModel([
    calls({ name: 'fixture.hold', scope: 'new-message' }),
    calls({ name: 'fixture.effect', scope: 'new-message' }),
    [finish],
  ]);
  const childModels = new Map([
    ['stop-child', createFixedModel([calls({ name: 'fixture.stop' }), [finish]])],
    [
      'attached-child',
      createFixedModel([calls({ name: 'fixture.hold', scope: 'attached-child' }), [finish]]),
    ],
    [
      'detached-child',
      createFixedModel([calls({ name: 'fixture.hold', scope: 'detached-child' }), [finish]]),
    ],
  ]);
  const childModel: ModelAdapter = {
    async *stream(request, context) {
      const material = JSON.stringify(request.messages);
      const key = [...childModels.keys()].find((scope) => material.includes(scope));
      if (!key) throw Error('original_child_assignment_missing');
      yield* childModels.get(key)!.stream(request, context);
    },
  };
  const rootModel: ModelAdapter = {
    async *stream(request, context) {
      const material = JSON.stringify(request.messages);
      const selected = material.includes('foreign-root-work')
        ? foreignModel
        : material.includes('new-explicit-message')
          ? nextModel
          : parentModel;
      yield* selected.stream(request, context);
    },
  };
  const tools: ToolDefinition[] = [
    {
      id: 'fixture.delegate',
      version: '1',
      description: 'Create actual attached and detached direct general children',
      inputSchema: { type: 'object' },
      async execute(_input, context) {
        for (const scope of childModels.keys())
          children.set(
            scope,
            await context.operations.ensure({
              key: scope,
              ...(scope === 'detached-child' ? { cancellation: 'detached' as const } : {}),
              request: {
                kind: 'agent',
                configurationId: 'general',
                input: { content: scope },
              },
            }),
          );
        await context.operations.wait(children.get('stop-child')!, { signal: context.signal });
        return { outcome: 'succeeded', content: 'original children observed' };
      },
    },
    {
      id: 'fixture.stop',
      version: '1',
      description: 'Trusted business decision stops only the current original work',
      inputSchema: { type: 'object' },
      async execute(_input, context) {
        entered.add('stop-child');
        await waitGate(gates.get('stop-child')!.ready, context.signal);
        return {
          outcome: 'succeeded',
          content: '未批准本次计划，已结束当前轮次。',
          details: { status: 'not_approved', decision: 'deny', feedback: '原反馈 雪🙂' },
          control: { kind: 'stop_work' },
        };
      },
    },
    {
      id: 'fixture.hold',
      version: '1',
      description: 'A harmless actual Tool keeps its original cancellation scope observable',
      inputSchema: {
        type: 'object',
        properties: { scope: { type: 'string' } },
        required: ['scope'],
      },
      async execute(input, context) {
        const scope = (input as { scope: string }).scope;
        entered.add(scope);
        try {
          await waitGate(gates.get(scope)!.ready, context.signal);
          return { outcome: 'succeeded', content: `released ${scope}` };
        } catch (error) {
          aborted.add(scope);
          throw error;
        }
      },
    },
    {
      id: 'fixture.effect',
      version: '1',
      description: 'One harmless exact effect',
      inputSchema: {
        type: 'object',
        properties: { scope: { type: 'string' } },
        required: ['scope'],
      },
      async execute(input) {
        effects.push((input as { scope: string }).scope);
        return { outcome: 'succeeded', content: 'one effect' };
      },
    },
  ];
  const runtime = createRuntime({
    store,
    model: rootModel,
    modelId: 'root',
    modelConcurrency: 4,
    maxConcurrentSubagents: 4,
    permissions: {
      toolDispatchOrder: 'model',
      authorize: async (request) =>
        request.definitionId === 'fixture.effect' &&
        (request.input as { scope?: string }).scope === 'unstarted-sibling'
          ? {
              allowed: false,
              revision: 'original-pending-sibling-policy',
              approval: { request: { reason: 'independent exact sibling approval' } },
            }
          : { allowed: true, revision: 'original-policy' },
    },
    extensions: [{ id: 'fixture', version: '1', apiMajor: 1, tools }],
    childConfigurations: [
      {
        id: 'general',
        version: '1',
        model: childModel,
        modelId: 'general',
        toolIds: tools.map((tool) => tool.id),
        snapshot: { roleId: 'general', fixture: 'stop-work' },
      },
    ],
  });
  let closed = false;
  try {
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'owned',
      rootUri: pathToFileURL(root).href,
    });
    for (const sessionId of ['s', 'foreign'])
      await runtime.createSession({
        ...base,
        sessionId,
        commandId: `create-${sessionId}`,
        workspaceId: 'w',
        title: sessionId,
      });
    await runtime.submitCommand({
      ...base,
      sessionId: 'foreign',
      commandId: 'foreign-work',
      request: { kind: 'run.start', content: 'foreign-root-work' },
    });
    await runtime.submitCommand({
      ...base,
      sessionId: 's',
      commandId: 'work',
      request: { kind: 'run.start', content: 'delegate the three original child assignments' },
    });
    await until(
      async () =>
        ['stop-child', 'attached-child', 'detached-child', 'foreign'].every((scope) =>
          entered.has(scope),
        ),
      'original-child-and-foreign-tools-entered',
    );
    expect(children.size).toBe(3);
    for (const ref of children.values()) {
      expect((await store.getExecution(ref.executionId!))?.definitionId).toBe('agent/general');
      expect(ref.childSessionId).toBeString();
    }
    await until(
      async () =>
        (
          await runtime.listInteractions({ ...base, sessionId: 's', state: 'pending' })
        ).interactions.some((card) => card.definitionId === 'fixture.effect'),
      'independent-sibling-human-approval-pending',
    );
    const pendingSibling = (
      await runtime.listInteractions({ ...base, sessionId: 's', state: 'pending' })
    ).interactions.find((card) => card.definitionId === 'fixture.effect')!;
    expect(effects).toEqual([]);
    gates.get('stop-child')!.release();
    await runtime.waitForCommand('work', { timeoutMs: 5000 });
    await until(async () => aborted.has('attached-child'), 'attached-original-child-cancelled');
    await until(
      async () =>
        (await store.getView(children.get('attached-child')!.childSessionId!)).runs[0]?.isActive ===
        false,
      'attached-child-run-settled',
    );
    const rootRun = (await store.getView('s')).runs[0]!;
    expect(rootRun.status).toBe('cancelled');
    expect(rootRun.isActive).toBe(false);
    expect((await store.getCommand('work'))?.cancelRequestedAt).not.toBeNull();
    expect(parentModel.requests).toHaveLength(1);
    expect(childModels.get('stop-child')!.requests).toHaveLength(1);
    expect(childModels.get('attached-child')!.requests).toHaveLength(1);
    const stoppedRows = await store.listExecutions(children.get('stop-child')!.childSessionId!);
    const stoppedTool = stoppedRows.find((row) => row.definitionId === 'fixture.stop')!;
    expect(stoppedTool.status).toBe('succeeded');
    expect(stoppedTool.result).toMatchObject({
      outcome: 'succeeded',
      content: '未批准本次计划，已结束当前轮次。',
      details: { status: 'not_approved', decision: 'deny', feedback: '原反馈 雪🙂' },
      control: { kind: 'stop_work' },
    });
    expect(
      (await store.listMessages(stoppedTool.sessionId)).filter(
        (message) => message.role === 'tool' && message.toolCallId === stoppedTool.callId,
      ),
    ).toHaveLength(1);
    const stopCommand = await store.getCommand(`tool-stop-${stoppedTool.id}`);
    expect(stopCommand).toMatchObject({
      sessionId: 's',
      subjectId: 'owner',
      status: 'applied',
      request: { kind: 'command.cancel', targetCommandId: 'work' },
    });
    const sibling = (await store.listExecutions('s')).find(
      (row) => row.definitionId === 'fixture.effect',
    )!;
    expect(sibling.authorization?.dispatched).not.toBe(true);
    expect(effects).toEqual([]);
    expect(
      await store.getInteraction({ ...base, sessionId: 's', interactionId: pendingSibling.id }),
    ).toMatchObject({ state: 'cancelled', acceptedDecisionRevision: null });
    expect(
      (await store.getExecution(children.get('attached-child')!.executionId!))?.cancelRequestedAt,
    ).not.toBeNull();
    expect(
      (await store.getView(children.get('attached-child')!.childSessionId!)).runs[0]?.status,
    ).toBe('cancelled');
    expect(
      (await store.getView(children.get('detached-child')!.childSessionId!)).runs[0]?.isActive,
    ).toBe(true);
    expect(aborted.has('detached-child')).toBe(false);
    expect(aborted.has('foreign')).toBe(false);
    expect(
      (await store.getExecution(children.get('detached-child')!.executionId!))?.cancelRequestedAt,
    ).toBeNull();
    expect((await store.getCommand('foreign-work'))?.cancelRequestedAt).toBeNull();
    expect((await store.getView('foreign')).runs[0]!.isActive).toBe(true);

    await runtime.submitCommand({
      ...base,
      sessionId: 's',
      commandId: 'next-work',
      request: {
        kind: 'input.follow_up',
        content: 'new-explicit-message',
        afterRunId: rootRun.id,
        contextSelectionId: (await store.getSession('s'))!.contextSelectionId,
      },
    });
    await until(async () => entered.has('new-message'), 'new-explicit-message-admitted');
    expect(
      await runtime.cancelCommand({
        ...base,
        sessionId: 's',
        commandId: stopCommand!.id,
        targetCommandId: 'work',
      }),
    ).toEqual(stopCommand!);
    expect(aborted.has('new-message')).toBe(false);
    expect((await store.getCommand('next-work'))?.cancelRequestedAt).toBeNull();
    gates.get('new-message')!.release();
    gates.get('foreign')!.release();
    gates.get('detached-child')!.release();
    await runtime.waitForCommand('next-work', { timeoutMs: 5000 });
    await runtime.waitForCommand('foreign-work', { timeoutMs: 5000 });
    await until(
      async () =>
        (await store.getExecution(children.get('detached-child')!.executionId!))?.status ===
        'succeeded',
      'original-detached-child-completed',
    );
    expect(effects.sort()).toEqual(['foreign', 'new-message']);
    expect(
      (await store.getView('s')).runs.find((run) => run.originCommandId === 'next-work')?.status,
    ).toBe('completed');
    expect(parentModel.requests).toHaveLength(1);
    expect(childModels.get('stop-child')!.requests).toHaveLength(1);
    expect(childModels.get('attached-child')!.requests).toHaveLength(1);
    expect(childModels.get('detached-child')!.requests).toHaveLength(2);
    expect(foreignModel.requests).toHaveLength(3);
    expect(nextModel.requests).toHaveLength(3);
    const counts = [...childModels.values()].map((model) => model.requests.length);
    const stoppedSnapshot = await store.getExecution(stoppedTool.id);
    const cursor = (await store.getMetadata()).lastChangeCursor;
    await runtime.close();
    closed = true;
    const cold = await openSqliteStore({ ...profile, mode: 'readonly' });
    try {
      expect(await cold.getExecution(stoppedTool.id)).toEqual(stoppedSnapshot);
      expect(await cold.getCommand(stopCommand!.id)).toEqual(stopCommand!);
      expect((await cold.getMetadata()).lastChangeCursor).toBe(cursor);
      expect([...childModels.values()].map((model) => model.requests.length)).toEqual(counts);
      expect(effects).toEqual(['foreign', 'new-message']);
    } finally {
      await cold.close();
    }
  } finally {
    for (const held of gates.values()) held.release();
    if (!closed) await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
