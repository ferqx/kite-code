import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { IpcMain, WebContentsView } from 'electron';
import { addNativeWindowView } from '../../electron/native-overlay-layer';
import type { NativeRootWindow } from '../../electron/native-root-window';
import { createNativeSettingsHost } from '../../electron/native-settings-host';
import type { NativeUserMcpSubmission } from '../../src/mcp-bridge';
import {
  isNativeSettingsReply,
  isNativeSettingsRequest,
  isNativeSettingsState,
  type NativeSettingsState,
  nativeSettingsActionChannel,
  nativeSettingsActiveChannel,
  nativeSettingsCloseChannel,
  nativeSettingsOverlayEventChannel,
  nativeSettingsOverlayRequestChannel,
  nativeSettingsPresentChannel,
  nativeSettingsReplyChannel,
  nativeSettingsStateChannel,
  projectNativeSettingsReply,
  projectNativeSettingsState,
} from '../../src/native-settings-bridge';

const rootUrl = 'file:///kite/index.html';
const url = 'file:///kite/settings.html';
const state = {
  instanceId: 'first',
  generation: 12,
  storeId: 'store',
  selection: { storeId: 'store', session: { id: 'session' } },
  webSearchSessionId: 'session',
  canReadWebSearch: true,
  windowsShell: false,
  editor: 'vscode',
  appearance: 'system',
  theme: 'light',
} as const satisfies NativeSettingsState;
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
  const root = new Surface(rootUrl);
  const browser = new Surface('https://example.test');
  const preview = new Surface('file:///kite/preview.html');
  const layer = new Surface(url);
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
  let higher = false;
  let handler: ((...args: unknown[]) => unknown) | undefined;
  const ipc = Object.assign(new EventEmitter(), {
    handle(channel: string, listener: (...args: unknown[]) => unknown) {
      if (channel === nativeSettingsOverlayRequestChannel) handler = listener;
    },
    removeHandler() {
      handler = undefined;
    },
  });
  const host = createNativeSettingsHost({
    window: window as unknown as NativeRootWindow,
    ipcMain: ipc as unknown as IpcMain,
    rootUrl,
    url,
    createView: () => layer as unknown as WebContentsView,
    theme: () => 'dark',
    higherModalActive: () => higher,
  });
  const source = (sender: Contents, senderFrame = sender.mainFrame) => ({ sender, senderFrame });
  const rootSource = source(root.webContents);
  const layerSource = source(layer.webContents);
  return {
    host,
    root,
    browser,
    preview,
    layer,
    window,
    preempt(value: boolean) {
      higher = value;
    },
    open(value: unknown = state, opening = true) {
      ipc.emit(nativeSettingsPresentChannel, rootSource, value, opening);
    },
    ready() {
      ipc.emit(nativeSettingsOverlayEventChannel, layerSource, 'ready');
    },
    request(value: unknown, origin: 'layer' | 'root' | 'child' = 'layer', id = 'first') {
      const sender =
        origin === 'root'
          ? rootSource
          : origin === 'child'
            ? source(layer.webContents, { ...layer.webContents.mainFrame })
            : layerSource;
      return handler?.(sender, id, value);
    },
    intent(value: unknown) {
      ipc.emit(nativeSettingsOverlayEventChannel, layerSource, 'first', value);
    },
    reply(request: { requestId: string }, value: unknown, foreign = false) {
      ipc.emit(
        nativeSettingsReplyChannel,
        foreign ? layerSource : rootSource,
        'first',
        request.requestId,
        value,
      );
    },
    close(id = 'first') {
      ipc.emit(nativeSettingsCloseChannel, rootSource, id);
    },
    actions: () => root.webContents.sent(nativeSettingsActionChannel),
  };
}

test('settings reserve full-window native hit testing without moving browser documents or Office, and survive temporary window loss', () => {
  const f = fixture();
  try {
    const b = f.browser.bounds;
    const o = f.preview.bounds;
    f.open();
    f.ready();
    expect(f.layer.webContents.sent(nativeSettingsStateChannel)).toEqual([
      { ...state, theme: 'dark' },
    ]);
    const shield = new Surface('file:///kite/shield.html');
    addNativeWindowView(
      f.window as unknown as NativeRootWindow,
      shield as unknown as WebContentsView,
    );
    expect(f.window.contentView.children.at(-1)).toBe(f.layer);
    expect(f.layer.bounds).toEqual({ x: 0, y: 0, width: 1000, height: 800 });
    f.window.emit('blur');
    f.window.emit('hide');
    f.window.emit('minimize');
    expect(f.host.active()).toBeTrue();
    expect(f.browser.visible).toBeTrue();
    expect(f.preview.visible).toBeTrue();
    expect(f.browser.bounds).toBe(b);
    expect(f.preview.bounds).toBe(o);
    let blocked = 0;
    const event = { preventDefault: () => blocked++ };
    f.browser.webContents.emit('before-mouse-event', event);
    expect(blocked).toBe(0);
    f.root.webContents.emit('before-input-event', event);
    expect(blocked).toBe(1);
    f.intent({ type: 'close' });
    expect(f.actions().at(-1)).toEqual({ type: 'close', instanceId: 'first' });
    f.close('wrong');
    expect(f.host.active()).toBeTrue();
    f.close();
    expect(f.host.active()).toBeFalse();
    expect(f.root.webContents.sent(nativeSettingsActiveChannel)).toEqual([true, false]);
    f.open(state, false);
    expect(f.host.active()).toBeFalse();
  } finally {
    f.host.dispose();
  }
});

test('only the admitted exact frame and instance relay allowlisted settings calls; ownership survives a higher approval', async () => {
  const f = fixture();
  try {
    f.open();
    f.ready();
    const read = { method: 'settings.providers.read', generation: 12 };
    const unavailable = { ok: false, code: 'native_settings_unavailable' };
    const notDispatched = { ok: false, code: 'native_settings_not_dispatched' };
    for (const origin of ['root', 'child'] as const)
      expect(f.request(read, origin)).toEqual(notDispatched);
    expect(f.request(read, 'layer', 'wrong')).toEqual(notDispatched);
    expect(f.request({ ...read, generation: 99 })).toEqual(notDispatched);
    expect(f.request({ method: 'conversation.send', generation: 12 })).toEqual(notDispatched);
    expect(
      f.request({
        method: 'webSearch.settings.test',
        generation: 12,
        expectedStoreId: 'store',
        sessionId: 'wrong',
      }),
    ).toEqual(notDispatched);
    expect(f.actions()).toEqual([]);
    const response = f.request(read);
    const action = f.actions()[0] as { requestId: string };
    expect(f.actions()[0]).toMatchObject({ type: 'request', instanceId: 'first', request: read });
    f.reply(action, { ok: true, value: null }, true);
    f.preempt(true);
    expect(f.request(read)).toEqual(notDispatched);
    f.intent({ type: 'close' });
    expect(f.actions()).toHaveLength(1);
    f.reply(action, { ok: true, value: { kind: 'settings.providers', storeId: 'store' } });
    expect(await response).toEqual({
      ok: true,
      value: { kind: 'settings.providers', storeId: 'store' },
    });
    f.preempt(false);
    const next = f.request(read);
    f.root.webContents.emit('did-start-navigation', { isMainFrame: true });
    expect(await next).toEqual(unavailable);
    expect(f.host.active()).toBeFalse();
    expect(f.actions().at(-1)).toEqual({ instanceId: 'first', type: 'retired' });
  } finally {
    f.host.dispose();
  }
});

test('settings projection drops other stores, raw MCP add secrets and arbitrary application state', () => {
  const raw = {
    kind: 'settings.userMcp.submission',
    commandId: 'one',
    storeId: 'store',
    operation: {
      kind: 'add',
      name: 'example',
      entry: {
        type: 'http',
        url: 'https://example.test/?value=private',
        headers: { Authorization: 'fake fixture value' },
      },
    },
    phase: 'pending',
    association: 'current',
  } satisfies NativeUserMcpSubmission;
  const input = { ...state, userMcpSubmissions: [raw, { ...raw, storeId: 'other' }] };
  expect(isNativeSettingsRequest({ method: 'store.backup', generation: 12 })).toBeFalse();
  expect(isNativeSettingsState(input)).toBeFalse();
  const projected = projectNativeSettingsState(input);
  expect(isNativeSettingsState(projected)).toBeTrue();
  expect(projected.userMcpSubmissions).toHaveLength(1);
  expect(JSON.stringify(projected)).not.toMatch(/private|fake fixture value|Authorization/);
  expect(isNativeSettingsReply({ ok: true, value: raw })).toBeFalse();
  const safe = projectNativeSettingsReply({ ok: true, value: raw });
  expect(isNativeSettingsReply(safe)).toBeTrue();
  expect(JSON.stringify(safe)).not.toMatch(/private|fake fixture value|Authorization/);
  const recovery = {
    generation: 12,
    directory: { storeId: 'store', workspaces: [], sessions: [] },
    creationSubmissions: [],
    inputSubmissions: [],
    permissionSubmissions: [],
    interactionSubmissions: [],
  };
  expect(isNativeSettingsReply({ ok: true, value: recovery })).toBeTrue();
  expect(
    isNativeSettingsReply({
      ok: true,
      value: { ...recovery, directory: { ...recovery.directory, sessions: ['transcript'] } },
    }),
  ).toBeFalse();
  expect(isNativeSettingsReply({ ok: true, value: { ...recovery, historyEpoch: 9 } })).toBeFalse();
});
