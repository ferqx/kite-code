import type {
  NativeBrowserBounds,
  NativeBrowserFrame,
  NativeBrowserGroupLayout,
  NativeBrowserLayout,
  NativeBrowserPanelLayout,
} from './native-content-geometry';
import { projectNativeBrowserBounds } from './native-content-geometry';
export function clippedViewport(node: HTMLElement): NativeBrowserBounds | null {
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

export function measuredLayout(
  node: HTMLElement,
  bounds: NativeBrowserBounds,
): NativeLayoutMeasurement {
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

export function visibleElement(node: HTMLElement) {
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
