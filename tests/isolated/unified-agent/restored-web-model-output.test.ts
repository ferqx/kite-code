import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createProfileBackup, restoreProfileBackup } from '@kite-ai/agent/maintenance';
import { openSqliteStore, resolveProfile } from '@kite-ai/agent/sqlite';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { createBrowserClient } from '@kite-ai/client/browser';
import { startService } from '@kite-ai/service';
import { startDevelopmentWeb } from '@kite-ai/service/development-web';
import { mountWebPage } from '@kite-ai/web';
import { JSDOM } from 'jsdom';
import { act } from 'react';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};

async function settle(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() >= deadline) throw Error('restored_web_dom_deadline');
    await act(async () => {
      await Bun.sleep(5);
    });
  }
}

test('actual restored Web page reads original plain and sealed full Model bodies through cold Cookie HTTP without replay', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-restored-web-model-')));
  const selected = { dataRoot: join(root, 'data'), profile: 'new' };
  const store = await openSqliteStore(selected);
  const originalStoreId = (await store.getMetadata()).storeId;
  const profile = {
    dataRoot: realpathSync(selected.dataRoot),
    name: selected.profile,
    accessKey: resolveProfile(selected).profileAccessKey,
  };
  const content = `Original recorded answer\n${'Original text 原🌿e\u0301 '.repeat(4096).trimEnd()}\nWEB_RESTORED_EXACT_TAIL`;
  const reasoning = 'Original private reasoning 雪🙂';
  const smallContent = 'Original complete small answer';
  const toolCall = { id: 'original-check', name: 'fixture.check', arguments: '{}' };
  const model = createFixedModel([
    [
      { type: 'text_delta', text: content },
      { type: 'reasoning_delta', text: reasoning },
      { type: 'tool_call', ...toolCall },
      { ...finish, reason: 'tool_calls' },
    ],
    [{ type: 'text_delta', text: smallContent }, finish],
  ]);
  let effects = 0;
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile: selected, store }),
    model,
    modelId: 'fixed',
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
            id: 'fixture.check',
            version: '1',
            description: 'The original Tool effect',
            inputSchema: { type: 'object' },
            async execute() {
              effects++;
              return { outcome: 'succeeded', content: 'Original Tool checked' };
            },
          },
        ],
      },
    ],
  });
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  let client: ReturnType<typeof createClient> | undefined;
  let gateway: ReturnType<typeof startDevelopmentWeb> | undefined;
  let browser: ReturnType<typeof createBrowserClient> | undefined;
  let dom: JSDOM | undefined;
  let handle: Awaited<ReturnType<typeof mountWebPage>> | undefined;
  const originalFetch = globalThis.fetch;
  const globals = new Map<string, PropertyDescriptor | undefined>();
  const restoreDOM = () => {
    dom?.window.close();
    dom = undefined;
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    globals.clear();
  };
  try {
    service = await startService({
      runtime,
      profile,
      buildId: 'restored-web-original',
      subjectId: 'owner',
    });
    client = createClient({
      endpoint: service.endpoint,
      token: service.bootstrap.token,
      bootstrap: service.bootstrap,
      expected: { profile, apiMajor: 1, requiredCapabilities: ['model_outputs'] },
    });
    await client.connect();
    await client.createWorkspace({
      expectedStoreId: originalStoreId,
      id: 'workspace',
      name: 'Original workspace',
      rootUri: pathToFileURL(root).href,
    });
    await client.createSession({
      expectedStoreId: originalStoreId,
      sessionId: 'source',
      workspaceId: 'workspace',
      commandId: 'create-source',
      title: 'Original source',
    });
    await client.startRun('source', {
      expectedStoreId: originalStoreId,
      commandId: 'original-run',
      kind: 'run.start',
      content: 'Original selected work',
    });
    await runtime.waitForCommand('original-run', { timeoutMs: 5000 });
    const source = await client.getView('source');
    const originalMessages = await client.listMessages('source');
    const models = originalMessages.filter((message) => message.outputBody);
    const inputs = await client.listModelInputs('source');
    expect(inputs.items).toHaveLength(2);
    expect(models).toHaveLength(1);
    expect(model.requests).toHaveLength(2);
    expect(effects).toBe(1);
    const savedBodies = await Promise.all(
      inputs.items.map((input) => client!.getModelOutput('source', input.executionId)),
    );
    expect(savedBodies[0]!.output).toEqual({
      content,
      reasoning,
      toolCalls: [toolCall],
      complete: true,
    });
    expect(savedBodies[1]!.output.content).toBe(smallContent);
    const smallMessage = originalMessages.find(
      (message) => message.role === 'assistant' && message.content === smallContent,
    )!;
    expect(smallMessage.outputBody).toBeUndefined();
    expect(models[0]!.content).not.toContain('WEB_RESTORED_EXACT_TAIL');
    const originalExecutions = await Promise.all(
      source.executions.map((execution) => client!.getExecution(execution.id)),
    );
    const originalRuns = await Promise.all(source.runs.map((run) => client!.getRun(run.id)));
    expect(originalExecutions).toHaveLength(3);
    expect(
      originalExecutions.every((execution) => execution.originStoreId === originalStoreId),
    ).toBe(true);
    const fork = await client.forkSession('source', {
      expectedStoreId: originalStoreId,
      commandId: 'fork',
      expectedContextSelectionId: source.session.contextSelectionId,
      newSessionId: 'sealed',
      title: 'Original sealed branch',
    });
    expect(fork.command.status).toBe('applied');
    const sealedMessages = await client.listMessages('sealed');
    expect(sealedMessages).toHaveLength(originalMessages.length);
    expect(
      sealedMessages.every((message) => message.originMessage?.storeId === originalStoreId),
    ).toBe(true);
    const originalCommands = await Promise.all(
      ['create-source', 'original-run', 'fork'].map((id) => client!.getCommand(id)),
    );
    client.disposeNetwork();
    client = undefined;
    await service.close();
    service = undefined;
    const backup = await createProfileBackup({
      profile: selected,
      destinationRoot: join(root, 'backups'),
    });
    const restored = await restoreProfileBackup({
      profile: selected,
      expectedStoreId: originalStoreId,
      backup,
      intent: 'replace_with_selected_backup',
    });
    expect(restored.outcome).toBe('restored');
    expect(restored.storeId).not.toBe(originalStoreId);
    let coldModelCalls = 0;
    for (let cold = 0; cold < 2; cold++) {
      const currentStore = await openSqliteStore(selected);
      const currentRuntime = createRuntime({
        store: currentStore,
        artifacts: createArtifactStore({ profile: selected, store: currentStore }),
        modelId: 'fixed',
        model: {
          async *stream() {
            coldModelCalls++;
            yield finish;
          },
        },
        permissions: {
          async authorize() {
            throw Error('restored_web_must_not_authorize');
          },
        },
        sources: {
          async capture() {
            throw Error('restored_web_must_not_capture');
          },
        },
      });
      service = await startService({
        runtime: currentRuntime,
        profile,
        buildId: 'restored-web-current',
        subjectId: 'owner',
      });
      const requests: { method: string; url: string }[] = [];
      globalThis.fetch = Object.assign(
        async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          requests.push({
            method: init?.method ?? (url instanceof Request ? url.method : 'GET'),
            url: url instanceof Request ? url.url : String(url),
          });
          return originalFetch(url, init);
        },
        { preconnect: originalFetch.preconnect },
      );
      client = createClient({
        endpoint: service.endpoint,
        token: service.bootstrap.token,
        bootstrap: service.bootstrap,
        expected: { profile, apiMajor: 1, requiredCapabilities: ['model_outputs'] },
      });
      await client.connect();
      expect(client.serverInfo?.storeId).toBe(restored.storeId);
      gateway = startDevelopmentWeb({ admittedClient: client });
      const document = await fetch(gateway.endpoint);
      await document.body?.cancel();
      const cookie = document.headers.get('set-cookie')!.split(';')[0]!;
      const endpoint = gateway.endpoint;
      browser = createBrowserClient({
        origin: endpoint,
        pageIdentity: gateway.pageIdentity,
        fetch: Object.assign(
          async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
            const headers = new Headers(init?.headers);
            headers.set('cookie', cookie);
            headers.set('origin', endpoint);
            return fetch(url, { ...init, headers });
          },
          { preconnect: fetch.preconnect },
        ),
      });
      await browser.connect();
      const metadata = await currentStore.getMetadata();
      expect(await browser.listMessages('source')).toEqual(originalMessages);
      expect(await browser.listMessages('sealed')).toEqual(sealedMessages);
      for (const saved of savedBodies) {
        const loaded = await browser.getModelOutput('source', saved.executionId);
        expect(loaded.storeId).toBe(restored.storeId);
        const { storeId: _oldStore, snapshotCursor: _oldCursor, ...original } = saved;
        const { storeId: _newStore, snapshotCursor: _newCursor, ...current } = loaded;
        expect(current).toEqual(original);
      }
      await expect(browser.getModelOutput('sealed', savedBodies[0]!.executionId)).rejects.toThrow(
        'model_input_scope_denied',
      );
      dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
        url: `${endpoint}/sessions/sealed`,
        pretendToBeVisual: true,
      });
      const page = dom.window;
      for (const [key, value] of Object.entries({
        window: page,
        document: page.document,
        HTMLElement: page.HTMLElement,
        IS_REACT_ACT_ENVIRONMENT: true,
      })) {
        globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
        Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
      }
      let copied = '';
      Object.defineProperty(page.navigator, 'clipboard', {
        configurable: true,
        value: {
          async writeText(text: string) {
            copied = text;
          },
        },
      });
      await act(async () => {
        handle = await mountWebPage({
          window: page as unknown as Window,
          element: page.document.getElementById('root')!,
          client: browser,
          pollIntervalMs: 100,
        });
      });
      const button = (text: string, target: ParentNode = page.document) => {
        const found = [...target.querySelectorAll('button')].find(
          (element) => element.textContent === text,
        );
        if (!found) throw Error(`restored_web_button_missing:${text}`);
        return found;
      };
      const click = async (element: Element) => {
        await act(async () => {
          element.dispatchEvent(new page.MouseEvent('click', { bubbles: true, cancelable: true }));
        });
      };
      await settle(
        () => page.document.querySelectorAll('[data-message-id]').length === sealedMessages.length,
      );
      await click(button('Original workspace'));
      await settle(() => !!page.document.querySelector('a[href="/sessions/source"]'));
      for (const [sessionId, messages] of [
        ['sealed', sealedMessages],
        ['source', originalMessages],
      ] as const) {
        await click(page.document.querySelector(`a[href="/sessions/${sessionId}"]`)!);
        await settle(
          () =>
            page.document.querySelector('h1')?.textContent ===
            (sessionId === 'sealed' ? 'Original sealed branch' : 'Original source'),
        );
        await settle(
          () => page.document.querySelectorAll('[data-message-id]').length === messages.length,
        );
        const modelMessages = messages.filter((message) => message.outputBody);
        const inline = messages.find((message) => message.content === smallContent)!;
        const inlineArticle = page.document.querySelector(`[data-message-id="${inline.id}"]`)!;
        expect(inlineArticle.textContent).toBe(smallContent);
        expect(inlineArticle.querySelector('button')).toBeNull();
        for (const [index, message] of modelMessages.entries()) {
          const article = page.document.querySelector(`[data-message-id="${message.id}"]`)!;
          const expected = savedBodies[index]!;
          const before = requests.filter((request) => request.url.includes('/model-output')).length;
          expect(article.textContent).not.toContain(reasoning);
          expect(article.textContent).toContain('Model output preview');
          await click(button('Read complete recorded Model output', article));
          await settle(
            () =>
              !!article.querySelector('[role="alert"]') ||
              !![...article.querySelectorAll('p')].find(
                (element) => element.textContent === 'Complete Model output',
              ),
          );
          console.log('restored-web-model-reader', {
            cold,
            sessionId,
            originalStoreId,
            currentStoreId: restored.storeId,
            originalSessionId: message.originMessage?.sessionId ?? message.sessionId,
            originalRunId: message.originMessage?.runId ?? message.runId,
            executionId: message.outputBody!.executionId,
            error: article.querySelector('[role="alert"]')?.textContent ?? null,
            reads:
              requests.filter((request) => request.url.includes('/model-output')).length - before,
          });
          expect(article.querySelector('.message-markdown')?.textContent?.trim()).toBe(
            expected.output.content,
          );
          expect(article.textContent).not.toContain(reasoning);
          if (index === 0)
            expect(article.textContent).toContain(JSON.stringify([toolCall], null, 2));
          await click(button('Copy conversation'));
          expect(copied).toContain(expected.output.content);
          expect(copied).not.toContain(reasoning);
          await click(button('Close full Model output', article));
          expect(article.textContent).toContain('Model output preview');
          await click(button('Copy conversation'));
          if (index === 0) expect(copied).not.toContain('WEB_RESTORED_EXACT_TAIL');
          expect(copied).toContain(message.content);
        }
      }
      const plain = page.document.querySelector(`[data-message-id="${models[0]!.id}"]`)!;
      await click(button('Read complete recorded Model output', plain));
      await settle(() => plain.textContent!.includes('WEB_RESTORED_EXACT_TAIL'));
      await click(page.document.querySelector('a[href="/sessions/sealed"]')!);
      await settle(
        () => page.document.querySelector('h1')?.textContent === 'Original sealed branch',
      );
      expect(page.document.body.textContent).not.toContain('WEB_RESTORED_EXACT_TAIL');
      await click(button('Copy conversation'));
      expect(copied).not.toContain('WEB_RESTORED_EXACT_TAIL');
      expect(await browser.listMessages('source')).toEqual(originalMessages);
      expect(await browser.listMessages('sealed')).toEqual(sealedMessages);
      expect(
        await Promise.all(
          originalExecutions.map((execution) => client!.getExecution(execution.id)),
        ),
      ).toEqual(originalExecutions);
      expect(await Promise.all(originalRuns.map((run) => client!.getRun(run.id)))).toEqual(
        originalRuns,
      );
      expect(
        await Promise.all(originalCommands.map((command) => client!.getCommand(command.id))),
      ).toEqual(originalCommands);
      expect(await currentStore.getMetadata()).toEqual(metadata);
      expect(requests.every((request) => request.method === 'GET')).toBe(true);
      expect(client.lastAppliedCursor).toBeUndefined();
      expect(coldModelCalls).toBe(0);
      expect(model.requests).toHaveLength(2);
      expect(effects).toBe(1);
      await act(async () => handle!.dispose());
      handle = undefined;
      restoreDOM();
      browser.disposeNetwork();
      browser = undefined;
      await gateway.close();
      gateway = undefined;
      client.disposeNetwork();
      client = undefined;
      await service.close();
      service = undefined;
      globalThis.fetch = originalFetch;
    }
  } finally {
    if (handle) await act(async () => handle!.dispose());
    restoreDOM();
    browser?.disposeNetwork();
    await gateway?.close();
    client?.disposeNetwork();
    globalThis.fetch = originalFetch;
    if (service) await service.close();
    else await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
