import { contextBridge, ipcRenderer, webFrame, webUtils } from 'electron';
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
  isNativeBrowserLayoutFrameAck,
  isNativeBrowserMenuAction,
  isNativeBrowserPresentationFrame,
  isNativeBrowserRestoreResult,
  isNativeBrowserState,
  type NativeBrowserBridge,
  type NativeBrowserReply,
  nativeBrowserChannel,
  nativeBrowserDisplayChannel,
  nativeBrowserEventChannel,
  nativeBrowserLayoutChannel,
  nativeBrowserLayoutFrameChannel,
  nativeBrowserMenuCancelChannel,
  nativeBrowserMenuChannel,
} from '../src/native-browser-bridge';
import {
  isNativeBrowserChromeEnvelope,
  isNativeBrowserChromeEvent,
  isNativeBrowserChromeSnapshot,
  type NativeBrowserChromeRootBridge,
  nativeBrowserChromeAckChannel,
  nativeBrowserChromeActionChannel,
  nativeBrowserChromeRootChannel,
  nativeBrowserChromeStateChannel,
} from '../src/native-browser-chrome-bridge';
import {
  isNativeWindowMenuAction,
  type NativeWindowMenuBridge,
  nativeWindowMenuActionChannel,
  nativeWindowMenuChannel,
} from '../src/native-menu-bridge';
import { createBrowserDisplayBootstrap } from './browser-display-bootstrap';

const bridge: NativeBridge &
  NativeBrowserBridge &
  NativeThemeBridge &
  NativeWindowBridge &
  NativeWindowMenuBridge &
  NativeStartupBridge &
  NativeBrowserChromeRootBridge = {
  async publishBrowserChrome(snapshot) {
    if (snapshot !== null && !isNativeBrowserChromeSnapshot(snapshot))
      throw Error('browser_chrome_snapshot_invalid');
    await ipcRenderer.invoke(nativeBrowserChromeRootChannel, snapshot);
  },
  watchBrowserChromeState(receive) {
    const listener = (_event: unknown, value: unknown) => {
      if (value === null || isNativeBrowserChromeEnvelope(value)) receive(value);
    };
    ipcRenderer.on(nativeBrowserChromeStateChannel, listener);
    return () => ipcRenderer.removeListener(nativeBrowserChromeStateChannel, listener);
  },
  watchBrowserChromeAction(receive) {
    const listener = (_event: unknown, value: unknown) => {
      if (!isNativeBrowserChromeEvent(value)) return;
      let forwarded = false;
      try {
        forwarded = receive(value) === true;
      } catch {
        // A UI relay acknowledgment never claims that the requested business action succeeded.
      }
      ipcRenderer.send(nativeBrowserChromeAckChannel, {
        attachment: value.attachment,
        pageToken: value.pageToken,
        sequence: value.sequence,
        forwarded,
      });
    };
    ipcRenderer.on(nativeBrowserChromeActionChannel, listener);
    return () => ipcRenderer.removeListener(nativeBrowserChromeActionChannel, listener);
  },
  ...createBrowserDisplayBootstrap({
    document,
    // Electron 44.3 removes webFrame sheets only from Blink's author list.
    // Using user origin leaves the staging mask applied after removal returns.
    insertCSS: (css) => webFrame.insertCSS(css, { cssOrigin: 'author' }),
    removeCSS: (key) => webFrame.removeInsertedCSS(key),
    request: (input) => ipcRenderer.sendSync(nativeBrowserDisplayChannel, input),
    subscribe(receive) {
      const listener = (_event: unknown, value: unknown) => receive(value);
      ipcRenderer.on(nativeBrowserDisplayChannel, listener);
      return () => ipcRenderer.removeListener(nativeBrowserDisplayChannel, listener);
    },
  }),
  async browserRequest(input) {
    const reply = (await ipcRenderer.invoke(nativeBrowserChannel, input)) as NativeBrowserReply;
    if (!reply.ok) throw Object.assign(Error(reply.code), { code: reply.code });
    if (reply.value !== null && !isNativeBrowserState(reply.value))
      throw Error('invalid_browser_state');
    return reply.value;
  },
  presentBrowserLayout(input) {
    const reply = ipcRenderer.sendSync(nativeBrowserLayoutChannel, input) as NativeBrowserReply & {
      waiting?: boolean;
      frozenKey?: string;
      frozenWidth?: number;
      frozenHeight?: number;
    };
    if (!reply.ok) throw Object.assign(Error(reply.code), { code: reply.code });
    if (reply.value !== null && !isNativeBrowserState(reply.value))
      throw Error('invalid_browser_state');
    if (input.witness) {
      if (
        typeof reply.waiting !== 'boolean' ||
        (reply.frozenKey !== undefined &&
          (!/^[a-f0-9]{32}$/.test(reply.frozenKey) ||
            ![reply.frozenWidth, reply.frozenHeight].every(
              (n) => typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= 32768,
            )))
      )
        throw Error('invalid_browser_presentation');
      return {
        state: reply.value,
        waiting: reply.waiting,
        ...(reply.frozenKey
          ? {
              frozenKey: reply.frozenKey,
              frozenWidth: reply.frozenWidth,
              frozenHeight: reply.frozenHeight,
            }
          : {}),
      };
    }
    return reply.value;
  },
  watchBrowserLayoutFrame(listener) {
    const receive = (_event: unknown, value: unknown) => {
      if (isNativeBrowserLayoutFrameAck(value)) listener(value);
    };
    ipcRenderer.on(nativeBrowserLayoutFrameChannel, receive);
    return () => ipcRenderer.removeListener(nativeBrowserLayoutFrameChannel, receive);
  },
  async showBrowserMenu(input) {
    const action: unknown = await ipcRenderer.invoke(nativeBrowserMenuChannel, input);
    if (action !== null && !isNativeBrowserMenuAction(action)) throw Error('invalid_browser_menu');
    return action;
  },
  cancelBrowserMenu(requestId) {
    ipcRenderer.send(nativeBrowserMenuCancelChannel, requestId);
  },
  async captureBrowserPresentation(id) {
    const reply = (await ipcRenderer.invoke(nativeBrowserChannel, {
      action: 'capturePresentation',
      id,
    })) as NativeBrowserReply;
    if (!reply.ok) throw Object.assign(Error(reply.code), { code: reply.code });
    if (!isNativeBrowserPresentationFrame(reply.value)) throw Error('invalid_browser_presentation');
    return reply.value;
  },
  async restoreBrowser(scope) {
    const reply = (await ipcRenderer.invoke(nativeBrowserChannel, {
      action: 'restore',
      scope,
    })) as NativeBrowserReply;
    if (!reply.ok) throw Object.assign(Error(reply.code), { code: reply.code });
    if (!isNativeBrowserRestoreResult(reply.value)) throw Error('invalid_browser_restore');
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
