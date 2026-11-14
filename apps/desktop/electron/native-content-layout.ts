import type { View } from 'electron';
import type { NativeRootWindow } from './native-root-window';

export type ContentBounds = { x: number; y: number; width: number; height: number };
/** Browser and document surfaces use the same inward-rounded native content rectangle. */
export function nativeContentBounds(
  bounds: ContentBounds,
  zoom: number,
  width: number,
  height: number,
): ContentBounds | undefined {
  if (
    ![bounds.x, bounds.y, bounds.width, bounds.height, zoom, width, height].every(
      Number.isFinite,
    ) ||
    zoom <= 0
  )
    return;
  const x = Math.max(0, Math.min(width, Math.ceil(bounds.x * zoom))),
    y = Math.max(0, Math.min(height, Math.ceil(bounds.y * zoom))),
    right = Math.min(width, Math.floor((bounds.x + bounds.width) * zoom)),
    bottom = Math.min(height, Math.floor((bounds.y + bounds.height) * zoom));
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : undefined;
}
/** Event lifetime only. Each content owner retains its own ready/identity/security policy. */
export function watchNativeContentWindow(
  window: NativeRootWindow,
  root: View | undefined,
  callbacks: {
    resize: () => void;
    hide: () => void;
    minimize: () => void;
    show: () => void;
    restore: () => void;
  },
) {
  const pairs = [
    ['resize', callbacks.resize],
    ['hide', callbacks.hide],
    ['minimize', callbacks.minimize],
    ['show', callbacks.show],
    ['restore', callbacks.restore],
  ] as const;
  for (const [event, handler] of pairs) Reflect.apply(window.on, window, [event, handler]);
  root?.on('bounds-changed', callbacks.resize);
  window.webContents.on('zoom-changed', callbacks.resize);
  return () => {
    for (const [event, handler] of pairs) Reflect.apply(window.off, window, [event, handler]);
    root?.off('bounds-changed', callbacks.resize);
    window.webContents.off('zoom-changed', callbacks.resize);
  };
}
