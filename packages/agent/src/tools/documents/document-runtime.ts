import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const documentFontAsset = {
  url: 'https://raw.githubusercontent.com/notofonts/noto-cjk/Sans2.004/Sans/Variable/TTF/Subset/NotoSansSC-VF.ttf',
  sha256: 'd68bafcb48a2707749396aa12bbbd833cb70401f3a9a689fd2902c7e0d295964',
};

export function documentAsset(name: string) {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    join(here, name),
    join(here, 'tools/documents', name),
    resolve(here, '../../../dist/tools/documents', name),
  ].find(existsSync);
}

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export async function verifyDocumentHelper() {
  const helper = documentAsset('kite-documents.js');
  if (!helper) throw Error('documents_helper_unavailable');
  const [source, sha256] = await Promise.all([
    readFile(helper),
    readFile(join(dirname(helper), 'kite-documents.sha256'), 'utf8'),
  ]);
  if (digest(source) !== sha256.trimEnd()) throw Error('documents_helper_checksum_mismatch');
  return helper;
}

export async function readDocumentFont() {
  const font = documentAsset('font.ttf');
  if (!font) throw Error('documents_font_unavailable');
  const bytes = await readFile(font);
  if (digest(bytes) !== documentFontAsset.sha256) throw Error('documents_font_checksum_mismatch');
  return bytes;
}
