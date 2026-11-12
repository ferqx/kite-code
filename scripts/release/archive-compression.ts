import { promisify } from 'node:util';
import { constants, gunzipSync, zstdCompress, zstdDecompressSync } from 'node:zlib';

const zstdMagic = 0xfd2fb528;
const windowLog = 27;
const compressZstd = promisify(zstdCompress);

export async function releaseArchiveBytes(
  files: Record<string, Uint8Array>,
  archivePath: string,
): Promise<Uint8Array> {
  if (!archivePath.toLowerCase().endsWith('.tar.zst'))
    return new Bun.Archive(files, { compress: 'gzip', level: 6 }).bytes();
  const tar = await new Bun.Archive(files).bytes();
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

// RFC 8878 frame boundaries. Bun's streaming decoder can return a partial frame.
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
