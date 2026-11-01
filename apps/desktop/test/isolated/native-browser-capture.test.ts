import { expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import type { BrowserPagePort, NativeBrowserPageHost } from '../../electron/browser-page-host';
import {
  type NativeBrowserClosePreparation,
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
import type { NativeBrowserChromeOwner } from '../../src/native-browser-chrome-bridge';

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
  invalidations = 0;
  invalidate() {
    this.invalidations++;
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
  stops = 0;
  stop() {
    this.stops++;
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
  closes = 0;
  close() {
    this.closes++;
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
type FakePresentationHold = {
  id: string;
  target: string;
  key: string;
  viewport: Electron.Rectangle;
};
type FakeDisplayPreparation = {
  id: string;
  viewport: Electron.Rectangle;
  scope: NativeBrowserChromeOwner;
  signal: AbortSignal;
};
let nativeChrome:
  | {
      ready: boolean;
      layouts: { id: string; bounds: Electron.Rectangle }[];
      releases: (string | undefined)[];
      invalidations: number;
      viewportSyncs: number;
      pageScope(id?: string): unknown;
      announceReady(id?: string): void;
      suspend(id?: string): void;
      releaseShell(id?: string): void;
      context: NativeBrowserChromeOwner | undefined;
      setContext(owner: NativeBrowserChromeOwner | undefined): void;
      autoReady: boolean;
      rootReturns: { id: string; owner: NativeBrowserChromeOwner }[];
      rootReturnValid: boolean;
      finishedRootReturns: string[];
      cancelledRootReturns: (string | undefined)[];
      hold: FakePresentationHold | undefined;
      endHold(key?: string): void;
      displayPreparations: FakeDisplayPreparation[];
      displayOffers: Omit<FakeDisplayPreparation, 'signal'>[];
      readDisplay(input: FakeDisplayPreparation): Promise<boolean>;
      offerSucceeds: boolean;
    }
  | undefined;
mock.module('../../electron/browser-chrome-host', () => ({
  createNativeBrowserChromeHost(options: {
    window: BrowserWindow;
    getPage(id: string): { id: string; scope?: unknown; draft?: string } | undefined;
    currentScope(forInput: boolean): NativeBrowserRestoreScope | undefined;
    onReady(id: string): void;
    onSuspend(id: string): void;
    onPresentationHoldEnd?(id: string, key: string): void;
    onShellReleased?(id?: string): void;
    onContextChanged?(): void;
    onRootReturnCancelled?(id: string): void;
    preparedPresentation?(): unknown;
  }) {
    const initialScope = options.currentScope(false);
    const boundScope = initialScope && { ...initialScope };
    const root = options.window.contentView.children.find(
      (view) =>
        (view as unknown as FakeView).webContents ===
        (options.window.webContents as unknown as FakeContents),
    ) as unknown as FakeView | undefined;
    const fullRoot = () => {
      const [width = 0, height = 0] = options.window.getContentSize();
      root?.setBounds({ x: 0, y: 0, width, height });
    };
    let returning:
      | { id: string; owner: NativeBrowserChromeOwner; previous: Electron.Rectangle | undefined }
      | undefined;
    const state = {
      ready: false,
      layouts: [] as { id: string; bounds: Electron.Rectangle }[],
      releases: [] as (string | undefined)[],
      invalidations: 0,
      viewportSyncs: 0,
      pageScope: (id = 'page') => options.getPage(id)?.scope,
      announceReady: (id = 'page') => options.onReady(id),
      suspend: (id = 'page') => options.onSuspend(id),
      releaseShell: (id?: string) => options.onShellReleased?.(id),
      context: boundScope as NativeBrowserChromeOwner | undefined,
      setContext(owner: NativeBrowserChromeOwner | undefined) {
        if (JSON.stringify(state.context) === JSON.stringify(owner)) return;
        state.context = owner;
        state.ready = false;
        options.onContextChanged?.();
      },
      autoReady: false,
      rootReturns: [] as { id: string; owner: NativeBrowserChromeOwner }[],
      rootReturnValid: true,
      finishedRootReturns: [] as string[],
      cancelledRootReturns: [] as (string | undefined)[],
      hold: undefined as FakePresentationHold | undefined,
      displayPreparations: [] as FakeDisplayPreparation[],
      displayOffers: [] as Omit<FakeDisplayPreparation, 'signal'>[],
      readDisplay: async (_input: FakeDisplayPreparation) => false,
      offerSucceeds: true,
      endHold(key?: string) {
        const held = state.hold;
        if (!held) return;
        if (!key || key === held.key) state.hold = undefined;
        options.onPresentationHoldEnd?.(held.id, key ?? held.key);
      },
    };
    nativeChrome = state;
    const acceptsPresentation = (id: string, context?: NativeBrowserChromeOwner) => {
      const page = options.getPage(id),
        scope = context ?? state.context;
      return (
        page?.id === id &&
        !!scope &&
        JSON.stringify(scope) === JSON.stringify(state.context) &&
        ('draft' in scope
          ? page.draft === scope.draft && !page.scope
          : !page.draft && JSON.stringify(options.currentScope(false)) === JSON.stringify(scope))
      );
    };
    const readyFor = (id: string, context?: NativeBrowserChromeOwner) =>
      state.ready && acceptsPresentation(id, context);
    return {
      acceptsPresentation,
      prepareDisplay(
        id: string,
        viewport: Electron.Rectangle,
        scope: NativeBrowserChromeOwner,
        signal: AbortSignal,
      ) {
        const input = { id, viewport: { ...viewport }, scope: { ...scope }, signal };
        state.displayPreparations.push(input);
        return state.readDisplay(input);
      },
      offerDisplay(id: string, viewport: Electron.Rectangle, scope: NativeBrowserChromeOwner) {
        state.displayOffers.push({ id, viewport: { ...viewport }, scope: { ...scope } });
        if (state.autoReady && state.offerSucceeds)
          queueMicrotask(() => {
            if (JSON.stringify(state.context) !== JSON.stringify(scope)) return;
            state.ready = true;
            options.onReady(id);
          });
        return state.offerSucceeds;
      },
      readyFor,
      beginRootReturn(id: string, scope: NativeBrowserChromeOwner) {
        if (!readyFor(id, scope) || !root) return null;
        const viewport = state.layouts.at(-1)?.bounds;
        if (!viewport) return null;
        returning = { id, owner: scope, previous: root.getBounds() };
        state.rootReturns.push({ id, owner: { ...scope } });
        fullRoot();
        const zoom = options.window.webContents.getZoomFactor(),
          [width = 0, height = 0] = options.window.getContentSize();
        return {
          bounds: {
            x: viewport.x / zoom,
            y: 0,
            width: viewport.width / zoom,
            height: viewport.y / zoom,
            radius: 0,
          },
          width: width / zoom,
          height: height / zoom,
        };
      },
      rootReturnCurrent(id: string, scope: NativeBrowserChromeOwner) {
        return (
          !!returning &&
          state.rootReturnValid &&
          returning.id === id &&
          JSON.stringify(returning.owner) === JSON.stringify(scope) &&
          readyFor(id, scope)
        );
      },
      finishRootReturn(id: string) {
        state.finishedRootReturns.push(id);
        if (returning?.id === id) returning = undefined;
        state.ready = false;
      },
      cancelRootReturn(id?: string) {
        state.cancelledRootReturns.push(id);
        if (!returning || (id && returning.id !== id)) return;
        if (returning.previous) root?.setBounds(returning.previous);
        returning = undefined;
      },
      invalidateGeometry() {
        if (state.ready) options.onShellReleased?.(state.layouts.at(-1)?.id);
        state.endHold();
        state.invalidations++;
      },
      holdsPresentation(id: string) {
        const held = state.hold;
        return held?.id === id
          ? { key: held.key, targetId: held.target, viewport: held.viewport }
          : undefined;
      },
      cancelPresentationHold(id?: string) {
        if (!id || state.hold?.id === id || state.hold?.target === id) state.endHold();
      },
      completePresentation(id: string) {
        if (state.hold?.target === id) state.endHold();
      },
      syncViewport() {
        state.viewportSyncs++;
      },
      presentationViewport(scope: NativeBrowserChromeOwner) {
        return state.ready && JSON.stringify(scope) === JSON.stringify(state.context)
          ? state.layouts.at(-1)?.bounds
          : undefined;
      },
      update() {},
      layout(id: string, bounds: Electron.Rectangle) {
        if (returning) return false;
        state.layouts.push({ id, bounds });
        if (state.ready && root)
          root.setBounds({
            x: 0,
            y: 0,
            width: bounds.x,
            height: options.window.getContentSize()[1]!,
          });
        return state.ready;
      },
      release(id?: string) {
        if (!id || state.hold?.target === id) state.endHold();
        state.releases.push(id);
        fullRoot();
      },
      dispose() {
        if (state.ready) options.onShellReleased?.(state.layouts.at(-1)?.id);
        state.endHold();
      },
    };
  },
}));
const { registerNativeBrowserIpc } = await import('../../electron/native-browser');

function fixture(
  nativeOwned = false,
  generation = 1,
  withRoot = false,
  config: { initialPage?: boolean; selectedScope?: boolean } = {},
) {
  views.length = 0;
  let page!: BrowserPagePort;
  const presentation: boolean[] = [];
  const unregistered: string[] = [];
  const ports = new Map<string, BrowserPagePort>();
  const armed: string[] = [];
  let selected = config.selectedScope !== false;
  let repaintOnPresent = false;
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
    state: (id: string) =>
      config.initialPage === false && !ports.has(id) ? undefined : { ...state },
    arm(id: string) {
      armed.push(id);
    },
    add(port: BrowserPagePort) {
      page = port;
      ports.set(port.id, port);
      return () => {
        unregistered.push(port.id);
      };
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
    present(id: string, visible: boolean) {
      presentation.push(visible);
      if (repaintOnPresent) ports.get(id)?.changed();
    },
  } as unknown as NativeBrowserPageHost;
  const owner = new FakeContents();
  const contentSize = [1600, 1200];
  const children: FakeView[] = [];
  const root = withRoot ? new FakeView() : undefined;
  if (root) {
    Object.defineProperty(root, 'webContents', { value: owner });
    root.setBounds({ x: 0, y: 0, width: 1600, height: 1200 });
    root.setVisible(true);
    children.push(root);
  }
  const window = Object.assign(new EventEmitter(), {
    webContents: owner,
    isDestroyed: () => false,
    isVisible: () => true,
    isMinimized: () => false,
    getContentSize: () => contentSize,
    contentView: {
      children,
      addChildView(view: FakeView, index?: number) {
        const old = children.indexOf(view);
        if (old >= 0) children.splice(old, 1);
        children.splice(index ?? children.length, 0, view);
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
  const scope = { storeId: 'store', sessionId: 'session', generation, viewSelection: 1 };
  const close = registerNativeBrowserIpc({
    window,
    ipcMain: {
      on: (key: string, handler: (event: Electron.IpcMainEvent, input: unknown) => void) =>
        events.set(key, handler),
      off: (key: string) => events.delete(key),
      handle: (key: string, handler: (event: IpcMainInvokeEvent, input: unknown) => unknown) =>
        handlers.set(key, handler),
      removeHandler: (key: string) => handlers.delete(key),
    } as unknown as IpcMain,
    automation,
    selectedScope: () => (selected ? scope : undefined),
    rendererUrl: 'http://localhost/',
    ...(nativeOwned ? { chrome: { preloadPath: '/isolated/chrome.cjs' } } : {}),
  });
  if (config.initialPage !== false) {
    expect(
      handlers.get(nativeBrowserChannel)!(
        { sender: owner, senderFrame: owner.mainFrame } as unknown as IpcMainInvokeEvent,
        { action: 'navigate', id: 'page', input: 'http://localhost/page' },
      ),
    ).toMatchObject({ ok: true });
    state.phase = 'agent';
  }
  const present = (
    bounds: { x: number; y: number; width: number; height: number; radius: number } | null,
    layout?: NativeBrowserLayout,
  ) =>
    handlers.get(nativeBrowserChannel)!(
      { sender: owner, senderFrame: owner.mainFrame } as unknown as IpcMainInvokeEvent,
      { action: 'present', id: 'page', bounds, ...(layout ? { layout } : {}) },
    );
  const asyncLayout = handlers.get(nativeBrowserLayoutChannel);
  return {
    prepare: (input: unknown, frame = owner.mainFrame, sender = owner) => {
      const handler = handlers.get('kite:native:browser-preparation');
      expect(typeof handler).toBe('function');
      return handler!(
        { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent,
        input,
      ) as Promise<{ key: string } | null>;
    },
    cancelPreparation: (key: string, frame = owner.mainFrame) => {
      const handler = handlers.get('kite:native:browser-preparation-cancel');
      expect(typeof handler).toBe('function');
      return handler!(
        { sender: owner, senderFrame: frame } as unknown as IpcMainInvokeEvent,
        key,
      ) as Promise<void>;
    },
    asyncLayoutRegistered: () => handlers.has(nativeBrowserLayoutChannel),
    asyncLayout: (input: unknown, frame = owner.mainFrame, sender = owner) => {
      expect(typeof asyncLayout).toBe('function');
      return asyncLayout!({ sender, senderFrame: frame } as unknown as IpcMainInvokeEvent, input);
    },
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
    root,
    contentSize,
    owner,
    presentation,
    unregistered,
    ports,
    armed,
    selectScope(value: boolean) {
      selected = value;
    },
    repaintOnPresent() {
      repaintOnPresent = true;
    },
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
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    toBitmap: () => bytes,
  } as unknown as Electron.NativeImage;
}

function draftRootFixture(selectedScope = false) {
  const f = fixture(true, 1, true, { initialPage: false, selectedScope }),
    draft = '0123456789abcdef0123456789abcdef',
    pageRead = deferred<FakeImage>();
  expect(
    f.invoke({ action: 'navigate', id: 'draft-page', input: 'https://www.baidu.com/', draft }),
  ).toMatchObject({ ok: true });
  const view = views.at(-1)!,
    contents = view.webContents;
  nativeChrome!.setContext({ draft });
  nativeChrome!.readDisplay = async () => true;
  nativeChrome!.autoReady = true;
  contents.getURL = () => 'https://www.baidu.com/';
  contents.mainFrame.url = contents.getURL();
  contents.captureVisible = () => pageRead.promise;
  contents.emit('did-start-navigation', {}, contents.getURL(), false, true);
  contents.emit('did-navigate', {}, contents.getURL());
  const { scope: _scope, ...request } = drawRequest(f, 1600, 800, '00112233445566778899aabb'),
    first = { ...request, id: 'draft-page', draft },
    second = { ...first, witness: { ...first.witness, step: 2 as const } };
  const draw = () => {
    expect(f.sync(first)).toMatchObject({ ok: true, waiting: true });
    f.owner.frame!(rootDraw(first));
    expect(f.sync(second)).toMatchObject({ ok: true, waiting: true });
    f.owner.frame!(rootDraw(second));
  };
  return { ...f, draft, view, contents, pageRead, first, second, draw, chrome: nativeChrome! };
}

if (process.platform === 'darwin') {
  test('draft first page needs its document, Page and Chrome frames and fresh native acceptance without reparenting', async () => {
    const f = draftRootFixture(),
      chromeRead = deferred<boolean>(),
      pageView = f.view as unknown as Electron.View,
      rootView = f.root! as unknown as Electron.View,
      ownLayerOrder = () =>
        f.window.contentView.children.filter((view) => view === pageView || view === rootView),
      prepared = { x: 801, y: 100, width: 799, height: 600 };
    f.chrome.autoReady = false;
    f.chrome.readDisplay = () => chromeRead.promise;
    f.contents.captureVisible = () => {
      expect(f.view.getBounds()).toEqual(prepared);
      expect(ownLayerOrder()).toEqual([pageView, rootView]);
      return f.pageRead.promise;
    };
    try {
      expect(f.ports.size).toBe(0);
      expect(f.armed).toEqual([]);
      f.draw();
      expect(f.view.getVisible()).toBe(true);
      expect(f.view.getBounds()).toEqual(prepared);
      expect(f.view.getBounds().x + f.view.getBounds().width).toBeLessThanOrEqual(
        f.contentSize[0]!,
      );
      expect(ownLayerOrder()).toEqual([pageView, rootView]);
      expect(f.contents.captureCalls).toBe(0);
      expect(f.chrome.displayPreparations).toHaveLength(0);
      expect(f.root!.getBounds()).toEqual({ x: 0, y: 0, width: 1600, height: 1200 });
      expect(f.owner.sent.at(-1)?.value).toMatchObject({
        id: 'draft-page',
        draft: f.draft,
        key: f.first.witness.key,
        presentationRevision: 1,
        step: 2,
        presented: false,
      });
      f.contents.emit('dom-ready');
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.contents.captureCalls).toBe(1);
      expect(f.chrome.displayPreparations).toHaveLength(1);
      expect(f.chrome.displayPreparations[0]).toMatchObject({
        id: 'draft-page',
        scope: { draft: f.draft },
        viewport: prepared,
      });
      expect(f.chrome.layouts).toHaveLength(0);
      expect(f.view.getBounds()).toEqual(prepared);
      f.pageRead.resolve(new FakeImage(1598, 1200));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.chrome.displayOffers).toHaveLength(0);
      expect(f.root!.getBounds()).toEqual({ x: 0, y: 0, width: 1600, height: 1200 });
      expect(f.owner.sent.at(-1)?.value).toMatchObject({ draft: f.draft, presented: false });
      chromeRead.resolve(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.chrome.displayPreparations).toHaveLength(2);
      expect(f.chrome.displayOffers).toEqual([
        { id: 'draft-page', scope: { draft: f.draft }, viewport: prepared },
      ]);
      expect(f.root!.getBounds()).toEqual({ x: 0, y: 0, width: 1600, height: 1200 });
      expect(f.chrome.layouts).toHaveLength(0);
      expect(f.owner.sent.at(-1)?.value).toMatchObject({ draft: f.draft, presented: false });
      f.chrome.ready = true;
      f.chrome.announceReady('draft-page');
      expect(f.view.getVisible()).toBe(true);
      expect(f.view.getBounds()).toEqual({ x: 801, y: 100, width: 799, height: 600 });
      expect(ownLayerOrder()).toEqual([pageView, rootView]);
      expect(f.root!.getBounds()).toEqual({ x: 0, y: 0, width: 801, height: 1200 });
      const ack = f.owner.sent.at(-1)?.value;
      expect(ack).toMatchObject({
        id: 'draft-page',
        draft: f.draft,
        key: f.first.witness.key,
        presentationRevision: 1,
        step: 2,
        presented: true,
      });
      expect(ack).not.toHaveProperty('scope');
      expect(f.chrome.ready).toBe(true);
      expect(f.chrome.layouts).toEqual([{ id: 'draft-page', bounds: prepared }]);
      expect(f.ports.size).toBe(0);
      expect(f.armed).toEqual([]);
      expect(f.contents.loads).toBe(1);
      expect(f.sync(f.second)).toMatchObject({ ok: true, waiting: false });
    } finally {
      f.pageRead.resolve(new FakeImage(0, 0));
      chromeRead.resolve(false);
      f.close();
    }
  });

  test('draft ownership never borrows selected Session scope or enters Agent restore and grant', async () => {
    const f = draftRootFixture(true);
    try {
      expect(f.ports.size).toBe(0);
      expect(f.chrome.pageScope('draft-page')).toBeUndefined();
      expect(
        f.invoke({ action: 'navigate', id: 'session-page', input: 'https://example.com/' }),
      ).toMatchObject({ ok: true });
      expect([...f.ports.keys()]).toEqual(['session-page']);
      expect(f.invoke({ action: 'restoreDraft', draft: f.draft })).toMatchObject({
        ok: true,
        value: { pages: [{ id: 'draft-page' }] },
      });
      const restored = f.invoke({ action: 'restore', scope: { ...f.scope } });
      expect(restored).toMatchObject({ ok: true, value: { pages: [{ id: 'session-page' }] } });
      expect(JSON.stringify(restored)).not.toContain('draft-page');
      expect(f.invoke({ action: 'grant', id: 'draft-page' })).toMatchObject({ ok: false });
      expect(
        f.invoke({ action: 'navigate', id: 'draft-page', input: 'https://example.org/' }),
      ).toMatchObject({ ok: false });
      expect(f.invoke({ action: 'close', id: 'draft-page', draft: 'f'.repeat(32) })).toMatchObject({
        ok: false,
      });
      expect(f.sync({ ...f.first, scope: { ...f.scope } })).toMatchObject({ ok: false });
      expect(f.invoke({ action: 'restoreDraft', draft: 'f'.repeat(32) })).toMatchObject({
        ok: true,
        value: { pages: [] },
      });
      expect(
        f.invoke({
          action: 'navigate',
          id: 'other-draft-page',
          input: 'https://example.org/',
          draft: 'f'.repeat(32),
        }),
      ).toMatchObject({ ok: true });
      expect(f.invoke({ action: 'restoreDraft', draft: f.draft })).toMatchObject({
        ok: true,
        value: { pages: [{ id: 'draft-page' }], activeId: 'draft-page' },
      });
      expect(f.invoke({ action: 'restoreDraft', draft: 'f'.repeat(32) })).toMatchObject({
        ok: true,
        value: { pages: [{ id: 'other-draft-page' }], activeId: 'other-draft-page' },
      });
      expect(f.armed).toEqual([]);
      expect(f.contents.destroyed).toBe(false);
      expect(f.contents.loads).toBe(1);
    } finally {
      f.pageRead.resolve(new FakeImage(0, 0));
      f.close();
    }
  });

  test('a released old or empty Chrome shell cannot cancel a draft waiting for its current Page frame', async () => {
    const f = draftRootFixture();
    try {
      f.draw();
      f.chrome.releaseShell();
      f.chrome.releaseShell('page-from-retired-shell');
      expect(f.contents.captureCalls).toBe(0);
      f.contents.emit('dom-ready');
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.contents.captureCalls).toBe(1);
      f.chrome.releaseShell();
      f.chrome.announceReady('page-from-retired-shell');
      expect(f.chrome.layouts).toHaveLength(0);
      expect(f.owner.sent.at(-1)?.value).toMatchObject({ draft: f.draft, presented: false });
      f.pageRead.resolve(new FakeImage(1598, 1200));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.view.getVisible()).toBe(true);
      expect(f.owner.sent.at(-1)?.value).toMatchObject({
        id: 'draft-page',
        draft: f.draft,
        key: f.second.witness.key,
        presentationRevision: f.second.presentationRevision,
        step: 2,
        presented: true,
      });
      expect(f.contents.captureCalls).toBe(1);
      expect(f.contents.loads).toBe(1);
      expect(f.chrome.displayPreparations.length).toBeGreaterThanOrEqual(1);
      expect(f.chrome.layouts).toHaveLength(1);
      expect(f.ports.size).toBe(0);
      expect(f.armed).toEqual([]);
    } finally {
      f.pageRead.resolve(new FakeImage(0, 0));
      f.close();
    }
  });

  test('draft explicit restore rebinds a reused Root node after replacement and requires a new presentation proof', async () => {
    for (const replacement of ['navigation', 'crash'] as const) {
      const f = draftRootFixture(),
        freshRead = deferred<FakeImage>();
      try {
        f.first.presentationRevision = 7;
        f.second.presentationRevision = 7;
        f.draw();
        const oldDraw = f.owner.frameCallbacks.at(-1)!;
        f.contents.emit('dom-ready');
        await new Promise<void>((resolve) => setImmediate(resolve));
        f.pageRead.resolve(new FakeImage(1598, 1200));
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(f.view.getVisible()).toBe(true);
        f.contents.document.value = 'retained draft form';
        const originalFrame = f.owner.mainFrame,
          originalDocument = f.contents.document,
          originalURL = f.contents.getURL();
        if (replacement === 'navigation')
          f.owner.emit('did-start-navigation', {}, originalFrame.url, false, true);
        else f.owner.emit('render-process-gone');
        f.chrome.setContext(undefined);
        expect(f.owner.mainFrame).toBe(originalFrame); // Native frame object ABA is intentional.
        expect(f.view.getVisible()).toBe(false);
        expect(f.sync(f.second)).toMatchObject({ ok: false });
        expect(
          f.invoke({
            action: 'present',
            id: 'draft-page',
            draft: f.draft,
            bounds: null,
            presentationRevision: 7,
          }),
        ).toMatchObject({ ok: false });
        expect(
          f.invoke({
            action: 'navigate',
            id: 'draft-page',
            draft: f.draft,
            input: 'https://example.org/',
          }),
        ).toMatchObject({ ok: false });
        expect(f.invoke({ action: 'restoreDraft', draft: 'f'.repeat(32) })).toMatchObject({
          ok: true,
          value: { pages: [] },
        });
        expect(f.sync(f.second)).toMatchObject({ ok: false });
        expect(f.invoke({ action: 'restoreDraft', draft: f.draft })).toMatchObject({
          ok: true,
          value: { pages: [{ id: 'draft-page' }], activeId: 'draft-page' },
        });
        f.chrome.setContext({ draft: f.draft });
        expect(f.view.getVisible()).toBe(false);
        expect(f.sync(f.second)).toMatchObject({ ok: false });
        const sent = f.owner.sent.length;
        oldDraw(rootDraw(f.second));
        expect(f.owner.sent).toHaveLength(sent);
        const first = {
            ...f.first,
            presentationRevision: 8,
            witness: { key: 'ffeeddccbbaa998877665544', step: 1 as const },
          },
          second = { ...first, witness: { ...first.witness, step: 2 as const } };
        f.contents.captureVisible = () => freshRead.promise;
        expect(f.sync({ ...first, presentationRevision: 1 })).toMatchObject({ ok: false });
        expect(f.sync(first)).toMatchObject({ ok: true, waiting: true });
        f.owner.frame!(rootDraw(f.first)); // Old key cannot prove this new Root paint.
        expect(f.owner.sent).toHaveLength(sent);
        f.owner.frame!(rootDraw(first));
        expect(f.owner.sent.at(-1)?.value).toMatchObject({
          draft: f.draft,
          key: first.witness.key,
          presentationRevision: 8,
          step: 1,
        });
        expect(f.sync(second)).toMatchObject({ ok: true, waiting: true });
        f.owner.frame!(rootDraw(second));
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(f.contents.captureCalls).toBe(2);
        freshRead.resolve(new FakeImage(1598, 1200));
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(f.view.getVisible()).toBe(true);
        expect(f.owner.sent.at(-1)?.value).toMatchObject({
          id: 'draft-page',
          draft: f.draft,
          key: second.witness.key,
          presentationRevision: 8,
          step: 2,
          presented: true,
        });
        const visibility = f.view.visibility.length,
          captured = f.contents.captureCalls;
        expect(f.sync(f.first)).toMatchObject({ ok: false });
        expect(f.sync(f.second)).toMatchObject({ ok: false });
        expect(
          f.invoke({
            action: 'present',
            id: 'draft-page',
            draft: f.draft,
            bounds: null,
            presentationRevision: 7,
          }),
        ).toMatchObject({ ok: false });
        expect(f.view.getVisible()).toBe(true);
        expect(f.view.visibility.slice(visibility)).not.toContain(false);
        expect(f.contents.captureCalls).toBe(captured);
        expect(f.contents.document).toBe(originalDocument);
        expect(f.contents.document.value).toBe('retained draft form');
        expect(f.contents.getURL()).toBe(originalURL);
        expect(f.contents.loads).toBe(1);
        expect(f.contents.destroyed).toBe(false);
        expect(f.chrome.layouts).toHaveLength(2);
        expect(f.ports.size).toBe(0);
        expect(f.armed).toEqual([]);
      } finally {
        freshRead.resolve(new FakeImage(0, 0));
        f.pageRead.resolve(new FakeImage(0, 0));
        f.close();
      }
    }
  });

  for (const failure of ['read', 'empty', 'wrong-size'] as const)
    test(`draft first page keeps its Root source and reports ${failure} without a false adoption`, async () => {
      const f = draftRootFixture();
      try {
        f.draw();
        f.contents.emit('dom-ready');
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (failure === 'read') f.pageRead.reject(Error('private draft capture detail'));
        else f.pageRead.resolve(new FakeImage(failure === 'empty' ? 0 : 10, 1200));
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(f.view.getVisible()).toBe(false);
        expect(f.root!.getVisible()).toBe(true);
        expect(f.root!.getBounds()).toEqual({ x: 0, y: 0, width: 1600, height: 1200 });
        expect(f.owner.sent.at(-1)?.value).toMatchObject({
          id: 'draft-page',
          draft: f.draft,
          key: f.first.witness.key,
          step: 2,
          presented: false,
          error: 'browser_presentation_unavailable',
        });
        expect(JSON.stringify(f.owner.sent)).not.toContain('private');
        expect(f.contents.loads).toBe(1);
        expect(f.chrome.displayPreparations).toHaveLength(1);
        expect(f.ports.size).toBe(0);
      } finally {
        f.pageRead.resolve(new FakeImage(0, 0));
        f.close();
      }
    });

  for (const boundary of [
    'hide',
    'close',
    'navigate',
    'stop',
    'page-frame',
    'page-token',
    'context',
    'Chrome-shell',
    'Root-frame',
    'Root-reload',
    'resize',
    'dispose',
  ] as const)
    test(`draft first page discards a late current-frame read after ${boundary}`, async () => {
      const f = draftRootFixture();
      try {
        f.draw();
        f.contents.emit('dom-ready');
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(f.contents.captureCalls).toBe(1);
        if (boundary === 'hide')
          expect(
            f.invoke({
              action: 'present',
              id: 'draft-page',
              draft: f.draft,
              presentationRevision: 1,
              bounds: null,
            }),
          ).toMatchObject({ ok: true });
        if (boundary === 'close')
          expect(f.invoke({ action: 'close', id: 'draft-page', draft: f.draft })).toMatchObject({
            ok: true,
          });
        if (boundary === 'navigate')
          expect(
            f.invoke({
              action: 'navigate',
              id: 'draft-page',
              draft: f.draft,
              input: 'https://example.com/',
            }),
          ).toMatchObject({ ok: true });
        if (boundary === 'stop')
          expect(f.invoke({ action: 'stop', id: 'draft-page', draft: f.draft })).toMatchObject({
            ok: true,
          });
        if (boundary === 'page-frame') f.contents.mainFrame = { url: f.contents.getURL() };
        if (boundary === 'page-token')
          f.contents.emit('did-start-navigation', {}, f.contents.getURL(), false, true);
        if (boundary === 'context') f.chrome.setContext({ ...f.scope });
        if (boundary === 'Chrome-shell') f.chrome.releaseShell('draft-page');
        if (boundary === 'Root-frame') f.owner.mainFrame = { url: f.owner.mainFrame.url };
        if (boundary === 'Root-reload')
          f.owner.emit('did-start-navigation', {}, f.owner.mainFrame.url, false, true);
        if (boundary === 'resize') {
          f.contentSize[0] = 1200;
          f.window.emit('resize');
        }
        if (boundary === 'dispose') f.close();
        const sent = f.owner.sent.length;
        f.pageRead.resolve(new FakeImage(1598, 1200));
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(
          f.owner.sent
            .slice(sent)
            .some(
              (message) =>
                message.channel === nativeBrowserLayoutFrameChannel &&
                (message.value as { presented?: boolean }).presented === true,
            ),
        ).toBe(false);
        expect(f.root!.getBounds()).toEqual({ x: 0, y: 0, width: f.contentSize[0]!, height: 1200 });
        expect(f.chrome.displayPreparations).toHaveLength(1);
        expect(f.chrome.layouts).toHaveLength(0);
        expect(f.ports.size).toBe(0);
        expect(f.armed).toEqual([]);
        expect(f.contents.loads).toBe(boundary === 'navigate' ? 2 : 1);
      } finally {
        f.pageRead.resolve(new FakeImage(0, 0));
        f.close();
      }
    });

  test('draft hide before DOM-ready cannot start a later document read or restore old witness pixels', async () => {
    const f = draftRootFixture();
    try {
      f.draw();
      expect(
        f.invoke({
          action: 'present',
          id: 'draft-page',
          draft: f.draft,
          bounds: null,
          presentationRevision: 1,
        }),
      ).toMatchObject({ ok: true });
      f.contents.emit('dom-ready');
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.contents.captureCalls).toBe(0);
      expect(f.view.getVisible()).toBe(false);
      expect(f.sync(f.second)).toMatchObject({ ok: false });
      expect(f.chrome.layouts).toHaveLength(0);
      expect(f.ports.size).toBe(0);
      expect(f.contents.loads).toBe(1);
    } finally {
      f.pageRead.resolve(new FakeImage(0, 0));
      f.close();
    }
  });

  test('draft menu accepts only its current manual navigation owner and cannot request Agent controls', async () => {
    const f = draftRootFixture();
    try {
      f.draw();
      f.contents.emit('dom-ready');
      await new Promise<void>((resolve) => setImmediate(resolve));
      f.pageRead.resolve(new FakeImage(1598, 1200));
      await new Promise<void>((resolve) => setImmediate(resolve));
      const request: NativeBrowserMenuRequest = {
        requestId: 'draft-menu',
        id: 'draft-page',
        draft: f.draft,
        x: 900,
        y: 80,
        details: [],
        items: [{ action: 'reload', enabled: true }],
      };
      const captures = f.contents.captureCalls,
        response = f.menu(request);
      expect(popupTemplate).toHaveLength(1);
      expect(popupTemplate[0]?.label).toBe('刷新网页');
      popupTemplate[0]!.click!({} as Electron.MenuItem, f.window, {} as Electron.KeyboardEvent);
      popupOptions!.callback!();
      expect(await response).toBe('reload');
      await expect(f.menu({ ...request, draft: 'f'.repeat(32) })).rejects.toThrow();
      await expect(
        f.menu({ ...request, items: [{ action: 'handoff', enabled: true }] }),
      ).rejects.toThrow();
      await expect(
        f.menu({ ...request, draft: undefined, scope: { ...f.scope } }),
      ).rejects.toThrow();
      const stale = f.menu({ ...request, requestId: 'stale-draft-menu' });
      f.owner.mainFrame = { url: f.owner.mainFrame.url };
      popupTemplate[0]!.click!({} as Electron.MenuItem, f.window, {} as Electron.KeyboardEvent);
      popupOptions!.callback!();
      expect(await stale).toBeNull();
      expect(f.contents.captureCalls).toBe(captures);
      expect(f.contents.loads).toBe(1);
      expect(f.armed).toEqual([]);
      expect(f.ports.size).toBe(0);
    } finally {
      f.pageRead.resolve(new FakeImage(0, 0));
      f.close();
    }
  });

  test('adopted draft resize projects the same live page and rejects obsolete key, revision and hides', async () => {
    const f = draftRootFixture();
    try {
      f.first.presentationRevision = 2;
      f.second.presentationRevision = 2;
      f.draw();
      f.contents.emit('dom-ready');
      await new Promise<void>((resolve) => setImmediate(resolve));
      f.pageRead.resolve(new FakeImage(1598, 1200));
      await new Promise<void>((resolve) => setImmediate(resolve));
      f.contents.document.value = 'draft form stays';
      const writes = f.view.boundsWrites.length,
        visible = f.view.visibility.length;
      expect(f.sync({ ...f.second, draft: 'f'.repeat(32) })).toMatchObject({ ok: false });
      expect(
        f.sync({ ...f.second, witness: { key: 'ffeeddccbbaa998877665544', step: 2 } }),
      ).toMatchObject({ ok: false });
      expect(f.sync({ ...f.second, presentationRevision: 1 })).toMatchObject({ ok: false });
      expect(
        f.invoke({
          action: 'present',
          id: 'draft-page',
          draft: f.draft,
          presentationRevision: 1,
          bounds: null,
        }),
      ).toMatchObject({ ok: false });
      expect(
        f.invoke({
          action: 'present',
          id: 'draft-page',
          draft: 'f'.repeat(32),
          presentationRevision: 1,
          bounds: null,
        }),
      ).toMatchObject({ ok: false });
      expect(f.view.boundsWrites).toHaveLength(writes);
      expect(f.view.visibility.slice(visible)).not.toContain(false);
      f.contentSize[0] = 1200;
      f.window.emit('resize');
      expect(f.view.getBounds()).toEqual({ x: 601, y: 100, width: 599, height: 600 });
      expect(f.view.getVisible()).toBe(true);
      expect(f.contents.document.value).toBe('draft form stays');
      expect(f.contents.loads).toBe(1);
      expect(f.contents.destroyed).toBe(false);
      expect(f.ports.size).toBe(0);
      expect(f.chrome.layouts.at(-1)).toEqual({
        id: 'draft-page',
        bounds: { x: 601, y: 100, width: 599, height: 600 },
      });
    } finally {
      f.pageRead.resolve(new FakeImage(0, 0));
      f.close();
    }
  });
}

if (process.platform === 'darwin')
  test('first Root handoff waits for its document and both native frames before offering and adopting', async () => {
    const f = fixture(true, 1, true),
      chrome = nativeChrome!,
      pageRead = deferred<FakeImage>(),
      chromeRead = deferred<boolean>();
    f.state.phase = 'human';
    f.contents.captureVisible = () => pageRead.promise;
    chrome.readDisplay = () => chromeRead.promise;
    try {
      f.contents.emit('did-start-navigation', {}, 'http://localhost/page', false, true);
      f.contents.emit('did-navigate', {}, 'http://localhost/page');
      const first = drawRequest(f, 1600, 800, '00112233445566778899aabb');
      expect(f.sync(first)).toMatchObject({ ok: true, waiting: true });
      f.owner.frame!(rootDraw(first));
      const second = { ...first, witness: { ...first.witness, step: 2 as const } };
      expect(f.sync(second)).toMatchObject({ ok: true, waiting: true });
      f.owner.frame!(rootDraw(second));
      expect(f.owner.sent.at(-1)?.value).toMatchObject({
        key: first.witness.key,
        presentationRevision: first.presentationRevision,
        step: 2,
        presented: false,
      });
      expect(f.presentation).not.toContain(true);
      expect(chrome.layouts).toHaveLength(0);
      expect(f.root!.getBounds()).toEqual({ x: 0, y: 0, width: 1600, height: 1200 });
      expect(
        f.window.contentView.children.indexOf(f.view as unknown as Electron.View),
      ).toBeLessThan(f.window.contentView.children.indexOf(f.root! as unknown as Electron.View));
      expect(f.contents.captureCalls).toBe(0);
      expect(chrome.displayPreparations).toHaveLength(0);
      f.contents.emit('dom-ready');
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.contents.captureCalls).toBe(1);
      expect(chrome.displayPreparations).toHaveLength(1);
      const prepared = chrome.displayPreparations[0]!;
      expect({ id: prepared.id, viewport: prepared.viewport, scope: prepared.scope }).toEqual({
        id: 'page',
        viewport: { x: 801, y: 100, width: 799, height: 600 },
        scope: first.scope,
      });
      pageRead.resolve(new FakeImage(1598, 1200));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(chrome.displayOffers).toHaveLength(0);
      expect(f.presentation).not.toContain(true);
      chromeRead.resolve(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(chrome.displayOffers).toEqual([
        { id: 'page', viewport: prepared.viewport, scope: first.scope },
      ]);
      expect(f.presentation).not.toContain(true);
      expect(chrome.layouts).toHaveLength(0);
      expect(f.sync(second)).toMatchObject({ ok: true, waiting: true });
      chrome.ready = true;
      chrome.announceReady();
      expect(f.view.getVisible()).toBe(true);
      expect(f.presentation.at(-1)).toBe(true);
      expect(chrome.layouts.at(-1)).toEqual({ id: 'page', bounds: prepared.viewport });
      expect(f.owner.sent.at(-1)?.value).toMatchObject({
        id: 'page',
        scope: first.scope,
        key: first.witness.key,
        presentationRevision: first.presentationRevision,
        step: 2,
        presented: true,
      });
      expect(f.sync(second)).toMatchObject({ ok: true, waiting: false });
      expect(f.contents.loads).toBe(1);
      expect(f.contents.captureCalls).toBe(1);
      expect(f.state.phase).toBe('human');
    } finally {
      pageRead.resolve(new FakeImage(0, 0));
      chromeRead.resolve(false);
      f.close();
    }
  });

function initialRootFixture() {
  const f = fixture(true, 1, true),
    chrome = nativeChrome!,
    pageRead = deferred<FakeImage>(),
    chromeRead = deferred<boolean>();
  f.state.phase = 'human';
  f.contents.captureVisible = () => pageRead.promise;
  chrome.readDisplay = () => chromeRead.promise;
  const first = drawRequest(f, 1600, 800, '00112233445566778899aabb'),
    second = { ...first, witness: { ...first.witness, step: 2 as const } };
  f.contents.emit('did-start-navigation', {}, 'http://localhost/page', false, true);
  f.contents.emit('did-navigate', {}, 'http://localhost/page');
  const draw = () => {
    expect(f.sync(first)).toMatchObject({ ok: true, waiting: true });
    f.owner.frame!(rootDraw(first));
    expect(f.sync(second)).toMatchObject({ ok: true, waiting: true });
    f.owner.frame!(rootDraw(second));
  };
  return { ...f, chrome, pageRead, chromeRead, first, second, draw };
}

function rootReturnDraw(
  receipt: NativeBrowserClosePreparation,
  options: {
    marker?: string | false;
    width?: number;
    height?: number;
    alpha?: number;
    empty?: boolean;
  } = {},
) {
  const width = options.width ?? receipt.width,
    height = options.height ?? receipt.height,
    bytes = Buffer.alloc(width * height * 4, 31),
    alpha = options.alpha ?? 255,
    marker = options.marker ?? receipt.witness;
  for (let offset = 3; offset < bytes.length; offset += 4) bytes[offset] = alpha;
  if (marker !== false) {
    const colors = nativeBrowserWitnessColors({ key: marker, step: 1 }),
      points = nativeBrowserWitnessSamplePoints(receipt.bounds, 1);
    points.forEach((point, index) => {
      if (point.x >= width || point.y >= height) return;
      const offset = (point.y * width + point.x) * 4,
        color = colors[index]!;
      bytes[offset] = color[2]!;
      bytes[offset + 1] = color[1]!;
      bytes[offset + 2] = color[0]!;
      bytes[offset + 3] = alpha;
    });
  }
  return {
    isEmpty: () => options.empty ?? false,
    getSize: () => ({ width, height }),
    toBitmap: () => bytes,
  } as unknown as Electron.NativeImage;
}

async function rootReturnFixture(kind: 'draft' | 'session' = 'draft') {
  const f = kind === 'draft' ? draftRootFixture() : initialRootFixture();
  f.chrome.readDisplay = async () => true;
  f.chrome.autoReady = true;
  f.draw();
  f.contents.emit('dom-ready');
  await new Promise<void>((resolve) => setImmediate(resolve));
  f.pageRead.resolve(new FakeImage(1598, 1200));
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(f.owner.sent.at(-1)?.value).toMatchObject({ id: f.first.id, presented: true });
  expect(f.root!.getBounds()).toEqual({ x: 0, y: 0, width: 801, height: 1200 });
  return { ...f, id: f.first.id, draft: 'draft' in f ? f.draft : undefined };
}

async function prepareRootReturn(f: Awaited<ReturnType<typeof rootReturnFixture>>) {
  const result = await f.invoke({
    action: 'prepareClose',
    id: f.id,
    ...(f.draft ? { draft: f.draft } : {}),
  });
  expect(result).toMatchObject({ ok: true });
  const receipt = (result as { value: NativeBrowserClosePreparation }).value;
  expect(receipt.key).toMatch(/^[a-f0-9]{32}$/);
  expect(receipt.witness).toMatch(/^[a-f0-9]{24}$/);
  expect(receipt).toMatchObject({
    bounds: { x: 801, y: 0, width: 799, height: 100, radius: 0 },
    width: 1600,
    height: 1200,
  });
  expect(f.root!.getBounds()).toEqual({ x: 0, y: 0, width: 1600, height: 1200 });
  expect(f.contents.closes).toBe(0);
  return receipt;
}

function hideRootReturnPresentation(f: Awaited<ReturnType<typeof rootReturnFixture>>) {
  expect(
    f.invoke({
      action: 'present',
      id: f.id,
      bounds: null,
      ...(f.draft ? { draft: f.draft } : { scope: f.scope }),
      presentationRevision: f.second.presentationRevision + 1,
    }),
  ).toMatchObject({ ok: true });
  const shield = views.at(-1)!,
    children = f.window.contentView.children;
  expect(f.view.getVisible()).toBe(true);
  expect(f.contents.destroyed).toBe(false);
  expect(f.contents.closes).toBe(0);
  expect(f.root!.getBounds()).toEqual({ x: 0, y: 0, width: 1600, height: 1200 });
  expect(children.indexOf(f.view as unknown as Electron.View)).toBeLessThan(
    children.indexOf(f.root! as unknown as Electron.View),
  );
  expect(shield).not.toBe(f.view);
  expect(shield.getVisible()).toBe(true);
  expect(shield.getBounds()).toEqual(f.view.getBounds());
  expect(children.indexOf(shield as unknown as Electron.View)).toBeGreaterThan(
    children.indexOf(f.root! as unknown as Electron.View),
  );
  return shield;
}

if (process.platform === 'darwin') {
  for (const kind of ['draft', 'session'] as const)
    test(`Root return closes ${kind} exactly once only after marked and then opaque marker-free full frames`, async () => {
      const f = await rootReturnFixture(kind);
      try {
        let captureId: string | undefined,
          dispatched = 0;
        if (kind === 'session') {
          f.state.phase = 'acquiring';
          await f.page.attach();
          f.state.phase = 'agent';
          f.contents.readMetrics = async () => ({ ...metrics, width: 799, height: 600 });
          f.contents.screenshot = async () => {
            dispatched++;
            return {
              data: Buffer.from(JSON.stringify({ width: 1598, height: 1200 })).toString('base64'),
            };
          };
          await f.page.send('Page.captureScreenshot', { format: 'png' });
          captureId = (f.page.captureMeta() as { metadata: { captureId: string } }).metadata
            .captureId;
          expect(await f.page.validateCapture!(captureId)).toBe(true);
          expect(dispatched).toBe(1);
          f.contents.screenshot = async () => {
            dispatched++;
            return image;
          };
        }
        const receipt = await prepareRootReturn(f),
          shield = hideRootReturnPresentation(f);
        if (captureId) {
          expect(await f.page.validateCapture!(captureId)).toBe(false);
          await expect(f.page.send('Page.captureScreenshot', { format: 'png' })).rejects.toThrow(
            'browser_page_read_stale',
          );
          expect(dispatched).toBe(1);
        }
        expect(await f.asyncLayout(f.second)).toMatchObject({ ok: false });
        expect(f.view.getVisible()).toBe(true);
        expect(shield.getVisible()).toBe(true);
        expect(f.contents.closes).toBe(0);
        let confirmed = false;
        const confirmation = Promise.resolve(
          f.invoke({ action: 'confirmClose', key: receipt.key }),
        ).then((value) => {
          confirmed = true;
          return value;
        });
        const draw = f.owner.frame!;
        expect(typeof draw).toBe('function');
        for (const image of [
          rootReturnDraw(receipt, { marker: false }),
          rootReturnDraw(receipt, { marker: 'f'.repeat(24) }),
          rootReturnDraw(receipt, { width: 1599 }),
          rootReturnDraw(receipt, { empty: true }),
          rootReturnDraw(receipt, { alpha: 0 }),
        ]) {
          draw(image);
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(confirmed).toBe(false);
          expect(f.contents.closes).toBe(0);
        }
        draw(rootReturnDraw(receipt));
        expect(await confirmation).toMatchObject({ ok: true, value: null });
        expect(f.contents.closes).toBe(0);
        expect(f.contents.destroyed).toBe(false);
        expect(f.view.getVisible()).toBe(true);
        let finished = false;
        const finishing = Promise.resolve(
          f.invoke({ action: 'finishClose', key: receipt.key }),
        ).then((value) => {
          finished = true;
          return value;
        });
        for (const image of [
          rootReturnDraw(receipt),
          rootReturnDraw(receipt, { marker: false, width: 1599 }),
          rootReturnDraw(receipt, { marker: false, empty: true }),
          rootReturnDraw(receipt, { marker: false, alpha: 0 }),
        ]) {
          draw(image);
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(finished).toBe(false);
          expect(f.contents.closes).toBe(0);
        }
        draw(rootReturnDraw(receipt, { marker: false }));
        expect(await finishing).toMatchObject({ ok: true, value: null });
        expect(f.contents.closes).toBe(1);
        expect(f.contents.destroyed).toBe(true);
        expect(f.view.getVisible()).toBe(false);
        expect(shield.getVisible()).toBe(false);
        expect(f.window.contentView.children).not.toContain(f.view as unknown as Electron.View);
        expect(f.chrome.finishedRootReturns).toEqual([f.id]);
        draw(rootReturnDraw(receipt));
        draw(rootReturnDraw(receipt, { marker: false }));
        expect(await f.invoke({ action: 'finishClose', key: receipt.key })).toMatchObject({
          ok: false,
        });
        expect(f.contents.closes).toBe(1);
        expect(f.contents.loads).toBe(1);
        expect(f.armed).toEqual([]);
        expect(f.root!.getBounds()).toEqual({ x: 0, y: 0, width: 1600, height: 1200 });
      } finally {
        f.close();
      }
    });

  test('Root return rejects wrong ownership and keys without cancelling an exact pending close', async () => {
    const f = await rootReturnFixture();
    try {
      for (const input of [
        { action: 'prepareClose', id: f.id },
        { action: 'prepareClose', id: f.id, draft: 'f'.repeat(32) },
        { action: 'prepareClose', id: 'missing-page', draft: f.draft },
      ]) {
        const result = await f.invoke(input);
        expect((result as { value?: unknown }).value ?? null).toBeNull();
        expect(f.contents.closes).toBe(0);
      }
      expect(f.chrome.rootReturns).toHaveLength(0);
      const receipt = await prepareRootReturn(f);
      expect(await f.invoke({ action: 'confirmClose', key: 'f'.repeat(32) })).toMatchObject({
        ok: false,
      });
      expect(await f.invoke({ action: 'finishClose', key: 'f'.repeat(32) })).toMatchObject({
        ok: false,
      });
      expect(f.contents.closes).toBe(0);
      const confirmation = f.invoke({ action: 'confirmClose', key: receipt.key });
      f.owner.frame!(rootReturnDraw(receipt));
      expect(await confirmation).toMatchObject({ ok: true, value: null });
      expect(await f.invoke({ action: 'cancelClose', key: receipt.key })).toMatchObject({
        ok: true,
        value: null,
      });
      expect(f.contents.closes).toBe(0);
      expect(f.view.getVisible()).toBe(true);
    } finally {
      f.close();
    }
  });

  for (const phase of ['confirmation', 'clearance'] as const)
    for (const boundary of [
      'cancel',
      'resize',
      'scope',
      'context',
      'Root-frame',
      'Root-epoch',
      'page-token',
      'page-replace',
      'shell-release',
    ] as const)
      test(`Root return ${phase} discards late frames after ${boundary}`, async () => {
        const f = await rootReturnFixture(boundary === 'scope' ? 'session' : 'draft');
        try {
          const receipt = await prepareRootReturn(f),
            shield = hideRootReturnPresentation(f),
            draw = f.owner.frame!,
            confirmation = f.invoke({ action: 'confirmClose', key: receipt.key });
          let pending = confirmation;
          if (phase === 'clearance') {
            draw(rootReturnDraw(receipt));
            expect(await confirmation).toMatchObject({ ok: true, value: null });
            pending = f.invoke({ action: 'finishClose', key: receipt.key });
          }
          let settled = false;
          const result = Promise.resolve(pending).then((value) => {
            settled = true;
            return value;
          });
          let replacement: FakeContents | undefined;
          if (boundary === 'cancel')
            expect(await f.invoke({ action: 'cancelClose', key: receipt.key })).toMatchObject({
              ok: true,
              value: null,
            });
          if (boundary === 'resize') {
            f.contentSize[0] = 1200;
            f.window.emit('resize');
          }
          if (boundary === 'scope') f.selectScope(false);
          if (boundary === 'context') f.chrome.setContext({ ...f.scope });
          if (boundary === 'Root-frame') f.owner.mainFrame = { url: f.owner.mainFrame.url };
          if (boundary === 'Root-epoch')
            f.owner.emit('did-start-navigation', {}, f.owner.mainFrame.url, false, true);
          if (boundary === 'page-token')
            f.contents.emit('did-start-navigation', {}, f.contents.getURL(), false, true);
          if (boundary === 'shell-release') f.chrome.releaseShell(f.id);
          if (boundary === 'page-replace') {
            expect(f.invoke({ action: 'close', id: f.id, draft: f.draft })).toMatchObject({
              ok: true,
            });
            expect(
              f.invoke({
                action: 'navigate',
                id: f.id,
                input: 'https://example.com/',
                draft: f.draft,
              }),
            ).toMatchObject({ ok: true });
            replacement = views.at(-1)!.webContents;
          }
          draw(rootReturnDraw(receipt));
          draw(rootReturnDraw(receipt, { marker: false }));
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(settled).toBe(true);
          expect(await result).toMatchObject({ ok: false });
          expect(f.contents.closes).toBe(boundary === 'page-replace' ? 1 : 0);
          expect(replacement?.closes ?? 0).toBe(0);
          expect(f.chrome.finishedRootReturns).toEqual([]);
          expect(f.view.getVisible()).toBe(false);
          expect(shield.getVisible()).toBe(false);
          expect(await f.asyncLayout(f.second)).toMatchObject({ ok: false });
          f.chrome.announceReady(f.id);
          f.contents.emit('dom-ready');
          draw(rootReturnDraw(receipt));
          draw(rootReturnDraw(receipt, { marker: false }));
          expect(f.view.getVisible()).toBe(false);
          expect(shield.getVisible()).toBe(false);
          expect(f.contents.closes).toBe(boundary === 'page-replace' ? 1 : 0);
          expect(replacement?.closes ?? 0).toBe(0);
          expect(f.contents.loads).toBe(1);
          expect(f.armed).toEqual([]);
        } finally {
          f.close();
        }
      });

  test('Root return cancellation neither closes nor replays, and a new key cannot be completed with the old proof', async () => {
    const f = await rootReturnFixture();
    try {
      const first = await prepareRootReturn(f),
        oldDraw = f.owner.frame!;
      expect(await f.invoke({ action: 'cancelClose', key: first.key })).toMatchObject({
        ok: true,
        value: null,
      });
      expect(f.view.getVisible()).toBe(true);
      expect(f.root!.getBounds().width).toBe(801);
      expect(f.contents.closes).toBe(0);
      const second = await prepareRootReturn(f);
      expect(second.key).not.toBe(first.key);
      expect(second.witness).not.toBe(first.witness);
      let confirmed = false;
      const confirmation = Promise.resolve(
        f.invoke({ action: 'confirmClose', key: second.key }),
      ).then((value) => {
        confirmed = true;
        return value;
      });
      oldDraw(rootReturnDraw(first));
      f.owner.frame!(rootReturnDraw(first));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(confirmed).toBe(false);
      expect(await f.invoke({ action: 'finishClose', key: first.key })).toMatchObject({
        ok: false,
      });
      f.owner.frame!(rootReturnDraw(second));
      expect(await confirmation).toMatchObject({ ok: true, value: null });
      const finishing = f.invoke({ action: 'finishClose', key: second.key });
      expect(await f.invoke({ action: 'cancelClose', key: second.key })).toMatchObject({
        ok: true,
        value: null,
      });
      f.owner.frame?.(rootReturnDraw(second, { marker: false }));
      expect(await finishing).toMatchObject({ ok: false });
      expect(f.contents.closes).toBe(0);
      expect(f.chrome.finishedRootReturns).toEqual([]);
      expect(f.contents.loads).toBe(1);
      expect(f.armed).toEqual([]);
    } finally {
      f.close();
    }
  });
}

if (process.platform === 'darwin') {
  test('first Root handoff cancelled before DOM-ready never reads a later document or creates control', async () => {
    const f = initialRootFixture();
    try {
      f.draw();
      expect(
        f.invoke({
          action: 'present',
          id: 'page',
          bounds: null,
          scope: f.first.scope,
          presentationRevision: f.first.presentationRevision,
        }),
      ).toMatchObject({ ok: true });
      f.contents.emit('dom-ready');
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.contents.captureCalls).toBe(0);
      expect(f.chrome.displayPreparations).toHaveLength(0);
      expect(f.chrome.displayOffers).toHaveLength(0);
      expect(f.chrome.layouts).toHaveLength(0);
      expect(f.presentation).not.toContain(true);
      expect(f.view.getVisible()).toBe(false);
      expect(f.contents.loads).toBe(1);
      expect(f.state.phase).toBe('human');
    } finally {
      f.pageRead.resolve(new FakeImage(0, 0));
      f.chromeRead.resolve(false);
      f.close();
    }
  });

  test('first Root handoff reports an exact failure within the offer deadline when its fresh ACK is lost', async () => {
    const f = initialRootFixture(),
      failure = deferred<unknown>(),
      send = f.owner.send.bind(f.owner);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    f.owner.send = (channel, value) => {
      send(channel, value);
      if (
        channel === nativeBrowserLayoutFrameChannel &&
        (value as { error?: string }).error === 'browser_presentation_unavailable'
      )
        failure.resolve(value);
    };
    try {
      f.draw();
      f.contents.emit('dom-ready');
      await new Promise<void>((resolve) => setImmediate(resolve));
      f.pageRead.resolve(new FakeImage(1598, 1200));
      f.chromeRead.resolve(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.chrome.displayOffers).toHaveLength(1);
      expect(f.presentation).not.toContain(true);
      // The Host mock has no timeout: the controller must independently retire
      // an offered surface whose fresh Root ACK never arrives.
      const result = await Promise.race([
        failure.promise,
        new Promise<null>((resolve) => {
          deadline = setTimeout(() => resolve(null), 1900);
        }),
      ]);
      expect(result).toMatchObject({
        id: 'page',
        scope: f.first.scope,
        key: f.first.witness.key,
        presentationRevision: f.first.presentationRevision,
        step: 2,
        presented: false,
        error: 'browser_presentation_unavailable',
      });
      expect(f.chrome.displayPreparations[0]!.signal.aborted).toBe(true);
      expect(f.chrome.releases.at(-1)).toBe('page');
      expect(f.chrome.layouts).toHaveLength(0);
      expect(f.presentation).not.toContain(true);
      expect(f.view.getVisible()).toBe(false);
      expect(f.root!.getVisible()).toBe(true);
      expect(f.root!.getBounds()).toEqual({ x: 0, y: 0, width: 1600, height: 1200 });
      expect(f.contents.loads).toBe(1);
      expect(f.contents.captureCalls).toBe(1);
    } finally {
      clearTimeout(deadline);
      f.pageRead.resolve(new FakeImage(0, 0));
      f.chromeRead.resolve(false);
      f.close();
    }
  });

  test('first Root handoff cannot offer when only Chrome has a frame', async () => {
    const f = initialRootFixture();
    try {
      f.draw();
      f.contents.emit('dom-ready');
      await new Promise<void>((resolve) => setImmediate(resolve));
      f.chromeRead.resolve(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.contents.captureCalls).toBe(1);
      expect(f.chrome.displayOffers).toHaveLength(0);
      expect(f.chrome.layouts).toHaveLength(0);
      expect(f.presentation).not.toContain(true);
      f.pageRead.resolve(new FakeImage(1598, 1200));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.chrome.displayOffers).toHaveLength(1);
      expect(f.presentation).not.toContain(true);
      f.chrome.ready = true;
      f.chrome.announceReady();
      expect(f.owner.sent.at(-1)?.value).toMatchObject({
        key: f.first.witness.key,
        step: 2,
        presented: true,
      });
      expect(f.contents.captureCalls).toBe(1);
    } finally {
      f.pageRead.resolve(new FakeImage(0, 0));
      f.chromeRead.resolve(false);
      f.close();
    }
  });

  for (const boundary of [
    'hide',
    'page-frame',
    'page-token',
    'navigate',
    'close',
    'scope',
    'resize',
    'Root-reload',
    'dispose',
  ] as const)
    test(`first Root handoff discards late native frames after ${boundary}`, async () => {
      const f = initialRootFixture();
      try {
        f.draw();
        f.contents.emit('dom-ready');
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(f.contents.captureCalls).toBe(1);
        expect(f.chrome.displayPreparations).toHaveLength(1);
        if (boundary === 'hide')
          expect(
            f.invoke({
              action: 'present',
              id: 'page',
              bounds: null,
              scope: f.first.scope,
              presentationRevision: f.first.presentationRevision,
            }),
          ).toMatchObject({ ok: true });
        if (boundary === 'page-frame') f.contents.mainFrame = { url: 'http://localhost/page' };
        if (boundary === 'page-token') f.state.incarnation = 'replacement';
        if (boundary === 'navigate') {
          expect(
            f.invoke({ action: 'navigate', id: 'page', input: 'http://localhost/next' }),
          ).toMatchObject({ ok: true });
          f.contents.emit('did-start-navigation', {}, 'http://localhost/next', false, true);
        }
        if (boundary === 'close')
          expect(f.invoke({ action: 'close', id: 'page' })).toMatchObject({ ok: true });
        if (boundary === 'scope') f.scope.viewSelection++;
        if (boundary === 'resize') {
          f.contentSize[0] = 1200;
          f.window.emit('resize');
        }
        if (boundary === 'Root-reload')
          f.owner.emit('did-start-navigation', {}, 'http://localhost/', false, true);
        if (boundary === 'dispose') f.close();
        const messages = f.owner.sent.length;
        f.pageRead.resolve(new FakeImage(1598, 1200));
        f.chromeRead.resolve(true);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(f.chrome.displayOffers).toHaveLength(0);
        expect(f.chrome.layouts).toHaveLength(0);
        expect(f.presentation).not.toContain(true);
        expect(
          f.owner.sent
            .slice(messages)
            .some(
              (message) =>
                message.channel === nativeBrowserLayoutFrameChannel &&
                (message.value as { presented?: boolean }).presented === true,
            ),
        ).toBe(false);
        expect(f.root!.getVisible()).toBe(true);
        expect(f.root!.getBounds()).toEqual({ x: 0, y: 0, width: f.contentSize[0]!, height: 1200 });
        expect(f.contents.loads).toBe(boundary === 'navigate' ? 2 : 1);
      } finally {
        f.pageRead.resolve(new FakeImage(0, 0));
        f.chromeRead.resolve(false);
        f.close();
      }
    });

  for (const failure of [
    'page-read',
    'empty-page',
    'wrong-page-size',
    'chrome-read',
    'chrome-not-ready',
    'offer',
  ] as const)
    test(`first Root handoff retains its source and reports ${failure} without adoption`, async () => {
      const f = initialRootFixture();
      try {
        f.draw();
        f.contents.emit('dom-ready');
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (failure === 'offer') f.chrome.offerSucceeds = false;
        if (failure === 'page-read') f.pageRead.reject(Error('private capture error'));
        else
          f.pageRead.resolve(
            new FakeImage(
              failure === 'empty-page' ? 0 : failure === 'wrong-page-size' ? 10 : 1598,
              failure === 'empty-page' ? 0 : 1200,
            ),
          );
        if (failure === 'chrome-read') f.chromeRead.reject(Error('private Chrome error'));
        else f.chromeRead.resolve(failure !== 'chrome-not-ready');
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(f.presentation).not.toContain(true);
        expect(f.chrome.layouts).toHaveLength(0);
        expect(f.view.getVisible()).toBe(false);
        expect(f.root!.getVisible()).toBe(true);
        expect(f.root!.getBounds()).toEqual({ x: 0, y: 0, width: 1600, height: 1200 });
        expect(f.owner.sent.at(-1)?.value).toMatchObject({
          id: 'page',
          scope: f.first.scope,
          key: f.first.witness.key,
          presentationRevision: f.first.presentationRevision,
          step: 2,
          presented: false,
          error: 'browser_presentation_unavailable',
        });
        expect(JSON.stringify(f.owner.sent)).not.toContain('private');
        expect(f.contents.loads).toBe(1);
        expect(f.contents.captureCalls).toBe(1);
      } finally {
        f.pageRead.resolve(new FakeImage(0, 0));
        f.chromeRead.resolve(false);
        f.close();
      }
    });
}

if (process.platform === 'darwin')
  test('native-owned resize fences old input and projects the live page within the native callback', async () => {
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
      for (const width of [1500, 1200, 1200, 820, 1000, 1600]) {
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
        const projected = projectNativeBrowserBounds(initial.bounds, initial.layout, width, 1200)!;
        const expected = {
          x: Math.ceil(projected.x),
          y: 100,
          width: Math.floor(projected.x + projected.width) - Math.ceil(projected.x),
          height: 600,
        };
        // No Root resize measurement or paint has run at this point.
        f.window.emit('resize');
        expect(chrome.invalidations).toBe(invalidations + 1);
        expect(f.view.getBounds()).toEqual(expected); // no asynchronous turn is needed
        expect(chrome.layouts.at(-1)).toEqual({ id: 'page', bounds: expected });
        expect(f.view.getVisible()).toBe(true);
        // Even the repeated 1200px event must retire the earlier input basis.
        expect(f.page.captureMeta()).toMatchObject({ metadata: null });
        const layouts = chrome.layouts.length;
        expect(await f.page.validateCapture!(proof.metadata.captureId)).toBe(false);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(f.view.getBounds()).toEqual(expected);
        expect(chrome.layouts).toHaveLength(layouts); // the direct commit was not also queued
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
      // A later native turn cannot revive an explicitly withdrawn page.
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
  test('UI preparation reads only the existing target once, keeps it below its source, and survives real source close until fresh adoption', async () => {
    const f = fixture(true),
      chrome = nativeChrome!,
      read = deferred<FakeImage>();
    try {
      f.state.phase = 'acquiring';
      await f.page.attach();
      const shield = views.at(-1)!;
      f.state.phase = 'human';
      chrome.ready = true;
      f.contents.emit('did-stop-loading');
      const initial = drawRequest(f, 1600, 800, '00112233445566778899aabb');
      expect(f.sync(initial)).toMatchObject({ ok: true });
      expect(
        f.invoke({ action: 'navigate', id: 'other', input: 'http://localhost/other' }),
      ).toMatchObject({ ok: true });
      const target = views.at(-1)!;
      target.webContents.emit('did-stop-loading');
      target.webContents.captureVisible = () => read.promise;
      const loads = target.webContents.loads,
        sourceLoads = f.contents.loads;
      const preparing = f.prepare({ fromId: 'page', targetId: 'other' });
      expect(target.getVisible()).toBe(true);
      expect(f.view.getVisible()).toBe(true);
      expect(shield.getVisible()).toBe(true);
      const children = f.window.contentView.children;
      expect(children.indexOf(target as unknown as Electron.View)).toBeLessThan(
        children.indexOf(f.view as unknown as Electron.View),
      );
      const bounds = target.getBounds();
      read.resolve(new FakeImage(bounds.width * 2, bounds.height * 2));
      const ready = await preparing;
      expect(ready?.key).toMatch(/^[a-f0-9]{32}$/);
      expect(target.webContents.captureCalls).toBe(1);
      target.webContents.readMetrics = async () => ({ ...metrics, ...bounds });
      target.webContents.screenshot = async () => ({
        data: Buffer.from(
          JSON.stringify({ width: bounds.width * 2, height: bounds.height * 2 }),
        ).toString('base64'),
      });
      f.state.phase = 'agent';
      await expect(f.ports.get('other')!.send('Page.captureScreenshot', {})).rejects.toThrow(
        'browser_page_read_stale',
      );
      f.state.phase = 'human';
      expect(f.invoke({ action: 'close', id: 'page' })).toMatchObject({ ok: true });
      expect(f.contents.destroyed).toBe(true);
      expect(f.unregistered).toEqual(['page']);
      expect(f.page.alive()).toBe(false);
      expect(target.getVisible()).toBe(true);
      expect(shield.getVisible()).toBe(true);
      // Electron clears view.webContents after destruction; the original port
      // still owns its captured contents object for exact lease cleanup.
      Object.defineProperty(f.view, 'webContents', { configurable: true, value: undefined });
      f.repaintOnPresent();
      expect(
        f.sync({
          ...initial,
          id: 'other',
          presentationRevision: 2,
          witness: { key: 'ffeeddccbbaa998877665544', step: 1 },
        }),
      ).toMatchObject({ ok: true });
      expect(target.getVisible()).toBe(true);
      expect(shield.getVisible()).toBe(false);
      await f.cancelPreparation(ready!.key);
      expect(target.getVisible()).toBe(true);
      expect(target.webContents.captureCalls).toBe(1);
      expect(target.webContents.loads).toBe(loads);
      expect(f.contents.loads).toBe(sourceLoads);
    } finally {
      read.resolve(new FakeImage(0, 0));
      f.close();
    }
  });

  for (const boundary of [
    'scope',
    'root-frame',
    'resize',
    'target-nav',
    'target-close',
    'cancel',
    'timeout',
    'capture-failure',
  ] as const)
    test(`UI preparation rejects late pixels after ${boundary} without creating, navigating or hiding a later adopted target`, async () => {
      const f = fixture(true),
        chrome = nativeChrome!,
        read = deferred<FakeImage>();
      try {
        f.state.phase = 'acquiring';
        await f.page.attach();
        f.state.phase = 'human';
        chrome.ready = true;
        f.contents.emit('did-stop-loading');
        const initial = drawRequest(f, 1600, 800, '00112233445566778899aabb');
        expect(f.sync(initial)).toMatchObject({ ok: true });
        expect(
          f.invoke({ action: 'navigate', id: 'other', input: 'http://localhost/other' }),
        ).toMatchObject({ ok: true });
        const target = views.at(-1)!;
        target.webContents.emit('did-stop-loading');
        target.webContents.captureVisible = () => read.promise;
        const preparing = f.prepare({ fromId: 'page', targetId: 'other' });
        if (boundary === 'scope') f.scope.generation++;
        if (boundary === 'root-frame') f.owner.mainFrame = { url: 'http://localhost/' };
        if (boundary === 'resize') {
          f.contentSize[0] = 1500;
          f.window.emit('resize');
        }
        if (boundary === 'target-nav')
          target.webContents.emit('did-start-navigation', {}, 'http://localhost/new', false, true);
        if (boundary === 'target-close')
          expect(f.invoke({ action: 'close', id: 'other' })).toMatchObject({ ok: true });
        if (boundary === 'timeout') await Bun.sleep(120);
        if (boundary === 'capture-failure') read.reject(Error('capture failed'));
        else read.resolve(new FakeImage(target.bounds.width * 2, target.bounds.height * 2));
        const result = await preparing;
        if (boundary === 'cancel') {
          expect(result).not.toBeNull();
          await f.cancelPreparation(result!.key);
        } else expect(result).toBeNull();
        expect(target.getVisible()).toBe(false);
        expect(f.view.getVisible()).toBe(true);
        expect(target.webContents.captureCalls).toBe(1);
      } finally {
        read.resolve(new FakeImage(0, 0));
        f.close();
      }
    });

  test('UI preparation denies wrong Root senders, frame ABA, malformed and nonexistent targets without reading pixels', async () => {
    const f = fixture(true);
    try {
      await expect(
        f.prepare({ fromId: 'page', targetId: 'other' }, f.owner.mainFrame, new FakeContents()),
      ).rejects.toThrow('native_sender_denied');
      await expect(
        f.prepare({ fromId: 'page', targetId: 'other' }, { url: 'http://localhost/' }),
      ).rejects.toThrow('native_sender_denied');
      await expect(f.prepare({ fromId: 'page', targetId: 'page', extra: true })).rejects.toThrow(
        'invalid_browser_preparation',
      );
      expect(await f.prepare({ fromId: 'page', targetId: 'missing' })).toBeNull();
      expect(f.contents.captureCalls).toBe(0);
      expect(
        views.filter(
          (view) => view !== f.view && view.webContents.getURL() === 'http://localhost/page',
        ),
      ).toEqual([]);
    } finally {
      f.close();
    }
  });

  test('UI preparation leaves a retained target already below its source attached in its original layer order', async () => {
    const f = fixture(true),
      chrome = nativeChrome!,
      read = deferred<FakeImage>();
    try {
      f.state.phase = 'acquiring';
      await f.page.attach();
      f.state.phase = 'human';
      chrome.ready = true;
      f.contents.emit('did-stop-loading');
      const initial = drawRequest(f, 1600, 800, '00112233445566778899aabb');
      expect(f.sync(initial)).toMatchObject({ ok: true });
      expect(
        f.invoke({ action: 'navigate', id: 'other', input: 'http://localhost/other' }),
      ).toMatchObject({ ok: true });
      const target = views.at(-1)!;
      target.webContents.emit('did-stop-loading');
      target.webContents.captureVisible = () => read.promise;
      const children = f.window.contentView.children;
      f.window.contentView.addChildView(
        target as unknown as Electron.View,
        children.indexOf(f.view as unknown as Electron.View),
      );
      const add = f.window.contentView.addChildView.bind(f.window.contentView),
        additions: Electron.View[] = [];
      f.window.contentView.addChildView = (view, index) => {
        additions.push(view);
        add(view, index);
      };
      const preparing = f.prepare({ fromId: 'page', targetId: 'other' });
      expect(children.indexOf(target as unknown as Electron.View)).toBeLessThan(
        children.indexOf(f.view as unknown as Electron.View),
      );
      expect(additions).not.toContain(target as unknown as Electron.View);
      read.resolve(new FakeImage(target.bounds.width * 2, target.bounds.height * 2));
      expect(await preparing).not.toBeNull();
    } finally {
      read.resolve(new FakeImage(0, 0));
      f.close();
    }
  });

  for (const phase of ['pending', 'ready'] as const)
    test(`UI preparation cancels a ${phase} target whose destroyed native view has cleared its contents getter`, async () => {
      const f = fixture(true),
        chrome = nativeChrome!,
        read = deferred<FakeImage>();
      let target: FakeView | undefined, contents: FakeContents | undefined;
      try {
        f.state.phase = 'acquiring';
        await f.page.attach();
        f.state.phase = 'human';
        chrome.ready = true;
        f.contents.emit('did-stop-loading');
        const initial = drawRequest(f, 1600, 800, '00112233445566778899aabb');
        expect(f.sync(initial)).toMatchObject({ ok: true });
        expect(
          f.invoke({ action: 'navigate', id: 'other', input: 'http://localhost/other' }),
        ).toMatchObject({ ok: true });
        target = views.at(-1)!;
        contents = target.webContents;
        contents.emit('did-stop-loading');
        contents.captureVisible = () => read.promise;
        const preparing = f.prepare({ fromId: 'page', targetId: 'other' });
        const pixels = new FakeImage(target.bounds.width * 2, target.bounds.height * 2);
        let ready: { key: string } | null = null;
        if (phase === 'ready') {
          read.resolve(pixels);
          ready = await preparing;
          expect(ready).not.toBeNull();
        }
        contents.destroyed = true;
        Object.defineProperty(target, 'webContents', { configurable: true, value: undefined });
        expect(() => f.page.changed()).not.toThrow();
        if (ready) await f.cancelPreparation(ready.key);
        else {
          read.resolve(pixels);
          expect(await preparing).toBeNull();
        }
        expect(f.view.getVisible()).toBe(true);
        expect(f.contents.destroyed).toBe(false);
      } finally {
        if (target && contents)
          Object.defineProperty(target, 'webContents', { configurable: true, value: contents });
        read.resolve(new FakeImage(0, 0));
        f.close();
      }
    });

  test('UI preparation enforces its 100ms deadline even before a delayed timer callback runs', async () => {
    const f = fixture(true),
      chrome = nativeChrome!,
      read = deferred<FakeImage>();
    const original = globalThis.setTimeout;
    try {
      f.state.phase = 'acquiring';
      await f.page.attach();
      f.state.phase = 'human';
      chrome.ready = true;
      f.contents.emit('did-stop-loading');
      const initial = drawRequest(f, 1600, 800, '00112233445566778899aabb');
      expect(f.sync(initial)).toMatchObject({ ok: true });
      expect(
        f.invoke({ action: 'navigate', id: 'other', input: 'http://localhost/other' }),
      ).toMatchObject({ ok: true });
      const target = views.at(-1)!;
      target.webContents.emit('did-stop-loading');
      target.webContents.captureVisible = () => read.promise;
      globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
        const [callback, delay, ...parameters] = args;
        return original(callback, delay === 100 ? 1000 : delay, ...parameters);
      }) as typeof setTimeout;
      const preparing = f.prepare({ fromId: 'page', targetId: 'other' });
      await Bun.sleep(120);
      read.resolve(new FakeImage(target.bounds.width * 2, target.bounds.height * 2));
      expect(await preparing).toBeNull();
      expect(target.getVisible()).toBe(false);
      expect(f.view.getVisible()).toBe(true);
      expect(target.webContents.captureCalls).toBe(1);
    } finally {
      globalThis.setTimeout = original;
      read.resolve(new FakeImage(0, 0));
      f.close();
    }
  });

  for (const state of ['pending', 'ready', 'fresh-adopted', 'ready-expired'] as const)
    test(`a repeated UI target has independent cancellation authority after ${state}`, async () => {
      const f = fixture(true),
        chrome = nativeChrome!,
        firstRead = deferred<FakeImage>(),
        nextRead = deferred<FakeImage>();
      try {
        f.state.phase = 'acquiring';
        await f.page.attach();
        f.state.phase = 'human';
        chrome.ready = true;
        f.contents.emit('did-stop-loading');
        const initial = drawRequest(f, 1600, 800, '00112233445566778899aabb');
        expect(f.sync(initial)).toMatchObject({ ok: true });
        expect(
          f.invoke({ action: 'navigate', id: 'other', input: 'http://localhost/other' }),
        ).toMatchObject({ ok: true });
        const target = views.at(-1)!;
        target.webContents.emit('did-stop-loading');
        target.webContents.captureVisible = () => firstRead.promise;
        const first = f.prepare({ fromId: 'page', targetId: 'other' });
        const bounds = target.getBounds(),
          pixels = () => new FakeImage(bounds.width * 2, bounds.height * 2);
        if (state === 'pending') {
          expect(await f.prepare({ fromId: 'page', targetId: 'other' })).toBeNull();
          expect(await first).toBeNull();
          expect(target.webContents.captureCalls).toBe(1);
          firstRead.resolve(pixels());
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(target.getVisible()).toBe(false);
          return;
        }
        if (state === 'fresh-adopted') {
          expect(
            f.sync({
              ...initial,
              id: 'other',
              presentationRevision: 2,
              witness: { key: 'ffeeddccbbaa998877665544', step: 1 },
            }),
          ).toMatchObject({ ok: true });
          expect(await first).toBeNull();
          firstRead.resolve(pixels());
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(target.getVisible()).toBe(true);
          expect(target.webContents.captureCalls).toBe(1);
          return;
        }
        firstRead.resolve(pixels());
        const old = (await first)!;
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (state === 'ready-expired') {
          await Bun.sleep(1530);
          expect(target.getVisible()).toBe(false);
          expect(f.view.getVisible()).toBe(true);
          expect(
            f.sync({
              ...initial,
              id: 'other',
              presentationRevision: 2,
              witness: { key: 'ffeeddccbbaa998877665544', step: 1 },
            }),
          ).toMatchObject({ ok: true });
          await f.cancelPreparation(old.key);
          expect(target.getVisible()).toBe(true);
          return;
        }
        target.webContents.captureVisible = () => nextRead.promise;
        const next = f.prepare({ fromId: 'page', targetId: 'other' });
        await f.cancelPreparation(old.key);
        expect(target.getVisible()).toBe(true);
        nextRead.resolve(pixels());
        const current = (await next)!;
        expect(current.key).not.toBe(old.key);
        await f.cancelPreparation(old.key);
        expect(target.getVisible()).toBe(true);
        expect(
          f.sync({
            ...initial,
            id: 'other',
            presentationRevision: 2,
            witness: { key: 'ffeeddccbbaa998877665544', step: 1 },
          }),
        ).toMatchObject({ ok: true });
        await f.cancelPreparation(current.key);
        expect(target.getVisible()).toBe(true);
        expect(target.webContents.captureCalls).toBe(2);
      } finally {
        firstRead.resolve(new FakeImage(0, 0));
        nextRead.resolve(new FakeImage(0, 0));
        f.close();
      }
    });

  test('same-viewport live handoff keeps the retired old page shielded above the new page until its own full frame is ready', async () => {
    const f = fixture(true),
      chrome = nativeChrome!;
    try {
      f.state.phase = 'acquiring';
      await f.page.attach();
      const shield = views.at(-1)!;
      f.state.phase = 'human';
      chrome.ready = true;
      const initial = drawRequest(f, 1600, 800, '00112233445566778899aabb');
      expect(f.sync(initial)).toMatchObject({ ok: true });
      const before = f.view.getBounds();
      f.contents.readMetrics = async () => ({ ...metrics, ...before });
      f.contents.screenshot = async () => ({
        data: Buffer.from(
          JSON.stringify({ width: before.width * 2, height: before.height * 2 }),
        ).toString('base64'),
      });
      f.state.phase = 'agent';
      await f.page.send('Page.captureScreenshot', {});
      const proof = f.page.captureMeta() as { metadata: { captureId: string } };
      expect(await f.page.validateCapture!(proof.metadata.captureId)).toBe(true);
      f.state.phase = 'human';
      expect(
        f.invoke({ action: 'navigate', id: 'other', input: 'http://localhost/other' }),
      ).toMatchObject({ ok: true });
      const other = views.at(-1)!;
      const read = deferred<FakeImage>();
      other.webContents.captureVisible = () => read.promise;
      chrome.hold = { id: 'page', target: 'other', key: 'hold-one', viewport: f.view.getBounds() };
      const loads = f.contents.loads;
      expect(
        f.invoke({
          action: 'present',
          id: 'page',
          bounds: null,
          scope: initial.scope,
          presentationRevision: 1,
        }),
      ).toMatchObject({ ok: true });
      expect(f.view.getVisible()).toBe(true);
      expect(await f.page.validateCapture!(proof.metadata.captureId)).toBe(false);
      expect(f.presentation.at(-1)).toBe(false);
      expect(shield.getVisible()).toBe(true);
      expect(shield.getBounds()).toEqual(f.view.getBounds());
      let blocked = 0;
      f.contents.emit(
        'before-input-event',
        {
          preventDefault() {
            blocked++;
          },
        },
        { type: 'keyDown', key: 'A' },
      );
      // A before-input-event can also originate in CDP. The native shield and
      // focus guard block human input without dropping the Agent's dispatched key.
      expect(blocked).toBe(0);
      const oldFocusCalls = f.owner.focusCalls;
      f.contents.emit('focus');
      expect(f.owner.focusCalls).toBeGreaterThan(oldFocusCalls);
      expect(await f.asyncLayout(initial)).toMatchObject({ ok: false });
      const order: string[] = [];
      const oldVisible = f.view.setVisible.bind(f.view),
        newVisible = other.setVisible.bind(other);
      f.view.setVisible = (value) => {
        order.push(`old:${value}`);
        oldVisible(value);
      };
      other.setVisible = (value) => {
        order.push(`new:${value}`);
        newVisible(value);
      };
      expect(
        f.sync({ ...initial, id: 'other', witness: { key: 'ffeeddccbbaa998877665544', step: 1 } }),
      ).toMatchObject({ ok: true });
      expect(order.indexOf('new:true')).toBeGreaterThanOrEqual(0);
      expect(order.includes('old:false')).toBe(false);
      expect(f.view.getVisible()).toBe(true);
      expect(other.getVisible()).toBe(true);
      expect(shield.getVisible()).toBe(true);
      const children = f.window.contentView.children;
      expect(children.indexOf(other as unknown as Electron.View)).toBeLessThan(
        children.indexOf(f.view as unknown as Electron.View),
      );
      expect(children.at(-1)).toBe(shield as unknown as Electron.View);
      chrome.announceReady('other');
      expect(other.webContents.captureCalls).toBe(1);
      chrome.endHold('a-retired-key');
      expect(f.view.getVisible()).toBe(true);
      const focusCalls = f.owner.focusCalls;
      other.webContents.emit('focus');
      expect(f.owner.focusCalls).toBeGreaterThan(focusCalls);
      const bounds = other.getBounds();
      read.resolve(new FakeImage(bounds.width * 2, bounds.height * 2));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(order.indexOf('old:false')).toBeGreaterThan(order.indexOf('new:true'));
      expect(f.view.getVisible()).toBe(false);
      expect(other.getVisible()).toBe(true);
      expect(shield.getVisible()).toBe(false);
      expect(f.contents.loads).toBe(loads);
    } finally {
      f.close();
    }
  });

  for (const boundary of [
    'capture-reject',
    'empty-frame',
    'wrong-frame-size',
    'resize',
    'old-nav',
    'new-nav',
    'old-close',
    'new-close',
    'new-crash',
    'root-reload',
    'shield-crash',
    'hold-expiry',
    'ABA',
  ] as const)
    test(`live handoff does not apply its late frame or hide the replacement after ${boundary}`, async () => {
      const f = fixture(true),
        chrome = nativeChrome!;
      const read = deferred<FakeImage>();
      let settled = false;
      try {
        f.state.phase = 'acquiring';
        await f.page.attach();
        const shield = views.at(-1)!;
        f.state.phase = 'human';
        chrome.ready = true;
        const initial = drawRequest(f, 1600, 800, '00112233445566778899aabb');
        expect(f.sync(initial)).toMatchObject({ ok: true });
        expect(
          f.invoke({ action: 'navigate', id: 'other', input: 'http://localhost/other' }),
        ).toMatchObject({ ok: true });
        const other = views.at(-1)!;
        other.webContents.captureVisible = () => read.promise;
        chrome.hold = { id: 'page', target: 'other', key: boundary, viewport: f.view.getBounds() };
        expect(f.present(null)).toMatchObject({ ok: true });
        expect(
          f.sync({
            ...initial,
            id: 'other',
            witness: { key: 'ffeeddccbbaa998877665544', step: 1 },
          }),
        ).toMatchObject({ ok: true });
        const bounds = other.getBounds();
        expect(other.webContents.captureCalls).toBe(1);
        expect(f.view.getVisible()).toBe(true);
        if (boundary === 'capture-reject') {
          read.reject(Error('capture failed'));
          settled = true;
        }
        if (boundary === 'empty-frame') {
          read.resolve(new FakeImage(0, 0));
          settled = true;
        }
        if (boundary === 'wrong-frame-size') {
          read.resolve(new FakeImage(4, 4));
          settled = true;
        }
        if (boundary === 'resize') {
          f.contentSize[0] = 1500;
          f.window.emit('resize');
        }
        if (boundary === 'old-nav')
          f.contents.emit('did-start-navigation', {}, 'http://localhost/new', false, true);
        if (boundary === 'new-nav')
          other.webContents.emit('did-start-navigation', {}, 'http://localhost/new', false, true);
        if (boundary === 'old-close')
          expect(f.invoke({ action: 'close', id: 'page' })).toMatchObject({ ok: true });
        if (boundary === 'new-close')
          expect(f.invoke({ action: 'close', id: 'other' })).toMatchObject({ ok: true });
        if (boundary === 'new-crash') other.webContents.emit('render-process-gone');
        if (boundary === 'root-reload')
          f.owner.emit('did-start-navigation', {}, 'http://localhost/', false, true);
        if (boundary === 'shield-crash') shield.webContents.emit('render-process-gone');
        if (boundary === 'hold-expiry' || boundary === 'ABA') chrome.endHold();
        if (boundary === 'ABA')
          expect(
            f.sync({
              ...initial,
              presentationRevision: 2,
              witness: { key: 'aabbccddeeff998877665544', step: 1 },
            }),
          ).toMatchObject({ ok: true });
        if (!settled) {
          expect(f.view.getVisible()).toBe(boundary === 'ABA');
          read.resolve(new FakeImage(bounds.width * 2, bounds.height * 2));
          settled = true;
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(f.view.getVisible()).toBe(boundary === 'ABA');
        expect(other.webContents.captureCalls).toBe(1);
        expect(chrome.hold).toBeUndefined();
      } finally {
        if (!settled) read.resolve(new FakeImage(0, 0));
        f.close();
      }
    });

  test('live handoff falls back to hide when its native input shield has not finished preparing', () => {
    const f = fixture(true),
      chrome = nativeChrome!;
    f.state.phase = 'human';
    chrome.ready = true;
    try {
      const initial = drawRequest(f, 1600, 800, '00112233445566778899aabb');
      expect(f.sync(initial)).toMatchObject({ ok: true });
      chrome.hold = {
        id: 'page',
        target: 'other',
        key: 'unprepared',
        viewport: f.view.getBounds(),
      };
      expect(f.present(null)).toMatchObject({ ok: true });
      expect(f.view.getVisible()).toBe(false);
    } finally {
      f.close();
    }
  });

  test('a still pending target frame cannot start another read under a new handoff key', async () => {
    const f = fixture(true),
      chrome = nativeChrome!,
      read = deferred<FakeImage>();
    try {
      f.state.phase = 'acquiring';
      await f.page.attach();
      f.state.phase = 'human';
      chrome.ready = true;
      const initial = drawRequest(f, 1600, 800, '00112233445566778899aabb');
      expect(f.sync(initial)).toMatchObject({ ok: true });
      expect(
        f.invoke({ action: 'navigate', id: 'other', input: 'http://localhost/other' }),
      ).toMatchObject({ ok: true });
      const other = views.at(-1)!;
      other.webContents.captureVisible = () => read.promise;
      chrome.hold = { id: 'page', target: 'other', key: 'first', viewport: f.view.getBounds() };
      f.present(null);
      expect(
        f.sync({ ...initial, id: 'other', witness: { key: 'ffeeddccbbaa998877665544', step: 1 } }),
      ).toMatchObject({ ok: true });
      chrome.endHold();
      expect(
        f.sync({
          ...initial,
          presentationRevision: 2,
          witness: { key: 'aabbccddeeff998877665544', step: 1 },
        }),
      ).toMatchObject({ ok: true });
      chrome.hold = { id: 'page', target: 'other', key: 'second', viewport: f.view.getBounds() };
      f.present(null);
      expect(
        f.sync({
          ...initial,
          id: 'other',
          presentationRevision: 2,
          witness: { key: '99887766554433221100aabb', step: 1 },
        }),
      ).toMatchObject({ ok: true });
      expect(other.webContents.captureCalls).toBe(1);
      expect(chrome.hold).toBeUndefined();
      const bounds = other.getBounds();
      read.resolve(new FakeImage(bounds.width * 2, bounds.height * 2));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.view.getVisible()).toBe(false);
      expect(other.getVisible()).toBe(true);
      expect(other.webContents.captureCalls).toBe(1);
    } finally {
      read.resolve(new FakeImage(0, 0));
      f.close();
    }
  });

  test('native resize retains min-constrained allocation history until a fresh Renderer calibration replaces it', () => {
    const f = fixture(true),
      chrome = nativeChrome!;
    f.state.phase = 'human';
    chrome.ready = true;
    try {
      f.contentSize[0] = 1601;
      const initial = drawRequest(f, 1601, 1300, '00112233445566778899aabb');
      initial.layout.groups[0]!.panels[0].min = 360;
      initial.layout.groups[0]!.panels[1].min = 300;
      expect(f.sync(initial)).toMatchObject({ ok: true, waiting: false });
      const loads = f.contents.loads;
      f.contentSize[0] = 1001;
      f.window.emit('resize');
      expect(f.view.getBounds()).toEqual({ x: 701, y: 100, width: 300, height: 600 });
      f.contentSize[0] = 1601;
      f.window.emit('resize');
      expect(f.view.getBounds()).toEqual({ x: 1121, y: 100, width: 480, height: 600 });
      const projected = f.view.getBounds(),
        writes = f.view.boundsWrites.length;
      for (let index = 0; index < 32; index++) f.window.emit('resize');
      expect(f.view.getBounds()).toEqual(projected);
      expect(f.view.boundsWrites).toHaveLength(writes);
      const calibrated = drawRequest(f, 1601, 1200, 'ffeeddccbbaa998877665544');
      calibrated.layout.groups[0]!.panels[0].min = 360;
      calibrated.layout.groups[0]!.panels[1].min = 300;
      expect(f.sync(calibrated)).toMatchObject({ ok: true, waiting: false });
      expect(f.view.getBounds()).toEqual({ x: 1201, y: 100, width: 400, height: 600 });
      f.contentSize[0] = 1801;
      f.window.emit('resize');
      expect(f.view.getBounds()).toEqual({ x: 1351, y: 100, width: 450, height: 600 });
      expect(f.view.getVisible()).toBe(true);
      expect(f.contents.loads).toBe(loads);
      expect(f.contents.destroyed).toBe(false);
    } finally {
      f.close();
    }
  });

  for (const phase of ['prepared', 'preparing'] as const)
    test(`explicit Renderer hide retires the ${phase} layout proof before late Chrome readiness`, async () => {
      const f = fixture(true),
        chrome = nativeChrome!;
      f.state.phase = 'human';
      chrome.ready = phase === 'prepared';
      try {
        const initial = drawRequest(f, 1600, 800, '00112233445566778899aabb');
        initial.presentationRevision = 2;
        expect(f.sync(initial)).toMatchObject({ ok: true, waiting: phase === 'preparing' });
        if (phase === 'prepared')
          expect(f.sync({ ...initial, witness: { ...initial.witness, step: 2 } })).toMatchObject({
            ok: true,
          });
        f.contents.document.value = 'original form input';
        const contents = f.contents,
          url = contents.getURL(),
          loads = contents.loads;
        expect(
          f.invoke({
            action: 'present',
            id: 'page',
            bounds: null,
            scope: initial.scope,
            presentationRevision: initial.presentationRevision,
          }),
        ).toMatchObject({ ok: true });
        expect(f.view.getVisible()).toBe(false);
        const visibility = f.view.visibility.length;
        chrome.ready = true;
        chrome.announceReady();
        expect(f.view.getVisible()).toBe(false);
        expect(f.view.visibility.slice(visibility)).not.toContain(true);
        expect(f.sync({ ...initial, witness: { ...initial.witness, step: 2 } })).toMatchObject({
          ok: false,
        });
        expect(await f.asyncLayout(initial)).toMatchObject({ ok: false });
        chrome.announceReady();
        expect(f.view.getVisible()).toBe(false);
        expect(f.owner.frame).toBeUndefined();
        const fresh = drawRequest(f, 1600, 900, 'ffeeddccbbaa998877665544');
        fresh.presentationRevision = initial.presentationRevision;
        expect(f.sync(fresh)).toMatchObject({ ok: true, waiting: false });
        expect(f.view.getVisible()).toBe(true);
        expect(f.view.getBounds()).toEqual({ x: 901, y: 100, width: 699, height: 600 });
        expect(f.view.webContents).toBe(contents);
        expect(contents.getURL()).toBe(url);
        expect(contents.document.value).toBe('original form input');
        expect(contents.loads).toBe(loads);
        expect(f.page.alive()).toBe(true);
      } finally {
        f.close();
      }
    });

  for (const stale of ['generation', 'revision'] as const)
    test(`a rejected old ${stale} hide cannot retire the current layout proof`, () => {
      const f = fixture(true, 2),
        chrome = nativeChrome!;
      f.state.phase = 'human';
      chrome.ready = true;
      try {
        const current = drawRequest(f, 1600, 800, '00112233445566778899aabb');
        current.presentationRevision = 2;
        expect(f.sync(current)).toMatchObject({ ok: true, waiting: false });
        expect(
          f.invoke({
            action: 'present',
            id: 'page',
            bounds: null,
            scope: { ...current.scope, ...(stale === 'generation' ? { generation: 1 } : {}) },
            presentationRevision: stale === 'revision' ? 1 : current.presentationRevision,
          }),
        ).toMatchObject({ ok: false });
        expect(f.view.getVisible()).toBe(true);
        chrome.suspend();
        expect(f.view.getVisible()).toBe(false);
        chrome.announceReady();
        expect(f.view.getVisible()).toBe(true);
        expect(f.view.getBounds()).toEqual({ x: 801, y: 100, width: 799, height: 600 });
      } finally {
        f.close();
      }
    });

  test('internal Chrome suspension preserves a pending bootstrap proof for its real ready callback', () => {
    const f = fixture(true),
      chrome = nativeChrome!;
    f.state.phase = 'human';
    try {
      const initial = drawRequest(f, 1600, 800, '00112233445566778899aabb');
      expect(f.sync(initial)).toMatchObject({ ok: true, waiting: true });
      const loads = f.contents.loads;
      expect(f.owner.frame).toBeDefined();
      chrome.suspend();
      expect(f.owner.frame).toBeUndefined();
      expect(f.view.getVisible()).toBe(false);
      chrome.ready = true;
      chrome.announceReady();
      expect(f.view.getVisible()).toBe(true);
      expect(f.view.getBounds()).toEqual({ x: 801, y: 100, width: 799, height: 600 });
      expect(f.contents.loads).toBe(loads);
    } finally {
      f.close();
    }
  });

  test('async layout calibrates only an already visible native-hosted page and retains its original document', async () => {
    const f = fixture(true);
    const chrome = nativeChrome!;
    chrome.ready = true;
    f.state.phase = 'human';
    try {
      const initial = drawRequest(f, 1600, 800, '00112233445566778899aabb');
      expect(await f.asyncLayout(initial)).toMatchObject({ ok: false });
      expect(f.view.getVisible()).toBe(false);
      expect(f.sync(initial)).toMatchObject({ ok: true, waiting: false });
      const loads = f.contents.loads;
      const next = drawRequest(f, 1600, 900, 'ffeeddccbbaa998877665544');
      expect(await f.asyncLayout(next)).toMatchObject({ ok: true, waiting: false });
      expect(f.view.getBounds()).toEqual({ x: 901, y: 100, width: 699, height: 600 });
      expect(f.view.getVisible()).toBe(true);
      expect(f.contents.loads).toBe(loads);
      expect(f.contents.destroyed).toBe(false);
      expect(f.owner.frame).toBeUndefined();
      expect(await f.asyncLayout({ ...next, witness: { ...next.witness, step: 2 } })).toMatchObject(
        { ok: true, waiting: false },
      );
      expect(
        await f.asyncLayout({ ...initial, witness: { ...initial.witness, step: 2 } }),
      ).toMatchObject({ ok: false });
      expect(f.view.getBounds().x).toBe(901);
    } finally {
      f.close();
    }
  });

  for (const boundary of [
    'hide',
    'close',
    'scope',
    'root-frame',
    'sender',
    'not-hosted',
    'revision',
    'bounds',
    'window-size',
    'inactive',
  ] as const)
    test(`async layout cannot apply a queued calibration after ${boundary}`, async () => {
      const f = fixture(true);
      const chrome = nativeChrome!;
      chrome.ready = true;
      f.state.phase = 'human';
      try {
        const initial = drawRequest(f, 1600, 800, '00112233445566778899aabb');
        initial.presentationRevision = 2;
        expect(f.sync(initial)).toMatchObject({ ok: true, waiting: false });
        const next = {
          ...drawRequest(f, 1600, 900, 'ffeeddccbbaa998877665544'),
          presentationRevision: 2,
        };
        let frame = f.owner.mainFrame,
          sender = f.owner;
        const delayed = Promise.resolve().then(() => f.asyncLayout(next, frame, sender));
        if (boundary === 'hide') f.present(null);
        if (boundary === 'close') f.invoke({ action: 'close', id: 'page' });
        if (boundary === 'scope') f.scope.viewSelection++;
        if (boundary === 'root-frame') frame = { url: f.owner.mainFrame.url };
        if (boundary === 'sender') sender = f.contents;
        if (boundary === 'not-hosted') chrome.ready = false;
        if (boundary === 'revision') next.presentationRevision = 1;
        if (boundary === 'bounds') {
          next.bounds.x += 40;
          next.presentationRevision = 3;
        }
        if (boundary === 'window-size') {
          f.contentSize[0] = 1400;
          next.presentationRevision = 3;
        }
        if (boundary === 'inactive') {
          f.invoke({ action: 'navigate', id: 'other', input: 'http://localhost/other' });
          expect(f.sync({ ...initial, id: 'other' })).toMatchObject({ ok: true, waiting: false });
        }
        const bounds = f.view.getBounds(),
          writes = f.view.boundsWrites.length,
          visibility = f.view.visibility.length,
          layouts = chrome.layouts.length;
        expect(await delayed).toMatchObject({ ok: false });
        expect(f.view.getBounds()).toEqual(bounds);
        expect(f.view.boundsWrites).toHaveLength(writes);
        expect(f.view.visibility.slice(visibility)).not.toContain(true);
        expect(chrome.layouts).toHaveLength(layouts);
        expect(f.contents.destroyed).toBe(boundary === 'close');
        if (boundary === 'bounds')
          expect(
            await f.asyncLayout({ ...initial, witness: { ...initial.witness, step: 2 } }),
          ).toMatchObject({ ok: true, waiting: false });
        if (boundary === 'window-size')
          expect(
            await f.asyncLayout({
              ...drawRequest(f, 1400, 700, '8899aabbccddeeff00112233'),
              presentationRevision: 2,
            }),
          ).toMatchObject({ ok: true, waiting: false });
      } finally {
        f.close();
      }
    });

  test('disposing removes the async layout handler and a previously queued callback cannot restore its page', async () => {
    const f = fixture(true);
    const chrome = nativeChrome!;
    chrome.ready = true;
    f.state.phase = 'human';
    const initial = drawRequest(f, 1600, 800, '00112233445566778899aabb');
    expect(f.sync(initial)).toMatchObject({ ok: true, waiting: false });
    expect(f.asyncLayoutRegistered()).toBe(true);
    const delayed = Promise.resolve().then(() => f.asyncLayout(initial));
    f.close();
    expect(f.asyncLayoutRegistered()).toBe(false);
    expect(await delayed).toMatchObject({ ok: false });
    expect(f.contents.destroyed).toBe(true);
  });

  test('prepared native resize cancels queued bootstrap work and shares its output with matching calibration', async () => {
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
      chrome.ready = false;
      f.window.emit('resize');
      expect(f.view.getBounds()).toEqual({ x: 801, y: 100, width: 800, height: 600 });
      expect(writes().every((value) => value.bounds === 0)).toBe(true);
      // An unprepared event is pending; the prepared callback must replace it,
      // rather than leave a second layout behind in the next event-loop turn.
      chrome.ready = true;
      f.window.emit('resize');
      expect(f.view.getBounds()).toEqual({ x: 601, y: 100, width: 600, height: 600 });
      expect(shield.getBounds()).toEqual(f.view.getBounds());
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
      const layouts = chrome.layouts.length;
      const viewportSyncs = chrome.viewportSyncs;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(writes()).toEqual(afterSync);
      expect(chrome.layouts).toHaveLength(layouts);
      expect(chrome.viewportSyncs).toBe(viewportSyncs);
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

  test('unprepared resize defers viewport synchronization while applying the current input policy immediately', async () => {
    const f = fixture(true);
    const chrome = nativeChrome!;
    chrome.ready = true;
    try {
      f.state.phase = 'acquiring';
      await f.page.attach();
      f.state.phase = 'agent';
      const initial = drawRequest(f, 1600, 800, '00112233445566778899aabb');
      expect(f.sync(initial)).toMatchObject({ ok: true, waiting: false });
      const shield = views.at(-1)!;
      expect(shield.getVisible()).toBe(true);
      const bounds = f.view.getBounds();
      const layouts = chrome.layouts.length;
      const viewportSyncs = chrome.viewportSyncs;
      const loads = f.contents.loads;
      chrome.ready = false;
      f.state.phase = 'human';
      f.contentSize[0] = 1200;
      f.window.emit('resize');
      expect(shield.getVisible()).toBe(false);
      expect(f.view.getBounds()).toEqual(bounds);
      expect(chrome.layouts).toHaveLength(layouts);
      expect(chrome.viewportSyncs).toBe(viewportSyncs);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(chrome.viewportSyncs).toBe(viewportSyncs + 1);
      expect(f.view.getBounds()).toEqual(bounds);
      expect(f.view.getVisible()).toBe(true);
      expect(shield.getVisible()).toBe(false);
      expect(f.contents.loads).toBe(loads);
      expect(f.page.alive()).toBe(true);
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
        chrome.ready = false;
        const invalidations = chrome.invalidations;
        const beforeResize = f.view.getBounds();
        f.window.emit('resize');
        expect(chrome.invalidations).toBe(invalidations + 1);
        expect(f.view.getBounds()).toEqual(beforeResize);
        chrome.ready = true;
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
