import { realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import tailwind from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { build } from 'vite';
import { expect, test } from '#kite-test';
import { ensureWindowsElectronPermissions } from '../../../../scripts/development/windows-electron-permissions';
import { build as buildFixture } from '../../../../scripts/tooling/build';
import {
  which as findFixtureExecutable,
  spawn as spawnFixtureProcess,
} from '../../../../scripts/tooling/process';
import { temporaryDirectory } from '../../../../tests/fixtures/test-filesystem';
import { prepareMacosElectronRuntime } from '../../scripts/macos-electron-runtime';

test('real sandboxed manual browser owners preserve exact pages across scope changes without exposing app authority', async () => {
  const directory = realpathSync(temporaryDirectory('kite-sidebar-browser-'));
  const desktop = resolve(import.meta.dirname, '../..');
  const require = createRequire(join(desktop, 'package.json'));
  const installed = realpathSync(require('electron') as string);
  ensureWindowsElectronPermissions({
    executable: installed,
    packageDirectory: resolve(require.resolve('electron/package.json'), '..'),
  });
  const runtime =
    process.platform === 'darwin' && process.arch === 'arm64'
      ? await prepareMacosElectronRuntime({
          sourceDist: join(dirname(realpathSync(require.resolve('electron/package.json'))), 'dist'),
          outdir: join(directory, 'electron-runtime'),
        })
      : { executable: installed, resize: null };
  const mainEntry = join(directory, 'browser-main.ts');
  writeFileSync(
    mainEntry,
    [
      "import { app } from 'electron';",
      `import { configureMacosElectronResize } from ${JSON.stringify(join(desktop, 'electron/macos-electron-resize.ts'))};`,
      `configureMacosElectronResize(app, ${JSON.stringify(runtime.resize)});`,
      // A runtime require keeps the original fixture's app.whenReady after the
      // same engine admission and feature selection used by production Main.
      `require(${JSON.stringify(join(desktop, 'test/native-browser-electron.fixture.ts'))});`,
    ].join('\n'),
    { flag: 'wx' },
  );
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
    [join(desktop, 'electron/preload.ts'), 'preload.cjs', 'cjs'],
    [mainEntry, 'main.cjs', 'cjs'],
    [join(desktop, 'test/native-browser-driver.fixture.ts'), 'driver.mjs', 'esm'],
  ] as const) {
    const built = await buildFixture({
      entrypoints: [input],
      outdir: directory,
      naming: output,
      target: 'node',
      format,
      external: ['electron', 'playwright'],
    });
    if (!built.success) throw new AggregateError(built.logs, 'browser_fixture_build_failed');
  }
  const child = spawnFixtureProcess(
    [
      realpathSync(findFixtureExecutable('node')!),
      join(directory, 'driver.mjs'),
      join(desktop, 'package.json'),
      directory,
      runtime.executable,
      runtime.resize ? 'macos-resize' : 'stock',
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
