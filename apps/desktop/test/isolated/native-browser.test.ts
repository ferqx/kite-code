import { expect, test } from 'bun:test';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import tailwind from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { build } from 'vite';
import { ensureWindowsElectronPermissions } from '../../../../scripts/development/windows-electron-permissions';
import { temporaryDirectory } from '../../../../tests/fixtures/test-filesystem';

test('real sandboxed browser tabs preserve history and reader lifetime without exposing app authority', async () => {
  const directory = realpathSync(temporaryDirectory('kite-sidebar-browser-'));
  const desktop = resolve(import.meta.dir, '../..');
  const require = createRequire(join(desktop, 'package.json'));
  ensureWindowsElectronPermissions({
    executable: require('electron'),
    packageDirectory: resolve(require.resolve('electron/package.json'), '..'),
  });
  await build({
    configFile: false,
    root: desktop,
    logLevel: 'error',
    plugins: [react(), tailwind()],
    esbuild: { jsxDev: false },
    define: { __KITE_DESKTOP_TEST_DIAGNOSTICS__: 'false', 'process.env.NODE_ENV': '"production"' },
    build: {
      outDir: directory,
      emptyOutDir: false,
      target: 'esnext',
      lib: {
        entry: join(desktop, 'test/native-browser-ui.fixture.tsx'),
        formats: ['es'],
        fileName: () => 'browser-ui.js',
        cssFileName: 'browser-ui',
      },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  });
  for (const [input, output, format] of [
    ['electron/preload.ts', 'preload.cjs', 'cjs'],
    ['test/native-browser-electron.fixture.ts', 'main.cjs', 'cjs'],
    ['test/native-browser-driver.fixture.ts', 'driver.mjs', 'esm'],
  ] as const) {
    const built = await Bun.build({
      entrypoints: [join(desktop, input)],
      outdir: directory,
      naming: output,
      target: 'node',
      format,
      external: ['electron', 'playwright'],
    });
    if (!built.success) throw new AggregateError(built.logs, 'browser_fixture_build_failed');
  }
  const child = Bun.spawn(
    [
      realpathSync(Bun.which('node')!),
      join(directory, 'driver.mjs'),
      join(desktop, 'package.json'),
      directory,
    ],
    { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' },
  );
  const timer = setTimeout(() => child.kill(), 75000);
  try {
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0) throw Error(`browser_fixture_failed:${code}\n${out}\n${err}`);
    console.log(out.trim());
    expect(out).toContain('browser_electron_pass');
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}, 90000);
