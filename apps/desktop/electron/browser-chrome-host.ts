import { randomUUID } from 'node:crypto';
import {
  type IpcMain,
  type IpcMainInvokeEvent,
  type WebContents,
  WebContentsView,
  type WebFrameMain,
} from 'electron';
import {
  type NativeBrowserBounds,
  type NativeBrowserRestoreScope,
  nativeBrowserWitnessPosition,
  nativeBrowserWitnessTileSize,
  nativeBrowserWitnessWidth,
} from '../src/native-browser-bridge';
import {
  isNativeBrowserChromeEvent,
  isNativeBrowserChromeOwner,
  isNativeBrowserChromeRendered,
  isNativeBrowserChromeSnapshot,
  type NativeBrowserChromeEnvelope,
  type NativeBrowserChromeEvent,
  type NativeBrowserChromeOwner,
  type NativeBrowserChromeResult,
  type NativeBrowserChromeSnapshot,
  nativeBrowserChromeAckChannel,
  nativeBrowserChromeActionChannel,
  nativeBrowserChromeChannel,
  nativeBrowserChromeOwnerKey,
  nativeBrowserChromeRootChannel,
  nativeBrowserChromeStateChannel,
  sameNativeBrowserChromeOwner,
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
  draft?: string;
  token: string;
};
type Binding = {
  id: string;
  token: string;
  pageToken: string;
  scope: NativeBrowserChromeOwner;
  attachment: string;
  sequence: number;
  prepared: boolean;
  displayOffered: boolean;
  announced: boolean;
  suspended?: boolean;
  renderedRevision?: number;
  viewport?: Bounds;
  geometry?: string;
  geometryEpoch?: number;
};
const sameScope = sameNativeBrowserChromeOwner;
const key = nativeBrowserChromeOwnerKey;

/** Main owns the physical split. Chrome receives display data and typed UI events only. */
export function createNativeBrowserChromeHost(options: {
  window: NativeRootWindow;
  ipcMain: IpcMain;
  rendererUrl: string;
  preloadPath: string;
  currentScope(forInput: boolean): NativeBrowserRestoreScope | undefined;
  getPage(id: string): Page | undefined;
  onContextChanged?(): void;
  onRootReturnCancelled?(id: string): void;
  onReady(id: string): void;
  onSuspend(id: string): void;
  onPresentationHoldEnd?(id: string, key: string): void;
  preparedPresentation?():
    | { fromId: string; targetId: string; scope: NativeBrowserChromeOwner }
    | undefined;
  onShellReleased?(id: string): void;
}) {
  const { window, ipcMain } = options;
  const owner = window.webContents;
  let contextFrame = owner.mainFrame,
    contextFloor = 0,
    contextual = false;
  let context: { revision: number; owner: NativeBrowserChromeOwner } | undefined;
  let rootReturn:
    | {
        binding: Binding;
        frame: WebFrameMain;
        metrics: Metrics;
        context?: number;
        chrome: Bounds;
        strip: Bounds;
        root: Bounds;
      }
    | undefined;
  const ownerCurrent = (value: NativeBrowserChromeOwner | undefined, forInput = false) => {
    if (!value) return false;
    if (
      contextual &&
      (contextFrame !== owner.mainFrame || !context || !sameScope(value, context.owner))
    )
      return false;
    return 'draft' in value
      ? contextual && !!context
      : sameScope(value, options.currentScope(forInput));
  };
  const pageOwnerMatches = (page: Page, value: NativeBrowserChromeOwner) =>
    'draft' in value
      ? page.draft === value.draft && !page.scope
      : page.draft === undefined &&
        page.scope?.storeId === value.storeId &&
        page.scope.sessionId === value.sessionId;

  let disposed = false;
  let failed = false;
  let binding: Binding | undefined;
  let handoff:
    | {
        binding: Binding;
        previous?: Binding;
        key: string;
        oldView?: WebContentsView;
        targetView: WebContentsView;
        oldURL?: string;
        targetURL: string;
        metrics: Metrics;
        epoch: number;
        rootBounds: Bounds;
        chromeBounds: Bounds;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  let intent: NativeBrowserChromeSnapshot | null | undefined;
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
  let display:
    | {
        binding: Binding;
        viewport: Bounds;
        metrics: Metrics;
        offered: boolean;
        readyRevision?: number;
        surfaceReady?: boolean;
        signal: AbortSignal;
        abort(): void;
        waiting: Set<(ready: boolean) => void>;
        timer?: ReturnType<typeof setTimeout>;
      }
    | undefined;
  let displayRead:
    | {
        display: NonNullable<typeof display>;
        revision: number;
        contents: WebContents;
        frame: WebFrameMain;
        bounds: Bounds;
        kind: 'frame' | 'capture';
      }
    | undefined;
  let shell:
    | {
        scope: NativeBrowserChromeOwner;
        viewport: Bounds;
        metrics: Metrics;
        root: Bounds;
        chrome: Bounds;
      }
    | undefined;
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
  const pageCurrent = (value: Pick<Binding, 'id' | 'token' | 'scope'> | undefined = binding) => {
    if (!value || !alive() || !ownerCurrent(value.scope)) return undefined;
    const page = options.getPage(value.id);
    if (
      !page ||
      page.token !== value.token ||
      page.id !== value.id ||
      !page.view.webContents ||
      page.view.webContents.isDestroyed() ||
      !pageOwnerMatches(page, value.scope)
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
  const targetIntent = (value: NativeBrowserChromeSnapshot) =>
    ownerCurrent(value.scope) &&
    value.tabs.active === value.toolbar.id &&
    value.tabs.tabs.some((tab) => tab.id === value.tabs.active && tab.kind === 'browser') &&
    value.tabs.visible &&
    value.tabs.present &&
    !value.tabs.restoring &&
    !value.tabs.restoreIssue &&
    !value.covered &&
    !value.toolbar.notesOpen &&
    !value.toolbar.error &&
    !value.control?.issue;
  const qualified = (value: NativeBrowserChromeSnapshot) =>
    targetIntent(value) && value.toolbar.hasPage;
  const acceptsPresentation = (id: string, scope: NativeBrowserChromeOwner) =>
    ownerCurrent(scope) &&
    (intent === undefined ||
      (!!intent &&
        targetIntent(intent) &&
        sameScope(intent.scope, scope) &&
        intent.toolbar.id === id));
  const bindingReady = (id: string, scope?: NativeBrowserChromeOwner) =>
    !!binding &&
    binding.id === id &&
    !binding.suspended &&
    (!scope || sameScope(scope, binding.scope)) &&
    binding.prepared &&
    binding.displayOffered &&
    !!snapshot?.hosted &&
    qualified(snapshot) &&
    !!pageCurrent();
  const readyFor = (id: string, scope?: NativeBrowserChromeOwner) =>
    bindingReady(id, scope) && !!binding && acceptsPresentation(id, binding.scope);
  const actionable = () =>
    !rootReturn &&
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
    ownerCurrent(binding.scope, true);
  const envelope = (): NativeBrowserChromeEnvelope | null =>
    binding && snapshot && !(rootReturn && intent === null)
      ? {
          attachment: binding.attachment,
          pageToken: binding.pageToken,
          hosted:
            (binding.prepared &&
              !!pageCurrent() &&
              qualified(snapshot) &&
              binding.displayOffered) ||
            !!preparedTarget(),
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
  const restore = (id = binding?.id, exposed = !!shell || !!display?.offered) => {
    finishDisplay(false);
    shell = undefined;
    if (id && exposed) options.onShellReleased?.(id);
    if (!alive() || !root) return;
    setNativeRootBounds(window);
    if (chrome?.getVisible()) chrome.setVisible(false);
  };
  function rootReturnCurrent(id: string, scope: NativeBrowserChromeOwner): boolean {
    const r = rootReturn;
    return (
      !!r &&
      r.binding.id === id &&
      binding === r.binding &&
      sameScope(r.binding.scope, scope) &&
      alive() &&
      !failed &&
      owner.mainFrame === r.frame &&
      ownerCurrent(scope) &&
      (contextual ? context?.revision : undefined) === r.context &&
      sameMetrics(r.metrics, currentMetrics()) &&
      sameMetrics(appliedMetrics, r.metrics) &&
      !inflightMetrics &&
      !!root &&
      !!chrome &&
      !!chromeContents &&
      !chromeContents.isDestroyed() &&
      chromeContents.mainFrame === chromeFrame &&
      chrome.getVisible() &&
      sameBounds(root.getBounds(), r.root) &&
      sameBounds(chrome.getBounds(), r.chrome) &&
      chromeContents.getZoomFactor() === owner.getZoomFactor()
    );
  }
  function cancelRootReturn(id?: string) {
    const r = rootReturn;
    if (!r || (id && r.binding.id !== id)) return;
    rootReturn = undefined;
    if (binding === r.binding) {
      binding = undefined;
      snapshot = undefined;
      geometryEpoch++;
      settle();
    }
    restore(r.binding.id);
    broadcast();
    options.onRootReturnCancelled?.(r.binding.id);
    options.onSuspend(r.binding.id);
  }
  function shrinkRootReturn() {
    const saved = rootReturn;
    if (!saved || !chrome || intent !== null) return;
    const strip = saved.strip,
      zoom = saved.metrics.zoom,
      scale = Math.min(1, zoom),
      bounds = {
        x: strip.x / zoom,
        y: strip.y / zoom,
        width: strip.width / zoom,
        height: strip.height / zoom,
        radius: 0,
      },
      position = nativeBrowserWitnessPosition(bounds, scale),
      right = (position.x + nativeBrowserWitnessWidth(scale)) * zoom,
      bottom = (position.y + nativeBrowserWitnessTileSize(scale)) * zoom,
      mask = {
        x: strip.x,
        y: strip.y,
        width: Math.min(strip.width, Math.ceil(right + 2 * zoom) - strip.x),
        height: Math.min(strip.height, Math.ceil(bottom + 2 * zoom) - strip.y),
      };
    // macOS backing scale is at least one. The zoom lower bound encloses
    // every actual palette without changing its receipt coordinates or proof.
    if (
      position.x * zoom < mask.x ||
      position.y * zoom < mask.y ||
      right > mask.x + mask.width ||
      bottom > mask.y + mask.height ||
      mask.width <= 0 ||
      mask.height <= 0
    ) {
      // A DPR lower bound can overestimate a palette that fits the actual
      // backing scale. Keep the original exact strip rather than fail close.
      return;
    }
    saved.chrome = mask;
    try {
      if (!sameBounds(chrome.getBounds(), mask)) chrome.setBounds(mask);
    } catch {
      cancelRootReturn();
    }
  }
  const finishHandoff = () => {
    const previous = handoff;
    if (!previous) return;
    clearTimeout(previous.timer);
    handoff = undefined;
    if (previous.previous && previous.oldView)
      options.onPresentationHoldEnd?.(previous.previous.id, previous.key);
  };
  const dropLiveSource = () => {
    const saved = handoff;
    if (!saved?.previous || !saved.oldView) return;
    saved.oldView = undefined;
    options.onPresentationHoldEnd?.(saved.previous.id, saved.key);
  };
  const shellCurrent = (scope?: NativeBrowserChromeOwner) =>
    !!shell &&
    alive() &&
    !failed &&
    !!root &&
    !!chrome?.getVisible() &&
    !!chromeContents &&
    !chromeContents.isDestroyed() &&
    debuggerOwned &&
    chromeFrame === chromeContents.mainFrame &&
    window.isVisible() &&
    !window.isMinimized() &&
    !inflightMetrics &&
    (!scope || sameScope(shell.scope, scope)) &&
    ownerCurrent(shell.scope) &&
    sameMetrics(shell.metrics, currentMetrics()) &&
    sameMetrics(appliedMetrics, shell.metrics) &&
    chromeContents.getZoomFactor() === owner.getZoomFactor() &&
    sameBounds(root.getBounds(), shell.root) &&
    sameBounds(chrome.getBounds(), shell.chrome);
  function displayCurrent() {
    const d = display;
    if (
      !d ||
      binding !== d.binding ||
      !alive() ||
      failed ||
      !root ||
      !chrome ||
      !chromeContents ||
      chromeContents.isDestroyed() ||
      chromeFrame !== chromeContents.mainFrame ||
      !snapshot ||
      !targetIntent(snapshot) ||
      !pageCurrent() ||
      !sameMetrics(d.metrics, currentMetrics()) ||
      !ownerCurrent(binding.scope)
    )
      return false;
    const [width, height] = window.getContentSize(),
      actual = root.getBounds();
    return actual.x === 0 && actual.y === 0 && actual.width === width && actual.height === height;
  }
  function finishDisplay(ready: boolean) {
    const d = display;
    if (!d) return;
    stopDisplayRead();
    display = undefined;
    clearTimeout(d.timer);
    d.signal.removeEventListener('abort', d.abort);
    if (!ready && binding === d.binding && !shell) {
      binding.displayOffered = false;
      binding.announced = false;
    }
    for (const receive of d.waiting) receive(ready);
    d.waiting.clear();
    if (!ready && !shell && chrome?.getVisible()) chrome.setVisible(false);
  }
  function stopDisplayRead() {
    const previous = displayRead;
    if (!previous) return;
    if (previous.kind === 'capture') return;
    displayRead = undefined;
    try {
      if (!previous.contents.isDestroyed()) previous.contents.endFrameSubscription();
    } catch {
      // Retiring a dead subscription cannot retain its callback authority.
    }
  }
  function placeDisplay() {
    const d = display;
    if (!d || !root || !chrome || !chromeContents || chromeContents.isDestroyed()) return;
    const [width = 0] = window.getContentSize(),
      { x, y } = d.viewport;
    const bounds = { x, y: 0, width: width - x, height: y };
    if (!sameBounds(chrome.getBounds(), bounds)) chrome.setBounds(bounds);
    if (chromeContents.getZoomFactor() !== owner.getZoomFactor())
      chromeContents.setZoomFactor(owner.getZoomFactor());
    if (!d.offered) {
      const children = window.contentView.children,
        source = children.indexOf(root),
        target = children.indexOf(chrome);
      if (target > source && source >= 0) window.contentView.addChildView(chrome, source);
    }
    if (!chrome.getVisible()) chrome.setVisible(true);
  }
  function pumpDisplay() {
    const d = display,
      revision = snapshot?.revision;
    if (displayRead && (displayRead.display !== d || displayRead.revision !== revision))
      stopDisplayRead();
    if (
      !d?.waiting.size ||
      !displayCurrent() ||
      !binding?.prepared ||
      !snapshot ||
      !qualified(snapshot) ||
      inflightMetrics ||
      !sameMetrics(appliedMetrics, d.metrics) ||
      displayRead ||
      !revision ||
      binding?.renderedRevision !== revision
    )
      return;
    placeDisplay();
    const contents = chromeContents!,
      frame = contents.mainFrame,
      bounds = chrome!.getBounds();
    const read = {
      display: d,
      revision,
      contents,
      frame,
      bounds,
      kind: d.surfaceReady ? ('capture' as const) : ('frame' as const),
    };
    displayRead = read;
    const receive = (image: Electron.NativeImage) => {
      if (displayRead !== read || display !== d) return false;
      if (!displayCurrent() || contents.mainFrame !== frame) {
        finishDisplay(false);
        return false;
      }
      if (snapshot?.revision !== revision) {
        stopDisplayRead();
        return false;
      }
      const size = image.getSize();
      if (
        image.isEmpty() ||
        !Number.isFinite(size.width) ||
        !Number.isFinite(size.height) ||
        size.width < bounds.width ||
        size.height < bounds.height ||
        Math.abs(size.height - (size.width / bounds.width) * bounds.height) > 2
      )
        return false;
      stopDisplayRead();
      d.surfaceReady = true;
      d.readyRevision = revision;
      clearTimeout(d.timer);
      d.timer = setTimeout(() => {
        if (display === d) finishDisplay(false);
      }, 1500);
      for (const resolve of d.waiting) resolve(true);
      d.waiting.clear();
      return true;
    };
    if (read.kind === 'capture') {
      // The same prepared geometry already produced a native surface. A new
      // DOM revision may change no pixels, so it needs no additional paint.
      // Keep this one read in the slot until it settles, even after cancellation.
      void Promise.resolve()
        .then(() => {
          if (display !== d || !displayCurrent() || snapshot?.revision !== revision) return;
          return contents.capturePage();
        })
        .then((image) => {
          if (image && !receive(image) && display === d && snapshot?.revision === revision)
            finishDisplay(false);
        })
        .catch(() => {
          if (display === d) finishDisplay(false);
        })
        .finally(() => {
          if (displayRead === read) displayRead = undefined;
          pumpDisplay();
        });
      return;
    }
    try {
      // A DOM commit at 0x0 does not prove that Viz has submitted the newly
      // sized view. Its first full native frame establishes surface readiness;
      // no image is saved, displayed, or used as a different page's observation.
      contents.beginFrameSubscription(false, (image) => {
        try {
          receive(image);
        } catch {
          if (display === d) finishDisplay(false);
        }
      });
    } catch {
      if (display === d) finishDisplay(false);
    }
  }

  const preparedTarget = () => {
    const prepared = options.preparedPresentation?.();
    const page = prepared && options.getPage(prepared.targetId);
    return prepared &&
      page &&
      shellCurrent(prepared.scope) &&
      pageCurrent({ id: page.id, token: page.token, scope: prepared.scope })
      ? prepared
      : undefined;
  };
  const handoffCurrent = () =>
    !!handoff &&
    binding === handoff.binding &&
    shellCurrent(binding.scope) &&
    !!snapshot &&
    qualified(snapshot) &&
    !!pageCurrent() &&
    pageCurrent()!.view === handoff.targetView &&
    pageCurrent()!.view.webContents.getURL() === handoff.targetURL;
  const holdCurrent = () => {
    const saved = handoff;
    if (
      !saved?.previous ||
      !saved.oldView ||
      !alive() ||
      failed ||
      binding !== saved.binding ||
      geometryEpoch !== saved.epoch ||
      inflightMetrics ||
      !snapshot ||
      !qualified(snapshot) ||
      !root ||
      !chrome ||
      !chromeContents ||
      chromeContents.isDestroyed() ||
      !chrome.getVisible() ||
      !window.isVisible() ||
      window.isMinimized() ||
      !debuggerOwned ||
      chromeFrame !== chromeContents.mainFrame ||
      chromeContents.getZoomFactor() !== owner.getZoomFactor() ||
      snapshot.toolbar.loading ||
      !sameMetrics(saved.metrics, currentMetrics()) ||
      !sameMetrics(appliedMetrics, saved.metrics) ||
      !sameBounds(root.getBounds(), saved.rootBounds) ||
      !sameBounds(chrome.getBounds(), saved.chromeBounds)
    )
      return false;
    const old = pageCurrent(saved.previous),
      target = pageCurrent(saved.binding);
    return (
      !!old &&
      !!target &&
      old.view === saved.oldView &&
      target.view === saved.targetView &&
      old.view.getVisible() &&
      window.contentView.children.includes(old.view) &&
      window.contentView.children.includes(target.view) &&
      !!saved.previous.viewport &&
      !old.view.webContents.isLoadingMainFrame() &&
      !target.view.webContents.isLoadingMainFrame() &&
      sameBounds(old.view.getBounds(), saved.previous.viewport) &&
      old.view.webContents.getURL() === saved.oldURL &&
      target.view.webContents.getURL() === saved.targetURL
    );
  };
  const release = (id?: string) => {
    if (id && binding?.id !== id) return;
    if (rootReturn) {
      if (!rootReturnCurrent(rootReturn.binding.id, rootReturn.binding.scope)) cancelRootReturn();
      else {
        shrinkRootReturn();
        settle();
        broadcast();
        return;
      }
    }
    const releasedId = binding?.id,
      exposed = !!shell || !!display?.offered;
    finishDisplay(false);
    const prepared = preparedTarget();
    if (prepared && (!id || id === prepared.fromId) && shellCurrent(prepared.scope)) {
      if (binding) binding.suspended = true;
      settle();
      broadcast();
      return;
    }
    finishHandoff();
    binding = undefined;
    snapshot = undefined;
    geometryEpoch++;
    settle();
    restore(releasedId, exposed);
    if (debuggerOwned && alive()) requestMetrics();
    broadcast();
  };
  const fail = () => {
    if (disposed || failed) return;
    const id = binding?.id;
    failed = true;
    cancelRootReturn();
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
    setNativeRootBounds(window);
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
      placeDisplay();
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
      placeDisplay();
      pumpDisplay();
    })().catch(fail);
  };
  function update() {
    if (!alive() || failed) return;
    if (rootReturn) {
      if (!rootReturnCurrent(rootReturn.binding.id, rootReturn.binding.scope)) cancelRootReturn();
      else {
        broadcast();
        return;
      }
    }
    if (display && chromeFrame && !displayCurrent()) finishDisplay(false);
    if (handoff && !handoffCurrent()) finishHandoff();
    else if (handoff?.oldView && !holdCurrent()) dropLiveSource();
    if (!binding && intent && targetIntent(intent) && options.getPage(intent.toolbar.id))
      applySnapshot(intent);
    if (!snapshot || !targetIntent(snapshot) || !pageCurrent()) {
      if (preparedTarget()) {
        broadcast();
        return;
      }
      const pending = binding && options.getPage(binding.id);
      if (
        !shell &&
        snapshot &&
        targetIntent(snapshot) &&
        pending?.view.webContents &&
        !pending.view.webContents.isDestroyed() &&
        pageOwnerMatches(pending, binding!.scope)
      ) {
        if (pending.token !== binding!.token) {
          finishDisplay(false);
          binding = {
            ...binding!,
            token: pending.token,
            attachment: randomUUID(),
            pageToken: randomUUID(),
            sequence: 0,
            prepared: false,
            displayOffered: false,
            announced: false,
            renderedRevision: undefined,
          };
          snapshot = { ...snapshot, hosted: false };
        }
        if (pageCurrent()) prepare();
        broadcast();
        return;
      }
      if (binding) {
        const id = binding.id;
        release();
        options.onSuspend(id);
      }
      return;
    }
    prepare();
    broadcast();
    pumpDisplay();
    if (binding && readyFor(binding.id) && !binding.announced) {
      binding.announced = true;
      options.onReady(binding.id);
    }
  }
  const detached = () => {
    debuggerOwned = false;
    fail();
  };
  const invalidateGeometry = () => {
    const exposed = !!shell || !!display?.offered;
    cancelRootReturn();
    finishDisplay(false);
    shell = undefined;
    if (binding && exposed) options.onShellReleased?.(binding.id);
    finishHandoff();
    geometryEpoch++;
    if (!alive()) return;
    // The controller invalidates old coordinates before its shared apply.
    broadcast();
  };
  const rootNavigation = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => {
    if (!mainFrame || inPlace) return;
    cancelRootReturn();
    context = undefined;
    intent = undefined;
    options.onContextChanged?.();
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
  function applySnapshot(value: NativeBrowserChromeSnapshot) {
    const page = options.getPage(value.toolbar.id);
    if (!targetIntent(value) || !page || !pageOwnerMatches(page, value.scope)) {
      const id = binding?.id;
      release();
      snapshot = value;
      if (id) options.onSuspend(id);
      return;
    }
    let suspended: string | undefined;
    if (
      !binding ||
      binding.id !== page.id ||
      binding.token !== page.token ||
      !sameScope(binding.scope, value.scope)
    ) {
      // Existing pages in the same selected document can exchange the target
      // without tearing down the physical split. This retains no input grant:
      // the replacement still needs a new wire ACK and current layout.
      const previous = binding;
      const retainShell = shellCurrent(value.scope);
      const retainSplit =
        previous &&
        retainShell &&
        !preparedTarget() &&
        !handoff &&
        previous.id !== page.id &&
        bindingReady(previous.id, value.scope) &&
        !!previous.viewport &&
        previous.geometryEpoch === geometryEpoch &&
        !inflightMetrics &&
        sameMetrics(appliedMetrics, currentMetrics()) &&
        !!root &&
        !!chrome?.getVisible() &&
        !snapshot?.toolbar.loading &&
        !value.toolbar.loading &&
        !pageCurrent(previous)?.view.webContents.isLoadingMainFrame() &&
        !page.view.webContents.isLoadingMainFrame() &&
        snapshot?.tabs.tabs.some((tab) => tab.id === page.id && tab.kind === 'browser') &&
        !!pageCurrent({ ...previous, id: page.id, token: page.token });
      if (retainShell) {
        finishDisplay(false);
        finishHandoff();
        settle();
        geometryEpoch++;
        suspended = previous?.id !== page.id ? previous?.id : undefined;
      } else release();
      binding = {
        id: page.id,
        token: page.token,
        pageToken: randomUUID(),
        scope: value.scope,
        attachment: randomUUID(),
        sequence: 0,
        prepared: false,
        displayOffered: retainShell,
        announced: false,
      };
      if (retainShell) {
        const target = binding,
          handoffKey = randomUUID();
        handoff = {
          binding: target,
          previous: retainSplit ? previous : undefined,
          key: handoffKey,
          oldView: retainSplit ? pageCurrent(previous)!.view : undefined,
          targetView: page.view,
          oldURL: retainSplit ? pageCurrent(previous)!.view.webContents.getURL() : undefined,
          targetURL: page.view.webContents.getURL(),
          metrics: currentMetrics(),
          epoch: geometryEpoch,
          rootBounds: root!.getBounds(),
          chromeBounds: chrome!.getBounds(),
          timer: setTimeout(() => {
            if (binding === target && handoff?.key === handoffKey) fail();
          }, 1500),
        };
      }
    }
    // A true delegation bit from the prior page/document is not an ACK for
    // this newly issued wire identity. Root must echo a fresh revision after
    // the new binding's metrics/Chrome offer has become available.
    snapshot = { ...structuredClone(value), hosted: binding.prepared && value.hosted };
    if (suspended) options.onSuspend(suspended);
    if (loading && chromeFrame && debuggerOwned && !binding?.prepared) requestMetrics();
  }
  ipcMain.handle(nativeBrowserChromeRootChannel, (event, value: unknown) => {
    assertNativeSender(event, disposed ? undefined : window, options.rendererUrl);
    const request =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
    if (request?.action === 'context') {
      if (
        Object.keys(request).length !== 3 ||
        !Object.keys(request).every((k) => ['action', 'revision', 'owner'].includes(k)) ||
        !Number.isSafeInteger(request.revision) ||
        Number(request.revision) <= 0 ||
        (request.owner !== null && !isNativeBrowserChromeOwner(request.owner))
      )
        throw Error('browser_chrome_context_invalid');
      const revision = Number(request.revision);
      if (revision < contextFloor) {
        if (request.owner === null) return;
        throw Error('browser_chrome_context_stale');
      }
      if (revision === contextFloor && request.owner !== null)
        throw Error('browser_chrome_context_stale');
      if (
        request.owner &&
        !('draft' in request.owner) &&
        !sameScope(request.owner, options.currentScope(false))
      )
        throw Error('browser_chrome_scope_denied');
      if (revision === contextFloor && !context) return;
      contextFloor = revision;
      contextFrame = owner.mainFrame;
      contextual = true;
      context = request.owner
        ? { revision, owner: request.owner as NativeBrowserChromeOwner }
        : undefined;
      intent = undefined;
      cancelRootReturn();
      release();
      options.onContextChanged?.();
      return;
    }
    if (request?.action === 'publish') {
      if (
        Object.keys(request).length !== 3 ||
        !Object.keys(request).every((k) => ['action', 'snapshot', 'context'].includes(k)) ||
        !Number.isSafeInteger(request.context) ||
        Number(request.context) <= 0 ||
        !contextual ||
        contextFrame !== owner.mainFrame ||
        request.context !== contextFloor
      )
        throw Error('browser_chrome_context_stale');
      value = request.snapshot;
    } else if (
      contextual ||
      (value &&
        typeof value === 'object' &&
        'scope' in value &&
        isNativeBrowserChromeOwner(value.scope) &&
        'draft' in value.scope)
    )
      throw Error('browser_chrome_context_required');
    if (value === null) {
      intent = null;
      const id = binding?.id;
      release();
      if (id && !rootReturn) options.onSuspend(id);
      return;
    }
    if (!isNativeBrowserChromeSnapshot(value)) throw Error('invalid_browser_chrome_snapshot');
    if (!ownerCurrent(value.scope)) throw Error('browser_chrome_scope_denied');
    const revision = revisions.get(key(value.scope)) ?? 0;
    if (value.revision <= revision) {
      if (snapshot && JSON.stringify(snapshot) === JSON.stringify(value)) return;
      throw Error('browser_chrome_stale_snapshot');
    }
    revisions.set(key(value.scope), value.revision);
    intent = value;
    if (rootReturn) {
      if (
        rootReturn.binding.id !== value.toolbar.id ||
        !targetIntent(value) ||
        !sameScope(rootReturn.binding.scope, value.scope)
      )
        cancelRootReturn();
      else {
        broadcast();
        return;
      }
    }
    applySnapshot(value);
    update();
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
    if (request.action === 'rendered') {
      const input = value as Record<string, unknown>;
      const rendered = {
        attachment: input.attachment,
        pageToken: input.pageToken,
        revision: input.revision,
      };
      if (
        Object.keys(input).length !== 4 ||
        !isNativeBrowserChromeRendered(rendered) ||
        !binding ||
        !snapshot ||
        rendered.attachment !== binding.attachment ||
        rendered.pageToken !== binding.pageToken ||
        rendered.revision !== snapshot.revision
      )
        throw Error('browser_chrome_stale_rendered');
      binding.renderedRevision = rendered.revision;
      pumpDisplay();
      return;
    }
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
    acceptsPresentation,
    beginRootReturn(
      id: string,
      scope: NativeBrowserChromeOwner,
    ): { bounds: NativeBrowserBounds; width: number; height: number } | null {
      if (
        rootReturn ||
        !readyFor(id, scope) ||
        !actionable() ||
        !shellCurrent(scope) ||
        !binding?.viewport ||
        !root ||
        !chrome ||
        !pageCurrent()?.view.getVisible()
      )
        return null;
      const { width, height } = dimensions(),
        zoom = owner.getZoomFactor(),
        strip = chrome.getBounds();
      finishDisplay(true);
      finishHandoff();
      settle();
      const saved = {
        binding,
        frame: owner.mainFrame,
        metrics: currentMetrics(),
        context: contextual ? context?.revision : undefined,
        chrome: chrome.getBounds(),
        strip,
        root: { x: 0, y: 0, width, height },
      };
      rootReturn = saved;
      binding.suspended = true;
      setNativeRootBounds(window);
      broadcast();
      return {
        bounds: {
          x: strip.x / zoom,
          y: strip.y / zoom,
          width: strip.width / zoom,
          height: strip.height / zoom,
          radius: 0,
        },
        width: width / zoom,
        height: height / zoom,
      };
    },
    rootReturnCurrent,
    cancelRootReturn,
    finishRootReturn(id: string) {
      const saved = rootReturn;
      if (!saved || saved.binding.id !== id) return;
      rootReturn = undefined;
      if (binding === saved.binding) {
        binding = undefined;
        snapshot = undefined;
        geometryEpoch++;
        settle();
      }
      restore(id);
      broadcast();
    },
    update,
    release,
    invalidateGeometry,
    syncViewport: requestMetrics,
    prepareDisplay(
      id: string,
      viewport: Bounds,
      scope: NativeBrowserChromeOwner,
      signal: AbortSignal,
    ): Promise<boolean> {
      signal.throwIfAborted();
      update();
      const [width = 0, height = 0] = window.getContentSize();
      if (
        !binding ||
        binding.id !== id ||
        !sameScope(binding.scope, scope) ||
        !pageCurrent() ||
        ![viewport.x, viewport.y, viewport.width, viewport.height].every(Number.isFinite) ||
        viewport.x <= 0 ||
        viewport.y <= 0 ||
        viewport.width <= 0 ||
        viewport.height <= 0 ||
        viewport.x + viewport.width > width ||
        viewport.y + viewport.height > height
      )
        return Promise.resolve(false);
      if (
        display &&
        (display.binding !== binding ||
          display.signal !== signal ||
          !sameBounds(display.viewport, viewport))
      )
        finishDisplay(false);
      if (!display) {
        const abort = () => {
          if (display?.signal === signal) finishDisplay(false);
        };
        display = {
          binding,
          viewport: { ...viewport },
          metrics: currentMetrics(),
          offered: false,
          waiting: new Set(),
          signal,
          abort,
        };
        signal.addEventListener('abort', abort, { once: true });
      }
      const d = display;
      if (d.readyRevision === snapshot?.revision && displayCurrent()) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        d.waiting.add(resolve);
        d.timer ??= setTimeout(() => {
          if (display === d) finishDisplay(false);
        }, 1500);
        prepare();
        placeDisplay();
        requestMetrics();
        broadcast();
        pumpDisplay();
      });
    },
    offerDisplay(id: string, viewport: Bounds, scope: NativeBrowserChromeOwner): boolean {
      const d = display;
      if (
        !d ||
        binding?.id !== id ||
        !sameScope(binding.scope, scope) ||
        !displayCurrent() ||
        inflightMetrics ||
        !sameMetrics(appliedMetrics, d.metrics) ||
        !sameBounds(d.viewport, viewport) ||
        d.readyRevision !== snapshot?.revision ||
        !chrome ||
        !root
      )
        return false;
      const children = window.contentView.children,
        index = children.indexOf(root);
      if (children.indexOf(chrome) < index) window.contentView.addChildView(chrome, index + 1);
      d.offered = true;
      binding.displayOffered = true;
      clearTimeout(d.timer);
      d.timer = setTimeout(() => {
        if (display === d) finishDisplay(false);
      }, 1500);
      snapshot = { ...snapshot!, hosted: false };
      broadcast();
      return true;
    },
    presentationViewport(scope: NativeBrowserChromeOwner) {
      return shellCurrent(scope) ? { ...shell!.viewport } : undefined;
    },
    holdsPresentation(id: string) {
      const saved = handoff;
      return saved?.previous?.id === id && holdCurrent() && saved.previous.viewport
        ? { key: saved.key, targetId: saved.binding.id, viewport: { ...saved.previous.viewport } }
        : undefined;
    },
    cancelPresentationHold(id?: string) {
      if (!id) finishHandoff();
      else if (handoff?.previous?.id === id || handoff?.binding.id === id) dropLiveSource();
    },
    completePresentation(id: string) {
      if (handoff?.binding !== binding || binding?.id !== id || !readyFor(id)) return;
      const page = pageCurrent();
      if (
        handoffCurrent() &&
        page?.view.getVisible() &&
        binding.viewport &&
        sameBounds(page.view.getBounds(), binding.viewport)
      ) {
        finishHandoff();
        update();
      }
    },
    layout(id: string, viewportDip: Bounds, scope?: NativeBrowserChromeOwner) {
      if (rootReturn) return false;
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
      if (
        handoff?.binding === binding &&
        handoff.oldView &&
        (!handoff.previous?.viewport || !sameBounds(handoff.previous.viewport, viewportDip))
      )
        finishHandoff();
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
      shell = {
        scope: binding.scope,
        viewport: { ...viewportDip },
        metrics: currentMetrics(),
        root: root.getBounds(),
        chrome: chrome.getBounds(),
      };
      finishDisplay(true);
      const visible = window.isVisible() && !window.isMinimized();
      if (chrome.getVisible() !== visible) chrome.setVisible(visible);
      return true;
    },
    dispose() {
      if (disposed) return;
      failed = true; // Restore physical Root without starting another metrics command.
      cancelRootReturn();
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
