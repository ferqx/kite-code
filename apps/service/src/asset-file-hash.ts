import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync, readSync } from 'node:fs';

/** Keep native reads for small admitted files and one scratch buffer for large files. */
export function createAssetFileHasher(): (path: string, size: number) => string {
  let buffer: Buffer | undefined;
  return (path, size) => {
    if (size <= 65536) return createHash('sha256').update(readFileSync(path)).digest('hex');
    buffer ??= Buffer.allocUnsafe(1024 * 1024);
    const fd = openSync(path, 'r');
    try {
      const hash = createHash('sha256');
      for (;;) {
        const length = readSync(fd, buffer, 0, buffer.length, null);
        if (!length) return hash.digest('hex');
        hash.update(length === buffer.length ? buffer : buffer.subarray(0, length));
      }
    } finally {
      closeSync(fd);
    }
  };
}
