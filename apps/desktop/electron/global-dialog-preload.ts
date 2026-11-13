import { contextBridge, ipcRenderer } from 'electron';
import {
  type NativeGlobalDialogBridge,
  type NativeGlobalDialogState,
  nativeGlobalDialogEventChannel,
  nativeGlobalDialogStateChannel,
} from '../src/native-global-dialog-bridge';

const validId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
function validState(input: unknown): input is NativeGlobalDialogState {
  if (input === null) return true;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const value = input as Record<string, unknown>;
  if (
    !validId(value.requestId) ||
    (value.language !== 'zh' && value.language !== 'en') ||
    (value.theme !== 'light' && value.theme !== 'dark')
  )
    return false;
  switch (value.kind) {
    case 'full-permission':
      return Object.keys(value).length === 4;
    case 'workspace-removal':
    case 'provider-removal':
      return (
        Object.keys(value).length === (value.kind === 'provider-removal' ? 6 : 5) &&
        typeof value.label === 'string' &&
        value.label.length >= 1 &&
        value.label.length <= 256 &&
        (value.kind === 'workspace-removal' ||
          (typeof value.modelCount === 'number' &&
            Number.isSafeInteger(value.modelCount) &&
            value.modelCount >= 0))
      );
    default:
      return false;
  }
}
const bridge: NativeGlobalDialogBridge = {
  watch(listener) {
    const receive = (_event: Electron.IpcRendererEvent, state: unknown) => {
      if (validState(state)) listener(state);
    };
    ipcRenderer.on(nativeGlobalDialogStateChannel, receive);
    return () => ipcRenderer.off(nativeGlobalDialogStateChannel, receive);
  },
  ready() {
    ipcRenderer.send(nativeGlobalDialogEventChannel, { type: 'ready' });
  },
  presented(requestId) {
    if (!validId(requestId)) throw Error('invalid_global_dialog_request');
    ipcRenderer.send(nativeGlobalDialogEventChannel, { type: 'presented', requestId });
  },
  decide(requestId, confirmed) {
    if (!validId(requestId) || typeof confirmed !== 'boolean')
      throw Error('invalid_global_dialog_request');
    ipcRenderer.send(nativeGlobalDialogEventChannel, { type: 'decision', requestId, confirmed });
  },
};
contextBridge.exposeInMainWorld('kiteGlobalDialog', bridge);
