import { expect, mock, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { MenuItemConstructorOptions } from 'electron';

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
    return this.loadURL(`file://${path}`);
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
  show() {
    this.shows++;
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
  setNativeRootBounds,
  onNativeRootReady,
  nativeRootWindowMenu,
} = await import('../../electron/native-root-window');
const tick = async () => {
  await Bun.sleep(0);
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
  await value.loadFile('/owned/index.html');
  expect(ready).toBe(1);
  expect(root.webContents.url).toBe('file:///owned/index.html');
  expect(root.webContents.captures).toBe(0);
  gate.resolve();
  await expect(prior).rejects.toThrow('native_root_load_superseded');
  expect(ready).toBe(1);
  expect(window.shows).toBe(0);
  window.destroy();
});

test('physical hosted geometry is preserved and unhosted resize waits until the native callback ends', async () => {
  const value = createNativeRootWindow({ show: false }),
    window = value as unknown as Window;
  const root = getNativeRootView(value)! as unknown as ContentsView;
  const writes = root.boundsWrites;
  expect(setNativeRootBounds(value)).toBe(true);
  expect(root.boundsWrites).toBe(writes);
  expect(setNativeRootBounds(value, { x: 0, y: 0, width: 600, height: 700 })).toBe(true);
  const clippedWrites = root.boundsWrites;
  expect(setNativeRootBounds(value, { x: 0, y: 0, width: 600, height: 700 })).toBe(true);
  expect(root.boundsWrites).toBe(clippedWrites);
  window.size[0] = 820;
  window.emit('resize');
  expect(root.bounds.width).toBe(600);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(root.bounds.width).toBe(600);
  expect(setNativeRootBounds(value, { x: 1, y: 0, width: 510, height: 700 })).toBe(false);
  expect(setNativeRootBounds(value, { x: 0, y: 0, width: 510, height: 700 })).toBe(true);
  expect(setNativeRootBounds(value)).toBe(true);
  expect(root.bounds.width).toBe(820);
  window.size[0] = 900;
  window.emit('resize');
  expect(root.bounds.width).toBe(820);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(root.bounds.width).toBe(900);
  window.size[0] = 920;
  window.emit('resize');
  window.destroy();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(root.bounds.width).toBe(900);
  expect(root.webContents.closes).toBe(1);
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

test('activating the window preserves the actual focused Chrome input and restores that surface after blur', () => {
  const value = createNativeRootWindow({ show: false }),
    window = value as unknown as Window;
  const root = getNativeRootView(value)! as unknown as ContentsView;
  const chrome = new ContentsView({});
  window.contentView.addChildView(chrome);
  chrome.webContents.focused = true;
  window.emit('focus');
  expect(chrome.webContents.focused).toBe(true);
  expect(root.webContents.focused).toBe(false);
  window.emit('blur');
  chrome.webContents.focused = false;
  window.emit('focus');
  expect(chrome.webContents.focused).toBe(true);
  expect(root.webContents.focused).toBe(false);
  chrome.webContents.close();
  window.destroy();
});
