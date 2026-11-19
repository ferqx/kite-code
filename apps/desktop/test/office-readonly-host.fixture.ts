/** Isolated real Chromium; original workbook path, no Service, business sends or clipboard. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { app, ipcMain, type WebContentsView, webContents } from 'electron';
import { createNativeRootWindow, getNativeRootView } from '../electron/native-root-window';
import { NativeOutputPreview, registerOutputPreviewScheme } from '../electron/output-preview';
import { parseNativePreviewLayout } from '../src/native-preview-layout-bridge';
import type { NativeOutputRequest } from '../src/output-files-bridge';

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
    const original = (id: string) => (id === 'notes' ? notes : bytes);
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
      name: id === 'notes' ? 'notes.docx' : `${id}.xlsx`,
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
              await preview.open({
                id: request.previewId,
                generation: request.generation,
                target: request.target,
                window,
                bounds: request.bounds,
                check() {},
                async materialize(path) {
                  await writeFile(path, original(request.target.fileId), { flag: 'wx' });
                  return info(request.target.fileId);
                },
              });
              const view = doc();
              assert.equal(view.getVisible(), false);
              assert.equal(view.webContents.getBackgroundThrottling(), true);
              return { kind: 'outputs.preview', status: 'ready' };
            }
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
      const doc = () =>
        window.contentView.children.find((v) =>
          (v as WebContentsView).webContents?.getURL().startsWith('kite-preview:'),
        ) as WebContentsView;
      const capture = async (name: string) => {
        await new Promise((resolve) => setTimeout(resolve, 350));
        await primary.webContents.executeJavaScript(
          'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
        );
        await pause();
        for (const [label, wc] of [
          ['host', primary.webContents],
          ['preview', doc()?.webContents],
        ] as const) {
          if (!wc) continue;
          const filename = `${name}-${label}.png`;
          try {
            await writeFile(
              join(root, filename),
              (await wc.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG(),
            );
            captures.push(filename);
          } catch (error) {
            captureUnavailable.push({ filename, error: String(error) });
          }
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
              const icons = viewport?.querySelectorAll('svg[role="status"][aria-label="文件预览加载中"]');
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
          doc()?.getVisible() &&
          (await primary.webContents.executeJavaScript(
            '!!document.querySelector(".native-office-toolbar") && !document.querySelector(".native-excel-readonly,textarea")',
          )),
        Boolean,
      ).catch(async (error: unknown) => {
        previewDiagnostic = {
          host: await primary.webContents.executeJavaScript(
            `({text:document.body.innerText.slice(0,400),hidden:document.hidden,viewport:document.querySelector('.native-file-preview > .native-file-preview-viewport')?.getBoundingClientRect().toJSON()})`,
          ),
          child: doc()?.webContents.getURL(),
          layoutReports,
          bounds: doc()?.getBounds(),
          visible: doc()?.getVisible(),
          contentSize: window.getContentSize(),
          rootBounds: getNativeRootView(window)?.getBounds(),
          childState: await doc()?.webContents.executeJavaScript(
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
        const bounds = doc().getBounds();
        geometries.push({ label, state, bounds });
        assert.ok(state.bar.bottom <= bounds.y + 1);
        assert.equal(state.hit, true);
        assert.ok(state.viewport);
        const viewport = state.viewport;
        const [width = 0, height = 0] = window.getContentSize();
        assert.equal(bounds.x, Math.ceil(viewport.x));
        assert.equal(bounds.y, Math.ceil(viewport.y));
        assert.equal(
          bounds.x + bounds.width,
          Math.min(width, Math.floor(viewport.x + viewport.width)),
        );
        assert.equal(
          bounds.y + bounds.height,
          Math.min(height, Math.floor(viewport.y + viewport.height)),
        );
        return bounds;
      };
      const drag = async (start: Point, end: Point, whileHeld?: () => Promise<void>) => {
        window.focus();
        const view = doc().webContents;
        view.focus();
        view.sendInputEvent({ type: 'mouseMove', ...start });
        view.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...start });
        await pause();
        view.sendInputEvent({
          type: 'mouseMove',
          button: 'left',
          modifiers: ['leftbuttondown'],
          ...end,
        });
        await pause();
        if (whileHeld) {
          // Cross the host's selection poll with a real captured pointer still held.
          await new Promise((resolve) => setTimeout(resolve, 450));
          await whileHeld();
        }
        view.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...end });
      };
      const initial = await geometry('initial');
      const contents = doc().webContents;
      previewWasVisible = window.isVisible() && doc().getVisible();
      assert.equal(previewWasVisible, true);
      const point = (address: string) =>
        until<Point | null>(
          () =>
            contents.executeJavaScript(
              `(()=>{const cell=document.querySelector('.xlsx-cell[data-row="${Number(address.slice(1)) - 1}"][data-col="${address.charCodeAt(0) - 65}"]');if(!cell)return null;const r=cell.getBoundingClientRect();const x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);return document.elementFromPoint(x,y)?.closest('.xlsx-cell')===cell?{x,y}:null})()`,
            ),
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
        assert.deepEqual(doc().getBounds(), initial);
        assert.ok(await contents.executeJavaScript("!!document.querySelector('.xlsx-highlight')"));
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
        contents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
        contents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
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
            "document.querySelector('.native-excel-readonly button').disabled",
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
        if (!view?.getVisible() || view.webContents === contents) return null;
        return await view.webContents.executeJavaScript(
          `(()=>{const paragraph=document.querySelector('[data-path="/body/p[1]"]');if(paragraph?.textContent!=='AB1CD')return null;const walker=document.createTreeWalker(paragraph,NodeFilter.SHOW_TEXT);for(let n=walker.nextNode();n;n=walker.nextNode()){if(n.textContent!=='CD')continue;const range=document.createRange();range.selectNodeContents(n);const r=range.getBoundingClientRect();const y=Math.round(r.y+r.height/2);return [{x:Math.ceil(r.left),y},{x:Math.floor(r.right),y}]};return null})()`,
        );
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
            captureKind: 'separate WebContents capturePage; not OS composition',
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
