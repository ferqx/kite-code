import { createRoot } from 'react-dom/client';
import { App } from './App';
import { DesktopClient } from './client';
import { applyTheme, readThemePreference } from './theme';
import './tailwind.css';
import '@kite-ai/kite-client-ui/style.css';

const macOS = /Macintosh|Mac OS X/i.test(navigator.userAgent);
if (macOS) document.documentElement.dataset.platform = 'macos';

applyTheme(readThemePreference());

const client = new DesktopClient();
createRoot(document.getElementById('root')!).render(<App client={client} />);
