import { expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { registerNativeIpc, registerNativeWindowIpc } from '../electron/native-ipc';
import {
  type NativeReply,
  nativeChannel,
  nativeClipboardChannel,
  nativeWindowMaximizeChannel,
} from '../src/native-bridge';

type Handler = (event: IpcMainInvokeEvent, payload: unknown) => NativeReply | Promise<NativeReply>;

function fixture(rendererUrl = pathToFileURL(join(tmpdir(), 'kite-native-ipc/index.html')).href) {
  const frame = { url: rendererUrl },
    contents = { mainFrame: frame },
    copied: string[] = [],
    zooms: boolean[] = [];
  let maximized = false,
    destroyed = false,
    callerOpens = 0,
    fail = false;
  const zoom = (value: boolean) => {
    if (fail) throw Error('unrelated OS details /private/original');
    maximized = value;
    zooms.push(value);
  };
  const window = {
      webContents: contents,
      isDestroyed: () => destroyed,
      isMaximized: () => maximized,
      maximize: () => zoom(true),
      unmaximize: () => zoom(false),
    } as unknown as BrowserWindow,
    event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent,
    handlers = new Map<string, Handler>(),
    ipcMain = {
      handle(channel: string, handler: Handler) {
        handlers.set(channel, handler);
      },
      removeHandler(channel: string) {
        handlers.delete(channel);
      },
    } as unknown as IpcMain;
  registerNativeIpc({
    ipcMain,
    window: () => window,
    rendererUrl: frame.url,
    caller: async () => {
      callerOpens++;
      throw Error('native_connection_unavailable');
    },
  });
  const close = registerNativeWindowIpc({
    ipcMain,
    window: () => window,
    rendererUrl: frame.url,
    writeClipboardText: (text) => {
      if (fail) throw Error('unrelated OS details /private/original');
      copied.push(text);
    },
  });
  return {
    rendererUrl,
    frame,
    event,
    copied,
    zooms,
    handlers,
    close,
    destroy: () => {
      destroyed = true;
    },
    fail: () => {
      fail = true;
    },
    get callerOpens() {
      return callerOpens;
    },
    send: (channel: string, payload?: unknown, sender = event) =>
      handlers.get(channel)!(sender, payload),
  };
}

test('original text and both zoom states use only the current window host, even after a Service attach failure', async () => {
  const f = fixture(),
    text = '完整原文\r\n雪🙂\n';
  expect(await f.send(nativeClipboardChannel, { text })).toEqual({ ok: true, value: null });
  expect(await f.send(nativeWindowMaximizeChannel)).toEqual({ ok: true, value: null });
  expect(await f.send(nativeWindowMaximizeChannel)).toEqual({ ok: true, value: null });
  expect(f.copied).toEqual([text]);
  expect(f.zooms).toEqual([true, false]);
  expect(f.callerOpens).toBe(0);
  expect(await f.send(nativeChannel, { method: 'attach' })).toEqual({
    ok: false,
    code: 'native_connection_unavailable',
  });
  expect(await f.send(nativeClipboardChannel, { text: '' })).toEqual({ ok: true, value: null });
  expect(f.copied).toEqual([text, '']);
  expect(f.callerOpens).toBe(1);
  f.close();
  expect(f.handlers.has(nativeClipboardChannel)).toBe(false);
  expect(f.handlers.has(nativeWindowMaximizeChannel)).toBe(false);
  expect(f.handlers.has(nativeChannel)).toBe(true);
});

test('development HTTP renderer retains exact main-frame, origin and document scope for window operations', async () => {
  const f = fixture('http://127.0.0.1:43219/');
  expect(await f.send(nativeClipboardChannel, { text: 'development' })).toEqual({
    ok: true,
    value: null,
  });
  for (const url of [
    'http://127.0.0.1:43220/',
    'http://localhost:43219/',
    'http://127.0.0.1:43219/foreign',
  ]) {
    f.frame.url = url;
    expect(await f.send(nativeClipboardChannel, { text: 'foreign' })).toEqual({
      ok: false,
      code: 'native_sender_denied',
    });
  }
  expect(f.copied).toEqual(['development']);
});

test('original 1 MiB UTF-8 clipboard boundary and closed payloads reject without truncation or host effects', async () => {
  const f = fixture(),
    atLimit = '🙂'.repeat(262144);
  expect(await f.send(nativeClipboardChannel, { text: atLimit })).toEqual({
    ok: true,
    value: null,
  });
  expect(f.copied).toEqual([atLimit]);
  for (const text of [`${atLimit}a`, '雪'.repeat(349526), undefined, 1])
    expect(await f.send(nativeClipboardChannel, { text })).toEqual({
      ok: false,
      code: 'invalid_native_clipboard_text',
    });
  for (const payload of [null, [], { text: 'original', path: '/unrelated' }])
    expect(await f.send(nativeClipboardChannel, payload)).toEqual({
      ok: false,
      code: 'invalid_native_request',
    });
  for (const payload of [null, {}, 2])
    expect(await f.send(nativeWindowMaximizeChannel, payload)).toEqual({
      ok: false,
      code: 'invalid_native_request',
    });
  expect(f.copied).toEqual([atLimit]);
  expect(f.zooms).toEqual([]);
  expect(f.callerOpens).toBe(0);
});

test('foreign documents, subframes and closed windows cannot act; OS failures return safe failure replies', async () => {
  const f = fixture();
  const denied = async (sender = f.event) => {
    expect(await f.send(nativeClipboardChannel, { text: 'original' }, sender)).toEqual({
      ok: false,
      code: 'native_sender_denied',
    });
    expect(await f.send(nativeWindowMaximizeChannel, undefined, sender)).toEqual({
      ok: false,
      code: 'native_sender_denied',
    });
  };
  await denied({ ...f.event, senderFrame: { url: f.frame.url } } as IpcMainInvokeEvent);
  f.frame.url = pathToFileURL(join(tmpdir(), 'foreign.html')).href;
  await denied();
  f.frame.url = f.rendererUrl;
  f.fail();
  expect(await f.send(nativeClipboardChannel, { text: 'original' })).toEqual({
    ok: false,
    code: 'native_clipboard_failed',
  });
  expect(await f.send(nativeWindowMaximizeChannel)).toEqual({
    ok: false,
    code: 'native_window_failed',
  });
  f.destroy();
  await denied();
  expect(f.copied).toEqual([]);
  expect(f.zooms).toEqual([]);
  expect(f.callerOpens).toBe(0);
});
