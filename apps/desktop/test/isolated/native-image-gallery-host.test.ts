import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { IpcMain, WebContentsView } from 'electron';
import { createNativeGlobalDialogHost } from '../../electron/native-global-dialog-host';
import { createNativeImageGalleryHost } from '../../electron/native-image-gallery-host';
import { addNativeWindowView, focusNativeWindowContent } from '../../electron/native-overlay-layer';
import type { NativeRootWindow } from '../../electron/native-root-window';
import { nativeGlobalDialogEventChannel } from '../../src/native-global-dialog-bridge';
import {
  type NativeImageGalleryPresentation,
  type NativeImageGalleryState,
  nativeImageGalleryActionChannel,
  nativeImageGalleryCloseChannel,
  nativeImageGalleryEventChannel,
  nativeImageGalleryPresentChannel,
  nativeImageGalleryStateChannel,
} from '../../src/native-image-gallery-bridge';

const rootUrl = 'file:///private/kite/index.html';
const url = 'file:///private/kite/image-gallery.html';
class Contents extends EventEmitter {
  mainFrame = { url };
  destroyed = false;
  focused = false;
  zoom = 1;
  messages: { channel: string; state: Record<string, unknown> | null }[] = [];
  isDestroyed() {
    return this.destroyed;
  }
  isFocused() {
    return this.focused;
  }
  getZoomFactor() {
    return this.zoom;
  }
  setZoomFactor(zoom: number) {
    this.zoom = zoom;
  }
  focus() {
    this.focused = true;
  }
  send(channel: string, state: unknown) {
    this.messages.push({ channel, state: state as Record<string, unknown> | null });
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
function fixture(failure?: 'create' | 'initialize') {
  let attempts = 0;
  const root = new Surface(),
    page = new Surface(),
    ipc = new EventEmitter();
  root.webContents.mainFrame.url = rootUrl;
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
    isVisible() {
      return this.visible;
    },
    isFocused() {
      return this.focused;
    },
    isMinimized() {
      return this.minimized;
    },
    getContentSize() {
      return this.size;
    },
  });
  const views: Surface[] = [];
  const host = createNativeImageGalleryHost({
    window: parent as unknown as NativeRootWindow,
    ipcMain: ipc as unknown as IpcMain,
    rootUrl,
    url,
    theme: () => 'dark',
    createView() {
      attempts++;
      if (attempts === 1 && failure === 'create') throw Error('fixture_create_failed');
      const view = new Surface();
      if (attempts === 1 && failure === 'initialize')
        view.setBackgroundColor = () => {
          throw Error('fixture_setup_failed');
        };
      views.push(view);
      return view as unknown as WebContentsView;
    },
  });
  const emit = (
    channel: string,
    input: unknown,
    contents = root.webContents,
    frame = contents.mainFrame,
  ) => ipc.emit(channel, { sender: contents, senderFrame: frame }, input);
  const tick = async () => {
    for (let n = 0; n < 8; n++) await Promise.resolve();
  };
  const ready = async () => {
    emit(nativeImageGalleryEventChannel, { type: 'ready' }, views.at(-1)!.webContents);
    await tick();
  };
  const current = () =>
    views
      .at(-1)!
      .webContents.messages.filter((value) => value.channel === nativeImageGalleryStateChannel)
      .at(-1)?.state as NonNullable<NativeImageGalleryState>;
  const state = (sessionId = 'one'): NativeImageGalleryPresentation => ({
    sessionId,
    items: [
      { id: 'a', name: 'duplicate.png' },
      { id: 'b', name: 'duplicate.png' },
    ],
    selectedId: 'a',
    language: 'zh',
    image: {
      status: 'ready',
      revision: 'revision-one',
      mimeType: 'image/png',
      bytes: new Uint8Array([1, 2, 3]),
    },
  });
  return { root, page, ipc, parent, views, host, emit, tick, ready, current, state };
}
test('viewer is transparent full-window native layer without hiding Page; old bytes clear before selection', async () => {
  const f = fixture();
  try {
    f.emit(nativeImageGalleryPresentChannel, f.state());
    const overlay = f.views[0]!;
    expect(overlay.visible).toBe(true);
    expect(overlay.background).toBe('#00000000');
    expect(overlay.bounds).toEqual({ x: 0, y: 0, width: 1000, height: 700 });
    await f.ready();
    expect(f.current().selectedId).toBe('a');
    const readyImage = f.current().image;
    expect(readyImage.status).toBe('ready');
    if (readyImage.status === 'ready') expect(readyImage.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(f.page.visible).toBe(true);
    let blocked = 0;
    f.root.webContents.emit('before-input-event', {
      preventDefault() {
        blocked++;
      },
    });
    f.page.webContents.emit('before-input-event', {
      preventDefault() {
        blocked++;
      },
    });
    expect(blocked).toBe(1);
    f.emit(
      nativeImageGalleryEventChannel,
      { sessionId: 'one', type: 'select', id: 'b' },
      overlay.webContents,
    );
    expect(f.current().image).toEqual({ status: 'loading' });
    expect(f.current().selectedId).toBe('b');
    f.emit(nativeImageGalleryPresentChannel, f.state()); // Late response for a cannot restore its bytes.
    expect(f.current().selectedId).toBe('b');
    expect(f.current().image.status).toBe('loading');
    f.emit(nativeImageGalleryPresentChannel, { ...f.state(), selectedId: 'b' });
    expect(f.current().image.status).toBe('ready');
    f.emit(nativeImageGalleryCloseChannel, 'one');
    expect(f.current()).toBeNull();
    expect(overlay.visible).toBe(false);
    f.emit(nativeImageGalleryPresentChannel, f.state());
    expect(f.host.active()).toBe(false);
    expect(f.page.visible).toBe(true);
    expect(f.page.webContents.destroyed).toBe(false);
  } finally {
    f.host.dispose();
  }
});
test('exact Root/viewer main frames, bounded finite DTOs and current sessions only', async () => {
  const f = fixture();
  try {
    for (const input of [
      { ...f.state(), html: '<script>' },
      { ...f.state(), items: [] },
      {
        ...f.state(),
        image: {
          status: 'ready',
          revision: 'revision-one',
          mimeType: 'image/svg+xml',
          bytes: new Uint8Array([1]),
        },
      },
      {
        ...f.state(),
        image: {
          status: 'ready',
          revision: 'revision-one',
          mimeType: 'image/png',
          bytes: new Uint8Array(16 * 1024 * 1024 + 1),
        },
      },
      {
        ...f.state(),
        image: {
          status: 'ready',
          revision: 'revision-one',
          mimeType: 'image/png',
          bytes: new Uint8Array(),
        },
      },
      {
        ...f.state(),
        items: [
          { id: 'a', name: 'x' },
          { id: 'a', name: 'x' },
        ],
      },
    ])
      f.emit(nativeImageGalleryPresentChannel, input);
    f.emit(nativeImageGalleryPresentChannel, f.state(), f.page.webContents);
    f.emit(nativeImageGalleryPresentChannel, f.state(), f.root.webContents, { url: rootUrl });
    expect(f.views).toHaveLength(0);
    f.emit(nativeImageGalleryPresentChannel, f.state());
    await f.ready();
    const contents = f.views[0]!.webContents;
    for (const [input, sender, frame] of [
      [{ sessionId: 'one', type: 'close' }, f.root.webContents, f.root.webContents.mainFrame],
      [{ sessionId: 'one', type: 'close' }, contents, { url }],
      [{ sessionId: 'old', type: 'close' }, contents, contents.mainFrame],
      [{ sessionId: 'one', type: 'select', id: 'unadmitted' }, contents, contents.mainFrame],
      [{ sessionId: 'one', type: 'close', extra: 1 }, contents, contents.mainFrame],
    ] as const)
      f.emit(nativeImageGalleryEventChannel, input, sender, frame);
    expect(f.host.active()).toBe(true);
    f.emit(nativeImageGalleryCloseChannel, 'old');
    expect(f.host.active()).toBe(true);
    f.emit(nativeImageGalleryPresentChannel, f.state('two'));
    f.emit(nativeImageGalleryCloseChannel, 'one');
    expect(f.host.active()).toBe(true);
    f.emit(nativeImageGalleryEventChannel, { sessionId: 'one', type: 'close' }, contents);
    expect(f.host.active()).toBe(true);
  } finally {
    f.host.dispose();
  }
});
test('confirmation always stays above image viewer, including new Page insertions and focus restoration', async () => {
  const f = fixture();
  const dialogs: Surface[] = [];
  const dialogUrl = 'file:///private/kite/global-dialog.html';
  const confirmation = createNativeGlobalDialogHost({
    window: f.parent as unknown as NativeRootWindow,
    ipcMain: f.ipc as unknown as IpcMain,
    url: dialogUrl,
    theme: () => 'dark',
    createView() {
      const v = new Surface();
      v.webContents.mainFrame.url = dialogUrl;
      dialogs.push(v);
      return v as unknown as WebContentsView;
    },
  });
  try {
    confirmation.prewarm();
    f.emit(nativeGlobalDialogEventChannel, { type: 'ready' }, dialogs[0]!.webContents);
    f.emit(nativeImageGalleryPresentChannel, f.state());
    await f.ready();
    const viewer = f.views[0]!;
    expect(f.parent.contentView.children.at(-1)).toBe(dialogs[0]);
    f.root.webContents.focused = false;
    viewer.webContents.focused = true;
    const controller = new AbortController();
    const result = confirmation.confirm(
      { kind: 'full-permission', language: 'zh' },
      controller.signal,
    );
    await f.tick();
    const newPage = new Surface();
    addNativeWindowView(
      f.parent as unknown as NativeRootWindow,
      newPage as unknown as WebContentsView,
    );
    expect(f.parent.contentView.children.slice(-2)).toEqual([viewer, dialogs[0]!]);
    dialogs[0]!.webContents.focused = false;
    focusNativeWindowContent(f.parent as unknown as NativeRootWindow, viewer.webContents as never);
    expect(dialogs[0]!.webContents.focused).toBe(true);
    controller.abort();
    expect(await result).toBe(false);
    expect(f.host.active()).toBe(true);
    expect(viewer.visible).toBe(true);
    expect(dialogs[0]!.visible).toBe(false);
    viewer.webContents.focused = false;
    focusNativeWindowContent(f.parent as unknown as NativeRootWindow, f.root.webContents as never);
    expect(viewer.webContents.focused).toBe(true);
    expect(f.page.visible).toBe(true);
  } finally {
    confirmation.dispose();
    f.host.dispose();
  }
});
test('hide, Root replacement and viewer crash retire opaque sessions and clear bytes', async () => {
  for (const reason of ['hide', 'root', 'crash', 'closed'] as const) {
    const f = fixture();
    try {
      f.emit(nativeImageGalleryPresentChannel, f.state());
      await f.ready();
      const viewer = f.views[0]!;
      if (reason === 'hide') {
        f.parent.visible = false;
        f.parent.emit('hide');
      } else if (reason === 'root')
        f.root.webContents.emit('did-start-navigation', { isMainFrame: true });
      else if (reason === 'crash') viewer.webContents.emit('render-process-gone');
      else {
        f.parent.destroyed = true;
        f.parent.emit('closed');
      }
      expect(f.host.active()).toBe(false);
      expect(
        f.root.webContents.messages.some(
          ({ channel, state }) =>
            channel === nativeImageGalleryActionChannel && state?.type === 'close',
        ),
      ).toBe(true);
      if (reason !== 'closed') expect(viewer.visible).toBe(false);
      expect(f.page.visible).toBe(true);
      expect(f.page.webContents.destroyed).toBe(false);
    } finally {
      f.host.dispose();
    }
  }
});

test('a failed cold creation or partial setup clears its native owner and a new session can reopen', async () => {
  for (const failure of ['create', 'initialize'] as const) {
    const f = fixture(failure);
    try {
      f.emit(nativeImageGalleryPresentChannel, f.state());
      await f.tick();
      expect(f.host.active()).toBe(false);
      expect(
        f.root.webContents.messages.filter(
          ({ channel, state }) =>
            channel === nativeImageGalleryActionChannel && state?.type === 'unavailable',
        ),
      ).toHaveLength(1);
      if (failure === 'initialize') expect(f.views[0]!.webContents.destroyed).toBe(true);
      f.emit(nativeImageGalleryPresentChannel, f.state('two'));
      await f.ready();
      expect(f.host.active()).toBe(true);
      expect(f.current().sessionId).toBe('two');
      expect(f.parent.contentView.children.filter((view) => f.views.includes(view))).toHaveLength(
        1,
      );
    } finally {
      f.host.dispose();
    }
  }
});
