export const nativeBrowserChannel = 'kite:native:browser';
export const nativeBrowserEventChannel = 'kite:native:browser-state';
export const nativeBrowserLayoutChannel = 'kite:native:browser-layout';
export const nativeBrowserPresentationChannel = 'kite:native:browser-presentation';

export interface NativeBrowserLoadFailure {
  readonly kind:
    | 'dns'
    | 'connection'
    | 'timeout'
    | 'offline'
    | 'certificate'
    | 'secure_connection'
    | 'other';
  /** A single native error name, never a log, stack or remote response body. */
  readonly code?: string;
}
export const nativeBrowserMenuChannel = 'kite:native:browser-menu';
export const nativeBrowserMenuCancelChannel = 'kite:native:browser-menu-cancel';

export interface NativeBrowserState {
  /** Opaque Main page/document and display-generation fence; never inferred from its URL. */
  readonly pageToken?: string;
  readonly display?: 'loading' | 'ready' | 'failed';
  readonly control?: {
    readonly phase: 'human' | 'armed' | 'acquiring' | 'agent' | 'revoking' | 'unknown';
    readonly incarnation: string;
    readonly navigation: number;
    readonly browserId?: string;
    readonly sessionId: string;
  };

  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly failure?: NativeBrowserLoadFailure;
  readonly error?:
    | 'load_failed'
    | 'unsupported_navigation'
    | 'download_unsupported'
    | 'process_gone';
}
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
export interface NativeBrowserRestoreScope {
  readonly storeId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly viewSelection: number;
}
export interface NativeBrowserRestoreResult {
  readonly scope: NativeBrowserRestoreScope;
  readonly page: NativeBrowserState | null;
  readonly pages?: readonly NativeBrowserState[];
  readonly activeId?: string;
  /** Restore the page presentation that was visible before this Root replacement. */
  readonly reveal?: true;
}
/** Manual Root-local pages, without any Core session or Agent control grant. */
export interface NativeBrowserDraftRestoreResult {
  readonly pages: readonly NativeBrowserState[];
  readonly activeId?: string;
}
export type NativeBrowserRequest =
  | {
      readonly action: 'navigate';
      readonly id: string;
      readonly input: string;
      readonly draft?: string;
    }
  | {
      readonly action: 'present';
      readonly id: string;
      readonly bounds: NativeBrowserBounds | null;
      readonly layout?: NativeBrowserLayout;
      readonly scope?: NativeBrowserRestoreScope;
      readonly draft?: string;
      readonly presentationRevision?: number;
      readonly pageToken?: string;
    }
  | {
      readonly action: 'state' | 'back' | 'forward' | 'reload' | 'stop';
      readonly id: string;
      readonly draft?: string;
    }
  | {
      readonly action: 'close';
      readonly id: string;
      readonly draft?: string;
      readonly pageToken?: string;
    }
  | { readonly action: 'grant'; readonly id: string; readonly draft?: never };
export type NativeBrowserMenuAction =
  | 'back'
  | 'forward'
  | 'reload'
  | 'stop'
  | 'handoff'
  | 'close'
  | 'checkOriginal';
export interface NativeBrowserMenuRequest {
  readonly requestId: string;
  readonly scope?: NativeBrowserRestoreScope;
  readonly draft?: string;
  readonly id: string;
  readonly incarnation?: string;
  readonly navigation?: number;
  readonly x: number;
  readonly y: number;
  readonly items: readonly {
    readonly action: NativeBrowserMenuAction;
    readonly enabled: boolean;
  }[];
  readonly details: readonly string[];
}
export function isNativeBrowserMenuAction(value: unknown): value is NativeBrowserMenuAction {
  return (
    typeof value === 'string' &&
    ['back', 'forward', 'reload', 'stop', 'handoff', 'close', 'checkOriginal'].includes(value)
  );
}
export function parseNativeBrowserMenuRequest(value: unknown): NativeBrowserMenuRequest {
  const input = record(value);
  if (
    Object.keys(input).some(
      (key) =>
        ![
          'requestId',
          'scope',
          'draft',
          'id',
          'incarnation',
          'navigation',
          'x',
          'y',
          'items',
          'details',
        ].includes(key),
    ) ||
    !isNativeBrowserPresentationOwner(input) ||
    ![input.requestId, input.id].every(
      (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v),
    ) ||
    (input.incarnation !== undefined &&
      (typeof input.incarnation !== 'string' || input.incarnation.length > 128)) ||
    (input.navigation !== undefined &&
      (!Number.isSafeInteger(input.navigation) || Number(input.navigation) < 0)) ||
    ![input.x, input.y].every(
      (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 32768,
    ) ||
    !Array.isArray(input.items) ||
    input.items.length > 7 ||
    !input.items.every(
      (item) =>
        item &&
        typeof item === 'object' &&
        Object.keys(item).length === 2 &&
        isNativeBrowserMenuAction(item.action) &&
        typeof item.enabled === 'boolean',
    ) ||
    new Set(input.items.map((item) => item.action)).size !== input.items.length ||
    !Array.isArray(input.details) ||
    input.details.length > 12 ||
    !input.details.every((v) => typeof v === 'string' && v.length <= 16384) ||
    input.details.join('').length > 32768
  )
    throw Error('invalid_browser_request');
  return input as unknown as NativeBrowserMenuRequest;
}

export interface NativeBrowserBridge {
  browserRequest(request: NativeBrowserRequest): Promise<NativeBrowserState | null>;
  /** Immediate withdrawal, before a DOM overlay paints above the page's area. */
  presentBrowserLayout?(
    request: Extract<NativeBrowserRequest, { action: 'present' }>,
  ): NativeBrowserState | null;
  /** Ordered actual DOM geometry; no UI drawing handshake or control authority. */
  presentBrowserLayoutAsync?(
    request: Extract<NativeBrowserRequest, { action: 'present' }>,
  ): Promise<NativeBrowserState | null>;
  watchBrowserPresentation?(listener: () => void): () => void;
  showBrowserMenu?(request: NativeBrowserMenuRequest): Promise<NativeBrowserMenuAction | null>;
  cancelBrowserMenu?(requestId: string): void;
  restoreBrowser(scope: NativeBrowserRestoreScope): Promise<NativeBrowserRestoreResult>;
  restoreBrowserDraft?(draft: string): Promise<NativeBrowserDraftRestoreResult>;
  watchBrowser(listener: (state: NativeBrowserState) => void): () => void;
}
export type NativeBrowserReply =
  | {
      readonly ok: true;
      readonly value:
        | NativeBrowserState
        | NativeBrowserRestoreResult
        | NativeBrowserDraftRestoreResult
        | null;
    }
  | { readonly ok: false; readonly code: string };

export function browserAddress(input: string): string {
  if (input.length > 2048) throw Error('invalid_browser_address');
  const value = input.trim();
  if (
    !value ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    throw Error('invalid_browser_address');
  let address = value;
  const local = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d{1,5})?(?:[/?#]|$)/i.test(value);
  if (local) address = `http://${value}`;
  else if (!/\s/.test(value) && /^(?:[a-z0-9-]+\.)+[a-z0-9-]+(?::\d{1,5})?(?:[/?#]|$)/i.test(value))
    address = `https://${value}`;
  else if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    if (!/^https?:\/\//i.test(value)) throw Error('unsupported_browser_protocol');
  } else address = `https://www.bing.com/search?q=${encodeURIComponent(value)}`;
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw Error('invalid_browser_address');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname)
    throw Error('unsupported_browser_protocol');
  return url.href;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('invalid_browser_request');
  return value as Record<string, unknown>;
}
export function isNativeBrowserRestoreScope(value: unknown): value is NativeBrowserRestoreScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const scope = value as Record<string, unknown>;
  return (
    Object.keys(scope).length === 4 &&
    typeof scope.storeId === 'string' &&
    !!scope.storeId &&
    scope.storeId.length <= 128 &&
    typeof scope.sessionId === 'string' &&
    !!scope.sessionId &&
    scope.sessionId.length <= 128 &&
    Number.isSafeInteger(scope.generation) &&
    Number(scope.generation) >= 1 &&
    Number.isSafeInteger(scope.viewSelection) &&
    Number(scope.viewSelection) >= 0
  );
}
export function isNativeBrowserDraft(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
}
function isNativeBrowserPresentationOwner(value: Record<string, unknown>): boolean {
  return (
    (value.draft === undefined && isNativeBrowserRestoreScope(value.scope)) ||
    (value.scope === undefined && isNativeBrowserDraft(value.draft))
  );
}
export function isNativeBrowserDraftRestoreResult(
  value: unknown,
): value is NativeBrowserDraftRestoreResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return (
    Object.keys(result).every((key) => ['pages', 'activeId'].includes(key)) &&
    Object.hasOwn(result, 'pages') &&
    Array.isArray(result.pages) &&
    result.pages.length <= 8 &&
    result.pages.every((page) => isNativeBrowserState(page) && page.control === undefined) &&
    new Set(result.pages.map((page) => page.id)).size === result.pages.length &&
    (result.activeId === undefined ||
      (typeof result.activeId === 'string' &&
        result.pages.some((page) => page.id === result.activeId)))
  );
}
export function isNativeBrowserRestoreResult(value: unknown): value is NativeBrowserRestoreResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return (
    Object.keys(result).every((key) =>
      ['scope', 'page', 'pages', 'activeId', 'reveal'].includes(key),
    ) &&
    isNativeBrowserRestoreScope(result.scope) &&
    (result.page === null || isNativeBrowserState(result.page)) &&
    (result.pages === undefined ||
      (Array.isArray(result.pages) &&
        result.pages.length <= 8 &&
        result.pages.every(isNativeBrowserState) &&
        new Set(result.pages.map((page) => page.id)).size === result.pages.length &&
        (result.page === null
          ? result.pages.length === 0
          : result.pages.some((page) => page.id === (result.page as NativeBrowserState).id)))) &&
    (result.reveal === undefined ||
      (result.reveal === true && typeof result.activeId === 'string')) &&
    (result.activeId === undefined ||
      (result.page !== null &&
        (Array.isArray(result.pages)
          ? result.pages.some((page) => page.id === result.activeId)
          : result.activeId === (result.page as NativeBrowserState).id)))
  );
}
export function parseNativeBrowserRequest(
  value: unknown,
):
  | NativeBrowserRequest
  | { readonly action: 'restoreDraft'; readonly draft: string }
  | { readonly action: 'restore'; readonly scope: NativeBrowserRestoreScope } {
  const input = record(value);
  if (input.action === 'restoreDraft') {
    if (Object.keys(input).length !== 2 || !isNativeBrowserDraft(input.draft))
      throw Error('invalid_browser_request');
    return { action: 'restoreDraft', draft: input.draft };
  }
  if (input.action === 'restore') {
    if (Object.keys(input).length !== 2 || !isNativeBrowserRestoreScope(input.scope))
      throw Error('invalid_browser_request');
    return { action: 'restore', scope: { ...input.scope } };
  }
  if (typeof input.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(input.id))
    throw Error('invalid_browser_request');
  const fields =
    input.action === 'navigate'
      ? ['action', 'id', 'input', 'draft']
      : input.action === 'present'
        ? [
            'action',
            'id',
            'bounds',
            'layout',
            'scope',
            'draft',
            'presentationRevision',
            'pageToken',
          ]
        : input.action === 'grant'
          ? ['action', 'id']
          : input.action === 'close'
            ? ['action', 'id', 'draft', 'pageToken']
            : ['action', 'id', 'draft'];
  if (Object.keys(input).some((key) => !fields.includes(key)))
    throw Error('invalid_browser_request');
  if (input.action === 'close' && typeof input.pageToken !== 'string')
    throw Error('invalid_browser_request');
  if (
    input.pageToken !== undefined &&
    (typeof input.pageToken !== 'string' ||
      input.pageToken.length === 0 ||
      input.pageToken.length > 1024)
  )
    throw Error('invalid_browser_request');
  if (
    input.draft !== undefined &&
    (!isNativeBrowserDraft(input.draft) || input.scope !== undefined)
  )
    throw Error('invalid_browser_request');
  if (input.action === 'navigate') {
    if (typeof input.input !== 'string') throw Error('invalid_browser_request');
    browserAddress(input.input);
  } else if (input.action === 'present') {
    if (
      !isNativeBrowserPresentationOwner(input) ||
      typeof input.pageToken !== 'string' ||
      !input.presentationRevision
    )
      throw Error('invalid_browser_request');
    if (
      input.pageToken !== undefined &&
      (typeof input.pageToken !== 'string' ||
        input.pageToken.length === 0 ||
        input.pageToken.length > 1024)
    )
      throw Error('invalid_browser_request');
    if (
      input.presentationRevision !== undefined &&
      (!Number.isSafeInteger(input.presentationRevision) || Number(input.presentationRevision) < 1)
    )
      throw Error('invalid_browser_request');
    if (input.scope !== undefined && !isNativeBrowserRestoreScope(input.scope))
      throw Error('invalid_browser_request');
    if (
      input.layout !== undefined &&
      (input.bounds === null || !isNativeBrowserLayout(input.layout))
    )
      throw Error('invalid_browser_request');
    if (input.bounds !== null) {
      const bounds = record(input.bounds);
      if (
        Object.keys(bounds).length !== 5 ||
        !['x', 'y', 'width', 'height', 'radius'].every(
          (key) =>
            typeof bounds[key] === 'number' &&
            Number.isFinite(bounds[key]) &&
            Number(bounds[key]) >= 0 &&
            Number(bounds[key]) <= (key === 'radius' ? 64 : 32768),
        )
      )
        throw Error('invalid_browser_request');
    }
  } else if (
    !['state', 'back', 'forward', 'reload', 'stop', 'close', 'grant'].includes(String(input.action))
  )
    throw Error('invalid_browser_request');
  return structuredClone(input) as NativeBrowserRequest;
}

function isNativeBrowserLayout(value: unknown): value is NativeBrowserLayout {
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

export function isNativeBrowserState(value: unknown): value is NativeBrowserState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return (
    Object.keys(state).every((key) =>
      [
        'id',
        'url',
        'title',
        'loading',
        'canGoBack',
        'canGoForward',
        'error',
        'failure',
        'control',
        'display',
        'pageToken',
      ].includes(key),
    ) &&
    (state.failure === undefined ||
      (state.error === 'load_failed' && isNativeBrowserLoadFailure(state.failure))) &&
    (state.control === undefined || isBrowserControl(state.control)) &&
    (state.pageToken === undefined ||
      (typeof state.pageToken === 'string' &&
        state.pageToken.length > 0 &&
        state.pageToken.length <= 1024)) &&
    (state.display === undefined ||
      ['loading', 'ready', 'failed'].includes(String(state.display))) &&
    typeof state.id === 'string' &&
    /^[A-Za-z0-9_-]{1,64}$/.test(state.id) &&
    typeof state.url === 'string' &&
    state.url.length <= 8192 &&
    typeof state.title === 'string' &&
    state.title.length <= 128 &&
    ['loading', 'canGoBack', 'canGoForward'].every((key) => typeof state[key] === 'boolean') &&
    (state.error === undefined ||
      ['load_failed', 'unsupported_navigation', 'download_unsupported', 'process_gone'].includes(
        String(state.error),
      ))
  );
}

function isNativeBrowserLoadFailure(value: unknown): value is NativeBrowserLoadFailure {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const failure = value as Record<string, unknown>;
  return (
    Object.keys(failure).every((key) => ['kind', 'code'].includes(key)) &&
    Object.hasOwn(failure, 'kind') &&
    typeof failure.kind === 'string' &&
    [
      'dns',
      'connection',
      'timeout',
      'offline',
      'certificate',
      'secure_connection',
      'other',
    ].includes(String(failure.kind)) &&
    (failure.code === undefined ||
      (typeof failure.code === 'string' && /^ERR_[A-Z0-9_]{1,60}$/.test(failure.code)))
  );
}

function isBrowserControl(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>;
  return (
    Object.keys(c).every((key) =>
      ['phase', 'incarnation', 'navigation', 'browserId', 'sessionId'].includes(key),
    ) &&
    ['human', 'armed', 'acquiring', 'agent', 'revoking', 'unknown'].includes(String(c.phase)) &&
    typeof c.incarnation === 'string' &&
    c.incarnation.length <= 128 &&
    Number.isSafeInteger(c.navigation) &&
    Number(c.navigation) >= 0 &&
    typeof c.sessionId === 'string' &&
    c.sessionId.length <= 128 &&
    (c.browserId === undefined || (typeof c.browserId === 'string' && c.browserId.length <= 128))
  );
}
