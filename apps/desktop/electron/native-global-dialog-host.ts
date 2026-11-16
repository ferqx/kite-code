import { randomUUID } from 'node:crypto';
import type { IpcMain, IpcMainEvent, WebContentsView } from 'electron';
import {
  type NativeGlobalDialogContent,
  type NativeGlobalDialogState,
  nativeGlobalDialogActiveChannel,
  nativeGlobalDialogEventChannel,
  nativeGlobalDialogStateChannel,
} from '../src/native-global-dialog-bridge';
import { createNativeModalSurface, nativeModalRecord } from './native-modal-surface';
import type { NativeRootWindow } from './native-root-window';

/** Fixed confirmation authority, presented by the shared transparent native modal surface. */
export function createNativeGlobalDialogHost(options: {
  window: NativeRootWindow;
  ipcMain: IpcMain;
  url: string;
  createView: () => WebContentsView;
  theme: () => 'light' | 'dark';
}) {
  let disposed = false;
  let pending:
    | {
        state: NonNullable<NativeGlobalDialogState>;
        presented: boolean;
        finish(confirmed: boolean, error?: Error): void;
      }
    | undefined;
  const cancel = () => pending?.finish(false);
  const surface = createNativeModalSurface({
    ...options,
    priority: 100,
    activeChannel: nativeGlobalDialogActiveChannel,
    unavailable: 'native_global_dialog_unavailable',
    cancel,
    unavailableError: (error) => pending?.finish(false, error),
  });
  const send = () => surface.send(nativeGlobalDialogStateChannel, pending?.state ?? null);
  const event = (event: IpcMainEvent, input: unknown) => {
    try {
      if (disposed || !surface.accepts(event) || !nativeModalRecord(input)) return;
      const keys = Object.keys(input).sort().join(',');
      if (keys === 'type' && input.type === 'ready') {
        surface.initialized();
        send();
      } else if (
        keys === 'requestId,type' &&
        input.type === 'presented' &&
        pending &&
        pending.state.requestId === input.requestId &&
        surface.available()
      ) {
        pending.presented = true;
        surface.present();
      } else if (
        keys === 'confirmed,requestId,type' &&
        input.type === 'decision' &&
        typeof input.confirmed === 'boolean' &&
        pending &&
        (!input.confirmed || pending.presented) &&
        pending.state.requestId === input.requestId
      )
        pending.finish(input.confirmed);
    } catch {
      /* Foreign or retired messages cannot resolve a confirmation. */
    }
  };
  options.ipcMain.on(nativeGlobalDialogEventChannel, event);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    cancel();
    options.ipcMain.off(nativeGlobalDialogEventChannel, event);
    options.window.off('closed', dispose);
    surface.dispose();
  };
  options.window.once('closed', dispose);
  return {
    active: () => !!pending,
    dismiss: cancel,
    prewarm() {
      void surface.prepare().catch(() => {});
    },
    syncTheme() {
      if (pending) {
        pending.state = { ...pending.state, theme: options.theme() };
        send();
      }
    },
    confirm(content: NativeGlobalDialogContent, signal: AbortSignal): Promise<boolean> {
      if (signal.aborted) return Promise.resolve(false);
      if (disposed || !surface.available())
        return Promise.reject(Error('native_global_dialog_unavailable'));
      if (pending) return Promise.reject(Error('native_global_dialog_busy'));
      return new Promise<boolean>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>;
        const state = { ...content, requestId: randomUUID(), theme: options.theme() };
        const abort = () => finish(false);
        const finish = (confirmed: boolean, error?: Error) => {
          if (pending?.state.requestId !== state.requestId) return;
          pending = undefined;
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          surface.setActive(false);
          send();
          if (error) reject(error);
          else resolve(confirmed && !signal.aborted);
        };
        pending = { state, presented: false, finish };
        try {
          surface.setActive(true);
        } catch {
          finish(false, Error('native_global_dialog_unavailable'));
          return;
        }
        signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => {
          if (!pending?.presented) finish(false, Error('native_global_dialog_unavailable'));
        }, 6000);
        void surface
          .prepare()
          .then(() => {
            if (pending?.state.requestId === state.requestId && !signal.aborted) {
              surface.present();
              send();
            }
          })
          .catch(() => finish(false, Error('native_global_dialog_unavailable')));
      });
    },
    dispose,
  };
}
