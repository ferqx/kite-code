import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { build } from 'vite';

const output = resolve(process.argv[2] ?? 'dist/acceptance/foreground-guidance/site');
await build({
  root: resolve(import.meta.dir, '..'),
  configFile: false,
  envFile: false,
  plugins: [react(), tailwindcss()],
  define: { __KITE_DESKTOP_TEST_DIAGNOSTICS__: 'false', 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warn',
  build: {
    outDir: output,
    emptyOutDir: false,
    lib: {
      entry: resolve(import.meta.dir, 'foreground-guidance-browser.fixture.tsx'),
      formats: ['es'],
      fileName: 'fixture',
      cssFileName: 'fixture',
    },
    target: 'esnext',
  },
});
await Bun.write(
  resolve(output, 'index.html'),
  '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"></head><body style="margin:0"><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
);
