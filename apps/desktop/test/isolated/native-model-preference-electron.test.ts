import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join, resolve, sep } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { build } from 'vite';
import { privateDirectory } from '../../../../tests/fixtures/test-filesystem';

test('actual sandboxed Electron restores model and effort after process exit on a new renderer origin', async () => {
  const root = resolve('.cache', `model-preference-${randomUUID()}`);
  privateDirectory(root);
  const output = join(root, 'renderer');
  await build({
    root: resolve(import.meta.dir, '../..'),
    configFile: false,
    envFile: false,
    plugins: [react(), tailwindcss()],
    esbuild: { jsxDev: false },
    base: './',
    logLevel: 'error',
    define: { __KITE_DESKTOP_TEST_DIAGNOSTICS__: 'false', 'process.env.NODE_ENV': '"production"' },
    build: {
      outDir: output,
      emptyOutDir: false,
      target: 'esnext',
      lib: {
        entry: resolve(import.meta.dir, '../native-model-preference-page.fixture.tsx'),
        formats: ['es'],
        fileName: 'fixture',
        cssFileName: 'fixture',
      },
    },
  });
  for (const [source, name] of [
    ['../native-model-preference-electron.fixture.ts', 'main.cjs'],
    ['../../electron/preload.ts', 'preload.cjs'],
  ]) {
    const built = await Bun.build({
      entrypoints: [resolve(import.meta.dir, source!)],
      target: 'node',
      format: 'cjs',
      external: ['electron'],
    });
    expect(built.success).toBe(true);
    await Bun.write(join(root, name!), built.outputs[0]!);
  }
  const serve = () =>
    Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const pathname = new URL(request.url).pathname;
        if (pathname === '/')
          return new Response(
            `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`,
            { headers: { 'content-type': 'text/html' } },
          );
        if (pathname === '/favicon.ico') return new Response(null, { status: 204 });
        const file = resolve(output, `.${pathname}`);
        return file.startsWith(output + sep)
          ? new Response(Bun.file(file))
          : new Response(null, { status: 404 });
      },
    });
  const firstServer = serve();
  const secondServer = serve();
  try {
    const driver = await Bun.build({
      entrypoints: [resolve(import.meta.dir, '../native-model-preference-driver.fixture.ts')],
      target: 'node',
      format: 'esm',
      packages: 'bundle',
      external: ['playwright'],
    });
    expect(driver.success).toBe(true);
    await Bun.write(join(root, 'driver.mjs'), driver.outputs[0]!);
    const require = createRequire(import.meta.url);
    const child = Bun.spawn(
      [
        Bun.which('node')!,
        join(root, 'driver.mjs'),
        root,
        firstServer.url.href,
        secondServer.url.href,
        require('electron') as string,
        resolve(import.meta.dir, '../../package.json'),
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    console.log(stdout);
    if (code !== 0) throw Error(stderr || 'model_preference_driver_failed');
    expect(code).toBe(0);
  } finally {
    firstServer.stop(true);
    secondServer.stop(true);
  }
}, 120000);
