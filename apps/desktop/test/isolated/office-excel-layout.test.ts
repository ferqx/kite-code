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
for (const mode of ['grid', 'popups', 'tabs'])
  test.skipIf(process.platform !== 'win32')(
    mode === 'tabs'
      ? 'Excel sheet tabs retain interface size, native hit targets and exact scope under document zoom'
      : mode === 'popups'
        ? 'Office fixed popup coordinates preserve visible trusted scope menus, capsules and status under root zoom'
        : 'Excel document painting and host selection metadata preserve real Chromium geometry, borders and trusted selection',
    async () => {
      const root = temporaryDirectory('kite-office-excel-layout-');
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
          entrypoints: [resolve(import.meta.dir, '../office-excel-layout.fixture.ts')],
          target: 'node',
          format: 'cjs',
          external: ['electron'],
          outdir: root,
          naming: 'fixture.cjs',
        });
        if (!built.success) throw new AggregateError(built.logs, 'excel_layout_build_failed');
        const electron = createRequire(resolve(import.meta.dir, '../../package.json'))(
          'electron',
        ) as string;
        const child = spawn(
          electron,
          [
            join(root, 'fixture.cjs'),
            root,
            '--force-device-scale-factor=1.5',
            ...(mode === 'grid' ? [] : [`--${mode}`]),
          ],
          {
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
          },
        );
        let failure: unknown,
          closed = false,
          unknown = false;
        let stop!: (error: unknown) => void;
        const completion = new Promise<number | null>((resolve, reject) => {
          let grace: ReturnType<typeof setTimeout> | undefined;
          const timeout = setTimeout(() => stop(Error('excel_layout_timeout')), 240000);
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
              reject(Error(`excel_layout_close_unconfirmed:${root}`));
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
              if (bytes > 2 * 1024 * 1024) stop(Error('excel_layout_diagnostic_limit'));
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
        if (unknown || !closed) throw Error(`excel_layout_close_unconfirmed:${root}`);
        if (failure) throw failure;
        expect(code, `${stdout}\n${stderr}\nRetained fixture: ${root}`).toBe(0);
        const receipt = JSON.parse(readFileSync(join(root, 'receipt.json'), 'utf8'));
        expect(receipt.passed).toBe(true);
        expect(receipt.viewsDestroyed).toBe(true);
        expect(receipt.normalSandbox).toBe(true);
        expect(receipt.windowWasHidden).toBe(true);
        if (mode === 'tabs') expect(receipt.tabSamples).toHaveLength(8);
        else if (mode === 'popups') expect(receipt.popupSamples).toHaveLength(24);
        else {
          expect(receipt.samples).toHaveLength(64);
          expect(receipt.frozenSamples).toHaveLength(2);
          expect(receipt.perimeterSamples).toHaveLength(12);
          expect(receipt.rowLineSamples).toHaveLength(15);
          expect(
            receipt.rowLineSamples.flatMap((sample: { rows: { alignmentQualified: boolean }[] }) =>
              sample.rows.filter((row) => !row.alignmentQualified),
            ),
          ).toHaveLength(1);
          expect(receipt.rangeSamples).toHaveLength(24);
          expect(receipt.migrationSamples).toHaveLength(6);
        }
        console.log(
          JSON.stringify({
            measurement: `office-${mode}-hidden-chromium`,
            tabs: receipt.tabSamples,
            popups: receipt.popupSamples,
            grid: receipt.samples.length,
            range: receipt.rangeSamples.length,
            migration: receipt.migrationSamples.length,
            frozen: receipt.frozenSamples,
            perimeter: receipt.perimeterSamples,
            rowLines: receipt.rowLineSamples,
            captures: receipt.captureAttempts.length,
            rejectedPaint: receipt.captureAttempts.filter(
              (entry: { current?: boolean; accepted?: boolean; attempt: number }) =>
                entry.attempt > 0,
            ).length,
            actualChildClose: code,
            viewsDestroyed: receipt.viewsDestroyed,
          }),
        );
        passed = true;
      } finally {
        // Only an owned, canonical tree after actual child close and successful view teardown.
        // Any startup/error/timeout/unknown retains the fixture, never recursively removes it.
        if (passed) removeTemporaryDirectory(root);
        else console.error('office_excel_layout_retained', root);
      }
    },
    260000,
  );
