import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import type { Extension, OperationRef, ToolDefinition } from '../../../src/extensions';
import { openSqliteStore } from '../../../src/sqlite';

async function waitUntil(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 4000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error('fixture_boundary_timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('ordinary detached Tool preserves its sealed cancellation edge through actual planning and exact parent cancellation', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-detached-tool-')));
  const store = await openSqliteStore({ dataRoot: join(directory, 'data'), profile: 'test' });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const starts = new Map<string, { executionId: string; signal: AbortSignal }>();
  const refs = new Map<string, OperationRef>();
  let parentExecutionId = '';
  let effects = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const child: ToolDefinition = {
    id: 'fixture.child',
    version: '1',
    description: 'A controlled harmless ordinary Tool',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { edge: { enum: ['attached', 'detached'] } },
      required: ['edge'],
    },
    async execute(input, context) {
      const edge = (input as { edge: string }).edge;
      starts.set(edge, { executionId: context.executionId, signal: context.signal });
      await new Promise<void>((resolve) => {
        const abort = () => resolve();
        context.signal.addEventListener('abort', abort, { once: true });
        if (context.signal.aborted) resolve();
        void gate.then(() => {
          context.signal.removeEventListener('abort', abort);
          resolve();
        });
      });
      if (context.signal.aborted)
        return { outcome: 'cancelled', content: 'Harmless fixture stopped before its effect' };
      effects++;
      return { outcome: 'succeeded', content: 'One actual effect' };
    },
  };
  const launch: ToolDefinition = {
    id: 'fixture.launch',
    version: '1',
    description: 'Create two accurately scoped ordinary Tool operations',
    inputSchema: { type: 'object', additionalProperties: false },
    async execute(_input, context) {
      parentExecutionId = context.executionId;
      for (const cancellation of ['attached', 'detached'] as const) {
        const request = {
          key: cancellation,
          cancellation,
          request: {
            kind: 'tool' as const,
            definitionId: child.id,
            definitionVersion: child.version,
            input: { edge: cancellation },
          },
        };
        const first = await context.operations.ensure(request);
        const second = await context.operations.ensure(request);
        if (first.commandId !== second.commandId) throw new Error('original_operation_changed');
        refs.set(cancellation, first);
      }
      await new Promise<void>((resolve) => {
        if (context.signal.aborted) resolve();
        else context.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return { outcome: 'cancelled', content: 'Explicit parent cancellation observed' };
    },
  };
  const finish: Extract<ModelEvent, { type: 'finish' }> = {
    type: 'finish',
    reason: 'stop',
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  const model = createFixedModel([
    [
      { type: 'tool_call', id: 'launch', name: launch.id, arguments: '{}' },
      { ...finish, reason: 'tool_calls' },
    ],
    [finish],
  ]);
  const extension: Extension = {
    id: 'fixture',
    version: '1',
    apiMajor: 1,
    tools: [launch, child],
  };
  const runtime = createRuntime({
    store,
    model,
    modelId: 'fixed',
    extensions: [extension],
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
  });
  try {
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      rootUri: `file://${directory}`,
      name: 'fixture',
    });
    await runtime.createSession({
      expectedStoreId,
      sessionId: 's',
      commandId: 'create',
      subjectId: 'owner',
      workspaceId: 'w',
      title: 'fixture',
    });
    await runtime.submitCommand({
      expectedStoreId,
      sessionId: 's',
      commandId: 'run',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'ordinary operations' },
    });
    await waitUntil(() => starts.size === 2);
    const attached = starts.get('attached')!;
    const detached = starts.get('detached')!;
    for (const edge of ['attached', 'detached'] as const) {
      const actual = starts.get(edge)!;
      const execution = (await store.getExecution(actual.executionId))!;
      const command = (await store.getCommand(refs.get(edge)!.commandId))!;
      expect(execution.parentExecutionId).toBe(parentExecutionId);
      expect(execution.originCommandId).toBe(command.id);
      expect(execution.runId).toBeNull();
      expect(execution.cancelWithParent).toBe(edge === 'attached');
      expect((command.request as { cancellation: string }).cancellation).toBe(edge);
      expect((command.receipt as { executionId: string }).executionId).toBe(execution.id);
    }
    const cancel = {
      expectedStoreId,
      sessionId: 's',
      commandId: 'cancel-parent',
      subjectId: 'owner',
      executionId: parentExecutionId,
    };
    const receipt = await runtime.cancelExecution(cancel);
    await waitUntil(() => attached.signal.aborted);
    expect(receipt.status).toBe('applied');
    expect(detached.signal.aborted).toBe(false);
    expect((await store.getExecution(detached.executionId))!.cancelRequestedAt).toBeNull();
    expect((await store.getCommand('run'))!.cancelRequestedAt).toBeNull();
    expect(starts.size).toBe(2);
    expect(effects).toBe(0);
    const parentCancelRequestedAt = (await store.getExecution(parentExecutionId))!
      .cancelRequestedAt;
    const attachedCancelRequestedAt = (await store.getExecution(attached.executionId))!
      .cancelRequestedAt;
    const beforeRetry = (await store.getMetadata()).lastChangeCursor;
    expect(await runtime.cancelExecution(cancel)).toEqual(receipt);
    const retryChanges = await store.getChanges({ after: beforeRetry });
    expect(
      retryChanges.events.filter((event) =>
        ['command.cancel_requested', 'execution.cancel_requested', 'run.cancel_requested'].includes(
          event.type,
        ),
      ),
    ).toEqual([]);
    expect((await store.getExecution(parentExecutionId))!.cancelRequestedAt).toBe(
      parentCancelRequestedAt,
    );
    expect((await store.getExecution(attached.executionId))!.cancelRequestedAt).toBe(
      attachedCancelRequestedAt,
    );
    expect((await store.getExecution(detached.executionId))!.cancelRequestedAt).toBeNull();
    release();
    await waitUntil(
      async () => (await store.getExecution(detached.executionId))?.status === 'succeeded',
    );
    await runtime.waitForCommand('run', { timeoutMs: 4000 });
    expect((await store.getExecution(attached.executionId))!.status).toBe('cancelled');
    expect((await store.getExecution(detached.executionId))!.status).toBe('succeeded');
    expect(effects).toBe(1);
    expect(model.requests).toHaveLength(2);
    // Once the run and both operations have settled, retries and reads have no concurrent writer.
    const beforeRead = (await store.getMetadata()).lastChangeCursor;
    expect(await runtime.cancelExecution(cancel)).toEqual(receipt);
    await runtime.getView('s');
    await store.getOperation({
      extensionId: 'fixture',
      sessionId: 's',
      key: 'detached',
      subjectId: 'owner',
      originStoreId: expectedStoreId,
    });
    expect((await store.getMetadata()).lastChangeCursor).toBe(beforeRead);
    expect(effects).toBe(1);
  } finally {
    release();
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 10000);
