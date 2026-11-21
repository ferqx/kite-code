import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { createNativeDraftFlush } from '../../electron/native-draft-flush';
import { assertNativeSender } from '../../electron/native-ipc';
import type { NativeBridge } from '../../src/native-bridge';
import {
  nativeDraftFlushChannel,
  nativeDraftFlushReadyChannel,
  nativeDraftFlushReplyChannel,
} from '../../src/native-draft-flush-bridge';

function host() {
  const ipc = new EventEmitter();
  const sent: unknown[][] = [];
  const frame = { url: pathToFileURL(resolve('app', 'renderer.html')).href };
  const sender = {
    mainFrame: frame,
    isDestroyed: () => false,
    send: (...v: unknown[]) => sent.push(v),
  };
  const event = { sender, senderFrame: frame };
  const window = { webContents: sender, isDestroyed: () => false };
  const flush = createNativeDraftFlush({
    ipcMain: ipc as never,
    window: () => window as never,
    assertSender: (event) => assertNativeSender(event, window as never, frame.url),
  });
  return { ipc, sent, event, sender, frame, flush };
}
test('draft quit barrier admits only the exact Root, frame and nonce and waits for save acknowledgement', async () => {
  const f = host();
  try {
    expect(f.flush.required()).toBe(false);
    expect(await f.flush.flush()).toBe(true);
    f.ipc.emit(nativeDraftFlushReadyChannel, { ...f.event, senderFrame: {} }, true);
    expect(f.flush.required()).toBe(false);
    f.ipc.emit(nativeDraftFlushReadyChannel, f.event, true);
    let result: boolean | undefined;
    const pending = f.flush.flush().then((value) => {
      result = value;
    });
    const nonce = f.sent[0]![1];
    expect(f.sent[0]![0]).toBe(nativeDraftFlushChannel);
    for (const [event, reply] of [
      [
        { ...f.event, senderFrame: {} },
        { nonce, saved: true },
      ],
      [f.event, { nonce: 'old', saved: true }],
      [f.event, { nonce, saved: true, content: 'extra authority' }],
    ])
      f.ipc.emit(nativeDraftFlushReplyChannel, event, reply);
    await Promise.resolve();
    expect(result).toBeUndefined();
    f.ipc.emit(nativeDraftFlushReplyChannel, f.event, { nonce, saved: true });
    await pending;
    expect(result).toBe(true);
    expect(f.sent).toHaveLength(1);
  } finally {
    f.flush.close();
  }
});
test('failed or missing draft ACK does not grant quit; retry ignores the old nonce', async () => {
  const f = host();
  try {
    f.ipc.emit(nativeDraftFlushReadyChannel, f.event, true);
    const first = f.flush.flush();
    const old = f.sent[0]![1];
    f.ipc.emit(nativeDraftFlushReplyChannel, f.event, { nonce: old, saved: false });
    expect(await first).toBe(false);
    f.flush.release();
    expect(f.sent.at(-1)).toEqual([nativeDraftFlushChannel, null]);
    const retry = f.flush.flush();
    f.ipc.emit(nativeDraftFlushReplyChannel, f.event, { nonce: old, saved: true });
    expect(await retry).toBe(false);
    expect(f.sent).toHaveLength(3);
  } finally {
    f.flush.close();
  }
}, 10000);
test('Root preload keeps input inert through ACK until explicit cancellation and reports save errors without text', async () => {
  const build = await Bun.build({
    entrypoints: [fileURLToPath(new URL('../../electron/preload.ts', import.meta.url))],
    target: 'node',
    format: 'cjs',
    external: ['electron'],
  });
  expect(build.success).toBe(true);
  const ipc = new EventEmitter();
  const sent: unknown[][] = [];
  const root = { inert: false };
  let bridge!: NativeBridge;
  Object.assign(ipc, { send: (...v: unknown[]) => sent.push(v) });
  runInNewContext(await build.outputs[0]!.text(), {
    exports: {},
    module: { exports: {} },
    document: { getElementById: () => root },
    require: () => ({
      ipcRenderer: ipc,
      webUtils: {},
      contextBridge: {
        exposeInMainWorld(name: string, value: NativeBridge) {
          if (name === 'kiteNative') bridge = value;
        },
      },
    }),
  });
  let calls = 0;
  let complete!: () => void;
  const stop = bridge.registerDraftFlush!(() => {
    calls++;
    return new Promise<void>((r) => {
      complete = r;
    });
  });
  const nonce = '11111111-1111-1111-1111-111111111111';
  ipc.emit(nativeDraftFlushChannel, {}, { nonce });
  expect(calls).toBe(0);
  ipc.emit(nativeDraftFlushChannel, {}, nonce);
  expect(root.inert).toBe(true);
  await Promise.resolve();
  expect(calls).toBe(1);
  ipc.emit(nativeDraftFlushChannel, {}, nonce);
  expect(calls).toBe(1);
  complete();
  await new Promise((r) => setTimeout(r, 0));
  expect(sent.at(-1)).toEqual([nativeDraftFlushReplyChannel, { nonce, saved: true }]);
  expect(root.inert).toBe(true);
  ipc.emit(nativeDraftFlushChannel, {}, null);
  expect(root.inert).toBe(false);
  stop();
  expect(ipc.listenerCount(nativeDraftFlushChannel)).toBe(0);
  const stopFailed = bridge.registerDraftFlush!(() => {
    throw Error('private draft text');
  });
  ipc.emit(nativeDraftFlushChannel, {}, nonce);
  await new Promise((r) => setTimeout(r, 0));
  expect(sent.at(-1)).toEqual([nativeDraftFlushReplyChannel, { nonce, saved: false }]);
  stopFailed();
  expect(root.inert).toBe(false);
});

test('IPC quit fence rejects both new and already-admitting business requests but keeps local draft writes available', async () => {
  const { registerNativeIpc } = await import('../../electron/native-ipc');
  const { nativeChannel } = await import('../../src/native-bridge');
  const f = host();
  let flushing = false;
  let release!: () => void;
  const admitted = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: string[] = [];
  const handlers = new Map<string, (event: unknown, input: unknown) => Promise<unknown>>();
  const unregister = registerNativeIpc({
    ipcMain: {
      handle: (channel: string, handler: (event: unknown, input: unknown) => Promise<unknown>) =>
        handlers.set(channel, handler),
      removeHandler: (channel: string) => handlers.delete(channel),
    } as never,
    window: () => ({ webContents: f.sender, isDestroyed: () => false }) as never,
    rendererUrl: f.frame.url,
    assertRequestAllowed(request) {
      if (flushing && request.method !== 'draft.write') throw Error('native_draining');
    },
    caller: async () => {
      await admitted;
      return {
        async invoke(request: { method: string }) {
          calls.push(request.method);
          return null;
        },
      } as never;
    },
  });
  try {
    const request = handlers.get(nativeChannel)!;
    const inFlight = request(f.event, { method: 'attach' });
    flushing = true;
    release();
    expect(await inFlight).toEqual({ ok: false, code: 'native_draining' });
    expect(await request(f.event, { method: 'attach' })).toEqual({
      ok: false,
      code: 'native_draining',
    });
    expect(
      await request(f.event, {
        method: 'draft.write',
        generation: 1,
        sessionId: 'a',
        revision: 0,
        content: 'draft',
      }),
    ).toEqual({ ok: true, value: null });
    expect(calls).toEqual(['draft.write']);
    flushing = false;
    expect(await request(f.event, { method: 'attach' })).toEqual({ ok: true, value: null });
    expect(calls).toEqual(['draft.write', 'attach']);
  } finally {
    unregister();
    f.flush.close();
  }
});
