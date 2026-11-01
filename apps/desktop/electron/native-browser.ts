import { createHash, randomUUID } from 'node:crypto';
import * as electron from 'electron';
import { type IpcMain, session, WebContentsView } from 'electron';
import {
  browserAddress,
  isNativeBrowserPreparation,
  isNativeBrowserRestoreScope,
  type NativeBrowserBounds,
  type NativeBrowserClosePreparation,
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
  nativeBrowserPreparationCancelChannel,
  nativeBrowserPreparationChannel,
  nativeBrowserWitnessSamplePoints,
  parseNativeBrowserMenuRequest,
  parseNativeBrowserRequest,
  projectNativeBrowserBounds,
  projectNativeBrowserLayout,
} from '../src/native-browser-bridge';
import {
  type NativeBrowserChromeOwner,
  sameNativeBrowserChromeOwner,
} from '../src/native-browser-chrome-bridge';
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
  waitForDisplayDocument?: (signal: AbortSignal) => Promise<boolean>;
  unprotect?: () => void;
  scope?: BrowserPageScope;
  draft?: { key: string; frame: Electron.WebFrameMain; epoch: number };
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
  nativeProjection?: {
    source: NonNullable<BrowserTab['presentation']>;
    bounds: NativeBrowserBounds;
    layout: NativeBrowserLayout;
  };
  presentationRevision?: number;
  presentationGeneration?: number;
  presentationCapture?: Promise<NativeBrowserPresentationFrame>;
  presentationReady?: { key: string; read: Promise<void> };
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
  scope?: NativeBrowserRestoreScope;
  draft?: string;
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
  let rootEpoch = 0;
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
  let heldPresentation: { tab: BrowserTab; key: string } | undefined;
  type Preparation = {
    key: string;
    from: BrowserTab;
    target: BrowserTab;
    scope: NativeBrowserChromeOwner;
    frame: Electron.WebFrameMain;
    targetFrame: Electron.WebFrameMain;
    targetToken: string;
    sourceToken: string;
    url: string;
    bounds: Electron.Rectangle;
    ready: boolean;
    expires: number;
    timer: ReturnType<typeof setTimeout>;
    resolve(value: { key: string } | null): void;
  };
  let preparation: Preparation | undefined;
  const pageToken = (tab: BrowserTab) =>
    JSON.stringify([
      tab.state.id,
      tab.view.webContents.id,
      tab.generation,
      tab.chromeNavigation,
      automation?.state(tab.state.id)?.incarnation,
      automation?.state(tab.state.id)?.navigation,
    ]);
  const scopeKey = (scope: BrowserPageScope) => JSON.stringify([scope.storeId, scope.sessionId]);
  const chromeOwner = (tab: BrowserTab): NativeBrowserChromeOwner | undefined =>
    tab.draft ? { draft: tab.draft.key } : tab.presentationScope;
  const requestOwner = (request: { draft?: string; scope?: NativeBrowserRestoreScope }) =>
    request.draft ? { draft: request.draft } : request.scope;
  const displayOwnerCurrent = (tab: BrowserTab, scope: NativeBrowserChromeOwner) => {
    if ('draft' in scope) return draftCurrent(tab, scope.draft);
    return (
      !tab.draft &&
      tab.scope?.storeId === scope.storeId &&
      tab.scope.sessionId === scope.sessionId &&
      sameNativeBrowserChromeOwner(
        (options.grantScope ?? options.selectedScope)?.() as NativeBrowserRestoreScope | undefined,
        scope,
      )
    );
  };
  const inputShield = createBrowserInputShield(window, () => {
    cancelClosePreparation();
    cancelRetainedDisplay();
    cancelPreparation();
    chromeHost?.cancelPresentationHold();
    clearHeldPresentation();
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
  let initialDisplay:
    | {
        tab: BrowserTab;
        request: DrawnPresentation;
        rootFrame: Electron.WebFrameMain;
        pageFrame?: Electron.WebFrameMain;
        pageToken?: string;
        url?: string;
        generation: number;
        bounds: Electron.Rectangle;
        controller: AbortController;
        timer: ReturnType<typeof setTimeout>;
        ready: boolean;
        offered: boolean;
      }
    | undefined;
  type Closing = {
    tab: BrowserTab;
    scope: NativeBrowserChromeOwner;
    receipt: NativeBrowserClosePreparation;
    frame: Electron.WebFrameMain;
    epoch: number;
    token: string;
    bounds: Electron.Rectangle;
    zoom: number;
    timer: ReturnType<typeof setTimeout>;
    subscribed: boolean;
    marked: boolean;
    cleared: boolean;
    confirming?: (value: boolean) => void;
    finishing?: (value: boolean) => void;
  };
  let closing: Closing | undefined;
  function cancelInitialDisplay(id?: string, adopted = false) {
    const d = initialDisplay;
    if (!d || (id && d.tab.state.id !== id)) return;
    initialDisplay = undefined;
    clearTimeout(d.timer);
    if (adopted) return;
    d.controller.abort();
    const contents = tabs.get(d.tab.state.id) === d.tab ? d.tab.view.webContents : undefined;
    if (contents && !contents.isDestroyed() && active !== d.tab.state.id) {
      d.tab.view.setVisible(false);
      delete d.tab.presentation;
      delete d.tab.nativeProjection;
      automation?.present(d.tab.state.id, false);
    }
    chromeHost?.release(d.tab.state.id);
  }
  let frameSubscription = 0;
  let subscribed = false;
  function clearHeldPresentation(key?: string) {
    const held = heldPresentation;
    if (!held || (key && held.key !== key)) return;
    if (
      tabs.get(held.tab.state.id) === held.tab &&
      !held.tab.view.webContents.isDestroyed() &&
      (active !== held.tab.state.id || !held.tab.presentation) &&
      currentPreparation()?.target !== held.tab
    )
      held.tab.view.setVisible(false);
    heldPresentation = undefined;
  }
  const currentHeldPresentation = () => {
    const held = heldPresentation;
    const receipt = held && chromeHost?.holdsPresentation(held.tab.state.id);
    if (
      !held ||
      receipt?.key !== held.key ||
      !displayShieldReady ||
      !inputShield.available() ||
      tabs.get(held.tab.state.id) !== held.tab ||
      held.tab.view.webContents.isDestroyed() ||
      !held.tab.view.getVisible()
    )
      return undefined;
    return held;
  };
  function currentPreparation() {
    const p = preparation;
    const target =
      p && tabs.get(p.target.state.id) === p.target ? p.target.view.webContents : undefined;
    if (
      !p ||
      performance.now() >= p.expires ||
      disposed ||
      owner.isDestroyed() ||
      owner.mainFrame !== p.frame ||
      !target ||
      target.isDestroyed() ||
      target.mainFrame !== p.targetFrame ||
      pageToken(p.target) !== p.targetToken ||
      target.getURL() !== p.url ||
      !p.target.view.getVisible() ||
      target.isLoadingMainFrame() ||
      !displayShieldReady ||
      !inputShield.available()
    )
      return undefined;
    const viewport = chromeHost?.presentationViewport(p.scope);
    const from =
      !p.ready && tabs.get(p.from.state.id) === p.from ? p.from.view.webContents : undefined;
    if (
      !displayOwnerCurrent(p.target, p.scope) ||
      (!p.ready && !displayOwnerCurrent(p.from, p.scope)) ||
      !viewport ||
      !sameRectangle(viewport, p.bounds) ||
      !sameRectangle(p.target.view.getBounds(), p.bounds) ||
      (!p.ready &&
        (!from ||
          from.isDestroyed() ||
          !p.from.view.getVisible() ||
          pageToken(p.from) !== p.sourceToken))
    )
      return undefined;
    return p;
  }
  function cancelPreparation(key?: string, adopted = false) {
    const p = preparation;
    if (!p || (key && p.key !== key)) return;
    preparation = undefined;
    clearTimeout(p.timer);
    p.resolve(null);
    const target = tabs.get(p.target.state.id) === p.target ? p.target.view.webContents : undefined;
    if (
      !adopted &&
      target &&
      !target.isDestroyed() &&
      !(active === p.target.state.id && p.target.presentation) &&
      currentHeldPresentation()?.tab !== p.target
    )
      p.target.view.setVisible(false);
  }
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
  const inputBlocked = (id: string) => {
    const phase = automation?.state(id)?.phase;
    return phase !== undefined && !['human', 'armed'].includes(phase);
  };
  const syncInput = () => {
    if (closing) {
      if (closePreparationCurrent(closing)) {
        inputShield.sync(closing.tab.view, true);
        return;
      }
      cancelClosePreparation();
    }
    const prepared = currentPreparation();
    if (prepared) {
      const from =
        tabs.get(prepared.from.state.id) === prepared.from
          ? prepared.from.view.webContents
          : undefined;
      inputShield.sync(
        from && !from.isDestroyed() && prepared.from.view.getVisible()
          ? prepared.from.view
          : prepared.target.view,
        true,
      );
      return;
    }
    if (preparation) cancelPreparation();
    const held = currentHeldPresentation();
    if (held) {
      inputShield.sync(held.tab.view, true);
      return;
    }
    if (heldPresentation) {
      chromeHost?.cancelPresentationHold(heldPresentation.tab.state.id);
      clearHeldPresentation();
    }
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
      ...(tab.scope && automation?.state(tab.state.id)
        ? { control: automation.state(tab.state.id) }
        : {}),
      canGoBack: tab.view.webContents.navigationHistory.canGoBack(),
      canGoForward: tab.view.webContents.navigationHistory.canGoForward(),
    };
    syncInput();
    if (
      tab.drawnPresentation &&
      !tab.state.loading &&
      !pendingLayout &&
      initialDisplay?.tab !== tab
    )
      startNativeFrames(tab);
    if (tab.notification !== undefined) return;
    tab.notification = setTimeout(() => {
      tab.notification = undefined;
      if (!disposed && tabs.get(tab.state.id) === tab && !window.isDestroyed())
        window.webContents.send(nativeBrowserEventChannel, tab.state);
    }, 16);
  };
  const hide = () => {
    cancelClosePreparation();
    cancelInitialDisplay();
    cancelPreparation();
    chromeHost?.cancelPresentationHold();
    clearHeldPresentation();
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
    cancelClosePreparation();
    cancelInitialDisplay();
    cancelPreparation();
    chromeHost?.cancelPresentationHold();
    clearHeldPresentation();
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
      delete tab.nativeProjection;
      delete tab.presentationScope;
      delete tab.presentationFrame;
    }
  };
  const close = (id: string, force = false) => {
    cancelClosePreparation(undefined, id);
    cancelInitialDisplay(id);
    if (
      preparation &&
      (preparation.target.state.id === id ||
        (!preparation.ready && preparation.from.state.id === id))
    )
      cancelPreparation();
    chromeHost?.cancelPresentationHold(id);
    if (retainedDisplay?.tab.state.id === id) cancelRetainedDisplay();
    const tab = tabs.get(id);
    if (!tab) return;
    stopNativeFrames(tab);
    cancelLayout(id);
    cancelMenu(id);
    if (!force && automation?.retained(id)) {
      tab.presentation = undefined;
      delete tab.nativeProjection;
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
    tab.view.setVisible(false);
    if (!window.isDestroyed()) window.contentView.removeChildView(tab.view);
    if (!tab.view.webContents.isDestroyed())
      tab.view.webContents.close({ waitForBeforeUnload: false });
  };
  const navigate = (tab: BrowserTab, url: string) => {
    cancelInitialDisplay(tab.state.id);
    if (preparation?.target === tab || (!preparation?.ready && preparation?.from === tab))
      cancelPreparation();
    chromeHost?.cancelPresentationHold(tab.state.id);
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
  const create = (id: string, grantedScope?: BrowserPageScope, draft?: string): BrowserTab => {
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
        const selected = draft ? undefined : (grantedScope ?? options.selectedScope?.());
        return selected ? { storeId: selected.storeId, sessionId: selected.sessionId } : undefined;
      })(),
      ...(draft ? { draft: { key: draft, frame: owner.mainFrame, epoch: rootEpoch } } : {}),
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
      if (
        mainFrame &&
        (preparation?.target === tab || (!preparation?.ready && preparation?.from === tab))
      )
        cancelPreparation();
      if (mainFrame) chromeHost?.cancelPresentationHold(id);
      if (mainFrame && !inPlace) {
        cancelClosePreparation(undefined, id);
        tab.chromeNavigation++;
        if (retainedDisplay?.tab === tab) cancelRetainedDisplay();
        // CDP, links and same-URL reloads do not pass through navigate().
        // Their previous document pixels and coalescing callbacks expire too.
        stopNativeFrames(tab);
        tab.state = { ...tab.state, loading: true };
      }
    });
    contents.on('did-navigate-in-page', (_event, _url, mainFrame) => {
      if (mainFrame) {
        cancelClosePreparation(undefined, id);
        if (preparation?.target === tab || (!preparation?.ready && preparation?.from === tab))
          cancelPreparation();
        chromeHost?.cancelPresentationHold(id);
        tab.chromeNavigation++;
      }
    });
    contents.on('destroyed', () => {
      cancelClosePreparation(undefined, id);
      if (preparation?.target === tab || (!preparation?.ready && preparation?.from === tab))
        cancelPreparation();
      chromeHost?.cancelPresentationHold(id);
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
      () =>
        inputBlocked(id) ||
        retainedDisplay?.tab === tab ||
        !!heldPresentation ||
        !!preparation ||
        initialDisplay?.tab === tab ||
        closing?.tab === tab,
    );
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
      }
    });
    const failedDisplayDocument = (
      _event: unknown,
      code: number,
      _description: string,
      url: string,
      mainFrame: boolean,
    ) => {
      if (mainFrame && code !== -3 && url === documentUrl) documentReady.stopped();
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
                heldPresentation?.tab !== tab &&
                preparation?.target !== tab &&
                initialDisplay?.tab !== tab &&
                closing?.tab !== tab &&
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
        if (mainFrame && !inPlace) {
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
      ) => {
        // An aborted old loader can arrive after a new start, even at the same URL.
        // An actual stop before DOM-ready is handled by did-stop-loading below.
        if (mainFrame && code !== -3 && url === documentUrl) {
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
      if (preparation?.target === tab || (!preparation?.ready && preparation?.from === tab))
        cancelPreparation();
      chromeHost?.cancelPresentationHold(id);
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
    releaseChrome = true,
  ) => {
    const tab = tabs.get(id);
    if (!tab) return;
    if (retainedDisplay && (!bounds || retainedDisplay.tab !== tab)) cancelRetainedDisplay();
    if (tab.state.error === 'process_gone' && inputBlocked(id)) bounds = null;
    if (!bounds) {
      cancelInitialDisplay(id);
      if (preparation?.target === tab) cancelPreparation();
      const receipt = chromeHost?.holdsPresentation(id);
      const retain =
        !!receipt &&
        displayShieldReady &&
        inputShield.available() &&
        tab.view.getVisible() &&
        !tab.view.webContents.isDestroyed() &&
        sameRectangle(tab.view.getBounds(), receipt.viewport);
      if (retain) {
        if (
          heldPresentation &&
          (heldPresentation.tab !== tab || heldPresentation.key !== receipt.key)
        )
          clearHeldPresentation();
        heldPresentation = { tab, key: receipt.key };
        tab.sizeEpoch++;
        inputShield.sync(tab.view, true);
      }
      if (releaseChrome) chromeHost?.release(id);
      stopNativeFrames(tab);
      cancelLayout(id);
      cancelMenu(id);
      tab.presentation = undefined;
      delete tab.nativeProjection;
      if (!retain || heldPresentation?.tab !== tab) tab.view.setVisible(false);
      automation?.present(id, false);
      if (active === id) active = undefined;
      syncInput();
      return;
    }
    const zoom = owner.getZoomFactor();
    const [width = 0, height = 0] = window.getContentSize();
    // Renderer measurements are inputs, never another native geometry writer.
    if (!layout && tab.presentation?.layout) throw Error('invalid_browser_request');
    if (layout) assertPanelMeasurement(bounds, layout, width / zoom, height / zoom);
    tab.presentation = { bounds, ...(layout ? { layout } : {}), width, height, zoom };
    delete tab.nativeProjection;
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
    if (preparation && tab !== preparation.from && tab !== preparation.target) cancelPreparation();
    const zoom = owner.getZoomFactor();
    const [width = 0, height = 0] = window.getContentSize();
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
    // Native constraints have history (a min clamp changes the relative share).
    // Keep that history separate from the last accepted Renderer anchor/proof.
    if (projected) tab.nativeProjection = { source: anchor, ...projected };
    const bounds = anchor.layout ? projected?.bounds : anchor.bounds;
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
        if (
          currentHeldPresentation()?.tab !== other &&
          currentPreparation()?.target !== other &&
          other.view.getVisible()
        )
          other.view.setVisible(false);
        automation?.present(otherId, false);
      }
    if (active !== id) cancelMenu();
    active = id;
    if (tab.scope) lastPresented.set(scopeKey(tab.scope), id);
    if (tab.draft) lastPresented.set(`draft:${tab.draft.key}`, id);
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
    chromeHost?.layout(id, { x, y, ...viewportSize }, chromeOwner(tab));
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
    const held = currentHeldPresentation();
    if (held && held.tab !== tab) {
      const children = window.contentView.children,
        sourceIndex = children.indexOf(held.tab.view),
        targetIndex = children.indexOf(tab.view);
      // Keep the visible source layer attached; move only its replacement below it.
      if (targetIndex > sourceIndex) window.contentView.addChildView(tab.view, sourceIndex);
    }
    if (tab.view.getVisible() !== visible) tab.view.setVisible(visible);
    rendererPresented = true;
    if (tab.scope && replacedPresentation.get(scopeKey(tab.scope)) === id)
      replacedPresentation.delete(scopeKey(tab.scope));
    automation?.present(id, window.isVisible() && !window.isMinimized());
    const prepared = currentPreparation();
    if (
      prepared?.target === tab &&
      prepared.ready &&
      chromeHost?.readyFor(id, chromeOwner(tab)) &&
      sameRectangle(tab.view.getBounds(), prepared.bounds)
    )
      cancelPreparation(prepared.key, true);
    syncInput();
    if (visible) prepareHeldTarget(tab);
    if (visible && !heldPresentation) chromeHost?.completePresentation(id);
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
        const tab = tabs.get(id),
          contents = tab?.view.webContents;
        if (
          !tab ||
          !contents ||
          contents.isDestroyed() ||
          (tab.draft && !draftCurrent(tab, tab.draft.key))
        )
          return;
        return {
          id,
          view: tab.view,
          // Page ownership exists before its first presentation. Waiting for a
          // drawn scope here prevents the initial Chrome offer from starting.
          scope: tab.scope,
          ...(tab.draft ? { draft: tab.draft.key } : {}),
          token: pageToken(tab),
        };
      },
      onReady(id) {
        const initial = initialDisplay;
        if (initial?.tab.state.id === id) {
          if (!initial.ready || !initial.offered || !initialDisplayCurrent(initial)) return;
          adoptInitialDisplay(initial);
          return;
        }
        const tab = tabs.get(id),
          request = tab?.drawnRequest;
        if (
          !tab ||
          !request ||
          !requestOwner(request) ||
          !layoutCurrent({ tab, request, confirmed: false })
        )
          return;
        cancelLayout();
        stopNativeFrames(tab);
        tab.presentationScope = request.scope;
        present(id, request.bounds, request.layout);
      },
      onSuspend(id) {
        if (!disposed && tabs.has(id)) present(id, null, undefined, false);
      },
      preparedPresentation() {
        const p = currentPreparation();
        return p?.ready
          ? { fromId: p.from.state.id, targetId: p.target.state.id, scope: p.scope }
          : undefined;
      },
      onShellReleased(id) {
        if (!id) return;
        cancelInitialDisplay(id);
        if (preparation?.from.state.id === id || preparation?.target.state.id === id)
          cancelPreparation();
        cancelClosePreparation(undefined, id);
      },
      onContextChanged() {
        cancelClosePreparation();
        cancelInitialDisplay();
        cancelPreparation();
        cancelLayout();
        for (const [id, tab] of tabs) {
          if (retainedDisplay?.tab === tab) continue;
          stopNativeFrames(tab);
          delete tab.drawnRequest;
          delete tab.drawnPresentation;
          present(id, null, undefined, false);
        }
      },
      onRootReturnCancelled(id) {
        cancelClosePreparation(undefined, id);
      },
      onPresentationHoldEnd(id, key) {
        if (heldPresentation?.tab.state.id !== id || heldPresentation.key !== key) return;
        clearHeldPresentation(key);
        syncInput();
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
  function prepareHeldTarget(tab: BrowserTab) {
    const held = currentHeldPresentation();
    if (!held || held.tab === tab) return;
    if (chromeHost?.holdsPresentation(held.tab.state.id)?.targetId !== tab.state.id) {
      chromeHost?.cancelPresentationHold();
      return;
    }
    if (tab.presentationReady) {
      if (tab.presentationReady.key !== held.key) chromeHost?.cancelPresentationHold(tab.state.id);
      return;
    }
    const contents = tab.view.webContents,
      frame = contents.mainFrame,
      rootFrame = owner.mainFrame,
      bounds = tab.view.getBounds(),
      generation = tab.generation,
      navigation = tab.chromeNavigation,
      revision = tab.presentationRevision;
    const current = () =>
      heldPresentation === held &&
      currentHeldPresentation() === held &&
      active === tab.state.id &&
      tabs.get(tab.state.id) === tab &&
      !contents.isDestroyed() &&
      contents.mainFrame === frame &&
      owner.mainFrame === rootFrame &&
      tab.generation === generation &&
      tab.chromeNavigation === navigation &&
      tab.presentationRevision === revision &&
      tab.view.getVisible() &&
      sameRectangle(tab.view.getBounds(), bounds) &&
      sameRectangle(chromeHost!.holdsPresentation(held.tab.state.id)!.viewport, bounds);
    // Read only this target's current full frame as readiness. No screenshot is
    // stored, shown or returned to the model; the Host deadline bounds the hold.
    try {
      const read = contents
        .capturePage()
        .then(
          (image) => {
            if (!current()) {
              if (heldPresentation === held) chromeHost?.cancelPresentationHold(tab.state.id);
              return;
            }
            if (!fullFrameMatches(image, bounds)) {
              chromeHost?.cancelPresentationHold(tab.state.id);
              return;
            }
            chromeHost?.completePresentation(tab.state.id);
          },
          () => {
            if (heldPresentation === held) chromeHost?.cancelPresentationHold(tab.state.id);
          },
        )
        .finally(() => {
          if (tab.presentationReady?.read === read) delete tab.presentationReady;
        });
      tab.presentationReady = { key: held.key, read };
      void read.catch(() => {
        if (heldPresentation === held) chromeHost?.cancelPresentationHold(tab.state.id);
      });
    } catch {
      chromeHost?.cancelPresentationHold(tab.state.id);
    }
  }
  function preparePresentation(fromId: string, targetId: string): Promise<{ key: string } | null> {
    cancelPreparation();
    const from = tabs.get(fromId),
      target = tabs.get(targetId),
      fromContents = from?.view.webContents,
      targetContents = target?.view.webContents,
      scope = from && chromeOwner(from);
    if (
      !from ||
      !target ||
      !fromContents ||
      !targetContents ||
      active !== fromId ||
      retainedDisplay ||
      !scope ||
      fromContents.isDestroyed() ||
      targetContents.isDestroyed() ||
      !from.view.getVisible() ||
      !httpUrl(target.view.webContents.getURL()) ||
      !target.state.url ||
      target.state.error ||
      target.state.loading ||
      target.view.webContents.isLoadingMainFrame() ||
      target.presentationReady ||
      !displayShieldReady ||
      !inputShield.available() ||
      [from, target].some((tab) => !displayOwnerCurrent(tab, scope))
    )
      return Promise.resolve(null);
    const bounds = chromeHost?.presentationViewport(scope);
    if (
      !bounds ||
      !sameRectangle(from.view.getBounds(), bounds) ||
      (target.view.getVisible() && currentHeldPresentation()?.tab !== target)
    )
      return Promise.resolve(null);
    let resolve!: Preparation['resolve'];
    const promise = new Promise<{ key: string } | null>((done) => {
      resolve = done;
    });
    const expire = () => {
      if (preparation !== p) return;
      cancelPreparation(p.key);
      syncInput();
      chromeHost?.update();
    };
    const p: Preparation = {
      key: randomUUID().replaceAll('-', ''),
      from,
      target,
      scope: { ...scope },
      frame: owner.mainFrame,
      targetFrame: target.view.webContents.mainFrame,
      targetToken: pageToken(target),
      sourceToken: pageToken(from),
      url: target.view.webContents.getURL(),
      bounds,
      ready: false,
      expires: performance.now() + 100,
      resolve,
      timer: setTimeout(expire, 100),
    };
    preparation = p;
    try {
      // Native preparation changes the real viewport but creates no model observation.
      // Retire the previous coordinate basis before resizing, just as normal layout does.
      stopNativeFrames(target);
      target.sizeEpoch++;
      delete target.presentationFrame;
      target.viewportSize = { width: bounds.width, height: bounds.height };
      if (!sameRectangle(target.view.getBounds(), bounds)) target.view.setBounds(bounds);
      if (!target.view.getVisible()) {
        const children = window.contentView.children,
          sourceIndex = children.indexOf(from.view),
          targetIndex = children.indexOf(target.view);
        if (sourceIndex < 0 || targetIndex < 0) {
          expire();
          return promise;
        }
        if (targetIndex > sourceIndex) window.contentView.addChildView(target.view, sourceIndex);
        target.view.setVisible(true);
      }
      automation?.present(targetId, false);
      syncInput();
      const read = target.view.webContents
        .capturePage()
        .then((image) => {
          if (currentPreparation() !== p || !fullFrameMatches(image, bounds)) {
            expire();
            return;
          }
          p.ready = true;
          p.expires = performance.now() + 1500;
          clearTimeout(p.timer);
          p.timer = setTimeout(expire, 1500);
          p.resolve({ key: p.key });
        }, expire)
        .finally(() => {
          if (target.presentationReady?.read === read) delete target.presentationReady;
        });
      target.presentationReady = { key: p.key, read };
      void read.catch(expire);
    } catch {
      expire();
    }
    return promise;
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
      (request.draft
        ? draftCurrent(tab, request.draft)
        : !!selected &&
          !!request.scope &&
          (['storeId', 'sessionId', 'generation', 'viewSelection'] as const).every(
            (key) => selected[key] === request.scope![key],
          )) &&
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
      !request?.scope ||
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
  const matchesDraw = (
    image: Electron.NativeImage,
    request: {
      bounds: NativeBrowserBounds;
      layout: Pick<NativeBrowserLayout, 'windowWidth' | 'windowHeight'>;
      witness: { key: string; step: 1 | 2 };
    },
  ) => {
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
  const acknowledgeDisplay = (request: DrawnPresentation, presented: boolean, error = false) => {
    if (owner.isDestroyed()) return;
    owner.send(nativeBrowserLayoutFrameChannel, {
      id: request.id,
      ...(request.draft ? { draft: request.draft } : { scope: request.scope }),
      presentationRevision: request.presentationRevision,
      key: request.witness.key,
      step: 2,
      presented,
      ...(error ? { error: 'browser_presentation_unavailable' } : {}),
    });
  };
  function closePreparationCurrent(p: Closing) {
    const tab = tabs.get(p.tab.state.id);
    const [width = 0, height = 0] = window.getContentSize();
    return (
      closing === p &&
      !disposed &&
      !window.isDestroyed() &&
      !owner.isDestroyed() &&
      owner.mainFrame === p.frame &&
      rootEpoch === p.epoch &&
      tab === p.tab &&
      !tab.view.webContents.isDestroyed() &&
      pageToken(tab) === p.token &&
      window.isVisible() &&
      !window.isMinimized() &&
      owner.getZoomFactor() === p.zoom &&
      width === p.bounds.width &&
      height === p.bounds.height &&
      displayOwnerCurrent(tab, p.scope) &&
      !!chromeHost?.rootReturnCurrent(tab.state.id, p.scope)
    );
  }
  function stopCloseFrames(p: Closing) {
    clearTimeout(p.timer);
    if (!p.subscribed) return;
    p.subscribed = false;
    try {
      owner.endFrameSubscription();
    } catch {}
  }
  function cancelClosePreparation(key?: string, id?: string) {
    const p = closing;
    if (!p || (key && key !== p.receipt.key) || (id && id !== p.tab.state.id)) return;
    closing = undefined;
    stopCloseFrames(p);
    p.confirming?.(false);
    p.finishing?.(false);
    chromeHost?.cancelRootReturn(p.tab.state.id);
  }
  function finishClosePreparation(p: Closing) {
    if (!p.finishing || !p.cleared || !closePreparationCurrent(p)) return;
    closing = undefined;
    stopCloseFrames(p);
    try {
      close(p.tab.state.id, true);
      chromeHost?.finishRootReturn(p.tab.state.id);
      p.finishing(true);
    } catch {
      chromeHost?.cancelRootReturn(p.tab.state.id);
      p.finishing(false);
    }
  }
  function prepareClose(id: string, draft?: string): NativeBrowserClosePreparation | null {
    cancelClosePreparation();
    const tab = tabs.get(id),
      scope = tab && chromeOwner(tab);
    if (
      !tab ||
      !scope ||
      active !== id ||
      !displayOwnerCurrent(tab, scope) ||
      (tab.draft ? !draftCurrent(tab, draft) : !!draft) ||
      retainedDisplay ||
      !displayShieldReady ||
      !inputShield.available()
    )
      return null;
    cancelInitialDisplay();
    cancelPreparation();
    cancelLayout();
    const layout = chromeHost?.beginRootReturn(id, scope);
    if (!layout) return null;
    const receipt = {
      key: randomUUID().replaceAll('-', ''),
      witness: randomUUID().replaceAll('-', '').slice(0, 24),
      ...layout,
    };
    const [width = 0, height = 0] = window.getContentSize();
    const p: Closing = {
      tab,
      scope,
      receipt,
      frame: owner.mainFrame,
      epoch: rootEpoch,
      token: pageToken(tab),
      bounds: { x: 0, y: 0, width, height },
      zoom: owner.getZoomFactor(),
      timer: setTimeout(() => cancelClosePreparation(receipt.key), 5000),
      subscribed: false,
      marked: false,
      cleared: false,
    };
    closing = p;
    tab.sizeEpoch++;
    delete tab.presentationFrame;
    stopNativeFrames(tab);
    syncInput();
    try {
      p.subscribed = true;
      owner.beginFrameSubscription((image) => {
        if (closing !== p) return;
        if (!closePreparationCurrent(p)) {
          cancelClosePreparation(receipt.key);
          return;
        }
        try {
          const size = image.getSize(),
            scale = size.width / receipt.width;
          if (
            !fullFrameMatches(image, {
              x: 0,
              y: 0,
              width: receipt.width * p.zoom,
              height: receipt.height * p.zoom,
            }) ||
            scale < 0.25 ||
            scale > 8 ||
            Math.abs(scale - size.height / receipt.height) > 0.02
          )
            return;
          const draw = {
            bounds: receipt.bounds,
            layout: { windowWidth: receipt.width, windowHeight: receipt.height },
            witness: { key: receipt.witness, step: 1 as const },
          };
          const marked = matchesDraw(image, draw);
          if (!p.marked) {
            if (!p.confirming || !marked) return;
            p.marked = true;
            p.confirming(true);
            delete p.confirming;
            return;
          }
          if (marked) return;
          const bytes = image.toBitmap();
          if (bytes.length !== size.width * size.height * 4) return;
          // Transparent/empty output cannot prove that Root has replaced the nonce.
          const points = nativeBrowserWitnessSamplePoints(receipt.bounds, scale, scale);
          for (const point of points) {
            if (
              point.x < 0 ||
              point.y < 0 ||
              point.x >= size.width ||
              point.y >= size.height ||
              bytes[(point.y * size.width + point.x) * 4 + 3]! < 250
            )
              return;
          }
          p.cleared = true;
          finishClosePreparation(p);
        } catch {
          cancelClosePreparation(receipt.key);
        }
      });
      owner.invalidate();
      return receipt;
    } catch {
      cancelClosePreparation(receipt.key);
      return null;
    }
  }
  function confirmClose(key: string): Promise<boolean> {
    const p = closing;
    if (!p || p.receipt.key !== key || !closePreparationCurrent(p) || p.confirming || p.finishing)
      return Promise.resolve(false);
    if (p.marked) return Promise.resolve(true);
    return new Promise((resolve) => {
      p.confirming = resolve;
      owner.invalidate();
    });
  }
  function finishClose(key: string): Promise<boolean> {
    const p = closing;
    if (!p || p.receipt.key !== key || !closePreparationCurrent(p) || !p.marked || p.finishing)
      return Promise.resolve(false);
    return new Promise((resolve) => {
      p.finishing = resolve;
      finishClosePreparation(p);
      owner.invalidate();
    });
  }
  const initialDisplayCurrent = (d: NonNullable<typeof initialDisplay>) => {
    const contents = tabs.get(d.tab.state.id) === d.tab ? d.tab.view.webContents : undefined;
    return (
      initialDisplay === d &&
      !d.controller.signal.aborted &&
      !!contents &&
      !contents.isDestroyed() &&
      !owner.isDestroyed() &&
      owner.mainFrame === d.rootFrame &&
      d.tab.generation === d.generation &&
      (!d.pageFrame ||
        (contents.mainFrame === d.pageFrame &&
          pageToken(d.tab) === d.pageToken &&
          contents.getURL() === d.url)) &&
      d.tab.drawnRequest === d.request &&
      layoutCurrent({ tab: d.tab, request: d.request, confirmed: true }) &&
      sameRectangle(d.tab.view.getBounds(), d.bounds)
    );
  };
  const adoptInitialDisplay = (d: NonNullable<typeof initialDisplay>) => {
    if (!initialDisplayCurrent(d)) return;
    const { tab, request } = d;
    cancelInitialDisplay(tab.state.id, true);
    tab.presentationScope = request.scope;
    present(tab.state.id, request.bounds, request.layout);
    if (active === tab.state.id && tab.view.getVisible()) acknowledgeDisplay(request, true);
  };
  const beginInitialDisplay = (tab: BrowserTab, request: DrawnPresentation) => {
    cancelInitialDisplay();
    const zoom = owner.getZoomFactor(),
      [width = 0, height = 0] = window.getContentSize();
    assertPanelMeasurement(request.bounds, request.layout, width / zoom, height / zoom);
    const x = Math.ceil(request.bounds.x * zoom),
      y = Math.ceil(request.bounds.y * zoom);
    const bounds = {
      x,
      y,
      width: Math.floor((request.bounds.x + request.bounds.width) * zoom) - x,
      height: Math.floor((request.bounds.y + request.bounds.height) * zoom) - y,
    };
    const controller = new AbortController();
    const fail = () => {
      if (!d || initialDisplay !== d) return;
      const current = initialDisplayCurrent(d);
      cancelInitialDisplay(tab.state.id);
      if (current) acknowledgeDisplay(request, false, true);
    };
    const d: NonNullable<typeof initialDisplay> = {
      tab,
      request,
      bounds,
      controller,
      rootFrame: owner.mainFrame,
      generation: tab.generation,
      ready: false,
      offered: false,
      timer: setTimeout(fail, 12000),
    };
    initialDisplay = d;
    // The Root remains attached and full size. Prepare only the real target
    // underneath it, at the exact witnessed viewport, without exposing pixels.
    tab.sizeEpoch++;
    tab.viewportSize = { width: bounds.width, height: bounds.height };
    const children = window.contentView.children,
      rootIndex = children.findIndex(
        (view) => view instanceof WebContentsView && view.webContents === owner,
      );
    if (rootIndex < 0) {
      fail();
      return;
    }
    if (children.indexOf(tab.view) > rootIndex)
      window.contentView.addChildView(tab.view, rootIndex);
    tab.view.setBounds(bounds);
    tab.view.setVisible(true);
    automation?.present(tab.state.id, false);
    acknowledgeDisplay(request, false);
    void (async () => {
      if (!(await tab.waitForDisplayDocument?.(controller.signal)) || !initialDisplayCurrent(d)) {
        fail();
        return;
      }
      const contents = tab.view.webContents,
        frame = contents.mainFrame,
        token = pageToken(tab),
        url = contents.getURL();
      d.pageFrame = frame;
      d.pageToken = token;
      d.url = url;
      const current = () =>
        initialDisplayCurrent(d) &&
        contents.mainFrame === frame &&
        pageToken(tab) === token &&
        contents.getURL() === url;
      // Never stack reads on an unresolved old presentation capture.
      await tab.presentationReady?.read;
      if (!current()) {
        fail();
        return;
      }
      const read = contents
        .capturePage()
        .then((image) => {
          if (!current() || !fullFrameMatches(image, bounds))
            throw Error('browser_presentation_unavailable');
        })
        .finally(() => {
          if (tab.presentationReady?.read === read) delete tab.presentationReady;
        });
      tab.presentationReady = { key: request.witness.key, read };
      const [, chromeReady] = await Promise.all([
        read,
        requestOwner(request)
          ? chromeHost!.prepareDisplay(
              tab.state.id,
              bounds,
              requestOwner(request)!,
              controller.signal,
            )
          : Promise.resolve(true),
      ]);
      if (!chromeReady || !current()) {
        fail();
        return;
      }
      if (!requestOwner(request)) {
        fail();
        return;
      }
      // A legitimate toolbar update may have committed while the page read was
      // pending. Reconfirm that current revision once; unchanged proof is reused.
      if (
        !(await chromeHost!.prepareDisplay(
          tab.state.id,
          bounds,
          requestOwner(request)!,
          controller.signal,
        )) ||
        !current()
      ) {
        fail();
        return;
      }
      d.ready = true;
      d.offered = true;
      clearTimeout(d.timer);
      d.timer = setTimeout(fail, 1500);
      if (!chromeHost!.offerDisplay(tab.state.id, bounds, requestOwner(request)!)) fail();
    })().catch(fail);
  };
  const proposeLayout = (tab: BrowserTab, request: DrawnPresentation) => {
    if (closing) cancelClosePreparation();
    const displayOwner = requestOwner(request);
    if (displayOwner && chromeHost && !chromeHost.acceptsPresentation(tab.state.id, displayOwner))
      throw Error('browser_page_scope_denied');
    if (initialDisplay) {
      const d = initialDisplay;
      if (
        d.tab === tab &&
        initialDisplayCurrent(d) &&
        JSON.stringify(d.request) === JSON.stringify(request)
      )
        return;
      cancelInitialDisplay();
    }
    if (active && active !== tab.state.id) present(active, null);
    if (pendingLayout && pendingLayout.tab !== tab) cancelLayout();
    const old = pendingLayout;
    if (!window.isVisible() || window.isMinimized()) {
      present(tab.state.id, null);
      return;
    }
    if (displayOwner && chromeHost?.readyFor(tab.state.id, displayOwner)) {
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
      tab.presentationGeneration = request.scope?.generation;
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
        tab.presentationGeneration === request.scope?.generation &&
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
      const prepared = currentPreparation();
      if (!retain && !retained && !(prepared?.ready && prepared.target === tab)) {
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
                ...(pending.request.draft
                  ? { draft: pending.request.draft }
                  : { scope: pending.request.scope }),
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
          pending.tab.presentationScope = pending.request.scope;
          if (
            chromeHost &&
            requestOwner(pending.request) &&
            !chromeHost.presentationViewport(requestOwner(pending.request)!)
          ) {
            beginInitialDisplay(pending.tab, pending.request);
            return;
          }
          present(pending.tab.state.id, pending.request.bounds, pending.request.layout);
          startNativeFrames(pending.tab);
          if (retained && !owner.isDestroyed())
            owner.send(nativeBrowserDisplayChannel, { token: retained.intent.token });
          owner.send(nativeBrowserLayoutFrameChannel, {
            id: pending.tab.state.id,
            ...(pending.request.draft
              ? { draft: pending.request.draft }
              : { scope: pending.request.scope }),
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
      heldPresentation?.tab === tab ||
      preparation?.target === tab ||
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
    if (request.draft) {
      if (
        !draftCurrent(tab, request.draft) ||
        request.scope ||
        (request.presentationRevision !== undefined &&
          request.presentationRevision < (tab.presentationRevision ?? 0))
      )
        throw Error('browser_page_scope_denied');
      return undefined;
    }
    if (!request.scope) {
      if (tab.draft || request.presentationRevision !== undefined)
        throw Error('browser_page_scope_denied');
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
  const applyLayout = (
    event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent,
    value: unknown,
    hostedOnly: boolean,
  ) => {
    try {
      assertNativeSender(event, disposed ? undefined : window, rendererUrl);
      const request = parseNativeBrowserRequest(value);
      if (
        request.action !== 'present' ||
        !request.bounds ||
        !request.layout ||
        (!request.scope && !request.draft) ||
        request.presentationKey
      )
        throw Error('invalid_browser_request');
      const tab = tabs.get(request.id),
        selected = (options.grantScope ?? options.selectedScope)?.();
      const scope = request.scope;
      if (
        !tab ||
        (request.draft
          ? !draftCurrent(tab, request.draft)
          : !scope ||
            !selected ||
            !tab.scope ||
            tab.draft ||
            selected.storeId !== tab.scope.storeId ||
            selected.sessionId !== tab.scope.sessionId ||
            !(['storeId', 'sessionId', 'generation', 'viewSelection'] as const).every(
              (key) => selected[key] === scope[key],
            ))
      )
        throw Error('browser_page_scope_denied');
      // Async requests only calibrate an existing live native presentation.
      // A queued request cannot bootstrap or revive a page after withdrawal.
      const targetOwner = requestOwner(request);
      if (targetOwner && chromeHost && !chromeHost.acceptsPresentation(request.id, targetOwner))
        throw Error('browser_page_scope_denied');
      if (
        hostedOnly &&
        (closing ||
          active !== request.id ||
          !window.isVisible() ||
          window.isMinimized() ||
          !tab.view.getVisible() ||
          !tab.presentation?.layout ||
          (request.draft
            ? !draftCurrent(tab, request.draft)
            : !scope ||
              !tab.presentationScope ||
              !(['storeId', 'sessionId', 'generation', 'viewSelection'] as const).every(
                (key) => tab.presentationScope![key] === scope[key],
              ) ||
              !chromeHost?.readyFor(request.id, scope)) ||
          !chromeHost?.readyFor(request.id, requestOwner(request)))
      )
        throw Error('invalid_browser_request');
      if (hostedOnly) {
        const [width = 0, height = 0] = window.getContentSize(),
          zoom = owner.getZoomFactor();
        // Reject stale queued dimensions before advancing the current witness,
        // revision or presentation anchor used by later valid calibrations.
        assertPanelMeasurement(request.bounds, request.layout, width / zoom, height / zoom);
      }
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
      return {
        ok: true,
        value: tab.state,
        ...(request.witness
          ? {
              waiting: !!pendingLayout || initialDisplay?.tab === tab,
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
      return {
        ok: false,
        code:
          cause instanceof Error && cause.message === 'browser_page_scope_denied'
            ? 'browser_page_scope_denied'
            : 'invalid_browser_request',
      };
    }
  };
  const layoutCommit = (event: Electron.IpcMainEvent, value: unknown) => {
    event.returnValue = applyLayout(event, value, false);
  };
  // Older isolated Main fakes may omit EventEmitter methods; production IpcMain has them.
  ipcMain.handle(nativeBrowserPreparationChannel, async (event, input: unknown) => {
    assertNativeSender(event, disposed ? undefined : window, rendererUrl);
    if (!isNativeBrowserPreparation(input)) throw Error('invalid_browser_preparation');
    return preparePresentation(input.fromId, input.targetId);
  });
  ipcMain.handle(nativeBrowserPreparationCancelChannel, async (event, input: unknown) => {
    assertNativeSender(event, disposed ? undefined : window, rendererUrl);
    if (typeof input !== 'string' || !/^[a-f0-9]{32}$/.test(input))
      throw Error('invalid_browser_preparation');
    cancelPreparation(input);
    syncInput();
    chromeHost?.update();
  });
  ipcMain.on?.(nativeBrowserLayoutChannel, layoutCommit);
  ipcMain.handle(nativeBrowserLayoutChannel, (event, value) => applyLayout(event, value, true));
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
        if (request.action === 'prepareClose')
          return { ok: true, value: prepareClose(request.id, request.draft) };
        if (request.action === 'cancelClose') {
          cancelClosePreparation(request.key);
          return { ok: true, value: null };
        }
        if (request.action === 'confirmClose' || request.action === 'finishClose')
          return (
            request.action === 'confirmClose' ? confirmClose(request.key) : finishClose(request.key)
          ).then(
            (ok): NativeBrowserReply =>
              ok ? { ok: true, value: null } : { ok: false, code: 'browser_presentation_stale' },
          );
        if ('key' in request) throw Error('invalid_browser_request');
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
            cancelInitialDisplay(tab.state.id);
            stopNativeFrames(tab);
            tab.view.setVisible(false);
            if (active === tab.state.id) active = undefined;
            tab.draft = { key: request.draft, frame: owner.mainFrame, epoch: rootEpoch };
            delete tab.drawnRequest;
            delete tab.drawnPresentation;
            delete tab.presentation;
            delete tab.nativeProjection;
            delete tab.presentationScope;
            // Draft revisions persist with the Root-local owner across reload.
            // Keep the old floor so late old-document layout cannot win.
            delete tab.presentationGeneration;
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
          tab ??= create(request.id, undefined, draft);
          navigate(tab, url);
        } else if (request.action === 'present') {
          if (request.witness) throw Error('invalid_browser_request');
          const displayOwner = requestOwner(request);
          if (
            request.bounds &&
            displayOwner &&
            chromeHost &&
            !chromeHost.acceptsPresentation(request.id, displayOwner)
          )
            throw Error('browser_page_scope_denied');
          const revisionGeneration = tab ? presentationGeneration(tab, request) : undefined;
          if (request.presentationKey)
            return tab
              ? commitPresentation(tab, request.presentationKey)
              : { ok: false, code: 'browser_presentation_stale' };
          if (tab && request.bounds === null) {
            // An accepted Renderer withdrawal retires its old layout proof.
            // Internal Chrome suspension still keeps bootstrap proof for onReady.
            delete tab.drawnRequest;
            delete tab.drawnPresentation;
          }
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
          if (['back', 'forward', 'reload', 'stop'].includes(request.action)) {
            cancelInitialDisplay(tab.state.id);
            tab.generation++;
          }
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
    if (mainFrame && !inPlace) {
      rootEpoch++;
      replaceRenderer();
    }
  };
  const displayReady = () => {
    if (retainedDisplay && !retainedDisplay.ready) cancelRetainedDisplay();
  };
  const rendererFailed = () => {
    rootEpoch++;
    replaceRenderer(false);
  };
  owner.on('did-start-navigation', navigation);
  owner.on('render-process-gone', rendererFailed);
  owner.on('preload-error', rendererFailed);
  owner.on('dom-ready', displayReady);
  // Native events and accepted Renderer corrections share the current-window
  // calculation. Stable hosted pages follow native callbacks directly; queuing
  // that work can starve during AppKit live resize. Bootstrap remains deferred.
  const applyNativeResize = () => {
    if (disposed || window.isDestroyed()) return;
    const tab = active ? tabs.get(active) : undefined;
    if (tab?.presentation?.layout && chromeHost?.readyFor(tab.state.id, chromeOwner(tab))) {
      const scope = (options.grantScope ?? options.selectedScope)?.();
      if (
        draftCurrent(tab, tab.draft?.key) ||
        (scope &&
          tab.presentationScope &&
          (['storeId', 'sessionId', 'generation', 'viewSelection'] as const).every(
            (key) => scope[key] === tab.presentationScope![key],
          ))
      )
        applyCurrentLayout(tab);
    } else {
      // Bootstrap and withdrawn Root still need the current logical viewport.
      chromeHost?.syncViewport();
    }
    syncInput();
  };
  const resize = () => {
    cancelClosePreparation();
    cancelInitialDisplay();
    if (retainedDisplay && !displayCurrent()) cancelRetainedDisplay();
    cancelMenu();
    chromeHost?.invalidateGeometry();
    const tab = active ? tabs.get(active) : undefined;
    if (tab?.presentation?.layout && chromeHost?.readyFor(tab.state.id, chromeOwner(tab))) {
      // Invalidate old coordinates before changing native view bounds.
      tab.sizeEpoch++;
      cancelNativeWindowLayout(window, applyNativeResize);
      applyNativeResize();
    } else {
      if (chromeHost) queueNativeWindowLayout(window, applyNativeResize);
      syncInput();
    }
  };
  window.on('resize', resize);
  window.on('hide', hide);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    cancelClosePreparation();
    cancelInitialDisplay();
    cancelPreparation();
    chromeHost?.cancelPresentationHold();
    clearHeldPresentation();
    cancelNativeWindowLayout(window, applyNativeResize);
    chromeHost?.dispose();
    cancelLayout();
    cancelMenu();
    unconfigureGrants?.();
    inputShield.dispose();
    for (const id of [...tabs.keys()]) close(id, true);
    ipcMain.removeHandler(nativeBrowserChannel);
    ipcMain.removeHandler(nativeBrowserMenuChannel);
    ipcMain.removeHandler(nativeBrowserLayoutChannel);
    ipcMain.removeHandler(nativeBrowserPreparationChannel);
    ipcMain.removeHandler(nativeBrowserPreparationCancelChannel);
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
