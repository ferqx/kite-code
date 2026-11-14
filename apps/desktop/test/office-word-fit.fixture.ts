/** Real Electron on a supplied synthetic OfficeCLI HTML file; no model or user profile. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { app, BrowserWindow } from 'electron';
import {
  officeInteractionControlScript,
  officeInteractionInstallScript,
  officeInteractionPeekScript,
  officeInteractionWorld,
} from '../electron/office-preview-interaction';

const root = resolve(process.argv[2]!);
const automated = process.argv[3] === 'automated';
app.setPath('userData', join(root, automated ? 'automated-profile' : 'normal-profile'));
if (automated) app.commandLine.appendSwitch('enable-automation');
const samples: unknown[] = [];
const deadline = setTimeout(() => app.exit(2), 30000);
void (async () => {
  await app.whenReady();
  const window = new BrowserWindow({
    show: true,
    width: 640,
    height: 600,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  window.webContents.session.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*'] },
    (_details, callback) => callback({ cancel: true }),
  );
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false),
  );
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  await window.loadFile(join(root, 'index.html'));
  await window.webContents.executeJavaScriptInIsolatedWorld(officeInteractionWorld, [
    { code: officeInteractionInstallScript('word') },
  ]);
  for (const width of [240, 320, 478, 640, 960]) {
    window.setContentSize(width, 600);
    await window.webContents.executeJavaScriptInIsolatedWorld(officeInteractionWorld, [
      { code: officeInteractionControlScript({ kind: 'zoom', value: 'fit' }) },
    ]);
    const result = await window.webContents.executeJavaScript(
      `new Promise((resolve,reject)=>{const start=Date.now();function sample(){if(document.documentElement.getAttribute('data-kite-word-pagination-state')!=='settled'){if(Date.now()-start>5000)return reject(Error('pagination_not_settled'));return setTimeout(sample,20);}requestAnimationFrame(()=>requestAnimationFrame(()=>{const page=document.querySelector('body > .page-wrapper > .page');const r=page.getBoundingClientRect();resolve({webdriver:navigator.webdriver,width:innerWidth,left:r.left,right:r.right,text:page.textContent,rail:!!document.querySelector('.kite-word-rail'),sync:window._wpSync});}));}sample();})`,
    );
    assert.equal(result.webdriver, automated);
    assert.equal(result.sync, false);
    assert.equal(result.width, width);
    assert.ok(result.left >= 0 && result.right <= width, JSON.stringify(result));
    assert.ok(
      result.text.includes('KITE_KEEP_UNCHANGED') && result.text.includes('KITE_TARGET_ORIGINAL'),
    );
    assert.equal(result.rail, true);
    await window.webContents.executeJavaScriptInIsolatedWorld(officeInteractionWorld, [
      { code: officeInteractionPeekScript },
    ]);
    samples.push(result);
    if (width === 240 || width === 478)
      writeFileSync(
        join(root, `${automated ? 'automated' : 'normal'}-${width}.png`),
        (await window.webContents.capturePage()).toPNG(),
      );
  }
  writeFileSync(
    join(root, `${automated ? 'automated' : 'normal'}-result.json`),
    JSON.stringify(samples, null, 2),
  );
  clearTimeout(deadline);
  window.destroy();
  app.quit();
})().catch((error) => {
  console.error(error);
  clearTimeout(deadline);
  app.exit(1);
});
