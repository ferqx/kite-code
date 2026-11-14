import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import {
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../../../../tests/fixtures/test-filesystem';

/** Real Windows Chromium, without CUA, no-sandbox, user profile or document conversion. */
test.skipIf(process.platform !== 'win32')(
  'readonly host stays outside the real preview and preserves narrow selection binding',
  async () => {
    const root = temporaryDirectory('kite-office-readonly-host-');
    let passed = false;
    try {
      for (const name of [
        'profile',
        'crash',
        'downloads',
        'home',
        'appdata',
        'localappdata',
        'temp',
      ])
        mkdirSync(join(root, name));
      const built = await Bun.build({
        entrypoints: [resolve(import.meta.dir, '../office-readonly-host.fixture.ts')],
        target: 'node',
        format: 'cjs',
        external: ['electron'],
        outdir: root,
        naming: 'fixture.cjs',
      });
      if (!built.success) throw new AggregateError(built.logs, 'readonly_host_build_failed');
      for (const [entry, name, target] of [
        ['office-readonly-host-renderer.fixture.tsx', 'renderer.[ext]', 'browser'],
        ['office-readonly-host-preload.fixture.ts', 'preload.cjs', 'node'],
      ] as const) {
        const result = await Bun.build({
          entrypoints: [resolve(import.meta.dir, `../${entry}`)],
          target,
          format: target === 'browser' ? 'esm' : 'cjs',
          external: target === 'node' ? ['electron'] : [],
          outdir: root,
          naming: name,
        });
        if (!result.success) throw new AggregateError(result.logs, 'readonly_host_build_failed');
      }
      await Bun.write(
        join(root, 'host.html'),
        '<!doctype html><html data-platform="windows" data-theme="light"><meta charset="utf-8"><link rel="stylesheet" href="renderer.css"><style>body{margin:0}#root{height:100vh}</style><div id="root"></div><script type="module" src="renderer.js"></script>',
      );
      const electron = createRequire(resolve(import.meta.dir, '../../package.json'))(
        'electron',
      ) as string;
      const child = spawn(electron, [join(root, 'fixture.cjs'), root], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          SystemRoot: process.env.SystemRoot,
          WINDIR: process.env.WINDIR,
          PATH: '',
          TEMP: join(root, 'temp'),
          TMP: join(root, 'temp'),
          HOME: join(root, 'home'),
          USERPROFILE: join(root, 'home'),
          APPDATA: join(root, 'appdata'),
          LOCALAPPDATA: join(root, 'localappdata'),
        },
      });
      let failure: unknown,
        closed = false,
        unknown = false;
      let stop!: (error: unknown) => void;
      const completion = new Promise<number | null>((resolve, reject) => {
        let grace: ReturnType<typeof setTimeout> | undefined;
        const timeout = setTimeout(() => stop(Error('readonly_host_timeout')), 45000);
        const finish = () => {
          clearTimeout(timeout);
          if (grace) clearTimeout(grace);
        };
        stop = (error) => {
          failure ??= error;
          if (closed || grace) return;
          grace = setTimeout(() => {
            unknown = true;
            finish();
            child.stdout.destroy();
            child.stderr.destroy();
            child.unref();
            reject(Error(`readonly_host_close_unconfirmed:${root}`));
          }, 5000);
          try {
            child.kill('SIGKILL');
          } catch {
            /* Only actual close proves completion. */
          }
        };
        child.on('error', stop);
        child.once('close', (code) => {
          closed = true;
          finish();
          resolve(code);
        });
      });
      const collect = async (stream: AsyncIterable<Uint8Array>) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        try {
          for await (const chunk of stream) {
            bytes += chunk.length;
            if (bytes > 2 * 1024 * 1024) stop(Error('readonly_host_diagnostic_limit'));
            else chunks.push(Buffer.from(chunk));
          }
        } catch (error) {
          stop(error);
        }
        return Buffer.concat(chunks).toString('utf8');
      };
      const output = Promise.all([collect(child.stdout), collect(child.stderr)]);
      void output.catch(() => {});
      const code = await completion;
      const [stdout, stderr] = await output;
      if (unknown || !closed) throw Error(`readonly_host_close_unconfirmed:${root}`);
      if (failure) throw failure;
      expect(code, `${stdout}\n${stderr}\nRetained fixture: ${root}`).toBe(0);
      const receipt = JSON.parse(readFileSync(join(root, 'receipt.json'), 'utf8'));
      expect(receipt.passed).toBe(true);
      expect(receipt.viewsDestroyed).toBe(true);
      expect(receipt.normalSandbox).toBe(true);
      expect(receipt.windowWasHidden).toBe(true);
      expect(receipt.checks).toHaveLength(6);
      passed = true;
    } finally {
      // Only an owned, canonical tree after actual child close and successful view teardown.
      // Any startup/error/timeout/unknown retains the fixture, never recursively removes it.
      if (passed) removeTemporaryDirectory(root);
      else console.error('office_readonly_host_retained', root);
    }
  },
  65000,
);
