import { contextBridge, ipcRenderer } from 'electron';
import {
  isNativeImageGalleryAction,
  isNativeImageGalleryPresentation,
  type NativeImageGalleryState,
  type NativeImageGalleryViewerBridge,
  nativeImageGalleryEventChannel,
  nativeImageGalleryStateChannel,
} from '../src/native-image-gallery-bridge';

const bridge: NativeImageGalleryViewerBridge = {
  watch(listener) {
    const receive = (_event: Electron.IpcRendererEvent, state: unknown) => {
      if (state === null || isNativeImageGalleryPresentation(state, true))
        listener(state as NativeImageGalleryState);
    };
    ipcRenderer.on(nativeImageGalleryStateChannel, receive);
    return () => ipcRenderer.off(nativeImageGalleryStateChannel, receive);
  },
  ready() {
    ipcRenderer.send(nativeImageGalleryEventChannel, { type: 'ready' });
  },
  act(action) {
    if (!isNativeImageGalleryAction(action) || (action as { type: string }).type === 'unavailable')
      throw Error('invalid_image_gallery_action');
    ipcRenderer.send(nativeImageGalleryEventChannel, action);
  },
};
contextBridge.exposeInMainWorld('kiteImageGalleryViewer', bridge);
