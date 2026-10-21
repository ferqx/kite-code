import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type ModelAdapter, ModelAttemptError, type ModelRequest } from '@kite-ai/ai';
import { createArtifactStore } from '../../../src/artifacts';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import type { Store } from '../../../src/storage/port';

function outputLengthContinuation(executionId: string) {
  return {
    role: 'user' as const,
    content:
      'The preceding Model response reached its output length. Continue the original task from the saved response; do not repeat completed work. This continuation grants no additional permission.',
    sourceIds: [executionId],
  };
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function fixture(
  mode: 'fresh' | 'corrupt' | 'plain' | 'compressed' | 'compressed-before' | 'compressed-corrupt',
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-length-retry-')));
  const profile = { dataRoot: join(root, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  const input = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
  const partial = `original-partial-${'🪁e\u0301\r\n'.repeat(12_000)}-TAIL`;
  const requests: ModelRequest[] = [];
  const failedRead = gate(),
    releaseRead = gate();
  let failedId: string | undefined, lengthId: string | undefined;
  let held = false,
    revision = 'v1';
  const authorizations: { executionId: string; revision: string }[] = [];
  let toolReads = 0;
  let compressed = false;
  const summaries: ModelRequest[] = [];
  const proxy = new Proxy(store, {
    get(target, key) {
      if (key === 'getExpandedContext' && mode === 'compressed-corrupt')
        return async (input: Parameters<Store['getExpandedContext']>[0]) => {
          const page = await target.getExpandedContext(input);
          return {
            ...page,
            messages: page.messages.map((message) =>
              message.sourceIds?.includes(lengthId ?? '')
                ? { ...message, runId: 'foreign-run' }
                : message,
            ),
          };
        };
      if (key === 'getExecution')
        return async (id: string) => {
          const value = await target.getExecution(id);
          if (id === failedId && value?.status === 'failed' && !held) {
            held = true;
            failedRead.release();
            await releaseRead.promise;
          }
          if (mode === 'corrupt' && held && id === lengthId && value)
            return { ...value, rootWorkCommandId: 'foreign-work' };
          return value;
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Store;
  const model: ModelAdapter = {
    async *stream(request) {
      if (
        request.messages.some((message) => message.content === 'ACTUAL_CONTROLLED_SUMMARIZATION')
      ) {
        summaries.push(structuredClone(request));
        yield {
          type: 'text_delta',
          text: `Original task remains unfinished. Persisted length partial was saved. Continue using current human input and actual host Sources. ${request.messages.find((message) => message.content === 'Follow up: preserve genuine input through actual compression.')?.content ?? ''}`,
        };
        yield { type: 'finish', reason: 'stop', usage: { inputTokens: 10, outputTokens: 2 } };
        return;
      }
      requests.push(structuredClone(request));
      if (requests.length === 1 && mode === 'fresh') {
        yield { type: 'tool_call', id: 'read-before-length', name: 'owned.read', arguments: '{}' };
        yield { type: 'finish', reason: 'tool_calls', usage: { inputTokens: 1, outputTokens: 1 } };
        return;
      }
      const priorTool = mode === 'fresh' ? 1 : 0;
      if (requests.length === priorTool + 1 && mode !== 'plain') {
        lengthId = request.requestId;
        yield { type: 'text_delta', text: partial };
        yield { type: 'finish', reason: 'length', usage: { inputTokens: 1, outputTokens: 1 } };
        return;
      }
      if (requests.length === priorTool + (mode === 'plain' ? 1 : 2)) {
        failedId = request.requestId;
        revision = 'v2';
        yield { type: 'text_delta', text: 'failed-transient-prefix' };
        throw new ModelAttemptError('stream_incomplete');
      }
      yield { type: 'text_delta', text: 'completed after exact continuation' };
      yield { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const runtime = createRuntime({
    store: proxy,
    artifacts: createArtifactStore({ profile, store }),
    model,
    ...(mode.startsWith('compressed')
      ? {
          compressor: {
            id: 'owned.actual-compression',
            version: '1',
            async shouldCompress() {
              return !compressed && (mode === 'compressed-before' ? lengthId !== undefined : held);
            },
            async prepare() {
              compressed = true;
              return {
                instructions: 'ACTUAL_CONTROLLED_SUMMARIZATION',
                snapshot: { bounded: 'controlled-only-not-live-qualification' },
              };
            },
          },
        }
      : {}),
    extensions: [
      {
        id: 'owned',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'owned.read',
            version: '1',
            description: 'Read an actual owned fixture fact once',
            inputSchema: { type: 'object' },
            async execute() {
              toolReads++;
              return { outcome: 'succeeded', content: 'actual-owned-tool-before-length' };
            },
          },
        ],
      },
    ],
    sources: {
      async capture() {
        return [
          {
            id: 'fresh-host-source',
            kind: 'owned_material',
            scope: 's',
            digest: revision,
            content: `actual-host-${revision}`,
            role: 'user',
          },
        ];
      },
    },
    permissions: {
      async authorize(request) {
        authorizations.push({ executionId: request.executionId, revision });
        return { allowed: true, revision };
      },
    },
  });
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    rootUri: pathToFileURL(root).href,
    name: 'owned',
  });
  await runtime.createSession({
    ...input,
    commandId: 'create',
    workspaceId: 'w',
    title: 'length retry',
  });
  return {
    runtime,
    store,
    input,
    requests,
    summaries,
    partial,
    failedRead,
    releaseRead,
    authorizations,
    get toolReads() {
      return toolReads;
    },
    async start() {
      await runtime.submitCommand({
        ...input,
        commandId: 'work',
        request: { kind: 'run.start', content: 'New task: finish the original owned result.' },
      });
    },
    async close() {
      releaseRead.release();
      await runtime.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('length continuation survives exact Provider retry with full persisted partial and fresh human/host Sources and permissions', async () => {
  const f = await fixture('fresh');
  try {
    await f.start();
    await f.failedRead.promise;
    const view = await f.store.getView('s');
    const run = view.runs.find((item) => item.isActive)!;
    await f.runtime.submitCommand({
      ...f.input,
      commandId: 'steer',
      request: {
        kind: 'input.steer',
        content: 'Follow up: preserve this genuine new human supplement.',
        targetRunId: run.id,
        contextSelectionId: view.session.contextSelectionId,
      },
    });
    f.releaseRead.release();
    await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
    expect(f.requests).toHaveLength(4);
    const [, first, continuation, retried] = f.requests;
    const suffix = outputLengthContinuation(first!.requestId);
    expect(continuation!.messages.at(-1)).toEqual(suffix);
    expect(retried!.messages.at(-1)).toEqual(suffix);
    expect(
      retried!.messages.filter(
        (message) =>
          message.content === suffix.content && message.sourceIds?.includes(first!.requestId),
      ),
    ).toHaveLength(1);
    expect(
      retried!.messages.filter(
        (message) => message.role === 'assistant' && message.sourceIds?.includes(first!.requestId),
      ),
    ).toEqual([
      { role: 'assistant', content: f.partial, sourceIds: [first!.requestId], toolCalls: [] },
    ]);
    expect(Buffer.byteLength(f.partial)).toBeGreaterThan(64 * 1024);
    expect(f.toolReads).toBe(1);
    const originalTool = (await f.store.getView('s')).executions.find(
      (execution) => execution.definitionId === 'owned.read',
    )!;
    expect(originalTool.status).toBe('succeeded');
    expect(
      retried!.messages.find(
        (message) => message.role === 'tool' && message.sourceIds?.includes(originalTool.id),
      ),
    ).toMatchObject({ content: 'actual-owned-tool-before-length', sourceIds: [originalTool.id] });
    expect(retried!.tools.some((tool) => tool.id === 'owned.read')).toBe(true);
    expect(retried!.messages.some((message) => message.content.includes('actual-host-v2'))).toBe(
      true,
    );
    expect(retried!.messages.some((message) => message.content.includes('actual-host-v1'))).toBe(
      false,
    );
    expect(
      retried!.messages.some(
        (message) => message.content === 'Follow up: preserve this genuine new human supplement.',
      ),
    ).toBe(true);
    expect(
      retried!.messages.some((message) => message.content.includes('failed-transient-prefix')),
    ).toBe(false);
    expect(
      f.authorizations
        .filter((row) => row.executionId === retried!.requestId)
        .map((row) => row.revision),
    ).toEqual(['v2', 'v2']);
    const done = await f.store.getView('s');
    expect(done.runs).toHaveLength(1);
    expect(done.runs[0]).toMatchObject({ status: 'completed', rootWorkCommandId: 'work' });
    expect(
      done.executions
        .filter((execution) => execution.kind === 'model')
        .map((execution) => execution.status),
    ).toEqual(['succeeded', 'succeeded', 'failed', 'succeeded']);
    const full = await f.runtime.readModelOutput({ ...f.input, executionId: first!.requestId });
    expect(full.output.complete).toBe(true);
    expect(full.output.content).toBe(f.partial);
    expect((await f.store.getExecution(retried!.requestId))!.decisionSource).toMatchObject({
      retry: {
        previousExecutionId: continuation!.requestId,
        reason: 'stream_incomplete',
        attempt: 2,
      },
    });
  } finally {
    await f.close();
  }
});

test('a mismatched original length proof never authorizes a continuation retry', async () => {
  const f = await fixture('corrupt');
  try {
    await f.start();
    await f.failedRead.promise;
    f.releaseRead.release();
    await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
    expect(f.requests).toHaveLength(2);
    const view = await f.store.getView('s');
    expect(view.runs[0]).toMatchObject({ status: 'failed', reason: 'run_continuation_invalid' });
    expect((await f.store.getExecution(f.requests[0]!.requestId))!.rootWorkCommandId).toBe('work');
  } finally {
    await f.close();
  }
});

test('ordinary failed Provider retries retain fresh history without inventing any length continuation', async () => {
  const f = await fixture('plain');
  try {
    await f.start();
    await f.failedRead.promise;
    f.releaseRead.release();
    await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
    expect(f.requests).toHaveLength(2);
    expect(
      f.requests[1]!.messages.some((message) =>
        message.content.includes('preceding Model response reached its output length'),
      ),
    ).toBe(false);
    expect(
      f.requests[1]!.messages.some((message) => message.content.includes('actual-host-v2')),
    ).toBe(true);
    expect((await f.store.getView('s')).runs[0]!.status).toBe('completed');
  } finally {
    await f.close();
  }
});

for (const mode of ['compressed', 'compressed-before'] as const)
  test(`Provider retry after actual compression (${mode}) retires covered length suffix and keeps fresh selected summary and human/host Sources`, async () => {
    const f = await fixture(mode);
    try {
      await f.start();
      await f.failedRead.promise;
      const run = (await f.store.getView('s')).runs.find((run) => run.isActive)!;
      await f.runtime.submitCommand({
        ...f.input,
        commandId: 'steer',
        request: {
          kind: 'input.steer',
          content: 'Follow up: preserve genuine input through actual compression.',
          targetRunId: run.id,
          contextSelectionId: run.contextSelectionId,
        },
      });
      f.releaseRead.release();
      await f.runtime.waitForCommand('work', { timeoutMs: 7000 });
      const view = await f.store.getView('s');
      expect(f.summaries).toHaveLength(1);
      const selected = await f.store.getModelContext(f.input);
      expect(selected.compression?.trigger).toBe('automatic');
      expect(view.runs[0]).toMatchObject({ status: 'completed', reason: null });
      expect(f.requests).toHaveLength(3);
      const retry = f.requests[2]!;
      expect(
        retry.messages.filter((message) => message.sourceIds?.includes(selected.compression!.id)),
      ).toHaveLength(1);
      expect(retry.messages.some((message) => message.content === f.partial)).toBe(false);
      expect(
        retry.messages.some((message) =>
          message.content.startsWith('The preceding Model response reached its output length.'),
        ),
      ).toBe(false);
      expect(retry.messages.some((message) => message.content.includes('actual-host-v2'))).toBe(
        true,
      );
      expect(retry.messages.some((message) => message.content.includes('actual-host-v1'))).toBe(
        false,
      );
      expect(f.summaries[0]!.messages.some((message) => message.content === f.partial)).toBe(true);
      expect(
        f.summaries[0]!.messages.some(
          (message) =>
            message.content === 'Follow up: preserve genuine input through actual compression.',
        ),
      ).toBe(mode === 'compressed');
      expect(
        retry.messages.some((message) =>
          message.content.includes('Follow up: preserve genuine input through actual compression.'),
        ),
      ).toBe(true);
      expect((await f.store.getExecution(f.requests[1]!.requestId))!.status).toBe('failed');
      expect((await f.store.getExecution(f.requests[0]!.requestId))!.status).toBe('succeeded');
      const full = await f.runtime.readModelOutput({
        ...f.input,
        executionId: f.requests[0]!.requestId,
      });
      expect(full.output.content).toBe(f.partial);
      expect(full.output.complete).toBe(true);
    } finally {
      await f.close();
    }
  });

test('compression without the original selected length assistant proof cannot authorize a Provider retry', async () => {
  const f = await fixture('compressed-corrupt');
  try {
    await f.start();
    await f.failedRead.promise;
    f.releaseRead.release();
    await f.runtime.waitForCommand('work', { timeoutMs: 7000 });
    expect(f.summaries).toHaveLength(1);
    expect((await f.store.getModelContext(f.input)).compression?.trigger).toBe('automatic');
    expect((await f.store.getView('s')).runs[0]).toMatchObject({
      status: 'failed',
      reason: 'run_continuation_invalid',
    });
    expect(f.requests).toHaveLength(2);
    const original = await f.runtime.readModelOutput({
      ...f.input,
      executionId: f.requests[0]!.requestId,
    });
    expect(original.output.content).toBe(f.partial);
    expect((await f.store.getExecution(f.requests[0]!.requestId))!.runId).not.toBe('foreign-run');
  } finally {
    await f.close();
  }
});
