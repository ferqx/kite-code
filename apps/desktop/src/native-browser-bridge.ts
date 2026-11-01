export const nativeBrowserChannel = 'kite:native:browser';
export const nativeBrowserEventChannel = 'kite:native:browser-state';
export const nativeBrowserLayoutChannel = 'kite:native:browser-layout';
export const nativeBrowserLayoutFrameChannel = 'kite:native:browser-layout-frame';
export const nativeBrowserMenuChannel = 'kite:native:browser-menu';
export const nativeBrowserMenuCancelChannel = 'kite:native:browser-menu-cancel';
export const nativeBrowserDisplayChannel = 'kite:native:browser-display';
export const nativeBrowserPreparationChannel = 'kite:native:browser-preparation';
export const nativeBrowserPreparationCancelChannel = 'kite:native:browser-preparation-cancel';

export interface NativeBrowserPreparation {
  readonly fromId: string;
  readonly targetId: string;
}
export function isNativeBrowserPreparation(value: unknown): value is NativeBrowserPreparation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    Object.keys(v).length === 2 &&
    [v.fromId, v.targetId].every(
      (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id),
    ) &&
    v.fromId !== v.targetId
  );
}

/** Read-only geometry of an existing Main surface; never a page/control capability. */
export interface NativeBrowserDisplayIntent {
  readonly token: string;
  readonly id: string;
  readonly storeId: string;
  readonly sessionId: string;
  readonly bounds: NativeBrowserBounds;
  readonly width: number;
  readonly height: number;
  readonly zoom: number;
}

export function isNativeBrowserDisplayIntent(value: unknown): value is NativeBrowserDisplayIntent {
  if (!value || typeof value !== 'object') return false;
  const input = value as Record<string, unknown>,
    bounds = input.bounds as Record<string, unknown> | undefined;
  return (
    Object.keys(input).length === 8 &&
    typeof input.token === 'string' &&
    /^[a-f0-9]{32}$/.test(input.token) &&
    [input.id, input.storeId, input.sessionId].every(
      (part) => typeof part === 'string' && part.length > 0 && part.length <= 128,
    ) &&
    !!bounds &&
    Object.keys(bounds).length === 5 &&
    ['x', 'y', 'width', 'height', 'radius'].every(
      (key) =>
        typeof bounds[key] === 'number' &&
        Number.isFinite(bounds[key]) &&
        Number(bounds[key]) >= 0 &&
        Number(bounds[key]) <= 32768,
    ) &&
    Number(bounds.width) > 0 &&
    Number(bounds.height) > 0 &&
    [input.width, input.height].every(
      (part) => Number.isSafeInteger(part) && Number(part) > 0 && Number(part) <= 32768,
    ) &&
    typeof input.zoom === 'number' &&
    Number.isFinite(input.zoom) &&
    input.zoom > 0 &&
    input.zoom <= 10 &&
    Number(bounds.x) + Number(bounds.width) <= Number(input.width) / input.zoom + 1 &&
    Number(bounds.y) + Number(bounds.height) <= Number(input.height) / input.zoom + 1
  );
}

export interface NativeBrowserState {
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
export interface NativeBrowserClosePreparation {
  readonly key: string;
  readonly witness: string;
  readonly bounds: NativeBrowserBounds;
  readonly width: number;
  readonly height: number;
}
export function isNativeBrowserClosePreparation(
  value: unknown,
): value is NativeBrowserClosePreparation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>,
    b = v.bounds as Record<string, unknown> | undefined;
  return (
    Object.keys(v).length === 5 &&
    Object.keys(v).every((key) => ['key', 'witness', 'bounds', 'width', 'height'].includes(key)) &&
    typeof v.key === 'string' &&
    /^[a-f0-9]{32}$/.test(v.key) &&
    typeof v.witness === 'string' &&
    /^[a-f0-9]{24}$/.test(v.witness) &&
    [v.width, v.height].every(
      (n) => typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= 32768,
    ) &&
    !!b &&
    !Array.isArray(b) &&
    Object.keys(b).length === 5 &&
    ['x', 'y', 'width', 'height', 'radius'].every(
      (key) =>
        typeof b[key] === 'number' &&
        Number.isFinite(b[key]) &&
        Number(b[key]) >= 0 &&
        Number(b[key]) <= (key === 'radius' ? 64 : 32768),
    ) &&
    Number(b.width) > 0 &&
    Number(b.height) > 0 &&
    Number(b.x) + Number(b.width) <= Number(v.width) + 0.000001 &&
    Number(b.y) + Number(b.height) <= Number(v.height) + 0.000001
  );
}
export interface NativeBrowserLayoutWitness {
  readonly key: string;
  readonly step: 1 | 2;
}
export interface NativeBrowserLayoutFrameAck {
  readonly presented?: boolean;
  readonly error?: 'browser_presentation_unavailable';
  readonly id: string;
  readonly scope?: NativeBrowserRestoreScope;
  readonly draft?: string;
  readonly presentationRevision: number;
  readonly key: string;
  readonly step: 0 | 1 | 2;
  readonly frozen?: NativeBrowserFrozenFrame;
}
export interface NativeBrowserFrozenFrame {
  readonly key: string;
  readonly mimeType: 'image/png';
  readonly data: string;
  readonly width: number;
  readonly height: number;
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly rootZoom: number;
}
export interface NativeBrowserLayoutReceipt {
  readonly state: NativeBrowserState | null;
  readonly waiting: boolean;
  readonly frozenKey?: string;
  readonly frozenWidth?: number;
  readonly frozenHeight?: number;
}
export function isNativeBrowserFrozenFrame(value: unknown): value is NativeBrowserFrozenFrame {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    Object.keys(v).length === 8 &&
    typeof v.key === 'string' &&
    /^[a-f0-9]{32}$/.test(v.key) &&
    v.mimeType === 'image/png' &&
    typeof v.data === 'string' &&
    v.data.length <= 5600000 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(v.data) &&
    [v.width, v.height].every(
      (n) => Number.isSafeInteger(n) && Number(n) > 0 && Number(n) <= 16384,
    ) &&
    Number(v.width) * Number(v.height) <= 64000000 &&
    [v.cssWidth, v.cssHeight].every(
      (n) => typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= 32768,
    ) &&
    typeof v.rootZoom === 'number' &&
    Number.isFinite(v.rootZoom) &&
    v.rootZoom >= 0.25 &&
    v.rootZoom <= 8
  );
}
/** One same-frame neutral ramp followed by all 24 nonce nibbles (96 bits).
 * Decoding uses the captured ramp, not an assumed display profile or RGB order. */
export function nativeBrowserWitnessColors(witness: NativeBrowserLayoutWitness): number[][] {
  const levels = [
    ...Array.from({ length: 16 }, (_, level) => level),
    ...[...witness.key].map((digit) => {
      const nibble = Number.parseInt(digit, 16);
      return witness.step === 1 ? nibble : 15 - nibble;
    }),
  ];
  return levels.map((level) => Array<number>(3).fill(24 + level * 4));
}
export function nativeBrowserWitnessTileSize(scale = 1) {
  return 3 / Math.min(1, scale);
}
export function nativeBrowserWitnessWidth(scale = 1) {
  return 40 * nativeBrowserWitnessTileSize(scale);
}
export function nativeBrowserWitnessPosition(bounds: NativeBrowserBounds, scale = 1) {
  return {
    x: bounds.x + Math.min(bounds.radius + 2, bounds.width - nativeBrowserWitnessWidth(scale)),
    y: bounds.y + 2,
  };
}
export function nativeBrowserWitnessSamplePoints(
  bounds: NativeBrowserBounds,
  scaleX: number,
  scaleY = scaleX,
) {
  const position = nativeBrowserWitnessPosition(bounds, scaleX),
    tile = nativeBrowserWitnessTileSize(scaleX);
  return Array.from({ length: 40 }, (_, index) => ({
    x: Math.floor((position.x + (index + 0.5) * tile) * scaleX),
    y: Math.floor((position.y + tile / 2) * scaleY),
  }));
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
export interface NativeBrowserPresentationFrame {
  readonly id: string;
  readonly key: string;
  readonly scope: NativeBrowserRestoreScope;
  readonly cssX: number;
  readonly cssY: number;
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly frame: {
    readonly mimeType: 'image/png';
    readonly data: string;
    readonly width: number;
    readonly height: number;
  };
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
      readonly presentationKey?: string;
      readonly witness?: NativeBrowserLayoutWitness;
    }
  | {
      readonly action: 'state' | 'back' | 'forward' | 'reload' | 'stop' | 'close';
      readonly id: string;
      readonly draft?: string;
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
  prepareBrowserClose?(input: {
    readonly id: string;
    readonly draft?: string;
  }): Promise<NativeBrowserClosePreparation | null>;
  confirmBrowserClose?(key: string): Promise<void>;
  finishBrowserClose?(key: string): Promise<void>;
  cancelBrowserClose?(key: string): Promise<void>;
  /** Prepare one existing target's native surface; conveys no page/control authority. */
  prepareBrowserPresentation?(input: NativeBrowserPreparation): Promise<{ key: string } | null>;
  cancelBrowserPreparation?(key: string): Promise<void>;
  browserDisplayIntent?(): NativeBrowserDisplayIntent | null;
  claimBrowserDisplay?(request: Extract<NativeBrowserRequest, { action: 'present' }>): boolean;
  cancelBrowserDisplay?(): void;
  browserRequest(request: NativeBrowserRequest): Promise<NativeBrowserState | null>;
  /** Bounded layout admission; actual placement waits for Root draw feedback. */
  presentBrowserLayout?(
    request: Extract<NativeBrowserRequest, { action: 'present' }>,
  ): NativeBrowserState | NativeBrowserLayoutReceipt | null;
  /** Async calibration of an already-visible hosted page; cannot create or reveal it. */
  presentBrowserLayoutAsync?(
    request: Extract<NativeBrowserRequest, { action: 'present' }>,
  ): Promise<NativeBrowserState | NativeBrowserLayoutReceipt | null>;
  watchBrowserLayoutFrame?(listener: (ack: NativeBrowserLayoutFrameAck) => void): () => void;
  showBrowserMenu?(request: NativeBrowserMenuRequest): Promise<NativeBrowserMenuAction | null>;
  cancelBrowserMenu?(requestId: string): void;
  restoreBrowser(scope: NativeBrowserRestoreScope): Promise<NativeBrowserRestoreResult>;
  restoreBrowserDraft?(draft: string): Promise<NativeBrowserDraftRestoreResult>;
  captureBrowserPresentation?(id: string): Promise<NativeBrowserPresentationFrame>;
  watchBrowser(listener: (state: NativeBrowserState) => void): () => void;
}
export type NativeBrowserReply =
  | {
      readonly ok: true;
      readonly value:
        | NativeBrowserState
        | NativeBrowserRestoreResult
        | NativeBrowserDraftRestoreResult
        | NativeBrowserClosePreparation
        | NativeBrowserPresentationFrame
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
export function isNativeBrowserLayoutFrameAck(
  value: unknown,
): value is NativeBrowserLayoutFrameAck {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    Object.keys(v).every((key) =>
      [
        'id',
        'scope',
        'draft',
        'presentationRevision',
        'key',
        'step',
        'frozen',
        'presented',
        'error',
      ].includes(key),
    ) &&
    typeof v.id === 'string' &&
    /^[A-Za-z0-9_-]{1,64}$/.test(v.id) &&
    isNativeBrowserPresentationOwner(v) &&
    Number.isSafeInteger(v.presentationRevision) &&
    Number(v.presentationRevision) > 0 &&
    typeof v.key === 'string' &&
    /^[a-f0-9]{24}$/.test(v.key) &&
    (v.step === 0 || v.step === 1 || v.step === 2) &&
    (v.presented === undefined || (v.step === 2 && typeof v.presented === 'boolean')) &&
    (v.error === undefined ||
      (v.step === 2 && v.presented === false && v.error === 'browser_presentation_unavailable')) &&
    (v.frozen === undefined || isNativeBrowserFrozenFrame(v.frozen))
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
export function isNativeBrowserPresentationFrame(
  value: unknown,
): value is NativeBrowserPresentationFrame {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>,
    frame = v.frame as Record<string, unknown> | undefined;
  return (
    Object.keys(v).length === 8 &&
    typeof v.id === 'string' &&
    /^[A-Za-z0-9_-]{1,64}$/.test(v.id) &&
    typeof v.key === 'string' &&
    /^[A-Za-z0-9_-]{1,128}$/.test(v.key) &&
    isNativeBrowserRestoreScope(v.scope) &&
    [v.cssX, v.cssY].every(
      (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 32768,
    ) &&
    [v.cssWidth, v.cssHeight].every(
      (n) => typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= 32768,
    ) &&
    !!frame &&
    Object.keys(frame).length === 4 &&
    frame.mimeType === 'image/png' &&
    typeof frame.data === 'string' &&
    frame.data.length <= 5592410 &&
    /^[A-Za-z0-9+/]+=*$/.test(frame.data) &&
    [frame.width, frame.height].every(
      (n) => Number.isSafeInteger(n) && Number(n) > 0 && Number(n) <= 16384,
    )
  );
}
export function parseNativeBrowserRequest(
  value: unknown,
):
  | NativeBrowserRequest
  | { readonly action: 'capturePresentation'; readonly id: string }
  | { readonly action: 'restoreDraft'; readonly draft: string }
  | { readonly action: 'prepareClose'; readonly id: string; readonly draft?: string }
  | { readonly action: 'confirmClose' | 'finishClose' | 'cancelClose'; readonly key: string }
  | { readonly action: 'restore'; readonly scope: NativeBrowserRestoreScope } {
  const input = record(value);
  if (['confirmClose', 'finishClose', 'cancelClose'].includes(String(input.action))) {
    if (
      Object.keys(input).length !== 2 ||
      typeof input.key !== 'string' ||
      !/^[a-f0-9]{32}$/.test(input.key)
    )
      throw Error('invalid_browser_request');
    return {
      action: input.action as 'confirmClose' | 'finishClose' | 'cancelClose',
      key: input.key,
    };
  }
  if (input.action === 'prepareClose') {
    if (
      Object.keys(input).some((key) => !['action', 'id', 'draft'].includes(key)) ||
      typeof input.id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(input.id) ||
      (input.draft !== undefined && !isNativeBrowserDraft(input.draft))
    )
      throw Error('invalid_browser_request');
    return structuredClone(input) as { action: 'prepareClose'; id: string; draft?: string };
  }
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
            'presentationKey',
            'witness',
          ]
        : input.action === 'grant' || input.action === 'capturePresentation'
          ? ['action', 'id']
          : ['action', 'id', 'draft'];
  if (Object.keys(input).some((key) => !fields.includes(key)))
    throw Error('invalid_browser_request');
  if (
    input.draft !== undefined &&
    (!isNativeBrowserDraft(input.draft) ||
      input.scope !== undefined ||
      input.presentationKey !== undefined)
  )
    throw Error('invalid_browser_request');
  if (input.action === 'navigate') {
    if (typeof input.input !== 'string') throw Error('invalid_browser_request');
    browserAddress(input.input);
  } else if (input.action === 'present') {
    if (input.witness !== undefined) {
      const witness = record(input.witness);
      if (
        Object.keys(witness).length !== 2 ||
        typeof witness.key !== 'string' ||
        !/^[a-f0-9]{24}$/.test(witness.key) ||
        ![1, 2].includes(Number(witness.step)) ||
        typeof witness.step !== 'number' ||
        input.bounds === null ||
        !input.layout ||
        !isNativeBrowserPresentationOwner(input) ||
        !input.presentationRevision
      )
        throw Error('invalid_browser_request');
    }
    if (
      input.presentationRevision !== undefined &&
      (!Number.isSafeInteger(input.presentationRevision) || Number(input.presentationRevision) < 1)
    )
      throw Error('invalid_browser_request');
    if (input.scope !== undefined && !isNativeBrowserRestoreScope(input.scope))
      throw Error('invalid_browser_request');
    if (
      input.presentationKey !== undefined &&
      (input.bounds !== null ||
        typeof input.presentationKey !== 'string' ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(input.presentationKey))
    )
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
    ![
      'state',
      'back',
      'forward',
      'reload',
      'stop',
      'close',
      'grant',
      'capturePresentation',
    ].includes(String(input.action))
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
    closed(value, ['windowWidth', 'windowHeight', 'groups', 'insetLeft', 'insetRight']) &&
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

/** Current two-panel contract: preserve measured pixels/relative shares, apply
 * the Panel library's min/max/collapse rules, then normalize the actual flex allocation. */
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
      ['id', 'url', 'title', 'loading', 'canGoBack', 'canGoForward', 'error', 'control'].includes(
        key,
      ),
    ) &&
    (state.control === undefined || isBrowserControl(state.control)) &&
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
