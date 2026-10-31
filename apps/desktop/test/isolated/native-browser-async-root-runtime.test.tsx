import { expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { deflateSync, inflateSync } from 'node:zlib';
import { type AgentRuntime, createRuntime } from '@kite-ai/agent';
import * as browserApi from '@kite-ai/agent/browser';
import type { Extension, Json } from '@kite-ai/agent/extensions';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createFixedModel, type ModelEvent, type ModelRequest } from '@kite-ai/ai';
import type { AgentClient, ExtensionCommandRequest } from '@kite-ai/client';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { NativeBrowserPageHost } from '../../electron/browser-page-host';
import { callerMetadata, NativeCallerJournal } from '../../electron/caller-journal';
import { NativeExtensions } from '../../electron/extensions';
import { decodeNativeRequest } from '../../electron/native-ipc';
import type { NativeExtensionScope } from '../../src/extensions-bridge';
import type { NativeBridge, NativeRequest } from '../../src/native-bridge';
import {
  type NativeBrowserMenuAction,
  type NativeBrowserMenuRequest,
  type NativeBrowserRequest,
  type NativeBrowserState,
  nativeBrowserChannel,
  nativeBrowserEventChannel,
} from '../../src/native-browser-bridge';
import { prepareDesktopDom } from '../native-page-dom.fixture';
import { memoryPrivateData } from '../private-data.fixture';
import { sessionSwitchBridge } from '../session-switch-bridge.fixture';

// Real solid-gray PNG/JPEG bytes keep the Main encoder, DPR and hash/proof
// boundary exercised. The fixture substitutes image codecs, not their metadata.
function pngChunk(type: string, data: Buffer) {
  const body = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const length = Buffer.alloc(4),
    checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, body, checksum]);
}
class FixtureImage {
  readonly width: number;
  readonly height: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
  isEmpty() {
    return this.width <= 0 || this.height <= 0;
  }
  getSize() {
    return { width: this.width, height: this.height };
  }
  resize(size: { width: number; height: number }) {
    return new FixtureImage(size.width, size.height);
  }
  toPNG() {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(this.width, 0);
    header.writeUInt32BE(this.height, 4);
    header[8] = 8; // 8-bit grayscale
    const pixels = Buffer.alloc((this.width + 1) * this.height, 128);
    for (let row = 0; row < this.height; row++) pixels[row * (this.width + 1)] = 0;
    return Buffer.concat([
      Buffer.from('89504e470d0a1a0a', 'hex'),
      pngChunk('IHDR', header),
      pngChunk('IDAT', deflateSync(pixels)),
      pngChunk('IEND', Buffer.alloc(0)),
    ]);
  }
  toJPEG() {
    const segment = (marker: number, data: Buffer) => {
      const header = Buffer.from([0xff, marker, 0, 0]);
      header.writeUInt16BE(data.length + 2, 2);
      return Buffer.concat([header, data]);
    };
    const frame = Buffer.from([8, 0, 0, 0, 0, 1, 1, 0x11, 0]);
    frame.writeUInt16BE(this.height, 1);
    frame.writeUInt16BE(this.width, 3);
    // One component, DC zero + AC EOB for each constant 8x8 gray block.
    const table = (id: number) => Buffer.from([id, 1, ...Array(15).fill(0), 0]);
    const bits = Math.ceil(this.width / 8) * Math.ceil(this.height / 8) * 2;
    const entropy = Buffer.alloc(Math.ceil(bits / 8));
    if (bits % 8) entropy[entropy.length - 1] = (1 << (8 - (bits % 8))) - 1;
    return Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      segment(0xdb, Buffer.from([0, ...Array(64).fill(1)])),
      segment(0xc0, frame),
      segment(0xc4, Buffer.concat([table(0), table(0x10)])),
      segment(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),
      entropy,
      Buffer.from([0xff, 0xd9]),
    ]);
  }
}
function readFixturePng(bytes: Buffer) {
  expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20);
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < bytes.length; ) {
    const length = bytes.readUInt32BE(offset),
      type = bytes.toString('ascii', offset + 4, offset + 8),
      data = bytes.subarray(offset + 8, offset + 8 + length);
    expect(bytes.subarray(offset, offset + length + 12)).toEqual(pngChunk(type, data));
    if (type === 'IDAT') chunks.push(data);
    offset += length + 12;
  }
  expect(inflateSync(Buffer.concat(chunks)).length).toBe((width + 1) * height);
  return new FixtureImage(width, height);
}

const views: FakeView[] = [];
let focused: FakeContents | undefined;
class FakeContents extends EventEmitter {
  destroyed = false;
  url = '';
  clicks = 0;
  readonly inputEvents: Record<string, any>[] = [];
  physical = 0;
  loads = 0;
  attached = false;
  viewport = { width: 960, height: 540 };
  readonly dpr = 2;
  readonly physicalEvents: Record<string, number> = {};
  readonly mainFrame = { url: 'http://localhost/' };
  readonly page = new JSDOM(
    '<!doctype html><html><body><input><button>Fixture</button></body></html>',
  );
  readonly navigationHistory = { canGoBack: () => false, canGoForward: () => false };
  readonly debugger = Object.assign(new EventEmitter(), {
    isAttached: () => this.attached,
    attach: () => {
      this.attached = true;
    },
    detach: () => {
      this.attached = false;
    },
    sendCommand: async (method: string, params: Record<string, any> = {}) => {
      if (method === 'Page.captureScreenshot') {
        expect(params).toMatchObject({
          format: 'png',
          fromSurface: true,
          captureBeyondViewport: false,
        });
        expect(params.clip).toBeUndefined();
        return {
          data: new FixtureImage(this.viewport.width * this.dpr, this.viewport.height * this.dpr)
            .toPNG()
            .toString('base64'),
        };
      }
      if (method === 'Page.navigate') await this.loadURL(String(params.url));
      if (method === 'Input.dispatchMouseEvent') {
        this.inputEvents.push({ ...params });
        if (params.type === 'mouseReleased') {
          this.clicks++;
          this.page.window.document
            .querySelector('button')!
            .dispatchEvent(new this.page.window.MouseEvent('click', { bubbles: true }));
        }
      }
      return {};
    },
  });
  isDestroyed() {
    return this.destroyed;
  }
  isFocused() {
    return focused === this;
  }
  focus() {
    focused = this;
    this.emit('focus');
  }
  getZoomFactor() {
    return 1;
  }
  getURL() {
    return this.url;
  }
  getTitle() {
    return 'Controlled local page';
  }
  setWindowOpenHandler(_handler: unknown) {}
  async executeJavaScript() {
    return { ...this.viewport, dpr: this.dpr, x: 0, y: 0 };
  }
  async capturePage() {
    return new FixtureImage(this.viewport.width * this.dpr, this.viewport.height * this.dpr);
  }
  async insertCSS() {
    return 'fixed-style';
  }
  async removeInsertedCSS(_key: string) {}
  async loadURL(url: string) {
    this.url = url;
    this.loads++;
    this.emit('did-start-navigation', {}, url, false, true);
    this.emit('did-navigate');
    this.emit('did-finish-load');
  }
  async executeJavaScriptInIsolatedWorld(_world: number, scripts: { code: string }[]) {
    for (const script of scripts)
      runInNewContext(script.code, {
        document: this.page.window.document,
        innerWidth: this.viewport.width,
        innerHeight: this.viewport.height,
      });
  }
  close() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('destroyed');
    this.page.window.close();
  }
  reload() {}
  stop() {}
}
class FakeView {
  readonly options: { webPreferences: Record<string, unknown> };
  readonly webContents = new FakeContents();
  visible = false;
  bounds = { x: 0, y: 0, width: 0, height: 0 };
  background = '';
  constructor(options: { webPreferences: Record<string, unknown> }) {
    this.options = options;
    views.push(this);
  }
  setVisible(value: boolean) {
    this.visible = value;
  }
  getVisible() {
    return this.visible;
  }
  setBounds(value: typeof this.bounds) {
    this.bounds = value;
    this.webContents.viewport = { width: value.width, height: value.height };
  }
  getBounds() {
    return this.bounds;
  }
  setBorderRadius() {}
  setBackgroundColor(value: string) {
    this.background = value;
  }
}
const browsing = Object.assign(new EventEmitter(), {
  setPermissionRequestHandler() {},
  setPermissionCheckHandler() {},
  webRequest: { onBeforeRequest() {} },
});
mock.module('electron', () => ({
  WebContentsView: FakeView,
  nativeImage: { createFromBuffer: readFixturePng },
  session: { fromPartition: () => browsing },
}));

let serverOptions: any,
  daemonCreated = 0,
  daemonClosed = 0,
  serverStopped = 0;
const nativeActions: string[] = [];
const actualBrowser = { ...browserApi };
mock.module('@kite-ai/agent/browser', () => ({
  ...actualBrowser,
  createNativeBrowserTransport() {
    daemonCreated++;
    const server = serverOptions;
    let finish!: (value: { confirmed: boolean }) => void;
    const completion = new Promise<{ confirmed: boolean }>((resolve) => {
      finish = resolve;
    });
    let nextId = 0;
    const answers = new Map<number, any>();
    const ws = {
      readyState: 1,
      send(value: string) {
        const answer = JSON.parse(value);
        if (answer.id) answers.set(answer.id, answer);
      },
      close() {
        this.readyState = 3;
        server.websocket.close(this);
      },
    };
    server.websocket.open(ws);
    const cdp = async (method: string, params: Record<string, unknown> = {}) => {
      const id = ++nextId;
      await server.websocket.message(ws, JSON.stringify({ id, method, params }));
      const answer = answers.get(id);
      if (!answer || answer.error) throw Error('fake_daemon_cdp_rejected');
      return answer.result;
    };
    return {
      ready: Promise.resolve(),
      completion,
      async request(input: Record<string, Json>) {
        nativeActions.push(String(input.action));
        if (input.action === 'navigate') await cdp('Page.navigate', { url: input.url });
        if (input.action === 'click') {
          await cdp('Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x: 80,
            y: 64,
            button: 'left',
            clickCount: 1,
          });
          await cdp('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: 80,
            y: 64,
            button: 'left',
            clickCount: 1,
          });
        }
        return {
          success: true,
          data:
            input.action === 'stream_status'
              ? { enabled: false }
              : { snapshot: '- button "Fixture" [ref=e1]' },
        };
      },
      async capture() {
        const frame = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 35 });
        const bytes = Buffer.from(frame.data, 'base64');
        expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
        const sof = bytes.indexOf(Buffer.from([0xff, 0xc0]));
        expect(sof).toBeGreaterThan(0);
        const width = bytes.readUInt16BE(sof + 7),
          height = bytes.readUInt16BE(sof + 5);
        return {
          frame: { mimeType: 'image/jpeg', data: frame.data, width, height },
          annotations: [
            {
              ref: '@e1',
              number: 1,
              role: 'button',
              name: 'Fixture',
              box: { x: 40, y: 44, width: 120, height: 40 },
            },
          ],
        };
      },
      async close() {
        daemonClosed++;
        ws.close();
        finish({ confirmed: true });
        return { confirmed: true };
      },
      async dispose() {},
    };
  },
}));
const bootstrap = new JSDOM('<!doctype html><div></div>', { pretendToBeVisual: true });
Object.assign(globalThis, {
  window: bootstrap.window,
  document: bootstrap.window.document,
  navigator: bootstrap.window.navigator,
});
const { createRoot } = await import('react-dom/client');
const { NativeDesktop } = await import('../../src/native');
const { registerNativeBrowserIpc } = await import('../../electron/native-browser');
const { createDesktopBrowserTransport } = await import('../../../service/src/desktop-browser');
bootstrap.window.close();

for (const mode of [
  'complete-with-unknown-ack',
  'post-admission-late-ack-in-b',
  'pre-post-immediate-switch-to-b',
  'cancel-late',
] as const) {
  test(`full Native root/Main/Service/Runtime async browser ${mode}`, async () => {
    views.length = 0;
    nativeActions.length = 0;
    daemonCreated = daemonClosed = serverStopped = 0;
    const dataRoot = mkdtempSync(join(tmpdir(), 'kite-root-async-'));
    const store = await openSqliteStore({ dataRoot, profile: 'fixture' });
    const storeId = (await store.getMetadata()).storeId;
    const dom = new JSDOM('<!doctype html><div id="root"></div>', {
      url: 'http://localhost/',
      pretendToBeVisual: true,
    });
    const restore = prepareDesktopDom(dom);
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      navigator: dom.window.navigator,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    // JSDOM has no flex layout. Keep the actual SessionPage Groups, Panel flex
    // weights and separator contiguous in the same viewport Main owns below.
    const windowSize = { width: 1200, height: 900 };
    Object.defineProperties(dom.window, {
      innerWidth: { configurable: true, value: windowSize.width },
      innerHeight: { configurable: true, value: windowSize.height },
    });
    const rect = (element: HTMLElement): DOMRect => {
      if (element.classList.contains('client-panels'))
        return new dom.window.DOMRect(0, 0, windowSize.width, windowSize.height);
      if (element.classList.contains('client-content-panels'))
        return rect(element.closest<HTMLElement>('[data-panel]')!);
      if (element.hasAttribute('data-panel')) {
        const group = element.parentElement!;
        const box = rect(group);
        const panels = [...group.children].filter(
          (node): node is HTMLElement =>
            node instanceof HTMLElement && node.hasAttribute('data-panel'),
        );
        const weights = panels.map((node) => Number(node.style.flexGrow) || 0);
        const total = weights[0]! + weights[1]!;
        const first = total
          ? ((box.width - 1) * weights[0]!) / total
          : group.classList.contains('client-panels')
            ? 200
            : box.width - 1;
        return element === panels[0]
          ? new dom.window.DOMRect(box.x, box.y, first, box.height)
          : new dom.window.DOMRect(box.x + first + 1, box.y, box.width - first - 1, box.height);
      }
      if (element.dataset.slot === 'resizable-handle') {
        const first = rect(
          element.parentElement!.querySelector<HTMLElement>(':scope > [data-panel]')!,
        );
        return new dom.window.DOMRect(first.right, first.y, 1, first.height);
      }
      if (element.classList.contains('native-browser-viewport')) {
        const box = rect(element.closest<HTMLElement>('[data-panel]')!);
        return new dom.window.DOMRect(box.x + 1, 92, Math.max(0, box.width - 2), box.height - 93);
      }
      const panel = element.closest<HTMLElement>('[data-panel]');
      return panel ? rect(panel) : new dom.window.DOMRect(20, 80, 800, 600);
    };
    dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
      return rect(this);
    };
    Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get() {
        return Math.round(rect(this).width);
      },
    });
    class LayoutObserver {
      readonly targets = new Set<Element>();
      readonly callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }
      observe(target: Element) {
        this.targets.add(target);
        queueMicrotask(() => {
          if (!this.targets.has(target) || !target.isConnected) return;
          const box = rect(target as HTMLElement);
          this.callback(
            [
              {
                target,
                contentRect: box,
                borderBoxSize: [{ inlineSize: box.width, blockSize: box.height }],
              },
            ] as unknown as ResizeObserverEntry[],
            this as unknown as ResizeObserver,
          );
        });
      }
      unobserve(target: Element) {
        this.targets.delete(target);
      }
      disconnect() {
        this.targets.clear();
      }
    }
    Object.assign(dom.window, { ResizeObserver: LayoutObserver });
    Object.assign(globalThis, { ResizeObserver: LayoutObserver });
    const owner = new FakeContents(),
      children: FakeView[] = [];
    const browserListeners = new Set<(state: NativeBrowserState) => void>();
    Object.assign(owner, {
      send(channel: string, value: NativeBrowserState) {
        if (channel === nativeBrowserEventChannel)
          act(() => {
            for (const listener of browserListeners) listener(value);
          });
      },
    });
    const windowPort = Object.assign(new EventEmitter(), {
      webContents: owner,
      isDestroyed: () => false,
      isVisible: () => true,
      isMinimized: () => false,
      getContentSize: () => [windowSize.width, windowSize.height],
      contentView: {
        children,
        addChildView(view: FakeView) {
          const i = children.indexOf(view);
          if (i >= 0) children.splice(i, 1);
          children.push(view);
        },
        removeChildView(view: FakeView) {
          const i = children.indexOf(view);
          if (i >= 0) children.splice(i, 1);
        },
      },
    });
    let scope: NativeExtensionScope | undefined;
    let pageId = '';
    const host = new NativeBrowserPageHost();
    const handlers = new Map<string, (event: IpcMainInvokeEvent, value: unknown) => any>();
    const disposeMain = registerNativeBrowserIpc({
      window: windowPort as unknown as BrowserWindow,
      rendererUrl: 'http://localhost/',
      automation: host,
      selectedScope: () => scope,
      ipcMain: {
        handle: (key: string, handler: any) => handlers.set(key, handler),
        removeHandler: (key: string) => handlers.delete(key),
      } as unknown as IpcMain,
    });
    const measuredPresentations: Extract<NativeBrowserRequest, { action: 'present' }>[] = [];
    const browserRequest = async (value: NativeBrowserRequest | unknown) => {
      const request = value as NativeBrowserRequest;
      if (request.action === 'present' && request.bounds) measuredPresentations.push(request);
      const reply = await handlers.get(nativeBrowserChannel)!(
        { sender: owner, senderFrame: owner.mainFrame } as unknown as IpcMainInvokeEvent,
        value,
      );
      if (!reply.ok) throw Error(reply.code);
      if (reply.value?.id) pageId = reply.value.id;
      return reply.value;
    };
    const originalFetch = globalThis.fetch,
      originalServe = Bun.serve;
    const captureProofs: {
      sha256: string;
      width: number;
      height: number;
      imageWidth: number;
      imageHeight: number;
    }[] = [];
    let fetches = 0;
    globalThis.fetch = (async (url: unknown, init: RequestInit) => {
      if (String(url) !== 'http://127.0.0.1:1234/kite-page') throw Error('fixture_network_denied');
      if (new Headers(init.headers).get('Authorization') !== `Bearer ${'0'.repeat(72)}`)
        throw Error('fixture_page_auth_denied');
      fetches++;
      try {
        const request = JSON.parse(String(init.body));
        const value = await host.request(request);
        if (request.op === 'captureMeta') {
          const proof = value as { metadata: (typeof captureProofs)[number] };
          captureProofs.push(proof.metadata);
        }
        return new Response(JSON.stringify({ ok: true, value }));
      } catch (error) {
        return new Response(JSON.stringify({ ok: false, error: (error as Error).message }), {
          status: 400,
        });
      }
    }) as typeof fetch;
    Bun.serve = ((options: unknown) => {
      serverOptions = options;
      return {
        port: 12345,
        stop: async () => {
          serverStopped++;
        },
      };
    }) as unknown as typeof Bun.serve;
    let runtime!: AgentRuntime;
    const controller = actualBrowser.createBrowserController({
      sharedPage: true,
      captureIntervalMs: 60000,
      createTransport: (context, binding) =>
        createDesktopBrowserTransport(
          { executable: '/trusted/fake-daemon', browserPath: '/unused' },
          { endpoint: 'http://127.0.0.1:1234/kite-page', token: '0'.repeat(72) },
          context,
          {
            ...binding,
            storeId: async () => (await runtime.getExecution(context.executionId))!.originStoreId,
          },
        ),
    });
    let allowAsk!: () => void,
      finishWork!: () => void,
      unrelated = false;
    const askGate = new Promise<void>((resolve) => {
        allowAsk = resolve;
      }),
      workGate = new Promise<void>((resolve) => {
        finishWork = resolve;
      });
    const requests: ModelRequest[] = [];
    const finish: Extract<ModelEvent, { type: 'finish' }> = {
      type: 'finish',
      reason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1 },
    };
    const independent: Extension = {
      id: 'fixture',
      version: '1',
      apiMajor: 1,
      tools: [
        {
          id: 'fixture.other',
          version: '1',
          model: { name: 'independent_work' },
          description: 'Unrelated gated work',
          inputSchema: { type: 'object' },
          async execute(_input, context) {
            unrelated = true;
            const abort = () => finishWork();
            context.signal.addEventListener('abort', abort, { once: true });
            try {
              await workGate;
              context.signal.throwIfAborted();
              return { outcome: 'succeeded', content: 'unrelated complete' };
            } finally {
              context.signal.removeEventListener('abort', abort);
            }
          },
        },
      ],
    };
    let modelPhase = 0,
      phaseTurn = 0;
    const model = {
      async *stream(request: ModelRequest, options: { signal: AbortSignal }) {
        requests.push(structuredClone(request));
        const turn = ++phaseTurn;
        let name = '',
          args: Json = {};
        const view = () => controller.view('a')!;
        if (turn === 1) {
          name = 'browser_open';
          args = {
            key: modelPhase === 0 ? 'same-page' : 'new-run-page',
            url: 'http://localhost/fixture',
          };
        }
        if (modelPhase === 0 && turn === 2) {
          await askGate;
          options.signal.throwIfAborted();
          name = 'independent_work';
        }
        if (modelPhase === 0 && turn === 3) {
          name = 'browser_close';
          args = {
            key: 'release-before-final',
            browser_id: view().browserId,
            generation: view().generation,
          };
        }
        if (modelPhase === 1 && turn === 2) {
          name = 'browser_snapshot';
          args = { key: 'fresh-in-new-run', browser_id: view().browserId };
        }
        if (modelPhase === 1 && turn === 3) {
          name = 'browser_click';
          args = {
            key: 'one-click-new-run',
            browser_id: view().browserId,
            generation: view().generation,
            seq: view().seq,
            ref: '@e1',
          };
        }
        if (modelPhase === 1 && turn === 4) {
          name = 'browser_close';
          args = {
            key: 'release-new-run',
            browser_id: view().browserId,
            generation: view().generation,
          };
        }
        yield* createFixedModel([
          name
            ? [
                { type: 'tool_call', id: `call-${turn}`, name, arguments: JSON.stringify(args) },
                { ...finish, reason: 'tool_calls' },
              ]
            : [{ type: 'text_delta', text: 'ROOT_ASYNC_DONE' }, finish],
        ]).stream(request, options);
      },
    };
    runtime = createRuntime({
      store,
      model,
      modelId: 'model-a',
      async resolveRunConfiguration() {
        return {
          model,
          modelId: 'model-a',
          snapshot: {
            version: 1,
            digest: 'a'.repeat(64),
            configuration: {
              models: [{ id: 'model-a', provider: 'compatible', protocol: 'chat-completions' }],
            },
          },
          async dispose() {},
        };
      },
      extensions: [actualBrowser.createBrowserExtension({ controller }), independent],
      permissions: {
        async authorize() {
          return { allowed: true, revision: 'fixture' };
        },
      },
    });
    await runtime.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'controlled',
      rootUri: pathToFileURL(dataRoot).href,
    });
    for (const id of ['a', 'b'])
      await runtime.createSession({
        expectedStoreId: storeId,
        sessionId: id,
        workspaceId: 'w',
        title: `Session ${id.toUpperCase()}`,
        subjectId: 'owner',
        commandId: `create-${id}`,
      });
    const control = sessionSwitchBridge({ active: false, protocol: 'chat-completions' });
    const data = memoryPrivateData();
    const posted: ExtensionCommandRequest[] = [],
      calls: NativeRequest[] = [];
    const selections: { sessionId: string; activationId?: number; callIndex: number }[] = [];
    const actionReplies: { actionId: string; outcome?: unknown; error?: string }[] = [];
    let dropAck = mode === 'complete-with-unknown-ack',
      lastHead = 0;
    let replyHeld = false,
      releaseReply!: () => void;
    const replyGate = new Promise<void>((resolve) => {
      releaseReply = resolve;
    });
    const client = {
      serverInfo: { storeId, subjectId: 'owner' },
      getView: (id: string) => runtime.getView(id),
      getExecution: (id: string) => runtime.getExecution(id),
      getCommand: (id: string) => runtime.getCommand(id),
      listExtensions: async () => runtime.getExtensionCatalogue(),
      queryExtension: (sessionId: string, extensionId: string, queryId: string, input: Json) =>
        runtime.queryExtension({
          expectedStoreId: storeId,
          sessionId,
          subjectId: 'owner',
          extensionId,
          queryId,
          input,
        }),
      async invokeExtension(sessionId: string, request: ExtensionCommandRequest) {
        posted.push(request);
        const { expectedStoreId, commandId, ...body } = request;
        const command = await runtime.submitCommand({
          expectedStoreId,
          commandId,
          sessionId,
          subjectId: 'owner',
          request: body,
        });
        if (dropAck && request.actionId === 'browser.handoff') {
          dropAck = false;
          throw Error('fixture_ack_lost_after_real_intake');
        }
        return command;
      },
    } as unknown as AgentClient;
    const journal = new NativeCallerJournal(client, data),
      main = new NativeExtensions(client, () => scope, journal);
    function mapStore(value: any): any {
      if (Array.isArray(value)) return value.map(mapStore);
      if (value && typeof value === 'object')
        return Object.fromEntries(
          Object.entries(value).map(([key, item]) => [
            key,
            key === 'storeId' && item === 'store' ? storeId : mapStore(item),
          ]),
        );
      return value;
    }
    let nativeMenu: NativeBrowserMenuRequest | undefined,
      chooseMenu!: (action: NativeBrowserMenuAction | null) => void;
    const bridge = {
      ...control.bridge,
      showBrowserMenu(input: NativeBrowserMenuRequest) {
        nativeMenu = input;
        return new Promise<NativeBrowserMenuAction | null>((resolve) => {
          chooseMenu = resolve;
        });
      },
      cancelBrowserMenu() {
        chooseMenu?.(null);
      },
      browserRequest,
      restoreBrowser: (scope: unknown) => browserRequest({ action: 'restore', scope }),
      watchBrowser(listener: (state: NativeBrowserState) => void) {
        browserListeners.add(listener);
        return () => browserListeners.delete(listener);
      },
      async request(raw: NativeRequest) {
        calls.push(raw);
        const input = decodeNativeRequest(raw);
        if (input.method === 'select')
          selections.push({
            sessionId: input.sessionId,
            activationId: input.activationId,
            callIndex: calls.length - 1,
          });
        switch (input.method) {
          case 'messages': {
            const messages = (await store.listMessages(scope?.sessionId ?? 'a')).filter(
              (message) => BigInt(message.seq) <= BigInt(input.upperSeq ?? '0'),
            );
            return { messages, nextAfterSeq: null, highWaterSeq: input.upperSeq ?? '0' };
          }
          case 'extensions.open':
            return main.open(input);
          case 'extensions.query': {
            const head = await main.query(input);
            lastHead = head.observationId;
            return head;
          }
          case 'extensions.read':
            return main.read(input);
          case 'extensions.close':
            return main.close(input.readId);
          case 'extensions.release':
            return main.release();
          case 'extensions.invoke': {
            let result: Awaited<ReturnType<NativeExtensions['invoke']>>;
            try {
              result = await main.invoke(input);
              actionReplies.push({ actionId: input.actionId, outcome: result.outcome });
            } catch (error) {
              actionReplies.push({
                actionId: input.actionId,
                error: error instanceof Error ? error.message : 'unknown',
              });
              throw error;
            }
            if (mode === 'post-admission-late-ack-in-b' && input.actionId === 'browser.handoff') {
              replyHeld = true;
              await replyGate;
            }
            return result;
          }
          case 'extensions.lookup':
            return main.lookup(input.commandId);
        }
        const value = mapStore(await control.bridge.request(raw));
        if (value?.selection) {
          const actual = await runtime.getView(value.selection.session.id);
          value.selection = {
            ...value.selection,
            session: actual.session,
            runs: actual.runs,
            executions: actual.executions,
            canReadExtensions: true,
            canInvokeExtensions: true,
          };
          value.callerSubmissions = journal.records().map(callerMetadata);
          scope = {
            generation: value.generation,
            viewSelection: value.selection.viewSelection ?? value.selection.viewGeneration,
            historyEpoch: value.historyEpoch ?? 0,
            storeId,
            sessionId: actual.session.id,
            workspaceId: actual.session.workspaceId,
            contextSelectionId: actual.session.contextSelectionId,
          };
        }
        return value;
      },
    } as NativeBridge;
    Object.defineProperty(dom.window, 'kiteNative', { value: bridge });
    const root = createRoot(dom.window.document.getElementById('root')!);
    const flush = async (action: () => void = () => {}, ms = 25) =>
      act(async () => {
        action();
        await Bun.sleep(ms);
      });
    const button = (text: string) =>
      [...dom.window.document.querySelectorAll<HTMLButtonElement>('button')].find(
        (row) => row.textContent === text || row.getAttribute('aria-label') === text,
      );
    const showTabs = () => {
      const toggle = button('标签页')!;
      if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
    };
    const until = async (check: () => boolean | Promise<boolean>) => {
      const end = Date.now() + 5000;
      let ready = false;
      while (!ready) {
        await act(async () => {
          ready = await check();
          if (!ready) await Bun.sleep(25);
        });
        if (Date.now() > end)
          throw Error(`root_async_timeout:${dom.window.document.body.textContent?.slice(-3000)}`);
      }
    };
    let cursor = (await store.getMetadata()).lastChangeCursor;
    const changes = setInterval(() => {
      void store
        .getMetadata()
        .then((meta) => {
          if (meta.lastChangeCursor !== cursor) {
            cursor = meta.lastChangeCursor;
            act(() => control.publish());
          }
        })
        .catch(() => {});
    }, 30);
    try {
      await flush(() => root.render(<NativeDesktop />));
      await until(() => !!button('Session A'));
      await flush(() => button('Session A')!.click());
      await until(() => !!button('标签页'));
      expect(button('浏览器')).toBeUndefined();
      await flush(showTabs);
      await until(() => !!dom.window.document.querySelector('[aria-label="搜索或输入网址"]'));
      const address = dom.window.document.querySelector<HTMLInputElement>(
        '[aria-label="搜索或输入网址"]',
      )!;
      await flush(() => {
        const setter = Object.getOwnPropertyDescriptor(
          dom.window.HTMLInputElement.prototype,
          'value',
        )!.set!;
        setter.call(address, 'http://localhost/fixture');
        address.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      });
      await flush(() =>
        address
          .closest('form')!
          .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })),
      );
      await until(() => views.some((view) => view.webContents.url === 'http://localhost/fixture'));
      const page = views.find((view) => view.webContents.url === 'http://localhost/fixture')!;
      let pageClicks = 0;
      page.webContents.page.window.document
        .querySelector('button')!
        .addEventListener('click', () => pageClicks++);
      await until(() => page.visible);
      expect(measuredPresentations.at(-1)?.layout).toMatchObject({
        windowWidth: windowSize.width,
        windowHeight: windowSize.height,
        groups: [
          { left: 0, right: 0, gap: 1 },
          { left: 0, right: 0, gap: 1 },
        ],
      });
      expect(page.bounds.x + page.bounds.width).toBeLessThanOrEqual(windowSize.width);
      // Test setup grants control through Main; production asks the persistent Question.
      await act(async () => {
        await browserRequest({ action: 'grant', id: pageId });
        await Bun.sleep(35);
      });
      await until(() => host.state(pageId)?.phase === 'armed');
      const originalPageId = pageId,
        originalIncarnation = host.state(pageId)?.incarnation;
      await runtime.submitCommand({
        expectedStoreId: storeId,
        sessionId: 'a',
        subjectId: 'owner',
        commandId: 'root-model-task',
        request: {
          kind: 'run.start',
          content:
            'Use the granted page; ask human; continue unrelated work; reobserve before one click.',
        },
      });
      await until(() => requests.length === 2 && controller.view('a')?.state === 'agent');
      await flush(() => control.publish());
      await until(() => !!button('浏览器控制'));
      await until(() => !!button('指向注释'));
      const beforeNotes = calls.filter((call) => call.method === 'extensions.open').length;
      await flush(() => button('指向注释')!.click());
      expect(
        dom.window.document.querySelector('.native-browser-annotations')?.parentElement?.className,
      ).toBe('native-browser-surface');
      await until(
        () => !!dom.window.document.querySelector('section[aria-label="冻结快照注释"] img'),
      );
      const captured = controller.view('a')!.frame!;
      expect(captureProofs.at(-1)).toMatchObject({
        sha256: createHash('sha256').update(Buffer.from(captured.data, 'base64')).digest('hex'),
        width: page.bounds.width,
        height: page.bounds.height,
        imageWidth: captured.width,
        imageHeight: captured.height,
      });
      await flush(() => button('返回网页')!.click());
      expect(calls.filter((call) => call.method === 'extensions.open')).toHaveLength(beforeNotes);
      expect(posted.map((request) => request.actionId)).toEqual(['browser.capture']);
      const originalBrowser = controller.view('a')!;
      allowAsk();
      await until(() => unrelated && requests.length === 2);
      await flush(() => control.publish());
      const openReadyMenu = async () => {
        const end = Date.now() + 5000;
        for (;;) {
          await flush(() => button('浏览器控制')!.click());
          if (nativeMenu?.items.some((item) => item.action === 'handoff' && item.enabled)) return;
          await flush(() => chooseMenu?.(null));
          if (Date.now() > end)
            throw Error(`root_native_menu_not_ready:${JSON.stringify(nativeMenu)}`);
        }
      };
      await openReadyMenu();
      expect(nativeMenu!.items.some((item) => /resume|human|continue/.test(item.action))).toBe(
        false,
      );
      const late = {
        method: 'extensions.invoke',
        generation: 1,
        observationId: lastHead,
        commandId: 'late-scope-request',
        extensionId: 'builtin.browser',
        actionId: 'browser.handoff',
        definitionVersion: '1',
        input: { browserId: originalBrowser.browserId, generation: originalBrowser.generation },
      } as NativeRequest;
      const beforeReplies = actionReplies.length;
      await flush(() => {
        chooseMenu('handoff');
        if (mode === 'pre-post-immediate-switch-to-b') button('Session B')!.click();
      });
      if (mode === 'pre-post-immediate-switch-to-b') {
        await until(() => scope?.sessionId === 'b');
        await until(() => actionReplies.length > beforeReplies);
        expect(actionReplies.slice(beforeReplies)).toEqual([
          { actionId: 'browser.handoff', error: 'extensions_observation_unavailable' },
        ]);
        expect(posted.filter((request) => request.actionId === 'browser.handoff')).toHaveLength(0);
        expect(controller.view('a')?.state).toBe('agent');
      } else {
        await until(() => controller.view('a')?.state === 'human');
        expect(host.state(pageId)?.phase).toBe('human');
        expect(posted.filter((request) => request.actionId === 'browser.handoff')).toHaveLength(1);
        if (mode === 'complete-with-unknown-ack')
          await until(() => calls.some((call) => call.method === 'extensions.lookup'));
        if (mode === 'post-admission-late-ack-in-b') await until(() => replyHeld);
        await flush(() => button('Session B')!.click());
        await until(() => scope?.sessionId === 'b');
        if (replyHeld) await flush(() => releaseReply());
      }
      const selectedBCount = selections.length;
      const readB = await bridge.request({ method: 'state', generation: scope!.generation });
      expect(readB && 'selection' in readB && readB.selection?.session.id).toBe('b');
      await expect(bridge.request(late)).rejects.toThrow('extensions_observation_unavailable');
      expect(scope?.sessionId).toBe('b');
      expect(page.visible).toBe(false);
      expect(pageClicks).toBe(0);
      const initialJob = (await store.listExecutions('a')).find(
        (row) => row.definitionId === 'browser.open',
      )!;
      expect(initialJob).toBeTruthy();
      if (mode === 'cancel-late') {
        await runtime.cancelRun({
          expectedStoreId: storeId,
          sessionId: 'a',
          subjectId: 'owner',
          commandId: 'cancel-root',
          runId: initialJob.runId!,
        });
      }
      finishWork();
      await until(async () => !(await runtime.getRun(initialJob.runId!))?.isActive);
      expect((await runtime.getRun(initialJob.runId!))?.status).toBe(
        mode === 'cancel-late' ? 'cancelled' : 'completed',
      );
      await until(() => host.state(pageId)?.browserId === undefined);
      expect(host.state(pageId)?.phase).toBe('human');
      expect(daemonCreated).toBe(1);
      expect(daemonClosed).toBe(1);
      expect(serverStopped).toBe(1);
      expect(page.webContents.destroyed).toBe(false);
      expect(selections).toHaveLength(selectedBCount);
      expect(
        (await store.listExecutions('a')).filter(
          (row) => row.definitionId === 'browser.request_human',
        ),
      ).toHaveLength(0);
      expect(
        posted.filter((request) => /resume|respond_human/.test(request.actionId)),
      ).toHaveLength(0);
      await flush(() => button('Session A')!.click());
      await until(() => scope?.sessionId === 'a');
      await flush(showTabs);
      await until(() => dom.window.document.querySelectorAll('.native-browser-page').length === 1);
      expect(button('继续并通知 Agent')).toBeUndefined();
      expect(pageId).toBe(originalPageId);
      expect(host.state(pageId)?.incarnation).toBe(originalIncarnation);
      expect(pageClicks).toBe(0);
      if (mode !== 'cancel-late') {
        const oldClicks = nativeActions.filter((action) => action === 'click').length;
        const stale = await controller.command(
          'a',
          { browserId: originalBrowser.browserId, generation: originalBrowser.generation },
          { action: 'click', ref: '@e1', seq: originalBrowser.seq },
          new AbortController().signal,
        );
        expect(stale.outcome).not.toBe('succeeded');
        expect(nativeActions.filter((action) => action === 'click')).toHaveLength(oldClicks);
        // A separate human message creates a new Run and a fresh lease on the same page.
        await browserRequest({ action: 'grant', id: pageId });
        modelPhase = 1;
        phaseTurn = 0;
        const next = await runtime.submitCommand({
          expectedStoreId: storeId,
          sessionId: 'a',
          subjectId: 'owner',
          commandId: 'root-new-message',
          request: {
            kind: 'run.start',
            content: 'The manual step is complete. Observe the current page and click once.',
          },
        });
        await runtime.waitForCommand(next.id, { timeoutMs: 5000 });
        await until(
          async () =>
            (await store.listExecutions('a')).filter(
              (row) => row.definitionId === 'browser.session',
            ).length === 2 && (await runtime.getView('a')).runs.every((run) => !run.isActive),
        );
        const opens = (await store.listExecutions('a')).filter(
          (row) => row.definitionId === 'browser.open',
        );
        expect(opens).toHaveLength(2);
        expect(opens[1]!.runId).not.toBe(opens[0]!.runId);
        expect(pageClicks).toBe(1);
        expect(
          page.webContents.inputEvents.filter((event) => event.type === 'mousePressed'),
        ).toHaveLength(1);
        expect(nativeActions.filter((action) => action === 'snapshot')).toHaveLength(1);
        expect(nativeActions.indexOf('snapshot')).toBeLessThan(nativeActions.indexOf('click'));
        expect(host.state(pageId)?.incarnation).toBe(originalIncarnation);
        expect(host.state(pageId)?.phase).toBe('human');
        expect(host.state(pageId)?.browserId).toBeUndefined();
        expect(page.webContents.destroyed).toBe(false);
        expect(daemonCreated).toBe(2);
        expect(daemonClosed).toBe(2);
        expect(serverStopped).toBe(2);
        expect((await runtime.getView('a')).runs.every((run) => !run.isActive)).toBe(true);
        expect(
          (await store.listMessages('a')).some((message) =>
            JSON.stringify(message.content).includes('ROOT_ASYNC_DONE'),
          ),
        ).toBe(true);
      }
      expect(fetches).toBeGreaterThan(0);
    } catch (error) {
      console.error('root_async_primary_failure', error);
      console.error(
        'root_async_fixture_scope',
        JSON.stringify({
          scope,
          selections,
          actionReplies,
          posted: posted.map((request) => ({
            actionId: request.actionId,
            commandId: request.commandId,
          })),
          humanControl: controller.view('a')?.state,
          calls: calls.map((call) => call.method),
          last: control.requests.slice(-4).map((call) => call.method),
          views: views.map((view) => ({ url: view.webContents.url, visible: view.visible })),
        }),
      );
      throw error;
    } finally {
      allowAsk();
      finishWork();
      releaseReply();
      clearInterval(changes);
      await flush(() => root.unmount());
      main.release();
      data.close();
      await runtime.close();
      disposeMain();
      globalThis.fetch = originalFetch;
      Bun.serve = originalServe;
      restore();
      dom.window.close();
      owner.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  }, 30000);
}
