import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  createSqliteRuntimeStorage,
  SqliteRuntimeFormatIncompatibleError,
} from '../src/sqlite-store';
import {
  createSqliteRuntimeStorageV5,
  SQLITE_RUNTIME_FORMAT_EPOCH_V2,
  SQLITE_RUNTIME_STATE26_SCHEMA_VERSION,
  SQLITE_RUNTIME_STORE5_SCHEMA_VERSION,
  sqliteRuntimeStorePathForV2,
} from '../src/store5';

type Event = { type: string };
type State = {
  schemaVersion: 26;
  formatEpoch: string;
  revision: number;
  session: {
    threadId: string;
    projectId: string;
    canonicalWorkspaceDigest: string;
  };
};

const codec = {
  encodeEvent: JSON.stringify,
  decodeEvent: (json: string) => JSON.parse(json) as Event,
  encodeState: JSON.stringify,
  decodeState: <T>(json: string) => JSON.parse(json) as T,
  snapshotMetadata: (state: State) => ({ stateRevision: state.revision, schemaVersion: 26 }),
  sessionIdentity: (state: State) => ({
    projectId: state.session.projectId,
    canonicalWorkspaceDigest: state.session.canonicalWorkspaceDigest,
  }),
  validateSnapshot: (input: {
    state: State;
    sessionId: string;
    stateRevision: number;
    schemaVersion: number;
    eventRevision: number;
  }) => {
    if (
      input.state.session.threadId !== input.sessionId ||
      input.state.schemaVersion !== 26 ||
      input.state.formatEpoch !== SQLITE_RUNTIME_FORMAT_EPOCH_V2 ||
      input.stateRevision !== input.state.revision ||
      input.schemaVersion !== 26 ||
      input.eventRevision !== input.state.revision
    ) {
      throw new Error('invalid current snapshot');
    }
  },
  rebindForkState: (state: State, sessionId: string) => ({
    ...state,
    session: { ...state.session, threadId: sessionId },
  }),
};

function state(threadId: string, revision = 1): State {
  return {
    schemaVersion: 26,
    formatEpoch: SQLITE_RUNTIME_FORMAT_EPOCH_V2,
    revision,
    session: {
      threadId,
      projectId: `project_${threadId}`,
      canonicalWorkspaceDigest: `sha256:${'a'.repeat(64)}`,
    },
  };
}

function temporaryDatabase(): { path: string; cleanup(): void } {
  const directory = mkdtempSync(join(process.cwd(), '.kite-store5-'));
  return {
    path: join(directory, 'runtime.db'),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

describe('State26/Store5 production format', () => {
  test('publishes the current profile and a separate path', () => {
    expect(SQLITE_RUNTIME_STATE26_SCHEMA_VERSION).toBe(26);
    expect(SQLITE_RUNTIME_STORE5_SCHEMA_VERSION).toBe(5);
    expect(SQLITE_RUNTIME_FORMAT_EPOCH_V2).toBe('kite-runtime-modularization-v1-2026-08-19');
    expect(sqliteRuntimeStorePathForV2('/tmp/checkpoints.sqlite')).toBe(
      '/tmp/checkpoints.runtime-state26-store5.db',
    );
  });

  test('creates only the seven runtime tables and two indexes', () => {
    const fixture = temporaryDatabase();
    try {
      const storage = createSqliteRuntimeStorageV5<Event, State>({
        databasePath: fixture.path,
        codec,
        options: { journalMode: 'delete' },
      });
      storage.close();
      const database = new Database(fixture.path, { readonly: true });
      const tables = database
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all()
        .map((row) => row.name);
      const indexes = database
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_autoindex_%' ORDER BY name",
        )
        .all()
        .map((row) => row.name);
      database.close();
      expect(tables).toEqual([
        'runtime_effect_leases',
        'runtime_events',
        'runtime_file_preimages',
        'runtime_named_snapshots',
        'runtime_sessions',
        'runtime_snapshots',
        'runtime_store_meta',
      ]);
      expect(indexes).toEqual([
        'runtime_events_session_sequence',
        'runtime_file_preimages_position',
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  test('persists, reopens and forks current state without authority side tables', () => {
    const fixture = temporaryDatabase();
    try {
      const first = createSqliteRuntimeStorageV5<Event, State>({
        databasePath: fixture.path,
        codec,
        options: { journalMode: 'delete' },
      });
      const source = state('source');
      first.transactions.commitDecision({
        sessionId: 'source',
        events: [{ type: 'committed' }],
        snapshot: source,
        metadata: [{ eventId: 'event-1', revision: 1 }],
      });
      first.checkpoints.saveNamedSnapshot('source', 'checkpoint', source, 1);
      expect(first.checkpoints.forkSession('source', 'checkpoint', 'fork', 'f'.repeat(64))).toBe(
        true,
      );
      first.close();

      const reopened = createSqliteRuntimeStorageV5<Event, State>({
        databasePath: fixture.path,
        codec,
        options: { journalMode: 'delete' },
      });
      expect(reopened.sessions.loadSnapshot<State>('source')).toEqual(source);
      expect(reopened.sessions.loadEventsStrict('fork')).toHaveLength(1);
      expect(reopened.sessions.loadSnapshot<State>('fork')).toMatchObject({
        session: { threadId: 'fork' },
      });
      reopened.close();
    } finally {
      fixture.cleanup();
    }
  });

  test('rejects legacy metadata before a transaction creates current rows', () => {
    const storage = createSqliteRuntimeStorageV5<Event, State>({ databasePath: ':memory:', codec });
    expect(() =>
      storage.transactions.commitDecision({
        sessionId: 'legacy-metadata',
        events: [],
        snapshot: state('legacy-metadata', 0),
        snapshotMetadata: {
          eventPosition: 0,
          stateRevision: 0,
          stateChecksum: '',
          schemaVersion: 25,
        },
      }),
    ).toThrow(/Runtime format is incompatible/u);
    expect(storage.sessions.loadSnapshot('legacy-metadata')).toBeNull();
    storage.close();
  });

  test('distinguishes a truly fresh database from corrupt or missing current snapshots', () => {
    const fixture = temporaryDatabase();
    try {
      const first = createSqliteRuntimeStorageV5<Event, State>({
        databasePath: fixture.path,
        codec,
        options: { journalMode: 'delete' },
      });
      first.transactions.commitDecision({
        sessionId: 'corrupt',
        events: [{ type: 'committed' }],
        snapshot: state('corrupt'),
        metadata: [{ eventId: 'event-1', revision: 1 }],
      });
      first.close();
      const database = new Database(fixture.path);
      database.run(
        "UPDATE runtime_snapshots SET state_json = '{\"tampered\":true}' WHERE session_id = 'corrupt'",
      );
      database.close();
      expect(() =>
        createSqliteRuntimeStorageV5({
          databasePath: fixture.path,
          codec,
          options: { journalMode: 'delete' },
        }),
      ).toThrow(SqliteRuntimeFormatIncompatibleError);
    } finally {
      fixture.cleanup();
    }

    const missing = temporaryDatabase();
    try {
      const first = createSqliteRuntimeStorageV5<Event, State>({
        databasePath: missing.path,
        codec,
        options: { journalMode: 'delete' },
      });
      first.transactions.commitDecision({
        sessionId: 'missing',
        events: [{ type: 'committed' }],
        snapshot: state('missing'),
        metadata: [{ eventId: 'event-1', revision: 1 }],
      });
      first.close();
      const database = new Database(missing.path);
      database.run("DELETE FROM runtime_snapshots WHERE session_id = 'missing'");
      database.close();
      expect(() =>
        createSqliteRuntimeStorageV5({
          databasePath: missing.path,
          codec,
          options: { journalMode: 'delete' },
        }),
      ).toThrow(SqliteRuntimeFormatIncompatibleError);
    } finally {
      missing.cleanup();
    }
  });

  test('does not read, migrate or modify a Store4 database', () => {
    const fixture = temporaryDatabase();
    try {
      const legacy = createSqliteRuntimeStorage<Event, State>({
        databasePath: fixture.path,
        codec: { ...codec, snapshotMetadata: () => ({ stateRevision: 0, schemaVersion: 25 }) },
        options: { journalMode: 'delete' },
      });
      legacy.close();
      const before = readFileSync(fixture.path);
      expect(() =>
        createSqliteRuntimeStorageV5({
          databasePath: fixture.path,
          codec,
          options: { journalMode: 'delete' },
        }),
      ).toThrow(SqliteRuntimeFormatIncompatibleError);
      expect(readFileSync(fixture.path)).toEqual(before);
    } finally {
      fixture.cleanup();
    }
  });
});
