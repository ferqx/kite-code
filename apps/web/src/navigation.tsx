import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

const minimum = 200;
const maximum = 420;
const conversationMinimum = 360;
export const separatorWidth = 8;
const preferenceKey = 'kite.web.navigationWidth.v1';
function savedWidth(browser: Window) {
  try {
    const value = browser.localStorage.getItem(preferenceKey);
    if (value?.length === 3 && /^[0-9]{3}$/.test(value)) {
      const width = Number(value);
      if (width >= minimum && width <= maximum) return width;
    }
  } catch {
    /* Local preference availability cannot block the page. */
  }
  return minimum;
}
function narrowWindow(browser: Window) {
  return browser.innerWidth <= 640;
}
function widthLimit(browser: Window) {
  const available = browser.document.documentElement.clientWidth || browser.innerWidth;
  return Math.max(minimum, Math.min(maximum, available - separatorWidth - conversationMinimum));
}

/** Local layout only; it has no Client, Session or execution authority. */
export function useNavigation(browser: Window, suspended: boolean) {
  const [preferredWidth, setWidth] = useState(() => savedWidth(browser));
  const [limit, setLimit] = useState(() => widthLimit(browser));
  const width = Math.min(preferredWidth, limit);
  const [narrow, setNarrow] = useState(() => narrowWindow(browser));
  const currentNarrow = useRef(narrow);
  const [open, setOpen] = useState(() => !narrowWindow(browser));
  const [dragging, setDragging] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const separator = useRef<HTMLHRElement>(null);
  const drag = useRef<(() => void) | undefined>(undefined);
  const remember = (next: number) => {
    try {
      browser.localStorage.setItem(preferenceKey, String(next));
    } catch {
      /* Keep local resize. */
    }
  };
  const close = useCallback(() => {
    setOpen(false);
    toggle.current?.focus();
  }, []);
  useEffect(() => {
    const resize = () => {
      const next = narrowWindow(browser);
      setLimit(widthLimit(browser));
      if (currentNarrow.current !== next) {
        drag.current?.();
        currentNarrow.current = next;
        setNarrow(next);
        setOpen(!next);
        const focused = browser.document.activeElement;
        if (next && (panel.current?.contains(focused) || focused === separator.current))
          toggle.current?.focus();
      }
    };
    const stop = () => drag.current?.();
    const visibility = () => {
      if (browser.document.visibilityState === 'hidden') stop();
    };
    browser.addEventListener('resize', resize);
    browser.addEventListener('blur', stop);
    browser.document.addEventListener('visibilitychange', visibility);
    return () => {
      stop();
      browser.removeEventListener('resize', resize);
      browser.removeEventListener('blur', stop);
      browser.document.removeEventListener('visibilitychange', visibility);
    };
  }, [browser]);
  useEffect(() => {
    if (suspended) drag.current?.();
  }, [suspended]);
  const overlayOpen = narrow && open;
  useLayoutEffect(() => {
    if (overlayOpen && !suspended) panel.current?.focus();
  }, [overlayOpen, suspended]);
  useEffect(() => {
    if (suspended || !overlayOpen) return;
    const closeOverlayOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      close();
    };
    browser.addEventListener('keydown', closeOverlayOnEscape);
    return () => browser.removeEventListener('keydown', closeOverlayOnEscape);
  }, [browser, overlayOpen, suspended, close]);
  function start(event: ReactPointerEvent) {
    if (suspended || narrow || event.button !== 0 || !Number.isFinite(event.clientX)) return;
    drag.current?.();
    event.preventDefault();
    const pointerId = event.pointerId,
      x = event.clientX,
      original = width;
    let latest = original,
      folded = false;
    setDragging(true);
    const remove = () => {
      browser.removeEventListener('pointermove', move);
      browser.removeEventListener('pointerup', end);
      browser.removeEventListener('pointercancel', pointerCancel);
      drag.current = undefined;
      setDragging(false);
    };
    const cancel = () => {
      remove();
      setWidth(preferredWidth);
      setOpen(true);
    };
    const pointerCancel = (next: PointerEvent) => {
      if (next.pointerId === pointerId) cancel();
    };
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointerId || !Number.isFinite(next.clientX)) return;
      const requested = original + next.clientX - x;
      folded = requested < minimum / 2;
      setOpen(!folded);
      if (!folded) {
        latest = Math.round(Math.max(minimum, Math.min(widthLimit(browser), requested)));
        setWidth(latest);
      }
    };
    const end = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      move(next);
      remove();
      if (folded) {
        setWidth(preferredWidth);
        close();
      } else if (latest === original) setWidth(preferredWidth);
      else remember(latest);
    };
    drag.current = cancel;
    browser.addEventListener('pointermove', move);
    browser.addEventListener('pointerup', end);
    browser.addEventListener('pointercancel', pointerCancel);
  }
  return {
    width,
    limit,
    narrow,
    open,
    overlayOpen,
    dragging,
    toggle,
    panel,
    separator,
    close,
    toggleOpen() {
      if (!suspended) {
        drag.current?.();
        if (open) close();
        else setOpen(true);
      }
    },
    onPointerDown: start,
    onKeyDown(event: React.KeyboardEvent) {
      if (suspended) return;
      if (event.key === 'Enter' || event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      const next =
        event.key === 'Home'
          ? minimum
          : event.key === 'End'
            ? limit
            : event.key === 'ArrowLeft'
              ? width - 10
              : event.key === 'ArrowRight'
                ? width + 10
                : undefined;
      if (next !== undefined) {
        event.preventDefault();
        const bounded = Math.max(minimum, Math.min(limit, next));
        if (bounded === width) return;
        setWidth(bounded);
        remember(bounded);
      }
    },
  };
}
export const navigationCSS = `.web-layout[data-navigation]{position:relative}.web-navigation[hidden]{display:none}.web-navigation{min-width:0}.navigation-resize{margin:0;cursor:col-resize;touch-action:none;background:transparent;border:0;border-radius:0;padding:0}.navigation-resize:hover,.navigation-resize:focus-visible{background:#8886;outline:2px solid currentColor;outline-offset:-2px}.web-layout[data-dragging=true]{user-select:none}.web-layout[data-navigation=narrow]>.web-navigation{position:absolute;inset:0 auto 0 0;width:min(420px,100%);z-index:10;background:inherit;border-right:1px solid #8886}.web-page[data-theme=dark] .web-navigation{background:#181a20}.web-page[data-theme=light] .web-navigation{background:#fafafa}`;
