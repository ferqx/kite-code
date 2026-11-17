import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { createNativeImageDisplayHost } from '../../electron/image-display-host';
import type { ImageDisplayInput } from '../../electron/image-display-service';
import type { NativeRootWindow } from '../../electron/native-root-window';
import {
  type NativeImageDisplayReply,
  type NativeImageDisplayResult,
  nativeImageDisplayCancelChannel,
  nativeImageDisplayChannel,
} from '../../src/native-image-display-bridge';

class Ipc extends EventEmitter {
  handlers = new Map<
    string,
    (event: IpcMainInvokeEvent, input: unknown) => Promise<NativeImageDisplayReply>
  >();
  handle(
    channel: string,
    handler: (event: IpcMainInvokeEvent, input: unknown) => Promise<NativeImageDisplayReply>,
  ) {
    if (this.handlers.has(channel)) throw Error('duplicate_handler');
    this.handlers.set(channel, handler);
  }
  removeHandler(channel: string) {
    this.handlers.delete(channel);
  }
}
function fixture(ipc = new Ipc()) {
  const rootUrl = 'file:///app/index.html';
  const root = Object.assign(new EventEmitter(), {
    mainFrame: { url: rootUrl },
    isDestroyed: () => false,
  });
  const window = Object.assign(new EventEmitter(), { webContents: root, isDestroyed: () => false });
  const pending: {
    input: ImageDisplayInput;
    resolve(value: NativeImageDisplayResult): void;
    reject(reason: unknown): void;
  }[] = [];
  const host = createNativeImageDisplayHost({
    window: window as unknown as NativeRootWindow,
    ipcMain: ipc as unknown as IpcMain,
    rootUrl,
    render(input) {
      return new Promise((resolve, reject) => pending.push({ input, resolve, reject }));
    },
  });
  const event = { sender: root, senderFrame: root.mainFrame } as unknown as IpcMainInvokeEvent;
  return {
    host,
    ipc,
    root,
    window,
    pending,
    event,
    render: (input: unknown, sender = event) =>
      ipc.handlers.get(nativeImageDisplayChannel)!(sender, input),
  };
}
const request = (id = 'one') => ({
  id,
  bytes: new Uint8Array([1, 2]),
  mediaType: 'image/png',
  edge: 512,
});
const result: NativeImageDisplayResult = {
  bytes: new Uint8Array([1]),
  mimeType: 'image/webp',
  width: 1,
  height: 1,
  sourceWidth: 1,
  sourceHeight: 1,
  animated: false,
  frame: 'static',
};

test('host admits only exact Root mainFrame URL and byte-only request, never paths URLs tokens or arbitrary options', async () => {
  const f = fixture();
  for (const event of [
    { sender: {}, senderFrame: f.root.mainFrame },
    { sender: f.root, senderFrame: { url: f.root.mainFrame.url } },
    { sender: f.root, senderFrame: null },
  ]) {
    expect(await f.render(request(), event as IpcMainInvokeEvent)).toMatchObject({ ok: false });
  }
  f.root.mainFrame.url = 'file:///app/foreign.html';
  expect(await f.render(request())).toMatchObject({ ok: false });
  f.root.mainFrame.url = 'file:///app/index.html#section';
  for (const input of [
    { ...request(), path: '/secret' },
    { ...request(), source: { path: '/secret' } },
    { ...request(), url: 'https://example.com' },
    { ...request(), token: 'secret' },
    { ...request(), edge: 65536 },
    { ...request(), mediaType: 'image/svg+xml' },
    { ...request(), bytes: [1, 2] },
    { ...request(), bytes: new Uint16Array([1]) },
    { ...request(), id: '../bad' },
  ]) {
    expect(await f.render(input)).toEqual({ ok: false, code: 'native_image_display_invalid' });
  }
  expect(f.pending).toHaveLength(0);
  const active = f.render(request());
  expect(f.pending).toHaveLength(1);
  expect(f.pending[0]!.input.source).toEqual({ bytes: request().bytes });
  f.pending[0]!.resolve(result);
  expect(await active).toEqual({ ok: true, value: result });
  f.host.dispose();
});

test('multiple Root hosts share one dispatcher; cancellation, duplicate IDs and disposal are sender scoped', async () => {
  const a = fixture(),
    b = fixture(a.ipc);
  const one = a.render(request()),
    two = b.render(request());
  expect(a.pending).toHaveLength(1);
  expect(b.pending).toHaveLength(1);
  expect(await a.render(request())).toEqual({ ok: false, code: 'native_image_display_invalid' });
  a.ipc.emit(nativeImageDisplayCancelChannel, { sender: {}, senderFrame: a.root.mainFrame }, 'one');
  a.ipc.emit(
    nativeImageDisplayCancelChannel,
    { sender: a.root, senderFrame: { url: a.root.mainFrame.url } },
    'one',
  );
  expect(a.pending[0]!.input.signal.aborted).toBe(false);
  a.ipc.emit(nativeImageDisplayCancelChannel, a.event, 'one');
  expect(a.pending[0]!.input.signal.aborted).toBe(true);
  expect(b.pending[0]!.input.signal.aborted).toBe(false);
  a.host.dispose();
  expect(a.ipc.handlers.size).toBe(1);
  a.pending[0]!.resolve(result);
  b.pending[0]!.resolve(result);
  expect(await one).toEqual({ ok: false, code: 'native_image_display_cancelled' });
  expect(await two).toEqual({ ok: true, value: result });
  const next = b.render(request('next'));
  b.pending[1]!.resolve(result);
  expect((await next).ok).toBe(true);
  b.host.dispose();
  expect(a.ipc.handlers.size).toBe(0);
  expect(a.ipc.listenerCount(nativeImageDisplayCancelChannel)).toBe(0);
});

test('navigation, renderer crash and window disposal retire in-flight bytes and cannot admit late success', async () => {
  for (const reason of ['navigation', 'crash', 'closed'] as const) {
    const f = fixture(),
      pending = f.render(request());
    if (reason === 'navigation')
      f.root.emit('did-start-navigation', {}, 'file:///app/index.html', false, true);
    if (reason === 'crash') f.root.emit('render-process-gone', {});
    if (reason === 'closed') f.window.emit('closed');
    expect(f.pending[0]!.input.signal.aborted).toBe(true);
    f.pending[0]!.resolve(result);
    expect(await pending).toEqual({ ok: false, code: 'native_image_display_cancelled' });
    f.host.dispose();
  }
});

test('host bounds outstanding requests and sanitizes decoder error messages', async () => {
  const f = fixture();
  const pending = Array.from({ length: 9 }, (_, i) => f.render(request(String(i))));
  expect(await f.render(request('overflow'))).toEqual({
    ok: false,
    code: 'native_image_display_queue_full',
  });
  f.pending[0]!.reject(Error('/private/secret native stack'));
  expect(await pending[0]).toEqual({ ok: false, code: 'native_image_display_decode_failed' });
  for (const entry of f.pending.slice(1)) entry.resolve(result);
  await Promise.all(pending);
  f.host.dispose();
});

test('Root ROI DTO is strict and forwards only the original-pixel rectangle to the decoder', async () => {
  const f = fixture(),
    region = { left: 20, top: 10, width: 32, height: 16 };
  for (const invalid of [
    { ...request(), region: { ...region, left: -1 } },
    { ...request(), region: { ...region, width: 0 } },
    { ...request(), region: { ...region, top: 0.5 } },
    { ...request(), region: { ...region, url: 'file:///secret' } },
    { ...request(), region: null },
    { ...request(), region: undefined },
    { ...request(), region, edge: 4096 },
  ])
    expect(await f.render(invalid)).toEqual({ ok: false, code: 'native_image_display_invalid' });
  expect(f.pending).toHaveLength(0);
  const pending = f.render({ ...request(), region });
  expect(f.pending[0]!.input.region).toEqual(region);
  const value = { ...result, width: 32, height: 16, sourceWidth: 96, sourceHeight: 48, region };
  f.pending[0]!.resolve(value);
  expect(await pending).toEqual({ ok: true, value });
  f.host.dispose();
});
