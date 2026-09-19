import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, nativeTheme } from 'electron';
import { DesktopHost } from './host';
import { registerDesktopIpc } from './ipc';
import { sameRendererDocument } from './security';

declare const __KITE_DESKTOP_SERVICE_MANIFEST__: unknown;

const DEVELOPMENT_RENDERER_URL = 'http://127.0.0.1:1420/';
const LEGACY_APP_DATA_DIRECTORY = 'dev.kite-code.desktop';

app.setName('kite');
app.setPath('userData', join(app.getPath('appData'), LEGACY_APP_DATA_DIRECTORY));

let mainWindow: BrowserWindow | undefined;
let exitAllowed = false;
let exitPromptOpen = false;
let quitInProgress = false;
let host: DesktopHost | undefined;

void app
  .whenReady()
  .then(async () => {
    const appPath = app.getAppPath();
    const rendererUrl = resolveRendererUrl(appPath, app.isPackaged);
    host = new DesktopHost({
      appDataDirectory: app.getPath('userData'),
      homeDirectory: app.getPath('home'),
      serviceDirectory: app.isPackaged
        ? join(process.resourcesPath, 'service')
        : join(appPath, 'service'),
      serviceManifest: __KITE_DESKTOP_SERVICE_MANIFEST__,
      ...(!app.isPackaged ? { sourceRepositoryRoot: resolve(appPath, '../..') } : {}),
    });
    mainWindow = createMainWindow(rendererUrl, app.isPackaged);
    registerDesktopIpc({
      ipcMain,
      host,
      getWindow: () => mainWindow,
      rendererUrl,
    });
    if (app.isPackaged) await mainWindow.loadFile(join(appPath, 'dist/index.html'));
    else await mainWindow.loadURL(rendererUrl);
  })
  .catch((error: unknown) => {
    dialog.showErrorBox('kite 无法启动', messageOf(error));
    app.exit(1);
  });

app.on('activate', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  }
});

app.on('before-quit', (event) => {
  if (exitAllowed) return;
  event.preventDefault();
  if (exitPromptOpen || quitInProgress) return;
  exitPromptOpen = true;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  }
  void showQuitConfirmation()
    .then(async (confirmed) => {
      exitPromptOpen = false;
      if (!confirmed) return;
      quitInProgress = true;
      try {
        await host?.quit();
        exitAllowed = true;
        app.quit();
      } catch (error) {
        quitInProgress = false;
        host?.cancelQuit();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show();
          await dialog.showMessageBox(mainWindow, {
            type: 'error',
            title: '服务收尾未正常完成',
            message: messageOf(error),
            buttons: ['确定'],
            noLink: true,
          });
        }
      }
    })
    .catch((error: unknown) => {
      exitPromptOpen = false;
      quitInProgress = false;
      dialog.showErrorBox('无法确认退出', messageOf(error));
    });
});

function createMainWindow(rendererUrl: string, packaged: boolean): BrowserWindow {
  const window = new BrowserWindow({
    title: 'kite',
    width: 1180,
    height: 800,
    minWidth: 760,
    minHeight: 540,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#191919' : '#fafafa',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 13, y: 19 } } : {}),
    webPreferences: {
      preload: join(app.getAppPath(), 'dist-electron/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: !packaged,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.on('will-navigate', (event, target) => {
    if (!sameRendererDocument(target, rendererUrl)) event.preventDefault();
  });
  window.webContents.on('did-start-navigation', (_event, target, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace && sameRendererDocument(target, rendererUrl))
      void host?.detachRenderer().catch(() => undefined);
  });
  window.webContents.on('render-process-gone', () => {
    void host?.detachRenderer().catch(() => undefined);
  });
  window.webContents.once('destroyed', () => {
    void host?.detachRenderer().catch(() => undefined);
  });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  window.webContents.session.setPermissionCheckHandler(() => false);
  const contentSecurityPolicy = [
    "default-src 'self'",
    // Vite injects the React Refresh preamble as an inline module in development.
    `script-src 'self'${packaged ? '' : " 'unsafe-inline'"}`,
    `connect-src 'self'${packaged ? '' : ' http://127.0.0.1:1420 ws://127.0.0.1:1420'}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  window.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...(details.responseHeaders ?? {}),
        'Content-Security-Policy': [contentSecurityPolicy],
      },
    });
  });
  window.once('ready-to-show', () => window.show());
  const updateSystemBackground = () => {
    if (!window.isDestroyed())
      window.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#191919' : '#fafafa');
  };
  nativeTheme.on('updated', updateSystemBackground);
  window.once('closed', () => nativeTheme.off('updated', updateSystemBackground));
  window.on('close', (event) => {
    if (exitAllowed) return;
    event.preventDefault();
    window.hide();
  });
  return window;
}

async function showQuitConfirmation(): Promise<boolean> {
  const options = {
    type: 'warning' as const,
    title: '退出 kite？',
    message: '退出会停止此应用中的任务，并等待服务清理。已经发生的修改不会撤销。',
    buttons: ['停止并退出', '返回'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    normalizeAccessKeys: true,
  };
  const result =
    mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showMessageBox(mainWindow, options)
      : await dialog.showMessageBox(options);
  return result.response === 0;
}

function resolveRendererUrl(appPath: string, packaged: boolean): string {
  if (packaged) return pathToFileURL(join(appPath, 'dist/index.html')).href;
  const value = process.env.KITE_DESKTOP_RENDERER_URL ?? DEVELOPMENT_RENDERER_URL;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('KITE_DESKTOP_RENDERER_URL 必须是固定的本机开发入口。');
  }
  if (
    parsed.protocol !== 'http:' ||
    parsed.hostname !== '127.0.0.1' ||
    parsed.port !== '1420' ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/'
  )
    throw new Error('KITE_DESKTOP_RENDERER_URL 必须是 http://127.0.0.1:1420/。');
  return parsed.href;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
