import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { IpcMain, WebContentsView } from 'electron';
import { addNativeWindowView } from '../../electron/native-overlay-layer';
import type { NativeRootWindow } from '../../electron/native-root-window';
import { createNativeSessionSearchHost } from '../../electron/native-session-search-host';
import {
  isNativeSessionSearchPresentation,
  type NativeSessionSearchPresentation,
  nativeSessionSearchActionChannel,
  nativeSessionSearchActiveChannel,
  nativeSessionSearchCloseChannel,
  nativeSessionSearchEventChannel,
  nativeSessionSearchPresentChannel,
  nativeSessionSearchStateChannel,
} from '../../src/native-session-search-bridge';

const rootUrl = 'file:///kite/index.html';
const url = 'file:///kite/session-search.html';
const row = (id: string) => ({
  key: id,
  workspaceLabel: 'Project',
  session: { sessionId: id, displayName: id, status: 'idle' },
});
const state: NativeSessionSearchPresentation = {
  requestId: 'first',
  resultId: 'results-1',
  query: '',
  page: 0,
  resultPage: 0,
  available: true,
  total: 1,
  rows: [row('current')],
};
class Contents extends EventEmitter {
  readonly mainFrame: { url: string };
  readonly messages: { channel: string; value: unknown }[] = [];
  private destroyed = false;
  constructor(url: string) {
    super();
    this.mainFrame = { url };
  }
  send(channel: string, value: unknown) {
    this.messages.push({ channel, value });
  }
  sent(channel: string) {
    return this.messages.filter((item) => item.channel === channel).map((item) => item.value);
  }
  isDestroyed() {
    return this.destroyed;
  }
  isFocused() {
    return false;
  }
  getZoomFactor() {
    return 1;
  }
  focus() {}
  setWindowOpenHandler() {}
  async loadURL() {}
  close() {
    this.destroyed = true;
    this.emit('destroyed');
  }
}
class Surface {
  readonly webContents: Contents;
  visible = true;
  bounds = { x: 13, y: 22, width: 500, height: 450 };
  constructor(url: string) {
    this.webContents = new Contents(url);
  }
  setVisible(visible: boolean) {
    this.visible = visible;
  }
  getVisible() {
    return this.visible;
  }
  getBounds() {
    return this.bounds;
  }
  setBounds(bounds: typeof this.bounds) {
    this.bounds = bounds;
  }
  setBackgroundColor() {}
}

function fixture() {
  const ipc = new EventEmitter();
  const root = new Surface(rootUrl);
  const browser = new Surface('https://example.test');
  const preview = new Surface('file:///kite/preview.html');
  const overlay = new Surface(url);
  const content = Object.assign(new EventEmitter(), {
    children: [root, browser, preview],
    addChildView(view: Surface, index?: number) {
      this.removeChildView(view);
      this.children.splice(index ?? this.children.length, 0, view);
    },
    removeChildView(view: Surface) {
      const index = this.children.indexOf(view);
      if (index >= 0) this.children.splice(index, 1);
    },
  });
  const window = Object.assign(new EventEmitter(), {
    contentView: content,
    webContents: root.webContents,
    getContentSize: () => [1000, 800],
    isDestroyed: () => false,
    isVisible: () => true,
    isMinimized: () => false,
    isFocused: () => true,
  });
  let higherModal = false;
  const host = createNativeSessionSearchHost({
    window: window as unknown as NativeRootWindow,
    ipcMain: ipc as unknown as IpcMain,
    rootUrl,
    url,
    createView: () => overlay as unknown as WebContentsView,
    theme: () => 'dark',
    higherModalActive: () => higherModal,
  });
  const send = (
    channel: string,
    input: unknown,
    contents: Contents,
    tail?: unknown,
    frame = contents.mainFrame,
  ) => ipc.emit(channel, { sender: contents, senderFrame: frame }, input, tail);
  const present = (input: unknown, opening = true) =>
    send(nativeSessionSearchPresentChannel, input, root.webContents, opening);
  const overlayEvent = (input: unknown) =>
    send(nativeSessionSearchEventChannel, input, overlay.webContents);
  return {
    host,
    window,
    root,
    browser,
    preview,
    overlay,
    send,
    present,
    overlayEvent,
    preempt() {
      higherModal = true;
    },
    actions: () => root.webContents.sent(nativeSessionSearchActionChannel),
  };
}

test('native search claims top-level hit testing without modifying Browser or Office, retires its own root input fence and cannot reopen on a late update', () => {
  const f = fixture();
  try {
    const browserBounds = f.browser.bounds;
    const previewBounds = f.preview.bounds;
    f.present(state);
    f.overlayEvent({ type: 'ready' });
    expect(f.overlay.webContents.sent(nativeSessionSearchStateChannel)).toEqual([
      { ...state, theme: 'dark' },
    ]);
    expect(f.overlay.visible).toBe(true);
    expect(f.overlay.bounds).toEqual({ x: 0, y: 0, width: 1000, height: 800 });
    const shield = new Surface('file:///kite/shield.html');
    addNativeWindowView(
      f.window as unknown as NativeRootWindow,
      shield as unknown as WebContentsView,
    );
    expect(f.window.contentView.children.at(-1)).toBe(f.overlay);
    expect(f.browser.bounds).toBe(browserBounds);
    expect(f.preview.bounds).toBe(previewBounds);
    expect(f.browser.visible && f.preview.visible).toBe(true);
    let prevented = 0;
    const event = {
      preventDefault: () => {
        prevented++;
      },
    };
    f.browser.webContents.emit('before-mouse-event', event);
    f.browser.webContents.emit('before-input-event', event);
    expect(prevented).toBe(0);
    f.root.webContents.emit('before-mouse-event', event);
    expect(prevented).toBe(1);
    f.overlayEvent({ type: 'close', requestId: state.requestId });
    expect(f.host.active()).toBe(false);
    expect(f.overlay.visible).toBe(false);
    expect(f.root.webContents.sent(nativeSessionSearchActiveChannel)).toEqual([true, false]);
    f.present(state, false);
    expect(f.host.active()).toBe(false);
    f.root.webContents.emit('before-mouse-event', event);
    expect(prevented).toBe(1);
  } finally {
    f.host.dispose();
  }
});

test('only exact frames may update or select from a published batch', () => {
  const f = fixture();
  const selection = {
    type: 'select',
    query: '',
    page: 0,
    requestId: 'first',
    resultId: state.resultId,
    sessionId: 'current',
  };
  try {
    f.send(nativeSessionSearchPresentChannel, state, f.browser.webContents, true);
    expect(f.host.active()).toBe(false);
    f.present(state);
    f.overlayEvent({ type: 'ready' });
    f.send(nativeSessionSearchEventChannel, selection, f.root.webContents);
    f.send(nativeSessionSearchEventChannel, selection, f.overlay.webContents, undefined, { url });
    f.overlayEvent({ ...selection, requestId: 'retired' });
    expect(f.host.active()).toBe(true);
    expect(f.actions()).toEqual([]);
    const query = { requestId: 'first', type: 'query', query: 'project', page: 3 };
    f.overlayEvent(query);
    f.present({ ...state, query: 'project' }, false);
    expect(f.overlay.webContents.sent(nativeSessionSearchStateChannel)).toHaveLength(1);
    f.present({ ...state, query: 'project', page: 3, total: 1, rows: [row('new')] }, false);
    const selected = { ...selection, query: 'project', sessionId: 'new' };
    f.overlayEvent(selected);
    expect(f.host.active()).toBe(false);
    expect(f.actions()).toEqual([query, selected]);
  } finally {
    f.host.dispose();
  }
});

test('continuous search can select an earlier loaded batch, but a changed snapshot retires it', () => {
  for (const changed of [false, true]) {
    const f = fixture();
    try {
      const firstBatch = Array.from({ length: 50 }, (_, index) => row(`row-${index}`));
      const first = { ...state, total: 51, rows: firstBatch };
      f.present(first);
      f.overlayEvent({ type: 'ready' });
      const next = { type: 'query', requestId: state.requestId, query: state.query, page: 1 };
      f.overlayEvent(next);
      f.present(
        {
          ...first,
          resultId: changed ? 'results-2' : first.resultId,
          page: 1,
          resultPage: 1,
          rows: [row('row-50')],
        },
        false,
      );
      const selection = {
        type: 'select',
        requestId: first.requestId,
        resultId: first.resultId,
        query: first.query,
        page: 0,
        sessionId: 'row-0',
      };
      f.overlayEvent(selection);
      expect(f.actions()).toEqual([
        next,
        changed ? { type: 'close', requestId: first.requestId } : selection,
      ]);
    } finally {
      f.host.dispose();
    }
  }
});

test('a racing approval, a removed row, an old Root close and a hidden window never cause navigation', () => {
  const f = fixture();
  const selection = {
    type: 'select',
    query: '',
    page: 0,
    requestId: 'first',
    resultId: state.resultId,
    sessionId: 'current',
  };
  try {
    f.present(state);
    f.overlayEvent({ type: 'ready' });
    f.send(nativeSessionSearchCloseChannel, 'retired', f.root.webContents);
    expect(f.host.active()).toBe(true);
    f.present({ ...state, rows: [row('new')] }, false);
    f.overlayEvent(selection);
    expect(f.actions()).toEqual([{ type: 'close', requestId: 'first' }]);
    f.present({ ...state, requestId: 'second' });
    f.window.emit('hide');
    expect(f.host.active()).toBe(false);
    f.present({ ...state, requestId: 'third' });
    f.preempt();
    f.overlayEvent({ ...selection, requestId: 'third' });
    expect(f.host.active()).toBe(false);
    f.present({ ...state, requestId: 'fourth' });
    expect(f.host.active()).toBe(false);
    expect(f.actions()).toEqual(
      ['first', 'second', 'third', 'fourth'].map((requestId) => ({ type: 'close', requestId })),
    );
  } finally {
    f.host.dispose();
  }
});

test('the preload DTO cannot transport a complete directory or extra app data', () => {
  const large = Array.from({ length: 51 }, (_, n) => row(String(n)));
  expect(isNativeSessionSearchPresentation({ ...state, total: 51, rows: large })).toBe(false);
  expect(
    isNativeSessionSearchPresentation({
      ...state,
      rows: [{ ...row('id'), session: { ...row('id').session, draft: 'private' } }],
    }),
  ).toBe(false);
  expect(isNativeSessionSearchPresentation({ ...state, query: 'x'.repeat(513) })).toBe(false);
  expect(isNativeSessionSearchPresentation({ ...state, page: 5, resultPage: 5 })).toBe(false);
  expect(isNativeSessionSearchPresentation({ ...state, page: 5 })).toBe(true);
});

test('search activity timestamp crosses the bridge only as a bounded millisecond value', () => {
  const valid = (updatedAtMs: unknown) =>
    isNativeSessionSearchPresentation({ ...state, rows: [{ ...row('id'), updatedAtMs }] });
  expect(valid(1_795_263_600_000)).toBe(true);
  expect(valid(undefined)).toBe(true);
  expect(valid('2026-11-21T14:00:00.000Z')).toBe(false);
  expect(valid(Number.POSITIVE_INFINITY)).toBe(false);
  expect(valid(8_640_000_000_000_001)).toBe(false);
  expect(valid(42.5)).toBe(false);
});
