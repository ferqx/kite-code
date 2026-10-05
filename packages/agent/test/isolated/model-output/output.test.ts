import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixedModel, type ModelAdapter, type ModelEvent } from '@kite-ai/ai';
import { createCompatibleModelBinding, createSdkModelAdapter } from '@kite-ai/ai/sdk';
import { createArtifactStore } from '../../../src/artifacts';
import { artifactPath } from '../../../src/artifacts-files';
import { readModelOutput } from '../../../src/model-output';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import type { Store } from '../../../src/storage/port';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
test('seventeen MiB actual output survives history and enters the next actual Model request with original source', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-model-output-')));
  const profile = { dataRoot: join(root, 'data'), profile: 'new' };
  const raw = await openSqliteStore(profile);
  const frames: { method: string; bytes: number }[] = [];
  const store = new Proxy(raw, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      return typeof value === 'function'
        ? (...args: unknown[]) => {
            frames.push({ method: String(key), bytes: Buffer.byteLength(JSON.stringify(args)) });
            return Reflect.apply(value, target, args);
          }
        : value;
    },
  }) as Store;
  const expectedStoreId = (await store.getMetadata()).storeId;
  const full = `${'x'.repeat(17 * 1024 * 1024)}EXACT OUTPUT TAIL`;
  const events: ModelEvent[] = [];
  for (let offset = 0; offset < full.length; offset += 32 * 1024)
    events.push({ type: 'text_delta', text: full.slice(offset, offset + 32 * 1024) });
  events.push(
    { type: 'tool_call', id: 'local', name: 'local.check', arguments: '{}' },
    { ...finish, reason: 'tool_calls' },
  );
  const model = createFixedModel([events, [finish]]);
  let effects = 0;
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    model,
    modelConcurrency: 1,
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
            description: 'No external effect',
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
  const scope = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
  try {
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'fixture',
      rootUri: `file://${root}`,
    });
    await runtime.createSession({
      ...scope,
      commandId: 'create',
      workspaceId: 'w',
      title: 'output',
    });
    await runtime.submitCommand({
      ...scope,
      commandId: 'start',
      request: { kind: 'run.start', content: 'local fixture' },
    });
    const settled = await runtime.waitForCommand('start', { timeoutMs: 20000 });
    const run = await runtime.getRun((settled.receipt as { runId: string }).runId);
    expect(run?.status).toBe('completed');
    expect(model.requests).toHaveLength(2);
    expect(effects).toBe(1);
    const original = await runtime.listModelInputs(scope);
    const source = original.items[0]!.executionId;
    expect(
      model.requests[1]!.messages.some(
        (message) =>
          message.role === 'assistant' &&
          message.content === full &&
          message.sourceIds?.includes(source),
      ),
    ).toBe(true);
    const history = await store.listMessages('s', { limit: 200 });
    const originalMessage = history.filter((message) => message.sourceIds?.includes(source));
    expect(originalMessage).toHaveLength(1);
    expect(originalMessage[0]?.id).toBe(`partial_${source}`);
    expect(originalMessage[0]?.status).toBe('complete');
    expect(originalMessage[0]?.modelOutput?.complete).toBe(true);
    const saved = await runtime.readModelOutput({ ...scope, executionId: source });
    expect(saved.output.content).toBe(full);
    expect(saved.output.complete).toBe(true);
    const snapshot = await store.getModelOutputSnapshot({ ...scope, executionId: source });
    expect(snapshot.output).not.toBeNull();
    expect(JSON.stringify(snapshot).length).toBeLessThan(8192);
    expect(Math.max(...frames.map((frame) => frame.bytes))).toBeLessThan(256 * 1024);
    const partials = frames.filter((frame) => frame.method === 'persistModelPartial');
    expect(partials.length).toBeGreaterThan(500);
    expect(partials.reduce((sum, frame) => sum + frame.bytes, 0)).toBeLessThan(
      Buffer.byteLength(full),
    );
    await runtime.close();
    const coldStore = await openSqliteStore({ ...profile, mode: 'readonly' });
    const cold = createRuntime({
      store: coldStore,
      artifacts: createArtifactStore({ profile, store: coldStore }),
      model: createFixedModel([]),
      permissions: {
        async authorize() {
          throw new Error('cold read must not authorize');
        },
      },
    });
    try {
      expect((await cold.readModelOutput({ ...scope, executionId: source })).output).toEqual(
        saved.output,
      );
      expect(model.requests).toHaveLength(2);
    } finally {
      await cold.close();
    }
  } finally {
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

async function smallFixture(
  model: ModelAdapter,
  observe?: (method: string, args: unknown[]) => void,
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-output-prefix-'))),
    profile = { dataRoot: join(root, 'data'), profile: 'new' };
  const raw = await openSqliteStore(profile);
  const store = observe
    ? (new Proxy(raw, {
        get(target, key) {
          const value = Reflect.get(target, key, target);
          return typeof value === 'function'
            ? (...args: unknown[]) => {
                observe(String(key), args);
                return Reflect.apply(value, target, args);
              }
            : value;
        },
      }) as Store)
    : raw;
  const expectedStoreId = (await store.getMetadata()).storeId;
  let effects = 0;
  const artifacts = createArtifactStore({ profile, store });
  const runtime = createRuntime({
    store,
    artifacts,
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
            description: 'Local counter only',
            inputSchema: { type: 'object' },
            async execute() {
              effects++;
              return { outcome: 'succeeded', content: 'local' };
            },
          },
        ],
      },
    ],
  });
  const scope = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'fixture',
    rootUri: `file://${root}`,
  });
  await runtime.createSession({ ...scope, commandId: 'create', workspaceId: 'w', title: 'prefix' });
  return {
    root,
    profile,
    store,
    artifacts,
    runtime,
    scope,
    get effects() {
      return effects;
    },
    async start() {
      await runtime.submitCommand({
        ...scope,
        commandId: 'work',
        request: { kind: 'run.start', content: 'fixture' },
      });
    },
    async output() {
      const page = await runtime.listModelInputs(scope);
      return runtime.readModelOutput({ ...scope, executionId: page.items[0]!.executionId });
    },
    async close() {
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('Unicode split between deltas keeps exact full content/reasoning UTF8 bytes and complete call arguments', async () => {
  const text = `${'x'.repeat(66000)}🚀`,
    reasoning = 'thought 🚀';
  const args = JSON.stringify({ value: 'argument'.repeat(10000) });
  const model = createFixedModel([
    [
      { type: 'text_delta', text: text.slice(0, -2) },
      { type: 'text_delta', text: '\ud83d' },
      { type: 'text_delta', text: '\ude80' },
      { type: 'reasoning_delta', text: 'thought \ud83d' },
      { type: 'reasoning_delta', text: '\ude80' },
      { type: 'tool_call', id: 'local', name: 'local.check', arguments: args },
      { ...finish, reason: 'tool_calls' },
    ],
    [finish],
  ]);
  const f = await smallFixture(model);
  try {
    await f.start();
    await f.runtime.waitForCommand('work');
    const saved = await f.output();
    expect(saved.output.content).toBe(text);
    expect(saved.output.reasoning).toBe(reasoning);
    expect(saved.contentBytes).toBe(String(Buffer.byteLength(text)));
    expect(saved.reasoningBytes).toBe(String(Buffer.byteLength(reasoning)));
    expect(saved.output.toolCalls[0]?.arguments).toBe(args);
    expect(f.effects).toBe(1);
    expect(
      model.requests[1]!.messages.some(
        (message) => message.content === text && message.toolCalls?.[0]?.arguments === args,
      ),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

test('remote failure retains exact incomplete prefix and reasoning but complete-looking calls grant no dispatch', async () => {
  const prefix = 'received '.repeat(10000),
    thought = 'recorded thought';
  let attempts = 0;
  const model: ModelAdapter = {
    async *stream() {
      attempts++;
      yield { type: 'text_delta', text: prefix };
      yield { type: 'reasoning_delta', text: thought };
      yield { type: 'tool_call', id: 'not-authorized', name: 'local.check', arguments: '{}' };
      throw new Error('fixture remote stream failure');
    },
  };
  const f = await smallFixture(model);
  try {
    await f.start();
    await f.runtime.waitForCommand('work');
    const saved = await f.output();
    expect(saved.output).toEqual({
      content: prefix,
      reasoning: thought,
      toolCalls: [],
      complete: false,
    });
    expect(saved.status).toBe('failed');
    expect(f.effects).toBe(0);
    expect(attempts).toBe(1);
    const page = await f.runtime.listModelInputs(f.scope);
    const snap = await f.store.getModelOutputSnapshot({
      ...f.scope,
      executionId: page.items[0]!.executionId,
    });
    expect(snap.output?.complete).toBe(false);
    expect(snap.content.length).toBeLessThan(prefix.length);
  } finally {
    await f.close();
  }
});

test('precise cancellation seals only received prefix and does not release tool calls or revive Model', async () => {
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const prefix = 'cancel prefix '.repeat(7000);
  let attempts = 0;
  const model: ModelAdapter = {
    async *stream(_request, { signal }) {
      attempts++;
      yield { type: 'text_delta', text: prefix };
      entered();
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });
      signal.throwIfAborted();
      yield finish;
    },
  };
  const f = await smallFixture(model);
  try {
    await f.start();
    await waiting;
    await f.runtime.cancelCommand({ ...f.scope, commandId: 'cancel', targetCommandId: 'work' });
    await f.runtime.waitForCommand('work');
    const saved = await f.output();
    expect(saved.output.content).toBe(prefix);
    expect(saved.output.complete).toBe(false);
    expect(saved.output.toolCalls).toEqual([]);
    expect(saved.status).toBe('cancelled');
    expect(f.effects).toBe(0);
    expect(attempts).toBe(1);
  } finally {
    await f.close();
  }
});

test('wrong scope and corrupted immutable head stop next Provider; cancelled reads do not return prefix success', async () => {
  const full = 'verified '.repeat(10000);
  const model = createFixedModel([[{ type: 'text_delta', text: full }, finish], [finish]]);
  const f = await smallFixture(model);
  try {
    await f.start();
    await f.runtime.waitForCommand('work');
    const page = await f.runtime.listModelInputs(f.scope),
      id = page.items[0]!.executionId,
      snapshot = await f.store.getModelOutputSnapshot({ ...f.scope, executionId: id });
    for (const changed of [
      { expectedStoreId: 'foreign-store' },
      { sessionId: 'foreign-session' },
      { subjectId: 'foreign-subject' },
    ]) {
      let rejected: unknown;
      try {
        await f.store.getModelOutputSnapshot({ ...f.scope, executionId: id, ...changed });
      } catch (error) {
        rejected = error;
      }
      expect(rejected).toBeDefined();
    }
    let calls = 0;
    let wrong: unknown;
    try {
      await readModelOutput(
        { ...snapshot.output!, head: { ...snapshot.output!.head, sessionId: 'other' } },
        { storeId: f.scope.expectedStoreId, sessionId: 's', subjectId: 'owner', executionId: id },
        async () => {
          calls++;
          return new Uint8Array();
        },
      );
    } catch (error) {
      wrong = error;
    }
    expect(wrong).toBeDefined();
    expect(calls).toBe(0);
    const signal = new AbortController();
    signal.abort();
    let cancelled: unknown;
    try {
      await f.runtime.readModelOutput({ ...f.scope, executionId: id, signal: signal.signal });
    } catch (error) {
      cancelled = error;
    }
    expect(cancelled).toBeDefined();
    const path = artifactPath(
        join(f.profile.dataRoot, f.profile.profile),
        snapshot.output!.head.hash,
      ),
      bytes = readFileSync(path);
    chmodSync(path, 0o600);
    try {
      writeFileSync(path, 'corrupt');
      let rejected: unknown;
      try {
        await f.runtime.readModelOutput({ ...f.scope, executionId: id });
      } catch (error) {
        rejected = error;
      }
      expect(rejected).toBeDefined();
      await f.runtime.submitCommand({
        ...f.scope,
        commandId: 'later',
        request: { kind: 'run.start', content: 'next' },
      });
      await f.runtime.waitForCommand('later');
      expect(model.requests).toHaveLength(1);
      expect(f.effects).toBe(0);
    } finally {
      writeFileSync(path, bytes);
      chmodSync(path, 0o444);
    }
  } finally {
    await f.close();
  }
});

test('actual SDK controlled stream seals large content instead of copying growing Worker responses', async () => {
  const full = 'compatible '.repeat(10000);
  let transport = 0;
  const binding = createCompatibleModelBinding({
    modelId: 'remote',
    baseURL: 'https://fixture.invalid/v1',
    apiKey: 'test-only',
    fetch: Object.assign(
      async () => {
        transport++;
        const frames = [
          {
            id: 'local',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'remote',
            choices: [{ index: 0, delta: { content: full }, finish_reason: null }],
          },
          {
            id: 'local',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'remote',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        ];
        return new Response(
          `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')}data: [DONE]\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
      { preconnect() {} },
    ),
  });
  const f = await smallFixture(createSdkModelAdapter({ models: new Map([['fixed', binding]]) }));
  try {
    await f.start();
    await f.runtime.waitForCommand('work');
    expect((await f.output()).output.content).toBe(full);
    expect(transport).toBe(1);
    expect(f.effects).toBe(0);
    const page = await f.runtime.listModelInputs(f.scope);
    expect(
      (
        await f.store.getModelOutputSnapshot({
          ...f.scope,
          executionId: page.items[0]!.executionId,
        })
      ).output?.complete,
    ).toBe(true);
  } finally {
    await f.close();
  }
});

test('stale checkpoint cannot replace current immutable head; retry preserves original message identity', async () => {
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  const prefix = 'checkpoint '.repeat(8000);
  const args: Parameters<Store['persistModelPartial']>[0][] = [];
  const model: ModelAdapter = {
    async *stream() {
      yield { type: 'text_delta', text: prefix };
      entered();
      await gate;
      yield finish;
    },
  };
  const f = await smallFixture(model, (method, values) => {
    if (method === 'persistModelPartial')
      args.push(structuredClone(values[0] as Parameters<Store['persistModelPartial']>[0]));
  });
  try {
    await f.start();
    await waiting;
    expect(args.length).toBeGreaterThan(1);
    const last = args.at(-1)!;
    const before = await f.store.getModelOutputSnapshot({
      ...f.scope,
      executionId: last.executionId,
    });
    let error: unknown;
    try {
      await f.store.persistModelPartial(args[0]!);
    } catch (cause) {
      error = cause;
    }
    expect((error as { code: string }).code).toBe('model_output_conflict');
    expect(
      (await f.store.getModelOutputSnapshot({ ...f.scope, executionId: last.executionId })).output,
    ).toEqual(before.output);
    await f.store.persistModelPartial(last);
    release();
    await f.runtime.waitForCommand('work');
    expect((await f.output()).output.content).toBe(prefix);
    const messages = await f.store.listMessages('s', { limit: 200 });
    const original = messages.filter((message) => message.sourceIds?.includes(last.executionId));
    expect(original).toHaveLength(1);
    expect(original[0]?.id).toBe(`partial_${last.executionId}`);
    expect(original[0]?.status).toBe('complete');
  } finally {
    release();
    await f.close();
  }
});
