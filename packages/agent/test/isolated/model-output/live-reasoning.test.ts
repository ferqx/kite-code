import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelAdapter } from '@kite-ai/ai';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';

/** One actual held Model proves the small public prefix before terminal and releases its generator. */
test('small live reasoning prefix is publicly readable before finish without releasing partial Tool calls', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-live-reasoning-'))),
    store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'new' });
  const expectedStoreId = (await store.getMetadata()).storeId;
  let release!: () => void,
    releaseFirst!: () => void,
    startedFirst!: () => void,
    started!: () => void,
    active = 0,
    effects = 0,
    requests = 0;
  const held = new Promise<void>((resolve) => (release = resolve)),
    ready = new Promise<void>((resolve) => (started = resolve)),
    firstHeld = new Promise<void>((resolve) => (releaseFirst = resolve)),
    firstReady = new Promise<void>((resolve) => (startedFirst = resolve));
  const reasoning = 'actual Unicode reasoning 中文🙂';
  const model: ModelAdapter = {
    async *stream() {
      requests++;
      active++;
      try {
        if (requests === 1) {
          yield { type: 'reasoning_delta', text: reasoning };
          startedFirst();
          await firstHeld;
          yield { type: 'tool_call', id: 'original-call', name: 'local.check', arguments: '{}' };
          await Bun.sleep(110);
          yield { type: 'reasoning_delta', text: ' continued' };
          started();
          await held;
          yield { type: 'text_delta', text: 'actual final' };
          yield {
            type: 'finish',
            reason: 'tool_calls',
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        } else {
          yield { type: 'text_delta', text: 'done' };
          yield { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
        }
      } finally {
        active--;
      }
    },
  };
  const runtime = createRuntime({
    store,
    model,
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'fixture' };
      },
    },
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'local.check',
            version: '1',
            description: 'No external effects',
            inputSchema: { type: 'object' },
            async execute() {
              effects++;
              return { outcome: 'succeeded', content: 'checked' };
            },
          },
        ],
      },
    ],
  });
  const scope = { expectedStoreId, sessionId: 'session', subjectId: 'owner' };
  try {
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'fixture',
      rootUri: pathToFileURL(root).href,
    });
    await runtime.createSession({ ...scope, commandId: 'create', workspaceId: 'w', title: 'live' });
    await runtime.submitCommand({
      ...scope,
      commandId: 'work',
      request: { kind: 'run.start', content: 'local' },
    });
    // The first small event must be visible while the producer is held before
    // any second event can cause the old elapsed-time checkpoint to fire.
    await firstReady;
    const inputs = await runtime.listModelInputs(scope),
      executionId = inputs.items[0]!.executionId;
    const first = await runtime.readModelOutput({ ...scope, executionId });
    expect(first.output).toEqual({ content: '', reasoning, toolCalls: [], complete: false });
    expect(first).toMatchObject({
      storeId: expectedStoreId,
      sessionId: scope.sessionId,
      executionId,
      originCommandId: 'work',
      status: 'dispatching',
      reasoningBytes: String(Buffer.byteLength(reasoning)),
    });
    expect(
      (await runtime.listMessages('session')).find((message) =>
        message.sourceIds?.includes(executionId),
      )?.firstOutput,
    ).toBe('reasoning');
    expect(effects).toBe(0);
    releaseFirst();
    await ready;
    const prefix = await runtime.readModelOutput({ ...scope, executionId });
    expect(prefix.output).toEqual({
      content: '',
      reasoning: `${reasoning} continued`,
      toolCalls: [],
      complete: false,
    });
    expect(prefix.reasoningBytes).toBe(String(Buffer.byteLength(`${reasoning} continued`)));
    expect(prefix.status).toBe('dispatching');
    expect(active).toBe(1);
    expect(effects).toBe(0);
    expect(
      (await runtime.listMessages('session')).find((message) =>
        message.sourceIds?.includes(executionId),
      )?.firstOutput,
    ).toBe('reasoning');
    release();
    await runtime.waitForCommand('work');
    expect((await runtime.readModelOutput({ ...scope, executionId })).output).toMatchObject({
      content: 'actual final',
      reasoning: `${reasoning} continued`,
      complete: true,
      toolCalls: [{ id: 'original-call' }],
    });
    expect(effects).toBe(1);
    expect(
      (await runtime.listMessages('session')).find((message) =>
        message.sourceIds?.includes(executionId),
      )?.firstOutput,
    ).toBe('reasoning');
    expect(active).toBe(0);
  } finally {
    releaseFirst();
    release();
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 5000);
