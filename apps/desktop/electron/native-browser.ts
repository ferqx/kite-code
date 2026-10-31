import { createHash, randomUUID } from 'node:crypto';
import * as electron from 'electron';
import { type IpcMain, session, WebContentsView } from 'electron';
import {
  browserAddress,
  isNativeBrowserRestoreScope,
  type NativeBrowserBounds,
  type NativeBrowserDisplayIntent,
  type NativeBrowserFrozenFrame,
  type NativeBrowserLayout,
  type NativeBrowserMenuAction,
  type NativeBrowserPresentationFrame,
  type NativeBrowserReply,
  type NativeBrowserRequest,
  type NativeBrowserRestoreScope,
  type NativeBrowserState,
  nativeBrowserChannel,
  nativeBrowserDisplayChannel,
  nativeBrowserEventChannel,
  nativeBrowserLayoutChannel,
  nativeBrowserLayoutFrameChannel,
  nativeBrowserMenuCancelChannel,
  nativeBrowserMenuChannel,
  nativeBrowserWitnessSamplePoints,
  parseNativeBrowserMenuRequest,
  parseNativeBrowserRequest,
  projectNativeBrowserBounds,
} from '../src/native-browser-bridge';
import { createBrowserAnnotationStyle } from './browser-annotation-style';
import { createNativeBrowserChromeHost } from './browser-chrome-host';
import { browserDecorationScript } from './browser-decoration';
import { createBrowserDocumentReady } from './browser-document-ready';
import { createBrowserInputShield } from './browser-input-shield';
import type { BrowserPageScope } from './browser-lease';
import { createBrowserNavigation } from './browser-navigation';
import { BrowserPagePreflightError, type NativeBrowserPageHost } from './browser-page-host';
import { browserTypingCursorScript } from './browser-typing-cursor';
import { assertNativeSender } from './native-ipc';
import type { NativeRootWindow as BrowserWindow } from './native-root-window';
import { cancelNativeWindowLayout, queueNativeWindowLayout } from './native-window-layout';

type BrowserTab = {
  view: WebContentsView;
  state: NativeBrowserState;
  generation: number;
  chromeNavigation: number;
  notification?: ReturnType<typeof setTimeout>;
  unregister?: () => void;
  disposeDocument?: () => void;
  unprotect?: () => void;
  scope?: BrowserPageScope;
  bootstrapping?: boolean;
  initialization?: Promise<void>;
  sizeEpoch: number;
  viewportSize?: { width: number; height: number };
  borderRadius?: number;
  presentation?: {
    bounds: NativeBrowserBounds;
    layout?: NativeBrowserLayout;
    width: number;
    height: number;
    zoom: number;
  };
  presentationScope?: NativeBrowserRestoreScope;
  presentationRevision?: number;
  presentationGeneration?: number;
  presentationCapture?: Promise<NativeBrowserPresentationFrame>;
  presentationFrame?: { key: string; stamp: string; scroll: string; expires: number };
  drawnPresentation?: boolean;
  drawnRequest?: DrawnPresentation;
  resizeFrame?: { generation: number; url: string; size: string; frame: NativeBrowserFrozenFrame };
  nativeFrames?: {
    generation: number;
    url: string;
    scope: NativeBrowserRestoreScope;
    width: number;
    height: number;
    scale: number;
    zoom: number;
    sent: number;
    latest?: Electron.NativeImage;
    timer?: ReturnType<typeof setTimeout>;
  };
};
type DrawnPresentation = Extract<NativeBrowserRequest, { action: 'present' }> & {
  bounds: NativeBrowserBounds;
  layout: NativeBrowserLayout;
  scope: NativeBrowserRestoreScope;
  presentationRevision: number;
  witness: { key: string; step: 1 | 2 };
};
/** Only the current full-width two-Panel Groups may establish a resize anchor.
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
      group.left > 1 ||
      group.right > 1 ||
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
  /** Product Chrome host; absent in older isolated presenters and unsupported platforms. */
  readonly chrome?: { readonly preloadPath: string };
  readonly automation?: NativeBrowserPageHost;
  readonly selectedScope?: () =>
    | (BrowserPageScope & { generation?: number; viewSelection?: number })
    | undefined;
  /** Main selection identity, including its verified same-selection loading projection. */
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
  let rendererPresented = false;
  let displayShieldReady = false;
  let retiredDisplayToken: string | undefined;
  let retainedDisplay:
    | {
        intent: NativeBrowserDisplayIntent;
        tab: BrowserTab;
        incarnation: string;
        navigation: number;
        pageGeneration: number;
        ready: boolean;
        claimed?: NativeBrowserRestoreScope;
      }
    | undefined;
  const scopeKey = (scope: BrowserPageScope) => JSON.stringify([scope.storeId, scope.sessionId]);
  const inputShield = createBrowserInputShield(window, () => {
    cancelRetainedDisplay();
    for (const tab of tabs.values())
      if (inputBlocked(tab.state.id)) {
        stopNativeFrames(tab);
        tab.view.setVisible(false);
        automation?.fail(tab.state.id);
      }
  });
  let active: string | undefined;
  let disposed = false;
  let chromeHost: ReturnType<typeof createNativeBrowserChromeHost> | undefined;
  let pendingLayout:
    | { tab: BrowserTab; request: DrawnPresentation; confirmed: boolean }
    | undefined;
  let frameSubscription = 0;
  let subscribed = false;
  const cancelLayout = (id?: string) => {
    if (id && pendingLayout?.tab.state.id !== id) return;
    pendingLayout = undefined;
    frameSubscription++;
    if (subscribed) {
      subscribed = false;
      try {
        owner.endFrameSubscription();
      } catch {}
    }
  };
  const stopNativeFrames = (tab: BrowserTab, preserve = false) => {
    const frames = tab.nativeFrames;
    delete tab.nativeFrames;
    if (frames) {
      clearTimeout(frames.timer);
      frames.latest = undefined;
      try {
        tab.view.webContents.endFrameSubscription();
      } catch {}
    }
    if (!preserve) delete tab.resizeFrame;
  };
  let menu: { id: string; pageId: string; current(): boolean; close(): void } | undefined;
  let menuEscapeHeld = false;
  const cancelMenu = (pageId?: string) => {
    if (menu && (!pageId || menu.pageId === pageId)) {
      menu.close();
    }
  };
  // Route one Escape press to the actual pending popup, including repeats and
  // its matching keyup. No post-close timeout may swallow the next press.
  const menuInput = (event: Electron.Event, input: Electron.Input) => {
    if (retainedDisplay) {
      event.preventDefault();
      return;
    }
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
  const inputBlocked = (id: string) => {
    const phase = automation?.state(id)?.phase;
    return phase !== undefined && !['human', 'armed'].includes(phase);
  };
  const syncInput = () => {
    const tab = active ? tabs.get(active) : undefined;
    if (
      tab &&
      inputBlocked(tab.state.id) &&
      automation?.state(tab.state.id)?.phase !== 'acquiring' &&
      !inputShield.available()
    ) {
      if (tab.view.getVisible()) {
        stopNativeFrames(tab);
        tab.view.setVisible(false);
        automation?.present(tab.state.id, false);
      }
      inputShield.hide();
      return;
    }
    inputShield.sync(
      tab?.view,
      !!tab && (inputBlocked(tab.state.id) || retainedDisplay?.tab === tab),
    );
  };
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
      ...(automation?.state(tab.state.id) ? { control: automation.state(tab.state.id) } : {}),
      canGoBack: tab.view.webContents.navigationHistory.canGoBack(),
      canGoForward: tab.view.webContents.navigationHistory.canGoForward(),
    };
    syncInput();
    if (tab.drawnPresentation && !tab.state.loading && !pendingLayout) startNativeFrames(tab);
    if (tab.notification !== undefined) return;
    tab.notification = setTimeout(() => {
      tab.notification = undefined;
      if (!disposed && tabs.get(tab.state.id) === tab && !window.isDestroyed())
        window.webContents.send(nativeBrowserEventChannel, tab.state);
    }, 16);
  };
  const hide = () => {
    cancelRetainedDisplay();
    cancelLayout();
    cancelMenu();
    inputShield.hide();
    for (const tab of tabs.values()) {
      stopNativeFrames(tab);
      tab.view.setVisible(false);
      automation?.present(tab.state.id, false);
    }
    active = undefined;
  };
  const replaceRenderer = (retainLive = true) => {
    // This is only a display intent. The next Root must still restore against
    // fresh Caller scope and present a newly measured viewport before showing it.
    if (rendererPresented) replacedPresentation.clear();
    for (const tab of tabs.values())
      if (tab.scope && tab.view.getVisible() && !tab.view.webContents.isDestroyed())
        replacedPresentation.set(scopeKey(tab.scope), tab.state.id);
    const tab = active ? tabs.get(active) : undefined;
    const [width = 0, height = 0] = window.getContentSize();
    const scope = tab?.scope;
    const control = tab && automation?.state(tab.state.id);
    const drawn = tab?.drawnRequest;
    const qualified =
      retainLive &&
      typeof ipcMain.on === 'function' &&
      !retainedDisplay &&
      tab &&
      control?.incarnation &&
      displayShieldReady &&
      inputShield.available() &&
      !pendingLayout &&
      drawn?.witness.step === 2 &&
      tab.presentationRevision === drawn.presentationRevision &&
      tab.presentationScope &&
      scope &&
      tab.view.getVisible() &&
      !tab.view.webContents.isDestroyed() &&
      electron.BrowserWindow.fromWebContents(tab.view.webContents) === window &&
      !!tab.presentation &&
      tab.presentation.width === width &&
      tab.presentation.height === height &&
      tab.presentation.zoom === owner.getZoomFactor() &&
      JSON.stringify(tab.presentationScope) === JSON.stringify(drawn.scope) &&
      JSON.stringify([tab.presentation.bounds, tab.presentation.layout]) ===
        JSON.stringify([drawn.bounds, drawn.layout]);
    rendererPresented = false;
    if (qualified) {
      cancelLayout();
      cancelMenu();
      stopNativeFrames(tab);
      retainedDisplay = {
        intent: {
          token: randomUUID().replaceAll('-', ''),
          id: tab.state.id,
          storeId: scope.storeId,
          sessionId: scope.sessionId,
          bounds: { ...drawn.bounds },
          width,
          height,
          zoom: owner.getZoomFactor(),
        },
        tab,
        incarnation: control.incarnation,
        navigation: control.navigation,
        pageGeneration: tab.generation,
        ready: false,
      };
      if (!displayCurrent()) {
        cancelRetainedDisplay();
        return;
      }
      tab.sizeEpoch++;
      automation?.present(tab.state.id, false);
      syncInput();
    } else hide();
    for (const tab of tabs.values()) {
      delete tab.presentation;
      delete tab.presentationScope;
      delete tab.presentationFrame;
    }
  };
  const close = (id: string, force = false) => {
    if (retainedDisplay?.tab.state.id === id) cancelRetainedDisplay();
    const tab = tabs.get(id);
    if (!tab) return;
    stopNativeFrames(tab);
    cancelLayout(id);
    cancelMenu(id);
    if (!force && automation?.retained(id)) {
      tab.presentation = undefined;
      tab.view.setVisible(false);
      automation.present(id, false);
      if (active === id) active = undefined;
      syncInput();
      return;
    }
    tab.disposeDocument?.();
    tab.unregister?.();
    tab.unprotect?.();
    tabs.delete(id);
    if (tab.scope && lastPresented.get(scopeKey(tab.scope)) === id)
      lastPresented.delete(scopeKey(tab.scope));
    if (tab.scope && replacedPresentation.get(scopeKey(tab.scope)) === id)
      replacedPresentation.delete(scopeKey(tab.scope));
    if (tab.notification !== undefined) clearTimeout(tab.notification);
    if (active === id) active = undefined;
    syncInput();
    if (!window.isDestroyed()) window.contentView.removeChildView(tab.view);
    if (!tab.view.webContents.isDestroyed())
      tab.view.webContents.close({ waitForBeforeUnload: false });
  };
  const navigate = (tab: BrowserTab, url: string) => {
    stopNativeFrames(tab);
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
  const create = (id: string, grantedScope?: BrowserPageScope): BrowserTab => {
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
    window.contentView.addChildView(view);
    const tab: BrowserTab = {
      view,
      scope: (() => {
        // A committed proposal already pins its exact owner. Renderer-created
        // tabs still require the ordinary current, ready selection projection.
        const selected = grantedScope ?? options.selectedScope?.();
        return selected ? { storeId: selected.storeId, sessionId: selected.sessionId } : undefined;
      })(),
      generation: 0,
      chromeNavigation: 0,
      sizeEpoch: 0,
      viewportSize: { width: 960, height: 540 },
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
      if (mainFrame && !inPlace) {
        tab.chromeNavigation++;
        if (retainedDisplay?.tab === tab) cancelRetainedDisplay();
        // CDP, links and same-URL reloads do not pass through navigate().
        // Their previous document pixels and coalescing callbacks expire too.
        stopNativeFrames(tab);
        tab.state = { ...tab.state, loading: true };
      }
    });
    contents.on('did-navigate-in-page', (_event, _url, mainFrame) => {
      if (mainFrame) tab.chromeNavigation++;
    });
    contents.on('destroyed', () => {
      if (retainedDisplay?.tab === tab) cancelRetainedDisplay();
    });
    // Electron 44.3's native dialog manager does not implement Chromium's
    // HandleJavaScriptDialog UI cleanup. Count its per-contents native openings
    // without replacing the ordinary human dialog handler.
    let nativeDialogSequence = 0;
    contents.on('-run-dialog' as never, () => ++nativeDialogSequence);
    contents.on('before-input-event', menuInput);
    tab.unprotect = inputShield.protect(
      contents,
      () => inputBlocked(id) || retainedDisplay?.tab === tab,
    );
    if (automation && tab.scope) {
      const documentReady = createBrowserDocumentReady();
      const navigation = createBrowserNavigation();
      tab.disposeDocument = () => {
        documentReady.dispose();
        navigation.dispose();
      };
      let documentEpoch = 0;
      let readyEpoch: number | undefined = 0;
      let documentUrl: string | undefined;
      let committedFrame: Electron.WebFrameMain | undefined;
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
        void annotationStyle.clear().catch(() => automation.fail(id));
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
          displayShieldReady = true;
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
                !contents.isDestroyed() &&
                contents.debugger.isAttached() &&
                sequence === captureSequence &&
                sizeEpoch === tab.sizeEpoch &&
                retainedDisplay?.tab !== tab &&
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
      contents.on('did-start-navigation', (_event, url, inPlace, mainFrame) => {
        if (mainFrame && !inPlace) {
          committedFrame = undefined;
          documentUrl = url;
          documentEpoch = documentReady.start();
          readyEpoch = undefined;
          automation.navigate(id);
          navigation.start(documentEpoch);
          clearStyle();
        }
      });
      contents.on('did-redirect-navigation', (_event, url, inPlace, mainFrame) => {
        if (mainFrame && !inPlace) documentUrl = url;
      });
      contents.on('did-navigate', (_event, url) => {
        documentUrl = url;
        committedFrame = contents.mainFrame;
        documentReady.commit(documentEpoch);
        navigation.commit(documentEpoch);
      });
      contents.on('dom-ready', () => {
        if (committedFrame === contents.mainFrame) {
          readyEpoch = documentEpoch;
          documentReady.ready(documentEpoch);
          navigation.ready(documentEpoch);
        }
      });
      const failedDocument = (
        _event: unknown,
        code: number,
        _description: string,
        url: string,
        mainFrame: boolean,
      ) => {
        // An aborted old loader can arrive after a new start, even at the same URL.
        // An actual stop before DOM-ready is handled by did-stop-loading below.
        if (mainFrame && code !== -3 && url === documentUrl) {
          documentReady.stopped();
          navigation.stopped(documentEpoch);
        }
      };
      contents.on('did-fail-load', failedDocument);
      contents.on('did-fail-provisional-load', failedDocument);
      contents.on('did-stop-loading', () => {
        if (contents.isLoadingMainFrame?.() === false) {
          documentReady.stopped();
          navigation.stopped(documentEpoch);
        }
      });
      contents.on('render-process-gone', () => {
        documentReady.fail();
        navigation.cancel();
      });
      contents.on('destroyed', () => {
        documentReady.dispose();
        navigation.dispose();
      });
      contents.debugger.on?.('detach', () => {
        documentReady.cancel();
        navigation.cancel();
      });
      contents.on('did-navigate-in-page', (_event, _url, mainFrame) => {
        if (!mainFrame) return;
        automation.navigate(id);
        navigation.inPage(documentEpoch);
        // This is still the same document. Its user stylesheet remains valid;
        // clearing it here would cancel a pending insertion before a CDP call.
      });
      contents.on('did-finish-load', () => {
        paint();
      });
      contents.on('destroyed', () => automation.fail(id));
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
      tab.state = {
        ...tab.state,
        title:
          title.slice(0, 128) || (tab.state.url ? new URL(tab.state.url).hostname : '新标签页'),
      };
      publish(tab);
    });
    contents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
      if (!mainFrame || code === -3) return;
      tab.state = { ...tab.state, loading: false, error: 'load_failed' };
      publish(tab);
    });
    contents.on('render-process-gone', () => {
      stopNativeFrames(tab);
      tab.view.setVisible(false);
      tab.state = { ...tab.state, loading: false, error: 'process_gone' };
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
  const present = (
    id: string,
    bounds: NativeBrowserBounds | null,
    layout?: NativeBrowserLayout,
  ) => {
    const tab = tabs.get(id);
    if (!tab) return;
    if (retainedDisplay && (!bounds || retainedDisplay.tab !== tab)) cancelRetainedDisplay();
    if (tab.state.error === 'process_gone' && inputBlocked(id)) bounds = null;
    if (!bounds) {
      chromeHost?.release(id);
      stopNativeFrames(tab);
      cancelLayout(id);
      cancelMenu(id);
      tab.presentation = undefined;
      tab.view.setVisible(false);
      automation?.present(id, false);
      if (active === id) active = undefined;
      syncInput();
      return;
    }
    const zoom = owner.getZoomFactor();
    const [width = 0, height = 0] = window.getContentSize();
    // Renderer measurements are inputs, never another native geometry writer.
    if (!layout && tab.presentation?.layout) throw Error('invalid_browser_request');
    if (layout) {
      if (!currentPanelMeasurement(layout, width / zoom, height / zoom))
        throw Error('invalid_browser_request');
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
    tab.presentation = { bounds, ...(layout ? { layout } : {}), width, height, zoom };
    applyCurrentLayout(tab);
  };
  // Both native resize predictions and accepted Renderer corrections are
  // computed here against the current window, then diffed at the native output.
  const applyCurrentLayout = (tab: BrowserTab) => {
    const anchor = tab.presentation;
    if (
      !anchor ||
      disposed ||
      window.isDestroyed() ||
      tabs.get(tab.state.id) !== tab ||
      tab.view.webContents.isDestroyed()
    )
      return;
    const zoom = owner.getZoomFactor();
    const [width = 0, height = 0] = window.getContentSize();
    const bounds = anchor.layout
      ? projectNativeBrowserBounds(anchor.bounds, anchor.layout, width / zoom, height / zoom)
      : anchor.bounds;
    if (!bounds) {
      present(tab.state.id, null);
      return;
    }
    const id = tab.state.id;
    // Round into the measured container, so fractional CSS edges cannot cover chat.
    const x = Math.max(0, Math.min(width, Math.ceil(bounds.x * zoom)));
    const y = Math.max(0, Math.min(height, Math.ceil(bounds.y * zoom)));
    const right = Math.min(width, Math.floor((bounds.x + bounds.width) * zoom));
    const bottom = Math.min(height, Math.floor((bounds.y + bounds.height) * zoom));
    if (right <= x || bottom <= y) {
      stopNativeFrames(tab);
      tab.view.setVisible(false);
      automation?.present(id, false);
      if (active === id) active = undefined;
      syncInput();
      return;
    }
    for (const [otherId, other] of tabs)
      if (otherId !== id) {
        stopNativeFrames(other);
        if (other.view.getVisible()) other.view.setVisible(false);
        automation?.present(otherId, false);
      }
    if (active !== id) cancelMenu();
    active = id;
    if (tab.scope) lastPresented.set(scopeKey(tab.scope), id);
    const viewportSize = { width: right - x, height: bottom - y };
    if (
      tab.viewportSize?.width !== viewportSize.width ||
      tab.viewportSize.height !== viewportSize.height
    ) {
      tab.sizeEpoch++;
      tab.viewportSize = viewportSize;
    }
    // Crop the app Root with its own native bounds before moving the live page.
    // A slow Root paint can no longer cover or receive input in the right column.
    chromeHost?.syncViewport();
    chromeHost?.layout(id, { x, y, ...viewportSize }, tab.presentationScope);
    const previous = tab.view.getBounds();
    if (
      previous.x !== x ||
      previous.y !== y ||
      previous.width !== viewportSize.width ||
      previous.height !== viewportSize.height
    )
      tab.view.setBounds({ x, y, ...viewportSize });
    const radius = Math.floor(
      Math.min(Math.round(bounds.radius * zoom), viewportSize.width / 2, viewportSize.height / 2),
    );
    if (tab.borderRadius !== radius) {
      tab.view.setBorderRadius(radius);
      tab.borderRadius = radius;
    }
    const visible = window.isVisible() && !window.isMinimized();
    if (tab.view.getVisible() !== visible) tab.view.setVisible(visible);
    rendererPresented = true;
    if (tab.scope && replacedPresentation.get(scopeKey(tab.scope)) === id)
      replacedPresentation.delete(scopeKey(tab.scope));
    automation?.present(id, window.isVisible() && !window.isMinimized());
    syncInput();
    chromeHost?.update();
    startNativeFrames(tab);
    if (!displayShieldReady)
      void inputShield.prepare().then(
        () => {
          displayShieldReady = true;
        },
        () => {},
      );
  };
  if (options.chrome && process.platform === 'darwin')
    chromeHost = createNativeBrowserChromeHost({
      window,
      ipcMain,
      rendererUrl,
      preloadPath: options.chrome.preloadPath,
      currentScope(forInput) {
        const scope = (
          forInput ? options.selectedScope : (options.grantScope ?? options.selectedScope)
        )?.();
        return isNativeBrowserRestoreScope(scope) ? scope : undefined;
      },
      getPage(id) {
        const tab = tabs.get(id);
        if (!tab || tab.view.webContents.isDestroyed()) return;
        return {
          id,
          view: tab.view,
          // Page ownership exists before its first presentation. Waiting for a
          // drawn scope here prevents the initial Chrome offer from starting.
          scope: tab.scope,
          token: JSON.stringify([
            id,
            tab.view.webContents.id,
            tab.generation,
            tab.chromeNavigation,
            automation?.state(id)?.incarnation,
            automation?.state(id)?.navigation,
          ]),
        };
      },
      onReady(id) {
        const tab = tabs.get(id),
          request = tab?.drawnRequest;
        if (!tab || !request || !layoutCurrent({ tab, request, confirmed: false })) return;
        cancelLayout();
        stopNativeFrames(tab);
        tab.presentationScope = request.scope;
        present(id, request.bounds, request.layout);
      },
      onSuspend(id) {
        if (!disposed && tabs.has(id)) present(id, null);
      },
    });
  function cancelRetainedDisplay() {
    const saved = retainedDisplay;
    if (!saved) return;
    retainedDisplay = undefined;
    retiredDisplayToken = saved.intent.token;
    present(saved.tab.state.id, null);
    if (!owner.isDestroyed())
      owner.send(nativeBrowserDisplayChannel, { token: saved.intent.token });
  }
  const displayCurrent = () => {
    const saved = retainedDisplay;
    if (!saved) return false;
    const { tab, intent } = saved;
    const [width, height] = window.getContentSize();
    const control = automation?.state(tab.state.id);
    const actual = tab.view.getBounds();
    const left = Math.ceil(intent.bounds.x * intent.zoom),
      top = Math.ceil(intent.bounds.y * intent.zoom);
    return (
      !disposed &&
      !window.isDestroyed() &&
      window.isVisible() &&
      !window.isMinimized() &&
      !owner.isDestroyed() &&
      tabs.get(tab.state.id) === tab &&
      active === tab.state.id &&
      !tab.view.webContents.isDestroyed() &&
      tab.view.getVisible() &&
      electron.BrowserWindow.fromWebContents(tab.view.webContents) === window &&
      displayShieldReady &&
      inputShield.available() &&
      control?.incarnation === saved.incarnation &&
      control.navigation === saved.navigation &&
      tab.generation === saved.pageGeneration &&
      width === intent.width &&
      height === intent.height &&
      owner.getZoomFactor() === intent.zoom &&
      actual.x === left &&
      actual.y === top &&
      actual.width === Math.floor((intent.bounds.x + intent.bounds.width) * intent.zoom) - left &&
      actual.height === Math.floor((intent.bounds.y + intent.bounds.height) * intent.zoom) - top
    );
  };
  const displayBootstrap = (event: Electron.IpcMainEvent, value: unknown) => {
    try {
      assertNativeSender(event, disposed ? undefined : window, rendererUrl);
      if (!value || typeof value !== 'object') throw Error('invalid_browser_request');
      const input = value as { action: string; token?: string; request?: unknown };
      if (input.action === 'get') {
        if (retainedDisplay && !displayCurrent()) cancelRetainedDisplay();
        event.returnValue = retainedDisplay ? structuredClone(retainedDisplay.intent) : null;
        return;
      }
      const saved = retainedDisplay;
      if (input.action === 'cancel' && input.token === retiredDisplayToken) {
        event.returnValue = true;
        return;
      }
      if (!saved || input.token !== saved.intent.token) {
        event.returnValue = false;
        return;
      }
      if (input.action === 'cancel') {
        cancelRetainedDisplay();
        event.returnValue = true;
        return;
      }
      if (!displayCurrent()) {
        cancelRetainedDisplay();
        event.returnValue = false;
        return;
      }
      if (input.action === 'ready') {
        saved.ready = true;
        event.returnValue = true;
        return;
      }
      if (input.action !== 'claim' || !saved.ready) throw Error('invalid_browser_request');
      const request = parseNativeBrowserRequest(input.request);
      const selected = (options.grantScope ?? options.selectedScope)?.();
      if (
        request.action !== 'present' ||
        request.id !== saved.tab.state.id ||
        !request.scope ||
        !request.bounds ||
        !request.layout ||
        !selected ||
        request.scope.generation === saved.tab.presentationGeneration ||
        request.scope.storeId !== saved.intent.storeId ||
        request.scope.sessionId !== saved.intent.sessionId ||
        !(['storeId', 'sessionId', 'generation', 'viewSelection'] as const).every(
          (key) => request.scope![key] === selected[key],
        ) ||
        JSON.stringify(request.bounds) !== JSON.stringify(saved.intent.bounds) ||
        !currentPanelMeasurement(
          request.layout,
          saved.intent.width / saved.intent.zoom,
          saved.intent.height / saved.intent.zoom,
        )
      ) {
        cancelRetainedDisplay();
        event.returnValue = false;
        return;
      }
      saved.claimed = { ...request.scope };
      event.returnValue = true;
    } catch {
      event.returnValue = false;
    }
  };
  ipcMain.on?.(nativeBrowserDisplayChannel, displayBootstrap);
  const layoutCurrent = (pending: NonNullable<typeof pendingLayout>) => {
    const { tab, request } = pending;
    const selected = (options.grantScope ?? options.selectedScope)?.();
    const [width = 0, height = 0] = window.getContentSize(),
      zoom = owner.getZoomFactor();
    return (
      !disposed &&
      (!retainedDisplay || displayCurrent()) &&
      !window.isDestroyed() &&
      !owner.isDestroyed() &&
      window.isVisible() &&
      !window.isMinimized() &&
      tabs.get(tab.state.id) === tab &&
      !tab.view.webContents.isDestroyed() &&
      !!selected &&
      (['storeId', 'sessionId', 'generation', 'viewSelection'] as const).every(
        (key) => selected[key] === request.scope[key],
      ) &&
      tab.presentationRevision === request.presentationRevision &&
      currentPanelMeasurement(request.layout, width / zoom, height / zoom)
    );
  };
  const savedResizeFrame = (tab: BrowserTab) => {
    const saved = tab.resizeFrame;
    return saved &&
      saved.generation === tab.generation &&
      saved.url === tab.view.webContents.getURL()
      ? saved.frame
      : undefined;
  };
  const nativeFrameCurrent = (tab: BrowserTab, frames: NonNullable<BrowserTab['nativeFrames']>) => {
    const selected = (options.grantScope ?? options.selectedScope)?.();
    const bounds = tab.view.getBounds();
    return (
      !disposed &&
      !owner.isDestroyed() &&
      tabs.get(tab.state.id) === tab &&
      tab.nativeFrames === frames &&
      tab.view.getVisible() &&
      active === tab.state.id &&
      !tab.view.webContents.isDestroyed() &&
      tab.generation === frames.generation &&
      tab.view.webContents.getURL() === frames.url &&
      owner.getZoomFactor() === frames.zoom &&
      (electron.screen?.getDisplayMatching(window.getBounds()).scaleFactor ?? 1) === frames.scale &&
      bounds.width === frames.width &&
      bounds.height === frames.height &&
      !!selected &&
      (['storeId', 'sessionId', 'generation', 'viewSelection'] as const).every(
        (key) => selected[key] === frames.scope[key],
      )
    );
  };
  const flushNativeFrame = (tab: BrowserTab) => {
    const frames = tab.nativeFrames;
    if (!frames?.latest || !nativeFrameCurrent(tab, frames)) return;
    clearTimeout(frames.timer);
    delete frames.timer;
    const image = frames.latest;
    frames.latest = undefined;
    delete tab.resizeFrame;
    try {
      const bytes = image.toPNG();
      if (
        bytes.length < 24 ||
        bytes.length > 4 * 1024 * 1024 ||
        !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      )
        return;
      const width = bytes.readUInt32BE(16),
        height = bytes.readUInt32BE(20);
      if (
        !width ||
        !height ||
        width > 16384 ||
        height > 16384 ||
        width * height > 64000000 ||
        Math.abs(width - Math.round(frames.width * frames.scale)) > 1 ||
        Math.abs(height - Math.round(frames.height * frames.scale)) > 1
      )
        return;
      const frame: NativeBrowserFrozenFrame = {
        key: randomUUID().replaceAll('-', ''),
        mimeType: 'image/png',
        data: bytes.toString('base64'),
        width,
        height,
        cssWidth: frames.width / frames.zoom,
        cssHeight: frames.height / frames.zoom,
        rootZoom: frames.zoom,
      };
      frames.sent = Date.now();
      tab.resizeFrame = {
        generation: frames.generation,
        url: frames.url,
        size: JSON.stringify([frames.width, frames.height]),
        frame,
      };
      const request = tab.drawnRequest;
      if (request)
        owner.send(nativeBrowserLayoutFrameChannel, {
          id: tab.state.id,
          scope: request.scope,
          presentationRevision: request.presentationRevision,
          key: request.witness.key,
          step: 0,
          frozen: frame,
        });
    } catch {}
  };
  const startNativeFrames = (tab: BrowserTab) => {
    if (chromeHost?.readyFor(tab.state.id, tab.presentationScope)) return;
    const request = tab.drawnRequest;
    if (
      !request ||
      !tab.view.getVisible() ||
      pendingLayout ||
      tab.state.loading ||
      tab.view.webContents.isDestroyed()
    )
      return;
    if (tab.nativeFrames && nativeFrameCurrent(tab, tab.nativeFrames)) return;
    // A viewport handoff has not produced new page pixels yet. Retain the last
    // actually presented frame until the new full frame arrives. Real hide,
    // navigation, scope changes and close still discard it at their boundaries.
    stopNativeFrames(tab, true);
    const bounds = tab.view.getBounds();
    const frames: NonNullable<BrowserTab['nativeFrames']> = {
      generation: tab.generation,
      url: tab.view.webContents.getURL(),
      scope: request.scope,
      width: bounds.width,
      height: bounds.height,
      zoom: owner.getZoomFactor(),
      sent: 0,
      scale: electron.screen?.getDisplayMatching(window.getBounds()).scaleFactor ?? 1,
    };
    tab.nativeFrames = frames;
    try {
      // onlyDirty=true supplies a cropped image. Keep the full presented frame,
      // using dirtyRect only to ignore presentations that repaint no pixels.
      tab.view.webContents.beginFrameSubscription(false, (image, dirtyRect) => {
        if (
          !nativeFrameCurrent(tab, frames) ||
          pendingLayout ||
          dirtyRect.width <= 0 ||
          dirtyRect.height <= 0
        )
          return;
        const size = image.getSize();
        if (
          size.width <= 0 ||
          size.height <= 0 ||
          size.width > 16384 ||
          size.height > 16384 ||
          size.width * size.height > 64000000 ||
          Math.abs(size.width - Math.round(frames.width * frames.scale)) > 1 ||
          Math.abs(size.height - Math.round(frames.height * frames.scale)) > 1
        )
          return;
        frames.latest = image;
        const delay = Math.max(0, 100 - (Date.now() - frames.sent));
        if (!delay) flushNativeFrame(tab);
        else if (!frames.timer)
          frames.timer = setTimeout(() => {
            delete frames.timer;
            flushNativeFrame(tab);
          }, delay);
      });
    } catch {
      stopNativeFrames(tab);
    }
  };
  const matchesDraw = (image: Electron.NativeImage, request: DrawnPresentation) => {
    const { width, height } = image.getSize();
    if (!width || !height || width * height > 64000000) return false;
    const scaleX = width / request.layout.windowWidth,
      scaleY = height / request.layout.windowHeight;
    if (Math.abs(scaleX - scaleY) > 0.02 || scaleX < 0.25 || scaleX > 8) return false;
    const bytes = image.toBitmap();
    if (bytes.length !== width * height * 4) return false;
    const samples: number[][] = [];
    for (const { x, y } of nativeBrowserWitnessSamplePoints(request.bounds, scaleX, scaleY)) {
      if (x < 0 || y < 0 || x >= width || y >= height) return false;
      const offset = (y * width + x) * 4;
      if (bytes[offset + 3]! < 250) return false;
      samples.push([bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!]);
    }
    const references = samples.slice(0, 16);
    // A collapsed/ambiguous ramp is not evidence. Comparing within this frame
    // tolerates its ICC/gamma transform without widening the nonce acceptance.
    if (
      references.some(
        (sample, level) =>
          level > 0 && sample.some((value, channel) => value <= references[level - 1]![channel]!),
      )
    )
      return false;
    return [...request.witness.key].every((digit, index) => {
      const nibble = Number.parseInt(digit, 16),
        level = request.witness.step === 1 ? nibble : 15 - nibble;
      const sample = samples[index + 16]!,
        reference = references[level]!;
      if (!sample.every((value, channel) => Math.abs(value - reference[channel]!) <= 1))
        return false;
      const distance = (target: number[]) =>
        sample.reduce((sum, value, channel) => sum + (value - target[channel]!) ** 2, 0);
      const own = distance(reference);
      return references.every(
        (other, candidate) => candidate === level || own * 4 < distance(other),
      );
    });
  };
  const proposeLayout = (tab: BrowserTab, request: DrawnPresentation) => {
    if (active && active !== tab.state.id) present(active, null);
    if (pendingLayout && pendingLayout.tab !== tab) cancelLayout();
    const old = pendingLayout;
    if (!window.isVisible() || window.isMinimized()) {
      present(tab.state.id, null);
      return;
    }
    if (chromeHost?.readyFor(tab.state.id, request.scope)) {
      if (request.witness.step === 2) {
        const previous = tab.drawnRequest;
        if (
          !previous ||
          previous.witness.key !== request.witness.key ||
          JSON.stringify([
            previous.bounds,
            previous.layout,
            previous.scope,
            previous.presentationRevision,
          ]) !==
            JSON.stringify([
              request.bounds,
              request.layout,
              request.scope,
              request.presentationRevision,
            ])
        )
          throw Error('invalid_browser_request');
      }
      cancelLayout();
      stopNativeFrames(tab);
      tab.drawnPresentation = true;
      tab.drawnRequest = request;
      tab.presentationRevision = request.presentationRevision;
      tab.presentationGeneration = request.scope.generation;
      tab.presentationScope = request.scope;
      present(tab.state.id, request.bounds, request.layout);
      return;
    }
    if (request.witness.step === 2) {
      if (
        !old ||
        old.tab !== tab ||
        !old.confirmed ||
        old.request.witness.key !== request.witness.key ||
        JSON.stringify([
          old.request.bounds,
          old.request.layout,
          old.request.scope,
          old.request.presentationRevision,
        ]) !==
          JSON.stringify([
            request.bounds,
            request.layout,
            request.scope,
            request.presentationRevision,
          ])
      )
        throw Error('invalid_browser_request');
      old.request = request;
    } else {
      const previous = tab.drawnRequest,
        presentation = tab.presentation,
        [width = 0, height = 0] = window.getContentSize(),
        zoom = owner.getZoomFactor();
      const projected = presentation?.layout
        ? projectNativeBrowserBounds(
            presentation.bounds,
            presentation.layout,
            width / zoom,
            height / zoom,
          )
        : undefined;
      const actual = tab.view.getBounds();
      const left = projected && Math.max(0, Math.min(width, Math.ceil(projected.x * zoom))),
        top = projected && Math.max(0, Math.min(height, Math.ceil(projected.y * zoom))),
        right = projected && Math.min(width, Math.floor((projected.x + projected.width) * zoom)),
        bottom = projected && Math.min(height, Math.floor((projected.y + projected.height) * zoom));
      const retain =
        !old &&
        !disposed &&
        !window.isDestroyed() &&
        !owner.isDestroyed() &&
        tabs.get(tab.state.id) === tab &&
        !tab.view.webContents.isDestroyed() &&
        electron.BrowserWindow.fromWebContents(tab.view.webContents) === window &&
        active === tab.state.id &&
        tab.view.getVisible() &&
        previous?.witness.step === 2 &&
        previous.presentationRevision === tab.presentationRevision &&
        tab.presentationGeneration === request.scope.generation &&
        presentation?.width === width &&
        presentation.height === height &&
        presentation.zoom === zoom &&
        JSON.stringify(tab.presentationScope) === JSON.stringify(request.scope) &&
        JSON.stringify([previous.bounds, previous.layout, previous.scope]) ===
          JSON.stringify([request.bounds, request.layout, request.scope]) &&
        JSON.stringify([presentation.bounds, presentation.layout]) ===
          JSON.stringify([request.bounds, request.layout]) &&
        projected &&
        left === actual.x &&
        top === actual.y &&
        right! - left! === actual.width &&
        bottom! - top! === actual.height;
      const retained =
        retainedDisplay?.tab === tab &&
        retainedDisplay.claimed &&
        displayCurrent() &&
        JSON.stringify(retainedDisplay.claimed) === JSON.stringify(request.scope) &&
        JSON.stringify(retainedDisplay.intent.bounds) === JSON.stringify(request.bounds);
      // One surface supplies pixels during the handoff. Resizing the live
      // WebContentsView to an intersection would reflow and shift its page.
      flushNativeFrame(tab);
      stopNativeFrames(tab, true);
      tab.sizeEpoch++;
      // A repeated effect does not require hiding an unchanged, fully proved
      // viewport. Its new revision still completes both real Root draws below.
      if (!retain && !retained) {
        if (retainedDisplay) cancelRetainedDisplay();
        tab.view.setVisible(false);
        automation?.present(tab.state.id, false);
        syncInput();
      }
      tab.drawnPresentation = true;
      pendingLayout = { tab, request, confirmed: false };
    }
    tab.drawnRequest = request;
    if (subscribed) return;
    const subscription = ++frameSubscription;
    subscribed = true;
    try {
      owner.beginFrameSubscription((image) => {
        if (subscription !== frameSubscription) return;
        const pending = pendingLayout;
        if (!pending) return;
        if (!layoutCurrent(pending)) {
          present(pending.tab.state.id, null);
          return;
        }
        try {
          if (!matchesDraw(image, pending.request)) return;
          if (pending.request.witness.step === 1) {
            if (!pending.confirmed) {
              pending.confirmed = true;
              owner.send(nativeBrowserLayoutFrameChannel, {
                id: pending.tab.state.id,
                scope: pending.request.scope,
                presentationRevision: pending.request.presentationRevision,
                key: pending.request.witness.key,
                step: 1,
                ...(savedResizeFrame(pending.tab) ? { frozen: savedResizeFrame(pending.tab) } : {}),
              });
            }
            return;
          }
          // A second Root draw requires the first real frame feedback to have
          // made a full Main -> Renderer -> compositor round trip. This avoids
          // moving the sibling in the first new Root frame's generation turn;
          // it is not an OS-wide atomic presentation guarantee.
          cancelLayout();
          const retained = retainedDisplay;
          if (retained?.tab === pending.tab) retainedDisplay = undefined;
          present(pending.tab.state.id, pending.request.bounds, pending.request.layout);
          pending.tab.presentationScope = pending.request.scope;
          startNativeFrames(pending.tab);
          if (retained && !owner.isDestroyed())
            owner.send(nativeBrowserDisplayChannel, { token: retained.intent.token });
          owner.send(nativeBrowserLayoutFrameChannel, {
            id: pending.tab.state.id,
            scope: pending.request.scope,
            presentationRevision: pending.request.presentationRevision,
            key: pending.request.witness.key,
            step: 2,
          });
        } catch {
          present(pending.tab.state.id, null);
        }
      });
    } catch {
      present(tab.state.id, null);
      throw Error('browser_presentation_unavailable');
    }
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
  const displayIdentity = (tab: BrowserTab) => {
    const selected = (options.grantScope ?? options.selectedScope)?.();
    const scope = selected && {
      storeId: selected.storeId,
      sessionId: selected.sessionId,
      generation: selected.generation,
      viewSelection: selected.viewSelection,
    };
    if (
      !isNativeBrowserRestoreScope(scope) ||
      retainedDisplay?.tab === tab ||
      disposed ||
      tabs.get(tab.state.id) !== tab ||
      tab.view.webContents.isDestroyed() ||
      active !== tab.state.id ||
      !tab.view.getVisible() ||
      !window.isVisible() ||
      window.isMinimized() ||
      !tab.presentation ||
      JSON.stringify(scope) !== JSON.stringify(tab.presentationScope)
    )
      throw Error('browser_presentation_unavailable');
    const bounds = tab.view.getBounds(),
      zoom = owner.getZoomFactor();
    if (bounds.width <= 0 || bounds.height <= 0) throw Error('browser_presentation_unavailable');
    return {
      scope,
      cssX: bounds.x / zoom,
      cssY: bounds.y / zoom,
      cssWidth: bounds.width / zoom,
      cssHeight: bounds.height / zoom,
      stamp: JSON.stringify([
        scope,
        tab.generation,
        tab.sizeEpoch,
        bounds,
        window.getContentSize(),
        zoom,
        tab.view.webContents.getURL(),
        automation?.state(tab.state.id),
      ]),
    };
  };
  const scrollPosition = async (tab: BrowserTab) => {
    const v = await tab.view.webContents.executeJavaScript('({x:scrollX,y:scrollY})');
    if (!v || !Number.isFinite(v.x) || !Number.isFinite(v.y))
      throw Error('browser_presentation_unavailable');
    return JSON.stringify([v.x, v.y]);
  };
  const boundedRead = async <T>(read: Promise<T>, milliseconds: number, expired?: () => void) => {
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
  const capturePresentation = (tab: BrowserTab): Promise<NativeBrowserPresentationFrame> => {
    const before = displayIdentity(tab);
    if (tab.presentationCapture) throw Error('browser_presentation_unavailable');
    delete tab.presentationFrame;
    let expired = false;
    const read = (async (): Promise<NativeBrowserPresentationFrame> => {
      const scroll = await scrollPosition(tab);
      if (displayIdentity(tab).stamp !== before.stamp) throw Error('browser_presentation_stale');
      const image = await tab.view.webContents.capturePage();
      if (
        expired ||
        displayIdentity(tab).stamp !== before.stamp ||
        scroll !== (await scrollPosition(tab))
      )
        throw Error('browser_presentation_stale');
      const scales = image.getScaleFactors?.() ?? [1];
      const scaleFactor = Math.max(
        1,
        ...scales.filter((n) => Number.isFinite(n) && n > 0 && n <= 4),
      );
      const bytes = image.toPNG({ scaleFactor });
      if (
        bytes.length > 4 * 1024 * 1024 ||
        bytes.length < 24 ||
        !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      )
        throw Error('browser_presentation_unavailable');
      const width = bytes.readUInt32BE(16),
        height = bytes.readUInt32BE(20);
      if (
        !width ||
        !height ||
        width > 16384 ||
        height > 16384 ||
        width * height > 64000000 ||
        expired ||
        displayIdentity(tab).stamp !== before.stamp
      )
        throw Error('browser_presentation_stale');
      const key = randomUUID();
      tab.presentationFrame = { key, stamp: before.stamp, scroll, expires: Date.now() + 1000 };
      return {
        id: tab.state.id,
        key,
        scope: before.scope,
        cssX: before.cssX,
        cssY: before.cssY,
        cssWidth: before.cssWidth,
        cssHeight: before.cssHeight,
        frame: { mimeType: 'image/png', data: bytes.toString('base64'), width, height },
      };
    })();
    tab.presentationCapture = read;
    void read
      .finally(() => {
        if (tab.presentationCapture === read) delete tab.presentationCapture;
      })
      .catch(() => {});
    return boundedRead(read, 120, () => {
      expired = true;
    });
  };
  const commitPresentation = async (tab: BrowserTab, key: string): Promise<NativeBrowserReply> => {
    const saved = tab.presentationFrame;
    try {
      if (
        !saved ||
        saved.key !== key ||
        saved.expires < Date.now() ||
        displayIdentity(tab).stamp !== saved.stamp
      )
        throw Error('browser_presentation_stale');
      const scroll = await boundedRead(scrollPosition(tab), 40);
      if (
        tab.presentationFrame !== saved ||
        scroll !== saved.scroll ||
        displayIdentity(tab).stamp !== saved.stamp
      )
        throw Error('browser_presentation_stale');
      delete tab.presentationFrame;
      present(tab.state.id, null);
      return { ok: true, value: tab.state };
    } catch {
      return { ok: false, code: 'browser_presentation_stale' };
    }
  };
  const presentationGeneration = (
    tab: BrowserTab,
    request: Extract<NativeBrowserRequest, { action: 'present' }>,
  ) => {
    if (!request.scope) {
      if (request.presentationRevision !== undefined) throw Error('browser_page_scope_denied');
      return undefined;
    }
    const selected = (options.grantScope ?? options.selectedScope)?.();
    if (
      !selected ||
      selected.generation !== request.scope.generation ||
      !tab.scope ||
      tab.scope.storeId !== request.scope.storeId ||
      tab.scope.sessionId !== request.scope.sessionId ||
      (request.bounds &&
        !(['storeId', 'sessionId', 'generation', 'viewSelection'] as const).every(
          (key) => selected[key] === request.scope![key],
        ))
    )
      throw Error('browser_page_scope_denied');
    // Renderer revisions restart with each Root document. A cleanup may hide its
    // old session after selection changes, but never cross the Caller generation.
    if (
      request.presentationRevision !== undefined &&
      tab.presentationGeneration === request.scope.generation &&
      request.presentationRevision < (tab.presentationRevision ?? 0)
    )
      throw Error('invalid_browser_request');
    return request.scope.generation;
  };
  const layoutCommit = (event: Electron.IpcMainEvent, value: unknown) => {
    try {
      assertNativeSender(event, disposed ? undefined : window, rendererUrl);
      const request = parseNativeBrowserRequest(value);
      if (
        request.action !== 'present' ||
        !request.bounds ||
        !request.layout ||
        !request.scope ||
        request.presentationKey
      )
        throw Error('invalid_browser_request');
      const tab = tabs.get(request.id),
        selected = (options.grantScope ?? options.selectedScope)?.();
      if (
        !tab ||
        !selected ||
        !tab.scope ||
        selected.storeId !== tab.scope.storeId ||
        selected.sessionId !== tab.scope.sessionId
      )
        throw Error('browser_page_scope_denied');
      const scope = {
        storeId: selected.storeId,
        sessionId: selected.sessionId,
        generation: selected.generation,
        viewSelection: selected.viewSelection,
      };
      if (
        !isNativeBrowserRestoreScope(scope) ||
        !(['storeId', 'sessionId', 'generation', 'viewSelection'] as const).every(
          (key) => scope[key] === request.scope![key],
        )
      )
        throw Error('browser_page_scope_denied');
      const revisionGeneration = presentationGeneration(tab, request);
      if (!request.witness) {
        cancelLayout();
        present(request.id, request.bounds, request.layout);
      }
      if (request.witness) proposeLayout(tab, request as DrawnPresentation);
      if (request.presentationRevision !== undefined) {
        tab.presentationRevision = request.presentationRevision;
        tab.presentationGeneration = revisionGeneration;
      }
      if (active === request.id && tab.view.getVisible()) tab.presentationScope = scope;
      chromeHost?.update();
      delete tab.presentationFrame;
      event.returnValue = {
        ok: true,
        value: tab.state,
        ...(request.witness
          ? {
              waiting: !!pendingLayout,
              ...(savedResizeFrame(tab)
                ? {
                    frozenKey: savedResizeFrame(tab)!.key,
                    frozenWidth:
                      (savedResizeFrame(tab)!.cssWidth * savedResizeFrame(tab)!.rootZoom) /
                      owner.getZoomFactor(),
                    frozenHeight:
                      (savedResizeFrame(tab)!.cssHeight * savedResizeFrame(tab)!.rootZoom) /
                      owner.getZoomFactor(),
                  }
                : {}),
            }
          : {}),
      };
    } catch (cause) {
      event.returnValue = {
        ok: false,
        code:
          cause instanceof Error && cause.message === 'browser_page_scope_denied'
            ? 'browser_page_scope_denied'
            : 'invalid_browser_request',
      };
    }
  };
  // Older isolated Main fakes may omit EventEmitter methods; production IpcMain has them.
  ipcMain.on?.(nativeBrowserLayoutChannel, layoutCommit);
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
      if (!tab) throw Error('browser_presentation_unavailable');
      const selected = (options.grantScope ?? options.selectedScope)?.();
      const binding = JSON.stringify([
        selected,
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
          !!now &&
          (['storeId', 'sessionId', 'generation', 'viewSelection'] as const).every(
            (key) => now[key] === request.scope[key],
          ) &&
          !!tab.scope &&
          now.storeId === tab.scope.storeId &&
          now.sessionId === tab.scope.sessionId &&
          JSON.stringify([now, tab.generation, control?.incarnation, control?.navigation]) ===
            binding &&
          request.incarnation === control?.incarnation &&
          request.navigation === control?.navigation
        );
      };
      if (!current()) throw Error('browser_presentation_unavailable');
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
          if (menu?.id === request.requestId) menu = undefined;
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
        if (request.action === 'capturePresentation') {
          if (!tab) throw Error('browser_presentation_unavailable');
          return capturePresentation(tab).then(
            (frame): NativeBrowserReply => ({ ok: true, value: frame }),
            (): NativeBrowserReply => ({ ok: false, code: 'browser_presentation_unavailable' }),
          );
        }
        const selected = options.selectedScope?.();
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
          tab ??= create(request.id);
          navigate(tab, url);
        } else if (request.action === 'present') {
          if (request.witness) throw Error('invalid_browser_request');
          const revisionGeneration = tab ? presentationGeneration(tab, request) : undefined;
          if (request.presentationKey)
            return tab
              ? commitPresentation(tab, request.presentationKey)
              : { ok: false, code: 'browser_presentation_stale' };
          present(request.id, request.bounds, request.layout);
          if (tab && request.presentationRevision !== undefined) {
            tab.presentationRevision = request.presentationRevision;
            tab.presentationGeneration = revisionGeneration;
          }
          if (tab) delete tab.presentationFrame;
          if (tab && request.bounds && active === request.id && tab.view.getVisible()) {
            const scope = presentationScope && {
              storeId: presentationScope.storeId,
              sessionId: presentationScope.sessionId,
              generation: presentationScope.generation,
              viewSelection: presentationScope.viewSelection,
            };
            tab.presentationScope = isNativeBrowserRestoreScope(scope) ? scope : undefined;
          }
        } else if (tab) {
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
  const navigation = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => {
    if (mainFrame && !inPlace) replaceRenderer();
  };
  const displayReady = () => {
    if (retainedDisplay && !retainedDisplay.ready) cancelRetainedDisplay();
  };
  const rendererFailed = () => replaceRenderer(false);
  owner.on('did-start-navigation', navigation);
  owner.on('render-process-gone', rendererFailed);
  owner.on('preload-error', rendererFailed);
  owner.on('dom-ready', displayReady);
  // Native events and synchronous Renderer corrections share the same current-
  // window calculation. The queued event coalesces work; it is not a guarantee
  // that independent native surfaces will be presented in the same OS frame.
  const applyNativeResize = () => {
    if (disposed || window.isDestroyed()) return;
    const tab = active ? tabs.get(active) : undefined;
    if (tab?.presentation?.layout && chromeHost?.readyFor(tab.state.id, tab.presentationScope)) {
      const scope = (options.grantScope ?? options.selectedScope)?.();
      if (
        scope &&
        tab.presentationScope &&
        (['storeId', 'sessionId', 'generation', 'viewSelection'] as const).every(
          (key) => scope[key] === tab.presentationScope![key],
        )
      )
        applyCurrentLayout(tab);
    } else {
      // Bootstrap and withdrawn Root still need the current logical viewport.
      chromeHost?.syncViewport();
    }
    syncInput();
  };
  const resize = () => {
    if (retainedDisplay && !displayCurrent()) cancelRetainedDisplay();
    cancelMenu();
    chromeHost?.invalidateGeometry();
    const tab = active ? tabs.get(active) : undefined;
    if (tab?.presentation?.layout && chromeHost?.readyFor(tab.state.id, tab.presentationScope)) {
      // The old coordinates cease to qualify immediately, before deferred
      // visual layout. Never let a captured old basis span this native resize.
      tab.sizeEpoch++;
    }
    if (chromeHost) queueNativeWindowLayout(window, applyNativeResize);
    syncInput();
  };
  window.on('resize', resize);
  window.on('hide', hide);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    cancelNativeWindowLayout(window, applyNativeResize);
    chromeHost?.dispose();
    cancelLayout();
    cancelMenu();
    unconfigureGrants?.();
    inputShield.dispose();
    for (const id of [...tabs.keys()]) close(id, true);
    ipcMain.removeHandler(nativeBrowserChannel);
    ipcMain.removeHandler(nativeBrowserMenuChannel);
    ipcMain.off?.(nativeBrowserLayoutChannel, layoutCommit);
    ipcMain.off?.(nativeBrowserMenuCancelChannel, menuCancel);
    browsing.webRequest.onBeforeRequest(null);
    browsing.off('will-download', download);
    browsing.setPermissionRequestHandler(null);
    browsing.setPermissionCheckHandler(null);
    owner.off('before-input-event', menuInput);
    window.off('blur', resetMenuInput);
    owner.off('did-start-navigation', navigation);
    owner.off('render-process-gone', rendererFailed);
    owner.off('preload-error', rendererFailed);
    owner.off('dom-ready', displayReady);
    ipcMain.off?.(nativeBrowserDisplayChannel, displayBootstrap);
    window.off('resize', resize);
    window.off('hide', hide);
  };
  window.once('closed', dispose);
  return dispose;
}
