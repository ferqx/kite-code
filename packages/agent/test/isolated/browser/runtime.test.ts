import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import type { Json } from '../../../src/extensions';
import { openSqliteStore } from '../../../src/sqlite';
import {
  createBrowserController,
  createBrowserExtension,
  type NativeBrowserTransport,
} from '../../../src/tools/browser';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const until = async (check: () => boolean | Promise<boolean>) => {
  const limit = Date.now() + 4000;
  while (!(await check())) {
    if (Date.now() > limit) throw Error('browser_fixture_timeout');
    await Bun.sleep(5);
  }
};
async function fixture(confirmed: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'kite-browser-runtime-'));
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'browser' });
  const expectedStoreId = (await store.getMetadata()).storeId;
  let finishOwner!: (proof: { confirmed: boolean }) => void;
  const completion = new Promise<{ confirmed: boolean }>((resolve) => {
    finishOwner = resolve;
  });
  let starts = 0,
    closes = 0,
    disposals = 0,
    bindings = 0;
  const requests: Json[] = [];
  const transport: NativeBrowserTransport = {
    ready: Promise.resolve(),
    completion,
    async request(command) {
      requests.push(command);
      return { success: true, data: {} };
    },
    async capture() {
      return {
        frame: { mimeType: 'image/jpeg', data: 'small', width: 960, height: 540 },
        annotations: [],
      };
    },
    async close() {
      closes++;
      finishOwner({ confirmed });
      return { confirmed };
    },
    async dispose() {
      disposals++;
    },
  };
  const controller = createBrowserController({
    createTransport() {
      starts++;
      return transport;
    },
    captureIntervalMs: 60000,
  });
  const extension = createBrowserExtension({ controller });
  const model = createFixedModel([
    [
      {
        type: 'tool_call',
        id: 'open',
        name: 'browser_open',
        arguments: JSON.stringify({ key: 'original', url: 'https://example.test/' }),
      },
      { ...finish, reason: 'tool_calls' },
    ],
    [finish],
  ]);
  const runtime = createRuntime({
    store,
    model,
    modelId: 'fixed',
    extensions: [extension],
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'trusted-browser-fixture' };
      },
    },
    async resolveRunConfiguration() {
      return {
        model,
        modelId: 'fixed',
        snapshot: {},
        async dispose() {
          bindings++;
        },
      };
    },
  });
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'workspace',
    rootUri: pathToFileURL(root).href,
    name: 'browser',
  });
  await runtime.createSession({
    expectedStoreId,
    sessionId: 'session',
    workspaceId: 'workspace',
    commandId: 'create',
    subjectId: 'owner',
    title: 'browser',
  });
  await runtime.submitCommand({
    expectedStoreId,
    sessionId: 'session',
    commandId: 'root-work',
    subjectId: 'owner',
    request: { kind: 'run.start', content: 'Open managed browser' },
  });
  return {
    root,
    store,
    runtime,
    controller,
    expectedStoreId,
    model,
    requests,
    get starts() {
      return starts;
    },
    get closes() {
      return closes;
    },
    get disposals() {
      return disposals;
    },
    get bindings() {
      return bindings;
    },
  };
}

test('real Runtime keeps the browser Job and Run binding after model completion, then root cancellation stops original owner', async () => {
  const f = await fixture(true);
  try {
    await until(async () => {
      const execution = (await f.store.listExecutions('session')).find(
        (entry) => entry.kind === 'tool' && entry.status === 'failed',
      );
      if (execution) throw Error(JSON.stringify(execution.result));
      return f.controller.view('session')?.state === 'agent';
    });
    await f.runtime.waitForCommand('root-work', { timeoutMs: 4000 });
    expect(f.starts).toBe(1);
    expect(f.bindings).toBe(0);
    expect(f.runtime.tryBeginShutdown('if_idle').accepted).toBe(false);
    const before = (await f.store.getMetadata()).lastChangeCursor;
    const views = await f.runtime.queryExtension({
      expectedStoreId: f.expectedStoreId,
      subjectId: 'owner',
      sessionId: 'session',
      extensionId: 'builtin.browser',
      queryId: 'browser.view',
      input: {},
    });
    expect(views[0]?.payload).toMatchObject({ state: 'agent', browserId: 'original' });
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(before);
    expect(f.closes).toBe(0);
    await f.runtime.cancelCommand({
      expectedStoreId: f.expectedStoreId,
      subjectId: 'owner',
      sessionId: 'session',
      commandId: 'stop-original',
      targetCommandId: 'root-work',
    });
    await until(() => f.disposals === 1 && f.bindings === 1);
    expect(f.closes).toBe(1);
    expect(f.bindings).toBe(1);
    const jobs = (await f.store.listExecutions('session')).filter(
      (execution) => execution.kind === 'job',
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.definitionId).toBe('browser.session');
    expect(jobs[0]?.status).toBe('cancelled');
    await f.runtime.close();
    expect(f.runtime.getLifecycleState().state).toBe('closed');
  } finally {
    await f.runtime.close();
    rmSync(f.root, { recursive: true, force: true });
  }
}, 15000);

test('real Runtime refuses shutdown and retains original browser binding when owned stop is unconfirmed', async () => {
  const f = await fixture(false);
  try {
    await until(async () => {
      const execution = (await f.store.listExecutions('session')).find(
        (entry) => entry.kind === 'tool' && entry.status === 'failed',
      );
      if (execution) throw Error(JSON.stringify(execution.result));
      return f.controller.view('session')?.state === 'agent';
    });
    await f.runtime.waitForCommand('root-work', { timeoutMs: 4000 });
    const view = f.controller.view('session')!;
    await f.controller.close('session', { browserId: view.browserId, generation: view.generation });
    await until(async () =>
      (await f.store.listExecutions('session')).some(
        (entry) => entry.kind === 'job' && entry.status === 'outcome_unknown',
      ),
    );
    // Await directly: Bun's async rejection matcher can stall this SQLite Worker turn.
    const closeError = await f.runtime.close().then(
      () => null,
      (error: unknown) => error,
    );
    expect(closeError).toMatchObject({ code: 'shutdown_cleanup_unconfirmed' });
    expect(f.runtime.getLifecycleState().state).toBe('drain_failed');
    expect(f.disposals).toBe(0);
    expect(f.bindings).toBe(0);
    expect(f.starts).toBe(1);
    expect((await f.runtime.getMetadata()).storeId).toBe(f.expectedStoreId);
  } finally {
    // Fixture has no external process; this is test cleanup, never production stop evidence.
    await f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
}, 15000);
