import { createRoot } from 'react-dom/client';
import { installNativeInputModality } from './native-input-modality';

import { applyTheme, readThemePreference } from './native-theme';
import './native-tailwind.css';
import './native-startup.css';
import '@kite-ai/ui/desktop/style.css';

declare const __KITE_DESKTOP_TEST_DIAGNOSTICS__: boolean;

document.documentElement.dataset.nativeWindow = 'true';
installNativeInputModality(document);
if (/Macintosh|Mac OS X/i.test(navigator.userAgent))
  document.documentElement.dataset.platform = 'macos';
else if (/Windows/i.test(navigator.userAgent))
  document.documentElement.dataset.platform = 'windows';
const root = createRoot(document.getElementById('root')!);
if (window.kiteBrowserChrome) {
  document.documentElement.dataset.browserChrome = 'true';
  const { NativeBrowserChromeRenderer } = await import('./native-browser-chrome-renderer');
  root.render(<NativeBrowserChromeRenderer />);
} else {
  applyTheme(readThemePreference());
  const appearance = await window.kiteNative?.getWindowAppearance?.().catch(() => undefined);
  document.documentElement.dataset.windowMaterial = appearance?.backgroundMaterial ?? 'none';
  const { NativeDesktop } = await import('./native');
  root.render(
    <NativeDesktop
      nativeWindow
      testDiagnostics={
        typeof __KITE_DESKTOP_TEST_DIAGNOSTICS__ !== 'undefined' &&
        __KITE_DESKTOP_TEST_DIAGNOSTICS__ === true
      }
    />,
  );
}
