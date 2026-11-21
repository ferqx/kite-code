import { randomUUID } from 'node:crypto';
import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent, WebContentsView } from 'electron';
import type { NativeReply } from '../src/native-bridge';
import {
  isNativeSettingsIntent,
  isNativeSettingsRelease,
  isNativeSettingsReply,
  isNativeSettingsRequest,
  isNativeSettingsState,
  type NativeSettingsAction,
  type NativeSettingsRequest,
  type NativeSettingsState,
  nativeSettingsActionChannel,
  nativeSettingsActiveChannel,
  nativeSettingsCloseChannel,
  nativeSettingsId,
  nativeSettingsOverlayEventChannel,
  nativeSettingsOverlayRequestChannel,
  nativeSettingsPresentChannel,
  nativeSettingsReplyChannel,
  nativeSettingsStateChannel,
} from '../src/native-settings-bridge';
import { createNativeModalSurface } from './native-modal-surface';
import type { NativeRootWindow } from './native-root-window';

const unavailable = { ok: false, code: 'native_settings_unavailable' } as const;
const notDispatched = { ok: false, code: 'native_settings_not_dispatched' } as const;

/** This view owns hit testing only. Authority stays on the existing Root request route. */
export function createNativeSettingsHost(options: {
  window: NativeRootWindow;
  ipcMain: IpcMain;
  rootUrl: string;
  url: string;
  createView: () => WebContentsView;
  theme: () => 'light' | 'dark';
  higherModalActive: () => boolean;
  onOpen?: () => void;
}) {
  const { window, ipcMain } = options;
  const root = window.webContents;
  let state: NativeSettingsState | null = null;
  let disposed = false;
  let closing = false;
  const pending = new Map<string, (result: NativeReply) => void>();
  const send = () => {
    if (surface.isReady()) surface.send(nativeSettingsStateChannel, state);
  };
  const action = (value: NativeSettingsAction) => {
    if (!root.isDestroyed()) root.send(nativeSettingsActionChannel, value);
  };
  const finish = (type: 'retired' | 'unavailable' = 'retired') => {
    if (!state) return;
    const { instanceId } = state;
    state = null;
    closing = false;
    for (const settle of pending.values()) settle(unavailable);
    pending.clear();
    surface.setActive(false);
    send();
    action({ instanceId, type });
  };
  const surface = createNativeModalSurface({
    ...options,
    priority: 40,
    activeChannel: nativeSettingsActiveChannel,
    unavailable: 'native_settings_unavailable',
    cancel: () => finish(),
    unavailableError: () => finish('unavailable'),
    retainOnHide: true,
  });
  const rootSender = (event: IpcMainEvent) =>
    !disposed &&
    !window.isDestroyed() &&
    !root.isDestroyed() &&
    event.sender === root &&
    event.senderFrame === root.mainFrame &&
    event.senderFrame?.url.split('#')[0] === options.rootUrl;
  const present = (event: IpcMainEvent, value: unknown, opening: unknown) => {
    if (!rootSender(event) || typeof opening !== 'boolean' || !isNativeSettingsState(value)) return;
    if (state?.instanceId === value.instanceId && !closing) {
      if (value.generation !== state.generation || value.storeId !== state.storeId) {
        finish();
        return;
      }
      state = { ...value, theme: options.theme() };
      send();
      return;
    }
    if (!opening) return;
    if (!surface.available() || options.higherModalActive() || state) {
      action({ instanceId: value.instanceId, type: 'unavailable' });
      return;
    }
    options.onOpen?.();
    state = { ...value, theme: options.theme() };
    // Reserve input before the overlay's first frame. Do not resize or hide underlying views.
    surface.setActive(true);
    void surface
      .prepare()
      .then(() => {
        if (state?.instanceId === value.instanceId) surface.present();
      })
      .catch(() => {
        if (state?.instanceId === value.instanceId) finish('unavailable');
      });
    send();
  };
  const rootClose = (event: IpcMainEvent, instanceId: unknown) => {
    if (rootSender(event) && nativeSettingsId(instanceId) && state?.instanceId === instanceId)
      finish();
  };
  const reply = (event: IpcMainEvent, instanceId: unknown, requestId: unknown, value: unknown) => {
    if (!rootSender(event) || state?.instanceId !== instanceId || !nativeSettingsId(requestId))
      return;
    const settle = pending.get(requestId);
    if (!settle) return;
    pending.delete(requestId);
    settle(
      isNativeSettingsReply(value) ? value : { ok: false, code: 'invalid_native_settings_reply' },
    );
  };
  const overlayEvent = (event: IpcMainEvent, instanceId: unknown, intent: unknown) => {
    if (!surface.accepts(event)) return;
    if (instanceId === 'ready' && intent === undefined) {
      surface.initialized();
      send();
      return;
    }
    if (
      !surface.isReady() ||
      !state ||
      state.instanceId !== instanceId ||
      !isNativeSettingsIntent(intent) ||
      options.higherModalActive() ||
      closing
    )
      return;
    if (intent.type === 'close') closing = true;
    action({ ...intent, instanceId: state.instanceId });
  };
  function matchScope(request: NativeSettingsRequest, current: NativeSettingsState) {
    if (request.generation !== current.generation) return false;
    if ('expectedStoreId' in request && request.expectedStoreId !== current.storeId) return false;
    if (request.method === 'webSearch.settings.test')
      return request.sessionId === current.webSearchSessionId;
    return true;
  }
  const overlayRequest = (
    event: IpcMainInvokeEvent,
    instanceId: unknown,
    request: unknown,
  ): Promise<NativeReply> | NativeReply => {
    if (
      !surface.accepts(event) ||
      root.isDestroyed() ||
      !surface.isReady() ||
      !state ||
      instanceId !== state.instanceId ||
      !isNativeSettingsRequest(request) ||
      !matchScope(request, state) ||
      pending.size >= 64
    )
      return notDispatched;
    if ((closing || options.higherModalActive()) && !isNativeSettingsRelease(request))
      return notDispatched;
    const requestId = randomUUID();
    return new Promise((resolve) => {
      pending.set(requestId, resolve);
      try {
        action({ instanceId: state!.instanceId, type: 'request', requestId, request });
      } catch {
        pending.delete(requestId);
        resolve(unavailable);
      }
    });
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    finish();
    ipcMain.off(nativeSettingsPresentChannel, present);
    ipcMain.off(nativeSettingsCloseChannel, rootClose);
    ipcMain.off(nativeSettingsReplyChannel, reply);
    ipcMain.off(nativeSettingsOverlayEventChannel, overlayEvent);
    ipcMain.removeHandler(nativeSettingsOverlayRequestChannel);
    window.off('closed', dispose);
    surface.dispose();
  };
  ipcMain.on(nativeSettingsPresentChannel, present);
  ipcMain.on(nativeSettingsCloseChannel, rootClose);
  ipcMain.on(nativeSettingsReplyChannel, reply);
  ipcMain.on(nativeSettingsOverlayEventChannel, overlayEvent);
  ipcMain.handle(nativeSettingsOverlayRequestChannel, overlayRequest);
  window.once('closed', dispose);
  return {
    active: () => !!state,
    dispose,
    dismiss: () => finish(),
    syncTheme() {
      if (!state) return;
      state = { ...state, theme: options.theme() };
      send();
    },
  };
}
