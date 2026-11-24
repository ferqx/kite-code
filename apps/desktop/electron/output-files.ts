import { createHash, randomUUID } from 'node:crypto';
import {
  type FileHandle,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import type { AgentClient, OutputFileTarget } from '@kite-ai/client';

function truncateFilenamePart(part: string, maxBytes: number) {
  const bytes = Buffer.from(part);
  if (bytes.length <= maxBytes) return part;
  let end = maxBytes;
  while ((bytes.readUInt8(end) & 0xc0) === 0x80) end--;
  return bytes.toString('utf8', 0, end);
}

function outputCopyName(name: string) {
  let cleaned = Array.from(name, (character) =>
    character.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(character) ? '_' : character,
  )
    .join('')
    .trim()
    .replace(/[. ]+$/u, '');
  const maxBytes = 200;
  if (Buffer.byteLength(cleaned) > maxBytes) {
    const suffix = extname(cleaned);
    const extension = truncateFilenamePart(suffix, 32);
    const stem = truncateFilenamePart(
      cleaned.slice(0, cleaned.length - suffix.length),
      maxBytes - Buffer.byteLength(extension),
    );
    cleaned = (stem + extension).replace(/[. ]+$/u, '');
  }
  const reserved = /^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/iu;
  const firstPart = cleaned.split('.', 1)[0]?.trimEnd() ?? '';
  if (reserved.test(firstPart)) return `_${cleaned}`;
  return cleaned || 'output';
}

const desktopDocumentExtensions = new Set([
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.odt',
  '.ods',
  '.odp',
  '.rtf',
  '.pdf',
  '.txt',
  '.md',
  '.csv',
  '.tsv',
  '.json',
  '.xml',
  '.yaml',
  '.yml',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.tif',
  '.tiff',
  '.avif',
  '.heic',
  '.mp3',
  '.wav',
  '.m4a',
  '.flac',
  '.ogg',
  '.mp4',
  '.mov',
  '.webm',
  '.mkv',
  '.zip',
]);

export function canOpenOutputInApp(name: string) {
  return desktopDocumentExtensions.has(extname(outputCopyName(name)).toLowerCase());
}

/** Reserve an independent destination for the new desktop copy. */
export async function createOutputCopyPath(downloadsDirectory: string, name: string) {
  await mkdir(downloadsDirectory, { recursive: true });
  const root = join(await realpath(downloadsDirectory), 'Kite Outputs');
  await mkdir(root, { recursive: true });
  if (!(await lstat(root)).isDirectory()) throw Error('output_copy_directory_invalid');
  return join(await mkdtemp(join(root, 'file-')), outputCopyName(name));
}

/** A destination is host-selected, never supplied by the renderer. EOF + integrity precede rename. */
export async function saveOutputFile(
  client: AgentClient,
  target: OutputFileTarget,
  destination: string,
  current: () => void,
) {
  current();
  const { reference, content, cancel } = await client.readOutputFileStream(target);
  const temporary = join(dirname(destination), `.kite-save-${randomUUID()}.tmp`);
  let file: FileHandle | undefined;
  let size = 0n;
  const hash = createHash('sha256');
  try {
    current();
    file = await open(temporary, 'wx', 0o600);
    for await (const chunk of content) {
      current();
      size += BigInt(chunk.byteLength);
      if (size > BigInt(reference.size)) throw Error('output_file_integrity_failed');
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.byteLength) {
        const written = await file.write(chunk, offset, chunk.byteLength - offset);
        if (!written.bytesWritten) throw Error('output_file_write_failed');
        offset += written.bytesWritten;
      }
    }
    if (String(size) !== reference.size || hash.digest('hex') !== reference.hash)
      throw Error('output_file_integrity_failed');
    await file.sync();
    await file.close();
    current();
    await rename(temporary, destination);
  } finally {
    await cancel().catch(() => {});
    await file?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}
