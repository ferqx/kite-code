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
  await window.webContents.executeJavaScript(
    "const note=document.createElement('details');note.setAttribute('role','note');note.style.display='none';note.textContent='Authored note preserved';document.body.append(note);",
  );
  await window.webContents.executeJavaScriptInIsolatedWorld(officeInteractionWorld, [
    { code: officeInteractionInstallScript('powerpoint') },
  ]);
  for (const width of [240, 320, 478, 640, 960]) {
    window.setContentSize(width, 600);
    await window.webContents.executeJavaScriptInIsolatedWorld(officeInteractionWorld, [
      { code: officeInteractionControlScript({ kind: 'zoom', value: 'fit' }) },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 180));
    await window.webContents.executeJavaScriptInIsolatedWorld(officeInteractionWorld, [
      { code: officeInteractionPeekScript },
    ]);
    const result = await window.webContents
      .executeJavaScript(
        `JSON.stringify({webdriver:navigator.webdriver,width:innerWidth,rail:document.querySelector('.kite-thumbnail-rail').getBoundingClientRect().width,authored:document.body.textContent.includes('Authored note preserved'),notice:[...document.querySelectorAll('body > details[role="note"]')].some(el=>el.textContent.startsWith('Kite 离线预览说明')),slides:[...document.querySelectorAll('.main > .slide-container .slide')].map(el=>({left:el.getBoundingClientRect().left,right:el.getBoundingClientRect().right,text:el.textContent})),buttons:document.querySelectorAll('.kite-thumbnail-button').length})`,
      )
      .then(JSON.parse);
    assert.equal(result.webdriver, automated);
    assert.equal(result.notice, false);
    assert.equal(result.authored, true);
    assert.equal(result.buttons, 2);
    assert.equal(result.rail, width <= 360 ? 64 : width <= 480 ? 80 : 104);
    for (const slide of result.slides)
      assert.ok(slide.left >= result.rail - 1 && slide.right <= width + 1, JSON.stringify(result));
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
