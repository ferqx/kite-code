import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { documentFontAsset } from './document-runtime';

const cache = resolve(import.meta.dir, '../../../../../.cache/document-assets');
const validFont = (bytes: Uint8Array) =>
  bytes.length <= 64 * 1024 * 1024 &&
  createHash('sha256').update(bytes).digest('hex') === documentFontAsset.sha256;

async function readFixedFont() {
  const cached = join(cache, documentFontAsset.sha256);
  try {
    const bytes = await readFile(cached);
    if (!validFont(bytes)) throw Error('documents_font_checksum_mismatch');
    return bytes;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const response = await fetch(documentFontAsset.url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw Error(`documents_font_download_failed:${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!validFont(bytes)) throw Error('documents_font_checksum_mismatch');
  const temporary = join(cache, `${documentFontAsset.sha256}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
    await rename(temporary, cached);
  } finally {
    await rm(temporary, { force: true });
  }
  return bytes;
}

export async function prepareDocumentFont(destination: string) {
  await mkdir(cache, { recursive: true });
  const font = await readFixedFont();
  await mkdir(destination, { recursive: true });
  await writeFile(join(destination, 'font.ttf'), font, { mode: 0o644 });
  await copyFile(join(import.meta.dir, 'font-license.txt'), join(destination, 'Font-LICENSE.txt'));
}
