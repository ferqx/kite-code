import { expect, test } from 'bun:test';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { registerNativeIpc, registerNativeThemeIpc } from '../electron/native-ipc';
import {
  decodeNativeEvent,
  type NativeReply,
  type NativeThemePreference,
  nativeChannel,
  nativeThemeChannel,
} from '../src/native-bridge';

type Handler = (event: IpcMainInvokeEvent, payload: unknown) => NativeReply | Promise<NativeReply>;

function fixture() {
  const frame = { url: 'file:///private/tmp/native/index.html' },
    contents = { mainFrame: frame };
  let destroyed = false,
    callerOpens = 0;
  const window = {
      webContents: contents,
      isDestroyed: () => destroyed,
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
    } as unknown as IpcMain,
    preferences: NativeThemePreference[] = [];
  registerNativeIpc({
    ipcMain,
    window: () => window,
    rendererUrl: frame.url,
    caller: async () => {
      callerOpens++;
      throw Error('native_connection_unavailable');
    },
  });
  const close = registerNativeThemeIpc({
    ipcMain,
    window: () => window,
    rendererUrl: frame.url,
    setTheme: (theme) => preferences.push(theme),
  });
  return {
    frame,
    event,
    preferences,
    handlers,
    close,
    destroy: () => {
      destroyed = true;
    },
    get callerOpens() {
      return callerOpens;
    },
    send: (payload: unknown, sender = event) => handlers.get(nativeThemeChannel)!(sender, payload),
  };
}

test('original three theme values use only the current window host; a failed Service connection does not block appearance', async () => {
  const f = fixture();
  for (const theme of ['dark', 'light', 'system'])
    expect(await f.send({ theme })).toEqual({ ok: true, value: null });
  expect(f.preferences).toEqual(['dark', 'light', 'system']);
  expect(f.callerOpens).toBe(0);
  expect(await f.handlers.get(nativeChannel)!(f.event, { method: 'attach' })).toEqual({
    ok: false,
    code: 'native_connection_unavailable',
  });
  expect(await f.send({ theme: 'light' })).toEqual({ ok: true, value: null });
  expect(f.preferences).toEqual(['dark', 'light', 'system', 'light']);
  expect(f.callerOpens).toBe(1);
  f.close();
  expect(f.handlers.has(nativeThemeChannel)).toBe(false);
  expect(f.handlers.has(nativeChannel)).toBe(true);
});

test('closed theme payload and original frame authority reject unsupported values, extra fields, foreign frames and a destroyed window before changing appearance', async () => {
  const f = fixture();
  for (const payload of [null, [], { theme: 'dark', token: 'hidden' }])
    expect(await f.send(payload)).toEqual({ ok: false, code: 'invalid_native_request' });
  for (const theme of [undefined, 'auto', 'DARK', 1, { value: 'light' }])
    expect(await f.send({ theme })).toEqual({ ok: false, code: 'invalid_native_theme' });
  expect(
    await f.send({ theme: 'dark' }, {
      ...f.event,
      senderFrame: { url: f.frame.url },
    } as IpcMainInvokeEvent),
  ).toEqual({ ok: false, code: 'native_sender_denied' });
  f.frame.url = 'file:///private/tmp/foreign.html';
  expect(await f.send({ theme: 'dark' })).toEqual({ ok: false, code: 'native_sender_denied' });
  f.frame.url = 'file:///private/tmp/native/index.html';
  f.destroy();
  expect(await f.send({ theme: 'dark' })).toEqual({ ok: false, code: 'native_sender_denied' });
  expect(f.preferences).toEqual([]);
  expect(f.callerOpens).toBe(0);
});

test('preload forwards only the closed lifecycle notification and original validated change observation', () => {
  for (const phase of ['quitting', 'active'] as const)
    expect(decodeNativeEvent({ kind: 'lifecycle', phase })).toEqual({ kind: 'lifecycle', phase });
  expect(
    decodeNativeEvent({ kind: 'changed', generation: 3, ignored: 'original behavior' }),
  ).toEqual({
    kind: 'changed',
    generation: 3,
  });
  for (const value of [
    null,
    [],
    { kind: 'lifecycle' },
    { kind: 'lifecycle', phase: 'closed' },
    { kind: 'lifecycle', phase: 'quitting', generation: 3 },
    { kind: 'lifecycle', phase: 'active', authorized: true },
    { kind: 'changed', generation: -1 },
    { kind: 'changed', generation: 1.5 },
  ])
    expect(decodeNativeEvent(value)).toBeUndefined();
});

test('lifecycle-shaped payload grants no business IPC authority and foreign frames remain denied', async () => {
  const f = fixture(),
    payload = { kind: 'lifecycle', phase: 'active' };
  expect(await f.handlers.get(nativeChannel)!(f.event, payload)).toEqual({
    ok: false,
    code: 'invalid_native_request',
  });
  expect(
    await f.handlers.get(nativeChannel)!(
      {
        ...f.event,
        senderFrame: { url: f.frame.url },
      } as IpcMainInvokeEvent,
      payload,
    ),
  ).toEqual({ ok: false, code: 'native_sender_denied' });
  f.destroy();
  expect(await f.handlers.get(nativeChannel)!(f.event, payload)).toEqual({
    ok: false,
    code: 'native_sender_denied',
  });
  expect(f.callerOpens).toBe(0);
});
