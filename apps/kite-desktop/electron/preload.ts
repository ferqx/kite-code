import { contextBridge, type IpcRendererEvent, ipcRenderer } from 'electron';
import type {
  DESKTOP_QUIT_INSPECTION_CHANNELS,
  DesktopIpcChannel,
  DesktopIpcResult,
} from '../src/bridge';
import { createPreloadBridge } from './preload-bridge';

const bridge = createPreloadBridge(
  <T>(
    channel: DesktopIpcChannel | typeof DESKTOP_QUIT_INSPECTION_CHANNELS.result,
    payload?: unknown,
  ) => ipcRenderer.invoke(channel, payload) as Promise<DesktopIpcResult<T>>,
  (channel, listener) => {
    const handler = (_event: IpcRendererEvent, requestId: unknown) => {
      if (typeof requestId === 'number' && Number.isSafeInteger(requestId) && requestId > 0)
        listener(requestId);
    };
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
);

contextBridge.exposeInMainWorld('kiteDesktop', bridge);
