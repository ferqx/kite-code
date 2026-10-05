import { contextBridge, ipcRenderer } from 'electron';
import {
  type NativeBridge,
  type NativeEvent,
  type NativeReply,
  type NativeRequest,
  nativeChannel,
  nativeEventChannel,
} from '../src/native-bridge';

const bridge: NativeBridge = {
  async request(input: NativeRequest) {
    const reply = (await ipcRenderer.invoke(nativeChannel, input)) as NativeReply;
    if (!reply.ok) throw Object.assign(Error(reply.code), { code: reply.code });
    return reply.value;
  },
  watch(listener) {
    const receive = (_event: unknown, value: NativeEvent) => {
      if (
        value?.kind === 'changed' &&
        Number.isSafeInteger(value.generation) &&
        value.generation >= 0
      )
        listener({ kind: 'changed', generation: value.generation });
    };
    ipcRenderer.on(nativeEventChannel, receive);
    return () => ipcRenderer.removeListener(nativeEventChannel, receive);
  },
};
contextBridge.exposeInMainWorld('kiteNative', Object.freeze(bridge));
