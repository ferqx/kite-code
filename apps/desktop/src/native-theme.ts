import { useLayoutEffect, useState } from 'react';
import type { NativeThemePreference } from './native-bridge';

export type ThemePreference = NativeThemePreference;
const themeKey = 'kite.desktop.theme';

export function readThemePreference(): ThemePreference {
  try {
    const saved = window.localStorage.getItem(themeKey);
    if (saved === 'dark' || saved === 'light') return saved;
  } catch {
    // Restricted storage still permits changing appearance for this window.
  }
  return 'system';
}

export function applyTheme(preference: ThemePreference) {
  const dark =
    preference === 'dark' ||
    (preference === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
}

/** Original desktop appearance preference; no legacy Host or bridge dependency. */
export function useNativeTheme() {
  const [preference, setPreference] = useState<ThemePreference>(readThemePreference);
  useLayoutEffect(() => {
    applyTheme(preference);
    void window.kiteNative?.setTheme?.(preference).catch(console.error);
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    const update = () => applyTheme(preference);
    if (preference === 'system') media?.addEventListener('change', update);
    return () => media?.removeEventListener('change', update);
  }, [preference]);
  return {
    value: preference,
    onChange(value: ThemePreference) {
      try {
        window.localStorage.setItem(themeKey, value);
      } catch {
        /* Current-window preference remains usable. */
      }
      setPreference(value);
    },
  };
}
