import { openAsBlob } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname } from 'node:path';

const contentTypes: Readonly<Record<string, string>> = {
  '.css': 'text/css',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.mjs': 'text/javascript',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

export function openFixtureFile(path: string): Promise<Blob> {
  return openAsBlob(path, { type: contentTypes[extname(path).toLowerCase()] });
}

export async function writeFixtureFile(
  path: string,
  value: string | Uint8Array | ArrayBuffer | Blob,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const bytes = value instanceof Blob ? await value.bytes() : value;
  await writeFile(path, bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes);
}
