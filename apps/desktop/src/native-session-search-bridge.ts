import type { SearchRow } from '@kite-ai/ui/desktop/session-search';

export const nativeSessionSearchPresentChannel = 'kite:native:session-search-present';
export const nativeSessionSearchCloseChannel = 'kite:native:session-search-close';
export const nativeSessionSearchActionChannel = 'kite:native:session-search-action';
export const nativeSessionSearchStateChannel = 'kite:native:session-search-state';
export const nativeSessionSearchEventChannel = 'kite:native:session-search-event';
export const nativeSessionSearchActiveChannel = 'kite:native:session-search-active';

type Request = { query: string; page: number };
export type NativeSessionSearchPresentation = Request & {
  requestId: string;
  resultId: string;
  available: boolean;
  total: number;
  resultPage: number;
  rows: readonly SearchRow[];
};
export type NativeSessionSearchState = NativeSessionSearchPresentation & {
  theme: 'light' | 'dark';
};
export type NativeSessionSearchAction = { requestId: string } & (
  | { type: 'close' }
  | { type: 'unavailable' }
  | ({ type: 'select'; sessionId: string; resultId: string } & Request)
  | ({ type: 'query' } & Request)
);
export interface NativeSessionSearchBridge {
  present(state: NativeSessionSearchPresentation, opening: boolean): void;
  close(requestId: string): void;
  watchActions(listener: (action: NativeSessionSearchAction) => void): () => void;
}
export interface NativeSessionSearchOverlayBridge {
  watch(listener: (state: NativeSessionSearchState | null) => void): () => void;
  ready(): void;
  request(action: Exclude<NativeSessionSearchAction, { type: 'unavailable' }>): void;
}

declare global {
  interface Window {
    kiteNativeSessionSearch?: NativeSessionSearchBridge;
    kiteSessionSearchOverlay?: NativeSessionSearchOverlayBridge;
  }
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const keys = (value: Record<string, unknown>, allowed: string[]) =>
  Reflect.ownKeys(value).every(
    (key) =>
      typeof key === 'string' &&
      allowed.includes(key) &&
      'value' in Object.getOwnPropertyDescriptor(value, key)!,
  );
const text = (value: unknown): value is string => typeof value === 'string';
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export const nativeSessionSearchRequestId = (value: unknown): value is string =>
  text(value) && /^[a-z0-9-]{1,128}$/.test(value);
const rowId = (value: unknown): value is string => text(value) && value.length > 0;
const request = (value: Record<string, unknown>) =>
  text(value.query) && value.query.length <= 512 && count(value.page);
const row = (value: unknown) =>
  record(value) &&
  keys(value, ['key', 'session', 'workspaceLabel', 'location', 'updatedAtMs']) &&
  (value.updatedAtMs === undefined ||
    (typeof value.updatedAtMs === 'number' &&
      Number.isSafeInteger(value.updatedAtMs) &&
      Math.abs(value.updatedAtMs) <= 8_640_000_000_000_000)) &&
  rowId(value.key) &&
  text(value.workspaceLabel) &&
  (value.location === undefined || text(value.location)) &&
  record(value.session) &&
  keys(value.session, ['sessionId', 'displayName', 'status', 'pendingInteractions']) &&
  rowId(value.session.sessionId) &&
  text(value.session.displayName) &&
  text(value.session.status) &&
  (value.session.pendingInteractions === undefined || count(value.session.pendingInteractions));

export function isNativeSessionSearchPresentation(
  input: unknown,
): input is NativeSessionSearchPresentation {
  return (
    record(input) &&
    keys(input, [
      'requestId',
      'resultId',
      'available',
      'query',
      'page',
      'total',
      'resultPage',
      'rows',
    ]) &&
    nativeSessionSearchRequestId(input.requestId) &&
    nativeSessionSearchRequestId(input.resultId) &&
    request(input) &&
    typeof input.available === 'boolean' &&
    count(input.total) &&
    count(input.resultPage) &&
    input.resultPage ===
      Math.min(input.page as number, Math.max(0, Math.ceil(input.total / 50) - 1)) &&
    Array.isArray(input.rows) &&
    input.rows.length === Math.min(50, input.total - input.resultPage * 50) &&
    (input.available || (!input.total && !input.rows.length)) &&
    input.rows.every(row)
  );
}

export function isNativeSessionSearchState(input: unknown): input is NativeSessionSearchState {
  if (
    !record(input) ||
    !keys(input, [
      'requestId',
      'resultId',
      'available',
      'query',
      'page',
      'total',
      'resultPage',
      'rows',
      'theme',
    ])
  )
    return false;
  const { theme, ...presentation } = input;
  return (theme === 'light' || theme === 'dark') && isNativeSessionSearchPresentation(presentation);
}

export function isNativeSessionSearchAction(input: unknown): input is NativeSessionSearchAction {
  if (!record(input) || !nativeSessionSearchRequestId(input.requestId)) return false;
  if (input.type === 'select')
    return (
      keys(input, ['type', 'requestId', 'resultId', 'sessionId', 'query', 'page']) &&
      nativeSessionSearchRequestId(input.resultId) &&
      rowId(input.sessionId) &&
      request(input)
    );
  if (input.type === 'query')
    return keys(input, ['type', 'requestId', 'query', 'page']) && request(input);
  return (
    keys(input, ['type', 'requestId']) && (input.type === 'close' || input.type === 'unavailable')
  );
}
