import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import {
  officeInteractionControlScript,
  officeInteractionInstallScript,
  officeInteractionWorld,
} from '../electron/office-preview-interaction';

const root = process.argv[2]!;
app.setPath('userData', join(root, 'profile'));
app
  .whenReady()
  .then(async () => {
    const w = new BrowserWindow({
      width: 800,
      height: 600,
      useContentSize: true,
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    const c = w.webContents;
    const records = [];
    try {
      for (const kind of ['word', 'powerpoint'] as const) {
        const html =
          kind === 'word'
            ? `<html data-kite-word-pagination-state="settled" data-kite-word-pagination-generation="1"><style>body{margin:0}.page{width:600px;height:800px;background:white}.page-body{padding:30px}</style><div class="pages"><div class="page-wrapper"><div class="page"><div class="page-body"><p data-path="/body/p[1]">Synthetic Word page</p></div></div></div><div class="page-wrapper"><div class="page"><div class="page-body"><p data-path="/body/p[2]">Second page</p></div></div></div></div>`
            : `<style>body{margin:0;display:flex}.main{flex:1;min-width:0}.slide{width:600px;height:400px;background:white}</style><div class="main"><div class="slide-container"><div class="slide" data-path="/slide[1]">Synthetic Slide 1</div></div><div class="slide-container"><div class="slide" data-path="/slide[2]">Synthetic Slide 2</div></div></div>`;
        await c.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
        await c.executeJavaScriptInIsolatedWorld(officeInteractionWorld, [
          { code: officeInteractionInstallScript(kind) },
        ]);
        for (const zoom of [1, 1.5, 2, 'fit'] as const) {
          await c.executeJavaScriptInIsolatedWorld(officeInteractionWorld, [
            { code: officeInteractionControlScript({ kind: 'zoom', value: zoom }) },
          ]);
          await c.executeJavaScript(
            'new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))',
          );
          const m = await c.executeJavaScript(
            `(()=>{const r=s=>{const e=document.querySelector(s);return e?{...e.getBoundingClientRect().toJSON(),font:getComputedStyle(e).fontSize}:null};const word=${kind === 'word'};return {rail:r(word?'.kite-word-rail':'.kite-thumbnail-rail'),button:r(word?'.kite-word-page-button':'.kite-thumbnail-button'),visual:r(word?'.kite-word-visual':'.kite-thumbnail-visual'),number:r(word?'.kite-word-number':'.kite-thumbnail-number'),content:r(word?'.pages > .page-wrapper > .page':'.main > .slide-container > .slide'),rootZoom:getComputedStyle(document.documentElement).zoom}})()`,
          );
          assert.equal(m.rail.width, 104);
          assert.equal(m.rail.height, 600);
          assert.equal(m.content.width, 600 * (zoom === 'fit' ? 1 : zoom));
          records.push({ kind, zoom, ...m });
          await c
            .capturePage()
            .then((i) => writeFileSync(join(root, kind + '-' + zoom + '.png'), i.toPNG()));
        }
        w.setContentSize(400, 600);
        await c.executeJavaScript(
          'new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))',
        );
        const inspect = () =>
          c.executeJavaScript(
            `(()=>{const r=document.querySelector('.kite-page-rail');return {width:r.getBoundingClientRect().width,compact:r.classList.contains('kite-rail-compact'),buttonHeight:r.querySelector('button').getBoundingClientRect().height,gutter:parseFloat(getComputedStyle(document.body).paddingLeft)}})()`,
          );
        assert.equal((await inspect()).width, 32);
        assert.equal((await inspect()).buttonHeight, 16);
        await c.executeJavaScript("document.querySelector('.kite-page-rail').focus()");
        assert.equal((await inspect()).width, 104);
        await c
          .capturePage()
          .then((i) => writeFileSync(join(root, kind + '-narrow-focus.png'), i.toPNG()));
        await c.executeJavaScript('document.activeElement.blur()');
        assert.equal((await inspect()).width, 32);
        c.sendInputEvent({ type: 'mouseMove', x: 12, y: 300 });
        await new Promise((r) => setTimeout(r, 100));
        assert.equal((await inspect()).width, 104);
        c.sendInputEvent({ type: 'mouseMove', x: 350, y: 100 });
        await new Promise((r) => setTimeout(r, 100));
        assert.equal((await inspect()).width, 32);
        await c
          .capturePage()
          .then((i) => writeFileSync(join(root, kind + '-narrow-lines.png'), i.toPNG()));
        for (const value of [1, 1.5, 2, 'fit'] as const) {
          await c.executeJavaScriptInIsolatedWorld(officeInteractionWorld, [
            { code: officeInteractionControlScript({ kind: 'zoom', value }) },
          ]);
          assert.equal((await inspect()).width, 32);
          await c.executeJavaScript("document.querySelector('.kite-page-rail').focus()");
          assert.equal((await inspect()).width, 104);
          const xy = await c.executeJavaScript(
            "(()=>{const b=document.querySelectorAll('.kite-page-rail>button')[1].getBoundingClientRect();return {x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}})()",
          );
          c.sendInputEvent({ type: 'mouseMove', ...xy });
          c.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...xy });
          c.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...xy });
          await new Promise((r) => setTimeout(r, 100));
          if (kind === 'powerpoint') {
            const state = await c.executeJavaScriptInIsolatedWorld(officeInteractionWorld, [
              { code: 'globalThis.kiteOfficeInteraction.read()' },
            ]);
            assert.equal(state.currentSlide, 2);
          } else {
            const top = await c.executeJavaScript(
              "document.querySelectorAll('.pages>.page-wrapper>.page')[1].getBoundingClientRect().top",
            );
            assert.ok(top < 600, 'Word second-page click navigates into viewport');
          }
          await c.executeJavaScript('document.activeElement.blur()');
          c.sendInputEvent({ type: 'mouseMove', x: 350, y: 100 });
          await new Promise((r) => setTimeout(r, 100));
          assert.equal((await inspect()).width, 32);
        }
        records.push({ kind, narrow: await inspect() });
        w.setContentSize(800, 600);
      }
      writeFileSync(join(root, 'measurements.json'), JSON.stringify(records, null, 2));
    } finally {
      w.destroy();
    }
  })
  .then(
    () => app.exit(0),
    (e) => {
      console.error(e);
      app.exit(1);
    },
  );
