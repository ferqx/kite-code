import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import tailwind from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { build } from 'vite';

/** Builds an explicitly isolated fixture only. It never launches Electron or a model. */
export async function buildBrowserChromeFixture(
  directory: string,
  options: { userData?: string } = {},
) {
  if (!isAbsolute(directory)) throw Error('fixture_directory_must_be_absolute');
  const userData = options.userData ?? join(directory, 'profile');
  if (!isAbsolute(userData) || userData.includes('\0'))
    throw Error('fixture_user_data_must_be_absolute');
  const desktop = resolve(import.meta.dir, '..');
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'chrome-fixture-manifest.json'),
    JSON.stringify({ kind: 'kite-browser-chrome-fixture', version: 1, userData }),
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
        entry: join(desktop, 'test/native-browser-chrome-ui.fixture.tsx'),
        formats: ['es'],
        fileName: () => 'chrome-ui.js',
        cssFileName: 'chrome-ui',
      },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  });
  for (const [input, output, format] of [
    ['electron/preload.ts', 'preload.cjs', 'cjs'],
    ['electron/browser-chrome-preload.ts', 'browser-chrome-preload.cjs', 'cjs'],
    ['test/native-browser-chrome-electron.fixture.ts', 'main.cjs', 'cjs'],
    ['test/native-browser-chrome-driver.fixture.ts', 'actor.mjs', 'esm'],
  ] as const) {
    const result = await Bun.build({
      entrypoints: [join(desktop, input)],
      outdir: directory,
      naming: output,
      target: 'node',
      format,
      external: ['electron', 'playwright'],
    });
    if (!result.success) throw new AggregateError(result.logs, 'chrome_fixture_build_failed');
  }
  return {
    directory,
    main: join(directory, 'main.cjs'),
    actor: join(directory, 'actor.mjs'),
    launches: 0,
  };
}

if (import.meta.main) {
  const directory = process.argv[2];
  if (!directory) throw Error('fixture_output_directory_required');
  console.log(JSON.stringify(await buildBrowserChromeFixture(resolve(directory))));
}
