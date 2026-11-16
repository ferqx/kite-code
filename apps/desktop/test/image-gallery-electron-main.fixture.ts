// Explicit Electron test entrypoint; ordinary Native applications do not import it.

import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, ipcMain, WebContentsView } from 'electron';
import { registerNativeBrowserIpc } from '../electron/native-browser';
import { createNativeGlobalDialogHost } from '../electron/native-global-dialog-host';
import { createNativeImageGalleryHost } from '../electron/native-image-gallery-host';
import { createNativeRootWindow } from '../electron/native-root-window';
import { NativeOutputPreview, registerOutputPreviewScheme } from '../electron/output-preview';
import { nativeBrowserLayoutChannel } from '../src/native-browser-bridge';
import {
  nativeImageGalleryEventChannel,
  nativeImageGalleryPresentChannel,
  nativeImageGalleryStateChannel,
} from '../src/native-image-gallery-bridge';
import {
  nativePreviewLayoutChannel,
  parseNativePreviewLayout,
} from '../src/native-preview-layout-bridge';

registerOutputPreviewScheme();
const directory = process.env.KITE_GALLERY_FIXTURE_DIRECTORY!,
  url = process.env.KITE_GALLERY_FIXTURE_URL!;
app.setPath('userData', join(directory, 'profile'));
app.on('window-all-closed', () => app.quit());
void app.whenReady().then(async () => {
  const window = createNativeRootWindow({
    width: 1440,
    height: 900,
    title: 'Kite Image Gallery Isolated Electron',
    show: true,
    webPreferences: {
      preload: join(directory, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const galleryTrace: {
    at: number;
    type: string;
    selectedId?: string;
    status?: string;
    bytes?: number;
    action?: string;
    revision?: string;
  }[] = [];
  const createModalView = (kind: 'image-gallery' | 'global-dialog') => {
    const view = new WebContentsView({
      webPreferences: {
        preload: join(directory, `${kind}-preload.cjs`),
        partition: `gallery-fixture-${kind}-${randomUUID()}`,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        webviewTag: false,
        devTools: false,
        navigateOnDragDrop: false,
        disableDialogs: true,
      },
    });
    if (kind === 'image-gallery') {
      const send = view.webContents.send;
      view.webContents.send = function (channel, ...args) {
        if (channel === nativeImageGalleryStateChannel) {
          const state = args[0];
          galleryTrace.push({
            at: Date.now(),
            type: 'viewer-state',
            selectedId: state?.selectedId,
            status: state?.image?.status,
            bytes: state?.image?.bytes?.byteLength,
            revision: state?.image?.revision,
          });
        }
        return Reflect.apply(send, this, [channel, ...args]);
      };
    }
    const isolated = view.webContents.session;
    isolated.on('will-download', (event) => event.preventDefault());
    isolated.setPermissionCheckHandler(() => false);
    isolated.setPermissionRequestHandler((_contents, _permission, complete) => complete(false));
    isolated.webRequest.onHeadersReceived((details, complete) =>
      complete({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-src 'none'",
          ],
        },
      }),
    );
    isolated.webRequest.onBeforeRequest((details, complete) => {
      let allowed = false;
      try {
        const target = new URL(details.url);
        allowed =
          target.origin === new URL(url).origin ||
          (kind === 'image-gallery' && target.protocol === 'blob:');
      } catch {}
      complete({ cancel: !allowed });
    });
    return view;
  };
  const gallery = createNativeImageGalleryHost({
    window,
    ipcMain,
    rootUrl: url,
    url: new URL('image-gallery.html', url).href,
    theme: () => 'dark',
    createView: () => createModalView('image-gallery'),
  });
  const confirmation = createNativeGlobalDialogHost({
    window,
    ipcMain,
    url: new URL('global-dialog.html', url).href,
    theme: () => 'dark',
    createView: () => createModalView('global-dialog'),
  });
  gallery.prewarm();
  confirmation.prewarm();
  const preview = new NativeOutputPreview();
  const calls: unknown[] = [];
  let originalHash: string | undefined;
  ipcMain.on(nativeImageGalleryEventChannel, (_event, input) =>
    galleryTrace.push({
      at: Date.now(),
      type: 'viewer-action',
      action: input?.type,
      selectedId: input?.id,
    }),
  );
  ipcMain.on(nativeImageGalleryPresentChannel, (_event, input) => {
    galleryTrace.push({
      at: Date.now(),
      type: 'root-present',
      selectedId: input?.selectedId,
      status: input?.image?.status,
      bytes: input?.image?.bytes?.byteLength,
      revision: input?.image?.revision,
    });
    if (input?.image?.status === 'ready')
      originalHash = createHash('sha256').update(input.image.bytes).digest('hex');
  });
  const stop = registerNativeBrowserIpc({ ipcMain, window, rendererUrl: url });
  ipcMain.on(nativeBrowserLayoutChannel, (_event, value) =>
    calls.push({ kind: 'browser', value, at: Date.now() }),
  );
  function present(value: unknown) {
    const request = parseNativePreviewLayout(value);
    calls.push({ kind: 'preview', value: request, at: Date.now() });
    preview.present(request);
    return {
      ok: true as const,
      value: { previewId: request.previewId, generation: request.generation },
    };
  }
  ipcMain.on(nativePreviewLayoutChannel, (event, value) => {
    try {
      event.returnValue = present(value);
    } catch (e) {
      event.returnValue = { ok: false, code: e instanceof Error ? e.message : 'unavailable' };
    }
  });
  ipcMain.handle(nativePreviewLayoutChannel, (_event, value) => present(value));
  const text =
    'Native document preview\n\nThis is an actual separate WebContentsView.\nIt must remain visible underneath the native image gallery,\nincluding during resize and native presentation wakes.';
  await preview.open({
    id: 'fixture-office',
    generation: 1,
    bounds: { x: 1000, y: 120, width: 400, height: 700 },
    window,
    check() {},
    async materialize(destination) {
      await writeFile(destination, text);
      return {
        name: 'gallery-document.txt',
        mediaType: 'text/plain',
        size: String(Buffer.byteLength(text)),
      };
    },
  });
  let secondary: ReturnType<typeof createNativeRootWindow> | undefined;
  Object.assign(globalThis, {
    galleryMain: {
      window,
      trace() {
        return galleryTrace;
      },
      clearTrace() {
        galleryTrace.length = 0;
      },
      async openOther() {
        secondary = createNativeRootWindow({
          width: 460,
          height: 340,
          title: 'Kite Gallery Isolation Second Window',
          show: true,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
        });
        await secondary.loadURL(
          'data:text/html,<meta charset=utf-8><body style="background:%2323343a;color:white;font:22px sans-serif;padding:32px"><h2>Second native window</h2><p>No gallery belongs here.</p></body>',
        );
        secondary.show();
        secondary.focus();
        secondary.webContents.focus();
        app.focus({ steal: true });
      },
      closeOther() {
        secondary?.close();
        secondary = undefined;
        window.focus();
        app.focus({ steal: true });
      },
      gallery,
      confirmation,
      confirm() {
        void confirmation.confirm(
          { kind: 'full-permission', language: 'zh' },
          new AbortController().signal,
        );
      },
      calls,
      snapshot() {
        return {
          calls,
          secondary:
            secondary && !secondary.isDestroyed()
              ? {
                  focused: secondary.isFocused(),
                  mediaSourceId: secondary.getMediaSourceId(),
                  views: secondary.contentView.children.map((view) => ({
                    visible: view.getVisible(),
                    ...('webContents' in view
                      ? { url: (view as Electron.WebContentsView).webContents.getURL() }
                      : {}),
                  })),
                }
              : undefined,
          originalHash,
          windowContentSize: window.getContentSize(),
          rootZoom: window.webContents.getZoomFactor(),
          views: window.contentView.children.map((view, index) => ({
            index,
            visible: view.getVisible(),
            bounds: view.getBounds(),
            ...('webContents' in view
              ? {
                  id: (view as Electron.WebContentsView).webContents.id,
                  focused: (view as Electron.WebContentsView).webContents.isFocused(),
                  url: (view as Electron.WebContentsView).webContents.getURL(),
                }
              : {}),
          })),
        };
      },
      wake() {
        window.webContents.send('kite:native:browser-presentation', true);
        window.webContents.send('kite:native:preview-presentation', true);
      },
      dispose() {
        secondary?.close();
        gallery.dispose();
        confirmation.dispose();
        preview.dispose();
        stop();
      },
    },
  });
  await window.loadURL(url);
  window.show();
  window.focus();
  app.focus({ steal: true });
});
