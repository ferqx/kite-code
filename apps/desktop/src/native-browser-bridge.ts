export const nativeBrowserChannel = 'kite:native:browser';
export const nativeBrowserEventChannel = 'kite:native:browser-state';

export interface NativeBrowserState {
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
export type NativeBrowserRequest =
  | { readonly action: 'navigate'; readonly id: string; readonly input: string }
  | { readonly action: 'present'; readonly id: string; readonly bounds: NativeBrowserBounds | null }
  | {
      readonly action: 'state' | 'back' | 'forward' | 'reload' | 'stop' | 'close';
      readonly id: string;
    };
export interface NativeBrowserBridge {
  browserRequest(request: NativeBrowserRequest): Promise<NativeBrowserState | null>;
  watchBrowser(listener: (state: NativeBrowserState) => void): () => void;
}
export type NativeBrowserReply =
  | { readonly ok: true; readonly value: NativeBrowserState | null }
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
export function parseNativeBrowserRequest(value: unknown): NativeBrowserRequest {
  const input = record(value);
  if (typeof input.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(input.id))
    throw Error('invalid_browser_request');
  const fields =
    input.action === 'navigate'
      ? ['action', 'id', 'input']
      : input.action === 'present'
        ? ['action', 'id', 'bounds']
        : ['action', 'id'];
  if (Object.keys(input).some((key) => !fields.includes(key)))
    throw Error('invalid_browser_request');
  if (input.action === 'navigate') {
    if (typeof input.input !== 'string') throw Error('invalid_browser_request');
    browserAddress(input.input);
  } else if (input.action === 'present') {
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
    !['state', 'back', 'forward', 'reload', 'stop', 'close'].includes(String(input.action))
  )
    throw Error('invalid_browser_request');
  return structuredClone(input) as NativeBrowserRequest;
}

export function isNativeBrowserState(value: unknown): value is NativeBrowserState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return (
    Object.keys(state).every((key) =>
      ['id', 'url', 'title', 'loading', 'canGoBack', 'canGoForward', 'error'].includes(key),
    ) &&
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
