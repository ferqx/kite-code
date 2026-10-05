import { expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixedModel } from '@kite-ai/ai';
import { AgentError, createRuntime } from '../../../src';
import { defineExtension } from '../../../src/extensions';
import { openSqliteStore } from '../../../src/sqlite';
import type { Store } from '../../../src/storage';

test.each([
  'none',
  'async',
  'sync',
])('normal Tool progress is bounded and flushes before terminal, without replacing a known effect on observation failure: %s', async (fault) => {
  const root = mkdtempSync(join(tmpdir(), 'kite-tool-progress-'));
  const ledger = join(root, 'effect');
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' });
  let writes = 0;
  const observed = new Proxy(store, {
    get(target, key) {
      if (key === 'appendExecutionOutput')
        return (...args: Parameters<Store['appendExecutionOutput']>) => {
          writes++;
          if (fault === 'sync') throw new AgentError('storage_error');
          if (fault === 'async') return Promise.reject(new AgentError('storage_error'));
          return target.appendExecutionOutput(...args);
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const extension = defineExtension({
    id: 'fixture.progress',
    version: '1',
    apiMajor: 1,
    tools: [
      {
        id: 'fixture.progress.effect',
        version: '1',
        description: 'Report coalesced progress then a real harmless effect',
        inputSchema: { type: 'object', additionalProperties: false },
        async execute(_input, context) {
          for (let index = 0; index < 3000; index++)
            context.reportProgress({ index, phase: 'working' });
          if (fault === 'sync') await new Promise((resolve) => setTimeout(resolve, 150));
          appendFileSync(ledger, 'effect\n');
          return { outcome: 'succeeded', content: 'known effect finished' };
        },
      },
    ],
  });
  const model = createFixedModel([
    [
      { type: 'tool_call', id: 'call', name: 'fixture.progress.effect', arguments: '{}' },
      { type: 'finish', reason: 'tool_calls', usage: { inputTokens: 1, outputTokens: 1 } },
    ],
    [{ type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }],
  ]);
  const runtime = createRuntime({
    store: observed,
    model,
    extensions: [extension],
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
      rootUri: `file://${root}`,
      name: 'fixture',
    });
    await runtime.createSession({
      expectedStoreId,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      title: 'fixture',
      subjectId: 'owner',
    });
    await runtime.submitCommand({
      expectedStoreId,
      commandId: 'work',
      sessionId: 's',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'report progress' },
    });
    await runtime.waitForCommand('work');
    const view = await runtime.getView('s');
    const execution = view.executions.find((value) => value.kind === 'tool')!;
    expect(execution).toMatchObject({
      status: 'succeeded',
      result: { outcome: 'succeeded', content: 'known effect finished' },
    });
    expect(view.runs[0]!.status).toBe('completed');
    expect(readFileSync(ledger, 'utf8')).toBe('effect\n');
    expect(writes).toBe(1);
    const output = await store.listExecutionOutput({ executionId: execution.id });
    if (fault !== 'none') {
      expect(output.items).toEqual([]);
      expect(execution.result).toMatchObject({
        progressPersistence: { state: 'failed', code: 'storage_error' },
      });
    } else {
      expect(output.items).toHaveLength(1);
      expect(output.items[0]).toMatchObject({ stream: 'progress', seq: '1', throughSeq: '1' });
      expect(JSON.parse(output.items[0]!.content)).toEqual({ index: 2999, phase: 'working' });
    }
    const changes = await store.getChanges({ after: '0', limit: 200 });
    if (fault === 'none') {
      const point = changes.events.findIndex(
        (event) => event.objectId === execution.id && event.type === 'execution.output',
      );
      const terminal = changes.events.findIndex(
        (event) => event.objectId === execution.id && event.type === 'execution.finished',
      );
      expect(point).toBeGreaterThanOrEqual(0);
      expect(terminal).toBeGreaterThan(point);
    }
  } finally {
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);
