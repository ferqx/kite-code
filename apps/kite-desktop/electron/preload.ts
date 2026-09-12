import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopIpcChannel, DesktopIpcResult } from '../src/bridge';
import { createPreloadBridge } from './preload-bridge';

const bridge = createPreloadBridge(
  <T>(channel: DesktopIpcChannel, payload?: unknown) =>
    ipcRenderer.invoke(channel, payload) as Promise<DesktopIpcResult<T>>,
);

contextBridge.exposeInMainWorld('kiteDesktop', bridge);
