/** Isolated Electron with fixed synthetic PDF.js renders. No provider, network or model. */
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron } from 'playwright';
import {
  type PdfTextLayer,
  pdfPreviewHtml,
  pdfPreviewInstallScript,
} from '../electron/pdf-preview';

type FixtureGlobal = {
  kitePdfPreview: {
    control(command: { kind: string; value: number }): void;
    setLayer(page: number, layer: PdfTextLayer): void;
  };
  kiteOfficeInteraction: {
    read(): {
      selection: import('../src/output-files-bridge').PdfSelection;
      floatingSelection: import('../src/output-files-bridge').PdfSelection;
      floatingRequest: number;
    };
  };
};
const root = await mkdtemp(join(tmpdir(), 'kite-pdf-annotation-layout-'));
const source = process.env.KITE_PDF_TEXT_FIXTURES;
if (!source) throw Error('fixed_pdf_fixtures_required');
await writeFile(
  join(root, 'main.cjs'),
  `const{app,BrowserWindow}=require('electron');app.setPath('userData',require('node:path').join(__dirname,'profile'));app.whenReady().then(()=>{const w=new BrowserWindow({width:1200,height:900,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});w.webContents.session.setPermissionRequestHandler((a,b,c)=>c(false));w.webContents.setWindowOpenHandler(()=>({action:'deny'}));w.loadFile(require('node:path').join(__dirname,'index.html'));});`,
);
await writeFile(join(root, 'index.html'), pdfPreviewHtml(1));
const app = await _electron.launch({ args: [join(root, 'main.cjs')] });
const page = await app.firstWindow();
const checks: unknown[] = [];
try {
  for (const name of ['latin', 'chinese', 'chinese-rotated', 'columns']) {
    await copyFile(join(source, `${name}.png`), join(root, 'page-1.png'));
    await page.reload();
    await page.evaluate(pdfPreviewInstallScript());
    await page.waitForFunction(() => {
      const img = document.querySelector('main img') as HTMLImageElement;
      return img.complete && img.naturalWidth > 0;
    });
    const layer = JSON.parse(await readFile(join(source, `${name}.json`), 'utf8'));
    await page.evaluate((value) => {
      const g = globalThis as unknown as FixtureGlobal;
      g.kitePdfPreview.control({ kind: 'zoom', value: 1 });
      g.kitePdfPreview.setLayer(1, value);
    }, layer);
    const span = page.locator('.text span').first();
    await span.scrollIntoViewIfNeeded();
    const box = await span.boundingBox();
    assert.ok(box);
    await page.mouse.dblclick(box.x + box.width * 0.2, box.y + box.height * 0.2);
    const state = await page.evaluate(() =>
      (globalThis as unknown as FixtureGlobal).kiteOfficeInteraction.read(),
    );
    assert.equal(state.selection?.kind, 'pdf');
    assert.equal(state.selection?.scope, 'text');
    assert.ok(state.selection.text);
    assert.ok(state.selection.text.trim());
    assert.ok(layer.items[0].text.includes(state.selection.text));
    assert.ok(state.selection.rects.length);
    await page.getByRole('button', { name: '请求修改', exact: true }).click();
    const frozen = await page.evaluate(() =>
      (globalThis as unknown as FixtureGlobal).kiteOfficeInteraction.read(),
    );
    assert.deepEqual(frozen.floatingSelection, state.selection);
    await page.screenshot({ path: join(root, `${name}.png`) });
    checks.push({ name, selection: state.selection, request: frozen.floatingRequest });
  }
  await copyFile(join(source, 'empty.png'), join(root, 'page-1.png'));
  await page.reload();
  await page.evaluate(pdfPreviewInstallScript());
  await page.waitForFunction(() => {
    const img = document.querySelector('main img') as HTMLImageElement;
    return img.complete && img.naturalWidth > 0;
  });
  const empty = JSON.parse(await readFile(join(source, 'empty.json'), 'utf8'));
  await page.evaluate(
    (value) => (globalThis as unknown as FixtureGlobal).kitePdfPreview.setLayer(1, value),
    empty,
  );
  const area = await page.locator('main img').boundingBox();
  assert.ok(area);
  await page.mouse.move(area.x + 40, area.y + 40);
  await page.mouse.down();
  await page.mouse.move(area.x + 160, area.y + 140, { steps: 8 });
  await page.mouse.up();
  const region = await page.evaluate(() =>
    (globalThis as unknown as FixtureGlobal).kiteOfficeInteraction.read(),
  );
  assert.equal(region.selection.scope, 'region');
  assert.equal(region.selection.text, undefined);
  await page.getByRole('button', { name: '请求修改', exact: true }).click();
  await page.screenshot({ path: join(root, 'empty-region.png') });
  checks.push({ name: 'empty-region', selection: region.selection });
  await writeFile(
    join(root, 'result.json'),
    JSON.stringify({ passed: true, checks, modelRequests: 0 }, null, 2),
  );
  console.log(root);
} finally {
  await app.close();
}
