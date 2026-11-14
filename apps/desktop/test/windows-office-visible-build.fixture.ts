/** Explicit opt-in build, never a production debug entry point. */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dir, '../../..');
const output = process.argv.find((arg) => arg.startsWith('--out='))?.slice(6);
const out = output ? resolve(output) : resolve(repo, '../visible-inline-1/app');
await mkdir(out, { recursive: true });
for (const [entry, target] of [
  ['windows-office-visible.fixture.ts', 'node', 'main.cjs'],
  ['windows-office-visible-renderer.fixture.tsx', 'browser', 'renderer.js'],
] as const) {
  const r = await Bun.build({
    entrypoints: [join(import.meta.dir, entry)],
    target,
    format: target === 'node' ? 'cjs' : 'esm',
    external: target === 'node' ? ['electron'] : [],
    outdir: out,
    naming: target === 'node' ? 'main.cjs' : 'renderer.[ext]',
    define: { 'process.env.NODE_ENV': '"production"', __KITE_DESKTOP_TEST_DIAGNOSTICS__: 'false' },
  });
  if (!r.success) throw new AggregateError(r.logs, 'fixture_build');
}
await writeFile(
  join(out, 'preload.cjs'),
  `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('fixture',{request:q=>ipcRenderer.invoke('fixture',q)});`,
);
await writeFile(
  join(out, 'package.json'),
  JSON.stringify({
    name: 'kite-windows-office-component-fixture',
    main: 'main.cjs',
    version: '0.0.0',
  }),
);
await writeFile(
  join(out, 'index.html'),
  `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:"><link rel="stylesheet" href="renderer.css"><style>:root{--page-background:#fafafa;--foreground:#202020;--sidebar:#eee;--muted-foreground:#626262;--control-hover:#ddd;--card:white;--border:#ddd;--input:#ccc}*{box-sizing:border-box}body{margin:0;font:14px 'Segoe UI',sans-serif}#root{height:100vh}</style></head><body><div id="root"></div><script type="module" src="renderer.js"></script></body></html>`,
);
console.log(out);
