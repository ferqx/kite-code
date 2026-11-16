import type { View, WebContents, WebContentsView } from 'electron';
import type { NativeRootWindow } from './native-root-window';

type Overlay = {
  view: WebContentsView;
  priority?: number;
  active: () => boolean;
  protect: (view: View) => void;
};
const overlays = new WeakMap<NativeRootWindow, Overlay[]>();
const ordered = (window: NativeRootWindow) => overlays.get(window) ?? [];
const topActive = (window: NativeRootWindow) =>
  [...ordered(window)].reverse().find((overlay) => overlay.active());

export function keepNativeOverlayOnTop(window: NativeRootWindow) {
  if (window.isDestroyed()) return;
  const stack = ordered(window);
  const children = window.contentView.children;
  if (
    stack.every(
      (overlay, index) => children[children.length - stack.length + index] === overlay.view,
    )
  )
    return;
  for (const overlay of stack) window.contentView.addChildView(overlay.view);
}

export function isNativeViewAboveContent(window: NativeRootWindow, view: View) {
  const children = window.contentView.children;
  return children[children.length - ordered(window).length - 1] === view;
}

/** Browser, Office and shield insertions remain below every reserved native modal. */
export function addNativeWindowView(window: NativeRootWindow, view: View, index?: number) {
  if (index === undefined) window.contentView.addChildView(view);
  else window.contentView.addChildView(view, index);
  for (const overlay of ordered(window)) if (view !== overlay.view) overlay.protect(view);
  keepNativeOverlayOnTop(window);
}

export function reserveNativeOverlay(window: NativeRootWindow, overlay: Overlay) {
  const stack = ordered(window);
  if (stack.some((current) => current.view === overlay.view))
    throw Error('native_modal_owner_exists');
  stack.push(overlay);
  stack.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
  overlays.set(window, stack);
  for (const child of window.contentView.children) overlay.protect(child);
  addNativeWindowView(window, overlay.view);
  return () => {
    const current = ordered(window);
    const next = current.filter((value) => value !== overlay);
    if (next.length) overlays.set(window, next);
    else overlays.delete(window);
  };
}

export function focusNativeWindowContent(window: NativeRootWindow, fallback: WebContents) {
  const target = topActive(window)?.view.webContents ?? fallback;
  if (!window.isDestroyed() && !target.isDestroyed()) target.focus();
}
