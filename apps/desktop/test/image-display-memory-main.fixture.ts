// No diagnostic surface is imported by production; all codecs and gallery hosts are production.
import { join } from 'node:path';
import { app, ipcMain, WebContentsView } from 'electron';
import { createNativeImageDisplayHost } from '../electron/image-display-host';
import { createNativeImageGalleryHost } from '../electron/native-image-gallery-host';
import { createNativeRootWindow } from '../electron/native-root-window';

const directory = process.env.KITE_MEMORY_DIRECTORY!,
  url = process.env.KITE_MEMORY_URL!;
app.setPath('userData', join(directory, 'profile'));
app.on('window-all-closed', () => app.quit());
void app.whenReady().then(async () => {
  const window = createNativeRootWindow({
    width: 1400,
    height: 1050,
    title: 'Kite Image Memory Acceptance',
    show: true,
    webPreferences: {
      preload: join(directory, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const display = createNativeImageDisplayHost({ window, rootUrl: url, ipcMain });
  const gallery = createNativeImageGalleryHost({
    window,
    ipcMain,
    rootUrl: url,
    url: new URL('image-gallery.html', url).href,
    theme: () => 'light',
    createView: () =>
      new WebContentsView({
        webPreferences: {
          preload: join(directory, 'image-gallery-preload.cjs'),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      }),
  });
  Object.assign(globalThis, {
    imageMemoryMain: {
      views: () =>
        window.contentView.children.flatMap((view) =>
          'webContents' in view
            ? [
                {
                  url: (view as WebContentsView).webContents.getURL(),
                  pid: (view as WebContentsView).webContents.getOSProcessId(),
                  visible: view.getVisible(),
                },
              ]
            : [],
        ),
      dispose() {
        gallery.dispose();
        display.dispose();
      },
    },
  });
  gallery.prewarm();
  await window.loadURL(url);
  window.show();
  window.focus();
});
declare global {
  var imageMemoryMain: {
    views(): { url: string; pid: number; visible: boolean }[];
    dispose(): void;
  };
}
