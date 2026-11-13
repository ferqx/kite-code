import { promisify } from 'node:util';
import { constants, gunzipSync, gzip, zstdCompress, zstdDecompressSync } from 'node:zlib';

const zstdMagic = 0xfd2fb528;
const windowLog = 27;
const compressZstd = promisify(zstdCompress);
const compressGzip = promisify(gzip);

const block = 512;

function tarHeader(name: string, size: number, type: '0' | 'x') {
  const header = Buffer.alloc(block);
  const number = (value: number, width: number, offset: number) => {
    const digits = value.toString(8);
    if (digits.length >= width) throw Error('terminal_archive_entry_too_large');
    header.write(digits.padStart(width - 1, '0'), offset, 'ascii');
  };
  header.write(name, 0, 100, 'utf8');
  number(0o644, 8, 100);
  number(0, 8, 108);
  number(0, 8, 116);
  number(size, 12, 124);
  number(0, 12, 136);
  header.fill(32, 148, 156);
  header.write(type, 156, 'ascii');
  header.write('ustar\0' + '00', 257, 'ascii');
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return header;
}

/** Emit regular files only. Long UTF-8 paths use one POSIX PAX path record. */
export function releaseTarBytes(files: Record<string, Uint8Array>): Buffer {
  const parts: Uint8Array[] = [];
  function entry(name: string, bytes: Uint8Array, type: '0' | 'x') {
    parts.push(tarHeader(name, bytes.byteLength, type), bytes);
    const remainder = bytes.byteLength % block;
    if (remainder) parts.push(Buffer.alloc(block - remainder));
  }
  for (const [path, bytes] of Object.entries(files)) {
    let name = path;
    if (Buffer.byteLength(path) >= 100) {
      const record = ` path=${path}\n`;
      const length = Buffer.byteLength(record);
      let width = 1;
      while (String(length + width).length !== width) width++;
      entry('PaxHeaders/file', Buffer.from(`${length + width}${record}`), 'x');
      name = 'file';
    }
    entry(name, bytes, '0');
  }
  parts.push(Buffer.alloc(2 * block));
  return Buffer.concat(parts);
}

export async function releaseArchiveBytes(
  files: Record<string, Uint8Array>,
  archivePath: string,
): Promise<Uint8Array> {
  const tar = releaseTarBytes(files);
  if (!archivePath.toLowerCase().endsWith('.tar.zst')) return compressGzip(tar, { level: 6 });
  const options = {
    pledgedSrcSize: tar.byteLength,
    params: {
      [constants.ZSTD_c_compressionLevel]: 10,
      [constants.ZSTD_c_enableLongDistanceMatching]: 1,
      [constants.ZSTD_c_windowLog]: windowLog,
      [constants.ZSTD_c_checksumFlag]: 1,
    },
  };
  return compressZstd(tar, options);
}

// Verify the complete RFC 8878 frame before decompressing.
function verifyZstdFrame(bytes: Buffer) {
  const descriptor = bytes[4];
  if (descriptor === undefined || descriptor & 8) throw Error('terminal_archive_invalid');
  const singleSegment = (descriptor & 32) !== 0;
  const dictionarySize = [0, 1, 2, 4][descriptor & 3]!;
  const contentSize = [singleSegment ? 1 : 0, 2, 4, 8][descriptor >> 6]!;
  const end = bytes.length - (descriptor & 4 ? 4 : 0);
  let offset = 5 + (singleSegment ? 0 : 1) + dictionarySize + contentSize;
  while (offset + 3 <= end) {
    const block = bytes.readUIntLE(offset, 3);
    const type = (block >> 1) & 3;
    if (type === 3) break;
    offset += 3 + (type === 1 ? 1 : block >>> 3);
    if (block & 1) {
      if (offset === end) return;
      break;
    }
  }
  throw Error('terminal_archive_invalid');
}

export function decompressReleaseArchive(bytes: Buffer, maxOutputLength: number): Uint8Array {
  if (bytes.length < 4 || bytes.readUInt32LE(0) !== zstdMagic)
    return gunzipSync(bytes, { maxOutputLength });
  verifyZstdFrame(bytes);
  return zstdDecompressSync(bytes, {
    maxOutputLength,
    params: { [constants.ZSTD_d_windowLogMax]: windowLog },
  });
}
