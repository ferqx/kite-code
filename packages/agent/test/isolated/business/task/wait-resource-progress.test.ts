import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelAdapter, ModelEvent } from '@kite-ai/ai';
import type { ToolDefinition } from '../../../../src/extensions';
import { createTaskExtension } from '../../../../src/extensions/task';
import { createRuntime } from '../../../../src/runtime';
import { openSqliteStore } from '../../../../src/sqlite';

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

test('parent and child event waits leave one Model slot and independent one-child groups available to the grandchild', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-wait-resource-')));
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const identity = { expectedStoreId, sessionId: 'parent', subjectId: 'owner' };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  const hold: ToolDefinition = {
    id: 'fixture.hold',
    version: '1',
    description: 'Finite local grandchild work',
    inputSchema: { type: 'object', additionalProperties: false },
    async execute() {
      entered = true;
      await gate;
      return { outcome: 'succeeded', content: 'Original grandchild work settled' };
    },
  };
  let parentCalls = 0,
    childCalls = 0,
    leafCalls = 0;
  const delegate = (next: () => number, prompt: string, preset?: string): ModelAdapter => ({
    async *stream() {
      const stage = next();
      for (const event of stage === 0
        ? call('spawn_agent', { prompt, ...(preset ? { preset } : {}) })
        : stage === 1
          ? call('wait_agent_events', { after_seq: '0', wait_ms: 180000 })
          : [
              { type: 'text_delta', text: 'Original delegated work finished' } as ModelEvent,
              finish,
            ])
        yield event;
    },
  });
  const parent = delegate(() => parentCalls++, 'Original worker responsibility');
  const child = delegate(() => childCalls++, 'Original leaf responsibility', 'leaf');
  const leaf: ModelAdapter = {
    async *stream() {
      for (const event of leafCalls++ === 0
        ? call(hold.id, {})
        : [{ type: 'text_delta', text: 'Original leaf finished' } as ModelEvent, finish])
        yield event;
    },
  };
  const task = createTaskExtension({
    defaultRole: 'worker',
    presets: ['leaf'],
    roles: [
      { id: 'worker', configurationId: 'worker', description: 'Trusted worker' },
      { id: 'leaf', configurationId: 'leaf', description: 'Trusted leaf' },
    ],
  });
  const runtime = createRuntime({
    store,
    model: parent,
    modelId: 'parent',
    modelConcurrency: 1,
    maxConcurrentSubagents: 1,
    extensions: [{ ...task, tools: [...task.tools!, hold] }],
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'fixture' };
      },
    },
    childConfigurations: [
      {
        id: 'worker',
        version: '1',
        model: child,
        modelId: 'worker',
        toolIds: ['task.spawn', 'task.events', hold.id],
        snapshot: {},
      },
      { id: 'leaf', version: '1', model: leaf, modelId: 'leaf', toolIds: [hold.id], snapshot: {} },
    ],
  });
  const until = async <T>(read: () => Promise<T | undefined>): Promise<T> => {
    const deadline = Date.now() + 4000;
    for (;;) {
      const result = await read();
      if (result !== undefined) return result;
      if (Date.now() >= deadline) throw Error('original_wait_resource_boundary_not_reached');
      await Bun.sleep(5);
    }
  };
  try {
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'private',
      rootUri: pathToFileURL(root).href,
    });
    await runtime.createSession({
      ...identity,
      commandId: 'create',
      workspaceId: 'w',
      title: 'parent',
    });
    await runtime.submitCommand({
      ...identity,
      commandId: 'work',
      request: { kind: 'run.start', content: 'Original root responsibility' },
    });
    const boundary = await until(async () => {
      const parentExecutions = await store.listExecutions('parent');
      const carrier = parentExecutions.find((execution) => execution.childSessionId !== null);
      if (!carrier?.childSessionId) return;
      const childExecutions = await store.listExecutions(carrier.childSessionId);
      const leafCarrier = childExecutions.find((execution) => execution.childSessionId !== null);
      const parentWait = parentExecutions.find(
        (execution) => execution.definitionId === 'task.events',
      );
      const childWait = childExecutions.find(
        (execution) => execution.definitionId === 'task.events',
      );
      if (
        !entered ||
        !leafCarrier?.childSessionId ||
        parentWait?.status !== 'dispatching' ||
        childWait?.status !== 'dispatching'
      )
        return;
      return { carrier, leafCarrier, parentWait, childWait };
    });
    expect([parentCalls, childCalls, leafCalls]).toEqual([2, 2, 1]);
    expect(boundary.parentWait.runId).toBe(
      (await store.getExecution(boundary.carrier.parentExecutionId!))!.runId,
    );
    expect(boundary.childWait.runId).toBe(
      (await store.getExecution(boundary.leafCarrier.parentExecutionId!))!.runId,
    );
    expect(boundary.carrier.originStoreId).toBe(expectedStoreId);
    expect(boundary.leafCarrier.originStoreId).toBe(expectedStoreId);
    expect(await store.getSession(boundary.leafCarrier.childSessionId!)).toMatchObject({
      parentSessionId: boundary.carrier.childSessionId,
      rootSessionId: 'parent',
      workspaceId: 'w',
    });
    expect(boundary.leafCarrier.rootWorkCommandId).toBe(boundary.carrier.rootWorkCommandId);
    release();
    await runtime.waitForCommand('work', { timeoutMs: 4000 });
    const sessions = [
      'parent',
      boundary.carrier.childSessionId!,
      boundary.leafCarrier.childSessionId!,
    ];
    expect(new Set(sessions).size).toBe(3);
    for (const sessionId of sessions) {
      const runs = (await store.getView(sessionId)).runs;
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        sessionId,
        originStoreId: expectedStoreId,
        status: 'completed',
        isActive: false,
      });
    }
    for (const execution of [
      boundary.carrier,
      boundary.leafCarrier,
      boundary.parentWait,
      boundary.childWait,
    ])
      expect(await store.getExecution(execution.id)).toMatchObject({
        id: execution.id,
        originStoreId: expectedStoreId,
        status: 'succeeded',
      });
    expect([parentCalls, childCalls, leafCalls]).toEqual([3, 3, 2]);
  } finally {
    release();
    try {
      const active = (await store.getView('parent')).runs.find((run) => run.isActive);
      if (active)
        await runtime.cancelRun({ ...identity, commandId: 'cleanup-cancel', runId: active.id });
    } finally {
      await runtime.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});
