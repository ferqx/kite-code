import { expect, mock, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { NativeBrowserPageHost } from '../../electron/browser-page-host';
import {
  type NativeBrowserMenuAction,
  type NativeBrowserMenuRequest,
  type NativeBrowserRequest,
  type NativeBrowserRestoreScope,
  type NativeBrowserState,
  nativeBrowserChannel,
  nativeBrowserEventChannel,
} from '../../src/native-browser-bridge';
import { browserFixture, browserScope, browserView } from '../agent-browser.fixture';
import { prepareDesktopDom } from '../native-page-dom.fixture';

const views: FakeView[] = [];
const windowOwners = new WeakMap<FakeContents, BrowserWindow>();
type FakeFrame = {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  getScaleFactors(): number[];
};
let focused: FakeContents | undefined;
let debuggerGate: Promise<void> | undefined;
let commandStarted = false;
class FakeContents extends EventEmitter {
  destroyed = false;
  url = '';
  clicks = 0;
  physical = 0;
  loads = 0;
  attached = false;
  documentReady = false;
  view?: FakeView;
  nativeFrames = 0;
  captureCalls = 0;
  frameBelowRoot = false;
  frameSubscription?: (frame: FakeFrame) => void;
  viewport = { width: 800, height: 600 };
  readonly styles = new Set<string>();
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
    sendCommand: async (method: string, params: Record<string, unknown>) => {
      if (method === 'Input.dispatchMouseEvent') {
        if (params.type === 'mouseReleased') {
          commandStarted = true;
          await debuggerGate;
        }
        if (params.type === 'mousePressed') this.clicks++;
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
  getOSProcessId() {
    return this.destroyed ? 0 : 1;
  }
  getURL() {
    return this.url;
  }
  getTitle() {
    return 'Controlled local page';
  }
  setWindowOpenHandler(_handler: unknown) {}
  async insertCSS() {
    const key = 'fixed-style';
    this.styles.add(key);
    return key;
  }
  async removeInsertedCSS(key: string) {
    this.styles.delete(key);
  }
  async loadURL(url: string) {
    this.documentReady = false;
    this.url = url;
    this.mainFrame.url = url;
    this.loads++;
    this.emit('did-start-navigation', {}, url, false, true);
    this.emit('did-start-loading');
    this.emit('did-navigate', {}, url);
    this.documentReady = true;
    this.emit('dom-ready');
    this.emit('did-finish-load');
    this.emit('did-stop-loading');
  }
  nativeFrame(): FakeFrame {
    const size = { ...this.viewport };
    return {
      isEmpty: () => size.width <= 0 || size.height <= 0,
      getSize: () => size,
      getScaleFactors: () => [1],
    };
  }
  async capturePage() {
    this.captureCalls++;
    return this.nativeFrame();
  }
  beginFrameSubscription(onlyDirty: boolean, callback: (frame: FakeFrame) => void) {
    expect(onlyDirty).toBe(false);
    this.frameSubscription = callback;
  }
  endFrameSubscription() {
    this.frameSubscription = undefined;
  }
  invalidate() {
    const callback = this.frameSubscription;
    queueMicrotask(() => {
      if (
        !callback ||
        this.frameSubscription !== callback ||
        this.destroyed ||
        !this.documentReady ||
        !this.view?.getVisible()
      )
        return;
      const window = windowOwners.get(this);
      const children = window?.contentView.children as unknown as FakeView[] | undefined;
      const rootOwner = window?.webContents as unknown as FakeContents | undefined;
      const root = children?.find((view) => view.webContents === rootOwner);
      this.frameBelowRoot =
        !!root && root.getVisible() && children!.indexOf(this.view) < children!.indexOf(root);
      this.nativeFrames++;
      callback(this.nativeFrame());
    });
  }
  async executeJavaScriptInIsolatedWorld(_world: number, scripts: { code: string }[]) {
    let result: unknown;
    for (const script of scripts)
      result = runInNewContext(script.code, {
        document: this.page.window.document,
        HTMLElement: this.page.window.HTMLElement,
        HTMLInputElement: this.page.window.HTMLInputElement,
        HTMLTextAreaElement: this.page.window.HTMLTextAreaElement,
        innerWidth: 800,
        innerHeight: 600,
      });
    return result;
  }
  close() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.endFrameSubscription();
    this.emit('destroyed');
    this.page.window.close();
  }
  reload() {}
  stop() {}
}
class FakeView {
  readonly options: { webPreferences: Record<string, unknown> };
  readonly webContents: FakeContents;
  visible = false;
  bounds = { x: 0, y: 0, width: 0, height: 0 };
  background = '';
  constructor(options: { webPreferences: Record<string, unknown> }, contents?: FakeContents) {
    this.options = options;
    this.webContents = contents ?? new FakeContents();
    this.webContents.view = this;
    if (!contents) views.push(this);
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
  BrowserWindow: {
    fromWebContents: (contents: FakeContents) => windowOwners.get(contents) ?? null,
  },
  WebContentsView: FakeView,
  session: { fromPartition: () => browsing },
}));
let websocket: any,
  serverOptions: any,
  nativeClosed = 0,
  nativeCreated = 0,
  serverStopped = 0;
mock.module('@kite-ai/agent/browser', () => ({
  BrowserTransportError: class extends Error {},
  createNativeBrowserTransport() {
    nativeCreated++;
    let end!: (value: { confirmed: boolean }) => void;
    const completion = new Promise<{ confirmed: boolean }>((resolve) => {
      end = resolve;
    });
    websocket = {
      readyState: 1,
      send() {},
      close() {
        this.readyState = 3;
        serverOptions.websocket.close(this);
      },
    };
    serverOptions.websocket.open(websocket);
    return {
      ready: Promise.resolve(),
      completion,
      async request(input: { action: string }) {
        if (input.action === 'click')
          for (const type of ['mousePressed', 'mouseReleased'])
            await serverOptions.websocket.message(
              websocket,
              JSON.stringify({
                id: type === 'mousePressed' ? 1 : 2,
                method: 'Input.dispatchMouseEvent',
                params: { type, x: 80, y: 64 },
              }),
            );
        return input.action === 'stream_status'
          ? { success: true, data: { enabled: false } }
          : { success: true };
      },
      async close() {
        nativeClosed++;
        end({ confirmed: true });
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
const { NativeBrowserPane } = await import('../../src/native-browser-pane');
const { closeNativeBrowserTab, nativeBrowserDisplayHint, restoreNativeBrowserTab } = await import(
  '../../src/native-browser-session'
);
const { NativeBrowserLeaseControls } = await import('../../src/native-browser-lease-controls');
const { useSessionTabs } = await import('../../../../packages/ui/src/desktop/SessionTabs');
const { registerNativeBrowserIpc } = await import('../../electron/native-browser');
const { createDesktopBrowserTransport } = await import('../../../service/src/desktop-browser');
const { createBrowserInputShield } = await import('../../electron/browser-input-shield');
bootstrap.window.close();

test('Native controls use Main and Service lease paths; native hit shield survives background execution and exact page restoration', async () => {
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
  dom.window.HTMLElement.prototype.getBoundingClientRect = () =>
    new dom.window.DOMRect(20, 80, 800, 600);
  const owner = new FakeContents(),
    rootView = new FakeView({ webPreferences: {} }, owner),
    children: FakeView[] = [rootView];
  rootView.setBounds({ x: 0, y: 0, width: 1200, height: 900 });
  rootView.setVisible(true);
  const listeners = new Set<(state: NativeBrowserState) => void>();
  Object.assign(owner, {
    send(channel: string, value: NativeBrowserState) {
      if (channel === nativeBrowserEventChannel) for (const listener of listeners) listener(value);
    },
  });
  const windowPort = Object.assign(new EventEmitter(), {
    webContents: owner,
    isDestroyed: () => false,
    isVisible: () => true,
    isMinimized: () => false,
    getContentSize: () => [1200, 900],
    contentView: {
      children,
      addChildView(view: FakeView, index?: number) {
        const i = children.indexOf(view);
        if (i >= 0) children.splice(i, 1);
        children.splice(index ?? children.length, 0, view);
        windowOwners.set(view.webContents, windowPort as unknown as BrowserWindow);
      },
      removeChildView(view: FakeView) {
        const i = children.indexOf(view);
        if (i >= 0) children.splice(i, 1);
        windowOwners.delete(view.webContents);
      },
    },
  });
  windowOwners.set(owner, windowPort as unknown as BrowserWindow);
  let selected = { storeId: 'store', sessionId: 'session' };
  const host = new NativeBrowserPageHost();
  const handlers = new Map<string, (event: IpcMainInvokeEvent, value: unknown) => any>();
  const dispose = registerNativeBrowserIpc({
    window: windowPort as unknown as BrowserWindow,
    rendererUrl: 'http://localhost/',
    automation: host,
    selectedScope: () => ({ ...selected, generation: 1, viewSelection: 1 }),
    ipcMain: {
      handle: (key: string, handler: any) => handlers.set(key, handler),
      removeHandler: (key: string) => handlers.delete(key),
    } as unknown as IpcMain,
  });
  const request = async (value: NativeBrowserRequest) => {
    const reply = await handlers.get(nativeBrowserChannel)!(
      { sender: owner, senderFrame: owner.mainFrame } as unknown as IpcMainInvokeEvent,
      value,
    );
    if (!reply.ok) throw Error(reply.code);
    return reply.value as NativeBrowserState | null;
  };
  const restorePage = async (scope: NativeBrowserRestoreScope) => {
    const reply = await handlers.get(nativeBrowserChannel)!(
      { sender: owner, senderFrame: owner.mainFrame } as unknown as IpcMainInvokeEvent,
      { action: 'restore', scope },
    );
    if (!reply.ok) throw Error(reply.code);
    return reply.value;
  };
  const originalFetch = globalThis.fetch,
    originalServe = Bun.serve;
  let leaseId = '';
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    try {
      const input = JSON.parse(String(init.body));
      const value = await host.request(input);
      if (input.op === 'acquire') leaseId = (value as { leaseId: string }).leaseId;
      return new Response(JSON.stringify({ ok: true, value }));
    } catch (error) {
      return new Response(JSON.stringify({ ok: false, error: (error as Error).message }), {
        status: 400,
      });
    }
  }) as unknown as typeof fetch;
  Bun.serve = ((options: unknown) => {
    serverOptions = options;
    return {
      port: 12345,
      stop: async () => {
        serverStopped++;
      },
    };
  }) as unknown as typeof Bun.serve;
  let transport: ReturnType<typeof createDesktopBrowserTransport> | undefined;
  const fixture = browserFixture({
    beforeAction: async (action) => {
      if (action.actionId === 'browser.handoff')
        await transport!.handoff!(new AbortController().signal);
      if (action.actionId === 'browser.close' && !(await transport!.close()).confirmed)
        throw Error('cleanup_unknown');
    },
  });
  let menu: NativeBrowserMenuRequest | undefined,
    choose!: (action: NativeBrowserMenuAction | null) => void;
  Object.assign(dom.window, {
    kiteNative: {
      showBrowserMenu(input: NativeBrowserMenuRequest) {
        menu = input;
        return new Promise<NativeBrowserMenuAction | null>((resolve) => {
          choose = resolve;
        });
      },
      cancelBrowserMenu() {
        choose?.(null);
      },
      browserRequest: request,
      restoreBrowser: restorePage,
      watchBrowser(listener: (state: NativeBrowserState) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  });
  let model: ReturnType<typeof useSessionTabs> | undefined;
  function Harness({ scope }: { scope: string }) {
    const pageScope = { ...selected, generation: 1, viewSelection: 1 };
    const tabs = useSessionTabs(
      scope,
      (id) => closeNativeBrowserTab(id, undefined, pageScope),
      () => restoreNativeBrowserTab(pageScope),
    );
    model = tabs;
    return (
      <>
        <button type="button" onClick={tabs.addBrowser}>
          New page
        </button>
        {tabs.tabs.map((tab) => (
          <NativeBrowserPane
            key={tab.id}
            id={tab.id}
            scope={pageScope}
            initialHint={nativeBrowserDisplayHint(tab.id, pageScope)}
            visible
            tools={null}
            onTitleChange={(value) => tabs.title(tab.id, value)}
            controlTools={(page) => (
              <NativeBrowserLeaseControls
                bridge={fixture.bridge}
                scope={{ ...browserScope, sessionId: selected.sessionId }}
                page={page}
                visible
                canRead
                canInvoke
              />
            )}
          />
        ))}
      </>
    );
  }
  const root = createRoot(dom.window.document.getElementById('root')!);
  const flush = async (action: () => void = () => {}) =>
    act(async () => {
      action();
      await Bun.sleep(35);
    });
  const until = async (check: () => boolean) => {
    const end = Date.now() + 2500;
    while (!check()) {
      if (Date.now() >= end) throw Error(`flow_timeout:${dom.window.document.body.textContent}`);
      await flush();
    }
  };
  const button = (text: string) =>
    [...dom.window.document.querySelectorAll<HTMLButtonElement>('button')].find(
      (row) => row.textContent === text || row.getAttribute('aria-label') === text,
    )!;
  const readyMenu = async (action: NativeBrowserMenuAction) => {
    const end = Date.now() + 2500;
    for (;;) {
      await flush(() => button('浏览器控制').click());
      if (menu?.items.some((item) => item.action === action && item.enabled)) return;
      await flush(() => choose?.(null));
      if (Date.now() >= end) throw Error(`native_menu_not_ready:${JSON.stringify(menu)}`);
    }
  };
  const physical = (type = 'click') => {
    const hit = [...children].reverse().find((view) => view.visible && view.bounds.width > 0);
    const target = type === 'key' ? focused : hit?.webContents;
    if (!target) return;
    if (type === 'click') target.focus();
    target.physical++;
    target.physicalEvents[type] = (target.physicalEvents[type] ?? 0) + 1;
  };
  let releaseCommand: (() => void) | undefined;
  try {
    for (const scope of [
      { ...selected, generation: 2, viewSelection: 1 },
      { ...selected, generation: 1, viewSelection: 0 },
      { ...selected, sessionId: 'foreign', generation: 1, viewSelection: 1 },
      { ...selected, storeId: 'foreign', generation: 1, viewSelection: 1 },
    ]) {
      const result = await restorePage(scope).then(
        () => null,
        (error: Error) => error.message,
      );
      expect(result).toBe('browser_page_scope_denied');
    }
    await flush(() => root.render(<Harness scope="a" />));
    await until(() => !model!.restoring);
    await flush(() => button('New page').click());
    const id = model!.tabs[0]!.id;
    await act(async () => {
      await request({ action: 'navigate', id, input: 'http://localhost/fixture' });
      await Bun.sleep(35);
    });
    const page = views[0]!;
    await until(() => page.visible);
    expect(page.webContents.nativeFrames).toBe(1);
    expect(page.webContents.frameBelowRoot).toBe(true);
    expect(page.webContents.captureCalls).toBe(0);
    expect(children.indexOf(page)).toBeGreaterThan(children.indexOf(rootView));
    physical();
    physical('key');
    physical('wheel');
    expect(page.webContents.physical).toBe(3);
    // Test setup grants control through Main; the ordinary page has no pre-arm UI.
    await act(async () => {
      await request({ action: 'grant', id });
      await Bun.sleep(35);
    });
    const signal = new AbortController().signal;
    transport = createDesktopBrowserTransport(
      { executable: '/trusted/mock', browserPath: '/unused' },
      {
        endpoint: 'http://127.0.0.1:1234/kite-page',
        token: '00000000-0000-0000-0000-00000000000100000000-0000-0000-0000-000000000002',
      },
      { sessionId: 'session', executionId: 'job', signal },
      { browserId: 'browser', storeId: async () => 'store' },
    );
    await act(async () => {
      await transport!.ready;
      await transport!.request(
        { action: 'launch', headless: true, engine: 'chrome', webmcp: false },
        signal,
      );
      await Bun.sleep(35);
    });
    await until(() => !!button('浏览器控制'));
    await readyMenu('handoff');
    expect(
      dom.window.document.querySelector('.native-browser-toolbar .native-browser-tools'),
    ).not.toBeNull();
    expect(
      dom.window.document.querySelector(
        '.native-browser-surface button, .native-browser-surface form, .native-browser-surface header',
      ),
    ).toBeNull();
    await flush(() => choose(null));
    const shield = views[1]!;
    expect(shield.background).toBe('#00000000');
    expect(shield.visible).toBe(true);
    expect(children.at(-1)).toBe(shield);
    expect(shield.bounds).toEqual(page.bounds);
    physical();
    physical('key');
    physical('wheel');
    expect(page.webContents.physical).toBe(3);
    expect(focused).toBe(owner);
    await transport.request({ action: 'click' }, signal);
    expect(page.webContents.clicks).toBe(1);
    expect(
      page.webContents.page.window.document
        .querySelector('[id^="kite-control-"]')
        ?.shadowRoot?.querySelector('svg'),
    ).not.toBeNull();
    const input = page.webContents.page.window.document.querySelector('input')!;
    input.getBoundingClientRect = () => ({ left: 20, top: 30, right: 120, bottom: 70 }) as DOMRect;
    input.focus();
    await host.request({
      op: 'cdp',
      leaseId,
      method: 'Input.insertText',
      params: { text: 'test' },
    });
    await until(
      () =>
        page.webContents.page.window.document
          .querySelector('[id^="kite-control-"]')
          ?.shadowRoot?.querySelector('svg path')
          ?.getAttribute('d') === 'M8 3h12M14 3v26M8 29h12',
    );
    const pointer = page.webContents.page.window.document
      .querySelector('[id^="kite-control-"]')
      ?.shadowRoot?.querySelector('svg');
    expect(pointer?.style.left).toBe('70px');
    expect(pointer?.style.top).toBe('50px');
    await host.request({
      op: 'cdp',
      leaseId,
      method: 'Runtime.evaluate',
      params: { expression: 'void 0' },
    });
    expect(page.webContents.styles.size).toBe(1);
    selected = { ...selected, storeId: 'other-store' };
    expect((await restorePage({ ...selected, generation: 1, viewSelection: 1 })).page).toBeNull();
    selected = { ...selected, storeId: 'store' };
    selected = { ...selected, sessionId: 'b' };
    fixture.scope = { ...browserScope, sessionId: 'b' };
    await flush(() => root.render(<Harness scope="b" />));
    expect(page.webContents.destroyed).toBe(false);
    expect(page.visible).toBe(false);
    expect(shield.visible).toBe(false);
    await transport.request({ action: 'click' }, signal);
    expect(page.webContents.clicks).toBe(2);
    expect(nativeClosed).toBe(0);
    expect(model!.tabs).toHaveLength(0);
    selected = { ...selected, sessionId: 'session' };
    fixture.scope = { ...browserScope };
    await flush(() => root.render(<Harness scope="a" />));
    await until(() => model!.tabs[0]?.id === id && !!button('浏览器控制'));
    await readyMenu('handoff');
    await flush(() => choose(null));
    expect(views).toHaveLength(2);
    expect(page.webContents.loads).toBe(1);
    expect(page.visible).toBe(true);
    expect(shield.visible).toBe(true);
    let finishCommand!: () => void;
    debuggerGate = new Promise<void>((resolve) => {
      finishCommand = resolve;
      releaseCommand = resolve;
    });
    commandStarted = false;
    const inFlight = transport.request({ action: 'click' }, signal);
    await until(() => commandStarted);
    await readyMenu('handoff');
    await flush(() => choose('handoff'));
    expect(host.state(id)?.phase).toBe('revoking');
    expect(shield.visible).toBe(true);
    physical();
    physical('key');
    physical('wheel');
    expect(page.webContents.physical).toBe(3);
    await expect(
      host.request({
        op: 'cdp',
        leaseId,
        method: 'Input.dispatchMouseEvent',
        params: { x: 1, y: 2 },
      }),
    ).rejects.toThrow();
    await act(async () => {
      finishCommand();
      debuggerGate = undefined;
      await inFlight;
      await Bun.sleep(35);
    });
    await until(() => host.state(id)?.phase === 'human');
    expect(host.state(id)?.phase).toBe('human');
    expect(page.webContents.styles.size).toBe(0);
    expect(shield.visible).toBe(false);
    expect(nativeClosed).toBe(1);
    physical();
    physical('key');
    physical('wheel');
    expect(page.webContents.physicalEvents).toEqual({ click: 2, key: 2, wheel: 2 });
    const oldLease = leaseId;
    // The old task ends normally before a new Run may acquire this same page.
    expect(await transport.close()).toEqual({ confirmed: true });
    expect(host.state(id)?.browserId).toBeUndefined();
    fixture.view = {
      ...browserView(),
      browserId: 'browser-next-run',
      generation: 'next-run-generation',
    };
    await request({ action: 'grant', id });
    transport = createDesktopBrowserTransport(
      { executable: '/trusted/mock', browserPath: '/unused' },
      {
        endpoint: 'http://127.0.0.1:1234/kite-page',
        token: '00000000-0000-0000-0000-00000000000100000000-0000-0000-0000-000000000002',
      },
      { sessionId: 'session', executionId: 'job-next-run', signal },
      { browserId: 'browser-next-run', storeId: async () => 'store' },
    );
    await act(async () => {
      await transport!.ready;
      await transport!.request(
        { action: 'launch', headless: true, engine: 'chrome', webmcp: false },
        signal,
      );
      await Bun.sleep(35);
    });
    expect(leaseId).not.toBe(oldLease);
    await expect(
      host.request({
        op: 'cdp',
        leaseId: oldLease,
        method: 'Input.dispatchMouseEvent',
        params: { type: 'mousePressed', x: 1, y: 2 },
      }),
    ).rejects.toThrow();
    expect(page.webContents.loads).toBe(1);
    expect(host.state(id)?.phase).toBe('agent');
    expect(shield.visible).toBe(true);
    await until(() => !!button('浏览器控制'));
    await flush();
    await readyMenu('close');
    await flush(() => choose('close'));
    await until(() => host.state(id)?.browserId === undefined);
    expect(page.webContents.destroyed).toBe(false);
    expect(host.state(id)?.phase).toBe('human');
    expect(shield.visible).toBe(false);
    expect(nativeCreated).toBe(2);
    expect(nativeClosed).toBe(2);
    expect(serverStopped).toBe(2);
    expect(fixture.submitted.map((row) => row.actionId)).toEqual([
      'browser.handoff',
      'browser.close',
    ]);
    // A failed native hit surface must never reopen a still-owned page to physical input.
    fixture.view = { ...browserView(), browserId: 'browser-2' };
    // Test setup grants control through Main; the ordinary page has no pre-arm UI.
    await act(async () => {
      await request({ action: 'grant', id });
      await Bun.sleep(35);
    });
    transport = createDesktopBrowserTransport(
      { executable: '/trusted/mock', browserPath: '/unused' },
      {
        endpoint: 'http://127.0.0.1:1234/kite-page',
        token: '00000000-0000-0000-0000-00000000000100000000-0000-0000-0000-000000000002',
      },
      { sessionId: 'session', executionId: 'job-2', signal },
      { browserId: 'browser-2', storeId: async () => 'store' },
    );
    await act(async () => {
      await transport!.ready;
      await transport!.request(
        { action: 'launch', headless: true, engine: 'chrome', webmcp: false },
        signal,
      );
      await Bun.sleep(35);
    });
    await until(() => !!button('浏览器控制'));
    await readyMenu('close');
    await flush(() => page.webContents.emit('render-process-gone'));
    expect(host.state(id)?.phase).toBe('unknown');
    await flush(() => shield.webContents.close());
    expect(host.state(id)?.phase).toBe('unknown');
    expect(page.visible).toBe(false);
    await request({
      action: 'present',
      id,
      pageToken: (await request({ action: 'state', id }))!.pageToken,
      scope: { ...selected, generation: 1, viewSelection: 1 },
      presentationRevision: Number.MAX_SAFE_INTEGER,
      bounds: { x: 20, y: 80, width: 800, height: 600, radius: 0 },
    });
    expect(page.visible).toBe(false);
    await flush(() => choose(null));
    await flush(() => button('浏览器控制').click());
    expect(menu?.items.find((item) => item.action === 'handoff')?.enabled).toBe(false);
    await flush(() => choose('close'));
    expect(await transport.close()).toEqual({ confirmed: false });
    expect(host.state(id)?.phase).toBe('unknown');
    expect(host.retained(id)).toBe(true);
    expect(nativeClosed).toBe(3);
    expect(serverStopped).toBe(3);
  } finally {
    releaseCommand?.();
    debuggerGate = undefined;
    await act(async () => {
      await transport?.close();
      root.unmount();
    });
    dispose();
    dispose();
    expect(views.every((view) => view.webContents.destroyed)).toBe(true);
    owner.close();
    globalThis.fetch = originalFetch;
    Bun.serve = originalServe;
    restore();
    dom.window.close();
  }
});
test('restoration ignores old A replies after A-B-A, blocks allocation until verified and keeps a failed read retry explicit', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
  const restoreDom = prepareDesktopDom(dom);
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const reads: {
    resolve: (page: { id: string; title: string } | null) => void;
    reject: (error: Error) => void;
  }[] = [];
  const closed: string[] = [];
  const originalTimer = globalThis.setTimeout;
  let timeOut!: () => void;
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    if (args[1] === 3000) timeOut = args[0] as () => void;
    return originalTimer(...args);
  }) as typeof setTimeout;
  const read = () =>
    new Promise<{ id: string; title: string } | null>((resolve, reject) => {
      reads.push({ resolve, reject });
    });
  let model: ReturnType<typeof useSessionTabs> | undefined;
  function Harness({ scope }: { scope: string }) {
    model = useSessionTabs(scope, (id) => closed.push(id), read);
    return <span>{model.active}</span>;
  }
  const root = createRoot(dom.window.document.getElementById('root')!);
  try {
    await act(async () => root.render(<Harness scope="a" />));
    expect(reads).toHaveLength(1);
    expect(model!.restoring).toBe(true);
    await act(() => model!.addBrowser());
    expect(model!.tabs).toHaveLength(0);
    await act(async () => root.render(<Harness scope="b" />));
    expect(reads).toHaveLength(2);
    await act(async () => reads[1]!.resolve({ id: 'b', title: 'B retained' }));
    expect(model!.active).toBe('b');
    await act(async () => root.render(<Harness scope="a" />));
    expect(reads).toHaveLength(3);
    await act(async () => reads[0]!.resolve({ id: 'a-old', title: 'stale A' }));
    expect(model!.tabs).toHaveLength(0);
    expect(model!.restoring).toBe(true);
    await act(async () => reads[2]!.reject(Error('read_unavailable')));
    expect(model!.restoreIssue).toBe(true);
    expect(model!.restoring).toBe(false);
    await act(() => {
      model!.addBrowser();
      model!.openChanges();
    });
    expect(model!.tabs).toHaveLength(0);
    expect(reads).toHaveLength(3);
    await act(async () => model!.retryRestore!());
    expect(reads).toHaveLength(4);
    await act(async () => timeOut());
    expect(model!.restoreIssue).toBe(true);
    await act(async () => model!.retryRestore!());
    expect(reads).toHaveLength(5);
    await act(async () => reads[4]!.resolve({ id: 'a-new', title: 'A retained' }));
    await act(async () => reads[3]!.resolve({ id: 'a-timeout', title: 'late timed out read' }));
    expect(model!.active).toBe('a-new');
    expect(model!.restoreIssue).toBe(false);
    expect(closed).toEqual([]);
    // Scope changes and unmount only release observation. Only the explicit
    // current tab close calls the Native close port, exactly once.
    await act(() => model!.closeTab('b'));
    expect(model!.active).toBe('a-new');
    expect(closed).toEqual([]);
    await act(() => model!.closeTab('a-new'));
    expect(model!.tabs).toHaveLength(0);
    expect(closed).toEqual(['a-new']);
  } finally {
    await act(() => root.unmount());
    globalThis.setTimeout = originalTimer;
    restoreDom();
    dom.window.close();
  }
  expect(closed).toEqual(['a-new']);
});

test('a native focus transfer that did not take effect fails closed without claiming a working input shield', async () => {
  const owner = new FakeContents(),
    children: FakeView[] = [];
  owner.focus = () => {};
  const windowPort = {
    webContents: owner,
    isDestroyed: () => false,
    contentView: {
      children,
      addChildView(view: FakeView) {
        children.push(view);
      },
      removeChildView(view: FakeView) {
        const i = children.indexOf(view);
        if (i >= 0) children.splice(i, 1);
      },
    },
  };
  let failures = 0;
  const shield = createBrowserInputShield(windowPort as unknown as BrowserWindow, () => {
    failures++;
  });
  const page = new FakeView({ webPreferences: {} });
  page.setVisible(true);
  page.setBounds({ x: 0, y: 0, width: 800, height: 600 });
  page.webContents.focus();
  try {
    await shield.prepare();
    shield.sync(page as unknown as Electron.WebContentsView, true);
    expect(failures).toBe(1);
    expect(shield.available()).toBe(false);
    await expect(shield.prepare()).rejects.toThrow('shield_closed');
    expect(page.webContents.destroyed).toBe(false);
    const hit = children[0]!;
    expect(hit.options.webPreferences.nodeIntegration).toBe(false);
    expect(hit.options.webPreferences.sandbox).toBe(true);
    expect(hit.webContents.url).toStartWith('data:text/html');
    expect(decodeURIComponent(hit.webContents.url)).not.toContain('<script');
    shield.dispose();
    shield.dispose();
    expect(hit.webContents.destroyed).toBe(true);
  } finally {
    shield.dispose();
    page.webContents.close();
    owner.close();
  }
});
