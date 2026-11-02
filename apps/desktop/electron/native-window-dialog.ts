import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { assertNativeSender } from './native-ipc';
import type { NativeRootWindow } from './native-root-window';

export type NativeWindowDialogReply = { ok: true; value: boolean } | { ok: false; code: string };

export function nativeDialogPayload(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).length !== keys.length ||
    !Reflect.ownKeys(input).every((key) => typeof key === 'string' && keys.includes(key)) ||
    !keys.every((key) => Object.getOwnPropertyDescriptor(input, key)?.get === undefined)
  )
    throw Error('invalid_native_request');
  const value = input as Record<string, unknown>;
  if (typeof value.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.requestId))
    throw Error('invalid_native_request');
  return value;
}

/** Root-owned dialog lifetime; a decision never performs a Service operation. */
export function registerNativeWindowDialogIpc<T>(options: {
  ipcMain: IpcMain;
  window: () => NativeRootWindow | undefined;
  rendererUrl: string;
  channel: string;
  cancelChannel: string;
  code: string;
  parse: (input: unknown) => { requestId: string; value: T };
  showDialog: (window: NativeRootWindow, value: T, signal: AbortSignal) => Promise<boolean>;
}): () => void {
  let disposed = false;
  let pending:
    | {
        requestId: string;
        frame: IpcMainInvokeEvent['senderFrame'];
        sender: IpcMainInvokeEvent['sender'];
        abort: () => void;
      }
    | undefined;

  const cancel = (event: IpcMainEvent, input: unknown) => {
    try {
      assertNativeSender(
        event as IpcMainInvokeEvent,
        disposed ? undefined : options.window(),
        options.rendererUrl,
      );
      const value = nativeDialogPayload(input, ['requestId']);
      const active = pending;
      if (
        active &&
        active.requestId === value.requestId &&
        active.frame === event.senderFrame &&
        active.sender === event.sender
      )
        active.abort();
    } catch {
      // An unrelated frame or malformed cancellation cannot retire the owner.
    }
  };
  options.ipcMain.on(options.cancelChannel, cancel);
  options.ipcMain.handle(
    options.channel,
    async (event, input: unknown): Promise<NativeWindowDialogReply> => {
      let cleanup = () => {};
      let record: typeof pending;
      try {
        const window = disposed ? undefined : options.window();
        assertNativeSender(event, window, options.rendererUrl);
        const value = options.parse(input);
        if (!window!.isVisible() || window!.isMinimized() || window!.webContents.isDestroyed())
          throw Error(`${options.code}_unavailable`);
        if (pending) throw Error(`${options.code}_busy`);
        const parent = window!,
          contents = parent.webContents,
          frame = event.senderFrame,
          controller = new AbortController();
        let rejectAbort!: (cause: Error) => void;
        const cancelled = new Promise<never>((_resolve, reject) => {
          rejectAbort = reject;
        });
        const abort = () => {
          if (controller.signal.aborted) return;
          controller.abort();
          rejectAbort(Error(`${options.code}_cancelled`));
        };
        record = { requestId: value.requestId as string, frame, sender: event.sender, abort };
        pending = record;
        const navigate = (
          details: { isMainFrame?: boolean },
          _url: string,
          _inPlace: boolean,
          mainFrame: boolean,
        ) => {
          if (details.isMainFrame || mainFrame) abort();
        };
        parent.on('hide', abort);
        parent.on('minimize', abort);
        parent.on('closed', abort);
        contents.on('did-start-navigation', navigate);
        contents.on('render-process-gone', abort);
        contents.on('destroyed', abort);
        cleanup = () => {
          parent.off('hide', abort);
          parent.off('minimize', abort);
          parent.off('closed', abort);
          contents.off('did-start-navigation', navigate);
          contents.off('render-process-gone', abort);
          contents.off('destroyed', abort);
        };
        const assertCurrent = () => {
          if (
            disposed ||
            controller.signal.aborted ||
            pending !== record ||
            options.window() !== parent ||
            parent.isDestroyed() ||
            contents.isDestroyed() ||
            !parent.isVisible() ||
            parent.isMinimized() ||
            parent.webContents !== contents ||
            contents.mainFrame !== frame
          ) {
            abort();
            throw Error(`${options.code}_cancelled`);
          }
          try {
            assertNativeSender(event, parent, options.rendererUrl);
          } catch (cause) {
            abort();
            throw cause;
          }
        };
        const result = await Promise.race([
          Promise.resolve().then(() => {
            assertCurrent();
            return options.showDialog(parent, value.value, controller.signal);
          }),
          cancelled,
        ]);
        assertCurrent();
        if (typeof result !== 'boolean') throw Error(`${options.code}_failed`);
        return { ok: true, value: result };
      } catch (cause) {
        const code = cause instanceof Error ? cause.message : '';
        return {
          ok: false,
          code: [
            'native_sender_denied',
            'invalid_native_request',
            `${options.code}_unavailable`,
            `${options.code}_busy`,
            `${options.code}_cancelled`,
          ].includes(code)
            ? code
            : `${options.code}_failed`,
        };
      } finally {
        cleanup();
        if (record && pending === record) pending = undefined;
      }
    },
  );
  return () => {
    if (disposed) return;
    disposed = true;
    pending?.abort();
    options.ipcMain.removeHandler(options.channel);
    options.ipcMain.off(options.cancelChannel, cancel);
  };
}
