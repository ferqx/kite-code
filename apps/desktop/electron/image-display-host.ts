import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import {
  isNativeImageDisplayId,
  isNativeImageDisplayRequest,
  type NativeImageDisplayReply,
  nativeImageDisplayCancelChannel,
  nativeImageDisplayChannel,
} from '../src/native-image-display-bridge';
import { type ImageDisplayInput, renderImageDisplay } from './image-display-service';
import type { NativeRootWindow } from './native-root-window';

type DisplayHost = {
  accepts(event: IpcMainEvent | IpcMainInvokeEvent): boolean;
  render(event: IpcMainInvokeEvent, input: unknown): Promise<NativeImageDisplayReply>;
  cancel(event: IpcMainEvent, id: unknown): void;
};
const registries = new WeakMap<
  IpcMain,
  { hosts: Set<DisplayHost>; cancel(event: IpcMainEvent, id: unknown): void }
>();
function register(ipc: IpcMain, host: DisplayHost) {
  let registry = registries.get(ipc);
  if (!registry) {
    const hosts = new Set<DisplayHost>();
    const cancel = (event: IpcMainEvent, id: unknown) => {
      for (const current of hosts)
        if (current.accepts(event)) {
          current.cancel(event, id);
          return;
        }
    };
    registry = { hosts, cancel };
    registries.set(ipc, registry);
    ipc.handle(nativeImageDisplayChannel, (event, input) => {
      for (const current of hosts) if (current.accepts(event)) return current.render(event, input);
      return { ok: false, code: 'native_image_display_unavailable' };
    });
    ipc.on(nativeImageDisplayCancelChannel, cancel);
  }
  registry.hosts.add(host);
  return () => {
    registry.hosts.delete(host);
    if (registry.hosts.size) return;
    ipc.removeHandler(nativeImageDisplayChannel);
    ipc.off(nativeImageDisplayCancelChannel, registry.cancel);
    registries.delete(ipc);
  };
}

/** Root-only byte transforms. No read path, URL, token, or attachment authority crosses IPC. */
export function createNativeImageDisplayHost(options: {
  window: NativeRootWindow;
  rootUrl: string;
  ipcMain: IpcMain;
  render?: typeof renderImageDisplay;
}) {
  const root = options.window.webContents;
  const requests = new Map<string, AbortController>();
  let disposed = false;
  const accepts = (event: IpcMainEvent | IpcMainInvokeEvent) =>
    !disposed &&
    !options.window.isDestroyed() &&
    !root.isDestroyed() &&
    event.sender === root &&
    event.senderFrame === root.mainFrame &&
    event.senderFrame?.url.split('#')[0] === options.rootUrl;
  const retire = () => {
    for (const controller of requests.values())
      controller.abort(Error('native_image_display_cancelled'));
    // Keep cancelled IDs owned until each decoder/queue entry confirms settlement.
  };
  const render = async (
    event: IpcMainInvokeEvent,
    input: unknown,
  ): Promise<NativeImageDisplayReply> => {
    if (!accepts(event)) return { ok: false, code: 'native_image_display_unavailable' };
    if (!isNativeImageDisplayRequest(input) || requests.has(input.id))
      return { ok: false, code: 'native_image_display_invalid' };
    if (requests.size >= 9) return { ok: false, code: 'native_image_display_queue_full' };
    const controller = new AbortController();
    requests.set(input.id, controller);
    try {
      const request: ImageDisplayInput = {
        source: { bytes: input.bytes },
        mediaType: input.mediaType,
        edge: input.edge,
        ...(input.region === undefined ? {} : { region: input.region }),
        signal: controller.signal,
      };
      const value = await (options.render ?? renderImageDisplay)(request);
      controller.signal.throwIfAborted();
      if (!accepts(event)) throw Error('native_image_display_unavailable');
      return { ok: true, value };
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : '';
      return {
        ok: false,
        code: /^native_image_display_(?:invalid|format_unsupported|source_too_large|dimensions_exceeded|queue_full|timeout|decode_failed|process_failed|output_invalid|unavailable|cancelled|exit_unconfirmed)$/.test(
          code,
        )
          ? code
          : 'native_image_display_decode_failed',
      };
    } finally {
      requests.delete(input.id);
    }
  };
  const cancel = (event: IpcMainEvent, id: unknown) => {
    if (accepts(event) && isNativeImageDisplayId(id))
      requests.get(id)?.abort(Error('native_image_display_cancelled'));
  };
  const navigation = (_event: unknown, _url: string, _inPlace: boolean, mainFrame: boolean) => {
    if (mainFrame) retire();
  };
  const unregister = register(options.ipcMain, { accepts, render, cancel });
  root.on('did-start-navigation', navigation);
  root.on('render-process-gone', retire);
  root.on('destroyed', retire);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    retire();
    unregister();
    root.off('did-start-navigation', navigation);
    root.off('render-process-gone', retire);
    root.off('destroyed', retire);
    options.window.off('closed', dispose);
  };
  options.window.once('closed', dispose);
  return { dispose };
}
