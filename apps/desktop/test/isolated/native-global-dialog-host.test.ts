import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { IpcMain, WebContentsView } from 'electron';
import { createNativeGlobalDialogHost } from '../../electron/native-global-dialog-host';
import { addNativeWindowView, focusNativeWindowContent } from '../../electron/native-overlay-layer';
import type { NativeRootWindow } from '../../electron/native-root-window';
import {
  type NativeGlobalDialogState,
  nativeGlobalDialogEventChannel,
} from '../../src/native-global-dialog-bridge';

const url = 'file:///private/kite/global-dialog.html';
class Contents extends EventEmitter {
  mainFrame = { url };
  destroyed = false;
  focused = false;
  zoom = 1;
  messages: NativeGlobalDialogState[] = [];
  isDestroyed() {
    return this.destroyed;
  }
  isFocused() {
    return this.focused;
  }
  getZoomFactor() {
    return this.zoom;
  }
  setZoomFactor(value: number) {
    this.zoom = value;
  }
  focus() {
    this.focused = true;
  }
  send(_channel: string, state: NativeGlobalDialogState) {
    this.messages.push(state);
  }
  setWindowOpenHandler() {}
  async loadURL() {}
  close() {
    this.destroyed = true;
    this.emit('destroyed');
  }
}
class Surface {
  webContents = new Contents();
  visible = true;
  bounds = { x: 0, y: 0, width: 600, height: 400 };
  background = '';
  getVisible() {
    return this.visible;
  }
  setVisible(value: boolean) {
    this.visible = value;
  }
  getBounds() {
    return this.bounds;
  }
  setBounds(value: typeof this.bounds) {
    this.bounds = value;
  }
  setBackgroundColor(value: string) {
    this.background = value;
  }
}
function fixture() {
  const root = new Surface(),
    page = new Surface(),
    ipc = new EventEmitter();
  root.webContents.focused = true;
  const content = Object.assign(new EventEmitter(), {
    children: [root, page],
    addChildView(view: Surface, index?: number) {
      this.removeChildView(view);
      this.children.splice(index ?? this.children.length, 0, view);
    },
    removeChildView(view: Surface) {
      const at = this.children.indexOf(view);
      if (at >= 0) this.children.splice(at, 1);
    },
  });
  const parent = Object.assign(new EventEmitter(), {
    contentView: content,
    webContents: root.webContents,
    visible: true,
    minimized: false,
    destroyed: false,
    focused: true,
    size: [1000, 700],
    isDestroyed() {
      return this.destroyed;
    },
    isFocused() {
      return this.focused;
    },
    isVisible() {
      return this.visible;
    },
    isMinimized() {
      return this.minimized;
    },
    getContentSize() {
      return this.size;
    },
  });
  let theme: 'dark' | 'light' = 'dark';
  const views: Surface[] = [];
  const host = createNativeGlobalDialogHost({
    window: parent as unknown as NativeRootWindow,
    ipcMain: ipc as unknown as IpcMain,
    url,
    theme: () => theme,
    createView() {
      const view = new Surface();
      views.push(view);
      return view as unknown as WebContentsView;
    },
  });
  const send = (input: unknown, contents = views.at(-1)!.webContents, frame = contents.mainFrame) =>
    ipc.emit(nativeGlobalDialogEventChannel, { sender: contents, senderFrame: frame }, input);
  const tick = async () => {
    for (let n = 0; n < 8; n++) await Promise.resolve();
  };
  const current = () =>
    views
      .at(-1)!
      .webContents.messages.filter((state) => state !== null)
      .at(-1)!;
  const ready = async () => {
    send({ type: 'ready' });
    await tick();
  };
  const present = () => send({ type: 'presented', requestId: current().requestId });
  return {
    root,
    page,
    parent,
    ipc,
    host,
    views,
    send,
    tick,
    ready,
    present,
    current,
    theme(value: typeof theme) {
      theme = value;
      host.syncTheme();
    },
  };
}

test('the full-content overlay stays above Page and shield, fences Root input and preserves Page CDP without hiding Page', async () => {
  const f = fixture(),
    controller = new AbortController();
  try {
    f.host.prewarm();
    const overlay = f.views[0]!;
    expect(overlay.visible).toBe(false);
    expect(overlay.background).toBe('#00000000');
    await f.ready();
    const decision = f.host.confirm({ kind: 'full-permission', language: 'zh' }, controller.signal);
    await f.tick();
    const state = f.current();
    expect(state).toMatchObject({ kind: 'full-permission', language: 'zh', theme: 'dark' });
    f.send({ type: 'decision', requestId: state.requestId, confirmed: true });
    expect(f.host.active()).toBe(true);
    f.present();
    expect(overlay.visible).toBe(true);
    expect(overlay.bounds).toEqual({ x: 0, y: 0, width: 1000, height: 700 });
    expect(overlay.webContents.focused).toBe(true);
    expect(f.page.visible).toBe(true);
    let prevented = 0;
    f.page.webContents.emit('before-mouse-event', {
      preventDefault() {
        prevented++;
      },
    });
    f.page.webContents.emit('before-input-event', {
      preventDefault() {
        prevented++;
      },
    });
    expect(prevented).toBe(0);
    f.root.webContents.emit('before-input-event', {
      preventDefault() {
        prevented++;
      },
    });
    expect(prevented).toBe(1);
    const shield = new Surface();
    addNativeWindowView(
      f.parent as unknown as NativeRootWindow,
      shield as unknown as WebContentsView,
    );
    expect(f.parent.contentView.children.at(-1)).toBe(overlay);
    shield.webContents.emit('before-input-event', {
      preventDefault() {
        prevented++;
      },
    });
    expect(prevented).toBe(1);
    overlay.webContents.focused = false;
    focusNativeWindowContent(f.parent as unknown as NativeRootWindow, f.root.webContents as never);
    expect(overlay.webContents.focused).toBe(true);
    f.parent.size = [1200, 800];
    f.parent.contentView.emit('bounds-changed');
    expect(overlay.bounds.width).toBe(1200);
    expect(overlay.bounds.height).toBe(800);
    f.theme('light');
    expect(f.current().theme).toBe('light');
    f.root.webContents.focused = false;
    f.send({ type: 'decision', requestId: state.requestId, confirmed: false });
    expect(await decision).toBe(false);
    expect(overlay.visible).toBe(false);
    expect(f.page.visible).toBe(true);
    expect(f.page.webContents.destroyed).toBe(false);
    expect(f.root.webContents.focused).toBe(true);
    f.page.webContents.emit('before-mouse-event', {
      preventDefault() {
        prevented++;
      },
    });
    expect(prevented).toBe(1);
  } finally {
    f.host.dispose();
  }
});

test('only the exact overlay main frame and current presented request may confirm; old decisions cannot approve a successor', async () => {
  const f = fixture(),
    first = new AbortController();
  try {
    const a = f.host.confirm({ kind: 'full-permission', language: 'zh' }, first.signal);
    await f.ready();
    const old = f.current();
    f.send({ type: 'presented', requestId: old.requestId }, f.root.webContents);
    f.send({ type: 'presented', requestId: old.requestId }, f.views[0]!.webContents, { url });
    f.send({ type: 'presented', requestId: old.requestId, extra: true });
    f.send({ type: 'decision', requestId: old.requestId, confirmed: true });
    expect(f.host.active()).toBe(true);
    f.present();
    first.abort();
    expect(await a).toBe(false);
    const b = f.host.confirm(
      { kind: 'full-permission', language: 'en' },
      new AbortController().signal,
    );
    await f.tick();
    expect(f.current().requestId).not.toBe(old.requestId);
    f.send({ type: 'decision', requestId: old.requestId, confirmed: true });
    expect(f.host.active()).toBe(true);
    f.present();
    f.send({ type: 'decision', requestId: f.current().requestId, confirmed: true });
    expect(await b).toBe(true);
  } finally {
    f.host.dispose();
  }
});

test('cancellation before the first presented frame closes immediately without allowing early approval', async () => {
  const f = fixture();
  try {
    const decision = f.host.confirm(
      { kind: 'full-permission', language: 'zh' },
      new AbortController().signal,
    );
    await f.ready();
    const state = f.current();
    f.send({ type: 'decision', requestId: state.requestId, confirmed: true });
    expect(f.host.active()).toBe(true);
    f.send({ type: 'decision', requestId: state.requestId, confirmed: false });
    expect(f.host.active()).toBe(false);
    expect(await decision).toBe(false);
    expect(f.page.visible).toBe(true);
  } finally {
    f.host.dispose();
  }
});

test('cold and prewarming modals cover Page immediately and own native focus before the renderer is ready', async () => {
  for (const prewarm of [false, true]) {
    const f = fixture();
    try {
      if (prewarm) f.host.prewarm();
      f.root.webContents.focused = false;
      const decision = f.host.confirm(
        { kind: 'full-permission', language: 'zh' },
        new AbortController().signal,
      );
      const overlay = f.views[0]!;
      expect(overlay.visible).toBe(true);
      expect(overlay.bounds).toEqual({ x: 0, y: 0, width: 1000, height: 700 });
      expect(f.parent.contentView.children.at(-1)).toBe(overlay);
      expect(f.page.visible).toBe(true);
      expect(overlay.webContents.focused).toBe(true);
      overlay.webContents.focused = false;
      f.page.webContents.emit('focus');
      expect(overlay.webContents.focused).toBe(true);
      await f.ready();
      overlay.webContents.focused = false;
      f.page.webContents.emit('focus');
      expect(overlay.webContents.focused).toBe(true);
      f.root.webContents.focused = false;
      f.send({ type: 'decision', requestId: f.current().requestId, confirmed: false });
      expect(await decision).toBe(false);
      expect(f.root.webContents.focused).toBe(true);
    } finally {
      f.host.dispose();
    }
  }
});

test('background cancellation and Page focus do not reactivate a window the user left', async () => {
  const f = fixture();
  try {
    const controller = new AbortController();
    const decision = f.host.confirm({ kind: 'full-permission', language: 'zh' }, controller.signal);
    await f.ready();
    f.present();
    const overlay = f.views[0]!;
    f.parent.focused = false;
    f.root.webContents.focused = false;
    overlay.webContents.focused = false;
    f.page.webContents.emit('focus');
    expect(overlay.webContents.focused).toBe(false);
    f.parent.focused = true;
    f.parent.emit('focus');
    expect(overlay.webContents.focused).toBe(true);
    f.parent.focused = false;
    controller.abort();
    expect(await decision).toBe(false);
    expect(f.root.webContents.focused).toBe(false);
    expect(overlay.visible).toBe(false);
    expect(f.page.visible).toBe(true);
  } finally {
    f.host.dispose();
  }
});

test('a modal renderer crash fails closed and the next request recreates the isolated view', async () => {
  const f = fixture();
  try {
    const a = f.host.confirm(
      { kind: 'full-permission', language: 'zh' },
      new AbortController().signal,
    );
    const rejected = a.catch((error: Error) => error);
    await f.ready();
    f.present();
    f.views[0]!.webContents.emit('render-process-gone');
    expect(await rejected).toBeInstanceOf(Error);
    expect(((await rejected) as Error).message).toBe('native_global_dialog_unavailable');
    expect(f.page.visible).toBe(true);
    const b = f.host.confirm(
      { kind: 'full-permission', language: 'zh' },
      new AbortController().signal,
    );
    expect(f.views).toHaveLength(2);
    f.send({ type: 'ready' }, f.views[0]!.webContents);
    expect(f.views[1]!.visible).toBe(true);
    await f.ready();
    f.present();
    f.send({ type: 'decision', requestId: f.current().requestId, confirmed: true });
    expect(await b).toBe(true);
  } finally {
    f.host.dispose();
  }
});

test('hide, overlay navigation and disposal retire the modal while retaining Root and Page', async () => {
  for (const reason of ['hide', 'navigate', 'dispose'] as const) {
    const f = fixture();
    try {
      const promise = f.host.confirm(
        { kind: 'full-permission', language: 'zh' },
        new AbortController().signal,
      );
      const result = promise.catch(() => false);
      await f.ready();
      f.present();
      if (reason === 'hide') {
        f.parent.visible = false;
        f.parent.emit('hide');
      } else if (reason === 'navigate')
        f.views[0]!.webContents.emit('did-start-navigation', { isMainFrame: true });
      else f.host.dispose();
      expect(await result).toBe(false);
      expect(f.views[0]!.visible).toBe(false);
      expect(f.page.visible).toBe(true);
      expect(f.page.webContents.destroyed).toBe(false);
      expect(f.root.webContents.destroyed).toBe(false);
    } finally {
      f.host.dispose();
    }
  }
});

test('permission and workspace confirmations share the same modal ownership and retire on Root replacement', async () => {
  for (const content of [
    { kind: 'workspace-removal', label: 'workspace', language: 'zh' },
    { kind: 'full-permission', language: 'zh' },
  ] as const) {
    const f = fixture();
    try {
      const decision = f.host.confirm(content, new AbortController().signal);
      await f.ready();
      expect(f.current()).toMatchObject(content);
      f.present();
      f.root.webContents.emit('did-start-navigation', { isMainFrame: true });
      expect(await decision).toBe(false);
      expect(f.host.active()).toBe(false);
      expect(f.page.visible).toBe(true);
    } finally {
      f.host.dispose();
    }
  }
});
