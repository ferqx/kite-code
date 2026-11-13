import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, open, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
/** Shell allocation owns helper temporaries; standalone developer fixtures use OS temp. */
export function documentTemporaryRoot() {
  const output = process.env.KITE_OUTPUT_DIR;
  if (output && !isAbsolute(output)) throw Error('document_output_directory_invalid');
  return output ? dirname(output) : tmpdir();
}

const maximum = 256 * 1024 * 1024;
/** Bounded stable read of an opened regular file. No source path is re-opened after validation. */
export async function readBoundedDocument(path: string, limit = maximum): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(limit)) throw Error('document_source_invalid');
    const chunks: Buffer[] = [];
    let count = 0;
    for (;;) {
      const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, limit - count + 1));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      count += bytesRead;
      if (count > limit) throw Error('document_size_limit');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const after = await file.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      BigInt(count) !== before.size
    )
      throw Error('document_source_changed');
    return Buffer.concat(chunks, count);
  } finally {
    await file.close();
  }
}
/** Exclusive atomic publication. Partial bytes stay private; never overwrites an existing output. */
export async function exportDocument(
  source: string,
  out: string,
  signal?: AbortSignal,
  stagingRoot = dirname(out),
) {
  signal?.throwIfAborted();
  const input = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const temporary = join(stagingRoot, `.kite-export-${randomUUID()}`);
  let target: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await input.stat({ bigint: true });
    if (!before.isFile() || before.size === 0n || before.size > BigInt(maximum))
      throw Error('document_source_invalid');
    target = await open(temporary, 'wx', 0o600);
    let count = 0;
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      signal?.throwIfAborted();
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      count += bytesRead;
      if (count > maximum) throw Error('document_size_limit');
      let offset = 0;
      while (offset < bytesRead) {
        const { bytesWritten } = await target.write(buffer, offset, bytesRead - offset, null);
        if (!bytesWritten) throw Error('document_write_incomplete');
        offset += bytesWritten;
      }
    }
    const after = await input.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      BigInt(count) !== before.size
    )
      throw Error('document_source_changed');
    await target.sync();
    await target.close();
    target = undefined;
    signal?.throwIfAborted();
    await link(temporary, out);
  } finally {
    await input.close();
    await target?.close();
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
