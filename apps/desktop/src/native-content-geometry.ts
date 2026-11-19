/** Shared geometry only; contains no page, session, file or permission authority. */
export interface NativeBrowserBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly radius: number;
}
/** Measured state of the current two-panel horizontal Groups, outermost first. */
export interface NativeBrowserPanelLayout {
  readonly size: number;
  readonly min: number;
  readonly minUnit: 'px' | '%';
  readonly max: number;
  readonly maxUnit: 'px' | '%';
  readonly preserve: 'pixel' | 'relative';
  readonly collapsible: boolean;
}
export interface NativeBrowserGroupLayout {
  readonly left: number;
  readonly right: number;
  readonly gap: number;
  readonly panels: readonly [NativeBrowserPanelLayout, NativeBrowserPanelLayout];
}
export interface NativeBrowserLayout {
  readonly windowWidth: number;
  readonly windowHeight: number;
  readonly groups: readonly NativeBrowserGroupLayout[];
  readonly insetLeft: number;
  readonly insetRight: number;
  /** Windows decorations share the native page's geometry commit; never page or control authority. */
  readonly frame?: NativeBrowserFrame;
}
export interface NativeBrowserFrame {
  readonly top: number;
  readonly bottom: number;
  readonly width: number;
  readonly color: readonly [number, number, number, number];
  readonly grip: {
    readonly left: number;
    readonly width: number;
    readonly height: number;
    readonly color: readonly [number, number, number, number];
    readonly visible: boolean;
  };
}
export function isNativeBrowserLayout(value: unknown): value is NativeBrowserLayout {
  const closed = (value: unknown, keys: string[]): value is Record<string, unknown> =>
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key));
  const finite = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 32768;
  const color = (value: unknown) =>
    Array.isArray(value) &&
    value.length === 4 &&
    Array.from(value).every(
      (channel, index) => finite(channel) && channel <= (index === 3 ? 1 : 255),
    );
  const frame = (value: unknown): value is NativeBrowserFrame => {
    if (!closed(value, ['top', 'bottom', 'width', 'color', 'grip'])) return false;
    const grip = value.grip;
    return (
      ['top', 'bottom', 'width'].every((key) => finite(value[key])) &&
      Number(value.width) <= 4 &&
      color(value.color) &&
      closed(grip, ['left', 'width', 'height', 'color', 'visible']) &&
      typeof grip.left === 'number' &&
      Number.isFinite(grip.left) &&
      Math.abs(grip.left) <= 16 &&
      ['width', 'height'].every((key) => finite(grip[key])) &&
      Number(grip.width) <= 8 &&
      Number(grip.height) <= 64 &&
      color(grip.color) &&
      typeof grip.visible === 'boolean'
    );
  };
  const panel = (value: unknown) =>
    closed(value, ['size', 'min', 'minUnit', 'max', 'maxUnit', 'preserve', 'collapsible']) &&
    ['size', 'min', 'max'].every((key) => finite(value[key])) &&
    ['px', '%'].includes(String(value.minUnit)) &&
    ['px', '%'].includes(String(value.maxUnit)) &&
    (value.minUnit !== '%' || Number(value.min) <= 100) &&
    (value.maxUnit !== '%' || Number(value.max) <= 100) &&
    ['pixel', 'relative'].includes(String(value.preserve)) &&
    typeof value.collapsible === 'boolean';
  return (
    closed(value, [
      'windowWidth',
      'windowHeight',
      'groups',
      'insetLeft',
      'insetRight',
      ...(value && typeof value === 'object' && Object.hasOwn(value, 'frame') ? ['frame'] : []),
    ]) &&
    (value.frame === undefined ||
      (frame(value.frame) && value.frame.top + value.frame.bottom < Number(value.windowHeight))) &&
    ['windowWidth', 'windowHeight', 'insetLeft', 'insetRight'].every((key) => finite(value[key])) &&
    Number(value.windowWidth) > 0 &&
    Number(value.windowHeight) > 0 &&
    Array.isArray(value.groups) &&
    value.groups.length >= 1 &&
    value.groups.length <= 2 &&
    Array.from(value.groups).every(
      (group) =>
        closed(group, ['left', 'right', 'gap', 'panels']) &&
        ['left', 'right', 'gap'].every((key) => finite(group[key])) &&
        Array.isArray(group.panels) &&
        group.panels.length === 2 &&
        panel(group.panels[0]) &&
        panel(group.panels[1]) &&
        group.panels.some((item) => item.preserve === 'relative' && item.size > 0),
    )
  );
}

/** Current two-panel contract: use observed allocations at the measured width;
 * apply the Panel library's target constraints only when predicting a new width. */
export function projectNativeBrowserBounds(
  bounds: NativeBrowserBounds,
  layout: NativeBrowserLayout,
  width: number,
  height: number,
): NativeBrowserBounds | undefined {
  return projectNativeBrowserLayout(bounds, layout, width, height)?.bounds;
}

/** Native prediction only: retain constrained allocations for the next resize,
 * without turning them into Renderer-observed layout or image proof. */
export function projectNativeBrowserLayout(
  bounds: NativeBrowserBounds,
  layout: NativeBrowserLayout,
  width: number,
  height: number,
): { bounds: NativeBrowserBounds; layout: NativeBrowserLayout } | undefined {
  if (
    !isNativeBrowserLayout(layout) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  )
    return undefined;
  let parentLeft = 0,
    parentWidth = width;
  const groups: NativeBrowserGroupLayout[] = [];
  const round = (value: number) => Math.round(value * 1000) / 1000;
  for (const group of layout.groups) {
    const available = parentWidth - group.left - group.right - group.gap;
    if (available <= 0) return undefined;
    const panels = group.panels;
    // SessionPage withdraws the right dock when the two open minima cannot
    // coexist. Do not expose a squeezed native view before Renderer catches up.
    if (
      width !== layout.windowWidth &&
      panels[1].collapsible &&
      panels.every((panel) => panel.minUnit === 'px') &&
      available < panels[0].min + panels[1].min
    )
      return undefined;
    const total = panels[0].size + panels[1].size;
    const relative = panels
      .filter((panel) => panel.preserve === 'relative')
      .reduce((sum, panel) => sum + panel.size, 0);
    const fixed = panels
      .filter((panel) => panel.preserve === 'pixel')
      .reduce((sum, panel) => sum + panel.size, 0);
    let sizes = panels.map((panel) =>
      panel.preserve === 'pixel'
        ? (panel.size / available) * 100
        : (panel.size / relative) * (100 - (fixed / available) * 100),
    );
    if (fixed === 0) sizes = panels.map((panel) => (panel.size / total) * 100);
    const clamp = (size: number, panel: NativeBrowserPanelLayout) => {
      // CSS transitions can still be between the old size and the new min/max.
      // Reapplying the target at the observed width discards those valid frames.
      if (width === layout.windowWidth) return size;
      const min = panel.minUnit === '%' ? panel.min : (panel.min / available) * 100;
      const max = panel.maxUnit === '%' ? panel.max : (panel.max / available) * 100;
      if (round(size) < round(min))
        size = panel.collapsible && round(size) < round(min / 2) ? 0 : min;
      return round(Math.min(max, size));
    };
    let remaining = 0;
    sizes = sizes.map((size, index) => {
      const next = clamp(size, panels[index]!);
      remaining += size - next;
      return next;
    });
    for (let index = 0; index < 2 && Math.abs(remaining) > 0.0005; index++) {
      const old = sizes[index]!;
      sizes[index] = clamp(old + remaining, panels[index]!);
      remaining -= sizes[index]! - old;
    }
    const sum = sizes[0]! + sizes[1]!;
    if (sum <= 0 || sizes[1]! <= 0) return undefined;
    const leftWidth = (available * sizes[0]!) / sum;
    const rightWidth = (available * sizes[1]!) / sum;
    groups.push({
      ...group,
      panels: [
        { ...panels[0], size: leftWidth },
        { ...panels[1], size: rightWidth },
      ],
    });
    parentLeft += group.left + leftWidth + group.gap;
    parentWidth = rightWidth;
  }
  const projectedWidth = parentWidth - layout.insetLeft - layout.insetRight;
  const bottom = layout.windowHeight - bounds.y - bounds.height;
  const projectedHeight = height - bounds.y - bottom;
  if (projectedWidth <= 0 || projectedHeight <= 0) return undefined;
  return {
    bounds: {
      ...bounds,
      x: parentLeft + layout.insetLeft,
      width: projectedWidth,
      height: projectedHeight,
    },
    layout: { ...layout, windowWidth: width, windowHeight: height, groups },
  };
}

/** Only coherent current two-Panel Groups may establish a resize anchor.
 * Both the outer shell and nested content retain their measured CSS gutters.
 * CSS handles occupy 0..1px; one CSS pixel covers measurement rounding, not gutters. */
export function currentPanelMeasurement(
  layout: NativeBrowserLayout,
  width: number,
  height: number,
): boolean {
  if (Math.abs(layout.windowWidth - width) > 1 || Math.abs(layout.windowHeight - height) > 1)
    return false;
  let parentWidth = layout.windowWidth;
  for (const group of layout.groups) {
    if (
      group.gap > 2 ||
      Math.abs(
        group.left +
          group.panels[0].size +
          group.gap +
          group.panels[1].size +
          group.right -
          parentWidth,
      ) > 1
    )
      return false;
    parentWidth = group.panels[1].size;
  }
  return true;
}
export function assertPanelMeasurement(
  bounds: NativeBrowserBounds,
  layout: NativeBrowserLayout,
  width: number,
  height: number,
): void {
  if (!currentPanelMeasurement(layout, width, height)) throw Error('invalid_browser_request');
  const measured = projectNativeBrowserBounds(
    bounds,
    layout,
    layout.windowWidth,
    layout.windowHeight,
  );
  if (
    !measured ||
    Math.abs(measured.x - bounds.x) > 1 ||
    Math.abs(measured.width - bounds.width) > 1
  )
    throw Error('invalid_browser_request');
}
