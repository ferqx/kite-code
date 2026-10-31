import { expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import type { BrowserPagePort, NativeBrowserPageHost } from '../../electron/browser-page-host';
import {
  type NativeBrowserLayout,
  type NativeBrowserMenuRequest,
  type NativeBrowserPresentationFrame,
  type NativeBrowserRequest,
  type NativeBrowserRestoreResult,
  type NativeBrowserRestoreScope,
  nativeBrowserChannel,
  nativeBrowserLayoutChannel,
  nativeBrowserLayoutFrameChannel,
  nativeBrowserMenuCancelChannel,
  nativeBrowserMenuChannel,
  nativeBrowserWitnessColors,
  nativeBrowserWitnessSamplePoints,
  projectNativeBrowserBounds,
} from '../../src/native-browser-bridge';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const metrics = { width: 800, height: 600, dpr: 2, x: 0, y: 100 };
const image = {
  data: Buffer.from(JSON.stringify({ width: 1600, height: 1200 })).toString('base64'),
};
class FakeImage {
  readonly width: number;
  readonly height: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
  isEmpty() {
    return !this.width || !this.height;
  }
  getSize() {
    return { width: this.width, height: this.height };
  }
  resize(size: { width: number; height: number }) {
    return new FakeImage(size.width, size.height);
  }
  toPNG() {
    return Buffer.from(JSON.stringify({ ...this.getSize(), format: 'png' }));
  }
  toJPEG(quality: number) {
    return Buffer.from(JSON.stringify({ ...this.getSize(), format: 'jpeg', quality }));
  }
}
const views: FakeView[] = [];
const windowOwners = new WeakMap<FakeContents, BrowserWindow>();
class FakeContents extends EventEmitter {
  destroyed = false;
  zoom = 1;
  attached = true;
  mainFrame = { url: 'http://localhost/' };
  readonly navigationHistory = { canGoBack: () => false, canGoForward: () => false };
  readMetrics: () => Promise<unknown> = async () => metrics;
  screenshot: (params: Record<string, unknown>) => Promise<unknown> = async () => image;
  paintWorld: (scripts: { code: string }[]) => Promise<void> = async () => {};
  readonly debugger = Object.assign(new EventEmitter(), {
    isAttached: () => this.attached,
    attach: () => {
      this.attached = true;
    },
    detach: () => {
      this.attached = false;
    },
    sendCommand: async (_method: string, params: Record<string, unknown>) =>
      this.screenshot(params),
  });
  isDestroyed() {
    return this.destroyed;
  }
  isFocused() {
    return false;
  }
  focusCalls = 0;
  focus() {
    this.focusCalls++;
  }
  getZoomFactor() {
    return this.zoom;
  }
  readonly sent: { channel: string; value: unknown }[] = [];
  send(channel: string, value: unknown) {
    this.sent.push({ channel, value });
  }
  frame?: (image: Electron.NativeImage, dirty?: Electron.Rectangle) => void;
  readonly frameCallbacks: ((image: Electron.NativeImage) => void)[] = [];
  frameOnlyDirty?: boolean;
  beginFrameSubscription(
    onlyDirty: boolean | ((image: Electron.NativeImage) => void),
    callback?: (image: Electron.NativeImage, dirty: Electron.Rectangle) => void,
  ) {
    this.frameOnlyDirty = typeof onlyDirty === 'boolean' ? onlyDirty : undefined;
    const receive = typeof onlyDirty === 'function' ? onlyDirty : callback!;
    this.frame = (image, dirty) => receive(image, dirty ?? { x: 0, y: 0, ...image.getSize() });
    this.frameCallbacks.push(this.frame);
  }
  endFrameSubscription() {
    this.frame = undefined;
  }
  setWindowOpenHandler() {}
  getURL() {
    return 'http://localhost/page';
  }
  getTitle() {
    return 'Local page';
  }
  loadingMain = false;
  isLoadingMainFrame() {
    return this.loadingMain;
  }
  loads = 0;
  readonly document = { value: '', clicks: 0 };
  async loadURL() {
    this.loads++;
  }
  captureCalls = 0;
  captureVisible: () => Promise<{ toPNG(): Buffer }> = async () => {
    const bytes = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
    bytes.writeUInt32BE(1600, 16);
    bytes.writeUInt32BE(1200, 20);
    return { toPNG: () => bytes };
  };
  async capturePage() {
    this.captureCalls++;
    return this.captureVisible();
  }
  async executeJavaScript() {
    return this.readMetrics();
  }
  async executeJavaScriptInIsolatedWorld(_world: number, scripts: { code: string }[]) {
    return this.paintWorld(scripts);
  }
  async removeInsertedCSS() {}
  close() {
    this.destroyed = true;
  }
}
class FakeView {
  readonly webContents = new FakeContents();
  visible = false;
  readonly visibility: boolean[] = [];
  bounds = { x: 0, y: 0, width: 0, height: 0 };
  readonly boundsWrites: Electron.Rectangle[] = [];
  readonly radiusWrites: number[] = [];
  readonly options: { webPreferences?: Record<string, unknown> };
  constructor(options: { webPreferences?: Record<string, unknown> } = {}) {
    this.options = options;
    views.push(this);
  }
  setVisible(value: boolean) {
    this.visible = value;
    this.visibility.push(value);
  }
  getVisible() {
    return this.visible;
  }
  getBounds() {
    return { ...this.bounds };
  }
  setBounds(bounds: typeof this.bounds) {
    this.boundsWrites.push({ ...bounds });
    this.bounds = { ...bounds };
  }
  setBorderRadius(radius: number) {
    this.radiusWrites.push(radius);
  }
  setBackgroundColor() {}
}
let popupTemplate: Electron.MenuItemConstructorOptions[] = [],
  popupOptions: Electron.PopupOptions | undefined;
let popupCloses = 0;
let deferPopupClose = false;
const pendingPopupCloses: (() => void)[] = [];
mock.module('electron', () => ({
  BrowserWindow: {
    fromWebContents: (contents: FakeContents) => windowOwners.get(contents) ?? null,
  },
  Menu: {
    buildFromTemplate(template: Electron.MenuItemConstructorOptions[]) {
      popupTemplate = template;
      let originalOptions: Electron.PopupOptions | undefined;
      return {
        popup(options: Electron.PopupOptions) {
          originalOptions = options;
          popupOptions = options;
        },
        closePopup() {
          popupCloses++;
          if (deferPopupClose) pendingPopupCloses.push(() => originalOptions?.callback?.());
          else originalOptions?.callback?.();
        },
      };
    },
  },
  WebContentsView: FakeView,
  nativeImage: {
    createFromBuffer(bytes: Buffer) {
      const size = JSON.parse(bytes.toString());
      return new FakeImage(size.width, size.height);
    },
  },
  session: {
    fromPartition: () =>
      Object.assign(new EventEmitter(), {
        setPermissionRequestHandler() {},
        setPermissionCheckHandler() {},
        webRequest: { onBeforeRequest() {} },
      }),
  },
}));
let nativeChrome:
  | {
      ready: boolean;
      layouts: { id: string; bounds: Electron.Rectangle }[];
      releases: (string | undefined)[];
      invalidations: number;
      viewportSyncs: number;
      pageScope(): unknown;
    }
  | undefined;
mock.module('../../electron/browser-chrome-host', () => ({
  createNativeBrowserChromeHost(options: {
    getPage(id: string): { id: string; scope?: unknown } | undefined;
    currentScope(forInput: boolean): NativeBrowserRestoreScope | undefined;
  }) {
    const initialScope = options.currentScope(false);
    const boundScope = initialScope && { ...initialScope };
    const state = {
      ready: false,
      layouts: [] as { id: string; bounds: Electron.Rectangle }[],
      releases: [] as (string | undefined)[],
      invalidations: 0,
      viewportSyncs: 0,
      pageScope: () => options.getPage('page')?.scope,
    };
    nativeChrome = state;
    return {
      readyFor: (id: string, scope?: NativeBrowserRestoreScope) =>
        state.ready &&
        options.getPage(id)?.id === id &&
        JSON.stringify(options.currentScope(false)) === JSON.stringify(boundScope) &&
        (!scope || JSON.stringify(scope) === JSON.stringify(boundScope)),
      invalidateGeometry() {
        state.invalidations++;
      },
      syncViewport() {
        state.viewportSyncs++;
      },
      update() {},
      layout(id: string, bounds: Electron.Rectangle) {
        state.layouts.push({ id, bounds });
        return state.ready;
      },
      release(id?: string) {
        state.releases.push(id);
      },
      dispose() {},
    };
  },
}));
const { registerNativeBrowserIpc } = await import('../../electron/native-browser');

function fixture(nativeOwned = false) {
  views.length = 0;
  let page!: BrowserPagePort;
  const presentation: boolean[] = [];
  const state = {
    phase: 'human',
    navigation: 0,
    incarnation: 'incarnation',
    browserId: 'browser',
    sessionId: 'session',
  };
  const automation = {
    assertCanCreate() {},
    configureGrantContext: () => () => {},
    state: () => ({ ...state }),
    add(port: BrowserPagePort) {
      page = port;
      return () => {};
    },
    fail() {
      state.phase = 'unknown';
      page?.changed();
    },
    navigate() {
      state.navigation++;
      page?.changed();
    },
    retained() {
      return state.phase !== 'human';
    },
    present(_id: string, visible: boolean) {
      presentation.push(visible);
    },
  } as unknown as NativeBrowserPageHost;
  const owner = new FakeContents();
  const contentSize = [1600, 1200];
  const children: FakeView[] = [];
  const window = Object.assign(new EventEmitter(), {
    webContents: owner,
    isDestroyed: () => false,
    isVisible: () => true,
    isMinimized: () => false,
    getContentSize: () => contentSize,
    contentView: {
      children,
      addChildView(view: FakeView) {
        const old = children.indexOf(view);
        if (old >= 0) children.splice(old, 1);
        children.push(view);
        windowOwners.set(view.webContents, window);
      },
      removeChildView(view: FakeView) {
        const old = children.indexOf(view);
        if (old >= 0) children.splice(old, 1);
        windowOwners.delete(view.webContents);
      },
    },
  }) as unknown as BrowserWindow;
  const events = new Map<string, (event: Electron.IpcMainEvent, input: unknown) => void>();
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => unknown>();
  const scope = { storeId: 'store', sessionId: 'session', generation: 1, viewSelection: 1 };
  const close = registerNativeBrowserIpc({
    window,
    ipcMain: {
      on: (key: string, handler: (event: Electron.IpcMainEvent, input: unknown) => void) =>
        events.set(key, handler),
      off: (key: string) => events.delete(key),
      handle: (key: string, handler: (event: IpcMainInvokeEvent, input: unknown) => unknown) =>
        handlers.set(key, handler),
      removeHandler() {},
    } as unknown as IpcMain,
    automation,
    selectedScope: () => scope,
    rendererUrl: 'http://localhost/',
    ...(nativeOwned ? { chrome: { preloadPath: '/isolated/chrome.cjs' } } : {}),
  });
  expect(
    handlers.get(nativeBrowserChannel)!(
      { sender: owner, senderFrame: owner.mainFrame } as unknown as IpcMainInvokeEvent,
      { action: 'navigate', id: 'page', input: 'http://localhost/page' },
    ),
  ).toMatchObject({ ok: true });
  state.phase = 'agent';
  const present = (
    bounds: { x: number; y: number; width: number; height: number; radius: number } | null,
    layout?: NativeBrowserLayout,
  ) =>
    handlers.get(nativeBrowserChannel)!(
      { sender: owner, senderFrame: owner.mainFrame } as unknown as IpcMainInvokeEvent,
      { action: 'present', id: 'page', bounds, ...(layout ? { layout } : {}) },
    );
  return {
    display: (input: unknown, frame = owner.mainFrame) => {
      const event = {
        sender: owner,
        senderFrame: frame,
        returnValue: undefined,
      } as unknown as Electron.IpcMainEvent;
      events.get('kite:native:browser-display')?.(event, input);
      return event.returnValue;
    },
    sync: (input: unknown) => {
      const event = {
        sender: owner,
        senderFrame: owner.mainFrame,
        returnValue: undefined,
      } as unknown as Electron.IpcMainEvent;
      events.get(nativeBrowserLayoutChannel)!(event, input);
      return event.returnValue;
    },
    menu: (input: NativeBrowserMenuRequest) =>
      handlers.get(nativeBrowserMenuChannel)!(
        { sender: owner, senderFrame: owner.mainFrame } as unknown as IpcMainInvokeEvent,
        input,
      ),
    cancelMenu: (id: string) =>
      events.get(nativeBrowserMenuCancelChannel)!(
        { sender: owner, senderFrame: owner.mainFrame } as unknown as Electron.IpcMainEvent,
        id,
      ),
    invoke: (input: unknown) =>
      handlers.get(nativeBrowserChannel)!(
        { sender: owner, senderFrame: owner.mainFrame } as unknown as IpcMainInvokeEvent,
        input,
      ),
    invokeFromFrame: (input: unknown, frame: typeof owner.mainFrame) =>
      handlers.get(nativeBrowserChannel)!(
        { sender: owner, senderFrame: frame } as unknown as IpcMainInvokeEvent,
        input,
      ),
    scope,
    page,
    state,
    contents: views.at(-1)!.webContents,
    view: views.at(-1)!,
    window,
    contentSize,
    owner,
    presentation,
    present,
    close,
  };
}

test('Native waits for the owned main document DOM-ready while hide and resources do not decide readiness', async () => {
  const f = fixture(),
    signal = new AbortController().signal;
  try {
    expect(await f.page.waitForDocument!(signal)).toBe(true);
    f.contents.emit('did-start-navigation', {}, 'http://localhost/next', false, false);
    expect(await f.page.waitForDocument!(signal)).toBe(true); // subframe only
    f.contents.emit('did-start-navigation', {}, 'http://localhost/page#hash', true, true);
    f.contents.emit('did-navigate-in-page', {}, 'http://localhost/page#hash', true);
    expect(await f.page.waitForDocument!(signal)).toBe(true); // no new document
    const loads = f.contents.loads;
    f.contents.emit('did-start-navigation', {}, 'http://localhost/next', false, true);
    let settled = false;
    const waiting = f.page.waitForDocument!(signal).then((value) => {
      settled = true;
      return value;
    });
    f.window.emit('hide');
    f.contents.emit('did-finish-load');
    f.contents.emit('dom-ready'); // previous/uncommitted document cannot release this read
    await Promise.resolve();
    expect(settled).toBe(false);
    f.contents.emit('did-navigate', {}, 'http://localhost/next');
    await Promise.resolve();
    expect(settled).toBe(false);
    const committedFrame = f.contents.mainFrame;
    f.contents.mainFrame = { url: 'http://localhost/another-frame' };
    f.contents.emit('dom-ready');
    await Promise.resolve();
    expect(settled).toBe(false);
    f.contents.mainFrame = committedFrame;
    f.contents.emit('dom-ready');
    expect(await waiting).toBe(true);
    expect(f.contents.loads).toBe(loads);
  } finally {
    f.close();
  }
});

test('late failures from an old URL and same-URL abort do not poison the current document', async () => {
  const f = fixture(),
    signal = new AbortController().signal;
  try {
    f.contents.emit('did-start-navigation', {}, 'http://localhost/old', false, true);
    const old = f.page.waitForDocument!(signal);
    f.contents.emit('did-start-navigation', {}, 'http://localhost/new', false, true);
    expect(await old).toBe(false);
    let settled = false;
    const current = f.page.waitForDocument!(signal).then((value) => {
      settled = true;
      return value;
    });
    f.contents.emit('did-fail-load', {}, -2, 'old failed', 'http://localhost/old', true);
    f.contents.emit(
      'did-fail-provisional-load',
      {},
      -3,
      'old cancelled',
      'http://localhost/old',
      true,
    );
    f.contents.emit(
      'did-fail-provisional-load',
      {},
      -3,
      'same URL old cancelled',
      'http://localhost/new',
      true,
    );
    f.contents.loadingMain = true;
    f.contents.emit('did-stop-loading');
    await Promise.resolve();
    expect(settled).toBe(false);
    f.contents.emit('did-navigate', {}, 'http://localhost/new');
    f.contents.emit('dom-ready');
    expect(await current).toBe(true);
  } finally {
    f.close();
  }
});

for (const end of [
  'supersede',
  'revoke',
  'close',
  'crash',
  'failure',
  'abort',
  'stop',
  'detach',
] as const)
  test(`Native document wait wakes on ${end} without navigation or replay`, async () => {
    const f = fixture(),
      owner = new AbortController();
    try {
      f.contents.emit('did-start-navigation', {}, 'http://localhost/next', false, true);
      const waiting = f.page.waitForDocument!(owner.signal);
      const loads = f.contents.loads;
      if (end === 'supersede')
        f.contents.emit('did-start-navigation', {}, 'http://localhost/newer', false, true);
      if (end === 'revoke') {
        f.state.phase = 'revoking';
        f.page.changed();
      }
      if (end === 'close') f.close();
      if (end === 'crash') f.contents.emit('render-process-gone');
      if (end === 'failure')
        f.contents.emit('did-fail-load', {}, -2, 'failed', 'http://localhost/next', true);
      if (end === 'stop') {
        f.contents.emit(
          'did-fail-provisional-load',
          {},
          -3,
          'stopped',
          'http://localhost/next',
          true,
        );
        f.contents.loadingMain = false;
        f.contents.emit('did-stop-loading');
      }
      if (end === 'detach') f.contents.debugger.emit('detach');
      if (end === 'abort') {
        owner.abort(Error('cancel original read'));
        await expect(waiting).rejects.toThrow('cancel original read');
      } else expect(await waiting).toBe(false);
      expect(f.contents.loads).toBe(loads);
    } finally {
      owner.abort();
      f.close();
    }
  });

test('an exact accepted or dismissed dialog clears only its native UI after the CDP decision', async () => {
  for (const accept of [true, false]) {
    const f = fixture();
    try {
      const decision = deferred<unknown>();
      const events: string[] = [];
      f.contents.emit('-run-dialog');
      f.contents.on('-cancel-dialogs', () => events.push('native-ui-cancelled'));
      f.contents.screenshot = async (params) => {
        expect(params).toEqual({ accept });
        events.push('cdp-decision');
        return decision.promise;
      };
      const handling = f.page.send('Page.handleJavaScriptDialog', { accept });
      expect(events).toEqual(['cdp-decision']);
      decision.resolve({});
      expect(await handling).toEqual({});
      expect(events).toEqual(['cdp-decision', 'native-ui-cancelled']);
      expect(f.view.visible).toBe(false);
      expect(windowOwners.get(f.contents)).toBe(f.window);
    } finally {
      f.close();
    }
  }
});

test('a late dialog decision never clears native UI after its page or control changes', async () => {
  for (const change of [
    'navigation',
    'session',
    'browser',
    'incarnation',
    'phase',
    'attachment',
    'dialog',
    'owner',
    'closed',
  ]) {
    const f = fixture();
    try {
      const decision = deferred<unknown>();
      let decisions = 0,
        nativeCancellations = 0;
      f.contents.emit('-run-dialog');
      f.contents.on('-cancel-dialogs', () => ++nativeCancellations);
      f.contents.screenshot = async () => {
        ++decisions;
        return decision.promise;
      };
      const handling = f.page.send('Page.handleJavaScriptDialog', { accept: true });
      if (change === 'navigation') ++f.state.navigation;
      if (change === 'session') f.state.sessionId = 'other-session';
      if (change === 'browser') f.state.browserId = 'other-browser';
      if (change === 'incarnation') f.state.incarnation = 'other-page';
      if (change === 'phase') f.state.phase = 'human';
      if (change === 'attachment') {
        await f.page.detach();
        f.contents.attached = true;
      }
      if (change === 'dialog') f.contents.emit('-run-dialog');
      if (change === 'owner') windowOwners.delete(f.contents);
      if (change === 'closed') f.contents.destroyed = true;
      decision.resolve({});
      await expect(handling).rejects.toThrow('browser_page_dialog_cleanup_unknown');
      expect(decisions).toBe(1);
      expect(nativeCancellations).toBe(0);
    } finally {
      f.close();
    }
  }
});

test('an unconfirmed CDP dialog decision never cancels native UI or replays the decision', async () => {
  const f = fixture();
  try {
    let decisions = 0,
      nativeCancellations = 0;
    f.contents.on('-cancel-dialogs', () => ++nativeCancellations);
    f.contents.screenshot = async () => {
      ++decisions;
      throw Error('dialog_response_lost');
    };
    await expect(f.page.send('Page.handleJavaScriptDialog', { accept: true })).rejects.toThrow(
      'dialog_response_lost',
    );
    expect(decisions).toBe(1);
    expect(nativeCancellations).toBe(0);
  } finally {
    f.close();
  }
});

test('dialog UI cleanup needs the original owner and a native cancellation listener', async () => {
  for (const owned of [true, false]) {
    const f = fixture();
    try {
      let decisions = 0;
      f.contents.screenshot = async () => {
        ++decisions;
        return {};
      };
      if (!owned) windowOwners.delete(f.contents);
      await expect(f.page.send('Page.handleJavaScriptDialog', { accept: true })).rejects.toThrow(
        owned ? 'browser_page_dialog_cleanup_unknown' : 'browser_page_dialog_stale',
      );
      expect(decisions).toBe(owned ? 1 : 0);
    } finally {
      f.close();
    }
  }
});

test('a background page has a nonzero viewport before its first Renderer presentation', async () => {
  const f = fixture();
  try {
    expect(f.view.getVisible()).toBe(false);
    expect(f.view.getBounds()).toEqual({ x: 0, y: 0, width: 960, height: 540 });
    f.contents.readMetrics = async () => ({ ...metrics, ...f.view.getBounds() });
    f.contents.screenshot = async () => ({
      data: Buffer.from(JSON.stringify({ width: 1920, height: 1080 })).toString('base64'),
    });
    const capture = await f.page.send('Page.captureScreenshot', { format: 'png' });
    expect(capture).toMatchObject({ data: expect.any(String) });
    expect(f.view.getVisible()).toBe(false);
  } finally {
    f.close();
  }
});

test('Main commits only fresh synchronous nested layouts and never moves the page ahead of Renderer resize', async () => {
  const f = fixture();
  try {
    f.state.phase = 'acquiring';
    await f.page.attach();
    f.state.phase = 'agent';
    const shield = views.at(-1)!;
    const bounds = { x: 951.45, y: 92, width: 448.3, height: 687, radius: 8 };
    const panel = (size: number, min: number, preserve: 'pixel' | 'relative') => ({
      size,
      min,
      minUnit: 'px' as const,
      max: 100,
      maxUnit: '%' as const,
      preserve,
      collapsible: false,
    });
    const layout: NativeBrowserLayout = {
      windowWidth: 1400,
      windowHeight: 839,
      insetLeft: 0.45,
      insetRight: 0.25,
      groups: [
        {
          left: 0,
          right: 0,
          gap: 1,
          panels: [
            { ...panel(200, 200, 'pixel'), max: 420, maxUnit: 'px' },
            panel(1199, 200, 'relative'),
          ],
        },
        {
          left: 0,
          right: 0,
          gap: 1,
          panels: [
            panel(749, 360, 'relative'),
            { ...panel(449, 240, 'relative'), max: 85, collapsible: true },
          ],
        },
      ],
    };
    f.contentSize.splice(0, 2, 1400, 839);
    const commit = (width: number, height: number, zoom = 1) => {
      const projected = projectNativeBrowserBounds(bounds, layout, width / zoom, height / zoom)!;
      // The production Panels are independently exercised in the Pane test. Here
      // Main receives that already completed layout, never extrapolates on resize.
      const currentLayout = {
        ...layout,
        windowWidth: width / zoom,
        windowHeight: height / zoom,
        groups: [
          {
            ...layout.groups[0]!,
            panels: [
              layout.groups[0]!.panels[0],
              { ...layout.groups[0]!.panels[1], size: width / zoom - 201 },
            ],
          },
          {
            ...layout.groups[1]!,
            panels: [
              {
                ...layout.groups[1]!.panels[0],
                size: width / zoom - 202 - projected.width - layout.insetLeft - layout.insetRight,
              },
              {
                ...layout.groups[1]!.panels[1],
                size: projected.width + layout.insetLeft + layout.insetRight,
              },
            ],
          },
        ],
      };
      return f.sync({
        action: 'present',
        id: 'page',
        bounds: projected,
        layout: currentLayout,
        scope: { ...f.scope },
      });
    };
    expect(
      f.sync({ action: 'present', id: 'page', bounds, layout, scope: { ...f.scope } }),
    ).toMatchObject({ ok: true });
    const original = f.view.getBounds();
    expect(original).toEqual({ x: 952, y: 92, width: 447, height: 687 });
    for (const width of [1100, 820, 1400, 1800, 1100]) {
      const before = f.view.getBounds();
      f.contentSize.splice(0, 2, width, 839);
      f.window.emit('resize');
      expect(f.view.getBounds()).toEqual(before);
      expect(shield.getBounds()).toEqual(before);
      if (width !== 1400)
        expect(
          f.sync({ action: 'present', id: 'page', bounds, layout, scope: { ...f.scope } }),
        ).toMatchObject({ ok: false });
      expect(commit(width, 839)).toMatchObject({ ok: true });
      expect(shield.getBounds()).toEqual(f.view.getBounds());
      expect(f.view.getVisible()).toBe(true);
    }
    const accepted = f.view.getBounds();
    for (const scope of [
      { ...f.scope, sessionId: 'other' },
      { ...f.scope, viewSelection: f.scope.viewSelection + 1 },
    ]) {
      expect(f.sync({ action: 'present', id: 'page', bounds, layout, scope })).toMatchObject({
        ok: false,
      });
      expect(f.view.getBounds()).toEqual(accepted);
    }
    expect(f.sync({ action: 'navigate', id: 'page', input: 'http://localhost/' })).toMatchObject({
      ok: false,
    });
    expect(f.sync({ action: 'present', id: 'page', bounds: null })).toMatchObject({ ok: false });
    expect(f.view.getBounds()).toEqual(accepted);
    // Use the last accepted measured payload, then ensure an old async cleanup
    // cannot hide the newer synchronous commit even when its scope is identical.
    f.contentSize.splice(0, 2, 1400, 839);
    expect(
      f.sync({
        action: 'present',
        id: 'page',
        bounds,
        layout,
        scope: { ...f.scope },
        presentationRevision: 20,
      }),
    ).toMatchObject({ ok: true });
    expect(
      f.invoke({ action: 'present', id: 'page', bounds: null, presentationRevision: 19 }),
    ).toMatchObject({ ok: false });
    expect(f.view.getVisible()).toBe(true);
    expect(
      f.sync({
        action: 'present',
        id: 'page',
        bounds,
        layout,
        scope: { ...f.scope },
        presentationRevision: 19,
      }),
    ).toMatchObject({ ok: false });
    expect(f.view.getVisible()).toBe(true);
  } finally {
    f.close();
  }
});

test('rapid 820 to 1400 resize rejects late, mixed and metadata-free measurements without changing visible page, shield or image proof', async () => {
  const f = fixture();
  const panel = (size: number) => ({
    size,
    min: 0,
    minUnit: 'px' as const,
    max: 100,
    maxUnit: '%' as const,
    preserve: 'relative' as const,
    collapsible: false,
  });
  const measured = (width: number, height: number, left: number) => ({
    bounds: { x: left + 1, y: 92, width: width - left - 1, height: height - 93, radius: 8 },
    layout: {
      windowWidth: width,
      windowHeight: height,
      insetLeft: 0,
      insetRight: 0,
      groups: [
        {
          left: 0,
          right: 0,
          gap: 1,
          panels: [panel(left), panel(width - left - 1)],
        },
      ],
    } satisfies NativeBrowserLayout,
  });
  try {
    f.state.phase = 'acquiring';
    await f.page.attach();
    f.state.phase = 'agent';
    const shield = views.at(-1)!;
    const big = measured(1400, 839, 856),
      small = measured(820, 700, 540);
    f.contentSize.splice(0, 2, 1400, 839);
    expect(f.present(big.bounds, big.layout)).toMatchObject({ ok: true });
    f.contentSize.splice(0, 2, 820, 700);
    f.window.emit('resize');
    expect(f.present(small.bounds, small.layout)).toMatchObject({ ok: true });
    f.contentSize.splice(0, 2, 1400, 839);
    f.window.emit('resize');
    expect(f.present(big.bounds, big.layout)).toMatchObject({ ok: true });
    const expected = f.view.getBounds();
    f.contents.readMetrics = async () => ({
      ...metrics,
      width: expected.width,
      height: expected.height,
    });
    f.contents.screenshot = async () => ({
      data: Buffer.from(
        JSON.stringify({ width: expected.width * 2, height: expected.height * 2 }),
      ).toString('base64'),
    });
    await f.page.send('Page.captureScreenshot', { format: 'png' });
    const proof = f.page.captureMeta() as { metadata: { captureId: string } };
    expect(await f.page.validateCapture!(proof.metadata.captureId)).toBe(true);
    const menuFrame = (await f.invoke({ action: 'capturePresentation', id: 'page' })) as {
      ok: boolean;
      value: NativeBrowserPresentationFrame;
    };
    expect(menuFrame.ok).toBe(true);
    f.view.visibility.length = 0;
    shield.visibility.length = 0;
    f.presentation.length = 0;
    const rootMixed = {
      ...small.layout,
      windowWidth: 1400,
      windowHeight: 839,
      groups: [{ ...small.layout.groups[0]!, right: 580 }],
    };
    const gapMixed = { ...rootMixed, groups: [{ ...small.layout.groups[0]!, gap: 581 }] };
    const childrenMixed = { ...rootMixed, groups: [small.layout.groups[0]!] };
    const innerMixed = {
      ...big.layout,
      groups: [big.layout.groups[0]!, { ...small.layout.groups[0]!, right: 20 }],
    };
    for (const [bounds, layout] of [
      [small.bounds, small.layout],
      [small.bounds, undefined],
      [small.bounds, rootMixed],
      [small.bounds, gapMixed],
      [small.bounds, childrenMixed],
      [big.bounds, innerMixed],
      [big.bounds, { ...big.layout, windowHeight: 700 }],
    ] as const) {
      expect(f.present(bounds, layout)).toMatchObject({ ok: false });
      expect(f.view.getBounds()).toEqual(expected);
      expect(shield.getBounds()).toEqual(expected);
      expect(await f.page.validateCapture!(proof.metadata.captureId)).toBe(true);
      f.window.emit('resize'); // a rejected message must not contaminate the next projection anchor
      expect(f.view.getBounds()).toEqual(expected);
    }
    expect(f.view.visibility).not.toContain(false);
    expect(shield.visibility).not.toContain(false);
    expect(f.presentation).not.toContain(false);
    // Rejected samples also retain a pending menu capture's one-shot hide proof.
    expect(
      await f.invoke({
        action: 'present',
        id: 'page',
        bounds: null,
        presentationKey: menuFrame.value.key,
      }),
    ).toMatchObject({ ok: true });
    expect(f.present(big.bounds, big.layout)).toMatchObject({ ok: true });
    f.owner.zoom = 1.25;
    f.contentSize.splice(0, 2, 1375, 1048.75);
    f.window.emit('resize');
    const projected = f.view.getBounds(),
      zoomed = measured(1100, 839, 660);
    expect(f.present(big.bounds, big.layout)).toMatchObject({ ok: false });
    expect(f.view.getBounds()).toEqual(projected);
    expect(f.present(zoomed.bounds, zoomed.layout)).toMatchObject({ ok: true });
    expect(shield.getBounds()).toEqual(f.view.getBounds());
    expect(f.view.getVisible()).toBe(true);
    expect(f.present(null)).toMatchObject({ ok: true });
    expect(f.view.getVisible()).toBe(false);
    // An explicit withdrawal ends the Panel anchor; the original bare path remains compatible.
    expect(f.present(small.bounds)).toMatchObject({ ok: true });
    expect(f.view.getVisible()).toBe(true);
    expect(f.present(zoomed.bounds, zoomed.layout)).toMatchObject({ ok: true });
    expect(f.view.getVisible()).toBe(true);
  } finally {
    f.close();
  }
});

test('continuous window resize retains the visible page and synchronized input shield until explicit hide', async () => {
  const f = fixture();
  expect(views[0]!.options.webPreferences).toMatchObject({
    safeDialogs: true,
    disableDialogs: false,
    nodeIntegration: false,
    sandbox: true,
  });
  try {
    f.state.phase = 'acquiring';
    await f.page.attach();
    f.state.phase = 'agent';
    const shield = views.at(-1)!;
    expect(shield).not.toBe(f.view);
    expect(f.present({ x: 50, y: 60, width: 800, height: 600, radius: 8 })).toMatchObject({
      ok: true,
    });
    f.view.visibility.length = 0;
    shield.visibility.length = 0;
    f.presentation.length = 0;
    for (let i = 0; i < 12; i++) {
      f.window.emit('resize');
      expect(f.view.getVisible()).toBe(true);
      expect(shield.getVisible()).toBe(true);
      expect(f.present({ x: 50 + i, y: 60, width: 800, height: 600 + i, radius: 8 })).toMatchObject(
        { ok: true },
      );
      expect(shield.getBounds()).toEqual(f.view.getBounds());
    }
    expect(f.view.visibility).not.toContain(false);
    expect(shield.visibility).not.toContain(false);
    expect(f.presentation).not.toContain(false);
    f.window.emit('hide');
    expect(f.view.getVisible()).toBe(false);
    expect(shield.getVisible()).toBe(false);
    expect(f.present({ x: 50, y: 60, width: 800, height: 600, radius: 8 })).toMatchObject({
      ok: true,
    });
    f.present(null);
    expect(f.view.getVisible()).toBe(false);
    expect(shield.getVisible()).toBe(false);
  } finally {
    f.close();
  }
});

test('capture rejects an in-flight viewport size change but accepts an equal-size position change', async () => {
  for (const changed of [true, false]) {
    const f = fixture();
    try {
      f.present({ x: 10, y: 20, width: 800, height: 600, radius: 8 });
      const entered = deferred<void>(),
        gate = deferred<void>();
      f.contents.screenshot = async () => {
        entered.resolve();
        await gate.promise;
        return image;
      };
      const pending = f.page.send('Page.captureScreenshot', {}).catch((error: Error) => error);
      await entered.promise;
      f.present({ x: 20, y: 30, width: changed ? 801 : 800, height: 600, radius: 8 });
      gate.resolve();
      const result = await pending;
      if (changed) {
        expect(result).toEqual(Error('browser_page_read_stale'));
        expect(f.page.captureMeta()).toEqual({ metadata: null, navigation: 0 });
      } else expect(result).toHaveProperty('data');
    } finally {
      f.close();
    }
  }
});

test('a resized viewport invalidates published proof while movement preserves it and shield loss still hides', async () => {
  const f = fixture();
  try {
    f.state.phase = 'acquiring';
    await f.page.attach();
    f.state.phase = 'agent';
    f.present({ x: 10, y: 20, width: 800, height: 600, radius: 8 });
    await f.page.send('Page.captureScreenshot', {});
    const proof = f.page.captureMeta();
    f.present({ x: 30, y: 40, width: 800, height: 600, radius: 8 });
    expect(f.page.captureMeta()).toEqual(proof);
    f.present({ x: 30, y: 40, width: 800, height: 601, radius: 8 });
    expect(f.page.captureMeta()).toEqual({ metadata: null, navigation: 0 });
    views.at(-1)!.webContents.destroyed = true;
    f.window.emit('resize');
    expect(f.view.getVisible()).toBe(false);
    expect(views.at(-1)!.getVisible()).toBe(false);
  } finally {
    f.close();
  }
});

test('raw screenshot pixels must match the CSS metrics and DPR rather than stretch an obsolete viewport', async () => {
  const f = fixture();
  try {
    f.contents.screenshot = async () => ({
      data: Buffer.from(JSON.stringify({ width: 1700, height: 1200 })).toString('base64'),
    });
    await expect(f.page.send('Page.captureScreenshot', {})).rejects.toThrow(
      'browser_page_read_stale',
    );
    expect(f.page.captureMeta()).toEqual({ metadata: null, navigation: 0 });
  } finally {
    f.close();
  }
});

test('screenshot never sends a visible-page clip and bounds DPR pixels only after capture', async () => {
  const f = fixture();
  try {
    let params: Record<string, unknown> | undefined;
    f.contents.screenshot = async (input) => {
      params = input;
      return image;
    };
    const result = (await f.page.send('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 35,
      clip: { x: 10, y: 20, width: 30, height: 40, scale: 0.5 },
      captureBeyondViewport: true,
      fromSurface: false,
    })) as { data: string };
    expect(params).toEqual({
      format: 'png',
      captureBeyondViewport: false,
      fromSurface: true,
    });
    expect(JSON.parse(Buffer.from(result.data, 'base64').toString())).toEqual({
      width: 800,
      height: 600,
      format: 'jpeg',
      quality: 35,
    });
    expect(f.page.captureMeta()).toMatchObject({
      metadata: {
        sha256: createHash('sha256').update(Buffer.from(result.data, 'base64')).digest('hex'),
        navigation: 0,
        width: 800,
        height: 600,
        imageWidth: 800,
        imageHeight: 600,
      },
      navigation: 0,
    });
    const proof = f.page.captureMeta() as { metadata: { captureId: string } };
    expect(proof.metadata.captureId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await f.page.validateCapture!(proof.metadata.captureId)).toBe(true);
    f.contents.readMetrics = async () => ({ ...metrics, y: metrics.y + 1 });
    expect(await f.page.validateCapture!(proof.metadata.captureId)).toBe(false);
    f.state.phase = 'revoking';
    expect(f.page.captureMeta()).toEqual({ metadata: null, navigation: 0 });
  } finally {
    f.close();
  }
});

test('large viewports are bounded on CPU while default PNG and JPEG quality remain exact', async () => {
  const f = fixture();
  try {
    f.contents.readMetrics = async () => ({ ...metrics, width: 4000, height: 3000 });
    f.contents.screenshot = async (params) => {
      expect(params).not.toHaveProperty('clip');
      return {
        data: Buffer.from(JSON.stringify({ width: 8000, height: 6000 })).toString('base64'),
      };
    };
    for (const [params, expected] of [
      [{}, { format: 'png' }],
      [
        { format: 'jpeg', quality: 73 },
        { format: 'jpeg', quality: 73 },
      ],
    ] as const) {
      const result = (await f.page.send('Page.captureScreenshot', params)) as { data: string };
      expect(JSON.parse(Buffer.from(result.data, 'base64').toString())).toEqual({
        width: 1440,
        height: 1080,
        ...expected,
      });
      expect(f.page.captureMeta()).toMatchObject({ metadata: { width: 4000, height: 3000 } });
    }
  } finally {
    f.close();
  }
});

test('DPR never becomes a visible capture scale and unsupported image input cannot publish proof', async () => {
  const f = fixture();
  try {
    for (const dpr of [1, 2, 3]) {
      f.contents.readMetrics = async () => ({ ...metrics, dpr });
      f.contents.screenshot = async (params) => {
        expect(params).toEqual({ format: 'png', fromSurface: true, captureBeyondViewport: false });
        return {
          data: Buffer.from(JSON.stringify({ width: 800 * dpr, height: 600 * dpr })).toString(
            'base64',
          ),
        };
      };
      const result = (await f.page.send('Page.captureScreenshot', { format: 'jpeg' })) as {
        data: string;
      };
      expect(JSON.parse(Buffer.from(result.data, 'base64').toString())).toEqual({
        width: 800,
        height: 600,
        format: 'jpeg',
        quality: 80,
      });
    }
    let dispatched = false;
    f.contents.screenshot = async () => {
      dispatched = true;
      return image;
    };
    await expect(f.page.send('Page.captureScreenshot', { format: 'invalid' })).rejects.toThrow(
      'browser_capture_format_invalid',
    );
    expect(dispatched).toBe(false);
    f.contents.screenshot = async () => ({
      data: Buffer.from('{"width":0,"height":0}').toString('base64'),
    });
    await expect(f.page.send('Page.captureScreenshot', {})).rejects.toThrow(
      'browser_capture_image_invalid',
    );
    expect(f.page.captureMeta()).toEqual({ metadata: null, navigation: 0 });
  } finally {
    f.close();
  }
});

for (const boundary of ['metrics', 'screenshot'] as const)
  for (const change of ['navigation', 'revoking', 'human', 'unknown', 'incarnation'] as const)
    test(`${boundary} in flight rejects a late capture after ${change}`, async () => {
      const f = fixture();
      try {
        const entered = deferred<void>();
        const gate = deferred<void>();
        let screenshots = 0;
        f.contents.readMetrics = async () => {
          if (boundary === 'metrics') {
            entered.resolve();
            await gate.promise;
          }
          return metrics;
        };
        f.contents.screenshot = async () => {
          screenshots++;
          if (boundary === 'screenshot') {
            entered.resolve();
            await gate.promise;
          }
          return image;
        };
        const capture = f.page.send('Page.captureScreenshot', {}).catch((error: Error) => error);
        await entered.promise;
        if (change === 'navigation') ++f.state.navigation;
        else if (change === 'incarnation') f.state.incarnation = 'replacement';
        else f.state.phase = change;
        gate.resolve();
        expect(await capture).toEqual(Error('browser_page_read_stale'));
        expect(screenshots).toBe(boundary === 'metrics' ? 0 : 1);
        expect(f.page.captureMeta()).toEqual({ metadata: null, navigation: f.state.navigation });
      } finally {
        f.close();
      }
    });

test('an older completion cannot overwrite metadata published by a newer capture', async () => {
  const f = fixture();
  try {
    const entered = deferred<void>();
    const gate = deferred<void>();
    let reads = 0;
    f.contents.screenshot = async () => {
      if (++reads === 1) {
        entered.resolve();
        await gate.promise;
        return { data: Buffer.from('old').toString('base64') };
      }
      return image;
    };
    const old = f.page.send('Page.captureScreenshot', {}).catch((error: Error) => error);
    await entered.promise;
    await f.page.send('Page.captureScreenshot', {});
    const newerMetadata = f.page.captureMeta();
    gate.resolve();
    expect(await old).toEqual(Error('browser_page_read_stale'));
    expect(f.page.captureMeta()).toEqual(newerMetadata);
  } finally {
    f.close();
  }
});

test('a handoff and reacquisition cannot revive an old capture even with identical public state', async () => {
  const f = fixture();
  try {
    const entered = deferred<void>();
    const gate = deferred<void>();
    f.contents.screenshot = async () => {
      entered.resolve();
      await gate.promise;
      return image;
    };
    const old = f.page.send('Page.captureScreenshot', {}).catch((error: Error) => error);
    await entered.promise;
    expect(await f.page.detach()).toBe(true);
    f.state.phase = 'acquiring';
    await f.page.attach();
    f.state.phase = 'agent';
    gate.resolve();
    expect(await old).toEqual(Error('browser_page_read_stale'));
    expect(f.page.captureMeta()).toEqual({ metadata: null, navigation: 0 });
  } finally {
    f.close();
  }
});

test('invalid viewport data never dispatches a screenshot or publishes metadata', async () => {
  const f = fixture();
  try {
    let screenshots = 0;
    f.contents.screenshot = async () => {
      screenshots++;
      return image;
    };
    for (const invalid of [null, { ...metrics, dpr: 0 }, { ...metrics, width: Number.NaN }]) {
      f.contents.readMetrics = async () => invalid;
      await expect(f.page.send('Page.captureScreenshot', {})).rejects.toThrow('metrics_invalid');
    }
    expect(screenshots).toBe(0);
    expect(f.page.captureMeta()).toEqual({ metadata: null, navigation: 0 });
  } finally {
    f.close();
  }
});

test('handoff clears the agent decoration queued behind a failed old painting', async () => {
  const f = fixture();
  try {
    const entered = deferred<void>();
    const gate = deferred<void>();
    const painted: boolean[] = [];
    let attempts = 0;
    f.contents.paintWorld = async (scripts) => {
      if (++attempts === 2) {
        entered.resolve();
        await gate.promise;
      }
      painted.push(scripts[0]!.code.includes('"agent":true'));
    };
    const decoration = { agent: true, visible: true, navigation: 0, cursor: null };
    f.page.decorate(decoration);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(painted).toEqual([true]);
    f.page.decorate(decoration);
    await entered.promise;
    f.page.decorate({ ...decoration, agent: false });
    gate.reject(Error('old_paint_context_destroyed'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(attempts).toBe(3);
    expect(painted).toEqual([true, false]);
  } finally {
    f.close();
  }
});

test('a failed painting without a newer update never retries itself', async () => {
  const f = fixture();
  try {
    let attempts = 0;
    f.contents.paintWorld = async () => {
      ++attempts;
      throw Error('permanent_paint_failure');
    };
    f.page.decorate({ agent: true, visible: true, navigation: 0, cursor: null });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(attempts).toBe(1);
    f.page.decorate({ agent: false, visible: true, navigation: 0, cursor: null });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(attempts).toBe(2);
  } finally {
    f.close();
  }
});

test('presentation capture is visible-only and guarded by exact Main scope, navigation, size and scroll before hide', async () => {
  const f = fixture();
  f.state.phase = 'human';
  delete (f.state as { browserId?: string }).browserId; // ordinary human page, no automation binding
  const bounds = { x: 10, y: 100, width: 800, height: 600, radius: 0 };
  const capture = () =>
    f.invoke({ action: 'capturePresentation', id: 'page' }) as Promise<{
      ok: boolean;
      value?: NativeBrowserPresentationFrame;
    }>;
  const commit = (key: string) =>
    f.invoke({ action: 'present', id: 'page', bounds: null, presentationKey: key });
  try {
    expect(await capture()).toMatchObject({ ok: false });
    expect(f.contents.captureCalls).toBe(0);
    f.present(bounds);
    const first = await capture();
    expect(first).toMatchObject({
      ok: true,
      value: {
        id: 'page',
        scope: f.scope,
        cssWidth: 800,
        cssHeight: 600,
        frame: { mimeType: 'image/png', width: 1600, height: 1200 },
      },
    });
    expect(f.contents.captureCalls).toBe(1);
    f.scope.viewSelection++;
    expect(await commit(first.value!.key)).toMatchObject({ ok: false });
    expect(f.view.visible).toBe(true);
    f.present(bounds);
    const second = await capture();
    f.state.navigation++;
    expect(await commit(second.value!.key)).toMatchObject({ ok: false });
    f.present(bounds);
    const third = await capture();
    f.present({ ...bounds, width: 700 });
    expect(await commit(third.value!.key)).toMatchObject({ ok: false });
    f.present(bounds);
    const fourth = await capture();
    f.contents.readMetrics = async () => ({ ...metrics, y: 101 });
    expect(await commit(fourth.value!.key)).toMatchObject({ ok: false });
    expect(f.view.visible).toBe(true);
    const final = await capture();
    expect(await commit(final.value!.key)).toMatchObject({ ok: true });
    expect(f.view.visible).toBe(false);
    expect(await commit(final.value!.key)).toMatchObject({ ok: false });
  } finally {
    f.close();
  }
});

test('Root replacement never reveals an already hidden or explicitly closed page', () => {
  for (const boundary of ['hidden', 'closed'] as const) {
    const f = fixture();
    f.state.phase = 'human';
    try {
      expect(
        f.invoke({
          action: 'present',
          id: 'page',
          scope: { ...f.scope },
          presentationRevision: 1,
          bounds: { x: 10, y: 100, width: 800, height: 600, radius: 0 },
        }),
      ).toMatchObject({ ok: true });
      if (boundary === 'hidden') f.present(null);
      f.scope.generation++;
      f.scope.viewSelection++;
      f.owner.emit('did-start-navigation', {}, 'http://localhost/', false, true);
      if (boundary === 'closed')
        expect(f.invoke({ action: 'close', id: 'page' })).toMatchObject({ ok: true });
      const restored = f.invoke({ action: 'restore', scope: { ...f.scope } }) as {
        value: NativeBrowserRestoreResult;
      };
      expect(restored.value.reveal).toBeUndefined();
      expect(f.view.getVisible()).toBe(false);
      expect(f.contents.destroyed).toBe(boundary === 'closed');
      expect(f.contents.document.clicks).toBe(0);
    } finally {
      f.close();
    }
  }
});

test('Root replacement accepts a fresh low revision on the original document and fences old presentation and cleanup', async () => {
  for (const [replacement, transport] of [
    ['navigation', 'sync'],
    ['crash', 'sync'],
    ['navigation', 'async'],
    ['crash', 'async'],
  ] as const) {
    const f = fixture();
    f.state.phase = 'human';
    delete (f.state as { browserId?: string }).browserId;
    const originalContents = f.contents;
    const originalDocument = f.contents.document;
    originalDocument.value = 'HUMAN-UPDATED';
    const oldScope = { ...f.scope };
    const oldFrame = f.owner.mainFrame;
    const oldBounds = { x: 10, y: 100, width: 800, height: 600, radius: 0 };
    const bounds = { x: 801, y: 100, width: 799, height: 600, radius: 0 };
    const panel = (size: number) => ({
      size,
      min: 0,
      minUnit: 'px' as const,
      max: 100,
      maxUnit: '%' as const,
      preserve: 'relative' as const,
      collapsible: false,
    });
    const layout: NativeBrowserLayout = {
      windowWidth: 1600,
      windowHeight: 1200,
      insetLeft: 0,
      insetRight: 0,
      groups: [{ left: 0, right: 0, gap: 1, panels: [panel(800), panel(799)] }],
    };
    const fresh = () => ({
      action: 'present',
      id: 'page',
      bounds,
      layout,
      scope: { ...f.scope },
      presentationRevision: 1,
    });
    try {
      expect(
        f.invoke({
          action: 'present',
          id: 'page',
          bounds: oldBounds,
          scope: oldScope,
          presentationRevision: 40,
        }),
      ).toMatchObject({ ok: true });
      const image = (await f.invoke({ action: 'capturePresentation', id: 'page' })) as {
        ok: boolean;
        value: NativeBrowserPresentationFrame;
      };
      expect(image.ok).toBe(true);
      const loads = originalContents.loads;
      // Production Caller.detach advances this same trusted generation before
      // Native Browser handles the Root navigation/crash lifecycle event.
      f.scope.generation++;
      f.scope.viewSelection++;
      if (replacement === 'navigation')
        f.owner.emit('did-start-navigation', {}, 'http://localhost/', false, true);
      else f.owner.emit('render-process-gone');
      f.owner.mainFrame = { url: oldFrame.url };
      expect(f.view.getVisible()).toBe(false);
      expect(f.contents.destroyed).toBe(false);
      expect(f.invoke({ action: 'restore', scope: { ...f.scope } })).toMatchObject({
        ok: true,
        value: { reveal: true, activeId: 'page' },
      });
      // Re-reading fresh scope before the new layout commits cannot lose the intent.
      expect(f.invoke({ action: 'restore', scope: { ...f.scope } })).toMatchObject({
        value: { reveal: true },
      });
      expect(await (transport === 'sync' ? f.sync(fresh()) : f.invoke(fresh()))).toMatchObject({
        ok: true,
      });
      expect(f.view.getVisible()).toBe(true);
      expect(
        (
          f.invoke({ action: 'restore', scope: { ...f.scope } }) as {
            value: NativeBrowserRestoreResult;
          }
        ).value.reveal,
      ).toBeUndefined();
      expect(f.view.getBounds()).toEqual({ x: 801, y: 100, width: 799, height: 600 });
      for (const stale of [
        { ...fresh(), scope: oldScope, presentationRevision: 1000 },
        {
          action: 'present',
          id: 'page',
          bounds: null,
          scope: oldScope,
          presentationRevision: 1000,
        },
        { action: 'present', id: 'page', bounds: null, presentationRevision: 1000 },
      ]) {
        expect(f.invoke(stale)).toMatchObject({ ok: false });
        expect(f.view.getVisible()).toBe(true);
        expect(f.view.getBounds()).toEqual({ x: 801, y: 100, width: 799, height: 600 });
      }
      expect(f.sync({ ...fresh(), scope: oldScope, presentationRevision: 1000 })).toMatchObject({
        ok: false,
      });
      expect(f.invokeFromFrame(fresh(), oldFrame)).toMatchObject({ ok: false });
      expect(
        await f.invoke({
          action: 'present',
          id: 'page',
          bounds: null,
          presentationKey: image.value.key,
        }),
      ).toMatchObject({ ok: false });
      expect(f.view.getVisible()).toBe(true);
      expect(f.contents).toBe(originalContents);
      expect(f.contents.document).toBe(originalDocument);
      expect(f.contents.document).toEqual({ value: 'HUMAN-UPDATED', clicks: 0 });
      expect(f.contents.loads).toBe(loads);
      const currentScope = { ...f.scope };
      f.scope.sessionId = 'other-session';
      f.scope.viewSelection++;
      expect(
        f.invoke({
          action: 'present',
          id: 'page',
          bounds: null,
          scope: currentScope,
          presentationRevision: 1,
        }),
      ).toMatchObject({ ok: true });
      expect(f.view.getVisible()).toBe(false);
      expect(f.contents.destroyed).toBe(false);
    } finally {
      f.close();
    }
  }
});

test('a hung presentation read times out without blocking controls or starting a second capture and its late image cannot commit', async () => {
  const f = fixture();
  f.state.phase = 'human';
  const read = deferred<{ toPNG(): Buffer }>();
  try {
    f.present({ x: 10, y: 100, width: 800, height: 600, radius: 0 });
    f.contents.captureVisible = () => read.promise;
    const start = Date.now();
    expect(await f.invoke({ action: 'capturePresentation', id: 'page' })).toMatchObject({
      ok: false,
    });
    expect(Date.now() - start).toBeLessThan(500);
    expect(f.contents.captureCalls).toBe(1);
    expect(await f.invoke({ action: 'capturePresentation', id: 'page' })).toMatchObject({
      ok: false,
    });
    expect(f.contents.captureCalls).toBe(1);
    expect(f.invoke({ action: 'present', id: 'page', bounds: null })).toMatchObject({ ok: true });
    expect(f.view.visible).toBe(false);
    read.resolve({ toPNG: () => Buffer.alloc(24) });
    await Bun.sleep(5);
    expect(f.view.visible).toBe(false);
    expect(f.contents.captureCalls).toBe(1);
  } finally {
    f.close();
  }
});

test('presentation pixels resolving after a changed Main selection or scroll are discarded', async () => {
  for (const change of ['scope', 'scroll', 'navigation', 'resize', 'zoom'] as const) {
    const f = fixture();
    f.state.phase = 'human';
    const read = deferred<{ toPNG(): Buffer }>();
    try {
      f.present({ x: 10, y: 100, width: 800, height: 600, radius: 0 });
      f.contents.captureVisible = () => read.promise;
      const capture = f.invoke({ action: 'capturePresentation', id: 'page' });
      await Bun.sleep(1);
      if (change === 'scope') f.scope.generation++;
      else if (change === 'scroll') f.contents.readMetrics = async () => ({ ...metrics, x: 200 });
      else if (change === 'navigation') f.state.navigation++;
      else if (change === 'resize')
        f.present({ x: 10, y: 100, width: 700, height: 600, radius: 0 });
      else f.owner.zoom = 1.25;
      read.resolve({ toPNG: () => Buffer.alloc(24) });
      expect(await capture).toMatchObject({ ok: false });
      expect(f.view.visible).toBe(true);
    } finally {
      f.close();
    }
  }
});

test('native menu stays over the same page and returns only an enabled current action', async () => {
  const f = fixture();
  try {
    f.state.phase = 'human';
    f.present({ x: 50, y: 60, width: 800, height: 600, radius: 8 });
    const request: NativeBrowserMenuRequest = {
      requestId: 'menu-current',
      id: 'page',
      scope: { ...f.scope },
      incarnation: 'incarnation',
      navigation: 0,
      x: 850,
      y: 60,
      details: ['Preserved manual reason', 'Preserved error detail'],
      items: [
        { action: 'handoff', enabled: true },
        { action: 'close', enabled: false },
      ],
    };
    const original = f.view.getBounds(),
      captures = f.contents.captureCalls;
    const response = f.menu(request);
    expect(popupTemplate.map((row) => row.label).filter(Boolean)).toEqual([
      'Preserved manual reason',
      'Preserved error detail',
      '暂停并接管',
      '停止浏览器任务',
    ]);
    expect(f.view.getVisible()).toBe(true);
    expect(f.view.getBounds()).toEqual(original);
    expect(f.contents.captureCalls).toBe(captures);
    popupTemplate.find((row) => row.label === '暂停并接管')!.click!(
      {} as Electron.MenuItem,
      f.window,
      {} as Electron.KeyboardEvent,
    );
    popupOptions!.callback!();
    expect(await response).toBe('handoff');
    const old = f.menu({ ...request, requestId: 'menu-old' });
    f.scope.viewSelection++;
    popupTemplate.find((row) => row.label === '暂停并接管')!.click!(
      {} as Electron.MenuItem,
      f.window,
      {} as Electron.KeyboardEvent,
    );
    popupOptions!.callback!();
    expect(await old).toBeNull();
    f.scope.viewSelection--;
    const cancelled = f.menu({ ...request, requestId: 'menu-cancel' });
    const closed = popupCloses;
    f.cancelMenu('menu-cancel');
    expect(popupCloses).toBe(closed + 1);
    expect(await cancelled).toBeNull();
    expect(f.view.getVisible()).toBe(true);
    expect(f.contents.captureCalls).toBe(captures);
  } finally {
    f.close();
  }
});

test('cancelled native popup waits for its real asynchronous close callback and cannot act or reopen during resize', async () => {
  const f = fixture();
  deferPopupClose = true;
  try {
    f.state.phase = 'human';
    f.present({ x: 50, y: 60, width: 800, height: 600, radius: 8 });
    const request: NativeBrowserMenuRequest = {
      requestId: 'async-menu',
      id: 'page',
      scope: { ...f.scope },
      incarnation: 'incarnation',
      navigation: 0,
      x: 850,
      y: 60,
      details: [],
      items: [{ action: 'close', enabled: true }],
    };
    const response = f.menu(request);
    let settled = false;
    void Promise.resolve(response).then(() => {
      settled = true;
    });
    const oldOptions = popupOptions!,
      oldClick = popupTemplate[0]!.click!,
      before = popupCloses;
    oldClick({} as Electron.MenuItem, f.window, {} as Electron.KeyboardEvent);
    f.window.emit('resize');
    f.window.emit('resize');
    f.cancelMenu(request.requestId);
    expect(popupCloses).toBe(before + 1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    oldClick({} as Electron.MenuItem, f.window, {} as Electron.KeyboardEvent);
    expect(await f.menu({ ...request, requestId: 'must-not-reopen' })).toBeNull();
    expect(popupOptions).toBe(oldOptions);
    expect(pendingPopupCloses).toHaveLength(1);
    pendingPopupCloses.shift()!();
    expect(await response).toBeNull();
    expect(settled).toBe(true);
    const next = f.menu({ ...request, requestId: 'next-explicit-menu' });
    let nextSettled = false;
    void Promise.resolve(next).then(() => {
      nextSettled = true;
    });
    expect(popupOptions).not.toBe(oldOptions);
    oldOptions.callback!(); // a duplicate old callback cannot close the new owner
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(nextSettled).toBe(false);
    popupTemplate[0]!.click!({} as Electron.MenuItem, f.window, {} as Electron.KeyboardEvent);
    popupOptions!.callback!();
    expect(await next).toBe('close');
    expect(f.view.getVisible()).toBe(true);
  } finally {
    deferPopupClose = false;
    for (const close of pendingPopupCloses.splice(0)) close();
    f.close();
  }
});

test('Main routes only the pending native popup Escape sequence and restores ordinary input after keyup', async () => {
  const f = fixture();
  try {
    f.state.phase = 'human';
    f.present({ x: 50, y: 60, width: 800, height: 600, radius: 8 });
    const request: NativeBrowserMenuRequest = {
      requestId: 'escape-menu',
      id: 'page',
      scope: { ...f.scope },
      incarnation: 'incarnation',
      navigation: 0,
      x: 850,
      y: 60,
      details: [],
      items: [{ action: 'close', enabled: true }],
    };
    const input = (type: string, target = f.owner, key = 'Escape') => {
      let prevented = false;
      target.emit(
        'before-input-event',
        {
          preventDefault() {
            prevented = true;
          },
        },
        { type, key },
      );
      return prevented;
    };
    const result = f.menu(request),
      before = popupCloses;
    expect(input('keyDown', f.owner, 'a')).toBe(false);
    expect(input('keyDown')).toBe(true);
    expect(popupCloses).toBe(before + 1);
    expect(await result).toBeNull();
    expect(f.view.getVisible()).toBe(true);
    expect(input('keyDown')).toBe(true); // same held press/repeat
    expect(input('keyUp')).toBe(true);
    expect(input('keyDown')).toBe(false); // new ordinary Escape
    expect(input('keyUp')).toBe(false);
    const pointer = f.menu({ ...request, requestId: 'pointer-dismiss' });
    popupOptions!.callback!();
    expect(await pointer).toBeNull();
    expect(input('keyDown')).toBe(false);
    const scope = f.menu({ ...request, requestId: 'scope-dismiss' });
    f.scope.viewSelection++;
    expect(input('keyDown')).toBe(false);
    expect(await scope).toBeNull();
    f.scope.viewSelection--;
    const page = f.menu({ ...request, requestId: 'page-input' });
    expect(input('keyDown', f.contents)).toBe(true);
    expect(await page).toBeNull();
    expect(input('keyUp', f.contents)).toBe(true);
    expect(input('keyDown', f.contents)).toBe(false);
  } finally {
    f.close();
  }
});

function drawRequest(f: ReturnType<typeof fixture>, width: number, left: number, key: string) {
  const panel = (size: number) => ({
    size,
    min: 0,
    minUnit: 'px' as const,
    max: 100,
    maxUnit: '%' as const,
    preserve: 'relative' as const,
    collapsible: false,
  });
  return {
    action: 'present' as const,
    id: 'page',
    scope: { ...f.scope },
    presentationRevision: 1,
    bounds: { x: left + 1, y: 100, width: width - left - 1, height: 600, radius: 0 },
    layout: {
      windowWidth: width,
      windowHeight: f.contentSize[1]!,
      insetLeft: 0,
      insetRight: 0,
      groups: [
        { left: 0, right: 0, gap: 1, panels: [panel(left), panel(width - left - 1)] as const },
      ],
    },
    witness: { key, step: 1 as const },
  };
}
function rootDraw(
  request: Extract<NativeBrowserRequest, { action: 'present' }>,
  key = request.witness!.key,
  transform: (color: number[], tile: number) => number[] = (color) => color,
  scale = 1,
) {
  const width = Math.round(request.layout!.windowWidth * scale),
    height = Math.round(request.layout!.windowHeight * scale);
  const bytes = Buffer.alloc(width * height * 4);
  const points = nativeBrowserWitnessSamplePoints(request.bounds!, scale);
  nativeBrowserWitnessColors({ ...request.witness!, key }).forEach((source, tile) => {
    const color = transform(source, tile);
    const { x, y } = points[tile]!;
    const offset = (y * width + x) * 4;
    bytes[offset] = color[2]!;
    bytes[offset + 1] = color[1]!;
    bytes[offset + 2] = color[0]!;
    bytes[offset + 3] = 255;
  });
  return {
    getSize: () => ({ width, height }),
    toBitmap: () => bytes,
  } as unknown as Electron.NativeImage;
}

if (process.platform === 'darwin')
  test('native-owned resize fences old input then batches live layout after the native callback', async () => {
    const f = fixture(true);
    f.state.phase = 'human';
    const chrome = nativeChrome!;
    chrome.ready = true;
    try {
      expect(chrome.pageScope()).toEqual({ storeId: 'store', sessionId: 'session' });
      const initial = drawRequest(f, 1600, 800, '00112233445566778899aabb');
      expect(f.sync(initial)).toMatchObject({ ok: true, waiting: false });
      expect(f.view.getVisible()).toBe(true);
      expect(f.owner.frame).toBeUndefined();
      f.state.phase = 'agent';
      const loadCount = f.contents.loads;
      const visibilityStart = f.view.visibility.length;
      const releasesStart = chrome.releases.length;
      for (const width of [1500, 1200, 820, 1000, 1600]) {
        const prior = f.view.getBounds();
        f.contents.readMetrics = async () => ({ ...metrics, ...prior });
        f.contents.screenshot = async () => ({
          data: Buffer.from(
            JSON.stringify({ width: prior.width * 2, height: prior.height * 2 }),
          ).toString('base64'),
        });
        await f.page.send('Page.captureScreenshot', {});
        const proof = f.page.captureMeta() as { metadata: { captureId: string } };
        expect(proof.metadata).not.toBeNull();
        expect(await f.page.validateCapture!(proof.metadata.captureId)).toBe(true);
        f.contentSize[0] = width;
        const invalidations = chrome.invalidations;
        // No Root resize measurement or paint has run at this point.
        f.window.emit('resize');
        expect(chrome.invalidations).toBe(invalidations + 1);
        expect(f.view.getBounds()).toEqual(prior);
        expect(f.view.getVisible()).toBe(true);
        expect(f.page.captureMeta()).toMatchObject({ metadata: null });
        expect(await f.page.validateCapture!(proof.metadata.captureId)).toBe(false);
        expect(f.view.getBounds()).toEqual(prior);
        await new Promise<void>((resolve) => setImmediate(resolve));
        const projected = projectNativeBrowserBounds(initial.bounds, initial.layout, width, 1200)!;
        expect(f.view.getBounds()).toEqual({
          x: Math.ceil(projected.x),
          y: 100,
          width: Math.floor(projected.x + projected.width) - Math.ceil(projected.x),
          height: 600,
        });
        expect(chrome.layouts.at(-1)).toEqual({ id: 'page', bounds: f.view.getBounds() });
        expect(f.view.getVisible()).toBe(true);
        expect(f.owner.frame).toBeUndefined();
      }
      expect(f.view.visibility.slice(visibilityStart).every(Boolean)).toBe(true);
      expect(chrome.releases).toHaveLength(releasesStart);
      expect(f.contents.loads).toBe(loadCount);
      expect(f.page.alive()).toBe(true);
      // Fresh Renderer proposals stay live, but stale scope is still denied.
      const next = drawRequest(f, 1600, 900, 'ffeeddccbbaa998877665544');
      expect(f.sync(next)).toMatchObject({ ok: true, waiting: false });
      expect(f.sync({ ...initial, witness: { ...initial.witness, step: 2 } })).toMatchObject({
        ok: false,
      });
      expect(f.view.getBounds().x).toBe(901);
      expect(f.sync({ ...next, witness: { ...next.witness, step: 2 } })).toMatchObject({
        ok: true,
        waiting: false,
      });
      expect(f.sync({ ...next, scope: { ...next.scope, viewSelection: 99 } })).toMatchObject({
        ok: false,
      });
      expect(f.view.getBounds().x).toBe(901);
      expect(f.view.getVisible()).toBe(true);
      f.present(null);
      expect(chrome.releases.at(-1)).toBe('page');
      expect(f.view.getVisible()).toBe(false);
      // A late batch cannot revive a page hidden before it gets to execute.
      f.present(initial.bounds, initial.layout);
      f.window.emit('resize');
      f.present(null);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.view.getVisible()).toBe(false);
    } finally {
      f.close();
    }
  });

if (process.platform === 'darwin') {
  test('sync calibration and its queued native resize share one output while a different calibration still commits', async () => {
    const f = fixture(true);
    const chrome = nativeChrome!;
    chrome.ready = true;
    try {
      f.state.phase = 'acquiring';
      await f.page.attach();
      f.state.phase = 'agent';
      const shield = views.at(-1)!;
      // Exact 50%/55% allocations after the 1px separator avoid exercising
      // the existing Panel percentage rounding in this output-dedup regression.
      f.contentSize[0] = 1601;
      const initial = drawRequest(f, 1601, 800, '00112233445566778899aabb');
      initial.bounds.radius = 8;
      expect(f.sync(initial)).toMatchObject({ ok: true, waiting: false });
      await new Promise<void>((resolve) => setImmediate(resolve));
      for (const view of [f.view, shield]) {
        view.boundsWrites.length = 0;
        view.radiusWrites.length = 0;
        view.visibility.length = 0;
      }
      const writes = () =>
        [f.view, shield].map((view) => ({
          bounds: view.boundsWrites.length,
          radius: view.radiusWrites.length,
          visibility: view.visibility.length,
        }));
      f.contentSize[0] = 1201;
      f.window.emit('resize');
      expect(f.view.getBounds()).toEqual({ x: 801, y: 100, width: 800, height: 600 });
      expect(writes().every((value) => value.bounds === 0)).toBe(true);
      const measured = drawRequest(f, 1201, 600, 'ffeeddccbbaa998877665544');
      measured.bounds.radius = 8;
      // The same effect revision can calibrate more than one size.
      expect(measured.presentationRevision).toBe(initial.presentationRevision);
      expect(f.sync(measured)).toMatchObject({ ok: true, waiting: false });
      expect(f.view.getBounds()).toEqual({ x: 601, y: 100, width: 600, height: 600 });
      expect(shield.getBounds()).toEqual(f.view.getBounds());
      expect(writes()).toEqual([
        { bounds: 1, radius: 0, visibility: 0 },
        { bounds: 1, radius: 0, visibility: 0 },
      ]);
      const afterSync = writes();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(writes()).toEqual(afterSync);
      expect(f.sync(measured)).toMatchObject({ ok: true, waiting: false });
      expect(writes()).toEqual(afterSync);

      const calibrated = drawRequest(f, 1201, 660, '8899aabbccddeeff00112233');
      calibrated.bounds.radius = 8;
      expect(f.sync(calibrated)).toMatchObject({ ok: true, waiting: false });
      expect(f.view.getBounds()).toEqual({ x: 661, y: 100, width: 540, height: 600 });
      expect(shield.getBounds()).toEqual(f.view.getBounds());
      expect(writes().map((value) => value.bounds)).toEqual([2, 2]);
      const afterCalibration = writes();
      const newOwner = { ...calibrated, presentationRevision: 2 };
      expect(f.sync(newOwner)).toMatchObject({ ok: true, waiting: false });
      expect(writes()).toEqual(afterCalibration);
      expect(
        f.invoke({
          action: 'present',
          id: 'page',
          bounds: null,
          scope: { ...f.scope },
          presentationRevision: 1,
        }),
      ).toMatchObject({ ok: false });
      expect(f.sync({ ...newOwner, witness: { ...newOwner.witness, step: 2 } })).toMatchObject({
        ok: true,
        waiting: false,
      });
      expect(writes()).toEqual(afterCalibration);
      expect(f.view.getVisible()).toBe(true);
      expect(shield.getVisible()).toBe(true);
    } finally {
      f.close();
    }
  });

  test('queued native resize cannot replay obsolete geometry after hide, close or selection replacement', async () => {
    for (const boundary of ['hide', 'close', 'selection'] as const) {
      const f = fixture(true);
      const chrome = nativeChrome!;
      chrome.ready = true;
      f.state.phase = 'human';
      try {
        const initial = drawRequest(f, 1600, 800, '00112233445566778899aabb');
        expect(f.sync(initial)).toMatchObject({ ok: true, waiting: false });
        await new Promise<void>((resolve) => setImmediate(resolve));
        f.contentSize[0] = 1200;
        const invalidations = chrome.invalidations;
        f.window.emit('resize');
        expect(chrome.invalidations).toBe(invalidations + 1);
        if (boundary === 'hide') expect(f.present(null)).toMatchObject({ ok: true });
        if (boundary === 'close')
          expect(f.invoke({ action: 'close', id: 'page' })).toMatchObject({ ok: true });
        if (boundary === 'selection') f.scope.viewSelection++;
        const bounds = f.view.getBounds();
        const boundsWrites = f.view.boundsWrites.length;
        const visibilityStart = f.view.visibility.length;
        const layouts = chrome.layouts.length;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(f.view.getBounds()).toEqual(bounds);
        expect(f.view.boundsWrites).toHaveLength(boundsWrites);
        expect(f.view.visibility.slice(visibilityStart)).not.toContain(true);
        expect(chrome.layouts).toHaveLength(layouts);
        if (boundary === 'hide') expect(f.view.getVisible()).toBe(false);
        expect(f.contents.destroyed).toBe(boundary === 'close');
        if (boundary === 'close') expect(f.window.contentView.children).not.toContain(f.view);
      } finally {
        f.close();
      }
    }
  });
}
test('same-frame grey calibration accepts nonidentity display curves and rejects collapsed levels, old nonces and the first step', () => {
  for (const scale of [0.25, 0.5, 1, 2]) {
    const f = fixture();
    f.state.phase = 'human';
    try {
      f.present({ x: 801, y: 100, width: 799, height: 600, radius: 0 });
      const first = drawRequest(f, 1600, 1000, '00112233445566778899aabb');
      expect(f.sync(first)).toMatchObject({ ok: true });
      const frames = () =>
        f.owner.sent.filter((message) => message.channel === nativeBrowserLayoutFrameChannel);
      f.owner.frame!(rootDraw(first, first.witness.key, () => [40, 40, 40], scale));
      expect(frames()).toHaveLength(0);
      const profile = (color: number[]) => {
        const value = color[0]! / 255;
        return [
          Math.round(15 + value ** 0.85 * 230),
          Math.round(10 + value ** 1.2 * 240),
          Math.round(8 + value ** 1.05 * 220),
        ];
      };
      f.owner.frame!(rootDraw(first, 'ffeeddccbbaa998877665544', profile, scale));
      expect(frames()).toHaveLength(0);
      f.owner.frame!(rootDraw(first, `${first.witness.key.slice(0, -1)}c`, profile, scale));
      expect(frames()).toHaveLength(0); // all 96 bits, including the last nibble
      f.owner.frame!(rootDraw(first, first.witness.key, profile, scale));
      expect(frames().at(-1)?.value).toMatchObject({ step: 1 });
      const second = { ...first, witness: { ...first.witness, step: 2 as const } };
      expect(f.sync(second)).toMatchObject({ ok: true });
      f.owner.frame!(rootDraw(first, first.witness.key, profile, scale));
      expect(frames()).toHaveLength(1);
      f.owner.frame!(rootDraw(second, second.witness.key, profile, scale));
      expect(frames().at(-1)?.value).toMatchObject({ step: 2 });
      expect(f.owner.frame).toBeUndefined();
      expect(f.view.getVisible()).toBe(true);
    } finally {
      f.close();
    }
  }
});
test('Root draw feedback gates complete bounds through two actual paints and rejects resized stale pixels', async () => {
  const f = fixture();
  f.state.phase = 'human';
  try {
    f.present({ x: 801, y: 100, width: 799, height: 600, radius: 0 });
    f.contentSize[0] = 1000;
    const first = drawRequest(f, 1000, 600, '00112233445566778899aabb');
    expect(f.sync(first)).toMatchObject({ ok: true, waiting: true });
    expect(f.view.getBounds()).toEqual({ x: 801, y: 100, width: 799, height: 600 });
    expect(f.view.getVisible()).toBe(false);
    f.owner.frame!(rootDraw(first, 'ffeeddccbbaa998877665544'));
    expect(f.owner.sent.filter((x) => x.channel === nativeBrowserLayoutFrameChannel)).toHaveLength(
      0,
    );
    f.owner.frame!(rootDraw(first));
    expect(f.owner.sent.at(-1)?.value).toMatchObject({ key: first.witness.key, step: 1 });
    expect(f.view.getBounds().x).toBe(801);
    const second = { ...first, witness: { ...first.witness, step: 2 as const } };
    expect(f.sync({ ...second, bounds: { ...first.bounds, y: 101 } })).toMatchObject({ ok: false });
    expect(f.sync(second)).toMatchObject({ ok: true, waiting: true });
    f.owner.frame!(rootDraw(first));
    expect(f.view.getBounds().x).toBe(801);
    f.owner.frame!(rootDraw(second));
    expect(f.view.getBounds()).toEqual({ x: 601, y: 100, width: 399, height: 600 });
    expect(f.owner.sent.at(-1)?.value).toMatchObject({ key: first.witness.key, step: 2 });
    expect(f.owner.frame).toBeUndefined();
    expect(f.contents.destroyed).toBe(false);
    expect(f.contents.loads).toBe(1);
  } finally {
    f.close();
  }
});

test('a new revision of the same completed presentation keeps Native visible while proving both new Root draws', () => {
  const f = fixture();
  f.state.phase = 'human';
  try {
    const first = drawRequest(f, 1600, 800, '00112233445566778899aabb');
    expect(f.sync(first)).toMatchObject({ ok: true, waiting: true });
    f.owner.frame!(rootDraw(first));
    const second = { ...first, witness: { ...first.witness, step: 2 as const } };
    expect(f.sync(second)).toMatchObject({ ok: true, waiting: true });
    f.owner.frame!(rootDraw(second));
    expect(f.view.getVisible()).toBe(true);
    const visible = f.view.visibility.length;
    const bounds = f.view.getBounds();
    const fresh = {
      ...first,
      presentationRevision: 2,
      witness: { key: 'aabbccddeeff001122334455', step: 1 as const },
    };
    expect(f.sync(fresh)).toMatchObject({ ok: true, waiting: true });
    expect(f.view.getVisible()).toBe(true);
    expect(f.view.getBounds()).toEqual(bounds);
    expect(f.view.visibility.slice(visible)).not.toContain(false);
    expect(
      f.invoke({
        action: 'present',
        id: 'page',
        bounds: null,
        scope: first.scope,
        presentationRevision: 1,
      }),
    ).toMatchObject({ ok: false });
    expect(f.view.getVisible()).toBe(true);
    f.owner.frame!(rootDraw(first));
    expect(f.owner.sent.at(-1)?.value).toMatchObject({ presentationRevision: 1, step: 2 });
    f.owner.frame!(rootDraw(fresh));
    expect(f.owner.sent.at(-1)?.value).toMatchObject({ presentationRevision: 2, step: 1 });
    const ready = { ...fresh, witness: { ...fresh.witness, step: 2 as const } };
    expect(f.sync(ready)).toMatchObject({ ok: true, waiting: true });
    f.owner.frame!(rootDraw(fresh));
    expect(f.owner.frame).toBeDefined();
    f.owner.frame!(rootDraw(ready));
    expect(f.owner.sent.at(-1)?.value).toMatchObject({ presentationRevision: 2, step: 2 });
    expect(f.view.visibility.slice(visible)).not.toContain(false);
    expect(f.view.getBounds()).toEqual(bounds);
    expect(f.contents.loads).toBe(1);
    expect(f.contents.captureCalls).toBe(0);
  } finally {
    f.close();
  }
});

test('a fixed-size Root reload retains only its fully drawn original page behind the Main input shield', async () => {
  const f = fixture();
  try {
    f.state.phase = 'acquiring';
    await f.page.attach();
    f.state.phase = 'human';
    const first = drawRequest(f, 1600, 800, '00112233445566778899aabb');
    f.sync(first);
    f.owner.frame!(rootDraw(first));
    const second = { ...first, witness: { ...first.witness, step: 2 as const } };
    f.sync(second);
    f.owner.frame!(rootDraw(second));
    const bounds = f.view.getBounds();
    expect(f.view.getVisible()).toBe(true);
    f.owner.emit('did-start-navigation', {}, 'http://localhost/', false, true);
    expect(f.view.getVisible()).toBe(true);
    expect(f.view.getBounds()).toEqual(bounds);
    expect(f.presentation.at(-1)).toBe(false);
    expect(f.contents.loads).toBe(1);
  } finally {
    f.close();
  }
});

async function retainedFixture() {
  const f = fixture();
  f.state.phase = 'acquiring';
  await f.page.attach();
  f.state.phase = 'human';
  const first = drawRequest(f, 1600, 800, '00112233445566778899aabb');
  f.sync(first);
  f.owner.frame!(rootDraw(first));
  const second = { ...first, witness: { ...first.witness, step: 2 as const } };
  f.sync(second);
  f.owner.frame!(rootDraw(second));
  f.owner.emit('did-start-navigation', {}, 'http://localhost/', false, true);
  const intent = f.display({
    action: 'get',
  }) as import('../../src/native-browser-bridge').NativeBrowserDisplayIntent;
  expect(intent?.id).toBe('page');
  return { ...f, intent };
}
test('an exact fresh Root unmount hide cancels its bootstrap and confirms the retired token', async () => {
  const f = await retainedFixture();
  try {
    f.scope.generation = 2;
    expect(
      f.invoke({
        action: 'present',
        id: 'page',
        bounds: null,
        scope: { ...f.scope },
        presentationRevision: 1,
      }),
    ).toMatchObject({ ok: true });
    expect(f.view.getVisible()).toBe(false);
    expect(
      f.owner.sent.some(
        (entry) =>
          entry.channel === 'kite:native:browser-display' &&
          (entry.value as { token?: string }).token === f.intent.token,
      ),
    ).toBe(true);
    expect(f.display({ action: 'cancel', token: f.intent.token })).toBe(true);
    expect(f.display({ action: 'get' })).toBeNull();
  } finally {
    f.close();
  }
});
test('Root bootstrap needs exact sender, a fresh complete scope and both new draws before releasing its shield', async () => {
  const f = await retainedFixture();
  try {
    expect(Object.keys(f.intent).sort()).toEqual([
      'bounds',
      'height',
      'id',
      'sessionId',
      'storeId',
      'token',
      'width',
      'zoom',
    ]);
    expect(f.display({ action: 'get' }, { url: 'http://localhost/' })).toBe(false);
    expect(f.view.getVisible()).toBe(true);
    const shield = views.find((view) =>
      String(view.options.webPreferences?.partition).startsWith('kite-browser-input-shield-'),
    )!;
    expect(shield.getVisible()).toBe(true);
    expect(shield.getBounds()).toEqual(f.view.getBounds());
    f.contents.emit('focus');
    expect(f.owner.focusCalls).toBeGreaterThan(0);
    expect(f.view.getVisible()).toBe(true);
    let prevented = false;
    f.owner.emit(
      'before-input-event',
      {
        preventDefault() {
          prevented = true;
        },
      },
      { type: 'keyDown', key: 'a' },
    );
    expect(prevented).toBe(true);
    expect(f.display({ action: 'ready', token: f.intent.token })).toBe(true);
    f.scope.generation = 2;
    f.scope.viewSelection = 2;
    const fresh = {
      ...drawRequest(f, 1600, 800, 'aabbccddeeff001122334455'),
      presentationRevision: 1,
    };
    expect(f.display({ action: 'claim', token: f.intent.token, request: fresh })).toBe(true);
    expect(f.sync(fresh)).toMatchObject({ ok: true, waiting: true });
    expect(f.view.getVisible()).toBe(true);
    expect(shield.getVisible()).toBe(true);
    f.owner.frame!(rootDraw(fresh));
    const ready = { ...fresh, witness: { ...fresh.witness, step: 2 as const } };
    expect(f.sync(ready)).toMatchObject({ ok: true, waiting: true });
    expect(shield.getVisible()).toBe(true);
    f.owner.frame!(rootDraw(ready));
    expect(f.view.getVisible()).toBe(true);
    expect(shield.getVisible()).toBe(false);
    expect(f.display({ action: 'get' })).toBeNull();
    expect(f.contents.loads).toBe(1);
  } finally {
    f.close();
  }
});
test('lost candidates confirm their exact already-hidden cancellation after get, ready or claim', async () => {
  for (const kind of [
    'close',
    'resize',
    'incarnation',
    'scope',
    'geometry',
    'not-ready',
    'shield-failure',
  ] as const) {
    const f = await retainedFixture();
    try {
      if (kind === 'close') f.invoke({ action: 'close', id: 'page' });
      if (kind === 'resize') {
        f.contentSize[0] = 1599;
        f.window.emit('resize');
      }
      if (kind === 'incarnation') f.state.incarnation = 'replacement';
      if (kind === 'shield-failure')
        views
          .find((view) =>
            String(view.options.webPreferences?.partition).startsWith('kite-browser-input-shield-'),
          )!
          .webContents.emit('render-process-gone');
      if (['close', 'resize', 'incarnation', 'shield-failure'].includes(kind))
        expect(f.display({ action: 'ready', token: f.intent.token })).toBe(false);
      else {
        if (kind !== 'not-ready')
          expect(f.display({ action: 'ready', token: f.intent.token })).toBe(true);
        f.scope.generation = 2;
        if (kind === 'scope') f.scope.sessionId = 'other';
        const fresh = drawRequest(
          f,
          1600,
          kind === 'geometry' ? 801 : 800,
          'aabbccddeeff001122334455',
        );
        expect(f.display({ action: 'claim', token: f.intent.token, request: fresh })).toBe(false);
      }
      expect(f.display({ action: 'cancel', token: f.intent.token })).toBe(true);
      expect(f.view.getVisible()).toBe(false);
      expect(f.display({ action: 'get' })).toBeNull();
    } finally {
      f.close();
    }
  }
});

test('new presentation revisions hide for changed geometry, scope, real viewport state or unfinished draws', () => {
  for (const kind of [
    'bounds',
    'layout',
    'scope',
    'generation',
    'size',
    'zoom',
    'actual-bounds',
    'hidden',
    'pending',
    'root-navigation',
    'root-crash',
    'foreign-view',
  ] as const) {
    const f = fixture();
    f.state.phase = 'human';
    try {
      const first = drawRequest(f, 1600, 800, '00112233445566778899aabb');
      f.sync(first);
      f.owner.frame!(rootDraw(first));
      const second = { ...first, witness: { ...first.witness, step: 2 as const } };
      f.sync(second);
      f.owner.frame!(rootDraw(second));
      expect(f.view.getVisible()).toBe(true);
      if (kind === 'scope') f.scope.viewSelection++;
      if (kind === 'generation') f.scope.generation++;
      if (kind === 'size') f.contentSize[0] = 1601;
      if (kind === 'zoom') f.owner.zoom = 1.0005;
      if (kind === 'actual-bounds') f.view.setBounds({ ...f.view.getBounds(), x: 802 });
      if (kind === 'hidden') f.view.setVisible(false);
      if (kind === 'root-navigation')
        f.owner.emit('did-start-navigation', {}, 'http://localhost/', false, true);
      if (kind === 'root-crash') f.owner.emit('render-process-gone');
      if (kind === 'foreign-view') windowOwners.delete(f.contents);
      const fresh = {
        ...drawRequest(f, 1600, kind === 'bounds' ? 801 : 800, 'aabbccddeeff001122334455'),
        presentationRevision: 2,
      };
      if (kind === 'layout') fresh.layout.groups[0]!.panels[0].min = 1;
      if (kind === 'pending') {
        expect(f.sync(fresh)).toMatchObject({ ok: true, waiting: true });
        expect(f.view.getVisible()).toBe(true);
        fresh.presentationRevision = 3;
        fresh.witness.key = 'ccddee001122334455667788';
      }
      expect(f.sync(fresh)).toMatchObject({ ok: true, waiting: true });
      expect(f.view.getVisible()).toBe(false);
      expect(f.contents.loads).toBe(1);
    } finally {
      f.close();
    }
  }
});

test('a failed Root subscription or frame read hides a retained live presentation', () => {
  for (const kind of ['subscribe', 'read'] as const) {
    const f = fixture();
    f.state.phase = 'human';
    try {
      const first = drawRequest(f, 1600, 800, '00112233445566778899aabb');
      f.sync(first);
      f.owner.frame!(rootDraw(first));
      const second = { ...first, witness: { ...first.witness, step: 2 as const } };
      f.sync(second);
      f.owner.frame!(rootDraw(second));
      expect(f.view.getVisible()).toBe(true);
      const fresh = {
        ...first,
        presentationRevision: 2,
        witness: { key: 'aabbccddeeff001122334455', step: 1 as const },
      };
      if (kind === 'subscribe') {
        f.owner.beginFrameSubscription = () => {
          throw Error('Root observation unavailable');
        };
        expect(f.sync(fresh)).toMatchObject({ ok: false });
      } else {
        expect(f.sync(fresh)).toMatchObject({ ok: true, waiting: true });
        f.owner.frame!(
          {
            getSize: () => {
              throw Error('Root frame unreadable');
            },
          } as unknown as Electron.NativeImage,
          { x: 0, y: 0, width: 1600, height: 1200 },
        );
      }
      expect(f.view.getVisible()).toBe(false);
      expect(f.owner.frame).toBeUndefined();
    } finally {
      f.close();
    }
  }
});
test('same-size splitter and repeated resize proposals retain the original viewport offscreen until the latest draw', () => {
  const f = fixture();
  f.state.phase = 'human';
  try {
    f.present({ x: 801, y: 100, width: 799, height: 600, radius: 0 });
    const first = drawRequest(f, 1600, 1000, '00112233445566778899aabb');
    expect(f.sync(first)).toMatchObject({ ok: true });
    expect(f.view.getBounds()).toEqual({ x: 801, y: 100, width: 799, height: 600 });
    expect(f.view.getVisible()).toBe(false);
    f.owner.frame!(rootDraw(first));
    const next = drawRequest(f, 1600, 600, 'aabbccddeeff001122334455');
    expect(f.sync(next)).toMatchObject({ ok: true });
    expect(f.view.getBounds().x).toBe(801);
    const stale = { ...first, witness: { ...first.witness, step: 2 as const } };
    expect(f.sync(stale)).toMatchObject({ ok: false });
    f.owner.frame!(rootDraw(stale));
    expect(f.view.getBounds().x).toBe(801);
    f.owner.frame!(rootDraw(next));
    const second = { ...next, witness: { ...next.witness, step: 2 as const } };
    expect(f.sync(second)).toMatchObject({ ok: true });
    f.owner.frame!(rootDraw(second));
    expect(f.view.getBounds().x).toBe(601);
  } finally {
    f.close();
  }
});
test('large resize uses the latest full presented frame and never shrinks the live viewport during handoff', async () => {
  const f = fixture();
  f.state.phase = 'human';
  try {
    f.contents.emit('did-stop-loading');
    const initial = drawRequest(f, 1600, 1100, '00112233445566778899aabb');
    expect(f.sync(initial)).toMatchObject({ ok: true });
    f.owner.frame!(rootDraw(initial));
    const ready = { ...initial, witness: { ...initial.witness, step: 2 as const } };
    expect(f.sync(ready)).toMatchObject({ ok: true });
    f.owner.frame!(rootDraw(ready));
    const size = f.view.getBounds();
    expect(f.contents.frameOnlyDirty).toBe(false);
    const frameImage = (value: number, width = size.width, height = size.height) => {
      const pixels = Buffer.alloc(25);
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(pixels);
      pixels.writeUInt32BE(width, 16);
      pixels.writeUInt32BE(height, 20);
      pixels[24] = value;
      return {
        getSize: () => ({ width, height }),
        toPNG: () => Buffer.from(pixels),
      } as Electron.NativeImage;
    };
    const pageDraw = f.contents.frame!;
    pageDraw(frameImage(1));
    const originalKey = (f.owner.sent.at(-1)!.value as { frozen: { key: string } }).frozen.key;
    // A later paint is coalesced and flushed before resize hides the live page.
    pageDraw(frameImage(2), { x: 5, y: 5, width: 20, height: 10 });
    pageDraw(frameImage(3), { x: 0, y: 0, width: 0, height: 0 });
    pageDraw(frameImage(4, 20, 10)); // cropped/old-size input is not a full frame
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      f.owner.sent.some(
        (x) =>
          x.channel === nativeBrowserLayoutFrameChannel &&
          (x.value as { step?: number }).step === 0,
      ),
    ).toBe(true);
    const sourceBounds = f.view.getBounds();
    const reads = f.contents.captureCalls;
    f.contentSize[0] = 820;
    const narrow = drawRequest(f, 820, 500, 'aabbccddeeff001122334455');
    const receipt = f.sync(narrow) as {
      ok: boolean;
      waiting: boolean;
      frozenKey?: string;
      frozen?: unknown;
      frozenWidth?: number;
      frozenHeight?: number;
    };
    expect(receipt).toMatchObject({ ok: true, waiting: true });
    expect(receipt.frozenKey).toMatch(/^[a-f0-9]{32}$/);
    expect(receipt.frozenKey).not.toBe(originalKey);
    const latest = (f.owner.sent.at(-1)!.value as { frozen: { data: string } }).frozen;
    expect(Buffer.from(latest.data, 'base64')[24]).toBe(2);
    expect(f.contents.frame).toBeUndefined();
    expect(f.view.getBounds()).toEqual(sourceBounds);
    const delivered = f.owner.sent.filter(
      (x) => x.channel === nativeBrowserLayoutFrameChannel,
    ).length;
    pageDraw(frameImage(5)); // late callback after hidden cannot update the fallback
    await Bun.sleep(110);
    expect(f.owner.sent.filter((x) => x.channel === nativeBrowserLayoutFrameChannel)).toHaveLength(
      delivered,
    );
    expect(receipt.frozen).toBeUndefined(); // the sync port never transports pixels
    expect(sourceBounds.width).toBeGreaterThan(495);
    expect(receipt.frozenWidth).toBe(sourceBounds.width);
    expect(receipt.frozenHeight).toBe(sourceBounds.height);
    expect(f.view.getVisible()).toBe(false);
    expect(f.contents.destroyed).toBe(false);
    f.owner.frame!(rootDraw(narrow));
    const narrowReady = { ...narrow, witness: { ...narrow.witness, step: 2 as const } };
    expect(f.sync(narrowReady)).toMatchObject({ ok: true });
    f.owner.frame!(rootDraw(narrowReady));
    expect(f.view.getVisible()).toBe(true);
    expect(f.view.getBounds()).toEqual({ x: 501, y: 100, width: 319, height: 600 });
    expect(f.contents.captureCalls - reads).toBe(0);
    // No new Native paint arrived at the narrow viewport yet. A second resize
    // still has the last actually presented full frame, rather than an empty cache.
    f.contentSize[0] = 840;
    const rapid = drawRequest(f, 840, 500, 'bbccddee0011223344556677');
    expect(f.sync(rapid)).toMatchObject({ frozenKey: receipt.frozenKey, waiting: true });
    f.owner.frame!(rootDraw(rapid));
    const rapidReady = { ...rapid, witness: { ...rapid.witness, step: 2 as const } };
    expect(f.sync(rapidReady)).toMatchObject({ ok: true });
    f.owner.frame!(rootDraw(rapidReady));
    const activeDraw = f.contents.frame!,
      currentSize = f.view.getBounds();
    activeDraw(frameImage(6, currentSize.width, currentSize.height));
    activeDraw(frameImage(7, currentSize.width, currentSize.height));
    const beforeNavigation = f.owner.sent.filter(
      (x) => x.channel === nativeBrowserLayoutFrameChannel,
    ).length;
    // Same-URL CDP/site navigation does not call Main navigate(). Its old
    // document frame, subscription and coalescing timer must still expire.
    f.contents.emit('did-start-navigation', {}, f.contents.getURL(), false, true);
    expect(f.contents.frame).toBeUndefined();
    activeDraw(frameImage(8, currentSize.width, currentSize.height));
    await Bun.sleep(110);
    expect(f.owner.sent.filter((x) => x.channel === nativeBrowserLayoutFrameChannel)).toHaveLength(
      beforeNavigation,
    );
    const navigating = drawRequest(f, 840, 500, 'ccddee001122334455667788');
    expect((f.sync(navigating) as { frozenKey?: string }).frozenKey).toBeUndefined();
    expect(f.present(null)).toMatchObject({ ok: true });
    const shownAgain = drawRequest(f, 840, 500, 'ccddee001122334455667788');
    expect(f.sync(shownAgain)).toMatchObject({ waiting: true });
    expect((f.sync(shownAgain) as { frozenKey?: string }).frozenKey).toBeUndefined();
  } finally {
    f.close();
  }
});
test('late Root paints cannot revive a hidden, switched, closed or replaced page', () => {
  for (const kind of ['hide', 'scope', 'close', 'renderer'] as const) {
    const f = fixture();
    f.state.phase = 'human';
    try {
      f.present({ x: 801, y: 100, width: 799, height: 600, radius: 0 });
      const first = drawRequest(f, 1600, 600, '00112233445566778899aabb');
      expect(f.sync(first)).toMatchObject({ ok: true });
      f.owner.frame!(rootDraw(first));
      const second = { ...first, witness: { ...first.witness, step: 2 as const } };
      expect(f.sync(second)).toMatchObject({ ok: true });
      const late = f.owner.frame!;
      if (kind === 'hide') f.present(null);
      if (kind === 'scope') {
        f.scope.sessionId = 'other';
        f.scope.viewSelection++;
      }
      if (kind === 'close')
        expect(f.invoke({ action: 'close', id: 'page' })).toMatchObject({ ok: true });
      if (kind === 'renderer') f.owner.emit('render-process-gone');
      late(rootDraw(second));
      if (kind === 'close') expect(f.window.contentView.children).not.toContain(f.view);
      else expect(f.view.getVisible()).toBe(false);
      expect(f.owner.frame).toBeUndefined();
      expect(f.contents.destroyed).toBe(kind === 'close');
    } finally {
      f.close();
    }
  }
});
test('pending Root feedback does not wait in the Agent read path and clipped bounds invalidate prior capture coordinates', async () => {
  const f = fixture();
  try {
    f.state.phase = 'acquiring';
    await f.page.attach();
    f.state.phase = 'agent';
    f.present({ x: 801, y: 100, width: 799, height: 600, radius: 0 });
    await f.page.send('Page.captureScreenshot', {});
    expect((f.page.captureMeta() as { metadata: unknown }).metadata).not.toBeNull();
    const pending = drawRequest(f, 1600, 1000, '00112233445566778899aabb');
    expect(f.sync(pending)).toMatchObject({ ok: true, waiting: true });
    expect(f.page.captureMeta()).toEqual({ metadata: null, navigation: 0 });
    f.state.phase = 'agent';
    expect(await f.page.send('Accessibility.getFullAXTree', {})).toEqual(image);
    expect(f.state.phase).toBe('agent');
    expect(f.page.alive()).toBe(true);
    expect(f.owner.frame).toBeDefined(); // no Root feedback was supplied
    expect(f.contents.loads).toBe(1);
  } finally {
    f.close();
  }
});
