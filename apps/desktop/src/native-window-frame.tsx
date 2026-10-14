import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { NativeWindowMenuAction, NativeWindowMenuId } from './native-menu-bridge';

const menus = [
  { id: 'file', label: '文件', key: 'f' },
  { id: 'edit', label: '编辑', key: 'e' },
  { id: 'view', label: '视图', key: 'v' },
  { id: 'help', label: '帮助', key: 'h' },
] as const;

export function NativeWindowFrame({
  children,
  showHeader = true,
  applicationEnabled = false,
  onAction,
}: {
  children: ReactNode;
  showHeader?: boolean;
  applicationEnabled?: boolean;
  onAction?: (action: NativeWindowMenuAction) => void;
}) {
  const windows = document.documentElement.dataset.platform === 'windows';
  const bridge = window.kiteNative;
  const [active, setActive] = useState<NativeWindowMenuId>();
  const [focused, setFocused] = useState(0);
  const [error, setError] = useState('');
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const previousFocus = useRef<HTMLElement | null>(null);
  const actionHandler = useRef({ applicationEnabled, onAction });
  actionHandler.current = { applicationEnabled, onAction };
  const opening = useRef(false);
  const available = !!bridge?.showWindowMenu;
  const watchWindowMenuAction = bridge?.watchWindowMenuAction;

  useEffect(() => {
    if (!windows) return;
    return watchWindowMenuAction?.((action) => {
      const handler = actionHandler.current;
      if (handler.applicationEnabled) handler.onAction?.(action);
    });
  }, [watchWindowMenuAction, windows]);

  async function openMenu(index: number) {
    const button = buttons.current[index];
    const definition = menus[index];
    if (!button || !definition || !bridge?.showWindowMenu || opening.current) return;
    const menu = definition.id;
    const bounds = button.getBoundingClientRect();
    opening.current = true;
    setActive(menu);
    setError('');
    // Native edit roles must keep the original editor and selection as their target.
    if (previousFocus.current?.isConnected) previousFocus.current.focus();
    try {
      await bridge.showWindowMenu({
        menu,
        x: Math.round(bounds.left),
        y: Math.round(bounds.bottom),
        applicationEnabled: actionHandler.current.applicationEnabled,
      });
    } catch {
      setError('菜单打开失败，请重试。');
    } finally {
      opening.current = false;
      setActive(undefined);
    }
  }

  useEffect(() => {
    if (!showHeader || !windows || !available) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const index = event.altKey
        ? menus.findIndex((menu) => menu.key === event.key.toLowerCase())
        : -1;
      if (index < 0 && event.key !== 'F10') return;
      event.preventDefault();
      const element = document.activeElement;
      if (element instanceof HTMLElement && !buttons.current.includes(element as HTMLButtonElement))
        previousFocus.current = element;
      setFocused(index < 0 ? 0 : index);
      if (index >= 0) void openMenu(index);
      else buttons.current[0]?.focus();
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  });

  return (
    <div className="native-window-frame">
      {showHeader ? (
        <div className="native-window-titlebar" aria-hidden={windows ? undefined : true}>
          {windows ? (
            <div role="menubar" aria-label="应用菜单" className="native-window-menubar">
              {menus.map((menu, index) => (
                <button
                  key={menu.id}
                  ref={(element) => {
                    buttons.current[index] = element;
                  }}
                  type="button"
                  role="menuitem"
                  aria-haspopup="menu"
                  aria-expanded={active === menu.id}
                  aria-keyshortcuts={`Alt+${menu.key.toUpperCase()}`}
                  tabIndex={focused === index ? 0 : -1}
                  disabled={!available}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    const element = document.activeElement;
                    if (
                      element instanceof HTMLElement &&
                      !buttons.current.includes(element as HTMLButtonElement)
                    )
                      previousFocus.current = element;
                  }}
                  onFocus={(event) => {
                    const element = event.relatedTarget;
                    if (
                      element instanceof HTMLElement &&
                      !buttons.current.includes(element as HTMLButtonElement)
                    )
                      previousFocus.current = element;
                    setFocused(index);
                  }}
                  onClick={() => void openMenu(index)}
                  onKeyDown={(event) => {
                    const direction =
                      event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
                    if (direction || event.key === 'Home' || event.key === 'End') {
                      event.preventDefault();
                      const next =
                        event.key === 'Home'
                          ? 0
                          : event.key === 'End'
                            ? menus.length - 1
                            : (index + direction + menus.length) % menus.length;
                      buttons.current[next]?.focus();
                    } else if (event.key === 'ArrowDown') {
                      event.preventDefault();
                      void openMenu(index);
                    } else if (event.key === 'Escape') {
                      event.preventDefault();
                      previousFocus.current?.focus();
                    }
                  }}
                >
                  {menu.label}
                </button>
              ))}
            </div>
          ) : null}
          {error ? (
            <span role="alert" className="native-window-menu-error">
              {error}
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="native-window-content">{children}</div>
    </div>
  );
}
