import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdtemp, open, realpath, rmdir, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
/** Shell allocation owns helper temporaries; standalone developer fixtures use OS temp. */
export function documentTemporaryRoot() {
  const output = process.env.KITE_OUTPUT_DIR;
  if (output && !isAbsolute(output)) throw Error('document_output_directory_invalid');
  return output ? dirname(output) : tmpdir();
}

/** The receipt names the actual saved source, whose delivery copy is collected separately. */
export async function stageDocument(source: string, signal?: AbortSignal) {
  const configuredOutput = process.env.KITE_OUTPUT_DIR;
  if (!configuredOutput || !isAbsolute(configuredOutput))
    throw Error('document_output_directory_invalid');
  const [absolutePath, output] = await Promise.all([realpath(source), realpath(configuredOutput)]);
  const fromJob = relative(dirname(output), absolutePath);
  if (!isAbsolute(fromJob) && fromJob !== '..' && !fromJob.startsWith(`..${sep}`))
    throw Error('document_requires_saved_source');
  await exportDocument(absolutePath, join(output, basename(absolutePath)), signal);
  const linkPath = process.platform === 'win32' ? absolutePath.replaceAll('\\', '/') : absolutePath;
  const markdownTarget = linkPath.replace(/[%<>&\\]/g, (character) =>
    encodeURIComponent(character),
  );
  return { success: true, absolutePath, markdownTarget };
}

const maximum = 256 * 1024 * 1024;
/** Bounded stable read of an opened regular file. No source path is re-opened after validation. */
export async function readBoundedDocument(
  path: string,
  limit = maximum,
  signal?: AbortSignal,
): Promise<Buffer> {
  signal?.throwIfAborted();
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(limit)) throw Error('document_source_invalid');
    const bytes = Buffer.allocUnsafe(Number(before.size));
    let count = 0;
    while (count < bytes.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(
        bytes,
        count,
        Math.min(1024 * 1024, bytes.length - count),
        null,
      );
      if (!bytesRead) break;
      count += bytesRead;
    }
    signal?.throwIfAborted();
    const extra = await file.read(Buffer.allocUnsafe(1), 0, 1, null);
    const after = await file.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      BigInt(count) !== before.size ||
      extra.bytesRead !== 0
    )
      throw Error('document_source_changed');
    signal?.throwIfAborted();
    return bytes;
  } finally {
    await file.close();
  }
}
/** Exclusive atomic publication. Partial bytes stay private; never overwrites an existing output. */
export async function exportDocument(source: string, out: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const input = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let directory: string | undefined;
  let temporary: string | undefined;
  let target: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await input.stat({ bigint: true });
    if (!before.isFile() || before.size === 0n || before.size > BigInt(maximum))
      throw Error('document_source_invalid');
    // Publish within the destination filesystem and sandbox write root. A private
    // sibling directory hides partial bytes without linking across Shell roots.
    directory = await mkdtemp(join(dirname(out), '.kite-export-'));
    temporary = join(directory, randomUUID());
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
    const atPath = await stat(source, { bigint: true });
    if (
      before.dev !== atPath.dev ||
      before.ino !== atPath.ino ||
      before.size !== atPath.size ||
      before.mtimeNs !== atPath.mtimeNs ||
      before.ctimeNs !== atPath.ctimeNs
    )
      throw Error('document_source_changed');
    signal?.throwIfAborted();
    await link(temporary, out);
  } finally {
    await input.close();
    await target?.close();
    if (temporary)
      await unlink(temporary).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    if (directory) await rmdir(directory);
  }
}
