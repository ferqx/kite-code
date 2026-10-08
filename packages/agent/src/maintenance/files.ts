import { createHash } from 'node:crypto';
import {
  closeSync as closeDescriptor,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { readPublishedArtifactChunks } from '../artifacts-files';
import { canonicalJson } from '../json';
import { assertNoSymlinkPath } from '../platform/profile';
import { createWindowsArtifactTemporary } from '../platform/windows-artifact-files';
import {
  privateDirectory as createWindowsPrivateDirectory,
  defaultWindowsPathSecurity,
  type WindowsPrivateRead,
} from '../platform/windows-path-security';
import { MaintenanceError } from './types';

export const maximumInteger = 9223372036854775807n;
export function decimal(value: unknown): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value))
    throw new MaintenanceError('backup_invalid_manifest');
  if (BigInt(value) > maximumInteger) throw new MaintenanceError('backup_invalid_manifest');
  return value;
}
export function contains(parent: string, path: string): boolean {
  const part = relative(parent, path);
  return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !part.startsWith(sep));
}
export function privateDirectory(path: string, create = false): string {
  if (process.platform === 'win32') {
    const requested = resolve(path);
    if (create) createWindowsPrivateDirectory(requested);
    else defaultWindowsPathSecurity()!.verifyDirectory(requested);
    return realpathSync(requested);
  }
  assertNoSymlinkPath(path);
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new MaintenanceError('backup_access_denied');
  return realpathSync(resolve(path));
}
const reads = new Map<number, WindowsPrivateRead>();
/** Release the same native pin only after all descriptor consumers have finished. */
export function closePrivate(fd: number): void {
  const held = reads.get(fd);
  if (held) {
    let error: unknown;
    try {
      held.verify();
    } catch (caught) {
      error = caught;
    }
    // Failed native close keeps the still-open descriptor and its original pin available.
    held.close();
    closeDescriptor(fd);
    reads.delete(fd);
    if (error) throw error;
    return;
  }
  closeDescriptor(fd);
}
export function openPrivate(path: string, readOnly = false): number {
  if (process.platform === 'win32') {
    const native = defaultWindowsPathSecurity()!;
    const held = readOnly ? native.retainReadOnlyFile(path) : native.retainPrivateFile(path);
    let fd: number | undefined;
    try {
      const before = lstatSync(path, { bigint: true });
      fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
      const opened = fstatSync(fd, { bigint: true });
      held.verify();
      if (
        !opened.isFile() ||
        opened.nlink !== 1n ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.size !== before.size
      )
        throw new MaintenanceError('backup_content_changed');
      reads.set(fd, held);
      return fd;
    } catch (error) {
      try {
        held.close();
      } finally {
        if (fd !== undefined) closeDescriptor(fd);
      }
      throw error;
    }
  }
  assertNoSymlinkPath(path);
  const before = lstatSync(path, { bigint: true });
  if (
    !before.isFile() ||
    before.nlink !== 1n ||
    (Number(before.mode) & 0o077) !== 0 ||
    (readOnly && (Number(before.mode) & 0o222) !== 0) ||
    (process.getuid && before.uid !== BigInt(process.getuid()))
  )
    throw new MaintenanceError('backup_access_denied');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size)
      throw new MaintenanceError('backup_content_changed');
    return fd;
  } catch (error) {
    closePrivate(fd);
    throw error;
  }
}
export function fingerprint(path: string, signal?: AbortSignal, readOnly = false) {
  const fd = openPrivate(path, readOnly);
  try {
    const before = fstatSync(fd, { bigint: true });
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let bytes = 0n;
    for (;;) {
      signal?.throwIfAborted();
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (!read) break;
      hash.update(buffer.subarray(0, read));
      bytes += BigInt(read);
    }
    const after = fstatSync(fd, { bigint: true });
    if (bytes !== before.size || before.ctimeNs !== after.ctimeNs || before.size !== after.size)
      throw new MaintenanceError('backup_content_changed');
    return { sha256: hash.digest('hex'), byteLength: decimal(String(bytes)) };
  } finally {
    closePrivate(fd);
  }
}
export function syncFile(path: string): void {
  if (process.platform === 'win32') {
    defaultWindowsPathSecurity()!.syncPrivateFile(path);
    return;
  }
  const fd = openPrivate(path);
  try {
    fsyncSync(fd);
  } finally {
    closePrivate(fd);
  }
}
export function syncDirectory(path: string): void {
  privateDirectory(path);
  // Windows publication uses explicit write-through file flushes and same-volume moves.
  // It has no POSIX directory-fsync operation; this call verifies its private directory.
  if (process.platform === 'win32') return;
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closePrivate(fd);
  }
}
export function movePrivateEntry(source: string, target: string, replace = false): void {
  if (process.platform === 'win32') {
    defaultWindowsPathSecurity()!.movePrivateEntry(source, target, replace);
    return;
  }
  renameSync(source, target);
}
/** The immutable Windows media publisher owns its original write/flush/rename handle. */
export async function copyWindowsMedia(
  source: string,
  target: string,
  hash: string,
  size: string,
  signal?: AbortSignal,
): Promise<void> {
  if (process.platform !== 'win32') throw new MaintenanceError('maintenance_platform_unsupported');
  const output = createWindowsArtifactTemporary(target);
  try {
    let sinceYield = 0;
    for (const chunk of readPublishedArtifactChunks(source, hash, size)) {
      signal?.throwIfAborted();
      output.write(chunk);
      sinceYield += chunk.byteLength;
      if (sinceYield >= 1024 * 1024) {
        await checkpoint(signal);
        sinceYield = 0;
      }
    }
    signal?.throwIfAborted();
    output.publish(hash, size);
  } finally {
    output.close();
  }
}
export function writeAll(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(fd, bytes, offset, bytes.byteLength - offset);
    if (!written) throw new MaintenanceError('backup_write_incomplete');
    offset += written;
  }
}
/** Yield control for cancellation/other profiles, never authority or a SQL write transaction. */
export async function checkpoint(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  signal?.throwIfAborted();
}

/** Complete private bytes; both the held source entity and published path must stay unchanged. */
export async function copyAssetFile(source: string, target: string, signal?: AbortSignal) {
  const initial = lstatSync(source, { bigint: true });
  const before = fingerprint(source, signal);
  privateDirectory(dirname(target), true);
  const reader = openPrivate(source);
  let writer: number | undefined;
  try {
    const entity = fstatSync(reader, { bigint: true });
    if (
      initial.dev !== entity.dev ||
      initial.ino !== entity.ino ||
      initial.ctimeNs !== entity.ctimeNs ||
      initial.size !== entity.size ||
      initial.mode !== entity.mode ||
      initial.uid !== entity.uid ||
      initial.nlink !== entity.nlink
    )
      throw new MaintenanceError('backup_content_changed');
    writer = openSync(
      target,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    const hash = createHash('sha256'),
      buffer = Buffer.alloc(65536);
    let length = 0n;
    for (;;) {
      signal?.throwIfAborted();
      const count = readSync(reader, buffer, 0, buffer.length, null);
      if (!count) break;
      const bytes = buffer.subarray(0, count);
      hash.update(bytes);
      writeAll(writer, bytes);
      length += BigInt(count);
      await checkpoint(signal);
    }
    const after = fstatSync(reader, { bigint: true }),
      path = lstatSync(source, { bigint: true });
    if (
      entity.dev !== after.dev ||
      entity.ino !== after.ino ||
      entity.size !== after.size ||
      entity.ctimeNs !== after.ctimeNs ||
      entity.mode !== after.mode ||
      entity.uid !== after.uid ||
      entity.nlink !== after.nlink ||
      entity.dev !== path.dev ||
      entity.ino !== path.ino ||
      entity.ctimeNs !== path.ctimeNs ||
      entity.size !== path.size ||
      entity.mode !== path.mode ||
      entity.uid !== path.uid ||
      entity.nlink !== path.nlink ||
      length !== entity.size ||
      String(length) !== before.byteLength ||
      hash.digest('hex') !== before.sha256
    )
      throw new MaintenanceError('backup_content_changed');
    fsyncSync(writer);
  } finally {
    try {
      closePrivate(reader);
    } finally {
      if (writer !== undefined) closePrivate(writer);
    }
  }
  if (
    canonicalJson(fingerprint(source, signal)) !== canonicalJson(before) ||
    canonicalJson(fingerprint(target, signal)) !== canonicalJson(before)
  )
    throw new MaintenanceError('backup_content_changed');
  if (process.platform === 'win32') syncFile(target);
  syncDirectory(dirname(target));
  return before;
}

/** SQL is allowed only on this operation's private DB/WAL copy, never on the source profile. */
export async function withPrivateDatabaseSnapshot<T>(
  source: string,
  scratch: string,
  read: (databasePath: string) => T | Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const entity = (path: string) => {
    const fd = openPrivate(path);
    try {
      const stat = fstatSync(fd, { bigint: true });
      return {
        dev: String(stat.dev),
        ino: String(stat.ino),
        ctime: String(stat.ctimeNs),
        size: String(stat.size),
        mode: String(stat.mode),
        uid: String(stat.uid),
        nlink: String(stat.nlink),
      };
    } finally {
      closePrivate(fd);
    }
  };
  const files = () =>
    ['', '-wal'].map((suffix) => {
      try {
        lstatSync(source + suffix);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && suffix) return null;
        throw error;
      }
      const path = source + suffix,
        stamp = entity(path),
        proof = fingerprint(path, signal);
      if (canonicalJson(entity(path)) !== canonicalJson(stamp))
        throw new MaintenanceError('backup_content_changed');
      return { stamp, proof };
    });
  const before = files();
  privateDirectory(dirname(scratch));
  privateDirectory(scratch, true);
  let outcome: { ok: true; value: T } | { ok: false; error: unknown } = {
    ok: false,
    error: new MaintenanceError('backup_content_changed'),
  };
  let cleanupError: unknown;
  try {
    const databasePath = join(scratch, 'source.db');
    for (const [index, suffix] of ['', '-wal'].entries()) {
      const expected = before[index];
      if (expected === undefined) throw new MaintenanceError('backup_content_changed');
      if (expected === null) continue;
      if (
        canonicalJson(await copyAssetFile(source + suffix, databasePath + suffix, signal)) !==
        canonicalJson(expected.proof)
      )
        throw new MaintenanceError('backup_content_changed');
      if (canonicalJson(files()) !== canonicalJson(before))
        throw new MaintenanceError('backup_content_changed');
    }
    if (canonicalJson(files()) !== canonicalJson(before))
      throw new MaintenanceError('backup_content_changed');
    signal?.throwIfAborted();
    const result = await read(databasePath);
    signal?.throwIfAborted();
    if (canonicalJson(files()) !== canonicalJson(before))
      throw new MaintenanceError('backup_content_changed');
    outcome = { ok: true, value: result };
  } catch (error) {
    outcome = { ok: false, error };
  } finally {
    try {
      rmSync(scratch, { recursive: true });
    } catch (error) {
      cleanupError = error;
    }
  }
  if (cleanupError !== undefined) {
    if (!outcome.ok)
      throw new AggregateError([outcome.error, cleanupError], 'backup_snapshot_cleanup_failed');
    throw cleanupError;
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
