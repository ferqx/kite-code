import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OutputFileSummary, OutputFileTarget } from '@kite-ai/client';
import {
  app,
  nativeImage,
  protocol,
  screen,
  session,
  WebContentsView,
  type WebFrameMain,
  webContents,
} from 'electron';
import { filePreviewFormat } from '../src/file-preview-format';
import { type ImageZoomControl, validateImageZoom } from '../src/image-zoom';
import {
  assertPanelMeasurement,
  type NativeBrowserBounds,
  type NativeBrowserLayout,
  projectNativeBrowserLayout,
} from '../src/native-content-geometry';
import type { NativeImageDisplayMediaType } from '../src/native-image-display-bridge';
import {
  type NativePreviewLayoutRequest,
  nativePreviewPresentationChannel,
  type OfficePreviewFrameClosed,
  officePreviewFrameClosedChannel,
} from '../src/native-preview-layout-bridge';
import type {
  LocalOfficePreviewInteraction,
  OfficeEditContext,
  OfficeInlineRequest,
  OfficeRequestOutcome,
} from '../src/output-files-bridge';
import { officeSelectionLabel } from '../src/output-files-bridge';
import {
  imageDisplayDocument,
  imageDisplayMediaType,
  imageDisplayReadingEdge,
} from './image-display-document';
import { createImageDisplayRegionResource } from './image-display-region-resource';
import { renderImageDisplay } from './image-display-service';
import { imageDisplayViewportScript } from './image-display-viewport';
import { isolatedOfficeDocumentCss } from './isolated-preview-chrome';
import { localPdfRegionPixels } from './local-preview-submit';
import { nativeContentBounds, watchNativeContentWindow } from './native-content-layout';
import { waitForNativeFrame } from './native-frame-readiness';
import { addNativeWindowView, focusNativeWindowContent } from './native-overlay-layer';
import { getNativeRootView, type NativeRootWindow } from './native-root-window';
import {
  createOfficeFrameWorld,
  leaseOfficePreviewFrame,
  newOfficePreviewOrigin,
  officePreviewScheme,
} from './office-preview-frame';
import {
  type OfficePreviewControl,
  officeInteractionControlScript,
  officeInteractionPeekScript,
  officeInteractionReadScript,
  officeInteractionReleaseScript,
  officeInteractionWorld,
} from './office-preview-interaction';
import { type OfficePreviewKind, readOfficeDescription } from './office-preview-trust';
import { officePreviewZoomInstallScript } from './office-preview-zoom';
import { NativeOfficeRequestView } from './office-request-view';
import { createPdfPageCache } from './pdf-page-cache';
import { type PdfTextLayer, pdfPreviewHtml, pdfPreviewInstallScript } from './pdf-preview';
import {
  escapePreviewText,
  markdownPreview,
  previewDocument,
  previewUtf8,
} from './static-file-preview';

/** Registered before app.ready; never a general filesystem or network scheme. */
export function registerOutputPreviewScheme() {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'kite-preview', privileges: { standard: true, secure: true, supportFetchAPI: true } },
    {
      scheme: officePreviewScheme,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
    },
  ]);
}
type Resource = {
  load?: () => Promise<Buffer>;
  path: string;
  absolutePath: string;
  mimeType: string;
  sha256: string;
  size: number;
};
type Bounds = { x: number; y: number; width: number; height: number };
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const csp =
  "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; media-src 'none'; worker-src 'none'";
const officeCsp = csp
  .replace("script-src 'self' 'unsafe-inline'", "script-src 'none'")
  .replace("connect-src 'none'", "connect-src 'self'");
const officePreviews = {
  word: { source: 'document.docx', script: 'docx-preview.js' },
  excel: { source: 'workbook.xlsx', script: 'xlsx-preview.js' },
  powerpoint: { source: 'presentation.pptx', script: 'pptx-preview.js' },
};

/** One admitted preview per Root. Resources come only from the active manifest. */
export class NativeOutputPreview {
  private active?: {
    id: string;
    generation: number;
    target?: OutputFileTarget;
    localHandleId?: string;
    bounds: Bounds;
    nativeBounds?: Bounds;
    presentationRevision: number;
    presentationError?: string;
    presentation?: { bounds: NativeBrowserBounds; layout?: NativeBrowserLayout };
    projection?: { bounds: NativeBrowserBounds; layout: NativeBrowserLayout };
    sourceHash?: string;
    hostedImage?: boolean;
    pdf?: boolean;
    pdfPageCount?: number;
    loadPdfPage?: (page: number) => Promise<Buffer>;
    pdfLayers?: Map<number, PdfTextLayer>;
    check?: () => void;
    officeKind?: OfficePreviewKind;
    abort: AbortController;
    view?: WebContentsView;
    frame?: ReturnType<typeof leaseOfficePreviewFrame>;
    frameDocument?: WebFrameMain;
    frameWorld?: ReturnType<typeof createOfficeFrameWorld>;
    frameReady?: Promise<void>;
    frameVisibilityChanged?: () => void;
    frameBoot?: (world: ReturnType<typeof createOfficeFrameWorld>) => Promise<void>;
    layout?: { sync: () => void; dispose: () => void };
    directory?: string;
    pending?: boolean;
    checkTimer?: ReturnType<typeof setInterval>;
    window: NativeRootWindow;
    latestRequestId?: string;
    request?: {
      id: string;
      view: NativeOfficeRequestView;
      context: OfficeEditContext;
      ready: boolean;
      serial: number;
      documentRequestSerial: number;
      retiring?: Promise<void>;
      requestId?: string;
      prompt?: string;
    };
  };
  async open(input: {
    id: string;
    generation: number;
    target?: OutputFileTarget;
    localHandleId?: string;
    bounds: Bounds;
    initialControls?: OfficePreviewControl[];
    window: NativeRootWindow;
    check: () => void;
    verifyAccess?: () => Promise<void>;
    renderPdfPage?: (
      page: number,
      signal: AbortSignal,
    ) => Promise<{ data: string; totalPages: number; textLayer?: PdfTextLayer }>;
    materialize: (
      destination: string,
      signal: AbortSignal,
    ) => Promise<Pick<OutputFileSummary, 'name' | 'mediaType' | 'size'> & { sourceHash?: string }>;
  }) {
    this.close();
    const active = {
      id: input.id,
      generation: input.generation,
      target: structuredClone(input.target),
      bounds: { ...input.bounds },
      abort: new AbortController(),
      window: input.window,
      localHandleId: input.localHandleId,
      pending: true,
      presentationRevision: 0,
      check: input.check,
    } as NonNullable<NativeOutputPreview['active']>;
    this.active = active;
    const current = () => {
      input.check();
      active.abort.signal.throwIfAborted();
      if (this.active !== active) throw Error('preview_replaced');
    };
    try {
      active.directory = await mkdtemp(join(tmpdir(), 'kite-output-preview-'));
      current();
      const source = join(active.directory, 'source');
      const file = await input.materialize(source, active.abort.signal);
      current();
      if (file.sourceHash && /^[a-f0-9]{64}$/.test(file.sourceHash))
        active.sourceHash = file.sourceHash;
      else {
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(source, { signal: active.abort.signal }))
          hash.update(chunk);
        active.sourceHash = hash.digest('hex');
      }
      current();
      const kind = /\.docx$/i.test(file.name)
        ? 'word'
        : /\.xlsx$/i.test(file.name)
          ? 'excel'
          : /\.pptx$/i.test(file.name)
            ? 'powerpoint'
            : undefined;
      active.officeKind = kind;
      const office = kind ? officePreviews[kind] : undefined;
      let files: Resource[], entry: string;
      let hostedImageScript: string | undefined;
      let imageSource:
        | { mediaType: NativeImageDisplayMediaType; width: number; height: number }
        | undefined;
      if (office) {
        if (BigInt(file.size) > 128n * 1024n * 1024n) throw Error('preview_office_source_budget');
        const html = Buffer.from(
          `<!doctype html><html lang="zh-CN" class="kite-office-preview-document"><meta charset="utf-8"><style>${isolatedOfficeDocumentCss}</style><body><div id="office-preview" data-editable="${Boolean(active.target)}"></div></body></html>`,
        );
        const path = join(active.directory, 'index.html');
        await writeFile(path, html, { flag: 'wx' });
        files = [
          {
            path: 'index.html',
            absolutePath: path,
            mimeType: 'text/html',
            size: html.length,
            sha256: digest(html),
          },
          {
            path: office.source,
            absolutePath: source,
            mimeType: 'application/octet-stream',
            size: Number(file.size),
            sha256: active.sourceHash!,
          },
        ];
        entry = 'index.html';
      } else if (file.mediaType === 'application/pdf' || /\.pdf$/i.test(file.name)) {
        if (!input.renderPdfPage) throw Error('preview_pdf_unavailable');
        const render = input.renderPdfPage;
        let textBytes = 0;
        active.pdfLayers = new Map();
        const first = await render(1, active.abort.signal);
        current();
        const html = Buffer.from(pdfPreviewHtml(first.totalPages));
        active.pdf = true;
        active.pdfPageCount = first.totalPages;
        active.officeKind = 'pdf';
        const path = join(active.directory, 'index.html');
        await writeFile(path, html, { flag: 'wx' });
        files = [
          {
            path: 'index.html',
            absolutePath: path,
            mimeType: 'text/html',
            size: html.length,
            sha256: digest(html),
          },
        ];
        const loadPage = createPdfPageCache(
          first,
          render,
          active.abort.signal,
          current,
          undefined,
          (page, value) => {
            const source = value ?? {
              status: 'unavailable' as const,
              width: 1,
              height: 1,
              items: [],
            };
            const bytes = Buffer.byteLength(JSON.stringify(source));
            const layer =
              textBytes + bytes <= 16 * 1024 * 1024
                ? source
                : { ...source, status: 'unavailable' as const, items: [] };
            textBytes += Buffer.byteLength(JSON.stringify(layer));
            active.pdfLayers!.set(page, layer);
          },
        );
        active.loadPdfPage = loadPage;
        for (let page = 1; page <= first.totalPages; page++) {
          files.push({
            path: `page-${page}.png`,
            absolutePath: '',
            mimeType: 'image/png',
            size: 0,
            sha256: '',
            load: () => loadPage(page),
          });
        }
        entry = 'index.html';
      } else if (
        ['markdown', 'text', 'code', 'unknown'].includes(
          filePreviewFormat(file.name, file.mediaType),
        )
      ) {
        if (BigInt(file.size) > 2n * 1024n * 1024n) throw Error('preview_text_budget');
        const text = previewUtf8(await readFile(source));
        if (text === undefined)
          throw Error(
            filePreviewFormat(file.name, file.mediaType) === 'unknown'
              ? 'preview_format_unavailable'
              : 'preview_text_encoding_unavailable',
          );
        const html = Buffer.from(
          filePreviewFormat(file.name, file.mediaType) === 'markdown'
            ? markdownPreview(text)
            : previewDocument(`<pre>${escapePreviewText(text)}</pre>`),
        );
        const path = join(active.directory, 'index.html');
        await writeFile(path, html, { flag: 'wx' });
        files = [
          {
            path: 'index.html',
            absolutePath: path,
            mimeType: 'text/html',
            size: html.length,
            sha256: digest(html),
          },
        ];
        entry = 'index.html';
      } else if (filePreviewFormat(file.name, file.mediaType) === 'image') {
        const display = await renderImageDisplay({
          source: { path: source },
          mediaType: imageDisplayMediaType(file.name, file.mediaType),
          edge: imageDisplayReadingEdge(
            input.bounds,
            screen.getDisplayMatching(input.window.getBounds()).scaleFactor,
          ),
          signal: active.abort.signal,
        });
        current();
        await input.verifyAccess?.();
        current();
        imageSource = {
          mediaType: imageDisplayMediaType(file.name, file.mediaType),
          width: display.sourceWidth,
          height: display.sourceHeight,
        };
        // Only the bounded display copy enters the manifest. The materialized original
        // remains private and its hash/output identity is never replaced by this copy.
        const image = join(active.directory, 'display-image');
        await writeFile(image, display.bytes, { flag: 'wx', mode: 0o600 });
        current();
        active.hostedImage = !!active.target;
        if (active.hostedImage) hostedImageScript = imageDisplayViewportScript(display, true);
        const html = Buffer.from(imageDisplayDocument(display, active.hostedImage));
        const path = join(active.directory, 'index.html');
        await writeFile(path, html, { flag: 'wx', mode: 0o600 });
        files = [
          {
            path: 'index.html',
            absolutePath: path,
            mimeType: 'text/html',
            size: html.length,
            sha256: digest(html),
          },
          {
            path: 'image',
            absolutePath: image,
            mimeType: display.mimeType,
            size: display.bytes.length,
            sha256: digest(display.bytes),
          },
        ];
        entry = 'index.html';
      } else throw Error('preview_format_unavailable');
      current();
      const framed = !!office || active.pdf === true;
      const origin = framed ? newOfficePreviewOrigin() : `kite-preview://${randomUUID()}`;
      const regions = imageSource
        ? createImageDisplayRegionResource({
            origin,
            source,
            ...imageSource,
            signal: active.abort.signal,
            check: current,
            verifyAccess: input.verifyAccess,
          })
        : undefined;
      const manifest = new Map(
        files.map((file) => [
          `${origin}/${file.path.split('/').map(encodeURIComponent).join('/')}`,
          file,
        ]),
      );
      const accepts = (url: string) => manifest.has(url.split('#')[0]!) || !!regions?.accepts(url);
      const rootUrl = framed ? new URL(input.window.webContents.getURL()) : undefined;
      const frameAncestor = rootUrl?.protocol === 'file:' ? 'file:' : rootUrl?.origin;
      const resourcePolicy = framed
        ? `${officeCsp.replaceAll("'self'", origin)}; sandbox allow-scripts; frame-ancestors ${frameAncestor}`
        : csp;
      const respond = async (request: Request) => {
        const resource = manifest.get(request.url.split('#')[0]!);
        if (
          (!resource && !regions?.accepts(request.url)) ||
          this.active !== active ||
          request.method !== 'GET'
        )
          return new Response(null, { status: 403 });
        try {
          current();
          if (!resource && regions) {
            const display = await regions.load(request.url, request.signal);
            current();
            return new Response(new Uint8Array(display.bytes).buffer, {
              headers: {
                'Content-Type': display.mimeType,
                'Content-Security-Policy': csp,
                'X-Content-Type-Options': 'nosniff',
                'Cache-Control': 'no-store',
              },
            });
          }
          if (!resource) return new Response(null, { status: 403 });
          const bytes = resource.load
            ? await resource.load()
            : await readFile(resource.absolutePath);
          if (
            !resource.load &&
            (bytes.length !== resource.size || digest(bytes) !== resource.sha256)
          )
            throw Error('preview_integrity_failed');
          current();
          return new Response(new Uint8Array(bytes).buffer, {
            headers: {
              'Content-Type': resource.mimeType,
              'Content-Security-Policy': resourcePolicy,
              ...(framed ? { 'Access-Control-Allow-Origin': 'null' } : {}),
              'X-Content-Type-Options': 'nosniff',
              'Cache-Control': 'no-store',
            },
          });
        } catch {
          return new Response(null, { status: 410 });
        }
      };
      let verifying = false;
      let lastVerified = 0;
      active.checkTimer = setInterval(() => {
        if (active.frameDocument) {
          try {
            if (active.frame?.resolve() !== active.frameDocument) throw Error('preview_replaced');
          } catch {
            if (this.active === active) this.close(active.id, 'interrupted');
            return;
          }
        }
        try {
          current();
          if (input.verifyAccess && !verifying && Date.now() - lastVerified > 2000) {
            verifying = true;
            lastVerified = Date.now();
            void input
              .verifyAccess()
              .catch(() => {
                if (this.active === active) this.close(active.id, 'access');
              })
              .finally(() => {
                verifying = false;
              });
          }
        } catch {
          if (this.active === active) this.close(active.id, 'access');
        }
      }, 250);
      if (framed) {
        const frame = leaseOfficePreviewFrame(
          input.window.webContents,
          origin,
          entry,
          accepts,
          respond,
        );
        active.frame = frame;
        const syncFrame = () => {
          if (this.active !== active || active.window.isDestroyed()) return;
          active.frameVisibilityChanged?.();
          const next = this.measureNativeBounds(active);
          active.nativeBounds = next;
          if (next) active.request?.view.bounds(next);
          active.request?.view.visible(
            !!next && active.window.isVisible() && !active.window.isMinimized(),
          );
        };
        active.layout = {
          sync: syncFrame,
          dispose: watchNativeContentWindow(input.window, getNativeRootView(input.window), {
            resize: syncFrame,
            hide: syncFrame,
            minimize: syncFrame,
            show: syncFrame,
            restore: syncFrame,
          }),
        };
        active.frameBoot = async (world) => {
          current();
          if (office) {
            const script = await readFile(join(app.getAppPath(), office.script), 'utf8');
            current();
            await world.evaluate(script);
            const result =
              await world.evaluate(`Promise.resolve(globalThis.kiteOfficePreviewReady).catch(error =>
              ['preview_office_archive_invalid', 'preview_office_archive_budget'].includes(error?.message)
                ? error.message : false)`);
            if (
              result === 'preview_office_archive_invalid' ||
              result === 'preview_office_archive_budget'
            )
              throw Error(result);
            if (result !== true) throw Error('preview_office_not_ready');
            const initialControls = input.initialControls ?? [];
            if (initialControls.length > 4) throw Error('preview_control_invalid');
            for (const command of initialControls) {
              current();
              await world.evaluate(officeInteractionControlScript(command));
            }
          } else {
            await world.evaluate(pdfPreviewInstallScript());
          }
          current();
          await world.evaluate(`(() => {
            for (const type of ['keydown', 'pointerdown', 'pointerup', 'click', 'dblclick',
              'contextmenu', 'wheel', 'touchmove']) {
              window.addEventListener(type, event => {
                if (!globalThis.kiteOfficeInputBlocked) return;
                event.preventDefault();
                event.stopImmediatePropagation();
              }, { capture: true, passive: false });
            }
          })()`);
          current();
          await world.evaluate(officePreviewZoomInstallScript());
          current();
        };
        return { kind: 'outputs.preview' as const, status: 'frame' as const, url: frame.url };
      }
      const previewSession = session.fromPartition(`kite-output-${randomUUID()}`, { cache: false });
      previewSession.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      );
      previewSession.setPermissionCheckHandler(() => false);
      previewSession.on('will-download', (event) => event.preventDefault());
      previewSession.webRequest.onBeforeRequest((details, callback) =>
        callback({ cancel: !accepts(details.url) }),
      );
      await previewSession.protocol.handle('kite-preview', respond);
      current();
      const view = new WebContentsView({
        webPreferences: {
          session: previewSession,
          nodeIntegration: false,
          nodeIntegrationInSubFrames: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          allowRunningInsecureContent: false,
        },
      });
      view.setVisible(false);
      active.view = view;
      // While the small request view is open, keep its original selection and page still.
      view.webContents.on('before-input-event', (event) => {
        if (active.request) event.preventDefault();
      });
      view.webContents.on('before-mouse-event', (event) => {
        if (active.request) event.preventDefault();
      });
      view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      view.webContents.on('will-navigate', (event) => event.preventDefault());
      view.webContents.on('will-frame-navigate', (event) => event.preventDefault());
      view.webContents.on('will-redirect', (event) => event.preventDefault());
      view.webContents.on('will-attach-webview', (event) => event.preventDefault());
      let drawable = false;
      let contentReady = false;
      type PreviewPaint = { controller: AbortController; stop?: () => void; restore?: () => void };
      let paint: PreviewPaint | undefined;
      const cancelPaint = () => {
        const job = paint;
        paint = undefined;
        job?.controller.abort();
        job?.stop?.();
        job?.restore?.();
      };
      const covered = () => {
        const root = getNativeRootView(input.window);
        const [width = 0, height = 0] = input.window.getContentSize();
        const children = input.window.contentView.children;
        return (
          !!root &&
          root.getVisible() &&
          ['x', 'y', 'width', 'height'].every(
            (key) =>
              Reflect.get(root.getBounds(), key) ===
              Reflect.get({ x: 0, y: 0, width, height }, key),
          ) &&
          children.indexOf(view) >= 0 &&
          children.indexOf(view) < children.indexOf(root)
        );
      };
      const prepareFrame = () => {
        if (
          paint ||
          drawable ||
          active.presentationError ||
          !contentReady ||
          !active.nativeBounds ||
          !active.presentation ||
          !input.window.isVisible() ||
          input.window.isMinimized()
        )
          return;
        const root = getNativeRootView(input.window);
        if (!root) return;
        const contents = view.webContents,
          frame = contents.mainFrame,
          rootFrame = input.window.webContents.mainFrame,
          bounds = { ...active.nativeBounds },
          job = { controller: new AbortController() } as PreviewPaint;
        paint = job;
        const currentPaint = () => {
          if (
            paint !== job ||
            this.active !== active ||
            active.abort.signal.aborted ||
            job.controller.signal.aborted ||
            input.window.isDestroyed() ||
            contents.isDestroyed() ||
            input.window.webContents.isDestroyed() ||
            !input.window.isVisible() ||
            input.window.isMinimized() ||
            !active.presentation ||
            contents.mainFrame !== frame ||
            input.window.webContents.mainFrame !== rootFrame ||
            JSON.stringify(active.nativeBounds) !== JSON.stringify(bounds) ||
            !covered()
          )
            return false;
          try {
            active.check?.();
            return true;
          } catch {
            return false;
          }
        };
        void (async () => {
          try {
            const children = input.window.contentView.children;
            const rootIndex = children.indexOf(root);
            const viewIndex = children.indexOf(view);
            // A cancelled paint can leave the view below Root. Reinserting at
            // Root's old index moves it above Root before its new frame is ready.
            if (rootIndex >= 0 && (viewIndex < 0 || viewIndex >= rootIndex))
              addNativeWindowView(input.window, view, rootIndex);
            if (!currentPaint()) throw Error('preview_paint_cancelled');
            if (process.platform === 'win32') {
              const before = contents.getBackgroundThrottling();
              job.restore = () => {
                job.restore = undefined;
                if (!contents.isDestroyed()) contents.setBackgroundThrottling(before);
              };
              contents.setBackgroundThrottling(false);
            }
            view.setVisible(true);
            await waitForNativeFrame({
              contents,
              bounds,
              signal: job.controller.signal,
              cancelled: Error('preview_paint_cancelled'),
              current: currentPaint,
              cancel: () => job.controller.abort(),
              setStop: (stop) => {
                job.stop = stop;
              },
              ownsStop: (stop) => job.stop === stop,
            });
            if (!currentPaint()) throw Error('preview_paint_cancelled');
            drawable = true;
            paint = undefined;
            addNativeWindowView(
              input.window,
              view,
              input.window.contentView.children.indexOf(root),
            );
            sync();
          } catch (error) {
            const failed =
              currentPaint() &&
              !(error instanceof Error && error.message === 'preview_paint_cancelled');
            if (paint === job) {
              paint = undefined;
              if (!contents.isDestroyed()) view.setVisible(false);
              if (failed) {
                active.presentationError = 'preview_paint_failed';
                if (!input.window.webContents.isDestroyed())
                  input.window.webContents.send(nativePreviewPresentationChannel, true);
              }
            }
          } finally {
            job.restore?.();
          }
        })();
      };
      const sync = () => {
        if (
          this.active !== active ||
          active.abort.signal.aborted ||
          input.window.isDestroyed() ||
          view.webContents.isDestroyed()
        )
          return;
        const [width = 0, height = 0] = input.window.getContentSize();
        const zoom = input.window.webContents.getZoomFactor();
        const anchor = active.projection ?? active.presentation;
        const projected =
          anchor?.layout &&
          projectNativeBrowserLayout(anchor.bounds, anchor.layout, width / zoom, height / zoom);
        if (projected) active.projection = projected;
        const cssBounds = anchor?.layout ? projected?.bounds : anchor?.bounds;
        const next = cssBounds && nativeContentBounds(cssBounds, zoom, width, height);
        const withdrawing = !next && !!active.nativeBounds;
        active.nativeBounds = next;
        if (next) {
          const previous = view.getBounds();
          if (JSON.stringify(previous) !== JSON.stringify(next)) {
            cancelPaint();
            view.setBounds(next);
          }
          active.request?.view.bounds(next);
          view.setBorderRadius(
            Math.floor(
              Math.min(
                Math.round((cssBounds?.radius ?? 0) * zoom),
                next.width / 2,
                next.height / 2,
              ),
            ),
          );
        }
        const visible =
          !!next && drawable && input.window.isVisible() && !input.window.isMinimized();
        if (!next) cancelPaint();
        if (!(paint && covered())) view.setVisible(visible);
        active.request?.view.visible(visible);
        if (withdrawing) {
          // AppKit can drop the child responder before the resize callback. Only
          // repair a vacant key window, after both native views have withdrawn.
          setImmediate(() => {
            if (
              this.active === active &&
              !active.nativeBounds &&
              !input.window.isDestroyed() &&
              input.window.isFocused() &&
              !webContents.getFocusedWebContents()
            )
              focusNativeWindowContent(input.window, input.window.webContents);
          });
        }
        if (next && !drawable) prepareFrame();
      };
      const hide = () => {
        if (this.active !== active || active.abort.signal.aborted || view.webContents.isDestroyed())
          return;
        cancelPaint();
        drawable = false;
        active.presentation = undefined;
        active.projection = undefined;
        view.setVisible(false);
        active.request?.view.visible(false);
      };
      const resume = () => {
        hide();
        if (!input.window.webContents.isDestroyed())
          input.window.webContents.send(nativePreviewPresentationChannel, true);
      };
      const dispose = watchNativeContentWindow(input.window, getNativeRootView(input.window), {
        resize: sync,
        hide: () => {
          if (!input.window.isVisible() || input.window.isMinimized()) hide();
        },
        minimize: () => {
          if (input.window.isMinimized()) hide();
        },
        show: resume,
        restore: resume,
      });
      active.layout = {
        sync,
        dispose: () => {
          cancelPaint();
          dispose();
        },
      };
      sync();
      // A first navigation in an attached hidden WebContentsView can take AppKit's
      // keyboard responder before dom-ready. Load detached; presenting is not a focus request.
      await view.webContents.loadURL(`${origin}/${entry}`);
      current();
      addNativeWindowView(input.window, view);
      if (hostedImageScript) {
        await view.webContents.executeJavaScriptInIsolatedWorld(officeInteractionWorld, [
          { code: hostedImageScript },
        ]);
        current();
      }
      current();
      contentReady = true;
      sync();
      return { kind: 'outputs.preview' as const, status: 'ready' as const };
    } catch (error) {
      if (this.active === active) this.close(input.id);
      throw error;
    } finally {
      active.pending = false;
      if (this.active !== active && active.directory)
        await rm(active.directory, { recursive: true, force: true }).catch(() => {});
    }
  }
  private measureNativeBounds(active: NonNullable<NativeOutputPreview['active']>) {
    const [width = 0, height = 0] = active.window.getContentSize();
    const zoom = active.window.webContents.getZoomFactor();
    const anchor = active.projection ?? active.presentation;
    const projected =
      anchor?.layout &&
      projectNativeBrowserLayout(anchor.bounds, anchor.layout, width / zoom, height / zoom);
    if (projected) active.projection = projected;
    const bounds = anchor?.layout ? projected?.bounds : anchor?.bounds;
    return bounds && nativeContentBounds(bounds, zoom, width, height);
  }
  async attachFrame(id: string, generation: number) {
    const active = this.active;
    if (!active?.frame || active.id !== id || active.generation !== generation)
      throw Error('preview_replaced');
    active.check?.();
    if (!active.frameReady) {
      const boot = active.frameBoot!;
      const frame = active.frame.resolve();
      active.frameReady = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const visibility = Promise.withResolvers<void>();
        const deadline = Promise.withResolvers<never>();
        const signal = active.abort.signal;
        const abort = () => deadline.reject(signal.reason);
        try {
          signal.addEventListener('abort', abort, { once: true });
          active.frameVisibilityChanged = () => {
            if (!active.window.isVisible() || active.window.isMinimized()) {
              clearTimeout(timer);
              timer = undefined;
              return;
            }
            visibility.resolve();
            timer ??= setTimeout(() => deadline.reject(Error('preview_office_timeout')), 60000);
          };
          active.frameVisibilityChanged();
          await Promise.race([visibility.promise, deadline.promise]);
          signal.throwIfAborted();
          const world = createOfficeFrameWorld(active.window.webContents, active.frame!.url, () => {
            if (this.active === active) this.close(id, 'interrupted');
          });
          active.frameWorld = world;
          await Promise.race([world.initialize().then(() => boot(world)), deadline.promise]);
          if (this.active !== active || frame !== active.frame!.resolve())
            throw Error('preview_replaced');
          active.frameDocument = frame;
          active.frameBoot = undefined;
        } catch (error) {
          if (this.active === active) this.close(id);
          throw error;
        } finally {
          signal.removeEventListener('abort', abort);
          active.frameVisibilityChanged = undefined;
          clearTimeout(timer);
        }
      })();
    }
    await active.frameReady;
    if (this.active !== active) throw Error('preview_replaced');
    active.check?.();
    return { kind: 'outputs.preview' as const, status: 'ready' as const };
  }
  private runPreview<T = unknown>(
    active: NonNullable<NativeOutputPreview['active']>,
    code: string,
  ): Promise<T> {
    if (this.active !== active) throw Error('preview_replaced');
    if (active.frame) {
      active.check?.();
      const frame = active.frame.resolve();
      if (frame !== active.frameDocument) throw Error('preview_replaced');
      return active.frameWorld!.evaluate<T>(code);
    }
    if (!active.view) throw Error('preview_replaced');
    return active.view.webContents.executeJavaScriptInIsolatedWorld(officeInteractionWorld, [
      { code },
    ]);
  }
  private async releaseDocumentRequest(
    active: NonNullable<NativeOutputPreview['active']>,
    serial: number,
  ) {
    if (this.active !== active || active.abort.signal.aborted) return;
    try {
      await this.runPreview(active, officeInteractionReleaseScript(serial));
      if (active.frame) await this.runPreview(active, 'globalThis.kiteOfficeInputBlocked = false');
    } catch (error) {
      // Retiring the entire preview destroys its controller; no acknowledgement is needed.
      if (this.active === active && !active.abort.signal.aborted) throw error;
    }
  }
  private retireRequest(
    active: NonNullable<NativeOutputPreview['active']>,
    request: NonNullable<NonNullable<NativeOutputPreview['active']>['request']>,
  ): Promise<void> {
    if (request.retiring) return request.retiring;
    request.ready = false;
    request.view.close();
    // Keep ownership while the exact controller serial is being released. A concurrent
    // read cannot create a new form in the acknowledgement gap.
    request.retiring = this.releaseDocumentRequest(active, request.documentRequestSerial).then(
      () => {
        if (active.request !== request) return;
        active.request = undefined;
        if (
          this.active === active &&
          !active.abort.signal.aborted &&
          active.window.isFocused() &&
          active.nativeBounds &&
          (active.frameDocument || active.view?.getVisible())
        ) {
          focusNativeWindowContent(
            active.window,
            active.view?.webContents ?? active.window.webContents,
          );
          if (active.frameDocument) void this.runPreview(active, 'window.focus()').catch(() => {});
        }
      },
    );
    return request.retiring;
  }
  async readInteraction(id: string, generation: number, consumeRequest = true) {
    if (!this.active?.target) throw Error('local_preview_readonly');
    return this.readInteractionState(id, generation, consumeRequest);
  }
  async readLocalInteraction(
    id: string,
    generation: number,
    handleId: string,
    consumeRequest = true,
  ): Promise<LocalOfficePreviewInteraction> {
    const active = this.active;
    if (
      !active ||
      !(active.pdf || active.officeKind) ||
      active.target ||
      active.localHandleId !== handleId ||
      active.id !== id ||
      active.generation !== generation ||
      active.pending
    )
      throw Error('local_preview_readonly');
    if (!active.pdf) {
      const evidence = await this.runPreview(active, officeInteractionPeekScript);
      if (this.active !== active || active.abort.signal.aborted) throw Error('preview_replaced');
      const { zoom } = readOfficeDescription(evidence, active.officeKind, active.sourceHash);
      return {
        selection: null,
        zoom,
        handleId,
        previewId: id,
        generation,
        sourceHash: active.sourceHash!,
      };
    }
    const { target: _target, ...result } = await this.readInteractionState(
      id,
      generation,
      consumeRequest,
    );
    if (this.active !== active) throw Error('preview_replaced');
    return { ...result, handleId };
  }
  async readLocalPdfSelectionImage(
    id: string,
    generation: number,
    handleId: string,
    sourceHash: string,
    selection: Extract<NonNullable<OfficeEditContext['selection']>, { kind: 'pdf' }>,
  ): Promise<Buffer | undefined> {
    const active = this.active;
    if (
      !active?.loadPdfPage ||
      active.id !== id ||
      active.generation !== generation ||
      active.localHandleId !== handleId ||
      active.sourceHash !== sourceHash ||
      active.target
    )
      throw Error('local_preview_replaced');
    if (selection.scope === 'text') return undefined;
    const page = await active.loadPdfPage(selection.page);
    if (this.active !== active) throw Error('local_preview_replaced');
    if (selection.scope === 'page') return page;
    const image = nativeImage.createFromBuffer(page);
    const clipped = image.crop(localPdfRegionPixels(selection, image.getSize())).toPNG();
    if (!clipped.length || clipped.length > 16 * 1024 * 1024)
      throw Error('local_preview_selection_unavailable');
    return clipped;
  }
  private async readInteractionState(id: string, generation: number, consumeRequest = true) {
    const active = this.active;
    if (
      !active ||
      active.id !== id ||
      active.generation !== generation ||
      (!active.frameDocument && !active.view) ||
      active.pending
    )
      throw Error('preview_replaced');
    let pdfPage: number | undefined;
    if (active.pdf) {
      const page = await this.runPreview<number>(active, 'globalThis.kitePdfPreview?.page()');
      if (!Number.isSafeInteger(page) || page < 1 || page > (active.pdfPageCount ?? 500))
        throw Error('preview_selection_replaced');
      pdfPage = page;
      const layer = active.pdfLayers?.get(page);
      if (layer)
        await this.runPreview(
          active,
          `globalThis.kitePdfPreview?.setLayer(${JSON.stringify(page)},${JSON.stringify(layer)})`,
        );
    }
    const evidence = await this.runPreview(
      active,
      consumeRequest ? officeInteractionReadScript : officeInteractionPeekScript,
    );
    if (this.active !== active || active.abort.signal.aborted) throw Error('preview_replaced');
    const result = readOfficeDescription(evidence, active.officeKind, active.sourceHash);
    for (const selection of [result.selection, result.floatingSelection]) {
      if (selection?.kind !== 'pdf') continue;
      if (selection.page !== pdfPage) throw Error('preview_selection_replaced');
      if (selection.scope !== 'text') continue;
      const items = active.pdfLayers?.get(selection.page)?.items;
      const start = selection.start!,
        end = selection.end!;
      if (
        !items ||
        start.item > end.item ||
        !items[start.item] ||
        !items[end.item] ||
        start.offset > items[start.item]!.text.length ||
        end.offset > items[end.item]!.text.length ||
        (start.item === end.item && start.offset >= end.offset) ||
        items
          .slice(start.item, end.item + 1)
          .map((item, i) =>
            item.text.slice(
              i === 0 ? start.offset : 0,
              i === end.item - start.item ? end.offset : undefined,
            ),
          )
          .join('') !== selection.text
      )
        throw Error('preview_selection_replaced');
    }
    if (result.requestInvalidated !== undefined) {
      const request = active.request;
      if (request?.documentRequestSerial === result.requestInvalidated)
        await this.retireRequest(active, request);
      else if (!request) await this.releaseDocumentRequest(active, result.requestInvalidated);
      if (this.active !== active || active.abort.signal.aborted) throw Error('preview_replaced');
    }
    if (
      consumeRequest &&
      result.floatingRequest &&
      result.floatingSelection &&
      result.floatingRequest !== result.requestInvalidated
    ) {
      if (!active.request) {
        const view = new NativeOfficeRequestView(
          active.window,
          result.requestAnchor ?? { x: 12, y: 12, width: 0, height: 0 },
        );
        const request: NonNullable<NonNullable<NativeOutputPreview['active']>['request']> = {
          id: randomUUID(),
          view,
          context: {
            sourceHash: active.sourceHash!,
            selection: structuredClone(result.floatingSelection),
          },
          ready: false,
          documentRequestSerial: result.floatingRequest,
          serial: 0,
        };
        active.request = request;
        active.latestRequestId = request.id;
        active.layout?.sync();
        const selection = request.context.selection!;
        const label = `请求修改 · ${officeSelectionLabel(selection)}`;
        try {
          if (active.frame)
            await this.runPreview(active, 'globalThis.kiteOfficeInputBlocked = true');
          await view.open(active.nativeBounds ?? active.bounds, label);
          if (
            this.active !== active ||
            active.abort.signal.aborted ||
            active.request !== request ||
            request.retiring
          )
            throw Error('preview_replaced');
          request.ready = true;
          active.layout?.sync();
        } catch (error) {
          await this.retireRequest(active, request);
          throw error;
        }
      }
    }
    const request = active.request;
    let inlineRequest: OfficeInlineRequest | undefined;
    if (request?.ready) {
      if (result.requestAnchor)
        request.view.bounds(active.nativeBounds ?? active.bounds, result.requestAnchor);
      const input = await request.view.read();
      if (
        this.active !== active ||
        active.abort.signal.aborted ||
        active.request !== request ||
        request.retiring
      )
        throw Error('preview_replaced');
      if (input.cancelled) {
        await this.retireRequest(active, request);
      } else if (input.pending) {
        const pending = input.pending;
        if (
          !Number.isSafeInteger(pending.serial) ||
          pending.serial < 1 ||
          typeof pending.prompt !== 'string' ||
          !pending.prompt.trim() ||
          pending.prompt.length > 16000
        )
          throw Error('preview_request_invalid');
        // The page may have reflowed or lost its frozen sheet/page while input was awaited.
        // Re-read only descriptive invalidation; never replace the captured context or target.
        const latest = await this.runPreview(active, officeInteractionPeekScript);
        if (
          this.active !== active ||
          active.abort.signal.aborted ||
          active.request !== request ||
          request.retiring
        )
          throw Error('preview_replaced');
        const fresh = readOfficeDescription(latest, active.officeKind, active.sourceHash);
        if (fresh.requestInvalidated === request.documentRequestSerial) {
          await this.retireRequest(active, request);
        } else {
          if (pending.serial > request.serial) {
            request.serial = pending.serial;
            request.requestId = randomUUID();
            request.prompt = pending.prompt;
          }
          if (request.requestId)
            inlineRequest = {
              requestId: request.requestId,
              prompt: request.prompt!,
              context: structuredClone(request.context),
            };
        }
      }
    }
    if (this.active !== active || active.abort.signal.aborted) throw Error('preview_replaced');
    // Controller lifetime acknowledgement is Main-only, not a new renderer protocol field.
    delete result.requestInvalidated;
    return {
      ...result,
      ...(inlineRequest ? { inlineRequest } : {}),
      requestOpen: !!active.request,
      previewId: active.id,
      generation: active.generation,
      sourceHash: active.sourceHash!,
      target: structuredClone(active.target!),
    };
  }
  async settleRequest(
    id: string,
    generation: number,
    requestId: string,
    outcome: OfficeRequestOutcome,
  ) {
    const active = this.active;
    if (
      !active ||
      active.id !== id ||
      active.generation !== generation ||
      active.abort.signal.aborted
    )
      throw Error('preview_replaced');
    const request = active.request;
    if (!request || request.requestId !== requestId) throw Error('preview_request_replaced');
    await request.view.settle(request.serial, outcome);
    if (outcome.status === 'accepted' && request.retiring) {
      // The accepted input marks itself cancelled before its JS acknowledgement
      // returns. A concurrent read may already have retired this exact form.
      // Join that retirement, not a new submission or an arbitrary closed view.
      await request.retiring;
      if (
        this.active === active &&
        !active.abort.signal.aborted &&
        !active.request &&
        active.latestRequestId === request.id
      )
        return;
      throw Error('preview_request_replaced');
    }
    if (
      this.active !== active ||
      active.abort.signal.aborted ||
      active.request !== request ||
      request.retiring
    )
      throw Error('preview_request_replaced');
    if (outcome.status === 'accepted') await this.retireRequest(active, request);
  }
  isLocal(id: string, generation: number) {
    const active = this.active;
    return !!active && active.id === id && active.generation === generation && !active.target;
  }
  async control(id: string, generation: number, command: OfficePreviewControl | ImageZoomControl) {
    const active = this.active;
    if (
      !active ||
      active.id !== id ||
      active.generation !== generation ||
      (!active.frameDocument && !active.view) ||
      active.pending
    )
      throw Error('preview_replaced');
    active.check?.();
    if (command.kind === 'image-zoom') {
      if (!active.target || !active.hostedImage || !active.view)
        throw Error('preview_control_invalid');
      validateImageZoom(command);
      const state = await active.view.webContents.executeJavaScriptInIsolatedWorld(
        officeInteractionWorld,
        [{ code: `globalThis.kiteImageZoom(${JSON.stringify(command.value)})` }],
      );
      if (this.active !== active || active.abort.signal.aborted) throw Error('preview_replaced');
      active.check?.();
      if (
        typeof state?.fit !== 'boolean' ||
        !Number.isFinite(state.scale) ||
        state.scale <= 0 ||
        state.scale > 8 ||
        !Number.isFinite(state.minimum) ||
        state.minimum <= 0 ||
        state.minimum > 0.01
      )
        throw Error('preview_control_invalid');
      return {
        kind: 'outputs.preview.imageZoom' as const,
        zoom: {
          fit: state.fit as boolean,
          scale: state.scale as number,
          minimum: state.minimum as number,
        },
      };
    }
    if (active.hostedImage !== undefined) throw Error('preview_control_invalid');
    const code = officeInteractionControlScript(command);
    if (!active.target && !(active.pdf && active.localHandleId) && command.kind !== 'zoom')
      throw Error('local_preview_readonly');
    if (active.pdf && !['zoom', 'request-edit'].includes(command.kind))
      throw Error('preview_control_invalid');
    if (active.request) {
      if (command.kind === 'request-edit') return;
      throw Error('preview_request_active');
    }
    if (command.kind === 'locate-selection') {
      const evidence = await this.runPreview(active, officeInteractionPeekScript);
      if (this.active !== active || active.abort.signal.aborted || active.pending)
        throw Error('preview_replaced');
      if (active.request) throw Error('preview_request_active');
      const current = readOfficeDescription(evidence, active.officeKind, active.sourceHash);
      if (current.floatingRequest) throw Error('preview_request_active');
      if (current.excelSelection?.selectionSerial !== command.selectionSerial)
        throw Error('preview_selection_replaced');
    }
    await this.runPreview(
      active,
      active.pdf
        ? `globalThis.kitePdfPreview?.control(${JSON.stringify(command)})`
        : !active.officeKind && command.kind === 'zoom'
          ? `document.documentElement.style.zoom = ${JSON.stringify(command.value === 'fit' ? '1' : String(command.value))}`
          : code,
    );
    if (this.active !== active || active.abort.signal.aborted) throw Error('preview_replaced');
    return undefined;
  }
  dispose() {
    this.close();
  }
  /** Trusted Root geometry commits, ordered independently of async conversion or page reads. */
  present(request: NativePreviewLayoutRequest) {
    const active = this.active;
    if (
      !active ||
      active.id !== request.previewId ||
      active.generation !== request.generation ||
      active.abort.signal.aborted
    )
      throw Error('preview_replaced');
    active.check?.();
    if (request.bounds && active.presentationError) throw Error(active.presentationError);
    if (request.presentationRevision <= active.presentationRevision)
      throw Error('preview_layout_stale');
    let presentation: typeof active.presentation;
    if (request.bounds && active.window.isVisible() && !active.window.isMinimized()) {
      const [width = 0, height = 0] = active.window.getContentSize();
      const zoom = active.window.webContents.getZoomFactor();
      try {
        if (request.layout)
          assertPanelMeasurement(request.bounds, request.layout, width / zoom, height / zoom);
      } catch {
        throw Error('preview_layout_stale');
      }
      presentation = { bounds: { ...request.bounds }, layout: structuredClone(request.layout) };
    }
    // Reject a mixed old-DOM/new-window measurement before changing the last coherent anchor.
    active.presentationRevision = request.presentationRevision;
    active.presentation = presentation;
    active.projection = undefined;
    active.layout?.sync();
  }
  bounds(id: string, bounds: Bounds) {
    const active = this.active;
    if (active?.id !== id) return;
    active.bounds = { ...bounds };
    active.layout?.sync();
  }
  closeOwned(id: string, generation: number) {
    if (this.active?.generation === generation) this.close(id);
  }
  close(id?: string, reason?: OfficePreviewFrameClosed['reason']) {
    const active = this.active;
    if (!active || (id && active.id !== id)) return;
    this.active = undefined;
    active.abort.abort(Error('preview_closed'));
    active.frameWorld?.close();
    if (active.frame) {
      active.frame.close();
      const root = active.window.webContents;
      if (!root.isDestroyed()) {
        try {
          root.send(officePreviewFrameClosedChannel, {
            previewId: active.id,
            generation: active.generation,
            reason,
          } satisfies OfficePreviewFrameClosed);
        } catch {
          // Root can lose its renderer before sending the retirement notice.
        }
      }
    }
    active.layout?.dispose();
    active.request?.view.close();
    if (active.checkTimer) clearInterval(active.checkTimer);
    if (active.view) {
      if (!active.window.isDestroyed()) active.window.contentView.removeChildView(active.view);
      active.view.webContents.close();
    }
    if (active.directory && !active.pending)
      void rm(active.directory, { recursive: true, force: true }).catch(() => {});
  }
}
