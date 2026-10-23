import { expect, test } from 'bun:test';
import { cpSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { simplePdf } from '../../../../../tests/fixtures/pdf';
import { temporaryDirectory } from '../../../../../tests/fixtures/test-filesystem';
import { pdfAssets } from '../../../src/tools/documents/pdf';

test('PDF worker and pinned native dependency closure read outside the source tree offline', async () => {
  const root = temporaryDirectory('kite-pdf-package-');
  try {
    const entry = join(root, 'reader.ts');
    writeFileSync(
      entry,
      `import assert from 'node:assert/strict';
import {readFileSync,unlinkSync,writeFileSync} from 'node:fs';
import {readPdf,pdfAssets} from ${JSON.stringify(resolve(import.meta.dir, '../../../src/tools/documents/pdf.ts').replaceAll('\\', '/'))};
const bytes = new Uint8Array(await Bun.file(new URL('./input.pdf', import.meta.url)).arrayBuffer());
const text = await readPdf(bytes, {}, new AbortController().signal);
const image = await readPdf(bytes, {mode:'image'}, new AbortController().signal);
const assets = pdfAssets();
const recovered = [];
for (const path of [assets.worker, assets.checksum]) {
  const original = readFileSync(path);
  unlinkSync(path);
  try {
    await assert.rejects(readPdf(bytes, {}, new AbortController().signal), {code:'ENOENT'});
  } finally {
    writeFileSync(path, original);
  }
  recovered.push((await readPdf(bytes, {}, new AbortController().signal)).pages[0].text);
}
const checksum = readFileSync(assets.checksum);
writeFileSync(assets.checksum, '0'.repeat(64));
try {
  await assert.rejects(readPdf(bytes, {}, new AbortController().signal), {code:'pdf_assets_invalid'});
} finally {
  writeFileSync(assets.checksum, checksum);
}
recovered.push((await readPdf(bytes, {}, new AbortController().signal)).pages[0].text);
console.log(JSON.stringify({text, recovered, signature:Buffer.from(image.pages[0].image).subarray(0,8).toString('hex')}));`,
    );
    const built = await Bun.build({
      entrypoints: [entry],
      outdir: root,
      target: 'bun',
      packages: 'bundle',
      naming: 'reader.js',
    });
    expect(built.success).toBe(true);
    const assets = pdfAssets();
    mkdirSync(join(root, 'tools/documents'), { recursive: true });
    cpSync(assets.worker, join(root, 'tools/documents/pdf-worker.js'));
    cpSync(assets.checksum, join(root, 'tools/documents/pdf-worker.sha256'));
    // Copy physical packages; no source links or package-manager fallback in the candidate.
    for (const source of assets.dependencies) {
      const name = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).name;
      const target = join(root, 'node_modules', name);
      mkdirSync(target, { recursive: true });
      cpSync(source, target, { recursive: true, dereference: true });
    }
    if (process.platform === 'darwin') {
      const preload = await Bun.build({
        entrypoints: [resolve(import.meta.dir, '../../../src/storage/worker/observer-preload.ts')],
        outdir: join(root, 'storage/worker'),
        target: 'bun',
        packages: 'bundle',
      });
      expect(preload.success).toBe(true);
    }
    writeFileSync(join(root, 'input.pdf'), simplePdf());
    const child = Bun.spawn([process.execPath, '--no-install', join(root, 'reader.js')], {
      cwd: root,
      env: { ...process.env, PATH: '', NODE_PATH: '' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ status, stderr }).toEqual({ status: 0, stderr: '' });
    expect(JSON.parse(stdout)).toMatchObject({
      text: { totalPages: 1, pages: [{ text: 'Hello PDF' }] },
      recovered: ['Hello PDF', 'Hello PDF', 'Hello PDF'],
      signature: '89504e470d0a1a0a',
    });
  } finally {
    // Only this test's physical private directory; dependencies above are copied, never linked.
    expect(dirname(root)).toBe(realpathSync.native(tmpdir()));
    expect(basename(root).startsWith('kite-pdf-package-')).toBe(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
