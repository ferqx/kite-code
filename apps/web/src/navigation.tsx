import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

const minimum = 200;
const maximum = 420;
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

/** Local layout only; it has no Client, Session or execution authority. */
export function useNavigation(browser: Window, suspended: boolean) {
  const [width, setWidth] = useState(() => savedWidth(browser));
  const [narrow, setNarrow] = useState(() => narrowWindow(browser));
  const currentNarrow = useRef(narrow);
  const [open, setOpen] = useState(() => !narrowWindow(browser));
  const [dragging, setDragging] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
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
      if (currentNarrow.current !== next) {
        drag.current?.();
        currentNarrow.current = next;
        setNarrow(next);
        setOpen(!next);
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
  useEffect(() => {
    if (suspended || !narrow || !open) return;
    const closeOverlayOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      close();
    };
    browser.addEventListener('keydown', closeOverlayOnEscape);
    return () => browser.removeEventListener('keydown', closeOverlayOnEscape);
  }, [browser, narrow, open, suspended, close]);
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
      setWidth(original);
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
        latest = Math.round(Math.max(minimum, Math.min(maximum, requested)));
        setWidth(latest);
      }
    };
    const end = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      move(next);
      remove();
      if (folded) {
        setWidth(original);
        close();
      } else remember(latest);
    };
    drag.current = cancel;
    browser.addEventListener('pointermove', move);
    browser.addEventListener('pointerup', end);
    browser.addEventListener('pointercancel', pointerCancel);
  }
  return {
    width,
    narrow,
    open,
    dragging,
    toggle,
    close,
    toggleOpen() {
      if (!suspended) {
        drag.current?.();
        setOpen((prior) => !prior);
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
            ? maximum
            : event.key === 'ArrowLeft'
              ? width - 10
              : event.key === 'ArrowRight'
                ? width + 10
                : undefined;
      if (next !== undefined) {
        event.preventDefault();
        const bounded = Math.max(minimum, Math.min(maximum, next));
        setWidth(bounded);
        remember(bounded);
      }
    },
  };
}
export const navigationCSS = `.web-layout[data-navigation]{position:relative}.web-navigation[hidden]{display:none}.web-navigation{min-width:0}.navigation-resize{margin:0;cursor:col-resize;touch-action:none;background:transparent;border:0;border-radius:0;padding:0}.navigation-resize:hover,.navigation-resize:focus-visible{background:#8886;outline:2px solid currentColor;outline-offset:-2px}.web-layout[data-dragging=true]{user-select:none}.web-layout[data-navigation=narrow]>.web-navigation{position:absolute;inset:0 auto 0 0;width:min(420px,100%);z-index:10;background:inherit;border-right:1px solid #8886}.web-page[data-theme=dark] .web-navigation{background:#181a20}.web-page[data-theme=light] .web-navigation{background:#fafafa}`;
