import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { constants, fstatSync, fsyncSync, lstatSync, readSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { canonicalJson } from '../json';
import { assertNoSymlinkPath } from '../platform/profile';
import { createWorkspaceFiles } from '../tools/files';
import {
  checkpoint,
  closePrivate,
  copyAssetFile,
  fingerprint,
  openMaintenanceDirectory,
  openMaintenanceFile,
  openPrivate,
  preserveMaintenanceFailure,
  privateDirectory,
  retainMaintenanceResource,
  writeAll,
} from './files';
import { MaintenanceError } from './types';

export interface WorkingFileInventory {
  inventory: 'working-files.jsonl';
  sha256: string;
  byteLength: string;
  fileCount: string;
}
type Entry = { path: string; proof: { sha256: string; byteLength: string } | null };
const pathPattern =
  /^files\/[a-f0-9]{64}\/[a-f0-9]{64}\/(?:plans\/[a-f0-9]{64}\/plan\.md|outputs\/[A-Za-z0-9][A-Za-z0-9._-]{0,119})$/;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
function fail(): never {
  throw new MaintenanceError('backup_working_files_invalid');
}
function paths(db: Database) {
  const values = new Set<string>();
  for (const row of db
    .query<{ scope_id: string; json: string }, []>(
      "SELECT scope_id,json FROM extension_record WHERE extension_id='builtin.planning' AND scope_kind='session' AND content_type='builtin.planning.record' AND content_version=1 AND json_extract(json,'$.kind') IN ('plan_document','plan_file_publication')",
    )
    .all()) {
    const value = JSON.parse(row.json);
    if (value.file === undefined) continue;
    const path = value.file?.path;
    if (
      typeof path !== 'string' ||
      !pathPattern.test(path) ||
      path.split('/')[2] !== hash(row.scope_id)
    )
      fail();
    values.add(path);
  }
  for (const row of db
    .query<{ scope_id: string; json: string }, []>(
      "SELECT scope_id,json FROM extension_record WHERE extension_id='builtin.files' AND scope_kind='session' AND content_type='builtin.files.output' AND content_version=1",
    )
    .all()) {
    const value = JSON.parse(row.json);
    if (
      typeof value.path !== 'string' ||
      !pathPattern.test(value.path) ||
      value.path.split('/')[2] !== hash(row.scope_id)
    )
      fail();
    values.add(value.path);
  }
  return [...values].sort();
}
function exists(path: string) {
  assertNoSymlinkPath(path);
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return false;
    throw error;
  }
}
function* entries(directory: string): Generator<Entry> {
  const fd = openPrivate(join(directory, 'working-files.jsonl'));
  try {
    const before = fstatSync(fd, { bigint: true });
    const buffer = Buffer.alloc(65536);
    let line = '';
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      for (const byte of buffer.subarray(0, count)) {
        if (byte === 10) {
          const value = JSON.parse(line);
          if (
            !value ||
            Object.keys(value).sort().join(',') !== 'path,proof' ||
            !pathPattern.test(value.path)
          )
            fail();
          if (
            value.proof !== null &&
            (!value.proof ||
              Object.keys(value.proof).sort().join(',') !== 'byteLength,sha256' ||
              !/^[a-f0-9]{64}$/.test(value.proof.sha256) ||
              !/^(0|[1-9][0-9]*)$/.test(value.proof.byteLength))
          )
            fail();
          yield value;
          line = '';
        } else {
          if (byte < 32 || byte > 126 || line.length > 1024) fail();
          line += String.fromCharCode(byte);
        }
      }
    }
    const after = fstatSync(fd, { bigint: true });
    if (line || before.size !== after.size || before.ctimeNs !== after.ctimeNs) fail();
  } finally {
    closePrivate(fd);
  }
}
export async function captureWorkingFiles(
  source: string,
  target: string,
  db: Database,
  signal?: AbortSignal,
): Promise<WorkingFileInventory | null> {
  const registered = paths(db);
  if (!registered.length) return null;
  const fd = openMaintenanceFile(
    join(target, 'working-files.jsonl'),
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    for (const path of registered) {
      signal?.throwIfAborted();
      const actual = join(source, ...path.split('/'));
      let proof: Entry['proof'] = null;
      if (exists(actual)) {
        await copyAssetFile(actual, join(target, ...path.split('/')), signal);
        proof = fingerprint(join(target, ...path.split('/')), signal);
      }
      writeAll(fd, Buffer.from(`${JSON.stringify({ path, proof })}\n`));
      await checkpoint(signal);
    }
    fsyncSync(fd);
  } finally {
    closePrivate(fd);
  }
  // A file copied early may have changed while later files were captured.
  for (const row of entries(target)) {
    const actual = join(source, ...row.path.split('/'));
    if (
      row.proof === null
        ? exists(actual)
        : canonicalJson(fingerprint(actual, signal)) !== canonicalJson(row.proof)
    )
      fail();
  }
  return {
    inventory: 'working-files.jsonl',
    ...fingerprint(join(target, 'working-files.jsonl'), signal),
    fileCount: String(registered.length),
  };
}
export function verifyWorkingFiles(
  directory: string,
  db: Database,
  inventory: WorkingFileInventory | undefined,
  signal?: AbortSignal,
) {
  const registered = paths(db);
  if (!inventory) {
    if (registered.length) fail();
    return;
  }
  if (
    canonicalJson(fingerprint(join(directory, inventory.inventory), signal)) !==
    canonicalJson({ sha256: inventory.sha256, byteLength: inventory.byteLength })
  )
    fail();
  const rows = [...entries(directory)];
  if (
    String(rows.length) !== inventory.fileCount ||
    canonicalJson(rows.map((row) => row.path)) !== canonicalJson(registered)
  )
    fail();
  const expected = new Set<string>();
  for (const row of rows) {
    const actual = join(directory, ...row.path.split('/'));
    if (row.proof === null) {
      if (exists(actual)) fail();
      continue;
    }
    if (canonicalJson(fingerprint(actual, signal)) !== canonicalJson(row.proof)) fail();
    const parts = row.path.split('/');
    for (let count = 1; count <= parts.length; count++)
      expected.add(parts.slice(0, count).join('/'));
  }
  function walk(relative: string) {
    const iterator = openMaintenanceDirectory(join(directory, ...relative.split('/')));
    try {
      for (let item = iterator.readSync(); item; item = iterator.readSync()) {
        const key = `${relative}/${item.name}`;
        if (!expected.has(key)) fail();
        if (item.isDirectory()) walk(key);
        else if (!item.isFile()) fail();
      }
    } finally {
      iterator.closeSync();
    }
  }
  if (exists(join(directory, 'files'))) walk('files');
}
export async function restoreWorkingFiles(
  source: string,
  target: string,
  inventory: WorkingFileInventory | undefined,
  signal?: AbortSignal,
) {
  if (!inventory) return;
  for (const row of entries(source)) {
    if (!row.proof) continue;
    const path = row.path.split('/');
    await copyAssetFile(join(source, ...path), join(target, ...path), signal);
    if (canonicalJson(fingerprint(join(target, ...path), signal)) !== canonicalJson(row.proof))
      fail();
  }
}

/** Called only inside the existing Profile EX and exact Store maintenance boundary. */
export async function collectWorkingFiles(
  profile: string,
  db: Database,
  cutoff: number,
  signal?: AbortSignal,
) {
  const registered = new Set(paths(db));
  let removedFiles = 0,
    removedBytes = 0n;
  async function walk(relative: string, depth: number) {
    signal?.throwIfAborted();
    if (depth > 7) throw new MaintenanceError('gc_unexpected_asset');
    const directory = join(profile, ...relative.split('/'));
    if (!exists(directory)) return;
    privateDirectory(directory);
    const iterator = openMaintenanceDirectory(directory);
    try {
      for (let item = iterator.readSync(); item; item = iterator.readSync()) {
        const path = `${relative}/${item.name}`;
        if (item.isDirectory()) {
          await walk(path, depth + 1);
          continue;
        }
        const cache =
          /^cache\/documents\/[a-f0-9]{64}\/[a-f0-9]{64}\/[a-f0-9]{64}\/result\.json$/.test(path);
        if (!item.isFile() || (!cache && !pathPattern.test(path)))
          throw new MaintenanceError('gc_unexpected_asset');
        if (!cache && registered.has(path)) continue;
        const target = join(profile, ...path.split('/'));
        const stat = lstatSync(target);
        if (stat.mtimeMs > cutoff || stat.ctimeMs > cutoff) continue;
        const files = createWorkspaceFiles({ root: dirname(target), strictReads: true });
        const release = retainMaintenanceResource(files);
        try {
          const snapshot = await files.readBytes(basename(target), { maxBytes: 256 * 1024 * 1024 });
          const current = lstatSync(target);
          if (current.mtimeMs > cutoff || current.ctimeMs > cutoff) continue;
          signal?.throwIfAborted();
          await files.remove({
            path: basename(target),
            base: snapshot.baseline,
            maxBytes: 256 * 1024 * 1024,
          });
          removedFiles++;
          removedBytes += BigInt(snapshot.baseline.size);
        } catch (error) {
          preserveMaintenanceFailure(error);
          throw error;
        } finally {
          await files.close();
          release();
        }
        await checkpoint(signal);
      }
    } finally {
      iterator.closeSync();
    }
  }
  await walk('files', 0);
  await walk('cache/documents', 0);
  return { removedFiles, removedBytes };
}
