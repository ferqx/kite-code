import { createHash, randomUUID } from 'node:crypto';
import * as electron from 'electron';
import { type IpcMain, session, WebContentsView } from 'electron';
import {
  browserAddress,
  type NativeBrowserBounds,
  type NativeBrowserLayout,
  type NativeBrowserMenuAction,
  type NativeBrowserReply,
  type NativeBrowserRequest,
  type NativeBrowserRestoreScope,
  type NativeBrowserState,
  nativeBrowserChannel,
  nativeBrowserEventChannel,
  nativeBrowserLayoutChannel,
  nativeBrowserMenuCancelChannel,
  nativeBrowserMenuChannel,
  nativeBrowserPresentationChannel,
  parseNativeBrowserMenuRequest,
  parseNativeBrowserRequest,
  projectNativeBrowserBounds,
  projectNativeBrowserLayout,
} from '../src/native-browser-bridge';
import { createBrowserAnnotationStyle } from './browser-annotation-style';
import { browserDecorationScript } from './browser-decoration';
import { createBrowserDocumentReady } from './browser-document-ready';
import { createBrowserInputShield } from './browser-input-shield';
import type { BrowserPageScope } from './browser-lease';
import { browserLoadFailure } from './browser-load-failure';
import { createBrowserNavigation } from './browser-navigation';
import { BrowserPagePreflightError, type NativeBrowserPageHost } from './browser-page-host';
import { createBrowserPaneFrame } from './browser-pane-frame';
import { browserTypingCursorScript } from './browser-typing-cursor';
import { assertNativeSender } from './native-ipc';
import { addNativeWindowView } from './native-overlay-layer';
import { type NativeRootWindow as BrowserWindow, onNativeRootWillShow } from './native-root-window';

type BrowserTab = {
  view: WebContentsView;
  state: NativeBrowserState;
  generation: number;
  documentNavigation: number;
  documentGeneration: number;
  notification?: ReturnType<typeof setTimeout>;
  unregister?: () => void;
  disposeDocument?: () => void;
  waitForDisplayDocument?: (signal: AbortSignal) => Promise<boolean>;
  unprotect?: () => void;
  scope?: BrowserPageScope;
  draft?: { key: string; frame: Electron.WebFrameMain; epoch: number };
  bootstrapping?: boolean;
  initialization?: Promise<void>;
  sizeEpoch: number;
  borderRadius?: number;
  presentation?: {
    bounds: NativeBrowserBounds;
    layout?: NativeBrowserLayout;
  };
  presentationScope?: NativeBrowserRestoreScope;
  nativeProjection?: {
    source: NonNullable<BrowserTab['presentation']>;
    bounds: NativeBrowserBounds;
    layout: NativeBrowserLayout;
  };
  resume?: {
    token: string;
    root: Electron.WebFrameMain;
    contents: Electron.WebContents;
    frame: Electron.WebFrameMain;
    document: number;
    geometry: string;
    presentation: NonNullable<BrowserTab['presentation']>;
    scope?: NativeBrowserRestoreScope;
    confirmed: boolean;
  };
  drawable?: { frame: Electron.WebFrameMain; document: number };
  paint?: {
    controller: AbortController;
    token: string;
    frame: Electron.WebFrameMain;
    bounds: Electron.Rectangle;
    geometry: string;
    underlay?: boolean;
    stopFrame?: () => void;
    restoreThrottling?: () => void;
  };
};
/** Only coherent current two-Panel Groups may establish a resize anchor.
 * Nested content frames retain their measured platform-specific margins.
 * CSS handles occupy 0..1px; one CSS pixel covers measurement rounding, not gutters. */
function currentPanelMeasurement(
  layout: NativeBrowserLayout,
  width: number,
  height: number,
): boolean {
  if (Math.abs(layout.windowWidth - width) > 1 || Math.abs(layout.windowHeight - height) > 1)
    return false;
  let parentWidth = layout.windowWidth;
  for (const group of layout.groups) {
    if (
      (group === layout.groups[0] && (group.left > 1 || group.right > 1)) ||
      group.gap > 2 ||
      Math.abs(
        group.left +
          group.panels[0].size +
          group.gap +
          group.panels[1].size +
          group.right -
          parentWidth,
      ) > 1
    )
      return false;
    parentWidth = group.panels[1].size;
  }
  return true;
}
function assertPanelMeasurement(
  bounds: NativeBrowserBounds,
  layout: NativeBrowserLayout,
  width: number,
  height: number,
): void {
  if (!currentPanelMeasurement(layout, width, height)) throw Error('invalid_browser_request');
  const measured = projectNativeBrowserBounds(
    bounds,
    layout,
    layout.windowWidth,
    layout.windowHeight,
  );
  if (
    !measured ||
    Math.abs(measured.x - bounds.x) > 1 ||
    Math.abs(measured.width - bounds.width) > 1
  )
    throw Error('invalid_browser_request');
}
function sameRectangle(a: Electron.Rectangle, b: Electron.Rectangle): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
function fullFrameMatches(image: Electron.NativeImage, bounds: Electron.Rectangle): boolean {
  const size = image.getSize();
  return (
    !image.isEmpty() &&
    [size.width, size.height].every(Number.isFinite) &&
    size.width >= bounds.width &&
    size.height >= bounds.height &&
    Math.abs(size.height - (size.width / bounds.width) * bounds.height) <= 2
  );
}
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

/** Fixed application UI; Main owns the exact, isolated real pages and native geometry. */
export function registerNativeBrowserIpc(options: {
  readonly ipcMain: IpcMain;
  readonly window: BrowserWindow;
  readonly rendererUrl: string;
  readonly automation?: NativeBrowserPageHost;
  readonly selectedScope?: () =>
    | (BrowserPageScope & { generation?: number; viewSelection?: number })
    | undefined;
  readonly grantScope?: () =>
    | (BrowserPageScope & { generation?: number; viewSelection?: number })
    | undefined;
}): () => void {
  const { window, ipcMain, rendererUrl, automation } = options;
  const owner = window.webContents;
  const browsing = session.fromPartition(`kite-sidebar-browser-${randomUUID()}`, { cache: false });
  const tabs = new Map<string, BrowserTab>();
  const lastPresented = new Map<string, string>();
  const replacedPresentation = new Map<string, string>();
  let active: string | undefined;
  let disposed = false;
  let rootEpoch = 0;
  let visibilityEpoch = 0;
  // A Root document has one ordered layout stream across all pages, including
  // withdrawals. An old async positive measurement cannot beat a newer hide.
  let layoutRevision = 0;
  const scopeKey = (scope: BrowserPageScope) => JSON.stringify([scope.storeId, scope.sessionId]);
  const pageToken = (tab: BrowserTab) =>
    JSON.stringify([
      tab.state.id,
      tab.view.webContents.id,
      tab.generation,
      tab.documentNavigation,
      rootEpoch,
      visibilityEpoch,
      automation?.state(tab.state.id)?.incarnation,
      automation?.state(tab.state.id)?.navigation,
    ]);
  const draftCurrent = (tab: BrowserTab, key: string | undefined) =>
    !!key &&
    tab.draft?.key === key &&
    tab.draft.epoch === rootEpoch &&
    tab.draft.frame === owner.mainFrame &&
    !owner.isDestroyed() &&
    !tab.scope &&
    tabs.get(tab.state.id) === tab &&
    !!tab.view.webContents &&
    !tab.view.webContents.isDestroyed();
  const scopeCurrent = (tab: BrowserTab, scope = tab.presentationScope) => {
    if (tab.draft) return draftCurrent(tab, tab.draft.key);
    const selected = (options.grantScope ?? options.selectedScope)?.();
    return (
      !!scope &&
      !!selected &&
      !!tab.scope &&
      tab.scope.storeId === scope.storeId &&
      tab.scope.sessionId === scope.sessionId &&
      (['storeId', 'sessionId', 'generation', 'viewSelection'] as const).every(
        (key) => selected[key] === scope[key],
      )
    );
  };
  const inputBlocked = (id: string) => {
    const phase = automation?.state(id)?.phase;
    return phase !== undefined && !['human', 'armed'].includes(phase);
  };
  const rootView = () =>
    window.contentView.children.find(
      (view) => 'webContents' in view && view.webContents === owner,
    ) as WebContentsView | undefined;
  const coveredByRoot = (tab: BrowserTab) => {
    const root = rootView(),
      children = window.contentView.children,
      [width = 0, height = 0] = window.getContentSize();
    return (
      !!root &&
      root.getVisible() &&
      sameRectangle(root.getBounds(), { x: 0, y: 0, width, height }) &&
      children.indexOf(tab.view) >= 0 &&
      children.indexOf(tab.view) < children.indexOf(root)
    );
  };
  const promotePage = (tab: BrowserTab) => {
    const root = rootView();
    if (!root) throw Error('browser_presentation_unavailable');
    const children = window.contentView.children,
      rootIndex = children.indexOf(root),
      pageIndex = children.indexOf(tab.view);
    if (pageIndex < 0) throw Error('browser_presentation_unavailable');
    // Retained pages already above Root keep their native sibling position.
    // Only a new document prepared below Root needs an actual promotion.
    if (pageIndex < rootIndex) addNativeWindowView(window, tab.view, rootIndex);
  };
  const paneFrame = createBrowserPaneFrame(window);
  const inputShield = createBrowserInputShield(window, () => {
    for (const tab of tabs.values())
      if (inputBlocked(tab.state.id)) {
        tab.view.setVisible(false);
        automation?.present(tab.state.id, false);
      }
    inputShield.hide();
  });
  const syncInput = () => {
    const tab = active ? tabs.get(active) : undefined;
    // A first document paints below the complete application Root. Root itself
    // receives human input there; a shield must not rise above the loading UI.
    if (tab?.paint?.underlay && coveredByRoot(tab)) {
      inputShield.hide();
      return;
    }
    if (tab && inputBlocked(tab.state.id) && !inputShield.available()) {
      tab.view.setVisible(false);
      automation?.present(tab.state.id, false);
      inputShield.hide();
      return;
    }
    inputShield.sync(tab?.view, !!tab && inputBlocked(tab.state.id));
  };
  let menu: { id: string; pageId: string; current(): boolean; close(): void } | undefined;
  let menuEscapeHeld = false;
  const cancelMenu = (pageId?: string) => {
    if (menu && (!pageId || menu.pageId === pageId)) menu.close();
  };
  const menuInput = (event: Electron.Event, input: Electron.Input) => {
    if (input.key !== 'Escape') return;
    if (input.type === 'keyUp') {
      if (menuEscapeHeld) event.preventDefault();
      menuEscapeHeld = false;
      return;
    }
    if (input.type !== 'keyDown') return;
    if (menu && !menu.current()) cancelMenu();
    if (!menu && !menuEscapeHeld) return;
    event.preventDefault();
    menuEscapeHeld = true;
    cancelMenu();
  };
  const resetMenuInput = () => {
    menuEscapeHeld = false;
  };
  owner.on('before-input-event', menuInput);
  window.on('blur', resetMenuInput);
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
    if (
      disposed ||
      tabs.get(tab.state.id) !== tab ||
      !tab.view.webContents ||
      tab.view.webContents.isDestroyed()
    )
      return;
    tab.state = {
      ...tab.state,
      pageToken: pageToken(tab),
      ...(tab.scope && automation?.state(tab.state.id)
        ? { control: automation.state(tab.state.id) }
        : {}),
      canGoBack: tab.view.webContents.navigationHistory.canGoBack(),
      canGoForward: tab.view.webContents.navigationHistory.canGoForward(),
    };
    if (tab.state.error) {
      cancelPaint(tab);
      tab.view.setVisible(false);
      if (active === tab.state.id) paneFrame.hide();
      automation?.present(tab.state.id, false);
    }
    syncInput();
    if (tab.notification !== undefined) return;
    tab.notification = setTimeout(() => {
      tab.notification = undefined;
      if (!disposed && tabs.get(tab.state.id) === tab && !window.isDestroyed())
        owner.send(nativeBrowserEventChannel, tab.state);
    }, 16);
  };
  const cancelPaint = (tab: BrowserTab) => {
    const job = tab.paint;
    tab.paint = undefined;
    job?.controller.abort();
    job?.stopFrame?.();
    job?.restoreThrottling?.();
  };
  const withdraw = (tab: BrowserTab) => {
    cancelPaint(tab);
    cancelMenu(tab.state.id);
    tab.sizeEpoch++;
    delete tab.presentation;
    delete tab.nativeProjection;
    delete tab.presentationScope;
    delete tab.resume;
    if (tab.view.webContents?.isFocused() && !owner.isDestroyed()) owner.focus();
    tab.view.setVisible(false);
    automation?.present(tab.state.id, false);
    if (active === tab.state.id) {
      active = undefined;
      paneFrame.hide();
    }
    syncInput();
  };
  const suspendWindow = () => {
    // Native visibility notifications may outlive the ordering operation that
    // produced them. A late hide must not retire a newly visible page/shield.
    if (disposed || window.isDestroyed() || window.isVisible() || window.isMinimized()) return;
    const selected = active ? tabs.get(active) : undefined;
    visibilityEpoch++;
    for (const tab of tabs.values()) {
      const contents = tab.view.webContents;
      if (
        tab !== selected ||
        !tab.presentation ||
        !contents ||
        contents.isDestroyed() ||
        !tab.view.getVisible() ||
        !scopeCurrent(tab) ||
        tab.drawable?.frame !== contents.mainFrame ||
        tab.drawable.document !== tab.documentGeneration
      ) {
        withdraw(tab);
        continue;
      }
      // The hidden parent already removes this native surface from the screen.
      // Retire the live binding and screenshot basis, preserving only an exact
      // candidate until this hidden Root confirms its current display intent.
      const presentation = tab.presentation,
        scope = tab.presentationScope;
      cancelPaint(tab);
      cancelMenu(tab.state.id);
      tab.sizeEpoch++;
      delete tab.presentation;
      delete tab.presentationScope;
      delete tab.nativeProjection;
      tab.resume = {
        token: pageToken(tab),
        root: owner.mainFrame,
        contents,
        frame: contents.mainFrame,
        document: tab.documentGeneration,
        geometry: JSON.stringify([...window.getContentSize(), owner.getZoomFactor()]),
        presentation,
        scope,
        confirmed: false,
      };
      automation?.present(tab.state.id, false);
    }
    active = undefined;
    paneFrame.hide();
    inputShield.hide();
    // Hidden Renderer commits still maintain intent using the new token. They
    // never grant a live display or revive the old observation/capture basis.
    for (const tab of tabs.values()) {
      publish(tab);
      if (!owner.isDestroyed()) owner.send(nativeBrowserEventChannel, tab.state);
    }
  };
  const hide = () => {
    visibilityEpoch++;
    for (const tab of tabs.values()) withdraw(tab);
    inputShield.hide();
  };
  const minimize = () => {
    if (!disposed && !window.isDestroyed() && window.isMinimized()) hide();
  };
  const close = (id: string, force = false) => {
    const tab = tabs.get(id);
    if (!tab) return;
    withdraw(tab);
    if (!force && automation?.retained(id)) return;
    // Capture the contents before Electron can clear the View's getter. All
    // teardown callbacks continue to belong to this exact object, never an heir.
    const contents = tab.view.webContents;
    tabs.delete(id);
    tab.disposeDocument?.();
    tab.unregister?.();
    tab.unprotect?.();
    if (tab.scope && lastPresented.get(scopeKey(tab.scope)) === id)
      lastPresented.delete(scopeKey(tab.scope));
    if (tab.scope && replacedPresentation.get(scopeKey(tab.scope)) === id)
      replacedPresentation.delete(scopeKey(tab.scope));
    if (tab.notification !== undefined) clearTimeout(tab.notification);
    if (!window.isDestroyed()) window.contentView.removeChildView(tab.view);
    if (contents && !contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
  };
  const navigate = (tab: BrowserTab, url: string) => {
    cancelPaint(tab);
    delete tab.resume;
    delete tab.drawable;
    tab.view.setVisible(false);
    automation?.present(tab.state.id, false);
    tab.sizeEpoch++;
    const generation = ++tab.generation;
    tab.state = {
      ...tab.state,
      url,
      title: new URL(url).hostname,
      loading: true,
      error: undefined,
      failure: undefined,
      display: 'loading',
    };
    publish(tab);
    const contents = tab.view.webContents;
    void contents.loadURL(url).catch((cause) => {
      if (
        disposed ||
        generation !== tab.generation ||
        contents.isDestroyed() ||
        tabs.get(tab.state.id) !== tab
      )
        return;
      if (cause?.errno === -3) return;
      tab.state = {
        ...tab.state,
        loading: false,
        display: 'failed',
        error: 'load_failed',
        failure: tab.state.failure ?? browserLoadFailure(cause?.errno, cause?.code),
      };
      publish(tab);
    });
  };
  const ensureBlank = (tab: BrowserTab): Promise<void> => {
    if (tab.state.url) return Promise.resolve();
    tab.initialization ??= (async () => {
      const id = tab.state.id,
        contents = tab.view.webContents,
        generation = tab.generation;
      if (contents.getURL() === 'about:blank' && contents.getOSProcessId() > 0) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      tab.bootstrapping = true;
      try {
        // Constructing a WebContentsView does not guarantee a renderer/DOM.
        // This is local initialization after a real grant, not a public URL.
        await Promise.race([
          contents.loadURL('about:blank'),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(Error('browser_page_initialization_failed')), 5000);
          }),
        ]);
        if (
          disposed ||
          tabs.get(id) !== tab ||
          contents.isDestroyed() ||
          tab.generation !== generation ||
          tab.state.url !== '' ||
          contents.getURL() !== 'about:blank' ||
          contents.getOSProcessId() <= 0
        )
          throw Error('browser_page_initialization_failed');
      } finally {
        clearTimeout(timer);
        tab.bootstrapping = false;
      }
    })();
    const pending = tab.initialization;
    void pending
      .finally(() => {
        // Only concurrent callers share initialization. A later Run must recheck
        // the current page process; an earlier failure cannot poison this tab.
        if (tab.initialization === pending) tab.initialization = undefined;
      })
      .catch(() => {});
    return pending;
  };
  const create = (id: string, grantedScope?: BrowserPageScope, draft?: string): BrowserTab => {
    if (tabs.has(id)) throw Error('browser_page_already_exists');
    if (tabs.size >= 8) throw Error('browser_tab_limit');
    automation?.assertCanCreate();
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
        // A controlled page must emit real dialog events for the host-issued
        // dialogRef API. Chromium's disabled-dialog path silently dismisses them.
        disableDialogs: !automation,
        navigateOnDragDrop: false,
      },
    });
    view.setVisible(false);
    // A committed page can execute while its session is in the background,
    // before Renderer has ever presented it. Chromium otherwise starts at 0x0.
    view.setBounds({ x: 0, y: 0, width: 960, height: 540 });
    addNativeWindowView(window, view);
    const tab: BrowserTab = {
      view,
      scope: (() => {
        // A committed proposal already pins its exact owner. Renderer-created
        // tabs still require the ordinary current, ready selection projection.
        const selected = draft ? undefined : (grantedScope ?? options.selectedScope?.());
        return selected ? { storeId: selected.storeId, sessionId: selected.sessionId } : undefined;
      })(),
      ...(draft ? { draft: { key: draft, frame: owner.mainFrame, epoch: rootEpoch } } : {}),
      generation: 0,
      documentNavigation: 0,
      documentGeneration: 0,
      sizeEpoch: 0,
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
    contents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (!mainFrame || inPlace) return;
      cancelPaint(tab);
      delete tab.drawable;
      tab.documentNavigation++;
      tab.documentGeneration++;
      tab.sizeEpoch++;
      tab.view.setVisible(false);
      automation?.present(id, false);
      tab.state = {
        ...tab.state,
        loading: true,
        error: undefined,
        failure: undefined,
        display: 'loading',
      };
      publish(tab);
    });
    contents.on('did-navigate-in-page', (_event, _url, mainFrame) => {
      if (!mainFrame) return;
      cancelPaint(tab);
      tab.documentNavigation++;
      tab.sizeEpoch++;
      publish(tab);
    });
    // Electron 44.3's native dialog manager does not implement Chromium's
    // HandleJavaScriptDialog UI cleanup. Count its per-contents native openings
    // without replacing the ordinary human dialog handler.
    let nativeDialogSequence = 0;
    contents.on('-run-dialog' as never, () => ++nativeDialogSequence);
    contents.on('before-input-event', menuInput);
    tab.unprotect = inputShield.protect(contents, () => inputBlocked(id) || !!tab.paint);
    const documentReady = createBrowserDocumentReady();
    let documentEpoch = 0;
    let readyEpoch: number | undefined = 0;
    let documentUrl: string | undefined;
    let committedFrame: Electron.WebFrameMain | undefined;
    // Display readiness shares the actual document lifecycle, without acquiring
    // an Agent attachment, lease or observation.
    tab.waitForDisplayDocument = async (signal) => {
      const current = () =>
        !disposed &&
        tabs.get(id) === tab &&
        !contents.isDestroyed() &&
        !window.isDestroyed() &&
        electron.BrowserWindow.fromWebContents(contents) === window;
      return (
        (await documentReady.wait(signal, current)) &&
        current() &&
        readyEpoch === documentEpoch &&
        committedFrame === contents.mainFrame &&
        /^https?:/.test(contents.getURL())
      );
    };
    tab.disposeDocument = () => documentReady.dispose();
    contents.on('did-start-navigation', (_event, url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) {
        committedFrame = undefined;
        documentUrl = url;
        documentEpoch = documentReady.start();
        readyEpoch = undefined;
      }
    });
    contents.on('did-redirect-navigation', (_event, url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) documentUrl = url;
    });
    contents.on('did-navigate', (_event, url) => {
      documentUrl = url;
      committedFrame = contents.mainFrame;
      documentReady.commit(documentEpoch);
    });
    contents.on('dom-ready', () => {
      if (committedFrame === contents.mainFrame) {
        readyEpoch = documentEpoch;
        documentReady.ready(documentEpoch);
        if (active === id && tab.presentation) applyCurrentLayout(tab);
      }
    });
    const currentFailure = (
      code: number,
      url: string,
      mainFrame: boolean,
      processId?: number,
      routingId?: number,
    ) =>
      tabs.get(id) === tab &&
      mainFrame &&
      code !== -3 &&
      url === documentUrl &&
      ((processId === undefined && routingId === undefined) ||
        (Number.isSafeInteger(processId) &&
          Number.isSafeInteger(routingId) &&
          contents.mainFrame.processId === processId &&
          contents.mainFrame.routingId === routingId));
    const failedDisplayDocument = (
      _event: unknown,
      code: number,
      _description: string,
      url: string,
      mainFrame: boolean,
      processId?: number,
      routingId?: number,
    ) => {
      if (currentFailure(code, url, mainFrame, processId, routingId)) documentReady.stopped();
    };
    contents.on('did-fail-load', failedDisplayDocument);
    contents.on('did-fail-provisional-load', failedDisplayDocument);
    contents.on('did-stop-loading', () => {
      if (contents.isLoadingMainFrame?.() === false) documentReady.stopped();
    });
    contents.on('render-process-gone', () => documentReady.fail());
    contents.on('destroyed', () => documentReady.dispose());
    if (automation && tab.scope) {
      const navigation = createBrowserNavigation();
      tab.disposeDocument = () => {
        documentReady.dispose();
        navigation.dispose();
      };
      const decorationId = `kite-control-${randomUUID()}`;
      let decoration = { agent: false, visible: false, navigation: 0, cursor: null } as Parameters<
        typeof browserDecorationScript
      >[1];
      let painting = false,
        dirty = false;
      let attachment = 0,
        captureSequence = 0;
      let captureMeta: {
        value: {
          captureId: string;
          sha256: string;
          navigation: number;
          width: number;
          height: number;
          imageWidth: number;
          imageHeight: number;
        };
        metrics: { dpr: number; x: number; y: number };
        current(): boolean;
      } | null = null;
      const annotationStyle = createBrowserAnnotationStyle({
        insertCSS: (css, options) => contents.insertCSS(css, options),
        removeInsertedCSS: (key) =>
          contents.isDestroyed() ? Promise.resolve() : contents.removeInsertedCSS(key),
      });
      const clearStyle = () => {
        captureMeta = null;
        void annotationStyle.clear().catch(() => {
          if (tabs.get(id) === tab) automation.fail(id);
        });
      };
      const paint = () => {
        dirty = true;
        if (painting) return;
        painting = true;
        void (async () => {
          while (dirty && !contents.isDestroyed()) {
            dirty = false;
            await contents.executeJavaScriptInIsolatedWorld(1004, [
              { code: browserDecorationScript(decorationId, decoration) },
            ]);
          }
        })()
          .catch(() => {})
          .finally(() => {
            painting = false;
            // An obsolete world can reject after a newer decoration was queued.
            // Drain that update once; a failure without new input never retries.
            if (dirty && !contents.isDestroyed()) paint();
          });
      };
      tab.unregister = automation.add({
        id,
        scope: tab.scope,
        alive: () => !contents.isDestroyed(),
        async attach() {
          ++attachment;
          captureMeta = null;
          if (automation.state(id)?.phase !== 'acquiring')
            throw Error('browser_page_control_denied');
          await ensureBlank(tab);
          if (automation.state(id)?.phase !== 'acquiring')
            throw Error('browser_page_control_denied');
          await inputShield.prepare();
          syncInput();
          if (!inputShield.available() || automation.state(id)?.phase !== 'acquiring')
            throw Error('browser_input_shield_unavailable');
          if (!contents.debugger.isAttached()) contents.debugger.attach('1.3');
        },
        async detach() {
          documentReady.cancel();
          navigation.cancel();
          ++attachment;
          captureMeta = null;
          try {
            await annotationStyle.clear();
          } finally {
            captureMeta = null;
            if (!contents.isDestroyed() && contents.debugger.isAttached())
              contents.debugger.detach();
          }
          if (contents.isDestroyed()) return true;
          return !contents.debugger.isAttached();
        },
        async waitForDocument(signal) {
          const binding = automation.state(id),
            attached = attachment;
          const current = () => {
            const now = automation.state(id);
            return (
              !disposed &&
              tabs.get(id) === tab &&
              !contents.isDestroyed() &&
              !window.isDestroyed() &&
              electron.BrowserWindow.fromWebContents(contents) === window &&
              contents.debugger.isAttached() &&
              attached === attachment &&
              binding?.phase === 'agent' &&
              now?.phase === 'agent' &&
              now.incarnation === binding.incarnation &&
              now.browserId === binding.browserId &&
              now.sessionId === binding.sessionId &&
              now.navigation === binding.navigation
            );
          };
          return (await documentReady.wait(signal, current)) && current();
        },
        async navigate(url, signal, beforeDispatch) {
          const binding = automation.state(id),
            attached = attachment;
          const current = () => {
            const now = automation.state(id);
            return (
              !disposed &&
              tabs.get(id) === tab &&
              tab.view.webContents === contents &&
              contents !== window.webContents &&
              !contents.isDestroyed() &&
              !window.isDestroyed() &&
              electron.BrowserWindow.fromWebContents(contents) === window &&
              contents.debugger.isAttached() &&
              attachment === attached &&
              binding?.phase === 'agent' &&
              now?.phase === 'agent' &&
              now.sessionId === binding.sessionId &&
              now.incarnation === binding.incarnation &&
              now.browserId === binding.browserId
            );
          };
          await navigation.run({
            url: new URL(url).href,
            epoch: documentEpoch,
            ready: readyEpoch === documentEpoch,
            signal,
            current,
            actualUrl: () => contents.getURL(),
            dispatch: () => {
              if (!current()) throw Error('browser_page_navigation_stale');
              signal?.throwIfAborted();
              beforeDispatch();
              return contents.debugger.sendCommand('Page.navigate', { url });
            },
          });
          const expectedNavigation = automation.state(id)?.navigation;
          const completed = () =>
            !signal?.aborted &&
            current() &&
            automation.state(id)?.navigation === expectedNavigation;
          if (!completed() || expectedNavigation === undefined)
            throw Error('browser_page_navigation_stale');
          return { navigation: expectedNavigation, current: completed };
        },
        async send(method, params) {
          if (method === 'Page.handleJavaScriptDialog') {
            const binding = automation.state(id),
              attached = attachment,
              dialogSequence = nativeDialogSequence;
            const current = () => {
              const now = automation.state(id);
              return (
                !disposed &&
                tabs.get(id) === tab &&
                !contents.isDestroyed() &&
                !window.isDestroyed() &&
                electron.BrowserWindow.fromWebContents(contents) === window &&
                contents.debugger.isAttached() &&
                attached === attachment &&
                dialogSequence === nativeDialogSequence &&
                binding?.phase === 'agent' &&
                now?.phase === 'agent' &&
                now.sessionId === binding.sessionId &&
                now.incarnation === binding.incarnation &&
                now.browserId === binding.browserId &&
                now.navigation === binding.navigation
              );
            };
            if (!current()) throw Error('browser_page_dialog_stale');
            const result = await contents.debugger.sendCommand(method, params);
            if (!current()) throw Error('browser_page_dialog_cleanup_unknown');
            // Pinned Electron's own listener aborts only this WebContents' native
            // MessageBoxes; its aborted callback cannot decide the webpage twice.
            // A hidden child view still belongs to the same BrowserWindow, which
            // is required for AbortSignal to close a macOS native MessageBox.
            if (!contents.emit('-cancel-dialogs'))
              throw Error('browser_page_dialog_cleanup_unknown');
            return result;
          }
          if (method === 'Runtime.evaluate' || method === 'Runtime.callFunctionOn') {
            const binding = automation.state(id),
              attached = attachment;
            const current = () => {
              const now = automation.state(id);
              return (
                !disposed &&
                tabs.get(id) === tab &&
                tab.view.webContents === contents &&
                contents !== window.webContents &&
                !contents.isDestroyed() &&
                !window.isDestroyed() &&
                electron.BrowserWindow.fromWebContents(contents) === window &&
                contents.debugger.isAttached() &&
                attached === attachment &&
                !!binding &&
                ['acquiring', 'agent'].includes(binding.phase) &&
                now?.phase === binding.phase &&
                now.sessionId === binding.sessionId &&
                now.incarnation === binding.incarnation &&
                now.browserId === binding.browserId &&
                now.navigation === binding.navigation
              );
            };
            if (!current()) throw new BrowserPagePreflightError(id, method, 'stale');
            try {
              await annotationStyle.ensure(binding!.navigation);
            } catch (cause) {
              throw new BrowserPagePreflightError(
                id,
                method,
                current() ? 'failed' : 'stale',
                cause,
              );
            }
            if (!current()) throw new BrowserPagePreflightError(id, method, 'stale');
          }
          if (method === 'Page.captureScreenshot') {
            const binding = automation.state(id),
              attached = attachment,
              sizeEpoch = tab.sizeEpoch,
              sequence = ++captureSequence;
            captureMeta = null;
            const current = () => {
              const now = automation.state(id);
              return (
                !disposed &&
                tabs.get(id) === tab &&
                tab.view.webContents === contents &&
                !window.isDestroyed() &&
                electron.BrowserWindow.fromWebContents(contents) === window &&
                !contents.isDestroyed() &&
                contents.debugger.isAttached() &&
                sequence === captureSequence &&
                sizeEpoch === tab.sizeEpoch &&
                attached === attachment &&
                !!binding &&
                ['acquiring', 'agent'].includes(binding.phase) &&
                now?.phase === binding.phase &&
                now.incarnation === binding.incarnation &&
                now.browserId === binding.browserId &&
                now.navigation === binding.navigation
              );
            };
            const assertCurrent = () => {
              if (!current()) throw Error('browser_page_read_stale');
            };
            assertCurrent();
            const metrics = await contents.executeJavaScript(
              '({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,x:scrollX,y:scrollY})',
            );
            assertCurrent();
            if (
              !metrics ||
              ![metrics.width, metrics.height, metrics.dpr, metrics.x, metrics.y].every(
                Number.isFinite,
              ) ||
              metrics.width <= 0 ||
              metrics.height <= 0 ||
              metrics.dpr <= 0
            )
              throw Error('browser_capture_metrics_invalid');
            const format = params.format ?? 'png';
            if (format !== 'png' && format !== 'jpeg')
              throw Error('browser_capture_format_invalid');
            const scale = Math.min(1, 1920 / metrics.width, 1080 / metrics.height);
            // CDP clip scaling temporarily resizes Chromium's visible widget, even
            // with captureBeyondViewport=false. Capture the untouched surface and
            // bound its pixels after capture so the user never sees that resize.
            const { clip: _clip, quality: _quality, ...captureParams } = params;
            const captured = await contents.debugger.sendCommand(method, {
              ...captureParams,
              // Resize lossless pixels, then encode the requested format once.
              format: 'png',
              fromSurface: true,
              captureBeyondViewport: false,
            });
            assertCurrent();
            const image = electron.nativeImage.createFromBuffer(
              Buffer.from(captured.data, 'base64'),
            );
            if (image.isEmpty()) throw Error('browser_capture_image_invalid');
            const target = {
              width: Math.max(1, Math.round(metrics.width * scale)),
              height: Math.max(1, Math.round(metrics.height * scale)),
            };
            const size = image.getSize();
            // Layout can reach the renderer between reading metrics and copying
            // its surface. Reject that old coordinate basis instead of stretching
            // a new viewport into it; tolerate only physical-pixel rounding.
            if (
              Math.abs(size.width - Math.round(metrics.width * metrics.dpr)) > 1 ||
              Math.abs(size.height - Math.round(metrics.height * metrics.dpr)) > 1
            )
              throw Error('browser_page_read_stale');
            const bounded =
              size.width === target.width && size.height === target.height
                ? image
                : image.resize(target);
            const bytes =
              format === 'jpeg'
                ? bounded.toJPEG(
                    typeof params.quality === 'number' &&
                      params.quality >= 0 &&
                      params.quality <= 100
                      ? params.quality
                      : 80,
                  )
                : bounded.toPNG();
            if (bytes.length > 4 * 1024 * 1024) throw Error('browser_capture_limit');
            assertCurrent();
            captureMeta = {
              value: {
                captureId: randomUUID(),
                sha256: createHash('sha256').update(bytes).digest('hex'),
                navigation: binding!.navigation,
                width: metrics.width,
                height: metrics.height,
                imageWidth: target.width,
                imageHeight: target.height,
              },
              metrics: { dpr: metrics.dpr, x: metrics.x, y: metrics.y },
              current,
            };
            return { ...captured, data: bytes.toString('base64') };
          }
          return contents.debugger.sendCommand(method, params);
        },
        async typingCursor() {
          return contents.executeJavaScriptInIsolatedWorld(1004, [
            { code: browserTypingCursorScript },
          ]);
        },
        captureMeta() {
          return {
            metadata: captureMeta?.current() ? captureMeta.value : null,
            navigation: automation.state(id)?.navigation,
          };
        },
        async validateCapture(captureId) {
          const proof = captureMeta;
          if (!proof || proof.value.captureId !== captureId || !proof.current()) return false;
          const metrics = await contents.executeJavaScript(
            '({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,x:scrollX,y:scrollY})',
          );
          return (
            captureMeta === proof &&
            proof.current() &&
            !!metrics &&
            metrics.width === proof.value.width &&
            metrics.height === proof.value.height &&
            metrics.dpr === proof.metrics.dpr &&
            metrics.x === proof.metrics.x &&
            metrics.y === proof.metrics.y
          );
        },
        onEvent(listener) {
          const event = (_e: unknown, method: string, params: unknown, sessionId?: string) =>
            listener(method, params, sessionId);
          contents.debugger.on('message', event);
          return () => contents.debugger.off('message', event);
        },
        decorate(value) {
          decoration = value;
          paint();
        },
        changed() {
          documentReady.check();
          navigation.check();
          publish(tab);
        },
        async capture() {
          const image = await contents.capturePage();
          const size = image.getSize();
          const scale = Math.min(1, 1920 / size.width, 1080 / size.height);
          const bounded =
            scale < 1
              ? image.resize({
                  width: Math.round(size.width * scale),
                  height: Math.round(size.height * scale),
                })
              : image;
          const bytes = bounded.toJPEG(35);
          if (bytes.length > 96 * 1024) throw Error('browser_capture_limit');
          const dimensions = bounded.getSize();
          return {
            frame: {
              mimeType: 'image/jpeg',
              data: bytes.toString('base64'),
              width: dimensions.width,
              height: dimensions.height,
            },
            annotations: [],
            url: contents.getURL(),
            title: contents.getTitle(),
          };
        },
      });
      contents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
        if (tabs.get(id) === tab && mainFrame && !inPlace) {
          automation.navigate(id);
          navigation.start(documentEpoch);
          clearStyle();
        }
      });
      contents.on('did-navigate', () => {
        navigation.commit(documentEpoch);
      });
      contents.on('dom-ready', () => {
        if (committedFrame === contents.mainFrame) {
          navigation.ready(documentEpoch);
        }
      });
      const failedDocument = (
        _event: unknown,
        code: number,
        _description: string,
        url: string,
        mainFrame: boolean,
        processId?: number,
        routingId?: number,
      ) => {
        // An aborted old loader can arrive after a new start, even at the same URL.
        // An actual stop before DOM-ready is handled by did-stop-loading below.
        if (currentFailure(code, url, mainFrame, processId, routingId)) {
          navigation.stopped(documentEpoch);
        }
      };
      contents.on('did-fail-load', failedDocument);
      contents.on('did-fail-provisional-load', failedDocument);
      contents.on('did-stop-loading', () => {
        if (contents.isLoadingMainFrame?.() === false) {
          navigation.stopped(documentEpoch);
        }
      });
      contents.on('render-process-gone', () => {
        navigation.cancel();
      });
      contents.on('destroyed', () => {
        navigation.dispose();
      });
      contents.debugger.on?.('detach', () => {
        documentReady.cancel();
        navigation.cancel();
      });
      contents.on('did-navigate-in-page', (_event, _url, mainFrame) => {
        if (tabs.get(id) !== tab || !mainFrame) return;
        automation.navigate(id);
        navigation.inPage(documentEpoch);
        // This is still the same document. Its user stylesheet remains valid;
        // clearing it here would cancel a pending insertion before a CDP call.
      });
      contents.on('did-finish-load', () => {
        paint();
      });
      contents.on('destroyed', () => {
        if (tabs.get(id) === tab) automation.fail(id);
      });
    }
    contents.setWindowOpenHandler(({ url }) => {
      if (httpUrl(url)) navigate(tab, url);
      return { action: 'deny' };
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.on('will-frame-navigate', (event) => {
      if (
        httpUrl(event.url) ||
        (tab.bootstrapping === true && event.isMainFrame && event.url === 'about:blank') ||
        (!event.isMainFrame && /^(?:about:blank$|data:|blob:)/i.test(event.url))
      )
        return;
      event.preventDefault();
      if (event.isMainFrame) {
        tab.state = { ...tab.state, error: 'unsupported_navigation', failure: undefined };
        publish(tab);
      }
    });
    contents.on('will-redirect', (event, url) => {
      if (httpUrl(url)) return;
      event.preventDefault();
      tab.state = {
        ...tab.state,
        loading: false,
        error: 'unsupported_navigation',
        failure: undefined,
      };
      publish(tab);
    });
    contents.on('did-start-loading', () => {
      tab.state = { ...tab.state, loading: true, error: undefined, failure: undefined };
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
      tab.state = {
        ...tab.state,
        title:
          title.slice(0, 128) || (tab.state.url ? new URL(tab.state.url).hostname : '新标签页'),
      };
      publish(tab);
    });
    contents.on(
      'did-fail-load',
      (_event, code, _description, url, mainFrame, processId, routingId) => {
        if (!currentFailure(code, url, mainFrame, processId, routingId)) return;
        tab.state = {
          ...tab.state,
          ...(httpUrl(url) ? { url } : {}),
          loading: false,
          display: 'failed',
          error: 'load_failed',
          failure: browserLoadFailure(code, _description),
        };
        publish(tab);
      },
    );
    contents.on('render-process-gone', () => {
      if (tabs.get(id) !== tab) return;
      cancelPaint(tab);
      delete tab.drawable;
      tab.view.setVisible(false);
      tab.state = { ...tab.state, loading: false, error: 'process_gone', failure: undefined };
      automation?.fail(id);
      publish(tab);
    });
    return tab;
  };
  const unconfigureGrants = automation?.configureGrantContext({
    selectedScope() {
      const selected = (options.grantScope ?? options.selectedScope)?.();
      return selected &&
        Number.isSafeInteger(selected.generation) &&
        Number.isSafeInteger(selected.viewSelection)
        ? { ...selected, generation: selected.generation!, viewSelection: selected.viewSelection! }
        : undefined;
    },
    async create(id, scope) {
      if (disposed) throw Error('browser_page_unavailable');
      const prior = tabs.get(id);
      try {
        const tab = create(id, scope);
        if (!automation.state(id)) throw Error('browser_page_grant_create_failed');
        await ensureBlank(tab);
      } catch (error) {
        // Registered allocations are reclaimed by Host's exact page/epoch guard.
        // A synchronous registration failure has no Host entry to reclaim it.
        const orphan = tabs.get(id);
        if (orphan && orphan !== prior && orphan.state.url === '' && !automation.state(id))
          close(id);
        throw error;
      }
    },
    describe(id) {
      const tab = tabs.get(id);
      return tab &&
        !disposed &&
        !window.isDestroyed() &&
        tab.view.webContents !== window.webContents &&
        !tab.view.webContents.isDestroyed() &&
        electron.BrowserWindow.fromWebContents(tab.view.webContents) === window
        ? {
            title: tab.view.webContents.getTitle().slice(0, 128),
            url:
              tab.state.url === '' && tab.view.webContents.getURL() === 'about:blank'
                ? ''
                : tab.view.webContents.getURL(),
          }
        : undefined;
    },
    close: (id) => close(id),
  });
  // The measured CSS rectangle and panel policy form the single geometry input.
  // Native resize and Renderer corrections share this calculation and output.
  const applyCurrentLayout = (tab: BrowserTab, beforeShow = false) => {
    const anchor = tab.presentation;
    if (
      !anchor ||
      disposed ||
      window.isDestroyed() ||
      tabs.get(tab.state.id) !== tab ||
      !tab.view.webContents ||
      tab.view.webContents.isDestroyed()
    )
      return;
    if (!scopeCurrent(tab)) {
      withdraw(tab);
      return;
    }
    const zoom = owner.getZoomFactor(),
      [width = 0, height = 0] = window.getContentSize();
    const cached = tab.nativeProjection?.source === anchor ? tab.nativeProjection : undefined;
    const projected = anchor.layout
      ? cached?.layout.windowWidth === width / zoom && cached.layout.windowHeight === height / zoom
        ? cached
        : projectNativeBrowserLayout(
            cached?.bounds ?? anchor.bounds,
            cached?.layout ?? anchor.layout,
            width / zoom,
            height / zoom,
          )
      : undefined;
    if (projected) tab.nativeProjection = { source: anchor, ...projected };
    const bounds = anchor.layout ? projected?.bounds : anchor.bounds;
    if (!bounds) {
      withdraw(tab);
      return;
    }
    const x = Math.max(0, Math.min(width, Math.ceil(bounds.x * zoom))),
      y = Math.max(0, Math.min(height, Math.ceil(bounds.y * zoom))),
      right = Math.min(width, Math.floor((bounds.x + bounds.width) * zoom)),
      bottom = Math.min(height, Math.floor((bounds.y + bounds.height) * zoom));
    if (right <= x || bottom <= y) {
      withdraw(tab);
      return;
    }
    const next = { x, y, width: right - x, height: bottom - y };
    paneFrame.sync(
      bounds,
      projected?.layout ?? anchor.layout,
      (window.isVisible() || beforeShow) && !window.isMinimized() && !tab.state.error,
    );
    const previous = tab.view.getBounds();
    if (!sameRectangle(previous, next)) {
      if (previous.width !== next.width || previous.height !== next.height) tab.sizeEpoch++;
      cancelPaint(tab);
      tab.view.setBounds(next);
    }
    const radius = Math.floor(
      Math.min(Math.round(bounds.radius * zoom), next.width / 2, next.height / 2),
    );
    if (tab.borderRadius !== radius) {
      tab.view.setBorderRadius(radius);
      tab.borderRadius = radius;
    }
    const contents = tab.view.webContents;
    const drawable =
      tab.drawable?.frame === contents.mainFrame &&
      tab.drawable.document === tab.documentGeneration;
    const visible =
      (window.isVisible() || beforeShow) &&
      !window.isMinimized() &&
      !tab.state.error &&
      drawable &&
      (!inputBlocked(tab.state.id) || inputShield.available());
    if (visible) promotePage(tab);
    const preparing = !drawable && !!tab.paint?.underlay && coveredByRoot(tab);
    if (!preparing && tab.view.getVisible() !== !!visible) tab.view.setVisible(!!visible);
    automation?.present(tab.state.id, !!visible && window.isVisible());
    syncInput();
    if (!drawable && !tab.state.error && tab.state.display !== 'failed') prepareDocument(tab);
  };
  const boundedRead = async <T>(
    read: Promise<T>,
    milliseconds: number,
    expired?: () => void,
  ): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        read,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            expired?.();
            reject(Error('browser_presentation_unavailable'));
          }, milliseconds);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const prepareDocument = (tab: BrowserTab) => {
    if (
      tab.paint ||
      !tab.presentation ||
      active !== tab.state.id ||
      !window.isVisible() ||
      window.isMinimized()
    )
      return;
    const contents = tab.view.webContents;
    const job: NonNullable<BrowserTab['paint']> = {
      controller: new AbortController(),
      token: pageToken(tab),
      frame: owner.mainFrame,
      bounds: tab.view.getBounds(),
      geometry: JSON.stringify([
        rootEpoch,
        visibilityEpoch,
        ...window.getContentSize(),
        owner.getZoomFactor(),
      ]),
    };
    tab.paint = job;
    const contextCurrent = () =>
      !disposed &&
      tab.paint === job &&
      tabs.get(tab.state.id) === tab &&
      !contents.isDestroyed() &&
      !owner.isDestroyed() &&
      !window.isDestroyed() &&
      owner.mainFrame === job.frame &&
      active === tab.state.id &&
      !!tab.presentation &&
      scopeCurrent(tab) &&
      pageToken(tab) === job.token &&
      sameRectangle(tab.view.getBounds(), job.bounds) &&
      JSON.stringify([
        rootEpoch,
        visibilityEpoch,
        ...window.getContentSize(),
        owner.getZoomFactor(),
      ]) === job.geometry &&
      window.isVisible() &&
      !window.isMinimized() &&
      !tab.state.error;
    const current = () => contextCurrent() && !job.controller.signal.aborted;
    // A never-shown View has no native copy surface, even after DOM-ready.
    // Paint the exact document under Root's opaque viewport, then promote only
    // after its current full native frame. No screenshot is copied or cached.
    void (async () => {
      try {
        const ready = await boundedRead(
          tab.waitForDisplayDocument!(job.controller.signal),
          12000,
          () => job.controller.abort(),
        );
        if (!current()) throw Error('browser_presentation_cancelled');
        if (!ready) throw Error('browser_presentation_unavailable');
        const pageFrame = contents.mainFrame;
        const root = rootView();
        if (!root?.getVisible()) throw Error('browser_presentation_unavailable');
        const children = window.contentView.children,
          rootIndex = children.indexOf(root);
        if (children.indexOf(tab.view) >= rootIndex)
          addNativeWindowView(window, tab.view, rootIndex);
        if (!coveredByRoot(tab)) throw Error('browser_presentation_unavailable');
        job.underlay = true;
        if (process.platform === 'win32') {
          // Chromium otherwise occludes this BaseWindow child under Root and
          // never produces its first frame. Only this bounded preparation may
          // draw in the background; retained/hidden tabs keep their own policy.
          const previous = contents.getBackgroundThrottling();
          job.restoreThrottling = () => {
            job.restoreThrottling = undefined;
            if (!contents.isDestroyed()) contents.setBackgroundThrottling(previous);
          };
          contents.setBackgroundThrottling(false);
        }
        tab.view.setVisible(true);
        automation?.present(tab.state.id, false);
        syncInput();
        await boundedRead(
          new Promise<void>((resolve, reject) => {
            let subscribed = false,
              settled = false;
            const finish = (error?: unknown) => {
              if (settled) return;
              settled = true;
              job.controller.signal.removeEventListener('abort', abort);
              if (job.stopFrame === abort) {
                job.stopFrame = undefined;
                if (subscribed && !contents.isDestroyed()) {
                  try {
                    contents.endFrameSubscription();
                  } catch (cause) {
                    error ??= cause;
                  }
                }
              }
              if (error) reject(error);
              else resolve();
            };
            const abort = () => finish(Error('browser_presentation_cancelled'));
            job.stopFrame = abort;
            job.controller.signal.addEventListener('abort', abort, { once: true });
            if (!current() || !coveredByRoot(tab)) {
              abort();
              return;
            }
            try {
              subscribed = true;
              contents.beginFrameSubscription(false, (image) => {
                if (!current() || contents.mainFrame !== pageFrame || !coveredByRoot(tab)) {
                  abort();
                  return;
                }
                if (fullFrameMatches(image, job.bounds)) finish();
              });
              contents.invalidate();
            } catch (cause) {
              finish(cause);
            }
          }),
          2000,
          () => job.controller.abort(),
        );
        if (!current()) throw Error('browser_presentation_cancelled');
        if (contents.mainFrame !== pageFrame || !coveredByRoot(tab))
          throw Error('browser_presentation_unavailable');
        tab.drawable = { frame: pageFrame, document: tab.documentGeneration };
        tab.state = { ...tab.state, display: 'ready' };
        tab.paint = undefined;
        applyCurrentLayout(tab);
        publish(tab);
      } catch {
        if (
          tab.paint !== job ||
          disposed ||
          tabs.get(tab.state.id) !== tab ||
          contents.isDestroyed() ||
          tab.view.webContents !== contents
        )
          return;
        // Scope, Root or geometry can retire before Renderer sends its hide.
        // Retire only this job's binding; cancellation is not a failed document
        // and must not poison the original page when its owner returns.
        if (!contextCurrent()) {
          withdraw(tab);
          return;
        }
        tab.paint = undefined;
        tab.view.setVisible(false);
        automation?.present(tab.state.id, false);
        tab.state = { ...tab.state, display: 'failed' };
        publish(tab);
      } finally {
        job.restoreThrottling?.();
        if (tab.paint === job) tab.paint = undefined;
      }
    })();
  };
  const rememberPresentation = (tab: BrowserTab) => {
    const id = tab.state.id;
    if (tab.scope) lastPresented.set(scopeKey(tab.scope), id);
    if (tab.draft) lastPresented.set(`draft:${tab.draft.key}`, id);
    if (tab.scope && replacedPresentation.get(scopeKey(tab.scope)) === id)
      replacedPresentation.delete(scopeKey(tab.scope));
  };
  const present = (
    id: string,
    bounds: NativeBrowserBounds | null,
    layout?: NativeBrowserLayout,
    scope?: NativeBrowserRestoreScope,
  ) => {
    const tab = tabs.get(id);
    if (!tab) return;
    if (!bounds) {
      withdraw(tab);
      return;
    }
    if (active !== id) cancelMenu();
    active = id;
    delete tab.resume;
    tab.presentation = { bounds, layout };
    tab.presentationScope = scope;
    delete tab.nativeProjection;
    rememberPresentation(tab);
    applyCurrentLayout(tab);
    // Place the exact replacement before withdrawing its predecessor. Both
    // operations belong to this one admitted layout, not separate IPC turns.
    for (const other of tabs.values()) if (other !== tab && other.presentation) withdraw(other);
  };
  const download = (
    event: Electron.Event,
    _item: Electron.DownloadItem,
    contents: Electron.WebContents,
  ) => {
    event.preventDefault();
    for (const tab of tabs.values())
      if (tab.view.webContents === contents) {
        tab.state = {
          ...tab.state,
          loading: false,
          error: 'download_unsupported',
          failure: undefined,
        };
        publish(tab);
      }
  };
  browsing.on('will-download', download);
  const admitLayout = (request: Extract<NativeBrowserRequest, { action: 'present' }>) => {
    const tab = tabs.get(request.id);
    if (!tab) {
      if (request.bounds) throw Error('browser_page_scope_denied');
      return null;
    }
    if (request.pageToken !== pageToken(tab)) throw Error('browser_page_scope_denied');
    if (
      request.draft
        ? !draftCurrent(tab, request.draft) || !!request.scope
        : tab.draft || !request.scope
    )
      throw Error('browser_page_scope_denied');
    const selected = (options.grantScope ?? options.selectedScope)?.();
    // Cleanup from the old selection may withdraw only its exact original page.
    if (
      request.scope &&
      (!tab.scope ||
        tab.scope.storeId !== request.scope.storeId ||
        tab.scope.sessionId !== request.scope.sessionId ||
        !selected ||
        selected.generation !== request.scope.generation ||
        (request.bounds &&
          !(['storeId', 'sessionId', 'generation', 'viewSelection'] as const).every(
            (key) => selected[key] === request.scope![key],
          )))
    )
      throw Error('browser_page_scope_denied');
    if (
      !Number.isSafeInteger(request.presentationRevision) ||
      request.presentationRevision! <= layoutRevision
    )
      throw Error('browser_layout_stale');
    if (request.bounds) {
      if (window.isMinimized()) throw Error('invalid_browser_request');
      const zoom = owner.getZoomFactor(),
        [width = 0, height = 0] = window.getContentSize();
      if (request.layout) {
        if (!currentPanelMeasurement(request.layout, width / zoom, height / zoom))
          throw Error('browser_layout_stale');
        assertPanelMeasurement(request.bounds, request.layout, width / zoom, height / zoom);
      }
      if (
        request.bounds.width <= 0 ||
        request.bounds.height <= 0 ||
        request.bounds.x + request.bounds.width > width / zoom + 1 ||
        request.bounds.y + request.bounds.height > height / zoom + 1
      )
        throw Error('invalid_browser_request');
    }
    layoutRevision = request.presentationRevision!;
    if (request.bounds && !window.isVisible()) {
      // An accurate hidden Root can change its intent, but cannot display or
      // operate a page by doing so. Reopening rechecks this exact record first.
      for (const other of tabs.values())
        if (other !== tab && (other.presentation || other.resume)) withdraw(other);
      cancelPaint(tab);
      delete tab.presentation;
      delete tab.presentationScope;
      delete tab.nativeProjection;
      active = undefined;
      paneFrame.hide();
      tab.resume = {
        token: pageToken(tab),
        root: owner.mainFrame,
        contents: tab.view.webContents,
        frame: tab.view.webContents.mainFrame,
        document: tab.documentGeneration,
        geometry: JSON.stringify([...window.getContentSize(), owner.getZoomFactor()]),
        presentation: { bounds: request.bounds, layout: request.layout },
        scope: request.scope,
        confirmed: true,
      };
      automation?.present(tab.state.id, false);
      inputShield.hide();
      return tab.state;
    }
    if (
      !request.bounds &&
      tab.scope &&
      replacedPresentation.get(scopeKey(tab.scope)) === request.id
    )
      replacedPresentation.delete(scopeKey(tab.scope));
    present(request.id, request.bounds, request.layout, request.scope);
    return tab.state;
  };
  const applyLayout = (
    event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent,
    value: unknown,
  ) => {
    try {
      assertNativeSender(event, disposed ? undefined : window, rendererUrl);
      const request = parseNativeBrowserRequest(value);
      if (request.action !== 'present') throw Error('invalid_browser_request');
      return { ok: true as const, value: admitLayout(request) };
    } catch (cause) {
      return {
        ok: false as const,
        code:
          cause instanceof Error &&
          ['native_sender_denied', 'browser_page_scope_denied', 'browser_layout_stale'].includes(
            cause.message,
          )
            ? cause.message
            : 'invalid_browser_request',
      };
    }
  };
  const layoutCommit = (event: Electron.IpcMainEvent, value: unknown) => {
    event.returnValue = applyLayout(event, value);
  };
  ipcMain.on?.(nativeBrowserLayoutChannel, layoutCommit);
  ipcMain.handle(nativeBrowserLayoutChannel, applyLayout);
  const menuCancel = (event: Electron.IpcMainEvent, requestId: unknown) => {
    try {
      assertNativeSender(event, disposed ? undefined : window, rendererUrl);
      if (typeof requestId === 'string' && menu?.id === requestId) cancelMenu();
    } catch {}
  };
  ipcMain.on?.(nativeBrowserMenuCancelChannel, menuCancel);
  ipcMain.handle(
    nativeBrowserMenuChannel,
    async (event, value): Promise<NativeBrowserMenuAction | null> => {
      assertNativeSender(event, disposed ? undefined : window, rendererUrl);
      const request = parseNativeBrowserMenuRequest(value),
        tab = tabs.get(request.id);
      if (!tab) return null;
      const selected = (options.grantScope ?? options.selectedScope)?.();
      const binding = JSON.stringify([
        request.draft ?? selected,
        tab.generation,
        automation?.state(request.id)?.incarnation,
        automation?.state(request.id)?.navigation,
      ]);
      const current = () => {
        const now = (options.grantScope ?? options.selectedScope)?.(),
          control = automation?.state(request.id);
        return (
          !disposed &&
          tabs.get(request.id) === tab &&
          !tab.view.webContents.isDestroyed() &&
          (active === request.id || !!tab.state.error) &&
          window.isVisible() &&
          !window.isMinimized() &&
          (request.draft
            ? draftCurrent(tab, request.draft) &&
              !request.incarnation &&
              request.navigation === undefined &&
              request.items.every((item) =>
                ['back', 'forward', 'reload', 'stop'].includes(item.action),
              )
            : !!now &&
              !!request.scope &&
              !tab.draft &&
              (['storeId', 'sessionId', 'generation', 'viewSelection'] as const).every(
                (key) => now[key] === request.scope![key],
              ) &&
              !!tab.scope &&
              now.storeId === tab.scope.storeId &&
              now.sessionId === tab.scope.sessionId) &&
          JSON.stringify([
            request.draft ?? now,
            tab.generation,
            control?.incarnation,
            control?.navigation,
          ]) === binding &&
          request.incarnation === control?.incarnation &&
          request.navigation === control?.navigation
        );
      };
      // A collapse/selection change may overtake this asynchronous UI request.
      // Retire it like a late native-menu selection, without failing the page.
      if (!current()) return null;
      if (menu) {
        cancelMenu();
        return null;
      }
      const labels: Record<NativeBrowserMenuAction, string> = {
        back: '后退',
        forward: '前进',
        reload: '刷新网页',
        stop: '停止加载',
        handoff: '暂停并接管',
        close: '停止浏览器任务',
        checkOriginal: '查询原操作',
      };
      return new Promise((resolve) => {
        let chosen: NativeBrowserMenuAction | null = null,
          settled = false,
          cancelled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          if (menu?.id === request.requestId) {
            menu = undefined;
          }
          resolve(!cancelled && current() ? chosen : null);
        };
        const template: Electron.MenuItemConstructorOptions[] = [];
        for (const detail of request.details)
          for (const line of detail.split('\n')) {
            // Retain every character in readable disabled rows; ampersands are literal.
            const characters = Array.from(line);
            for (let offset = 0; offset < characters.length; offset += 80)
              template.push({
                label: characters
                  .slice(offset, offset + 80)
                  .join('')
                  .replaceAll('&', '&&'),
                enabled: false,
              });
          }
        if (template.length && request.items.length) template.push({ type: 'separator' });
        for (const item of request.items)
          template.push({
            label: labels[item.action],
            enabled: item.enabled,
            click: () => {
              if (!cancelled && item.enabled && current()) chosen = item.action;
            },
          });
        const popup = electron.Menu.buildFromTemplate(template);
        menu = {
          id: request.requestId,
          pageId: request.id,
          current: () => !cancelled && current(),
          close() {
            if (cancelled || settled) return;
            cancelled = true;
            chosen = null;
            // closePopup requests cancellation. The popup still owns the slot
            // until Electron's real close callback; late clicks cannot act.
            popup.closePopup(window);
          },
        };
        const zoom = owner.getZoomFactor(),
          [width = 0, height = 0] = window.getContentSize();
        popup.popup({
          window,
          x: Math.min(width, Math.round(request.x * zoom)),
          y: Math.min(height, Math.round(request.y * zoom)),
          callback: finish,
        });
      });
    },
  );
  ipcMain.handle(
    nativeBrowserChannel,
    (event, value): NativeBrowserReply | Promise<NativeBrowserReply> => {
      try {
        assertNativeSender(event, disposed ? undefined : window, rendererUrl);
        const request = parseNativeBrowserRequest(value);
        if (request.action === 'restoreDraft') {
          const pages = [...tabs.values()].filter(
            (tab) =>
              tab.draft?.key === request.draft &&
              !tab.scope &&
              !!tab.view.webContents &&
              !tab.view.webContents.isDestroyed(),
          );
          for (const tab of pages) {
            if (tab.draft!.epoch === rootEpoch && tab.draft!.frame === owner.mainFrame) continue;
            // Exact possession restores only this manual inventory. Old Root
            // proofs retire; the actual documents are never navigated or armed.
            withdraw(tab);
            tab.draft = { key: request.draft, frame: owner.mainFrame, epoch: rootEpoch };
            delete tab.presentation;
            delete tab.nativeProjection;
            delete tab.presentationScope;
            publish(tab);
          }
          const selected = pages.find(
            (tab) => tab.state.id === lastPresented.get(`draft:${request.draft}`),
          );
          return {
            ok: true,
            value: {
              pages: pages.map((tab) => tab.state),
              ...(pages.length ? { activeId: (selected ?? pages[0]!).state.id } : {}),
            },
          };
        }
        if (request.action === 'restore') {
          const selected = (options.grantScope ?? options.selectedScope)?.();
          if (
            !selected ||
            selected.storeId !== request.scope.storeId ||
            selected.sessionId !== request.scope.sessionId ||
            selected.generation !== request.scope.generation ||
            selected.viewSelection !== request.scope.viewSelection
          )
            throw Error('browser_page_scope_denied');
          const pages = [...tabs.values()].filter((tab) => {
            if (
              tab.scope?.storeId !== selected.storeId ||
              tab.scope.sessionId !== selected.sessionId ||
              tab.view.webContents.isDestroyed()
            )
              return false;
            return true;
          });
          for (const page of pages) publish(page);
          const retained = pages.filter((tab) => automation?.retained(tab.state.id));
          if (retained.length > 1) throw Error('browser_session_page_already_bound');
          const presented = pages.find(
            (tab) => tab.state.id === lastPresented.get(scopeKey(selected)),
          );
          const tab = retained[0] ?? presented ?? pages[0];
          if (tab) publish(tab);
          return {
            ok: true,
            value: {
              scope: { ...request.scope },
              page: tab?.state ?? null,
              pages: pages.map((tab) => tab.state),
              ...(tab ? { activeId: (presented ?? tab).state.id } : {}),
              ...(tab &&
              replacedPresentation.get(scopeKey(selected)) === (presented ?? tab).state.id
                ? { reveal: true as const }
                : {}),
            },
          };
        }
        if (request.action === 'close') {
          const tab = tabs.get(request.id);
          const selected = (options.grantScope ?? options.selectedScope)?.();
          if (tab && request.pageToken !== pageToken(tab)) throw Error('browser_page_scope_denied');
          if (
            (request.draft && (!tab || !draftCurrent(tab, request.draft))) ||
            (tab?.draft && !draftCurrent(tab, request.draft))
          )
            throw Error('browser_page_scope_denied');
          if (
            tab?.scope &&
            (!selected ||
              selected.storeId !== tab.scope.storeId ||
              selected.sessionId !== tab.scope.sessionId)
          )
            throw Error('browser_page_scope_denied');
          // This request comes only from the user's tab X. Pane unmount and
          // session changes publish presentation hide and preserve the page.
          close(request.id, true);
          return { ok: true, value: null };
        }
        let tab = tabs.get(request.id);
        const draft = 'draft' in request ? request.draft : undefined;
        if (
          (draft && tab && !draftCurrent(tab, draft)) ||
          (tab?.draft && !draftCurrent(tab, draft))
        )
          throw Error('browser_page_scope_denied');
        const selected = options.selectedScope?.();
        if (request.action === 'navigate' && !draft && !selected)
          throw Error('browser_page_scope_denied');
        // Presentation conveys no navigation/control permission. Main retains this
        // exact selection identity during Core refresh; an installed provider that
        // denies must never fall back to the ready projection.
        const presentationScope =
          request.action === 'present'
            ? (options.grantScope ?? options.selectedScope)?.()
            : selected;
        if (
          tab?.scope &&
          request.action !== 'state' &&
          !(request.action === 'present' && request.bounds === null) &&
          (!presentationScope ||
            presentationScope.storeId !== tab.scope.storeId ||
            presentationScope.sessionId !== tab.scope.sessionId)
        )
          throw Error('browser_page_scope_denied');
        if (request.action === 'grant') {
          if (!tab || !selected || !automation) throw Error('browser_page_unavailable');
          automation.arm(tab.state.id, selected);
          publish(tab);
        }
        const phase = automation?.state(request.id)?.phase;
        if (
          ['navigate', 'back', 'forward', 'reload', 'stop'].includes(request.action) &&
          phase &&
          !['human', 'armed'].includes(phase)
        )
          throw Error('browser_page_control_required');
        if (request.action === 'navigate') {
          const url = browserAddress(request.input);
          tab ??= create(request.id, undefined, draft);
          navigate(tab, url);
        } else if (request.action === 'present') {
          admitLayout(request);
        } else if (tab) {
          const contents = tab.view.webContents;
          if (['back', 'forward', 'reload'].includes(request.action)) {
            cancelPaint(tab);
            delete tab.drawable;
            tab.state = { ...tab.state, display: 'loading' };
            tab.generation++;
          }
          if (request.action === 'back' && contents.navigationHistory.canGoBack())
            contents.navigationHistory.goBack();
          if (request.action === 'forward' && contents.navigationHistory.canGoForward())
            contents.navigationHistory.goForward();
          if (request.action === 'reload') {
            tab.state = { ...tab.state, loading: true, error: undefined, failure: undefined };
            contents.reload();
          }
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
            'browser_layout_stale',
            'invalid_browser_address',
            'unsupported_browser_protocol',
            'browser_tab_limit',
            'browser_page_scope_denied',
            'browser_page_control_required',
            'browser_page_unavailable',
            'browser_page_grant_denied',
            'browser_session_page_already_bound',
          ].includes(code)
            ? code
            : 'browser_unavailable',
        };
      }
    },
  );
  const replaceRenderer = () => {
    for (const tab of tabs.values()) {
      if (tab.scope && tab.presentation)
        replacedPresentation.set(scopeKey(tab.scope), tab.state.id);
      withdraw(tab);
    }
    rootEpoch++;
    layoutRevision = 0;
  };
  const navigation = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => {
    if (mainFrame && !inPlace) replaceRenderer();
  };
  owner.on('did-start-navigation', navigation);
  owner.on('render-process-gone', replaceRenderer);
  owner.on('preload-error', replaceRenderer);
  const resize = () => {
    if (disposed || window.isDestroyed()) return;
    cancelMenu();
    const tab = active ? tabs.get(active) : undefined;
    if (tab?.presentation) {
      cancelPaint(tab);
      applyCurrentLayout(tab);
    }
    syncInput();
  };
  const beforeShow = () => {
    if (disposed || window.isDestroyed() || owner.isDestroyed() || window.isVisible()) return;
    for (const tab of tabs.values()) {
      const intent = tab.resume,
        contents = tab.view.webContents;
      if (!intent) continue;
      const root = rootView();
      if (
        !intent.confirmed ||
        !contents ||
        contents !== intent.contents ||
        contents.isDestroyed() ||
        owner.mainFrame !== intent.root ||
        pageToken(tab) !== intent.token ||
        contents.mainFrame !== intent.frame ||
        tab.documentGeneration !== intent.document ||
        tab.drawable?.frame !== intent.frame ||
        tab.drawable.document !== intent.document ||
        !scopeCurrent(tab, intent.scope) ||
        !root?.getVisible() ||
        !sameRectangle(root.getBounds(), {
          x: 0,
          y: 0,
          width: window.getContentSize()[0]!,
          height: window.getContentSize()[1]!,
        }) ||
        JSON.stringify([...window.getContentSize(), owner.getZoomFactor()]) !== intent.geometry ||
        tab.state.error ||
        tab.state.display === 'failed'
      ) {
        withdraw(tab);
        continue;
      }
      delete tab.resume;
      active = tab.state.id;
      tab.presentation = { ...intent.presentation };
      tab.presentationScope = intent.scope;
      try {
        applyCurrentLayout(tab, true);
        if (active === tab.state.id && tab.presentation) rememberPresentation(tab);
      } catch {
        withdraw(tab);
      }
    }
  };
  // Reopening requests a fresh Renderer measurement. It never navigates or
  // resurrects a previous display binding from the selected URL.
  const resume = () => {
    if (owner.isDestroyed() || window.isDestroyed() || !window.isVisible() || window.isMinimized())
      return;
    // A system restore may bypass the JS show wrapper. Unconsumed hidden
    // candidates must be withdrawn, never exposed using a stale binding.
    for (const tab of tabs.values()) if (tab.resume) withdraw(tab);
    const tab = active ? tabs.get(active) : undefined;
    if (tab?.presentation) applyCurrentLayout(tab);
    for (const tab of tabs.values()) {
      publish(tab);
      owner.send(nativeBrowserEventChannel, tab.state);
    }
    owner.send(nativeBrowserPresentationChannel, true);
  };
  window.on('resize', resize);
  const unwatchWillShow = onNativeRootWillShow(window, beforeShow);
  window.on('hide', suspendWindow);
  window.on('minimize', minimize);
  window.on('show', resume);
  window.on('restore', resume);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    cancelMenu();
    unconfigureGrants?.();
    for (const id of [...tabs.keys()]) close(id, true);
    inputShield.dispose();
    paneFrame.dispose();
    ipcMain.removeHandler(nativeBrowserChannel);
    ipcMain.removeHandler(nativeBrowserMenuChannel);
    ipcMain.removeHandler(nativeBrowserLayoutChannel);
    ipcMain.off?.(nativeBrowserLayoutChannel, layoutCommit);
    ipcMain.off?.(nativeBrowserMenuCancelChannel, menuCancel);
    browsing.webRequest.onBeforeRequest(null);
    browsing.off('will-download', download);
    browsing.setPermissionRequestHandler(null);
    browsing.setPermissionCheckHandler(null);
    owner.off('before-input-event', menuInput);
    window.off('blur', resetMenuInput);
    owner.off('did-start-navigation', navigation);
    owner.off('render-process-gone', replaceRenderer);
    owner.off('preload-error', replaceRenderer);
    window.off('resize', resize);
    unwatchWillShow();
    window.off('hide', suspendWindow);
    window.off('minimize', minimize);
    window.off('show', resume);
    window.off('restore', resume);
  };
  window.once('closed', dispose);
  return dispose;
}
