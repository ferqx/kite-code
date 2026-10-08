import type { Database } from 'bun:sqlite';
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
  syncFile,
  withPrivateDatabaseSnapshot,
} from './files';
import { collectHistory, planHistoryCollection } from './gc-history';
import { capture, openBackupDatabase, openMaintenanceDatabase } from './sqlite';
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
  purgedWorkspaces: number;
  purgedSessions: number;
  retainedRecentWorkspaces: number;
  retainedUnsettledWorkspaces: number;
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
async function collectArtifacts(
  db: Database,
  profilePath: string,
  result: ProfileGarbageCollection,
  now: number,
  signal?: AbortSignal,
) {
  const referenced = db.query(
    'SELECT 1 FROM blob_ref WHERE blob_hash=? UNION ALL SELECT 1 FROM execution_output WHERE blob_hash=? LIMIT 1',
  );
  const root = join(profilePath, 'blobs');
  let removedBytes = 0n;
  for (const entry of entries(root)) {
    signal?.throwIfAborted();
    result.scannedFiles++;
    if (entry.hash && referenced.get(entry.hash, entry.hash)) {
      result.retainedReferenced++;
      continue;
    }
    const fd = openPrivate(entry.path, entry.hash !== null);
    try {
      const before = fstatSync(fd, { bigint: true });
      if (
        Number(before.ctimeMs) > now - result.gracePeriodMs ||
        Number(before.mtimeMs) > now - result.gracePeriodMs
      ) {
        result.retainedRecent++;
        continue;
      }
      if (entry.hash) {
        let work = 0;
        for (const chunk of readPublishedArtifactChunks(
          profilePath,
          entry.hash,
          String(before.size),
        )) {
          work += chunk.byteLength;
          signal?.throwIfAborted();
          if (work >= 1048576) {
            await checkpoint(signal);
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
      signal?.throwIfAborted();
      unlinkSync(entry.path);
      syncDirectory(dirname(entry.path));
      result.removedFiles++;
      removedBytes += before.size;
    } finally {
      closePrivate(fd);
    }
    await checkpoint(signal);
  }
  result.removedBytes = String(removedBytes);
  return result;
}
/** Explicit offline collection; unresolved work and immutable safety facts are never expired. */
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
  const access = acquireProfileAccess(input.profile, 'exclusive');
  try {
    privateDirectory(access.profilePath);
    if (existsSync(`${access.databasePath}-journal`))
      throw new MaintenanceError('backup_source_journal_present');
    const now = Date.now();
    const result: ProfileGarbageCollection = {
      storeId: input.expectedStoreId,
      outcome: 'collected',
      gracePeriodMs,
      purgedWorkspaces: 0,
      purgedSessions: 0,
      retainedRecentWorkspaces: 0,
      retainedUnsettledWorkspaces: 0,
      scannedFiles: 0,
      retainedReferenced: 0,
      retainedRecent: 0,
      removedFiles: 0,
      removedBytes: '0',
    };
    const snapshot = <T>(read: (db: Database) => T | Promise<T>) =>
      withPrivateDatabaseSnapshot(
        access.databasePath,
        join(access.profilePath, `.gc-${randomUUID()}`),
        async (path) => {
          const db = openBackupDatabase(path);
          try {
            if (capture(db).storeId !== input.expectedStoreId)
              throw new MaintenanceError('store_identity_mismatch');
            return await read(db);
          } finally {
            db.close(true);
          }
        },
        input.signal,
      );
    const plan = await snapshot(async (db) => {
      const plan = planHistoryCollection(db, now - gracePeriodMs);
      result.retainedRecentWorkspaces = plan.retainedRecentWorkspaces;
      result.retainedUnsettledWorkspaces = plan.retainedUnsettledWorkspaces;
      // The entire namespace is checked before either SQL bodies or artifact files are removed.
      for (const entry of entries(join(access.profilePath, 'blobs'))) {
        input.signal?.throwIfAborted();
        closePrivate(openPrivate(entry.path, entry.hash !== null));
        await checkpoint(input.signal);
      }
      if (!plan.workspaces.length && !plan.previouslyCollected)
        await collectArtifacts(db, access.profilePath, result, now, input.signal);
      return plan;
    });
    if (plan.workspaces.length || plan.previouslyCollected) {
      // The unchanged-source snapshot proof has finished before original SQL may be mutated.
      input.signal?.throwIfAborted();
      const db = openMaintenanceDatabase(access.databasePath);
      try {
        if (
          capture(db).storeId !== input.expectedStoreId ||
          JSON.stringify(planHistoryCollection(db, now - gracePeriodMs)) !== JSON.stringify(plan)
        )
          throw new MaintenanceError('backup_content_changed');
        collectHistory(db, plan, now);
        result.purgedWorkspaces = plan.workspaces.length;
        result.purgedSessions = plan.workspaces.reduce((n, w) => n + w.sessions, 0);
      } finally {
        db.close(true);
      }
      syncFile(access.databasePath);
      syncDirectory(access.profilePath);
      input.signal?.throwIfAborted();
      await snapshot((db) => collectArtifacts(db, access.profilePath, result, now, input.signal));
    }
    return result;
  } finally {
    access.lock.release();
  }
}
