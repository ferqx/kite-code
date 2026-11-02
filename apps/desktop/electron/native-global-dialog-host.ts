import { randomUUID } from 'node:crypto';
import type { IpcMain, IpcMainEvent, View, WebContents, WebContentsView } from 'electron';
import {
  type NativeGlobalDialogContent,
  type NativeGlobalDialogState,
  nativeGlobalDialogActiveChannel,
  nativeGlobalDialogEventChannel,
  nativeGlobalDialogStateChannel,
} from '../src/native-global-dialog-bridge';
import { keepNativeOverlayOnTop, reserveNativeOverlay } from './native-overlay-layer';
import type { NativeRootWindow } from './native-root-window';

/** A local, capability-limited modal renderer above Root, Page and its input shield. */
export function createNativeGlobalDialogHost(options: {
  window: NativeRootWindow;
  ipcMain: IpcMain;
  url: string;
  createView: () => WebContentsView;
  theme: () => 'light' | 'dark';
}) {
  const parent = options.window;
  let view: WebContentsView | undefined;
  let release: (() => void) | undefined;
  let preparing: Promise<void> | undefined;
  let ready: (() => void) | undefined;
  let disposed = false;
  let pending:
    | {
        state: Exclude<NativeGlobalDialogState, null>;
        presented: boolean;
        finish: (confirmed: boolean, error?: Error) => void;
      }
    | undefined;
  const protectedContents = new Map<WebContents, () => void>();
  const initializedContents = new WeakSet<WebContents>();
  const focusInWindow = (contents: WebContents) => {
    if (!parent.isDestroyed() && parent.isFocused() && !contents.isDestroyed()) contents.focus();
  };
  const send = (state: NativeGlobalDialogState) => {
    if (view && !view.webContents.isDestroyed())
      view.webContents.send(nativeGlobalDialogStateChannel, state);
  };
  const sync = () => {
    if (!view || parent.isDestroyed() || view.webContents.isDestroyed()) return;
    const [width = 0, height = 0] = parent.getContentSize();
    const bounds = view.getBounds();
    if (bounds.x !== 0 || bounds.y !== 0 || bounds.width !== width || bounds.height !== height)
      view.setBounds({ x: 0, y: 0, width, height });
    const zoom = parent.webContents.getZoomFactor();
    if (view.webContents.getZoomFactor() !== zoom) view.webContents.setZoomFactor(zoom);
    keepNativeOverlayOnTop(parent);
  };
  const protect = (child: View) => {
    if (!('webContents' in child) || child === view) return;
    const contents = child.webContents as WebContents;
    if (!contents || contents.isDestroyed() || protectedContents.has(contents)) return;
    const block = (event: { preventDefault(): void }) => {
      if (pending) event.preventDefault();
    };
    const focus = () => {
      if (!pending || parent.isDestroyed()) return;
      const target = view?.getVisible() ? view.webContents : parent.webContents;
      if (target !== contents) focusInWindow(target);
    };
    // Page CDP input also emits these Electron events. Native hit-testing and
    // focus fence human input; never silently consume an authorized Page action.
    if (contents === parent.webContents) {
      contents.on('before-input-event', block);
      contents.on('before-mouse-event', block);
    }
    contents.on('focus', focus);
    const remove = () => {
      contents.off('before-input-event', block);
      contents.off('before-mouse-event', block);
      contents.off('focus', focus);
      contents.off('destroyed', remove);
      protectedContents.delete(contents);
    };
    contents.once('destroyed', remove);
    protectedContents.set(contents, remove);
  };
  const destroyView = () => {
    const current = view;
    view = undefined;
    preparing = undefined;
    ready = undefined;
    release?.();
    release = undefined;
    if (current) {
      if (!parent.isDestroyed()) parent.contentView.removeChildView(current);
      if (!current.webContents.isDestroyed())
        current.webContents.close({ waitForBeforeUnload: false });
    }
  };
  const prepare = () => {
    let created: WebContentsView | undefined;
    preparing ??= (async () => {
      if (disposed || parent.isDestroyed()) throw Error('native_global_dialog_unavailable');
      const current = options.createView();
      created = current;
      view = current;
      current.setBackgroundColor('#00000000');
      current.setVisible(false);
      release = reserveNativeOverlay(parent, {
        view: current,
        active: () => !!pending && current.getVisible(),
        protect,
      });
      sync();
      const contents = current.webContents;
      // The transparent native view must intercept human input while its local
      // renderer is still loading. Page CDP input stays independently directed.
      if (pending) {
        current.setVisible(true);
        focusInWindow(contents);
      }
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      contents.on('will-navigate', (event) => event.preventDefault());
      contents.on('will-attach-webview', (event) => event.preventDefault());
      const failed = () => {
        if (view !== current) return;
        pending?.finish(false, Error('native_global_dialog_unavailable'));
        destroyView();
      };
      contents.on('render-process-gone', failed);
      contents.on('destroyed', failed);
      contents.on('did-start-navigation', (details, _url, _inPlace, mainFrame) => {
        if (initializedContents.has(contents) && (details.isMainFrame || mainFrame)) failed();
      });
      const initialized = new Promise<void>((resolve) => {
        ready = resolve;
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all([contents.loadURL(options.url), initialized]),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(Error('native_global_dialog_unavailable')), 5000);
          }),
        ]);
        if (view !== current || contents.isDestroyed() || disposed)
          throw Error('native_global_dialog_unavailable');
      } catch (error) {
        if (view === current) destroyView();
        throw error;
      } finally {
        clearTimeout(timer);
      }
    })().catch((error) => {
      if (view === created) destroyView();
      throw error;
    });
    return preparing;
  };
  const event = (event: IpcMainEvent, input: unknown) => {
    try {
      const contents = view?.webContents;
      if (
        disposed ||
        !contents ||
        contents.isDestroyed() ||
        parent.isDestroyed() ||
        event.sender !== contents ||
        event.senderFrame !== contents.mainFrame ||
        event.senderFrame?.url !== options.url ||
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.getPrototypeOf(input) !== Object.prototype
      )
        return;
      const value = input as Record<string, unknown>;
      if (
        Reflect.ownKeys(value).some(
          (key) => typeof key !== 'string' || Object.getOwnPropertyDescriptor(value, key)?.get,
        )
      )
        return;
      const keys = Object.keys(value).sort().join(',');
      if (keys === 'type' && value.type === 'ready') {
        initializedContents.add(contents);
        ready?.();
        send(pending?.state ?? null);
      } else if (
        keys === 'requestId,type' &&
        value.type === 'presented' &&
        pending &&
        pending.state.requestId === value.requestId &&
        parent.isVisible() &&
        !parent.isMinimized()
      ) {
        pending.presented = true;
        sync();
        view!.setVisible(true);
        focusInWindow(contents);
      } else if (
        keys === 'confirmed,requestId,type' &&
        value.type === 'decision' &&
        typeof value.confirmed === 'boolean' &&
        pending &&
        (!value.confirmed || pending.presented) &&
        pending.state.requestId === value.requestId
      )
        pending.finish(value.confirmed);
    } catch {
      // Foreign, malformed and retired renderer messages cannot resolve a confirmation.
    }
  };
  const cancel = () => pending?.finish(false);
  const focusOverlay = () => {
    if (pending && view?.getVisible()) focusInWindow(view.webContents);
  };
  const rootNavigation = (
    details: { isMainFrame?: boolean },
    _url: string,
    _inPlace: boolean,
    mainFrame: boolean,
  ) => {
    if (details.isMainFrame || mainFrame) cancel();
  };
  options.ipcMain.on(nativeGlobalDialogEventChannel, event);
  parent.on('resize', sync);
  parent.contentView.on('bounds-changed', sync);
  parent.on('hide', cancel);
  parent.on('minimize', cancel);
  parent.on('focus', focusOverlay);
  parent.webContents.on('did-start-navigation', rootNavigation);
  parent.webContents.on('render-process-gone', cancel);
  parent.webContents.on('destroyed', cancel);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    cancel();
    options.ipcMain.off(nativeGlobalDialogEventChannel, event);
    parent.off('resize', sync);
    parent.contentView.off('bounds-changed', sync);
    parent.off('hide', cancel);
    parent.off('minimize', cancel);
    parent.off('focus', focusOverlay);
    parent.off('closed', dispose);
    parent.webContents.off('did-start-navigation', rootNavigation);
    parent.webContents.off('render-process-gone', cancel);
    parent.webContents.off('destroyed', cancel);
    for (const remove of protectedContents.values()) remove();
    protectedContents.clear();
    destroyView();
  };
  parent.once('closed', dispose);
  return {
    active() {
      return !!pending;
    },
    dismiss: cancel,
    prewarm() {
      void prepare().catch(() => {});
    },
    syncTheme() {
      if (pending) {
        pending.state = { ...pending.state, theme: options.theme() };
        send(pending.state);
      }
    },
    confirm(content: NativeGlobalDialogContent, signal: AbortSignal): Promise<boolean> {
      if (signal.aborted) return Promise.resolve(false);
      if (disposed || parent.isDestroyed() || !parent.isVisible() || parent.isMinimized())
        return Promise.reject(Error('native_global_dialog_unavailable'));
      if (pending) return Promise.reject(Error('native_global_dialog_busy'));
      const focused = parent.contentView.children.find(
        (child) =>
          'webContents' in child &&
          !(child.webContents as WebContents).isDestroyed() &&
          (child.webContents as WebContents).isFocused(),
      );
      const previous =
        focused && 'webContents' in focused
          ? (focused.webContents as WebContents)
          : parent.webContents;
      const frame = previous?.mainFrame;
      return new Promise<boolean>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>;
        const state: Exclude<NativeGlobalDialogState, null> = {
          ...content,
          requestId: randomUUID(),
          theme: options.theme(),
        };
        const abort = () => finish(false);
        const finish = (confirmed: boolean, error?: Error) => {
          if (pending?.state.requestId !== state.requestId) return;
          pending = undefined;
          try {
            if (!parent.webContents.isDestroyed())
              parent.webContents.send(nativeGlobalDialogActiveChannel, false);
          } catch {}
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          try {
            if (!parent.isDestroyed()) view?.setVisible(false);
            send(null);
          } catch {}
          if (
            previous &&
            !previous.isDestroyed() &&
            previous.mainFrame === frame &&
            !parent.isDestroyed() &&
            parent.isFocused() &&
            parent.isVisible() &&
            !parent.isMinimized() &&
            parent.contentView.children.some(
              (child) =>
                'webContents' in child && child.webContents === previous && child.getVisible(),
            )
          )
            try {
              focusInWindow(previous);
            } catch {}
          if (error) reject(error);
          else resolve(confirmed && !signal.aborted);
        };
        pending = { state, presented: false, finish };
        try {
          parent.webContents.send(nativeGlobalDialogActiveChannel, true);
          if (view) {
            sync();
            view.setVisible(true);
            focusInWindow(view.webContents);
          } else {
            // No event turn elapses before prepare installs the native overlay.
            focusInWindow(parent.webContents);
          }
        } catch {
          finish(false, Error('native_global_dialog_unavailable'));
          return;
        }
        signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => {
          if (!pending?.presented) finish(false, Error('native_global_dialog_unavailable'));
        }, 6000);
        void prepare()
          .then(() => {
            if (pending?.state.requestId === state.requestId && !signal.aborted) {
              sync();
              // A hidden Chromium view may suspend rAF. The empty view is fully
              // transparent; admit rendering before waiting for the dialog commit.
              view!.setVisible(true);
              focusInWindow(view!.webContents);
              send(pending.state);
            }
          })
          .catch(() => finish(false, Error('native_global_dialog_unavailable')));
      });
    },
    dispose,
  };
}
