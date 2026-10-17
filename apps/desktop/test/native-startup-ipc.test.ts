import { expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { registerNativeStartupIpc } from '../electron/native-ipc';
import {
  type NativeStartupReply,
  nativeStartupDiagnosticSaveChannel as save,
  nativeStartupStatusChannel as status,
} from '../src/native-bridge';

test('startup save has no renderer path/body; capture, cancellation and late frame/report changes bound its host effects', async () => {
  type Handler = (
    event: IpcMainInvokeEvent,
    payload?: unknown,
  ) => NativeStartupReply | Promise<NativeStartupReply>;
  const rendererUrl = pathToFileURL(join(tmpdir(), 'own', 'index.html')).href;
  const handlers = new Map<string, Handler>(),
    frame = { url: rendererUrl },
    contents = { mainFrame: frame },
    window = { webContents: contents, isDestroyed: () => false } as unknown as BrowserWindow,
    event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent,
    writes: [string, string][] = [];
  let report: string | null = null,
    picks = 0,
    path: string | null = null,
    pending: Promise<string | null> | undefined;
  const close = registerNativeStartupIpc({
    ipcMain: {
      handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
      removeHandler: (channel: string) => handlers.delete(channel),
    } as unknown as IpcMain,
    window: () => window,
    rendererUrl: frame.url,
    report: () => report,
    pickPath: async () => {
      picks++;
      return pending ?? path;
    },
    write: async (target, content) => {
      writes.push([target, content]);
    },
  });
  const send = (channel: string, payload?: unknown, sender = event) =>
    handlers.get(channel)!(sender, payload);
  expect(await send(status)).toEqual({ ok: true, value: { diagnosticAvailable: false } });
  expect((await send(save)).ok).toBe(false);
  expect(picks).toBe(0);
  report = '{"schema":"kite.startup-diagnostic.v1"}\n';
  expect(await send(status)).toEqual({ ok: true, value: { diagnosticAvailable: true } });
  expect(await send(save)).toEqual({ ok: true, value: false });
  expect(writes).toEqual([]);
  for (const payload of [null, {}, { path: '/foreign', report: 'forged' }]) {
    expect((await send(save, payload)).ok).toBe(false);
    expect((await send(status, payload)).ok).toBe(false);
  }
  expect(
    (
      await send(save, undefined, {
        ...event,
        senderFrame: { url: frame.url },
      } as IpcMainInvokeEvent)
    ).ok,
  ).toBe(false);
  expect(picks).toBe(1);
  path = join(tmpdir(), 'selected', 'report.json');
  expect(await send(save)).toEqual({ ok: true, value: true });
  expect(writes).toEqual([[path, report]]);
  for (const changed of ['frame', 'report']) {
    let release!: (path: string) => void;
    pending = new Promise((resolve) => {
      release = resolve;
    });
    const saving = send(save);
    if (changed === 'frame') frame.url = pathToFileURL(join(tmpdir(), 'foreign.html')).href;
    else report = null;
    release(path);
    expect((await saving).ok).toBe(false);
    frame.url = rendererUrl;
  }
  expect(writes.length).toBe(1);
  close();
  expect(handlers.size).toBe(0);
});
