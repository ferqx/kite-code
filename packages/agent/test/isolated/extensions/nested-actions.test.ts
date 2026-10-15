import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { type AgentRuntime, createRuntime } from '../../../src';
import type { Extension, Permissions, ToolContext } from '../../../src/extensions';
import { openSqliteStore } from '../../../src/sqlite';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
async function until<T>(read: () => Promise<T | null>) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await Bun.sleep(5);
  }
  throw Error('nested_action_test_deadline');
}
async function fixture(mode: 'allow' | 'deny' | 'cancel' | 'orphan') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-nested-action-')));
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' });
  let runtime!: AgentRuntime;
  let entered = 0,
    stopped = false,
    parentId = '';
  const expectedStoreId = (await store.getMetadata()).storeId;
  const invoke = (context: ToolContext, extra = {}) =>
    runtime.invokeActionFromTool({
      expectedStoreId,
      sessionId: 's',
      subjectId: 'owner',
      parentExecutionId: context.executionId,
      commandId: 'nested',
      request: {
        kind: 'extension.invoke',
        extensionId: 'fixture',
        actionId: 'action',
        definitionVersion: '1',
        input: {},
      },
      ...extra,
    });
  const extension: Extension = {
    id: 'fixture',
    version: '1',
    apiMajor: 1,
    actions: [
      {
        id: 'action',
        version: '1',
        description: 'Owned no-op action',
        inputSchema: { type: 'object' },
        async prepare(input) {
          return input;
        },
        async execute(_input, context) {
          entered++;
          if (mode === 'cancel') {
            await new Promise<void>((resolve) => {
              if (context.signal.aborted) resolve();
              else context.signal.addEventListener('abort', () => resolve(), { once: true });
            });
            stopped = true;
            return { outcome: 'cancelled', content: 'Owned action stopped' };
          }
          return { outcome: 'succeeded', content: 'Owned action completed' };
        },
      },
    ],
    tools: [
      {
        id: 'fixture.parent',
        version: '1',
        description: 'Own the nested request',
        inputSchema: { type: 'object' },
        async execute(_input, context) {
          parentId = context.executionId;
          await expect(invoke(context, { subjectId: 'foreign' })).rejects.toMatchObject({
            code: 'nested_action_scope_invalid',
          });
          await expect(invoke(context, { expectedStoreId: 'foreign' })).rejects.toMatchObject({
            code: 'nested_action_scope_invalid',
          });
          if (mode === 'orphan') {
            const owner = (await store.getSession('s'))!;
            await store.acceptNestedAction({
              expectedStoreId,
              sessionId: 's',
              subjectId: 'owner',
              commandId: 'orphan',
              parentExecutionId: context.executionId,
              owner: {
                sessionId: 's',
                instanceId: owner.ownerInstanceId!,
                generation: owner.ownerGeneration,
              },
              request: {
                kind: 'extension.invoke',
                extensionId: 'fixture',
                actionId: 'action',
                definitionVersion: '1',
                input: {},
              },
            });
          } else {
            const first = invoke(context);
            const second = invoke(context);
            expect(second).toBe(first);
            await first;
          }
          return { outcome: 'succeeded', content: 'Parent consumed original action receipt' };
        },
      },
    ],
  };
  const permissions: Permissions = {
    async authorize(request) {
      return mode === 'deny' && request.definitionId === 'fixture/action'
        ? { allowed: false, revision: 'parent-ceiling', reason: 'parent_denied' }
        : { allowed: true, revision: 'parent-ceiling' };
    },
  };
  const model = createFixedModel([
    [
      { type: 'tool_call', id: 'call', name: 'fixture.parent', arguments: '{}' },
      { ...finish, reason: 'tool_calls' },
    ],
    [finish],
  ]);
  runtime = createRuntime({
    store,
    extensions: [extension],
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'global-allows' };
      },
    },
    resolveRunConfiguration: async () => ({ model, modelId: 'fixed', permissions, snapshot: null }),
  });
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'temporary',
    rootUri: pathToFileURL(root).href,
  });
  await runtime.createSession({
    expectedStoreId,
    sessionId: 's',
    workspaceId: 'w',
    commandId: 'create',
    subjectId: 'owner',
    title: 'nested',
  });
  await runtime.submitCommand({
    expectedStoreId,
    commandId: 'root',
    sessionId: 's',
    subjectId: 'owner',
    request: { kind: 'run.start', content: 'Run owned action' },
  });
  return {
    runtime,
    store,
    expectedStoreId,
    entered: () => entered,
    stopped: () => stopped,
    parentId: () => parentId,
    done: () =>
      until(async () => {
        const command = await store.getCommand('root');
        if (command?.status === 'rejected' || command?.status === 'needs_review')
          throw Error(JSON.stringify(command.receipt));
        const runId = (command?.receipt as { runId?: string })?.runId;
        const run = runId ? await store.getRun(runId) : null;
        return run && !run.isActive ? run : null;
      }),
    close: async () => {
      await runtime.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test('nested ordinary Action retains exact parent root work, original actor and single dispatch', async () => {
  const f = await fixture('allow');
  try {
    await f.done();
    const action = (await f.store.listExecutions('s')).find(
      (e) => e.definitionId === 'fixture/action',
    )!;
    const parent = await f.store.getExecution(f.parentId());
    expect(action.status).toBe('succeeded');
    expect(action.parentExecutionId).toBe(parent!.id);
    expect(action.rootWorkCommandId).toBe(parent!.rootWorkCommandId);
    expect(action.rootWorkSeq).toBe(parent!.rootWorkSeq);
    expect(action.runId).toBeNull();
    expect(f.entered()).toBe(1);
  } finally {
    await f.close();
  }
});
test('captured parent ceiling rejects an Action that global host policy would allow', async () => {
  const f = await fixture('deny');
  try {
    await f.done();
    expect(f.entered()).toBe(0);
    expect(
      (await f.store.listExecutions('s')).find((e) => e.definitionId === 'fixture/action')?.status,
    ).toBe('failed');
  } finally {
    await f.close();
  }
});
test('parent cancellation aborts and awaits the actual nested Action lifetime', async () => {
  const f = await fixture('cancel');
  try {
    await until(async () => (f.entered() ? true : null));
    const root = await f.store.getCommand('root');
    const runId = (root!.receipt as { runId: string }).runId;
    await f.runtime.cancelRun({
      expectedStoreId: f.expectedStoreId,
      sessionId: 's',
      subjectId: 'owner',
      commandId: 'cancel',
      runId,
    });
    await f.done();
    expect(f.stopped()).toBe(true);
    expect(
      (await f.store.listExecutions('s')).find((e) => e.definitionId === 'fixture/action')?.status,
    ).not.toBe('succeeded');
  } finally {
    await f.close();
  }
});
test('an accepted nested intent without the original hot permission binding never enters ordinary pump dispatch', async () => {
  const f = await fixture('orphan');
  try {
    await f.done();
    const command = await until(async () => {
      const row = await f.store.getCommand('orphan');
      return row?.status === 'needs_review' ? row : null;
    });
    expect(command.receipt).toMatchObject({ reason: 'nested_action_recovery_required' });
    expect(f.entered()).toBe(0);
  } finally {
    await f.close();
  }
});
