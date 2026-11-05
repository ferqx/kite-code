import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelAdapter, ModelEvent } from '@kite-ai/ai';
import type { Extension, OperationRef } from '../../../../src/extensions';
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

test('parent and direct child waits release the Model slot while a controlled Job retains its process permit', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-wait-resource-')));
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const identity = { expectedStoreId, sessionId: 'parent', subjectId: 'owner' };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let original: OperationRef | undefined;
  let starts = 0,
    observations = 0,
    disposals = 0,
    effects = 0;
  const lifecycle: string[] = [];
  const work: Extension = {
    id: 'fixture',
    version: '1',
    apiMajor: 1,
    tools: [
      {
        id: 'fixture.launch',
        version: '1',
        description: 'Start one finite controlled operation',
        inputSchema: { type: 'object', additionalProperties: false },
        async execute(_input, context) {
          original = await context.operations.ensure({
            key: 'original',
            cancellation: 'attached',
            request: {
              kind: 'job',
              definitionId: 'fixture.held',
              definitionVersion: '1',
              input: {},
            },
          });
          return { outcome: 'succeeded', content: JSON.stringify(original) };
        },
      },
      {
        id: 'fixture.wait',
        version: '1',
        description: 'Wait for the original controlled operation',
        inputSchema: { type: 'object', additionalProperties: false },
        async execute(_input, context) {
          if (!original) throw Error('original_operation_missing');
          const result = await context.operations.wait(original, { signal: context.signal });
          return {
            outcome: result.status === 'succeeded' ? 'succeeded' : 'failed',
            content: 'Original work settled',
          };
        },
      },
      {
        id: 'fixture.probe',
        version: '1',
        description: 'One finite process-permit probe',
        inputSchema: { type: 'object', additionalProperties: false },
        resources: { slot: 'process' },
        async execute() {
          lifecycle.push('probe-effect');
          effects++;
          return { outcome: 'succeeded', content: 'Process permit acquired' };
        },
      },
    ],
    jobs: [
      {
        id: 'fixture.held',
        version: '1',
        description: 'Finite controlled process permit owner',
        inputSchema: { type: 'object', additionalProperties: false },
        resources: { slot: 'process' },
        async start(_input, context) {
          lifecycle.push('job-start');
          starts++;
          return { reference: { executionId: context.executionId } };
        },
        async *observe() {
          lifecycle.push('job-observe');
          observations++;
          await gate;
          lifecycle.push('job-terminal');
          yield {
            type: 'terminal',
            supervision: 'ended',
            result: { outcome: 'succeeded', content: 'Original work finished' },
          };
        },
        async cancel() {
          release();
          return { status: 'stopped' };
        },
        async dispose() {
          lifecycle.push('job-dispose');
          disposals++;
        },
      },
    ],
  };
  let parentCalls = 0,
    childCalls = 0,
    probeCalls = 0;
  const parent: ModelAdapter = {
    async *stream(request) {
      const independent =
        (await store.getExecution(request.requestId))?.sessionId === 'independent';
      const stage = independent ? probeCalls++ : parentCalls++;
      for (const event of independent
        ? stage === 0
          ? call('fixture.probe', {})
          : [finish]
        : stage === 0
          ? call('spawn_agent', { prompt: 'Original worker responsibility' })
          : stage === 1
            ? call('wait_agent_events', { after_seq: '0', wait_ms: 180000 })
            : [finish])
        yield event;
    },
  };
  const child: ModelAdapter = {
    async *stream() {
      const stage = childCalls++;
      for (const event of stage === 0
        ? call('fixture.launch', {})
        : stage === 1
          ? call('fixture.wait', {})
          : [finish])
        yield event;
    },
  };
  const task = createTaskExtension({
    defaultRole: 'worker',
    roles: [{ id: 'worker', configurationId: 'worker', description: 'Trusted worker' }],
  });
  const runtime = createRuntime({
    store,
    model: parent,
    modelId: 'parent',
    modelConcurrency: 1,
    processConcurrency: 1,
    maxConcurrentSubagents: 1,
    extensions: [task, work],
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
        toolIds: ['fixture.launch', 'fixture.wait'],
        snapshot: {},
      },
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
      if (!carrier?.childSessionId || !original?.executionId) return;
      const childExecutions = await store.listExecutions(carrier.childSessionId);
      const parentWait = parentExecutions.find(
        (execution) => execution.definitionId === 'task.events',
      );
      const childWait = childExecutions.find(
        (execution) => execution.definitionId === 'fixture.wait',
      );
      const job = await store.getExecution(original.executionId);
      if (
        observations !== 1 ||
        parentWait?.status !== 'dispatching' ||
        childWait?.status !== 'dispatching' ||
        job?.status !== 'running'
      )
        return;
      return { carrier, parentWait, childWait, job };
    });
    expect([parentCalls, childCalls, probeCalls]).toEqual([2, 2, 0]);
    expect(starts).toBe(1);
    expect(boundary.parentWait.runId).toBe(
      (await store.getExecution(boundary.carrier.parentExecutionId!))!.runId,
    );
    expect(boundary.job).toMatchObject({
      kind: 'job',
      definitionId: 'fixture.held',
      definitionVersion: '1',
      sessionId: boundary.carrier.childSessionId,
      runId: null,
      rootWorkCommandId: boundary.carrier.rootWorkCommandId,
      originStoreId: expectedStoreId,
    });
    expect(await store.getExecution(boundary.job.parentExecutionId!)).toMatchObject({
      kind: 'tool',
      definitionId: 'fixture.launch',
      sessionId: boundary.carrier.childSessionId,
      runId: boundary.childWait.runId,
    });
    expect(await store.getSession(boundary.carrier.childSessionId!)).toMatchObject({
      parentSessionId: 'parent',
      rootSessionId: 'parent',
      workspaceId: 'w',
    });
    expect(
      (await store.listExecutions(boundary.carrier.childSessionId!)).filter(
        (execution) => execution.childSessionId !== null,
      ),
    ).toEqual([]);
    await runtime.createSession({
      ...identity,
      sessionId: 'independent',
      commandId: 'create-probe',
      workspaceId: 'w',
      title: 'independent root',
    });
    await runtime.submitCommand({
      ...identity,
      sessionId: 'independent',
      commandId: 'probe',
      request: { kind: 'run.start', content: 'Independent process probe' },
    });
    const probe = await until(async () =>
      (await store.listExecutions('independent')).find(
        (execution) => execution.definitionId === 'fixture.probe',
      ),
    );
    expect(probeCalls).toBe(1);
    expect(probe.status).toBe('planned');
    expect(effects).toBe(0);
    expect((await store.getExecution(boundary.job.id))?.status).toBe('running');
    expect((await store.getExecution(boundary.parentWait.id))?.status).toBe('dispatching');
    expect((await store.getExecution(boundary.childWait.id))?.status).toBe('dispatching');
    release();
    await Promise.all([
      runtime.waitForCommand('work', { timeoutMs: 4000 }),
      runtime.waitForCommand('probe', { timeoutMs: 4000 }),
    ]);
    const sessions = ['parent', boundary.carrier.childSessionId!, 'independent'];
    expect(new Set(sessions).size).toBe(3);
    expect(await store.getSession('independent')).toMatchObject({
      parentSessionId: null,
      rootSessionId: 'independent',
    });
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
      boundary.parentWait,
      boundary.childWait,
      boundary.job,
      probe,
    ])
      expect(await store.getExecution(execution.id)).toMatchObject({
        id: execution.id,
        originStoreId: expectedStoreId,
        status: 'succeeded',
      });
    expect(
      (await store.listExecutions(boundary.carrier.childSessionId!))
        .filter((execution) => execution.definitionId === 'fixture.held')
        .map((execution) => execution.id),
    ).toEqual([boundary.job.id]);
    expect(
      (await store.listExecutions('parent')).filter(
        (execution) => execution.childSessionId !== null,
      ),
    ).toHaveLength(1);
    expect([starts, observations, disposals, effects]).toEqual([1, 1, 1, 1]);
    expect(lifecycle).toEqual([
      'job-start',
      'job-observe',
      'job-terminal',
      'job-dispose',
      'probe-effect',
    ]);
    expect([parentCalls, childCalls, probeCalls]).toEqual([3, 3, 2]);
  } finally {
    release();
    try {
      for (const sessionId of ['parent', 'independent']) {
        if (!(await store.getSession(sessionId))) continue;
        const active = (await store.getView(sessionId)).runs.find((run) => run.isActive);
        if (active)
          await runtime.cancelRun({
            ...identity,
            sessionId,
            commandId: `cleanup-${sessionId}`,
            runId: active.id,
          });
      }
    } finally {
      await runtime.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});
