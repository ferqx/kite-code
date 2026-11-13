/** Hidden real Chromium; synthetic cache, no Service, business sends or clipboard. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { officePreviewRecipeVersion, officeRendererVersion } from '@kite-ai/agent/documents';
import { app, BrowserWindow, ipcMain, type WebContentsView, webContents } from 'electron';
import type { NativeRootWindow } from '../electron/native-root-window';
import { NativeOutputPreview, registerOutputPreviewScheme } from '../electron/output-preview';
import type { NativeOutputRequest } from '../src/output-files-bridge';

const root = resolve(process.argv[2]!);
registerOutputPreviewScheme();
app.on('window-all-closed', () => {});
app.setPath('userData', join(root, 'profile'));
app.setPath('crashDumps', join(root, 'crash'));
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const pause = () => new Promise((r) => setTimeout(r, 80));
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
    const window = new BrowserWindow({
      width: 1100,
      height: 800,
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        preload: join(root, 'preload.cjs'),
        backgroundThrottling: false,
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
    let passed = false;
    let failure = '';
    let currentId = '';
    let currentGeneration = 1;
    const bytes = Buffer.from('synthetic workbook fixture');
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
      name: `${id}.xlsx`,
      ownerRunId: 'fixture',
      mediaType: 'application/octet-stream',
      size: String(bytes.length),
      publishedAt: '2026-11-12T00:00:00Z',
      sourceHash,
    });
    try {
      assert.equal(app.commandLine.hasSwitch('no-sandbox'), false);
      const directory = join(root, 'render');
      await mkdir(directory);
      const rows = Array.from(
        { length: 30 },
        (_, r) =>
          '<tr><th>' +
          (r + 1) +
          '</th>' +
          Array.from({ length: 8 }, (_, c) => {
            const a = String.fromCharCode(65 + c) + (r + 1);
            return (
              '<td data-path="/S/' +
              a +
              '"' +
              (a === 'D4' ? ' data-formula="=SUM(B2:C3)"' : '') +
              '>' +
              a +
              '</td>'
            );
          }).join('') +
          '</tr>',
      ).join('');
      const html = Buffer.from(
        '<!doctype html><style>body{margin:0}table{border-collapse:collapse}td,th{border:1px solid #999;min-width:90px;height:30px} .table-wrapper{overflow:auto;height:100vh}</style><div class="sheet-content active" data-sheet="0"><div class="table-wrapper"><table><thead><tr><th></th>' +
          Array.from({ length: 8 }, (_, i) => `<th>${String.fromCharCode(65 + i)}</th>`).join('') +
          '</tr></thead><tbody>' +
          rows +
          '</tbody></table></div></div><div class="sheet-tabs"><button class="sheet-tab active" data-sheet="0">S</button></div>',
      );
      const absolutePath = join(directory, 'index.html');
      await writeFile(absolutePath, html, { flag: 'wx' });
      (preview as unknown as { cache: Map<string, unknown> }).cache.set(
        `${sourceHash}:${officeRendererVersion}:${officePreviewRecipeVersion}`,
        {
          directory,
          entry: 'index.html',
          files: [
            {
              path: 'index.html',
              absolutePath,
              mimeType: 'text/html',
              size: html.length,
              sha256: hash(html),
            },
          ],
        },
      );
      ipcMain.handle('readonly-fixture-request', async (event, request: NativeOutputRequest) => {
        assert.equal(event.sender, primary.webContents);
        switch (request.method) {
          case 'outputs.info':
            return { kind: 'outputs.info', file: info(request.target.fileId) };
          case 'outputs.preview.open':
            currentId = request.previewId;
            currentGeneration = request.generation;
            await preview.open({
              id: request.previewId,
              generation: request.generation,
              target: request.target,
              window: window as NativeRootWindow,
              bounds: request.bounds,
              check() {},
              async materialize(path) {
                await writeFile(path, bytes, { flag: 'wx' });
                return info(request.target.fileId);
              },
            });
            return { kind: 'outputs.preview', status: 'ready' };
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
      });
      await primary.webContents.loadFile(join(root, 'host.html'));
      const doc = () =>
        window.contentView.children.find(
          (v) => (v as WebContentsView).webContents !== primary.webContents,
        ) as WebContentsView;
      await until(
        async () =>
          !!doc() &&
          (await primary.webContents.executeJavaScript(
            '!!document.querySelector(".native-excel-readonly")',
          )),
        Boolean,
      );
      await pause();
      const geometry = async (label: string) => {
        const state = await primary.webContents.executeJavaScript(
          `(()=>{const bar=document.querySelector('.native-excel-readonly').getBoundingClientRect(); const viewport=document.querySelector('.native-file-preview > div[style]')?.getBoundingClientRect();return {bar:{bottom:bar.bottom,left:bar.left,top:bar.top,right:bar.right},viewport:viewport?{x:viewport.x,y:viewport.y,width:viewport.width,height:viewport.height}:null,hit:document.elementFromPoint(bar.left+20,bar.top+12)?.closest('.native-excel-readonly')!==null}})()`,
        );
        const bounds = doc().getBounds();
        assert.ok(state.bar.bottom <= bounds.y + 1);
        assert.equal(state.hit, true);
        assert.ok(state.viewport);
        assert.deepEqual(
          bounds,
          Object.fromEntries(
            Object.entries(state.viewport).map(([key, value]) => [key, Math.round(Number(value))]),
          ),
        );
        geometries.push({ label, state, bounds });
        return bounds;
      };
      const click = async (selector: string) => {
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
      const capture = async (name: string) => {
        await new Promise((resolve) => setTimeout(resolve, 350));
        await primary.webContents.executeJavaScript(
          'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
        );
        await pause();
        for (const [label, wc] of [
          ['host', primary.webContents],
          ['preview', doc().webContents],
        ] as const) {
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
      const initial = await geometry('initial');
      const contents = doc().webContents;
      contents.on('console-message', (_event, level, message) =>
        console.error('preview-console', level, message),
      );
      const point = async (address: string) =>
        contents.executeJavaScript(
          `(()=>{const r=document.querySelector('[data-path="/S/${address}"]').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`,
        );
      const start = await point('D4'),
        end = await point('B2');
      contents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...start });
      contents.sendInputEvent({
        type: 'mouseMove',
        button: 'left',
        modifiers: ['leftButtonDown'],
        ...end,
      });
      contents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...end });
      await until(
        () =>
          primary.webContents.executeJavaScript(
            'document.querySelector(".native-excel-value textarea").value',
          ),
        (v) => v === '=SUM(B2:C3)',
      );
      const selected = await preview.readInteraction(currentId, currentGeneration, false);
      assert.equal(selected.excelSelection?.activeAddress, 'D4');
      checks.push('reverse-real-pointer-anchor-formula');
      await capture('selected');
      const collapsed = await primary.webContents.executeJavaScript(
        "(()=>{const e=document.querySelector('.native-excel-value textarea'),s=getComputedStyle(e);return {rows:e.rows,height:e.getBoundingClientRect().height,minHeight:s.minHeight,maxHeight:s.maxHeight,lineHeight:s.lineHeight,padding:s.padding,border:s.borderTopWidth}})()",
      );
      await writeFile(join(root, 'collapsed-height.json'), JSON.stringify(collapsed, null, 2));
      assert.equal(collapsed.rows, 1);
      assert.equal(Math.round(collapsed.height), 28);
      const isolatedPaint = await contents.executeJavaScript(
        `(()=>{const host=[...document.querySelectorAll('*')].find(e=>e.shadowRoot?.querySelector('.kite-excel-range-edge'));const edge=host?.shadowRoot.querySelector('.kite-excel-range-edge');if(!edge)return null;const before=edge.getBoundingClientRect().toJSON();const style=document.createElement('style');style.textContent='.kite-excel-range-edge{background:magenta!important;border:10px solid cyan!important}';document.head.append(style);const css=getComputedStyle(edge);return {before,after:edge.getBoundingClientRect().toJSON(),background:css.backgroundColor,border:css.borderTopWidth,leaked:!!document.querySelector('.kite-excel-range-edge')}})()`,
      );
      assert.ok(isolatedPaint);
      assert.equal(isolatedPaint.background, 'rgb(115, 115, 115)');
      assert.equal(isolatedPaint.border, '0px');
      assert.equal(isolatedPaint.leaked, false);
      assert.deepEqual(isolatedPaint.after, isolatedPaint.before);
      checks.push('shadow-style-isolation-not-security-boundary');
      await click('[aria-label="展开单元格内容"]');
      await pause();
      const expanded = await geometry('expanded');
      const expandedHeight = await primary.webContents.executeJavaScript(
        "(()=>{const e=document.querySelector('.native-excel-value textarea');return {rows:e.rows,height:e.getBoundingClientRect().height}})()",
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
            "[...document.querySelectorAll('.native-office-toolbar,.native-office-pill,.native-excel-readonly,.native-excel-readonly button,.native-excel-readonly textarea')].map(e=>({tag:e.tagName,cls:e.className,color:getComputedStyle(e).color,font:getComputedStyle(e).font,background:getComputedStyle(e).backgroundColor,foreground:getComputedStyle(e).getPropertyValue('--foreground'),disabled:e.disabled}))",
          ),
          null,
          2,
        ),
      );
      await primary.webContents.executeJavaScript("document.documentElement.dataset.theme='light'");
      checks.push('narrow-zoom-layer-bounds-hit');
      const againStart = await point('D4'),
        againEnd = await point('B2');
      contents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...againStart });
      contents.sendInputEvent({
        type: 'mouseMove',
        button: 'left',
        modifiers: ['leftButtonDown'],
        ...againEnd,
      });
      contents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...againEnd });
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
            'document.querySelector(".native-office-identity strong").textContent',
          ),
        (v) => v === 'B.xlsx',
      );
      await until(
        () =>
          primary.webContents.executeJavaScript(
            'document.querySelector(".native-excel-value textarea").value',
          ),
        (v) => v === '',
      );
      checks.push('target-replacement-clears-readonly-and-request');
      await capture('replacement');
      passed = true;
    } catch (error) {
      failure = String(error);
      console.error(error);
    } finally {
      ipcMain.removeHandler('readonly-fixture-request');
      preview.close();
      primary.webContents.close();
      window.destroy();
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
            viewsDestroyed,
            normalSandbox: !app.commandLine.hasSwitch('no-sandbox'),
            windowWasHidden: true,
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
