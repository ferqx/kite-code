import type { IpcMain, IpcMainEvent, WebContentsView } from 'electron';
import {
  isNativeImageGalleryAction,
  isNativeImageGalleryPresentation,
  type NativeImageGalleryAction,
  type NativeImageGalleryState,
  nativeImageGalleryActionChannel,
  nativeImageGalleryActiveChannel,
  nativeImageGalleryCloseChannel,
  nativeImageGalleryEventChannel,
  nativeImageGalleryPresentChannel,
  nativeImageGallerySessionId,
  nativeImageGalleryStateChannel,
} from '../src/native-image-gallery-bridge';
import { createNativeModalSurface, nativeModalRecord } from './native-modal-surface';
import type { NativeRootWindow } from './native-root-window';

/** Relays only the currently admitted image. This renderer cannot read any source. */
export function createNativeImageGalleryHost(options: {
  window: NativeRootWindow;
  ipcMain: IpcMain;
  rootUrl: string;
  url: string;
  createView(): WebContentsView;
  theme(): 'light' | 'dark';
}) {
  const root = options.window.webContents;
  let state: NativeImageGalleryState = null;
  let disposed = false;
  const retired = new Set<string>();
  const send = () => {
    if (surface.isReady()) surface.send(nativeImageGalleryStateChannel, state);
  };
  const action = (input: NativeImageGalleryAction) => {
    if (!root.isDestroyed()) root.send(nativeImageGalleryActionChannel, input);
  };
  const close = () => {
    if (!state) return;
    const sessionId = state.sessionId;
    retired.add(sessionId);
    state = null;
    surface.setActive(false);
    send();
    action({ sessionId, type: 'close' });
  };
  const unavailable = () => {
    if (state) action({ sessionId: state.sessionId, type: 'unavailable' });
    close();
  };
  const surface = createNativeModalSurface({
    ...options,
    priority: 50,
    activeChannel: nativeImageGalleryActiveChannel,
    unavailable: 'native_image_gallery_unavailable',
    cancel: close,
    unavailableError: unavailable,
  });
  const rootSender = (event: IpcMainEvent) =>
    !disposed &&
    !options.window.isDestroyed() &&
    !root.isDestroyed() &&
    event.sender === root &&
    event.senderFrame === root.mainFrame &&
    event.senderFrame?.url.split('#')[0] === options.rootUrl;
  const present = (event: IpcMainEvent, input: unknown) => {
    try {
      if (
        !rootSender(event) ||
        !surface.available() ||
        !isNativeImageGalleryPresentation(input) ||
        retired.has(input.sessionId)
      )
        return;
      if (
        state?.sessionId === input.sessionId &&
        (state.selectedId !== input.selectedId ||
          JSON.stringify(state.items) !== JSON.stringify(input.items))
      )
        return;
      if (state && state.sessionId !== input.sessionId) close();
      state = { ...input, theme: options.theme() };
      surface.setActive(true);
      const sessionId = state.sessionId;
      // Cold preparation installs the transparent native input fence synchronously.
      void surface
        .prepare()
        .then(() => {
          if (state?.sessionId === sessionId) surface.present();
        })
        .catch(() => {
          if (state?.sessionId === sessionId) unavailable();
        });
      send();
    } catch {
      /* Malformed Root DTOs cannot grant renderer authority. */
    }
  };
  const rootClose = (event: IpcMainEvent, sessionId: unknown) => {
    if (!rootSender(event) || !nativeImageGallerySessionId(sessionId)) return;
    retired.add(sessionId);
    if (state?.sessionId === sessionId) close();
  };
  const viewerEvent = (event: IpcMainEvent, input: unknown) => {
    try {
      if (!surface.accepts(event) || !nativeModalRecord(input)) return;
      if (Object.keys(input).join(',') === 'type' && input.type === 'ready') {
        surface.initialized();
        send();
        return;
      }
      if (
        !state ||
        !isNativeImageGalleryAction(input) ||
        input.type === 'unavailable' ||
        input.sessionId !== state.sessionId
      )
        return;
      if (input.type === 'select' && input.id === state.selectedId) return;
      if (input.type === 'close') close();
      else if (
        input.type === 'retry' ||
        (input.type === 'select' && state.items.some((item) => item.id === input.id))
      ) {
        // Clear old bytes before the next Root read. No stale image survives a selection.
        state = {
          ...state,
          ...(input.type === 'select' ? { selectedId: input.id } : {}),
          image: { status: 'loading' },
        };
        send();
        action(input);
      }
    } catch {
      /* Foreign, stale and subframe messages are ignored. */
    }
  };
  options.ipcMain.on(nativeImageGalleryPresentChannel, present);
  options.ipcMain.on(nativeImageGalleryCloseChannel, rootClose);
  options.ipcMain.on(nativeImageGalleryEventChannel, viewerEvent);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    close();
    options.ipcMain.off(nativeImageGalleryPresentChannel, present);
    options.ipcMain.off(nativeImageGalleryCloseChannel, rootClose);
    options.ipcMain.off(nativeImageGalleryEventChannel, viewerEvent);
    options.window.off('closed', dispose);
    surface.dispose();
  };
  options.window.once('closed', dispose);
  return {
    active: () => !!state,
    dismiss: close,
    prewarm() {
      void surface.prepare().catch(() => {});
    },
    syncTheme() {
      if (state) {
        state = { ...state, theme: options.theme() };
        send();
      }
    },
    dispose,
  };
}
