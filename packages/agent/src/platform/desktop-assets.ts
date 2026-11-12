import { dirname, join } from 'node:path';

declare const __KITE_DESKTOP_ASSETS__: boolean;

/** Selected by the desktop runtime producer. The verified Bun is under runtime/. */
export function desktopAsset(path: string): string | undefined {
  if (typeof __KITE_DESKTOP_ASSETS__ !== 'undefined' && __KITE_DESKTOP_ASSETS__)
    return join(dirname(dirname(process.execPath)), path);
  return undefined;
}
