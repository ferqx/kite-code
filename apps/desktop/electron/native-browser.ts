import { randomUUID } from 'node:crypto';
import { type BrowserWindow, type IpcMain, session, WebContentsView } from 'electron';
import {
  browserAddress,
  type NativeBrowserBounds,
  type NativeBrowserReply,
  type NativeBrowserState,
  nativeBrowserChannel,
  nativeBrowserEventChannel,
  parseNativeBrowserRequest,
} from '../src/native-browser-bridge';
import { assertNativeSender } from './native-ipc';

type BrowserTab = {
  view: WebContentsView;
  state: NativeBrowserState;
  generation: number;
  notification?: ReturnType<typeof setTimeout>;
};
function httpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}
function webSocketUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ['ws:', 'wss:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Isolated, memory-only browsing; no Service caller, app preload or external protocol handoff. */
export function registerNativeBrowserIpc(options: {
  readonly ipcMain: IpcMain;
  readonly window: BrowserWindow;
  readonly rendererUrl: string;
}): () => void {
  const { window, ipcMain, rendererUrl } = options;
  const owner = window.webContents;
  const browsing = session.fromPartition(`kite-sidebar-browser-${randomUUID()}`, { cache: false });
  const tabs = new Map<string, BrowserTab>();
  let active: string | undefined;
  let disposed = false;
  browsing.setPermissionRequestHandler((_contents, _permission, complete) => complete(false));
  browsing.setPermissionCheckHandler(() => false);
  browsing.webRequest.onBeforeRequest((details, complete) => {
    const allowed =
      httpUrl(details.url) ||
      (details.resourceType === 'webSocket' && webSocketUrl(details.url)) ||
      /^(?:data:|blob:|about:blank$)/i.test(details.url);
    complete({ cancel: !allowed });
  });
  const publish = (tab: BrowserTab) => {
    if (disposed || tabs.get(tab.state.id) !== tab || tab.view.webContents.isDestroyed()) return;
    tab.state = {
      ...tab.state,
      canGoBack: tab.view.webContents.navigationHistory.canGoBack(),
      canGoForward: tab.view.webContents.navigationHistory.canGoForward(),
    };
    if (tab.notification !== undefined) return;
    tab.notification = setTimeout(() => {
      tab.notification = undefined;
      if (!disposed && tabs.get(tab.state.id) === tab && !window.isDestroyed())
        window.webContents.send(nativeBrowserEventChannel, tab.state);
    }, 16);
  };
  const hide = () => {
    for (const tab of tabs.values()) tab.view.setVisible(false);
    active = undefined;
  };
  const close = (id: string) => {
    const tab = tabs.get(id);
    if (!tab) return;
    tabs.delete(id);
    if (tab.notification !== undefined) clearTimeout(tab.notification);
    if (active === id) active = undefined;
    if (!window.isDestroyed()) window.contentView.removeChildView(tab.view);
    if (!tab.view.webContents.isDestroyed())
      tab.view.webContents.close({ waitForBeforeUnload: false });
  };
  const clear = () => {
    for (const id of [...tabs.keys()]) close(id);
  };
  const navigate = (tab: BrowserTab, url: string) => {
    const generation = ++tab.generation;
    tab.state = {
      ...tab.state,
      url,
      title: new URL(url).hostname,
      loading: true,
      error: undefined,
    };
    publish(tab);
    void tab.view.webContents.loadURL(url).catch(() => {
      if (
        disposed ||
        generation !== tab.generation ||
        tab.view.webContents.isDestroyed() ||
        !tabs.has(tab.state.id)
      )
        return;
      tab.state = { ...tab.state, loading: false, error: 'load_failed' };
      publish(tab);
    });
  };
  const create = (id: string): BrowserTab => {
    if (tabs.size >= 8) throw Error('browser_tab_limit');
    const view = new WebContentsView({
      webPreferences: {
        session: browsing,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
        devTools: false,
        safeDialogs: true,
        disableDialogs: true,
        navigateOnDragDrop: false,
      },
    });
    view.setVisible(false);
    window.contentView.addChildView(view);
    const tab: BrowserTab = {
      view,
      generation: 0,
      state: {
        id,
        url: '',
        title: '新标签页',
        loading: false,
        canGoBack: false,
        canGoForward: false,
      },
    };
    tabs.set(id, tab);
    const contents = view.webContents;
    contents.setWindowOpenHandler(({ url }) => {
      if (httpUrl(url)) navigate(tab, url);
      return { action: 'deny' };
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.on('will-frame-navigate', (event) => {
      if (
        httpUrl(event.url) ||
        (!event.isMainFrame && /^(?:about:blank$|data:|blob:)/i.test(event.url))
      )
        return;
      event.preventDefault();
      if (event.isMainFrame) {
        tab.state = { ...tab.state, error: 'unsupported_navigation' };
        publish(tab);
      }
    });
    contents.on('will-redirect', (event, url) => {
      if (httpUrl(url)) return;
      event.preventDefault();
      tab.state = { ...tab.state, loading: false, error: 'unsupported_navigation' };
      publish(tab);
    });
    contents.on('did-start-loading', () => {
      tab.state = { ...tab.state, loading: true, error: undefined };
      publish(tab);
    });
    contents.on('did-stop-loading', () => {
      tab.state = { ...tab.state, loading: false };
      publish(tab);
    });
    const location = () => {
      const url = contents.getURL();
      if (httpUrl(url)) tab.state = { ...tab.state, url: url.slice(0, 8192) };
      publish(tab);
    };
    contents.on('did-navigate', location);
    contents.on('did-navigate-in-page', location);
    contents.on('page-title-updated', (_event, title) => {
      tab.state = { ...tab.state, title: title.slice(0, 128) || new URL(tab.state.url).hostname };
      publish(tab);
    });
    contents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
      if (!mainFrame || code === -3) return;
      tab.state = { ...tab.state, loading: false, error: 'load_failed' };
      publish(tab);
    });
    contents.on('render-process-gone', () => {
      tab.view.setVisible(false);
      tab.state = { ...tab.state, loading: false, error: 'process_gone' };
      publish(tab);
    });
    return tab;
  };
  const present = (id: string, bounds: NativeBrowserBounds | null) => {
    const tab = tabs.get(id);
    if (!tab) return;
    if (!bounds) {
      tab.view.setVisible(false);
      if (active === id) active = undefined;
      return;
    }
    const zoom = window.webContents.getZoomFactor();
    const [width = 0, height = 0] = window.getContentSize();
    const x = Math.max(0, Math.min(width, Math.round(bounds.x * zoom)));
    const y = Math.max(0, Math.min(height, Math.round(bounds.y * zoom)));
    const right = Math.min(width, Math.round((bounds.x + bounds.width) * zoom));
    const bottom = Math.min(height, Math.round((bounds.y + bounds.height) * zoom));
    if (right <= x || bottom <= y) {
      tab.view.setVisible(false);
      return;
    }
    for (const [otherId, other] of tabs) if (otherId !== id) other.view.setVisible(false);
    active = id;
    tab.view.setBounds({ x, y, width: right - x, height: bottom - y });
    tab.view.setBorderRadius(
      Math.floor(Math.min(Math.round(bounds.radius * zoom), (right - x) / 2, (bottom - y) / 2)),
    );
    tab.view.setVisible(window.isVisible() && !window.isMinimized());
  };
  const download = (
    event: Electron.Event,
    _item: Electron.DownloadItem,
    contents: Electron.WebContents,
  ) => {
    event.preventDefault();
    for (const tab of tabs.values())
      if (tab.view.webContents === contents) {
        tab.state = { ...tab.state, loading: false, error: 'download_unsupported' };
        publish(tab);
      }
  };
  browsing.on('will-download', download);
  ipcMain.handle(nativeBrowserChannel, (event, value): NativeBrowserReply => {
    try {
      assertNativeSender(event, disposed ? undefined : window, rendererUrl);
      const request = parseNativeBrowserRequest(value);
      if (request.action === 'close') {
        close(request.id);
        return { ok: true, value: null };
      }
      let tab = tabs.get(request.id);
      if (request.action === 'navigate') {
        const url = browserAddress(request.input);
        tab ??= create(request.id);
        navigate(tab, url);
      } else if (request.action === 'present') present(request.id, request.bounds);
      else if (tab) {
        const contents = tab.view.webContents;
        if (['back', 'forward', 'reload', 'stop'].includes(request.action)) tab.generation++;
        if (request.action === 'back' && contents.navigationHistory.canGoBack())
          contents.navigationHistory.goBack();
        if (request.action === 'forward' && contents.navigationHistory.canGoForward())
          contents.navigationHistory.goForward();
        if (request.action === 'reload') contents.reload();
        if (request.action === 'stop') contents.stop();
        publish(tab);
      }
      return { ok: true, value: tab?.state ?? null };
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : '';
      return {
        ok: false,
        code: [
          'native_sender_denied',
          'invalid_browser_request',
          'invalid_browser_address',
          'unsupported_browser_protocol',
          'browser_tab_limit',
        ].includes(code)
          ? code
          : 'browser_unavailable',
      };
    }
  });
  const navigation = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => {
    if (mainFrame && !inPlace) clear();
  };
  owner.on('did-start-navigation', navigation);
  owner.on('render-process-gone', clear);
  window.on('resize', hide);
  window.on('hide', hide);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clear();
    ipcMain.removeHandler(nativeBrowserChannel);
    browsing.webRequest.onBeforeRequest(null);
    browsing.off('will-download', download);
    browsing.setPermissionRequestHandler(null);
    browsing.setPermissionCheckHandler(null);
    owner.off('did-start-navigation', navigation);
    owner.off('render-process-gone', clear);
    window.off('resize', hide);
    window.off('hide', hide);
  };
  window.once('closed', dispose);
  return dispose;
}
