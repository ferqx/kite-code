import type { IpcMain, IpcMainEvent, WebContentsView } from 'electron';
import {
  isNativeSessionSearchAction,
  isNativeSessionSearchPresentation,
  type NativeSessionSearchAction,
  type NativeSessionSearchState,
  nativeSessionSearchActionChannel,
  nativeSessionSearchActiveChannel,
  nativeSessionSearchCloseChannel,
  nativeSessionSearchEventChannel,
  nativeSessionSearchPresentChannel,
  nativeSessionSearchRequestId,
  nativeSessionSearchStateChannel,
} from '../src/native-session-search-bridge';
import { createNativeModalSurface, nativeModalRecord } from './native-modal-surface';
import type { NativeRootWindow } from './native-root-window';

/** Only Root can publish its directory; only the isolated current overlay can return a row. */
export function createNativeSessionSearchHost(options: {
  window: NativeRootWindow;
  ipcMain: IpcMain;
  rootUrl: string;
  url: string;
  createView: () => WebContentsView;
  theme(): 'light' | 'dark';
  higherModalActive(): boolean;
}) {
  const root = options.window.webContents;
  let state: NativeSessionSearchState | null = null;
  let disposed = false;
  let awaiting: { query: string; page: number } | undefined;
  const send = () => {
    if (surface.isReady()) surface.send(nativeSessionSearchStateChannel, state);
  };
  const action = (result: NativeSessionSearchAction) => {
    if (!root.isDestroyed()) root.send(nativeSessionSearchActionChannel, result);
  };
  const finish = (result?: NativeSessionSearchAction) => {
    if (!state) return;
    const { requestId } = state;
    state = null;
    awaiting = undefined;
    surface.setActive(false);
    send();
    action(result ?? { requestId, type: 'close' });
  };
  const unavailable = () => {
    if (state) finish({ requestId: state.requestId, type: 'unavailable' });
  };
  const surface = createNativeModalSurface({
    ...options,
    priority: 25,
    activeChannel: nativeSessionSearchActiveChannel,
    unavailable: 'native_session_search_unavailable',
    cancel: finish,
    unavailableError: unavailable,
  });
  const rootSender = (event: IpcMainEvent) =>
    !disposed &&
    !options.window.isDestroyed() &&
    !root.isDestroyed() &&
    event.sender === root &&
    event.senderFrame === root.mainFrame &&
    event.senderFrame?.url.split('#')[0] === options.rootUrl;
  const present = (event: IpcMainEvent, input: unknown, opening: unknown) => {
    if (
      !rootSender(event) ||
      typeof opening !== 'boolean' ||
      !isNativeSessionSearchPresentation(input)
    )
      return;
    if (state?.requestId === input.requestId) {
      if (awaiting && (input.query !== awaiting.query || input.page !== awaiting.page)) return;
      awaiting = undefined;
      state = { ...input, theme: options.theme() };
      send();
      return;
    }
    if (!opening) return;
    if (!surface.available() || options.higherModalActive()) {
      action({ requestId: input.requestId, type: 'close' });
      return;
    }
    finish();
    state = { ...input, theme: options.theme() };
    const { requestId } = input;
    // Reserve the transparent native input fence before waiting for its renderer.
    surface.setActive(true);
    void surface
      .prepare()
      .then(() => {
        if (state?.requestId === requestId) surface.present();
      })
      .catch(() => {
        if (state?.requestId === requestId) unavailable();
      });
    send();
  };
  const rootClose = (event: IpcMainEvent, input: unknown) => {
    if (rootSender(event) && nativeSessionSearchRequestId(input) && state?.requestId === input)
      finish();
  };
  const overlayEvent = (event: IpcMainEvent, input: unknown) => {
    if (!surface.accepts(event) || !nativeModalRecord(input)) return;
    if (input.type === 'ready' && Object.keys(input).length === 1) {
      surface.initialized();
      send();
    } else if (
      surface.isReady() &&
      isNativeSessionSearchAction(input) &&
      state &&
      input.requestId === state.requestId
    ) {
      if (options.higherModalActive() && input.type !== 'query') {
        finish();
        return;
      }
      if (input.type === 'close') finish();
      if (input.type === 'query') {
        awaiting = { query: input.query, page: input.page };
        action(input);
      }
      if (input.type === 'select') {
        const current =
          !awaiting &&
          state.available &&
          state.query === input.query &&
          state.page === input.page &&
          state.rows.some((row) => row.session.sessionId === input.sessionId);
        finish(current ? input : undefined);
      }
    }
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    finish();
    options.ipcMain.off(nativeSessionSearchPresentChannel, present);
    options.ipcMain.off(nativeSessionSearchCloseChannel, rootClose);
    options.ipcMain.off(nativeSessionSearchEventChannel, overlayEvent);
    options.window.off('closed', dispose);
    surface.dispose();
  };
  options.ipcMain.on(nativeSessionSearchPresentChannel, present);
  options.ipcMain.on(nativeSessionSearchCloseChannel, rootClose);
  options.ipcMain.on(nativeSessionSearchEventChannel, overlayEvent);
  options.window.once('closed', dispose);
  return {
    active: () => !!state,
    dispose,
    dismiss: () => finish(),
    syncTheme() {
      if (state) {
        state = { ...state, theme: options.theme() };
        send();
      }
    },
  };
}
