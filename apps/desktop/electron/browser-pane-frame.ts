import { View } from 'electron';
import type { NativeBrowserBounds, NativeBrowserLayout } from '../src/native-browser-bridge';
import { addNativeWindowView } from './native-overlay-layer';
import type { NativeRootWindow } from './native-root-window';

/** Native seam inside the sidebar; native grip paints only after Root captures a drag. */
export function createBrowserPaneFrame(window: NativeRootWindow) {
  let layers: readonly [View, View] | undefined;
  const hide = () => {
    for (const layer of layers ?? []) if (layer.getVisible()) layer.setVisible(false);
  };
  return {
    hide,
    sync(bounds: NativeBrowserBounds, layout: NativeBrowserLayout | undefined, visible: boolean) {
      const frame = process.platform === 'win32' ? layout?.frame : undefined;
      if (!visible || !frame || !layout || window.isDestroyed()) {
        hide();
        return;
      }
      if (!layers) {
        layers = [new View(), new View()];
        for (const layer of layers) {
          layer.setVisible(false);
          // The public zero-blur setting creates an independent native paint
          // layer, without a blur filter or another WebContents.
          layer.setBackgroundBlur(0);
          addNativeWindowView(window, layer);
        }
      }
      const zoom = window.webContents.getZoomFactor(),
        [width = 0, height = 0] = window.getContentSize(),
        // Anchor decoration offsets to the same integer page edge. Independent
        // floor/ceil of fractional flex allocations otherwise adds a one-DIP
        // jump, even when both layers are committed together.
        left = Math.ceil(bounds.x * zoom) - Math.floor(layout.insetLeft * zoom),
        top = Math.ceil(frame.top * zoom),
        bottom = Math.floor(height - frame.bottom * zoom);
      const paint = (
        view: View,
        rect: Electron.Rectangle,
        color: readonly [number, number, number, number],
        visible: boolean,
      ) => {
        const previous = view.getBounds();
        if ((['x', 'y', 'width', 'height'] as const).some((key) => previous[key] !== rect[key]))
          view.setBounds(rect);
        view.setBackgroundColor(`rgba(${color.join(',')})`);
        // Electron's generic View clip path is unsuitable for these sub-32px
        // strips. Leave them unclipped, including the square page seam.
        if (view.getVisible() !== visible) view.setVisible(visible);
      };
      paint(
        layers[0],
        {
          x: Math.max(0, Math.min(width, left)),
          y: top,
          width: Math.ceil(frame.width * zoom),
          height: Math.max(0, bottom - top),
        },
        frame.color,
        bottom > top && frame.width > 0,
      );
      const grip = frame.grip;
      paint(
        layers[1],
        {
          x: Math.max(0, Math.min(width, left + Math.round(grip.left * zoom))),
          y: Math.round((top + bottom - grip.height * zoom) / 2),
          width: Math.ceil(grip.width * zoom),
          height: Math.ceil(grip.height * zoom),
        },
        grip.color,
        grip.visible && bottom > top && grip.width > 0 && grip.height > 0,
      );
    },
    dispose() {
      hide();
      if (!window.isDestroyed())
        for (const layer of layers ?? []) window.contentView.removeChildView(layer);
      layers = undefined;
    },
  };
}
