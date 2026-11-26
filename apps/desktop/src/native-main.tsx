import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { installNativeInputModality } from './native-input-modality';
import { NativeStartupFrame } from './native-startup-frame';

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
applyTheme(readThemePreference());
document.documentElement.dataset.windowMaterial = 'none';
flushSync(() => root.render(<NativeStartupFrame loading />));
void applyWindowMaterial();

async function applyWindowMaterial() {
  try {
    const appearance = await window.kiteNative?.getWindowAppearance?.();
    document.documentElement.dataset.windowMaterial = appearance?.backgroundMaterial ?? 'none';
  } catch {
    // Window material is optional. The theme supplies the background.
  }
}

async function loadDesktop() {
  try {
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
  } catch {
    root.render(
      <NativeStartupFrame loading={false}>
        <p role="alert">启动未完成：桌面界面加载失败。</p>
        <button
          type="button"
          className="button"
          data-slot="button"
          onClick={() => location.reload()}
        >
          重新尝试
        </button>
      </NativeStartupFrame>,
    );
  }
}

// Let the window present the startup shell before the workspace CSS and scripts load.
if (document.readyState === 'complete') void loadDesktop();
else window.addEventListener('load', loadDesktop, { once: true });
