import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { app, ipcMain, screen, WebContentsView } from 'electron';
import { NativeBrowserPageHost } from '../electron/browser-page-host';
import { desktopContentSecurityPolicy } from '../electron/development';
import { registerNativeBrowserIpc } from '../electron/native-browser';
import { createNativeRootWindow, type NativeRootWindow } from '../electron/native-root-window';
import {
  isNativeBrowserChromeSnapshot,
  type NativeBrowserChromeEnvelope,
  type NativeBrowserChromeSnapshot,
  nativeBrowserChromeRootChannel,
} from '../src/native-browser-chrome-bridge';

interface RootPublicationTrace {
  at: number;
  summary:
    | (Pick<NativeBrowserChromeSnapshot, 'scope' | 'revision' | 'hosted' | 'covered'> & {
        id: string;
        hasPage: boolean;
      })
    | null;
  attachedBefore: boolean | null;
  attachedAfter?: boolean | null;
  result: 'pending' | 'returned' | 'threw';
  error?: string;
}

export interface ChromeFixtureView {
  id: number;
  role: 'root' | 'chrome' | 'page' | 'shield' | 'unconfirmed';
  url: string;
  bounds: Electron.Rectangle;
  visible: boolean;
  zoom: number;
}
export interface ChromeFixturePage {
  id: number;
  href: string;
  documentId: string;
  timeOrigin: number;
  input: string | null;
  selected: string | null;
  checked: boolean | null;
  scrollX: number;
  scrollY: number;
  reading: {
    viewport: { width: number; height: number };
    header: { top: number; bottom: number; height: number; text: string } | null;
    markers: { id: string; top: number; bottom: number; height: number; text: string }[];
  };
}
export interface ChromeFixtureSample {
  at: number;
  window: {
    visible: boolean;
    size: number[];
    bounds: Electron.Rectangle;
    mediaId: string;
    zoom: number;
    rootId: number;
  };
  views: ChromeFixtureView[];
  envelope: NativeBrowserChromeEnvelope | null;
  binding: {
    pageId: string;
    contentsId?: number;
    incarnation?: string;
    navigation?: number;
  } | null;
  pages: ChromeFixturePage[];
  rootPublications: { records: RootPublicationTrace[]; dropped: number };
  root: ReturnType<NonNullable<Window['browserChromeFixture']>['read']> | null;
}
export interface ChromeFixtureHost {
  window: NativeRootWindow;
  origin: string;
  sample(): Promise<ChromeFixtureSample>;
  geometry(): {
    records: { at: number; reason: string; views: ChromeFixtureView[] }[];
    dropped: number;
  };
  resize(width: number, height: number): void;
  zoom(value: number): void;
  seed(value: string, scrollY: number): Promise<void>;
  prepareQuit(): { contents: { id: number; destroyed: boolean }[]; rootId: number };
}
declare global {
  var browserChromeHostFixture: ChromeFixtureHost;
}

// Only this explicitly built test entry can expose the fixture. No product flag enables it.
const directory = resolve(process.argv.at(-1)!);
if (!existsSync(join(directory, 'chrome-fixture-manifest.json')))
  throw Error('browser_chrome_fixture_manifest_missing');
const manifest: unknown = JSON.parse(
  readFileSync(join(directory, 'chrome-fixture-manifest.json'), 'utf8'),
);
if (
  !manifest ||
  typeof manifest !== 'object' ||
  Array.isArray(manifest) ||
  Object.keys(manifest).length !== 3 ||
  !Object.keys(manifest).every((key) => ['kind', 'version', 'userData'].includes(key)) ||
  !('kind' in manifest) ||
  manifest.kind !== 'kite-browser-chrome-fixture' ||
  !('version' in manifest) ||
  manifest.version !== 1 ||
  !('userData' in manifest) ||
  typeof manifest.userData !== 'string' ||
  !isAbsolute(manifest.userData) ||
  manifest.userData.includes('\0')
)
  throw Error('invalid_browser_chrome_fixture_manifest');
app.setPath('userData', manifest.userData);
void app.whenReady().then(async () => {
  if (process.platform !== 'darwin') throw Error('browser_chrome_fixture_requires_macos');
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    if (url.pathname === '/') {
      response.setHeader('content-security-policy', desktopContentSecurityPolicy(null));
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(
        '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/chrome-ui.css"></head><body><div id="root"></div><script type="module" src="/chrome-ui.js"></script></body></html>',
      );
    } else if (url.pathname === '/form') {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(
        `<!doctype html><html><head><meta charset="utf-8"><title>Retained form</title><style>body{margin:0;background:#f2f7fc;color:#123;font:20px system-ui}header{position:sticky;top:0;background:#d5e8fa;padding:20px}main{padding:24px}p{height:160px;border-bottom:2px solid #789}</style></head><body><header>Retained form — live page</header><main><label>Value <input id="retained-value"></label><label> Choice <select id="retained-choice"><option>A</option><option>B</option></select></label><label><input type="checkbox" id="retained-check">Keep</label>${Array.from({ length: 18 }, (_, i) => `<p data-reading-marker="${i + 1}">Reading marker ${i + 1}</p>`).join('')}</main><script>document.documentElement.dataset.fixtureDocument=crypto.randomUUID()</script></body></html>`,
      );
    } else {
      const file = resolve(directory, `.${url.pathname}`);
      if (
        !file.startsWith(directory + sep) ||
        !existsSync(file) ||
        !/\.(?:js|css|woff2)$/.test(file)
      ) {
        response.writeHead(404).end();
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
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('fixture_server_missing');
  const origin = `http://127.0.0.1:${address.port}`;
  const work = screen.getPrimaryDisplay().workArea;
  const window = createNativeRootWindow({
    title: 'Kite isolated native Chrome fixture',
    x: work.x,
    y: work.y,
    width: Math.min(1472, work.width),
    height: Math.min(796, work.height),
    show: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#18181b',
    webPreferences: {
      preload: join(directory, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  const [initialWidth = 1472, initialHeight = 768] = window.getContentSize();
  const host = new NativeBrowserPageHost();
  const scope = {
    storeId: 'chrome-fixture-store',
    sessionId: 'chrome-fixture-session',
    generation: 1,
    viewSelection: 1,
  };
  const rootPublications: RootPublicationTrace[] = [];
  let rootPublicationDropped = 0;
  const attached = () =>
    window.webContents.isDestroyed() ? null : window.webContents.debugger.isAttached();
  const originalHandle = ipcMain.handle;
  const dispose = (() => {
    // Observe only this fixture's registration; restore the real dispatcher
    // immediately and invoke its original listener without changing admission.
    ipcMain.handle = (channel, listener) =>
      originalHandle.call(
        ipcMain,
        channel,
        channel !== nativeBrowserChromeRootChannel
          ? listener
          : async (event, value: unknown) => {
              const trace: RootPublicationTrace = {
                at: Date.now(),
                summary: isNativeBrowserChromeSnapshot(value)
                  ? {
                      scope: { ...value.scope },
                      revision: value.revision,
                      id: value.toolbar.id,
                      hosted: value.hosted,
                      covered: value.covered,
                      hasPage: value.toolbar.hasPage,
                    }
                  : null,
                attachedBefore: attached(),
                result: 'pending',
              };
              if (rootPublications.length < 64) rootPublications.push(trace);
              else rootPublicationDropped++;
              try {
                const result = await listener(event, value);
                trace.result = 'returned';
                return result;
              } catch (cause) {
                trace.result = 'threw';
                trace.error = String(cause).slice(0, 1024);
                throw cause;
              } finally {
                trace.attachedAfter = attached();
              }
            },
      );
    try {
      return registerNativeBrowserIpc({
        ipcMain,
        window,
        rendererUrl: `${origin}/`,
        automation: host,
        selectedScope: () => scope,
        grantScope: () => scope,
        chrome: { preloadPath: join(directory, 'browser-chrome-preload.cjs') },
      });
    } finally {
      ipcMain.handle = originalHandle;
    }
  })();
  const views = () =>
    window.contentView.children.filter(
      (view): view is WebContentsView => view instanceof WebContentsView,
    );
  let chromeId: number | undefined;
  const describe = (): ChromeFixtureView[] =>
    views()
      .filter((view) => !view.webContents.isDestroyed())
      .map((view) => {
        const contents = view.webContents,
          url = contents.getURL();
        const role =
          contents === window.webContents
            ? 'root'
            : contents.id === chromeId
              ? 'chrome'
              : url.startsWith('data:')
                ? 'shield'
                : url === `${origin}/`
                  ? 'unconfirmed'
                  : 'page';
        return {
          id: contents.id,
          role,
          url: url.slice(0, 4096),
          bounds: view.getBounds(),
          visible: view.getVisible(),
          zoom: contents.getZoomFactor(),
        };
      });
  const records: ReturnType<ChromeFixtureHost['geometry']>['records'] = [];
  let dropped = 0,
    disposed = false;
  const record = (reason: string) => {
    if (window.isDestroyed() || disposed) return;
    if (records.length >= 20000) {
      dropped++;
      return;
    }
    records.push({ at: Date.now(), reason, views: describe() });
  };
  const resize = () => record('resize');
  window.on('resize', resize);
  const timer = setInterval(() => record('sample'), 33);
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    clearInterval(timer);
    window.off('resize', resize);
    dispose();
    server.closeAllConnections();
    server.close();
  };
  globalThis.browserChromeHostFixture = {
    window,
    origin,
    async sample() {
      let firstEnvelope: NativeBrowserChromeEnvelope | null | undefined;
      if (chromeId === undefined)
        for (const view of views().filter(
          (view) =>
            view.webContents !== window.webContents && view.webContents.getURL() === `${origin}/`,
        )) {
          const result = (await view.webContents.executeJavaScript(
            '(async()=>{if(typeof window.kiteBrowserChrome?.read!=="function"||window.kiteNative)return {verified:false};return {verified:true,envelope:await window.kiteBrowserChrome.read()}})()',
          )) as { verified: boolean; envelope?: NativeBrowserChromeEnvelope | null };
          if (result.verified === true) {
            chromeId = view.webContents.id;
            firstEnvelope = result.envelope ?? null;
            break;
          }
        }
      const current = describe(),
        chrome = current.find((view) => view.role === 'chrome');
      const chromeView = views().find((view) => view.webContents.id === chrome?.id);
      const envelope =
        firstEnvelope !== undefined
          ? firstEnvelope
          : chromeView
            ? ((await chromeView.webContents.executeJavaScript(
                'window.kiteBrowserChrome?.read?.()??null',
              )) as NativeBrowserChromeEnvelope | null)
            : null;
      const pages: ChromeFixturePage[] = [];
      for (const view of views().filter((view) =>
        current.some((data) => data.id === view.webContents.id && data.role === 'page'),
      ))
        pages.push({
          id: view.webContents.id,
          ...(await view.webContents.executeJavaScript(
            '({href:location.href,documentId:document.documentElement?.dataset.fixtureDocument||"",timeOrigin:performance.timeOrigin,input:document.querySelector("#retained-value")?.value??null,selected:document.querySelector("#retained-choice")?.value??null,checked:document.querySelector("#retained-check")?.checked??null,scrollX,scrollY,reading:{viewport:{width:innerWidth,height:innerHeight},header:(()=>{const n=document.querySelector("header");if(!n)return null;const r=n.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height,text:n.textContent.slice(0,128)}})(),markers:[...document.querySelectorAll("p[data-reading-marker]")].map(n=>{const r=n.getBoundingClientRect();return {id:n.dataset.readingMarker,top:r.top,bottom:r.bottom,height:r.height,text:n.textContent}})}})',
          )),
        });
      const target = envelope?.snapshot.toolbar;
      const state = target ? host.state(target.id) : undefined;
      // A deliberately single-page fixture association, never duplicate-URL authority.
      const exact =
        !!target &&
        !!state &&
        current.filter((view) => view.role === 'page').length === 1 &&
        pages.length === 1 &&
        pages[0]!.href === target.readonlyURL;
      return {
        at: Date.now(),
        window: {
          visible: window.isVisible(),
          size: window.getContentSize(),
          bounds: window.getBounds(),
          mediaId: window.getMediaSourceId(),
          zoom: window.webContents.getZoomFactor(),
          rootId: window.webContents.id,
        },
        views: current,
        rootPublications: {
          records: rootPublications.map((record) => ({ ...record })),
          dropped: rootPublicationDropped,
        },
        envelope,
        binding: target
          ? {
              pageId: target.id,
              ...(exact ? { contentsId: pages[0]!.id } : {}),
              ...state,
            }
          : null,
        pages,
        root: await window.webContents.executeJavaScript(
          'window.browserChromeFixture?.read()??null',
        ),
      };
    },
    geometry: () => ({ records: [...records], dropped }),
    resize(width, height) {
      if (
        ![width, height].every((value) => Number.isInteger(value) && value >= 240) ||
        width > initialWidth ||
        height > initialHeight
      )
        throw Error('invalid_fixture_size');
      window.setContentSize(width, height);
      record('requested-resize');
    },
    zoom(value) {
      if (![1, 1.25].includes(value)) throw Error('invalid_fixture_zoom');
      window.webContents.setZoomFactor(value);
      record('requested-zoom');
    },
    async seed(value, scrollY) {
      const target = views().filter((view) => view.webContents.getURL() === `${origin}/form`);
      if (
        target.length !== 1 ||
        value.length > 128 ||
        !Number.isInteger(scrollY) ||
        scrollY < 0 ||
        scrollY > 2000
      )
        throw Error('fixture_seed_target_ambiguous');
      await target[0]!.webContents.executeJavaScript(
        `document.querySelector('#retained-value').value=${JSON.stringify(value)};document.querySelector('#retained-choice').value='B';document.querySelector('#retained-check').checked=true;window.scrollTo(0,${scrollY})`,
      );
    },
    prepareQuit() {
      const contents = views()
        .filter((view) => view.webContents !== window.webContents)
        .map((view) => view.webContents);
      cleanup();
      return {
        rootId: window.webContents.id,
        contents: contents.map((contents) => ({
          id: contents.id,
          destroyed: contents.isDestroyed(),
        })),
      };
    },
  };
  window.once('closed', cleanup);
  app.once('before-quit', cleanup);
  await window.loadURL(`${origin}/`);
});
