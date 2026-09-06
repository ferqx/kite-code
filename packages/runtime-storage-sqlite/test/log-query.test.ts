import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  createSqliteRuntimeLogQueryPort,
  createSqliteRuntimeStorage,
  createSqliteWorkspaceRuntimeLogQueryPort,
  ensureSqliteRuntimeGenerationRoot,
  ensureSqliteRuntimeLayoutRoot,
  ensureSqliteWorkspaceStoreDirectory,
  SQLITE_RUNTIME_FORMAT_EPOCH,
  SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
  SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
  SQLITE_RUNTIME_WORKSPACE_STORE_SCHEMA_VERSION,
  SqliteRuntimeLogQueryError,
  writeSqliteActiveLayoutPointer,
  writeSqliteRuntimeLayoutManifest,
  writeSqliteRuntimeMigrationFence,
  writeSqliteRuntimeMigrationJournal,
} from '../src/index';
import { initializeSqliteRuntimeSchema } from '../src/schema';

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

  test('binds an offline Store 7 reader to the exact layout generation and Worker scope', () => {
    const testFixture = fixture();
    const binding = {
      layoutGeneration: 'generation-reader',
      workerScopeId: 'workspace_reader_scope',
      workspaceIdentityDigest: 'd'.repeat(64),
    } as const;
    try {
      const database = new Database(testFixture.path);
      initializeSqliteRuntimeSchema(database, {
        stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
        storeSchemaVersion: SQLITE_RUNTIME_WORKSPACE_STORE_SCHEMA_VERSION,
        formatEpoch: SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
        workspaceBinding: binding,
      });
      database
        .query(
          'INSERT INTO runtime_sessions (session_id, project_id, workspace_digest, worker_scope_id, workspace_identity_digest, state_schema, format_epoch, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          'session-offline',
          'project-offline',
          `sha256:${'a'.repeat(64)}`,
          binding.workerScopeId,
          binding.workspaceIdentityDigest,
          SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
          SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
          1,
          1,
        );
      database
        .query(
          'INSERT INTO runtime_events (session_id, event_id, sequence, schema_version, event_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(
          'session-offline',
          'event-offline',
          1,
          SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
          JSON.stringify({ type: 'message' }),
          1,
        );
      database.close();

      const reader = createSqliteRuntimeLogQueryPort({
        databasePath: testFixture.path,
        codec,
        currentEventTypes: ['message'],
        workspace: {
          layoutGeneration: binding.layoutGeneration,
          workerScopeId: binding.workerScopeId,
          workspaceIdentityDigest: binding.workspaceIdentityDigest,
        },
      });
      expect(reader.listSessions({ limit: 10 }).entries.map((entry) => entry.sessionId)).toEqual([
        'session-offline',
      ]);
      reader.close();

      expect(() =>
        createSqliteRuntimeLogQueryPort({
          databasePath: testFixture.path,
          codec,
          currentEventTypes: ['message'],
          workspace: {
            layoutGeneration: binding.layoutGeneration,
            workerScopeId: 'workspace_other_scope',
            workspaceIdentityDigest: binding.workspaceIdentityDigest,
          },
        }),
      ).toThrow(SqliteRuntimeLogQueryError);
    } finally {
      testFixture.cleanup();
    }
  });

  test('derives an active Store 7 path from opaque scope and rejects layout drift', () => {
    const root = mkdtempSync(join(process.cwd(), '.kite-active-log-reader-'));
    const layout = ensureSqliteRuntimeLayoutRoot(join(root, 'home'));
    const binding = {
      layoutGeneration: 'generation-active-reader',
      workerScopeId: 'workspace_active_reader',
      workspaceIdentityDigest: 'e'.repeat(64),
    } as const;
    const sourceProfile = {
      stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
      storeSchemaVersion: 6,
      formatEpoch: SQLITE_RUNTIME_FORMAT_EPOCH,
    } as const;
    try {
      ensureSqliteRuntimeGenerationRoot(layout, binding.layoutGeneration);
      const databasePath = ensureSqliteWorkspaceStoreDirectory(
        layout,
        binding.layoutGeneration,
        binding.workerScopeId,
      );
      const database = new Database(databasePath);
      initializeSqliteRuntimeSchema(database, {
        stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
        storeSchemaVersion: SQLITE_RUNTIME_WORKSPACE_STORE_SCHEMA_VERSION,
        formatEpoch: SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
        workspaceBinding: binding,
      });
      database
        .query(
          'INSERT INTO runtime_sessions (session_id, project_id, workspace_digest, worker_scope_id, workspace_identity_digest, state_schema, format_epoch, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          'session-active',
          'project-active',
          `sha256:${'b'.repeat(64)}`,
          binding.workerScopeId,
          binding.workspaceIdentityDigest,
          SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
          SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
          1,
          1,
        );
      database.close();
      chmodSync(databasePath, 0o600);
      const storeEntry = { workerScopeId: binding.workerScopeId, digest: 'c'.repeat(64) };
      writeSqliteRuntimeLayoutManifest(layout, {
        schema: 'kite.runtime-layout-manifest.v1',
        generation: binding.layoutGeneration,
        profile: {
          stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
          storeSchemaVersion: SQLITE_RUNTIME_WORKSPACE_STORE_SCHEMA_VERSION,
          formatEpoch: SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
        },
        catalogDigest: 'd'.repeat(64),
        workspaceStores: [storeEntry],
      });
      writeSqliteRuntimeMigrationFence(layout, {
        schema: 'kite.runtime-migration-fence.v1',
        sourceStoreIdentity: 'active-reader-source',
        sourceStoreDigest: 'a'.repeat(64),
        sourceProfile,
        targetLayoutGeneration: binding.layoutGeneration,
        migrationNonce: 'active-reader-nonce',
        state: 'active',
      });
      writeSqliteRuntimeMigrationJournal(layout, {
        schema: 'kite.runtime-migration-journal.v1',
        sourceStoreIdentity: 'active-reader-source',
        sourceStoreDigest: 'a'.repeat(64),
        sourceProfile,
        targetLayoutGeneration: binding.layoutGeneration,
        targetCatalogDigest: 'd'.repeat(64),
        workspaceStoreDigests: [storeEntry],
        pointerPhase: 'committed',
        targetWriteState: 'written',
        migrationNonce: 'active-reader-nonce',
      });
      writeSqliteActiveLayoutPointer(layout, {
        schema: 'kite.runtime-active-layout.v1',
        generation: binding.layoutGeneration,
      });

      const reader = createSqliteWorkspaceRuntimeLogQueryPort({
        layout,
        layoutGeneration: binding.layoutGeneration,
        workerScopeId: binding.workerScopeId,
        codec,
        currentEventTypes: ['message'],
      });
      expect(reader.listSessions({ limit: 10 }).entries[0]?.sessionId).toBe('session-active');

      ensureSqliteRuntimeGenerationRoot(layout, 'generation-replacement');
      writeSqliteActiveLayoutPointer(layout, {
        schema: 'kite.runtime-active-layout.v1',
        generation: 'generation-replacement',
      });
      expect(() => reader.listSessions({ limit: 10 })).toThrow(SqliteRuntimeLogQueryError);
      reader.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
