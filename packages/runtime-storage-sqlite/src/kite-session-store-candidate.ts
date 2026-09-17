import { Database, constants as sqliteConstants } from 'bun:sqlite';
import {
  chmodSync,
  copyFileSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import { assertKiteSessionStoreSchema } from './kite-home-store';
import {
  assertKiteSessionExclusiveMaintenance,
  type KiteSessionMaintenanceLock,
} from './kite-session-maintenance';
import {
  captureKiteSessionPreservationManifest,
  type KiteSessionPreservationManifest,
} from './kite-session-preservation';
import {
  createKiteSessionRecoveryBackup,
  type KiteSessionRecoveryBackup,
} from './kite-session-recovery-backup';
import { mergeKiteSessionStores10 } from './kite-session-store-merge';
import { convertKiteStore9ToSessionStore10 } from './kite-session-store9-conversion';
import { convertKiteSessionStore11To10 } from './kite-session-store11-conversion';
import type { SqliteRuntimeSnapshotCodec } from './preflight';

export interface KiteSessionStoreCandidate {
  readonly databasePath: string;
  readonly manifest: KiteSessionPreservationManifest;
  readonly backups: readonly KiteSessionRecoveryBackup[];
}

/**
 * Builds a private candidate from exact known sources. Original files are never opened writable.
 * The service must prove retired writers have stopped before calling; all source locks remain
 * owned by the caller through publication. A candidate is not a normal Store entrypoint.
 */
export function createKiteSessionStoreCandidate<Event, State>(input: {
  readonly sources: readonly {
    readonly databasePath: string;
    readonly maintenance: KiteSessionMaintenanceLock;
  }[];
  readonly migrationDirectory: string;
  readonly codec: SqliteRuntimeSnapshotCodec<Event, State>;
  readonly isSettledState: (state: State) => boolean;
  /** Full production reader and reference validation, called before sealing the candidate. */
  readonly validate: (database: Database) => void;
  readonly nowMs: number;
}): KiteSessionStoreCandidate {
  if (process.platform === 'win32')
    throw new Error('Store candidate publication is not qualified on Windows.');
  if (
    input.sources.length === 0 ||
    new Set(input.sources.map((s) => s.databasePath)).size !== input.sources.length
  ) {
    throw new Error('Store candidate sources are empty or duplicated.');
  }
  const directory = lstatSync(input.migrationDirectory);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    directory.uid !== process.getuid?.() ||
    (directory.mode & 0o077) !== 0 ||
    realpathSync.native(input.migrationDirectory) !== input.migrationDirectory
  ) {
    throw new Error('Store candidate directory is not private and canonical.');
  }
  for (const source of input.sources)
    assertKiteSessionExclusiveMaintenance(source.maintenance, source.databasePath);
  const backups = input.sources.map((source) =>
    createKiteSessionRecoveryBackup(source.databasePath, input.migrationDirectory, {
      maintenance: source.maintenance,
    }),
  );
  const working: string[] = [];
  // The verified backup is immutable. All format changes are made to separate private candidates.
  for (const [index, backup] of backups.entries()) {
    const parent = join(input.migrationDirectory, `converted-${index}`);
    mkdirSync(parent, { mode: 0o700 });
    const path = join(parent, 'kite-session.sqlite');
    copyFileSync(backup.databasePath, path, fsConstants.COPYFILE_EXCL);
    chmodSync(path, 0o600);
    const database = new Database(
      path,
      sqliteConstants.SQLITE_OPEN_READWRITE | sqliteConstants.SQLITE_OPEN_NOFOLLOW,
    );
    try {
      database.run('PRAGMA foreign_keys = ON');
      database.run('PRAGMA synchronous = FULL');
      const conversion = {
        database,
        codec: input.codec,
        isSettledState: input.isSettledState,
        nowMs: input.nowMs,
      };
      if (backup.manifest.capture.schemaVersion === 9)
        convertKiteStore9ToSessionStore10(conversion);
      else if (backup.manifest.capture.schemaVersion === 11)
        convertKiteSessionStore11To10(conversion);
      else assertKiteSessionStoreSchema(database);
      input.validate(database);
      const mode = database
        .query<{ journal_mode: string }, []>('PRAGMA journal_mode = DELETE')
        .get();
      if (mode?.journal_mode !== 'delete')
        throw new Error('Converted Store journal did not close.');
    } finally {
      database.close(false);
    }
    working.push(path);
  }
  const databasePath = working[0]!;
  const target = new Database(
    databasePath,
    sqliteConstants.SQLITE_OPEN_READWRITE | sqliteConstants.SQLITE_OPEN_NOFOLLOW,
  );
  let manifest: KiteSessionPreservationManifest;
  try {
    target.run('PRAGMA foreign_keys = ON');
    target.run('PRAGMA synchronous = FULL');
    // All source merges succeed together. A failure leaves only a disposable private candidate.
    target.transaction(() => {
      for (const path of working.slice(1)) {
        const source = new Database(
          path,
          sqliteConstants.SQLITE_OPEN_READONLY | sqliteConstants.SQLITE_OPEN_NOFOLLOW,
        );
        try {
          mergeKiteSessionStores10({ target, source });
        } finally {
          source.close(false);
        }
      }
      input.validate(target);
    })();
    manifest = captureKiteSessionPreservationManifest(target);
  } finally {
    target.close(false);
  }
  // Reopen the actual closed candidate, not only the connection used to create it.
  const verified = new Database(
    databasePath,
    sqliteConstants.SQLITE_OPEN_READONLY | sqliteConstants.SQLITE_OPEN_NOFOLLOW,
  );
  try {
    input.validate(verified);
    if (
      JSON.stringify(captureKiteSessionPreservationManifest(verified)) !== JSON.stringify(manifest)
    ) {
      throw new Error('Closed Store candidate differs from its validated content.');
    }
  } finally {
    verified.close(false);
  }
  for (const source of input.sources)
    assertKiteSessionExclusiveMaintenance(source.maintenance, source.databasePath);
  return Object.freeze({ databasePath, manifest, backups: Object.freeze(backups) });
}
