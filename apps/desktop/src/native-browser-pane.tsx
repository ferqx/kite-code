import { type SessionBrowserPageProps, Spinner } from '@kite-ai/ui/desktop';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  NativeBrowserBounds,
  NativeBrowserGroupLayout,
  NativeBrowserLayout,
  NativeBrowserPanelLayout,
  NativeBrowserPresentationRequest,
  NativeBrowserRequest,
  NativeBrowserRestoreScope,
  NativeBrowserState,
} from './native-browser-bridge';
import {
  nativeBrowserWitnessColors,
  nativeBrowserWitnessPosition,
  nativeBrowserWitnessTileSize,
  nativeBrowserWitnessWidth,
  projectNativeBrowserBounds,
} from './native-browser-bridge';
import { NativeBrowserChromeToolbar } from './native-browser-chrome-presentation';
import type {
  NativeBrowserToolbarAction,
  NativeBrowserToolbarPort,
  NativeBrowserToolbarPresentation,
} from './native-browser-chrome-types';
import { useNativeBrowserPopup } from './native-browser-menu';

const presentationRevisionKey = Symbol.for('kite.native.browser.presentationRevision');
function nextPresentationRevision(draft?: string) {
  // Fast Refresh can reevaluate this module while Main still owns the same
  // Root document and Caller generation. Keep ordering with that document;
  // a real document replacement obtains a new Caller generation in Main.
  const previous: unknown = Reflect.get(document, presentationRevisionKey) ?? 0;
  if (!Number.isSafeInteger(previous) || Number(previous) < 0)
    throw Error('browser_presentation_unavailable');
  let floor = Number(previous);
  const savedKey = draft && `kite.browserDraftRevision:${draft}`;
  if (savedKey) {
    try {
      const saved = window.sessionStorage.getItem(savedKey);
      if (saved !== null) {
        const revision = Number(saved);
        if (!Number.isSafeInteger(revision) || revision < 0 || String(revision) !== saved)
          throw Error('browser_presentation_unavailable');
        floor = Math.max(floor, revision);
      }
    } catch {
      throw Error('browser_presentation_unavailable');
    }
  }
  const next = floor + 1;
  if (!Number.isSafeInteger(next)) throw Error('browser_presentation_unavailable');
  if (savedKey) {
    try {
      window.sessionStorage.setItem(savedKey, String(next));
    } catch {
      throw Error('browser_presentation_unavailable');
    }
  }
  Object.defineProperty(document, presentationRevisionKey, { value: next, configurable: true });
  return next;
}

function clippedViewport(node: HTMLElement): NativeBrowserBounds | null {
  const rect = node.getBoundingClientRect();
  const clips: DOMRect[] = [];
  for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor);
    if (
      ancestor.hasAttribute('data-panel') ||
      [style.overflow, style.overflowX, style.overflowY].some((value) =>
        /^(?:hidden|clip|auto|scroll)$/.test(value),
      )
    )
      clips.push(ancestor.getBoundingClientRect());
  }
  const x = Math.max(0, rect.left, ...clips.map((box) => box.left));
  const y = Math.max(0, rect.top, ...clips.map((box) => box.top));
  const width = Math.min(window.innerWidth, rect.right, ...clips.map((box) => box.right)) - x;
  const height = Math.min(window.innerHeight, rect.bottom, ...clips.map((box) => box.bottom)) - y;
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return {
    x,
    y,
    width,
    height,
    radius: Number.parseFloat(getComputedStyle(node).borderTopLeftRadius) || 0,
  };
}

type NativeLayoutMeasurement =
  | { kind: 'standalone' | 'deferred' | 'unsupported' }
  | { kind: 'measured'; layout: NativeBrowserLayout };

function measuredLayout(node: HTMLElement, bounds: NativeBrowserBounds): NativeLayoutMeasurement {
  try {
    const leaf = node.closest<HTMLElement>('[data-panel]');
    const inSessionLayout = !!node.closest('.client-panels, .client-content-panels');
    if (!leaf) return { kind: inSessionLayout ? 'unsupported' : 'standalone' };
    if (!inSessionLayout && !leaf.hasAttribute('data-native-browser-layout'))
      return { kind: 'standalone' };
    const width = window.innerWidth,
      height = window.innerHeight;
    const finiteBox = (box: DOMRect) =>
      [box.left, box.top, box.right, box.bottom, box.width, box.height].every(Number.isFinite);
    const near = (a: number, b: number) => Math.abs(a - b) <= 1;
    const fills = (box: DOMRect, parent: DOMRect) =>
      near(box.left, parent.left) &&
      near(box.top, parent.top) &&
      near(box.right, parent.right) &&
      near(box.bottom, parent.bottom);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
      return { kind: 'unsupported' };
    let panel: HTMLElement | null = leaf;
    let deferred = false;
    const groups: NativeBrowserGroupLayout[] = [];
    while (panel) {
      if (groups.length === 2) return { kind: 'unsupported' };
      const group: HTMLElement | null = panel.parentElement;
      if (
        group?.dataset.slot !== 'resizable-panel-group' ||
        getComputedStyle(group).flexDirection !== 'row'
      )
        return { kind: 'unsupported' };
      const panels = [...group.children].filter(
        (element): element is HTMLElement =>
          element instanceof HTMLElement && element.hasAttribute('data-panel'),
      );
      const handles = [...group.children].filter(
        (element): element is HTMLElement =>
          element instanceof HTMLElement && element.dataset.slot === 'resizable-handle',
      );
      if (panels.length !== 2 || panels[1] !== panel || handles.length !== 1)
        return { kind: 'unsupported' };
      const parent: HTMLElement | null =
        group.parentElement?.closest<HTMLElement>('[data-panel]') ?? null;
      if (!group.classList.contains(parent ? 'client-content-panels' : 'client-panels'))
        return { kind: 'unsupported' };
      const parentBox = parent?.getBoundingClientRect() ?? new DOMRect(0, 0, width, height);
      const box = group.getBoundingClientRect();
      const boxes = panels.map((element) => element.getBoundingClientRect());
      const handle = handles[0]!.getBoundingClientRect();
      if (
        ![parentBox, box, ...boxes, handle].every(finiteBox) ||
        box.width <= 0 ||
        box.height <= 0 ||
        boxes[0]!.width < 0 ||
        boxes[1]!.width <= 0 ||
        handle.width < 0 ||
        handle.width > 2
      )
        return { kind: 'unsupported' };
      // SessionPage's Groups fill their viewport/parent. A newer window with old
      // DOM boxes is a pending measurement, never a real fixed outer margin.
      if (
        !fills(box, parentBox) ||
        !near(boxes[0]!.left, box.left) ||
        !near(boxes[1]!.right, box.right) ||
        !near(boxes[0]!.right, handle.left) ||
        !near(handle.right, boxes[1]!.left) ||
        !near(boxes[0]!.width + handle.width + boxes[1]!.width, box.width) ||
        ![...boxes, handle].every(
          (part) => near(part.top, box.top) && near(part.bottom, box.bottom),
        )
      )
        deferred = true;
      const data = panels.map((element, index): NativeBrowserPanelLayout => {
        const input = JSON.parse(element.dataset.nativeBrowserLayout ?? 'null');
        if (
          !input ||
          Object.keys(input).length !== 4 ||
          !Object.keys(input).every((key) =>
            ['minSize', 'maxSize', 'groupResizeBehavior', 'collapsible'].includes(key),
          )
        )
          throw Error('unsupported_panel_layout');
        const size = (value: unknown) => {
          const match = typeof value === 'string' ? /^(\d+(?:\.\d+)?)(px|%)$/.exec(value) : null;
          if (!match) throw Error('unsupported_panel_size');
          const number = Number(match[1]);
          if (!Number.isFinite(number) || number > 32768 || (match[2] === '%' && number > 100))
            throw Error('unsupported_panel_size');
          return { value: number, unit: match[2] as 'px' | '%' };
        };
        const min = size(input.minSize),
          max = size(input.maxSize);
        if (
          !['preserve-pixel-size', 'preserve-relative-size'].includes(input.groupResizeBehavior) ||
          typeof input.collapsible !== 'boolean' ||
          (min.unit === max.unit && min.value > max.value)
        )
          throw Error('unsupported_panel_policy');
        return {
          size: boxes[index]!.width,
          min: min.value,
          minUnit: min.unit,
          max: max.value,
          maxUnit: max.unit,
          preserve: input.groupResizeBehavior === 'preserve-pixel-size' ? 'pixel' : 'relative',
          collapsible: input.collapsible,
        };
      });
      if (!data.some((item) => item.preserve === 'relative' && item.size > 0))
        return { kind: 'unsupported' };
      groups.unshift({
        left: 0,
        right: 0,
        gap: handle.width,
        panels: data as [NativeBrowserPanelLayout, NativeBrowserPanelLayout],
      });
      panel = parent;
    }
    if (deferred) return { kind: 'deferred' };
    const box = leaf.getBoundingClientRect();
    const layout: NativeBrowserLayout = {
      windowWidth: width,
      windowHeight: height,
      groups,
      insetLeft: bounds.x - box.left,
      insetRight: box.right - bounds.x - bounds.width,
    };
    const predicted = projectNativeBrowserBounds(bounds, layout, width, height);
    if (
      !predicted ||
      Math.abs(predicted.x - bounds.x) > 1 ||
      Math.abs(predicted.width - bounds.width) > 1
    )
      return { kind: 'deferred' };
    return { kind: 'measured', layout };
  } catch {
    return { kind: 'unsupported' };
  }
}

const errors = {
  load_failed: '网页未能打开，请检查地址或网络后重试。',
  unsupported_navigation: '暂不支持打开这种地址，请使用 HTTP 或 HTTPS 网址。',
  download_unsupported: '简易浏览器暂不支持下载文件。',
  process_gone: '浏览页面已停止，请刷新后重试。',
};
function requestError(cause: unknown): string {
  const code = cause instanceof Error ? cause.message : '';
  if (code === 'unsupported_browser_protocol') return errors.unsupported_navigation;
  if (code === 'invalid_browser_address') return '请输入有效的网址或搜索内容。';
  if (code === 'browser_page_control_required') return 'Agent 正在控制此页，请先明确暂停并接管。';
  if (code === 'browser_page_scope_denied') return '会话已变化，原页面操作未发送。';
  if (code === 'browser_page_grant_denied' || code === 'browser_session_page_already_bound')
    return '已有页面正在接管或保留控制，请先核对原任务。';
  if (code === 'browser_tab_limit') return '最多打开8个浏览标签页，请先关闭一些标签。';
  if (code === 'browser_presentation_unavailable')
    return '网页显示尚未确认。请检查当前页面状态；你可以停止加载或重新输入地址。';
  return '浏览器暂不可用，请完全退出并重新启动应用后重试。';
}

export function NativeBrowserPane({
  id,
  visible,
  tools,
  onTitleChange,
  controlTools,
  annotate,
  initialHint,
  scope,
  draft,
  chromeHosted = false,
  onChromePresentation,
}: SessionBrowserPageProps & {
  scope?: NativeBrowserRestoreScope;
  draft?: string;
  initialHint?: NativeBrowserState;
  chromeHosted?: boolean;
  onChromePresentation?: (presentation: NativeBrowserToolbarPort | undefined) => void;
  controlTools?: (state: NativeBrowserState) => ReactNode;
  annotate?: (
    state: NativeBrowserState,
    visible: boolean,
    toolbarHost: HTMLElement | null,
  ) => ReactNode;
}) {
  const [notesOpen, setNotesOpen] = useState(false);
  const [annotationToolbarHost, setAnnotationToolbarHost] = useState<HTMLSpanElement | null>(null);
  const host = typeof window === 'undefined' ? undefined : window.kiteNative;
  const [state, setState] = useState<NativeBrowserState>(
    initialHint?.id === id
      ? initialHint
      : {
          id,
          url: '',
          title: '新标签页',
          loading: false,
          canGoBack: false,
          canGoForward: false,
        },
  );
  const [address, setAddress] = useState('');
  const [issue, setIssue] = useState<string>();
  const [menuIssue, setMenuIssue] = useState<string>();
  const mounted = useRef(false);
  const focused = useRef(false);
  const toolbar = useRef<HTMLDivElement>(null);
  const title = useRef(onTitleChange);
  title.current = onTitleChange;
  const viewport = useRef<HTMLElement>(null);
  const layoutWitness = useRef<HTMLCanvasElement>(null);
  const frozenViewport = useRef<HTMLImageElement>(null);
  const hideWitness = useCallback(() => {
    const canvas = layoutWitness.current;
    if (!canvas || canvas.hidden) return;
    canvas.hidden = true;
    // Retire the backing pixels as well as the DOM visibility. A retained
    // canvas must not bring an old proof back into a later loading surface.
    canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
  }, []);
  const chromeHostedRef = useRef(chromeHosted);
  chromeHostedRef.current = chromeHosted;
  useLayoutEffect(() => {
    if (!chromeHosted || !frozenViewport.current) return;
    frozenViewport.current.hidden = true;
    frozenViewport.current.removeAttribute('src');
  }, [chromeHosted]);
  const scopeKey = JSON.stringify(scope);
  const chromeOwnerKey = JSON.stringify([scope, draft]);
  const hasChromeOwner = !!scope || !!draft;
  const presentationScope = useMemo(
    () => (scopeKey ? (JSON.parse(scopeKey) as NativeBrowserRestoreScope) : undefined),
    [scopeKey],
  );
  const displayIdentity = useRef({ id, host, scopeKey, draft, token: {} });
  if (
    displayIdentity.current.id !== id ||
    displayIdentity.current.host !== host ||
    displayIdentity.current.scopeKey !== scopeKey ||
    displayIdentity.current.draft !== draft
  )
    displayIdentity.current = { id, host, scopeKey, draft, token: {} };
  const displayOwner = displayIdentity.current.token;
  const [presentedOwner, setPresentedOwner] = useState<object>();
  const previouslyPresentedOwner = useRef<object>(undefined);
  const awaitingPresentation = presentedOwner !== displayOwner;
  const awaitingPresentationRef = useRef(awaitingPresentation);
  awaitingPresentationRef.current = awaitingPresentation;
  const startupEpoch = useRef(0);
  const [presentationEpoch, setPresentationEpoch] = useState(0);
  const retirePresentation = useRef<((reobserve?: boolean) => void) | undefined>(undefined);
  const restartPresentation = useCallback(
    (reobserve = false) => {
      if (displayIdentity.current.token !== displayOwner) return;
      retirePresentation.current?.(reobserve);
      awaitingPresentationRef.current = true;
      setPresentedOwner(undefined);
      setPresentationEpoch(++startupEpoch.current);
    },
    [displayOwner],
  );
  const observedNavigation = useRef('');
  const invalidateInitialPresentation = useCallback(() => {
    if (!awaitingPresentationRef.current) return;
    restartPresentation();
  }, [restartPresentation]);
  const identity = JSON.stringify([
    scope,
    draft,
    id,
    state.url,
    state.control?.incarnation,
    state.control?.navigation,
    state.error,
  ]);
  const apply = useCallback(
    (next: NativeBrowserState | null) => {
      if (!mounted.current || displayIdentity.current.token !== displayOwner || next?.id !== id)
        return;
      if (!next.url) {
        awaitingPresentationRef.current = true;
        setPresentedOwner(undefined);
      }
      const navigation = JSON.stringify([
        next.url,
        next.control?.incarnation,
        next.control?.navigation,
        next.error,
      ]);
      if (navigation !== observedNavigation.current) {
        observedNavigation.current = navigation;
        invalidateInitialPresentation();
      }
      setState(next);
    },
    [id, invalidateInitialPresentation, displayOwner],
  );
  useEffect(() => {
    mounted.current = true;
    const unwatch = host?.watchBrowser?.(apply);
    void host
      ?.browserRequest?.({ action: 'state', id, ...(draft ? { draft } : {}) })
      .then((next) => {
        if (!mounted.current || displayIdentity.current.token !== displayOwner) return;
        apply(next);
        if (!next && host.browserDisplayIntent?.()?.id === id) host.cancelBrowserDisplay?.();
      })
      .catch(() => {
        if (!mounted.current || displayIdentity.current.token !== displayOwner) return;
        if (host?.browserDisplayIntent?.()?.id === id) host.cancelBrowserDisplay?.();
      });
    return () => {
      mounted.current = false;
      unwatch?.();
    };
  }, [id, host, apply, draft, displayOwner]);
  useEffect(() => {
    if (!host?.watchBrowserPresentation) return;
    let disposed = false;
    let pending: NativeBrowserPresentationRequest | undefined;
    let lastRequest: string | undefined;
    const observe = (request: NativeBrowserPresentationRequest) => {
      if (
        disposed ||
        !mounted.current ||
        displayIdentity.current.token !== displayOwner ||
        !presentationIdentity.current.visible ||
        request.id !== id ||
        (draft
          ? request.draft !== draft || request.scope !== undefined
          : request.draft !== undefined ||
            !presentationScope ||
            !request.scope ||
            !(['storeId', 'sessionId', 'generation', 'viewSelection'] as const).every(
              (key) => request.scope![key] === presentationScope[key],
            ))
      )
        return;
      if (document.hidden) {
        pending = request;
        return;
      }
      pending = undefined;
      if (lastRequest === request.key) return;
      lastRequest = request.key;
      restartPresentation(true);
    };
    const resume = () => {
      if (!document.hidden && pending) observe(pending);
    };
    const unwatchPresentation = host.watchBrowserPresentation(observe);
    document.addEventListener('visibilitychange', resume);
    return () => {
      disposed = true;
      pending = undefined;
      try {
        unwatchPresentation();
      } finally {
        document.removeEventListener('visibilitychange', resume);
      }
    };
  }, [id, host, draft, displayOwner, presentationScope, restartPresentation]);
  useEffect(() => {
    title.current(state.title || '新标签页');
  }, [state.title]);
  useEffect(() => {
    if (!focused.current) setAddress(state.url);
  }, [state.url]);
  const request = async (
    input: Exclude<NativeBrowserRequest, { action: 'grant' | 'capturePresentation' | 'restore' }>,
  ) => {
    setIssue(undefined);
    if (input.action === 'navigate' || input.action === 'stop') invalidateInitialPresentation();
    if (!host?.browserRequest) {
      setIssue(requestError(null));
      return;
    }
    try {
      const next = await host.browserRequest(draft ? { ...input, draft } : input);
      if (!mounted.current || displayIdentity.current.token !== displayOwner) return;
      apply(next);
      if (mounted.current && input.action === 'navigate' && next) setAddress(next.url);
    } catch (cause) {
      if (mounted.current && displayIdentity.current.token === displayOwner)
        setIssue(requestError(cause));
    }
  };
  const external = !!state.url;
  const blocked = !!state.error || !!issue;
  const presentationIdentity = useRef({
    id,
    host,
    visible,
    external,
    blocked,
    presentationScope,
    draft,
  });
  presentationIdentity.current = { id, host, visible, external, blocked, presentationScope, draft };
  const previousRevision = useRef<number>(undefined);
  useEffect(() => {
    // Only a visible owner creates a presentation. An inactive retained Pane
    // must not revoke its next selection from an effect that never showed it.
    if (!host?.browserRequest || !visible) return;
    const hide = (revision: number | undefined) => {
      if (revision === undefined) return;
      try {
        void host.browserRequest!({
          action: 'present',
          id,
          bounds: null,
          presentationRevision: revision,
          ...(presentationScope ? { scope: presentationScope } : {}),
          ...(draft ? { draft } : {}),
        }).catch(() => {});
      } catch {}
    };
    let revision: number;
    try {
      revision = nextPresentationRevision(draft);
    } catch (cause) {
      hide(previousRevision.current);
      throw cause;
    }
    previousRevision.current = revision;
    const originalNode = viewport.current,
      originalDocument = document;
    let frame: number | undefined;
    let last = '';
    let pending = '';
    let committedLayout = false;
    let asyncLayout = false;
    let asyncLayoutDirty = false;
    let sequence = 0;
    let stopped = false;
    let recoveryAnimating = false;
    let drawn: Extract<NativeBrowserRequest, { action: 'present' }> | undefined;
    let rejectedDraw: typeof drawn;
    const frozenFrames = new Map<string, { image: HTMLImageElement; src: string }>();
    let displayedKey: string | undefined;
    let layoutWaiting = false;
    let requestedFrozen: { key: string; width: number; height: number } | undefined;
    const showFrozen = (key: string, width: number, height: number) => {
      const image = frozenViewport.current,
        saved = frozenFrames.get(key);
      if (!image || !saved) return;
      if (image.getAttribute('src') !== saved.src) image.src = saved.src;
      image.style.width = `${width}px`;
      image.style.height = `${height}px`;
      image.hidden = false;
      displayedKey = key;
    };
    const cache = (value: import('./native-browser-bridge').NativeBrowserFrozenFrame) => {
      if (chromeHostedRef.current) return;
      const image = frozenViewport.current;
      if (!image) return;
      const src = `data:image/png;base64,${value.data}`;
      if (!frozenFrames.has(value.key)) {
        const preload = new window.Image();
        preload.src = src;
        frozenFrames.set(value.key, { image: preload, src });
      }
      if (requestedFrozen?.key === value.key)
        showFrozen(value.key, requestedFrozen.width, requestedFrozen.height);
      // Cache delivery can lag a geometry proposal. It must not replace an
      // already displayed freeze without Main returning that exact frame key.
      if (image.hidden && !image.getAttribute('src')) image.src = src;
      while (frozenFrames.size > 2) {
        const old = [...frozenFrames.keys()].find(
          (key) => key !== requestedFrozen?.key && (image.hidden || key !== displayedKey),
        );
        if (!old) break;
        frozenFrames.delete(old);
      }
    };
    const freeze = (
      value: unknown,
      input?: Extract<NativeBrowserRequest, { action: 'present' }>,
    ) => {
      const image = frozenViewport.current;
      if (value && typeof value === 'object' && 'waiting' in value) {
        const receipt = value as import('./native-browser-bridge').NativeBrowserLayoutReceipt;
        if (!receipt.waiting && receipt.state?.id === id) {
          // Retire only this completed draw even when DOM geometry has moved.
          // Adopting the page still requires the independent current measure.
          if (input && drawn === input) hideWitness();
          completePresentation(input);
        }
      }
      if (chromeHostedRef.current) {
        if (image) {
          image.hidden = true;
          image.removeAttribute('src');
        }
        frozenFrames.clear();
        displayedKey = undefined;
        requestedFrozen = undefined;
        layoutWaiting = false;
        return;
      }
      if (!image || !value || typeof value !== 'object' || !('waiting' in value)) return;
      const receipt = value as import('./native-browser-bridge').NativeBrowserLayoutReceipt;
      layoutWaiting = receipt.waiting;
      // Keep the last qualified image underneath the live Native surface.
      // A subsequent Main resize can hide that sibling before Root receives
      // its resize event; the already painted fallback must still be present.
      if (!receipt.waiting) {
        requestedFrozen = undefined;
        return;
      }
      requestedFrozen = receipt.frozenKey
        ? { key: receipt.frozenKey, width: receipt.frozenWidth!, height: receipt.frozenHeight! }
        : undefined;
      const saved = receipt.frozenKey && frozenFrames.get(receipt.frozenKey);
      if (saved) showFrozen(receipt.frozenKey!, receipt.frozenWidth!, receipt.frozenHeight!);
      else image.hidden = true;
    };
    const draw = (input: Extract<NativeBrowserRequest, { action: 'present' }>) => {
      const canvas = layoutWitness.current,
        node = viewport.current;
      if (!canvas || !node || !input.bounds || !input.witness) return;
      const context = canvas.getContext('2d');
      if (!context) throw Error('browser_presentation_unavailable');
      const scale = window.devicePixelRatio || 1;
      const position = nativeBrowserWitnessPosition(input.bounds, scale),
        box = node.getBoundingClientRect();
      canvas.style.width = `${nativeBrowserWitnessWidth(scale)}px`;
      canvas.style.height = `${nativeBrowserWitnessTileSize(scale)}px`;
      canvas.style.left = `${position.x - box.left}px`;
      canvas.style.top = `${position.y - box.top}px`;
      nativeBrowserWitnessColors(input.witness).forEach((color, tile) => {
        context.fillStyle = `rgb(${color.join(',')})`;
        context.fillRect(tile * 3, 0, 3, 3);
      });
      canvas.hidden = false;
      rejectedDraw = undefined;
      drawn = input;
    };
    let unwatchFrame: (() => void) | undefined;
    const receiveFrame = (ack: import('./native-browser-bridge').NativeBrowserLayoutFrameAck) => {
      // A rejected preflight may later report a bounded display failure. It
      // can explain that failure, never acknowledge successful presentation.
      const input = drawn ?? (ack.error ? rejectedDraw : undefined);
      if (
        stopped ||
        !input?.bounds ||
        !input.layout ||
        !input.witness ||
        ack.id !== id ||
        ack.presentationRevision !== revision ||
        (draft
          ? ack.draft !== draft || ack.scope !== undefined
          : !presentationScope ||
            ack.draft !== undefined ||
            !ack.scope ||
            !(['storeId', 'sessionId', 'generation', 'viewSelection'] as const).every(
              (key) => ack.scope![key] === presentationScope[key],
            ))
      )
        return;
      if (ack.step === 0) {
        if (ack.frozen) {
          cache(ack.frozen);
          if (!layoutWaiting && input.witness.step === 2 && input.witness.key === ack.key)
            showFrozen(ack.frozen.key, ack.frozen.cssWidth, ack.frozen.cssHeight);
        }
        return;
      }
      if (input.witness.key !== ack.key) return;
      if (ack.step === 2) {
        hideWitness();
        if (ack.error) {
          if (presentationCurrent(input)) {
            drawn = undefined;
            setIssue(requestError(Error(ack.error)));
          }
          return;
        }
        if (ack.presented === true || (!draft && ack.presented === undefined))
          completePresentation(input);
        freeze({ waiting: false });
        return;
      }
      if (input.witness.step !== 1) return;
      const node = viewport.current,
        bounds = node && clippedViewport(node);
      const measurement = node && bounds ? measuredLayout(node, bounds) : undefined;
      if (
        !bounds ||
        measurement?.kind !== 'measured' ||
        JSON.stringify([bounds, measurement.layout]) !==
          JSON.stringify([input.bounds, input.layout])
      ) {
        last = '';
        publish();
        return;
      }
      const next = { ...input, witness: { key: input.witness.key, step: 2 as const } };
      try {
        if (ack.frozen) cache(ack.frozen);
        draw(next);
        freeze(host.presentBrowserLayout?.(next), next);
      } catch {
        last = '';
      }
    };
    const measure = () => {
      const node = viewport.current;
      let bounds: NativeBrowserBounds | null = null;
      let unclipped: NativeBrowserBounds | undefined;
      if (
        visible &&
        external &&
        !blocked &&
        node?.isConnected &&
        node.ownerDocument === originalDocument &&
        !document.hidden &&
        !node.closest('[inert], [hidden]') &&
        getComputedStyle(node).visibility !== 'hidden' &&
        getComputedStyle(node).visibility !== 'collapse'
      ) {
        const rect = node.getBoundingClientRect();
        const covered = [
          ...document.querySelectorAll(
            '[data-slot="dialog-overlay"], [data-slot="alert-dialog-overlay"], [role="menu"], [data-slot="popover-content"], [data-slot="sheet-overlay"], [data-native-browser-overlay]:not([hidden])',
          ),
        ].some((overlay) => {
          const box = overlay.getBoundingClientRect();
          const style = getComputedStyle(overlay);
          return (
            style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            box.width > 0 &&
            box.height > 0 &&
            box.left < rect.right &&
            box.right > rect.left &&
            box.top < rect.bottom &&
            box.bottom > rect.top
          );
        });
        if (!covered) {
          bounds = clippedViewport(node);
          if (rect.width > 0 && rect.height > 0)
            unclipped = {
              x: rect.left,
              y: rect.top,
              width: rect.width,
              height: rect.height,
              radius: 0,
            };
        }
      }
      const measuredBounds = bounds ?? unclipped;
      const measurement = measuredBounds && node ? measuredLayout(node, measuredBounds) : undefined;
      // An actual layout/resize event will remeasure a mixed viewport/DOM state.
      // Do not replace Main's last qualified projection with raw stale bounds.
      if (measurement?.kind === 'deferred') return;
      if (measurement?.kind === 'unsupported') bounds = null;
      if (
        bounds &&
        host.watchBrowserLayoutFrame &&
        (bounds.width < nativeBrowserWitnessWidth(window.devicePixelRatio || 1) ||
          bounds.height < 2 + nativeBrowserWitnessTileSize(window.devicePixelRatio || 1))
      )
        bounds = null;
      const layout = bounds && measurement?.kind === 'measured' ? measurement.layout : undefined;
      const key = JSON.stringify([bounds, layout, presentationScope, draft]);
      return { bounds, layout, key };
    };
    const presentationCurrent = (
      input: Extract<NativeBrowserRequest, { action: 'present' }> | undefined,
    ) => {
      const current = presentationIdentity.current;
      if (
        stopped ||
        startupEpoch.current !== presentationEpoch ||
        !input?.bounds ||
        input.presentationRevision !== revision ||
        !visible ||
        !external ||
        blocked ||
        !current.visible ||
        !current.external ||
        current.blocked ||
        current.id !== id ||
        current.host !== host ||
        originalNode !== viewport.current ||
        !originalNode?.isConnected ||
        originalNode.ownerDocument !== originalDocument ||
        JSON.stringify(current.presentationScope) !== JSON.stringify(presentationScope) ||
        current.draft !== draft
      )
        return false;
      const measured = measure();
      return (
        !!measured?.bounds &&
        JSON.stringify([input.bounds, input.layout, input.scope, input.draft]) ===
          JSON.stringify([measured.bounds, measured.layout, presentationScope, draft])
      );
    };
    const completePresentation = (
      input: Extract<NativeBrowserRequest, { action: 'present' }> | undefined,
    ) => {
      if (!presentationCurrent(input)) return;
      hideWitness();
      awaitingPresentationRef.current = false;
      previouslyPresentedOwner.current = displayOwner;
      setPresentedOwner(displayOwner);
    };
    const publish = () => {
      frame = undefined;
      if (stopped) return;
      const display = host.browserDisplayIntent?.();
      if (display && viewport.current?.closest('[data-animate-width="true"]')) {
        recoveryAnimating = true;
        return;
      }
      if (
        display &&
        !external &&
        !blocked &&
        visible &&
        display.id === id &&
        display.storeId === presentationScope?.storeId &&
        display.sessionId === presentationScope.sessionId
      )
        return;
      const measured = measure();
      if (!measured) {
        // Deferred geometry before the real reveal is remeasured by observers.
        // Once the known reveal animation ends, it must converge or cancel.
        if (display && recoveryAnimating) host.cancelBrowserDisplay?.();
        return;
      }
      const { bounds, layout, key } = measured;
      if ((!pending && key === last) || key === pending) return;
      if (bounds && layout && chromeHostedRef.current && asyncLayout) {
        // Keep one calibration in flight. Its completion remeasures the live
        // DOM, rather than dispatching a queue of obsolete window rectangles.
        asyncLayoutDirty = true;
        return;
      }
      const asyncCalibration =
        bounds &&
        layout &&
        (chromeHostedRef.current || (draft && !awaitingPresentationRef.current)) &&
        host.presentBrowserLayoutAsync &&
        committedLayout;
      const sent = ++sequence;
      pending = key;
      const input = {
        action: 'present' as const,
        id,
        bounds,
        presentationRevision: revision,
        ...(layout ? { layout } : {}),
        ...(presentationScope ? { scope: presentationScope } : {}),
        ...(draft ? { draft } : {}),
        ...(!asyncCalibration &&
        bounds &&
        layout &&
        host.watchBrowserLayoutFrame &&
        bounds.width >= nativeBrowserWitnessWidth(window.devicePixelRatio || 1) &&
        bounds.height >= 2 + nativeBrowserWitnessTileSize(window.devicePixelRatio || 1)
          ? {
              witness: {
                key: crypto.randomUUID().replaceAll('-', '').slice(0, 24),
                step: 1 as const,
              },
            }
          : {}),
      };
      if (display) {
        if (
          !bounds ||
          !layout ||
          !presentationScope ||
          display.id !== id ||
          !host.claimBrowserDisplay
        )
          host.cancelBrowserDisplay?.();
        else host.claimBrowserDisplay(input);
      }
      if (!bounds) {
        drawn = undefined;
        hideWitness();
        if (frozenViewport.current) frozenViewport.current.hidden = true;
        freeze({ waiting: false });
        frozenViewport.current?.removeAttribute('src');
        frozenFrames.clear();
        displayedKey = undefined;
        requestedFrozen = undefined;
      }
      const committed = () => {
        if (stopped || sent !== sequence) return;
        last = key;
        pending = '';
        committedLayout = !!layout;
      };
      const rejected = () => {
        if (!stopped && sent === sequence) {
          pending = '';
          hideWitness();
          rejectedDraw = drawn;
          drawn = undefined;
        }
      };
      // Main already owns native window projection and invalidates old input.
      // Do not block Root painting on Main's AppKit live-resize callback. The
      // asynchronous port admits calibration only for the still-hosted page.
      // Bootstrap and fallback stay synchronous. Once hosted, even returning to
      // a previous size or changing a splitter must not re-enter sendSync while
      // Main may still be inside a native resize/compositor transaction.
      if (asyncCalibration) {
        if (!presentationScope && !draft) {
          rejected();
          return;
        }
        asyncLayout = true;
        try {
          if (input.witness) draw(input);
          void host.presentBrowserLayoutAsync!(input)
            .then((value) => {
              if (stopped || sent !== sequence) return;
              freeze(value, input);
              committed();
            }, rejected)
            .catch(rejected)
            .finally(() => {
              asyncLayout = false;
              if (asyncLayoutDirty && !stopped) {
                asyncLayoutDirty = false;
                publish();
              }
            });
        } catch {
          asyncLayout = false;
          rejected();
        }
      } else if (bounds && layout && host.presentBrowserLayout) {
        if (!presentationScope && !draft) {
          rejected();
          return;
        }
        try {
          if (input.witness) draw(input);
          freeze(host.presentBrowserLayout(input), input);
          committed();
        } catch {
          rejected();
        }
      } else
        void host.browserRequest!(input).then((value) => {
          if (value?.id === id && input.bounds) completePresentation(input);
          committed();
        }, rejected);
    };
    const schedule = () => {
      if (stopped) return;
      if (frame === undefined) frame = requestAnimationFrame(publish);
    };
    const force = () => {
      last = '';
      schedule();
    };
    const visibilityChanged = () => {
      if (
        stopped ||
        document !== originalDocument ||
        displayIdentity.current.token !== displayOwner
      )
        return;
      if (document.hidden) {
        force();
        return;
      }
      if (host.watchBrowserPresentation && chromeHostedRef.current) return;
      // Main withdraws the live Page when the window hides. Returning is a
      // fresh presentation, not calibration of the former active native view.
      restartPresentation();
    };
    const invalidateSize = () => {
      last = '';
      if (host.presentBrowserLayout) publish();
      else schedule();
    };
    let resize: ResizeObserver | undefined;
    let mutations: MutationObserver | undefined;
    let reobserving = false;
    const retire = (reobserve = false) => {
      stopped = true;
      reobserving = reobserve;
    };
    retirePresentation.current = retire;
    const cleanup = (retain: boolean) => {
      let qualified = false;
      let measuredPositive = false;
      try {
        const current = presentationIdentity.current;
        const measured =
          retain &&
          originalNode &&
          originalNode === viewport.current &&
          originalNode.isConnected &&
          document === originalDocument &&
          originalNode.ownerDocument === originalDocument &&
          current.id === id &&
          current.host === host &&
          current.visible === visible &&
          current.external === external &&
          current.blocked === blocked &&
          JSON.stringify(current.presentationScope) === JSON.stringify(presentationScope) &&
          current.draft === draft
            ? measure()
            : undefined;
        measuredPositive = !!measured?.bounds;
        qualified = measuredPositive && !pending && measured?.key === last;
        const display = host.browserDisplayIntent?.();
        // The first passive state read has not observed this retained page yet.
        // A real unmount, identity change, hide or error still cancels it below.
        if (
          retain &&
          !external &&
          display?.id === id &&
          originalNode === viewport.current &&
          originalNode?.isConnected &&
          originalNode.ownerDocument === originalDocument &&
          document === originalDocument &&
          current.id === id &&
          current.host === host &&
          current.visible &&
          !current.blocked &&
          JSON.stringify(current.presentationScope) === JSON.stringify(presentationScope) &&
          current.draft === draft &&
          display.storeId === presentationScope?.storeId &&
          display.sessionId === presentationScope.sessionId
        )
          qualified = true;
      } catch {}
      stopped = true;
      if (retirePresentation.current === retire) retirePresentation.current = undefined;
      let failure: { cause: unknown } | undefined;
      const stop = (dispose: () => void) => {
        try {
          dispose();
        } catch (cause) {
          failure ??= { cause };
          qualified = false;
        }
      };
      stop(() => unwatchFrame?.());
      drawn = undefined;
      stop(() => {
        hideWitness();
        if (frozenViewport.current) frozenViewport.current.hidden = true;
        freeze({ waiting: false });
        frozenViewport.current?.removeAttribute('src');
      });
      frozenFrames.clear();
      displayedKey = undefined;
      requestedFrozen = undefined;
      stop(() => {
        if (frame !== undefined) cancelAnimationFrame(frame);
      });
      stop(() => resize?.disconnect());
      stop(() => mutations?.disconnect());
      stop(() => window.removeEventListener('resize', invalidateSize));
      stop(() => window.removeEventListener('scroll', schedule, true));
      stop(() => document.removeEventListener('visibilitychange', visibilityChanged));
      // Repeated effects can leave the exact same connected viewport in place.
      // Retain only its last positive measurement; every uncertain boundary hides.
      const current = presentationIdentity.current;
      const preparedHandoff =
        reobserving &&
        measuredPositive &&
        !failure &&
        originalNode === viewport.current &&
        originalNode?.isConnected &&
        document === originalDocument &&
        !document.hidden &&
        current.id === id &&
        current.host === host &&
        current.visible &&
        !current.blocked &&
        current.external === external &&
        current.draft === draft &&
        JSON.stringify(current.presentationScope) === JSON.stringify(presentationScope) &&
        displayIdentity.current.token === displayOwner;
      // Main already retired the prior proof before asking this exact owner to
      // observe again. Its prepared native cover belongs to the successor.
      if (!qualified && !preparedHandoff) hide(revision);
      if (failure) throw failure.cause;
    };
    try {
      unwatchFrame = host.watchBrowserLayoutFrame?.(receiveFrame);
      resize =
        typeof ResizeObserver === 'undefined'
          ? undefined
          : new ResizeObserver(() => {
              if (host.presentBrowserLayout) publish();
              else schedule();
            });
      if (originalNode) {
        resize?.observe(originalNode);
        for (let ancestor = originalNode.parentElement; ancestor; ancestor = ancestor.parentElement)
          resize?.observe(ancestor);
      }
      mutations = new MutationObserver((records) => {
        // Our proof/fallback pixels are outputs, not new layout observations.
        // In particular, retiring a rejected proof must not retry itself.
        if (
          records.some(
            (record) =>
              record.target !== layoutWitness.current && record.target !== frozenViewport.current,
          )
        )
          schedule();
      });
      mutations.observe(originalDocument.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [
          'style',
          'data-native-browser-layout',
          'data-animate-width',
          'data-state',
          'aria-hidden',
          'hidden',
          'inert',
        ],
      });
      window.addEventListener('resize', invalidateSize);
      window.addEventListener('scroll', schedule, true);
      // Hosted views use Main's request. Other platforms/legacy presenters
      // still need the same restart entry when no native Chrome owns the page.
      document.addEventListener('visibilitychange', visibilityChanged);
      publish();
    } catch (cause) {
      try {
        cleanup(false);
      } catch {}
      throw cause;
    }
    return () => cleanup(true);
  }, [
    id,
    host,
    visible,
    external,
    blocked,
    presentationScope,
    draft,
    displayOwner,
    presentationEpoch,
    restartPresentation,
    hideWitness,
  ]);
  const error =
    issue ||
    menuIssue ||
    (state.error === 'process_gone' && state.control?.phase === 'unknown'
      ? '浏览页面已停止，控制权尚未确认，请先停止原浏览器任务。'
      : state.error && errors[state.error]);
  const canNavigate = !state.control || ['human', 'armed'].includes(state.control.phase);
  const showOptions = useNativeBrowserPopup({
    identity: `${identity}:${state.loading}:${state.canGoBack}:${state.canGoForward}:${error}`,
    hostKey: chromeHosted ? 'chrome' : 'root',
    visible,
    scope,
    draft,
    page: state,
    items: state.url
      ? [
          { action: 'back', enabled: canNavigate && state.canGoBack },
          { action: 'forward', enabled: canNavigate && state.canGoForward },
          { action: state.loading ? 'stop' : 'reload', enabled: canNavigate },
        ]
      : [],
    details: [error, !canNavigate ? '页面由 Agent 控制，接管后可手动导航。' : undefined].filter(
      (value): value is string => !!value,
    ),
    onAction(action) {
      if (['back', 'forward', 'reload', 'stop'].includes(action))
        void request({ action: action as 'back' | 'forward' | 'reload' | 'stop', id });
    },
    onError(cause) {
      setMenuIssue(
        cause instanceof Error && cause.message === 'browser_menu_state_changed'
          ? '状态已变化，原操作未发送，请核对后重试。'
          : '页面选项暂不可用，请重试。',
      );
    },
  });
  const notesAvailable = !!annotate && !!state.control?.browserId;
  const data = useMemo<NativeBrowserToolbarPresentation>(
    () => ({
      id,
      address,
      readonlyURL: state.url,
      loading: state.loading,
      hasPage: !!state.url,
      canGoBack: state.canGoBack,
      canGoForward: state.canGoForward,
      canNavigate,
      error,
      notesAvailable,
      notesOpen,
      optionsAvailable: !!state.url || !!error,
    }),
    [
      id,
      address,
      state.url,
      state.loading,
      state.canGoBack,
      state.canGoForward,
      canNavigate,
      error,
      notesAvailable,
      notesOpen,
    ],
  );
  const handleToolbarAction = (action: NativeBrowserToolbarAction) => {
    switch (action.type) {
      case 'address-change':
        if (canNavigate && action.value.length <= 2048) setAddress(action.value);
        return;
      case 'address-focus':
        focused.current = action.focused && canNavigate;
        if (!focused.current) setAddress(state.url);
        return;
      case 'navigate':
        if (canNavigate) void request({ action: 'navigate', id, input: address });
        return;
      case 'back':
        if (canNavigate && state.canGoBack) void request({ action: 'back', id });
        return;
      case 'forward':
        if (canNavigate && state.canGoForward) void request({ action: 'forward', id });
        return;
      case 'reload':
        if (canNavigate && state.url)
          void request({ action: state.loading ? 'stop' : 'reload', id });
        return;
      case 'toggle-notes':
        if (notesAvailable) setNotesOpen((open) => !open);
        return;
      case 'show-options':
        if (data.optionsAvailable) {
          setMenuIssue(undefined);
          showOptions(action.anchor);
        }
    }
  };
  const chrome = useRef({
    id,
    scopeKey: chromeOwnerKey,
    visible,
    chromeHosted,
    handleToolbarAction,
  });
  chrome.current = { id, scopeKey: chromeOwnerKey, visible, chromeHosted, handleToolbarAction };
  const dispatch = useCallback(
    (action: NativeBrowserToolbarAction) => {
      const current = chrome.current;
      if (
        mounted.current &&
        current.id === id &&
        current.scopeKey === chromeOwnerKey &&
        hasChromeOwner &&
        current.visible &&
        current.chromeHosted
      )
        current.handleToolbarAction(action);
    },
    [id, chromeOwnerKey, hasChromeOwner],
  );
  const port = useMemo(() => ({ data, dispatch }), [data, dispatch]);
  useLayoutEffect(() => {
    // SessionTabs retains inactive pages. Keep their ports available so its
    // next committed selection can offer that exact page before passive hides.
    onChromePresentation?.(hasChromeOwner ? port : undefined);
  }, [onChromePresentation, port, hasChromeOwner]);
  useLayoutEffect(() => {
    if (hasChromeOwner && chromeOwnerKey) return () => onChromePresentation?.(undefined);
    return undefined;
  }, [onChromePresentation, hasChromeOwner, chromeOwnerKey]);
  const previousChrome = useRef({ scopeKey, draft, chromeHosted });
  useEffect(() => {
    const scopeChanged =
      previousChrome.current.scopeKey !== scopeKey || previousChrome.current.draft !== draft;
    if (scopeChanged) {
      focused.current = false;
      setAddress(state.url);
    }
    if ((previousChrome.current.chromeHosted && !chromeHosted) || !visible) focused.current = false;
    if (scopeChanged || chromeHosted || !visible) {
      const active = document.activeElement;
      if (active instanceof HTMLElement && toolbar.current?.contains(active)) active.blur();
    }
    previousChrome.current = { scopeKey, draft, chromeHosted };
  }, [chromeHosted, scopeKey, draft, visible, state.url]);
  return (
    <section className="native-browser-page" aria-label="浏览器">
      <div
        ref={toolbar}
        inert={chromeHosted || undefined}
        aria-hidden={chromeHosted || undefined}
        style={{
          flexShrink: 0,
          ...(chromeHosted ? { visibility: 'hidden', pointerEvents: 'none' } : {}),
        }}
      >
        <NativeBrowserChromeToolbar
          data={data}
          dispatch={handleToolbarAction}
          tools={state.control?.browserId ? controlTools?.(state) : undefined}
          annotationTools={
            <span
              className="native-browser-annotation-tools"
              ref={setAnnotationToolbarHost}
              hidden={!notesOpen}
            />
          }
        />
      </div>
      <div className="native-browser-surface">
        {(!state.url || awaitingPresentation) && (
          <section
            className="native-browser-start"
            aria-label={state.url || initialHint?.url ? '网页加载' : '浏览器起始页'}
          >
            {state.url || initialHint?.url || previouslyPresentedOwner.current === displayOwner
              ? !blocked && (
                  <div className="native-browser-loading">
                    <Spinner aria-label="网页加载中" className="size-5" />
                  </div>
                )
              : tools}
          </section>
        )}
        {annotate && state.control?.browserId && (
          <section
            data-native-browser-overlay
            className="native-browser-annotations"
            hidden={!notesOpen || !visible}
            aria-label="网页快照注释"
          >
            {annotate(state, notesOpen && visible, annotationToolbarHost)}
          </section>
        )}
        <section
          className="native-browser-viewport"
          ref={viewport}
          aria-label="网页内容"
          aria-busy={state.loading || (external && awaitingPresentation && !blocked)}
          style={{ position: 'relative' }}
        >
          <img
            ref={frozenViewport}
            hidden
            alt=""
            aria-hidden="true"
            style={{
              position: 'absolute',
              inset: 0,
              pointerEvents: 'auto',
            }}
          />
          <canvas
            ref={layoutWitness}
            width={120}
            height={3}
            hidden
            tabIndex={-1}
            aria-hidden="true"
            style={{
              position: 'absolute',
              pointerEvents: 'none',
              width: 120,
              height: 3,
              zIndex: 2,
            }}
          />
        </section>
      </div>
    </section>
  );
}
