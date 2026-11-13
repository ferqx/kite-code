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
  'hostile Office preview cannot submit, escape resources or survive target replacement',
  async () => {
    const root = temporaryDirectory('kite-office-preview-security-');
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
        entrypoints: [resolve(import.meta.dir, '../office-preview-security.fixture.ts')],
        target: 'node',
        format: 'cjs',
        external: ['electron'],
        outdir: root,
        naming: 'fixture.cjs',
      });
      if (!built.success) throw new AggregateError(built.logs, 'preview_security_build_failed');
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
        const timeout = setTimeout(() => stop(Error('preview_security_timeout')), 45000);
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
            reject(Error(`preview_security_close_unconfirmed:${root}`));
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
            if (bytes > 2 * 1024 * 1024) stop(Error('preview_security_diagnostic_limit'));
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
      if (unknown || !closed) throw Error(`preview_security_close_unconfirmed:${root}`);
      if (failure) throw failure;
      expect(code, `${stdout}\n${stderr}\nRetained fixture: ${root}`).toBe(0);
      const receipt = JSON.parse(readFileSync(join(root, 'receipt.json'), 'utf8'));
      expect(receipt.passed).toBe(true);
      expect(receipt.viewsDestroyed).toBe(true);
      expect(receipt.normalSandbox).toBe(true);
      expect(receipt.windowWasHidden).toBe(true);
      expect(receipt.checks).toHaveLength(5);
      passed = true;
    } finally {
      // Only an owned, canonical tree after actual child close and successful view teardown.
      // Any startup/error/timeout/unknown retains the fixture, never recursively removes it.
      if (passed) removeTemporaryDirectory(root);
      else console.error('office_preview_security_retained', root);
    }
  },
  65000,
);
