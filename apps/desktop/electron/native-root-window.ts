import type {
  BaseWindow,
  BrowserWindowConstructorOptions,
  MenuItemConstructorOptions,
  Rectangle,
  WebContents,
  WebContentsView,
} from 'electron';
import * as electron from 'electron';
import { cancelNativeWindowLayout, queueNativeWindowLayout } from './native-window-layout';

/** The application needs this public composition, not BrowserWindow's hidden primary View. */
export type NativeRootWindow = BaseWindow & {
  readonly webContents: WebContents;
  readonly loadURL: WebContents['loadURL'];
  readonly loadFile: WebContents['loadFile'];
};
const roots = new WeakMap<
  BaseWindow,
  { view: WebContentsView; hosted: boolean; ready: boolean; listeners: Set<() => void> }
>();
export function onNativeRootReady(window: NativeRootWindow, receive: () => void): () => void {
  const record = roots.get(window);
  if (!record) throw Error('native_root_view_unavailable');
  if (record.ready)
    queueMicrotask(() => {
      if (!window.isDestroyed()) receive();
    });
  else record.listeners.add(receive);
  return () => record.listeners.delete(receive);
}
export function getNativeRootView(window: NativeRootWindow): WebContentsView | undefined {
  return roots.get(window)?.view;
}
/** Transfer only physical geometry ownership; this never navigates or replaces Root. */
export function setNativeRootBounds(window: NativeRootWindow, bounds?: Rectangle): boolean {
  const record = roots.get(window);
  if (!record || window.isDestroyed() || record.view.webContents.isDestroyed()) return false;
  const [width = 0, height = 0] = window.getContentSize();
  if (
    bounds &&
    (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) ||
      bounds.x !== 0 ||
      bounds.y !== 0 ||
      bounds.width <= 0 ||
      bounds.width > width ||
      bounds.height !== height)
  )
    return false;
  record.hosted = !!bounds;
  record.view.setBounds(bounds ?? { x: 0, y: 0, width, height });
  return true;
}

export function createNativeRootWindow(options: BrowserWindowConstructorOptions): NativeRootWindow {
  const { webPreferences, ...windowOptions } = options;
  const native = new electron.BaseWindow({ ...windowOptions, show: false });
  let root: WebContentsView;
  try {
    root = new electron.WebContentsView({ webPreferences });
  } catch (error) {
    native.destroy();
    throw error;
  }
  const contents = root.webContents;
  let loadSequence = 0;
  let ready = false;
  let closed = false;
  const load = async (navigate: () => Promise<void>) => {
    const sequence = ++loadSequence;
    await navigate();
    if (closed || contents.isDestroyed() || window.isDestroyed())
      throw Error('native_root_load_unavailable');
    if (sequence !== loadSequence) throw Error('native_root_load_superseded');
    if (ready) return;
    ready = true;
    const record = roots.get(window);
    if (record) {
      record.ready = true;
      for (const receive of record.listeners) receive();
      record.listeners.clear();
    }
    if (options.show !== false && !window.isDestroyed()) window.show();
  };
  const window: NativeRootWindow = Object.assign(native, {
    webContents: contents,
    loadURL: (...args: Parameters<WebContents['loadURL']>) => load(() => contents.loadURL(...args)),
    loadFile: (...args: Parameters<WebContents['loadFile']>) =>
      load(() => contents.loadFile(...args)),
  });
  try {
    roots.set(window, { view: root, hosted: false, ready: false, listeners: new Set() });
    window.contentView.addChildView(root);
    root.setBackgroundColor(options.backgroundColor ?? '#ffffff');
    if (!setNativeRootBounds(window)) throw Error('native_root_view_unavailable');
  } catch (error) {
    roots.delete(window);
    if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
    if (!native.isDestroyed()) native.destroy();
    throw error;
  }
  const background = native.setBackgroundColor.bind(native);
  window.setBackgroundColor = (color) => {
    background(color);
    if (!contents.isDestroyed()) root.setBackgroundColor(color);
  };
  let previousFocus: WebContents = contents;
  const resizeLayout = () => {
    if (!closed && !roots.get(window)?.hosted) setNativeRootBounds(window);
  };
  const resize = () => queueNativeWindowLayout(window, resizeLayout);
  // A hidden WebContentsView need not have a capture surface. Completing the
  // actual load admits showing Root; screenshots never gate application startup.
  window.on('resize', resize);
  contents.on('unresponsive', () => {
    if (!closed) window.emit('unresponsive');
  });
  contents.on('responsive', () => {
    if (!closed) window.emit('responsive');
  });
  contents.on('page-title-updated', (event, title) => {
    if (closed) return;
    window.emit('page-title-updated', event, title);
    if (!event.defaultPrevented && options.title === undefined && !window.isDestroyed())
      window.setTitle(title);
  });
  const focusedSurface = () => {
    let focused: WebContents | undefined;
    for (const view of window.contentView.children) {
      if ('webContents' in view) {
        const candidate = view.webContents as WebContents | undefined;
        if (candidate && !candidate.isDestroyed() && candidate.isFocused()) focused = candidate;
      }
    }
    return focused;
  };
  window.on('blur', () => {
    if (closed || window.isDestroyed()) return;
    previousFocus = focusedSurface() ?? previousFocus;
  });
  window.on('focus', () => {
    if (closed || window.isDestroyed()) return;
    const focused = focusedSurface();
    if (focused) {
      previousFocus = focused;
      return;
    }
    const target = previousFocus.isDestroyed() ? contents : previousFocus;
    if (!target.isDestroyed()) target.focus();
  });
  contents.on('destroyed', () => {
    if (!closed && !window.isDestroyed()) window.destroy();
  });
  window.once('closed', () => {
    closed = true;
    loadSequence++;
    roots.delete(window);
    cancelNativeWindowLayout(window, resizeLayout);
    window.off('resize', resize);
    if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
  });
  return window;
}

/** Native edit responders remain native; window/Root roles use our actual owned instance. */
export function nativeRootWindowMenu(window: NativeRootWindow): MenuItemConstructorOptions[] {
  const current = () => !window.isDestroyed() && !window.webContents.isDestroyed();
  const zoom = (delta: number) => {
    if (current()) window.webContents.setZoomLevel(window.webContents.getZoomLevel() + delta);
  };
  return [
    { role: 'appMenu' },
    { role: 'editMenu' },
    {
      label: '视图',
      submenu: [
        {
          label: '重新载入',
          accelerator: 'CmdOrCtrl+R',
          click: () => {
            if (current()) window.webContents.reload();
          },
        },
        { type: 'separator' },
        { label: '放大', accelerator: 'Command+Plus', click: () => zoom(0.5) },
        { label: '缩小', accelerator: 'Command+-', click: () => zoom(-0.5) },
        {
          label: '实际大小',
          accelerator: 'Command+0',
          click: () => {
            if (current()) window.webContents.setZoomLevel(0);
          },
        },
        { type: 'separator' },
        {
          label: '切换全屏',
          accelerator: 'Control+Command+F',
          click: () => {
            if (current()) window.setFullScreen(!window.isFullScreen());
          },
        },
      ],
    },
    {
      label: '窗口',
      submenu: [
        {
          label: '最小化',
          accelerator: 'Command+M',
          click: () => {
            if (current()) window.minimize();
          },
        },
        {
          label: '关闭窗口',
          accelerator: 'Command+W',
          click: () => {
            if (current()) window.close();
          },
        },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ];
}
