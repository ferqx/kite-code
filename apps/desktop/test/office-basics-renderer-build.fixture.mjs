import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { build as buildRenderer } from 'vite';
import { desktopMarkdownDecoderAlias } from '../scripts/markdown-worker-resolution.ts';

const root = resolve(import.meta.dirname, '..');
const directory = process.env.KITE_OFFICE_PRODUCT_FIXTURE_DIRECTORY;
if (!directory?.startsWith('/workspace/shared/'))
  throw Error('explicit_owned_fixture_directory_required');
const outdir = join(directory, 'app');
const testDiagnostics = true;
await buildRenderer({
  root,
  configFile: false,
  plugins: [react(), tailwindcss()],
  resolve: { alias: [desktopMarkdownDecoderAlias()] },
  base: './',
  clearScreen: false,
  logLevel: 'warn',
  // Formal renderer bytes must not inherit the invoking process's test/dev
  // environment. Development keeps its separate Vite server.
  esbuild: { jsxDev: false },
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    __KITE_DESKTOP_TEST_DIAGNOSTICS__: JSON.stringify(testDiagnostics),
  },
  build: {
    target: 'es2022',
    outDir: outdir,
    emptyOutDir: false,
    rollupOptions: {
      input: {
        main: join(root, 'index.html'),
        'global-dialog': join(root, 'global-dialog.html'),
        trajectory: join(root, 'trajectory.html'),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'global-dialog'
            ? 'global-dialog-renderer.js'
            : chunk.name === 'trajectory'
              ? 'trajectory-renderer.js'
              : 'renderer.js',
      },
    },
  },
});
await writeFile(
  join(outdir, 'package.json'),
  JSON.stringify({ name: 'kite-native', version: '0.1.0', main: 'main.cjs' }),
);
