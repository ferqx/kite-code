import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import type { Extension, JobDefinition } from '@kite-ai/agent/extensions';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { ModelAdapter } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { createBrowserClient } from '@kite-ai/client/browser';
import { WebController, type WebUpdate } from '../../../web/src';
import { startDevelopmentWeb } from '../../src/development-web';
import { startService } from '../../src/index';

async function fixture(partialBytes = 32768) {
  const root = mkdtempSync(join(tmpdir(), 'kite-development-web-'));
  const store = await openSqliteStore({ dataRoot: root, profile: 'development' });
  const storeId = (await store.getMetadata()).storeId;
  let jobs = 0,
    models = 0,
    release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const partial = `actual partial ${'x'.repeat(partialBytes)}`;
  const model: ModelAdapter = {
    async *stream(_request, { signal }) {
      models++;
      yield { type: 'text_delta', text: partial };
      await Promise.race([
        hold,
        new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        ),
      ]);
      signal.throwIfAborted();
      yield { type: 'text_delta', text: ' complete' };
      yield { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const outputJob: JobDefinition = {
    id: 'fixture.browser-output',
    version: '1',
    description: 'Harmless actual output',
    inputSchema: { type: 'object' },
    async start() {
      jobs++;
      return { reference: { id: 'actual-output-handle' } };
    },
    async *observe() {
      yield { type: 'output', stream: 'stdout', content: 'first α\n' };
      yield { type: 'output', stream: 'stderr', content: 'second β\n' };
      yield {
        type: 'terminal',
        supervision: 'ended',
        result: { outcome: 'succeeded', content: 'done' },
      };
    },
    async cancel() {
      return { status: 'already_finished' };
    },
    async dispose() {},
  };
  const outputExtension: Extension = {
    id: 'fixture.browser-output',
    version: '1',
    apiMajor: 1,
    jobs: [outputJob],
    actions: [
      {
        id: 'launch',
        version: '1',
        description: 'One ordinary output Job',
        inputSchema: { type: 'object', additionalProperties: false },
        async prepare(input) {
          return input;
        },
        async execute(_input, context) {
          const ref = await context.operations.ensure({
            key: 'output',
            request: { kind: 'job', definitionId: outputJob.id, definitionVersion: '1', input: {} },
          });
          await context.operations.wait(ref, { timeoutMs: 4000, signal: context.signal });
          return { outcome: 'succeeded', content: 'created' };
        },
      },
    ],
  };
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({
      profile: selectProfile({ dataRoot: root, profile: 'development' }),
      store,
    }),
    model,
    extensions: [outputExtension],
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'test' };
      },
    },
  });
  const profile = { dataRoot: root, name: 'development', accessKey: 'development-test' };
  const service = await startService({
    runtime,
    profile,
    subjectId: 'owner',
    buildId: 'web-test',
    instanceId: 'native',
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    bootstrap: service.bootstrap,
    expected: {
      profile,
      apiMajor: 1,
      instanceId: 'native',
      buildId: 'web-test',
      requiredCapabilities: ['history', 'commands'],
    },
  });
  await client.connect();
  await client.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    name: 'private name',
    rootUri: 'file:///private-project-not-public-address',
  });
  for (const sessionId of ['s', 'other'])
    await client.createSession({
      expectedStoreId: storeId,
      commandId: `create-${sessionId}`,
      sessionId,
      workspaceId: 'w',
      title: sessionId,
    });
  let now = Date.now();
  const web = startDevelopmentWeb({ admittedClient: client, now: () => now });
  let cookie = '';
  const shell = await fetch(web.endpoint);
  cookie = shell.headers.get('set-cookie')!.split(';')[0]!;
  const html = await shell.text();
  const requests: { url: string; method: string; authorization: string | null }[] = [];
  const browserFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set('cookie', cookie);
    headers.set('origin', web.endpoint);
    requests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      authorization: headers.get('authorization'),
    });
    const response = await fetch(input, { ...init, headers });
    const next = response.headers.get('set-cookie');
    if (next) cookie = next.split(';')[0]!;
    return response;
  }) as typeof fetch;
  const browser = createBrowserClient({
    origin: web.endpoint,
    pageIdentity: web.pageIdentity,
    fetch: browserFetch,
  });
  await browser.connect();
  return {
    root,
    store,
    storeId,
    runtime,
    service,
    client,
    web,
    browser,
    requests,
    html,
    partial,
    get models() {
      return models;
    },
    get jobs() {
      return jobs;
    },
    async launchOutput() {
      await client.invokeExtension('s', {
        expectedStoreId: storeId,
        commandId: 'launch-output',
        kind: 'extension.invoke',
        extensionId: outputExtension.id,
        actionId: 'launch',
        definitionVersion: '1',
        input: {},
      });
      await runtime.waitForCommand('launch-output', { timeoutMs: 4000 });
      return (await store.listExecutions('s')).find((row) => row.definitionId === outputJob.id)!;
    },
    expire() {
      now += 5 * 60_000;
    },
    release,
    async raw(path: string, method = 'GET', headers: Record<string, string> = {}) {
      return fetch(`${web.endpoint}${path}`, {
        method,
        headers: { cookie, 'x-kite-web-identity': web.pageIdentity, ...headers },
      });
    },
    async close() {
      release();
      browser.disposeNetwork();
      await web.close();
      client.disposeNetwork();
      await service.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('development Browser reads actual Service/SQLite without Native credential, filesystem address or mutation proxy', async () => {
  const f = await fixture();
  try {
    expect(f.html).toContain(`content="${f.web.pageIdentity}"`);
    expect(f.html).not.toContain(f.service.bootstrap.token);
    expect(f.html).not.toContain(f.root);
    expect(await f.browser.listWorkspaces()).toEqual([{ id: 'w', name: 'private name' }]);
    expect(
      (await f.browser.listSessions({ workspaceId: 'w' })).map((session) => session.id).sort(),
    ).toEqual(['other', 's']);
    const before = await f.store.getMetadata();
    for (const path of [
      '/v1/sessions/s/commands',
      '/browser/v1/sessions/s/commands',
      '/browser/v1/events',
      '/v1/config/user',
      '/v1/credentials',
    ]) {
      const response = await f.raw(path, path.includes('commands') ? 'POST' : 'GET');
      expect([404, 405]).toContain(response.status);
      await response.body?.cancel();
    }
    const invalidHeaders: Record<string, string>[] = [
      { authorization: `Bearer ${f.service.bootstrap.token}` },
      { origin: 'https://foreign.example' },
      { 'x-kite-web-identity': 'f'.repeat(64) },
    ];
    for (const headers of invalidHeaders) {
      const response = await f.raw('/browser/v1/workspaces', 'GET', headers);
      expect([403, 409]).toContain(response.status);
      await response.body?.cancel();
    }
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(before.lastChangeCursor);
    expect(f.models).toBe(0);
    expect(f.requests.every((request) => request.authorization === null)).toBe(true);
    const renew = await f.raw('/browser/session', 'POST');
    expect(renew.status).toBe(403);
    await renew.body?.cancel();
    f.expire();
    await f.browser.listWorkspaces();
    expect(f.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
    await f.browser.closeBrowserSession();
    expect(f.requests.filter((request) => request.method === 'DELETE')).toHaveLength(1);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(before.lastChangeCursor);
  } finally {
    await f.close();
  }
});

test('Web selection/poll/expiry and document close read exact actual history while original Model work continues', async () => {
  const f = await fixture();
  const updates: WebUpdate[] = [];
  const controller = new WebController({
    admittedClient: f.browser,
    onUpdate: (update) => updates.push(update),
    initiallyVisible: false,
  });
  try {
    await f.client.startRun('s', {
      expectedStoreId: f.storeId,
      commandId: 'work',
      kind: 'run.start',
      content: 'the complete original human input',
    });
    const deadline = Date.now() + 5000;
    while (
      !(await f.client.getView('s')).messages.some((message) => message.content === f.partial)
    ) {
      if (Date.now() > deadline) throw new Error('actual_model_barrier_timeout');
      await Bun.sleep(5);
    }
    const snapshot = await controller.selectSession('s');
    expect(snapshot?.messages.map((message) => message.content)).toContain(
      'the complete original human input',
    );
    expect(snapshot?.messages.at(-1)?.content).toBe(f.partial);
    expect(snapshot?.messages.at(-1)?.seq).toBe(snapshot?.view.session.nextSeq);
    expect(snapshot?.view.runs[0]?.isActive).toBe(true);
    expect(snapshot?.view.runs[0]).not.toHaveProperty('configuration');
    expect(snapshot?.view.executions.every((execution) => !('result' in execution))).toBe(true);
    f.expire();
    const before = (await f.store.getMetadata()).lastChangeCursor;
    await controller.refresh();
    await controller.selectSession('other');
    expect(controller.snapshot?.sessionId).toBe('other');
    expect(controller.snapshot?.messages).toEqual([]);
    controller.disposeObserver();
    await f.browser.closeBrowserSession();
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(before);
    expect(f.models).toBe(1);
    expect((await f.runtime.getView('s')).runs[0]!.isActive).toBe(true);
    f.release();
    await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
    expect((await f.client.getView('s')).runs[0]!.status).toBe('completed');
    expect(updates.some((update) => update.phase === 'ready')).toBe(true);
  } finally {
    controller.disposeObserver();
    await f.close();
  }
});

test('Browser context and Job output use original Session and fixed cursor with zero model, command or Job replay', async () => {
  const f = await fixture();
  try {
    const job = await f.launchOutput();
    expect(job.status).toBe('succeeded');
    expect(f.jobs).toBe(1);
    const before = (await f.store.getMetadata()).lastChangeCursor;
    const view = await f.browser.getView('s');
    const contextInput = {
      contextSelectionId: view.session.contextSelectionId,
      messageLimit: 1,
      sourceLimit: 1,
    };
    const context = await f.browser.getContext('s', contextInput);
    expect(context).toEqual(
      await f.client.getContext('s', { ...contextInput, storeId: f.storeId }),
    );
    const one = await f.browser.listExecutionOutput('s', job.id, { limit: 1 });
    expect(one.highWaterSeq).toBe('2');
    expect(one.items.map((item) => item.content)).toEqual(['first α\n']);
    const two = await f.browser.listExecutionOutput('s', job.id, {
      afterSeq: one.items[0]!.throughSeq,
      upperSeq: one.highWaterSeq,
      limit: 1,
    });
    expect(two.items.map((item) => item.content)).toEqual(['second β\n']);
    expect(
      await f.browser.listExecutionOutput('s', job.id, { afterSeq: '2', upperSeq: '2' }),
    ).toEqual({ items: [], highWaterSeq: '2' });
    let foreign: unknown;
    try {
      await f.browser.listExecutionOutput('other', job.id);
    } catch (error) {
      foreign = error;
    }
    expect(foreign).toMatchObject({ code: 'browser_scope_denied', status: 403 });
    for (const path of [
      '/browser/v1/sessions/s/context?storeId=forged',
      '/browser/v1/sessions/s/context?sourceLimit=101',
      '/browser/v1/sessions/s/context?afterSeq=1&afterSeq=2',
      `/browser/v1/sessions/s/executions/${job.id}/output?subjectId=forged`,
    ]) {
      const response = await f.raw(path);
      expect(response.status).toBe(400);
      await response.body?.cancel();
    }
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(before);
    expect(f.models).toBe(0);
    expect(f.jobs).toBe(1);
  } finally {
    await f.close();
  }
});

test('concurrent Browser directory, history, context and output retain every original finite read', async () => {
  const f = await fixture();
  try {
    const job = await f.launchOutput();
    const before = (await f.store.getMetadata()).lastChangeCursor;
    const view = await f.browser.getView('s');
    const [workspaces, sessions, current, messages, context, output] = await Promise.all([
      f.browser.listWorkspaces(),
      f.browser.listSessions({ workspaceId: 'w' }),
      f.browser.getView('s'),
      f.browser.listMessages('s', { upperSeq: view.session.nextSeq }),
      f.browser.getContext('s', { contextSelectionId: view.session.contextSelectionId }),
      f.browser.listExecutionOutput('s', job.id),
    ]);
    expect(workspaces).toEqual([{ id: 'w', name: 'private name' }]);
    expect(sessions.map((item) => item.id).sort()).toEqual(['other', 's']);
    expect(current.session.id).toBe('s');
    expect(current.storeId).toBe(f.storeId);
    expect(messages.every((item) => item.sessionId === 's')).toBe(true);
    expect(context.selection.id).toBe(view.session.contextSelectionId);
    expect(output.items.map((item) => item.content)).toEqual(['first α\n', 'second β\n']);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(before);
    expect(f.models).toBe(0);
    expect(f.jobs).toBe(1);
    expect(f.client.lastAppliedCursor).toBeUndefined();
    expect(f.requests.every((item) => item.authorization === null)).toBe(true);
  } finally {
    await f.close();
  }
});

test('Gateway seals trusted assets and binds their exact content identity without exposing arbitrary files', async () => {
  const f = await fixture();
  const assets = new Map([
    [
      '/index.html',
      {
        content: '<!doctype html><html><head></head><body>original assets</body></html>',
        mediaType: 'text/html; charset=utf-8',
      },
    ],
  ]);
  const first = startDevelopmentWeb({ admittedClient: f.client, assets });
  let second: ReturnType<typeof startDevelopmentWeb> | undefined;
  try {
    assets.set('/index.html', {
      content: '<!doctype html><html><head></head><body>changed assets</body></html>',
      mediaType: 'text/html; charset=utf-8',
    });
    const reply = await fetch(first.endpoint);
    const html = await reply.text();
    expect(html).toContain('original assets');
    expect(html).not.toContain('changed assets');
    expect(html).toContain(first.pageIdentity);
    second = startDevelopmentWeb({ admittedClient: f.client, assets });
    expect(second.pageIdentity).not.toBe(first.pageIdentity);
    expect(() =>
      startDevelopmentWeb({
        admittedClient: f.client,
        assets: new Map([['/private-file', { content: 'private', mediaType: 'text/plain' }]]),
      }),
    ).toThrow('invalid_browser_assets');
    const absent = await fetch(`${first.endpoint}/private-file`);
    expect(absent.status).toBe(404);
    await absent.body?.cancel();
    expect(f.models).toBe(0);
    expect(f.jobs).toBe(0);
  } finally {
    await second?.close();
    await first.close();
    await f.close();
  }
});

test('gateway close shares completion and waits for its actual admitted slow read after abort', async () => {
  const f = await fixture();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = f.client.listWorkspaces.bind(f.client);
  let aborted = false;
  f.client.listWorkspaces = async (options) => {
    const result = await original(options);
    entered();
    await held;
    aborted = options?.signal?.aborted === true;
    return result;
  };
  let settled = false;
  const request = f
    .raw('/browser/v1/workspaces')
    .then(async (reply) => await reply.text())
    .catch((error) => error);
  try {
    await started;
    const first = f.web.close();
    expect(f.web.close()).toBe(first);
    void first.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect((await f.store.getMetadata()).storeId).toBe(f.storeId);
    release();
    await first;
    await request;
    expect(aborted).toBe(true);
    expect(settled).toBe(true);
    expect(f.models).toBe(0);
    expect(f.jobs).toBe(0);
    expect((await f.store.getMetadata()).storeId).toBe(f.storeId);
  } finally {
    release();
    f.client.listWorkspaces = original;
    await f.close();
  }
});

test('Gateway streams complete real 17 MiB Model output and closes an interrupted transfer without replay', async () => {
  const f = await fixture(17 * 1024 * 1024);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    await f.client.startRun('s', {
      expectedStoreId: f.storeId,
      commandId: 'large-output',
      kind: 'run.start',
      content: 'small original input',
    });
    f.release();
    await f.runtime.waitForCommand('large-output', { timeoutMs: 40000 });
    const execution = (await f.store.listExecutions('s')).find((row) => row.kind === 'model')!;
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    const native = await f.client.getModelOutput('s', execution.id);
    const browser = await f.browser.getModelOutput('s', execution.id);
    expect(browser).toEqual(native);
    expect(browser.output.content).toBe(`${f.partial} complete`);
    const response = await f.raw(`/browser/v1/sessions/s/executions/${execution.id}/model-output`);
    expect(response.status).toBe(200);
    expect(Number(response.headers.get('x-model-output-size'))).toBeGreaterThan(17 * 1024 * 1024);
    reader = response.body!.getReader();
    expect((await reader.read()).value!.byteLength).toBeGreaterThan(0);
    const close = f.web.close();
    expect(f.web.close()).toBe(close);
    await close;
    await reader.cancel();
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect(f.models).toBe(1);
    expect(f.jobs).toBe(0);
    expect(f.runtime.getLifecycleState().state).toBe('accepting');
  } finally {
    await reader?.cancel();
    await f.close();
  }
}, 60000);
