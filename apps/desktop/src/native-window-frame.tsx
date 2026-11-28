import { NAVIGATION_MIN_WIDTH } from '@kite-ai/ui/desktop';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { NativeWindowMenuAction, NativeWindowMenuId } from './native-menu-bridge';

const menuShortcuts = [
  { id: 'file', key: 'f' },
  { id: 'edit', key: 'e' },
  { id: 'view', key: 'v' },
  { id: 'help', key: 'h' },
] as const;

export function NativeWindowFrame({
  children,
  showHeader = true,
  applicationEnabled = false,
  onAction,
  navigation,
}: {
  children: ReactNode;
  showHeader?: boolean;
  applicationEnabled?: boolean;
  onAction?: (action: NativeWindowMenuAction) => void;
  navigation?: {
    sidebarHost: (element: HTMLDivElement | null) => void;
    searchHost: (element: HTMLDivElement | null) => void;
    sessionHeaderHost?: (element: HTMLDivElement | null) => void;
    back?: () => void;
    forward?: () => void;
  };
}) {
  const windows = document.documentElement.dataset.platform === 'windows';
  const mac = document.documentElement.dataset.platform === 'macos';
  const bridge = window.kiteNative;
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState('');
  const titlebar = useRef<HTMLDivElement>(null);
  const windowContent = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const actionHandler = useRef({ applicationEnabled, onAction });
  actionHandler.current = { applicationEnabled, onAction };
  const opening = useRef(false);
  const menuClosedAt = useRef(-Infinity);
  const dismissingClick = useRef(false);
  const available = !!bridge?.showWindowMenu;
  const watchWindowMenuAction = bridge?.watchWindowMenuAction;
  const getPageZoomFactor = bridge?.getPageZoomFactor;

  useLayoutEffect(() => {
    const element = titlebar.current;
    const frame = element?.parentElement;
    const content = windowContent.current;
    const header = element?.querySelector('.native-window-session');
    if (!showHeader || !windows || !element || !frame || !content) return;
    let panel: Element | null = null;
    const update = () => {
      const zoom = getPageZoomFactor?.() ?? 1;
      frame.style.setProperty('--native-titlebar-page-zoom', `${zoom}`);
      if (!header) return;
      const currentPanel = content.querySelector('.client-content-frame');
      if (currentPanel !== panel) {
        if (panel) observer?.unobserve(panel);
        if (currentPanel) observer?.observe(currentPanel);
        panel = currentPanel;
      }
      const toolbarLeft = element.getBoundingClientRect().left;
      const contentLeft = (panel?.getBoundingClientRect().left ?? toolbarLeft) - toolbarLeft;
      const sidebar = content.querySelector('#navigation');
      const navigation = sidebar?.getBoundingClientRect();
      const right = navigation ? navigation.right - toolbarLeft : contentLeft;
      // The body can collapse to zero while the titlebar keeps its default navigation space.
      const dividerLeft = navigation
        ? Math.max(right, navigation.left - toolbarLeft + NAVIGATION_MIN_WIDTH)
        : right;
      const dividerWidth = sidebar
        ? Number.parseFloat(getComputedStyle(sidebar).getPropertyValue('--resize-handle-width')) ||
          0
        : 0;
      const headerLeft = header.getBoundingClientRect().left - toolbarLeft;
      const dividerOffset = (dividerLeft - headerLeft) * zoom;
      const titleInset = Math.max(0, (dividerLeft + dividerWidth - headerLeft) * zoom + 16);
      element.style.setProperty('--native-titlebar-border-left', `${contentLeft * zoom}px`);
      element.style.setProperty('--native-titlebar-divider-offset', `${dividerOffset}px`);
      element.style.setProperty(
        '--native-titlebar-divider-width',
        `${Math.max(0, dividerWidth * zoom)}px`,
      );
      element.style.setProperty('--native-titlebar-heading-inset', `${titleInset}px`);
    };
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update);
    if (header) observer?.observe(header);
    observer?.observe(content);
    update();
    window.addEventListener('resize', update);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [getPageZoomFactor, showHeader, windows]);

  useEffect(() => {
    if (!windows) return;
    return watchWindowMenuAction?.((action) => {
      const handler = actionHandler.current;
      if (handler.applicationEnabled) handler.onAction?.(action);
    });
  }, [watchWindowMenuAction, windows]);

  async function openMenu(menu: NativeWindowMenuId = 'application') {
    const button = menuButton.current;
    if (!button || !bridge?.showWindowMenu || opening.current) return;
    const bounds = button.getBoundingClientRect();
    opening.current = true;
    setExpanded(true);
    setError('');
    // Native edit roles must keep the original editor and selection as their target.
    if (document.activeElement === button && previousFocus.current?.isConnected)
      previousFocus.current.focus({ preventScroll: true });
    try {
      await bridge.showWindowMenu({
        menu,
        x: Math.round(bounds.left),
        y: Math.round(bounds.bottom),
        applicationEnabled: actionHandler.current.applicationEnabled,
      });
      menuClosedAt.current = performance.now();
    } catch {
      setError('菜单打开失败，请重试。');
    } finally {
      opening.current = false;
      setExpanded(false);
    }
  }

  useEffect(() => {
    if (!showHeader || !windows || !available) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || event.repeat || event.ctrlKey || event.metaKey || event.shiftKey)
        return;
      const shortcut = event.altKey
        ? menuShortcuts.find(({ key }) => key === event.key.toLowerCase())
        : undefined;
      if (!shortcut && (event.altKey || event.key !== 'F10')) return;
      event.preventDefault();
      if (shortcut) void openMenu(shortcut.id);
      else menuButton.current?.focus({ preventScroll: true });
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  });

  return (
    <div className="native-window-frame" data-window-navigation={navigation ? 'true' : undefined}>
      {showHeader ? (
        <div className="native-window-titlebar" ref={titlebar}>
          {windows ? (
            <button
              ref={menuButton}
              type="button"
              className="native-window-menu-button"
              aria-label="应用菜单"
              title={expanded ? undefined : '应用菜单'}
              aria-haspopup="menu"
              aria-expanded={expanded}
              aria-keyshortcuts="F10"
              disabled={!available}
              onMouseDown={(event) => {
                event.preventDefault();
                // Electron can dismiss the popup before forwarding that same press to the button.
                dismissingClick.current =
                  opening.current || performance.now() - menuClosedAt.current < 50;
              }}
              onFocus={(event) => {
                previousFocus.current =
                  event.relatedTarget instanceof HTMLElement ? event.relatedTarget : null;
              }}
              onClick={(event) => {
                if (event.detail === 0 || !dismissingClick.current) void openMenu();
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  void openMenu();
                } else if (event.key === 'Escape' && previousFocus.current?.isConnected) {
                  event.preventDefault();
                  previousFocus.current.focus({ preventScroll: true });
                }
              }}
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              >
                <path d="M2 3.5h12M2 8h12M2 12.5h12" />
              </svg>
            </button>
          ) : null}
          {navigation && (
            <nav className="native-window-navigation" aria-label="页面导航">
              <div ref={navigation.sidebarHost} />
              {(
                [
                  ['后退', navigation.back],
                  ['前进', navigation.forward],
                ] as const
              ).map(([label, run], index) => (
                <button
                  key={label}
                  type="button"
                  aria-label={label}
                  title={label}
                  aria-disabled={!run}
                  onClick={run}
                >
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 20 20"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={index ? { transform: 'scaleX(-1)' } : undefined}
                  >
                    <path d={mac ? 'M16 10H4m0 0 6-6m-6 6 6 6' : 'm12 4-6 6 6 6'} />
                  </svg>
                </button>
              ))}
            </nav>
          )}
          {navigation && <div className="native-window-search" ref={navigation.searchHost} />}
          {error && (
            <span role="alert" className="native-window-menu-error">
              {error}
            </span>
          )}
          {windows && navigation?.sessionHeaderHost && (
            <div className="kite-client native-window-session" ref={navigation.sessionHeaderHost} />
          )}
        </div>
      ) : null}
      <div className="native-window-content" ref={windowContent}>
        {children}
      </div>
    </div>
  );
}
