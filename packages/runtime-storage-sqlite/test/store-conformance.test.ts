import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  createSqliteRuntimeStorage,
  SQLITE_RUNTIME_FORMAT_EPOCH,
  SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
  SQLITE_RUNTIME_STORE_SCHEMA_VERSION,
  SqliteRuntimeFormatMismatchError,
  sqliteRuntimeStorePath,
} from '../src/index';

type Event = { type: string; content?: string };
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
      input.state.formatEpoch !== SQLITE_RUNTIME_FORMAT_EPOCH ||
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
    formatEpoch: SQLITE_RUNTIME_FORMAT_EPOCH,
    revision,
    session: {
      threadId,
      projectId: `project_${threadId}`,
      canonicalWorkspaceDigest: `sha256:${'a'.repeat(64)}`,
    },
  };
}

function temporaryDatabase(): { path: string; cleanup(): void } {
  const directory = mkdtempSync(join(process.cwd(), '.kite-store-'));
  return {
    path: join(directory, 'runtime.db'),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

describe('State/Store production format', () => {
  test('publishes the current profile and a separate path', () => {
    expect(SQLITE_RUNTIME_STATE_SCHEMA_VERSION).toBe(26);
    expect(SQLITE_RUNTIME_STORE_SCHEMA_VERSION).toBe(5);
    expect(SQLITE_RUNTIME_FORMAT_EPOCH).toBe('kite-runtime-modularization-v1-2026-08-19');
    expect(sqliteRuntimeStorePath('/tmp/checkpoints.sqlite')).toBe(
      '/tmp/checkpoints.runtime-state-store.db',
    );
  });

  test('creates only the seven runtime tables and two indexes', () => {
    const fixture = temporaryDatabase();
    try {
      const storage = createSqliteRuntimeStorage<Event, State>({
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
      const first = createSqliteRuntimeStorage<Event, State>({
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

      const reopened = createSqliteRuntimeStorage<Event, State>({
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

  test('stops decoding a session journal after finding its naming event', () => {
    let decodedEvents = 0;
    const summaryCodec = {
      ...codec,
      decodeEvent: (json: string): Event => {
        decodedEvents += 1;
        return JSON.parse(json) as Event;
      },
      eventSummary: (event: Event) =>
        event.type === 'user.message_appended' && event.content
          ? { isSessionNameCandidate: true, searchText: event.content }
          : null,
    };
    const storage = createSqliteRuntimeStorage<Event, State>({
      databasePath: ':memory:',
      codec: summaryCodec,
    });
    const events: Event[] = [
      { type: 'turn.started' },
      { type: 'user.message_appended', content: 'fast startup' },
      ...Array.from({ length: 500 }, () => ({ type: 'model.delta' })),
    ];
    storage.transactions.commitDecision({
      sessionId: 'long-session',
      events,
      snapshot: state('long-session', events.length),
      metadata: events.map((_, index) => ({
        eventId: `event-${index + 1}`,
        revision: index + 1,
      })),
    });

    expect(storage.sessions.listSessions()).toEqual([
      expect.objectContaining({
        threadId: 'long-session',
        name: 'fast startup',
        needsSmartName: true,
      }),
    ]);
    expect(decodedEvents).toBe(2);
    storage.close();
  });

  test('rejects legacy metadata before a transaction creates current rows', () => {
    const storage = createSqliteRuntimeStorage<Event, State>({ databasePath: ':memory:', codec });
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
      const first = createSqliteRuntimeStorage<Event, State>({
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
      const discovery = createSqliteRuntimeStorage({
        databasePath: fixture.path,
        codec,
        options: { journalMode: 'delete' },
      });
      discovery.close();
      expect(() =>
        createSqliteRuntimeStorage({
          databasePath: fixture.path,
          codec,
          sessionId: 'corrupt',
          options: { journalMode: 'delete' },
        }),
      ).toThrow(SqliteRuntimeFormatMismatchError);
    } finally {
      fixture.cleanup();
    }

    const missing = temporaryDatabase();
    try {
      const first = createSqliteRuntimeStorage<Event, State>({
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
      const discovery = createSqliteRuntimeStorage({
        databasePath: missing.path,
        codec,
        options: { journalMode: 'delete' },
      });
      discovery.close();
      expect(() =>
        createSqliteRuntimeStorage({
          databasePath: missing.path,
          codec,
          sessionId: 'missing',
          options: { journalMode: 'delete' },
        }),
      ).toThrow(SqliteRuntimeFormatMismatchError);
    } finally {
      missing.cleanup();
    }
  });
});
