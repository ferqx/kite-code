/** Hidden sandbox Chromium layout regression. Synthetic converter markup, never a user file or model run. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, nativeTheme } from 'electron';
import {
  type OfficeInteraction,
  officeInteractionControlScript,
  officeInteractionInstallScript,
  officeInteractionPeekScript,
  officeInteractionReadScript,
  officeInteractionReleaseScript,
  officeInteractionWorld,
} from '../electron/office-preview-interaction';

const root = resolve(process.argv[2]!);
app.setPath('userData', join(root, 'profile'));
app.on('window-all-closed', () => {});
const gridCss = `body :not(.katex):not(.katex *){font-family:KiteDocument,serif!important}*{margin:0;padding:0;box-sizing:border-box}html,body{height:100%}body{font-family:'Segoe UI';display:flex;flex-direction:column;background:#fff}.sheet-content{display:flex;flex:1;min-height:0;flex-direction:column}.table-wrapper{flex:1;overflow:auto;min-height:0;background:#fff}table{border-collapse:collapse;table-layout:fixed;font:16px 'Segoe UI'}.row-header-col{width:40px}th{background:#f8f8f8;border:1px solid #e0e0e0;font-weight:normal;color:#666;font-size:10px;text-align:center;padding:2px 4px}.corner-cell{background:#f0f0f0;position:sticky;left:0;top:0;z-index:4}.col-header{position:sticky;top:0;z-index:3;background:#f8f8f8;min-width:50px}.row-header{position:sticky;left:0;z-index:2;background:#f8f8f8;min-width:40px;border-right:none}td{padding:1px 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;vertical-align:bottom}table:not(.no-grid) td{box-shadow:inset -1px -1px 0 #e0e0e0}table:not(.no-grid) tbody tr:first-child td{box-shadow:inset -1px -1px 0 #e0e0e0,inset 0 1px 0 #e0e0e0}table:not(.no-grid) tr td:first-of-type{box-shadow:inset -1px -1px 0 #e0e0e0,inset 1px 0 0 #e0e0e0}table:not(.no-grid) tbody tr:first-child td:first-of-type{box-shadow:inset -1px -1px 0 #e0e0e0,inset 1px 1px 0 #e0e0e0}`;
function html(frozen: boolean, author: boolean) {
  return `<!doctype html><meta charset="utf-8"><style>${gridCss}</style><span id="fixture-paint" style="position:fixed;bottom:0;left:0;width:6px;height:6px;z-index:2147483646;pointer-events:none;background:rgb(1,2,3)"></span><details role="note" style="position:fixed;top:8px;right:8px;z-index:10000;max-width:calc(100vw - 16px);padding:6px;border-radius:4px;background:#fff;color:#222;box-shadow:0 1px 5px #0004;font:12px sans-serif"><summary style="cursor:pointer">Kite 离线预览说明</summary>排版可能与 Office 不同；复杂 3D 与动画不受支持。</details><div class="sheet-content active" data-sheet="0"><div class="table-wrapper"><table style="width:1226.6px"><colgroup><col class="row-header-col">${'<col style="width:59.33px">'.repeat(20)}</colgroup><thead><tr><th class="corner-cell"></th>${Array.from({ length: 20 }, (_, c) => `<th class="col-header">${String.fromCharCode(65 + c)}</th>`).join('')}</tr></thead><tbody>${Array.from({ length: 50 }, (_, r) => `<tr ${r === 0 && frozen ? 'data-frozen=""' : ''}><th class="row-header">${r + 1}</th>${Array.from({ length: 20 }, (_, c) => `<td data-path="/S/${String.fromCharCode(65 + c)}${r + 1}" ${r === 2 && c === 2 ? 'data-formula="SUM(A1:A2)"' : ''} style="${r === 0 && frozen ? 'position:sticky;z-index:2;top:18px;background:white;' : ''}${c === 0 && frozen ? 'position:sticky;z-index:2;left:40px;background:white;' : ''}${r === 0 && author ? 'border-top:3px solid rgb(200,0,0);' : ''}${r === 0 && author && c === 1 ? 'border-left:2px solid rgb(0,0,200);' : ''}${r === 2 && c === 2 ? 'background:rgb(255,240,180);' : ''}">${r === 3 && c === 3 ? '长内容 '.repeat(80) : `${r + 1},${c + 1}`}</td>`).join('')}</tr>`).join('')}</tbody></table></div></div><div class="sheet-tabs"><div class="sheet-tab active" data-sheet="0">S</div></div><script>const h=document.querySelector('thead').offsetHeight;document.querySelectorAll('tr[data-frozen] td').forEach(e=>e.style.top=h+'px')</script>`;
}
type Rect = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
};
type State = {
  dpr: number;
  sourceFont: string;
  innerWidth: number;
  head: Rect;
  marker: Rect;
  viewport: Rect;
  body: Rect;
  bar: Rect | null;
  layer: Rect | null;
  fills: Rect[];
  edges: Rect[];
  inline: string[];
  name: string;
  value: string;
  selection: OfficeInteraction;
  scroll: { left: number; top: number };
  frozen: Rect | null;
};
const inspect = `(()=>{const r=e=>{if(!e)return null;const q=e.getBoundingClientRect();return {left:q.left,right:q.right,top:q.top,bottom:q.bottom,width:q.width,height:q.height}};const d=document,p=d.querySelector('.kite-office-selection-paint')?.shadowRoot,w=d.querySelector('.table-wrapper'),h=d.querySelector('thead .col-header:nth-child(4)').getBoundingClientRect(),a=w.getBoundingClientRect(),cells=[...d.querySelectorAll('tbody tr td:nth-child(4)')],b=cells.find(e=>{const r=e.getBoundingClientRect();return r.top>=h.bottom-1&&r.bottom<=a.bottom});return {dpr:devicePixelRatio,sourceFont:getComputedStyle(d.querySelector("td")).fontFamily,innerWidth,marker:r(d.querySelector("#fixture-paint")),viewport:r(w),head:r(d.querySelector('thead .col-header:nth-child(4)')),body:r(b),bar:r(d.querySelector('.kite-excel-bar')),layer:r(p?.querySelector('.kite-excel-range-layer')),fills:[...(p?.querySelectorAll('.kite-excel-range-fill')??[])].map(r),edges:[...(p?.querySelectorAll('.kite-excel-range-edge')??[])].map(r),inline:[...d.querySelectorAll('td')].map(e=>e.getAttribute('style')),scroll:{left:w.scrollLeft,top:w.scrollTop},frozen:r(d.querySelector('tr[data-frozen] td')),selection:null}})()`;
void app
  .whenReady()
  .then(async () => {
    const window = new BrowserWindow({
      show: false,
      width: 680,
      height: 540,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        partition: 'excel-layout',
      },
    });
    const contents = window.webContents,
      session = contents.session;
    session.setPermissionRequestHandler((_w, _p, cb) => cb(false));
    session.setPermissionCheckHandler(() => false);
    session.webRequest.onBeforeRequest((d, cb) =>
      cb({ cancel: !d.url.startsWith(`${pathToFileURL(root).href}/`) }),
    );
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (e) => e.preventDefault());
    const frames = () =>
      contents.executeJavaScript(
        'new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))',
      );
    const isolated = (code: string) =>
      contents.executeJavaScriptInIsolatedWorld(officeInteractionWorld, [{ code }]);
    const snapshot = async () => {
      const state = (await contents.executeJavaScript(inspect)) as State;
      const description = (await isolated(officeInteractionPeekScript)) as OfficeInteraction;
      state.selection = description;
      const range = description.selection;
      if (range?.kind === 'excel' && !('scope' in range)) {
        state.name = range.range;
        const active = range.cells.find(
          (cell) => cell.address === description.excelSelection?.activeAddress,
        );
        state.value = active?.formula || active?.value || '';
      }
      return state;
    };
    const captureAttempts: unknown[] = [];
    let paintSerial = 0;
    const captureCurrent = async () => {
      const color = [29 + (++paintSerial % 180), 61, 137];
      await contents.executeJavaScript(
        `document.querySelector('#fixture-paint').style.backgroundColor='rgb(${color.join(',')})'`,
      );
      for (let attempt = 0; attempt < 8; attempt++) {
        await frames();
        const state = await snapshot();
        const picture = await contents.capturePage(undefined, {
          stayHidden: true,
          stayAwake: true,
        });
        const size = picture.getSize(),
          bitmap = picture.toBitmap(),
          ratio = size.width / state.innerWidth;
        assert.equal(bitmap.length, size.width * size.height * 4);
        assert.ok(Math.abs(ratio - state.dpr) < 0.02);
        const x = Math.round((state.marker.left + state.marker.width / 2) * ratio),
          y = Math.round((state.marker.top + state.marker.height / 2) * ratio);
        assert.ok(x >= 0 && x < size.width && y >= 0 && y < size.height);
        const i = (y * size.width + x) * 4,
          actual = [bitmap[i + 2], bitmap[i + 1], bitmap[i]];
        captureAttempts.push({
          serial: paintSerial,
          attempt,
          size,
          innerWidth: state.innerWidth,
          dpr: state.dpr,
          ratio,
          expected: color,
          actual,
        });
        if (actual.every((v, i) => v === color[i])) return { picture, state, paintSerial };
        await writeFile(join(root, `stale-paint-${paintSerial}-${attempt}.png`), picture.toPNG());
      }
      throw Error('current_compositor_frame_not_observed');
    };
    const samples: unknown[] = [];
    const rangeSamples: unknown[] = [];
    const migrationSamples: unknown[] = [];
    const frozenSamples: unknown[] = [];
    const perimeterSamples: unknown[] = [];
    const rowLineSamples: unknown[] = [];
    const popupSamples: unknown[] = [];
    let passed = false;
    const click = async (selector: string, shift = false) => {
      const p = await contents.executeJavaScript(
        `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();const x=Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2),target=document.querySelector(${JSON.stringify(selector)}),hit=document.elementFromPoint(x,y);return {x,y,hit:target===hit||target.contains(hit)}})()`,
      );
      assert.equal(p.hit, true, `click target is occluded: ${selector}`);
      const point = { x: p.x, y: p.y, modifiers: shift ? ['shift' as const] : [] };
      contents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
      contents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
      await frames();
    };

    const tabSamples: unknown[] = [];
    const runSheetTabCases = async () => {
      const actual = process.argv.includes('--tabs-actual');
      const file = join(root, actual ? 'input/index.html' : 'tabs.html');
      if (!actual) {
        const originalTabs =
          '<div class="sheet-tabs"><div class="sheet-tab active" data-sheet="0">S</div></div>';
        const names = ['S', ...Array.from({ length: 9 }, (_, i) => `工作表${i + 1}`)];
        const tabs = `<div class="sheet-tabs" role="tablist">${names.map((name, i) => `<div class="sheet-tab ${i ? '' : 'active'}" data-sheet="${i}" role="tab" tabindex="0" style="--tab-color:#4472C4" onclick="switchSheet(${i})" onkeydown="if(event.key==='Enter')switchSheet(${i})">${name}</div>`).join('')}</div>`;
        const other = names
          .slice(1)
          .map(
            (name, i) =>
              `<div class="sheet-content" data-sheet="${i + 1}"><div class="table-wrapper"><table><tbody><tr><td data-path="/${name}/A1">原值</td></tr></tbody></table></div></div>`,
          )
          .join('');
        const css = `<style>body{min-height:100vh}.sheet-slider{flex:1;position:relative;overflow:hidden;display:flex;flex-direction:column;min-height:0}.sheet-content{display:none}.sheet-content.active{display:flex}.sheet-tabs{display:flex;overflow-x:auto;flex-shrink:0;position:sticky;bottom:0;z-index:10}.sheet-tab{white-space:nowrap;position:relative;cursor:pointer}</style>`;
        await writeFile(
          file,
          html(true, true)
            .replace(
              '<div class="sheet-content active"',
              '<div class="sheet-slider"><div class="sheet-content active"',
            )
            .replace(originalTabs, `${other}</div>${tabs}`) +
            css +
            `<script>function switchSheet(i){document.querySelectorAll('.sheet-tab,.sheet-content').forEach(e=>e.classList.toggle('active',e.dataset.sheet===String(i)));window.scrollTo(0,0)}</script>`,
        );
      }
      const facts = () =>
        contents.executeJavaScript(
          `(()=>{const r=e=>e.getBoundingClientRect().toJSON(),bar=document.querySelector('body>.sheet-tabs'),tabs=[...bar.children],w=document.querySelector('.sheet-content.active .table-wrapper'),table=w.querySelector('table'),cell=table.querySelector('td'),first=tabs[0],t=getComputedStyle(first),rect=r(first),text=document.createRange();text.selectNodeContents(first);return {bar:r(bar),tabs:tabs.map(r),text:r(text),font:t.fontFamily,fontSize:t.fontSize,lineHeight:t.lineHeight,tabZoom:getComputedStyle(bar).zoom,rootZoom:getComputedStyle(document.documentElement).zoom,width:innerWidth,height:innerHeight,visualHeight:visualViewport.height,dpr:devicePixelRatio,wrapper:r(w),table:r(table),tableCssWidth:getComputedStyle(table).width,cell:r(cell),scroll:{x:w.scrollLeft,y:w.scrollTop},barScroll:{left:bar.scrollLeft,width:bar.scrollWidth,client:bar.clientWidth},active:document.querySelector('.sheet-content.active').dataset.sheet,accents:tabs.map(e=>[e.style.getPropertyValue('--tab-color'),getComputedStyle(e).boxShadow]),hit:[[rect.left+2,(rect.top+rect.bottom)/2],[rect.right-2,(rect.top+rect.bottom)/2],[(rect.left+rect.right)/2,rect.top+2],[(rect.left+rect.right)/2,rect.bottom-2],[(rect.left+rect.right)/2,(rect.top+rect.bottom)/2]].every(([x,y])=>{const h=document.elementFromPoint(x,y);return h===first||first.contains(h)})}})()`,
        );
      for (const width of [900, 420]) {
        window.setSize(width, 600);
        await contents.loadURL(pathToFileURL(file).href);
        await contents.executeJavaScript('document.fonts.ready');
        await isolated(officeInteractionInstallScript('excel'));
        await contents.executeJavaScript(
          `{const m=document.createElement('span');m.id='tabs-paint';m.style.cssText='position:fixed;left:0;top:0;width:6px;height:6px;z-index:2147483647;pointer-events:none';document.body.append(m)}`,
        );
        await frames();
        const inline = await contents.executeJavaScript(
          "[...document.querySelectorAll('td')].map(e=>e.getAttribute('style'))",
        );
        const baseline = await facts();
        for (const zoom of [1, 1.25, 2, 'fit'] as const) {
          await isolated(officeInteractionControlScript({ kind: 'zoom', value: zoom }));
          await frames();
          const f = await facts(),
            scale = zoom === 'fit' ? 1 : zoom;
          await writeFile(
            join(root, 'latest-tab-facts.json'),
            JSON.stringify({ f, baseline, zoom }, null, 2),
          );
          for (const key of ['width', 'height'] as const) {
            assert.ok(
              Math.abs(f.tabs[0][key] - baseline.tabs[0][key]) < 0.05,
              JSON.stringify({ zoom, f, baseline }),
            );
            assert.ok(Math.abs(f.text[key] - baseline.text[key]) < 0.05);
          }
          assert.equal(f.fontSize, '12px');
          assert.equal(f.font, baseline.font);
          assert.equal(f.hit, true, JSON.stringify(f));
          assert.ok(Math.abs(f.bar.height - baseline.bar.height) < 0.05);
          assert.ok(f.bar.left >= 0 && f.bar.right <= f.width + 0.05);
          assert.ok(f.bar.bottom <= f.visualHeight + 0.05, JSON.stringify(f));
          assert.ok(Math.abs(f.wrapper.bottom - f.bar.top) < 0.05, JSON.stringify(f));
          assert.ok(
            Math.abs(f.table.width - Number.parseFloat(f.tableCssWidth) * scale) < 0.05,
            JSON.stringify(f),
          );
          if (scale > 1) assert.ok(f.table.width > baseline.table.width * (scale - 0.01));
          assert.deepEqual(f.accents, baseline.accents);
          assert.deepEqual(
            await contents.executeJavaScript(
              "[...document.querySelectorAll('td')].map(e=>e.getAttribute('style'))",
            ),
            inline,
          );
          // Native focus and Enter still execute the converter's original tab behavior.
          await contents.executeJavaScript("document.querySelectorAll('.sheet-tab')[1].focus()");
          contents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
          contents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
          await frames();
          assert.equal((await facts()).active, '1');
          await click('.sheet-tab[data-sheet="0"]');
          assert.equal((await facts()).active, '0');
          const target = await contents.executeJavaScript(
            `(()=>{const e=document.querySelectorAll('.sheet-tab')[1],r=e.getBoundingClientRect();return {x:Math.round((r.left+r.right)/2),y:Math.round((r.top+r.bottom)/2),name:e.textContent,rect:r.toJSON(),hit:document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2)===e}})()`,
          );
          assert.equal(target.hit, true);
          for (const type of ['mouseDown', 'mouseUp'] as const)
            contents.sendInputEvent({
              type,
              button: 'right',
              clickCount: 1,
              x: target.x,
              y: target.y,
            });
          await frames();
          await click('[role=menuitem]');
          const request = (await isolated(officeInteractionReadScript)) as OfficeInteraction;
          assert.deepEqual(request.floatingSelection, {
            kind: 'excel',
            scope: 'sheet',
            sheet: target.name,
          });
          assert.ok(request.floatingRequest);
          assert.equal((await facts()).active, '0');
          assert.deepEqual(request.requestAnchor, {
            x: target.rect.x,
            y: target.rect.y,
            width: target.rect.width,
            height: target.rect.height,
          });
          // Consuming the request never frees its scope for another tab request.
          for (const type of ['mouseDown', 'mouseUp'] as const)
            contents.sendInputEvent({
              type,
              button: 'right',
              clickCount: 1,
              x: target.x,
              y: target.y,
            });
          assert.equal(
            ((await isolated(officeInteractionReadScript)) as OfficeInteraction).floatingRequest,
            undefined,
          );
          await isolated(officeInteractionReleaseScript(request.floatingRequest!));
          await contents.executeJavaScript(
            `{const w=document.querySelector('.sheet-content.active .table-wrapper');w.scrollLeft=80;w.scrollTop=w.scrollHeight}`,
          );
          await frames();
          const end = await facts();
          assert.equal(end.bar.top, f.bar.top);
          const last = await contents.executeJavaScript(
            `(()=>{const w=document.querySelector('.sheet-content.active .table-wrapper'),e=w.querySelector('tbody tr:last-child td:nth-of-type(3)'),r=e.getBoundingClientRect(),x=(r.left+r.right)/2,y=(r.top+r.bottom)/2;return {rect:r.toJSON(),hit:document.elementFromPoint(x,y)===e,bottom:w.getBoundingClientRect().top+w.clientHeight*(Number.parseFloat(getComputedStyle(document.documentElement).zoom)||1)}})()`,
          );
          assert.ok(last.rect.bottom <= end.bar.top + 0.05, JSON.stringify({ last, end }));
          assert.equal(last.hit, true, JSON.stringify({ last, end }));
          assert.ok(last.rect.bottom <= last.bottom + 1, JSON.stringify({ last, end }));
          if (!actual && width === 420) {
            assert.ok(end.barScroll.width > end.barScroll.client);
            await contents.executeJavaScript(
              `{const bar=document.querySelector('.sheet-tabs');bar.scrollLeft=bar.scrollWidth}`,
            );
            await click('.sheet-tab:last-child');
            assert.equal((await facts()).active, '9');
            await contents.executeJavaScript(`document.querySelector('.sheet-tabs').scrollLeft=0`);
            await click('.sheet-tab[data-sheet="0"]');
          }
          const color = [30 + tabSamples.length, 61, 137];
          await contents.executeJavaScript(
            `document.querySelector('#tabs-paint').style.backgroundColor='rgb(${color})'`,
          );
          let current = false;
          for (let attempt = 0; attempt < 8; attempt++) {
            await frames();
            const picture = await contents.capturePage(undefined, {
                stayHidden: true,
                stayAwake: true,
              }),
              size = picture.getSize(),
              bytes = picture.toBitmap();
            const marker = await contents.executeJavaScript(
                `document.querySelector('#tabs-paint').getBoundingClientRect().toJSON()`,
              ),
              ratio = size.width / f.width;
            const i =
              (Math.floor((marker.top + marker.height / 2) * ratio) * size.width +
                Math.floor((marker.left + marker.width / 2) * ratio)) *
              4;
            current = [bytes[i + 2], bytes[i + 1], bytes[i]].every((n, j) => n === color[j]);
            captureAttempts.push({ tabs: true, width, zoom, attempt, current });
            await writeFile(
              join(root, `${current ? 'tabs' : 'stale-tabs'}-${width}-${zoom}-${attempt}.png`),
              picture.toPNG(),
            );
            if (current) break;
          }
          assert.ok(current);
          tabSamples.push({ actual, width, zoom, baseline, state: f, end, last, target, request });
          await contents.executeJavaScript(
            `{const w=document.querySelector('.sheet-content.active .table-wrapper');w.scrollLeft=0;w.scrollTop=0}`,
          );
        }
      }
    };
    const runPopupCases = async () => {
      let serial = 0;
      const loadPopup = async (
        kind: 'excel' | 'powerpoint' | 'word',
        body: string,
        zoom: number,
      ) => {
        const file = join(root, `popup-${kind}-${++serial}.html`);
        const marker =
          '<span id="popup-paint" style="position:fixed;bottom:0;left:0;width:4px;height:4px;pointer-events:none;z-index:2147483647"></span>';
        await writeFile(
          file,
          `<!doctype html><html style="zoom:${zoom}" data-kite-word-pagination-state="settled" data-kite-word-pagination-generation="1"><meta charset="utf-8"><body>${body}${marker}</body></html>`,
        );
        await contents.loadURL(pathToFileURL(file).href);
        await frames();
        await isolated(officeInteractionInstallScript(kind));
        await frames();
      };
      const capturePopup = async (label: string, selector: string) => {
        const color = [29 + (++serial % 180), 61, 137];
        await contents.executeJavaScript(
          `document.querySelector('#popup-paint').style.backgroundColor='rgb(${color.join(',')})'`,
        );
        for (let attempt = 0; attempt < 8; attempt++) {
          await frames();
          const facts = await contents.executeJavaScript(
            `(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),p=document.querySelector('#popup-paint').getBoundingClientRect(),x=(r.left+r.right)/2,y=(r.top+r.bottom)/2,hit=document.elementFromPoint(x,y);return {rect:r.toJSON(),width:innerWidth,height:innerHeight,clientWidth:document.documentElement.clientWidth,clientHeight:document.documentElement.clientHeight,zoom:getComputedStyle(document.documentElement).zoom,display:getComputedStyle(e).display,hit:e===hit||e.contains(hit),edgesHit:[[r.left+2,y],[r.right-2,y],[x,r.top+2],[x,r.bottom-2]].every(([a,b])=>{const h=document.elementFromPoint(a,b);return e===h||e.contains(h)}),marker:{x:p.left+p.width/2,y:p.top+p.height/2}}})()`,
          );
          const picture = await contents.capturePage(undefined, {
              stayHidden: true,
              stayAwake: true,
            }),
            size = picture.getSize(),
            bytes = picture.toBitmap(),
            ratio = size.width / facts.width;
          const i =
              (Math.round(facts.marker.y * ratio) * size.width +
                Math.round(facts.marker.x * ratio)) *
              4,
            actual = [bytes[i + 2], bytes[i + 1], bytes[i]];
          const current = actual.every((n, index) => n === color[index]);
          captureAttempts.push({
            popup: label,
            attempt,
            size,
            ratio,
            expected: color,
            actual,
            current,
          });
          if (!current) {
            await writeFile(join(root, `stale-popup-${serial}-${attempt}.png`), picture.toPNG());
            continue;
          }
          await writeFile(join(root, `${label}.png`), picture.toPNG());
          assert.notEqual(facts.display, 'none');
          assert.ok(facts.rect.width > 0 && facts.rect.height > 0);
          assert.ok(
            facts.rect.left >= 3.95 &&
              facts.rect.top >= 3.95 &&
              facts.rect.right <= facts.clientWidth - 3.95 &&
              facts.rect.bottom <= facts.clientHeight - 3.95,
            JSON.stringify(facts),
          );
          if (selector !== '.kite-office-range-status') {
            assert.equal(facts.hit, true);
            assert.equal(facts.edgesHit, true);
          }
          return facts;
        }
        throw Error('popup_current_paint_not_observed');
      };
      const context = async (selector: string) => {
        const point = await contents.executeJavaScript(
          `(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),x=Math.round((r.left+r.right)/2),y=Math.round((r.top+r.bottom)/2),hit=document.elementFromPoint(x,y);return{x,y,hit:e===hit||e.contains(hit)}})()`,
        );
        assert.equal(point.hit, true, selector);
        for (const type of ['mouseDown', 'mouseUp'] as const)
          contents.sendInputEvent({ type, button: 'right', clickCount: 1, x: point.x, y: point.y });
        await frames();
        return point;
      };
      for (const width of [680, 420])
        for (const zoom of [1.25, 2]) {
          window.setSize(width, width === 420 ? 360 : 540);
          for (const kind of ['excel', 'powerpoint', 'word'] as const) {
            const body =
              kind === 'excel'
                ? '<style>body{margin:0}.sheet-tabs{position:fixed;bottom:0;right:0;display:flex}.sheet-tab{padding:8px}.sheet-content:not(.active){display:none}</style><div class="sheet-content active" data-sheet="0"><table><tr><td data-path="/S/A1">one</td></tr></table></div><div class="sheet-content" data-sheet="1"><table><tr><td data-path="/S2/A1">two</td></tr></table></div><div class="sheet-tabs"><div class="sheet-tab active" data-sheet="0">S</div><div class="sheet-tab" data-sheet="1">S2</div></div>'
                : kind === 'powerpoint'
                  ? '<div class="main">' +
                    [1, 2]
                      .map(
                        (n) =>
                          `<div class="slide-container"><div class="slide" style="width:600px;height:800px"><p data-path="/slide[${n}]/shape[1]">page${n}</p></div></div>`,
                      )
                      .join('') +
                    '</div>'
                  : [1, 2]
                      .map(
                        (n) =>
                          `<div class="page-wrapper"><div class="page" style="width:600px;height:800px;background:white;color:black"><div class="page-body"><p data-path="/body/p[${n}]">正文${n}</p></div></div></div>`,
                      )
                      .join('');
            await loadPopup(kind, body, zoom);
            const target =
              kind === 'excel'
                ? '.sheet-tab:nth-child(2)'
                : kind === 'powerpoint'
                  ? '.kite-thumbnail-button:nth-child(2)'
                  : '.kite-word-page-button:nth-child(2)';
            await contents.executeJavaScript(
              `document.querySelector(${JSON.stringify(target)}).scrollIntoView({block:'center',inline:'nearest'})`,
            );
            await frames();
            await contents.executeJavaScript(
              `document.querySelector(${JSON.stringify(target)}).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:10,clientY:10}))`,
            );
            assert.equal(
              await contents.executeJavaScript(
                "document.querySelector('[role=menu]').style.display",
              ),
              'none',
            );
            const point = await context(target);
            const facts = await capturePopup(`menu-${kind}-${width}-${zoom}`, '[role=menu]');
            assert.equal((await isolated(officeInteractionPeekScript)).floatingRequest, undefined);
            contents.sendInputEvent({ type: 'keyDown', keyCode: 'ESC' });
            contents.sendInputEvent({ type: 'keyUp', keyCode: 'ESC' });
            await frames();
            assert.equal(
              await contents.executeJavaScript(
                "document.querySelector('[role=menu]').style.display",
              ),
              'none',
            );
            await context(target);
            await click('[role=menuitem]');
            const request = await isolated(officeInteractionReadScript);
            assert.equal(request.floatingSelection.kind, kind);
            if (kind === 'excel') assert.equal(request.floatingSelection.sheet, 'S2');
            else assert.equal(request.floatingSelection[kind === 'word' ? 'page' : 'slide'], 2);
            assert.equal((await isolated(officeInteractionReadScript)).floatingRequest, undefined);
            await isolated(officeInteractionReleaseScript(request.floatingRequest));
            popupSamples.push({
              kind,
              type: 'menu',
              width,
              zoom,
              point,
              facts,
              target: request.floatingSelection,
              cancelled: true,
              once: true,
            });
          }
          for (const kind of ['word', 'powerpoint'] as const) {
            const text =
              '<p data-path="' +
              (kind === 'word' ? '/body/p[1]' : '/slide[1]/shape[1]') +
              '" style="position:fixed;right:4px;bottom:4px;margin:0;width:100px;height:28px;font:16px Arial">Hello world</p>';
            await loadPopup(
              kind,
              kind === 'word'
                ? text
                : '<div class="main"><div class="slide-container"><div class="slide" style="width:600px;height:800px">' +
                    text +
                    '</div></div></div>',
              zoom,
            );
            if (kind === 'powerpoint') await click('.main [data-path]');
            else {
              const r = await contents.executeJavaScript(
                "document.querySelector('[data-path]').getBoundingClientRect().toJSON()",
              );
              const x = Math.round(r.left + 2),
                y = Math.round(r.top + 10 * zoom),
                end = Math.round(r.right - 8);
              contents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x, y });
              contents.sendInputEvent({
                type: 'mouseMove',
                button: 'left',
                modifiers: ['leftbuttondown'],
                x: end,
                y,
              });
              contents.sendInputEvent({
                type: 'mouseUp',
                button: 'left',
                clickCount: 1,
                x: end,
                y,
              });
              await frames();
            }
            const facts = await capturePopup(
                `capsule-${kind}-${width}-${zoom}`,
                '.kite-office-request-trigger',
              ),
              description = await isolated(officeInteractionPeekScript);
            assert.equal(description.selection.kind, kind);
            assert.equal(description.floatingRequest, undefined);
            popupSamples.push({
              kind,
              type: 'capsule',
              width,
              zoom,
              facts,
              selection: description.selection,
            });
          }
          // A genuine over-budget Shift selection exposes the noninteractive range status.
          await loadPopup(
            'excel',
            html(false, false).replace(/<!doctype html><meta charset="utf-8">/, ''),
            zoom,
          );
          await click('[data-path="/S/A1"]');
          await contents.executeJavaScript(
            "document.querySelector('[data-path=\"/S/Q17\"]').scrollIntoView({block:'end',inline:'end'})",
          );
          await frames();
          await click('[data-path="/S/Q17"]', true);
          const facts = await capturePopup(
            `range-status-${width}-${zoom}`,
            '.kite-office-range-status',
          );
          assert.equal((await isolated(officeInteractionPeekScript)).selection, null);
          assert.equal((await isolated(officeInteractionPeekScript)).floatingRequest, undefined);
          popupSamples.push({ kind: 'excel', type: 'status', width, zoom, facts });
        }
    };
    try {
      assert.equal(window.isVisible(), false);
      assert.equal(app.commandLine.hasSwitch('no-sandbox'), false);
      if (process.argv.includes('--tabs')) {
        await runSheetTabCases();
        passed = true;
        return;
      }
      if (process.argv.includes('--popups')) {
        await runPopupCases();
        passed = true;
        return;
      }
      for (const frozen of [false, true])
        for (const author of [false, true]) {
          const file = join(root, `source-${frozen}-${author}.html`);
          await writeFile(file, html(frozen, author));
          await contents.loadURL(pathToFileURL(file).href);
          await frames();
          await contents.executeJavaScriptInIsolatedWorld(1015, [
            {
              code: `globalThis.events=[];for(const type of ["pointerdown","pointermove","pointerup","pointercancel","lostpointercapture"])document.addEventListener(type,e=>globalThis.events.push({type,trusted:e.isTrusted,buttons:e.buttons,target:e.target.getAttribute?.("data-path"),x:e.clientX,y:e.clientY}),true)`,
            },
          ]);
          const baseline = await snapshot();
          await isolated(officeInteractionInstallScript('excel'));
          await frames();
          const installed = await snapshot();
          assert.equal(installed.bar, null);
          assert.equal(
            await contents.executeJavaScript(
              'document.querySelector("body > details[role=note]") === null',
            ),
            true,
          );
          assert.equal(installed.sourceFont, baseline.sourceFont);
          assert.match(installed.sourceFont, /KiteDocument/);
          assert.deepEqual(installed.inline, baseline.inline);
          assert.equal(installed.head.width, baseline.head.width);
          assert.equal(installed.body.width, baseline.body.width);
          assert.equal(installed.head.height, baseline.head.height);
          assert.equal(installed.body.height, baseline.body.height);
          for (const theme of ['light', 'dark'] as const)
            for (const zoom of [0.75, 1, 1.25, 1.5])
              for (const scrolled of [false, true]) {
                nativeTheme.themeSource = theme;
                await isolated(officeInteractionControlScript({ kind: 'zoom', value: zoom }));
                await contents.executeJavaScript(
                  `document.querySelector('.table-wrapper').scrollLeft=${scrolled ? 25 : 0};document.querySelector('.table-wrapper').scrollTop=${scrolled ? 52 : 0}`,
                );
                await frames();
                const { picture, state, paintSerial: paint } = await captureCurrent();
                assert.ok(Math.abs(state.head.left - state.body.left) < 0.02);
                assert.ok(Math.abs(state.head.right - state.body.right) < 0.02);
                assert.deepEqual(state.inline, baseline.inline);
                if (frozen && scrolled)
                  assert.ok(Math.abs(state.frozen!.top - state.head.bottom) < zoom + 1);
                const size = picture.getSize(),
                  bitmap = picture.toBitmap(),
                  ratio = size.width / state.innerWidth;
                const rgb = (x: number, y: number) => {
                  const i = (Math.round(y * ratio) * size.width + Math.round(x * ratio)) * 4;
                  return [bitmap[i + 2], bitmap[i + 1], bitmap[i]];
                };
                const edge = (r: Rect, y: number) =>
                  Array.from({ length: 9 }, (_, i) => ({
                    offset: i - 4,
                    rgb: rgb(r.right + (i - 4) / ratio, y),
                  }));
                assert.ok(
                  state.head.top >= state.viewport.top - 1 &&
                    state.head.bottom <= state.viewport.bottom,
                );
                assert.ok(
                  state.body.top >= state.head.bottom - 1 &&
                    state.body.bottom <= state.viewport.bottom,
                );
                assert.ok(
                  state.head.right + 4 / ratio < state.viewport.right &&
                    state.head.left > state.viewport.left,
                );
                const headerEdge = edge(state.head, state.head.top + 3 * zoom),
                  bodyEdge = edge(state.body, state.body.top + state.body.height / 2);
                samples.push({
                  frozen,
                  author,
                  theme,
                  zoom,
                  scrolled,
                  dpr: state.dpr,
                  paint,
                  sourceFont: state.sourceFont,
                  head: state.head,
                  body: state.body,
                  headerEdge,
                  bodyEdge,
                  scroll: state.scroll,
                });
                await writeFile(join(root, 'latest.png'), picture.toPNG());
                if (author && !scrolled) {
                  assert.deepEqual(rgb(state.body.left + 20 * zoom, state.body.top), [200, 0, 0]);
                  assert.deepEqual(
                    rgb(state.body.left - state.body.width, state.body.top + state.body.height / 2),
                    [0, 0, 200],
                  );
                }
                {
                  const line = (a: typeof headerEdge, background: number) => {
                    assert.ok(
                      a.some((p) => p.rgb.every((v) => v === 224)),
                      'missing actual default grid line',
                    );
                    assert.ok(
                      a.some((p) => p.rgb.every((v) => v === background)),
                      'missing expected cell background',
                    );
                    assert.ok(
                      new Set(a.map((p) => p.rgb.join(','))).size > 1,
                      'flat pixels are not grid evidence',
                    );
                  };
                  line(headerEdge, 248);
                  line(bodyEdge, 255);
                  const min = (a: typeof headerEdge) =>
                    a.reduce((best, p) => (p.rgb[0]! < best.rgb[0]! ? p : best));
                  assert.equal(min(headerEdge).offset, min(bodyEdge).offset);
                }
              }
          await isolated(officeInteractionControlScript({ kind: 'zoom', value: 1 }));
          await contents.executeJavaScript(
            "document.querySelector('.table-wrapper').scrollTop=0;document.querySelector('.table-wrapper').scrollLeft=0",
          );
          await frames();
          const original = (await captureCurrent()).picture;
          const sourceColors = await contents.executeJavaScript(
            '(()=>{const c=document.querySelector(\'[data-path="/S/C3"]\'),r=c.getBoundingClientRect();return {x:r.right-6,y:r.bottom-6,color:getComputedStyle(c).backgroundColor}})()',
          );
          assert.equal(sourceColors.color, 'rgb(255, 240, 180)');
          await writeFile(join(root, `grid-${frozen}-${author}.png`), original.toPNG());
          await click('[data-path="/S/C3"]');
          let state = await snapshot();
          state.selection = await isolated(officeInteractionPeekScript);
          assert.equal(state.name, 'C3');
          assert.equal(state.value, 'SUM(A1:A2)');
          const points = await contents.executeJavaScript(
            `['/S/C3','/S/B2'].map(path=>{const r=document.querySelector('[data-path="'+path+'"]').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})`,
          );
          contents.sendInputEvent({
            type: 'mouseDown',
            button: 'left',
            clickCount: 1,
            ...points[0],
          });
          contents.sendInputEvent({
            type: 'mouseMove',
            button: 'left',
            modifiers: ['leftbuttondown'],
            ...points[1],
          });
          contents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...points[1] });
          await frames();
          state = await snapshot();
          assert.equal(state.name, 'B2:C3');
          assert.equal(state.value, 'SUM(A1:A2)');
          assert.equal(state.fills.length, 3);
          assert.equal(state.edges.length, 8);
          assert.ok(state.layer!.top >= state.viewport.top);
          assert.deepEqual(state.inline, baseline.inline);
          const selection = await isolated(officeInteractionPeekScript);
          assert.equal(selection.floatingRequest, undefined);
          assert.equal(selection.selection.cells.length, 4);
          await writeFile(
            join(root, `range-${frozen}-${author}.png`),
            (await captureCurrent()).picture.toPNG(),
          );
          const selectedImage = (await captureCurrent()).picture;
          const pixelAt = (image: typeof selectedImage, x: number, y: number) => {
            const scale = image.getSize().width / state.innerWidth,
              data = image.toBitmap();
            const i = (Math.round(y * scale) * image.getSize().width + Math.round(x * scale)) * 4;
            return [data[i + 2], data[i + 1], data[i]];
          };
          assert.deepEqual(
            pixelAt(selectedImage, sourceColors.x, sourceColors.y),
            pixelAt(original, sourceColors.x, sourceColors.y),
          );
          for (const zoom of [0.75, 1, 1.5])
            for (const scrolled of [false, true]) {
              await isolated(officeInteractionControlScript({ kind: 'zoom', value: zoom }));
              await contents.executeJavaScript(
                `document.querySelector('.table-wrapper').scrollLeft=${scrolled ? 25 : 0};document.querySelector('.table-wrapper').scrollTop=${scrolled ? 52 : 0}`,
              );
              await frames();
              const sample = await snapshot();
              assert.equal(sample.name, 'B2:C3');
              assert.equal(sample.value, 'SUM(A1:A2)');
              for (const rect of [...sample.fills, ...sample.edges]) {
                assert.ok(
                  rect.left >= sample.layer!.left - 0.02 &&
                    rect.right <= sample.layer!.right + 0.02,
                );
                assert.ok(
                  rect.top >= Math.max(sample.layer!.top, sample.viewport.top) - 0.02 &&
                    rect.bottom <= sample.layer!.bottom + 0.02,
                );
                if (frozen) assert.ok(rect.top >= sample.frozen!.bottom - 0.02);
              }
              rangeSamples.push({
                frozen,
                author,
                zoom,
                scrolled,
                name: sample.name,
                viewport: sample.viewport,
                layer: sample.layer,
                fills: sample.fills,
                edges: sample.edges,
              });
            }
          await isolated(officeInteractionControlScript({ kind: 'zoom', value: 1 }));
          await contents.executeJavaScript(
            "document.querySelector('.table-wrapper').scrollLeft=0;document.querySelector('.table-wrapper').scrollTop=0",
          );
          await frames();
          nativeTheme.themeSource = 'light';
          await frames();
          await writeFile(
            join(root, `range-light-${frozen}-${author}.png`),
            (await captureCurrent()).picture.toPNG(),
          );
          if (!frozen && !author) {
            for (const width of [680, 420])
              for (const zoom of [0.75, 1.25, 1.5]) {
                window.setSize(width, 540);
                await isolated(officeInteractionControlScript({ kind: 'zoom', value: zoom }));
                await frames();
                const before = await snapshot();
                const metadata = before.selection.excelSelection!;
                assert.equal(metadata.activeAddress, 'C3');
                assert.equal(before.bar, null);
                assert.equal(
                  await contents.executeJavaScript(
                    'document.querySelector(".kite-excel-name,.kite-excel-value,.kite-excel-expand,body > details[role=note]") === null',
                  ),
                  true,
                );
                const staleCommand = officeInteractionControlScript({
                  kind: 'locate-selection',
                  selectionSerial: metadata.selectionSerial + 1,
                });
                assert.equal(
                  await isolated(
                    `(()=>{try{${staleCommand};return 'not-rejected'}catch(error){return error.message}})()`,
                  ),
                  'preview_selection_replaced',
                );
                await isolated(
                  officeInteractionControlScript({
                    kind: 'locate-selection',
                    selectionSerial: metadata.selectionSerial,
                  }),
                );
                const after = await snapshot();
                assert.deepEqual(after.selection, before.selection);
                assert.deepEqual(after.inline, baseline.inline);
                migrationSamples.push({
                  width,
                  zoom,
                  serial: metadata.selectionSerial,
                  activeAddress: 'C3',
                  range: after.name,
                  formula: after.value,
                  documentBar: false,
                  submitted: false,
                });
              }
            window.setSize(680, 540);
          }
          await isolated(officeInteractionControlScript({ kind: 'zoom', value: 1 }));
          await contents.executeJavaScript(
            "document.querySelector('.table-wrapper').scrollTop=0;document.querySelector('.table-wrapper').scrollLeft=0",
          );
          await frames();
          await click('[data-path="/S/D4"]');
          state = await snapshot();
          assert.equal(state.selection.excelSelection?.activeAddress, 'D4');
          assert.equal(state.value, '长内容 '.repeat(80));
          assert.equal(state.selection.floatingRequest, undefined);
        }
      // The fixed converter leaves frozen-column cells transparent and uses collapsed
      // authored borders. Compare the failing raw paint with the production repair.
      const frozenFile = join(root, 'source-frozen-transparent.html');
      await writeFile(
        frozenFile,
        html(true, false)
          .replaceAll('left:40px;background:white;', 'left:40px;')
          .replace(
            /(<td data-path="\/S\/A1"\s+style=")([^"]*)"/,
            '$1$2background:#FFE699;border-top:2px solid red;border-left:2px solid red;border-right:2px solid blue;border-bottom:2px solid blue;"',
          ),
      );
      const frozenInspect = `(()=>{const r=e=>{const q=e.getBoundingClientRect();return {left:q.left,right:q.right,top:q.top,bottom:q.bottom,width:q.width,height:q.height}};const a=document.querySelector('[data-path="/S/A1"]'),b=[...document.querySelectorAll('tbody td:first-of-type')].find(e=>{const q=e.getBoundingClientRect(),w=e.closest('.table-wrapper').getBoundingClientRect(),a=document.querySelector('[data-path="/S/A1"]').getBoundingClientRect();return q.top>a.bottom+10&&q.bottom<w.bottom-10})??document.querySelector('[data-path="/S/A25"]');return {a:r(a),b:r(b),inline:[...document.querySelectorAll('td')].map(e=>e.getAttribute('style')),paper:document.querySelectorAll('[data-kite-frozen-paper]').length,borders:document.querySelector('.kite-excel-frozen-borders')?.childElementCount??0,border:['Top','Right','Bottom','Left'].map(side=>getComputedStyle(a)['border'+side]),collapse:getComputedStyle(a.closest('table')).borderCollapse}})()`;
      for (const mode of ['raw', 'repaired']) {
        await contents.loadURL(pathToFileURL(frozenFile).href);
        await frames();
        await contents.executeJavaScriptInIsolatedWorld(1015, [{ code: 'globalThis.events=[]' }]);
        const baseline = await contents.executeJavaScript(frozenInspect);
        assert.deepEqual(baseline.border, [
          '2px solid rgb(255, 0, 0)',
          '2px solid rgb(0, 0, 255)',
          '2px solid rgb(0, 0, 255)',
          '2px solid rgb(255, 0, 0)',
        ]);
        if (mode === 'repaired') await isolated(officeInteractionInstallScript('excel'));
        await contents.executeJavaScript(
          "document.documentElement.style.zoom='2';window.dispatchEvent(new Event('resize'))",
        );
        await frames();
        const initial = await captureCurrent();
        const start = await contents.executeJavaScript(frozenInspect);
        await writeFile(join(root, `frozen-${mode}-initial.png`), initial.picture.toPNG());
        assert.deepEqual(start.inline, baseline.inline);
        assert.equal(start.collapse, 'collapse');
        await contents.executeJavaScript(
          "(()=>{const w=document.querySelector('.table-wrapper');w.scrollLeft=120;w.scrollTop=350})()",
        );
        await frames();
        const shown = await captureCurrent(),
          scrolled = await contents.executeJavaScript(frozenInspect);
        assert.deepEqual(scrolled.inline, baseline.inline);
        assert.equal(scrolled.a.width, start.a.width);
        assert.equal(scrolled.a.height, start.a.height);
        const colorAt = (capture: typeof shown, x: number, y: number) => {
          const size = capture.picture.getSize(),
            ratio = size.width / capture.state.innerWidth,
            bytes = capture.picture.toBitmap();
          const i = (Math.round(y * ratio) * size.width + Math.round(x * ratio)) * 4;
          return [bytes[i + 2], bytes[i + 1], bytes[i]];
        };
        const a = scrolled.a;
        const edges = [
          colorAt(shown, (a.left + a.right) / 2, a.top),
          colorAt(shown, a.right, (a.top + a.bottom) / 2),
          colorAt(shown, (a.left + a.right) / 2, a.bottom),
          colorAt(shown, a.left, (a.top + a.bottom) / 2),
        ];
        if (mode === 'repaired')
          assert.deepEqual(edges, [
            [255, 0, 0],
            [0, 0, 255],
            [0, 0, 255],
            [255, 0, 0],
          ]);
        else
          assert.notDeepEqual(edges, [
            [255, 0, 0],
            [0, 0, 255],
            [0, 0, 255],
            [255, 0, 0],
          ]);
        await contents.executeJavaScript(
          `(()=>{const s=document.createElement('style');s.id='fixture-hide';s.textContent='td[data-fixture-underlying]{visibility:hidden!important}';document.head.append(s);document.querySelectorAll('tbody td').forEach(e=>{if(getComputedStyle(e).position!=='sticky')e.setAttribute('data-fixture-underlying','')})})()`,
        );
        const hidden = await captureCurrent(),
          size = shown.picture.getSize(),
          ratio = size.width / shown.state.innerWidth,
          before = shown.picture.toBitmap(),
          after = hidden.picture.toBitmap(),
          b = scrolled.b;
        assert.ok(b.top >= shown.state.viewport.top && b.bottom <= shown.state.viewport.bottom);
        let differences = 0,
          compared = 0;
        for (let y = Math.ceil((b.top + 3) * ratio); y < Math.floor((b.bottom - 3) * ratio); y++)
          for (
            let x = Math.ceil((b.left + 3) * ratio);
            x < Math.floor((b.right - 3) * ratio);
            x++
          ) {
            const i = (y * size.width + x) * 4;
            compared++;
            if (
              before[i] !== after[i] ||
              before[i + 1] !== after[i + 1] ||
              before[i + 2] !== after[i + 2]
            )
              differences++;
          }
        assert.ok(compared > 100);
        assert.ok(mode === 'repaired' ? differences === 0 : differences > 0);
        await writeFile(join(root, `frozen-${mode}-scrolled.png`), shown.picture.toPNG());
        await contents.executeJavaScript(
          "(()=>{document.querySelector('#fixture-hide').remove();document.querySelectorAll('[data-fixture-underlying]').forEach(e=>e.removeAttribute('data-fixture-underlying'));const w=document.querySelector('.table-wrapper');w.scrollTop=w.scrollLeft=0})()",
        );
        await frames();
        const returned = await captureCurrent(),
          end = await contents.executeJavaScript(frozenInspect);
        await writeFile(join(root, `frozen-${mode}-returned.png`), returned.picture.toPNG());
        await writeFile(
          join(root, `frozen-${mode}-states.json`),
          JSON.stringify({ start, scrolled, end }, null, 2),
        );
        assert.deepEqual(end.inline, baseline.inline);
        assert.deepEqual(end.a, start.a);
        assert.equal(end.borders, 0);
        // Exact authored edge pixels at the original position are handed back to native paint.
        for (const [x, y] of [
          [start.a.left, (start.a.top + start.a.bottom) / 2],
          [(start.a.left + start.a.right) / 2, start.a.top],
          [start.a.right, (start.a.top + start.a.bottom) / 2],
          [(start.a.left + start.a.right) / 2, start.a.bottom],
        ])
          assert.deepEqual(colorAt(returned, x, y), colorAt(initial, x, y));
        assert.ok(scrolled.paper <= 50 && scrolled.borders <= 512);
        frozenSamples.push({
          mode,
          zoom: 2,
          edges,
          differences,
          compared,
          visiblePaper: scrolled.paper,
          visibleBorders: scrolled.borders,
          inlineUnchanged: true,
          returnedNative: true,
        });
        await writeFile(join(root, `frozen-${mode}-returned.png`), returned.picture.toPNG());
      }

      // Author border variants, neighbouring collapsed edge ownership, and rejected merges.
      // This is generated markup; a separate fixed-CLI sample supplies converter evidence.
      window.setSize(1000, 760);
      const perimeterFile = join(root, 'source-perimeter.html');
      let perimeterHtml = html(true, false).replaceAll('left:40px;background:white;', 'left:40px;');
      // Match the converter's frozen intersection and column stacking; equal z-index
      // would let later frozen rows occlude the top-left cell during vertical scrolling.
      perimeterHtml = perimeterHtml.replaceAll('z-index:2;left:40px;', 'z-index:1;left:40px;');
      perimeterHtml = perimeterHtml.replace(
        /(<td data-path="\/S\/A1"[^>]*style=")([^"]*)"/,
        '$1$2z-index:3;"',
      );
      const styles: Record<string, string> = {
        A1: 'border-top:2px solid red;border-left:2px solid red;border-right:2px solid blue;border-bottom:2px solid blue;background:#FFE699;',
        B2: 'border-top:2px solid red;border-left:2px solid red;border-right:2px solid blue;border-bottom:2px solid blue;background:#FFE699;',
        C3: 'border-top:2px solid red;border-left:2px solid red;border-right:2px solid blue;border-bottom:2px solid blue;background:#FFE699;',
      };
      for (const address of ['D5', 'E5', 'D6', 'E6'])
        styles[address] =
          'border-top:3px solid green;border-left:3px solid green;border-bottom:3px solid purple;border-right:3px solid purple;background:#FFE699;';
      for (const address of ['F5', 'G5', 'F6', 'G6'])
        styles[address] =
          'border-top:2px dashed #FF8800;border-left:2px dashed #FF8800;border-bottom:1px dashed #0088CC;border-right:1px dashed #0088CC;background:#FFE699;';
      for (const [address, style] of Object.entries(styles))
        perimeterHtml = perimeterHtml.replace(
          new RegExp(`(<td data-path="/S/${address}"[^>]*style=")([^"]*)"`),
          `$1$2${style}"`,
        );
      perimeterHtml = perimeterHtml.replace(
        'data-path="/S/D8"',
        'data-path="/S/D8" colspan="3" rowspan="2"',
      );
      for (const address of ['E8', 'F8', 'D9', 'E9', 'F9'])
        perimeterHtml = perimeterHtml.replace(
          new RegExp(`<td data-path="/S/${address}"[^>]*>[\\s\\S]*?</td>`),
          '',
        );
      await writeFile(perimeterFile, perimeterHtml);
      await contents.loadURL(pathToFileURL(perimeterFile).href);
      await frames();
      await contents.executeJavaScriptInIsolatedWorld(1015, [{ code: 'globalThis.events=[]' }]);
      const perimeterInline = (await snapshot()).inline;
      await isolated(officeInteractionInstallScript('excel'));
      const js = (code: string) => contents.executeJavaScript(code);
      const cellRect = async (address: string): Promise<Rect> =>
        js(
          `document.querySelector('[data-path="/S/${address}"]').getBoundingClientRect().toJSON()`,
        );
      const palette = [
        [255, 0, 0],
        [0, 0, 255],
        [0, 128, 0],
        [128, 0, 128],
        [255, 136, 0],
        [0, 136, 204],
      ];
      const isAuthor = (color: number[]) => palette.some((p) => p.every((v, i) => v === color[i]));
      const pixelReader = (capture: Awaited<ReturnType<typeof captureCurrent>>) => {
        const size = capture.picture.getSize(),
          bytes = capture.picture.toBitmap(),
          scale = size.width / capture.state.innerWidth;
        return {
          size,
          bytes,
          scale,
          rgb: (x: number, y: number) => {
            const i = (Math.round(y * scale) * size.width + Math.round(x * scale)) * 4;
            return [bytes[i + 2]!, bytes[i + 1]!, bytes[i]!];
          },
        };
      };
      const cancelSelection = async () => {
        contents.sendInputEvent({ type: 'keyDown', keyCode: 'ESC' });
        contents.sendInputEvent({ type: 'keyUp', keyCode: 'ESC' });
        await frames();
        assert.equal((await isolated(officeInteractionPeekScript)).selection, null);
      };
      for (const zoom of [1.25, 2]) {
        await isolated(officeInteractionControlScript({ kind: 'zoom', value: zoom }));
        for (const [first, last, label] of [
          ['C3', 'C3', 'solid-2'],
          ['D5', 'E6', 'solid-3'],
          ['F5', 'G6', 'dashed'],
          ['C5', 'C6', 'unselected-neighbour'],
        ] as const) {
          await js(
            `(()=>{const w=document.querySelector('.table-wrapper');w.scrollTop=w.scrollLeft=0;const e=document.querySelector('[data-path="/S/${last}"]'),r=e.getBoundingClientRect(),b=w.getBoundingClientRect();if(r.right>b.right-20)w.scrollLeft=(r.right-b.right+20)/${zoom}})()`,
          );
          await frames();
          const before = pixelReader(await captureCurrent());
          await click(`[data-path="/S/${first}"]`);
          if (first !== last) await click(`[data-path="/S/${last}"]`, true);
          const context = await isolated(officeInteractionPeekScript);
          assert.equal(context.selection.range, first === last ? first : `${first}:${last}`);
          assert.equal(context.floatingRequest, undefined);
          // The request capsule legitimately casts a shadow on the bottom edge. Isolate
          // only that unrelated chrome for paint measurements, never change source cells.
          await js(
            "document.querySelector('.kite-office-request-trigger').style.visibility='hidden'",
          );
          const selected = await captureCurrent(),
            paint = pixelReader(selected),
            a = await cellRect(first),
            b = await cellRect(last);
          const centers = [
            [(a.left + a.right) / 2, a.top],
            [b.right, (b.top + b.bottom) / 2],
            [(b.left + b.right) / 2, b.bottom],
            [a.left, (a.top + a.bottom) / 2],
          ];
          let exposed = 0;
          for (const [side, [x, y]] of centers.entries()) {
            assert.ok(
              x! > selected.state.viewport.left &&
                x! < selected.state.viewport.right &&
                y! > selected.state.viewport.top &&
                y! < selected.state.viewport.bottom,
            );
            assert.deepEqual(paint.rgb(x!, y!), [115, 115, 115]);
            for (let d = -3.5 * zoom; d <= 3.5 * zoom; d += 1 / paint.scale)
              if (isAuthor(paint.rgb(x! + (side % 2 ? d : 0), y! + (side % 2 ? 0 : d)))) exposed++;
          }
          assert.equal(exposed, 0);
          // Scan the complete strip unions, including every corner and cell junction.
          // Their inward boundary stops at the perimeter stroke, not internal author lines.
          let bandPixels = 0,
            bandColors = 0;
          for (const r of selected.state.edges)
            for (
              let y = Math.ceil(r.top * paint.scale);
              y < Math.floor(r.bottom * paint.scale);
              y++
            )
              for (
                let x = Math.ceil(r.left * paint.scale);
                x < Math.floor(r.right * paint.scale);
                x++
              ) {
                const i = (y * paint.size.width + x) * 4;
                if (isAuthor([paint.bytes[i + 2]!, paint.bytes[i + 1]!, paint.bytes[i]!]))
                  bandColors++;
                bandPixels++;
              }
          assert.ok(bandPixels > 100);
          assert.equal(bandColors, 0);

          await writeFile(join(root, `perimeter-${zoom}-${label}.png`), selected.picture.toPNG());
          await cancelSelection();
          const restored = pixelReader(await captureCurrent());
          let count = 0;
          for (
            let y = Math.ceil((a.top - 4 * zoom) * before.scale);
            y < Math.floor((b.bottom + 4 * zoom) * before.scale);
            y++
          )
            for (
              let x = Math.ceil((a.left - 4 * zoom) * before.scale);
              x < Math.floor((b.right + 4 * zoom) * before.scale);
              x++
            ) {
              if (x < 0 || y < 0 || x >= before.size.width || y >= before.size.height) continue;
              const i = (y * before.size.width + x) * 4,
                color = [before.bytes[i + 2]!, before.bytes[i + 1]!, before.bytes[i]!];
              if (isAuthor(color)) {
                assert.deepEqual(
                  [restored.bytes[i + 2], restored.bytes[i + 1], restored.bytes[i]],
                  color,
                );
                count++;
              }
            }
          assert.ok(count > 0);
          assert.deepEqual((await snapshot()).inline, perimeterInline);
          perimeterSamples.push({
            zoom,
            label,
            range: context.selection.range,
            exposed,
            restored: count,
            bandPixels,
            bandColors,
          });
        }
        await js("document.querySelector('.table-wrapper').scrollLeft=0");
        await frames();
        await click('[data-path="/S/C3"]');
        await click('[data-path="/S/D8"]');
        assert.equal((await isolated(officeInteractionPeekScript)).selection, null);
        assert.equal(
          await js(
            "document.querySelector('.kite-office-selection-paint').shadowRoot.querySelectorAll('.kite-excel-range-edge,.kite-excel-range-fill').length",
          ),
          0,
        );
        assert.equal((await isolated(officeInteractionPeekScript)).floatingRequest, undefined);
      }
      await isolated(officeInteractionControlScript({ kind: 'zoom', value: 2 }));
      for (const top of [350, 0]) {
        await js(
          `(()=>{const w=document.querySelector('.table-wrapper');w.scrollLeft=80;w.scrollTop=${top}})()`,
        );
        await frames();
        const image = await captureCurrent(),
          paint = pixelReader(image),
          a = await cellRect('A1');
        let ghost = 0;
        for (
          let y = Math.ceil(a.top * paint.scale) - 4;
          y < Math.min(paint.size.height - 40, Math.ceil((a.bottom + 100) * paint.scale));
          y++
        )
          for (let x = 0; x < Math.floor((a.left - 8) * paint.scale); x++) {
            const i = (y * paint.size.width + x) * 4;
            if (isAuthor([paint.bytes[i + 2]!, paint.bytes[i + 1]!, paint.bytes[i]!])) ghost++;
          }
        assert.equal(ghost, 0);
        await writeFile(join(root, `header-ghost-${top}.png`), image.picture.toPNG());
        if (top === 0) {
          const aRows = await Promise.all(['A8', 'A9'].map(cellRect));
          await js(
            `(()=>{const s=document.createElement('style');s.id='fixture-rear';s.textContent='td[data-fixture-rear]{visibility:hidden!important}';document.head.append(s);document.querySelectorAll('td').forEach(e=>{if(getComputedStyle(e).position!=='sticky')e.setAttribute('data-fixture-rear','')})})()`,
          );
          const hidden = pixelReader(await captureCurrent());
          for (const [index, r] of aRows.entries()) {
            assert.ok(r.top > image.state.viewport.top && r.bottom < image.state.viewport.bottom);
            let differences = 0,
              compared = 0;
            for (
              let y = Math.ceil((r.top + 3) * paint.scale);
              y < Math.floor((r.bottom - 3) * paint.scale);
              y++
            )
              for (
                let x = Math.ceil((r.left + 3) * paint.scale);
                x < Math.floor((r.right - 3) * paint.scale);
                x++
              ) {
                const i = (y * paint.size.width + x) * 4;
                compared++;
                if (
                  paint.bytes[i] !== hidden.bytes[i] ||
                  paint.bytes[i + 1] !== hidden.bytes[i + 1] ||
                  paint.bytes[i + 2] !== hidden.bytes[i + 2]
                )
                  differences++;
              }
            assert.ok(compared > 100);
            assert.equal(differences, 0);
            perimeterSamples.push({
              address: `A${index + 8}`,
              besideMerge: true,
              compared,
              differences,
            });
          }
          await js(
            "(()=>{document.querySelector('#fixture-rear').remove();document.querySelectorAll('[data-fixture-rear]').forEach(e=>e.removeAttribute('data-fixture-rear'))})()",
          );
        }
        await click('[data-path="/S/A1"]');
        await js(
          "document.querySelector('.kite-office-request-trigger').style.visibility='hidden'",
        );
        const selected = pixelReader(await captureCurrent());
        for (const [x, y] of [
          [(a.left + a.right) / 2, a.top],
          [a.right, (a.top + a.bottom) / 2],
          [(a.left + a.right) / 2, a.bottom],
          [a.left, (a.top + a.bottom) / 2],
        ])
          assert.deepEqual(selected.rgb(x!, y!), [115, 115, 115]);
        await cancelSelection();
        const restored = pixelReader(await captureCurrent());
        for (const [x, y] of [
          [(a.left + a.right) / 2, a.top],
          [a.right, (a.top + a.bottom) / 2],
          [(a.left + a.right) / 2, a.bottom],
          [a.left, (a.top + a.bottom) / 2],
        ])
          assert.deepEqual(restored.rgb(x!, y!), paint.rgb(x!, y!));
        assert.deepEqual((await snapshot()).inline, perimeterInline);
        perimeterSamples.push({ zoom: 2, left: 80, top, ghost, cancelled: true, range: 'A1' });
      }

      // Explicit variable row heights are synthetic coverage, not the fixed XLSX sample.
      const rowFile = join(root, 'source-variable-row-heights.html');
      let rowIndex = 0;
      let rowHtml = html(true, false).replace(
        /<tr (data-frozen="")?>/g,
        (_tag, frozen) => `<tr ${frozen ?? ''} style="height:${[24, 33, 47][rowIndex++ % 3]}px">`,
      );
      rowHtml = rowHtml
        .replaceAll('z-index:2;left:40px;', 'z-index:1;left:40px;')
        .replace(/(<td data-path="\/S\/A1"[^>]*style=")([^"]*)"/, '$1$2z-index:3;"')
        .replace(
          '<th class="row-header">1</th>',
          '<th class="row-header" style="position:sticky;top:18px;left:0;z-index:3">1</th>',
        )
        .replace(
          "e.style.top=h+'px')</script>",
          "e.style.top=h+'px');document.querySelector('tr[data-frozen] th').style.top=h+'px'</script>",
        );
      await writeFile(rowFile, rowHtml);
      await contents.loadURL(pathToFileURL(rowFile).href);
      await frames();
      await contents.executeJavaScriptInIsolatedWorld(1015, [{ code: 'globalThis.events=[]' }]);
      const originalRowInline = await js(
          "[...document.querySelectorAll('tbody tr')].map(e=>e.getAttribute('style'))",
        ),
        originalCells = (await snapshot()).inline;
      await isolated(officeInteractionInstallScript('excel'));
      for (const zoom of [1.25, 1.5, 2])
        for (const [step, [left, top]] of (
          [
            [0, 0],
            [80, 0],
            [80, 350],
            [80, 0],
            [0, 0],
          ] as const
        ).entries()) {
          await isolated(officeInteractionControlScript({ kind: 'zoom', value: zoom }));
          await js(
            `(()=>{const w=document.querySelector('.table-wrapper');w.scrollLeft=${left};w.scrollTop=${top}})()`,
          );
          await frames();
          const capture = await captureCurrent(),
            paint = pixelReader(capture);
          const rows: { address: string; header: Rect; cell: Rect }[] = await js(
            `(()=>{const rect=e=>e.getBoundingClientRect().toJSON(),tabs=document.querySelector('.kite-office-sheet-tabs').getBoundingClientRect(),head=document.querySelector('thead .col-header').getBoundingClientRect();return[...document.querySelectorAll('tbody tr')].flatMap(row=>{const h=row.querySelector('th'),c=row.querySelector('td');if(!h||!c)return[];const hr=rect(h),cr=rect(c),hx=hr.right-8*${zoom},cx=cr.right-8*${zoom},y=hr.bottom-1;if(hr.bottom<head.bottom+4||hr.bottom>Math.min(innerHeight,tabs.top)-4)return[];if(document.elementFromPoint(hx,y)!==h||document.elementFromPoint(cx,y)!==c)return[];return[{address:c.getAttribute('data-path'),header:hr,cell:cr}]})})()`,
          );
          assert.ok(rows.length >= 3);
          const results = [];
          for (const row of rows) {
            assert.ok(Math.abs(row.header.bottom - row.cell.bottom) < 0.001);
            const base = Math.round(row.header.bottom * paint.scale),
              offsets = [];
            for (const x of [row.header.right - 8 * zoom, row.cell.right - 8 * zoom]) {
              const line = [];
              for (let y = base - Math.ceil(zoom * paint.scale) - 2; y <= base + 2; y++) {
                const rgb = paint.rgb(x, y / paint.scale);
                if (rgb.every((value) => value === 224)) line.push(y);
              }
              assert.ok(line.length > 0, 'flat/background pixels are not a grid line');
              offsets.push(line);
            }
            // Chromium's native frozen corner can retain a one-pixel phase difference
            // between its own shadow and other frozen td after scrolling back. The same
            // difference exists with no production script specifically at 200% after
            // vertical return while horizontal scroll remains. All other corner states
            // remain strict comparisons. Preserve that one profile, but do
            // not call them row-header alignment coverage or imitate the extra td stroke.
            const nativeFrozenCorner = zoom === 2 && step === 3 && row.address === '/S/A1';
            if (!nativeFrozenCorner)
              assert.deepEqual(
                offsets[0],
                offsets[1],
                `row-number/default grid absolute pixel y and width: ${zoom}/${left}/${top}/${row.address}`,
              );
            results.push({
              address: row.address,
              height: row.cell.height,
              headerY: offsets[0],
              cellY: offsets[1],
              alignmentQualified: !nativeFrozenCorner,
            });
          }
          assert.ok(new Set(rows.map((row) => Math.round(row.cell.height))).size >= 2);
          assert.deepEqual((await snapshot()).inline, originalCells);
          assert.deepEqual(
            await js("[...document.querySelectorAll('tbody tr')].map(e=>e.getAttribute('style'))"),
            originalRowInline,
          );
          await writeFile(
            join(root, `row-lines-${zoom}-${left}-${top}-${rowLineSamples.length}.png`),
            capture.picture.toPNG(),
          );
          rowLineSamples.push({
            zoom,
            step,
            left,
            top,
            syntheticVariableHeights: true,
            rows: results,
          });
        }

      passed = true;
    } catch (error) {
      console.error(error);
      await writeFile(
        join(root, 'events.json'),
        JSON.stringify(
          (await contents.executeJavaScriptInIsolatedWorld(1015, [
            { code: 'globalThis.events' },
          ])) ?? null,
        ),
      );
      await writeFile(
        join(root, 'failure.png'),
        (await contents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG(),
      );
      await writeFile(
        join(root, 'failure.txt'),
        String(error instanceof Error ? error.stack : error),
      );
      throw error;
    } finally {
      await new Promise<void>((resolve) => {
        contents.once('destroyed', () => resolve());
        window.destroy();
      });
      await writeFile(
        join(root, 'receipt.json'),
        JSON.stringify(
          {
            passed,
            viewsDestroyed: contents.isDestroyed(),
            normalSandbox: !app.commandLine.hasSwitch('no-sandbox'),
            windowWasHidden: true,
            samples,
            rangeSamples,
            captureAttempts,
            migrationSamples,
            frozenSamples,
            perimeterSamples,
            rowLineSamples,
            popupSamples,
            tabSamples,
          },
          null,
          2,
        ),
      );
      app.exit(passed ? 0 : 1);
    }
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
