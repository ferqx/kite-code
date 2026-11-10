import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, nativeTheme } from 'electron';
import { nativeTrajectoryOfflineFileChannel } from '../src/native-trajectory-file-bridge';
import { type DesktopDevelopment, desktopContentSecurityPolicy } from './development';
import { registerNativeTrajectoryFileIpc } from './trajectory-file-ipc';
import { NativeTrajectoryFiles } from './trajectory-files';

/** Cold package opening is an independent Main owner and does not open the selected profile. */
export function createTrajectoryOfflineWindow(input: {
  development?: DesktopDevelopment | null;
  initialPath?: string;
  onClosed?(): void;
}) {
  let initialPath = input.initialPath;
  const files = new NativeTrajectoryFiles();
  const url = input.development
    ? new URL('trajectory.html', input.development.rendererUrl).href
    : pathToFileURL(join(app.getAppPath(), 'trajectory.html')).href;
  const window = new BrowserWindow({
    title: 'Kite · 轨迹重放',
    width: 1050,
    height: 800,
    minWidth: 640,
    minHeight: 480,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#191919' : '#fafafa',
    webPreferences: {
      preload: join(app.getAppPath(), 'trajectory-preload.cjs'),
      partition: `kite-trajectory-${randomUUID()}`,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, target) => {
    if (target !== url) event.preventDefault();
  });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, complete) =>
    complete(false),
  );
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.session.on('will-download', (event) => event.preventDefault());
  window.webContents.session.webRequest.onHeadersReceived((details, complete) =>
    complete({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [desktopContentSecurityPolicy(input.development ?? null)],
      },
    }),
  );
  window.webContents.session.webRequest.onBeforeRequest((details, complete) => {
    let allowed = false;
    try {
      const target = new URL(details.url),
        base = new URL('.', url);
      allowed =
        base.protocol === 'file:'
          ? target.protocol === 'file:' && target.href.startsWith(base.href)
          : target.origin === base.origin ||
            (target.protocol === 'ws:' && target.host === base.host);
    } catch {}
    complete({ cancel: !allowed });
  });
  registerNativeTrajectoryFileIpc({
    ipcMain,
    channel: nativeTrajectoryOfflineFileChannel,
    window: () => (window.isDestroyed() ? undefined : window),
    rendererUrl: url,
    files,
    async pickPath() {
      if (initialPath) {
        const path = initialPath;
        initialPath = undefined;
        return path;
      }
      const selected = await dialog.showOpenDialog(window, {
        title: '打开轨迹包',
        properties: ['openFile'],
        filters: [{ name: 'Kite trajectory', extensions: ['kite-trajectory'] }],
      });
      return !selected.canceled && selected.filePaths.length === 1 ? selected.filePaths[0]! : null;
    },
    async exportSnapshot() {
      throw Error('offline_operation_unavailable');
    },
  });
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= files.close());
  window.once('closed', () => {
    ipcMain.removeHandler(nativeTrajectoryOfflineFileChannel);
    void close().then(
      () => input.onClosed?.(),
      () => {},
    );
  });
  window.once('ready-to-show', () => window.show());
  const ready = window.loadURL(url);
  // Retain the original load failure for the owner without an unhandled background rejection.
  void ready.catch(() => {});
  return {
    window,
    ready,
    async open(path?: string) {
      await ready;
      if (path) {
        initialPath = path;
        await window.loadURL(url);
      }
      window.show();
      window.focus();
    },
    async close() {
      await close();
      if (!window.isDestroyed()) window.destroy();
    },
  };
}
