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
  NativeBrowserFrame,
  NativeBrowserGroupLayout,
  NativeBrowserLayout,
  NativeBrowserPanelLayout,
  NativeBrowserRequest,
  NativeBrowserRestoreScope,
  NativeBrowserState,
} from './native-browser-bridge';
import { projectNativeBrowserBounds } from './native-browser-bridge';
import { rememberNativeBrowserState } from './native-browser-display-state';
import { NativeBrowserError } from './native-browser-error';
import { useNativeBrowserPopup } from './native-browser-menu';
import { NativeBrowserToolbar } from './native-browser-toolbar';
import type {
  NativeBrowserToolbarAction,
  NativeBrowserToolbarPresentation,
} from './native-browser-toolbar-types';

const presentationRevisionKey = Symbol.for('kite.native.browser.presentationRevision');
// Sibling layout effects run in tree order. Retire a deselected page at the
// end of this commit, so the newly selected page can replace it in Main first.
// A successful positive commit already withdraws every other Main binding.
const pendingWithdrawals = new WeakMap<Document, Set<() => void>>();
const committedLayout = new WeakMap<Document, { host: object; id: string; token?: string }>();
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
      const nativeContent = !parent ? group.closest('.native-window-content') : null;
      const top = nativeContent?.getBoundingClientRect().top ?? 0;
      const parentBox = parent?.getBoundingClientRect() ?? new DOMRect(0, top, width, height - top);
      let expected = parentBox;
      const frame: HTMLElement | null = group.parentElement;
      const frameStyle =
        parent &&
        frame?.classList.contains('client-content-frame') &&
        frame.parentElement?.closest('[data-panel]') === parent
          ? getComputedStyle(frame)
          : !parent && nativeContent
            ? getComputedStyle(nativeContent)
            : undefined;
      if (frameStyle) {
        const [left, right, top, bottom] = (
          parent
            ? [
                frameStyle.marginLeft,
                frameStyle.marginRight,
                frameStyle.marginTop,
                frameStyle.marginBottom,
              ]
            : [
                frameStyle.paddingLeft,
                frameStyle.paddingRight,
                frameStyle.paddingTop,
                frameStyle.paddingBottom,
              ]
        ).map((value) => Number.parseFloat(value) || 0);
        expected = new DOMRect(
          parentBox.left + left!,
          parentBox.top + top!,
          parentBox.width - left! - right!,
          parentBox.height - top! - bottom!,
        );
      }
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
      // Root fills the native content box inside the shell padding; the nested
      // Group fills its content frame, including any material margins. Compare
      // against CSS policy, so old DOM sizes cannot masquerade as new gutters.
      if (
        !fills(box, expected) ||
        (nativeContent && !fills(nativeContent.getBoundingClientRect(), parentBox)) ||
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
        left: Math.max(0, box.left - parentBox.left),
        right: Math.max(0, parentBox.right - box.right),
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
      ...(() => {
        if (document.documentElement.dataset.platform !== 'windows') return {};
        const sidebar = leaf.querySelector<HTMLElement>('.right-sidebar');
        const separator = leaf.previousElementSibling;
        const grip = separator?.querySelector<HTMLElement>('.resizable-grip');
        if (!sidebar || !grip || !fills(sidebar.getBoundingClientRect(), box)) return {};
        const color = (value: string, opacity = 1): NativeBrowserFrame['color'] | undefined => {
          const match = /^rgba?\(([^)]+)\)$/.exec(value);
          const channels = match?.[1]
            ?.split(/[,\s/]+/)
            .filter(Boolean)
            .map(Number);
          if (!channels || ![3, 4].includes(channels.length) || !channels.every(Number.isFinite))
            return;
          const [r, g, b, a = 1] = channels;
          if ([r!, g!, b!].some((value) => value < 0 || value > 255) || a < 0 || a > 1) return;
          return [r!, g!, b!, a * opacity];
        };
        const style = getComputedStyle(sidebar),
          gripStyle = getComputedStyle(grip),
          border = Number.parseFloat(style.borderLeftWidth),
          borderColor = color(style.borderLeftColor),
          gripColor = color(gripStyle.backgroundColor, 0.55),
          gripBox = grip.getBoundingClientRect();
        if (!borderColor || !gripColor || border < 0 || border > 4) return {};
        const frame: NativeBrowserFrame = {
          top: Math.max(0, box.top),
          bottom: Math.max(0, height - box.bottom),
          width: border,
          color: borderColor,
          grip: {
            left: gripBox.left - box.left,
            width: gripBox.width,
            height: gripBox.height,
            color: gripColor,
            // A generic native View participates in hit testing. Paint the grip
            // only once the real DOM separator has captured this drag; idle
            // hover/focus keeps the original interactive DOM grip.
            visible: separator?.getAttribute('data-separator') === 'active',
          },
        };
        return { frame };
      })(),
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
  unsupported_navigation: '暂不支持打开这种地址，请使用 HTTP 或 HTTPS 网址。',
  download_unsupported: '简易浏览器暂不支持下载文件。',
  process_gone: '浏览页面已停止，请刷新后重试。',
};
function requestError(cause: unknown): string | undefined {
  const code = cause instanceof Error ? cause.message : '';
  if (code === 'unsupported_browser_protocol') return errors.unsupported_navigation;
  if (code === 'invalid_browser_address') return '请输入有效的网址或搜索内容。';
  if (code === 'browser_page_control_required') return 'Agent 正在控制此页，请先明确暂停并接管。';
  if (code === 'browser_page_scope_denied') return;
  if (code === 'browser_page_grant_denied' || code === 'browser_session_page_already_bound')
    return '已有页面正在接管或保留控制，请先核对原任务。';
  if (code === 'browser_tab_limit') return '最多打开8个浏览标签页，请先关闭一些标签。';
  if (code === 'browser_presentation_unavailable')
    return '网页显示尚未确认。请检查当前页面状态；你可以停止加载或重新输入地址。';
  return '浏览器暂不可用，请完全退出并重新启动应用后重试。';
}

function visibleElement(node: HTMLElement) {
  if (!node.isConnected || node.closest('[hidden]')) return false;
  for (let element: HTMLElement | null = node; element; element = element.parentElement) {
    const style = getComputedStyle(element);
    if (
      style.display === 'none' ||
      ['hidden', 'collapse'].includes(style.visibility) ||
      style.opacity === '0'
    )
      return false;
  }
  return true;
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
}: SessionBrowserPageProps & {
  scope?: NativeBrowserRestoreScope;
  draft?: string;
  initialHint?: NativeBrowserState;
  controlTools?: (state: NativeBrowserState) => ReactNode;
  annotate?: (
    state: NativeBrowserState,
    visible: boolean,
    toolbarHost: HTMLElement | null,
  ) => ReactNode;
}) {
  const host = typeof window === 'undefined' ? undefined : window.kiteNative;
  const scopeKey = JSON.stringify(scope);
  const ownerKey = JSON.stringify([id, scope, draft]);
  const presentationScope = useMemo(
    () => (scopeKey ? (JSON.parse(scopeKey) as NativeBrowserRestoreScope) : undefined),
    [scopeKey],
  );
  const identity = useRef({ key: ownerKey, host, token: {} });
  if (identity.current.key !== ownerKey || identity.current.host !== host)
    identity.current = { key: ownerKey, host, token: {} };
  const owner = identity.current.token;
  const blank = (): NativeBrowserState =>
    initialHint?.id === id
      ? initialHint
      : {
          id,
          url: '',
          title: '新标签页',
          loading: false,
          canGoBack: false,
          canGoForward: false,
        };
  const [savedState, setState] = useState(() => ({ owner, value: blank() }));
  const state = savedState.owner === owner ? savedState.value : blank();
  const [address, setAddress] = useState(state.url);
  const [issue, setIssue] = useState<string>();
  const [presentationIssue, setPresentationIssue] = useState<string>();
  const [menuIssue, setMenuIssue] = useState<string>();
  const [notesOpen, setNotesOpen] = useState(false);
  const [annotationToolbarHost, setAnnotationToolbarHost] = useState<HTMLSpanElement | null>(null);
  const mounted = useRef(false);
  const focused = useRef(false);
  const toolbar = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLElement>(null);
  const placement = useRef<{ owner: object; commit(key: string): void } | undefined>(undefined);
  const annotating = notesOpen && !!annotate && !!state.control?.browserId;
  const current = useRef({ owner, visible, state, annotating });
  current.current = { owner, visible, state, annotating };
  const stateSequence = useRef(0);
  const apply = useCallback(
    (next: NativeBrowserState | null) => {
      if (!mounted.current || identity.current.token !== owner || next?.id !== id) return;
      stateSequence.current++;
      current.current = { ...current.current, state: next };
      rememberNativeBrowserState(next, presentationScope, draft);
      setState({ owner, value: next });
    },
    [id, owner, presentationScope, draft],
  );
  const previousOwner = useRef(owner);
  useLayoutEffect(() => {
    if (identity.current.token !== owner) return;
    mounted.current = true;
    // Fast Refresh reexecutes effects even for unchanged dependencies. The
    // retained owner keeps its editor and notes; a real target/Host change
    // retires them before the replacement can accept UI actions.
    if (previousOwner.current !== owner) {
      previousOwner.current = owner;
      focused.current = false;
      const active = document.activeElement;
      if (active instanceof HTMLElement && toolbar.current?.contains(active)) active.blur();
      setAddress(current.current.state.url);
      setIssue(undefined);
      setPresentationIssue(undefined);
      setMenuIssue(undefined);
      setNotesOpen(false);
    }
    return () => {
      mounted.current = false;
    };
  }, [owner]);
  useEffect(() => {
    mounted.current = true;
    const unwatch = host?.watchBrowser?.(apply);
    const sequence = stateSequence.current;
    void host
      ?.browserRequest?.({ action: 'state', id, ...(draft ? { draft } : {}) })
      .then((next) => {
        if (stateSequence.current === sequence) apply(next);
      })
      .catch(() => {});
    return () => {
      unwatch?.();
    };
  }, [id, host, draft, apply]);
  useEffect(() => {
    onTitleChange(state.title || '新标签页');
  }, [state.title, onTitleChange]);
  useEffect(() => {
    if (!focused.current) setAddress(state.url);
  }, [state.url]);
  useLayoutEffect(() => {
    if (visible) return;
    focused.current = false;
    const active = document.activeElement;
    if (active instanceof HTMLElement && toolbar.current?.contains(active)) active.blur();
  }, [visible]);

  const external = !!state.url;
  useLayoutEffect(() => {
    const node = viewport.current;
    if (!host?.browserRequest || !node || (!presentationScope && !draft)) return;
    const originalDocument = node.ownerDocument;
    let stopped = false;
    let last = '';
    let hidden = false;
    let initialPlacement = true;
    let pageToken = current.current.state.pageToken;
    let pendingHide: (() => void) | undefined;
    let inFlight: object | undefined;
    let dirty = false;
    let frame: number | undefined;
    const owned = () =>
      !stopped &&
      mounted.current &&
      identity.current.token === owner &&
      viewport.current === node &&
      node.isConnected &&
      node.ownerDocument === originalDocument;
    const input = (bounds: NativeBrowserBounds | null, layout?: NativeBrowserLayout) => ({
      action: 'present' as const,
      id,
      bounds,
      presentationRevision: nextPresentationRevision(draft),
      ...(pageToken ? { pageToken } : {}),
      ...(layout ? { layout } : {}),
      ...(presentationScope ? { scope: presentationScope } : {}),
      ...(draft ? { draft } : {}),
    });
    const hide = (defer = false) => {
      delete node.dataset.nativeBrowserFrame;
      // A withdrawal bypasses the positive calibration queue. Its newer
      // revision retires every earlier asynchronous positive request in Main.
      if (pendingHide) {
        if (!defer) pendingHide();
        return;
      }
      if (hidden) return;
      hidden = true;
      initialPlacement = true;
      inFlight = undefined;
      last = '';
      dirty = false;
      const committed = committedLayout.get(originalDocument);
      if (defer && committed?.host === host && committed.id !== id) return;
      const request = input(null);
      const pending = pendingWithdrawals.get(originalDocument) ?? new Set<() => void>();
      pendingWithdrawals.set(originalDocument, pending);
      const send = () => {
        if (pendingHide !== send) return;
        pendingHide = undefined;
        if (!pending.delete(cancel)) return;
        try {
          if (host.presentBrowserLayout) host.presentBrowserLayout(request);
          else void host.browserRequest!(request).catch(() => {});
          if (
            committedLayout.get(originalDocument) === committed &&
            committed?.id === id &&
            committed.token === request.pageToken
          )
            committedLayout.delete(originalDocument);
        } catch {}
      };
      const cancel = () => {
        pending.delete(cancel);
        if (pendingHide === send) pendingHide = undefined;
      };
      pendingHide = send;
      pending.add(cancel);
      if (defer) queueMicrotask(send);
      else send();
    };
    const measure = () => {
      if (
        !owned() ||
        !current.current.visible ||
        current.current.annotating ||
        !current.current.state.url ||
        !pageToken ||
        current.current.state.error ||
        current.current.state.display === 'failed' ||
        !visibleElement(node)
      )
        return { bounds: null };
      const bounds = clippedViewport(node);
      if (!bounds) return { bounds: null };
      const measured = measuredLayout(node, bounds);
      if (measured.kind === 'deferred') return;
      if (measured.kind === 'unsupported') return { bounds: null };
      return { bounds, layout: measured.kind === 'measured' ? measured.layout : undefined };
    };
    const publish = () => {
      frame = undefined;
      if (!owned()) return;
      const latestToken = current.current.state.pageToken;
      if (pageToken !== latestToken) {
        // Document/visibility replacement invalidates old async work without
        // tearing down the retained layout observer or hiding its successor.
        pageToken = latestToken;
        inFlight = undefined;
        dirty = false;
        last = '';
        hidden = false;
        initialPlacement = true;
      }
      const measured = measure();
      // An actual resize supplies the next coherent DOM measurement. A mixed
      // window/DOM state must not withdraw a still-valid native resize projection.
      if (!measured) return;
      if (!measured.bounds) {
        hide(!current.current.visible && !originalDocument.hidden);
        return;
      }
      const key = JSON.stringify(measured);
      if (!hidden && last === key) return;
      const moving = node.closest(
        '[data-slot="resizable-panel-group"]:is([data-animate-width="true"], :has(> [data-separator="active"]))',
      );
      if ((initialPlacement || moving) && host.presentBrowserLayout) {
        // The original page must occupy this exact viewport before the Root
        // commit paints its newly selected UI, animation or dragged boundary.
        // ResizeObserver runs before paint; waiting for asynchronous calibration
        // here would leave the page one frame behind the sidebar transition.
        // Stable resize calibration remains asynchronous and coalesced.
        inFlight = undefined;
        dirty = false;
        hidden = false;
        try {
          const placed = host.presentBrowserLayout(input(measured.bounds, measured.layout));
          if (placed?.id !== id || placed.pageToken !== pageToken)
            throw Error('browser_page_scope_denied');
          committedLayout.set(originalDocument, { host, id, token: pageToken });
          if (measured.layout?.frame) node.dataset.nativeBrowserFrame = 'true';
          else delete node.dataset.nativeBrowserFrame;
          for (const cancel of pendingWithdrawals.get(originalDocument) ?? []) cancel();
          initialPlacement = false;
          last = key;
          if (owned()) setPresentationIssue(undefined);
        } catch (cause) {
          // Rendering this admission failure is not a new layout proposal.
          // Stale geometry waits for a real notification; other failures remain
          // readable without retrying from their own DOM mutation.
          const stale = cause instanceof Error && cause.message === 'browser_layout_stale';
          last = key;
          if (!stale && owned()) setPresentationIssue(requestError(cause));
        }
        return;
      }
      if (inFlight) {
        dirty = true;
        return;
      }
      hidden = false;
      const request = input(measured.bounds, measured.layout);
      const operation = {};
      inFlight = operation;
      last = key;
      const send = async () => {
        if (host.presentBrowserLayoutAsync) await host.presentBrowserLayoutAsync(request);
        else await host.browserRequest!(request);
      };
      void Promise.resolve()
        .then(send)
        .then(() => {
          if (owned() && inFlight === operation) {
            if (measured.layout?.frame) node.dataset.nativeBrowserFrame = 'true';
            else delete node.dataset.nativeBrowserFrame;
            initialPlacement = false;
            setPresentationIssue(undefined);
          }
        })
        .catch((cause) => {
          if (owned() && inFlight === operation && !hidden) {
            if (
              cause instanceof Error &&
              ['browser_layout_stale', 'browser_page_scope_denied'].includes(cause.message)
            ) {
              const latest = measure();
              if (latest?.bounds && JSON.stringify(latest) !== key) {
                last = '';
                dirty = true;
              }
            } else {
              last = '';
              setPresentationIssue(requestError(cause));
            }
          }
        })
        .finally(() => {
          if (inFlight !== operation) return;
          inFlight = undefined;
          if (dirty && owned()) {
            dirty = false;
            publish();
          }
        });
    };
    const schedule = () => {
      if (!owned()) return;
      // A genuinely hidden viewport must withdraw with the observer notification;
      // positive placement can wait until the DOM's next completed layout.
      const measured = measure();
      if (measured && !measured.bounds) {
        hide(!current.current.visible && !originalDocument.hidden);
        return;
      }
      if (frame === undefined) frame = requestAnimationFrame(publish);
    };
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(publish);
    resize?.observe(node);
    for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement)
      resize?.observe(ancestor);
    const mutations = new MutationObserver(schedule);
    mutations.observe(originalDocument.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        'style',
        'class',
        'data-native-browser-layout',
        'data-state',
        'data-separator',
        'hidden',
      ],
    });
    mutations.observe(originalDocument.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'class'],
    });
    window.addEventListener('resize', publish);
    window.addEventListener('scroll', schedule, true);
    originalDocument.addEventListener('visibilitychange', publish);
    // A layout effect precedes the passive state subscription, so ownership is
    // checked independently here; the node/owner remain the sole layout writer.
    const remeasure = () => {
      last = '';
      publish();
    };
    const unwatchPresentation = host.watchBrowserPresentation?.(remeasure);
    let renderedIntent = '';
    const controller = {
      owner,
      commit(key: string) {
        if (key === renderedIntent) return;
        renderedIntent = key;
        publish();
      },
    };
    placement.current = controller;
    return () => {
      try {
        hide();
      } finally {
        stopped = true;
        if (placement.current === controller) placement.current = undefined;
        unwatchPresentation?.();
        inFlight = undefined;
        resize?.disconnect();
        mutations.disconnect();
        if (frame !== undefined) cancelAnimationFrame(frame);
        window.removeEventListener('resize', publish);
        window.removeEventListener('scroll', schedule, true);
        originalDocument.removeEventListener('visibilitychange', publish);
      }
    };
  }, [id, host, owner, presentationScope, draft]);
  const displayIntent = JSON.stringify([
    visible,
    external,
    state.error,
    state.display === 'failed',
    state.pageToken,
    annotating,
  ]);
  useLayoutEffect(() => {
    if (placement.current?.owner === owner) placement.current.commit(displayIntent);
  }, [owner, displayIntent]);

  const request = async (input: Exclude<NativeBrowserRequest, { action: 'grant' }>) => {
    if (!current.current.visible || current.current.owner !== owner) return;
    setIssue(undefined);
    if (!host?.browserRequest) {
      setIssue(requestError(null));
      return;
    }
    const sequence = stateSequence.current;
    try {
      const next = await host.browserRequest(draft ? { ...input, draft } : input);
      // State events can be newer than an IPC reply from the same document.
      if (stateSequence.current === sequence) apply(next);
    } catch (cause) {
      if (mounted.current && identity.current.token === owner) setIssue(requestError(cause));
    }
  };
  const error =
    issue ||
    presentationIssue ||
    (state.error === 'process_gone' && state.control?.phase === 'unknown'
      ? '浏览页面已停止，控制权尚未确认，请先停止原浏览器任务。'
      : state.error && state.error !== 'load_failed' && errors[state.error]) ||
    (state.display === 'failed' && state.error !== 'load_failed'
      ? '网页显示尚未确认，请刷新或重新输入地址。'
      : undefined);
  const canNavigate = !state.control || ['human', 'armed'].includes(state.control.phase);
  const showOptions = useNativeBrowserPopup({
    identity: JSON.stringify([
      ownerKey,
      state.url,
      state.control,
      state.loading,
      state.canGoBack,
      state.canGoForward,
      error,
    ]),
    hostKey: 'root',
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
    details: [
      error,
      menuIssue,
      !canNavigate ? '页面由 Agent 控制，接管后可手动导航。' : undefined,
    ].filter((value): value is string => !!value),
    onAction(action) {
      if (['back', 'forward', 'reload', 'stop'].includes(action))
        void request({ action: action as 'back' | 'forward' | 'reload' | 'stop', id });
    },
    onError(cause) {
      setMenuIssue(
        cause instanceof Error && cause.message === 'browser_menu_state_changed'
          ? undefined
          : '页面选项暂不可用，请重试。',
      );
    },
  });
  const notesAvailable = !!annotate && !!state.control?.browserId;
  const data: NativeBrowserToolbarPresentation = {
    address,
    loading: state.loading,
    hasPage: !!state.url,
    canGoBack: state.canGoBack,
    canGoForward: state.canGoForward,
    canNavigate,
    error,
    optionsIssue: menuIssue,
    notesAvailable,
    notesOpen,
    optionsAvailable: !!state.url || !!error,
  };
  const handleToolbarAction = (action: NativeBrowserToolbarAction) => {
    if (!visible || identity.current.token !== owner) return;
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
  return (
    <section className="native-browser-page" aria-label="浏览器">
      <div ref={toolbar} style={{ flexShrink: 0 }}>
        <NativeBrowserToolbar
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
        {state.error === 'load_failed' && (
          <NativeBrowserError
            url={state.url}
            failure={state.failure}
            canReload={canNavigate}
            onReload={() => void request({ action: 'reload', id })}
          />
        )}
        {state.error !== 'load_failed' && (!state.url || state.display !== 'ready') && (
          <section
            className="native-browser-start"
            aria-label={state.url || initialHint?.url ? '网页加载' : '浏览器起始页'}
          >
            {state.url || initialHint?.url ? (
              error ? (
                <p role="alert">{error}</p>
              ) : state.display === 'stopped' ? (
                <p role="status">已停止加载</p>
              ) : (
                <div className="native-browser-loading">
                  <Spinner aria-label="网页加载中" className="size-5" />
                </div>
              )
            ) : (
              tools
            )}
          </section>
        )}
        {annotate && state.control?.browserId && (
          <section
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
          aria-busy={state.loading || (external && state.display === 'loading')}
        />
      </div>
    </section>
  );
}
