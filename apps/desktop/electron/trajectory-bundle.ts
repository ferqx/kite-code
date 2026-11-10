import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { type FileHandle, lstat, open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  createTrajectoryBundle,
  type LocalTrajectoryBundle,
  openTrajectoryBundle,
  type TrajectoryBundleDirectory,
} from '@kite-ai/client';

const magic = Buffer.from('KITE-TRAJECTORY-BUNDLE 1\n');
const entryPath = /^(?:manifest\.json|events\/[0-9]{8}\.jsonl|evidence\/[a-f0-9]{64}\.bin)$/;
const maximumFileBytes = 2 * 1024 * 1024 * 1024;
const maximumEntries = 100_000;
/** Retains the actual selected file when failed-open cleanup cannot confirm its close. */
export class TrajectoryBundleCleanupError extends Error {
  readonly code = 'trajectory_bundle_close_unconfirmed';
  constructor(originalError: unknown, cleanupError: unknown, file: FileHandle) {
    super('trajectory_bundle_close_unconfirmed', {
      cause: Object.freeze({ originalError, cleanupError, file }),
    });
  }
}
function fail(code: string): never {
  throw Error(`trajectory_bundle_${code}`);
}
function same(
  a: { dev: number; ino: number; size: number; mtimeMs: number },
  b: { dev: number; ino: number; size: number; mtimeMs: number },
): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}
async function readExact(
  file: FileHandle,
  offset: number,
  length: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const result = Buffer.alloc(length);
  let position = 0;
  while (position < length) {
    signal?.throwIfAborted();
    const chunk = await file.read(result, position, length - position, offset + position);
    if (!chunk.bytesRead) fail('truncated');
    position += chunk.bytesRead;
  }
  signal?.throwIfAborted();
  return result;
}
/** Single-file wrapper for the fixed manifest/section format; no archive extraction or external paths. */
export async function openNativeTrajectoryBundle(
  path: string,
  signal?: AbortSignal,
): Promise<{ bundle: LocalTrajectoryBundle; close(): Promise<void> }> {
  signal?.throwIfAborted();
  const selected = await lstat(path);
  if (!selected.isFile() || selected.isSymbolicLink() || selected.size > maximumFileBytes)
    fail('file_invalid');
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let closed = false;
  try {
    const original = await file.stat();
    if (
      !same(selected, original) ||
      !(await readExact(file, 0, magic.byteLength, signal)).equals(magic)
    )
      fail('file_invalid');
    const entries = new Map<string, { offset: number; bytes: number }>();
    let offset = magic.byteLength;
    while (offset < original.size) {
      signal?.throwIfAborted();
      if (entries.size >= maximumEntries) fail('entry_limit');
      const header = await readExact(file, offset, Math.min(2048, original.size - offset), signal);
      const newline = header.indexOf(10);
      if (newline < 0) fail('header_invalid');
      let value: unknown;
      try {
        value = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(header.subarray(0, newline)),
        );
      } catch {
        return fail('header_invalid');
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail('header_invalid');
      const record = value as Record<string, unknown>;
      if (
        Object.keys(record).sort().join(',') !== 'bytes,path' ||
        typeof record.path !== 'string' ||
        !entryPath.test(record.path) ||
        entries.has(record.path) ||
        typeof record.bytes !== 'string' ||
        !/^(0|[1-9][0-9]{0,9})$/.test(record.bytes)
      )
        fail('header_invalid');
      const bytes = Number(record.bytes),
        start = offset + newline + 1,
        end = start + bytes;
      if (!Number.isSafeInteger(end) || end >= original.size) fail('truncated');
      if ((await readExact(file, end, 1, signal))[0] !== 10) fail('frame_invalid');
      entries.set(record.path, { offset: start, bytes });
      offset = end + 1;
    }
    const assertFile = async () => {
      if (closed || !same(original, await file.stat())) fail('changed');
    };
    const directory: TrajectoryBundleDirectory = {
      async list(readSignal) {
        readSignal?.throwIfAborted();
        await assertFile();
        return [...entries.keys()];
      },
      async read(name, readSignal, maximumBytes) {
        readSignal?.throwIfAborted();
        await assertFile();
        const entry = entries.get(name);
        if (!entry || (maximumBytes !== undefined && entry.bytes > maximumBytes))
          fail('entry_budget');
        const bytes = await readExact(file, entry.offset, entry.bytes, readSignal);
        await assertFile();
        return bytes;
      },
    };
    const bundle = await openTrajectoryBundle(directory, {}, signal);
    let closing: Promise<void> | undefined;
    return {
      bundle,
      close() {
        closing ??= (async () => {
          bundle.clearCache();
          try {
            await file.close();
            closed = true;
          } catch (error) {
            throw new TrajectoryBundleCleanupError(error, error, file);
          }
        })();
        return closing;
      },
    };
  } catch (error) {
    try {
      await file.close();
      closed = true;
    } catch (cleanupError) {
      throw new TrajectoryBundleCleanupError(error, cleanupError, file);
    }
    throw error;
  }
}

/** The caller obtains this exact destination from a Native save dialog. Commit only a complete manifest. */
export async function writeNativeTrajectoryBundle(
  path: string,
  input: Parameters<typeof createTrajectoryBundle>[0],
): Promise<void> {
  const previous = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (previous && (!previous.isFile() || previous.isSymbolicLink())) fail('destination_invalid');
  const temporary = join(dirname(path), `.kite-trajectory-${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  let closed = false,
    committed = false,
    size = magic.byteLength;
  let closing: Promise<void> | undefined,
    originalError: unknown,
    failed = false;
  const closeFile = () =>
    (closing ??= file.close().then(() => {
      closed = true;
    }));
  try {
    await file.writeFile(magic);
    for await (const frame of createTrajectoryBundle(input)) {
      input.signal?.throwIfAborted();
      if (!entryPath.test(frame.path)) fail('entry_invalid');
      const header = Buffer.from(
        `${JSON.stringify({ path: frame.path, bytes: String(frame.bytes.byteLength) })}\n`,
      );
      size += header.byteLength + frame.bytes.byteLength + 1;
      if (size > maximumFileBytes) fail('file_budget');
      await file.writeFile(header);
      await file.writeFile(frame.bytes);
      await file.writeFile('\n');
    }
    await file.sync();
    await closeFile();
    // Verify the actual bytes and every section before making the selected file visible.
    const checked = await openNativeTrajectoryBundle(temporary, input.signal);
    try {
      let after = checked.bundle.minimumCursor;
      for (;;) {
        const page = await checked.bundle.readEvents(
          {
            storeId: checked.bundle.snapshot.storeId,
            sessionId: checked.bundle.snapshot.sessionId,
            ...(checked.bundle.snapshot.runId ? { runId: checked.bundle.snapshot.runId } : {}),
            ...(checked.bundle.snapshot.executionId
              ? { executionId: checked.bundle.snapshot.executionId }
              : {}),
            ...(checked.bundle.snapshot.eventKinds
              ? { eventKinds: checked.bundle.snapshot.eventKinds }
              : {}),
            afterCursor: after,
            upperCursor: checked.bundle.snapshot.upperCursor,
          },
          input.signal,
        );
        for (const event of page.events)
          for (const ref of event.evidenceRefs)
            await checked.bundle.readEvidence(
              event.eventId,
              ref.evidenceId,
              ref.contentVersion,
              input.signal,
            );
        if (page.exhausted) break;
        after = page.scannedThrough;
      }
    } finally {
      await checked.close();
    }
    input.signal?.throwIfAborted();
    const current = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (previous ? !current || !same(previous, current) : current !== null)
      fail('destination_changed');
    await rename(temporary, path);
    committed = true;
    if (process.platform !== 'win32') {
      const directory = await open(dirname(path), 'r');
      let syncError: unknown,
        syncFailed = false;
      try {
        await directory.sync();
      } catch (error) {
        syncError = error;
        syncFailed = true;
      }
      try {
        await directory.close();
      } catch (error) {
        throw new TrajectoryBundleCleanupError(syncError, error, directory);
      }
      if (syncFailed) throw syncError;
    }
  } catch (error) {
    originalError = error;
    failed = true;
  }
  if (!closed) {
    try {
      await closeFile();
    } catch (cleanupError) {
      throw new TrajectoryBundleCleanupError(originalError, cleanupError, file);
    }
  }
  if (!committed && closed) await unlink(temporary);
  if (failed) throw originalError;
}
