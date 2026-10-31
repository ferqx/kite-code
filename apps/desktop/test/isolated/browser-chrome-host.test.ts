import { expect, mock, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import type { NativeBrowserRestoreScope } from '../../src/native-browser-bridge';
import {
  type NativeBrowserChromeEnvelope,
  type NativeBrowserChromeEvent,
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
  addChildView(view: FakeView) {
    this.removeChildView(view);
    this.children.push(view);
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
  const ready: string[] = [],
    suspended: string[] = [];
  const host = createNativeBrowserChromeHost({
    window,
    ipcMain: ipc as unknown as IpcMain,
    rendererUrl: 'http://localhost/',
    preloadPath: '/private/browser-chrome-preload.cjs',
    currentScope: (input) => (input ? inputScope : selected),
    getPage: (id) => (id === 'page' ? { id, view: page as never, token, scope } : undefined),
    onReady: (id) => ready.push(id),
    onSuspend: (id) => suspended.push(id),
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
  const chrome = () => views.at(-1)!;
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
  const activate = async () => {
    publish(snapshot(1));
    await tick();
    publish(snapshot(2, true));
    await tick();
    expect(layout('page', { x: 600, y: 96, width: 400, height: 604 }, scope)).toBe(true);
    await tick();
  };
  return {
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
    event,
    publish,
    snapshot,
    chrome,
    envelope,
    call,
    send,
    acknowledge,
    activate,
    select(value?: NativeBrowserRestoreScope) {
      selected = value;
    },
    input(value?: NativeBrowserRestoreScope) {
      inputScope = value;
    },
    token(value: string) {
      token = value;
    },
  };
}

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
    expect(f.envelope()).toMatchObject({ hosted: true, actionable: false });
    expect(f.host.readyFor('page')).toBe(false);
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
    expect(f.envelope()).toMatchObject({ hosted: true, snapshot: { hosted: false } });
    expect(f.host.readyFor('page')).toBe(false);
    expect(f.root.webContents.commands).toHaveLength(commands);
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
        hosted: true,
        snapshot: { hosted: false },
      });
      expect(f.host.readyFor('page')).toBe(false);
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
