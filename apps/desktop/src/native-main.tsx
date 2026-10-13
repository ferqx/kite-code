import { createRoot } from 'react-dom/client';
import { NativeDesktop } from './native';

import { applyTheme, readThemePreference } from './native-theme';
import './native-tailwind.css';
import './native-startup.css';
import '@kite-ai/ui/desktop/style.css';

declare const __KITE_DESKTOP_TEST_DIAGNOSTICS__: boolean;

if (/Macintosh|Mac OS X/i.test(navigator.userAgent))
  document.documentElement.dataset.platform = 'macos';
applyTheme(readThemePreference());
createRoot(document.getElementById('root')!).render(
  <NativeDesktop
    testDiagnostics={
      typeof __KITE_DESKTOP_TEST_DIAGNOSTICS__ !== 'undefined' &&
      __KITE_DESKTOP_TEST_DIAGNOSTICS__ === true
    }
  />,
);
