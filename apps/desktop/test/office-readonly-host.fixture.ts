/** Isolated real Chromium; original workbook path, no Service, business sends or clipboard. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { app, ipcMain, Menu, nativeImage, webContents } from 'electron';
import { createNativeRootWindow } from '../electron/native-root-window';
import { nativeWindowMenuTemplate } from '../electron/native-window-menu';
import { ignoreOfficePreviewMenuShortcut } from '../electron/office-preview-zoom';
import { NativeOutputPreview, registerOutputPreviewScheme } from '../electron/output-preview';
import { parseNativePreviewLayout } from '../src/native-preview-layout-bridge';
import type { NativeOutputRequest } from '../src/output-files-bridge';
import { verifyOfficePreviewTheme } from './office-preview-theme.fixture';

const root = resolve(process.argv[2]!);
// This fixture can run behind another window on a shared Windows desktop.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
registerOutputPreviewScheme();
app.on('window-all-closed', () => {});
app.setPath('userData', join(root, 'profile'));
app.setPath('crashDumps', join(root, 'crash'));
app.on('web-contents-created', (_, contents) => {
  contents.on('console-message', (message) => {
    if (message.level === 'error') console.error(contents.getURL(), message.message);
  });
});
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const pause = () => new Promise((r) => setTimeout(r, 80));
type Point = { x: number; y: number };
type ExcelFitFrame = {
  dpr: number;
  viewport: number[];
  scroll: number[];
  edges: number[];
  gap: number[];
  font: number;
  tabTop: number;
};
async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean) {
  for (let i = 0; i < 100; i++) {
    const v = await fn();
    if (ok(v)) return v;
    await pause();
  }
  throw Error('fixture_condition_timeout');
}
void app
  .whenReady()
  .then(async () => {
    const window = createNativeRootWindow({
      width: 1100,
      height: 780,
      show: true,
      alwaysOnTop: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        preload: join(root, 'preload.cjs'),
      },
    });
    const primary = { webContents: window.webContents };
    window.setMenu(
      Menu.buildFromTemplate(
        nativeWindowMenuTemplate({
          applicationEnabled: true,
          dispatch() {},
        }),
      ),
    );
    window.setMenuBarVisibility(false);
    primary.webContents.on('before-input-event', (_event, input) => {
      primary.webContents.setIgnoreMenuShortcuts(
        ignoreOfficePreviewMenuShortcut(primary.webContents, input),
      );
    });
    primary.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) =>
      callback(false),
    );
    primary.webContents.session.setPermissionCheckHandler(() => false);
    primary.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    primary.webContents.on('will-navigate', (event) => event.preventDefault());
    const preview = new NativeOutputPreview();
    const checks: string[] = [];
    const captures: string[] = [];
    const captureUnavailable: unknown[] = [];
    const geometries: unknown[] = [];
    let previewDiagnostic: unknown;
    let passed = false;
    let previewWasVisible = false;
    let failure = '';
    const layoutReports: unknown[] = [];
    let currentId = '';
    let currentGeneration = 1;
    let initialAttempts = 0;
    let releaseOpen: (success: boolean) => void;
    const bytes = await readFile(join(root, 'fixture.xlsx'));
    const notes = await readFile(join(root, 'fixture.docx'));
    const pdfSource = Buffer.from('%PDF-1.4\n% view fixture');
    const pdfWidth = 384;
    const pdfHeight = 768;
    const pdfPage = nativeImage
      .createFromBitmap(Buffer.alloc(pdfWidth * pdfHeight * 4, 255), {
        width: pdfWidth,
        height: pdfHeight,
      })
      .toPNG()
      .toString('base64');
    const original = (id: string) => (id === 'notes' ? notes : id === 'pdf' ? pdfSource : bytes);
    const sourceHash = hash(bytes);
    const target = {
      storeId: 'store',
      sessionId: 'session',
      fileId: 'A',
      locator: { kind: 'delivery' as const, key: 'delivery/A' },
    };
    const info = (id: string) => ({
      ...target,
      fileId: id,
      locator: { kind: 'delivery' as const, key: `delivery/${id}` },
      name: id === 'notes' ? 'notes.docx' : id === 'pdf' ? 'fixture.pdf' : `${id}.xlsx`,
      ownerRunId: 'fixture',
      mediaType: 'application/octet-stream',
      size: String(original(id).length),
      publishedAt: '2026-11-12T00:00:00Z',
      sourceHash: hash(original(id)),
    });
    try {
      assert.equal(app.commandLine.hasSwitch('no-sandbox'), false);
      const present = (request: unknown) => {
        const layout = parseNativePreviewLayout(request);
        layoutReports.push({
          revision: layout.presentationRevision,
          bounds: layout.bounds,
          visible: window.isVisible(),
        });
        preview.present(layout);
        return { previewId: layout.previewId, generation: layout.generation };
      };
      ipcMain.on('readonly-fixture-layout', (event, request: unknown) => {
        assert.equal(event.sender, primary.webContents);
        try {
          event.returnValue = { ok: true, value: present(request) };
        } catch (error) {
          event.returnValue = { ok: false, code: String((error as Error).message) };
        }
      });
      ipcMain.handle('readonly-fixture-layout', (event, request: unknown) => {
        assert.equal(event.sender, primary.webContents);
        return present(request);
      });
      ipcMain.handle(
        'readonly-fixture-request',
        async (
          event,
          request:
            | NativeOutputRequest
            | { method: 'settings.skills.open' | 'settings.skills.close' },
        ) => {
          assert.equal(event.sender, primary.webContents);
          switch (request.method) {
            case 'settings.skills.open':
            case 'settings.skills.close':
              return null;
            case 'outputs.info':
              return { kind: 'outputs.info', file: info(request.target.fileId) };
            case 'outputs.preview.open': {
              if (request.target.fileId === 'A' && ++initialAttempts <= 2) {
                const success = await new Promise<boolean>((resolve) => {
                  releaseOpen = resolve;
                });
                if (!success) throw Error('fixture_preview_read_failed');
              }
              currentId = request.previewId;
              currentGeneration = request.generation;
              return preview.open({
                id: request.previewId,
                generation: request.generation,
                target: request.target,
                window,
                bounds: request.bounds,
                check() {},
                async renderPdfPage() {
                  return {
                    data: pdfPage,
                    totalPages: 12,
                    textLayer: { status: 'empty', width: pdfWidth, height: pdfHeight, items: [] },
                  };
                },
                async materialize(path) {
                  await writeFile(path, original(request.target.fileId), { flag: 'wx' });
                  return info(request.target.fileId);
                },
              });
            }
            case 'outputs.preview.frame.ready':
              return preview.attachFrame(request.previewId, request.generation);
            case 'outputs.preview.interaction':
              return {
                kind: 'outputs.preview.interaction',
                interaction: await preview.readInteraction(
                  request.previewId,
                  request.generation,
                  request.consumeRequest,
                ),
              };
            case 'outputs.preview.bounds':
              preview.bounds(request.previewId, request.bounds);
              return null;
            case 'outputs.preview.control':
              await preview.control(request.previewId, request.generation, request.control);
              return null;
            case 'outputs.preview.close':
              preview.closeOwned(request.previewId, request.generation);
              return null;
            default:
              throw Error('fixture_forbidden_business_request');
          }
        },
      );
      await window.loadFile(join(root, 'host.html'));
      window.setContentSize(1100, 780);
      const doc = () =>
        primary.webContents.mainFrame.frames.find((frame) =>
          frame.url.startsWith('kite-office-preview:'),
        );
      const frameBounds = () =>
        primary.webContents.executeJavaScript(
          'document.querySelector(".native-file-preview-iframe")?.getBoundingClientRect().toJSON()',
        );
      const paintedFrame = () =>
        primary.webContents.executeJavaScript(
          'document.querySelector(".native-file-preview-iframe:not([data-loading])")?.src',
        );
      const capture = async (name: string) => {
        await new Promise((resolve) => setTimeout(resolve, 350));
        await primary.webContents.executeJavaScript(
          'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
        );
        const filename = `${name}-host.png`;
        try {
          await writeFile(join(root, filename), (await primary.webContents.capturePage()).toPNG());
          captures.push(filename);
        } catch (error) {
          captureUnavailable.push({ filename, error: String(error) });
        }
      };
      const click = async (selector: string) => {
        window.focus();
        primary.webContents.focus();
        const p = await primary.webContents.executeJavaScript(
          `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`,
        );
        primary.webContents.sendInputEvent({
          type: 'mouseDown',
          button: 'left',
          clickCount: 1,
          ...p,
        });
        primary.webContents.sendInputEvent({
          type: 'mouseUp',
          button: 'left',
          clickCount: 1,
          ...p,
        });
        await pause();
      };
      await until(
        async () =>
          window.isVisible() &&
          (await primary.webContents.executeJavaScript(
            '!document.hidden && !!document.querySelector("#open")',
          )),
        Boolean,
      );
      await click('#open');
      const loading = (attempt: number) =>
        until(
          async () =>
            initialAttempts === attempt &&
            (await primary.webContents.executeJavaScript(`(() => {
              const viewport = document.querySelector('.native-file-preview > .native-file-preview-viewport');
              const icons = viewport?.querySelectorAll(
                '[data-slot="spinner"][role="status"][aria-label="文件预览加载中"]',
              );
              if (icons?.length !== 1 || viewport.textContent.trim()) return false;
              const frame = viewport.getBoundingClientRect(), icon = icons[0].getBoundingClientRect();
              return icon.width > 0 && icon.height > 0 &&
                Math.abs(frame.x + frame.width / 2 - icon.x - icon.width / 2) < 2 &&
                Math.abs(frame.y + frame.height / 2 - icon.y - icon.height / 2) < 2;
            })()`)),
          Boolean,
        );
      await loading(1);
      await capture('loading');
      releaseOpen!(false);
      await until(
        () =>
          primary.webContents.executeJavaScript(`(() => {
            const viewport = document.querySelector('.native-file-preview > .native-file-preview-viewport');
            const error = viewport?.querySelector('.native-file-preview-error');
            if (error?.querySelector('p[role="status"]')?.textContent !== '预览失败' ||
                error.querySelector('button')?.textContent !== '重试') return false;
            const frame = viewport.getBoundingClientRect(), block = error.getBoundingClientRect();
            return Math.abs(frame.x + frame.width / 2 - block.x - block.width / 2) < 2 &&
              Math.abs(frame.y + frame.height / 2 - block.y - block.height / 2) < 2;
          })()`),
        Boolean,
      );
      await capture('failed');
      await click('.native-file-preview-error button');
      await loading(2);
      releaseOpen!(true);
      await until(
        async () =>
          !!doc() &&
          (await primary.webContents.executeJavaScript(
            '!!document.querySelector(".native-office-toolbar") && !document.querySelector(".native-file-preview-state,.native-excel-readonly,textarea")',
          )),
        Boolean,
      ).catch(async (error: unknown) => {
        previewDiagnostic = {
          host: await primary.webContents.executeJavaScript(
            `({text:document.body.innerText.slice(0,400),hidden:document.hidden,viewport:document.querySelector('.native-file-preview > .native-file-preview-viewport')?.getBoundingClientRect().toJSON()})`,
          ),
          child: doc()?.url,
          layoutReports,
          bounds: await frameBounds(),
          contentSize: window.getContentSize(),
          childState: await doc()?.executeJavaScript(
            `({text:document.body?.innerText.slice(0,160),element:!!document.querySelector('.xlsx-viewport'),viewport:[innerWidth,innerHeight],hidden:document.hidden})`,
          ),
        };
        throw error;
      });
      assert.equal(
        await primary.webContents.executeJavaScript(
          '!document.querySelector(".native-file-preview-state")',
        ),
        true,
      );
      checks.push('centered-loading-icon-failure-and-retry');
      await pause();
      const geometry = async (label: string) => {
        const state = await primary.webContents.executeJavaScript(
          `(()=>{const toolbar=document.querySelector('.native-office-toolbar').getBoundingClientRect(); const bottom=(document.querySelector('.native-excel-details') ?? document.querySelector('.native-excel-readonly') ?? document.querySelector('.native-office-toolbar')).getBoundingClientRect().bottom; const viewport=document.querySelector('.native-file-preview > .native-file-preview-viewport')?.getBoundingClientRect();return {bar:{bottom,left:toolbar.left,top:toolbar.top,right:toolbar.right},viewport:viewport?{x:viewport.x,y:viewport.y,width:viewport.width,height:viewport.height}:null,hit:!!document.elementFromPoint(toolbar.left+20,toolbar.top+12)?.closest('.native-office-toolbar')}})()`,
        );
        const bounds = await frameBounds();
        geometries.push({ label, state, bounds });
        assert.ok(state.bar.bottom <= bounds.y + 1);
        assert.equal(state.hit, true);
        assert.ok(state.viewport);
        for (const key of ['x', 'y', 'width', 'height'])
          assert.ok(Math.abs(bounds[key] - state.viewport[key]) < 1, key);
        return bounds;
      };
      const drag = async (start: Point, end: Point, whileHeld?: () => Promise<void>) => {
        window.focus();
        const view = primary.webContents;
        view.focus();
        const frame = await frameBounds();
        const absolute = (point: Point) => ({
          x: Math.round(point.x + frame.x),
          y: Math.round(point.y + frame.y),
        });
        const dispatch = (type: string, point: Point, buttons: number) =>
          view.debugger.sendCommand('Input.dispatchMouseEvent', {
            type,
            button: 'left',
            buttons,
            clickCount: 1,
            ...absolute(point),
          });
        await dispatch('mouseMoved', start, 0);
        await dispatch('mousePressed', start, 1);
        await pause();
        await dispatch('mouseMoved', end, 1);
        await pause();
        if (whileHeld) {
          // Cross the host's selection poll with a real captured pointer still held.
          await new Promise((resolve) => setTimeout(resolve, 450));
          await whileHeld();
        }
        await dispatch('mouseReleased', end, 0);
      };
      const initial = await geometry('initial');
      const contents = doc()!;
      previewWasVisible = window.isVisible() && !!contents;
      assert.equal(previewWasVisible, true);
      assert.equal(contents.origin, 'null');
      assert.equal(window.contentView.children.length, 1, 'Office has no native document view');
      const zoomTrigger = '[role="combobox"][aria-label="预览缩放"]';
      const previewZoom = () =>
        preview.readInteraction(currentId, currentGeneration, false).then((value) => value.zoom);
      const toolbarZoom = () =>
        primary.webContents.executeJavaScript(
          `document.querySelector(${JSON.stringify(zoomTrigger)})?.textContent.trim()`,
        );
      const wheel = async (deltaY: number, modifiers: number, deltaX = 0) => {
        const bounds = await frameBounds();
        return primary.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: Math.round(bounds.x + bounds.width / 2),
          y: Math.round(bounds.y + bounds.height / 2),
          deltaX,
          deltaY,
          modifiers,
        });
      };
      const keyZoom = async (key: '=' | '-' | '0', modifier: 'control' | 'meta') => {
        const code = { '=': 'Equal', '-': 'Minus', '0': 'Digit0' }[key];
        const windowsVirtualKeyCode = { '=': 187, '-': 189, '0': 48 }[key];
        for (const type of ['rawKeyDown', 'keyUp'])
          await primary.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
            type,
            key,
            code,
            windowsVirtualKeyCode,
            modifiers: modifier === 'control' ? 2 : 4,
          });
      };
      const verifyZoom = async (format: string, modifier: 'control' | 'meta', scroller: string) => {
        const documentFrame = doc()!;
        const state = await documentFrame.executeJavaScript(`(() => {
          document.body.tabIndex = -1;
          document.body.focus({preventScroll:true});
          return visualViewport.scale;
        })()`);
        await until(async () => primary.webContents.focusedFrame === documentFrame, Boolean);
        const shellZoom = primary.webContents.getZoomFactor();
        const bounds = await frameBounds();
        await preview.control(currentId, currentGeneration, { kind: 'zoom', value: 1 });
        await until(toolbarZoom, (label) => label === '100%');
        await keyZoom('=', modifier);
        await until(previewZoom, (value) => value === 1.25);
        await until(toolbarZoom, (label) => label === '125%');
        await keyZoom('-', modifier);
        await until(previewZoom, (value) => value === 1);
        const scroll = async () =>
          Number(
            await documentFrame.executeJavaScript(
              `document.querySelector(${JSON.stringify(scroller)}).scrollTop`,
            ),
          );
        const initialScroll = await scroll();
        await wheel(180, 0);
        await until(scroll, (top) => top > initialScroll);
        assert.equal(await previewZoom(), 1);
        await wheel(-60, 2);
        const enlarged = await until(
          previewZoom,
          (value) => typeof value === 'number' && value > 1,
        );
        assert.ok(typeof enlarged === 'number' && enlarged < 1.25);
        await until(toolbarZoom, (label) => label === `${Math.round(enlarged * 100)}%`);
        await wheel(90, 2);
        await until(previewZoom, (value) => typeof value === 'number' && value < 1);
        await keyZoom('0', modifier);
        await until(previewZoom, (value) => value === 1);
        await until(toolbarZoom, (label) => label === '100%');
        assert.equal(await documentFrame.executeJavaScript('visualViewport.scale'), state);
        assert.equal(primary.webContents.getZoomFactor(), shellZoom);
        assert.deepEqual(await frameBounds(), bounds);
        await preview.control(currentId, currentGeneration, { kind: 'zoom', value: 'fit' });
        await documentFrame.executeJavaScript(
          `document.querySelector(${JSON.stringify(scroller)}).scrollTop = 0`,
        );
        await until(toolbarZoom, (label) => label === '适应');
        checks.push(`${format}-scoped-zoom-input-and-ordinary-scroll`);
      };
      const openMenu = async () => {
        await click(zoomTrigger);
        await until(
          () =>
            primary.webContents.executeJavaScript(
              '!!document.querySelector("[role=listbox]") && !!document.activeElement?.closest("[role=listbox]")',
            ),
          Boolean,
        );
        assert.equal(doc(), contents);
        assert.deepEqual(await frameBounds(), initial);
        const hits = await primary.webContents.executeJavaScript(
          `(() => {const opt=document.querySelector('[role=option]:last-child'); const r=opt.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;return y>${initial.y} && document.elementFromPoint(x,y)?.closest('[role=listbox]')!==null})()`,
        );
        assert.equal(hits, true, 'the option is above the file iframe at the shared point');
      };
      const closeMenu = async () => {
        await until(
          () =>
            primary.webContents.executeJavaScript(
              `!document.querySelector('[role=listbox]') && document.activeElement?.matches(${JSON.stringify(zoomTrigger)})`,
            ),
          Boolean,
        );
        assert.deepEqual(await frameBounds(), initial);
      };
      const chooseZoom = async (label: string, value: number | 'fit') => {
        await openMenu();
        const p = await primary.webContents.executeJavaScript(
          `(() => {const el=[...document.querySelectorAll('[role=option]')].find(e=>e.textContent.trim()===${JSON.stringify(label)}); const r=el.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`,
        );
        for (const type of ['mouseDown', 'mouseUp'] as const)
          primary.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, ...p });
        await closeMenu();
        await until(
          () => preview.readInteraction(currentId, currentGeneration, false),
          (state) => state.zoom === value,
        );
      };
      await openMenu();
      await capture('zoom-menu');
      primary.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      primary.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      await closeMenu();
      await chooseZoom('125%', 1.25);
      await chooseZoom('适应', 'fit');
      checks.push('zoom-menu-over-iframe-without-moving-preview');
      await verifyOfficePreviewTheme(
        contents,
        [
          { selector: '.xlsx-viewport', axis: 'vertical' },
          { selector: '.xlsx-tabs', axis: 'horizontal' },
        ],
        '.xlsx-tabs',
        '.xlsx-cell',
        () => capture('xlsx-dark-scrollbars'),
      );
      checks.push('excel-scrollbar-theme');
      await verifyZoom('excel', 'control', '.xlsx-viewport');
      const fitWidths = [640, 580, 540, 512, 440, 360, 320, 360, 440, 512, 580, 640];
      const fitSamples = [];
      for (const width of fitWidths) {
        await primary.webContents.executeJavaScript(
          `document.querySelector('.client-content-frame').style.width = '${width}px'`,
        );
        await until(frameBounds, (bounds) => Math.abs(bounds.width - width) < 2);
        const frames = (await doc()!.executeJavaScript(`(async () => {
          const viewport = document.querySelector('.xlsx-viewport');
          const first = viewport.querySelector('[data-row="0"][data-col="0"]');
          const next = viewport.querySelector('[data-row="1"][data-col="1"]');
          const tab = document.querySelector('.xlsx-tabs');
          const frames = [];
          for (let i = 0; i < 6; i++) {
            await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
            const rect = first.getBoundingClientRect(), adjacent = next.getBoundingClientRect();
            frames.push({
              dpr: devicePixelRatio,
              viewport: [viewport.clientWidth, viewport.clientHeight, viewport.scrollWidth, viewport.scrollHeight],
              scroll: [viewport.scrollLeft, viewport.scrollTop],
              edges: [rect.left, rect.right, rect.top, rect.bottom],
              gap: [adjacent.left - rect.right, adjacent.top - rect.bottom],
              font: parseFloat(getComputedStyle(first).fontSize),
              tabTop: tab.getBoundingClientRect().top,
            });
          }
          return frames;
        })()`)) as ExcelFitFrame[];
        fitSamples.push({ width, frames });
        if ([512, 320].includes(width)) await capture(`excel-fit-${width}`);
        if (width === 320) {
          const scrollLeft = () =>
            doc()!.executeJavaScript("document.querySelector('.xlsx-viewport').scrollLeft");
          await wheel(0, 0, 300);
          await until(scrollLeft, (offset) => Number(offset) > 0);
          assert.equal(await previewZoom(), 'fit');
          assert.equal(
            await doc()!.executeJavaScript(`(() => {
              const last = document.querySelector('[data-row="0"][data-col="7"]');
              const r = last.getBoundingClientRect();
              return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('td') === last;
            })()`),
            true,
          );
          await wheel(0, 0, -300);
          await until(scrollLeft, (offset) => offset === 0);
        }
      }
      await writeFile(join(root, 'excel-fit-frames.json'), JSON.stringify(fitSamples, null, 2));
      for (const { width, frames } of fitSamples) {
        const settled = frames.at(-1)!;
        assert.ok(settled.font >= 9.75, `unreadable fit text at ${width}px: ${settled.font}px`);
        for (const frame of frames) {
          assert.deepEqual(frame, settled, `unstable fit at ${width}px`);
          for (const edge of frame.edges)
            assert.ok(Math.abs(edge * frame.dpr - Math.round(edge * frame.dpr)) < 0.025);
          assert.ok(frame.gap.every((gap) => Math.abs(gap) < 0.025));
        }
        assert.equal(settled.viewport[2]! > settled.viewport[0]!, width <= 440);
      }
      assert.deepEqual(fitSamples[0]?.frames.at(-1), fitSamples.at(-1)?.frames.at(-1));
      await primary.webContents.executeJavaScript(
        "document.querySelector('.client-content-frame').style.width = ''",
      );
      await until(frameBounds, (bounds) => bounds.width === initial.width);
      checks.push('excel-narrow-fit-grid-stays-readable-and-stable');
      const point = (address: string) =>
        until<Point | null>(
          () =>
            contents.executeJavaScript(
              `(()=>{const cell=document.querySelector('.xlsx-cell[data-row="${Number(address.slice(1)) - 1}"][data-col="${address.charCodeAt(0) - 65}"]');if(!cell)return null;const r=cell.getBoundingClientRect();const x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);return document.elementFromPoint(x,y)?.closest('.xlsx-cell')===cell?{x,y}:null})()`,
            ) as Promise<Point | null>,
          Boolean,
        )
          .then((position) => {
            assert.ok(position);
            return position;
          })
          .catch(async (error: unknown) => {
            previewDiagnostic = await contents.executeJavaScript(
              "({viewport:[innerWidth,innerHeight],html:document.body.innerHTML.slice(0,240),cells:[...document.querySelectorAll('.xlsx-cell')].slice(0,24).map(e=>[e.dataset.row,e.dataset.col,e.getBoundingClientRect().toJSON()])})",
            );
            throw error;
          });
      const start = await point('D4'),
        end = await point('B2');
      await contents.executeJavaScript(
        `(()=>{window.fixturePointer=[];for(const name of ['pointerdown','pointermove','pointerup'])document.addEventListener(name,e=>window.fixturePointer.push({name,x:e.clientX,y:e.clientY,target:e.target?.className,buttons:e.buttons,isTrusted:e.isTrusted}),{capture:true})})()`,
      );
      await drag(start, end, async () => {
        const current = await preview.readInteraction(currentId, currentGeneration, false);
        assert.equal(current.selection, null);
        assert.equal(current.excelSelection, undefined);
        assert.deepEqual(await frameBounds(), initial);
        const shown = await contents.executeJavaScript(
          "!!document.querySelector('.xlsx-highlight')",
        );
        if (!shown) {
          previewDiagnostic = {
            pointer: await contents.executeJavaScript('window.fixturePointer'),
            bounds: await frameBounds(),
            start,
            end,
            root: await primary.webContents.executeJavaScript(
              '({active:document.activeElement?.outerHTML.slice(0,320),zoom:devicePixelRatio})',
            ),
          };
        }
        assert.ok(shown);
        assert.ok(
          await primary.webContents.executeJavaScript(
            "!document.querySelector('.native-excel-readonly')",
          ),
        );
      });
      await until(
        () =>
          primary.webContents.executeJavaScript(
            'document.querySelector(".native-excel-value textarea")?.value',
          ),
        (v) => v === '=SUM(B2:C3)',
      ).catch(async (error: unknown) => {
        previewDiagnostic = {
          start,
          end,
          pointer: await contents.executeJavaScript('window.fixturePointer'),
          interaction: await preview.readInteraction(currentId, currentGeneration, false),
          host: await primary.webContents.executeJavaScript('document.body.innerText.slice(0,450)'),
        };
        throw error;
      });
      const selected = await preview.readInteraction(currentId, currentGeneration, false);
      assert.equal(selected.excelSelection?.activeAddress, 'D4');
      assert.equal(selected.sourceHash, sourceHash);
      assert.equal(selected.selection?.kind, 'excel');
      assert.ok(selected.selection && 'range' in selected.selection);
      assert.equal(selected.selection.range, 'B2:D4');
      assert.equal(
        selected.selection.cells.find(({ address }) => address === 'D4')?.formula,
        '=SUM(B2:C3)',
      );
      checks.push('reverse-real-pointer-anchor-formula');
      await capture('selected');
      const collapsed = await primary.webContents.executeJavaScript(
        "(()=>{const e=document.querySelector('.native-excel-value textarea'),s=getComputedStyle(e);return {rows:e.rows,height:e.getBoundingClientRect().height,minHeight:s.minHeight,maxHeight:s.maxHeight,lineHeight:s.lineHeight,padding:s.padding,border:s.borderTopWidth}})()",
      );
      await writeFile(join(root, 'collapsed-height.json'), JSON.stringify(collapsed, null, 2));
      assert.equal(collapsed.rows, 1);
      assert.equal(Math.round(collapsed.height), 24);
      const paint = await contents.executeJavaScript(
        `(()=>{const cell=document.querySelector('.xlsx-cell[data-row="1"][data-col="1"]');const shade=cell?.querySelector('.xlsx-highlight');return {author:getComputedStyle(cell).backgroundColor,shade:shade?.getAttribute('aria-hidden'),hit:shade&&getComputedStyle(shade).pointerEvents}})()`,
      );
      assert.deepEqual(paint, { author: 'rgb(255, 255, 170)', shade: 'true', hit: 'none' });
      checks.push('source-fill-and-selection-decoration');
      await click('[aria-label="展开单元格内容"]');
      await pause();
      const expanded = await geometry('expanded');
      const expandedHeight = await primary.webContents.executeJavaScript(
        "(()=>{const e=document.querySelector('.native-excel-details textarea');return {rows:e.rows,height:e.getBoundingClientRect().height}})()",
      );
      assert.equal(expandedHeight.rows, 5);
      assert.equal(Math.round(expandedHeight.height), 100);
      assert.ok(expanded.y > initial.y);
      checks.push('expanded-host-bar-native-bounds');
      window.setSize(700, 700);
      await pause();
      await geometry('narrow');
      await preview.control(currentId, currentGeneration, { kind: 'zoom', value: 1.5 });
      await pause();
      await geometry('zoom150');
      await capture('expanded-narrow');
      await primary.webContents.executeJavaScript("document.documentElement.dataset.theme='dark'");
      await capture('expanded-dark');
      await writeFile(
        join(root, 'dark-style.json'),
        JSON.stringify(
          await primary.webContents.executeJavaScript(
            "[...document.querySelectorAll('.native-office-toolbar,.native-excel-readonly,.native-excel-readonly button,.native-excel-readonly textarea,.native-excel-details textarea')].map(e=>({tag:e.tagName,cls:e.className,color:getComputedStyle(e).color,font:getComputedStyle(e).font,background:getComputedStyle(e).backgroundColor,foreground:getComputedStyle(e).getPropertyValue('--foreground'),disabled:e.disabled}))",
          ),
          null,
          2,
        ),
      );
      await primary.webContents.executeJavaScript("document.documentElement.dataset.theme='light'");
      checks.push('narrow-zoom-layer-bounds-hit');
      await drag(await point('C3'), await point('B2'), async () => {
        const pending = await preview.readInteraction(currentId, currentGeneration, false);
        assert.deepEqual(pending.selection, selected.selection);
        assert.deepEqual(pending.excelSelection, selected.excelSelection);
        for (const type of ['rawKeyDown', 'keyUp'])
          await primary.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
            type,
            key: 'Escape',
            code: 'Escape',
            windowsVirtualKeyCode: 27,
          });
        await until(
          () => preview.readInteraction(currentId, currentGeneration, false),
          (value) => value.selection === null,
        );
      });
      await until(
        () =>
          primary.webContents.executeJavaScript(
            "!document.querySelector('.native-excel-readonly,.native-excel-details')",
          ),
        Boolean,
      );
      await drag(await point('D4'), await point('B2'));
      await pause();
      await preview.control(currentId, currentGeneration, { kind: 'request-edit' });
      await preview.readInteraction(currentId, currentGeneration, true);
      await until(
        () =>
          primary.webContents.executeJavaScript(
            "document.querySelector('.native-excel-readonly button')?.disabled",
          ),
        Boolean,
      );
      await assert.rejects(
        preview.control(currentId, currentGeneration, {
          kind: 'locate-selection',
          selectionSerial: selected.excelSelection!.selectionSerial,
        }),
        /preview_request_active/,
      );
      checks.push('frozen-request-locate-lock');
      await click('#replace');
      await until(
        () =>
          primary.webContents.executeJavaScript(
            'document.querySelector(".native-office-toolbar")?.getAttribute("aria-label")',
          ),
        (v) => v === 'B.xlsx 预览工具栏',
      );
      await until(
        () =>
          primary.webContents.executeJavaScript(
            '!document.querySelector(".native-excel-readonly, .native-excel-details, textarea")',
          ),
        Boolean,
      );
      checks.push('target-replacement-clears-readonly-and-request');
      await capture('replacement');
      await click('#word');
      const positions = await until<[Point, Point] | null>(async () => {
        const view = doc();
        if (!view || view === contents || view.url !== (await paintedFrame())) return null;
        return (await view.executeJavaScript(
          `(()=>{const paragraph=document.querySelector('[data-path="/body/p[1]"]');if(paragraph?.textContent!=='AB1CD')return null;const walker=document.createTreeWalker(paragraph,NodeFilter.SHOW_TEXT);for(let n=walker.nextNode();n;n=walker.nextNode()){if(n.textContent!=='CD')continue;const range=document.createRange();range.selectNodeContents(n);const r=range.getBoundingClientRect();const y=Math.round(r.y+r.height/2);return [{x:Math.ceil(r.left),y},{x:Math.floor(r.right),y}]};return null})()`,
        )) as [Point, Point] | null;
      }, Boolean);
      assert.ok(positions);
      await drag(positions[0], positions[1]);
      const word = await until(
        () => preview.readInteraction(currentId, currentGeneration, false),
        (state) => state.selection?.kind === 'word',
      );
      assert.equal(word.sourceHash, hash(notes));
      assert.deepEqual(word.selection, {
        kind: 'word',
        start: { path: '/body/p[1]', offset: 2 },
        end: { path: '/body/p[1]', offset: 4 },
        text: 'CD',
      });
      checks.push('word-footnote-source-offsets');
      await capture('footnote-selection');
      const wordFrame = doc()!;
      await verifyOfficePreviewTheme(
        wordFrame,
        [{ selector: 'html', axis: 'vertical' }, { selector: '.kite-word-rail' }],
        'html',
        'section.kite-docx.page',
        () => capture('word-dark-scrollbars'),
      );
      checks.push('word-scrollbar-theme');
      await verifyZoom('word', 'control', 'html');
      window.setContentSize(640, 620);
      await click('#pdf');
      const pdf = await until(async () => {
        const frame = doc();
        if (!frame || frame === wordFrame || frame.url !== (await paintedFrame())) return null;
        return (await frame.executeJavaScript(
          `document.querySelector("main img")?.complete && document.querySelector("main img")?.naturalWidth === ${pdfWidth}`,
        ))
          ? frame
          : null;
      }, Boolean);
      assert.ok(pdf);
      await preview.control(currentId, currentGeneration, { kind: 'zoom', value: 2 });
      await verifyOfficePreviewTheme(
        pdf,
        [
          { selector: 'html', axis: 'vertical' },
          { selector: 'main', axis: 'horizontal' },
          { selector: 'nav', axis: 'vertical' },
        ],
        'nav',
        'main img',
        () => capture('pdf-dark-scrollbars'),
      );
      await preview.control(currentId, currentGeneration, { kind: 'zoom', value: 'fit' });
      checks.push('pdf-scrollbar-theme');
      await verifyZoom('pdf', 'meta', 'html');
      await preview.control(currentId, currentGeneration, { kind: 'zoom', value: 1 });
      const recordPinch = `window.fixturePinch=[];window.addEventListener('wheel',e=>window.fixturePinch.push({x:e.clientX,y:e.clientY,ctrl:e.ctrlKey,delta:e.deltaY,trusted:e.isTrusted}),{passive:true,capture:true})`;
      await primary.webContents.executeJavaScript(recordPinch);
      await pdf.executeJavaScript(recordPinch);
      const pinch = async (scaleFactor: number) => {
        const bounds = await frameBounds();
        return primary.webContents.debugger.sendCommand('Input.synthesizePinchGesture', {
          x: Math.round(bounds.x + bounds.width / 2),
          y: Math.round(bounds.y + bounds.height / 2),
          gestureSourceType: 'mouse',
          scaleFactor,
        });
      };
      await pinch(1.3);
      await pause();
      previewDiagnostic = {
        zoom: await previewZoom(),
        root: await primary.webContents.executeJavaScript('window.fixturePinch'),
        frame: await pdf.executeJavaScript('window.fixturePinch'),
        bounds: await frameBounds(),
      };
      const pinched = await until(previewZoom, (scale) => typeof scale === 'number' && scale > 1);
      assert.ok(typeof pinched === 'number' && pinched >= 1.15 && pinched <= 1.35, String(pinched));
      await pinch(0.7);
      await until(previewZoom, (scale) => typeof scale === 'number' && scale < 1);
      assert.equal(await pdf.executeJavaScript('visualViewport.scale'), 1);
      assert.equal(primary.webContents.getZoomFactor(), 1);
      await preview.control(currentId, currentGeneration, { kind: 'zoom', value: 'fit' });
      checks.push('pdf-chromium-touchpad-pinch');
      const pdfRail = () =>
        pdf.executeJavaScript(`(() => {
          const rail = document.querySelector('nav');
          const { width, y, height } = rail.getBoundingClientRect();
          return { width, y, height, clientWidth: rail.clientWidth, scrollWidth: rail.scrollWidth,
            verticalOverflow: rail.scrollHeight > rail.clientHeight, top: rail.scrollTop,
            viewportWidth: innerWidth, compact: rail.classList.contains('kite-rail-compact'),
            thumbnailVisible: getComputedStyle(rail.querySelector('img')).visibility === 'visible',
            selectedPage: Number(rail.querySelector('[aria-current="true"]').dataset.page),
            image: document.querySelector('main img').getBoundingClientRect().toJSON() };
        })()`) as Promise<{
          width: number;
          y: number;
          height: number;
          clientWidth: number;
          scrollWidth: number;
          verticalOverflow: boolean;
          top: number;
          viewportWidth: number;
          compact: boolean;
          thumbnailVisible: boolean;
          selectedPage: number;
          image: unknown;
        }>;
      const previewMouse = async (type: string, x: number, y: number, deltaY?: number) => {
        const bounds = await frameBounds();
        return primary.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
          type,
          x: bounds.x + x,
          y: bounds.y + y,
          ...(deltaY === undefined ? {} : { deltaX: 0, deltaY }),
        });
      };
      const moveOutsideRail = async () =>
        previewMouse('mouseMoved', (await frameBounds()).width - 8, 8);
      const goToPdfPage = async (page: number) => {
        const point = (await pdf.executeJavaScript(
          `(() => {const r=document.querySelector('button[data-page="${page}"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
        )) as Point;
        await drag(point, point);
        await until(
          () =>
            pdf.executeJavaScript(
              `(() => {const img=document.querySelector('main img[alt="第 ${page} 页"]');return img?.complete && img.naturalWidth === ${pdfWidth}})()`,
            ),
          Boolean,
        );
      };
      await moveOutsideRail();
      const wideRail = await until(pdfRail, (rail) => rail.viewportWidth >= 600 && !rail.compact);
      assert.equal(wideRail.width, 104);
      assert.equal(wideRail.thumbnailVisible, true);
      assert.ok(wideRail.scrollWidth <= wideRail.clientWidth, 'wide PDF rail fits');
      assert.equal(wideRail.verticalOverflow, true);
      await previewMouse('mouseWheel', 14, 100, 300);
      const wideScrolled = await until(pdfRail, (rail) => rail.top > 0);
      assert.deepEqual(wideScrolled.image, wideRail.image);
      await previewMouse('mouseWheel', 14, 100, -300);
      await until(pdfRail, (rail) => rail.top === 0);
      await goToPdfPage(3);
      await pdf.executeJavaScript('document.activeElement.blur()');
      await moveOutsideRail();
      // Control the iframe width in CSS pixels so OS scale and native size rounding cannot skip 599.
      const setFrameWidth = (width: string) =>
        primary.webContents.executeJavaScript(
          `document.querySelector('.native-file-preview-iframe').style.width = ${JSON.stringify(width)}`,
        );
      await setFrameWidth('600px');
      const wideBoundary = await until(pdfRail, (rail) => rail.viewportWidth === 600);
      assert.equal(wideBoundary.compact, false);
      assert.equal(wideBoundary.thumbnailVisible, true);
      assert.ok(wideBoundary.scrollWidth <= wideBoundary.clientWidth);
      assert.equal(wideBoundary.selectedPage, 3);
      await setFrameWidth('599px');
      const narrowBoundary = await until(
        pdfRail,
        (rail) => rail.viewportWidth === 599 && rail.compact,
      );
      assert.equal(narrowBoundary.width, 32);
      assert.equal(narrowBoundary.thumbnailVisible, false);
      assert.ok(narrowBoundary.scrollWidth <= narrowBoundary.clientWidth);
      assert.equal(narrowBoundary.selectedPage, 3);
      checks.push('pdf-wide-rail-and-compact-breakpoint');
      await setFrameWidth('');
      window.setContentSize(520, 620);
      const compactRail = await until(
        pdfRail,
        (rail) => rail.viewportWidth < 600 && rail.width === 32,
      );
      assert.ok(compactRail.scrollWidth <= compactRail.clientWidth, 'compact PDF rail fits');
      const railMiddle = compactRail.y + compactRail.height / 2;
      await previewMouse('mouseMoved', 14, railMiddle);
      const expandedRail = await until(pdfRail, (rail) => rail.width === 104);
      assert.ok(expandedRail.scrollWidth <= expandedRail.clientWidth, 'expanded PDF rail fits');
      assert.equal(expandedRail.verticalOverflow, true);
      assert.deepEqual(expandedRail.image, compactRail.image);
      await previewMouse('mouseWheel', 14, railMiddle, 300);
      const scrolledRail = await until(pdfRail, (rail) => rail.top > 0);
      assert.deepEqual(scrolledRail.image, compactRail.image);
      await previewMouse('mouseWheel', 14, railMiddle, -300);
      await until(pdfRail, (rail) => rail.top === 0);
      await moveOutsideRail();
      await until(pdfRail, (rail) => rail.width === 32);
      await pdf.executeJavaScript("document.querySelector('nav').focus()");
      const focusedRail = await until(pdfRail, (rail) => rail.width === 104);
      assert.ok(
        focusedRail.scrollWidth <= focusedRail.clientWidth,
        'keyboard-focused PDF rail fits',
      );
      assert.deepEqual(focusedRail.image, compactRail.image);
      checks.push('pdf-rail-fits-and-scrolls-vertically');
      await goToPdfPage(2);
      await preview.control(currentId, currentGeneration, { kind: 'request-edit' });
      const pdfRequest = await preview.readInteraction(currentId, currentGeneration);
      assert.equal(pdfRequest.floatingSelection?.kind, 'pdf');
      assert.equal(
        pdfRequest.floatingSelection?.kind === 'pdf' && pdfRequest.floatingSelection.page,
        2,
      );
      assert.equal(pdfRequest.requestOpen, true);
      await wheel(-120, 2);
      await pinch(1.2);
      await pause();
      assert.equal(await previewZoom(), 'fit');
      assert.equal(
        (await preview.readInteraction(currentId, currentGeneration, false)).requestOpen,
        true,
      );
      checks.push('pdf-iframe-page-resource-and-exact-request');
      await capture('pdf-page-request');
      await primary.webContents.executeJavaScript(
        "document.querySelector('.native-file-preview-iframe').remove()",
      );
      await until(
        () =>
          primary.webContents.executeJavaScript(
            `document.querySelector('.native-file-preview-error [role=status]')?.textContent`,
          ),
        (status) => status === '预览已中断',
      );
      assert.equal(pdf.isDestroyed(), true);
      assert.equal(window.contentView.children.length, 1);
      await click('.native-file-preview-error button');
      await until(
        () =>
          primary.webContents.executeJavaScript(
            `!!document.querySelector('.native-file-preview-iframe:not([data-loading])')`,
          ),
        Boolean,
      );
      assert.ok(doc());
      checks.push('interrupted-iframe-releases-input-and-retries');
      passed = true;
    } catch (error) {
      failure = String(error);
      console.error(error);
    } finally {
      ipcMain.removeHandler('readonly-fixture-request');
      ipcMain.removeHandler('readonly-fixture-layout');
      ipcMain.removeAllListeners('readonly-fixture-layout');
      preview.close();
      if (!window.isDestroyed()) window.destroy();
      await pause();
      const viewsDestroyed = webContents.getAllWebContents().length === 0;
      await writeFile(
        join(root, 'receipt.json'),
        JSON.stringify(
          {
            passed,
            failure,
            checks,
            captures,
            captureUnavailable,
            geometries,
            previewDiagnostic,
            viewsDestroyed,
            normalSandbox: !app.commandLine.hasSwitch('no-sandbox'),
            previewWasVisible,
            captureKind: 'Root capturePage with the Office iframe',
            businessRequests: 0,
          },
          null,
          2,
        ),
      );
      app.exit(passed && viewsDestroyed ? 0 : 1);
    }
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
