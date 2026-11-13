import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { setTimeout as fixtureDelay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { MenuItemConstructorOptions } from 'electron';
import { expect, mock, test } from '#kite-test';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const image = { isEmpty: () => false, getSize: () => ({ width: 2000, height: 1400 }) };
class Contents extends EventEmitter {
  destroyed = false;
  focused = false;
  url = 'about:blank';
  mainFrame = { url: this.url };
  epoch = 0;
  closes = 0;
  captures = 0;
  capture: () => Promise<typeof image> = async () => image;
  load: () => Promise<void> = async () => {};
  zoom = 0;
  reloads = 0;
  tools = 0;
  async loadURL(url: string) {
    this.url = url;
    this.mainFrame = { url };
    this.emit('did-start-navigation', null, url, false, true);
    await this.load();
    this.emit('did-finish-load');
  }
  async loadFile(path: string) {
    return this.loadURL(pathToFileURL(path).href);
  }
  capturePage() {
    this.captures++;
    return this.capture();
  }
  isDestroyed() {
    return this.destroyed;
  }
  isFocused() {
    return this.focused;
  }
  focus() {
    this.focused = true;
  }
  close() {
    this.closes++;
    this.destroyed = true;
    this.emit('destroyed');
  }
  getZoomLevel() {
    return this.zoom;
  }
  setZoomLevel(value: number) {
    this.zoom = value;
  }
  reload() {
    this.reloads++;
  }
  toggleDevTools() {
    this.tools++;
  }
}
class View {
  visible = true;
  children: View[] = [];
  bounds = { x: 0, y: 0, width: 0, height: 0 };
  boundsWrites = 0;
  colors: string[] = [];
  addChildView(view: View) {
    this.children.push(view);
  }
  setBounds(value: typeof this.bounds) {
    this.boundsWrites++;
    this.bounds = { ...value };
  }
  getBounds() {
    return { ...this.bounds };
  }
  setBackgroundColor(value: string) {
    this.colors.push(value);
  }
  getVisible() {
    return this.visible;
  }
}
class ContentsView extends View {
  webContents = new Contents();
  readonly options: unknown;
  constructor(options: unknown) {
    super();
    this.options = options;
  }
}
class Window extends EventEmitter {
  contentView = new View();
  size = [1000, 700];
  destroyed = false;
  shows = 0;
  inactiveShows = 0;
  closes = 0;
  full = false;
  minimizes = 0;
  title = '';
  readonly options: unknown;
  constructor(options: unknown) {
    super();
    this.options = options;
  }
  getContentSize() {
    return [...this.size];
  }
  isDestroyed() {
    return this.destroyed;
  }
  setBackgroundColor() {}
  show(...args: unknown[]) {
    this.shows++;
    this.emit('native-show', ...args);
  }
  showInactive(...args: unknown[]) {
    this.inactiveShows++;
    this.emit('native-show-inactive', ...args);
  }
  destroy() {
    this.destroyed = true;
    this.emit('closed');
  }
  close() {
    this.closes++;
    const event = {
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
    };
    this.emit('close', event);
    if (!event.defaultPrevented) this.destroy();
  }
  setTitle(value: string) {
    this.title = value;
  }
  setFullScreen(value: boolean) {
    this.full = value;
  }
  isFullScreen() {
    return this.full;
  }
  minimize() {
    this.minimizes++;
  }
}
mock.module('electron', () => ({ BaseWindow: Window, WebContentsView: ContentsView }));
const {
  createNativeRootWindow,
  getNativeRootView,
  onNativeRootReady,
  nativeRootWindowMenu,
  nativeRootWillShowEvent,
} = await import('../../electron/native-root-window');
const tick = async () => {
  await fixtureDelay(0);
};

test('Root waits for its actual load without requiring a hidden capture surface; Main retains show and preload ownership', async () => {
  const value = createNativeRootWindow({
    show: false,
    title: 'Kite',
    webPreferences: { preload: '/owned/preload.cjs', sandbox: true },
  });
  const window = value as unknown as Window,
    view = getNativeRootView(value)! as unknown as ContentsView;
  const gate = deferred<void>();
  view.webContents.load = () => gate.promise;
  view.webContents.capture = async () => {
    throw Error('Current display surface not available for capture');
  };
  let ready = 0;
  onNativeRootReady(value, () => ready++);
  const loaded = value.loadURL('http://localhost/');
  await tick();
  expect(ready).toBe(0);
  expect(window.shows).toBe(0);
  expect(view.webContents.captures).toBe(0);
  expect(view.options).toMatchObject({
    webPreferences: { preload: '/owned/preload.cjs', sandbox: true },
  });
  gate.resolve();
  await loaded;
  expect(ready).toBe(1);
  expect(window.shows).toBe(0);
  await value.loadURL('http://localhost/again');
  expect(view.webContents.captures).toBe(0);
  window.destroy();
  expect(view.webContents.closes).toBe(1);
  expect(getNativeRootView(value)).toBeUndefined();
});

test('a failed load or a window closed during loading cannot admit startup or show the window', async () => {
  const value = createNativeRootWindow({ show: true });
  const window = value as unknown as Window;
  const view = getNativeRootView(value)! as unknown as ContentsView;
  let ready = 0;
  onNativeRootReady(value, () => ready++);
  view.webContents.load = async () => {
    throw Error('ERR_CONNECTION_REFUSED');
  };
  await expect(value.loadURL('http://localhost/')).rejects.toThrow('ERR_CONNECTION_REFUSED');
  expect(ready).toBe(0);
  expect(window.shows).toBe(0);
  window.destroy();
  expect(view.webContents.closes).toBe(1);
  const next = createNativeRootWindow({ show: true });
  const native = next as unknown as Window;
  const root = getNativeRootView(next)! as unknown as ContentsView,
    gate = deferred<void>();
  root.webContents.load = () => gate.promise;
  const loading = next.loadURL('http://localhost/');
  await tick();
  native.destroy();
  gate.resolve();
  await expect(loading).rejects.toThrow('native_root_load_unavailable');
  expect(native.shows).toBe(0);
});

test('a superseded load cannot claim readiness and loadFile uses the same current-load admission', async () => {
  const value = createNativeRootWindow({ show: false });
  const window = value as unknown as Window;
  const root = getNativeRootView(value)! as unknown as ContentsView;
  const gate = deferred<void>();
  root.webContents.load = () => gate.promise;
  let ready = 0;
  onNativeRootReady(value, () => ready++);
  const prior = value.loadURL('http://localhost/old');
  root.webContents.load = async () => {};
  const entry = resolve('owned', 'index 雪 #%.html');
  await value.loadFile(entry);
  expect(ready).toBe(1);
  expect(fileURLToPath(root.webContents.url)).toBe(entry);
  expect(root.webContents.captures).toBe(0);
  gate.resolve();
  await expect(prior).rejects.toThrow('native_root_load_superseded');
  expect(ready).toBe(1);
  expect(window.shows).toBe(0);
  window.destroy();
});

test('Root always follows the full native viewport immediately without a browser crop', async () => {
  const value = createNativeRootWindow({ show: false }),
    window = value as unknown as Window;
  const root = getNativeRootView(value)! as unknown as ContentsView;
  const writes = root.boundsWrites;
  window.emit('resize');
  expect(root.boundsWrites).toBe(writes);
  window.size[0] = 820;
  window.emit('resize');
  expect(root.bounds.width).toBe(820);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(root.bounds.width).toBe(820);
  window.size[0] = 900;
  window.emit('resize');
  expect(root.bounds.width).toBe(900);
  const resizedWrites = root.boundsWrites;
  window.emit('resize');
  expect(root.boundsWrites).toBe(resizedWrites);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(root.bounds.width).toBe(900);
  window.size[0] = 920;
  window.emit('resize');
  expect(root.bounds.width).toBe(920);
  window.destroy();
  const closedWrites = root.boundsWrites;
  window.size[0] = 940;
  window.emit('resize');
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(root.bounds.width).toBe(920);
  expect(root.boundsWrites).toBe(closedWrites);
  expect(root.webContents.closes).toBe(1);
});

test('show and showInactive synchronously update Root and notify before invoking the owned native window', () => {
  const value = createNativeRootWindow({ show: false }),
    window = value as unknown as Window,
    root = getNativeRootView(value)! as unknown as ContentsView;
  const events: string[] = [],
    argument = {};
  window.on(nativeRootWillShowEvent, function (this: Window) {
    expect(this).toBe(window);
    expect(root.bounds).toEqual({ x: 0, y: 0, width: window.size[0]!, height: window.size[1]! });
    events.push('will-show');
  });
  window.on('native-show', function (this: Window, ...args) {
    expect(this).toBe(window);
    expect(args).toEqual([argument]);
    events.push('show');
  });
  window.on('native-show-inactive', function (this: Window, ...args) {
    expect(this).toBe(window);
    expect(args).toEqual([argument, undefined]);
    events.push('show-inactive');
  });
  window.size = [840, 620];
  Reflect.apply(value.show, window, [argument]);
  window.size = [920, 680];
  Reflect.apply(value.showInactive, window, [argument, undefined]);
  expect(events).toEqual(['will-show', 'show', 'will-show', 'show-inactive']);
  expect(window.shows).toBe(1);
  expect(window.inactiveShows).toBe(1);
  expect(root.webContents.captures).toBe(0);
  window.destroy();
});

test('closed windows do not notify or invoke native showing, including closure during the pre-show notification', () => {
  const value = createNativeRootWindow({ show: false }),
    window = value as unknown as Window;
  let notifications = 0;
  window.on(nativeRootWillShowEvent, () => {
    notifications++;
    window.destroy();
  });
  value.show();
  expect(notifications).toBe(1);
  expect(window.shows).toBe(0);
  value.show();
  value.showInactive();
  expect(notifications).toBe(1);
  expect(window.shows).toBe(0);
  expect(window.inactiveShows).toBe(0);
});

test('explicit instance menu targets Root zoom/reload and the actual BaseWindow close gate without global BrowserWindow lookup', () => {
  const value = createNativeRootWindow({ show: false }),
    window = value as unknown as Window;
  const root = getNativeRootView(value)! as unknown as ContentsView;
  const items: MenuItemConstructorOptions[] = [];
  for (const item of nativeRootWindowMenu(value))
    if (Array.isArray(item.submenu)) items.push(...item.submenu);
  const click = (label: string) => {
    const action = items.find((item) => item.label === label)!;
    expect(typeof action.click).toBe('function');
    action.click!({} as never, undefined, {} as never);
  };
  click('放大');
  expect(root.webContents.zoom).toBe(0.5);
  click('实际大小');
  expect(root.webContents.zoom).toBe(0);
  click('重新载入');
  expect(root.webContents.reloads).toBe(1);
  click('切换全屏');
  expect(window.full).toBe(true);
  window.on('close', (event) => event.preventDefault());
  click('关闭窗口');
  expect(window.closes).toBe(1);
  expect(window.destroyed).toBe(false);
  window.destroy();
  expect(root.webContents.closes).toBe(1);
});

test('Root title and responsiveness remain observable, and unexpected Root destruction closes its owned native window', () => {
  const value = createNativeRootWindow({ show: false, title: 'Kite' });
  const window = value as unknown as Window,
    root = getNativeRootView(value)! as unknown as ContentsView;
  let titles = 0,
    unavailable = 0,
    responsive = 0;
  window.on('page-title-updated', () => titles++);
  window.on('unresponsive', () => unavailable++);
  window.on('responsive', () => responsive++);
  root.webContents.emit('page-title-updated', { defaultPrevented: false }, 'Website');
  root.webContents.emit('unresponsive');
  root.webContents.emit('responsive');
  expect(titles).toBe(1);
  expect(window.title).toBe('');
  expect(unavailable).toBe(1);
  expect(responsive).toBe(1);
  root.webContents.close();
  expect(window.destroyed).toBe(true);
  expect(root.webContents.closes).toBe(1);
  expect(getNativeRootView(value)).toBeUndefined();
});

test('a hidden modal surface cannot retain activation focus after it closes in the background', () => {
  const value = createNativeRootWindow({ show: false });
  const window = value as unknown as Window;
  const root = getNativeRootView(value)! as unknown as ContentsView;
  const overlay = new ContentsView({});
  window.contentView.addChildView(overlay);
  overlay.webContents.focused = true;
  window.emit('blur');
  overlay.visible = false;
  window.emit('focus');
  expect(root.webContents.focused).toBe(true);
  expect(overlay.visible).toBe(false);
  expect(root.webContents.isDestroyed()).toBe(false);
  window.destroy();
});

test('activating the window preserves the actual focused page and restores that surface after blur', () => {
  const value = createNativeRootWindow({ show: false }),
    window = value as unknown as Window;
  const root = getNativeRootView(value)! as unknown as ContentsView;
  const page = new ContentsView({});
  window.contentView.addChildView(page);
  page.webContents.focused = true;
  window.emit('focus');
  expect(page.webContents.focused).toBe(true);
  expect(root.webContents.focused).toBe(false);
  window.emit('blur');
  page.webContents.focused = false;
  window.emit('focus');
  expect(page.webContents.focused).toBe(true);
  expect(root.webContents.focused).toBe(false);
  page.webContents.close();
  window.destroy();
});

test('the same explicit Root factory forwards platform window options while confining preload and WebPreferences to Root', () => {
  for (const platform of [
    {
      titleBarStyle: 'hiddenInset' as const,
      trafficLightPosition: { x: 13, y: 17 },
      vibrancy: 'sidebar' as const,
      visualEffectState: 'active' as const,
    },
    {
      titleBarStyle: 'hidden' as const,
      titleBarOverlay: { color: '#00000000', symbolColor: '#eeeeee', height: 32 },
      backgroundMaterial: 'mica' as const,
      icon: '/owned/app-icon.ico',
    },
    {
      titleBarStyle: 'hidden' as const,
      titleBarOverlay: { color: '#00000000', symbolColor: '#222222', height: 32 },
    },
  ]) {
    const webPreferences = {
      preload: '/owned/preload.cjs',
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    };
    const value = createNativeRootWindow({
      ...platform,
      webPreferences,
      title: 'Kite',
      show: false,
      backgroundColor: '#191919',
    });
    const window = value as unknown as Window,
      root = getNativeRootView(value)! as unknown as ContentsView;
    expect(window.options).toEqual({
      ...platform,
      title: 'Kite',
      show: false,
      backgroundColor: '#191919',
    });
    expect(root.options).toEqual({ webPreferences });
    expect(window.contentView.children).toEqual([root]);
    expect(root.bounds).toEqual({ x: 0, y: 0, width: 1000, height: 700 });
    expect(root.colors).toEqual(['#191919']);
    window.destroy();
    expect(root.webContents.closes).toBe(1);
  }
});
