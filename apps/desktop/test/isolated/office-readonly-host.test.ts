import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { build } from 'vite';
import {
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../../../../tests/fixtures/test-filesystem';
import { buildOfficePreviews } from '../../scripts/build-office-previews';

async function wordWithFootnote() {
  const zip = new JSZip();
  const w = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const relationships = 'http://schemas.openxmlformats.org/package/2006/relationships';
  zip.file(
    '_rels/.rels',
    `<Relationships xmlns="${relationships}"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  zip.file(
    'word/_rels/document.xml.rels',
    `<Relationships xmlns="${relationships}"><Relationship Id="rId1" Type="${rel}/footnotes" Target="footnotes.xml"/></Relationships>`,
  );
  zip.file(
    '[Content_Types].xml',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/></Types>',
  );
  zip.file(
    'word/document.xml',
    `<w:document xmlns:w="${w}"><w:body><w:p><w:r><w:t>AB</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r><w:r><w:t>CD</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>`,
  );
  zip.file(
    'word/footnotes.xml',
    `<w:footnotes xmlns:w="${w}"><w:footnote w:id="1"><w:p><w:r><w:t>Footnote content</w:t></w:r></w:p></w:footnote></w:footnotes>`,
  );
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

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
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('S');
      for (let index = 1; index <= 12; index++)
        workbook.addWorksheet(`Supplemental sheet ${index}`);
      for (let row = 1; row <= 48; row++)
        for (let col = 1; col <= 8; col++) {
          const cell = sheet.getCell(row, col);
          cell.value = cell.address;
        }
      sheet.getCell('D4').value = { formula: 'SUM(B2:C3)', result: 0 };
      sheet.getCell('B2').fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFFFFFAA' },
      };
      writeFileSync(join(root, 'fixture.xlsx'), Buffer.from(await workbook.xlsx.writeBuffer()));
      writeFileSync(join(root, 'fixture.docx'), await wordWithFootnote());
      await buildOfficePreviews(root);
      // Require one real Chromium frame before the renderer can report readiness.
      for (const format of ['docx', 'xlsx'])
        appendFileSync(
          join(root, `${format}-preview.js`),
          '\n;globalThis.kiteOfficePreviewReady = globalThis.kiteOfficePreviewReady.then(' +
            '(ready) => new Promise(resolve => requestAnimationFrame(() => resolve(ready))));\n',
        );
      const built = await Bun.build({
        entrypoints: [resolve(import.meta.dir, '../office-readonly-host.fixture.ts')],
        target: 'node',
        format: 'cjs',
        external: ['electron'],
        outdir: root,
        naming: 'fixture.cjs',
      });
      if (!built.success) throw new AggregateError(built.logs, 'readonly_host_build_failed');
      const desktop = resolve(import.meta.dir, '../..');
      const preload = await Bun.build({
        entrypoints: [resolve(desktop, 'test/office-readonly-host-preload.fixture.ts')],
        target: 'node',
        format: 'cjs',
        external: ['electron'],
        outdir: root,
        naming: 'preload.cjs',
      });
      if (!preload.success) throw new AggregateError(preload.logs, 'readonly_host_build_failed');
      await build({
        root: desktop,
        configFile: false,
        envFile: false,
        logLevel: 'error',
        base: './',
        plugins: [react(), tailwindcss()],
        esbuild: { jsxDev: false },
        define: { 'process.env.NODE_ENV': '"production"' },
        build: {
          target: 'es2022',
          outDir: root,
          emptyOutDir: false,
          lib: {
            entry: resolve(desktop, 'test/office-readonly-host-renderer.fixture.tsx'),
            formats: ['es'],
            fileName: () => 'renderer.js',
            cssFileName: 'renderer',
          },
        },
      });
      await Bun.write(
        join(root, 'host.html'),
        '<!doctype html><html data-platform="windows" data-theme="light"><meta charset="utf-8"><link rel="stylesheet" href="renderer.css"><style>body{margin:0}#root{height:100vh}</style><div id="root"></div><script type="module" src="renderer.js"></script>',
      );
      const electron = createRequire(resolve(import.meta.dir, '../../package.json'))(
        'electron',
      ) as string;
      const child = spawn(electron, [join(root, 'fixture.cjs'), root], {
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
      expect(receipt.previewWasVisible).toBe(true);
      expect(receipt.checks).toHaveLength(21);
      expect(receipt.checks).toContain('excel-scoped-zoom-input-and-ordinary-scroll');
      expect(receipt.checks).toContain('excel-narrow-fit-grid-stays-readable-and-stable');
      expect(receipt.checks).toContain('pdf-scoped-zoom-input-and-ordinary-scroll');
      expect(receipt.checks).toContain('pdf-chromium-touchpad-pinch');
      expect(receipt.checks).toContain('word-scoped-zoom-input-and-ordinary-scroll');
      expect(receipt.checks).toContain('excel-scrollbar-theme');
      expect(receipt.checks).toContain('word-scrollbar-theme');
      expect(receipt.checks).toContain('pdf-scrollbar-theme');
      expect(receipt.checks).toContain('zoom-menu-over-iframe-without-moving-preview');
      expect(receipt.checks).toContain('pdf-wide-rail-and-compact-breakpoint');
      expect(receipt.checks).toContain('pdf-rail-fits-and-scrolls-vertically');
      expect(receipt.checks).toContain('pdf-iframe-page-resource-and-exact-request');
      expect(receipt.checks).toContain('interrupted-iframe-releases-input-and-retries');
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
