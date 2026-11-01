import { expect, mock, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import {
  type NativeBrowserRestoreScope,
  nativeBrowserWitnessPosition,
  nativeBrowserWitnessTileSize,
  nativeBrowserWitnessWidth,
} from '../../src/native-browser-bridge';
import {
  type NativeBrowserChromeEnvelope,
  type NativeBrowserChromeEvent,
  type NativeBrowserChromeOwner,
  type NativeBrowserChromeSnapshot,
  nativeBrowserChromeAckChannel,
  nativeBrowserChromeActionChannel,
  nativeBrowserChromeChannel,
  nativeBrowserChromeRootChannel,
  nativeBrowserChromeStateChannel,
} from '../../src/native-browser-chrome-bridge';

const views: FakeContentsView[] = [];
class FakeView {
  children: FakeView[] = [];
  bounds = { x: 0, y: 0, width: 1000, height: 700 };
  boundsHistory: FakeView['bounds'][] = [];
  visible = true;
  visibilityHistory: boolean[] = [];
  addChildView(view: FakeView, index = this.children.length) {
    this.removeChildView(view);
    this.children.splice(index, 0, view);
  }
  removeChildView(view: FakeView) {
    this.children = this.children.filter((item) => item !== view);
  }
  setBounds(bounds: typeof this.bounds) {
    this.bounds = { ...bounds };
    this.boundsHistory.push(this.bounds);
  }
  getBounds() {
    return { ...this.bounds };
  }
  setVisible(value: boolean) {
    this.visibilityHistory.push(value);
    this.visible = value;
  }
  getVisible() {
    return this.visible;
  }
  setBackgroundColor() {}
}
class FakeContents extends EventEmitter {
  destroyed = false;
  attached = false;
  zoom = 1;
  zoomHistory: number[] = [];
  focused = false;
  url = 'http://localhost/';
  mainFrame = { url: this.url };
  sent: { channel: string; value: unknown }[] = [];
  commands: { method: string; params: unknown }[] = [];
  command: () => Promise<unknown> = async () => ({});
  session = { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} };
  debugger = Object.assign(new EventEmitter(), {
    isAttached: () => this.attached,
    attach: () => {
      this.attached = true;
    },
    detach: () => {
      this.attached = false;
      this.debugger.emit('detach');
    },
    sendCommand: (method: string, params: unknown) => {
      this.commands.push({ method, params });
      return this.command();
    },
  });
  isDestroyed() {
    return this.destroyed;
  }
  getURL() {
    return this.url;
  }
  loadingMain = false;
  isLoadingMainFrame() {
    return this.loadingMain;
  }
  getZoomFactor() {
    return this.zoom;
  }
  setZoomFactor(value: number) {
    this.zoomHistory.push(value);
    this.zoom = value;
  }
  focus() {
    this.focused = true;
  }
  send(channel: string, value: unknown) {
    this.sent.push({ channel, value });
  }
  setWindowOpenHandler() {}
  async loadURL(url: string) {
    this.url = url;
    this.mainFrame = { url };
  }
  async loadFile() {}
  async capturePage() {
    return { isEmpty: () => false, getSize: () => ({ width: 1000, height: 700 }) };
  }
  autoFrames = true;
  frameStarts = 0;
  frameEnds = 0;
  frameImage = () => ({ isEmpty: () => false, getSize: () => ({ width: 1000, height: 700 }) });
  frame?: (image: ReturnType<FakeContents['frameImage']>) => void;
  beginFrameSubscription(onlyDirty: boolean, receive: NonNullable<FakeContents['frame']>) {
    expect(onlyDirty).toBe(false);
    this.frameStarts++;
    this.frame = receive;
    if (this.autoFrames) queueMicrotask(() => receive(this.frameImage()));
  }
  endFrameSubscription() {
    this.frameEnds++;
    this.frame = undefined;
  }
  close() {
    this.destroyed = true;
    this.emit('destroyed');
  }
}
class FakeContentsView extends FakeView {
  webContents = new FakeContents();
  readonly options: unknown;
  constructor(options: unknown = {}) {
    super();
    this.options = options;
    views.push(this);
    this.webContents.capturePage = async () => ({
      isEmpty: () => false,
      getSize: () => ({ width: this.bounds.width, height: this.bounds.height }),
    });
    this.webContents.frameImage = () => ({
      isEmpty: () => false,
      getSize: () => ({ width: this.bounds.width, height: this.bounds.height }),
    });
  }
}
class FakeWindow extends EventEmitter {
  contentView = new FakeView();
  size = [1000, 700];
  destroyed = false;
  constructor(_options: unknown) {
    super();
  }
  getContentSize() {
    return [...this.size];
  }
  isDestroyed() {
    return this.destroyed;
  }
  isVisible() {
    return true;
  }
  isMinimized() {
    return false;
  }
  setBackgroundColor() {}
  show() {}
  destroy() {
    this.destroyed = true;
    this.emit('closed');
  }
  setTitle() {}
}
mock.module('electron', () => ({
  BaseWindow: FakeWindow,
  View: FakeView,
  WebContentsView: FakeContentsView,
}));
const { createNativeBrowserChromeHost } = await import('../../electron/browser-chrome-host');
const { createNativeRootWindow, getNativeRootView } = await import(
  '../../electron/native-root-window'
);
const tick = async () => {
  await Bun.sleep(0);
};
function fixture() {
  views.length = 0;
  const window = createNativeRootWindow({ show: false });
  const root = getNativeRootView(window)! as unknown as FakeContentsView;
  const page = new FakeContentsView();
  page.webContents.url = 'https://example.com/weather';
  const shield = new FakeView();
  window.contentView.addChildView(page as never);
  window.contentView.addChildView(shield as never);
  const size = (window as unknown as FakeWindow).size;
  const handlers = new Map<string, (event: IpcMainInvokeEvent, value: unknown) => unknown>();
  const ipc = Object.assign(new EventEmitter(), {
    handle: (channel: string, handler: (event: IpcMainInvokeEvent, value: unknown) => unknown) =>
      handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
  });
  const scope: NativeBrowserRestoreScope = {
    storeId: 'store',
    sessionId: 'session',
    generation: 1,
    viewSelection: 2,
  };
  let selected: NativeBrowserRestoreScope | undefined = scope;
  let inputScope: NativeBrowserRestoreScope | undefined = scope;
  let token = 'page-incarnation-navigation';
  let pageDraft: string | undefined;
  let protection = true;
  const loadingFailures: string[] = [];
  const cancelledDisplays: { id: string; signal: AbortSignal }[] = [];
  let contextChanges = 0;
  let stateChanges = 0;
  const returnCancelled: string[] = [];
  const retained = new Map<
    string,
    { id: string; view: FakeContentsView; token: string; scope: NativeBrowserRestoreScope }
  >();
  const ready: string[] = [],
    suspended: string[] = [];
  const holdEnds: { id: string; key: string }[] = [];
  let prepared: { fromId: string; targetId: string; scope: NativeBrowserRestoreScope } | undefined;
  const host = createNativeBrowserChromeHost({
    window,
    ipcMain: ipc as unknown as IpcMain,
    rendererUrl: 'http://localhost/',
    preloadPath: '/private/browser-chrome-preload.cjs',
    currentScope: (input) => (input ? inputScope : selected),
    getPage: (id) =>
      id === 'page'
        ? { id, view: page as never, token, ...(pageDraft ? { draft: pageDraft } : { scope }) }
        : (retained.get(id) as never),
    onLoadingFailed: (id) => loadingFailures.push(id),
    onDisplayCancelled: (id, signal) => cancelledDisplays.push({ id, signal }),
    canProtectLivePage: () => true,
    protectLivePage: () => protection,
    onContextChanged: () => {
      contextChanges++;
    },
    onStateChanged: () => stateChanges++,
    onRootReturnCancelled: (id) => returnCancelled.push(id),
    onReady: (id) => ready.push(id),
    onSuspend: (id) => suspended.push(id),
    onPresentationHoldEnd: (id, key) => holdEnds.push({ id, key }),
    preparedPresentation: () => prepared,
    onShellReleased: () => {
      prepared = undefined;
    },
  });
  const event = (contents = root.webContents) =>
    ({ sender: contents, senderFrame: contents.mainFrame }) as unknown as IpcMainInvokeEvent;
  const publish = (value: NativeBrowserChromeSnapshot | null) =>
    handlers.get(nativeBrowserChromeRootChannel)!(event(), value);
  const snapshot = (revision: number, hosted = false): NativeBrowserChromeSnapshot => ({
    scope,
    revision,
    theme: 'dark',
    interactive: true,
    covered: false,
    hosted,
    tabs: {
      scopeKey: 'scope',
      tabs: [{ id: 'page', kind: 'browser', title: 'Weather' }],
      active: 'page',
      visible: true,
      present: true,
      restoring: false,
      restoreIssue: false,
    },
    toolbar: {
      id: 'page',
      address: 'example.com',
      readonlyURL: 'https://example.com/weather',
      loading: false,
      hasPage: true,
      canGoBack: true,
      canGoForward: false,
      canNavigate: true,
      notesAvailable: false,
      notesOpen: false,
      optionsAvailable: true,
    },
  });
  const chrome = () =>
    views.find(
      (view) =>
        (view.options as { webPreferences?: { preload?: string } }).webPreferences?.preload ===
        '/private/browser-chrome-preload.cjs',
    )!;
  const envelope = () =>
    root.webContents.sent.filter((item) => item.channel === nativeBrowserChromeStateChannel).at(-1)!
      .value as NativeBrowserChromeEnvelope;
  const call = (value: unknown, source = chrome().webContents) =>
    handlers.get(nativeBrowserChromeChannel)!(event(source), value);
  const send = (
    sequence: number,
    revision = 2,
    action: NativeBrowserChromeEvent['part'] = 'toolbar',
  ) => {
    const env = envelope();
    const value = {
      attachment: env.attachment,
      pageToken: env.pageToken,
      sequence,
      revision,
      part: action,
      action: { type: 'reload' },
    };
    return call({ action: 'send', event: value }) as Promise<unknown>;
  };
  const acknowledge = (sequence: number, forwarded = true, source = root.webContents) => {
    const env = envelope();
    ipc.emit(nativeBrowserChromeAckChannel, event(source), {
      attachment: env.attachment,
      pageToken: env.pageToken,
      sequence,
      forwarded,
    });
  };
  const layout: typeof host.layout = (id, bounds, scope) => {
    host.syncViewport();
    const applied = host.layout(id, bounds, scope);
    if (applied) page.setBounds(bounds);
    host.update();
    return applied;
  };
  const prime = async (
    bounds = { x: 600, y: 96, width: 400, height: 604 },
    displayOwner: NativeBrowserChromeOwner = scope,
  ) => {
    const prepared = host.prepareDisplay(
      'page',
      bounds,
      displayOwner,
      new AbortController().signal,
    );
    await tick();
    const value = envelope();
    await call({
      action: 'rendered',
      attachment: value.attachment,
      pageToken: value.pageToken,
      revision: value.snapshot.revision,
    });
    expect(await prepared).toBe(true);
    expect(host.offerDisplay('page', bounds, displayOwner)).toBe(true);
  };
  const activate = async () => {
    publish(snapshot(1));
    await tick();
    await prime();
    publish(snapshot(2, true));
    await tick();
    expect(layout('page', { x: 600, y: 96, width: 400, height: 604 }, scope)).toBe(true);
    await tick();
  };
  return {
    prepare(fromId: string, targetId: string) {
      prepared = { fromId, targetId, scope };
    },
    host,
    layout,
    root,
    page,
    shield,
    window,
    handlers,
    ipc,
    scope,
    size,
    ready,
    suspended,
    holdEnds,
    event,
    publish,
    snapshot,
    chrome,
    envelope,
    call,
    send,
    acknowledge,
    activate,
    prime,
    context(revision: number, owner: NativeBrowserChromeOwner | null) {
      return handlers.get(nativeBrowserChromeRootChannel)!(event(), {
        action: 'context',
        revision,
        owner,
      });
    },
    modern(value: NativeBrowserChromeSnapshot | null, context: number) {
      return handlers.get(nativeBrowserChromeRootChannel)!(event(), {
        action: 'publish',
        snapshot: value,
        context,
      });
    },
    draft(value: string) {
      pageDraft = value;
    },
    loadingFailures,
    cancelledDisplays,
    protection(value: boolean) {
      protection = value;
    },
    contextChanges: () => contextChanges,
    stateChanges: () => stateChanges,
    returnCancelled,
    select(value?: NativeBrowserRestoreScope) {
      selected = value;
    },
    input(value?: NativeBrowserRestoreScope) {
      inputScope = value;
    },
    token(value: string) {
      token = value;
    },
    addPage(id: string, url = 'https://example.org/retained') {
      const view = new FakeContentsView();
      view.webContents.url = url;
      view.setVisible(false);
      window.contentView.addChildView(view as never);
      retained.set(id, { id, view, token: `${id}-incarnation`, scope });
      return view;
    },
  };
}

function retainedSnapshot(
  f: ReturnType<typeof fixture>,
  revision: number,
  active: 'page' | 'second',
) {
  const value = f.snapshot(revision, true);
  return {
    ...value,
    tabs: {
      ...value.tabs,
      tabs: [...value.tabs.tabs, { id: 'second', kind: 'browser' as const, title: 'Retained' }],
      active,
    },
    toolbar: {
      ...value.toolbar,
      id: active,
      readonlyURL: active === 'second' ? 'https://example.org/retained' : value.toolbar.readonlyURL,
    },
  };
}

test('display facts distinguish an unpublished owner from explicit Root presentation without creating authority', async () => {
  const f = fixture();
  try {
    expect(f.host.displayState()).toEqual({ kind: 'unknown' });
    f.context(1, f.scope);
    expect(f.host.displayState()).toEqual({ kind: 'unknown' });
    const notifications = f.stateChanges();
    f.modern(null, 1);
    expect(f.host.displayState()).toEqual({ kind: 'root' });
    expect(f.stateChanges()).toBeGreaterThan(notifications);
    const changes = f.stateChanges();
    const writes = f.root.boundsHistory.length;
    expect(f.host.displayState()).toEqual({ kind: 'root' });
    expect(f.stateChanges()).toBe(changes);
    expect(f.root.boundsHistory).toHaveLength(writes);
    expect(f.ready).toEqual([]);
    expect(f.root.webContents.commands).toEqual([]);
    f.context(2, f.scope);
    expect(f.host.displayState()).toEqual({ kind: 'unknown' });
    f.modern(f.snapshot(1), 2);
    await tick();
    expect(f.host.displayState()).toMatchObject({
      kind: 'page',
      id: 'page',
      scope: f.scope,
      token: 'page-incarnation-navigation',
      presented: false,
    });
    for (const value of [
      { ...f.snapshot(2), covered: true },
      { ...f.snapshot(3), toolbar: { ...f.snapshot(3).toolbar, hasPage: false } },
      { ...f.snapshot(4), toolbar: { ...f.snapshot(4).toolbar, notesOpen: true } },
      { ...f.snapshot(5), tabs: { ...f.snapshot(5).tabs, restoreIssue: true } },
    ]) {
      f.modern(value, 2);
      expect(f.host.displayState()).toEqual({ kind: 'root' });
      expect(f.host.readyFor('page')).toBe(false);
    }
  } finally {
    f.host.dispose();
  }
});

for (const part of ['options', 'control'] as const)
  test(`a local ${part} menu issue retains the exact live page while a real page error still withdraws it`, async () => {
    const f = fixture();
    try {
      await f.activate();
      const root = f.root.getBounds(),
        chrome = f.chrome().getBounds(),
        wire = f.envelope(),
        next = f.snapshot(3, true);
      if (part === 'options')
        Object.assign(next.toolbar, { optionsIssue: '页面选项暂不可用，请重试。' });
      else
        Object.assign(next, {
          control: {
            id: 'page',
            label: '浏览器控制',
            detail: '当前由用户控制',
            issue: '控制菜单暂不可用，请重试。',
            handoffAvailable: false,
            closeAvailable: false,
            pending: false,
            details: [],
          },
        });
      f.publish(next);
      await tick();
      expect(f.host.readyFor('page', f.scope)).toBe(true);
      expect(f.envelope()).toMatchObject({
        attachment: wire.attachment,
        pageToken: wire.pageToken,
        hosted: true,
        actionable: true,
      });
      expect(f.host.displayState()).toMatchObject({ kind: 'page', id: 'page', presented: true });
      expect(f.root.getBounds()).toEqual(root);
      expect(f.chrome().getBounds()).toEqual(chrome);
      expect(f.chrome().getVisible()).toBe(true);
      expect(f.page.getVisible()).toBe(true);
      expect(f.suspended).toEqual([]);
      const failed = f.snapshot(4, true);
      Object.assign(failed.toolbar, { error: '网页加载失败' });
      f.publish(failed);
      await tick();
      expect(f.host.readyFor('page')).toBe(false);
      expect(f.host.displayState()).toMatchObject({ kind: 'root' });
      expect(f.root.getBounds()).toEqual({ x: 0, y: 0, width: 1000, height: 700 });
      expect(f.chrome().getVisible()).toBe(false);
      expect(f.suspended).toEqual(['page']);
      expect(f.page.webContents.destroyed).toBe(false);
    } finally {
      f.host.dispose();
    }
  });

test('display facts select same-URL pages by current id and token instead of an old binding', async () => {
  const f = fixture();
  const second = f.addPage('second', f.page.webContents.getURL());
  try {
    await f.activate();
    expect(f.host.displayState()).toMatchObject({
      kind: 'page',
      id: 'page',
      token: 'page-incarnation-navigation',
      busy: false,
      presented: true,
    });
    const next = retainedSnapshot(f, 3, 'second');
    next.toolbar.readonlyURL = f.page.webContents.getURL();
    f.publish(next);
    expect(second.webContents.getURL()).toBe(f.page.webContents.getURL());
    expect(f.host.displayState()).toMatchObject({
      kind: 'page',
      id: 'second',
      token: 'second-incarnation',
      busy: true,
      presented: false,
    });
    f.publish(retainedSnapshot(f, 4, 'page'));
    f.token('page-next-navigation');
    expect(f.host.displayState()).toMatchObject({
      kind: 'page',
      id: 'page',
      token: 'page-next-navigation',
      presented: false,
    });
    expect(f.page.webContents.destroyed).toBe(false);
    expect(second.webContents.destroyed).toBe(false);
  } finally {
    f.host.dispose();
  }
});

test('display facts keep exact first-surface preparation and Root return busy until actual adoption', async () => {
  const f = fixture();
  const controller = new AbortController();
  const bounds = { x: 600, y: 96, width: 400, height: 604 };
  try {
    f.publish(f.snapshot(1));
    expect(f.host.displayState()).toMatchObject({ kind: 'page', busy: true, presented: false });
    await tick();
    f.chrome().webContents.autoFrames = false;
    const prepared = f.host.prepareDisplay('page', bounds, f.scope, controller.signal);
    await tick();
    const wire = f.envelope();
    await f.call({
      action: 'rendered',
      attachment: wire.attachment,
      pageToken: wire.pageToken,
      revision: wire.snapshot.revision,
    });
    expect(f.host.displayState()).toMatchObject({ kind: 'page', busy: true, presented: false });
    expect(f.chrome().webContents.frame).toBeDefined();
    f.chrome().webContents.frame!(f.chrome().webContents.frameImage());
    expect(await prepared).toBe(true);
    expect(f.host.offerDisplay('page', bounds, f.scope)).toBe(true);
    f.publish(f.snapshot(2, true));
    expect(f.host.readyFor('page')).toBe(true);
    expect(f.host.displayState()).toMatchObject({ kind: 'page', busy: true, presented: false });
    expect(f.layout('page', bounds, f.scope)).toBe(true);
    expect(f.host.displayState()).toMatchObject({ kind: 'page', busy: false, presented: true });
    expect(f.host.beginRootReturn('page', f.scope)).not.toBeNull();
    expect(f.host.displayState()).toMatchObject({ kind: 'page', busy: true, presented: false });
    f.publish(null);
    expect(f.host.displayState()).toEqual({ kind: 'root' });
    expect(f.host.rootReturnCurrent('page', f.scope)).toBe(true);
  } finally {
    controller.abort();
    f.host.dispose();
  }
});

test('display facts retain the original page through resize invalidation and in-flight metrics', async () => {
  const f = fixture();
  let complete!: (value: unknown) => void;
  try {
    await f.activate();
    f.root.webContents.command = () => new Promise((resolve) => (complete = resolve));
    f.size[0] = 820;
    f.size[1] = 650;
    f.host.invalidateGeometry();
    expect(f.page.getVisible()).toBe(true);
    expect(f.host.displayState()).toMatchObject({
      kind: 'page',
      id: 'page',
      token: 'page-incarnation-navigation',
      presented: false,
    });
    f.host.syncViewport();
    expect(f.host.displayState()).toMatchObject({ kind: 'page', busy: true, presented: false });
    complete({});
    await tick();
    expect(f.host.displayState()).toMatchObject({ kind: 'page', busy: false, presented: false });
    expect(f.layout('page', { x: 510, y: 96, width: 310, height: 554 }, f.scope)).toBe(true);
    expect(f.host.displayState()).toMatchObject({
      kind: 'page',
      id: 'page',
      token: 'page-incarnation-navigation',
      busy: false,
      presented: true,
    });
    expect(f.page.webContents.destroyed).toBe(false);
    expect(
      f.root.webContents.sent.some((item) => item.channel === nativeBrowserChromeActionChannel),
    ).toBe(false);
  } finally {
    f.host.dispose();
  }
});

test('display facts require a fresh context and publication after Root document replacement', async () => {
  const f = fixture();
  try {
    f.context(1, f.scope);
    f.modern(f.snapshot(1), 1);
    await tick();
    expect(f.host.displayState()).toMatchObject({ kind: 'page', id: 'page' });
    f.root.webContents.mainFrame = { url: 'http://localhost/?replacement' };
    f.root.webContents.emit('did-start-navigation', {}, 'http://localhost/', false, true);
    expect(f.host.displayState()).toEqual({ kind: 'unknown' });
    expect(() => f.modern(f.snapshot(2), 1)).toThrow('browser_chrome_context_stale');
    f.context(2, f.scope);
    expect(f.host.displayState()).toEqual({ kind: 'unknown' });
    f.modern(f.snapshot(2), 2);
    expect(f.host.displayState()).toMatchObject({ kind: 'page', id: 'page', presented: false });
    expect(f.page.webContents.destroyed).toBe(false);
  } finally {
    f.host.dispose();
  }
});

test('display facts stay unknown after Host failure without reviving old intent or replaying actions', async () => {
  for (const failure of ['chrome', 'debugger'] as const) {
    const f = fixture();
    try {
      await f.activate();
      if (failure === 'chrome') f.chrome().webContents.close();
      else f.root.webContents.debugger.detach();
      expect(f.host.displayState()).toEqual({ kind: 'unknown' });
      const commands = f.root.webContents.commands.length;
      const ready = f.ready.length;
      f.host.update();
      f.host.syncViewport();
      expect(f.host.displayState()).toEqual({ kind: 'unknown' });
      expect(f.host.readyFor('page')).toBe(false);
      expect(f.root.webContents.commands).toHaveLength(commands);
      expect(f.ready).toHaveLength(ready);
      expect(f.page.webContents.destroyed).toBe(false);
      expect(f.root.getBounds().width).toBe(1000);
      expect(
        f.root.webContents.sent.some((item) => item.channel === nativeBrowserChromeActionChannel),
      ).toBe(false);
    } finally {
      f.host.dispose();
    }
  }
});

test('an explicit draft context binds its own page without borrowing the selected Session', async () => {
  const f = fixture(),
    draft = 'a'.repeat(32),
    owner = { draft };
  try {
    f.draft(draft);
    expect(() => f.context(1, owner)).not.toThrow();
    const snapshot = { ...f.snapshot(1), scope: owner };
    f.modern(snapshot, 1);
    await tick();
    expect(f.host.acceptsPresentation('page', owner)).toBe(true);
    expect(f.host.acceptsPresentation('page', f.scope)).toBe(false);
    await f.prime(undefined, owner);
    f.modern({ ...snapshot, revision: 2, hosted: true }, 1);
    expect(f.layout('page', { x: 600, y: 96, width: 400, height: 604 }, owner)).toBe(true);
    expect(f.host.readyFor('page', owner)).toBe(true);
    expect(f.envelope().actionable).toBe(true);
    expect(f.root.getBounds().width).toBe(600);
  } finally {
    f.host.dispose();
  }
});

test('Root return footprint exposes Root controls while covering the unchanged palette at supported zooms', async () => {
  for (const zoom of [1, 0.5, 1.25]) {
    const f = fixture();
    try {
      f.root.webContents.zoom = zoom;
      await f.activate();
      const strip = f.chrome().getBounds(),
        receipt = f.host.beginRootReturn('page', f.scope)!;
      expect(receipt).not.toBeNull();
      f.publish(null);
      const mask = f.chrome().getBounds();
      expect(mask.width < strip.width / 2).toBe(true);
      expect(mask.height < strip.height / 4).toBe(true);
      expect(mask.x).toBe(strip.x);
      expect(mask.y).toBe(strip.y);
      expect(mask.x + mask.width <= strip.x + strip.width).toBe(true);
      expect(mask.y + mask.height <= strip.y + strip.height).toBe(true);
      for (const backing of [1, 2, 3]) {
        const scale = backing * zoom,
          position = nativeBrowserWitnessPosition(receipt.bounds, scale);
        expect(position.x * zoom >= mask.x).toBe(true);
        expect(position.y * zoom >= mask.y).toBe(true);
        expect((position.x + nativeBrowserWitnessWidth(scale)) * zoom <= mask.x + mask.width).toBe(
          true,
        );
        expect(
          (position.y + nativeBrowserWitnessTileSize(scale)) * zoom <= mask.y + mask.height,
        ).toBe(true);
      }
      expect(mask.x + mask.width < strip.x + strip.width - 32).toBe(true);
      expect(mask.y + mask.height < 24).toBe(true);
      expect(f.host.rootReturnCurrent('page', f.scope)).toBe(true);
      const writes = f.chrome().boundsHistory.length;
      f.publish(null);
      f.host.release('page');
      f.host.update();
      expect(f.chrome().boundsHistory).toHaveLength(writes);
      f.host.cancelRootReturn('page');
      f.publish(f.snapshot(3));
      await tick();
      await f.prime();
      f.publish(f.snapshot(4, true));
      expect(f.layout('page', { x: 600, y: 96, width: 400, height: 604 }, f.scope)).toBe(true);
      expect(f.chrome().getBounds()).toEqual(strip);
      expect(f.chrome().getVisible()).toBe(true);
      f.host.finishRootReturn('page');
      expect(f.chrome().getBounds()).toEqual(strip);
      expect(f.chrome().getVisible()).toBe(true);
    } finally {
      f.host.dispose();
    }
  }
  const narrow = fixture();
  try {
    await narrow.activate();
    const strip = { x: 880, y: 0, width: 120, height: 96 };
    expect(narrow.layout('page', { x: 880, y: 96, width: 120, height: 604 }, narrow.scope)).toBe(
      true,
    );
    const receipt = narrow.host.beginRootReturn('page', narrow.scope)!;
    narrow.publish(null);
    expect(narrow.chrome().getBounds()).toEqual({ ...strip, height: 7 });
    expect(nativeBrowserWitnessPosition(receipt.bounds).x).toBe(880);
    expect(narrow.host.rootReturnCurrent('page', narrow.scope)).toBe(true);
  } finally {
    narrow.host.dispose();
  }
  const lowZoom = fixture();
  try {
    lowZoom.root.webContents.zoom = 0.25;
    await lowZoom.activate();
    expect(lowZoom.layout('page', { x: 925, y: 96, width: 75, height: 604 }, lowZoom.scope)).toBe(
      true,
    );
    const strip = lowZoom.chrome().getBounds(),
      receipt = lowZoom.host.beginRootReturn('page', lowZoom.scope)!;
    const actual = nativeBrowserWitnessPosition(receipt.bounds, 0.5);
    expect(actual.x * 0.25 >= strip.x).toBe(true);
    expect((actual.x + nativeBrowserWitnessWidth(0.5)) * 0.25 <= strip.x + strip.width).toBe(true);
    const writes = lowZoom.chrome().boundsHistory.length;
    lowZoom.publish(null);
    expect(lowZoom.chrome().getBounds()).toEqual(strip);
    expect(lowZoom.host.rootReturnCurrent('page', lowZoom.scope)).toBe(true);
    expect(lowZoom.returnCancelled).toEqual([]);
    lowZoom.publish(null);
    lowZoom.host.release('page');
    lowZoom.host.update();
    expect(lowZoom.chrome().boundsHistory).toHaveLength(writes);
    expect(lowZoom.host.rootReturnCurrent('page', lowZoom.scope)).toBe(true);
  } finally {
    lowZoom.host.dispose();
  }
  const changed = fixture();
  try {
    await changed.activate();
    expect(changed.host.beginRootReturn('page', changed.scope)).not.toBeNull();
    changed.chrome().setBounds({ ...changed.chrome().getBounds(), x: 601 });
    changed.publish(null);
    expect(changed.host.rootReturnCurrent('page', changed.scope)).toBe(false);
    expect(changed.returnCancelled).toEqual(['page']);
    expect(changed.chrome().getVisible()).toBe(false);
  } finally {
    changed.host.dispose();
  }
});

test('Root return keeps its Chrome strip through negative publication and ends safely after real page removal', async () => {
  const f = fixture();
  try {
    await f.activate();
    const chromeBounds = f.chrome().getBounds();
    const prepared = f.host.beginRootReturn('page', f.scope);
    expect(prepared).toEqual({
      bounds: { x: 600, y: 0, width: 400, height: 96, radius: 0 },
      width: 1000,
      height: 700,
    });
    expect(f.envelope().actionable).toBe(false);
    expect(f.root.getBounds().width).toBe(1000);
    f.publish(null);
    expect(f.chrome().getVisible()).toBe(true);
    expect(f.chrome().getBounds()).toEqual({ ...chromeBounds, width: 124, height: 7 });
    Reflect.set(f.page, 'webContents', undefined);
    expect(f.host.rootReturnCurrent('page', f.scope)).toBe(true);
    f.host.finishRootReturn('page');
    expect(f.chrome().getVisible()).toBe(false);
    expect(f.root.getBounds().width).toBe(1000);
    expect(f.returnCancelled).toEqual([]);
  } finally {
    f.host.dispose();
  }
});

test('a modern Root return clears stale Chrome content and reads while retaining its visible strip and proof', async () => {
  const f = fixture();
  try {
    f.context(1, f.scope);
    f.modern(f.snapshot(1), 1);
    await tick();
    await f.prime();
    f.modern(f.snapshot(2, true), 1);
    f.layout('page', { x: 600, y: 96, width: 400, height: 604 }, f.scope);
    const bounds = f.chrome().getBounds();
    expect(f.host.beginRootReturn('page', f.scope)).not.toBeNull();
    f.modern(null, 1);
    expect(f.envelope()).toBeNull();
    expect(await f.call({ action: 'read' })).toBeNull();
    expect(f.chrome().getVisible()).toBe(true);
    expect(f.chrome().getBounds()).toEqual({ ...bounds, width: 124, height: 7 });
    expect(f.host.rootReturnCurrent('page', f.scope)).toBe(true);
    f.host.release('page');
    f.host.update();
    expect(f.envelope()).toBeNull();
    expect(f.host.rootReturnCurrent('page', f.scope)).toBe(true);
    expect(f.contextChanges()).toBe(1);
    expect(f.returnCancelled).toEqual([]);
    Reflect.set(f.page, 'webContents', undefined);
    f.host.finishRootReturn('page');
    expect(f.chrome().getVisible()).toBe(false);
    expect(f.root.getBounds().width).toBe(1000);
  } finally {
    f.host.dispose();
  }
});

test('modern context floors retire old wires, ignore old cleanup and survive a real Root replacement', async () => {
  const f = fixture();
  try {
    f.context(7, f.scope);
    f.modern(f.snapshot(1), 7);
    await tick();
    await f.prime();
    f.modern(f.snapshot(2, true), 7);
    f.layout('page', { x: 600, y: 96, width: 400, height: 604 }, f.scope);
    const old = f.envelope();
    f.context(8, f.scope);
    const changes = f.contextChanges();
    f.context(7, null);
    expect(f.contextChanges()).toBe(changes);
    expect(() => f.modern(f.snapshot(3), 7)).toThrow('browser_chrome_context_stale');
    expect(() => f.publish(f.snapshot(3))).toThrow('browser_chrome_context_required');
    f.modern(f.snapshot(3), 8);
    await f.prime();
    expect(f.envelope().attachment).not.toBe(old.attachment);
    f.context(8, null);
    expect(f.host.acceptsPresentation('page', f.scope)).toBe(false);
    expect(() => f.context(8, f.scope)).toThrow('browser_chrome_context_stale');
    f.root.webContents.mainFrame = { url: 'http://localhost/' };
    f.root.webContents.emit('did-start-navigation', {}, 'http://localhost/', false, true);
    expect(() => f.context(8, f.scope)).toThrow('browser_chrome_context_stale');
    f.context(9, f.scope);
    f.modern(f.snapshot(1), 9);
    expect(f.host.acceptsPresentation('page', f.scope)).toBe(true);
  } finally {
    f.host.dispose();
  }
});

test('a cold modern target without Page display state waits for its latest intent and cannot borrow a Session page', async () => {
  const f = fixture(),
    scope = { draft: 'a'.repeat(32) };
  try {
    f.context(1, scope);
    const first = { ...f.snapshot(1), scope };
    f.modern(first, 1);
    await tick();
    expect(f.host.readyFor('page', scope)).toBe(false);
    expect(views).toHaveLength(2); // Existing Session page is not a draft page.
    f.draft(scope.draft);
    const blank = { ...first, revision: 2, toolbar: { ...first.toolbar, hasPage: false } };
    f.modern(blank, 1);
    await tick();
    const controller = new AbortController(),
      bounds = { x: 600, y: 96, width: 400, height: 604 };
    let settled = false;
    const ready = f.host.prepareDisplay('page', bounds, scope, controller.signal).then((value) => {
      settled = true;
      return value;
    });
    const wire = f.envelope();
    await f.call({
      action: 'rendered',
      attachment: wire.attachment,
      pageToken: wire.pageToken,
      revision: 2,
    });
    await tick();
    expect(settled).toBe(false);
    expect(f.envelope().hosted).toBe(false);
    f.modern({ ...first, revision: 3 }, 1);
    const next = f.envelope();
    await f.call({
      action: 'rendered',
      attachment: next.attachment,
      pageToken: next.pageToken,
      revision: 3,
    });
    expect(await ready).toBe(true);
    expect(f.host.offerDisplay('page', bounds, scope)).toBe(true);
    f.modern({ ...first, revision: 4, hosted: true }, 1);
    expect(f.layout('page', bounds, scope)).toBe(true);
  } finally {
    f.host.dispose();
  }
});

for (const boundary of [
  'context',
  'target',
  'cover',
  'resize',
  'root',
  'crash',
  'owner',
  'cancel',
  'dispose',
] as const)
  test(`Root return cancels precisely after ${boundary} and late finish cannot hide a replacement`, async () => {
    const f = fixture();
    try {
      await f.activate();
      expect(f.host.beginRootReturn('page', f.scope)).not.toBeNull();
      f.publish(null);
      f.host.cancelRootReturn('unrelated');
      expect(f.host.rootReturnCurrent('page', f.scope)).toBe(true);
      if (boundary === 'context') f.context(1, f.scope);
      if (boundary === 'target') {
        f.addPage('second');
        f.publish(retainedSnapshot(f, 3, 'second'));
      }
      if (boundary === 'cover') f.publish({ ...f.snapshot(3), covered: true });
      if (boundary === 'resize') {
        f.size[0] = 900;
        f.host.invalidateGeometry();
      }
      if (boundary === 'root')
        f.root.webContents.emit('did-start-navigation', {}, 'http://localhost/', false, true);
      if (boundary === 'crash') f.chrome().webContents.emit('render-process-gone');
      if (boundary === 'owner') {
        f.select({ ...f.scope, generation: 2 });
        f.host.update();
      }
      if (boundary === 'cancel') f.host.cancelRootReturn('page');
      if (boundary === 'dispose') f.host.dispose();
      expect(f.host.rootReturnCurrent('page', f.scope)).toBe(false);
      expect(f.returnCancelled).toEqual(['page']);
      const visible = f.chrome().getVisible();
      f.host.finishRootReturn('page');
      expect(f.chrome().getVisible()).toBe(visible);
      expect(f.page.webContents.destroyed).toBe(false);
    } finally {
      f.host.dispose();
    }
  });

test('first native Chrome waits for its committed own frame under Root before offering delegation', async () => {
  const f = fixture();
  try {
    f.publish(f.snapshot(1));
    await tick();
    expect(f.envelope().hosted).toBe(false);
    const bounds = { x: 600, y: 96, width: 400, height: 604 };
    const prepared = f.host.prepareDisplay('page', bounds, f.scope, new AbortController().signal);
    await tick();
    const wire = f.envelope();
    await f.call({
      action: 'rendered',
      attachment: wire.attachment,
      pageToken: wire.pageToken,
      revision: wire.snapshot.revision,
    });
    expect(await prepared).toBe(true);
    expect(f.root.getBounds().width).toBe(1000);
    expect(f.window.contentView.children.indexOf(f.chrome() as never)).toBeLessThan(
      f.window.contentView.children.indexOf(f.root as never),
    );
    expect(f.host.offerDisplay('page', bounds, f.scope)).toBe(true);
    expect(f.envelope()).toMatchObject({
      hosted: true,
      actionable: false,
      snapshot: { hosted: false },
    });
    f.publish(f.snapshot(2, true));
    expect(f.host.readyFor('page')).toBe(true);
  } finally {
    f.host.dispose();
  }
});

test('a first about:blank allocation preserves the Root intent and waits for its real HTTP binding', async () => {
  const f = fixture();
  try {
    f.page.webContents.url = 'about:blank';
    f.publish(f.snapshot(1));
    await tick();
    expect(views).toHaveLength(2);
    const previous = f.envelope();
    expect(previous.hosted).toBe(false);
    f.page.webContents.url = 'https://example.com/weather';
    f.token('committed-first-document');
    f.host.update();
    await tick();
    expect(views).toHaveLength(3);
    expect(f.envelope().attachment).not.toBe(previous.attachment);
    expect(f.envelope()).toMatchObject({
      hosted: false,
      actionable: false,
      snapshot: { revision: 1 },
    });
    expect(f.root.getBounds().width).toBe(1000);
    await f.prime();
    expect(f.envelope().hosted).toBe(true);
    expect(f.host.readyFor('page')).toBe(false);
  } finally {
    f.host.dispose();
  }
});

test('a zero-sized DOM render receipt cannot offer Chrome before its current full native frame', async () => {
  const f = fixture();
  try {
    f.publish(f.snapshot(1));
    await tick();
    const contents = f.chrome().webContents;
    contents.autoFrames = false;
    let captures = 0,
      settled = false;
    contents.capturePage = async () => {
      captures++;
      return contents.frameImage();
    };
    const bounds = { x: 600, y: 96, width: 400, height: 604 };
    const ready = f.host
      .prepareDisplay('page', bounds, f.scope, new AbortController().signal)
      .then((value) => {
        settled = true;
        return value;
      });
    const wire = f.envelope();
    await f.call({
      action: 'rendered',
      attachment: wire.attachment,
      pageToken: wire.pageToken,
      revision: 1,
    });
    await tick();
    expect(settled).toBe(false);
    expect(captures).toBe(0);
    expect(contents.frameStarts).toBe(1);
    expect(f.host.offerDisplay('page', bounds, f.scope)).toBe(false);
    const receive = contents.frame!;
    receive({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }) });
    receive({ isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }) });
    await tick();
    expect(settled).toBe(false);
    receive(contents.frameImage());
    expect(await ready).toBe(true);
    expect(contents.frameEnds).toBe(1);
    expect(f.host.offerDisplay('page', bounds, f.scope)).toBe(true);
    expect(captures).toBe(0);
  } finally {
    f.host.dispose();
  }
});

test('a same-sized newer DOM revision uses its established surface without requiring another paint', async () => {
  const f = fixture();
  try {
    f.publish(f.snapshot(1));
    await tick();
    const contents = f.chrome().webContents;
    contents.autoFrames = false;
    const controller = new AbortController(),
      bounds = { x: 600, y: 96, width: 400, height: 604 };
    const first = f.host.prepareDisplay('page', bounds, f.scope, controller.signal);
    const wire = f.envelope();
    await f.call({
      action: 'rendered',
      attachment: wire.attachment,
      pageToken: wire.pageToken,
      revision: 1,
    });
    contents.frame!(contents.frameImage());
    expect(await first).toBe(true);
    let captures = 0,
      settled = false;
    contents.capturePage = async () => {
      captures++;
      return contents.frameImage();
    };
    f.publish(f.snapshot(2));
    await f.call({
      action: 'rendered',
      attachment: wire.attachment,
      pageToken: wire.pageToken,
      revision: 2,
    });
    const second = f.host
      .prepareDisplay('page', bounds, f.scope, controller.signal)
      .then((value) => {
        settled = true;
        return value;
      });
    await tick();
    expect(settled).toBe(true);
    expect(await second).toBe(true);
    expect(contents.frameStarts).toBe(1);
    expect(captures).toBe(1);
    expect(f.host.offerDisplay('page', bounds, f.scope)).toBe(true);
  } finally {
    f.host.dispose();
  }
});

test('a cancelled current-revision capture keeps the single read slot until it settles and cannot ready its replacement', async () => {
  const f = fixture();
  try {
    f.publish(f.snapshot(1));
    await tick();
    const contents = f.chrome().webContents,
      bounds = { x: 600, y: 96, width: 400, height: 604 };
    contents.autoFrames = false;
    const firstController = new AbortController();
    const first = f.host.prepareDisplay('page', bounds, f.scope, firstController.signal);
    const wire = f.envelope(),
      rendered = (revision: number) => ({
        action: 'rendered',
        attachment: wire.attachment,
        pageToken: wire.pageToken,
        revision,
      });
    await f.call(rendered(1));
    contents.frame!(contents.frameImage());
    expect(await first).toBe(true);
    let complete!: (image: ReturnType<FakeContents['frameImage']>) => void,
      reads = 0;
    contents.capturePage = () => {
      reads++;
      return new Promise((resolve) => {
        complete = resolve;
      });
    };
    f.publish(f.snapshot(2));
    await f.call(rendered(2));
    const previous = f.host.prepareDisplay('page', bounds, f.scope, firstController.signal);
    await tick();
    expect(reads).toBe(1);
    firstController.abort();
    expect(await previous).toBe(false);
    let settled = false;
    const replacement = f.host
      .prepareDisplay('page', bounds, f.scope, new AbortController().signal)
      .then((ready) => {
        settled = true;
        return ready;
      });
    await tick();
    expect(contents.frameStarts).toBe(1);
    expect(reads).toBe(1);
    complete(contents.frameImage());
    await tick();
    expect(settled).toBe(false);
    expect(contents.frameStarts).toBe(2);
    contents.frame!(contents.frameImage());
    expect(await replacement).toBe(true);
    expect(reads).toBe(1);
    expect(f.host.offerDisplay('page', bounds, f.scope)).toBe(true);
  } finally {
    f.host.dispose();
  }
});

test('missing native frames have a bounded deadline and late deadlines or callbacks cannot withdraw an adopted shell', async () => {
  const f = fixture(),
    original = globalThis.setTimeout,
    deadlines: (() => void)[] = [];
  try {
    f.publish(f.snapshot(1));
    await tick();
    const contents = f.chrome().webContents,
      bounds = { x: 600, y: 96, width: 400, height: 604 };
    contents.autoFrames = false;
    globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
      const [callback, milliseconds, ...parameters] = args;
      if (milliseconds === 1500) deadlines.push(() => callback(...parameters));
      return original(...args);
    }) as typeof setTimeout;
    const previous = f.host.prepareDisplay('page', bounds, f.scope, new AbortController().signal);
    const wire = f.envelope();
    await f.call({
      action: 'rendered',
      attachment: wire.attachment,
      pageToken: wire.pageToken,
      revision: 1,
    });
    const oldFrame = contents.frame!;
    deadlines[0]!();
    expect(await previous).toBe(false);
    expect(contents.frameEnds).toBe(1);
    expect(f.chrome().getVisible()).toBe(false);
    const next = f.host.prepareDisplay('page', bounds, f.scope, new AbortController().signal);
    oldFrame(contents.frameImage());
    deadlines[0]!();
    expect(f.host.offerDisplay('page', bounds, f.scope)).toBe(false);
    contents.frame!(contents.frameImage());
    expect(await next).toBe(true);
    expect(f.host.offerDisplay('page', bounds, f.scope)).toBe(true);
    f.publish(f.snapshot(2, true));
    expect(f.host.layout('page', bounds, f.scope)).toBe(true);
    for (const expire of deadlines) expire();
    oldFrame(contents.frameImage());
    expect(f.host.readyFor('page')).toBe(true);
    expect(f.chrome().getVisible()).toBe(true);
    expect(f.root.getBounds().width).toBe(600);
  } finally {
    globalThis.setTimeout = original;
    f.host.dispose();
  }
});

test('Chrome render receipts are exact readonly facts and retired native frame callbacks cannot complete a newer revision', async () => {
  const f = fixture();
  try {
    f.publish(f.snapshot(1));
    await tick();
    const contents = f.chrome().webContents;
    contents.autoFrames = false;
    const controller = new AbortController(),
      bounds = { x: 600, y: 96, width: 400, height: 604 };
    const prepared = f.host.prepareDisplay('page', bounds, f.scope, controller.signal);
    const env = f.envelope(),
      ack = {
        action: 'rendered',
        attachment: env.attachment,
        pageToken: env.pageToken,
        revision: 1,
      };
    for (const changed of [
      { ...ack, attachment: 'retired' },
      { ...ack, pageToken: 'retired' },
      { ...ack, revision: 2 },
    ]) {
      expect(f.call(changed)).toBeUndefined();
    }
    for (const changed of [
      { ...ack, sequence: 1 },
      { ...ack, action: 'rendered', code: 'unsafe' },
      { ...ack, revision: 0 },
      { ...ack, revision: 1.5 },
      { ...ack, pageToken: '' },
    ]) {
      expect(() => f.call(changed)).toThrow('invalid_browser_chrome_request');
    }
    expect(() => f.call(ack, f.root.webContents)).toThrow('native_sender_denied');
    expect(() =>
      f.handlers.get(nativeBrowserChromeChannel)!(
        { sender: f.chrome().webContents, senderFrame: { url: 'http://localhost/' } } as never,
        ack,
      ),
    ).toThrow('native_sender_denied');
    expect(contents.frameStarts).toBe(0);
    await f.call(ack);
    await tick();
    const oldFrame = contents.frame!;
    expect(contents.frameStarts).toBe(1);
    expect(f.envelope()).toMatchObject({ hosted: false, actionable: false });
    f.publish(f.snapshot(2));
    expect(contents.frameEnds).toBe(1);
    expect(f.call(ack)).toBeUndefined();
    await f.call({ ...ack, revision: 2 });
    await tick();
    expect(contents.frameStarts).toBe(2);
    const image = { isEmpty: () => false, getSize: () => ({ width: 400, height: 96 }) };
    oldFrame(image);
    await tick();
    expect(contents.frameEnds).toBe(1);
    expect(f.host.offerDisplay('page', bounds, f.scope)).toBe(false);
    contents.frame!(image);
    expect(await prepared).toBe(true);
    expect(contents.frameEnds).toBe(2);
    await f.call({ ...ack, revision: 2 });
    await tick();
    expect(contents.frameStarts).toBe(2);
    expect(f.host.offerDisplay('page', bounds, f.scope)).toBe(true);
    expect(f.envelope().actionable).toBe(false);
  } finally {
    f.host.dispose();
  }
});

test('Chrome ignores render receipts retired by window rebind and subsequent resize without confirming fresh display', async () => {
  const f = fixture();
  const receipt = (env: NativeBrowserChromeEnvelope) => ({
    action: 'rendered',
    attachment: env.attachment,
    pageToken: env.pageToken,
    revision: env.snapshot.revision,
  });
  try {
    await f.activate();
    const beforeHide = receipt(f.envelope()),
      contents = f.chrome().webContents,
      document = f.page.webContents;
    contents.autoFrames = false;
    // Reopening retires the former presentation, while keeping the same Page.
    f.page.setVisible(false);
    f.host.release('page');
    const previousStarts = contents.frameStarts;
    expect(f.call(beforeHide)).toBeUndefined();
    expect(contents.frameStarts).toBe(previousStarts);
    f.publish(f.snapshot(3));
    await tick();
    const reopened = receipt(f.envelope());
    expect(reopened.attachment).not.toBe(beforeHide.attachment);
    const bounds = { x: 600, y: 96, width: 400, height: 604 };
    const prepared = f.host.prepareDisplay('page', bounds, f.scope, new AbortController().signal);
    expect(f.call(beforeHide)).toBeUndefined();
    await tick();
    expect(contents.frameStarts).toBe(previousStarts);
    expect(f.host.offerDisplay('page', bounds, f.scope)).toBe(false);
    expect(f.envelope()).toMatchObject({ hosted: false, actionable: false });
    f.call(reopened);
    expect(contents.frameStarts).toBe(previousStarts + 1);
    contents.frame!(contents.frameImage());
    expect(await prepared).toBe(true);
    expect(f.host.offerDisplay('page', bounds, f.scope)).toBe(true);
    f.publish(f.snapshot(4, true));
    expect(f.layout('page', bounds, f.scope)).toBe(true);
    f.page.setVisible(true);
    const beforeResize = receipt(f.envelope());
    f.size[0] = 1100;
    f.host.invalidateGeometry();
    f.host.syncViewport();
    await tick();
    f.publish(f.snapshot(5, true));
    const resized = { x: 650, y: 96, width: 450, height: 604 };
    expect(f.layout('page', resized, f.scope)).toBe(true);
    const current = receipt(f.envelope()),
      starts = contents.frameStarts,
      state = f.host.displayState();
    expect(current.attachment).not.toBe(beforeResize.attachment);
    for (const stale of [beforeHide, reopened, beforeResize]) {
      expect(f.call(stale)).toBeUndefined();
      expect(contents.frameStarts).toBe(starts);
      expect(f.host.displayState()).toEqual(state);
      expect(f.envelope()).toMatchObject({
        attachment: current.attachment,
        snapshot: { revision: current.revision },
      });
    }
    f.call(current);
    expect(contents.frameStarts).toBe(starts);
    expect(f.host.displayState()).toMatchObject({ kind: 'page', presented: true });
    expect(f.page.getBounds()).toEqual(resized);
    expect(f.page.webContents).toBe(document);
    expect(document.getURL()).toBe('https://example.com/weather');
    expect(document.isDestroyed()).toBe(false);
    expect(
      f.root.webContents.sent.filter((item) => item.channel === nativeBrowserChromeActionChannel),
    ).toEqual([]);
  } finally {
    f.host.dispose();
  }
});

for (const phase of ['waiting', 'ready'] as const)
  for (const boundary of [
    'abort',
    'resize',
    'scope',
    'root',
    'token',
    'getter-cleared',
    'withdraw',
    'covered',
    'dispose',
  ] as const)
    test(`a ${phase} first Chrome frame cannot survive ${boundary} or revive after a late receipt`, async () => {
      const f = fixture();
      try {
        f.publish(f.snapshot(1));
        await tick();
        const chrome = f.chrome().webContents;
        chrome.autoFrames = phase === 'ready';
        const controller = new AbortController(),
          bounds = { x: 600, y: 96, width: 400, height: 604 };
        const prepared = f.host.prepareDisplay('page', bounds, f.scope, controller.signal);
        const env = f.envelope();
        const sent = f.call({
          action: 'rendered',
          attachment: env.attachment,
          pageToken: env.pageToken,
          revision: 1,
        });
        const lateFrame = chrome.frame!;
        await sent;
        if (phase === 'ready') expect(await prepared).toBe(true);
        const contents = f.page.webContents;
        if (boundary === 'abort') controller.abort();
        if (boundary === 'resize') {
          f.size[0] = 900;
          f.host.invalidateGeometry();
        }
        if (boundary === 'scope') {
          f.select({ ...f.scope, viewSelection: 3 });
          f.host.update();
        }
        if (boundary === 'root')
          f.root.webContents.emit('did-start-navigation', {}, 'http://localhost/', false, true);
        if (boundary === 'token') {
          f.token('replacement-document');
          f.host.update();
        }
        if (boundary === 'getter-cleared') {
          Reflect.set(f.page, 'webContents', undefined);
          f.host.update();
          Reflect.set(f.page, 'webContents', contents);
        }
        if (boundary === 'withdraw') f.publish(null);
        if (boundary === 'covered') f.publish({ ...f.snapshot(2), covered: true });
        if (boundary === 'dispose') f.host.dispose();
        if (phase === 'waiting') expect(await prepared).toBe(false);
        lateFrame(chrome.frameImage());
        expect(chrome.frameEnds).toBe(1);
        expect(f.host.offerDisplay('page', bounds, f.scope)).toBe(false);
        expect(f.host.readyFor('page')).toBe(false);
        expect(f.chrome().getVisible()).toBe(false);
        expect(f.root.getBounds().width).toBe(1000); // Controller, not Host invalidation, resizes Root.
        expect(contents.destroyed).toBe(false);
      } finally {
        f.host.dispose();
      }
    });

test('a failed Chrome own-frame read preserves Root controls and can prepare again without poisoning the Host', async () => {
  const f = fixture();
  try {
    f.publish(f.snapshot(1));
    await tick();
    const contents = f.chrome().webContents,
      subscribe = contents.beginFrameSubscription.bind(contents);
    contents.beginFrameSubscription = () => {
      throw Error('temporary-own-frame-unavailable');
    };
    const bounds = { x: 600, y: 96, width: 400, height: 604 };
    const prepared = f.host.prepareDisplay('page', bounds, f.scope, new AbortController().signal);
    const env = f.envelope();
    await f.call({
      action: 'rendered',
      attachment: env.attachment,
      pageToken: env.pageToken,
      revision: 1,
    });
    expect(await prepared).toBe(false);
    expect(f.envelope()).toMatchObject({
      hosted: false,
      actionable: false,
      snapshot: { toolbar: { canNavigate: true } },
    });
    expect(f.root.getBounds().width).toBe(1000);
    expect(f.chrome().getVisible()).toBe(false);
    expect(f.suspended).toEqual([]);
    contents.beginFrameSubscription = subscribe;
    await f.prime();
    expect(f.envelope().hosted).toBe(true);
  } finally {
    f.host.dispose();
  }
});

for (const boundary of ['new-tab', 'same-id-nav', 'old-loading'] as const)
  test(`a current native shell survives ${boundary} while its next binding still needs fresh acknowledgement`, async () => {
    const f = fixture();
    try {
      await f.activate();
      f.addPage('second');
      const writes = f.root.boundsHistory.length,
        visibility = f.chrome().visibilityHistory.length;
      if (boundary === 'same-id-nav') {
        f.token('new-document');
        f.publish(f.snapshot(3, true));
      } else {
        if (boundary === 'old-loading') {
          f.publish(retainedSnapshot(f, 3, 'page'));
          f.page.webContents.loadingMain = true;
        }
        f.publish(retainedSnapshot(f, boundary === 'old-loading' ? 4 : 3, 'second'));
      }
      expect(f.root.getBounds().width).toBe(600);
      expect(f.root.boundsHistory.slice(writes).some((bounds) => bounds.width === 1000)).toBe(
        false,
      );
      expect(f.chrome().visibilityHistory.slice(visibility)).not.toContain(false);
      expect(f.host.readyFor(boundary === 'same-id-nav' ? 'page' : 'second')).toBe(false);
      f.host.release();
      expect(f.root.getBounds().width).toBe(1000);
    } finally {
      f.host.dispose();
    }
  });

test('a prepared exact target keeps its shell after real source destruction without granting the retired source or reusing its ACK', async () => {
  const f = fixture();
  try {
    await f.activate();
    const second = f.addPage('second');
    const bounds = f.page.getBounds();
    second.setBounds(bounds);
    second.setVisible(true);
    f.prepare('page', 'second');
    f.page.webContents.close();
    f.host.update();
    expect(f.root.getBounds().width).toBe(600);
    expect(f.chrome().getVisible()).toBe(true);
    expect(f.host.readyFor('page')).toBe(false);
    f.publish(retainedSnapshot(f, 3, 'second'));
    expect(f.root.getBounds().width).toBe(600);
    expect(f.host.readyFor('second')).toBe(false);
    f.publish(retainedSnapshot(f, 4, 'second'));
    expect(f.host.readyFor('second')).toBe(true);
    expect(f.host.layout('second', bounds, f.scope)).toBe(true);
    f.host.completePresentation('second');
    expect(f.root.getBounds().width).toBe(600);
    expect(second.getVisible()).toBe(true);
  } finally {
    f.host.dispose();
  }
});

test('a live presentation hold ends only after the exact new page is visible, not when its layout commits', async () => {
  const f = fixture();
  try {
    await f.activate();
    const second = f.addPage('second');
    f.publish(retainedSnapshot(f, 3, 'page'));
    const next = retainedSnapshot(f, 4, 'second');
    f.publish(next);
    const held = f.host.holdsPresentation('page')!;
    expect(held.viewport).toEqual({ x: 600, y: 96, width: 400, height: 604 });
    expect(f.host.holdsPresentation('second')).toBeUndefined();
    expect(f.host.readyFor('second')).toBe(false);
    f.publish({ ...next, revision: 5, hosted: true });
    expect(f.host.layout('second', held.viewport, f.scope)).toBe(true);
    expect(f.host.holdsPresentation('page')?.key).toBe(held.key);
    f.host.completePresentation('second');
    expect(f.host.holdsPresentation('page')?.key).toBe(held.key);
    second.setBounds(held.viewport);
    second.setVisible(true);
    f.host.update();
    // Fresh target toolbar/tab actions remain available; the native body shield
    // separately protects the held source and can be cancelled by another tab.
    expect(f.envelope().actionable).toBe(true);
    f.host.completePresentation('second');
    expect(f.host.holdsPresentation('page')).toBeUndefined();
    expect(f.holdEnds).toEqual([{ id: 'page', key: held.key }]);
    expect(f.envelope().actionable).toBe(true);
  } finally {
    f.host.dispose();
  }
});

for (const boundary of [
  'resize',
  'scope',
  'old-token',
  'new-page',
  'root',
  'geometry',
  'cancel',
  'old-loading',
  'new-loading',
  'dispose',
] as const)
  test(`a live presentation hold actively retires its old page after ${boundary}`, async () => {
    const f = fixture();
    try {
      await f.activate();
      const second = f.addPage('second');
      f.publish(retainedSnapshot(f, 3, 'page'));
      const next = retainedSnapshot(f, 4, 'second');
      f.publish(next);
      const held = f.host.holdsPresentation('page')!;
      expect(held).toBeDefined();
      if (boundary === 'resize') f.host.invalidateGeometry();
      if (boundary === 'scope') {
        f.select();
        f.host.update();
      }
      if (boundary === 'old-token') {
        f.token('new-navigation');
        f.host.update();
      }
      if (boundary === 'new-page') {
        f.addPage('second');
        f.host.update();
      }
      if (boundary === 'root')
        f.root.webContents.emit('did-start-navigation', {}, 'http://localhost/', false, true);
      if (boundary === 'geometry') {
        f.publish({ ...next, revision: 5, hosted: true });
        expect(f.host.layout('second', { ...held.viewport, x: 610, width: 390 }, f.scope)).toBe(
          true,
        );
      }
      if (boundary === 'cancel') f.host.cancelPresentationHold('second');
      if (boundary === 'old-loading') {
        f.page.webContents.loadingMain = true;
        f.host.update();
      }
      if (boundary === 'new-loading') {
        second.webContents.loadingMain = true;
        f.host.update();
      }
      if (boundary === 'dispose') f.host.dispose();
      expect(f.host.holdsPresentation('page')).toBeUndefined();
      expect(f.holdEnds).toEqual([{ id: 'page', key: held.key }]);
      f.host.cancelPresentationHold();
      expect(f.holdEnds).toHaveLength(1);
    } finally {
      f.host.dispose();
    }
  });

test('a retained same-scope page switch keeps native shell geometry while requiring a fresh target ACK', async () => {
  const f = fixture();
  const second = f.addPage('second');
  try {
    await f.activate();
    const previous = retainedSnapshot(f, 3, 'page');
    f.publish(previous);
    const old = f.envelope();
    const bounds = f.root.getBounds();
    const writes = f.root.boundsHistory.length;
    const visibility = f.chrome().visibilityHistory.length;
    const states = f.root.webContents.sent.length;
    const next = retainedSnapshot(f, 4, 'second');
    f.publish(next);
    expect(f.root.getBounds()).toEqual(bounds);
    expect(f.root.boundsHistory.slice(writes)).toEqual([]);
    expect(f.chrome().visibilityHistory.slice(visibility)).not.toContain(false);
    expect(
      f.root.webContents.sent
        .slice(states)
        .filter((item) => item.channel === nativeBrowserChromeStateChannel)
        .every((item) => item.value !== null),
    ).toBe(true);
    expect(f.suspended).toEqual(['page']);
    expect(f.envelope()).toMatchObject({
      hosted: true,
      actionable: false,
      snapshot: { hosted: false },
    });
    expect(f.envelope().attachment).not.toBe(old.attachment);
    expect(f.envelope().pageToken).not.toBe(old.pageToken);
    expect(f.host.readyFor('second')).toBe(false);
    expect(
      await f.call({
        action: 'send',
        event: {
          attachment: old.attachment,
          pageToken: old.pageToken,
          sequence: 1,
          revision: 3,
          part: 'toolbar',
          action: { type: 'reload' },
        },
      }),
    ).toBe('stale');
    f.host.release('page'); // the old Pane's later hide cannot revoke the new shell
    expect(f.root.getBounds()).toEqual(bounds);
    f.publish({ ...next, revision: 5, hosted: true });
    expect(f.host.readyFor('second')).toBe(true);
    expect(f.host.layout('second', { x: 600, y: 96, width: 400, height: 604 }, f.scope)).toBe(true);
    expect(f.root.getBounds()).toEqual(bounds);
    f.host.update();
    expect(f.envelope().actionable).toBe(false); // controller has not shown the new page
    expect(second.getVisible()).toBe(false);
    f.host.release('second');
    expect(f.root.getBounds().width).toBe(1000);
    expect(f.chrome().getVisible()).toBe(false);
  } finally {
    f.host.dispose();
  }
});

test('late handoff deadlines cannot withdraw a completed target or its later ABA replacement', async () => {
  const f = fixture();
  const original = globalThis.setTimeout;
  const deadlines: (() => void)[] = [];
  try {
    await f.activate();
    const second = f.addPage('second');
    globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
      const [callback, milliseconds, ...parameters] = args;
      if (milliseconds === 1500) deadlines.push(() => callback(...parameters));
      return original(...args);
    }) as typeof setTimeout;
    f.publish(retainedSnapshot(f, 3, 'page'));
    f.publish(retainedSnapshot(f, 4, 'second'));
    const first = f.host.holdsPresentation('page')!;
    f.publish(retainedSnapshot(f, 5, 'second'));
    expect(f.host.layout('second', first.viewport, f.scope)).toBe(true);
    second.setBounds(first.viewport);
    second.setVisible(true);
    f.host.completePresentation('second');
    deadlines[0]!();
    expect(f.host.readyFor('second')).toBe(true);
    f.publish(retainedSnapshot(f, 6, 'page'));
    const next = f.host.holdsPresentation('second')!;
    deadlines[0]!();
    expect(f.host.holdsPresentation('second')?.key).toBe(next.key);
    f.publish(retainedSnapshot(f, 7, 'page'));
    expect(f.host.layout('page', next.viewport, f.scope)).toBe(true);
    f.page.setBounds(next.viewport);
    f.host.completePresentation('page');
    deadlines[1]!();
    expect(f.host.readyFor('page')).toBe(true);
    expect(f.root.getBounds().width).toBe(600);
    expect(f.chrome().getVisible()).toBe(true);
    expect(f.holdEnds).toEqual([
      { id: 'page', key: first.key },
      { id: 'second', key: next.key },
    ]);
  } finally {
    globalThis.setTimeout = original;
    f.host.dispose();
  }
});

for (const source of ['old-toolbar', 'new-toolbar', 'old-main', 'new-main'] as const)
  test(`a loading ${source} page cannot become a live presentation hold`, async () => {
    const f = fixture();
    try {
      await f.activate();
      const second = f.addPage('second');
      const previous = retainedSnapshot(f, 3, 'page'),
        next = retainedSnapshot(f, 4, 'second');
      if (source === 'old-toolbar') previous.toolbar.loading = true;
      if (source === 'new-toolbar') next.toolbar.loading = true;
      f.publish(previous);
      if (source === 'old-main') f.page.webContents.loadingMain = true;
      if (source === 'new-main') second.webContents.loadingMain = true;
      f.publish(next);
      expect(f.host.holdsPresentation('page')).toBeUndefined();
      expect(f.root.getBounds().width).toBe(600); // loading forbids old pixels, not the exact shell
    } finally {
      f.host.dispose();
    }
  });

test('an unconfirmed retained-page handoff restores the full Root and cannot reuse its late ACK', async () => {
  const f = fixture();
  f.addPage('second');
  try {
    await f.activate();
    const previous = retainedSnapshot(f, 3, 'page');
    f.publish(previous);
    const next = retainedSnapshot(f, 4, 'second');
    f.publish(next);
    expect(f.root.getBounds().width).toBe(600);
    const held = f.host.holdsPresentation('page')!;
    await Bun.sleep(1530);
    expect(f.holdEnds).toEqual([{ id: 'page', key: held.key }]);
    expect(f.root.getBounds().width).toBe(1000);
    expect(f.chrome().getVisible()).toBe(false);
    expect(f.suspended).toEqual(['page', 'second']);
    f.publish({ ...next, revision: 5, hosted: true });
    expect(f.host.readyFor('second')).toBe(false);
    expect(f.host.layout('second', { x: 600, y: 96, width: 400, height: 604 }, f.scope)).toBe(
      false,
    );
    expect(f.root.getBounds().width).toBe(1000);
  } finally {
    f.host.dispose();
  }
});

test('a retained handoff cannot keep the split for an unknown document or after scope withdrawal', async () => {
  for (const boundary of ['unknown-document', 'scope'] as const) {
    const f = fixture();
    f.addPage(
      'second',
      boundary === 'unknown-document' ? 'about:blank' : 'https://example.org/retained',
    );
    try {
      await f.activate();
      const previous = retainedSnapshot(f, 3, 'page');
      f.publish(previous);
      const next = retainedSnapshot(f, 4, 'second');
      f.publish(next);
      if (boundary === 'scope') {
        expect(f.root.getBounds().width).toBe(600);
        f.select({ ...f.scope, generation: f.scope.generation + 1 });
        f.host.update();
      }
      expect(f.root.getBounds().width).toBe(1000);
      expect(f.chrome().getVisible()).toBe(false);
      expect(f.host.readyFor('second')).toBe(false);
    } finally {
      f.host.dispose();
    }
  }
});

test('lazy explicit Root migration preserves original owner and page/shield peers; hosted handshake precedes physical clipping', async () => {
  const f = fixture();
  try {
    expect(views.length).toBe(2);
    f.publish(f.snapshot(1));
    await tick();
    expect(views.length).toBe(3);
    expect(Object.is(f.window.webContents, f.root.webContents)).toBe(true);
    expect(f.window.contentView.children.length).toBe(4);
    expect(
      f.window.contentView.children.every((child, index) =>
        Object.is(child, [f.root, f.page, f.shield, f.chrome()][index]),
      ),
    ).toBe(true);
    expect(f.root.getBounds().width).toBe(1000);
    expect(f.envelope()).toMatchObject({ hosted: false, actionable: false });
    expect(f.host.readyFor('page')).toBe(false);
    await f.prime();
    expect(f.envelope()).toMatchObject({ hosted: true, actionable: false });
    f.publish(f.snapshot(2, true));
    await tick();
    expect(f.ready).toEqual(['page']);
    expect(f.root.getBounds().width).toBe(1000);
    expect(f.host.layout('page', { x: 600, y: 96, width: 400, height: 604 }, f.scope)).toBe(true);
    f.host.update();
    expect(f.root.getBounds()).toEqual({ x: 0, y: 0, width: 600, height: 700 });
    expect(f.chrome().getBounds()).toEqual({ x: 600, y: 0, width: 400, height: 96 });
    expect(f.page.getBounds()).toEqual({ x: 0, y: 0, width: 1000, height: 700 }); // Host never moves the page.
    expect(
      f.root.webContents.commands.every(
        (item) => item.method === 'Emulation.setDeviceMetricsOverride',
      ),
    ).toBe(true);
    expect(f.root.webContents.commands[0]!.params).toEqual({
      width: 1000,
      height: 700,
      deviceScaleFactor: 0,
      mobile: false,
      dontSetVisibleSize: true,
    });
  } finally {
    f.host.dispose();
  }
  await tick();
  expect(f.window.contentView.children.length).toBe(3);
  expect(
    f.window.contentView.children.every((child, index) =>
      Object.is(child, [f.root, f.page, f.shield][index]),
    ),
  ).toBe(true);
  expect(f.root.children).toEqual([]);
  expect(f.chrome().webContents.destroyed).toBe(true);
});

test('same-binding revisions retain typed input, strict actions and exact Root acknowledgements never replay', async () => {
  const f = fixture();
  try {
    await f.activate();
    const env = f.envelope();
    const text = f.call({
      action: 'send',
      event: {
        attachment: env.attachment,
        pageToken: env.pageToken,
        sequence: 1,
        revision: 1,
        part: 'toolbar',
        action: { type: 'address-change', value: 'typed text' },
      },
    }) as Promise<unknown>;
    f.acknowledge(1, true, f.chrome().webContents);
    f.acknowledge(1);
    expect(await text).toBe('forwarded');
    expect(await f.send(1)).toBe('stale');
    expect(await f.send(2, 1)).toBe('stale');
    const action = f.send(2);
    f.acknowledge(2, false);
    expect(await action).toBe('stale');
    expect(
      f.root.webContents.sent.filter((item) => item.channel === nativeBrowserChromeActionChannel),
    ).toHaveLength(2);
    const pending = f.send(3);
    f.host.release('page');
    expect(await pending).toBe('unconfirmed');
    expect(f.root.getBounds().width).toBe(1000);
  } finally {
    f.host.dispose();
  }
});

test('grant identity cannot authorize UI input; token, selected scope, and retired frame reject stale actions', async () => {
  const f = fixture();
  try {
    await f.activate();
    f.input(undefined);
    expect(await f.send(1)).toBe('stale');
    f.input(f.scope);
    f.token('new-document');
    expect(await f.send(1)).toBe('stale');
    f.host.update();
    expect(f.suspended).toEqual(['page']);
    expect(f.root.getBounds().width).toBe(1000);
    f.select({ ...f.scope, viewSelection: 4 });
    expect(() => f.publish(f.snapshot(3, true))).toThrow('browser_chrome_scope_denied');
    const oldFrame = f.chrome().webContents.mainFrame;
    f.chrome().webContents.mainFrame = { url: 'http://localhost/' };
    expect(() => f.call({ action: 'read' })).toThrow('native_sender_denied');
    f.chrome().webContents.mainFrame = oldFrame;
  } finally {
    f.host.dispose();
  }
});

test('geometry changes retire anchors and pending confirmations; current anchors stay inside Chrome and translate to Root CSS', async () => {
  const f = fixture();
  try {
    await f.activate();
    const before = f.envelope();
    const action = {
      attachment: before.attachment,
      pageToken: before.pageToken,
      sequence: 1,
      revision: 2,
      part: 'toolbar',
      action: { type: 'show-options', anchor: { x: 10, y: 10, width: 20, height: 20 } },
    };
    const pending = f.call({ action: 'send', event: action }) as Promise<unknown>;
    expect(
      f.root.webContents.sent
        .filter((item) => item.channel === nativeBrowserChromeActionChannel)
        .at(-1)?.value,
    ).toMatchObject({ action: { anchor: { x: 610, y: 10 } } });
    f.size[0] = 820;
    f.host.invalidateGeometry();
    expect(f.envelope().actionable).toBe(false);
    expect(f.layout('page', { x: 510, y: 96, width: 310, height: 604 }, f.scope)).toBe(true);
    expect(await pending).toBe('unconfirmed');
    expect(f.envelope().attachment).not.toBe(before.attachment);
    expect(await f.call({ action: 'send', event: action })).toBe('stale');
    const current = f.envelope();
    expect(
      await f.call({
        action: 'send',
        event: {
          ...action,
          attachment: current.attachment,
          action: { type: 'show-options', anchor: { x: 0, y: 90, width: 20, height: 20 } },
        },
      }),
    ).toBe('stale');
    const attachment = current.attachment;
    f.layout('page', { x: 510, y: 96, width: 310, height: 604 }, f.scope);
    expect(f.envelope().attachment).toBe(attachment);
  } finally {
    f.host.dispose();
  }
});

test('metrics rejection restores full Root, suspends exact page once, and late completion cannot resurrect bounds', async () => {
  const f = fixture();
  try {
    await f.activate();
    let reject!: (error: Error) => void;
    f.root.webContents.command = () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      });
    f.size[0] = 820;
    f.host.invalidateGeometry();
    f.host.syncViewport();
    reject(Error('metrics transport failed'));
    await tick();
    expect(f.root.getBounds()).toEqual({ x: 0, y: 0, width: 820, height: 700 });
    expect(f.chrome().getVisible()).toBe(false);
    expect(f.suspended).toEqual(['page']);
    expect(f.host.readyFor('page')).toBe(false);
    expect(f.page.webContents.destroyed).toBe(false);
    const commands = f.root.webContents.commands.length;
    f.host.syncViewport();
    f.host.syncViewport();
    expect(f.root.webContents.commands).toHaveLength(commands);
  } finally {
    f.host.dispose();
  }
});

test('host invalidation retires actions without scheduling; the controller requests only its latest viewport', async () => {
  const f = fixture();
  try {
    await f.activate();
    const commands = f.root.webContents.commands.length;
    const rootBounds = f.root.getBounds();
    const chromeBounds = f.chrome().getBounds();
    f.root.boundsHistory.length = 0;
    f.chrome().boundsHistory.length = 0;
    f.size[0] = 920;
    f.host.invalidateGeometry();
    f.size[0] = 820;
    f.size[1] = 650;
    f.host.invalidateGeometry();
    expect(f.envelope().actionable).toBe(false);
    expect(f.root.webContents.commands).toHaveLength(commands);
    expect(f.root.boundsHistory).toEqual([]);
    expect(f.chrome().boundsHistory).toEqual([]);
    expect(f.root.getBounds()).toEqual(rootBounds);
    expect(f.chrome().getBounds()).toEqual(chromeBounds);
    expect(await f.send(1)).toBe('stale');
    expect(f.window.listenerCount('resize')).toBe(1); // only the Root factory, never the Host
    f.host.syncViewport();
    await tick();
    expect(f.root.webContents.commands.slice(commands)).toEqual([
      {
        method: 'Emulation.setDeviceMetricsOverride',
        params: {
          width: 820,
          height: 650,
          deviceScaleFactor: 0,
          mobile: false,
          dontSetVisibleSize: true,
        },
      },
    ]);
    // Metrics cannot authorize old geometry; only the manager's current layout can.
    expect(f.envelope().actionable).toBe(false);
    expect(f.layout('page', { x: 510, y: 96, width: 310, height: 554 }, f.scope)).toBe(true);
    await tick();
    expect(f.envelope().actionable).toBe(true);
  } finally {
    f.host.dispose();
  }
});

test('unbound Root resize stays with its factory while viewport synchronization remains explicit', async () => {
  const f = fixture();
  try {
    await f.activate();
    f.host.release('page');
    await tick();
    f.root.boundsHistory.length = 0;
    const commands = f.root.webContents.commands.length;
    f.size[0] = 920;
    f.window.emit('resize');
    expect(f.root.getBounds()).toEqual({ x: 0, y: 0, width: 920, height: 700 });
    f.size[0] = 820;
    f.window.emit('resize');
    const expectedBounds = [
      { x: 0, y: 0, width: 920, height: 700 },
      { x: 0, y: 0, width: 820, height: 700 },
    ];
    expect(f.root.boundsHistory).toEqual(expectedBounds);
    expect(f.root.webContents.commands).toHaveLength(commands);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.root.boundsHistory).toEqual(expectedBounds);
    f.host.syncViewport();
    await tick();
    expect(f.root.boundsHistory).toEqual(expectedBounds);
    expect(f.root.webContents.commands.slice(commands)).toHaveLength(1);
    expect(f.root.webContents.commands.at(-1)?.params).toMatchObject({ width: 820, height: 700 });
    expect(f.chrome().getVisible()).toBe(false);
  } finally {
    f.host.dispose();
  }
});

test('disposing cancels late Host metrics and Chrome mutations while the live window restores its Root', async () => {
  const f = fixture();
  await f.activate();
  f.size[0] = 820;
  f.window.emit('resize');
  f.host.dispose();
  const commands = f.root.webContents.commands.length;
  const rootMutations = f.root.boundsHistory.length;
  const chromeMutations = f.chrome().boundsHistory.length;
  await new Promise<void>((resolve) => setImmediate(resolve));
  await tick();
  expect(f.root.webContents.commands).toHaveLength(commands);
  expect(f.root.boundsHistory.slice(rootMutations)).toEqual([]); // Factory sees the already-restored bounds.
  expect(f.chrome().boundsHistory).toHaveLength(chromeMutations);
  expect(f.chrome().webContents.destroyed).toBe(true);
  expect(f.root.webContents.attached).toBe(false);
});

test('covered, notes, restore issue and spoofed root cannot take over the toolbar', async () => {
  for (const change of ['covered', 'notes', 'restore', 'active', 'issue'] as const) {
    const f = fixture();
    try {
      const value = f.snapshot(1);
      if (change === 'covered') Object.assign(value, { covered: true });
      if (change === 'notes') Object.assign(value.toolbar, { notesOpen: true });
      if (change === 'restore') Object.assign(value.tabs, { restoring: true });
      if (change === 'active') Object.assign(value.tabs, { active: 'other' });
      if (change === 'issue') Object.assign(value.toolbar, { error: 'failed' });
      f.publish(value);
      await tick();
      expect(views.length).toBe(2);
      expect(f.host.readyFor('page')).toBe(false);
      expect(() =>
        f.handlers.get(nativeBrowserChromeRootChannel)!(f.event(f.page.webContents), f.snapshot(2)),
      ).toThrow('native_sender_denied');
    } finally {
      f.host.dispose();
    }
  }
});

test('owned metrics coalesce current size and a late old acknowledgement cannot crop a released Root', async () => {
  const f = fixture();
  let complete!: () => void;
  let first = true;
  f.root.webContents.command = () => {
    if (!first) return Promise.resolve({});
    first = false;
    return new Promise<void>((resolve) => {
      complete = resolve;
    });
  };
  try {
    f.publish(f.snapshot(1));
    await tick();
    expect(f.envelope().hosted).toBe(false);
    f.size[0] = 820;
    f.window.emit('resize');
    f.host.release();
    complete();
    await tick();
    expect(f.ready).toEqual([]);
    expect(f.root.getBounds()).toEqual({ x: 0, y: 0, width: 820, height: 700 });
    expect(f.root.webContents.commands.at(-1)?.params).toMatchObject({ width: 820, height: 700 });
    expect(f.chrome().getVisible()).toBe(false);
  } finally {
    f.host.dispose();
  }
});

test('foreign Root debugger is never borrowed, detached, or cleared', async () => {
  const f = fixture();
  const original = f.window.contentView;
  f.root.webContents.attached = true;
  try {
    f.publish(f.snapshot(1));
    await tick();
    expect(f.root.webContents.commands).toEqual([]);
    expect(f.root.webContents.attached).toBe(true);
    expect(f.window.contentView === original).toBe(true);
    expect(views.length).toBe(2);
    expect(f.suspended).toEqual(['page']);
  } finally {
    f.host.dispose();
  }
  expect(f.root.webContents.attached).toBe(true);
});

test('release and rebind the same actual page generate fresh wire identity without reviving old events', async () => {
  const f = fixture();
  try {
    await f.activate();
    const old = f.envelope();
    f.host.release('page');
    f.publish(f.snapshot(3));
    await tick();
    f.publish(f.snapshot(4, true));
    await tick();
    f.layout('page', { x: 600, y: 96, width: 400, height: 604 }, f.scope);
    const current = f.envelope();
    expect(current.pageToken).not.toBe(old.pageToken);
    expect(current.attachment).not.toBe(old.attachment);
    expect(
      await f.call({
        action: 'send',
        event: {
          attachment: old.attachment,
          pageToken: old.pageToken,
          sequence: 100,
          revision: 4,
          part: 'toolbar',
          action: { type: 'reload' },
        },
      }),
    ).toBe('stale');
  } finally {
    f.host.dispose();
  }
});

test('unacknowledged forwarding times out as unknown once and consumes the sequence', async () => {
  const f = fixture();
  try {
    await f.activate();
    expect(await f.send(1)).toBe('unconfirmed');
    expect(await f.send(1)).toBe('stale');
    expect(
      f.root.webContents.sent.filter((item) => item.channel === nativeBrowserChromeActionChannel),
    ).toHaveLength(1);
  } finally {
    f.host.dispose();
  }
});

test('zoom uses full DIP metrics, matches Chrome zoom and retires the old anchor coordinate basis', async () => {
  const f = fixture();
  try {
    await f.activate();
    const previous = f.envelope();
    f.root.webContents.zoom = 1.25;
    f.layout('page', { x: 600, y: 96, width: 400, height: 604 }, f.scope);
    await tick();
    expect(f.chrome().webContents.zoom).toBe(1.25);
    expect(f.root.webContents.commands.at(-1)?.params).toMatchObject({ width: 1000, height: 700 });
    expect(f.envelope().attachment).not.toBe(previous.attachment);
    const current = f.envelope();
    const pending = f.call({
      action: 'send',
      event: {
        attachment: current.attachment,
        pageToken: current.pageToken,
        sequence: 1,
        revision: 2,
        part: 'toolbar',
        action: { type: 'show-options', anchor: { x: 10, y: 10, width: 20, height: 20 } },
      },
    }) as Promise<unknown>;
    expect(
      f.root.webContents.sent
        .filter((item) => item.channel === nativeBrowserChromeActionChannel)
        .at(-1)?.value,
    ).toMatchObject({ action: { anchor: { x: 490, y: 10 } } });
    f.acknowledge(1);
    expect(await pending).toBe('forwarded');
  } finally {
    f.host.dispose();
  }
});

test('Chrome destruction or Root debugger detach restores full Root without destroying the actual page', async () => {
  for (const change of ['chrome', 'debugger'] as const) {
    const f = fixture();
    try {
      await f.activate();
      if (change === 'chrome') f.chrome().webContents.close();
      else f.root.webContents.debugger.detach();
      expect(f.root.getBounds().width).toBe(1000);
      expect(f.suspended).toEqual(['page']);
      expect(f.page.webContents.destroyed).toBe(false);
      expect(f.host.readyFor('page')).toBe(false);
    } finally {
      f.host.dispose();
    }
  }
});

test('an unexposed BrowserWindow primary Root is never guessed, replaced, or attached through a duplicate WebContents', async () => {
  const f = fixture();
  const overlay = new FakeView();
  overlay.addChildView(f.page);
  f.window.contentView = overlay as never;
  try {
    f.publish(f.snapshot(1));
    await tick();
    expect(Object.is(f.window.contentView, overlay)).toBe(true);
    expect(views.length).toBe(2);
    expect(f.root.webContents.commands).toEqual([]);
    expect(f.root.webContents.attached).toBe(false);
    expect(f.host.readyFor('page')).toBe(false);
    expect(f.suspended).toEqual(['page']);
  } finally {
    f.host.dispose();
  }
});

test('explicit Root withdrawal suspends its accurate page once even after selection changed, without relying on a late Pane hide', async () => {
  const f = fixture();
  try {
    await f.activate();
    const pending = f.send(1);
    f.select(undefined);
    f.publish(null);
    expect(await pending).toBe('unconfirmed');
    expect(f.suspended).toEqual(['page']);
    expect(f.root.getBounds().width).toBe(1000);
    expect(f.chrome().getVisible()).toBe(false);
    expect(f.host.readyFor('page')).toBe(false);
    f.publish(null);
    f.host.release('page');
    expect(f.suspended).toEqual(['page']);
  } finally {
    f.host.dispose();
  }
});

test('same-id navigation rotates page identity and cannot reuse a prior hosted acknowledgement', async () => {
  const f = fixture();
  try {
    await f.activate();
    const old = f.envelope();
    f.token('same-page-new-navigation');
    expect(await f.send(1)).toBe('stale');
    f.publish(f.snapshot(3, true));
    expect(f.host.readyFor('page')).toBe(false);
    expect(f.envelope().snapshot.hosted).toBe(false);
    await tick();
    expect(f.envelope().hosted).toBe(true);
    expect(f.envelope().snapshot.hosted).toBe(false);
    expect(f.envelope().pageToken).not.toBe(old.pageToken);
    expect(f.ready).toEqual(['page']);
    f.publish(f.snapshot(4, true));
    await tick();
    expect(f.ready).toEqual(['page', 'page']);
    expect(f.host.readyFor('page')).toBe(true);
  } finally {
    f.host.dispose();
  }
});

test('same-value metrics requests skip both in-flight duplicates and already-applied commands', async () => {
  const f = fixture();
  let complete!: () => void;
  try {
    await f.activate();
    const before = f.root.webContents.commands.length;
    f.host.syncViewport();
    f.host.syncViewport();
    expect(f.root.webContents.commands).toHaveLength(before);
    f.root.webContents.command = () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      });
    f.size[0] = 820;
    f.host.invalidateGeometry();
    f.host.syncViewport();
    f.host.syncViewport();
    f.host.syncViewport();
    expect(f.root.webContents.commands).toHaveLength(before + 1);
    complete();
    await tick();
    f.host.syncViewport();
    expect(f.root.webContents.commands).toHaveLength(before + 1);
    f.layout('page', { x: 510, y: 96, width: 310, height: 604 }, f.scope);
    expect(f.envelope().actionable).toBe(true);
  } finally {
    f.host.dispose();
  }
});

test('applied A is restored after in-flight B even when the latest desire returns to A', async () => {
  const f = fixture();
  const completions: (() => void)[] = [];
  try {
    await f.activate();
    const before = f.root.webContents.commands.length;
    f.root.webContents.command = () => new Promise<void>((resolve) => completions.push(resolve));
    f.size[0] = 820;
    f.host.invalidateGeometry();
    f.host.syncViewport();
    f.size[0] = 1000;
    f.host.invalidateGeometry();
    f.host.syncViewport();
    expect(f.root.webContents.commands).toHaveLength(before + 1);
    completions[0]!();
    await tick();
    expect(f.root.webContents.commands.slice(before).map((command) => command.params)).toEqual([
      { width: 820, height: 700, deviceScaleFactor: 0, mobile: false, dontSetVisibleSize: true },
      { width: 1000, height: 700, deviceScaleFactor: 0, mobile: false, dontSetVisibleSize: true },
    ]);
    expect(f.envelope().actionable).toBe(false);
    completions[1]!();
    await tick();
    f.layout('page', { x: 600, y: 96, width: 400, height: 604 }, f.scope);
    expect(f.root.webContents.commands).toHaveLength(before + 2);
    expect(f.envelope().actionable).toBe(true);
  } finally {
    f.host.dispose();
  }
});

test('a superseded pending size is dropped when the latest desire equals the in-flight value', async () => {
  const f = fixture();
  let complete!: () => void;
  try {
    await f.activate();
    const before = f.root.webContents.commands.length;
    f.root.webContents.command = () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      });
    for (const width of [820, 760, 820]) {
      f.size[0] = width;
      f.host.invalidateGeometry();
      f.host.syncViewport();
    }
    complete();
    await tick();
    expect(f.root.webContents.commands.slice(before)).toHaveLength(1);
    expect(f.root.webContents.commands.at(-1)?.params).toMatchObject({ width: 820 });
    f.layout('page', { x: 510, y: 96, width: 310, height: 604 }, f.scope);
    expect(f.envelope().actionable).toBe(true);
  } finally {
    f.host.dispose();
  }
});

for (const rejectOld of [false, true])
  test(`native resize supersedes pending Root metrics and ignores old ${rejectOld ? 'rejection' : 'completion'} while ordinary updates stay serial`, async () => {
    const f = fixture(),
      requests: { resolve(): void; reject(error: Error): void }[] = [];
    try {
      await f.activate();
      const before = f.root.webContents.commands.length,
        finalWidth = rejectOld ? 1400 : 820; // Completion also exercises same-size ABA.
      f.root.webContents.command = () =>
        new Promise<void>((resolve, reject) => requests.push({ resolve, reject }));
      for (const width of [820, 1100, finalWidth]) {
        f.size[0] = width;
        f.host.invalidateGeometry();
        f.host.syncViewport(true);
      }
      f.host.syncViewport(true); // The current identical desire is not a fourth command.
      expect(
        f.root.webContents.commands
          .slice(before)
          .map((command) => (command.params as { width: number }).width),
      ).toEqual([820, 1100, finalWidth]);
      expect(requests).toHaveLength(3);
      const changes = f.stateChanges();
      if (rejectOld) requests[0]!.reject(Error('superseded native resize'));
      else requests[0]!.resolve();
      await tick();
      expect(f.stateChanges()).toBe(changes);
      expect(f.suspended).toEqual([]);
      expect(f.envelope().actionable).toBe(false);
      expect(f.root.webContents.commands).toHaveLength(before + 3);
      requests[2]!.resolve();
      await tick();
      expect(
        f.layout('page', { x: finalWidth - 310, y: 96, width: 310, height: 604 }, f.scope),
      ).toBe(true);
      expect(f.envelope().actionable).toBe(true);
      const current = f.envelope(),
        commands = f.root.webContents.commands.length;
      if (rejectOld) requests[1]!.reject(Error('late superseded native resize'));
      else requests[1]!.resolve();
      await tick();
      expect(f.envelope()).toEqual(current);
      expect(f.suspended).toEqual([]);
      expect(f.root.webContents.commands).toHaveLength(commands);
      f.host.syncViewport();
      expect(f.root.webContents.commands).toHaveLength(commands);
      // Ordinary calls retain their single-flight path after native resize callbacks.
      for (const width of [1250, 1300]) {
        f.size[0] = width;
        f.host.invalidateGeometry();
        f.host.syncViewport();
      }
      expect(requests).toHaveLength(4);
      requests[3]!.resolve();
      await tick();
      expect(requests).toHaveLength(5);
      expect(f.root.webContents.commands.at(-1)?.params).toMatchObject({ width: 1300 });
      requests[4]!.resolve();
      await tick();
      expect(f.layout('page', { x: 990, y: 96, width: 310, height: 604 }, f.scope)).toBe(true);
      expect(f.envelope().actionable).toBe(true);
    } finally {
      f.host.dispose();
      for (const request of requests) request.resolve();
      await tick();
    }
  });

test('native resize reasserts already-applied A while a previously dispatched B is pending', async () => {
  const f = fixture(),
    requests: { resolve(): void; reject(error: Error): void }[] = [];
  try {
    await f.activate(); // A=1000 is already applied.
    const before = f.root.webContents.commands.length;
    f.root.webContents.command = () =>
      new Promise<void>((resolve, reject) => requests.push({ resolve, reject }));
    f.size[0] = 820; // Ordinary B was already dispatched before the native resize callback.
    f.host.invalidateGeometry();
    f.host.syncViewport();
    expect(requests).toHaveLength(1);
    f.size[0] = 1000;
    f.host.invalidateGeometry();
    f.host.syncViewport(true);
    f.host.syncViewport(true);
    expect(
      f.root.webContents.commands
        .slice(before)
        .map((command) => (command.params as { width: number }).width),
    ).toEqual([820, 1000]);
    expect(requests).toHaveLength(2);
    const changes = f.stateChanges();
    requests[0]!.resolve();
    await tick();
    expect(f.stateChanges()).toBe(changes);
    expect(f.envelope().actionable).toBe(false);
    expect(f.root.webContents.commands).toHaveLength(before + 2);
    requests[1]!.resolve();
    await tick();
    expect(f.layout('page', { x: 600, y: 96, width: 400, height: 604 }, f.scope)).toBe(true);
    expect(f.envelope().actionable).toBe(true);
    expect(f.suspended).toEqual([]);
    f.host.syncViewport();
    expect(f.root.webContents.commands).toHaveLength(before + 2);
  } finally {
    f.host.dispose();
    for (const request of requests) request.resolve();
    await tick();
  }
});

test('native resize still fails the actual latest Root metrics rejection and late predecessors cannot revive it', async () => {
  const f = fixture(),
    requests: { resolve(): void; reject(error: Error): void }[] = [];
  try {
    await f.activate();
    f.root.webContents.command = () =>
      new Promise<void>((resolve, reject) => requests.push({ resolve, reject }));
    for (const width of [820, 1100, 1400]) {
      f.size[0] = width;
      f.host.invalidateGeometry();
      f.host.syncViewport(true);
    }
    expect(requests).toHaveLength(3);
    requests[2]!.reject(Error('current native resize failed'));
    await tick();
    expect(f.envelope()).toBeNull();
    expect(f.suspended).toEqual(['page']);
    expect(f.root.getBounds()).toEqual({ x: 0, y: 0, width: 1400, height: 700 });
    expect(f.chrome().getVisible()).toBe(false);
    expect(f.page.webContents.destroyed).toBe(false);
    const commands = f.root.webContents.commands.length;
    requests[0]!.resolve();
    requests[1]!.reject(Error('obsolete failure after current failure'));
    await tick();
    f.host.syncViewport();
    expect(f.root.webContents.commands).toHaveLength(commands);
    expect(f.suspended).toEqual(['page']);
    expect(f.envelope()).toBeNull();
  } finally {
    f.host.dispose();
    for (const request of requests) request.resolve();
    await tick();
  }
});

for (const boundary of ['root-frame', 'dispose'] as const)
  test(`native resize predecessors and latest work remain retired after ${boundary}`, async () => {
    const f = fixture(),
      requests: { resolve(): void; reject(error: Error): void }[] = [];
    let disposed = false;
    try {
      await f.activate();
      f.root.webContents.command = () =>
        new Promise<void>((resolve, reject) => requests.push({ resolve, reject }));
      for (const width of [820, 1100, 1400]) {
        f.size[0] = width;
        f.host.invalidateGeometry();
        f.host.syncViewport(true);
      }
      expect(requests).toHaveLength(3);
      if (boundary === 'dispose') {
        f.host.dispose();
        disposed = true;
      } else {
        f.root.webContents.mainFrame = { url: 'http://localhost/' };
        f.root.webContents.emit('did-start-navigation', {}, 'http://localhost/', false, true);
        f.publish(f.snapshot(1, true));
      }
      requests[0]!.reject(Error('superseded resize on obsolete environment'));
      requests[2]!.resolve();
      await tick();
      expect(f.host.readyFor('page')).toBe(false);
      expect(f.suspended).toEqual(boundary === 'dispose' ? [] : ['page']);
      expect(f.root.getBounds()).toEqual({ x: 0, y: 0, width: 1400, height: 700 });
      expect(requests).toHaveLength(4); // New Root desire, or the exact disposal metrics reset.
      requests[3]!.resolve();
      await tick();
      if (boundary === 'root-frame') {
        expect(f.envelope()).toMatchObject({ hosted: false, snapshot: { hosted: false } });
        await f.prime({ x: 1090, y: 96, width: 310, height: 604 });
        f.publish(f.snapshot(2, true));
        expect(f.layout('page', { x: 1090, y: 96, width: 310, height: 604 }, f.scope)).toBe(true);
        expect(f.envelope().actionable).toBe(true);
      }
      const changes = f.stateChanges(),
        commands = f.root.webContents.commands.length;
      requests[1]!.reject(Error('late old resize after replacement adoption'));
      await tick();
      expect(f.stateChanges()).toBe(changes);
      expect(f.root.webContents.commands).toHaveLength(commands);
      expect(f.host.readyFor('page')).toBe(boundary === 'root-frame');
      expect(f.page.webContents.destroyed).toBe(false);
      if (disposed) expect(f.root.webContents.attached).toBe(false);
    } finally {
      if (!disposed) f.host.dispose();
      for (const request of requests) request.resolve();
      await tick();
    }
  });

test('pure same-value layout performs no native writes, metrics or broadcasts; controller update publishes the applied state', async () => {
  const f = fixture();
  try {
    await f.activate();
    const commands = f.root.webContents.commands.length;
    const sent = f.root.webContents.sent.length,
      chromeSent = f.chrome().webContents.sent.length;
    f.root.boundsHistory.length = f.chrome().boundsHistory.length = 0;
    f.chrome().visibilityHistory.length = f.chrome().webContents.zoomHistory.length = 0;
    expect(f.host.layout('page', { x: 600, y: 96, width: 400, height: 604 }, f.scope)).toBe(true);
    f.host.update();
    await tick();
    expect(f.root.boundsHistory).toEqual([]);
    expect(f.chrome().boundsHistory).toEqual([]);
    expect(f.chrome().visibilityHistory).toEqual([]);
    expect(f.chrome().webContents.zoomHistory).toEqual([]);
    expect(f.root.webContents.commands).toHaveLength(commands);
    expect(f.root.webContents.sent).toHaveLength(sent);
    expect(f.chrome().webContents.sent).toHaveLength(chromeSent);
    f.host.invalidateGeometry();
    const invalidated = f.root.webContents.sent.length;
    expect(f.host.layout('page', { x: 590, y: 96, width: 410, height: 604 }, f.scope)).toBe(true);
    expect(f.root.webContents.sent).toHaveLength(invalidated);
    f.page.setBounds({ x: 590, y: 96, width: 410, height: 604 });
    f.host.update();
    expect(f.root.webContents.sent).toHaveLength(invalidated + 1);
    expect(f.envelope().actionable).toBe(true);
  } finally {
    f.host.dispose();
  }
});

test('broadcast deduplication preserves first delivery to Chrome and newer-revision address echoes', async () => {
  const f = fixture();
  let complete!: () => void;
  try {
    f.root.webContents.command = () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      });
    f.publish(f.snapshot(1));
    await tick();
    const sent = f.root.webContents.sent.length;
    expect(f.chrome().webContents.sent).toHaveLength(0);
    f.host.update();
    expect(f.root.webContents.sent).toHaveLength(sent);
    expect(f.chrome().webContents.sent).toHaveLength(1);
    complete();
    await tick();
    f.publish(f.snapshot(2, true));
    f.layout('page', { x: 600, y: 96, width: 400, height: 604 }, f.scope);
    const before = f.root.webContents.sent.length;
    for (const [revision, address] of [
      [3, 'edited'],
      [4, 'example.com'],
    ] as const) {
      const value = f.snapshot(revision, true);
      Object.assign(value.toolbar, { address });
      f.publish(value);
    }
    expect(f.root.webContents.sent).toHaveLength(before + 2);
    expect(
      f.root.webContents.sent
        .slice(-2)
        .map((item) => (item.value as NativeBrowserChromeEnvelope).snapshot.toolbar.address),
    ).toEqual(['edited', 'example.com']);
  } finally {
    f.host.dispose();
  }
});

test('a new binding reuses applied metrics but still needs a fresh hosted ACK; a new Root epoch does not reuse them', async () => {
  const f = fixture();
  try {
    await f.activate();
    const commands = f.root.webContents.commands.length;
    f.host.release();
    f.publish(f.snapshot(3, true));
    expect(f.envelope()).toMatchObject({ hosted: false, snapshot: { hosted: false } });
    expect(f.host.readyFor('page')).toBe(false);
    expect(f.root.webContents.commands).toHaveLength(commands);
    await f.prime();
    f.publish(f.snapshot(4, true));
    expect(f.host.readyFor('page')).toBe(true);
    f.root.webContents.mainFrame = { url: 'http://localhost/new-root' };
    f.root.webContents.emit('did-start-navigation', {}, 'http://localhost/new-root', false, true);
    await tick();
    expect(f.root.webContents.commands).toHaveLength(commands + 1);
    expect(f.root.getBounds().width).toBe(1000);
    expect(f.host.readyFor('page')).toBe(false);
  } finally {
    f.host.dispose();
  }
});

test('disposal while metrics are in flight restores Root once and never revives a late completion', async () => {
  const f = fixture();
  const completions: (() => void)[] = [];
  await f.activate();
  f.root.webContents.command = () =>
    new Promise<void>((resolve) => {
      completions.push(resolve);
    });
  f.size[0] = 820;
  f.host.invalidateGeometry();
  f.host.syncViewport();
  const commands = f.root.webContents.commands.length;
  f.host.dispose();
  const bounds = f.root.getBounds(),
    writes = f.root.boundsHistory.length,
    sent = f.root.webContents.sent.length;
  expect(f.root.webContents.commands.slice(commands)).toEqual([
    {
      method: 'Emulation.setDeviceMetricsOverride',
      params: {
        width: 0,
        height: 0,
        deviceScaleFactor: 0,
        mobile: false,
        dontSetVisibleSize: true,
      },
    },
  ]);
  completions[0]!();
  await tick();
  expect(f.root.getBounds()).toEqual(bounds);
  expect(f.root.boundsHistory).toHaveLength(writes);
  expect(f.root.webContents.commands).toHaveLength(commands + 1);
  expect(f.root.webContents.sent).toHaveLength(sent);
  expect(f.chrome().webContents.destroyed).toBe(true);
  completions[1]!();
  await tick();
  expect(f.root.webContents.attached).toBe(false);
});

for (const rejectOld of [false, true]) {
  test(`old Root metrics ${rejectOld ? 'rejection' : 'completion'} cannot prepare or fail the replacement binding`, async () => {
    const f = fixture();
    const requests: { resolve(): void; reject(error: Error): void }[] = [];
    try {
      await f.activate();
      const before = f.root.webContents.commands.length;
      f.root.webContents.command = () =>
        new Promise<void>((resolve, reject) => requests.push({ resolve, reject }));
      f.size[0] = 820;
      f.host.invalidateGeometry();
      f.host.syncViewport();
      f.root.webContents.mainFrame = { url: 'http://localhost/' };
      f.root.webContents.emit('did-start-navigation', {}, 'http://localhost/', false, true);
      f.publish(f.snapshot(1, true));
      const replacement = f.envelope();
      expect(replacement).toMatchObject({
        hosted: false,
        actionable: false,
        snapshot: { hosted: false },
      });
      if (rejectOld) requests[0]!.reject(Error('obsolete document failed'));
      else requests[0]!.resolve();
      await tick();
      expect(f.root.webContents.commands).toHaveLength(before + 2);
      expect(f.envelope()).toMatchObject({
        attachment: replacement.attachment,
        pageToken: replacement.pageToken,
        hosted: false,
        actionable: false,
      });
      expect(f.suspended).toEqual(['page']);
      expect(f.root.getBounds()).toEqual({ x: 0, y: 0, width: 820, height: 700 });
      requests[1]!.resolve();
      await tick();
      expect(f.envelope()).toMatchObject({
        attachment: replacement.attachment,
        hosted: false,
        snapshot: { hosted: false },
      });
      expect(f.host.readyFor('page')).toBe(false);
      await f.prime({ x: 510, y: 96, width: 310, height: 604 });
      f.publish(f.snapshot(2, true));
      expect(f.layout('page', { x: 510, y: 96, width: 310, height: 604 }, f.scope)).toBe(true);
      expect(f.envelope().actionable).toBe(true);
    } finally {
      f.host.dispose();
    }
  });
}

test('ignoring an obsolete rejection still checks detached transport for the new Root desire', async () => {
  const f = fixture();
  let reject!: (error: Error) => void;
  try {
    await f.activate();
    const before = f.root.webContents.commands.length;
    f.root.webContents.command = () =>
      new Promise<void>((_resolve, fail) => {
        reject = fail;
      });
    f.size[0] = 820;
    f.host.invalidateGeometry();
    f.host.syncViewport();
    f.root.webContents.mainFrame = { url: 'http://localhost/' };
    f.root.webContents.emit('did-start-navigation', {}, 'http://localhost/', false, true);
    f.publish(f.snapshot(1, true));
    f.root.webContents.attached = false;
    reject(Error('obsolete document failed'));
    await tick();
    expect(f.root.webContents.commands).toHaveLength(before + 1);
    expect(f.suspended).toEqual(['page', 'page']);
    expect(f.envelope()).toBeNull();
    expect(f.host.readyFor('page')).toBe(false);
    expect(f.page.webContents.destroyed).toBe(false);
  } finally {
    f.host.dispose();
  }
});

for (const transition of ['loaded-tab', 'prepared-close-fallback'] as const)
  test(`cold loading cannot replace the native shell during a ${transition} fresh target handshake`, async () => {
    const f = fixture();
    const second = f.addPage('second');
    const viewport = { x: 600, y: 96, width: 400, height: 604 };
    try {
      await f.activate();
      f.publish(retainedSnapshot(f, 3, 'page'));
      for (const [revision, id, previous] of [
        [4, 'second', 'page'],
        [6, 'page', 'second'],
      ] as const) {
        if (transition === 'prepared-close-fallback' && id === 'page') f.prepare(previous, id);
        const next = retainedSnapshot(f, revision, id);
        f.publish(next);
        expect(f.host.readyFor(id, f.scope)).toBe(false);
        const root = f.root.getBounds();
        const chrome = f.chrome().getBounds();
        const children = [...f.window.contentView.children];
        const rootWrites = f.root.boundsHistory.length;
        const chromeWrites = f.chrome().boundsHistory.length;
        const attachment = f.envelope().attachment;
        const hold = f.host.holdsPresentation(previous);
        if (transition === 'loaded-tab' || id === 'second') expect(hold).toBeDefined();
        expect(f.host.loadingReady(id, viewport, f.scope)).toBe(false);
        expect(f.chrome().getBounds()).toEqual(chrome);
        expect(f.root.getBounds()).toEqual(root);
        expect(f.chrome().boundsHistory).toHaveLength(chromeWrites);
        expect(f.root.boundsHistory).toHaveLength(rootWrites);
        expect(f.window.contentView.children).toEqual(children);
        expect(f.envelope().attachment).toBe(attachment);
        expect(f.envelope().preparing).toBeUndefined();
        f.host.update();
        expect(f.host.holdsPresentation(previous)).toEqual(hold);
        expect(f.host.presentationViewport(f.scope)).toEqual(viewport);
        f.publish({ ...next, revision: revision + 1, hosted: true });
        expect(f.host.layout(id, viewport, f.scope)).toBe(true);
        const target = id === 'page' ? f.page : second;
        target.setBounds(viewport);
        target.setVisible(true);
        f.host.completePresentation(id);
        expect(f.host.readyFor(id, f.scope)).toBe(true);
        expect(f.root.getBounds()).toEqual(root);
        expect(f.chrome().getBounds()).toEqual(chrome);
        expect(f.loadingFailures).toEqual([]);
      }
    } finally {
      f.host.dispose();
    }
  });

test('ordinary loading geometry cancellation permits a fresh attempt for the same current intent', async () => {
  const f = fixture();
  const bounds = { x: 600, y: 96, width: 400, height: 604 };
  try {
    f.publish(f.snapshot(1));
    await tick();
    f.chrome().webContents.autoFrames = false;
    expect(f.host.loadingReady('page', bounds, f.scope)).toBe(false);
    const attachment = f.envelope().attachment;
    expect(f.host.displayState()).toMatchObject({ kind: 'page', busy: true });
    f.host.invalidateGeometry();
    expect(f.loadingFailures).toEqual([]);
    expect(f.host.displayState()).toMatchObject({ kind: 'page', busy: false });
    expect(f.host.loadingReady('page', bounds, f.scope)).toBe(false);
    const current = f.envelope();
    expect(current.attachment).not.toBe(attachment);
    expect(current.preparing).toBe(true);
    f.chrome().webContents.autoFrames = true;
    await f.call({
      action: 'rendered',
      attachment: current.attachment,
      pageToken: current.pageToken,
      revision: 1,
    });
    await tick();
    expect(f.host.loadingReady('page', bounds, f.scope)).toBe(true);
    expect(f.loadingFailures).toEqual([]);
  } finally {
    f.host.dispose();
  }
});

test('native loading host covers the complete right pane before Root proof and keeps fresh cancellation available', async () => {
  const f = fixture(),
    bounds = { x: 600, y: 96, width: 400, height: 604 };
  try {
    f.publish(f.snapshot(1));
    await tick();
    const old = f.envelope();
    expect(f.host.loadingReady('page', bounds, f.scope)).toBe(false);
    const env = f.envelope();
    expect(env.attachment).not.toBe(old.attachment);
    expect(env).toMatchObject({ preparing: true, hosted: false, actionable: false });
    expect(f.chrome().getBounds()).toEqual({ x: 600, y: 0, width: 400, height: 700 });
    expect(f.window.contentView.children.indexOf(f.chrome() as never)).toBeLessThan(
      f.window.contentView.children.indexOf(f.root as never),
    );
    f.chrome().webContents.autoFrames = false;
    await f.call({
      action: 'rendered',
      attachment: env.attachment,
      pageToken: env.pageToken,
      revision: 1,
    });
    expect(f.host.loadingReady('page', bounds, f.scope)).toBe(false);
    f.chrome().webContents.frame?.({
      isEmpty: () => false,
      getSize: () => ({ width: 400, height: 96 }),
    });
    expect(f.host.loadingReady('page', bounds, f.scope)).toBe(false);
    f.chrome().webContents.frame?.({
      isEmpty: () => false,
      getSize: () => ({ width: 400, height: 700 }),
    });
    expect(f.host.loadingReady('page', bounds, f.scope)).toBe(true);
    expect(f.host.readyFor('page', f.scope)).toBe(false);
    expect(f.window.contentView.children.indexOf(f.chrome() as never)).toBeGreaterThan(
      f.window.contentView.children.indexOf(f.root as never),
    );
    const send = (sequence: number, part: string, action: object) =>
      f.call({
        action: 'send',
        event: {
          attachment: env.attachment,
          pageToken: env.pageToken,
          revision: 1,
          sequence,
          part,
          action,
        },
      });
    expect(await send(1, 'toolbar', { type: 'navigate' })).toBe('stale');
    const closing = send(2, 'tabs', { type: 'collapse' });
    f.acknowledge(2);
    expect(await closing).toBe('forwarded');
    expect(f.root.getBounds()).toEqual({ x: 0, y: 0, width: 1000, height: 700 });
    f.publish(null);
    expect(f.chrome().getVisible()).toBe(false);
    expect(f.host.loadingReady('page', bounds, f.scope)).toBe(false);
  } finally {
    f.host.dispose();
  }
});

for (const change of ['none', 'navigation', 'geometry', 'document-loading'] as const) {
  test(`retained native resource resume uses live exact page only with unchanged ${change} facts`, async () => {
    const f = fixture(),
      bounds = { x: 600, y: 96, width: 400, height: 604 };
    try {
      await f.activate();
      const oldWire = f.envelope();
      f.publish(null);
      f.page.setVisible(false);
      if (change === 'navigation') f.token('new-navigation');
      if (change === 'geometry') f.size[0] = 1010;
      if (change === 'document-loading') {
        f.page.webContents.loadingMain = true;
      }
      f.publish(f.snapshot(3));
      expect(f.host.loadingReady('page', bounds, f.scope)).toBe(false);
      await tick();
      const env = f.envelope();
      expect(env.attachment).not.toBe(oldWire.attachment);
      expect(env.actionable).toBe(false);
      const expectedHeight = change === 'none' ? 96 : 700;
      const width = change === 'geometry' ? 410 : 400;
      f.chrome().webContents.frameImage = () => ({
        isEmpty: () => false,
        getSize: () => ({ width, height: expectedHeight }),
      });
      await f.call({
        action: 'rendered',
        attachment: env.attachment,
        pageToken: env.pageToken,
        revision: 3,
      });
      await tick();
      expect(f.host.loadingReady('page', bounds, f.scope)).toBe(true);
      expect(f.host.preparingPage() === (f.page as never)).toBe(change === 'none');
      expect(f.host.readyFor('page', f.scope)).toBe(false);
      expect(f.chrome().getBounds().height).toBe(expectedHeight);
      expect(f.envelope().loadingBody).toBe(change !== 'none');
      f.publish(null);
      expect(f.host.preparingPage()).toBeUndefined();
      expect(f.page.getVisible()).toBe(false);
    } finally {
      f.host.dispose();
    }
  });
}

test('native loading preparation transfers to the existing Page preparation and retires only on actual adoption', async () => {
  const f = fixture(),
    bounds = { x: 600, y: 96, width: 400, height: 604 };
  try {
    f.publish(f.snapshot(1));
    await tick();
    f.host.loadingReady('page', bounds, f.scope);
    const env = f.envelope();
    f.chrome().webContents.frameImage = () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 400, height: 700 }),
    });
    await f.call({
      action: 'rendered',
      attachment: env.attachment,
      pageToken: env.pageToken,
      revision: 1,
    });
    await tick();
    expect(f.host.loadingReady('page', bounds, f.scope)).toBe(true);
    const starts = f.chrome().webContents.frameStarts;
    const controller = new AbortController();
    expect(await f.host.prepareDisplay('page', bounds, f.scope, controller.signal)).toBe(true);
    expect(f.chrome().webContents.frameStarts).toBe(starts);
    expect(f.host.offerDisplay('page', bounds, f.scope)).toBe(true);
    expect(f.envelope()).toMatchObject({ preparing: true, hosted: true, actionable: false });
    expect(f.chrome().getBounds().height).toBe(700);
    f.publish(f.snapshot(2, true));
    expect(f.layout('page', bounds, f.scope)).toBe(true);
    expect(f.chrome().getBounds().height).toBe(96);
    expect(f.envelope().preparing).toBeUndefined();
    expect(f.envelope().actionable).toBe(true);
    controller.abort();
    expect(f.host.readyFor('page', f.scope)).toBe(true);
    expect(f.loadingFailures).toEqual([]);
  } finally {
    f.host.dispose();
  }
});

for (const boundary of ['native-frame', 'fresh-root'] as const)
  test(`missing ${boundary} reports one bounded loading failure without an observe/fail loop`, async () => {
    const f = fixture(),
      bounds = { x: 600, y: 96, width: 400, height: 604 };
    try {
      f.publish(f.snapshot(1));
      await tick();
      f.chrome().webContents.autoFrames = boundary !== 'native-frame';
      f.chrome().webContents.frameImage = () => ({
        isEmpty: () => false,
        getSize: () => ({ width: 400, height: 700 }),
      });
      f.host.loadingReady('page', bounds, f.scope);
      const env = f.envelope();
      await f.call({
        action: 'rendered',
        attachment: env.attachment,
        pageToken: env.pageToken,
        revision: 1,
      });
      await new Promise((resolve) => setTimeout(resolve, 1550));
      expect(f.loadingFailures).toEqual(['page']);
      expect(f.chrome().getVisible()).toBe(false);
      expect(f.host.displayState()).toMatchObject({ kind: 'page', busy: true });
      const starts = f.chrome().webContents.frameStarts;
      expect(f.host.loadingReady('page', bounds, f.scope)).toBe(false);
      f.host.update();
      expect(f.chrome().webContents.frameStarts).toBe(starts);
      expect(f.loadingFailures).toHaveLength(1);
      f.publish(null);
      expect(f.host.displayState()).toMatchObject({ kind: 'root' });
      f.publish(f.snapshot(2));
      expect(f.host.loadingReady('page', bounds, f.scope)).toBe(false);
      expect(f.envelope().attachment).not.toBe(env.attachment);
    } finally {
      f.host.dispose();
    }
  });

test('cold loading Chrome read failure withdraws its temporary visible Page and cancels only the claimed preparation', async () => {
  const f = fixture(),
    bounds = { x: 600, y: 96, width: 400, height: 604 };
  try {
    f.publish(f.snapshot(1));
    await tick();
    f.host.loadingReady('page', bounds, f.scope);
    let env = f.envelope();
    f.chrome().webContents.frameImage = () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 400, height: 700 }),
    });
    await f.call({
      action: 'rendered',
      attachment: env.attachment,
      pageToken: env.pageToken,
      revision: 1,
    });
    await tick();
    const controller = new AbortController();
    expect(await f.host.prepareDisplay('page', bounds, f.scope, controller.signal)).toBe(true);
    f.page.setBounds(bounds);
    f.page.setVisible(true);
    f.window.contentView.addChildView(f.page as never);
    f.publish(f.snapshot(2));
    f.chrome().webContents.capturePage = async () => {
      throw Error('native-read-failed');
    };
    const pending = f.host.prepareDisplay('page', bounds, f.scope, controller.signal);
    env = f.envelope();
    await f.call({
      action: 'rendered',
      attachment: env.attachment,
      pageToken: env.pageToken,
      revision: 2,
    });
    expect(await pending).toBe(false);
    expect(f.page.getVisible()).toBe(false);
    expect(f.chrome().getVisible()).toBe(false);
    expect(f.cancelledDisplays).toEqual([{ id: 'page', signal: controller.signal }]);
    expect(f.loadingFailures).toEqual([]);
    expect(f.host.readyFor('page', f.scope)).toBe(false);
  } finally {
    f.host.dispose();
  }
});

test('warm resource resume reports protection failure and withdraws the original live page without acquiring input', async () => {
  const f = fixture(),
    bounds = { x: 600, y: 96, width: 400, height: 604 };
  try {
    await f.activate();
    f.publish(null);
    f.page.setVisible(false);
    f.publish(f.snapshot(3));
    f.host.loadingReady('page', bounds, f.scope);
    f.protection(false);
    const env = f.envelope();
    f.chrome().webContents.frameImage = () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 400, height: 96 }),
    });
    await f.call({
      action: 'rendered',
      attachment: env.attachment,
      pageToken: env.pageToken,
      revision: 3,
    });
    await tick();
    expect(f.host.preparingPage()).toBeUndefined();
    expect(f.page.getVisible()).toBe(false);
    expect(f.chrome().getVisible()).toBe(false);
    expect(f.host.readyFor('page', f.scope)).toBe(false);
    expect(f.loadingFailures).toEqual(['page']);
  } finally {
    f.host.dispose();
  }
});
