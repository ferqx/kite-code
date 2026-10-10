import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ContextCompressor, createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createProfileBackup, restoreProfileBackup } from '@kite-ai/agent/maintenance';
import { openSqliteStore, resolveProfile } from '@kite-ai/agent/sqlite';
import { createFixedModel } from '@kite-ai/ai';
import { canonicalModelBody, createClient, type ModelInputSnapshot } from '@kite-ai/client';
import { startService } from '@kite-ai/service';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { NativeCaller } from '../../electron/native-caller';
import { decodeNativeRequest } from '../../electron/native-ipc';
import type {
  NativeBridge,
  NativeEvent,
  NativeModelInputChunk,
  NativeModelInputOpen,
  NativeRequest,
} from '../../src/native-bridge';
import { prepareDesktopDom } from '../native-page-dom.fixture';

const bootstrap = new JSDOM('<div></div>', { pretendToBeVisual: true });
const originals = {
  window: globalThis.window,
  document: globalThis.document,
  navigator: globalThis.navigator,
};
Object.assign(globalThis, {
  window: bootstrap.window,
  document: bootstrap.window.document,
  navigator: bootstrap.window.navigator,
});
const { createRoot } = await import('react-dom/client');
const { NativeDesktop } = await import('../../src/native');
Object.assign(globalThis, originals);
bootstrap.window.close();

async function settle(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() >= deadline) throw Error('restored_compression_input_dom_deadline');
    await act(async () => {
      await Bun.sleep(5);
    });
  }
}

test('restored compression opens the exact sensitive original input through the actual Native page, Main and public Core, with close, selection cancellation and cold zero replay', async () => {
  const rootPath = realpathSync(mkdtempSync(join(tmpdir(), 'kite-native-restored-compression-')));
  const selected = { dataRoot: join(rootPath, 'data'), profile: 'new' };
  const originalStore = await openSqliteStore(selected);
  const originalStoreId = (await originalStore.getMetadata()).storeId;
  const profile = {
    dataRoot: realpathSync(selected.dataRoot),
    name: selected.profile,
    accessKey: resolveProfile(selected).profileAccessKey,
  };
  const originalText = `Original user\r\n${'完整历史🌿e\u0301 '.repeat(4096)}\r\nORIGINAL HISTORY END`;
  const focus = `Exact compression focus\r\n${'保留重点雪🙂 '.repeat(1024)}\r\nORIGINAL FOCUS END`;
  const instructions = 'Summarize the complete selected history without any tools';
  const summary = 'Actual recorded summary of the original full user and assistant';
  const compressor: ContextCompressor = {
    id: 'fixture.recorded-compressor',
    version: '1',
    async prepare() {
      return { instructions, snapshot: { originalAlgorithm: 'fixture', version: 1 } };
    },
    async validateSummary(input) {
      return input.summary === summary;
    },
  };
  const finish = {
    type: 'finish' as const,
    reason: 'stop' as const,
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  const originalModel = createFixedModel([
    [{ type: 'text_delta', text: 'Original assistant reply' }, finish],
    [{ type: 'text_delta', text: summary }, finish],
  ]);
  const runtimeOptions = {
    modelId: 'fixed',
    compressor,
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'trusted-fixture' };
      },
    },
  };
  const runtime = createRuntime({
    ...runtimeOptions,
    store: originalStore,
    artifacts: createArtifactStore({ profile: selected, store: originalStore }),
    model: originalModel,
  });
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  let client: ReturnType<typeof createClient> | undefined;
  let caller: NativeCaller | undefined;
  let dom: JSDOM | undefined;
  let rendered: ReturnType<typeof createRoot> | undefined;
  let restoreDom: (() => void) | undefined;
  let releaseHeld: (() => void) | undefined;
  const originalFetch = globalThis.fetch;
  const prior = {
    ...originals,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT,
  };
  const methods: string[] = [];
  const connect = async (currentRuntime: ReturnType<typeof createRuntime>, buildId: string) => {
    service = await startService({ runtime: currentRuntime, profile, buildId, subjectId: 'owner' });
    client = createClient({
      endpoint: service.endpoint,
      token: service.bootstrap.token,
      expected: { profile, apiMajor: 1, requiredCapabilities: ['context', 'model_inputs'] },
      bootstrap: service.bootstrap,
    });
    await client.connect();
    return client;
  };
  const closePage = async () => {
    releaseHeld?.();
    releaseHeld = undefined;
    if (rendered) await act(async () => rendered!.unmount());
    rendered = undefined;
    // Radix focus restoration runs on its next timer; finish it before releasing browser globals.
    if (dom)
      await act(async () => {
        await Bun.sleep(5);
      });
    await caller?.close();
    caller = undefined;
    dom?.window.close();
    dom = undefined;
    restoreDom?.();
    restoreDom = undefined;
    Object.assign(globalThis, prior);
  };
  const close = async () => {
    await closePage();
    client?.disposeNetwork();
    client = undefined;
    await service?.close();
    service = undefined;
  };
  const mount = async (current: ReturnType<typeof createClient>) => {
    const calls: NativeRequest[] = [];
    const opened: NativeModelInputOpen[] = [];
    const chunks: NativeModelInputChunk[] = [];
    const listeners = new Set<(event: NativeEvent) => void>();
    let holdNext = false;
    let held: NativeModelInputOpen | undefined;
    let holding = false;
    const native = new NativeCaller(current, (event) => {
      for (const listener of listeners) listener(event);
    });
    caller = native;
    const bridge: NativeBridge = {
      watch(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async request(input) {
        const request = decodeNativeRequest(input);
        calls.push(request);
        const result = await native.invoke(request);
        if (
          request.method === 'modelInput.open' &&
          result &&
          'readId' in result &&
          'kind' in result
        ) {
          if (result.kind !== 'modelInput.opened') throw Error('unexpected_original_input_open');
          opened.push(result);
          if (holdNext) {
            holdNext = false;
            held = result;
            holding = true;
            // Delay only the real Main reply after its real Core GET; no body or scope is invented.
            await new Promise<void>((resolve) => {
              releaseHeld = resolve;
            });
            holding = false;
          }
        }
        if (
          request.method === 'modelInput.read' &&
          result &&
          'readId' in result &&
          'kind' in result
        ) {
          if (result.kind !== 'modelInput.chunk') throw Error('unexpected_original_input_chunk');
          chunks.push(result);
        }
        return result;
      },
    };
    dom = new JSDOM('<div id="root"></div>', {
      url: 'http://localhost',
      pretendToBeVisual: true,
    });
    restoreDom = prepareDesktopDom(dom);
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      navigator: dom.window.navigator,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    Object.assign(dom.window, { kiteNative: bridge });
    const host = dom.window.document.getElementById('root')!;
    rendered = createRoot(host);
    const button = (text: string, scope: Element = host) =>
      [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
        (value) => value.textContent === text,
      );
    const click = async (text: string, scope?: Element) => {
      const target = button(text, scope);
      expect(target).toBeDefined();
      expect(target!.disabled).toBe(false);
      await act(async () => target!.click());
    };
    const select = async (title: string) => {
      await settle(() => !!host.querySelector('nav[aria-label="当前项目会话"]'));
      const nav = host.querySelector('nav[aria-label="当前项目会话"]')!;
      const target = [...nav.querySelectorAll<HTMLButtonElement>('button')].find(
        (value) => value.getAttribute('aria-label') === title,
      );
      expect(target).toBeDefined();
      await act(async () => target!.click());
      await settle(() => target!.getAttribute('aria-current') === 'page');
      // This read-only admitted Main has no Node private UI database. Keep its real draft failure
      // visible and dismiss the actual alert; neither the bridge nor saved input is substituted.
      await settle(() => !!dom!.window.document.querySelector('[role="alertdialog"]'));
      const alert = dom!.window.document.querySelector('[role="alertdialog"]')!;
      expect(alert.textContent).toContain('draft_storage_unavailable');
      await click('确定', alert);
    };
    await act(async () => rendered!.render(<NativeDesktop />));
    await select('Original compression');
    await settle(() => !!button('会话工具'));
    await click('会话工具');
    await settle(() => !!button('读取当前所选上下文'));
    await click('读取当前所选上下文');
    await settle(() => !!host.querySelector('section[aria-label="手动上下文压缩"]'));
    return {
      host,
      calls,
      opened,
      chunks,
      button,
      click,
      select,
      hold() {
        holdNext = true;
      },
      get held() {
        return held;
      },
      get holding() {
        return holding;
      },
    };
  };
  try {
    const original = await connect(runtime, 'original-compression');
    await original.createWorkspace({
      expectedStoreId: originalStoreId,
      id: 'workspace',
      name: 'Original workspace',
      rootUri: `file://${rootPath}`,
    });
    for (const [sessionId, title] of [
      ['session', 'Original compression'],
      ['other', 'Other session'],
    ] as const)
      await original.createSession({
        expectedStoreId: originalStoreId,
        sessionId,
        workspaceId: 'workspace',
        commandId: `create-${sessionId}`,
        title,
      });
    await original.startRun('session', {
      expectedStoreId: originalStoreId,
      commandId: 'original-run',
      kind: 'run.start',
      content: originalText,
    });
    await runtime.waitForCommand('original-run', { timeoutMs: 5000 });
    const selectedContext = await original.getContext('session', { storeId: originalStoreId });
    await original.compressContext('session', {
      expectedStoreId: originalStoreId,
      commandId: 'original-compression',
      expectedContextSelectionId: selectedContext.selection.id,
      focus,
    });
    await runtime.waitForCommand('original-compression', { timeoutMs: 5000 });
    const originalContext = await original.getContext('session', { storeId: originalStoreId });
    const compression = originalContext.compression!;
    expect(compression).toBeDefined();
    expect(compression.originStoreId).toBe(originalStoreId);
    expect(compression.originSessionId).toBe('session');
    expect(originalModel.requests).toHaveLength(2);
    const originalRequest = structuredClone(originalModel.requests[1]!);
    const originalInput = await original.getModelInput('session', compression.modelExecutionId, {
      expectedStoreId: originalStoreId,
    });
    expect(originalRequest).toEqual(originalInput.request);
    expect(originalRequest.tools).toEqual([]);
    expect(originalRequest.messages.some((message) => message.content === originalText)).toBe(true);
    expect(originalRequest.messages.some((message) => message.content.includes(focus))).toBe(true);
    expect(originalRequest.messages.some((message) => message.content.includes(instructions))).toBe(
      true,
    );
    const requestBytes = Buffer.from(canonicalModelBody(originalRequest));
    expect(requestBytes.byteLength).toBeGreaterThan(65536);
    expect(originalInput.bodyBytes).toBe(String(requestBytes.byteLength));
    expect(originalInput.bodyHash).toBe(createHash('sha256').update(requestBytes).digest('hex'));
    const originalExecution = (await originalStore.getExecution(compression.modelExecutionId))!;
    const originalRun = (await originalStore.getRun(compression.runId))!;
    const originalCommand = await original.getCommand('original-compression');
    await close();
    const backup = await createProfileBackup({
      profile: selected,
      destinationRoot: join(rootPath, 'backups'),
    });
    const restored = await restoreProfileBackup({
      profile: selected,
      expectedStoreId: originalStoreId,
      backup,
      intent: 'replace_with_selected_backup',
    });
    expect(restored.outcome).toBe('restored');
    expect(restored.storeId).not.toBe(originalStoreId);
    globalThis.fetch = Object.assign(
      async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        methods.push(init?.method ?? (url instanceof Request ? url.method : 'GET'));
        return originalFetch(url, init);
      },
      { preconnect: originalFetch.preconnect },
    );
    const verifyRead = async (page: Awaited<ReturnType<typeof mount>>, snapshotCursor: string) => {
      expect(page.host.textContent).toContain(`原存储 ${originalStoreId}`);
      expect(page.host.textContent).toContain(compression.modelExecutionId);
      expect(page.host.textContent).toContain(compression.runId);
      expect(page.button('查看此压缩的原模型输入')).toBeDefined();
      const readsBefore = page.opened.length;
      await page.click('查看此压缩的原模型输入');
      const panel = page.host.querySelector('.model-input-panel')!;
      expect(panel.textContent).toContain(compression.modelExecutionId);
      expect(panel.textContent).toContain('Sensitive local diagnostic');
      expect(panel.querySelectorAll('article')).toHaveLength(0);
      expect(page.opened).toHaveLength(readsBefore);
      await page.click('Confirm read original input', panel);
      await settle(() => !!panel.querySelector('article'));
      const opened = page.opened.at(-1)!;
      expect(opened.storeId).toBe(restored.storeId);
      expect(opened.sessionId).toBe('session');
      expect(opened.executionId).toBe(compression.modelExecutionId);
      expect(opened.bodyBytes).toBe(originalInput.bodyBytes);
      expect(opened.bodyHash).toBe(originalInput.bodyHash);
      const chunks = page.chunks.filter((chunk) => chunk.readId === opened.readId);
      expect(chunks.length).toBeGreaterThan(1);
      let offset = 0;
      for (const chunk of chunks) {
        const bytes = Buffer.from(chunk.data, 'base64');
        expect(chunk.offset).toBe(offset);
        expect(bytes.byteLength).toBeLessThanOrEqual(65536);
        offset += bytes.byteLength;
        expect(chunk.nextOffset).toBe(offset);
      }
      expect(chunks.at(-1)!.eof).toBe(true);
      expect(String(offset)).toBe(opened.wireBytes);
      const snapshot = JSON.parse(
        Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.data, 'base64'))).toString('utf8'),
      ) as ModelInputSnapshot;
      expect(snapshot).toEqual({
        ...originalInput,
        storeId: restored.storeId,
        snapshotCursor,
      });
      expect(originalRequest).toEqual(snapshot.request);
      expect(snapshot.metadata).toEqual(originalInput.metadata);
      expect(
        [...panel.querySelectorAll('article > pre:first-of-type')].map((pre) => pre.textContent),
      ).toEqual(originalRequest.messages.map((message) => message.content));
      expect(panel.textContent).toContain('Tools · original order');
      expect(panel.textContent).toContain('Frozen adapter and request settings');
      expect(panel.textContent).toContain('Frozen assembly and source identities');
      expect(panel.textContent).toContain(originalInput.originCommandId);
      expect(panel.textContent).toContain(originalInput.bodyBytes);
      expect(
        page.calls.some(
          (call) => call.method === 'modelInput.close' && call.readId === opened.readId,
        ),
      ).toBe(true);
      return panel;
    };
    for (const cold of [false, true]) {
      const currentStore = await openSqliteStore(selected);
      const currentModel = createFixedModel([]);
      const currentRuntime = createRuntime({
        ...runtimeOptions,
        store: currentStore,
        artifacts: createArtifactStore({ profile: selected, store: currentStore }),
        model: currentModel,
      });
      const current = await connect(
        currentRuntime,
        cold ? 'cold-compression-input' : 'restored-compression-input',
      );
      expect(current.serverInfo?.storeId).toBe(restored.storeId);
      const before = await currentStore.getMetadata();
      expect(
        (await current.getContext('session', { storeId: restored.storeId })).compression,
      ).toEqual(compression);
      expect(await currentStore.getExecution(compression.modelExecutionId)).toEqual(
        originalExecution,
      );
      expect(await currentStore.getRun(compression.runId)).toEqual(originalRun);
      expect(await current.getCommand('original-compression')).toEqual(originalCommand);
      const page = await mount(current);
      expect(page.opened).toHaveLength(0);
      const panel = await verifyRead(page, before.lastChangeCursor);
      await page.click('Close Model inspector', panel);
      expect(page.host.querySelector('.model-input-panel')).toBeNull();
      if (!cold) {
        await page.click('查看此压缩的原模型输入');
        page.hold();
        await page.click('Confirm read original input');
        await settle(() => !!page.held);
        expect(
          page.host.querySelector('.model-input-panel')?.querySelectorAll('article'),
        ).toHaveLength(0);
        const held = page.held!;
        await page.select('Other session');
        await settle(() =>
          page.calls.some(
            (call) => call.method === 'modelInput.close' && call.readId === held.readId,
          ),
        );
        expect(page.host.querySelector('.model-input-panel')).toBeNull();
        releaseHeld!();
        releaseHeld = undefined;
        await settle(() => !page.holding);
        expect(page.host.querySelector('.model-input-panel')).toBeNull();
        expect(page.chunks.some((chunk) => chunk.readId === held.readId)).toBe(false);
        expect(page.host.textContent).not.toContain('ORIGINAL FOCUS END');
      }
      expect(currentModel.requests).toHaveLength(0);
      expect((await currentStore.getMetadata()).lastChangeCursor).toBe(before.lastChangeCursor);
      expect(await currentStore.getExecution(compression.modelExecutionId)).toEqual(
        originalExecution,
      );
      expect(await currentStore.getRun(compression.runId)).toEqual(originalRun);
      expect(await current.getCommand('original-compression')).toEqual(originalCommand);
      await close();
    }
    expect(originalModel.requests).toHaveLength(2);
    expect(methods.length).toBeGreaterThan(0);
    expect(methods.every((method) => method === 'GET')).toBe(true);
  } finally {
    releaseHeld?.();
    await close();
    globalThis.fetch = originalFetch;
    Object.assign(globalThis, prior);
    rmSync(rootPath, { recursive: true, force: true });
  }
});
