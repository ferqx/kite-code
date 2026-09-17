import { Database, constants as sqliteConstants } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertKiteSessionStoreSchema,
  initializeKiteSessionStoreIfNeeded,
} from '../src/kite-home-store';
import { acquireKiteSessionStoreMaintenance } from '../src/kite-session-maintenance';
import { captureKiteSessionPreservationManifest } from '../src/kite-session-preservation';
import { openKiteSessionRuntimeStorage } from '../src/kite-session-runtime-storage';
import { prepareKiteSessionStore } from '../src/kite-session-store-preparation';
import {
  captureKiteSessionPublicationSource,
  inspectKiteSessionPublication,
  publishVerifiedKiteSessionCandidate,
  resumeKiteSessionPublication,
} from '../src/kite-session-store-publication';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(withOldCanonical = true, withSidecars = false) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-publication-')));
  roots.push(root);
  const canonicalPath = join(root, 'kite-session.sqlite');
  const historicalPath = join(root, 'kite.sqlite');
  const migrationDirectory = join(
    root,
    'session-store-recovery',
    'migration-0123456789abcdef01234567',
  );
  const candidateDirectory = join(migrationDirectory, 'converted-0');
  mkdirSync(candidateDirectory, { recursive: true, mode: 0o700 });
  chmodSync(join(root, 'session-store-recovery'), 0o700);
  chmodSync(migrationDirectory, 0o700);
  chmodSync(candidateDirectory, 0o700);
  const candidatePath = join(candidateDirectory, 'kite-session.sqlite');
  using db = new Database(candidatePath, { strict: true });
  initializeKiteSessionStoreIfNeeded(db);
  db.run('PRAGMA journal_mode=DELETE');
  const candidateManifest = captureKiteSessionPreservationManifest(db);
  chmodSync(candidatePath, 0o600);
  writeFileSync(historicalPath, 'old historical bytes', { mode: 0o600 });
  if (withOldCanonical) writeFileSync(canonicalPath, 'old canonical bytes', { mode: 0o600 });
  if (withSidecars) {
    for (const path of [canonicalPath, historicalPath]) {
      writeFileSync(`${path}-wal`, 'old wal bytes', { mode: 0o600 });
      writeFileSync(`${path}-shm`, 'old shm bytes', { mode: 0o600 });
    }
  }
  const sourcePaths = [canonicalPath, historicalPath];
  const sources = sourcePaths.map((databasePath) => ({
    databasePath,
    files: captureKiteSessionPublicationSource(canonicalPath, databasePath),
    maintenance: acquireKiteSessionStoreMaintenance(databasePath, 'exclusive'),
  }));
  const validatePublished = (database: Database) => assertKiteSessionStoreSchema(database);
  const input = {
    canonicalPath,
    candidatePath,
    migrationDirectory,
    candidateManifest,
    canonicalMaintenance: sources[0]!.maintenance,
    sources,
    validatePublished,
  };
  return {
    root,
    canonicalPath,
    historicalPath,
    migrationDirectory,
    candidatePath,
    sources,
    input,
    validatePublished,
  };
}
function release(f: ReturnType<typeof fixture>) {
  for (const source of f.sources) source.maintenance.release();
}
function assertPublished(f: ReturnType<typeof fixture>) {
  expect(inspectKiteSessionPublication(f.canonicalPath).status).toBe('none');
  expect(existsSync(f.historicalPath)).toBe(false);
  expect(existsSync(f.candidatePath)).toBe(false);
  const db = new Database(f.canonicalPath, sqliteConstants.SQLITE_OPEN_READONLY);
  try {
    assertKiteSessionStoreSchema(db);
  } finally {
    db.close(false);
  }
  const retired = join(f.migrationDirectory, 'retired');
  expect(readdirSync(retired).length).toBe(2);
}

describe('Kite Session Store publication', () => {
  test('publishes a verified closed candidate and retires every old source', () => {
    const f = fixture();
    try {
      publishVerifiedKiteSessionCandidate(f.input);
      assertPublished(f);
    } finally {
      release(f);
    }
  });

  test('resumes every durable interruption without replacing a changed candidate', () => {
    const stages = [
      'intent_temp_write',
      'intent_temp_fsync',
      'intent_rename',
      'intent_directory_fsync',
      ...[0, 1].flatMap((source) =>
        ['main', 'wal', 'shm'].flatMap((part) =>
          ['source_rename', 'source_parent_fsync', 'retired_parent_fsync'].map(
            (operation) => `${operation}:${source}:${part}`,
          ),
        ),
      ),
      'candidate_rename',
      'candidate_parent_fsync',
      'canonical_parent_fsync',
      'intent_unlink',
      'intent_unlink_fsync',
    ];
    for (const stage of stages) {
      const f = fixture(true, true);
      try {
        expect(() =>
          publishVerifiedKiteSessionCandidate({
            ...f.input,
            fault: (point) => {
              if (point === stage) throw new Error(stage);
            },
          }),
        ).toThrow(stage);
        const inspection = inspectKiteSessionPublication(f.canonicalPath);
        if (stage === 'intent_temp_write' || stage === 'intent_temp_fsync') {
          expect(inspection.status).toBe('none');
          expect(readFileSync(f.historicalPath, 'utf8')).toBe('old historical bytes');
          continue;
        }
        if (inspection.status === 'pending') {
          release(f);
          const locks = f.sources.map(({ databasePath }) => ({
            databasePath,
            maintenance: acquireKiteSessionStoreMaintenance(databasePath, 'exclusive'),
          }));
          try {
            resumeKiteSessionPublication({
              canonicalPath: f.canonicalPath,
              canonicalMaintenance: locks[0]!.maintenance,
              sourceMaintenance: locks,
              validatePublished: f.validatePublished,
            });
          } finally {
            for (const entry of locks) entry.maintenance.release();
          }
        }
        assertPublished(f);
      } finally {
        release(f);
      }
    }
  });

  test('a production validation failure leaves an intent for maintenance retry', () => {
    const f = fixture(false);
    try {
      expect(() =>
        publishVerifiedKiteSessionCandidate({
          ...f.input,
          validatePublished: () => {
            throw new Error('reader rejected');
          },
        }),
      ).toThrow('reader rejected');
      expect(inspectKiteSessionPublication(f.canonicalPath).status).toBe('pending');
      resumeKiteSessionPublication({
        canonicalPath: f.canonicalPath,
        canonicalMaintenance: f.sources[0]!.maintenance,
        sourceMaintenance: f.sources,
        validatePublished: f.validatePublished,
      });
      assertPublished(f);
    } finally {
      release(f);
    }
  });

  test('a normal owner cannot create an empty canonical Store while publication is pending', () => {
    const f = fixture(false);
    try {
      expect(() =>
        publishVerifiedKiteSessionCandidate({
          ...f.input,
          fault: (point) => {
            if (point === 'source_rename:1:main') throw new Error('publication interrupted');
          },
        }),
      ).toThrow('publication interrupted');
      expect(inspectKiteSessionPublication(f.canonicalPath).status).toBe('pending');
      expect(existsSync(f.canonicalPath)).toBe(false);
    } finally {
      release(f);
    }
    expect(() =>
      openKiteSessionRuntimeStorage({
        databasePath: f.canonicalPath,
        // The pending-publication check must precede any codec-dependent Store opening.
        codec: {} as never,
        stateSchemaVersion: 1,
        formatEpoch: 'test',
      }),
    ).toThrow();
    expect(existsSync(f.canonicalPath)).toBe(false);
  });

  test('a normal owner cannot open the canonical Store while a historical source remains', () => {
    const f = fixture();
    release(f);
    expect(() =>
      openKiteSessionRuntimeStorage({
        databasePath: f.canonicalPath,
        codec: {} as never,
        stateSchemaVersion: 1,
        formatEpoch: 'test',
      }),
    ).toThrow('Historical session data');
    expect(readFileSync(f.canonicalPath, 'utf8')).toBe('old canonical bytes');
  });

  test('preparer rechecks a newly committed intent under exclusive maintenance', async () => {
    const f = fixture(false);
    let released = false;
    try {
      const result = await prepareKiteSessionStore({
        databasePath: f.canonicalPath,
        codec: {} as never,
        isSettledState: () => true,
        assertRetiredWritersStopped: () => undefined,
        onProgress(stage) {
          if (stage !== 'acquiring_maintenance') return;
          expect(() =>
            publishVerifiedKiteSessionCandidate({
              ...f.input,
              fault: (point) => {
                if (point === 'source_rename:1:main') throw new Error('publication interrupted');
              },
            }),
          ).toThrow('publication interrupted');
          release(f);
          released = true;
        },
      });
      expect(result.status).toBe('resumed');
      assertPublished(f);
    } finally {
      if (!released) release(f);
    }
  });

  test('rejects changed candidate and unknown retired files during resume', () => {
    const f = fixture();
    try {
      expect(() =>
        publishVerifiedKiteSessionCandidate({
          ...f.input,
          fault: (point) => {
            if (point === 'intent_directory_fsync') throw new Error('pause');
          },
        }),
      ).toThrow('pause');
      writeFileSync(f.candidatePath, 'changed', { mode: 0o600 });
      expect(() =>
        resumeKiteSessionPublication({
          canonicalPath: f.canonicalPath,
          canonicalMaintenance: f.sources[0]!.maintenance,
          sourceMaintenance: f.sources,
          validatePublished: f.validatePublished,
        }),
      ).toThrow();
      expect(readFileSync(f.historicalPath, 'utf8')).toBe('old historical bytes');
    } finally {
      release(f);
    }
  });

  test('rejects an unverified manifest before creating an intent', () => {
    const f = fixture();
    try {
      expect(() =>
        publishVerifiedKiteSessionCandidate({
          ...f.input,
          candidateManifest: {
            ...f.input.candidateManifest,
            tables: {},
          },
        }),
      ).toThrow('validated manifest');
      expect(inspectKiteSessionPublication(f.canonicalPath).status).toBe('none');
      expect(readFileSync(f.historicalPath, 'utf8')).toBe('old historical bytes');
    } finally {
      release(f);
    }
  });

  test('rejects an unknown retired file instead of overwriting it', () => {
    const f = fixture();
    try {
      expect(() =>
        publishVerifiedKiteSessionCandidate({
          ...f.input,
          fault: (point) => {
            if (point === 'intent_directory_fsync') throw new Error('pause');
          },
        }),
      ).toThrow('pause');
      const unknown = join(f.migrationDirectory, 'retired', 'source0', 'unknown');
      mkdirSync(join(f.migrationDirectory, 'retired', 'source0'), {
        recursive: true,
        mode: 0o700,
      });
      writeFileSync(unknown, 'conflict', { mode: 0o600 });
      expect(() =>
        resumeKiteSessionPublication({
          canonicalPath: f.canonicalPath,
          canonicalMaintenance: f.sources[0]!.maintenance,
          sourceMaintenance: f.sources,
          validatePublished: f.validatePublished,
        }),
      ).toThrow('Unknown retired source file');
      expect(readFileSync(unknown, 'utf8')).toBe('conflict');
    } finally {
      release(f);
    }
  });

  test('a partial staging write never becomes startup admission state', () => {
    const f = fixture();
    try {
      expect(() =>
        publishVerifiedKiteSessionCandidate({
          ...f.input,
          fault: (point) => {
            if (point === 'intent_temp_write') {
              writeFileSync(join(f.migrationDirectory, 'publication-stage.json'), '{partial', {
                mode: 0o600,
              });
              throw new Error('ENOSPC');
            }
          },
        }),
      ).toThrow('ENOSPC');
      expect(inspectKiteSessionPublication(f.canonicalPath).status).toBe('none');
      expect(readFileSync(f.historicalPath, 'utf8')).toBe('old historical bytes');
      expect(readFileSync(f.canonicalPath, 'utf8')).toBe('old canonical bytes');
    } finally {
      release(f);
    }
  });
});
