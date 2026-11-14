import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { _electron } from 'playwright';
import { build } from 'vite';

// Explicit standalone fixture; never imported by development or production frontdoors.
const repository = resolve(import.meta.dir, '../../..');
const cache = join(repository, '.cache');
mkdirSync(cache, { recursive: true });
const root = mkdtempSync(join(cache, 'local-file-electron-'));
const preload = await Bun.build({
  entrypoints: [resolve(import.meta.dir, '../electron/preload.ts')],
  outdir: root,
  target: 'node',
  format: 'cjs',
  external: ['electron'],
  naming: 'preload.cjs',
});
if (!preload.success) throw new AggregateError(preload.logs, 'fixture_preload_build_failed');
await build({
  root: resolve(import.meta.dir, '..'),
  configFile: false,
  envFile: false,
  plugins: [react(), tailwindcss()],
  base: './',
  define: {
    __KITE_DESKTOP_TEST_DIAGNOSTICS__: 'false',
    'process.env.NODE_ENV': '"production"',
  },
  logLevel: 'warn',
  build: {
    outDir: join(root, 'dist'),
    emptyOutDir: false,
    lib: {
      entry: join(import.meta.dir, 'local-file-references-electron.fixture.tsx'),
      formats: ['es'],
      fileName: 'fixture',
      cssFileName: 'fixture',
    },
  },
});
await Bun.write(
  join(root, 'dist/index.html'),
  '<html><head><title>Attachment regression fixture</title><link rel="stylesheet" href="./fixture.css"></head><body style="margin:0"><div id="root"></div><script type="module" src="./fixture.js"></script></body></html>',
);
await Bun.write(
  join(root, 'main.cjs'),
  `const {app,BrowserWindow,ipcMain}=require('electron');
const calls=[]; global.calls=calls;
ipcMain.on('kite:native:browser-display',(event)=>event.returnValue=null);
ipcMain.handle('kite:native:request',(_event,request)=>{calls.push(request.method);return {ok:true,value:null};});
app.whenReady().then(()=>{
  const window=new BrowserWindow({width:1040,height:850,webPreferences:{preload:${JSON.stringify(join(root, 'preload.cjs'))},sandbox:true,contextIsolation:true,nodeIntegration:false}});
  window.setMenuBarVisibility(false);
  window.loadFile(${JSON.stringify(join(root, 'dist/index.html'))});
});
app.on('window-all-closed',()=>app.quit());`,
);
const require = createRequire(import.meta.url);
const env: Record<string, string> = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);
for (const name of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'BUN_OPTIONS'])
  delete env[name];
const app = await _electron.launch({
  executablePath: require('electron'),
  args: [join(root, 'main.cjs'), `--user-data-dir=${join(root, 'electron-data')}`],
  env,
  cwd: repository,
});
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (e) => console.error('renderer', String(e)));
  await page.locator('#result').waitFor();
  const state = async () => JSON.parse(await page.locator('#result').innerText());
  const waitFiles = async (n: number) => {
    await page.waitForFunction(
      (n) => JSON.parse(document.querySelector('#result')!.textContent!).files.length === n,
      n,
      { timeout: 10000 },
    );
    return state();
  };
  const pick = async (paths: string | string[]) => {
    const chooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '添加附件', exact: true }).click();
    const item = page.getByRole('menuitem', { name: '添加文件', exact: true });
    if (await item.count()) await item.click();
    await (await chooserPromise).setFiles(paths);
  };
  const a = join(root, 'a'),
    b = join(root, 'b');
  mkdirSync(a);
  mkdirSync(b);
  const one = join(a, 'same.docx'),
    two = join(b, 'same.docx'),
    pdf = join(a, 'sample.pdf');
  writeFileSync(one, 'first');
  writeFileSync(two, 'second');
  writeFileSync(pdf, '%PDF-1.4\n%fixture');
  await pick([one, two, pdf]);
  console.log('selected state', await state());
  let value = await waitFiles(3);
  assert(value.files.every((f: { prepared?: boolean }) => !f.prepared));
  assert.equal(new Set(value.files.map((f: { uri: string }) => f.uri)).size, 3);
  assert.equal(value.intent.files.length, 3);
  assert.deepEqual(
    await app.evaluate(() => (globalThis as unknown as { calls: string[] }).calls),
    [],
  );
  await page.screenshot({ path: join(root, 'selected.png') });
  writeFileSync(one, 'changed after selection');
  await pick(one);
  assert.equal((await state()).files.length, 3);
  await page.getByText('Reconnect', { exact: true }).click();
  await waitFiles(0);
  const cdp = await page.context().newCDPSession(page);
  const target = await page.locator('textarea.prompt-editor').boundingBox();
  if (!target) throw Error('composer_not_found');
  for (const type of ['dragEnter', 'dragOver', 'drop'] as const)
    await cdp.send('Input.dispatchDragEvent', {
      type,
      x: target.x + Math.min(25, target.width / 2),
      y: target.y + target.height / 2,
      data: { items: [], files: [one], dragOperationsMask: 1 },
    });
  value = await waitFiles(1);
  assert.equal(value.files[0].uri, new URL(`file://${one}`).href);
  assert(!value.files[0].prepared);
  await page.screenshot({ path: join(root, 'dropped.png') });
  await page.getByText('Synthetic', { exact: true }).click();
  value = await waitFiles(2);
  assert(value.files.find((f: { name: string }) => f.name === 'synthetic.pdf').prepared);
  assert.equal(value.intent.files.length, 1);
  const methods = await app.evaluate(() => (globalThis as unknown as { calls: string[] }).calls);
  assert(methods.includes('input.files.begin'));
  assert(methods.includes('input.files.finish'));
  await page.getByText('Reconnect', { exact: true }).click();
  await waitFiles(0);
  await page.getByText('Toggle local', { exact: true }).click();
  await pick(pdf);
  value = await waitFiles(1);
  assert(value.files[0].prepared);
  assert(!value.intent.files);
  await page.screenshot({ path: join(root, 'fallback.png') });
  await Bun.write(
    join(root, 'report.json'),
    JSON.stringify(
      {
        passed: true,
        root,
        coverage: [
          'real Electron preload disk File paths',
          'Composer file input and CDP OS-file drag event',
          'same names different directories',
          'local PDF reference',
          'no byte IPC for local files',
          'synthetic and nonlocal fallback byte IPC',
          'generation clears drafts',
        ],
        limitations: [
          'Main IPC acknowledges fallback in this isolated UI fixture; Service import covered separately',
          'No provider calls, real permissions or full product launch',
        ],
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: true, root }));
} catch (error) {
  const page = await app.firstWindow();
  console.error(await page.locator('body').innerText());
  await page.screenshot({ path: join(root, 'failed.png') });
  throw error;
} finally {
  await app.close();
}
