import { mkdirSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { build } from 'vite';

// Explicit standalone fixture; never imported by development or production frontdoors.
const repository = resolve(import.meta.dir, '../../..');
const cache = join(repository, '.cache');
mkdirSync(cache, { recursive: true });
const root = mkdtempSync(join(cache, 'attachment-browser-'));
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
      entry: join(import.meta.dir, 'input-attachments-browser.fixture.tsx'),
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
  `const {app,BrowserWindow}=require('electron');
app.whenReady().then(()=>{
  const window=new BrowserWindow({width:1040,height:850,webPreferences:{preload:${JSON.stringify(join(root, 'preload.cjs'))},sandbox:true,contextIsolation:true,nodeIntegration:false}});
  window.setMenuBarVisibility(false);
  window.loadFile(${JSON.stringify(join(root, 'dist/index.html'))});
});
app.on('window-all-closed',()=>app.quit());`,
);
const require = createRequire(import.meta.url);
const env = { ...process.env };
for (const name of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'BUN_OPTIONS'])
  delete env[name];
const child = Bun.spawn(
  [require('electron'), join(root, 'main.cjs'), `--user-data-dir=${join(root, 'electron-data')}`],
  { env, cwd: repository, stdout: 'inherit', stderr: 'inherit' },
);
console.log(JSON.stringify({ fixture: 'attachment-browser', root, pid: child.pid }));
process.exitCode = await child.exited;
