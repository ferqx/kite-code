// Isolated Mac acceptance fixture. Production code has no test enable switch.
import { copyFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { app, ipcMain, WebContentsView } from 'electron';
import { createNativeImageDisplayHost } from '../electron/image-display-host';
import { LocalFilePreview } from '../electron/local-file-preview';
import { createNativeImageGalleryHost } from '../electron/native-image-gallery-host';
import { createNativeRootWindow } from '../electron/native-root-window';
import { NativeOutputPreview, registerOutputPreviewScheme } from '../electron/output-preview';

registerOutputPreviewScheme();
const directory = process.env.KITE_DISPLAY_FIXTURE_DIRECTORY!,
  url = process.env.KITE_DISPLAY_FIXTURE_URL!;
app.setPath('userData', join(directory, 'profile'));
app.on('window-all-closed', () => app.quit());
void app.whenReady().then(async () => {
  const window = createNativeRootWindow({
    width: 1280,
    height: 900,
    title: 'Kite Image Display Acceptance',
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
  gallery.prewarm();
  const preview = new NativeOutputPreview();
  let allowed = true;
  let local: LocalFilePreview | undefined;
  Object.assign(globalThis, {
    imageDisplayMain: {
      window,
      async output(path: string, localSource: boolean, width = 820) {
        preview.close();
        local?.release();
        local = undefined;
        allowed = true;
        const check = () => {
          if (!allowed) throw Error('fixture_scope_revoked');
        };
        if (localSource)
          local = await LocalFilePreview.create(async (consume) => {
            check();
            await consume(path);
          }, check);
        const handle = local;
        await preview.open({
          id: 'image',
          generation: 1,
          window,
          bounds: { x: 420, y: 70, width, height: 780 },
          check,
          verifyAccess: handle ? () => handle.verifyAccess() : async () => check(),
          ...(localSource
            ? { localHandleId: handle!.id }
            : {
                target: {
                  storeId: 'store',
                  sessionId: 'session',
                  fileId: 'fixture-file',
                  locator: {
                    kind: 'delivery' as const,
                    key: 'delivery/00000000000000000001/job/image',
                  },
                },
              }),
          materialize: handle
            ? (dest, signal) => handle.materialize(dest, signal)
            : async (dest) => {
                await copyFile(path, dest);
                return {
                  name: basename(path),
                  size: String((await stat(path)).size),
                  mediaType: 'application/octet-stream',
                };
              },
        });
        preview.present({
          previewId: 'image',
          generation: 1,
          presentationRevision: 1,
          bounds: { x: 420, y: 70, width, height: 780, radius: 0 },
        });
      },
      async zoom(value: import('../src/image-zoom').ImageZoomControl['value']) {
        return (await preview.control('image', 1, { kind: 'image-zoom', value }))?.zoom;
      },
      revoke() {
        allowed = false;
      },
      close() {
        preview.close();
        local?.release();
        local = undefined;
      },
      views() {
        return window.contentView.children.flatMap((view) =>
          'webContents' in view
            ? [
                {
                  url: (view as WebContentsView).webContents.getURL(),
                  id: (view as WebContentsView).webContents.id,
                  pid: (view as WebContentsView).webContents.getOSProcessId(),
                  visible: view.getVisible(),
                },
              ]
            : [],
        );
      },
      async dispose() {
        preview.dispose();
        local?.release();
        gallery.dispose();
        await display.dispose();
      },
    },
  });
  await window.loadURL(url);
  window.show();
  window.focus();
});

declare global {
  var imageDisplayMain: {
    window: ReturnType<typeof createNativeRootWindow>;
    output(path: string, localSource: boolean, width?: number): Promise<void>;
    zoom(
      value: import('../src/image-zoom').ImageZoomControl['value'],
    ): Promise<import('../src/image-zoom').ImageZoomState | undefined>;
    revoke(): void;
    close(): void;
    views(): { url: string; id: number; pid: number; visible: boolean }[];
    dispose(): Promise<void>;
  };
}
