import { randomUUID } from 'node:crypto';
import {
  type IpcMain,
  type IpcMainInvokeEvent,
  type WebContents,
  WebContentsView,
  type WebFrameMain,
} from 'electron';
import type { NativeBrowserRestoreScope } from '../src/native-browser-bridge';
import {
  isNativeBrowserChromeEvent,
  isNativeBrowserChromeSnapshot,
  type NativeBrowserChromeEnvelope,
  type NativeBrowserChromeEvent,
  type NativeBrowserChromeResult,
  type NativeBrowserChromeSnapshot,
  nativeBrowserChromeAckChannel,
  nativeBrowserChromeActionChannel,
  nativeBrowserChromeChannel,
  nativeBrowserChromeRootChannel,
  nativeBrowserChromeStateChannel,
} from '../src/native-browser-chrome-bridge';
import { assertNativeSender } from './native-ipc';
import {
  getNativeRootView,
  type NativeRootWindow,
  setNativeRootBounds,
} from './native-root-window';

type Bounds = { x: number; y: number; width: number; height: number };
type Metrics = { width: number; height: number; zoom: number; epoch: number; frame: WebFrameMain };
const sameBounds = (a: Bounds, b: Bounds) =>
  (['x', 'y', 'width', 'height'] as const).every((key) => a[key] === b[key]);
const sameMetrics = (a: Metrics | undefined, b: Metrics | undefined) =>
  !!a &&
  !!b &&
  a.width === b.width &&
  a.height === b.height &&
  a.zoom === b.zoom &&
  a.epoch === b.epoch &&
  a.frame === b.frame;
type Page = {
  id: string;
  view: WebContentsView;
  scope?: Pick<NativeBrowserRestoreScope, 'storeId' | 'sessionId'>;
  token: string;
};
type Binding = {
  id: string;
  token: string;
  pageToken: string;
  scope: NativeBrowserRestoreScope;
  attachment: string;
  sequence: number;
  prepared: boolean;
  announced: boolean;
  viewport?: Bounds;
  geometry?: string;
  geometryEpoch?: number;
};
const sameScope = (
  a: NativeBrowserRestoreScope | undefined,
  b: NativeBrowserRestoreScope | undefined,
) =>
  !!a &&
  !!b &&
  (['storeId', 'sessionId', 'generation', 'viewSelection'] as const).every(
    (key) => a[key] === b[key],
  );
const key = (scope: NativeBrowserRestoreScope) =>
  JSON.stringify([scope.storeId, scope.sessionId, scope.generation, scope.viewSelection]);

/** Main owns the physical split. Chrome receives display data and typed UI events only. */
export function createNativeBrowserChromeHost(options: {
  window: NativeRootWindow;
  ipcMain: IpcMain;
  rendererUrl: string;
  preloadPath: string;
  currentScope(forInput: boolean): NativeBrowserRestoreScope | undefined;
  getPage(id: string): Page | undefined;
  onReady(id: string): void;
  onSuspend(id: string): void;
}) {
  const { window, ipcMain } = options;
  const owner = window.webContents;
  let disposed = false;
  let failed = false;
  let binding: Binding | undefined;
  let snapshot: NativeBrowserChromeSnapshot | undefined;
  let chrome: WebContentsView | undefined;
  let chromeContents: WebContents | undefined;
  let chromeFrame: WebFrameMain | undefined;
  let loading: Promise<void> | undefined;
  let root: WebContentsView | undefined;
  let debuggerOwned = false;
  let desiredMetrics: Metrics | undefined;
  let inflightMetrics: Metrics | undefined;
  let appliedMetrics: Metrics | undefined;
  let metricsEpoch = 0;
  let geometryEpoch = 0;
  const revisions = new Map<string, number>();
  const deliveries = new WeakMap<
    WebContents,
    { frame: WebFrameMain; snapshot: NativeBrowserChromeSnapshot | undefined; key: string }
  >();
  const acknowledgements = new Map<
    number,
    {
      event: NativeBrowserChromeEvent;
      resolve(value: NativeBrowserChromeResult): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const alive = () => !disposed && !window.isDestroyed() && !owner.isDestroyed();
  const dimensions = () => {
    const [width = 0, height = 0] = window.getContentSize();
    return { width, height };
  };
  const currentMetrics = (): Metrics => ({
    ...dimensions(),
    zoom: owner.getZoomFactor(),
    epoch: metricsEpoch,
    frame: owner.mainFrame,
  });
  const settle = () => {
    for (const item of acknowledgements.values()) {
      clearTimeout(item.timer);
      item.resolve('unconfirmed');
    }
    acknowledgements.clear();
  };
  const pageCurrent = (value = binding) => {
    if (!value || !alive() || !sameScope(value.scope, options.currentScope(false)))
      return undefined;
    const page = options.getPage(value.id);
    if (
      !page ||
      page.token !== value.token ||
      page.id !== value.id ||
      page.view.webContents.isDestroyed() ||
      page.scope?.storeId !== value.scope.storeId ||
      page.scope.sessionId !== value.scope.sessionId
    )
      return undefined;
    try {
      if (!['http:', 'https:'].includes(new URL(page.view.webContents.getURL()).protocol))
        return undefined;
    } catch {
      return undefined;
    }
    return page;
  };
  const qualified = (value: NativeBrowserChromeSnapshot) =>
    sameScope(value.scope, options.currentScope(false)) &&
    value.tabs.active === value.toolbar.id &&
    value.tabs.tabs.some((tab) => tab.id === value.tabs.active && tab.kind === 'browser') &&
    value.tabs.visible &&
    value.tabs.present &&
    !value.tabs.restoring &&
    !value.tabs.restoreIssue &&
    !value.covered &&
    !value.toolbar.notesOpen &&
    !value.toolbar.error &&
    !value.control?.issue &&
    value.toolbar.hasPage;
  const readyFor = (id: string, scope?: NativeBrowserRestoreScope) =>
    !!binding &&
    binding.id === id &&
    (!scope || sameScope(scope, binding.scope)) &&
    binding.prepared &&
    !!snapshot?.hosted &&
    qualified(snapshot) &&
    !!pageCurrent();
  const actionable = () =>
    !!binding?.viewport &&
    binding.geometryEpoch === geometryEpoch &&
    !inflightMetrics &&
    sameMetrics(appliedMetrics, desiredMetrics) &&
    sameMetrics(appliedMetrics, currentMetrics()) &&
    window.isVisible() &&
    !window.isMinimized() &&
    !!chrome?.getVisible() &&
    !!chromeContents &&
    chromeContents.getZoomFactor() === owner.getZoomFactor() &&
    !!pageCurrent()?.view.getVisible() &&
    !!snapshot?.interactive &&
    readyFor(binding.id) &&
    sameScope(binding.scope, options.currentScope(true));
  const envelope = (): NativeBrowserChromeEnvelope | null =>
    binding && snapshot
      ? {
          attachment: binding.attachment,
          pageToken: binding.pageToken,
          hosted: binding.prepared && !!pageCurrent() && qualified(snapshot),
          actionable: actionable(),
          snapshot,
        }
      : null;
  const broadcast = () => {
    if (!alive()) return;
    const value = envelope();
    const key = value
      ? JSON.stringify([
          value.attachment,
          value.pageToken,
          value.snapshot.scope,
          value.snapshot.revision,
          value.hosted,
          value.actionable,
        ])
      : 'null';
    const send = (recipient: WebContents) => {
      const frame = recipient.mainFrame,
        previous = deliveries.get(recipient);
      if (previous?.frame === frame && previous.snapshot === snapshot && previous.key === key)
        return;
      recipient.send(nativeBrowserChromeStateChannel, value);
      deliveries.set(recipient, { frame, snapshot, key });
    };
    send(owner);
    if (chromeFrame && chromeContents && !chromeContents.isDestroyed()) send(chromeContents);
  };
  const restore = () => {
    if (!alive() || !root) return;
    setNativeRootBounds(window);
    if (chrome?.getVisible()) chrome.setVisible(false);
  };
  const release = (id?: string) => {
    if (id && binding?.id !== id) return;
    binding = undefined;
    snapshot = undefined;
    geometryEpoch++;
    settle();
    restore();
    if (debuggerOwned && alive()) requestMetrics();
    broadcast();
  };
  const fail = () => {
    if (disposed || failed) return;
    const id = binding?.id;
    failed = true;
    metricsEpoch++;
    desiredMetrics = undefined;
    appliedMetrics = undefined;
    if (debuggerOwned && !owner.isDestroyed()) {
      debuggerOwned = false;
      try {
        if (owner.debugger.isAttached()) owner.debugger.detach();
      } catch {
        /* Root is restored below even if transport teardown failed. */
      }
    }
    release();
    if (id) options.onSuspend(id);
  };
  const metricsReady = (notify: boolean) => {
    if (
      !alive() ||
      failed ||
      !debuggerOwned ||
      inflightMetrics ||
      !sameMetrics(appliedMetrics, desiredMetrics) ||
      !sameMetrics(appliedMetrics, currentMetrics()) ||
      !binding ||
      !chromeFrame ||
      !pageCurrent()
    )
      return;
    const newlyPrepared = !binding.prepared;
    binding.prepared = true;
    if (notify || newlyPrepared) update();
  };
  function pumpMetrics() {
    if (!alive() || !debuggerOwned || failed || inflightMetrics) return;
    const next = desiredMetrics;
    if (!next || sameMetrics(next, appliedMetrics)) {
      metricsReady(false);
      return;
    }
    inflightMetrics = next;
    void (async () => {
      try {
        if (!owner.debugger.isAttached()) throw Error('browser_root_metrics_detached');
        await owner.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
          width: next.width,
          height: next.height,
          deviceScaleFactor: 0,
          mobile: false,
          dontSetVisibleSize: true,
        });
        // This is command completion for this exact Root environment, not a
        // compositor/pixel acknowledgement. An old completion grants nothing.
        if (
          alive() &&
          debuggerOwned &&
          !failed &&
          next.epoch === metricsEpoch &&
          next.frame === owner.mainFrame
        )
          appliedMetrics = next;
      } catch {
        // The obsolete document's rejection cannot fail its replacement. The
        // current desire is still pumped below and must pass its own checks.
        if (
          alive() &&
          debuggerOwned &&
          !failed &&
          next.epoch === metricsEpoch &&
          next.frame === owner.mainFrame
        )
          fail();
      } finally {
        if (inflightMetrics === next) inflightMetrics = undefined;
      }
      if (!alive() || failed || !debuggerOwned) return;
      // If A was applied before B went in flight, a new desire for A must
      // restore A after B; comparing only against the earlier applied A loses it.
      if (desiredMetrics && !sameMetrics(desiredMetrics, appliedMetrics)) pumpMetrics();
      else metricsReady(true);
    })();
  }
  function requestMetrics() {
    if (!alive() || !debuggerOwned || failed) return;
    desiredMetrics = currentMetrics();
    pumpMetrics();
  }
  const ownRoot = () => {
    if (root) return;
    root = getNativeRootView(window);
    if (!root || root.webContents !== owner || !window.contentView.children.includes(root))
      throw Error('browser_root_view_unavailable');
    restore();
  };
  const prepare = () => {
    if (loading || failed || !binding) return;
    loading = (async () => {
      if (owner.debugger.isAttached()) throw Error('browser_root_metrics_busy');
      ownRoot();
      owner.debugger.attach('1.3');
      debuggerOwned = true;
      owner.debugger.on('detach', detached);
      chrome = new WebContentsView({
        webPreferences: {
          preload: options.preloadPath,
          partition: `kite-browser-chrome-${randomUUID()}`,
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          nodeIntegrationInSubFrames: false,
          webSecurity: true,
          devTools: false,
          webviewTag: false,
          navigateOnDragDrop: false,
          disableDialogs: true,
        },
      });
      chrome.setVisible(false);
      window.contentView.addChildView(chrome);
      const contents = chrome.webContents;
      chromeContents = contents;
      contents.session.setPermissionRequestHandler((_contents, _permission, done) => done(false));
      contents.session.setPermissionCheckHandler(() => false);
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      contents.on('will-navigate', (event) => event.preventDefault());
      contents.on('will-attach-webview', (event) => event.preventDefault());
      contents.on('render-process-gone', fail);
      contents.on('preload-error', fail);
      contents.on('destroyed', fail);
      await contents.loadURL(options.rendererUrl);
      if (!alive() || contents.isDestroyed()) return;
      chromeFrame = contents.mainFrame;
      contents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
        if (mainFrame && !inPlace) fail();
      });
      requestMetrics();
    })().catch(fail);
  };
  function update() {
    if (!alive() || failed) return;
    if (!snapshot || !qualified(snapshot) || !pageCurrent()) {
      if (binding) {
        const id = binding.id;
        release();
        options.onSuspend(id);
      }
      return;
    }
    prepare();
    broadcast();
    if (binding?.prepared && snapshot.hosted && !binding.announced) {
      binding.announced = true;
      options.onReady(binding.id);
    }
  }
  const detached = () => {
    debuggerOwned = false;
    fail();
  };
  const invalidateGeometry = () => {
    geometryEpoch++;
    if (!alive()) return;
    // The controller invalidates old coordinates before its shared apply.
    broadcast();
  };
  const rootNavigation = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => {
    if (!mainFrame || inPlace) return;
    const id = binding?.id;
    metricsEpoch++;
    desiredMetrics = undefined;
    appliedMetrics = undefined;
    deliveries.delete(owner);
    release();
    revisions.clear();
    if (id) options.onSuspend(id);
  };
  const input = (event: NativeBrowserChromeEvent) =>
    event.part === 'toolbar' && ['address-change', 'address-focus'].includes(event.action.type);
  const forward = (event: NativeBrowserChromeEvent): Promise<NativeBrowserChromeResult> => {
    if (
      !binding ||
      !snapshot ||
      !actionable() ||
      event.attachment !== binding.attachment ||
      event.pageToken !== binding.pageToken ||
      event.sequence <= binding.sequence ||
      event.revision > snapshot.revision ||
      (!input(event) && event.revision !== snapshot.revision)
    )
      return Promise.resolve('stale');
    if (event.part === 'tabs' && 'id' in event.action) {
      const id = event.action.id;
      if (!snapshot.tabs.tabs.some((tab) => tab.id === id)) return Promise.resolve('stale');
    }
    if (event.part === 'toolbar') {
      if (
        ['navigate', 'back', 'forward', 'reload'].includes(event.action.type) &&
        !snapshot.toolbar.canNavigate
      )
        return Promise.resolve('stale');
      if (event.action.type === 'back' && !snapshot.toolbar.canGoBack)
        return Promise.resolve('stale');
      if (event.action.type === 'forward' && !snapshot.toolbar.canGoForward)
        return Promise.resolve('stale');
      if (event.action.type === 'show-options' && !snapshot.toolbar.optionsAvailable)
        return Promise.resolve('stale');
      if (event.action.type === 'toggle-notes' && !snapshot.toolbar.notesAvailable)
        return Promise.resolve('stale');
    }
    if (
      event.part === 'control' &&
      (!snapshot.control || snapshot.control.id !== snapshot.toolbar.id)
    )
      return Promise.resolve('stale');
    const adjusted = structuredClone(event);
    if ('action' in adjusted && 'anchor' in adjusted.action) {
      const rect = adjusted.action.anchor,
        bounds = chrome!.getBounds(),
        zoom = owner.getZoomFactor();
      if (
        rect.width <= 0 ||
        rect.height <= 0 ||
        rect.x + rect.width > bounds.width / zoom ||
        rect.y + rect.height > bounds.height / zoom
      )
        return Promise.resolve('stale');
      Object.assign(rect, { x: rect.x + bounds.x / zoom, y: rect.y + bounds.y / zoom });
    }
    binding.sequence = event.sequence;
    if (adjusted.part === 'focus-root') owner.focus();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        acknowledgements.delete(event.sequence);
        resolve('unconfirmed');
      }, 1500);
      acknowledgements.set(event.sequence, { event, resolve, timer });
      try {
        owner.send(nativeBrowserChromeActionChannel, adjusted);
      } catch {
        clearTimeout(timer);
        acknowledgements.delete(event.sequence);
        resolve('unconfirmed');
      }
    });
  };
  ipcMain.handle(nativeBrowserChromeRootChannel, (event, value: unknown) => {
    assertNativeSender(event, disposed ? undefined : window, options.rendererUrl);
    if (value === null) {
      const id = binding?.id;
      release();
      if (id) options.onSuspend(id);
      return;
    }
    if (!isNativeBrowserChromeSnapshot(value)) throw Error('invalid_browser_chrome_snapshot');
    if (!sameScope(value.scope, options.currentScope(false)))
      throw Error('browser_chrome_scope_denied');
    const revision = revisions.get(key(value.scope)) ?? 0;
    if (value.revision <= revision) {
      if (snapshot && JSON.stringify(snapshot) === JSON.stringify(value)) return;
      throw Error('browser_chrome_stale_snapshot');
    }
    revisions.set(key(value.scope), value.revision);
    const page = options.getPage(value.toolbar.id);
    if (!qualified(value) || !page) {
      const id = binding?.id;
      release();
      if (id) options.onSuspend(id);
      return;
    }
    if (
      !binding ||
      binding.id !== page.id ||
      binding.token !== page.token ||
      !sameScope(binding.scope, value.scope)
    ) {
      release();
      binding = {
        id: page.id,
        token: page.token,
        pageToken: randomUUID(),
        scope: value.scope,
        attachment: randomUUID(),
        sequence: 0,
        prepared: false,
        announced: false,
      };
    }
    // A true delegation bit from the prior page/document is not an ACK for
    // this newly issued wire identity. Root must echo a fresh revision after
    // the new binding's metrics/Chrome offer has become available.
    snapshot = { ...structuredClone(value), hosted: binding.prepared && value.hosted };
    update();
    if (loading && chromeFrame && debuggerOwned && !binding?.prepared) requestMetrics();
  });
  ipcMain.handle(nativeBrowserChromeChannel, (event, value: unknown) => {
    if (
      !alive() ||
      !chromeContents ||
      chromeContents.isDestroyed() ||
      event.sender !== chromeContents ||
      event.senderFrame !== chromeContents.mainFrame ||
      (chromeFrame && event.senderFrame !== chromeFrame)
    )
      throw Error('native_sender_denied');
    const actual = new URL(event.senderFrame.url),
      expected = new URL(options.rendererUrl);
    if (
      actual.protocol !== expected.protocol ||
      actual.pathname !== expected.pathname ||
      (actual.protocol !== 'file:' && actual.origin !== expected.origin)
    )
      throw Error('native_sender_denied');
    if (!value || typeof value !== 'object') throw Error('invalid_browser_chrome_request');
    const request = value as { action?: string; event?: unknown };
    if (request.action === 'read' && Object.keys(request).length === 1)
      return chromeFrame ? envelope() : null;
    if (
      request.action === 'send' &&
      Object.keys(request).length === 2 &&
      chromeFrame &&
      isNativeBrowserChromeEvent(request.event)
    )
      return forward(request.event);
    throw Error('invalid_browser_chrome_request');
  });
  const ack = (event: Electron.IpcMainEvent, value: unknown) => {
    try {
      assertNativeSender(
        event as IpcMainInvokeEvent,
        disposed ? undefined : window,
        options.rendererUrl,
      );
      if (!value || typeof value !== 'object') return;
      const reply = value as {
        attachment: string;
        pageToken: string;
        sequence: number;
        forwarded: boolean;
      };
      if (
        Object.keys(reply).some(
          (field) => !['attachment', 'pageToken', 'sequence', 'forwarded'].includes(field),
        ) ||
        typeof reply.forwarded !== 'boolean'
      )
        return;
      const pending = acknowledgements.get(reply.sequence);
      if (
        !pending ||
        !binding ||
        !actionable() ||
        reply.attachment !== binding.attachment ||
        reply.pageToken !== binding.pageToken ||
        pending.event.attachment !== reply.attachment ||
        pending.event.pageToken !== reply.pageToken
      )
        return;
      clearTimeout(pending.timer);
      acknowledgements.delete(reply.sequence);
      pending.resolve(reply.forwarded ? 'forwarded' : 'stale');
    } catch {
      /* An untrusted or retired Root cannot confirm dispatch. */
    }
  };
  ipcMain.on(nativeBrowserChromeAckChannel, ack);
  owner.on('did-start-navigation', rootNavigation);
  return {
    readyFor,
    update,
    release,
    invalidateGeometry,
    syncViewport: requestMetrics,
    layout(id: string, viewportDip: Bounds, scope?: NativeBrowserRestoreScope) {
      if (!readyFor(id, scope) || !chrome || !root || !binding) return false;
      const { width, height } = dimensions(),
        { x, y } = viewportDip;
      if (
        ![x, y, viewportDip.width, viewportDip.height].every(Number.isFinite) ||
        x <= 0 ||
        y <= 0 ||
        viewportDip.width <= 0 ||
        viewportDip.height <= 0 ||
        x + viewportDip.width > width ||
        y + viewportDip.height > height
      )
        return false;
      const left = Math.ceil(x),
        top = Math.ceil(y);
      if (left >= width || top >= height) return false;
      const geometry = JSON.stringify([
        width,
        height,
        owner.getZoomFactor(),
        x,
        y,
        viewportDip.width,
        viewportDip.height,
      ]);
      if (binding.geometry && binding.geometry !== geometry) {
        settle();
        binding.attachment = randomUUID();
        binding.sequence = 0;
      }
      binding.geometry = geometry;
      if (!setNativeRootBounds(window, { x: 0, y: 0, width: left, height })) return false;
      if (chromeContents!.getZoomFactor() !== owner.getZoomFactor())
        chromeContents!.setZoomFactor(owner.getZoomFactor());
      const chromeBounds = { x: left, y: 0, width: width - left, height: top };
      if (!sameBounds(chrome.getBounds(), chromeBounds)) chrome.setBounds(chromeBounds);
      binding.viewport = { ...viewportDip };
      binding.geometryEpoch = geometryEpoch;
      const visible = window.isVisible() && !window.isMinimized();
      if (chrome.getVisible() !== visible) chrome.setVisible(visible);
      return true;
    },
    dispose() {
      if (disposed) return;
      failed = true; // Restore physical Root without starting another metrics command.
      release();
      disposed = true;
      metricsEpoch++;
      desiredMetrics = undefined;
      appliedMetrics = undefined;
      owner.off('did-start-navigation', rootNavigation);
      owner.debugger.off('detach', detached);
      ipcMain.removeHandler(nativeBrowserChromeRootChannel);
      ipcMain.removeHandler(nativeBrowserChromeChannel);
      ipcMain.removeListener(nativeBrowserChromeAckChannel, ack);
      if (chrome) {
        if (!window.isDestroyed()) window.contentView.removeChildView(chrome);
        if (chromeContents && !chromeContents.isDestroyed())
          chromeContents.close({ waitForBeforeUnload: false });
      }
      if (debuggerOwned && !owner.isDestroyed() && owner.debugger.isAttached()) {
        void owner.debugger
          .sendCommand('Emulation.setDeviceMetricsOverride', {
            width: 0,
            height: 0,
            deviceScaleFactor: 0,
            mobile: false,
            dontSetVisibleSize: true,
          })
          .finally(() => {
            if (!owner.isDestroyed() && owner.debugger.isAttached()) owner.debugger.detach();
          })
          .catch(() => {});
      }
    },
  };
}
