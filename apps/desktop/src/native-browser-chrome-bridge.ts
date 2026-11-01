import type { SessionTabsChromeAction, SessionTabsChromeData } from '@kite-ai/ui/desktop';
import {
  isNativeBrowserDraft,
  isNativeBrowserRestoreScope,
  type NativeBrowserRestoreScope,
} from './native-browser-bridge';
import type {
  NativeBrowserControlAction,
  NativeBrowserControlPresentation,
  NativeBrowserToolbarAction,
  NativeBrowserToolbarPresentation,
} from './native-browser-chrome-types';

export const nativeBrowserChromeRootChannel = 'kite:native:browser-chrome-root';
export const nativeBrowserChromeChannel = 'kite:native:browser-chrome';
export const nativeBrowserChromeStateChannel = 'kite:native:browser-chrome-state';
export const nativeBrowserChromeActionChannel = 'kite:native:browser-chrome-action';
export const nativeBrowserChromeAckChannel = 'kite:native:browser-chrome-ack';

export type NativeBrowserChromeOwner = NativeBrowserRestoreScope | { readonly draft: string };
export function isNativeBrowserChromeOwner(value: unknown): value is NativeBrowserChromeOwner {
  return (
    isNativeBrowserRestoreScope(value) ||
    (!!value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).length === 1 &&
      'draft' in value &&
      isNativeBrowserDraft(value.draft))
  );
}
export function nativeBrowserChromeOwnerKey(
  owner: NativeBrowserChromeOwner | undefined | null,
): string {
  if (!owner) return '';
  return 'draft' in owner
    ? JSON.stringify(['draft', owner.draft])
    : JSON.stringify([
        'session',
        owner.storeId,
        owner.sessionId,
        owner.generation,
        owner.viewSelection,
      ]);
}
export function sameNativeBrowserChromeOwner(
  a: NativeBrowserChromeOwner | undefined | null,
  b: NativeBrowserChromeOwner | undefined | null,
): boolean {
  return !!a && !!b && nativeBrowserChromeOwnerKey(a) === nativeBrowserChromeOwnerKey(b);
}

/** Display data only. No Service caller, callbacks, task authority or executable content. */
export interface NativeBrowserChromeSnapshot {
  readonly scope: NativeBrowserChromeOwner;
  readonly revision: number;
  readonly theme: 'light' | 'dark';
  readonly material?: string;
  readonly interactive: boolean;
  readonly covered: boolean;
  readonly hosted: boolean;
  readonly tabs: SessionTabsChromeData;
  readonly toolbar: NativeBrowserToolbarPresentation;
  readonly control?: NativeBrowserControlPresentation;
}

export interface NativeBrowserChromeEnvelope {
  readonly attachment: string;
  readonly pageToken: string;
  readonly hosted: boolean;
  readonly actionable: boolean;
  readonly preparing?: boolean;
  readonly loadingBody?: boolean;
  readonly snapshot: NativeBrowserChromeSnapshot;
}

export type NativeBrowserChromeAction =
  | { readonly part: 'tabs'; readonly action: SessionTabsChromeAction }
  | { readonly part: 'toolbar'; readonly action: NativeBrowserToolbarAction }
  | { readonly part: 'control'; readonly action: NativeBrowserControlAction }
  | { readonly part: 'escape' | 'focus-root' };

/** Classification only; callers still verify current owner, wire and revision. */
export function isNativeBrowserChromePreparingAction(
  action: NativeBrowserChromeAction,
  snapshot: NativeBrowserChromeSnapshot,
): boolean {
  if (action.part === 'escape' || action.part === 'focus-root') return true;
  if (action.part === 'tabs') return ['close', 'collapse'].includes(action.action.type);
  return action.part === 'toolbar' && action.action.type === 'reload' && snapshot.toolbar.loading;
}

export type NativeBrowserChromeEvent = NativeBrowserChromeAction & {
  readonly attachment: string;
  readonly pageToken: string;
  readonly sequence: number;
  readonly revision: number;
};
export type NativeBrowserChromeResult = 'forwarded' | 'stale' | 'unconfirmed';

export interface NativeBrowserChromeBridge {
  rendered?(input: NativeBrowserChromeRendered): Promise<void>;
  read(): Promise<NativeBrowserChromeEnvelope | null>;
  watch(receive: (value: NativeBrowserChromeEnvelope | null) => void): () => void;
  send(event: NativeBrowserChromeEvent): Promise<NativeBrowserChromeResult>;
}
export interface NativeBrowserChromeRendered {
  readonly attachment: string;
  readonly pageToken: string;
  readonly revision: number;
}
export function isNativeBrowserChromeRendered(
  value: unknown,
): value is NativeBrowserChromeRendered {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    Object.keys(v).length === 3 &&
    Object.keys(v).every((key) => ['attachment', 'pageToken', 'revision'].includes(key)) &&
    [v.attachment, v.pageToken].every(
      (part) =>
        typeof part === 'string' && part.length > 0 && part.length <= 128 && !part.includes('\0'),
    ) &&
    Number.isSafeInteger(v.revision) &&
    Number(v.revision) > 0
  );
}
export interface NativeBrowserChromeRootBridge {
  setBrowserPresentationContext?(input: {
    readonly revision: number;
    readonly owner: NativeBrowserChromeOwner | null;
  }): Promise<void>;
  publishBrowserChrome(
    snapshot: NativeBrowserChromeSnapshot | null,
    context?: number,
  ): Promise<void>;
  watchBrowserChromeState(receive: (value: NativeBrowserChromeEnvelope | null) => void): () => void;
  watchBrowserChromeAction(receive: (event: NativeBrowserChromeEvent) => boolean): () => void;
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, maximum = 128): value is string =>
  typeof value === 'string' && value.length <= maximum && !value.includes('\0');
const positive = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;
const bools = (value: Record<string, unknown>, fields: string[]) =>
  fields.every((field) => typeof value[field] === 'boolean');
const keys = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
const optionalText = (value: unknown, maximum = 1024) =>
  value === undefined || text(value, maximum);

export function isNativeBrowserChromeSnapshot(
  value: unknown,
): value is NativeBrowserChromeSnapshot {
  if (!object(value)) return false;
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 65536) return false;
  } catch {
    return false;
  }
  if (
    !keys(value, [
      'scope',
      'revision',
      'theme',
      'material',
      'interactive',
      'covered',
      'hosted',
      'tabs',
      'toolbar',
      'control',
    ]) ||
    !isNativeBrowserChromeOwner(value.scope) ||
    !positive(value.revision) ||
    !['light', 'dark'].includes(String(value.theme)) ||
    !optionalText(value.material, 32) ||
    !bools(value, ['interactive', 'covered', 'hosted'])
  )
    return false;
  const tabs = value.tabs,
    toolbar = value.toolbar,
    control = value.control;
  if (
    'draft' in value.scope &&
    (control !== undefined ||
      !object(toolbar) ||
      toolbar.notesAvailable !== false ||
      toolbar.notesOpen !== false)
  )
    return false;
  if (
    !object(tabs) ||
    !keys(tabs, [
      'scopeKey',
      'tabs',
      'active',
      'visible',
      'present',
      'restoring',
      'restoreIssue',
    ]) ||
    !text(tabs.scopeKey, 2048) ||
    !text(tabs.active) ||
    !bools(tabs, ['visible', 'present', 'restoring', 'restoreIssue']) ||
    !Array.isArray(tabs.tabs) ||
    tabs.tabs.length > 8
  )
    return false;
  const ids = new Set<string>();
  for (const tab of tabs.tabs) {
    if (
      !object(tab) ||
      !keys(tab, ['id', 'kind', 'title', 'sessionId', 'executionId', 'childAgentIdentity']) ||
      !text(tab.id) ||
      !tab.id ||
      ids.has(tab.id) ||
      !text(tab.title, 1024) ||
      !['browser', 'changes', 'child', 'workspace'].includes(String(tab.kind)) ||
      !optionalText(tab.childAgentIdentity, 128) ||
      !optionalText(tab.executionId, 128) ||
      (tab.kind === 'child' && (!text(tab.sessionId) || !tab.sessionId))
    )
      return false;
    ids.add(tab.id);
  }
  if (
    !object(toolbar) ||
    !keys(toolbar, [
      'id',
      'address',
      'readonlyURL',
      'loading',
      'hasPage',
      'canGoBack',
      'canGoForward',
      'canNavigate',
      'error',
      'optionsIssue',
      'notesAvailable',
      'notesOpen',
      'optionsAvailable',
    ]) ||
    !text(toolbar.id) ||
    !toolbar.id ||
    !text(toolbar.address, 2048) ||
    !text(toolbar.readonlyURL, 4096) ||
    !optionalText(toolbar.error, 2048) ||
    !optionalText(toolbar.optionsIssue, 2048) ||
    !bools(toolbar, [
      'loading',
      'hasPage',
      'canGoBack',
      'canGoForward',
      'canNavigate',
      'notesAvailable',
      'notesOpen',
      'optionsAvailable',
    ])
  )
    return false;
  if (
    control !== undefined &&
    (!object(control) ||
      !keys(control, [
        'id',
        'label',
        'detail',
        'issue',
        'handoffAvailable',
        'closeAvailable',
        'pending',
        'details',
      ]) ||
      !text(control.id) ||
      !text(control.label, 128) ||
      !text(control.detail, 1024) ||
      !optionalText(control.issue, 2048) ||
      !bools(control, ['handoffAvailable', 'closeAvailable', 'pending']) ||
      !Array.isArray(control.details) ||
      control.details.length > 16 ||
      !control.details.every((item) => text(item, 2048)))
  )
    return false;
  return true;
}

export function isNativeBrowserChromeEvent(value: unknown): value is NativeBrowserChromeEvent {
  if (
    !object(value) ||
    !text(value.attachment) ||
    !value.attachment ||
    !text(value.pageToken, 256) ||
    !positive(value.sequence) ||
    !positive(value.revision) ||
    !keys(value, ['attachment', 'pageToken', 'sequence', 'revision', 'part', 'action'])
  )
    return false;
  if (value.part === 'escape' || value.part === 'focus-root') return value.action === undefined;
  const action = value.action;
  if (!object(action) || typeof action.type !== 'string') return false;
  if (value.part === 'tabs') {
    if (['select', 'close'].includes(action.type))
      return keys(action, ['type', 'id']) && text(action.id) && !!action.id;
    return (
      keys(action, ['type']) &&
      ['add', 'collapse', 'retryRestore', 'openChanges'].includes(action.type)
    );
  }
  if (value.part === 'toolbar') {
    if (action.type === 'address-change')
      return keys(action, ['type', 'value']) && text(action.value, 2048);
    if (action.type === 'address-focus')
      return keys(action, ['type', 'focused']) && typeof action.focused === 'boolean';
    if (['navigate', 'back', 'forward', 'reload', 'toggle-notes'].includes(action.type))
      return keys(action, ['type']);
  }
  if (
    (value.part === 'toolbar' && action.type === 'show-options') ||
    (value.part === 'control' && action.type === 'show-menu')
  ) {
    const rect = action.anchor;
    return (
      keys(action, ['type', 'anchor']) &&
      object(rect) &&
      keys(rect, ['x', 'y', 'width', 'height']) &&
      ['x', 'y', 'width', 'height'].every(
        (key) =>
          typeof rect[key] === 'number' &&
          Number.isFinite(rect[key]) &&
          Number(rect[key]) >= 0 &&
          Number(rect[key]) <= 32768,
      )
    );
  }
  return false;
}

export function isNativeBrowserChromeEnvelope(
  value: unknown,
): value is NativeBrowserChromeEnvelope {
  return (
    object(value) &&
    keys(value, [
      'attachment',
      'pageToken',
      'hosted',
      'actionable',
      'preparing',
      'loadingBody',
      'snapshot',
    ]) &&
    text(value.attachment) &&
    !!value.attachment &&
    text(value.pageToken, 256) &&
    bools(value, ['hosted', 'actionable']) &&
    (value.preparing === undefined || typeof value.preparing === 'boolean') &&
    (value.loadingBody === undefined || typeof value.loadingBody === 'boolean') &&
    !(value.preparing === true && value.actionable) &&
    isNativeBrowserChromeSnapshot(value.snapshot)
  );
}

declare global {
  interface Window {
    readonly kiteBrowserChrome?: NativeBrowserChromeBridge;
  }
}
