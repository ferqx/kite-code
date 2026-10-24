import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve, sep } from 'node:path';
import { app, BrowserWindow, ipcMain } from 'electron';
import { desktopContentSecurityPolicy } from '../electron/development';
import { registerNativeBrowserIpc } from '../electron/native-browser';

const directory = resolve(process.argv.at(-1)!);
app.setPath('userData', join(directory, 'profile'));
declare global {
  var browserTabsHostFixture: {
    window: BrowserWindow;
    origin: string;
    hits: Record<string, number>;
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
        '<!doctype html><html data-theme="dark" data-native-window="true" data-platform="windows" data-window-material="mica"><head><link rel="stylesheet" href="/browser-ui.css"></head><body><div id="root"></div><script type="module" src="/browser-ui.js"></script></body></html>',
      );
    } else if (url.pathname === '/one' || url.pathname === '/two') {
      const title = url.pathname === '/one' ? 'Page One' : 'Page Two';
      response.setHeader('content-type', 'text/html');
      response.end(
        `<html><head><title>${title}</title></head><body><h1>${title}</h1><a id="next" href="/two">Next</a><a id="file" href="file:///C:/private.txt">File</a><a id="popup" href="/two" target="_blank">Popup</a><a id="download" href="/download">Download</a></body></html>`,
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
  const window = new BrowserWindow({
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
  registerNativeBrowserIpc({ ipcMain, window, rendererUrl: `${origin}/` });
  globalThis.browserTabsHostFixture = { window, origin, hits };
  await window.loadURL(`${origin}/`);
  app.once('will-quit', () => {
    server.closeAllConnections();
    server.close();
  });
});
