/** Isolated Chromium geometry check. Synthetic table; no provider, user files or network. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import {
  officeInteractionControlScript,
  officeInteractionInstallScript,
  officeInteractionWorld,
} from '../electron/office-preview-interaction';

const root = process.argv[2]!;
app.setPath('userData', join(root, 'profile'));
void app
  .whenReady()
  .then(async () => {
    const window = new BrowserWindow({
      width: 400,
      height: 600,
      useContentSize: true,
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    const c = window.webContents;
    try {
      await c.loadURL(
        'data:text/html;charset=utf-8,' +
          encodeURIComponent(
            `<!doctype html><style>*{box-sizing:border-box}html,body{margin:0;height:100%}body{display:flex;flex-direction:column}.sheet-slider{flex:1;min-height:0;display:flex;flex-direction:column}.sheet-content{flex:1;min-height:0;display:flex;flex-direction:column}.table-wrapper{flex:1;overflow:auto}table{width:1200px;table-layout:fixed;border-collapse:collapse}th,td{border:1px solid #aaa;height:90px}th{width:40px}.sheet-tabs{display:flex;flex-shrink:0}</style><div class="sheet-slider"><div class="sheet-content active" data-sheet="0"><div class="table-wrapper"><table><colgroup><col style="width:40px"><col style="width:580px"><col style="width:580px"></colgroup><thead><tr><th></th><th>A</th><th>B</th></tr></thead><tbody><tr><th class="row-header">1</th><td data-path="/Sheet1/A1">预算输入</td><td data-path="/Sheet1/B1">600</td></tr><tr><th class="row-header">2</th><td data-path="/Sheet1/A2">预算汇总</td><td data-path="/Sheet1/B2">2840</td></tr></tbody></table></div></div></div><div class="sheet-tabs"><div class="sheet-tab active" data-sheet="0">Sheet1</div></div>`,
          ),
      );
      await c.executeJavaScriptInIsolatedWorld(officeInteractionWorld, [
        { code: officeInteractionInstallScript('excel') },
      ]);
      const measure = () =>
        c.executeJavaScript(
          `(()=>{const r=e=>e.getBoundingClientRect().toJSON(),d=document;return {width:innerWidth,scale:Number(getComputedStyle(d.documentElement).zoom),table:r(d.querySelector('table')),tab:r(d.querySelector('.sheet-tab')),button:r(d.querySelector('.kite-office-request-trigger')),header:r(d.querySelector('tbody th')),cell:r(d.querySelector('td')),style:d.querySelector('table').getAttribute('style')}})()`,
        );
      const control = (value: number | 'fit') =>
        c.executeJavaScriptInIsolatedWorld(officeInteractionWorld, [
          { code: officeInteractionControlScript({ kind: 'zoom', value }) },
        ]);
      await control(1);
      const base = await measure();
      const point = await c.executeJavaScript(
        `(()=>{const r=document.querySelector('td').getBoundingClientRect();return{x:Math.round(r.left+20),y:Math.round(r.top+20)}})()`,
      );
      c.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
      c.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
      const records = [];
      for (const width of [400, 240, 600]) {
        window.setContentSize(width, 600);
        await control('fit');
        // Wait for layout/selection paint, not for model work.
        await c.executeJavaScript(
          'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
        );
        const m = await measure();
        assert.ok(m.table.width <= width && m.table.width >= width - 3);
        assert.ok(Math.abs(m.tab.height - base.tab.height) < 1);
        assert.ok(Math.abs(m.header.bottom - m.cell.bottom) < 0.1);
        assert.ok(
          m.button.height >= 25 && m.button.height <= 35,
          'request button stays at interface size',
        );
        assert.equal(m.style, base.style);
        records.push(m);
        await writeFile(join(root, `fit-${width}.png`), (await c.capturePage()).toPNG());
      }
      await control(1);
      assert.ok((await measure()).table.width > 1199, '100% is distinct from fit');
      await writeFile(join(root, 'result.json'), JSON.stringify(records, null, 2));
      await c.loadURL(
        'data:text/html;charset=utf-8,' +
          encodeURIComponent(
            '<style>body{margin:0;display:flex}.main{flex:1}</style><div class="main"><div class="slide-container"><div class="slide" style="width:1280px;height:720px">Slide</div></div></div>',
          ),
      );
      await c.executeJavaScriptInIsolatedWorld(officeInteractionWorld, [
        { code: officeInteractionInstallScript('powerpoint') },
      ]);
      for (const [width, expected] of [
        [600, 104],
        [400, 32],
        [240, 32],
      ]) {
        window.setContentSize(width!, 600);
        await c.executeJavaScript(
          'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
        );
        const railWidth = await c.executeJavaScript(
          'document.querySelector(".kite-thumbnail-rail").getBoundingClientRect().width',
        );
        assert.equal(railWidth, expected, 'PPT narrow rail collapses to fixed interface ticks');
      }
    } finally {
      window.destroy();
    }
  })
  .then(
    () => app.exit(0),
    (error) => {
      console.error(error);
      app.exit(1);
    },
  );
