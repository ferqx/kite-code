import { createRoot } from 'react-dom/client';
import { NativeDesktop } from './native';
import { applyTheme, readThemePreference } from './native-theme';
import './native-tailwind.css';
import '@kite-ai/ui/desktop/style.css';

if (/Macintosh|Mac OS X/i.test(navigator.userAgent))
  document.documentElement.dataset.platform = 'macos';
applyTheme(readThemePreference());
createRoot(document.getElementById('root')!).render(<NativeDesktop />);
