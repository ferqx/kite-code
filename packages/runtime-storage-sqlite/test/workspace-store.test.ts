import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { chmodSync, linkSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  admitNewWorkspaceStore,
  canRollbackSqliteRuntimeLayout,
  createSqliteRuntimeLayoutCutover,
  createSqliteRuntimeStorage,
  ensureSqliteRuntimeGenerationRoot,
  ensureSqliteRuntimeLayoutRoot,
  ensureSqliteWorkspaceStoreDirectory,
  materializeAndAdmitNewWorkspaceStore,
  readSqliteActiveLayoutPointer,
  readSqliteRuntimeLayoutManifest,
  readSqliteRuntimeMigrationJournal,
  resolveSqliteRuntimeLayoutPaths,
  SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
  SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
  SQLITE_RUNTIME_WORKSPACE_STORE_SCHEMA_VERSION,
  SqliteRuntimeFormatMismatchError,
  sqliteRuntimeStoreDigest,
  writeSqliteActiveLayoutPointer,
  writeSqliteRuntimeLayoutManifest,
  writeSqliteRuntimeMigrationFence,
  writeSqliteRuntimeMigrationJournal,
} from '../src/index';
import { initializeSqliteRuntimeSchema } from '../src/schema';

type Event = { readonly type: string };
type State = {
  readonly schemaVersion: number;
  readonly formatEpoch: string;
  readonly revision: number;
  readonly session: {
    readonly threadId: string;
    readonly projectId: string;
    readonly canonicalWorkspaceDigest: string;
  };
};

const binding = {
  layoutGeneration: 'generation-1',
  workerScopeId: 'worker-scope-1',
  workspaceIdentityDigest: 'd'.repeat(64),
} as const;

const codec = {
  encodeEvent: JSON.stringify,
  decodeEvent: (json: string) => JSON.parse(json) as Event,
  encodeState: JSON.stringify,
  decodeState: <T>(json: string) => JSON.parse(json) as T,
  snapshotMetadata: (state: State) => ({
    stateRevision: state.revision,
    schemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
  }),
  sessionIdentity: (state: State) => ({
    projectId: state.session.projectId,
    canonicalWorkspaceDigest: state.session.canonicalWorkspaceDigest,
  }),
  rebindForkState: (state: State, sessionId: string) => ({
    ...state,
    session: { ...state.session, threadId: sessionId },
  }),
};

function state(sessionId: string, revision = 1): State {
  return {
    schemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
    formatEpoch: SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
    revision,
    session: {
      threadId: sessionId,
      projectId: `project-${sessionId}`,
      canonicalWorkspaceDigest: 'sha256:workspace-digest',
    },
  };
}

function receipt(sessionId: string, commandId: string, revision: number) {
  return {
    scopeSessionId: sessionId,
    commandId,
    requestDigest: 'a'.repeat(64),
    targetSessionId: sessionId,
    originalReceiptJson: JSON.stringify({
      status: 'applied',
      commandId,
      sessionId,
      revision,
    }),
    committedRevision: revision,
    committedAt: 1_700_000_000_000,
  } as const;
}

function fixture(): {
  readonly path: string;
  readonly layout: ReturnType<typeof resolveSqliteRuntimeLayoutPaths>;
  cleanup(): void;
} {
  const root = mkdtempSync(join(process.cwd(), '.kite-workspace-store-'));
  const layout = ensureSqliteRuntimeLayoutRoot(join(root, 'home'));
  const databasePath = ensureSqliteWorkspaceStoreDirectory(
    layout,
    binding.layoutGeneration,
    binding.workerScopeId,
  );
  ensureSqliteRuntimeGenerationRoot(layout, binding.layoutGeneration);
  const sourceProfile = {
    stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
    storeSchemaVersion: 6,
    formatEpoch: 'kite-runtime-server-v1-2026-08-26',
  } as const;
  const target = new Database(databasePath);
  initializeSqliteRuntimeSchema(target, {
    stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
    storeSchemaVersion: SQLITE_RUNTIME_WORKSPACE_STORE_SCHEMA_VERSION,
    formatEpoch: SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
    workspaceBinding: binding,
  });
  target.close();
  chmodSync(databasePath, 0o600);
  const storeDigest = sqliteRuntimeStoreDigest(databasePath);
  const journal = {
    schema: 'kite.runtime-migration-journal.v1' as const,
    sourceStoreIdentity: 'workspace-store-test-source',
    sourceStoreDigest: 'a'.repeat(64),
    sourceProfile,
    targetLayoutGeneration: binding.layoutGeneration,
    targetCatalogDigest: 'b'.repeat(64),
    workspaceStoreDigests: [{ workerScopeId: binding.workerScopeId, digest: storeDigest }],
    pointerPhase: 'committed' as const,
    targetWriteState: 'none' as const,
    migrationNonce: 'workspace-store-test-nonce',
  };
  writeSqliteRuntimeLayoutManifest(layout, {
    schema: 'kite.runtime-layout-manifest.v1',
    generation: binding.layoutGeneration,
    profile: {
      stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
      storeSchemaVersion: SQLITE_RUNTIME_WORKSPACE_STORE_SCHEMA_VERSION,
      formatEpoch: SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
    },
    catalogDigest: journal.targetCatalogDigest,
    workspaceStores: journal.workspaceStoreDigests,
  });
  writeSqliteRuntimeMigrationFence(layout, {
    schema: 'kite.runtime-migration-fence.v1',
    sourceStoreIdentity: journal.sourceStoreIdentity,
    sourceStoreDigest: journal.sourceStoreDigest,
    sourceProfile,
    targetLayoutGeneration: binding.layoutGeneration,
    migrationNonce: journal.migrationNonce,
    state: 'active',
  });
  writeSqliteRuntimeMigrationJournal(layout, journal);
  writeSqliteActiveLayoutPointer(layout, {
    schema: 'kite.runtime-active-layout.v1',
    generation: binding.layoutGeneration,
  });
  return {
    path: databasePath,
    layout,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe('Store 7 Workspace binding', () => {
  test('rejects concurrent admission and hardlinked layout authority files', () => {
    const testFixture = fixture();
    try {
      const lock = join(testFixture.layout.root, 'layout-admission.lock');
      writeFileSync(lock, 'unknown-owner\n', { mode: 0o600 });
      expect(() => admitNewWorkspaceStore(testFixture.layout, binding, testFixture.path)).toThrow(
        'already active',
      );
      rmSync(lock);

      const alias = join(testFixture.layout.root, 'active-layout.alias');
      linkSync(testFixture.layout.activeLayout, alias);
      expect(() => readSqliteActiveLayoutPointer(testFixture.layout)).toThrow(
        'private regular file',
      );
    } finally {
      testFixture.cleanup();
    }
  });

  test('admits a materialized new Workspace only into the active generation', () => {
    const root = mkdtempSync(join(process.cwd(), '.kite-workspace-admission-'));
    try {
      const layout = ensureSqliteRuntimeLayoutRoot(join(root, 'home'));
      const path = ensureSqliteWorkspaceStoreDirectory(
        layout,
        binding.layoutGeneration,
        binding.workerScopeId,
      );
      const sourceProfile = {
        stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
        storeSchemaVersion: 6,
        formatEpoch: 'kite-runtime-server-v1-2026-08-26',
      } as const;
      const journal = {
        schema: 'kite.runtime-migration-journal.v1' as const,
        sourceStoreIdentity: 'admission-source',
        sourceStoreDigest: 'a'.repeat(64),
        sourceProfile,
        targetLayoutGeneration: binding.layoutGeneration,
        targetCatalogDigest: 'b'.repeat(64),
        workspaceStoreDigests: [],
        pointerPhase: 'committed' as const,
        targetWriteState: 'none' as const,
        migrationNonce: 'admission-nonce',
      };
      writeSqliteRuntimeLayoutManifest(layout, {
        schema: 'kite.runtime-layout-manifest.v1',
        generation: binding.layoutGeneration,
        profile: {
          stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
          storeSchemaVersion: SQLITE_RUNTIME_WORKSPACE_STORE_SCHEMA_VERSION,
          formatEpoch: SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
        },
        catalogDigest: journal.targetCatalogDigest,
        workspaceStores: [],
      });
      writeSqliteRuntimeMigrationFence(layout, {
        schema: 'kite.runtime-migration-fence.v1',
        sourceStoreIdentity: journal.sourceStoreIdentity,
        sourceStoreDigest: journal.sourceStoreDigest,
        sourceProfile,
        targetLayoutGeneration: binding.layoutGeneration,
        migrationNonce: journal.migrationNonce,
        state: 'active',
      });
      writeSqliteRuntimeMigrationJournal(layout, journal);
      writeSqliteActiveLayoutPointer(layout, {
        schema: 'kite.runtime-active-layout.v1',
        generation: binding.layoutGeneration,
      });
      const admission = materializeAndAdmitNewWorkspaceStore(layout, binding);
      expect(admission.databasePath).toBe(path);
      expect(admission.workerScopeId).toBe(binding.workerScopeId);
      expect(admission.digest).toMatch(/^[a-f0-9]{64}$/u);
      expect(
        readSqliteRuntimeLayoutManifest(layout, binding.layoutGeneration)?.workspaceStores,
      ).toEqual([{ workerScopeId: binding.workerScopeId, digest: admission.digest }]);
      expect(readSqliteRuntimeMigrationJournal(layout)?.targetWriteState).toBe('written');
      const writer = createSqliteRuntimeStorage<Event, State>({
        databasePath: path,
        codec,
        workspaceBinding: binding,
        workspaceLayout: layout,
        options: { journalMode: 'delete' },
      });
      writer.transactions.commitDecision({
        sessionId: 'written-store-reopen',
        events: [{ type: 'created' }],
        snapshot: state('written-store-reopen'),
        metadata: [{ eventId: 'written-store-event', revision: 1 }],
      });
      writer.close();
      expect(sqliteRuntimeStoreDigest(path)).not.toBe(admission.digest);
      expect(materializeAndAdmitNewWorkspaceStore(layout, binding)).toEqual({
        databasePath: path,
        workerScopeId: admission.workerScopeId,
        digest: admission.digest,
      });
      writeSqliteRuntimeLayoutManifest(layout, {
        schema: 'kite.runtime-layout-manifest.v1',
        generation: binding.layoutGeneration,
        profile: {
          stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
          storeSchemaVersion: SQLITE_RUNTIME_WORKSPACE_STORE_SCHEMA_VERSION,
          formatEpoch: SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
        },
        catalogDigest: journal.targetCatalogDigest,
        workspaceStores: [],
      });
      const recovered = admitNewWorkspaceStore(layout, binding, path);
      expect(recovered).toEqual({
        workerScopeId: admission.workerScopeId,
        digest: admission.digest,
      });
      expect(
        readSqliteRuntimeLayoutManifest(layout, binding.layoutGeneration)?.workspaceStores,
      ).toEqual([{ workerScopeId: binding.workerScopeId, digest: admission.digest }]);
      expect(readSqliteRuntimeMigrationJournal(layout)?.targetWriteState).toBe('written');
      expect(() =>
        admitNewWorkspaceStore(layout, { ...binding, workerScopeId: 'other-scope' }, path),
      ).toThrow();
      const invalidBinding = { ...binding, workerScopeId: 'invalid-store-scope' };
      const invalidPath = ensureSqliteWorkspaceStoreDirectory(
        layout,
        invalidBinding.layoutGeneration,
        invalidBinding.workerScopeId,
      );
      writeFileSync(invalidPath, 'not a Store 7 database', { mode: 0o600 });
      expect(() => admitNewWorkspaceStore(layout, invalidBinding, invalidPath)).toThrow(
        'profile or Workspace binding',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('publishes bound header, Session columns, receipt columns, and tombstone', () => {
    const testFixture = fixture();
    try {
      const storage = createSqliteRuntimeStorage<Event, State>({
        databasePath: testFixture.path,
        codec,
        workspaceBinding: binding,
        workspaceLayout: testFixture.layout,
        options: { journalMode: 'delete' },
      });
      expect(storage.storeSchemaVersion).toBe(SQLITE_RUNTIME_WORKSPACE_STORE_SCHEMA_VERSION);
      expect(storage.formatEpoch).toBe(SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH);
      storage.close();
      const database = new Database(testFixture.path, { readonly: true });
      expect(
        database
          .query<{ value: string }, [string]>('SELECT value FROM runtime_store_meta WHERE key = ?')
          .get('worker_scope_id'),
      ).toEqual({ value: binding.workerScopeId });
      expect(
        database
          .query<{ name: string }, []>('PRAGMA table_info(runtime_sessions)')
          .all()
          .map((row) => row.name),
      ).toContain('workspace_identity_digest');
      expect(
        database
          .query<{ name: string }, []>('PRAGMA table_info(session_workspace_tombstone)')
          .all()
          .map((row) => row.name),
      ).toEqual([
        'session_id',
        'worker_scope_id',
        'project_id',
        'workspace_digest',
        'deleted_revision',
        'deleted_at',
      ]);
      expect(
        database
          .query<{ name: string }, []>('PRAGMA table_info(session_directory_outbox)')
          .all()
          .map((row) => row.name),
      ).toEqual(['session_id', 'worker_scope_id', 'revision', 'updated_at', 'tombstone']);
      database.close();
    } finally {
      testFixture.cleanup();
    }
  });

  test('records create, rename, and delete through the adapter-owned outbox', () => {
    const testFixture = fixture();
    try {
      const storage = createSqliteRuntimeStorage<Event, State>({
        databasePath: testFixture.path,
        codec,
        workspaceBinding: binding,
        workspaceLayout: testFixture.layout,
        options: { journalMode: 'delete' },
      });
      const outbox = storage.directoryOutbox;
      expect(outbox).toBeDefined();
      storage.transactions.commitDecision({
        sessionId: 'directory-adapter',
        events: [{ type: 'created' }],
        snapshot: state('directory-adapter'),
        metadata: [{ eventId: 'directory-event', revision: 1 }],
      });
      storage.sessions.setSessionName('directory-adapter', 'renamed');
      storage.sessions.deleteSession('directory-adapter');
      const page = outbox!.list({ limit: 10 });
      expect(page.entries).toHaveLength(3);
      expect(page.entries.map((entry) => entry.tombstone)).toEqual([false, false, true]);
      expect(page.entries.every((entry) => entry.workerScopeId === binding.workerScopeId)).toBe(
        true,
      );
      storage.close();
    } finally {
      testFixture.cleanup();
    }
  });

  test('serves bounded Session, History, and Checkpoint pages on the existing Store connection', () => {
    const testFixture = fixture();
    try {
      const storage = createSqliteRuntimeStorage<Event, State>({
        databasePath: testFixture.path,
        codec,
        workspaceBinding: binding,
        workspaceLayout: testFixture.layout,
        options: { journalMode: 'delete' },
      });
      for (const sessionId of ['session-page-a', 'session-page-b']) {
        storage.transactions.commitDecision({
          sessionId,
          events: [{ type: 'created' }],
          snapshot: state(sessionId),
          metadata: [{ eventId: `event-${sessionId}`, revision: 1 }],
        });
      }
      const logs = storage.openWorkspaceLogQuery?.(['created']);
      expect(logs).toBeDefined();
      const sessions = logs!.listSessions({ limit: 1 });
      expect(sessions.entries).toHaveLength(1);
      expect(sessions.hasMore).toBe(true);
      expect(sessions.nextCursor).toBeDefined();
      const sessionId = sessions.entries[0]!.sessionId;
      expect(
        logs!.listEvents({
          sessionId,
          afterSequence: 0,
          beforeSequence: 2,
          direction: 'forward',
          limit: 1,
        }),
      ).toMatchObject({
        entries: [{ sessionId, sequence: 1, event: { type: 'created' } }],
        observedLastSequence: 1,
      });

      storage.checkpoints.saveNamedSnapshot(sessionId, 'checkpoint-page', state(sessionId, 1), 1);
      const checkpoints = storage.workspaceCheckpointQuery;
      expect(checkpoints).toBeDefined();
      expect(checkpoints!.list({ sessionId, limit: 1 })).toMatchObject({
        entries: [
          {
            checkpointId: 'checkpoint-page',
            sessionId,
            revision: 1,
            eventPosition: 1,
            affectedFileCount: 0,
          },
        ],
        hasMore: false,
      });
      expect(checkpoints!.get(sessionId, 'checkpoint-page')).toMatchObject({
        checkpointId: 'checkpoint-page',
        revision: 1,
      });

      logs!.close();
      expect(storage.sessions.getLastEventPosition(sessionId)).toBe(1);
      storage.close();
    } finally {
      testFixture.cleanup();
    }
  });

  test('binds Session/receipt ownership and retains a validated delete tombstone', () => {
    const testFixture = fixture();
    try {
      const storage = createSqliteRuntimeStorage<Event, State>({
        databasePath: testFixture.path,
        codec,
        workspaceBinding: binding,
        workspaceLayout: testFixture.layout,
        options: { journalMode: 'delete' },
      });
      storage.transactions.commitDecision({
        sessionId: 'session-1',
        events: [{ type: 'committed' }],
        snapshot: state('session-1'),
        metadata: [{ eventId: 'event-1', revision: 1 }],
        commandReceipt: receipt('session-1', 'command-1', 1),
      });
      storage.sessions.deleteSession('session-1', {
        expectedRevision: 1,
        commandReceipt: receipt('session-1', 'delete-1', 1),
      });
      expect(
        storage.commandReceipts.lookup({
          scopeSessionId: 'session-1',
          commandId: 'delete-1',
          requestDigest: 'a'.repeat(64),
        }),
      ).toMatchObject({ status: 'replay' });
      storage.close();

      const database = new Database(testFixture.path, { readonly: true });
      expect(database.query('SELECT COUNT(*) AS count FROM runtime_sessions').get()).toEqual({
        count: 0,
      });
      expect(
        database
          .query(
            'SELECT worker_scope_id, project_id, workspace_digest, deleted_revision FROM session_workspace_tombstone',
          )
          .all(),
      ).toEqual([
        {
          worker_scope_id: binding.workerScopeId,
          project_id: 'project-session-1',
          workspace_digest: 'sha256:workspace-digest',
          deleted_revision: 1,
        },
      ]);
      expect(
        database
          .query(
            'SELECT worker_scope_id, project_id, workspace_digest FROM runtime_command_receipts ORDER BY command_id',
          )
          .all(),
      ).toEqual([
        {
          worker_scope_id: binding.workerScopeId,
          project_id: 'project-session-1',
          workspace_digest: 'sha256:workspace-digest',
        },
        {
          worker_scope_id: binding.workerScopeId,
          project_id: 'project-session-1',
          workspace_digest: 'sha256:workspace-digest',
        },
      ]);
      database.close();

      const reopened = createSqliteRuntimeStorage<Event, State>({
        databasePath: testFixture.path,
        codec,
        workspaceBinding: binding,
        workspaceLayout: testFixture.layout,
        options: { journalMode: 'delete' },
      });
      expect(
        reopened.commandReceipts.lookup({
          scopeSessionId: 'session-1',
          commandId: 'delete-1',
          requestDigest: 'a'.repeat(64),
        }),
      ).toMatchObject({ status: 'replay' });
      reopened.close();
    } finally {
      testFixture.cleanup();
    }
  });

  test('rejects a Store 7 owner/header drift before opening a writer', () => {
    const testFixture = fixture();
    try {
      const storage = createSqliteRuntimeStorage<Event, State>({
        databasePath: testFixture.path,
        codec,
        workspaceBinding: binding,
        workspaceLayout: testFixture.layout,
        options: { journalMode: 'delete' },
      });
      storage.close();
      const database = new Database(testFixture.path);
      database.run(
        "UPDATE runtime_store_meta SET value = 'wrong-scope' WHERE key = 'worker_scope_id'",
      );
      database.close();
      expect(() =>
        createSqliteRuntimeStorage<Event, State>({
          databasePath: testFixture.path,
          codec,
          workspaceBinding: binding,
          workspaceLayout: testFixture.layout,
          options: { journalMode: 'delete' },
        }),
      ).toThrow('pre-write manifest digest');
    } finally {
      testFixture.cleanup();
    }
  });

  test('blocks a receipt whose retained Workspace binding no longer matches its tombstone', () => {
    const testFixture = fixture();
    try {
      const storage = createSqliteRuntimeStorage<Event, State>({
        databasePath: testFixture.path,
        codec,
        workspaceBinding: binding,
        workspaceLayout: testFixture.layout,
        options: { journalMode: 'delete' },
      });
      storage.transactions.commitDecision({
        sessionId: 'session-binding-drift',
        events: [{ type: 'committed' }],
        snapshot: state('session-binding-drift'),
        metadata: [{ eventId: 'event-binding-drift', revision: 1 }],
      });
      storage.sessions.deleteSession('session-binding-drift', {
        expectedRevision: 1,
        commandReceipt: receipt('session-binding-drift', 'delete-binding-drift', 1),
      });
      storage.close();
      const database = new Database(testFixture.path);
      database.run(
        "UPDATE runtime_command_receipts SET workspace_digest = 'sha256:wrong' WHERE command_id = 'delete-binding-drift'",
      );
      database.close();
      expect(() =>
        createSqliteRuntimeStorage<Event, State>({
          databasePath: testFixture.path,
          codec,
          workspaceBinding: binding,
          workspaceLayout: testFixture.layout,
          options: { journalMode: 'delete' },
        }),
      ).toThrow(SqliteRuntimeFormatMismatchError);
    } finally {
      testFixture.cleanup();
    }
  });

  test('enforces generation pointer/journal phases and refuses rollback after first write', () => {
    const root = mkdtempSync(join(process.cwd(), '.kite-layout-'));
    try {
      const paths = ensureSqliteRuntimeLayoutRoot(root);
      const targetGeneration = 'generation-1';
      const journal = {
        schema: 'kite.runtime-migration-journal.v1' as const,
        sourceStoreIdentity: 'source-identity-1',
        sourceStoreDigest: 'a'.repeat(64),
        sourceProfile: {
          stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
          storeSchemaVersion: 6,
          formatEpoch: 'kite-runtime-server-v1-2026-08-26',
        },
        targetLayoutGeneration: targetGeneration,
        targetCatalogDigest: 'b'.repeat(64),
        workspaceStoreDigests: [{ workerScopeId: binding.workerScopeId, digest: 'c'.repeat(64) }],
        pointerPhase: 'source_active' as const,
        targetWriteState: 'none' as const,
        migrationNonce: 'migration-nonce-1',
      };
      const fence = {
        schema: 'kite.runtime-migration-fence.v1' as const,
        sourceStoreIdentity: journal.sourceStoreIdentity,
        sourceStoreDigest: journal.sourceStoreDigest,
        sourceProfile: journal.sourceProfile,
        targetLayoutGeneration: targetGeneration,
        migrationNonce: journal.migrationNonce,
        state: 'active' as const,
      };
      const cutover = createSqliteRuntimeLayoutCutover(paths);
      cutover.prepareTarget(
        {
          schema: 'kite.runtime-layout-manifest.v1',
          generation: targetGeneration,
          profile: {
            stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
            storeSchemaVersion: SQLITE_RUNTIME_WORKSPACE_STORE_SCHEMA_VERSION,
            formatEpoch: SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
          },
          catalogDigest: journal.targetCatalogDigest,
          workspaceStores: journal.workspaceStoreDigests,
        },
        journal,
        fence,
      );
      expect(readSqliteActiveLayoutPointer(paths)).toBeUndefined();
      cutover.switchPointer();
      expect(readSqliteActiveLayoutPointer(paths)?.generation).toBe(targetGeneration);
      expect(canRollbackSqliteRuntimeLayout(cutover.journal())).toBe(true);
      cutover.markTargetWritten();
      expect(canRollbackSqliteRuntimeLayout(cutover.journal())).toBe(false);
      cutover.markTargetReady();
      cutover.commit();
      expect(readSqliteRuntimeMigrationJournal(paths)?.pointerPhase).toBe('committed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects a fence with a different migration nonce before pointer switch', () => {
    const root = mkdtempSync(join(process.cwd(), '.kite-layout-fence-'));
    try {
      const paths = resolveSqliteRuntimeLayoutPaths(root);
      ensureSqliteRuntimeLayoutRoot(root);
      expect(() =>
        writeSqliteRuntimeMigrationFence(paths, {
          schema: 'kite.runtime-migration-fence.v1',
          sourceStoreIdentity: 'source-identity-1',
          sourceStoreDigest: 'a'.repeat(64),
          sourceProfile: {
            stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
            storeSchemaVersion: 6,
            formatEpoch: 'kite-runtime-server-v1-2026-08-26',
          },
          targetLayoutGeneration: 'generation-1',
          migrationNonce: 'nonce-1',
          state: 'active',
        }),
      ).not.toThrow();
      expect(readSqliteRuntimeMigrationJournal(paths)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
