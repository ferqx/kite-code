import { randomUUID } from 'node:crypto';
import type { IpcMain, IpcMainEvent, WebFrameMain } from 'electron';
import {
  nativeDraftFlushChannel,
  nativeDraftFlushReadyChannel,
  nativeDraftFlushReplyChannel,
} from '../src/native-draft-flush-bridge';
import type { NativeRootWindow } from './native-root-window';

/** A bounded save barrier before quit. Failure cancels quit, never retries business work. */
export function createNativeDraftFlush(options: {
  ipcMain: IpcMain;
  window: () => NativeRootWindow | undefined;
  assertSender: (event: IpcMainEvent) => void;
}) {
  let ready: WebFrameMain | undefined;
  let registered = false;
  let pending: { nonce: string; frame: WebFrameMain; finish: (saved: boolean) => void } | undefined;
  const admitted = (event: IpcMainEvent) => {
    try {
      options.assertSender(event);
      return true;
    } catch {
      return false;
    }
  };
  const onReady = (event: IpcMainEvent, value: unknown) => {
    if (!admitted(event) || typeof value !== 'boolean') return;
    registered = true;
    ready = value ? (event.senderFrame ?? undefined) : undefined;
    if (!value && pending?.frame === event.senderFrame) pending.finish(false);
  };
  const onReply = (event: IpcMainEvent, value: unknown) => {
    if (!admitted(event) || !pending || event.senderFrame !== pending.frame) return;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const reply = value as Record<string, unknown>;
    if (
      Object.keys(reply).sort().join(',') !== 'nonce,saved' ||
      reply.nonce !== pending.nonce ||
      typeof reply.saved !== 'boolean'
    )
      return;
    pending.finish(reply.saved);
  };
  options.ipcMain.on(nativeDraftFlushReadyChannel, onReady);
  options.ipcMain.on(nativeDraftFlushReplyChannel, onReply);
  return {
    required: () => registered,
    flush(): Promise<boolean> {
      const window = options.window();
      if (!registered) return Promise.resolve(true);
      if (
        pending ||
        !window ||
        window.isDestroyed() ||
        window.webContents.isDestroyed() ||
        !ready ||
        ready !== window.webContents.mainFrame
      )
        return Promise.resolve(false);
      const frame = ready;
      return new Promise((resolve) => {
        const nonce = randomUUID();
        const timer = setTimeout(() => finish(false), 5000);
        const finish = (saved: boolean) => {
          if (pending?.nonce !== nonce) return;
          pending = undefined;
          clearTimeout(timer);
          resolve(saved);
        };
        pending = { nonce, frame, finish };
        try {
          window.webContents.send(nativeDraftFlushChannel, nonce);
        } catch {
          finish(false);
        }
      });
    },
    release() {
      const window = options.window();
      try {
        if (window && !window.isDestroyed() && !window.webContents.isDestroyed())
          window.webContents.send(nativeDraftFlushChannel, null);
      } catch {
        // A renderer lost during cancellation cannot receive the release.
      }
    },
    close() {
      ready = undefined;
      pending?.finish(false);
      options.ipcMain.off(nativeDraftFlushReadyChannel, onReady);
      options.ipcMain.off(nativeDraftFlushReplyChannel, onReply);
    },
  };
}
