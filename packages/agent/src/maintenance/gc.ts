import { randomUUID } from 'node:crypto';
import { existsSync, fstatSync, lstatSync, opendirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readPublishedArtifactChunks } from '../artifacts-files';
import { acquireProfileAccess, type ProfileOptions } from '../platform/profile';
import {
  checkpoint,
  closePrivate,
  openPrivate,
  privateDirectory,
  syncDirectory,
  withPrivateDatabaseSnapshot,
} from './files';
import { capture, openBackupDatabase } from './sqlite';
import { MaintenanceError } from './types';

export interface CollectProfileGarbageInput {
  profile: ProfileOptions;
  expectedStoreId: string;
  gracePeriodMs?: number;
  signal?: AbortSignal;
}
export interface ProfileGarbageCollection {
  storeId: string;
  outcome: 'collected';
  gracePeriodMs: number;
  scannedFiles: number;
  retainedReferenced: number;
  retainedRecent: number;
  removedFiles: number;
  removedBytes: string;
}
function* entries(root: string): Generator<{ path: string; hash: string | null }> {
  if (!existsSync(root)) return;
  privateDirectory(root);
  const top = opendirSync(root);
  try {
    for (let entry = top.readSync(); entry; entry = top.readSync()) {
      if (/^\.publish-[a-f0-9-]{36}$/.test(entry.name)) {
        yield { path: join(root, entry.name), hash: null };
        continue;
      }
      if (!/^[a-f0-9]{2}$/.test(entry.name)) throw new MaintenanceError('gc_unexpected_asset');
      const directory = privateDirectory(join(root, entry.name)),
        children = opendirSync(directory);
      try {
        for (let child = children.readSync(); child; child = children.readSync()) {
          if (!/^[a-f0-9]{64}$/.test(child.name) || !child.name.startsWith(entry.name))
            throw new MaintenanceError('gc_unexpected_asset');
          yield { path: join(directory, child.name), hash: child.name };
        }
      } finally {
        children.closeSync();
      }
    }
  } finally {
    top.closeSync();
  }
}
/** Explicit orphan collection only. Session tombstones, receipts and referenced history remain. */
export async function collectProfileGarbage(
  input: CollectProfileGarbageInput,
): Promise<ProfileGarbageCollection> {
  if (!['darwin', 'linux'].includes(process.platform))
    throw new MaintenanceError('maintenance_platform_unsupported');
  const gracePeriodMs = input.gracePeriodMs ?? 7 * 86400000;
  if (
    !Number.isSafeInteger(gracePeriodMs) ||
    gracePeriodMs < 86400000 ||
    gracePeriodMs > 365 * 86400000 ||
    typeof input.expectedStoreId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(input.expectedStoreId)
  )
    throw new MaintenanceError('gc_invalid_request');
  input.signal?.throwIfAborted();
  // Service, Artifact publishers/readers, Native and backup all share this same external lease.
  const access = acquireProfileAccess(input.profile, 'exclusive');
  try {
    privateDirectory(access.profilePath);
    if (existsSync(`${access.databasePath}-journal`))
      throw new MaintenanceError('backup_source_journal_present');
    const now = Date.now();
    return await withPrivateDatabaseSnapshot(
      access.databasePath,
      join(access.profilePath, `.gc-${randomUUID()}`),
      async (path) => {
        const db = openBackupDatabase(path);
        try {
          const metadata = capture(db);
          if (metadata.storeId !== input.expectedStoreId)
            throw new MaintenanceError('store_identity_mismatch');
          const referenced = db.query(
            'SELECT 1 FROM blob_ref WHERE blob_hash=? UNION ALL SELECT 1 FROM execution_output WHERE blob_hash=? LIMIT 1',
          );
          const root = join(access.profilePath, 'blobs');
          // Preflight the entire private namespace before any deletion, retaining bounded memory.
          for (const entry of entries(root)) {
            input.signal?.throwIfAborted();
            closePrivate(openPrivate(entry.path, entry.hash !== null));
            await checkpoint(input.signal);
          }
          const result: ProfileGarbageCollection = {
            storeId: metadata.storeId,
            outcome: 'collected',
            gracePeriodMs,
            scannedFiles: 0,
            retainedReferenced: 0,
            retainedRecent: 0,
            removedFiles: 0,
            removedBytes: '0',
          };
          let removedBytes = 0n;
          for (const entry of entries(root)) {
            input.signal?.throwIfAborted();
            result.scannedFiles++;
            if (entry.hash && referenced.get(entry.hash, entry.hash)) {
              result.retainedReferenced++;
              continue;
            }
            const fd = openPrivate(entry.path, entry.hash !== null);
            try {
              const before = fstatSync(fd, { bigint: true });
              if (
                Number(before.ctimeMs) > now - gracePeriodMs ||
                Number(before.mtimeMs) > now - gracePeriodMs
              ) {
                result.retainedRecent++;
                continue;
              }
              if (entry.hash) {
                let work = 0;
                for (const chunk of readPublishedArtifactChunks(
                  access.profilePath,
                  entry.hash,
                  String(before.size),
                )) {
                  work += chunk.byteLength;
                  input.signal?.throwIfAborted();
                  if (work >= 1048576) {
                    await checkpoint(input.signal);
                    work = 0;
                  }
                }
              }
              const current = lstatSync(entry.path, { bigint: true });
              if (
                current.dev !== before.dev ||
                current.ino !== before.ino ||
                current.ctimeNs !== before.ctimeNs ||
                current.size !== before.size ||
                current.nlink !== 1n
              )
                throw new MaintenanceError('backup_content_changed');
              input.signal?.throwIfAborted();
              unlinkSync(entry.path);
              syncDirectory(dirname(entry.path));
              result.removedFiles++;
              removedBytes += before.size;
            } finally {
              closePrivate(fd);
            }
            await checkpoint(input.signal);
          }
          result.removedBytes = String(removedBytes);
          return result;
        } finally {
          db.close(true);
        }
      },
      input.signal,
    );
  } finally {
    access.lock.release();
  }
}
