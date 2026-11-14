import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { inputFileReference } from '../src/input-file-reference';
import {
  decodeNativeEvent,
  type NativeBridge,
  type NativeFullPermissionConfirmationReply,
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
  nativeFullPermissionConfirmationCancelChannel,
  nativeFullPermissionConfirmationChannel,
  nativeStartupDiagnosticSaveChannel,
  nativeStartupStatusChannel,
  nativeThemeChannel,
  nativeWindowAppearanceChannel,
  nativeWindowMaximizeChannel,
} from '../src/native-bridge';
import {
  isNativeBrowserDraft,
  isNativeBrowserDraftRestoreResult,
  isNativeBrowserMenuAction,
  isNativeBrowserRestoreResult,
  isNativeBrowserState,
  type NativeBrowserBridge,
  type NativeBrowserReply,
  nativeBrowserChannel,
  nativeBrowserEventChannel,
  nativeBrowserLayoutChannel,
  nativeBrowserMenuCancelChannel,
  nativeBrowserMenuChannel,
  nativeBrowserPresentationChannel,
} from '../src/native-browser-bridge';
import { nativeGlobalDialogActiveChannel } from '../src/native-global-dialog-bridge';
import {
  isNativeWindowMenuAction,
  type NativeWindowMenuBridge,
  nativeWindowMenuActionChannel,
  nativeWindowMenuChannel,
} from '../src/native-menu-bridge';
import {
  isNativeRecommendedModel,
  type NativeModelPreferenceBridge,
  type NativeModelPreferenceReply,
  nativeModelPreferenceChannel,
} from '../src/native-model-preference-bridge';
import {
  type NativeTrajectoryFileBridge,
  type NativeTrajectoryFileReply,
  nativeTrajectoryFileChannel,
} from '../src/native-trajectory-file-bridge';

type BrowserLayoutReply = NativeBrowserReply;
let modalRoot: HTMLElement | undefined;
let rootWasInert = false;
ipcRenderer.on(nativeGlobalDialogActiveChannel, (_event, active: unknown) => {
  if (typeof active !== 'boolean') return;
  if (active) {
    const root = document.getElementById('root');
    if (!root) return;
    if (root !== modalRoot) {
      modalRoot = root;
      rootWasInert = root.inert;
    }
    root.inert = true;
  } else if (modalRoot) {
    modalRoot.inert = rootWasInert;
    modalRoot = undefined;
  }
});
function readBrowserLayoutReply(reply: BrowserLayoutReply) {
  if (!reply.ok) throw Object.assign(Error(reply.code), { code: reply.code });
  if (reply.value !== null && !isNativeBrowserState(reply.value))
    throw Error('invalid_browser_state');
  return reply.value;
}

const bridge: NativeBridge &
  NativeBrowserBridge &
  NativeThemeBridge &
  NativeModelPreferenceBridge &
  NativeWindowBridge &
  NativeWindowMenuBridge &
  NativeStartupBridge = {
  trajectoryFiles: Object.freeze<NativeTrajectoryFileBridge>({
    async request(input) {
      const reply = (await ipcRenderer.invoke(
        nativeTrajectoryFileChannel,
        structuredClone(input),
      )) as NativeTrajectoryFileReply;
      if (!reply || typeof reply !== 'object' || typeof reply.ok !== 'boolean')
        throw Error('invalid_native_reply');
      if (!reply.ok) throw Object.assign(Error(reply.code), { code: reply.code });
      return reply.value;
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
    return readBrowserLayoutReply(
      ipcRenderer.sendSync(nativeBrowserLayoutChannel, input) as BrowserLayoutReply,
    );
  },
  async presentBrowserLayoutAsync(input) {
    return readBrowserLayoutReply(
      (await ipcRenderer.invoke(nativeBrowserLayoutChannel, input)) as BrowserLayoutReply,
    );
  },
  watchBrowserPresentation(listener) {
    const receive = (_event: unknown, value: unknown) => {
      if (value === true) listener();
    };
    ipcRenderer.on(nativeBrowserPresentationChannel, receive);
    return () => ipcRenderer.removeListener(nativeBrowserPresentationChannel, receive);
  },
  async showBrowserMenu(input) {
    const action: unknown = await ipcRenderer.invoke(nativeBrowserMenuChannel, input);
    if (action !== null && !isNativeBrowserMenuAction(action)) throw Error('invalid_browser_menu');
    return action;
  },
  cancelBrowserMenu(requestId) {
    ipcRenderer.send(nativeBrowserMenuCancelChannel, requestId);
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
  async restoreBrowserDraft(draft) {
    if (!isNativeBrowserDraft(draft)) throw Error('invalid_browser_request');
    const reply = (await ipcRenderer.invoke(nativeBrowserChannel, {
      action: 'restoreDraft',
      draft,
    })) as NativeBrowserReply;
    if (!reply.ok) throw Object.assign(Error(reply.code), { code: reply.code });
    if (!isNativeBrowserDraftRestoreResult(reply.value)) throw Error('invalid_browser_restore');
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
    return files.map((file) => {
      const path = webUtils.getPathForFile(file);
      // Synthetic browser Files have bytes but no native path. Import those normally.
      return path ? inputFileReference(file.name, path) : { name: file.name, uri: '' };
    });
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
  async confirmFullPermission(input) {
    const reply = (await ipcRenderer.invoke(
      nativeFullPermissionConfirmationChannel,
      input,
    )) as NativeFullPermissionConfirmationReply;
    if (!reply.ok) {
      if (reply.code === 'native_full_permission_confirmation_cancelled') return false;
      throw Object.assign(Error(reply.code), { code: reply.code });
    }
    if (typeof reply.value !== 'boolean') throw Error('invalid_native_confirmation_result');
    return reply.value;
  },
  cancelFullPermissionConfirmation(requestId) {
    ipcRenderer.send(nativeFullPermissionConfirmationCancelChannel, { requestId });
  },
  async setTheme(theme) {
    const reply = (await ipcRenderer.invoke(nativeThemeChannel, { theme })) as NativeReply;
    if (!reply.ok) throw Object.assign(Error(reply.code), { code: reply.code });
  },
  async readRecommendedModel(storeId) {
    const reply = (await ipcRenderer.invoke(nativeModelPreferenceChannel, {
      action: 'read',
      storeId,
    })) as NativeModelPreferenceReply;
    if (!reply.ok) throw Object.assign(Error(reply.code), { code: reply.code });
    if (reply.value !== null && !isNativeRecommendedModel(reply.value))
      throw Error('model_preference_invalid');
    return reply.value;
  },
  async rememberRecommendedModel(storeId, choice) {
    if (!isNativeRecommendedModel(choice)) throw Error('model_preference_invalid');
    const reply = (await ipcRenderer.invoke(nativeModelPreferenceChannel, {
      action: 'remember',
      storeId,
      choice,
    })) as NativeModelPreferenceReply;
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
