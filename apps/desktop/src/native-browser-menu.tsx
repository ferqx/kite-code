import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type {
  NativeBrowserMenuAction,
  NativeBrowserMenuRequest,
  NativeBrowserRestoreScope,
} from './native-browser-bridge';
import type { NativeBrowserChromeRect } from './native-browser-chrome-types';

let menuSequence = 0;
/** Native menus remain above WebContentsView and never replace the page pixels. */
export function useNativeBrowserPopup(options: {
  identity: string;
  /** Changing presentation hosts invalidates a pending menu even for the same page. */
  hostKey?: string;
  visible: boolean;
  scope?: NativeBrowserRestoreScope;
  draft?: string;
  page: { id: string; control?: { incarnation: string; navigation: number } };
  items: NativeBrowserMenuRequest['items'];
  details: readonly string[];
  onAction(action: NativeBrowserMenuAction): void;
  onError?(error: unknown): void;
}) {
  const current = useRef(options);
  current.current = options;
  const scopeKey = JSON.stringify([options.scope, options.draft]);
  const pending = useRef<
    { id: string; identity: string; scopeKey?: string; hostKey?: string } | undefined
  >(undefined);
  const cancel = useCallback(() => {
    const old = pending.current;
    pending.current = undefined;
    if (old) window.kiteNative?.cancelBrowserMenu?.(old.id);
  }, []);
  useLayoutEffect(() => {
    if (
      !options.visible ||
      (!options.scope && !options.draft) ||
      pending.current?.identity !== options.identity ||
      pending.current?.scopeKey !== scopeKey ||
      pending.current?.hostKey !== options.hostKey
    )
      cancel();
  }, [
    options.identity,
    options.visible,
    options.hostKey,
    options.scope,
    options.draft,
    scopeKey,
    cancel,
  ]);
  useEffect(() => {
    let escapeHeld = false;
    const consumeEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (!escapeHeld && (!pending.current || event.type === 'keyup')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type === 'keyup') {
        escapeHeld = false;
        return;
      }
      escapeHeld = true;
      cancel();
    };
    const reset = () => {
      escapeHeld = false;
    };
    // Capture precedes SessionPage's global Escape and any page input target.
    window.addEventListener('keydown', consumeEscape, true);
    window.addEventListener('keyup', consumeEscape, true);
    window.addEventListener('blur', reset);
    return () => {
      window.removeEventListener('keydown', consumeEscape, true);
      window.removeEventListener('keyup', consumeEscape, true);
      window.removeEventListener('blur', reset);
      cancel();
    };
  }, [cancel]);
  return useCallback((anchor: HTMLElement | NativeBrowserChromeRect) => {
    const start = current.current,
      host = window.kiteNative;
    if (
      !start.visible ||
      (!start.scope && !start.draft) ||
      (start.scope && start.draft) ||
      pending.current ||
      !host?.showBrowserMenu
    )
      return;
    const rect = 'getBoundingClientRect' in anchor ? anchor.getBoundingClientRect() : anchor;
    if (
      ![rect.x, rect.y, rect.width, rect.height, rect.x + rect.width, rect.y + rect.height].every(
        Number.isFinite,
      ) ||
      rect.width < 0 ||
      rect.height < 0
    ) {
      start.onError?.(Error('browser_menu_invalid_anchor'));
      return;
    }
    const request = {
      id: `browser-menu-${++menuSequence}`,
      identity: start.identity,
      scopeKey: JSON.stringify([start.scope, start.draft]),
      hostKey: start.hostKey,
    };
    pending.current = request;
    void host
      .showBrowserMenu({
        requestId: request.id,
        id: start.page.id,
        ...(start.scope ? { scope: start.scope } : {}),
        ...(start.draft ? { draft: start.draft } : {}),
        ...(start.page.control && !start.draft
          ? {
              incarnation: start.page.control.incarnation,
              navigation: start.page.control.navigation,
            }
          : {}),
        x: Math.max(0, rect.x + rect.width),
        y: Math.max(0, rect.y + rect.height),
        items: start.items,
        details: start.details,
      })
      .then(
        (action) => {
          if (pending.current !== request) return;
          pending.current = undefined;
          const now = current.current;
          if (
            !action ||
            !now.visible ||
            now.identity !== request.identity ||
            now.hostKey !== request.hostKey ||
            JSON.stringify([now.scope, now.draft]) !== request.scopeKey
          )
            return;
          if (now.items.some((item) => item.action === action && item.enabled))
            now.onAction(action);
          else now.onError?.(Error('browser_menu_state_changed'));
        },
        (error) => {
          if (pending.current !== request) return;
          pending.current = undefined;
          if (
            current.current.visible &&
            current.current.identity === request.identity &&
            current.current.hostKey === request.hostKey &&
            JSON.stringify([current.current.scope, current.current.draft]) === request.scopeKey
          )
            current.current.onError?.(error);
        },
      );
  }, []);
}
