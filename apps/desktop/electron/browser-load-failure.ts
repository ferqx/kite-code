import type { NativeBrowserLoadFailure } from '../src/native-browser-bridge';

/** Chromium 152 net errors; keep native diagnostics out of the presentation state. */
export function browserLoadFailure(code: number, description: unknown): NativeBrowserLoadFailure {
  const kind =
    code <= -200 && code > -300
      ? 'certificate'
      : code === -105 || code === -137 || (code <= -800 && code > -900)
        ? 'dns'
        : code === -106
          ? 'offline'
          : code === -7 || code === -118
            ? 'timeout'
            : code === -107 || code === -113
              ? 'secure_connection'
              : (code <= -100 && code >= -104) || code === -109 || code === -130 || code === -111
                ? 'connection'
                : 'other';
  return {
    kind,
    ...(typeof description === 'string' && /^ERR_[A-Z0-9_]{1,60}$/.test(description)
      ? { code: description }
      : {}),
  };
}
