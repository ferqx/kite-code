import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  createSqliteRuntimeCompatibilityWriter,
  discoverSqliteRuntimeCompatibilitySource,
  SQLITE_RUNTIME_COMPATIBILITY_SOURCE_PROFILES,
  SQLITE_RUNTIME_FORMAT_EPOCH,
  SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
  SQLITE_RUNTIME_STORE_SCHEMA_VERSION,
  type SqliteRuntimeCompatibilitySession,
  type SqliteRuntimeCompatibilityTargetSession,
  sqliteCurrentRuntimeStorePath,
  sqliteRuntimeStorePathForEpoch,
} from '../src/index';
import { checksum } from '../src/preflight';

const legacyEpoch = 'kite-runtime-modularization-v1-2026-08-19';

function temporaryDirectory(): { path: string; cleanup(): void } {
  const path = mkdtempSync(join(process.cwd(), '.kite-compat-'));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

function createStore(path: string, profile = { state: 26, epoch: legacyEpoch }): void {
  const db = new Database(path);
  db.run('CREATE TABLE runtime_store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.run(
    'CREATE TABLE runtime_events (session_id TEXT NOT NULL, event_id TEXT NOT NULL, sequence INTEGER NOT NULL, schema_version INTEGER NOT NULL, event_json TEXT NOT NULL, causation_id TEXT, occurred_at TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (session_id, event_id), UNIQUE (session_id, sequence))',
  );
  db.run(
    "CREATE TABLE runtime_sessions (session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace_digest TEXT NOT NULL, state_schema INTEGER NOT NULL, format_epoch TEXT NOT NULL, revision INTEGER NOT NULL, name TEXT NOT NULL DEFAULT '', model_provider TEXT, model_name TEXT, updated_at INTEGER NOT NULL DEFAULT (unixepoch()))",
  );
  db.run(
    "CREATE TABLE runtime_snapshots (session_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, format_epoch TEXT NOT NULL, revision INTEGER NOT NULL, state_json TEXT NOT NULL, event_position INTEGER NOT NULL DEFAULT 0, state_checksum TEXT NOT NULL DEFAULT '', created_at INTEGER DEFAULT (unixepoch()))",
  );
  db.run(
    'CREATE TABLE runtime_named_snapshots (session_id TEXT NOT NULL, name TEXT NOT NULL, schema_version INTEGER NOT NULL, format_epoch TEXT NOT NULL, revision INTEGER NOT NULL, state_json TEXT NOT NULL, event_position INTEGER NOT NULL DEFAULT 0, state_checksum TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), PRIMARY KEY (session_id, name))',
  );
  db.run(
    'CREATE TABLE runtime_file_preimages (session_id TEXT NOT NULL, path TEXT NOT NULL, event_position INTEGER NOT NULL DEFAULT 0, content TEXT, existed INTEGER NOT NULL DEFAULT 1, post_hash TEXT, post_existed INTEGER, created_at INTEGER DEFAULT (unixepoch()), PRIMARY KEY (session_id, path, event_position))',
  );
  db.run(
    "CREATE TABLE runtime_effect_leases (session_id TEXT NOT NULL, effect_id TEXT NOT NULL, owner_id TEXT NOT NULL, lease_revision INTEGER NOT NULL DEFAULT 0, certainty TEXT NOT NULL DEFAULT 'certain', expires_at_ms INTEGER NOT NULL, PRIMARY KEY (session_id, effect_id))",
  );
  db.run('CREATE INDEX runtime_events_session_sequence ON runtime_events(session_id, sequence)');
  db.run(
    'CREATE INDEX runtime_file_preimages_position ON runtime_file_preimages(session_id, event_position)',
  );
  db.run("INSERT INTO runtime_store_meta (key, value) VALUES ('format_version', ?)", [
    String(SQLITE_RUNTIME_STORE_SCHEMA_VERSION),
  ]);
  db.run("INSERT INTO runtime_store_meta (key, value) VALUES ('runtime_format_epoch', ?)", [
    profile.epoch,
  ]);

  const state = JSON.stringify({ schemaVersion: profile.state, revision: 1, sessionId: 'legacy' });
  db.run(
    'INSERT INTO runtime_sessions (session_id, project_id, workspace_digest, state_schema, format_epoch, revision, name) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['legacy', 'project', 'workspace', profile.state, profile.epoch, 1, 'legacy name'],
  );
  db.run(
    'INSERT INTO runtime_snapshots (session_id, schema_version, format_epoch, revision, state_json, event_position, state_checksum) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['legacy', profile.state, profile.epoch, 1, state, 1, checksum(state)],
  );
  db.run(
    'INSERT INTO runtime_events (session_id, event_id, sequence, schema_version, event_json, causation_id, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      'legacy',
      'legacy-event',
      1,
      profile.state,
      JSON.stringify({ type: 'message', text: 'hello' }),
      null,
      null,
      1,
    ],
  );
  db.close();
}

function readBytes(path: string): Uint8Array {
  return readFileSync(path);
}

function currentTargetFromSource(
  input: SqliteRuntimeCompatibilitySession,
): SqliteRuntimeCompatibilityTargetSession {
  return {
    sessionId: input.session.sessionId,
    projectId: input.session.projectId,
    workspaceDigest: input.session.workspaceDigest,
    name: input.session.name,
    revision: input.snapshot.revision,
    eventPosition: input.snapshot.eventPosition,
    stateJson: JSON.stringify({
      schemaVersion: 27,
      revision: 1,
      sessionId: input.session.sessionId,
    }),
    events: input.events.map((event) => ({
      eventId: event.eventId,
      sequence: event.sequence,
      schemaVersion: 27,
      eventJson: event.eventJson,
      causationId: event.causationId,
      occurredAt: event.occurredAt,
      createdAt: event.createdAt,
    })),
  };
}

describe('SQLite compatibility store', () => {
  test('uses one stable current path and keeps the legacy path contract', () => {
    const checkpoint = '/tmp/checkpoints.sqlite';
    const current = sqliteCurrentRuntimeStorePath(checkpoint);
    expect(current).toBe(sqliteCurrentRuntimeStorePath(checkpoint));
    expect(current).not.toMatch(/state-(?:26|27)|store-(?:4|5)/u);
    expect(current).not.toBe(
      `${checkpoint.replace(/\.sqlite$/u, '')}.runtime-state-store.db.legacy`,
    );
    expect(current).not.toBe(sqliteRuntimeStorePathForEpoch(checkpoint, legacyEpoch));
  });

  test('silently ignores an unknown source profile', () => {
    const fixture = temporaryDirectory();
    try {
      const path = join(fixture.path, 'unknown.db');
      createStore(path, { state: 99, epoch: 'future-epoch' });
      expect(discoverSqliteRuntimeCompatibilitySource(path)).toBeNull();
      expect(discoverSqliteRuntimeCompatibilitySource(join(fixture.path, 'missing.db'))).toBeNull();
    } finally {
      fixture.cleanup();
    }
  });

  test('discovers a known source, imports lazily, and is exactly-once without changing source bytes', () => {
    const fixture = temporaryDirectory();
    try {
      const sourcePath = join(fixture.path, 'legacy.db');
      const targetPath = join(fixture.path, 'current.db');
      createStore(sourcePath);
      const sourceDb = new Database(sourcePath);
      const namedState = JSON.stringify({ schemaVersion: 26, revision: 1, sessionId: 'legacy' });
      sourceDb.run(
        'INSERT INTO runtime_named_snapshots (session_id, name, schema_version, format_epoch, revision, state_json, event_position, state_checksum, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ['legacy', 'checkpoint', 26, legacyEpoch, 1, namedState, 1, checksum(namedState), 1],
      );
      sourceDb.run(
        'INSERT INTO runtime_file_preimages (session_id, path, event_position, content, existed, post_hash, post_existed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ['legacy', 'file.txt', 1, 'before', 1, 'after-hash', 1, 1],
      );
      sourceDb.run(
        'INSERT INTO runtime_effect_leases (session_id, effect_id, owner_id, lease_revision, certainty, expires_at_ms) VALUES (?, ?, ?, ?, ?, ?)',
        ['legacy', 'effect-1', 'owner-1', 1, 'certain', 999999],
      );
      sourceDb.close();
      const before = readBytes(sourcePath);
      const source = discoverSqliteRuntimeCompatibilitySource(sourcePath);
      expect(source).not.toBeNull();
      expect(source?.listSessions()).toEqual([
        expect.objectContaining({ sessionId: 'legacy', stateSchemaVersion: 26 }),
      ]);
      const writer = createSqliteRuntimeCompatibilityWriter({
        databasePath: targetPath,
        profile: {
          storeSchemaVersion: SQLITE_RUNTIME_STORE_SCHEMA_VERSION,
          stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
          formatEpoch: SQLITE_RUNTIME_FORMAT_EPOCH,
        },
      });
      const migrate = (
        input: NonNullable<typeof source> extends infer Source
          ? Source extends { readSession: (id: string) => infer Session }
            ? Session
            : never
          : never,
      ) => {
        if (!input) return null;
        return {
          sessionId: input.session.sessionId,
          projectId: input.session.projectId,
          workspaceDigest: input.session.workspaceDigest,
          name: input.session.name,
          revision: input.snapshot.revision,
          eventPosition: input.snapshot.eventPosition,
          stateJson: JSON.stringify({ schemaVersion: 27, revision: 1, sessionId: 'legacy' }),
          events: input.events.map((event) => ({
            ...event,
            schemaVersion: 27,
            eventJson: JSON.stringify({ ...JSON.parse(event.eventJson), migrated: true }),
          })),
          namedSnapshots: input.namedSnapshots.map((named) => ({
            ...named,
            schemaVersion: 27,
            formatEpoch: SQLITE_RUNTIME_FORMAT_EPOCH,
            stateJson: JSON.stringify({ schemaVersion: 27, revision: 1, sessionId: 'legacy' }),
            stateChecksum: checksum(
              JSON.stringify({ schemaVersion: 27, revision: 1, sessionId: 'legacy' }),
            ),
          })),
          filePreimages: input.filePreimages,
        };
      };
      expect(writer.importSession(source!, 'legacy', migrate)).toMatchObject({
        status: 'imported',
      });
      expect(writer.importSession(source!, 'legacy', migrate)).toMatchObject({
        status: 'already_imported',
      });
      writer.close();
      source?.close();
      expect(readBytes(sourcePath)).toEqual(before);

      const db = new Database(targetPath, { readonly: true });
      expect(db.query('SELECT COUNT(*) AS count FROM runtime_sessions').get()).toEqual({
        count: 1,
      });
      expect(db.query('SELECT COUNT(*) AS count FROM runtime_events').get()).toEqual({ count: 1 });
      expect(db.query('SELECT COUNT(*) AS count FROM runtime_named_snapshots').get()).toEqual({
        count: 1,
      });
      expect(db.query('SELECT COUNT(*) AS count FROM runtime_file_preimages').get()).toEqual({
        count: 1,
      });
      expect(db.query('SELECT COUNT(*) AS count FROM runtime_effect_leases').get()).toEqual({
        count: 0,
      });
      expect(
        db
          .query(
            "SELECT COUNT(*) AS count FROM runtime_store_meta WHERE key LIKE 'compat_migration_v1:%'",
          )
          .get(),
      ).toEqual({ count: 1 });
      db.close();
    } finally {
      fixture.cleanup();
    }
  });

  test('isolates malformed sessions and rolls back a failed session import', () => {
    const fixture = temporaryDirectory();
    try {
      const sourcePath = join(fixture.path, 'legacy.db');
      const targetPath = join(fixture.path, 'current.db');
      createStore(sourcePath);
      const db = new Database(sourcePath);
      db.run(
        'INSERT INTO runtime_sessions (session_id, project_id, workspace_digest, state_schema, format_epoch, revision) VALUES (?, ?, ?, ?, ?, ?)',
        ['broken', 'p', 'w', 26, legacyEpoch, 1],
      );
      db.run(
        'INSERT INTO runtime_snapshots (session_id, schema_version, format_epoch, revision, state_json, event_position, state_checksum) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ['broken', 26, legacyEpoch, 1, '{not json', 0, ''],
      );
      db.close();
      const source = discoverSqliteRuntimeCompatibilitySource(sourcePath)!;
      expect(source.listSessions().map((session) => session.sessionId)).toEqual([
        'legacy',
        'broken',
      ]);
      const writer = createSqliteRuntimeCompatibilityWriter({
        databasePath: targetPath,
        profile: {
          storeSchemaVersion: SQLITE_RUNTIME_STORE_SCHEMA_VERSION,
          stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
          formatEpoch: SQLITE_RUNTIME_FORMAT_EPOCH,
        },
      });
      const result = writer.importSession(source, 'legacy', () => {
        throw new Error('migration failed');
      });
      expect(result).toMatchObject({ status: 'failed' });
      expect(writer.importSession(source, 'broken', () => null)).toMatchObject({
        status: 'failed',
      });
      const target = new Database(targetPath, { readonly: true });
      expect(target.query('SELECT COUNT(*) AS count FROM runtime_sessions').get()).toEqual({
        count: 0,
      });
      expect(target.query('SELECT COUNT(*) AS count FROM runtime_events').get()).toEqual({
        count: 0,
      });
      target.close();
      writer.close();
      source.close();
    } finally {
      fixture.cleanup();
    }
  });

  test('rejects bad target checksums, schemas, and sequence boundaries before writing', () => {
    const fixture = temporaryDirectory();
    try {
      const sourcePath = join(fixture.path, 'legacy.db');
      const targetPath = join(fixture.path, 'current.db');
      createStore(sourcePath);
      const source = discoverSqliteRuntimeCompatibilitySource(sourcePath)!;
      const writer = createSqliteRuntimeCompatibilityWriter({ databasePath: targetPath });
      let variant: 'checksum' | 'schema' | 'sequence' | 'named' | 'preimage' = 'checksum';
      const migrate = (input: SqliteRuntimeCompatibilitySession) => {
        const target = currentTargetFromSource(input);
        if (variant === 'checksum') return { ...target, stateChecksum: 'wrong' };
        if (variant === 'schema') {
          return {
            ...target,
            events: target.events.map((event) => ({ ...event, schemaVersion: 999 })),
          };
        }
        if (variant === 'named') {
          return {
            ...target,
            namedSnapshots: [
              {
                name: 'future',
                schemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
                formatEpoch: SQLITE_RUNTIME_FORMAT_EPOCH,
                revision: 2,
                eventPosition: 2,
                stateJson: target.stateJson,
                stateChecksum: checksum(target.stateJson),
                createdAt: 1,
              },
            ],
          };
        }
        if (variant === 'preimage') {
          return {
            ...target,
            filePreimages: [
              {
                path: 'outside.txt',
                eventPosition: 2,
                content: 'before',
                existed: true,
                postHash: null,
                postExisted: null,
                createdAt: 1,
              },
            ],
          };
        }
        return {
          ...target,
          revision: 2,
          eventPosition: 2,
          events: target.events.map((event) => ({ ...event, sequence: 2 })),
        };
      };
      expect(writer.importSession(source, 'legacy', migrate)).toMatchObject({ status: 'failed' });
      variant = 'schema';
      expect(writer.importSession(source, 'legacy', migrate)).toMatchObject({ status: 'failed' });
      variant = 'sequence';
      expect(writer.importSession(source, 'legacy', migrate)).toMatchObject({ status: 'failed' });
      variant = 'named';
      expect(writer.importSession(source, 'legacy', migrate)).toMatchObject({ status: 'failed' });
      variant = 'preimage';
      expect(writer.importSession(source, 'legacy', migrate)).toMatchObject({ status: 'failed' });
      const target = new Database(targetPath, { readonly: true });
      expect(target.query('SELECT COUNT(*) AS count FROM runtime_sessions').get()).toEqual({
        count: 0,
      });
      expect(
        target
          .query(
            "SELECT COUNT(*) AS count FROM runtime_store_meta WHERE key LIKE 'compat_migration_v1:%'",
          )
          .get(),
      ).toEqual({ count: 0 });
      target.close();
      writer.close();
      source.close();
    } finally {
      fixture.cleanup();
    }
  });

  test('repairs a missing target session when its ledger remains, without overwriting an existing session', () => {
    const fixture = temporaryDirectory();
    try {
      const sourcePath = join(fixture.path, 'legacy.db');
      const targetPath = join(fixture.path, 'current.db');
      createStore(sourcePath);
      const source = discoverSqliteRuntimeCompatibilitySource(sourcePath)!;
      const migrate = (input: SqliteRuntimeCompatibilitySession) => currentTargetFromSource(input);
      const firstWriter = createSqliteRuntimeCompatibilityWriter({ databasePath: targetPath });
      expect(firstWriter.importSession(source, 'legacy', migrate)).toMatchObject({
        status: 'imported',
      });
      firstWriter.close();
      const damaged = new Database(targetPath);
      for (const table of [
        'runtime_events',
        'runtime_snapshots',
        'runtime_named_snapshots',
        'runtime_file_preimages',
        'runtime_effect_leases',
        'runtime_sessions',
      ]) {
        damaged.run(`DELETE FROM ${table} WHERE session_id = 'legacy'`);
      }
      damaged.close();
      const repairWriter = createSqliteRuntimeCompatibilityWriter({ databasePath: targetPath });
      expect(repairWriter.importSession(source, 'legacy', migrate)).toMatchObject({
        status: 'imported',
      });
      const existing = new Database(targetPath);
      existing.run(
        "UPDATE runtime_sessions SET name = 'locally edited' WHERE session_id = 'legacy'",
      );
      existing.close();
      expect(repairWriter.importSession(source, 'legacy', migrate)).toMatchObject({
        status: 'already_imported',
      });
      const check = new Database(targetPath, { readonly: true });
      expect(
        check.query("SELECT name FROM runtime_sessions WHERE session_id = 'legacy'").get(),
      ).toEqual({
        name: 'locally edited',
      });
      check.close();
      repairWriter.close();
      source.close();
    } finally {
      fixture.cleanup();
    }
  });

  test('rolls back SQL failures after partial row insertion', () => {
    const fixture = temporaryDirectory();
    try {
      const sourcePath = join(fixture.path, 'legacy.db');
      const targetPath = join(fixture.path, 'current.db');
      createStore(sourcePath);
      const source = discoverSqliteRuntimeCompatibilitySource(sourcePath)!;
      const writer = createSqliteRuntimeCompatibilityWriter({ databasePath: targetPath });
      const migrate = (input: SqliteRuntimeCompatibilitySession) => {
        const target = currentTargetFromSource(input);
        const firstEvent = target.events[0]!;
        return {
          ...target,
          revision: 2,
          eventPosition: 2,
          events: [
            ...target.events,
            {
              eventId: firstEvent.eventId,
              sequence: 2,
              schemaVersion: firstEvent.schemaVersion,
              eventJson: firstEvent.eventJson,
              causationId: firstEvent.causationId,
              occurredAt: firstEvent.occurredAt,
              createdAt: firstEvent.createdAt,
            },
          ],
        };
      };
      expect(writer.importSession(source, 'legacy', migrate)).toMatchObject({ status: 'failed' });
      const target = new Database(targetPath, { readonly: true });
      expect(target.query('SELECT COUNT(*) AS count FROM runtime_sessions').get()).toEqual({
        count: 0,
      });
      expect(target.query('SELECT COUNT(*) AS count FROM runtime_events').get()).toEqual({
        count: 0,
      });
      expect(
        target
          .query(
            "SELECT COUNT(*) AS count FROM runtime_store_meta WHERE key LIKE 'compat_migration_v1:%'",
          )
          .get(),
      ).toEqual({ count: 0 });
      target.close();
      writer.close();
      source.close();
    } finally {
      fixture.cleanup();
    }
  });

  test('recognizes both supported source profiles while retaining unknown-format silence', () => {
    expect(SQLITE_RUNTIME_COMPATIBILITY_SOURCE_PROFILES).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ storeSchemaVersion: 5, stateSchemaVersion: 26 }),
        expect.objectContaining({ storeSchemaVersion: 5, stateSchemaVersion: 27 }),
      ]),
    );
  });

  test('reads an existing WAL and SHM only through an isolated snapshot', () => {
    const fixture = temporaryDirectory();
    let liveWriter: Database | undefined;
    try {
      const livePath = join(fixture.path, 'live-wal.db');
      const sourcePath = join(fixture.path, 'copied-wal.db');
      createStore(livePath);
      liveWriter = new Database(livePath);
      liveWriter.run('PRAGMA journal_mode = WAL');
      liveWriter.run(
        'INSERT INTO runtime_sessions (session_id, project_id, workspace_digest, state_schema, format_epoch, revision, name) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ['wal-session', 'p', 'w', 26, legacyEpoch, 1, 'wal'],
      );
      liveWriter.run('PRAGMA wal_checkpoint(TRUNCATE)');
      expect(existsSync(`${livePath}-wal`)).toBe(true);
      expect(existsSync(`${livePath}-shm`)).toBe(true);
      copyFileSync(livePath, sourcePath);
      copyFileSync(`${livePath}-wal`, `${sourcePath}-wal`);
      copyFileSync(`${livePath}-shm`, `${sourcePath}-shm`);
      const paths = [sourcePath, `${sourcePath}-wal`, `${sourcePath}-shm`];
      const before = paths.map((path) => ({
        bytes: readBytes(path),
        mtimeMs: statSync(path).mtimeMs,
      }));

      const source = discoverSqliteRuntimeCompatibilitySource(sourcePath);
      expect(source?.listSessions().map((session) => session.sessionId)).toContain('wal-session');
      source?.close();
      for (const [index, path] of paths.entries()) {
        const expected = before[index];
        if (!expected) throw new Error(`Missing source fingerprint for ${path}.`);
        expect(readBytes(path)).toEqual(expected.bytes);
        expect(statSync(path).mtimeMs).toBe(expected.mtimeMs);
      }
    } finally {
      liveWriter?.close();
      fixture.cleanup();
    }
  });

  test('rebuilds a missing source SHM only in an isolated WAL snapshot', () => {
    const fixture = temporaryDirectory();
    let liveWriter: Database | undefined;
    try {
      const livePath = join(fixture.path, 'live-legacy.db');
      const sourcePath = join(fixture.path, 'copied-legacy.db');
      const targetPath = join(fixture.path, 'current.db');
      createStore(livePath);
      liveWriter = new Database(livePath);
      liveWriter.run('PRAGMA journal_mode = WAL');
      liveWriter.run(
        "UPDATE runtime_sessions SET name = 'name-from-wal' WHERE session_id = 'legacy'",
      );
      expect(existsSync(`${livePath}-wal`)).toBe(true);
      copyFileSync(livePath, sourcePath);
      copyFileSync(`${livePath}-wal`, `${sourcePath}-wal`);
      expect(existsSync(`${sourcePath}-shm`)).toBe(false);
      const databaseBefore = readBytes(sourcePath);
      const walBefore = readBytes(`${sourcePath}-wal`);

      const source = discoverSqliteRuntimeCompatibilitySource(sourcePath);
      expect(source?.listSessions()).toEqual([
        expect.objectContaining({ sessionId: 'legacy', name: 'name-from-wal' }),
      ]);
      const writer = createSqliteRuntimeCompatibilityWriter({ databasePath: targetPath });
      expect(
        source && writer.importSession(source, 'legacy', (input) => currentTargetFromSource(input)),
      ).toMatchObject({ status: 'imported' });
      writer.close();
      source?.close();

      expect(readBytes(sourcePath)).toEqual(databaseBefore);
      expect(readBytes(`${sourcePath}-wal`)).toEqual(walBefore);
      expect(existsSync(`${sourcePath}-shm`)).toBe(false);
    } finally {
      liveWriter?.close();
      fixture.cleanup();
    }
  });

  test('suppresses a source session across source deletion and reappearance', () => {
    const fixture = temporaryDirectory();
    try {
      const sourcePath = join(fixture.path, 'legacy.db');
      const targetPath = join(fixture.path, 'current.db');
      createStore(sourcePath);
      const source = discoverSqliteRuntimeCompatibilitySource(sourcePath)!;
      const writer = createSqliteRuntimeCompatibilityWriter({ databasePath: targetPath });
      expect(writer.suppressSession(source, 'legacy')).toBe(true);
      expect(writer.isSessionSuppressed(source, 'legacy')).toBe(true);
      expect(
        writer.importSession(source, 'legacy', (input) => currentTargetFromSource(input)),
      ).toMatchObject({ status: 'ignored' });
      source.close();
      rmSync(sourcePath);
      createStore(sourcePath);
      const reappeared = discoverSqliteRuntimeCompatibilitySource(sourcePath)!;
      expect(writer.isSessionSuppressed(reappeared, 'legacy')).toBe(true);
      expect(
        writer.importSession(reappeared, 'legacy', (input) => currentTargetFromSource(input)),
      ).toMatchObject({ status: 'ignored' });
      expect(writer.clearSessionSuppression(reappeared, 'legacy')).toBe(true);
      expect(
        writer.importSession(reappeared, 'legacy', (input) => currentTargetFromSource(input)),
      ).toMatchObject({ status: 'imported' });
      reappeared.close();
      writer.close();
    } finally {
      fixture.cleanup();
    }
  });

  test('stops using a source connection after its path is replaced', () => {
    const fixture = temporaryDirectory();
    try {
      const sourcePath = join(fixture.path, 'legacy.db');
      createStore(sourcePath);
      const source = discoverSqliteRuntimeCompatibilitySource(sourcePath)!;
      rmSync(sourcePath);
      createStore(sourcePath, { state: 99, epoch: 'future-epoch' });
      expect(source.listSessions()).toEqual([]);
      expect(source.readSession('legacy')).toBeNull();
      source.close();
    } finally {
      fixture.cleanup();
    }
  });

  test('does not open or rewrite an unknown existing target', () => {
    const fixture = temporaryDirectory();
    try {
      const targetPath = join(fixture.path, 'unknown-target.db');
      createStore(targetPath, { state: 99, epoch: 'future-epoch' });
      const before = readBytes(targetPath);
      const writer = createSqliteRuntimeCompatibilityWriter({ databasePath: targetPath });
      expect(writer.available).toBe(false);
      writer.close();
      expect(readBytes(targetPath)).toEqual(before);
    } finally {
      fixture.cleanup();
    }
  });

  test('reopens a current target when WAL exists without a copied SHM file', () => {
    const fixture = temporaryDirectory();
    let live: Database | undefined;
    try {
      const livePath = join(fixture.path, 'live-current.db');
      const targetPath = join(fixture.path, 'copied-current.db');
      createStore(livePath, {
        state: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
        epoch: SQLITE_RUNTIME_FORMAT_EPOCH,
      });
      live = new Database(livePath);
      live.run('PRAGMA journal_mode = WAL');
      live.run(
        "INSERT OR REPLACE INTO runtime_store_meta (key, value) VALUES ('compat_test_marker', '1')",
      );
      expect(existsSync(`${livePath}-wal`)).toBe(true);
      expect(existsSync(`${livePath}-shm`)).toBe(true);

      // This is a valid SQLite WAL recovery shape: the SHM file is an
      // ephemeral index and may be absent after a copy/restart. The target
      // classifier must rebuild it in an isolated preflight view instead of
      // declaring the current Store unknown.
      copyFileSync(livePath, targetPath);
      copyFileSync(`${livePath}-wal`, `${targetPath}-wal`);
      expect(existsSync(`${targetPath}-shm`)).toBe(false);

      const writer = createSqliteRuntimeCompatibilityWriter({ databasePath: targetPath });
      expect(writer.available).toBe(true);
      writer.close();
    } finally {
      live?.close();
      fixture.cleanup();
    }
  });

  test('requires an explicit source profile policy before accepting an empty snapshot checksum', () => {
    const fixture = temporaryDirectory();
    try {
      const sourcePath = join(fixture.path, 'empty-checksum.db');
      createStore(sourcePath);
      const db = new Database(sourcePath);
      db.run("UPDATE runtime_snapshots SET state_checksum = '' WHERE session_id = 'legacy'");
      db.close();
      const strict = discoverSqliteRuntimeCompatibilitySource(sourcePath);
      expect(strict?.readSession('legacy')).toBeNull();
      strict?.close();
      const explicitlyLegacy = discoverSqliteRuntimeCompatibilitySource(sourcePath, [
        {
          storeSchemaVersion: 5,
          stateSchemaVersion: 26,
          formatEpoch: legacyEpoch,
          allowMissingSnapshotChecksum: true,
        },
      ]);
      expect(explicitlyLegacy?.readSession('legacy')).not.toBeNull();
      explicitlyLegacy?.close();
    } finally {
      fixture.cleanup();
    }
  });
});
