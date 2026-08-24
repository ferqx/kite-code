import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  createSqliteRuntimeLogQueryPort,
  createSqliteRuntimeStorage,
  SQLITE_RUNTIME_FORMAT_EPOCH,
  SqliteRuntimeLogQueryError,
} from '../src/index';

type Event = { readonly type: string; readonly content?: string };
type State = {
  readonly schemaVersion: 26;
  readonly formatEpoch: string;
  readonly revision: number;
  readonly session: {
    readonly threadId: string;
    readonly projectId: string;
    readonly canonicalWorkspaceDigest: string;
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
  rebindForkState: (state: State, sessionId: string) => ({
    ...state,
    session: { ...state.session, threadId: sessionId },
  }),
};

function fixture() {
  const directory = mkdtempSync(join(process.cwd(), '.kite-log-reader-'));
  return {
    path: join(directory, 'runtime.db'),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function state(sessionId: string, revision: number): State {
  return {
    schemaVersion: 26,
    formatEpoch: SQLITE_RUNTIME_FORMAT_EPOCH,
    revision,
    session: {
      sessionId,
      threadId: sessionId,
      projectId: `project-${sessionId}`,
      canonicalWorkspaceDigest: `sha256:${'a'.repeat(64)}`,
    },
  } as State;
}

function append(
  storage: ReturnType<typeof createSqliteRuntimeStorage<Event, State>>,
  sessionId: string,
  revision: number,
  event: Event,
): void {
  storage.transactions.commitDecision({
    sessionId,
    events: [event],
    snapshot: state(sessionId, revision),
    metadata: [{ eventId: `${sessionId}-${revision}`, revision }],
  });
}

describe('SQLite RuntimeLogQueryPort', () => {
  for (const journalMode of ['wal', 'delete'] as const) {
    test(`paginates a live ${journalMode.toUpperCase()} session by sequence without duplicate or raw JSON`, () => {
      const testFixture = fixture();
      try {
        const writer = createSqliteRuntimeStorage<Event, State>({
          databasePath: testFixture.path,
          codec,
          options: { journalMode },
        });
        append(writer, 'session-1', 1, { type: 'message' });
        append(writer, 'session-1', 2, { type: 'message' });
        const reader = createSqliteRuntimeLogQueryPort({
          databasePath: testFixture.path,
          codec,
          currentEventTypes: ['message'],
        });
        const first = reader.listEvents({ sessionId: 'session-1', direction: 'forward', limit: 1 });
        expect(first.entries.map((entry) => entry.sequence)).toEqual([1]);
        expect(JSON.stringify(first)).not.toContain('event_json');
        append(writer, 'session-1', 3, { type: 'message' });
        const second = reader.listEvents({
          sessionId: 'session-1',
          direction: 'forward',
          limit: 10,
          afterSequence: first.nextCursor!,
        });
        expect(second.entries.map((entry) => entry.sequence)).toEqual([2, 3]);
        expect(second.observedLastSequence).toBe(3);
        reader.close();
        writer.close();
      } finally {
        testFixture.cleanup();
      }
    });
  }

  test('fails closed for unknown current-format event data and invalid filter types', () => {
    const testFixture = fixture();
    try {
      const writer = createSqliteRuntimeStorage<Event, State>({
        databasePath: testFixture.path,
        codec,
        options: { journalMode: 'delete' },
      });
      append(writer, 'session-1', 1, { type: 'message' });
      writer.close();
      const validReader = createSqliteRuntimeLogQueryPort({
        databasePath: testFixture.path,
        codec,
        currentEventTypes: ['message'],
      });
      expect(() =>
        validReader.listEvents({
          sessionId: 'session-1',
          direction: 'forward',
          limit: 10,
          eventTypes: ['not.current'],
        }),
      ).toThrow('unknown current');
      validReader.close();
      const database = new Database(testFixture.path);
      database.run('UPDATE runtime_events SET event_json = \'{"type":"future.event"}\'');
      database.close();
      const corruptReader = createSqliteRuntimeLogQueryPort({
        databasePath: testFixture.path,
        codec,
        currentEventTypes: ['message'],
      });
      expect(() =>
        corruptReader.listEvents({ sessionId: 'session-1', direction: 'forward', limit: 10 }),
      ).toThrow(SqliteRuntimeLogQueryError);
      corruptReader.close();
    } finally {
      testFixture.cleanup();
    }
  });

  test('reports a short read blocked by an exclusive DELETE writer as temporarily unavailable', () => {
    const testFixture = fixture();
    try {
      const writer = createSqliteRuntimeStorage<Event, State>({
        databasePath: testFixture.path,
        codec,
        options: { journalMode: 'delete' },
      });
      append(writer, 'session-1', 1, { type: 'message' });
      const reader = createSqliteRuntimeLogQueryPort({
        databasePath: testFixture.path,
        codec,
        currentEventTypes: ['message'],
      });
      const blocker = new Database(testFixture.path);
      blocker.run('BEGIN EXCLUSIVE');
      try {
        expect(() => reader.listSessions({ limit: 1 })).toThrow('temporarily unavailable');
      } finally {
        blocker.run('ROLLBACK');
        blocker.close();
      }
      reader.close();
      writer.close();
    } finally {
      testFixture.cleanup();
    }
  });
});
