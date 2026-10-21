import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { inputFileReference } from '../src/input-file-reference';
import {
  decodeNativeEvent,
  type NativeBridge,
  type NativeReply,
  type NativeRequest,
  type NativeStartupBridge,
  type NativeStartupReply,
  type NativeThemeBridge,
  type NativeWindowAppearanceReply,
  type NativeWindowBridge,
  nativeChannel,
  nativeClipboardChannel,
  nativeEventChannel,
  nativeStartupDiagnosticSaveChannel,
  nativeStartupStatusChannel,
  nativeThemeChannel,
  nativeWindowAppearanceChannel,
  nativeWindowMaximizeChannel,
} from '../src/native-bridge';
import {
  isNativeBrowserState,
  type NativeBrowserBridge,
  type NativeBrowserReply,
  nativeBrowserChannel,
  nativeBrowserEventChannel,
} from '../src/native-browser-bridge';
import {
  isNativeWindowMenuAction,
  type NativeWindowMenuBridge,
  nativeWindowMenuActionChannel,
  nativeWindowMenuChannel,
} from '../src/native-menu-bridge';

const bridge: NativeBridge &
  NativeBrowserBridge &
  NativeThemeBridge &
  NativeWindowBridge &
  NativeWindowMenuBridge &
  NativeStartupBridge = {
  async browserRequest(input) {
    const reply = (await ipcRenderer.invoke(nativeBrowserChannel, input)) as NativeBrowserReply;
    if (!reply.ok) throw Object.assign(Error(reply.code), { code: reply.code });
    if (reply.value !== null && !isNativeBrowserState(reply.value))
      throw Error('invalid_browser_state');
    return reply.value;
  },
  watchBrowser(listener) {
    const receive = (_event: unknown, value: unknown) => {
      if (isNativeBrowserState(value)) listener(value);
    };
    ipcRenderer.on(nativeBrowserEventChannel, receive);
    return () => ipcRenderer.removeListener(nativeBrowserEventChannel, receive);
  },
  fileReferences(files) {
    if (!Array.isArray(files) || files.length > 128) throw Error('file_reference_unavailable');
    return files.map((file) => inputFileReference(file.name, webUtils.getPathForFile(file)));
  },
  async showWindowMenu(request) {
    const reply = (await ipcRenderer.invoke(nativeWindowMenuChannel, request)) as NativeReply;
    if (!reply.ok) throw Object.assign(Error(reply.code), { code: reply.code });
  },
  watchWindowMenuAction(listener) {
    const receive = (_event: unknown, value: unknown) => {
      if (isNativeWindowMenuAction(value)) listener(value);
    };
    ipcRenderer.on(nativeWindowMenuActionChannel, receive);
    return () => ipcRenderer.removeListener(nativeWindowMenuActionChannel, receive);
  },
  async startupStatus() {
    const reply = (await ipcRenderer.invoke(nativeStartupStatusChannel)) as NativeStartupReply;
    if (!reply.ok) throw Object.assign(Error(reply.code), { code: reply.code });
    if (typeof reply.value === 'boolean') throw Error('invalid_native_startup_status');
    return reply.value;
  },
  async saveStartupDiagnostic() {
    const reply = (await ipcRenderer.invoke(
      nativeStartupDiagnosticSaveChannel,
    )) as NativeStartupReply;
    if (!reply.ok) throw Object.assign(Error(reply.code), { code: reply.code });
    if (typeof reply.value !== 'boolean') throw Error('invalid_native_startup_save_result');
    return reply.value;
  },
  async writeClipboardText(text) {
    const reply = (await ipcRenderer.invoke(nativeClipboardChannel, { text })) as NativeReply;
    if (!reply.ok) throw Object.assign(Error(reply.code), { code: reply.code });
  },
  async toggleWindowMaximize() {
    const reply = (await ipcRenderer.invoke(nativeWindowMaximizeChannel)) as NativeReply;
    if (!reply.ok) throw Object.assign(Error(reply.code), { code: reply.code });
  },
  async getWindowAppearance() {
    const reply = (await ipcRenderer.invoke(
      nativeWindowAppearanceChannel,
    )) as NativeWindowAppearanceReply;
    if (!reply.ok) throw Object.assign(Error(reply.code), { code: reply.code });
    if (!['mica', 'vibrancy', 'none'].includes(reply.value?.backgroundMaterial))
      throw Error('invalid_native_window_appearance');
    return reply.value;
  },
  async setTheme(theme) {
    const reply = (await ipcRenderer.invoke(nativeThemeChannel, { theme })) as NativeReply;
    if (!reply.ok) throw Object.assign(Error(reply.code), { code: reply.code });
  },
  async request(input: NativeRequest) {
    const reply = (await ipcRenderer.invoke(nativeChannel, input)) as NativeReply;
    if (!reply.ok) throw Object.assign(Error(reply.code), { code: reply.code });
    return reply.value;
  },
  watch(listener) {
    const receive = (_event: unknown, value: unknown) => {
      const event = decodeNativeEvent(value);
      if (event) listener(event);
    };
    ipcRenderer.on(nativeEventChannel, receive);
    return () => ipcRenderer.removeListener(nativeEventChannel, receive);
  },
};
contextBridge.exposeInMainWorld('kiteNative', Object.freeze(bridge));
