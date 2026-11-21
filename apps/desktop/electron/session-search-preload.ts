import { contextBridge, ipcRenderer } from 'electron';
import {
  isNativeSessionSearchAction,
  isNativeSessionSearchState,
  type NativeSessionSearchOverlayBridge,
  nativeSessionSearchEventChannel,
  nativeSessionSearchStateChannel,
} from '../src/native-session-search-bridge';

const bridge: NativeSessionSearchOverlayBridge = {
  watch(listener) {
    const receive = (_event: Electron.IpcRendererEvent, state: unknown) => {
      if (state === null || isNativeSessionSearchState(state)) listener(state);
    };
    ipcRenderer.on(nativeSessionSearchStateChannel, receive);
    return () => ipcRenderer.off(nativeSessionSearchStateChannel, receive);
  },
  ready() {
    ipcRenderer.send(nativeSessionSearchEventChannel, { type: 'ready' });
  },
  request(action) {
    if (!isNativeSessionSearchAction(action)) throw Error('invalid_session_search_action');
    ipcRenderer.send(nativeSessionSearchEventChannel, action);
  },
};
contextBridge.exposeInMainWorld('kiteSessionSearchOverlay', bridge);
