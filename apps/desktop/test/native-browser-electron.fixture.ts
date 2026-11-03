import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { release } from 'node:os';
import { join, resolve, sep } from 'node:path';
import {
  app,
  ipcMain,
  shell,
  type WebContents,
  type WebContentsView,
  type WebFrameMain,
} from 'electron';
import { desktopContentSecurityPolicy } from '../electron/development';
import { registerNativeExternalLinks } from '../electron/external-links';
import { registerNativeBrowserIpc } from '../electron/native-browser';
import {
  createNativeRootWindow,
  getNativeRootView,
  type NativeRootWindow,
} from '../electron/native-root-window';

const directory = resolve(process.argv.at(-1)!);
// Match Native renderer/Main's platform and material CSS branches.
const platform =
  process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : undefined;
const material =
  process.platform === 'win32' && Number(release().split('.')[2]) >= 22621
    ? 'mica'
    : process.platform === 'darwin'
      ? 'vibrancy'
      : 'none';
app.setPath('userData', join(directory, 'profile'));
declare global {
  var browserTabsHostFixture: {
    window: NativeRootWindow;
    rootView: WebContentsView;
    origin: string;
    hits: Record<string, number>;
    externalUrls: string[];
    forwardExternal: boolean;
    retained?: { contents: WebContents; view: WebContentsView; frame: WebFrameMain };
  };
}
void app.whenReady().then(async () => {
  const hits: Record<string, number> = {};
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    hits[url.pathname] = (hits[url.pathname] ?? 0) + 1;
    if (url.pathname === '/') {
      response.setHeader('content-security-policy', desktopContentSecurityPolicy(null));
      response.setHeader('content-type', 'text/html');
      response.end(
        `<!doctype html><html data-theme="dark" data-native-window="true"${platform ? ` data-platform="${platform}"` : ''} data-window-material="${material}"><head><link rel="stylesheet" href="/browser-ui.css"></head><body><div id="root"></div><script type="module" src="/browser-ui.js"></script></body></html>`,
      );
    } else if (url.pathname === '/one' || url.pathname === '/two') {
      const title = url.pathname === '/one' ? 'Page One' : 'Page Two';
      response.setHeader('content-type', 'text/html');
      response.end(
        `<html><head><title>${title}</title></head><body><h1>${title}</h1><input id="retained" aria-label="Retained form"><a id="next" href="/two">Next</a><a id="file" href="file:///C:/private.txt">File</a><a id="popup" href="/two" target="_blank">Popup</a><a id="download" href="/download">Download</a><div style="height:1000px">Reading content</div><h2 id="reading">Retained reading position</h2><div style="height:1000px">More content</div></body></html>`,
      );
    } else if (url.pathname === '/download') {
      response.setHeader('content-disposition', 'attachment; filename="example.txt"');
      response.end('example');
    } else if (url.pathname === '/foreign') {
      response.setHeader('content-type', 'text/html');
      response.end('<html><body>Foreign window</body></html>');
    } else {
      const file = resolve(directory, `.${url.pathname}`);
      if (
        !file.startsWith(directory + sep) ||
        !existsSync(file) ||
        !/\.(?:js|css|woff2)$/.test(file)
      ) {
        response.statusCode = 404;
        response.end();
        return;
      }
      response.setHeader(
        'content-type',
        file.endsWith('.js')
          ? 'text/javascript'
          : file.endsWith('.css')
            ? 'text/css'
            : 'font/woff2',
      );
      response.end(readFileSync(file));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('fixture_server_missing');
  const origin = `http://127.0.0.1:${address.port}`;
  const window = createNativeRootWindow({
    width: 1280,
    height: 800,
    show: false,
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    webPreferences: {
      preload: join(directory, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  // The renderer supplies explicit Root-local draft owners. No Core selection
  // or Agent page/control authority is fabricated for this manual fixture.
  registerNativeBrowserIpc({ ipcMain, window, rendererUrl: `${origin}/` });
  registerNativeExternalLinks(window, `${origin}/`);
  const externalUrls: string[] = [];
  const openExternal = shell.openExternal.bind(shell);
  shell.openExternal = async (url, options) => {
    externalUrls.push(url);
    if (globalThis.browserTabsHostFixture.forwardExternal) await openExternal(url, options);
  };
  const rootView = getNativeRootView(window);
  if (!rootView || rootView.webContents !== window.webContents)
    throw Error('fixture_exact_root_view_missing');
  globalThis.browserTabsHostFixture = {
    rootView,
    window,
    origin,
    hits,
    externalUrls,
    forwardExternal: false,
  };
  await window.loadURL(`${origin}/`);
  app.once('will-quit', () => {
    server.closeAllConnections();
    server.close();
  });
});
