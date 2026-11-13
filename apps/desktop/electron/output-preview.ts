import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import {
  officeEnvironment,
  officePreviewRecipeVersion,
  officeRendererVersion,
  renderOfficePreview,
  verifyOfficeRuntimeAssets,
} from '@kite-ai/agent/documents';
import type { OutputFileSummary, OutputFileTarget } from '@kite-ai/client';
import { protocol, session, WebContentsView } from 'electron';
import type {
  OfficeEditContext,
  OfficeInlineRequest,
  OfficeRequestOutcome,
} from '../src/output-files-bridge';
import { officeSelectionLabel } from '../src/output-files-bridge';
import { addNativeWindowView, focusNativeWindowContent } from './native-overlay-layer';
import { NativeProcessOwner } from './native-processes';
import type { NativeRootWindow } from './native-root-window';
import {
  type OfficePreviewControl,
  officeInteractionControlScript,
  officeInteractionInstallScript,
  officeInteractionPeekScript,
  officeInteractionReadScript,
  officeInteractionReleaseScript,
  officeInteractionWorld,
} from './office-preview-interaction';
import { type OfficePreviewKind, readOfficeDescription } from './office-preview-trust';
import { NativeOfficeRequestView } from './office-request-view';

/** Registered before app.ready; never a general filesystem or network scheme. */
export function registerOutputPreviewScheme() {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'kite-preview', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}
type Resource = {
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
const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );

/** One isolated view per root. Converted resources are a closed manifest, never pathname joins. */
export class NativeOutputPreview {
  private readonly assetsRoot?: string;
  constructor(assetsRoot?: string) {
    this.assetsRoot = assetsRoot;
  }
  private readonly cache = new Map<
    string,
    { directory: string; files: Resource[]; entry: string }
  >();
  private active?: {
    id: string;
    generation: number;
    target: OutputFileTarget;
    bounds: Bounds;
    sourceHash?: string;
    officeKind?: OfficePreviewKind;
    abort: AbortController;
    view?: WebContentsView;
    directory?: string;
    pending?: boolean;
    cached?: boolean;
    checkTimer?: ReturnType<typeof setInterval>;
    window: NativeRootWindow;
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
    target: OutputFileTarget;
    bounds: Bounds;
    initialControls?: OfficePreviewControl[];
    window: NativeRootWindow;
    check: () => void;
    materialize: (destination: string) => Promise<OutputFileSummary & { sourceHash?: string }>;
  }) {
    this.close();
    const active = {
      id: input.id,
      generation: input.generation,
      target: structuredClone(input.target),
      bounds: { ...input.bounds },
      abort: new AbortController(),
      window: input.window,
      pending: true,
    } as NonNullable<NativeOutputPreview['active']>;
    this.active = active;
    const current = () => {
      input.check();
      active.abort.signal.throwIfAborted();
      if (this.active !== active) throw Error('preview_replaced');
    };
    const owner = new NativeProcessOwner();
    try {
      active.directory = await mkdtemp(join(tmpdir(), 'kite-output-preview-'));
      current();
      const source = join(active.directory, 'source');
      const file = await input.materialize(source);
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
      active.officeKind = /\.docx$/i.test(file.name)
        ? 'word'
        : /\.xlsx$/i.test(file.name)
          ? 'excel'
          : /\.pptx$/i.test(file.name)
            ? 'powerpoint'
            : undefined;
      let files: Resource[], entry: string;
      if (/\.(docx|xlsx|pptx)$/i.test(file.name)) {
        const cacheKey = file.sourceHash
          ? `${file.sourceHash}:${officeRendererVersion}:${officePreviewRecipeVersion}`
          : undefined;
        const cached = cacheKey ? this.cache.get(cacheKey) : undefined;
        if (cached) {
          await rm(active.directory, { recursive: true, force: true });
          active.directory = cached.directory;
          active.cached = true;
          files = cached.files;
          entry = cached.entry;
        } else {
          await rename(source, source + extname(file.name).toLowerCase());
          const assets = await verifyOfficeRuntimeAssets(this.assetsRoot);
          current();
          const converted = await renderOfficePreview({
            assetsRoot: this.assetsRoot,
            sourcePath: source + extname(file.name).toLowerCase(),
            outputDirectory: join(active.directory, 'render'),
            signal: active.abort.signal,
            run: async (args, signal) => {
              const operation = owner.start(
                assets.officecli,
                args,
                {
                  env: { ...process.env, ...officeEnvironment() },
                  stdio: ['ignore', 'pipe', 'pipe'],
                  windowsHide: true,
                },
                {
                  timeoutMs: 60000,
                  timeoutError: 'preview_timeout',
                  launchError: 'preview_launch_failed',
                },
              );
              const abort = () => operation.stop(Error('preview_cancelled'));
              signal.addEventListener('abort', abort, { once: true });
              if (signal.aborted) abort();
              async function collect(stream: AsyncIterable<Uint8Array>) {
                const chunks: Buffer[] = [];
                let size = 0;
                for await (const chunk of stream) {
                  size += chunk.length;
                  if (size > 2 * 1024 * 1024) {
                    operation.stop(Error('preview_diagnostic_limit'));
                    throw Error('preview_diagnostic_limit');
                  }
                  chunks.push(Buffer.from(chunk));
                }
                return Buffer.concat(chunks).toString('utf8');
              }
              try {
                const [code, stdout, stderr] = await Promise.all([
                  operation.result,
                  collect(operation.child.stdout!),
                  collect(operation.child.stderr!),
                ]);
                if (code === null) throw Error('preview_process_failed');
                return { code, stdout, stderr };
              } finally {
                signal.removeEventListener('abort', abort);
              }
            },
          });
          current();
          files = converted.files;
          entry = converted.entry;
          if (cacheKey) {
            active.cached = true;
            this.cache.set(cacheKey, { directory: active.directory, files, entry });
            while (this.cache.size > 8) {
              const first = this.cache.keys().next().value!;
              const old = this.cache.get(first)!;
              this.cache.delete(first);
              void rm(old.directory, { recursive: true, force: true }).catch(() => {});
            }
          }
        }
      } else if (file.mediaType.startsWith('text/') || /\.(txt|md|json|csv)$/i.test(file.name)) {
        if (BigInt(file.size) > 2n * 1024n * 1024n) throw Error('preview_text_budget');
        const html = Buffer.from(
          `<!doctype html><meta charset="utf-8"><style>body{font:14px system-ui;padding:16px}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><pre>${escapeHtml(await readFile(source, 'utf8'))}</pre>`,
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
      } else if (/^image\/(png|jpeg|webp|gif)$/.test(file.mediaType)) {
        if (BigInt(file.size) > 32n * 1024n * 1024n) throw Error('preview_image_budget');
        const bytes = await readFile(source);
        const html = Buffer.from(
          '<!doctype html><meta charset="utf-8"><style>img{max-width:100%;height:auto}body{margin:0}</style><img src="image">',
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
            path: 'image',
            absolutePath: source,
            mimeType: file.mediaType,
            size: bytes.length,
            sha256: digest(bytes),
          },
        ];
        entry = 'index.html';
      } else throw Error('preview_format_unavailable');
      current();
      const origin = `kite-preview://${randomUUID()}`;
      const manifest = new Map(
        files.map((file) => [
          `${origin}/${file.path.split('/').map(encodeURIComponent).join('/')}`,
          file,
        ]),
      );
      const previewSession = session.fromPartition(`kite-output-${randomUUID()}`, { cache: false });
      previewSession.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      );
      previewSession.setPermissionCheckHandler(() => false);
      previewSession.on('will-download', (event) => event.preventDefault());
      previewSession.webRequest.onBeforeRequest((details, callback) =>
        callback({ cancel: !manifest.has(details.url.split('#')[0]!) }),
      );
      await previewSession.protocol.handle('kite-preview', async (request) => {
        const resource = manifest.get(request.url.split('#')[0]!);
        if (!resource || this.active !== active || request.method !== 'GET')
          return new Response(null, { status: 403 });
        try {
          current();
          const bytes = await readFile(resource.absolutePath);
          if (bytes.length !== resource.size || digest(bytes) !== resource.sha256)
            throw Error('preview_integrity_failed');
          current();
          return new Response(bytes, {
            headers: {
              'Content-Type': resource.mimeType,
              'Content-Security-Policy': csp,
              'X-Content-Type-Options': 'nosniff',
              'Cache-Control': 'no-store',
            },
          });
        } catch {
          return new Response(null, { status: 410 });
        }
      });
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
      active.checkTimer = setInterval(() => {
        try {
          current();
        } catch {
          this.close(active.id);
        }
      }, 250);
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
      view.setBounds(active.bounds);
      addNativeWindowView(input.window, view);
      await view.webContents.loadURL(`${origin}/${entry}`);
      current();
      const officeKind = active.officeKind;
      if (officeKind) {
        await view.webContents.executeJavaScriptInIsolatedWorld(officeInteractionWorld, [
          { code: officeInteractionInstallScript(officeKind) },
        ]);
        current();
        const initialControls = input.initialControls ?? [];
        if (initialControls.length > 4) throw Error('preview_control_invalid');
        for (const command of initialControls) {
          await view.webContents.executeJavaScriptInIsolatedWorld(officeInteractionWorld, [
            { code: officeInteractionControlScript(command) },
          ]);
          current();
        }
      }
      current();
      view.setVisible(true);
      return { kind: 'outputs.preview' as const, status: 'ready' as const };
    } catch (error) {
      if (this.active === active) this.close(input.id);
      throw error;
    } finally {
      await owner.close();
      active.pending = false;
      if (this.active !== active && !active.cached && active.directory)
        await rm(active.directory, { recursive: true, force: true }).catch(() => {});
    }
  }
  private async releaseDocumentRequest(
    active: NonNullable<NativeOutputPreview['active']>,
    serial: number,
  ) {
    if (this.active !== active || active.abort.signal.aborted || !active.view) return;
    try {
      await active.view.webContents.executeJavaScriptInIsolatedWorld(officeInteractionWorld, [
        { code: officeInteractionReleaseScript(serial) },
      ]);
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
          active.view
        )
          focusNativeWindowContent(active.window, active.view.webContents);
      },
    );
    return request.retiring;
  }
  async readInteraction(id: string, generation: number, consumeRequest = true) {
    const active = this.active;
    if (
      !active ||
      active.id !== id ||
      active.generation !== generation ||
      !active.view ||
      active.pending
    )
      throw Error('preview_replaced');
    const evidence = await active.view.webContents.executeJavaScriptInIsolatedWorld(
      officeInteractionWorld,
      [{ code: consumeRequest ? officeInteractionReadScript : officeInteractionPeekScript }],
    );
    if (this.active !== active || active.abort.signal.aborted) throw Error('preview_replaced');
    const result = readOfficeDescription(evidence, active.officeKind, active.sourceHash);
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
        const selection = request.context.selection!;
        const label = `请求修改 · ${officeSelectionLabel(selection)}`;
        try {
          await view.open(active.bounds, label);
          if (
            this.active !== active ||
            active.abort.signal.aborted ||
            active.request !== request ||
            request.retiring
          )
            throw Error('preview_replaced');
          request.ready = true;
        } catch (error) {
          await this.retireRequest(active, request);
          throw error;
        }
      }
    }
    const request = active.request;
    let inlineRequest: OfficeInlineRequest | undefined;
    if (request?.ready) {
      if (result.requestAnchor) request.view.bounds(active.bounds, result.requestAnchor);
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
        const latest = await active.view.webContents.executeJavaScriptInIsolatedWorld(
          officeInteractionWorld,
          [{ code: officeInteractionPeekScript }],
        );
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
      target: structuredClone(active.target),
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
    if (
      this.active !== active ||
      active.abort.signal.aborted ||
      active.request !== request ||
      request.retiring
    )
      throw Error('preview_request_replaced');
    if (outcome.status === 'accepted') await this.retireRequest(active, request);
  }
  async control(id: string, generation: number, command: OfficePreviewControl) {
    const code = officeInteractionControlScript(command);
    const active = this.active;
    if (
      !active ||
      active.id !== id ||
      active.generation !== generation ||
      !active.view ||
      active.pending
    )
      throw Error('preview_replaced');
    if (active.request) {
      if (command.kind === 'request-edit') return;
      throw Error('preview_request_active');
    }
    if (command.kind === 'locate-selection') {
      const evidence = await active.view.webContents.executeJavaScriptInIsolatedWorld(
        officeInteractionWorld,
        [{ code: officeInteractionPeekScript }],
      );
      if (this.active !== active || active.abort.signal.aborted || active.pending)
        throw Error('preview_replaced');
      if (active.request) throw Error('preview_request_active');
      const current = readOfficeDescription(evidence, active.officeKind, active.sourceHash);
      if (current.floatingRequest) throw Error('preview_request_active');
      if (current.excelSelection?.selectionSerial !== command.selectionSerial)
        throw Error('preview_selection_replaced');
    }
    await active.view.webContents.executeJavaScriptInIsolatedWorld(officeInteractionWorld, [
      { code },
    ]);
    if (this.active !== active || active.abort.signal.aborted) throw Error('preview_replaced');
  }
  dispose() {
    this.close();
    for (const cached of this.cache.values())
      void rm(cached.directory, { recursive: true, force: true }).catch(() => {});
    this.cache.clear();
  }
  bounds(id: string, bounds: Bounds) {
    const active = this.active;
    if (active?.id !== id) return;
    active.bounds = { ...bounds };
    active.view?.setBounds(active.bounds);
    active.request?.view.bounds(active.bounds);
  }
  closeOwned(id: string, generation: number) {
    if (this.active?.generation === generation) this.close(id);
  }
  close(id?: string) {
    const active = this.active;
    if (!active || (id && active.id !== id)) return;
    this.active = undefined;
    active.abort.abort(Error('preview_closed'));
    active.request?.view.close();
    if (active.checkTimer) clearInterval(active.checkTimer);
    if (active.view) {
      if (!active.window.isDestroyed()) active.window.contentView.removeChildView(active.view);
      active.view.webContents.close();
    }
    if (active.directory && !active.pending && !active.cached)
      void rm(active.directory, { recursive: true, force: true }).catch(() => {});
  }
}
