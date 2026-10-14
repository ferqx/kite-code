import { expect, test } from 'bun:test';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import {
  nativeWindowMenuShortcut,
  nativeWindowMenuTemplate,
  registerNativeWindowMenuIpc,
} from '../electron/native-window-menu';
import type { NativeReply } from '../src/native-bridge';
import {
  type NativeWindowMenuAction,
  type NativeWindowMenuRequest,
  nativeWindowMenuChannel,
} from '../src/native-menu-bridge';

function fixture(platform = 'win32', rendererUrl = 'file:///C:/kite/index.html') {
  const frame = { url: rendererUrl },
    contents = { mainFrame: frame, getZoomFactor: () => 1.25 };
  const host = {
    isDestroyed: () => false,
    webContents: contents,
    getContentSize: () => [1100, 780],
  } as unknown as BrowserWindow;
  const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  const opened: NativeWindowMenuRequest[] = [];
  const handlers = new Map<
    string,
    (event: IpcMainInvokeEvent, payload: unknown) => Promise<NativeReply>
  >();
  let fail = false;
  const close = registerNativeWindowMenuIpc({
    ipcMain: {
      handle: (
        channel: string,
        handler: (event: IpcMainInvokeEvent, payload: unknown) => Promise<NativeReply>,
      ) => handlers.set(channel, handler),
      removeHandler: (channel: string) => handlers.delete(channel),
    } as unknown as IpcMain,
    window: () => host,
    rendererUrl,
    platform,
    showMenu: async (window, request) => {
      expect(window).toBe(host);
      if (fail) throw Error('OS details C:/private/file');
      opened.push(request);
    },
  });
  return {
    frame,
    contents,
    event,
    host,
    opened,
    handlers,
    close,
    fail: () => {
      fail = true;
    },
    send: (payload: unknown, sender = event) =>
      handlers.get(nativeWindowMenuChannel)!(sender, payload),
  };
}

const request: NativeWindowMenuRequest = { menu: 'file', x: 8, y: 32, applicationEnabled: true };

test('Windows menu anchors follow page zoom and work independently of Service readiness', async () => {
  const f = fixture();
  expect(await f.send(request)).toEqual({ ok: true, value: null });
  expect(await f.send({ ...request, menu: 'edit', applicationEnabled: false })).toEqual({
    ok: true,
    value: null,
  });
  expect(f.opened).toEqual([
    { ...request, x: 10, y: 40 },
    { ...request, menu: 'edit', applicationEnabled: false, x: 10, y: 40 },
  ]);
  f.close();
  expect(f.handlers.size).toBe(0);
});

test('file shortcuts accept one unmodified Ctrl keydown and reject repeats, composition and other modifiers', () => {
  const input = { type: 'keyDown', key: 'n', control: true } as import('electron').Input;
  expect(nativeWindowMenuShortcut(input)).toBe('new-conversation');
  expect(nativeWindowMenuShortcut({ ...input, key: 'O' })).toBe('add-workspace');
  expect(nativeWindowMenuShortcut({ ...input, key: ',' })).toBe('settings');
  for (const changed of [
    { type: 'keyUp' },
    { control: false },
    { shift: true },
    { alt: true },
    { meta: true },
    { isComposing: true },
    { isAutoRepeat: true },
    { key: 'q' },
  ])
    expect(nativeWindowMenuShortcut({ ...input, ...changed })).toBeUndefined();
});

test('foreign frames, documents, unsupported platforms and malformed menu payloads have zero host effects', async () => {
  const f = fixture();
  for (const payload of [
    undefined,
    null,
    [],
    {},
    { ...request, menu: 'execute' },
    { ...request, x: -1 },
    { ...request, x: 900 },
    { ...request, y: 700 },
    { ...request, x: 0.5 },
    { ...request, y: Infinity },
    { ...request, applicationEnabled: 'true' },
    { ...request, path: 'C:/outside' },
  ])
    expect(await f.send(payload)).toEqual({ ok: false, code: 'invalid_native_request' });
  expect(
    await f.send(request, { ...f.event, senderFrame: { url: f.frame.url } } as IpcMainInvokeEvent),
  ).toEqual({ ok: false, code: 'native_sender_denied' });
  expect(await f.send(request, { ...f.event, sender: {} } as IpcMainInvokeEvent)).toEqual({
    ok: false,
    code: 'native_sender_denied',
  });
  f.frame.url = 'file:///C:/foreign/index.html';
  expect(await f.send(request)).toEqual({ ok: false, code: 'native_sender_denied' });
  expect(f.opened).toEqual([]);
  const linux = fixture('linux');
  expect(await linux.send(request)).toEqual({ ok: false, code: 'native_window_menu_unavailable' });
  expect(linux.opened).toEqual([]);
});

test('development menus retain exact origin and document checks; OS failures stay private', async () => {
  const f = fixture('win32', 'http://127.0.0.1:43219/');
  expect(await f.send(request)).toEqual({ ok: true, value: null });
  for (const url of [
    'http://127.0.0.1:43220/',
    'http://localhost:43219/',
    'http://127.0.0.1:43219/foreign',
  ]) {
    f.frame.url = url;
    expect(await f.send(request)).toEqual({ ok: false, code: 'native_sender_denied' });
  }
  f.frame.url = 'http://127.0.0.1:43219/';
  f.fail();
  expect(await f.send(request)).toEqual({ ok: false, code: 'native_window_menu_failed' });
  expect(f.opened).toHaveLength(1);
});

test('file actions use existing application entry points while close and quit remain native roles', () => {
  const actions: NativeWindowMenuAction[] = [];
  const template = nativeWindowMenuTemplate({
    applicationEnabled: true,
    dispatch: (action) => actions.push(action),
  });
  const file = template[0]!.submenu as import('electron').MenuItemConstructorOptions[];
  for (const item of file.slice(0, 3))
    item.click!(undefined as never, undefined, undefined as never);
  expect(actions).toEqual(['new-conversation', 'add-workspace', 'settings']);
  expect(file.slice(-2).map((item) => item.role)).toEqual(['close', 'quit']);
  const loading = nativeWindowMenuTemplate({ applicationEnabled: false, dispatch: () => {} });
  expect(
    (loading[0]!.submenu as import('electron').MenuItemConstructorOptions[])
      .slice(0, 3)
      .every((item) => item.enabled === false),
  ).toBe(true);
});
