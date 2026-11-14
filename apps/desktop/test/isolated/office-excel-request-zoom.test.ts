import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { renderOfficePreview, runOfficeCLI } from '@kite-ai/agent/documents';
import {
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../../../../tests/fixtures/test-filesystem';

/** Requires a real normal-sandbox desktop; never supplies DISPLAY or disables sandboxing. */
test.skipIf(process.platform !== 'win32' && !process.env.DISPLAY)(
  'Excel request button keeps interface geometry and native hit targets on actual OfficeCLI output',
  async () => {
    const root = temporaryDirectory('kite-office-request-zoom-');
    let passed = false;
    try {
      for (const name of ['profile', 'home', 'temp']) mkdirSync(join(root, name));
      const source = join(root, 'Request-zoom.xlsx'),
        operations = join(root, 'operations.json');
      const ops: unknown[] = [
        { command: 'set', path: '/Sheet1', props: { name: '预算', freeze: 'B2' } },
      ];
      for (let row = 1; row <= 80; row++)
        for (let column = 0; column < 8; column++)
          ops.push({
            command: 'set',
            path: `/预算/${String.fromCharCode(65 + column)}${row}`,
            props: { value: String(row * (column + 1)) },
          });
      writeFileSync(operations, JSON.stringify(ops));
      for (const args of [
        ['create', source],
        ['batch', source, '--input', operations],
        ['validate', source],
      ]) {
        const result = await runOfficeCLI({ args });
        expect(result.code, result.stderr).toBe(0);
      }
      const sourceHash = createHash('sha256').update(readFileSync(source)).digest('hex');
      await renderOfficePreview({
        sourcePath: source,
        outputDirectory: join(root, 'preview'),
        signal: new AbortController().signal,
        run: (args, signal) => runOfficeCLI({ args, signal }),
      });
      const built = await Bun.build({
        entrypoints: [resolve(import.meta.dir, '../office-excel-request-zoom.fixture.ts')],
        target: 'node',
        format: 'cjs',
        external: ['electron'],
        outdir: root,
        naming: 'fixture.cjs',
      });
      if (!built.success) throw new AggregateError(built.logs, 'request_zoom_fixture_build_failed');
      const electron = createRequire(resolve(import.meta.dir, '../../package.json'))(
        'electron',
      ) as string;
      const child = spawn(
        electron,
        [join(root, 'fixture.cjs'), root, join(root, 'preview/index.html')],
        {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            HOME: join(root, 'home'),
            USERPROFILE: join(root, 'home'),
            TEMP: join(root, 'temp'),
            TMP: join(root, 'temp'),
          },
        },
      );
      let diagnostic = '',
        closed = false;
      const completion = new Promise<number | null>((resolve, reject) => {
        const deadline = setTimeout(() => {
          // Retain the owned fixture on uncertainty. No signal or recursive cleanup.
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          reject(Error(`request_zoom_exit_unconfirmed:${root}`));
        }, 120000);
        child.on('error', (error) => {
          diagnostic += String(error);
        });
        child.once('close', (code) => {
          closed = true;
          clearTimeout(deadline);
          resolve(code);
        });
      });
      for (const stream of [child.stdout, child.stderr])
        stream.on('data', (chunk: Buffer) => {
          if (diagnostic.length < 2 * 1024 * 1024) diagnostic += chunk.toString();
        });
      const code = await completion;
      expect(closed).toBe(true);
      expect(code, `${diagnostic}\nRetained fixture: ${root}`).toBe(0);
      const receipt = JSON.parse(readFileSync(join(root, 'receipt.json'), 'utf8'));
      expect(receipt.passed).toBe(true);
      expect(receipt.normalSandbox).toBe(true);
      expect(receipt.viewsDestroyed).toBe(true);
      expect(receipt.samples).toHaveLength(10);
      expect(createHash('sha256').update(readFileSync(source)).digest('hex')).toBe(sourceHash);
      console.log(
        JSON.stringify({
          measurement: 'office-request-zoom-cli-html',
          actualChildClose: code,
          samples: receipt.samples,
        }),
      );
      passed = true;
    } finally {
      if (passed) removeTemporaryDirectory(root);
      else console.error('office_request_zoom_retained', root);
    }
  },
  180000,
);
