import { useLayoutEffect, useState } from 'react';

export type ThemePreference = 'dark' | 'light' | 'system';
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

export function useDesktopTheme() {
  const [preference, setPreference] = useState<ThemePreference>(readThemePreference);
  useLayoutEffect(() => {
    applyTheme(preference);
    void window.kiteDesktop?.setTheme(preference).catch(console.error);
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
        // Keep the current window usable when preference storage is unavailable.
      }
      setPreference(value);
    },
  };
}
