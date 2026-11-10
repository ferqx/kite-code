import { contextBridge, ipcRenderer } from 'electron';
import {
  type NativeTrajectoryFileBridge,
  type NativeTrajectoryFileReply,
  type NativeTrajectoryFileRequest,
  nativeTrajectoryOfflineFileChannel,
} from '../src/native-trajectory-file-bridge';

/** Offline windows receive only local-package viewing. No online/native business bridge is installed. */
const trajectoryFiles: NativeTrajectoryFileBridge = Object.freeze({
  async request(input: NativeTrajectoryFileRequest) {
    const reply = (await ipcRenderer.invoke(
      nativeTrajectoryOfflineFileChannel,
      structuredClone(input),
    )) as NativeTrajectoryFileReply;
    if (!reply || typeof reply !== 'object' || typeof reply.ok !== 'boolean')
      throw Error('invalid_native_reply');
    if (!reply.ok) throw Object.assign(Error(reply.code), { code: reply.code });
    return reply.value;
  },
});
contextBridge.exposeInMainWorld('kiteNative', Object.freeze({ trajectoryFiles }));
