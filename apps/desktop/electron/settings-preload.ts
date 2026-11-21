import { contextBridge, ipcRenderer } from 'electron';
import {
  isNativeSettingsIntent,
  isNativeSettingsReply,
  isNativeSettingsRequest,
  isNativeSettingsState,
  type NativeSettingsOverlayBridge,
  nativeSettingsId,
  nativeSettingsOverlayEventChannel,
  nativeSettingsOverlayRequestChannel,
  nativeSettingsStateChannel,
} from '../src/native-settings-bridge';

const bridge: NativeSettingsOverlayBridge = {
  watch(listener) {
    const receive = (_event: Electron.IpcRendererEvent, state: unknown) => {
      if (state === null || isNativeSettingsState(state)) listener(state);
    };
    ipcRenderer.on(nativeSettingsStateChannel, receive);
    return () => ipcRenderer.off(nativeSettingsStateChannel, receive);
  },
  ready() {
    ipcRenderer.send(nativeSettingsOverlayEventChannel, 'ready');
  },
  async request(instanceId, request) {
    if (!nativeSettingsId(instanceId) || !isNativeSettingsRequest(request))
      throw Error('invalid_native_settings_request');
    const reply: unknown = await ipcRenderer.invoke(
      nativeSettingsOverlayRequestChannel,
      instanceId,
      request,
    );
    if (!isNativeSettingsReply(reply)) throw Error('invalid_native_settings_reply');
    if (!reply.ok) throw Object.assign(Error(reply.code), { code: reply.code });
    return reply.value;
  },
  action(instanceId, intent) {
    if (!nativeSettingsId(instanceId) || !isNativeSettingsIntent(intent))
      throw Error('invalid_native_settings_action');
    ipcRenderer.send(nativeSettingsOverlayEventChannel, instanceId, intent);
  },
};
contextBridge.exposeInMainWorld('kiteSettingsOverlay', bridge);
