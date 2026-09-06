import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  createSqliteWorkspaceDirectoryOutbox,
  SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
  SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
  SQLITE_RUNTIME_WORKSPACE_STORE_SCHEMA_VERSION,
  SQLITE_SESSION_DIRECTORY_OUTBOX_MAX_PAGE_SIZE,
} from '../src';
import { initializeSqliteRuntimeSchema } from '../src/schema';
import { createSqliteSessionMetadataStore } from '../src/session-store';

const binding = {
  layoutGeneration: 'generation-directory',
  workerScopeId: 'worker-directory',
  workspaceIdentityDigest: `sha256:${'d'.repeat(64)}`,
} as const;

const codec = {
  encodeEvent: JSON.stringify,
  decodeEvent: (json: string) => JSON.parse(json) as unknown,
  encodeState: JSON.stringify,
  decodeState: <T>(json: string) => JSON.parse(json) as T,
  snapshotMetadata: (state: DirectoryState) => ({
    stateRevision: state.revision,
    schemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
  }),
  sessionIdentity: (state: DirectoryState) => ({
    projectId: state.projectId,
    canonicalWorkspaceDigest: state.workspaceDigest,
  }),
  rebindForkState: (state: DirectoryState, sessionId: string) => ({
    ...state,
    sessionId,
  }),
};

interface DirectoryState {
  readonly sessionId: string;
  readonly projectId: string;
  readonly workspaceDigest: string;
  readonly revision: number;
}

function state(sessionId: string, revision: number): DirectoryState {
  return {
    sessionId,
    projectId: `project-${sessionId}`,
    workspaceDigest: `sha256:${'w'.repeat(64)}`,
    revision,
  };
}

function createFixture(): {
  readonly database: Database;
  readonly outbox: ReturnType<typeof createSqliteWorkspaceDirectoryOutbox>;
  readonly sessions: ReturnType<typeof createSqliteSessionMetadataStore<DirectoryState>>;
} {
  const database = new Database(':memory:');
  initializeSqliteRuntimeSchema(database, {
    stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
    storeSchemaVersion: SQLITE_RUNTIME_WORKSPACE_STORE_SCHEMA_VERSION,
    formatEpoch: SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
    workspaceBinding: binding,
  });
  const outbox = createSqliteWorkspaceDirectoryOutbox({ db: database, binding });
  const sessions = createSqliteSessionMetadataStore({
    db: database,
    codec,
    stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
    formatEpoch: SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
    workspaceBinding: binding,
    onDirectoryChange: outbox.append,
  });
  return { database, outbox, sessions };
}

describe('Store 7 Session Directory outbox', () => {
  test('commits create, rename, and delete facts with path-free outbox rows', () => {
    const fixture = createFixture();
    try {
      fixture.database.run('BEGIN IMMEDIATE');
      fixture.sessions.ensureSession('session-directory', state('session-directory', 3));
      fixture.database.run('COMMIT');

      const created = fixture.outbox.list({ limit: 10 });
      expect(created.entries).toEqual([
        {
          sessionId: 'session-directory',
          workerScopeId: binding.workerScopeId,
          revision: 3,
          updatedAt: expect.any(Number),
          tombstone: false,
        },
      ]);
      const createCursor = created.nextCursor;
      expect(createCursor).toBeGreaterThan(0);

      fixture.database.run('BEGIN IMMEDIATE');
      fixture.sessions.setName('session-directory', 'renamed');
      fixture.database.run('COMMIT');
      expect(fixture.sessions.list(10)[0]?.name).toBe('renamed');

      fixture.database.run('BEGIN IMMEDIATE');
      fixture.sessions.delete('session-directory');
      fixture.database.run('COMMIT');
      expect(fixture.sessions.list(10)).toEqual([]);

      const changes = fixture.outbox.list({ cursor: createCursor, limit: 10 });
      expect(changes.entries).toHaveLength(2);
      expect(changes.entries[0]).toMatchObject({
        sessionId: 'session-directory',
        workerScopeId: binding.workerScopeId,
        revision: 3,
        tombstone: false,
      });
      expect(changes.entries[1]).toMatchObject({
        sessionId: 'session-directory',
        workerScopeId: binding.workerScopeId,
        revision: 3,
        tombstone: true,
      });
      expect(changes.nextCursor).toBeGreaterThan(createCursor!);

      fixture.database.run('BEGIN IMMEDIATE');
      fixture.sessions.ensureSession('rolled-back', state('rolled-back', 4));
      fixture.database.run('ROLLBACK');
      expect(fixture.sessions.list(10).map((entry) => entry.thread_id)).toEqual([]);
      expect(fixture.outbox.list({ cursor: changes.nextCursor, limit: 10 }).entries).toEqual([]);
    } finally {
      fixture.database.close();
    }
  });

  test('is idempotent and returns bounded strictly advancing rowid cursors', () => {
    const fixture = createFixture();
    try {
      const entry = {
        sessionId: 'same-session',
        workerScopeId: binding.workerScopeId,
        revision: 1,
        updatedAt: 100,
        tombstone: false,
      } as const;
      fixture.outbox.append(entry);
      fixture.outbox.append(entry);
      for (let revision = 2; revision <= 5; revision += 1) {
        fixture.outbox.append({ ...entry, revision, updatedAt: 100 + revision });
      }

      const first = fixture.outbox.list({ limit: 2 });
      expect(first.entries).toHaveLength(2);
      expect(first.hasMore).toBe(true);
      expect(first.nextCursor).toBeGreaterThan(0);
      const second = fixture.outbox.list({ cursor: first.nextCursor, limit: 2 });
      expect(second.entries).toHaveLength(2);
      expect(second.nextCursor).toBeGreaterThan(first.nextCursor!);
      const final = fixture.outbox.list({ cursor: second.nextCursor, limit: 2 });
      expect(final.entries).toHaveLength(1);
      expect(final.hasMore).toBe(false);
      expect(final.nextCursor).toBeGreaterThan(second.nextCursor!);
      expect(fixture.outbox.list({ limit: 10 }).entries).toHaveLength(5);

      expect(() =>
        fixture.outbox.list({ limit: SQLITE_SESSION_DIRECTORY_OUTBOX_MAX_PAGE_SIZE + 1 }),
      ).toThrow();
      expect(() => fixture.outbox.list({ cursor: -1 })).toThrow();
      expect(() => fixture.outbox.append({ ...entry, workerScopeId: 'other-worker' })).toThrow();

      const columns = fixture.database
        .query<{ name: string }, []>('PRAGMA table_info(session_directory_outbox)')
        .all()
        .map((row) => row.name);
      expect(columns).toEqual([
        'session_id',
        'worker_scope_id',
        'revision',
        'updated_at',
        'tombstone',
      ]);
    } finally {
      fixture.database.close();
    }
  });
});
