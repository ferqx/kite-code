import { createRoot } from 'react-dom/client';
import { NativeDesktop } from './native';

import { applyTheme, readThemePreference } from './native-theme';
import './native-tailwind.css';
import './native-startup.css';
import '@kite-ai/ui/desktop/style.css';

declare const __KITE_DESKTOP_TEST_DIAGNOSTICS__: boolean;

document.documentElement.dataset.nativeWindow = 'true';
if (/Macintosh|Mac OS X/i.test(navigator.userAgent))
  document.documentElement.dataset.platform = 'macos';
applyTheme(readThemePreference());
const appearance = await window.kiteNative?.getWindowAppearance?.().catch(() => undefined);
document.documentElement.dataset.windowMaterial = appearance?.backgroundMaterial ?? 'none';
createRoot(document.getElementById('root')!).render(
  <div className="native-window-frame">
    <div className="native-window-titlebar" aria-hidden="true" />
    <div className="native-window-content">
      <NativeDesktop
        testDiagnostics={
          typeof __KITE_DESKTOP_TEST_DIAGNOSTICS__ !== 'undefined' &&
          __KITE_DESKTOP_TEST_DIAGNOSTICS__ === true
        }
      />
    </div>
  </div>,
);
