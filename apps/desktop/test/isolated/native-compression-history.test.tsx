import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type ContextCompressor, createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { openSqliteStore, resolveProfile } from '@kite-ai/agent/sqlite';
import { createFixedModel } from '@kite-ai/ai';
import { createClient, type Message } from '@kite-ai/client';
import { startService } from '@kite-ai/service';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { NativeContext } from '../../electron/context';
import { decodeNativeRequest } from '../../electron/native-ipc';
import type { NativeBridge, NativeRequest, NativeSelection } from '../../src/native-bridge';
import { NativeContextView } from '../../src/native-context';

async function settle(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() >= deadline) throw Error('native_compression_history_dom_deadline');
    await act(async () => {
      await Bun.sleep(5);
    });
  }
}

test('Native original compression lookup reads its complete terminal Run beyond the actual 200-Run View without replay', async () => {
  const rootPath = realpathSync(mkdtempSync(join(tmpdir(), 'kite-native-compression-history-'))),
    selected = { dataRoot: join(rootPath, 'data'), profile: 'new' },
    store = await openSqliteStore(selected),
    storeId = (await store.getMetadata()).storeId,
    profile = {
      dataRoot: realpathSync(selected.dataRoot),
      name: selected.profile,
      accessKey: resolveProfile(selected).profileAccessKey,
    };
  const finish = {
    type: 'finish' as const,
    reason: 'stop' as const,
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  const summary = 'Original complete compression summary',
    model = createFixedModel([
      [{ type: 'text_delta', text: 'Original reply' }, finish],
      [{ type: 'text_delta', text: summary }, finish],
      ...Array.from({ length: 201 }, (_, index) => [
        { type: 'text_delta' as const, text: `Later actual reply ${index}` },
        finish,
      ]),
    ]),
    compressor: ContextCompressor = {
      id: 'fixture.history-compressor',
      version: '1',
      async prepare() {
        return { instructions: 'Summarize original history', snapshot: { fixture: 'history' } };
      },
      async validateSummary(input) {
        return input.summary === summary;
      },
    },
    runtime = createRuntime({
      store,
      artifacts: createArtifactStore({ profile: selected, store }),
      modelId: 'fixed',
      model,
      compressor,
      permissions: {
        async authorize() {
          return { allowed: true, revision: 'fixture' };
        },
      },
    });
  let service: Awaited<ReturnType<typeof startService>> | undefined,
    client: ReturnType<typeof createClient> | undefined,
    host: NativeContext | undefined,
    dom: JSDOM | undefined,
    rendered: ReturnType<typeof createRoot> | undefined;
  const originalFetch = globalThis.fetch,
    globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean },
    prior = {
      window: globals.window,
      document: globals.document,
      navigator: globals.navigator,
      IS_REACT_ACT_ENVIRONMENT: globals.IS_REACT_ACT_ENVIRONMENT,
    };
  try {
    service = await startService({
      runtime,
      profile,
      buildId: 'native-compression-history',
      subjectId: 'owner',
    });
    const current = createClient({
      endpoint: service.endpoint,
      token: service.bootstrap.token,
      bootstrap: service.bootstrap,
      expected: { profile, apiMajor: 1, requiredCapabilities: ['context', 'commands'] },
    });
    client = current;
    await current.connect();
    await current.createWorkspace({
      expectedStoreId: storeId,
      id: 'workspace',
      name: 'Workspace',
      rootUri: pathToFileURL(rootPath).href,
    });
    await current.createSession({
      expectedStoreId: storeId,
      commandId: 'create',
      sessionId: 'session',
      workspaceId: 'workspace',
      title: 'Original history',
    });
    await current.startRun('session', {
      kind: 'run.start',
      expectedStoreId: storeId,
      commandId: 'original',
      content: 'Original user content',
    });
    await runtime.waitForCommand('original', { timeoutMs: 5000 });
    const scope = {
      generation: 1,
      selection: 1,
      storeId,
      sessionId: 'session',
      workspaceId: 'workspace',
    };
    host = new NativeContext(
      current,
      () => scope,
      () => {},
    );
    const contextHost = host;
    const facts = await contextHost.read('session');
    await contextHost.maintainCompression(facts.observationId, 'compress', 'Original focus 🙂');
    const original = contextHost.compressionSubmissions[0]!;
    await runtime.waitForCommand(original.intent.commandId, { timeoutMs: 5000 });
    await contextHost.lookupCompression(original.intent.commandId);
    const context = await current.getContext('session', { storeId }),
      compression = context.compression!;
    expect(compression).toBeDefined();
    const originalCommand = await current.getCommand(original.intent.commandId),
      originalRun = await current.getRun(compression.runId),
      originalModel = await current.getExecution(compression.modelExecutionId);
    expect(originalRun.status).toBe('completed');
    expect(originalRun.originCommandId).toBe(original.intent.commandId);
    for (let index = 0; index < 201; index++) {
      const commandId = `later-${index}`;
      await current.startRun('session', {
        kind: 'run.start',
        expectedStoreId: storeId,
        commandId,
        content: `Later actual user ${index}`,
      });
      await runtime.waitForCommand(commandId, { timeoutMs: 5000 });
    }
    const boundedView = await current.getView('session');
    expect(boundedView.runs).toHaveLength(200);
    expect(boundedView.runs.every((run) => run.status === 'completed')).toBe(true);
    expect(boundedView.runs.some((run) => run.id === originalRun.id)).toBe(false);
    expect(await current.getRun(originalRun.id)).toEqual(originalRun);
    const readHistory = async () => {
      const messages: Message[] = [];
      let afterSeq = '0';
      for (;;) {
        const page = await current.listMessages('session', {
          afterSeq,
          upperSeq: boundedView.session.nextSeq,
          limit: 200,
        });
        messages.push(...page);
        if (page.length < 200) return messages;
        afterSeq = page.at(-1)!.seq;
      }
    };
    const beforeHistory = await readHistory(),
      beforeMetadata = await store.getMetadata(),
      beforeRequests = model.requests;
    expect(beforeRequests).toHaveLength(203);
    const wire: { method: string; path: string }[] = [];
    globalThis.fetch = Object.assign(
      async (...args: Parameters<typeof fetch>) => {
        const input = args[0],
          init = args[1],
          url = new URL(input instanceof Request ? input.url : String(input));
        wire.push({
          method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
          path: url.pathname,
        });
        return originalFetch(...args);
      },
      { preconnect: originalFetch.preconnect },
    );
    dom = new JSDOM('<div id="root"></div>');
    Object.assign(globals, {
      window: dom.window,
      document: dom.window.document,
      navigator: dom.window.navigator,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    rendered = createRoot(dom.window.document.getElementById('root')!);
    const calls: NativeRequest[] = [],
      lookupErrors: string[] = [];
    let lookups = 0;
    const bridge: NativeBridge = {
      watch: () => () => {},
      async request(input) {
        const request = decodeNativeRequest(input);
        calls.push(request);
        switch (request.method) {
          case 'lookupCompression':
            try {
              return await contextHost.lookupCompression(request.commandId);
            } catch (error) {
              lookupErrors.push((error as { code?: string }).code ?? 'lookup_failed');
              throw error;
            } finally {
              lookups++;
            }
          case 'context.close':
            contextHost.close(request.readId);
            return null;
          default:
            throw Error('unexpected_history_request');
        }
      },
    };
    const selection: NativeSelection = {
      storeId,
      viewGeneration: 1,
      viewSelection: 1,
      canReadModelOutput: false,
      canReadContext: true,
      session: boundedView.session,
      runs: boundedView.runs,
      executions: boundedView.executions,
      interactions: [],
      interactionsAfterId: null,
    };
    const renderPage = () =>
      act(async () =>
        rendered!.render(
          <NativeContextView
            bridge={bridge}
            generation={1}
            selection={selection}
            compressionSubmissions={contextHost.compressionSubmissions}
            onRefresh={async () => {}}
          />,
        ),
      );
    await renderPage();
    const button = [...dom.window.document.querySelectorAll('button')].find(
      (value) => value.textContent === '查询原压缩命令与执行',
    )!;
    expect(button).toBeDefined();
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    await settle(() => lookups === 1);
    await renderPage();
    expect(lookupErrors).toEqual([]);
    expect(Boolean(dom.window.document.querySelector('[role="alert"]'))).toBe(false);
    expect(dom.window.document.body.textContent).toContain('压缩原轮次：completed');
    expect(contextHost.compressionSubmissions[0]?.run).toEqual(originalRun);
    expect(calls.filter((call) => call.method === 'lookupCompression')).toEqual([
      { method: 'lookupCompression', generation: 1, commandId: original.intent.commandId },
    ]);
    expect(wire.some((request) => request.path === `/v1/runs/${originalRun.id}`)).toBe(true);
    expect(wire.every((request) => request.method === 'GET')).toBe(true);
    expect(await current.getCommand(original.intent.commandId)).toEqual(originalCommand);
    expect(await current.getRun(originalRun.id)).toEqual(originalRun);
    expect(await current.getExecution(compression.modelExecutionId)).toEqual(originalModel);
    expect(await readHistory()).toEqual(beforeHistory);
    expect(await current.getView('session')).toEqual(boundedView);
    expect(await store.getMetadata()).toEqual(beforeMetadata);
    expect(model.requests).toEqual(beforeRequests);
  } finally {
    globalThis.fetch = originalFetch;
    if (rendered) await act(async () => rendered!.unmount());
    host?.release();
    dom?.window.close();
    Object.assign(globals, prior);
    client?.disposeNetwork();
    try {
      if (service) await service.close();
      else await runtime.close();
    } finally {
      await store.close();
      rmSync(rootPath, { recursive: true, force: true });
    }
  }
}, 90000);
