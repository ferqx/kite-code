/** Real Chromium geometry on OfficeCLI output. Program input, not human/CUA qualification. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow } from 'electron';
import {
  officeInteractionControlScript,
  officeInteractionInstallScript,
  officeInteractionPeekScript,
  officeInteractionReadScript,
  officeInteractionReleaseScript,
  officeInteractionWorld,
} from '../electron/office-preview-interaction';

const root = resolve(process.argv[2]!),
  html = resolve(process.argv[3]!);
app.setPath('userData', join(root, 'profile'));
app.on('window-all-closed', () => {});
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
void (async () => {
  const before = await readFile(html),
    samples: unknown[] = [];
  let window: BrowserWindow | undefined;
  let stage = 'starting',
    sequence = 0,
    finished = false;
  const checkpoint = (name: string) => {
    stage = name;
    const entry = JSON.stringify({ sequence: ++sequence, stage, time: new Date().toISOString() });
    appendFileSync(join(root, 'checkpoints.jsonl'), `${entry}\n`);
    console.log(entry);
  };
  const fail = (error: unknown) => {
    if (finished) return;
    finished = true;
    clearTimeout(deadline);
    const failedStage = stage;
    if (window && !window.isDestroyed()) window.destroy();
    writeFileSync(
      join(root, 'failure.json'),
      JSON.stringify(
        {
          error: String(error),
          stack: error instanceof Error ? error.stack : undefined,
          stage: failedStage,
          viewsDestroyed: !window || window.isDestroyed(),
          samples,
        },
        null,
        2,
      ),
    );
    app.exit(1);
  };
  const deadline = setTimeout(() => fail(Error(`request_zoom_total_timeout:${stage}`)), 90000);
  const bounded = async <T>(name: string, operation: () => Promise<T>, milliseconds = 8000) => {
    checkpoint(`${name}:begin`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(Error(`request_zoom_stage_timeout:${name}`)),
            milliseconds,
          );
        }),
      ]);
      checkpoint(`${name}:end`);
      return value;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  try {
    await bounded('app-ready', () => app.whenReady());
    window = new BrowserWindow({
      show: false,
      width: 720,
      height: 560,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        partition: `request-zoom-${Date.now()}`,
      },
    });
    const contents = window.webContents;
    const base = `${pathToFileURL(dirname(html)).href}/`;
    contents.session.setPermissionRequestHandler((_w, _p, callback) => callback(false));
    contents.session.setPermissionCheckHandler(() => false);
    contents.session.on('will-download', (event) => event.preventDefault());
    assert.equal(app.commandLine.hasSwitch('no-sandbox'), false);
    const preferences = (
      contents as unknown as {
        getLastWebPreferences(): {
          sandbox?: boolean;
          contextIsolation?: boolean;
          nodeIntegration?: boolean;
          webSecurity?: boolean;
        };
      }
    ).getLastWebPreferences();
    assert.equal(preferences.sandbox, true);
    assert.equal(preferences.contextIsolation, true);
    assert.equal(preferences.nodeIntegration, false);
    assert.equal(preferences.webSecurity, true);
    contents.session.webRequest.onBeforeRequest((request, callback) =>
      callback({ cancel: !request.url.startsWith(base) }),
    );
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event) => event.preventDefault());
    const isolated = (code: string) =>
      bounded('isolated-script', () =>
        contents.executeJavaScriptInIsolatedWorld(officeInteractionWorld, [{ code }]),
      );
    const execute = (code: string) =>
      bounded('page-script', () => contents.executeJavaScript(code));
    const frames = () =>
      bounded(
        'two-paint-frames',
        () =>
          contents.executeJavaScript(
            'new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))',
          ),
        4000,
      );
    const pressEscape = async () => {
      contents.sendInputEvent({ type: 'keyDown', keyCode: 'ESC' });
      contents.sendInputEvent({ type: 'keyUp', keyCode: 'ESC' });
      await frames();
    };
    const click = async (selector: string) => {
      const point = await execute(
        `(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),x=Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2),hit=document.elementFromPoint(x,y);return {x,y,hit:e===hit||e.contains(hit)}})()`,
      );
      assert.equal(point.hit, true, `target not hit: ${selector}`);
      for (const type of ['mouseDown', 'mouseUp'] as const)
        contents.sendInputEvent({ type, button: 'left', clickCount: 1, x: point.x, y: point.y });
      await frames();
    };
    const inspect = (selector: string) =>
      execute(
        `(()=>{const e=document.querySelector(${JSON.stringify(selector)}),b=document.querySelector('.kite-office-request-trigger'),r=e.getBoundingClientRect(),q=b.getBoundingClientRect(),w=Math.min(innerWidth,document.documentElement.clientWidth||innerWidth),h=Math.min(innerHeight,document.documentElement.clientHeight||innerHeight),rect=r=>({x:r.left,y:r.top,width:r.width,height:r.height});const table=e.closest('table'),wrapper=table.parentElement,wr=wrapper.getBoundingClientRect(),scale=Number.parseFloat(getComputedStyle(document.documentElement).zoom)||1;let left=Math.max(0,r.left,wr.left),top=Math.max(0,r.top,wr.top),right=Math.min(w,r.right,wr.left+wrapper.clientWidth*scale),bottom=Math.min(h,r.bottom,wr.top+wrapper.clientHeight*scale);const occluders=[];for(const other of table.querySelectorAll('th,td')){if(other===e||getComputedStyle(other).position!=='sticky')continue;const o=other.getBoundingClientRect();if(o.left<=r.left&&o.right>left&&o.top<bottom&&o.bottom>top){left=o.right;occluders.push(other.getAttribute('data-path'));}if(o.top<=r.top&&o.bottom>top&&o.left<right&&o.right>left){top=o.bottom;occluders.push(other.getAttribute('data-path'));}}const head=table.querySelector('thead')?.getBoundingClientRect(),rail=table.querySelector('tbody .row-header')?.getBoundingClientRect(),contentArea={left:Math.max(0,wr.left,rail?.right??wr.left),top:Math.max(0,wr.top,head?.bottom??wr.top),right:Math.min(w,wr.left+wrapper.clientWidth*scale),bottom:Math.min(h,wr.top+wrapper.clientHeight*scale)};const hitCell=(x,y)=>{const old=b.style.pointerEvents;b.style.pointerEvents='none';const path=document.elementFromPoint(x,y)?.closest('td,th')?.getAttribute('data-path');b.style.pointerEvents=old;return path},middleY=(top+bottom)/2;return {contentArea,cell:rect(r),visibleCell:{x:left,y:top,width:right-left,height:bottom-top},occlusion:{occluders,visibleHit:hitCell(left+Math.min(3,(right-left)/2),middleY),coveredHit:left-r.left>3?hitCell(left-2,middleY):null},button:rect(q),viewport:{width:w,height:h},font:getComputedStyle(b).fontSize,zoom:getComputedStyle(document.documentElement).zoom,buttonZoom:getComputedStyle(b).zoom,visible:getComputedStyle(b).display!=='none',path:e.getAttribute('data-path'),hits:[[q.left+3,q.top+3],[q.right-3,q.top+3],[q.left+3,q.bottom-3],[q.right-3,q.bottom-3],[q.left+q.width/2,q.top+q.height/2]].map(([x,y])=>document.elementFromPoint(x,y)===b)}})()`,
      );
    let baseline: { width: number; height: number } | undefined;
    const assertPopup = (state: Awaited<ReturnType<typeof inspect>>) => {
      assert.equal(state.visible, true);
      assert.equal(state.font, '13px');
      assert.ok(
        state.hits.every(Boolean),
        'button rendered pixels and native hit targets disagree',
      );
      assert.ok(state.visibleCell.width > 0 && state.visibleCell.height > 0);
      assert.equal(state.occlusion.visibleHit, state.path);
      if (state.visibleCell.x - state.cell.x > 3) {
        assert.notEqual(state.occlusion.coveredHit, state.path);
        assert.ok(state.occlusion.occluders.includes(state.occlusion.coveredHit));
      }
      const expectedLeft = Math.max(
        state.contentArea.left + 4,
        Math.min(state.contentArea.right - state.button.width - 4, state.visibleCell.x),
      );
      const expectedTop = Math.max(
        state.contentArea.top + 4,
        Math.min(
          state.contentArea.bottom - state.button.height - 4,
          state.visibleCell.y + state.visibleCell.height + 5,
        ),
      );
      assert.ok(state.button.x >= state.contentArea.left + 4 - 0.05);
      assert.ok(state.button.y >= state.contentArea.top + 4 - 0.05);
      assert.ok(Math.abs(state.button.x - expectedLeft) <= 0.05, JSON.stringify(state));
      assert.ok(Math.abs(state.button.y - expectedTop) <= 0.05, JSON.stringify(state));
      assert.ok(state.button.x + state.button.width <= state.contentArea.right - 4 + 0.05);
      assert.ok(state.button.y + state.button.height <= state.contentArea.bottom - 4 + 0.05);
    };
    // Hidden Linux windows need not receive compositor frames. This is a visible,
    // inactive program-driven fixture, not hidden-window or human qualification.
    window.showInactive();
    checkpoint('window-shown-inactive');
    for (const width of [720, 360]) {
      window.setContentSize(width, 560);
      await bounded(`load-${width}`, () => contents.loadURL(pathToFileURL(html).href), 15000);
      await frames();
      const authored = await execute(
        `JSON.stringify([...document.querySelectorAll('td[data-path]')].map(e=>[e.getAttribute('data-path'),e.getAttribute('style'),e.textContent]))`,
      );
      await isolated(officeInteractionInstallScript('excel'));
      const target = '.sheet-content.active td[data-path$="/B6"]';
      for (const zoom of [0.75, 1, 1.25, 2, 'fit'] as const) {
        checkpoint(`sample-${width}-${zoom}`);
        await pressEscape();
        await isolated(officeInteractionControlScript({ kind: 'zoom', value: zoom }));
        await execute(
          `document.querySelector('.sheet-content.active .table-wrapper').scrollTo(0,0)`,
        );
        await frames();
        await click(target);
        const first = await inspect(target);
        assertPopup(first);
        baseline ??= { width: first.button.width, height: first.button.height };
        assert.ok(
          Math.abs(first.button.width - baseline.width) <= 0.05,
          'button width follows document zoom',
        );
        assert.ok(
          Math.abs(first.button.height - baseline.height) <= 0.05,
          'button height follows document zoom',
        );
        const selected = await isolated(officeInteractionPeekScript);
        await execute(`document.querySelector('.kite-office-request-trigger').click()`);
        assert.equal((await isolated(officeInteractionPeekScript)).floatingRequest, undefined);
        // Keep B6 visible while moving both document scroll axes. Native CSS layout
        // and event handling determine its new viewport coordinates.
        await execute(
          `{const w=document.querySelector('.sheet-content.active .table-wrapper');w.scrollLeft=10;w.scrollTop=16;}`,
        );
        await frames();
        const scrolled = await inspect(target);
        assertPopup(scrolled);
        assert.deepEqual(
          (await isolated(officeInteractionPeekScript)).selection,
          selected.selection,
        );
        await click('.kite-office-request-trigger');
        const request = await isolated(officeInteractionReadScript);
        assert.equal(request.floatingSelection.kind, 'excel');
        assert.equal(request.floatingSelection.range, 'B6');
        assert.equal(request.floatingSelection.cells[0].path, scrolled.path);
        assert.deepEqual(request.requestAnchor, scrolled.cell);
        assert.equal((await isolated(officeInteractionReadScript)).floatingRequest, undefined);
        await click('.sheet-content.active td[data-path$="/B5"]');
        const locked = await isolated(officeInteractionPeekScript);
        assert.deepEqual(locked.selection, selected.selection);
        assert.equal(locked.floatingRequest, undefined);
        await isolated(officeInteractionReleaseScript(request.floatingRequest));
        await pressEscape();
        // Select the last wholly visible cell to exercise real right/bottom clamping.
        const edge = await execute(
          `(()=>{const w=document.querySelector('.sheet-content.active .table-wrapper').getBoundingClientRect();return [...document.querySelectorAll('.sheet-content.active td[data-path]')].filter(e=>{const r=e.getBoundingClientRect();return r.left>=40&&r.top>w.top+40&&r.right<=Math.min(innerWidth,w.right)-20&&r.bottom<=Math.min(innerHeight,w.bottom)-1}).sort((a,b)=>{const x=a.getBoundingClientRect(),y=b.getBoundingClientRect();return y.bottom-x.bottom||y.right-x.right})[0]?.getAttribute('data-path')})()`,
        );
        assert.equal(typeof edge, 'string');
        const edgeSelector = `td[data-path=${JSON.stringify(edge)}]`;
        await click(edgeSelector);
        const edgeState = await inspect(edgeSelector);
        assertPopup(edgeState);
        await pressEscape();
        assert.equal((await isolated(officeInteractionPeekScript)).selection, null);
        assert.equal(
          await execute(
            `JSON.stringify([...document.querySelectorAll('td[data-path]')].map(e=>[e.getAttribute('data-path'),e.getAttribute('style'),e.textContent]))`,
          ),
          authored,
        );
        samples.push({ width, zoom, first, scrolled, edge: edgeState });
      }
    }
    assert.equal(digest(await readFile(html)), digest(before));
    window.destroy();
    assert.equal(window.isDestroyed(), true);
    await writeFile(
      join(root, 'receipt.json'),
      JSON.stringify(
        {
          passed: true,
          normalSandbox: true,
          viewsDestroyed: true,
          htmlSha256: digest(before),
          samples,
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ measurement: 'office-request-zoom-cli-html', samples }));
    finished = true;
    clearTimeout(deadline);
    checkpoint('passed-own-window-destroyed');
    app.exit(0);
  } catch (error) {
    fail(error);
  }
})();
