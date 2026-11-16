import { contextBridge, ipcRenderer } from 'electron';
import {
  type NativePreviewLayoutRequest,
  nativePreviewPresentationChannel,
} from '../src/native-preview-layout-bridge';

// Test-only entrypoint, never included in the application.
contextBridge.exposeInMainWorld('readonlyFixture', {
  request: (request: unknown) => ipcRenderer.invoke('readonly-fixture-request', request),
  presentPreviewLayout: (request: NativePreviewLayoutRequest) => {
    const reply = ipcRenderer.sendSync('readonly-fixture-layout', request);
    if (!reply.ok) throw Error(reply.code);
    return reply.value;
  },
  presentPreviewLayoutAsync: (request: NativePreviewLayoutRequest) =>
    ipcRenderer.invoke('readonly-fixture-layout', request),
  subscribePreviewPresentation: (receive: () => void) => {
    const listener = () => receive();
    ipcRenderer.on(nativePreviewPresentationChannel, listener);
    return () => ipcRenderer.off(nativePreviewPresentationChannel, listener);
  },
});
