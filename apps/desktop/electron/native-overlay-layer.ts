import type { View, WebContents, WebContentsView } from 'electron';
import type { NativeRootWindow } from './native-root-window';

type Overlay = {
  view: WebContentsView;
  active: () => boolean;
  protect: (view: View) => void;
};
const overlays = new WeakMap<NativeRootWindow, Overlay>();

export function keepNativeOverlayOnTop(window: NativeRootWindow) {
  const overlay = overlays.get(window);
  if (!overlay || window.isDestroyed()) return;
  const children = window.contentView.children;
  if (children[children.length - 1] !== overlay.view) window.contentView.addChildView(overlay.view);
}

export function isNativeViewAboveContent(window: NativeRootWindow, view: View) {
  const children = window.contentView.children;
  const overlay = overlays.get(window);
  return children[children.length - (overlay ? 2 : 1)] === view;
}

/** All browser/shield insertions preserve the reserved application overlay above them. */
export function addNativeWindowView(window: NativeRootWindow, view: View, index?: number) {
  if (index === undefined) window.contentView.addChildView(view);
  else window.contentView.addChildView(view, index);
  const overlay = overlays.get(window);
  if (view !== overlay?.view) overlay?.protect(view);
  keepNativeOverlayOnTop(window);
}

export function reserveNativeOverlay(window: NativeRootWindow, overlay: Overlay) {
  if (overlays.has(window)) throw Error('native_global_dialog_owner_exists');
  overlays.set(window, overlay);
  for (const child of window.contentView.children) overlay.protect(child);
  addNativeWindowView(window, overlay.view);
  return () => {
    if (overlays.get(window) === overlay) overlays.delete(window);
  };
}

export function focusNativeWindowContent(window: NativeRootWindow, fallback: WebContents) {
  const overlay = overlays.get(window);
  const target = overlay?.active() ? overlay.view.webContents : fallback;
  if (!window.isDestroyed() && !target.isDestroyed()) target.focus();
}
