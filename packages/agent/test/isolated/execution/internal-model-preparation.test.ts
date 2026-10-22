import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixedModel, type ModelAdapter, type ModelRequest } from '@kite-ai/ai';
import { type AgentRuntime, createRuntime } from '../../../src';
import { openSqliteStore } from '../../../src/sqlite';
import type { Store } from '../../../src/storage/port';
import type { Json } from '../../../src/storage/types';

const finish = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
} as const;
async function fixture(
  checker: ModelAdapter,
  options: {
    cancelAtDispatchRead?: boolean;
    perRunDispose?(): Promise<void>;
    plannedCommandRead?: { entered(): void; released: Promise<void> };
  } = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-internal-model-preparation-')));
  const profile = { dataRoot: join(root, 'data'), profile: 'new' };
  const store = await openSqliteStore(profile);
  let effects = 0;
  const model = createFixedModel([
    [
      { type: 'tool_call', id: 'effect', name: 'fixture.effect', arguments: '{"value":"exact"}' },
      { ...finish, reason: 'tool_calls' },
    ],
    [finish],
  ]);
  let runtime!: AgentRuntime;
  let cancelledAtDispatchRead = false;
  let heldPlannedCommand = false;
  const runtimeStore = new Proxy(store, {
    get(target, key) {
      if (key === 'getCommand')
        return async (...args: Parameters<Store['getCommand']>) => {
          const command = await target.getCommand(...args);
          if (
            options.plannedCommandRead &&
            !heldPlannedCommand &&
            command?.kind === 'authorization.check'
          ) {
            const execution = (await target.listExecutions(command.sessionId)).find(
              (item) => item.originCommandId === command.id,
            );
            if (execution?.status === 'planned') {
              heldPlannedCommand = true;
              options.plannedCommandRead.entered();
              await options.plannedCommandRead.released;
            }
          }

          if (
            options.cancelAtDispatchRead &&
            !cancelledAtDispatchRead &&
            command?.kind === 'authorization.check'
          ) {
            const execution = (await target.listExecutions(command.sessionId)).find(
              (item) => item.originCommandId === command.id,
            );
            if (execution?.status === 'dispatching') {
              cancelledAtDispatchRead = true;
              await runtime.cancelCommand({
                expectedStoreId: command.originStoreId,
                sessionId: command.sessionId,
                subjectId: command.subjectId,
                commandId: 'cancel-after-check-dispatch',
                targetCommandId: 'work',
              });
            }
          }
          return command;
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  runtime = createRuntime({
    store: runtimeStore,
    model,
    modelId: 'fixture-model',
    ...(options.perRunDispose
      ? {
          resolveRunConfiguration: async () => ({
            model,
            modelId: 'fixture-model',
            toolIds: ['fixture.effect'],
            snapshot: null,
            dispose: options.perRunDispose,
          }),
        }
      : {}),
    modelConcurrency: 1,
    authorizationCheck: { id: 'checker', version: '1', modelId: 'check-model', model: checker },
    permissions: {
      async authorize(request) {
        return request.definitionId === 'fixture.effect'
          ? {
              allowed: false,
              revision: 'policy',
              check: { request: { task: 'exact operation', input: request.input } },
            }
          : { allowed: true, revision: 'policy' };
      },
    },
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'fixture.effect',
            version: '1',
            description: 'Bound effect',
            inputSchema: { type: 'object' },
            async execute() {
              effects++;
              return { outcome: 'succeeded', content: 'effect complete' };
            },
          },
        ],
      },
    ],
  });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const base = { expectedStoreId, sessionId: 'session', subjectId: 'owner' };
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'workspace',
    name: 'fixture',
    rootUri: pathToFileURL(root).href,
  });
  await runtime.createSession({
    ...base,
    commandId: 'create',
    workspaceId: 'workspace',
    title: 'fixture',
  });
  await runtime.submitCommand({
    ...base,
    commandId: 'work',
    request: { kind: 'run.start', content: 'perform the exact effect' },
  });
  return {
    store,
    profile,
    runtime,
    base,
    effects: () => effects,
    cancelledAtDispatchRead: () => cancelledAtDispatchRead,
    async close() {
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
async function pendingApproval(f: Awaited<ReturnType<typeof fixture>>) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const page = await f.runtime.listInteractions({
      expectedStoreId: f.base.expectedStoreId,
      sessionId: f.base.sessionId,
      state: 'pending',
    });
    if (page.interactions[0]) return page.interactions[0];
    await Bun.sleep(10);
  }
  throw new Error('Expected the real approval fallback');
}

test('metadata preparation failure settles its saved check without a Provider call and retains real human fallback', async () => {
  let calls = 0;
  const f = await fixture({
    describeRequest() {
      throw new Error('fixture metadata unavailable');
    },
    async *stream() {
      calls++;
      yield finish;
    },
  });
  try {
    const approval = await pendingApproval(f);
    const checks = (await f.store.listExecutions('session')).filter(
      (e) => e.kind === 'model' && e.runId === null,
    );
    expect(checks).toHaveLength(1);
    expect(checks[0]!.status).toBe('failed');
    expect(calls).toBe(0);
    expect(f.effects()).toBe(0);
    await f.runtime.answerInteraction({
      expectedStoreId: f.base.expectedStoreId,
      commandId: 'approve',
      presentationSessionId: 'session',
      interactionId: approval.id,
      expectedRevision: approval.revision,
      subjectId: 'owner',
      answer: { kind: 'approval', decision: 'approve' },
    });
    await f.runtime.waitForCommand('work');
    expect(f.effects()).toBe(1);
    expect(calls).toBe(0);
    expect(
      (await f.store.listExecutions('session')).filter(
        (e) => e.kind === 'model' && e.runId === null,
      ),
    ).toHaveLength(1);
    expect(await f.store.listSessions()).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('a metadata hook receives an isolated request and cannot change the sealed input actually sent to the checker', async () => {
  let actual: ModelRequest | undefined;
  const f = await fixture({
    describeRequest(request) {
      // Deliberately violate the adapter purity contract to verify isolation; this is no Model capability.
      const writable = request as unknown as { messages: { content: string }[] };
      writable.messages[0]!.content = 'metadata attempted to replace the bound request';
      return undefined as never;
    },
    async *stream(request) {
      actual = structuredClone(request);
      yield {
        type: 'text_delta',
        text: '{"decision":"approve_once","reason":"exact bound operation"}',
      };
      yield finish;
    },
  });
  try {
    await f.runtime.waitForCommand('work');
    expect(f.effects()).toBe(1);
    expect(actual).toBeDefined();
    const checks = (await f.store.listExecutions('session')).filter(
      (e) => e.kind === 'model' && e.runId === null,
    );
    expect(checks).toHaveLength(1);
    expect(checks[0]!.status).toBe('succeeded');
    const saved = { ...(checks[0]!.input as Record<string, Json>) };
    delete saved.authorizationCheckBindingDigest;
    expect(actual as unknown).toEqual(saved);
    const payload = JSON.parse(actual!.messages[0]!.content);
    expect(payload).toMatchObject({
      purpose: 'authorization_check',
      target: { input: { value: 'exact' } },
    });
    expect(actual!.requestId).toBe(checks[0]!.id);
    expect(actual!.tools).toEqual([]);
    expect(await f.store.listSessions()).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('cancellation after internal dispatch ACK and before the original command read returns never calls the checker Provider', async () => {
  let calls = 0;
  const f = await fixture(
    {
      async *stream() {
        calls++;
        yield {
          type: 'text_delta',
          text: '{"decision":"approve_once","reason":"must never start"}',
        };
        yield finish;
      },
    },
    { cancelAtDispatchRead: true },
  );
  try {
    await f.runtime.waitForCommand('work');
    expect(f.cancelledAtDispatchRead()).toBe(true);
    expect(calls).toBe(0);
    expect(f.effects()).toBe(0);
    const checks = (await f.store.listExecutions('session')).filter(
      (item) => item.kind === 'model' && item.runId === null,
    );
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe('cancelled');
    expect(
      (await f.runtime.listInteractions({ ...f.base, state: 'pending' })).interactions,
    ).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('a cancelled checker that ignores abort retains its per-Run configuration and Store until the actual call exits', async () => {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let disposed = 0;
  let draining: Promise<void> | undefined;
  const f = await fixture(
    {
      async *stream() {
        enter();
        yield { type: 'text_delta', text: '{"decision":' };
        await held;
        yield { type: 'text_delta', text: '"approve_once","reason":"late"}' };
        yield finish;
      },
    },
    {
      perRunDispose: async () => {
        disposed++;
      },
    },
  );
  try {
    await entered;
    await f.runtime.cancelCommand({
      ...f.base,
      commandId: 'cancel-held-check',
      targetCommandId: 'work',
    });
    await f.runtime.waitForCommand('work');
    expect(disposed).toBe(0);
    expect(f.effects()).toBe(0);
    let storeClosed = false,
      drained = false;
    const closeStore = f.store.close.bind(f.store);
    f.store.close = async () => {
      storeClosed = true;
      await closeStore();
    };
    draining = f.runtime.close().then(() => {
      drained = true;
    });
    void draining.catch(() => {});
    await Bun.sleep(100);
    expect(disposed).toBe(0);
    expect(storeClosed).toBe(false);
    expect(drained).toBe(false);
    expect((await f.store.getMetadata()).storeId).toBe(f.base.expectedStoreId);
    release();
    await draining;
    expect(disposed).toBe(1);
    expect(storeClosed).toBe(true);
    expect(f.effects()).toBe(0);
  } finally {
    release();
    await draining?.catch(() => {});
    await f.close();
  }
});

test('cancelling during the first planned check command read retains its configuration and Store until preparation settles', async () => {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0,
    disposed = 0;
  let draining: Promise<void> | undefined;
  const f = await fixture(
    {
      async *stream() {
        calls++;
        yield finish;
      },
    },
    {
      perRunDispose: async () => {
        disposed++;
      },
      plannedCommandRead: { entered: enter, released },
    },
  );
  try {
    await entered;
    const checks = (await f.store.listExecutions('session')).filter(
      (item) => item.kind === 'model' && item.runId === null,
    );
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe('planned');
    await f.runtime.cancelCommand({
      ...f.base,
      commandId: 'cancel-planned-check-read',
      targetCommandId: 'work',
    });
    await f.runtime.waitForCommand('work');
    expect(disposed).toBe(0);
    let storeClosed = false,
      drained = false;
    const closeStore = f.store.close.bind(f.store);
    f.store.close = async () => {
      storeClosed = true;
      await closeStore();
    };
    draining = f.runtime.close().then(() => {
      drained = true;
    });
    void draining.catch(() => {});
    await Bun.sleep(100);
    expect(disposed).toBe(0);
    expect(storeClosed).toBe(false);
    expect(drained).toBe(false);
    expect((await f.store.getMetadata()).storeId).toBe(f.base.expectedStoreId);
    release();
    await draining;
    expect(calls).toBe(0);
    expect(f.effects()).toBe(0);
    expect(disposed).toBe(1);
    expect(storeClosed).toBe(true);
    const cold = await openSqliteStore({ ...f.profile, mode: 'readonly' });
    try {
      const settled = await cold.getExecution(checks[0]!.id);
      expect(settled).not.toBeNull();
      expect(['cancelled', 'failed']).toContain(settled!.status);
    } finally {
      await cold.close();
    }
  } finally {
    release();
    await draining?.catch(() => {});
    await f.close();
  }
});
