import { contextBridge, ipcRenderer } from 'electron';
import {
  type PreviewMenuOverlayBridge,
  type PreviewMenuState,
  previewMenuEventChannel,
  previewMenuStateChannel,
} from '../src/native-preview-menu-bridge';

const bridge: PreviewMenuOverlayBridge = {
  watch(listener) {
    const receive = (_event: Electron.IpcRendererEvent, state: PreviewMenuState) => listener(state);
    ipcRenderer.on(previewMenuStateChannel, receive);
    return () => ipcRenderer.off(previewMenuStateChannel, receive);
  },
  ready() {
    ipcRenderer.send(previewMenuEventChannel, { type: 'ready' });
  },
  shown(id) {
    ipcRenderer.send(previewMenuEventChannel, { type: 'shown', id });
  },
  finish(id, value) {
    ipcRenderer.send(previewMenuEventChannel, { type: 'finish', id, value });
  },
};
contextBridge.exposeInMainWorld('kitePreviewMenuOverlay', bridge);
