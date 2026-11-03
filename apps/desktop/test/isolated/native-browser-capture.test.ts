import { expect, mock, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import type { BrowserPagePort, NativeBrowserPageHost } from '../../electron/browser-page-host';
import {
  type NativeBrowserBounds,
  type NativeBrowserLayout,
  type NativeBrowserMenuRequest,
  type NativeBrowserRestoreResult,
  type NativeBrowserState,
  nativeBrowserChannel,
  nativeBrowserLayoutChannel,
  nativeBrowserMenuCancelChannel,
  nativeBrowserMenuChannel,
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
let contentsSequence = 0;
const views: FakeView[] = [];
const windowOwners = new WeakMap<FakeContents, BrowserWindow>();
class FakeContents extends EventEmitter {
  readonly id = ++contentsSequence;
  actualUrl = 'http://localhost/page';
  destroyed = false;
  zoom = 1;
  attached = true;
  mainFrame: { url: string; processId?: number; routingId?: number } = { url: 'http://localhost/' };
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
    if (this.subscriptionError) throw this.subscriptionError;
    this.frameOnlyDirty = typeof onlyDirty === 'boolean' ? onlyDirty : undefined;
    const receive = typeof onlyDirty === 'function' ? onlyDirty : callback!;
    this.frame = (image, dirty) => receive(image, dirty ?? { x: 0, y: 0, ...image.getSize() });
    this.frameCallbacks.push(this.frame);
  }
  endFrameSubscription() {
    this.subscriptionEnds++;
    this.frame = undefined;
  }
  invalidations = 0;
  autoPresentationFrame = true;
  nativeSurface = false;
  backgroundThrottling = true;
  getBackgroundThrottling() {
    return this.backgroundThrottling;
  }
  setBackgroundThrottling(value: boolean) {
    this.backgroundThrottling = value;
  }
  nativeVisible: () => boolean = () => true;
  invalidateError?: Error;
  frameImage?: () => Electron.NativeImage;
  subscriptionError?: Error;
  subscriptionEnds = 0;
  lastCaptureImage?: Electron.NativeImage;
  invalidate() {
    this.invalidations++;
    if (this.invalidateError) throw this.invalidateError;
    if (this.autoPresentationFrame && this.frameImage && this.nativeVisible()) {
      const frame = this.frame,
        image = this.frameImage();
      queueMicrotask(() => {
        this.nativeSurface = true;
        frame?.(image);
      });
    }
  }
  setWindowOpenHandler() {}
  getURL() {
    return this.actualUrl;
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
  reloads = 0;
  reload() {
    this.reloads++;
  }
  stop() {
    this.stops++;
  }
  captureCalls = 0;
  captureVisible: () => Promise<Electron.NativeImage> = async () => {
    const bytes = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
    bytes.writeUInt32BE(1600, 16);
    bytes.writeUInt32BE(1200, 20);
    return {
      toPNG: () => bytes,
      getSize: () => ({ width: 1600, height: 1200 }),
      isEmpty: () => false,
    } as Electron.NativeImage;
  };
  readonly captureArguments: unknown[][] = [];
  async capturePage(...args: unknown[]) {
    this.captureCalls++;
    this.captureArguments.push(args);
    if (!this.nativeSurface) throw Error('Current display surface not available for capture');
    const image = await this.captureVisible();
    this.lastCaptureImage = image as Electron.NativeImage;
    return image;
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
class FakePlainView {
  visible = false;
  readonly visibility: boolean[] = [];
  bounds = { x: 0, y: 0, width: 0, height: 0 };
  readonly boundsWrites: Electron.Rectangle[] = [];
  readonly radiusWrites: number[] = [];
  readonly backgrounds: string[] = [];
  setBackgroundBlur(_radius: number) {}
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
  setBackgroundColor(color: string) {
    this.backgrounds.push(color);
  }
}
class FakeView extends FakePlainView {
  readonly webContents = new FakeContents();
  readonly options: { webPreferences?: Record<string, unknown> };
  constructor(options: { webPreferences?: Record<string, unknown> } = {}) {
    super();
    this.options = options;
    this.webContents.nativeVisible = () => this.visible;
    views.push(this);
  }
}
class FakeWindow extends EventEmitter {
  destroyed = false;
  visible = false;
  minimized = false;
  readonly size = [1600, 1200];
  readonly contentView = {
    children: [] as FakePlainView[],
    addChildView: (view: FakePlainView, index?: number) => {
      const children = this.contentView.children,
        old = children.indexOf(view);
      if (old >= 0) children.splice(old, 1);
      children.splice(index ?? children.length, 0, view);
      if (view instanceof FakeView)
        windowOwners.set(view.webContents, this as unknown as BrowserWindow);
    },
    removeChildView: (view: FakePlainView) => {
      const children = this.contentView.children,
        old = children.indexOf(view);
      if (old >= 0) children.splice(old, 1);
      if (view instanceof FakeView) windowOwners.delete(view.webContents);
    },
  };
  isDestroyed() {
    return this.destroyed;
  }
  isVisible() {
    return this.visible;
  }
  isMinimized() {
    return this.minimized;
  }
  getContentSize() {
    return this.size;
  }
  getBounds() {
    return { x: 0, y: 0, width: this.size[0]!, height: this.size[1]! };
  }
  setBackgroundColor() {}
  show() {
    this.visible = true;
    this.emit('show');
  }
  hide() {
    this.visible = false;
    this.emit('hide');
  }
  setTitle() {}
  destroy() {
    this.destroyed = true;
    this.emit('closed');
  }
}
const backingScale = 1;
let popupTemplate: Electron.MenuItemConstructorOptions[] = [],
  popupOptions: Electron.PopupOptions | undefined;
let popupCloses = 0;
let deferPopupClose = false;
let popupBuildError: Error | undefined;
const pendingPopupCloses: (() => void)[] = [];
mock.module('electron', () => ({
  BrowserWindow: {
    fromWebContents: (contents: FakeContents) => windowOwners.get(contents) ?? null,
  },
  Menu: {
    buildFromTemplate(template: Electron.MenuItemConstructorOptions[]) {
      if (popupBuildError) throw popupBuildError;
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
  BaseWindow: FakeWindow,
  WebContentsView: FakeView,
  View: FakePlainView,
  screen: { getDisplayMatching: () => ({ scaleFactor: backingScale }) },
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
const { registerNativeBrowserIpc } = await import('../../electron/native-browser');
const { createNativeRootWindow, getNativeRootView, nativeRootWillShowEvent } = await import(
  '../../electron/native-root-window'
);
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const bounds = { x: 10, y: 100, width: 800, height: 600, radius: 0 };
function nativeFrame(width: number, height: number): Electron.NativeImage {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return {
    getSize: () => ({ width, height }),
    isEmpty: () => !width || !height,
    toPNG: () => bytes,
  } as Electron.NativeImage;
}
function fixture(
  config: { initialPage?: boolean; ready?: boolean; automation?: boolean; draft?: string } = {},
) {
  views.length = 0;
  let page!: BrowserPagePort;
  const presentation: boolean[] = [];
  const unregistered: string[] = [],
    armed: string[] = [];
  const ports = new Map<string, BrowserPagePort>();
  let selected = true,
    revision = 0,
    repaintOnPresent = false;
  const state = {
    phase: 'human',
    navigation: 0,
    incarnation: 'incarnation',
    browserId: 'browser',
    sessionId: 'session',
  };
  const scope = { storeId: 'store', sessionId: 'session', generation: 1, viewSelection: 1 };
  const controlStates = new Map([['page', state]]);
  const automation = {
    assertCanCreate() {},
    configureGrantContext: () => () => {},
    state: (id: string) => (ports.has(id) ? { ...controlStates.get(id)! } : undefined),
    arm(id: string) {
      armed.push(id);
    },
    add(port: BrowserPagePort) {
      page = port;
      if (!controlStates.has(port.id)) controlStates.set(port.id, { ...state, navigation: 0 });
      ports.set(port.id, port);
      return () => {
        ports.delete(port.id);
        unregistered.push(port.id);
      };
    },
    fail(id: string) {
      const current = controlStates.get(id)!;
      current.phase = 'unknown';
      ports.get(id)?.changed();
    },
    navigate(id: string) {
      controlStates.get(id)!.navigation++;
      ports.get(id)?.changed();
    },
    retained(id: string) {
      return controlStates.get(id)?.phase !== 'human';
    },
    present(id: string, visible: boolean) {
      presentation.push(visible);
      if (repaintOnPresent) ports.get(id)?.changed();
    },
  } as unknown as NativeBrowserPageHost;
  const rootWindow = createNativeRootWindow({ show: false, backgroundColor: '#191919' });
  const root = getNativeRootView(rootWindow)! as unknown as FakeView;
  const nativeWindow = rootWindow as unknown as FakeWindow;
  const window = rootWindow as unknown as BrowserWindow;
  const owner = rootWindow.webContents as unknown as FakeContents;
  owner.mainFrame = { url: 'http://localhost/' };
  const contentSize = nativeWindow.size;
  root.setVisible(true);
  nativeWindow.show();
  // Page/shield inventory remains independent of the actual application Root.
  views.splice(views.indexOf(root), 1);
  const events = new Map<string, (event: Electron.IpcMainEvent, input: unknown) => void>();
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => unknown>();
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
    ...(config.automation === false ? {} : { automation }),
    selectedScope: () => (selected ? scope : undefined),
    rendererUrl: 'http://localhost/',
  });
  const invokeFromFrame = (input: unknown, frame = owner.mainFrame, sender = owner) =>
    handlers.get(nativeBrowserChannel)!(
      { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent,
      input,
    );
  const invoke = (input: unknown) => invokeFromFrame(input);
  const pageState = (id = 'page') =>
    (
      invoke({ action: 'state', id, ...(config.draft ? { draft: config.draft } : {}) }) as {
        value: NativeBrowserState;
      }
    ).value;
  const pageView = (id: string) =>
    views.find((view) => pageState(id)?.pageToken?.includes(`,${view.webContents.id},`))!;
  const completeDocument = (view: FakeView, url = view.webContents.actualUrl, start = true) => {
    const contents = view.webContents;
    contents.actualUrl = url;
    if (start) contents.emit('did-start-navigation', {}, url, false, true);
    contents.emit('did-navigate', {}, url);
    contents.emit('dom-ready');
    contents.loadingMain = false;
    contents.emit('did-stop-loading');
  };
  const setupFrame = (view: FakeView) => {
    view.webContents.captureVisible = async () =>
      nativeFrame(view.bounds.width * 2, view.bounds.height * 2);
    view.webContents.frameImage = () => nativeFrame(view.bounds.width * 2, view.bounds.height * 2);
  };
  if (config.initialPage !== false) {
    expect(
      invoke({
        action: 'navigate',
        id: 'page',
        input: 'http://localhost/page',
        ...(config.draft ? { draft: config.draft } : {}),
      }),
    ).toMatchObject({ ok: true });
    const view = views.at(-1)!;
    setupFrame(view);
    if (config.ready !== false) completeDocument(view);
    else view.webContents.emit('did-start-navigation', {}, view.webContents.actualUrl, false, true);
    state.navigation = 0;
    state.phase = 'agent';
    page?.changed();
  }
  const layoutRequest = (
    id: string,
    bounds: NativeBrowserBounds | null,
    layout?: NativeBrowserLayout,
  ) => ({
    action: 'present' as const,
    id,
    bounds,
    ...(layout ? { layout } : {}),
    ...(config.draft ? { draft: config.draft } : { scope: { ...scope } }),
    pageToken: pageState(id)?.pageToken,
    presentationRevision: ++revision,
  });
  const presentFor = (
    id: string,
    bounds: NativeBrowserBounds | null,
    layout?: NativeBrowserLayout,
  ) => invoke(layoutRequest(id, bounds, layout));
  const present = (bounds: NativeBrowserBounds | null, layout?: NativeBrowserLayout) =>
    presentFor('page', bounds, layout);
  return {
    invoke,
    invokeFromFrame,
    pageState,
    pageView,
    completeDocument,
    setupFrame,
    layoutRequest,
    presentFor,
    sync(input: unknown, frame = owner.mainFrame, sender = owner) {
      const event = {
        sender,
        senderFrame: frame,
        returnValue: undefined,
      } as unknown as Electron.IpcMainEvent;
      events.get(nativeBrowserLayoutChannel)!(event, input);
      return event.returnValue;
    },
    asyncLayout: (input: unknown, frame = owner.mainFrame, sender = owner) =>
      handlers.get(nativeBrowserLayoutChannel)!(
        { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent,
        input,
      ),
    asyncLayoutRegistered: () => handlers.has(nativeBrowserLayoutChannel),
    menu: (input: unknown, frame = owner.mainFrame, sender = owner) =>
      handlers.get(nativeBrowserMenuChannel)!(
        { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent,
        input,
      ),
    cancelMenu: (id: string) =>
      events.get(nativeBrowserMenuCancelChannel)!(
        { sender: owner, senderFrame: owner.mainFrame } as unknown as Electron.IpcMainEvent,
        id,
      ),
    scope,
    get page() {
      return page;
    },
    state,
    get contents() {
      return views[0]!.webContents;
    },
    get view() {
      return views[0]!;
    },
    window,
    root,
    aboveRoot(view = views[0]!) {
      return (
        view.visible &&
        window.contentView.children.indexOf(view as unknown as Electron.View) >
          window.contentView.children.indexOf(root as unknown as Electron.View)
      );
    },
    contentSize,
    owner,
    presentation,
    unregistered,
    ports,
    armed,
    present,
    close,
    windowEvent(event: 'hide' | 'show' | 'minimize' | 'restore' | 'focus') {
      if (event === 'hide' || event === 'minimize') nativeWindow.visible = false;
      if (event === 'show' || event === 'restore') nativeWindow.visible = true;
      if (event === 'minimize') nativeWindow.minimized = true;
      if (event === 'restore') nativeWindow.minimized = false;
      window.emit(event);
    },
    selectScope(value: boolean) {
      selected = value;
    },
    repaintOnPresent() {
      repaintOnPresent = true;
    },
    async show(bounds: NativeBrowserBounds, layout?: NativeBrowserLayout, id = 'page') {
      if (config.automation !== false && state.phase === 'agent' && views.length === 1) {
        state.phase = 'acquiring';
        await ports.get(id)!.attach();
        state.phase = 'agent';
      }
      const response = presentFor(id, bounds, layout);
      await turn();
      return response;
    },
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

test('a failed navigation publishes bounded human-readable metadata without granting document readiness or copying pixels', async () => {
  const f = fixture();
  f.state.phase = 'human';
  const failed = 'http://localhost/unavailable';
  try {
    f.contents.emit('did-start-navigation', {}, failed, false, true);
    f.contents.actualUrl = failed;
    f.contents.mainFrame = { url: failed, processId: 41, routingId: 7 };
    f.present(bounds);
    await turn();
    f.contents.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', failed, true, 41, 7);
    expect(f.view.visible).toBe(false);
    f.contents.emit('dom-ready');
    await turn();
    expect(f.pageState()).toMatchObject({
      url: failed,
      error: 'load_failed',
      display: 'failed',
      loading: false,
      failure: { kind: 'connection', code: 'ERR_CONNECTION_REFUSED' },
    });
    expect(f.aboveRoot()).toBe(false);
    f.state.phase = 'agent';
    expect(await f.page.waitForDocument!(new AbortController().signal)).toBe(false);
    expect(f.page.captureMeta()).toMatchObject({ metadata: null });
    f.state.phase = 'human';
    expect(f.contents.frameCallbacks).toHaveLength(0);
    expect(f.contents.captureCalls).toBe(0);
    const loads = f.contents.loads;
    f.invoke({ action: 'reload', id: 'page' });
    expect(f.contents.reloads).toBe(1);
    expect(f.pageState().failure).toBeUndefined();
    f.contents.emit('did-start-navigation', {}, failed, false, true);
    expect(f.view.visible).toBe(false);
    f.contents.mainFrame = { url: failed, processId: 42, routingId: 8 };
    f.completeDocument(f.view, failed, false);
    await f.show(bounds);
    expect(f.pageState().error).toBeUndefined();
    expect(f.aboveRoot()).toBe(true);
    f.state.phase = 'agent';
    expect(await f.page.waitForDocument!(new AbortController().signal)).toBe(true);
    expect(f.contents.loads).toBe(loads);
  } finally {
    f.close();
  }
});

for (const [code, description, kind] of [
  [-105, 'ERR_NAME_NOT_RESOLVED', 'dns'],
  [-106, 'ERR_INTERNET_DISCONNECTED', 'offline'],
  [-118, 'ERR_CONNECTION_TIMED_OUT', 'timeout'],
  [-202, 'ERR_CERT_AUTHORITY_INVALID', 'certificate'],
  [-107, 'ERR_SSL_PROTOCOL_ERROR', 'secure_connection'],
  [-379, 'ERR_HTTP_RESPONSE_CODE_FAILURE', 'other'],
  [-2, 'private stack\n and logs', 'other'],
] as const)
  test(`native load failure ${code} publishes only its bounded reason and code`, () => {
    const f = fixture(),
      url = 'http://localhost/failed';
    try {
      f.contents.emit('did-start-navigation', {}, url, false, true);
      f.contents.mainFrame = { url, processId: 41, routingId: 7 };
      f.contents.emit('did-fail-load', {}, code, description, url, true, 41, 7);
      expect(f.pageState().failure).toEqual({
        kind,
        ...(description.startsWith('ERR_') ? { code: description } : {}),
      });
      expect(f.view.visible).toBe(false);
    } finally {
      f.close();
    }
  });

for (const stale of ['url', 'frame', 'subframe', 'aborted'] as const)
  test(`a ${stale} failure cannot poison the current document`, async () => {
    const f = fixture();
    f.state.phase = 'human';
    const url = 'http://localhost/unavailable';
    try {
      f.contents.emit('did-start-navigation', {}, url, false, true);
      f.contents.actualUrl = url;
      f.contents.mainFrame = { url, processId: 41, routingId: 7 };
      f.contents.emit(
        'did-fail-load',
        {},
        stale === 'aborted' ? -3 : -102,
        'failure',
        stale === 'url' ? 'http://localhost/old' : url,
        stale !== 'subframe',
        stale === 'frame' ? 40 : 41,
        7,
      );
      f.contents.emit('dom-ready');
      await f.show(bounds);
      expect(f.aboveRoot()).toBe(false);
      expect(f.pageState().display).not.toBe('ready');
      expect(f.pageState().error).toBeUndefined();
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

test('capture rejects an in-flight viewport size change but accepts an equal-size position change', async () => {
  for (const changed of [true, false]) {
    const f = fixture();
    try {
      await f.show({ x: 10, y: 20, width: 800, height: 600, radius: 8 });
      const entered = deferred<void>(),
        gate = deferred<void>();
      f.contents.screenshot = async () => {
        entered.resolve();
        await gate.promise;
        return image;
      };
      const pending = f.page.send('Page.captureScreenshot', {}).catch((error: Error) => error);
      await entered.promise;
      await f.show({ x: 20, y: 30, width: changed ? 801 : 800, height: 600, radius: 8 });
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
    await f.show({ x: 10, y: 20, width: 800, height: 600, radius: 8 });
    await f.page.send('Page.captureScreenshot', {});
    const proof = f.page.captureMeta();
    await f.show({ x: 30, y: 40, width: 800, height: 600, radius: 8 });
    expect(f.page.captureMeta()).toEqual(proof);
    await f.show({ x: 30, y: 40, width: 800, height: 601, radius: 8 });
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

test('retired display-snapshot requests cannot read pixels or withdraw the real page', async () => {
  const f = fixture();
  f.state.phase = 'human';
  try {
    await f.show(bounds);
    const reads = f.contents.captureCalls;
    for (const request of [
      { action: 'capturePresentation', id: 'page' },
      { action: 'present', id: 'page', bounds: null, presentationKey: 'old-display-snapshot' },
      { ...f.layoutRequest('page', null), presentationKey: 'old-display-snapshot' },
    ]) {
      expect(await f.invoke(request)).toMatchObject({ ok: false, code: 'invalid_browser_request' });
      expect(f.view.visible).toBe(true);
      expect(f.contents.captureCalls).toBe(reads);
      expect(f.contents.closes).toBe(0);
    }
  } finally {
    f.close();
  }
});

test('the actual PageHost observer capture retains its independent bounded JPEG path without publishing model coordinate proof', async () => {
  const f = fixture();
  try {
    f.contents.nativeSurface = true;
    f.contents.captureVisible = async () =>
      new FakeImage(1600, 1200) as unknown as Electron.NativeImage;
    const observed = (await f.page.capture()) as {
      frame: { mimeType: string; data: string; width: number; height: number };
      annotations: unknown[];
      url: string;
      title: string;
    };
    expect(observed).toMatchObject({
      frame: { mimeType: 'image/jpeg', width: 1440, height: 1080 },
      annotations: [],
      url: f.contents.getURL(),
      title: 'Local page',
    });
    expect(JSON.parse(Buffer.from(observed.frame.data, 'base64').toString())).toEqual({
      width: 1440,
      height: 1080,
      format: 'jpeg',
      quality: 35,
    });
    expect(f.contents.captureCalls).toBe(1);
    expect(f.view.visible).toBe(false);
    expect(f.page.captureMeta()).toEqual({ metadata: null, navigation: 0 });
    expect(f.armed).toEqual([]);
  } finally {
    f.close();
  }
});

test('real model screenshot coordinates are rejected by the input proof check after a page scroll during capture', async () => {
  const f = fixture(),
    entered = deferred<void>(),
    release = deferred<void>();
  let scrollY = 100;
  try {
    f.contents.readMetrics = async () => ({ ...metrics, y: scrollY });
    f.contents.screenshot = async () => {
      entered.resolve();
      await release.promise;
      return image;
    };
    const capture = f.page.send('Page.captureScreenshot', {}).catch((error: Error) => error);
    await entered.promise;
    scrollY = 101;
    release.resolve();
    expect(await capture).toHaveProperty('data');
    const proof = f.page.captureMeta() as { metadata: { captureId: string } };
    expect(proof.metadata.captureId).toEqual(expect.any(String));
    expect(await f.page.validateCapture!(proof.metadata.captureId)).toBe(false);
    expect(f.contents.loads).toBe(1);
  } finally {
    release.resolve();
    f.close();
  }
});

for (const boundary of ['withdraw', 'hide', 'owner', 'close'] as const)
  test(`a stale native menu after ${boundary} cancels without a popup and a current successor can still open`, async () => {
    const f = fixture(),
      bounds = { x: 50, y: 60, width: 800, height: 600, radius: 8 };
    f.state.phase = 'human';
    try {
      await f.show(bounds);
      const request: NativeBrowserMenuRequest = {
        requestId: 'stale-lifecycle-menu',
        id: 'page',
        scope: { ...f.scope },
        incarnation: 'incarnation',
        navigation: 0,
        x: 850,
        y: 60,
        details: [],
        items: [{ action: 'reload', enabled: true }],
      };
      const template = popupTemplate,
        options = popupOptions,
        loads = f.contents.loads;
      if (boundary === 'withdraw') f.present(null);
      if (boundary === 'hide') f.windowEvent('hide');
      if (boundary === 'owner') f.scope.viewSelection++;
      if (boundary === 'close')
        f.invoke({ action: 'close', id: 'page', pageToken: f.pageState().pageToken });
      expect(await f.menu(request)).toBeNull();
      expect(popupTemplate).toBe(template);
      expect(popupOptions).toBe(options);
      expect(f.contents.loads).toBe(loads);
      expect(f.contents.stops).toBe(0);
      expect(f.state.navigation).toBe(0);
      expect(f.armed).toEqual([]);
      if (boundary === 'hide') f.windowEvent('show');
      const id = boundary === 'close' ? 'successor' : 'page';
      if (boundary === 'close')
        expect(f.invoke({ action: 'navigate', id, input: 'http://localhost/page' })).toMatchObject({
          ok: true,
        });
      expect(await f.show(bounds, undefined, id)).toMatchObject({ ok: true });
      const response = f.menu({
        ...request,
        requestId: 'current-successor-menu',
        id,
        scope: { ...f.scope },
      });
      expect(popupTemplate).not.toBe(template);
      expect(popupTemplate.map((row) => row.label)).toEqual(['刷新网页']);
      popupTemplate[0]!.click!({} as Electron.MenuItem, f.window, {} as Electron.KeyboardEvent);
      popupOptions!.callback!();
      expect(await response).toBe('reload');
      expect(f.contents.loads).toBe(loads); // Returning a menu choice executes no page action itself.
      expect(f.armed).toEqual([]);
    } finally {
      f.close();
    }
  });

test('native menus still reject invalid senders, malformed requests and actual native failures', async () => {
  const f = fixture();
  f.state.phase = 'human';
  const request: NativeBrowserMenuRequest = {
    requestId: 'strict-menu',
    id: 'page',
    scope: { ...f.scope },
    incarnation: 'incarnation',
    navigation: 0,
    x: 850,
    y: 60,
    details: [],
    items: [{ action: 'reload', enabled: true }],
  };
  try {
    await f.show({ x: 50, y: 60, width: 800, height: 600, radius: 8 });
    const template = popupTemplate;
    await expect(f.menu(request, f.owner.mainFrame, f.contents)).rejects.toThrow(
      'native_sender_denied',
    );
    await expect(f.menu(request, { url: f.owner.mainFrame.url })).rejects.toThrow(
      'native_sender_denied',
    );
    await expect(f.menu({ ...request, x: -1 })).rejects.toThrow('invalid_browser_request');
    expect(popupTemplate).toBe(template);
    popupBuildError = Error('native menu construction failed');
    await expect(f.menu(request)).rejects.toThrow('native menu construction failed');
    expect(popupTemplate).toBe(template);
    expect(f.contents.loads).toBe(1);
    expect(f.contents.stops).toBe(0);
    expect(f.armed).toEqual([]);
  } finally {
    popupBuildError = undefined;
    f.close();
  }
});

test('native menu stays over the same page and returns only an enabled current action', async () => {
  const f = fixture();
  try {
    f.state.phase = 'human';
    await f.show({ x: 50, y: 60, width: 800, height: 600, radius: 8 });
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
    await f.show({ x: 50, y: 60, width: 800, height: 600, radius: 8 });
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
    await f.show({ x: 50, y: 60, width: 800, height: 600, radius: 8 });
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

test.skipIf(process.platform !== 'win32')(
  'Windows paints the seam and grip with the accepted page geometry without adding an input surface',
  async () => {
    const f = fixture();
    f.state.phase = 'human';
    const panel = {
      size: 0,
      min: 0,
      minUnit: 'px',
      max: 100,
      maxUnit: '%',
      preserve: 'relative',
      collapsible: false,
    } as const;
    const layout: NativeBrowserLayout = {
      windowWidth: 1600,
      windowHeight: 1200,
      insetLeft: 1,
      insetRight: 1,
      groups: [
        {
          left: 0,
          right: 0,
          gap: 1,
          panels: [
            { ...panel, size: 599 },
            { ...panel, size: 1000 },
          ],
        },
      ],
      frame: {
        top: 38,
        bottom: 6,
        width: 1,
        color: [255, 255, 255, 0.08],
        grip: {
          left: -1,
          width: 3,
          height: 28,
          color: [181, 181, 181, 0.55],
          visible: true,
        },
      },
    };
    const bounds = { x: 601, y: 100, width: 998, height: 1094, radius: 0 };
    const decorations = () =>
      (f.window.contentView.children as unknown as FakePlainView[]).filter(
        (v) => !(v instanceof FakeView),
      );
    try {
      await f.show(bounds, layout);
      const [seam, grip] = decorations();
      expect(decorations()).toHaveLength(2);
      expect(seam!.visible).toBe(true);
      expect(seam!.bounds).toEqual({ x: 600, y: 38, width: 1, height: 1156 });
      expect(grip!.bounds.x).toBe(599);
      expect(grip!.visible).toBe(true);
      expect(seam!.radiusWrites).toEqual([]); // Tiny native strips must not be clipped away.
      const retired = f.layoutRequest('page', bounds, layout);
      const nextLayout = {
        ...layout,
        groups: [
          {
            ...layout.groups[0]!,
            panels: [
              { ...panel, size: 549 },
              { ...panel, size: 1050 },
            ] as const,
          },
        ],
      };
      expect(
        f.sync(f.layoutRequest('page', { ...bounds, x: 551, width: 1048 }, nextLayout)),
      ).toMatchObject({ ok: true });
      expect(Math.abs(f.view.bounds.x - 551)).toBeLessThanOrEqual(1);
      expect([seam!.bounds.x, grip!.bounds.x]).toEqual([f.view.bounds.x - 1, f.view.bounds.x - 2]);
      const accepted = [seam!.bounds.x, grip!.bounds.x, f.view.bounds.x];
      f.sync(retired);
      expect([seam!.bounds.x, grip!.bounds.x, f.view.bounds.x]).toEqual(accepted);
      f.contentSize[0] = 1800;
      f.window.emit('resize');
      expect(f.view.bounds.x - seam!.bounds.x).toBeGreaterThanOrEqual(1);
      expect(f.view.bounds.x - seam!.bounds.x).toBeLessThanOrEqual(2);
      expect(grip!.bounds.x).toBe(seam!.bounds.x - 1);
      expect(views).toHaveLength(1);
      expect(f.contents.loads).toBe(1);
      expect(f.contents.captureCalls).toBe(0);
      f.windowEvent('hide');
      expect(decorations().every((v) => !v.visible)).toBe(true);
      f.sync(retired);
      expect(decorations().every((v) => !v.visible)).toBe(true);
    } finally {
      f.close();
    }
    expect(decorations()).toEqual([]);
  },
);

for (const previous of [true, false])
  for (const outcome of ['ready', 'cancelled', 'failed'] as const)
    test.skipIf(process.platform !== 'win32')(
      `Windows first-frame preparation restores background throttling=${previous} after ${outcome}`,
      async () => {
        const f = fixture();
        f.contents.backgroundThrottling = previous;
        f.contents.autoPresentationFrame = false;
        try {
          f.present(bounds);
          await turn();
          expect(f.contents.backgroundThrottling).toBe(false);
          expect(f.aboveRoot()).toBe(false);
          const late = f.contents.frame!;
          if (outcome === 'ready') {
            late(nativeFrame(1600, 1200));
            await turn();
            expect(f.pageState().display).toBe('ready');
          } else if (outcome === 'cancelled') {
            f.present(null);
          } else {
            f.contents.emit('did-fail-load', {}, -105, 'failed', f.contents.getURL(), true);
          }
          expect(f.contents.backgroundThrottling).toBe(previous);
          late(nativeFrame(1600, 1200));
          await turn();
          expect(f.contents.backgroundThrottling).toBe(previous);
          if (outcome !== 'ready') expect(f.aboveRoot()).toBe(false);
          expect(f.contents.captureCalls).toBe(0);
        } finally {
          f.close();
        }
      },
    );

test('a hidden new page really has no capture surface, but a full native frame under Root promotes the exact committed document', async () => {
  const f = fixture({ ready: false });
  f.state.phase = 'human';
  f.contents.autoPresentationFrame = false;
  try {
    await expect(f.contents.capturePage()).rejects.toThrow(
      'Current display surface not available for capture',
    );
    const copies = f.contents.captureCalls;
    expect(f.present(bounds)).toMatchObject({ ok: true });
    expect(f.view.visible).toBe(false);
    expect(f.aboveRoot()).toBe(false);
    expect(f.root.bounds).toEqual({ x: 0, y: 0, width: 1600, height: 1200 });
    expect(f.pageState().display).toBe('loading');
    expect(f.presentation).not.toContain(true);
    f.contents.emit('did-finish-load');
    f.contents.emit('dom-ready');
    await turn();
    expect(f.contents.frameCallbacks).toHaveLength(0);
    f.completeDocument(f.view, 'https://example.test/form', false);
    await turn();
    expect(f.contents.frameCallbacks).toHaveLength(1);
    expect(f.view.visible).toBe(true);
    expect(f.contents.frameOnlyDirty).toBe(false);
    expect(f.contents.invalidations).toBe(1);
    expect(f.aboveRoot()).toBe(false);
    expect(f.page.captureMeta()).toEqual({ metadata: null, navigation: 0 });
    f.contents.frame!(nativeFrame(1600, 1200));
    await turn();
    expect(f.aboveRoot()).toBe(true);
    expect(f.pageState().display).toBe('ready');
    expect(f.contents.frame).toBeUndefined();
    expect(f.contents.captureCalls).toBe(copies);
    expect(f.page.captureMeta()).toEqual({ metadata: null, navigation: 0 });
    expect(f.armed).toEqual([]);
    expect(f.contents.loads).toBe(1);
  } finally {
    f.close();
  }
});

for (const invalid of ['empty', 'small', 'wrong-aspect'] as const)
  test(`a ${invalid} native frame cannot promote the page, while the next complete current frame can`, async () => {
    const f = fixture();
    f.state.phase = 'human';
    f.contents.autoPresentationFrame = false;
    try {
      f.present(bounds);
      await turn();
      const receive = f.contents.frame!;
      expect(typeof receive).toBe('function');
      receive(
        invalid === 'empty'
          ? nativeFrame(0, 0)
          : invalid === 'small'
            ? nativeFrame(799, 600)
            : nativeFrame(1600, 1000),
      );
      await turn();
      expect(f.aboveRoot()).toBe(false);
      expect(f.pageState().display).toBe('loading');
      expect(f.contents.frame).toBe(receive);
      receive(nativeFrame(1600, 1200));
      await turn();
      expect(f.aboveRoot()).toBe(true);
      expect(f.pageState().display).toBe('ready');
      expect(f.contents.captureCalls).toBe(0);
      expect(f.page.captureMeta()).toEqual({ metadata: null, navigation: 0 });
    } finally {
      f.close();
    }
  });

test('native frame subscription failure withdraws its underlay without replay or automatic retry', async () => {
  const f = fixture();
  f.state.phase = 'human';
  f.contents.subscriptionError = Error('native frame observer unavailable');
  try {
    f.present(bounds);
    await turn();
    expect(f.pageState().display).toBe('failed');
    expect(f.view.visible).toBe(false);
    expect(f.contents.captureCalls).toBe(0);
    f.window.emit('resize');
    f.present(bounds);
    await turn();
    expect(f.contents.frameCallbacks).toHaveLength(0);
    expect(f.contents.loads).toBe(1);
    expect(f.contents.stops).toBe(0);
    expect(f.armed).toEqual([]);
  } finally {
    f.close();
  }
});

test('the first native frame has a finite deadline and its late callback cannot resurrect its underlay', async () => {
  const f = fixture();
  f.state.phase = 'human';
  f.contents.autoPresentationFrame = false;
  try {
    f.present(bounds);
    await turn();
    const old = f.contents.frame!;
    expect(typeof old).toBe('function');
    expect(f.aboveRoot()).toBe(false);
    expect(f.invoke({ action: 'stop', id: 'page' })).toMatchObject({ ok: true });
    expect(f.contents.stops).toBe(1);
    await Bun.sleep(2050);
    expect(f.pageState().display).toBe('failed');
    expect(f.view.visible).toBe(false);
    expect(f.contents.frame).toBeUndefined();
    old(nativeFrame(1600, 1200));
    await turn();
    expect(f.view.visible).toBe(false);
    expect(f.pageState().display).toBe('failed');
    expect(f.contents.captureCalls).toBe(0);
    expect(f.contents.loads).toBe(1);
  } finally {
    f.close();
  }
});

test('an uncommitted first document has a finite display deadline and late DOM-ready cannot start its native frame observer', async () => {
  const f = fixture({ ready: false });
  f.state.phase = 'human';
  try {
    f.present(bounds);
    await turn();
    expect(f.contents.frameCallbacks).toHaveLength(0);
    expect(f.aboveRoot()).toBe(false);
    expect(f.pageState().display).toBe('loading');
    await Bun.sleep(12050);
    expect(f.pageState().display).toBe('failed');
    expect(f.view.visible).toBe(false);
    f.completeDocument(f.view, 'https://example.test/late', false);
    await turn();
    expect(f.contents.frameCallbacks).toHaveLength(0);
    expect(f.contents.captureCalls).toBe(0);
    expect(f.view.visible).toBe(false);
    expect(f.pageState().display).toBe('failed');
    expect(f.invoke({ action: 'stop', id: 'page' })).toMatchObject({ ok: true });
    expect(f.contents.stops).toBe(1);
  } finally {
    f.close();
  }
}, 15000);

test('a drawable real document cannot authorize human input when its Agent input shield is absent', async () => {
  const f = fixture();
  try {
    f.present(bounds);
    await turn();
    expect(f.pageState().display).toBe('ready');
    expect(f.view.visible).toBe(false);
    expect(f.page.captureMeta()).toEqual({ metadata: null, navigation: 0 });
    expect(f.armed).toEqual([]);
    f.state.phase = 'acquiring';
    await f.page.attach();
    f.state.phase = 'agent';
    f.present(bounds);
    const shield = views.at(-1)!;
    expect(f.aboveRoot()).toBe(true);
    expect(shield.visible).toBe(true);
    expect(shield.bounds).toEqual(f.view.bounds);
    expect(f.window.contentView.children.at(-1)).toBe(shield as unknown as Electron.View);
    expect(f.contents.captureCalls).toBe(0);
    expect(f.contents.frameCallbacks).toHaveLength(1);
  } finally {
    f.close();
  }
});

for (const boundary of [
  'withdraw',
  'window-hide',
  'minimize',
  'scope',
  'navigation',
  'root',
  'close',
  'same-id-successor',
] as const)
  test(`a first native frame arriving after ${boundary} cannot promote the old page or mutate its successor`, async () => {
    const f = fixture();
    f.state.phase = 'human';
    f.contents.autoPresentationFrame = false;
    try {
      const original = f.view,
        contents = f.contents,
        originalToken = f.pageState().pageToken;
      f.present(bounds);
      await turn();
      const old = contents.frame!;
      expect(typeof old).toBe('function');
      if (boundary === 'withdraw') f.present(null);
      if (boundary === 'window-hide') f.windowEvent('hide');
      if (boundary === 'minimize') f.windowEvent('minimize');
      if (boundary === 'scope') {
        f.scope.viewSelection++;
        f.window.emit('resize');
      }
      if (boundary === 'navigation')
        contents.emit('did-start-navigation', {}, 'https://example.test/new', false, true);
      if (boundary === 'root') {
        f.owner.mainFrame = { url: 'http://localhost/' };
        f.owner.emit('did-start-navigation', {}, 'http://localhost/', false, true);
      }
      if (boundary === 'close' || boundary === 'same-id-successor')
        expect(f.invoke({ action: 'close', id: 'page', pageToken: originalToken })).toMatchObject({
          ok: true,
        });
      if (boundary === 'same-id-successor') {
        expect(
          f.invoke({ action: 'navigate', id: 'page', input: 'https://example.test/new' }),
        ).toMatchObject({ ok: true });
        const next = views.at(-1)!;
        f.setupFrame(next);
        f.completeDocument(next, 'https://example.test/new');
        f.present(bounds);
        await turn();
        expect(f.aboveRoot(next)).toBe(true);
      }
      old(nativeFrame(1600, 1200));
      await turn();
      expect(original.visible).toBe(false);
      expect(contents.captureCalls).toBe(0);
      expect(contents.loads).toBe(1);
      expect(f.armed).toEqual([]);
      if (boundary === 'same-id-successor') {
        const next = views.at(-1)!;
        expect(f.aboveRoot(next)).toBe(true);
        expect(next.webContents.closes).toBe(0);
        expect(f.pageState().display).toBe('ready');
      }
    } finally {
      f.close();
    }
  });

test('old geometry cannot end its successor subscription and only the current full frame may promote the page', async () => {
  const f = fixture();
  f.state.phase = 'human';
  f.contents.autoPresentationFrame = false;
  try {
    f.present(bounds);
    await turn();
    const old = f.contents.frame!;
    f.present({ ...bounds, width: 600 });
    await turn();
    const latest = f.contents.frame!;
    expect(latest).not.toBe(old);
    expect(f.contents.frameCallbacks).toHaveLength(2);
    const ended = f.contents.subscriptionEnds;
    old(nativeFrame(1600, 1200));
    await turn();
    expect(f.contents.frame).toBe(latest);
    expect(f.contents.subscriptionEnds).toBe(ended);
    expect(f.aboveRoot()).toBe(false);
    expect(f.pageState().display).toBe('loading');
    latest(nativeFrame(1200, 1200));
    await turn();
    expect(f.aboveRoot()).toBe(true);
    expect(f.view.bounds.width).toBe(600);
    expect(f.pageState().display).toBe('ready');
    expect(f.contents.frame).toBeUndefined();
    expect(f.contents.captureCalls).toBe(0);
    expect(f.page.captureMeta()).toEqual({ metadata: null, navigation: 0 });
  } finally {
    f.close();
  }
});

for (const missing of ['hidden', 'cropped', 'absent'] as const)
  test(`a ${missing} Root cannot authorize a first-page underlay or native frame observer`, async () => {
    const f = fixture();
    f.state.phase = 'human';
    try {
      if (missing === 'hidden') f.root.setVisible(false);
      if (missing === 'cropped') f.root.setBounds({ ...f.root.bounds, width: 800 });
      if (missing === 'absent')
        f.window.contentView.removeChildView(f.root as unknown as Electron.View);
      f.present(bounds);
      await turn();
      expect(f.view.visible).toBe(false);
      expect(f.contents.frameCallbacks).toHaveLength(0);
      expect(f.pageState().display).toBe('failed');
      expect(f.contents.captureCalls).toBe(0);
      expect(f.armed).toEqual([]);
      expect(f.contents.loads).toBe(1);
    } finally {
      f.close();
    }
  });

for (const boundary of [
  'root-hidden',
  'root-cropped',
  'root-absent',
  'root-below-page',
  'page-frame',
] as const)
  test(`a full native frame after ${boundary} cannot bypass the current Root cover or document identity`, async () => {
    const f = fixture();
    f.state.phase = 'human';
    f.contents.autoPresentationFrame = false;
    try {
      f.present(bounds);
      await turn();
      const old = f.contents.frame!;
      expect(typeof old).toBe('function');
      expect(f.view.visible).toBe(true);
      expect(f.aboveRoot()).toBe(false);
      if (boundary === 'root-hidden') f.root.setVisible(false);
      if (boundary === 'root-cropped') f.root.setBounds({ ...f.root.bounds, width: 800 });
      if (boundary === 'root-absent')
        f.window.contentView.removeChildView(f.root as unknown as Electron.View);
      if (boundary === 'root-below-page')
        f.window.contentView.addChildView(f.root as unknown as Electron.View, 0);
      if (boundary === 'page-frame')
        f.contents.mainFrame = { url: 'https://example.test/successor' };
      old(nativeFrame(1600, 1200));
      await turn();
      expect(f.view.visible).toBe(false);
      expect(f.contents.frame).toBeUndefined();
      expect(f.pageState().display).toBe('failed');
      expect(f.contents.captureCalls).toBe(0);
      expect(f.armed).toEqual([]);
      expect(f.contents.loads).toBe(1);
    } finally {
      f.close();
    }
  });

test('native invalidate failure ends only its own subscription and withdraws the prepared underlay', async () => {
  const f = fixture();
  f.state.phase = 'human';
  f.contents.invalidateError = Error('native invalidate failed');
  try {
    f.present(bounds);
    await turn();
    expect(f.contents.frameCallbacks).toHaveLength(1);
    expect(f.contents.subscriptionEnds).toBe(1);
    expect(f.contents.frame).toBeUndefined();
    expect(f.view.visible).toBe(false);
    expect(f.pageState().display).toBe('failed');
    expect(f.contents.captureCalls).toBe(0);
    expect(f.contents.loads).toBe(1);
  } finally {
    f.close();
  }
});

test('a provider-only selection change cancels the old underlay without poisoning its original page on return', async () => {
  const f = fixture();
  f.state.phase = 'human';
  f.contents.autoPresentationFrame = false;
  try {
    f.contents.document.value = 'unsent original A';
    const originalFrame = f.contents.mainFrame,
      originalPage = f.view;
    f.present(bounds);
    await turn();
    const old = f.contents.frame!;
    expect(typeof old).toBe('function');
    expect(f.aboveRoot()).toBe(false);
    expect(f.pageState().display).toBe('loading');
    // Only the authority provider changes. No Renderer withdrawal or native
    // resize gets a chance to cancel the old observer before its frame arrives.
    f.scope.sessionId = 'session-b';
    f.scope.viewSelection++;
    old(nativeFrame(1600, 1200));
    await turn();
    const cancelledDisplay = f.pageState().display;
    expect(f.contents.frame).toBeUndefined();
    expect(f.aboveRoot()).toBe(false);
    expect(f.contents.mainFrame).toBe(originalFrame);
    expect(f.contents.document.value).toBe('unsent original A');
    expect(f.contents.loads).toBe(1);
    expect(f.contents.closes).toBe(0);
    f.scope.sessionId = 'session';
    f.scope.viewSelection++;
    expect(f.present(bounds)).toMatchObject({ ok: true });
    await turn();
    // A cancellation belongs to the old display attempt. The exact original
    // document must be allowed to prepare under this fresh selection/revision.
    expect(cancelledDisplay).not.toBe('failed');
    expect(f.contents.frameCallbacks).toHaveLength(2);
    const current = f.contents.frame!;
    expect(current).not.toBe(old);
    current(nativeFrame(1600, 1200));
    await turn();
    expect(f.view).toBe(originalPage);
    expect(f.contents.mainFrame).toBe(originalFrame);
    expect(f.contents.document.value).toBe('unsent original A');
    expect(f.pageState().display).toBe('ready');
    expect(f.aboveRoot()).toBe(true);
    expect(f.contents.loads).toBe(1);
    expect(f.contents.closes).toBe(0);
    expect(f.contents.captureCalls).toBe(0);
    expect(f.armed).toEqual([]);
  } finally {
    f.close();
  }
});

for (const transport of ['sync', 'async', 'request'] as const)
  test(`the ${transport} layout stream rejects old page tokens, stale revisions, old Root frames and noncurrent scope`, async () => {
    const f = fixture();
    f.state.phase = 'human';
    try {
      await f.show(bounds);
      const send = async (input: unknown, frame = f.owner.mainFrame, sender = f.owner) =>
        transport === 'sync'
          ? f.sync(input, frame, sender)
          : transport === 'async'
            ? f.asyncLayout(input, frame, sender)
            : f.invokeFromFrame(input, frame, sender);
      const first = f.layoutRequest('page', bounds);
      expect(await send(first)).toMatchObject({ ok: true });
      for (const invalid of [
        { ...first, pageToken: 'same-url-is-not-the-page', presentationRevision: 1000 },
        { ...first, pageToken: undefined, presentationRevision: 1000 },
        { ...first, scope: { ...f.scope, sessionId: 'other' }, presentationRevision: 1000 },
        { ...first, scope: { ...f.scope, viewSelection: 100 }, presentationRevision: 1000 },
        { ...first, bounds: null },
        { ...first, presentationRevision: first.presentationRevision - 1 },
      ]) {
        expect(await send(invalid)).toMatchObject({ ok: false });
        expect(f.view.visible).toBe(true);
        expect(f.view.bounds).toEqual({
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
        });
      }
      expect(
        await send({ ...first, presentationRevision: 999 }, { url: f.owner.mainFrame.url }),
      ).toMatchObject({ ok: false });
      expect(
        await send({ ...first, presentationRevision: 999 }, f.owner.mainFrame, f.contents),
      ).toMatchObject({ ok: false });
      const hide = f.layoutRequest('page', null);
      expect(await send(hide)).toMatchObject({ ok: true });
      expect(f.view.visible).toBe(false);
      expect(await send(first)).toMatchObject({ ok: false });
      expect(f.view.visible).toBe(false);
      expect(f.contents.loads).toBe(1);
      expect(f.contents.closes).toBe(0);
      expect(f.armed).toEqual([]);
    } finally {
      f.close();
    }
  });

test('missing-page positive layouts are refused while exact cleanup remains harmless', async () => {
  const f = fixture({ initialPage: false });
  try {
    const children = [...f.window.contentView.children];
    for (const transport of ['sync', 'async', 'request'] as const) {
      const send = (input: unknown) =>
        transport === 'sync'
          ? f.sync(input)
          : transport === 'async'
            ? f.asyncLayout(input)
            : f.invoke(input);
      expect(
        await send({ ...f.layoutRequest('missing-page', bounds), pageToken: 'retired-page-token' }),
      ).toMatchObject({
        ok: false,
        code: 'browser_page_scope_denied',
      });
      expect(
        await send({ ...f.layoutRequest('missing-page', null), pageToken: 'retired-page-token' }),
      ).toEqual({ ok: true, value: null });
      expect(f.window.contentView.children).toEqual(children);
      expect(views).toHaveLength(0);
      expect(f.presentation).toEqual([]);
    }
  } finally {
    f.close();
  }
});

test('retained page switches show the exact target before hiding the source in either direction', async () => {
  const f = fixture();
  f.state.phase = 'human';
  const a = f.view;
  try {
    await f.show(bounds);
    expect(
      f.invoke({ action: 'navigate', id: 'page-b', input: 'https://example.test/b' }),
    ).toMatchObject({ ok: true });
    const b = views.at(-1)!;
    f.setupFrame(b);
    f.completeDocument(b, 'https://example.test/b');
    await f.show(bounds, undefined, 'page-b');
    const aFrame = a.webContents.mainFrame,
      bFrame = b.webContents.mainFrame,
      visibility: { id: string; visible: boolean }[] = [];
    a.webContents.document.value = 'retained A';
    b.webContents.document.value = 'retained B';
    const setA = a.setVisible.bind(a),
      setB = b.setVisible.bind(b);
    const spyA = spyOn(a, 'setVisible').mockImplementation((visible) => {
        visibility.push({ id: 'a', visible });
        setA(visible);
      }),
      spyB = spyOn(b, 'setVisible').mockImplementation((visible) => {
        visibility.push({ id: 'b', visible });
        setB(visible);
      });
    try {
      expect(f.present(bounds)).toMatchObject({
        ok: true,
        value: { id: 'page', display: 'ready' },
      });
      expect(visibility).toEqual([
        { id: 'a', visible: true },
        { id: 'b', visible: false },
      ]);
      expect(a.visible).toBe(true);
      expect(b.visible).toBe(false);
      visibility.length = 0;
      expect(f.presentFor('page-b', bounds)).toMatchObject({
        ok: true,
        value: { id: 'page-b', display: 'ready' },
      });
      expect(visibility).toEqual([
        { id: 'b', visible: true },
        { id: 'a', visible: false },
      ]);
      expect(a.visible).toBe(false);
      expect(b.visible).toBe(true);
      expect(a.webContents.mainFrame).toBe(aFrame);
      expect(b.webContents.mainFrame).toBe(bFrame);
      expect(a.webContents.document.value).toBe('retained A');
      expect(b.webContents.document.value).toBe('retained B');
      for (const view of [a, b]) {
        expect(view.webContents.loads).toBe(1);
        expect(view.webContents.closes).toBe(0);
        expect(view.webContents.frameCallbacks).toHaveLength(1);
      }
    } finally {
      spyA.mockRestore();
      spyB.mockRestore();
    }
  } finally {
    f.close();
  }
});

test('drawable A and B retain their sibling order through switching, restore and resize while first frames still promote', async () => {
  const f = fixture();
  f.state.phase = 'human';
  const a = f.view,
    addChild = spyOn(f.window.contentView, 'addChildView');
  a.webContents.autoPresentationFrame = false;
  try {
    expect(f.present(bounds)).toMatchObject({ ok: true });
    await turn();
    expect(f.aboveRoot(a)).toBe(false);
    addChild.mockClear();
    a.webContents.frame!(nativeFrame(1600, 1200));
    await turn();
    expect(f.aboveRoot(a)).toBe(true);
    expect(addChild.mock.calls.map(([view, index]) => [view === (a as unknown), index])).toEqual([
      [true, 1],
    ]);
    expect(
      f.invoke({ action: 'navigate', id: 'page-b', input: 'https://example.test/same' }),
    ).toMatchObject({ ok: true });
    const b = views.at(-1)!;
    f.setupFrame(b);
    b.webContents.autoPresentationFrame = false;
    f.completeDocument(b, 'https://example.test/same');
    expect(f.presentFor('page-b', bounds)).toMatchObject({ ok: true });
    await turn();
    expect(f.aboveRoot(b)).toBe(false);
    addChild.mockClear();
    b.webContents.frame!(nativeFrame(1600, 1200));
    await turn();
    expect(f.aboveRoot(b)).toBe(true);
    expect(addChild.mock.calls.map(([view, index]) => [view === (b as unknown), index])).toEqual([
      [true, 1],
    ]);
    // B's first frame has legitimately placed it above Root, leaving the already
    // drawable A above B. Hidden siblings do not require A to become adjacent.
    const stableOrder = [...f.window.contentView.children],
      aFrame = a.webContents.mainFrame,
      bFrame = b.webContents.mainFrame;
    expect(stableOrder).toEqual([f.root, b, a] as unknown as Electron.View[]);
    a.webContents.document.value = 'original A';
    b.webContents.document.value = 'original B';
    addChild.mockClear();

    await f.show(bounds);
    expect(a.visible).toBe(true);
    expect(b.visible).toBe(false);
    f.present(null);
    expect(a.visible).toBe(false);
    await f.show(bounds);
    f.windowEvent('hide');
    expect(a.visible).toBe(true); // The hidden parent holds the exact native child off-screen.
    expect(f.presentation.at(-1)).toBe(false);
    f.windowEvent('show');
    expect(a.visible).toBe(false);
    await f.show(bounds);
    f.contentSize.splice(0, 2, 1800, 1300);
    f.window.emit('resize');
    expect(a.visible).toBe(true);
    expect(f.present({ ...bounds, width: 900, height: 700 })).toMatchObject({ ok: true });
    await f.show(bounds, undefined, 'page-b');
    expect(a.visible).toBe(false);
    expect(b.visible).toBe(true);
    await f.show(bounds);
    expect(a.visible).toBe(true);
    expect(b.visible).toBe(false);
    expect(
      addChild.mock.calls
        .filter(([view]) => view === (a as unknown) || view === (b as unknown))
        .map(([view, index]) => ({ page: view === (a as unknown) ? 'A' : 'B', index })),
    ).toEqual([]);
    expect(f.window.contentView.children).toEqual(stableOrder);
    expect(a.webContents.mainFrame).toBe(aFrame);
    expect(b.webContents.mainFrame).toBe(bFrame);
    expect(a.webContents.document.value).toBe('original A');
    expect(b.webContents.document.value).toBe('original B');
    for (const view of [a, b]) {
      expect(view.webContents.frameCallbacks).toHaveLength(1);
      expect(view.webContents.loads).toBe(1);
      expect(view.webContents.closes).toBe(0);
      expect(view.webContents.captureCalls).toBe(0);
    }
  } finally {
    addChild.mockRestore();
    f.close();
  }
});

test('switching, collapsing and window hide preserve the exact original document without repeat first-frame reads', async () => {
  const f = fixture();
  f.state.phase = 'human';
  try {
    f.contents.document.value = 'unsent form A';
    await f.show(bounds);
    const original = f.view,
      originalFrame = f.contents.mainFrame,
      reads = f.contents.frameCallbacks.length;
    expect(
      f.invoke({ action: 'navigate', id: 'page-b', input: 'https://example.test/same' }),
    ).toMatchObject({ ok: true });
    const b = views.at(-1)!;
    f.setupFrame(b);
    f.completeDocument(b, 'https://example.test/same');
    await f.show(bounds, undefined, 'page-b');
    expect(original.visible).toBe(false);
    expect(b.visible).toBe(true);
    expect(f.contents.document.value).toBe('unsent form A');
    await f.show(bounds);
    expect(original.visible).toBe(true);
    expect(b.visible).toBe(false);
    f.present(null);
    await f.show(bounds);
    f.windowEvent('hide');
    expect(original.visible).toBe(true);
    expect(f.presentation.at(-1)).toBe(false);
    f.windowEvent('show');
    expect(original.visible).toBe(false); // reopening itself cannot reuse an old display binding
    await f.show(bounds);
    expect(original.visible).toBe(true);
    expect(f.contents.mainFrame).toBe(originalFrame);
    expect(f.contents.frameCallbacks).toHaveLength(reads);
    expect(f.contents.document.value).toBe('unsent form A');
    expect(f.contents.loads).toBe(1);
    expect(f.contents.closes).toBe(0);
    expect(
      f.invoke({ action: 'close', id: 'page-b', pageToken: f.pageState('page-b').pageToken }),
    ).toMatchObject({ ok: true });
    expect(b.webContents.closes).toBe(1);
    expect(original.visible).toBe(true);
    expect(f.contents.closes).toBe(0);
  } finally {
    f.close();
  }
});

test('hidden current intent preserves the exact child while retiring old tokens and screenshot proof, then stages its shield before showing', async () => {
  const f = fixture();
  try {
    await f.show(bounds);
    const original = f.view,
      frame = f.contents.mainFrame,
      oldLayout = f.layoutRequest('page', bounds),
      reads = f.contents.frameCallbacks.length;
    original.webContents.document.value = 'keep this original form';
    await f.page.send('Page.captureScreenshot', {});
    expect(f.page.captureMeta()).toMatchObject({ metadata: { captureId: expect.any(String) } });
    const shield = f.window.contentView.children.find(
      (view) => view !== (f.root as unknown) && view !== (original as unknown),
    )! as unknown as FakeView;
    expect(shield.visible).toBe(true);
    f.presentation.length = 0;
    f.windowEvent('hide');
    expect(f.window.isVisible()).toBe(false);
    expect(original.visible).toBe(true);
    expect(shield.visible).toBe(false);
    expect(f.page.captureMeta()).toMatchObject({ metadata: null });
    expect(f.sync(oldLayout)).toMatchObject({ ok: false, code: 'browser_page_scope_denied' });
    const current = f.layoutRequest('page', bounds);
    expect(current.pageToken).not.toBe(oldLayout.pageToken);
    expect(f.sync(current)).toMatchObject({ ok: true, value: { id: 'page' } });
    expect(f.presentation.every((visible) => !visible)).toBe(true);
    expect(shield.visible).toBe(false);
    f.window.emit(nativeRootWillShowEvent);
    expect(f.window.isVisible()).toBe(false);
    expect(original.visible).toBe(true);
    expect(shield.visible).toBe(true);
    expect(f.window.contentView.children.at(-1)).toBe(shield as unknown as Electron.View);
    expect(f.presentation.every((visible) => !visible)).toBe(true);
    expect(f.page.captureMeta()).toMatchObject({ metadata: null });
    f.windowEvent('show');
    expect(original.visible).toBe(true);
    expect(shield.visible).toBe(true);
    expect(f.presentation.at(-1)).toBe(true);
    expect(f.contents.mainFrame).toBe(frame);
    expect(f.contents.document.value).toBe('keep this original form');
    expect(f.contents.frameCallbacks).toHaveLength(reads);
    expect(f.contents.loads).toBe(1);
    expect(f.contents.closes).toBe(0);
  } finally {
    f.close();
  }
});

test('late hide and minimize notifications cannot retire a currently visible binding or remove its input shield', async () => {
  const f = fixture();
  try {
    await f.show(bounds);
    const original = f.view,
      token = f.pageState().pageToken,
      shield = f.window.contentView.children.at(-1)! as unknown as FakeView;
    expect(shield).not.toBe(original);
    expect(shield.visible).toBe(true);
    for (const event of ['hide', 'minimize']) {
      f.window.emit(event);
      expect(original.visible).toBe(true);
      expect(shield.visible).toBe(true);
      expect(f.pageState().pageToken).toBe(token);
      expect(f.presentation.at(-1)).toBe(true);
    }
  } finally {
    f.close();
  }
});

test('a late show notification cannot consume the current hidden intent before its actual opening', async () => {
  const f = fixture();
  f.state.phase = 'human';
  try {
    await f.show(bounds);
    f.windowEvent('hide');
    expect(f.sync(f.layoutRequest('page', bounds))).toMatchObject({ ok: true });
    const token = f.pageState().pageToken;
    f.window.emit('show');
    expect(f.view.visible).toBe(true);
    expect(f.presentation.at(-1)).toBe(false);
    expect(f.pageState().pageToken).toBe(token);
    f.window.emit(nativeRootWillShowEvent);
    f.windowEvent('show');
    expect(f.view.visible).toBe(true);
    expect(f.presentation.at(-1)).toBe(true);
  } finally {
    f.close();
  }
});

test('a confirmed hidden intent still requires the pre-show hook and a system show withdraws its candidate', async () => {
  const f = fixture();
  f.state.phase = 'human';
  try {
    await f.show(bounds);
    f.windowEvent('hide');
    expect(f.sync(f.layoutRequest('page', bounds))).toMatchObject({ ok: true });
    expect(f.view.visible).toBe(true);
    f.windowEvent('show');
    expect(f.view.visible).toBe(false);
    expect(f.presentation.at(-1)).toBe(false);
    expect(f.contents.loads).toBe(1);
    expect(f.contents.frameCallbacks).toHaveLength(1);
  } finally {
    f.close();
  }
});

test('hidden collapse or overlay cleanup retires the exact resume intent before either show path', async () => {
  const f = fixture();
  f.state.phase = 'human';
  try {
    await f.show(bounds);
    const original = f.view;
    f.windowEvent('hide');
    expect(f.sync(f.layoutRequest('page', bounds))).toMatchObject({ ok: true });
    expect(f.sync(f.layoutRequest('page', null))).toMatchObject({ ok: true });
    expect(original.visible).toBe(false);
    f.window.emit(nativeRootWillShowEvent);
    f.windowEvent('show');
    expect(original.visible).toBe(false);
    expect(f.presentation.at(-1)).toBe(false);
    expect(original.webContents.loads).toBe(1);
    expect(original.webContents.frameCallbacks).toHaveLength(1);
  } finally {
    f.close();
  }
});

test('a different drawable tab can replace hidden intent without exposing the previous tab', async () => {
  const f = fixture();
  f.state.phase = 'human';
  try {
    await f.show(bounds);
    const a = f.view;
    expect(
      f.invoke({ action: 'navigate', id: 'page-b', input: 'https://example.test/b' }),
    ).toMatchObject({ ok: true });
    const b = views.at(-1)!;
    f.setupFrame(b);
    f.completeDocument(b, 'https://example.test/b');
    await f.show(bounds, undefined, 'page-b');
    await f.show(bounds);
    const aFrame = a.webContents.mainFrame,
      bFrame = b.webContents.mainFrame;
    f.windowEvent('hide');
    f.presentation.length = 0;
    expect(f.sync(f.layoutRequest('page-b', bounds))).toMatchObject({ ok: true });
    expect(a.visible).toBe(false);
    expect(b.visible).toBe(false);
    expect(f.presentation.every((visible) => !visible)).toBe(true);
    f.window.emit(nativeRootWillShowEvent);
    expect(a.visible).toBe(false);
    expect(b.visible).toBe(true);
    expect(f.window.isVisible()).toBe(false);
    expect(f.presentation.every((visible) => !visible)).toBe(true);
    f.windowEvent('show');
    expect(a.visible).toBe(false);
    expect(b.visible).toBe(true);
    expect(a.webContents.mainFrame).toBe(aFrame);
    expect(b.webContents.mainFrame).toBe(bFrame);
    for (const page of [a, b]) {
      expect(page.webContents.loads).toBe(1);
      expect(page.webContents.closes).toBe(0);
      expect(page.webContents.frameCallbacks).toHaveLength(1);
    }
  } finally {
    f.close();
  }
});

test('a hidden target adopted before showing remains the selected exact page across immediate Root replacement', async () => {
  const f = fixture();
  f.state.phase = 'human';
  try {
    await f.show(bounds);
    const a = f.view;
    expect(
      f.invoke({ action: 'navigate', id: 'page-b', input: 'https://example.test/b' }),
    ).toMatchObject({ ok: true });
    const b = views.at(-1)!;
    f.setupFrame(b);
    f.completeDocument(b, 'https://example.test/b');
    await f.show(bounds, undefined, 'page-b');
    await f.show(bounds);
    const aFrame = a.webContents.mainFrame,
      bFrame = b.webContents.mainFrame;
    a.webContents.document.value = 'original form A';
    b.webContents.document.value = 'original form B';
    f.windowEvent('hide');
    expect(f.sync(f.layoutRequest('page-b', bounds))).toMatchObject({ ok: true });
    f.window.emit(nativeRootWillShowEvent);
    f.windowEvent('show');
    expect(a.visible).toBe(false);
    expect(b.visible).toBe(true);
    // The new Renderer has not sent another positive placement: adopting B
    // before showing must itself preserve the page-selection recovery facts.
    f.owner.mainFrame = { url: 'http://localhost/' };
    f.owner.emit('did-start-navigation', {}, 'http://localhost/', false, true);
    const restored = f.invoke({ action: 'restore', scope: { ...f.scope } }) as {
      ok: boolean;
      value: NativeBrowserRestoreResult;
    };
    expect(restored.ok).toBe(true);
    expect(restored.value.activeId).toBe('page-b');
    expect(restored.value.page?.id).toBe('page-b');
    expect(restored.value.reveal).toBe(true);
    expect(a.webContents.mainFrame).toBe(aFrame);
    expect(b.webContents.mainFrame).toBe(bFrame);
    expect(a.webContents.document.value).toBe('original form A');
    expect(b.webContents.document.value).toBe('original form B');
    for (const page of [a, b]) {
      expect(page.webContents.loads).toBe(1);
      expect(page.webContents.closes).toBe(0);
      expect(page.webContents.frameCallbacks).toHaveLength(1);
      expect(page.webContents.captureCalls).toBe(0);
    }
  } finally {
    f.close();
  }
});

for (const boundary of [
  'unconfirmed',
  'scope',
  'root-frame',
  'root-navigation',
  'close',
  'same-id-successor',
  'page-frame',
  'document-navigation',
  'in-page-navigation',
  'host-incarnation',
  'host-navigation',
  'window-size',
  'zoom',
] as const) {
  test(`hidden resume refuses ${boundary} without refreshing, allocating or reading a frame`, async () => {
    const f = fixture();
    f.state.phase = 'human';
    try {
      await f.show(bounds);
      const original = f.view;
      f.windowEvent('hide');
      if (boundary !== 'unconfirmed')
        expect(f.sync(f.layoutRequest('page', bounds))).toMatchObject({ ok: true });
      if (boundary === 'scope') f.scope.viewSelection++;
      if (boundary === 'root-frame') f.owner.mainFrame = { url: 'http://localhost/' };
      if (boundary === 'root-navigation')
        f.owner.emit('did-start-navigation', {}, 'http://localhost/reloaded', false, true);
      if (boundary === 'close' || boundary === 'same-id-successor') {
        expect(
          f.invoke({ action: 'close', id: 'page', pageToken: f.pageState().pageToken }),
        ).toMatchObject({ ok: true });
        if (boundary === 'same-id-successor') {
          expect(
            f.invoke({ action: 'navigate', id: 'page', input: 'http://localhost/successor' }),
          ).toMatchObject({ ok: true });
          const successor = views.at(-1)!;
          f.setupFrame(successor);
          f.completeDocument(successor);
          expect(successor).not.toBe(original);
        }
      }
      if (boundary === 'page-frame')
        original.webContents.mainFrame = { url: original.webContents.actualUrl };
      if (boundary === 'document-navigation')
        original.webContents.emit('did-start-navigation', {}, 'http://localhost/next', false, true);
      if (boundary === 'in-page-navigation')
        original.webContents.emit(
          'did-navigate-in-page',
          {},
          'http://localhost/page#changed',
          true,
        );
      if (boundary === 'host-incarnation') f.state.incarnation = 'successor-incarnation';
      if (boundary === 'host-navigation') f.state.navigation++;
      if (boundary === 'window-size') f.contentSize[0] = 1500;
      if (boundary === 'zoom') f.owner.zoom = 1.25;
      const inventory = [...views],
        activity = () =>
          inventory.map((view) => ({
            loads: view.webContents.loads,
            closes: view.webContents.closes,
            frames: view.webContents.frameCallbacks.length,
            captures: view.webContents.captureCalls,
          })),
        before = activity();
      f.presentation.length = 0;
      f.window.emit(nativeRootWillShowEvent);
      expect(original.visible).toBe(false);
      expect(f.window.isVisible()).toBe(false);
      f.windowEvent('show');
      expect(views.every((view) => !view.visible)).toBe(true);
      expect(f.presentation.every((visible) => !visible)).toBe(true);
      expect(views).toEqual(inventory);
      expect(activity()).toEqual(before);
    } finally {
      f.close();
    }
  });
}

test('minimize withdraws the native child and never retains an optimized system-restore intent', async () => {
  const f = fixture();
  f.state.phase = 'human';
  try {
    await f.show(bounds);
    const old = f.layoutRequest('page', bounds);
    f.windowEvent('minimize');
    expect(f.view.visible).toBe(false);
    expect(f.presentation.at(-1)).toBe(false);
    expect(f.sync(old)).toMatchObject({ ok: false, code: 'browser_page_scope_denied' });
    expect(f.sync(f.layoutRequest('page', bounds))).toMatchObject({
      ok: false,
      code: 'invalid_browser_request',
    });
    f.window.emit(nativeRootWillShowEvent);
    f.windowEvent('restore');
    expect(f.view.visible).toBe(false);
    expect(f.presentation.at(-1)).toBe(false);
    expect(f.contents.loads).toBe(1);
    expect(f.contents.frameCallbacks).toHaveLength(1);
    expect(f.contents.closes).toBe(0);
  } finally {
    f.close();
  }
});

test('a same-ID successor refuses old close callbacks and old layout tokens even at a newer revision', async () => {
  const f = fixture();
  f.state.phase = 'human';
  try {
    await f.show(bounds);
    const old = f.layoutRequest('page', bounds),
      oldContents = f.contents;
    expect(f.invoke({ action: 'close', id: 'page', pageToken: old.pageToken })).toMatchObject({
      ok: true,
    });
    expect(
      f.invoke({ action: 'navigate', id: 'page', input: 'http://localhost/page' }),
    ).toMatchObject({ ok: true });
    const successor = views.at(-1)!;
    f.setupFrame(successor);
    f.completeDocument(successor);
    f.present(bounds);
    await turn();
    expect(f.pageState().pageToken).not.toBe(old.pageToken);
    expect(f.invoke({ action: 'close', id: 'page', pageToken: old.pageToken })).toMatchObject({
      ok: false,
    });
    expect(f.sync({ ...old, presentationRevision: 9999 })).toMatchObject({ ok: false });
    expect(successor.webContents.closes).toBe(0);
    expect(successor.visible).toBe(true);
    expect(oldContents.closes).toBe(1);
  } finally {
    f.close();
  }
});

test('native resize projects the current panel allocation immediately and keeps the exact page and input shield visible', async () => {
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
  const measured = { x: 961, y: 100, width: 640, height: 1000, radius: 8 };
  const layout: NativeBrowserLayout = {
    windowWidth: 1601,
    windowHeight: 1200,
    insetLeft: 0,
    insetRight: 0,
    groups: [{ left: 0, right: 0, gap: 1, panels: [panel(960), panel(640)] }],
  };
  try {
    f.contentSize.splice(0, 2, 1601, 1200);
    f.window.emit('resize');
    f.state.phase = 'acquiring';
    await f.page.attach();
    f.state.phase = 'agent';
    const shield = views.at(-1)!;
    await f.show(measured, layout);
    const reads = f.contents.frameCallbacks.length,
      loads = f.contents.loads;
    f.view.visibility.length = 0;
    shield.visibility.length = 0;
    f.presentation.length = 0;
    for (const [width, height, x, pageWidth, pageHeight] of [
      [1001, 900, 601, 400, 700],
      [2001, 1400, 1201, 800, 1200],
      [1601, 1200, 961, 640, 1000],
    ]) {
      f.contentSize.splice(0, 2, width!, height!);
      f.window.emit('resize');
      expect(f.view.bounds).toEqual({ x: x!, y: 100, width: pageWidth!, height: pageHeight! });
      expect(shield.bounds).toEqual(f.view.bounds);
      expect(f.view.visible).toBe(true);
      expect(shield.visible).toBe(true);
    }
    expect(f.view.visibility).not.toContain(false);
    expect(shield.visibility).not.toContain(false);
    expect(f.presentation).not.toContain(false);
    expect(f.contents.frameCallbacks).toHaveLength(reads);
    expect(f.contents.loads).toBe(loads);
    expect(f.contents.closes).toBe(0);
    f.present(null);
    expect(f.view.visible).toBe(false);
    expect(shield.visible).toBe(false);
  } finally {
    f.close();
  }
});

test('live sidebar animation accepts measured intermediate widths while rejecting mismatched viewport bounds', async () => {
  const f = fixture();
  try {
    f.contentSize.splice(0, 2, 1000, 800);
    f.window.emit('resize');
    f.state.phase = 'human';
    await f.show({ x: 201, y: 100, width: 799, height: 600, radius: 0 });
    const loads = f.contents.loads;
    const reads = f.contents.frameCallbacks.length;
    f.view.visibility.length = 0;
    for (const size of [200, 150, 100, 50, 0]) {
      const layout: NativeBrowserLayout = {
        windowWidth: 1000,
        windowHeight: 800,
        insetLeft: 0,
        insetRight: 0,
        groups: [
          {
            left: 0,
            right: 0,
            gap: 1,
            panels: [
              {
                size,
                min: 0,
                max: 0,
                minUnit: 'px',
                maxUnit: 'px',
                preserve: 'pixel',
                collapsible: false,
              },
              {
                size: 999 - size,
                min: 200,
                max: 100,
                minUnit: 'px',
                maxUnit: '%',
                preserve: 'relative',
                collapsible: false,
              },
            ],
          },
        ],
      };
      const measured = { x: size + 1, y: 100, width: 999 - size, height: 600, radius: 0 };
      expect(await f.asyncLayout(f.layoutRequest('page', measured, layout))).toMatchObject({
        ok: true,
      });
      expect(f.view.bounds).toEqual({ x: measured.x, y: 100, width: measured.width, height: 600 });
      expect(f.view.visible).toBe(true);
      expect(f.present({ ...measured, x: measured.x + 10 }, layout)).toMatchObject({ ok: false });
      expect(f.view.bounds.x).toBe(measured.x);
    }
    expect(f.view.visibility).not.toContain(false);
    expect(f.contents.loads).toBe(loads);
    expect(f.contents.frameCallbacks).toHaveLength(reads);
    expect(f.contents.closes).toBe(0);
  } finally {
    f.close();
  }
});

test('a Windows content-frame inset remains inside the same panel through native resize without another first-frame read', async () => {
  const f = fixture();
  const panel = (size: number, preserve: 'relative' | 'pixel' = 'relative') => ({
    size,
    min: 0,
    minUnit: 'px' as const,
    max: 100,
    maxUnit: '%' as const,
    preserve,
    collapsible: false,
  });
  const layout: NativeBrowserLayout = {
    windowWidth: 1600,
    windowHeight: 1200,
    insetLeft: 0,
    insetRight: 0,
    groups: [
      { left: 0, right: 0, gap: 1, panels: [panel(200, 'pixel'), panel(1399)] },
      { left: 6, right: 6, gap: 1, panels: [panel(600), panel(786)] },
    ],
  };
  try {
    await f.show({ x: 808, y: 132, width: 786, height: 1061, radius: 8 }, layout);
    expect(f.view.visible).toBe(true);
    const frames = f.contents.frameCallbacks.length,
      loads = f.contents.loads;
    f.contentSize.splice(0, 2, 1700, 1300);
    f.window.emit('resize');
    expect(f.view.bounds.x + f.view.bounds.width).toBe(1694);
    expect(f.view.bounds.y + f.view.bounds.height).toBe(1293);
    expect(f.view.visible).toBe(true);
    expect(f.contents.frameCallbacks).toHaveLength(frames);
    expect(f.contents.loads).toBe(loads);
  } finally {
    f.close();
  }
});

test('rejected stale and mixed panel measurements cannot replace the current native projection or invalidate a valid page-coordinate proof', async () => {
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
  const layout: NativeBrowserLayout = {
    windowWidth: 1600,
    windowHeight: 1200,
    insetLeft: 0,
    insetRight: 0,
    groups: [{ left: 0, right: 0, gap: 1, panels: [panel(799), panel(800)] }],
  };
  const measured = { x: 800, y: 100, width: 800, height: 600, radius: 8 };
  try {
    await f.show(measured, layout);
    await f.page.send('Page.captureScreenshot', {});
    const proof = f.page.captureMeta() as { metadata: { captureId: string } };
    const current = { ...f.view.bounds };
    for (const changed of [
      { ...layout, windowWidth: 1000 },
      { ...layout, windowHeight: 700 },
      { ...layout, groups: [{ ...layout.groups[0]!, gap: 20 }] },
      { ...layout, groups: [{ ...layout.groups[0]!, right: 200 }] },
      { ...layout, groups: [{ ...layout.groups[0]!, panels: [panel(700), panel(500)] as const }] },
    ]) {
      expect(f.present(measured, changed)).toMatchObject({ ok: false });
      expect(f.view.bounds).toEqual(current);
      expect(f.view.visible).toBe(true);
      expect(await f.page.validateCapture!(proof.metadata.captureId)).toBe(true);
      f.window.emit('resize');
      expect(f.view.bounds).toEqual(current);
    }
    const writes = f.view.boundsWrites.length;
    f.present(measured, layout);
    f.window.emit('resize');
    expect(f.view.boundsWrites).toHaveLength(writes);
    expect(await f.page.validateCapture!(proof.metadata.captureId)).toBe(true);
  } finally {
    f.close();
  }
});

for (const replacement of ['navigation', 'crash', 'preload'] as const)
  test(`Root ${replacement} restores the exact inventory before any fresh presentation and refuses the old Root's late positive or cleanup`, async () => {
    const f = fixture();
    f.state.phase = 'human';
    try {
      f.contents.document.value = 'original A';
      await f.show(bounds);
      const old = f.layoutRequest('page', bounds),
        oldRoot = f.owner.mainFrame,
        originalFrame = f.contents.mainFrame,
        reads = f.contents.frameCallbacks.length;
      f.owner.mainFrame = { url: 'http://localhost/' };
      if (replacement === 'navigation')
        f.owner.emit('did-start-navigation', {}, 'http://localhost/', false, true);
      if (replacement === 'crash') f.owner.emit('render-process-gone');
      if (replacement === 'preload') f.owner.emit('preload-error');
      expect(f.view.visible).toBe(false);
      const restored = f.invoke({ action: 'restore', scope: { ...f.scope } }) as {
        ok: boolean;
        value: NativeBrowserRestoreResult;
      };
      expect(restored.ok).toBe(true);
      expect(restored.value.pages).toHaveLength(1);
      expect(restored.value.activeId).toBe('page');
      expect(restored.value.page!.pageToken).not.toBe(old.pageToken);
      expect(f.view.visible).toBe(false);
      const fresh = { ...f.layoutRequest('page', bounds), presentationRevision: 1 };
      expect(f.sync(fresh)).toMatchObject({ ok: true });
      expect(f.view.visible).toBe(true);
      for (const stale of [
        { ...old, presentationRevision: 999 },
        { ...old, bounds: null, presentationRevision: 1000 },
      ]) {
        expect(f.sync(stale, oldRoot)).toMatchObject({ ok: false });
        expect(f.sync(stale)).toMatchObject({ ok: false });
        expect(f.view.visible).toBe(true);
      }
      expect(f.contents.mainFrame).toBe(originalFrame);
      expect(f.contents.document.value).toBe('original A');
      expect(f.contents.frameCallbacks).toHaveLength(reads);
      expect(f.contents.loads).toBe(1);
      expect(f.contents.closes).toBe(0);
    } finally {
      f.close();
    }
  });

test('session return reuses the original document and an old selection cannot present over the current one', async () => {
  const f = fixture();
  f.state.phase = 'human';
  try {
    await f.show(bounds);
    const old = f.layoutRequest('page', bounds),
      frame = f.contents.mainFrame;
    f.scope.sessionId = 'other';
    f.scope.viewSelection++;
    f.window.emit('resize');
    expect(f.view.visible).toBe(false);
    expect(f.sync({ ...old, presentationRevision: 999 })).toMatchObject({ ok: false });
    expect(f.view.visible).toBe(false);
    f.scope.sessionId = 'session';
    f.scope.viewSelection++;
    const restored = f.invoke({ action: 'restore', scope: { ...f.scope } }) as {
      value: NativeBrowserRestoreResult;
    };
    expect(restored.value.pages?.map((page) => page.id)).toEqual(['page']);
    await f.show(bounds);
    expect(f.view.visible).toBe(true);
    expect(f.contents.mainFrame).toBe(frame);
    expect(f.contents.loads).toBe(1);
    expect(f.contents.frameCallbacks).toHaveLength(1);
  } finally {
    f.close();
  }
});

test('manual draft reload restores only the possessed inventory and never grants a session or Agent page', async () => {
  const draft = 'a'.repeat(32),
    f = fixture({ draft, automation: false });
  try {
    await f.show(bounds);
    const frame = f.contents.mainFrame,
      token = f.pageState().pageToken;
    f.owner.mainFrame = { url: 'http://localhost/' };
    f.owner.emit('did-start-navigation', {}, 'http://localhost/', false, true);
    expect(f.view.visible).toBe(false);
    expect(f.invoke({ action: 'restoreDraft', draft: 'b'.repeat(32) })).toMatchObject({
      ok: true,
      value: { pages: [] },
    });
    expect(f.invoke({ action: 'restoreDraft', draft })).toMatchObject({
      ok: true,
      value: { activeId: 'page', pages: [{ id: 'page' }] },
    });
    expect(f.sync({ ...f.layoutRequest('page', bounds), pageToken: token })).toMatchObject({
      ok: false,
    });
    await f.show(bounds);
    expect(f.view.visible).toBe(true);
    expect(f.contents.mainFrame).toBe(frame);
    expect(f.contents.loads).toBe(1);
    expect(f.contents.frameCallbacks).toHaveLength(1);
    expect(f.ports.size).toBe(0);
    expect(f.armed).toEqual([]);
  } finally {
    f.close();
  }
});

test('a new manual navigation cannot allocate an ownerless page while the current Caller selection is unavailable', () => {
  const f = fixture({ initialPage: false });
  try {
    f.selectScope(false);
    expect(
      f.invoke({ action: 'navigate', id: 'orphan', input: 'https://example.org/' }),
    ).toMatchObject({
      ok: false,
      code: 'browser_page_scope_denied',
    });
    expect(views).toHaveLength(0);
    expect(f.ports.size).toBe(0);
    expect(f.invoke({ action: 'state', id: 'orphan' })).toEqual({ ok: true, value: null });
  } finally {
    f.close();
  }
});

test('an explicit withdrawal after Root replacement retires its reveal intent across the next Root replacement', async () => {
  const f = fixture();
  try {
    await f.show(bounds);
    f.owner.emit('render-process-gone');
    expect(f.invoke({ action: 'restore', scope: f.scope })).toMatchObject({
      ok: true,
      value: { reveal: true },
    });
    expect(f.present(null)).toMatchObject({ ok: true });
    f.owner.emit('render-process-gone');
    const restored = f.invoke({ action: 'restore', scope: f.scope }) as {
      ok: boolean;
      value: { reveal?: true };
    };
    expect(restored.ok).toBe(true);
    expect(restored.value.reveal).toBeUndefined();
    expect(f.contents.closes).toBe(0);
    expect(f.view.visible).toBe(false);
  } finally {
    f.close();
  }
});
