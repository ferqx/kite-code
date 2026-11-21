import type { IpcMainEvent, View, WebContents, WebContentsView } from 'electron';
import {
  focusNativeWindowContent,
  keepNativeOverlayOnTop,
  reserveNativeOverlay,
} from './native-overlay-layer';
import type { NativeRootWindow } from './native-root-window';

/** Shared transparent native modal mechanics. Authority remains in each typed host. */
export function createNativeModalSurface(options: {
  window: NativeRootWindow;
  url: string;
  createView(): WebContentsView;
  priority: number;
  activeChannel: string;
  unavailable: string;
  cancel(): void;
  unavailableError(error: Error): void;
  retainOnHide?: boolean;
}) {
  const parent = options.window;
  const content = parent.contentView;
  const root = parent.webContents;
  let view: WebContentsView | undefined;
  let release: (() => void) | undefined;
  let preparing: Promise<void> | undefined;
  let ready: (() => void) | undefined;
  let initialized = false;
  let active = false;
  let disposed = false;
  let previous: { contents: WebContents; frame: WebContents['mainFrame'] } | undefined;
  const protectedContents = new Map<WebContents, () => void>();
  const focus = () => {
    if (active && !parent.isDestroyed() && parent.isFocused())
      focusNativeWindowContent(parent, root);
  };
  const sync = () => {
    if (!view || parent.isDestroyed() || view.webContents.isDestroyed()) return;
    const [width = 0, height = 0] = parent.getContentSize();
    const bounds = view.getBounds();
    if (bounds.x !== 0 || bounds.y !== 0 || bounds.width !== width || bounds.height !== height)
      view.setBounds({ x: 0, y: 0, width, height });
    const zoom = root.getZoomFactor();
    if (view.webContents.getZoomFactor() !== zoom) view.webContents.setZoomFactor(zoom);
    keepNativeOverlayOnTop(parent);
  };
  const protect = (child: View) => {
    if (!('webContents' in child) || child === view) return;
    const contents = child.webContents as WebContents;
    if (!contents || contents.isDestroyed() || protectedContents.has(contents)) return;
    const block = (event: { preventDefault(): void }) => {
      if (active) event.preventDefault();
    };
    // Native hit testing fences people. Authorized Page CDP input remains independent.
    if (contents === root) {
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
  const destroy = () => {
    const current = view;
    view = undefined;
    preparing = undefined;
    ready = undefined;
    initialized = false;
    release?.();
    release = undefined;
    if (current) {
      if (!parent.isDestroyed()) content.removeChildView(current);
      if (!current.webContents.isDestroyed())
        current.webContents.close({ waitForBeforeUnload: false });
    }
  };
  const prepare = () => {
    if (preparing) return preparing;
    let created: WebContentsView | undefined;
    const work = (async () => {
      if (disposed || parent.isDestroyed()) throw Error(options.unavailable);
      const current = options.createView();
      created = current;
      view = current;
      current.setBackgroundColor('#00000000');
      current.setVisible(active);
      release = reserveNativeOverlay(parent, {
        view: current,
        priority: options.priority,
        active: () => active && current.getVisible(),
        protect,
      });
      sync();
      focus();
      const contents = current.webContents;
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      contents.on('will-navigate', (event) => event.preventDefault());
      contents.on('will-attach-webview', (event) => event.preventDefault());
      const failed = () => {
        if (view !== current) return;
        options.unavailableError(Error(options.unavailable));
        destroy();
      };
      contents.on('render-process-gone', failed);
      contents.on('destroyed', failed);
      contents.on('did-start-navigation', (details, _url, _inPlace, mainFrame) => {
        if (initialized && (details.isMainFrame || mainFrame)) failed();
      });
      const initializedPromise = new Promise<void>((resolve) => {
        ready = resolve;
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all([contents.loadURL(options.url), initializedPromise]),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(Error(options.unavailable)), 5000);
          }),
        ]);
        if (view !== current || contents.isDestroyed() || disposed)
          throw Error(options.unavailable);
      } catch (error) {
        if (view === current) destroy();
        throw error;
      } finally {
        clearTimeout(timer);
      }
    })().catch((error) => {
      if (created && view === created) destroy();
      if (preparing === work) preparing = undefined;
      throw error;
    });
    preparing = work;
    return work;
  };
  const setActive = (value: boolean) => {
    if (value === active) return;
    active = value;
    if (value) {
      const focused = content.children.find(
        (child) =>
          'webContents' in child &&
          !(child.webContents as WebContents).isDestroyed() &&
          (child.webContents as WebContents).isFocused(),
      );
      const contents =
        focused && 'webContents' in focused ? (focused.webContents as WebContents) : root;
      previous = { contents, frame: contents.mainFrame };
    }
    try {
      if (!root.isDestroyed()) root.send(options.activeChannel, value);
    } catch {}
    if (value) {
      if (view) {
        sync();
        view.setVisible(true);
        focus();
      }
    } else {
      try {
        if (!parent.isDestroyed()) view?.setVisible(false);
      } catch {}
      const saved = previous;
      previous = undefined;
      if (
        saved &&
        !saved.contents.isDestroyed() &&
        saved.contents.mainFrame === saved.frame &&
        !parent.isDestroyed() &&
        parent.isFocused() &&
        parent.isVisible() &&
        !parent.isMinimized() &&
        content.children.some(
          (child) =>
            'webContents' in child && child.webContents === saved.contents && child.getVisible(),
        )
      )
        try {
          focusNativeWindowContent(parent, saved.contents);
        } catch {}
    }
  };
  const cancel = () => options.cancel();
  const rootNavigation = (
    details: { isMainFrame?: boolean },
    _url: string,
    _inPlace: boolean,
    mainFrame: boolean,
  ) => {
    if (details.isMainFrame || mainFrame) cancel();
  };
  parent.on('resize', sync);
  content.on('bounds-changed', sync);
  if (!options.retainOnHide) {
    parent.on('hide', cancel);
    parent.on('minimize', cancel);
  }
  parent.on('focus', focus);
  root.on('did-start-navigation', rootNavigation);
  root.on('render-process-gone', cancel);
  root.on('destroyed', cancel);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    cancel();
    setActive(false);
    parent.off('resize', sync);
    content.off('bounds-changed', sync);
    parent.off('hide', cancel);
    parent.off('minimize', cancel);
    parent.off('focus', focus);
    parent.off('closed', dispose);
    root.off('did-start-navigation', rootNavigation);
    root.off('render-process-gone', cancel);
    root.off('destroyed', cancel);
    for (const remove of protectedContents.values()) remove();
    protectedContents.clear();
    destroy();
  };
  parent.once('closed', dispose);
  return {
    prepare,
    sync,
    setActive,
    dispose,
    available: () =>
      !disposed && !parent.isDestroyed() && parent.isVisible() && !parent.isMinimized(),
    accepts(event: Pick<IpcMainEvent, 'sender' | 'senderFrame'>) {
      const contents = view?.webContents;
      return (
        !disposed &&
        !!contents &&
        !contents.isDestroyed() &&
        !parent.isDestroyed() &&
        event.sender === contents &&
        event.senderFrame === contents.mainFrame &&
        event.senderFrame?.url === options.url
      );
    },
    initialized() {
      initialized = true;
      ready?.();
    },
    isReady: () => initialized,
    send(channel: string, state: unknown) {
      if (view && !view.webContents.isDestroyed()) view.webContents.send(channel, state);
    },
    present() {
      if (active && view) {
        sync();
        view.setVisible(true);
        focus();
      }
    },
  };
}

/** IPC DTOs must have only ordinary own data properties, never accessors or prototypes. */
export function nativeModalRecord(input: unknown): input is Record<string, unknown> {
  return (
    !!input &&
    typeof input === 'object' &&
    !Array.isArray(input) &&
    Object.getPrototypeOf(input) === Object.prototype &&
    Reflect.ownKeys(input).every(
      (key) =>
        typeof key === 'string' &&
        !!Object.getOwnPropertyDescriptor(input, key) &&
        'value' in Object.getOwnPropertyDescriptor(input, key)!,
    )
  );
}
