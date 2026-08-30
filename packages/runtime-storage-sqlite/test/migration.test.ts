import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  canRollbackSqliteRuntimeLayout,
  createSqliteRuntimeLayoutCutover,
  createSqliteRuntimeStorage,
  ensureSqliteRuntimeLayoutRoot,
  migrateSqliteRuntimeStoreToWorkspaceLayout,
  readSqliteActiveLayoutPointer,
  readSqliteRuntimeMigrationJournal,
  resolveSqliteRuntimeLayoutPaths,
  resolveSqliteWorkspaceStorePath,
  SQLITE_RUNTIME_FORMAT_EPOCH,
  SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
  SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
  SQLITE_RUNTIME_WORKSPACE_STORE_SCHEMA_VERSION,
  type SqliteRuntimeLayoutManifest,
  type SqliteRuntimeMigrationCatalogBuilder,
  type SqliteRuntimeMigrationCatalogSession,
  type SqliteRuntimeMigrationSourceGuard,
  sqliteRuntimeStoreDigest,
  sqliteRuntimeStoreFingerprint,
  writeSqliteRuntimeLayoutManifest,
  writeSqliteRuntimeMigrationFence,
  writeSqliteRuntimeMigrationJournal,
} from '../src/index';

type Event = { readonly type: string; readonly content?: string };
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
    formatEpoch: SQLITE_RUNTIME_FORMAT_EPOCH,
    revision,
    session: {
      threadId: sessionId,
      projectId: 'project-kite',
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
  readonly root: string;
  readonly sourcePath: string;
  readonly layout: ReturnType<typeof resolveSqliteRuntimeLayoutPaths>;
  cleanup(): void;
} {
  const root = mkdtempSync(join(process.cwd(), '.kite-migration-'));
  const layout = resolveSqliteRuntimeLayoutPaths(join(root, 'home'));
  return {
    root,
    sourcePath: join(root, 'legacy.db'),
    layout,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function seedSource(sourcePath: string, sessionIds: readonly string[], withReceipt = false): void {
  const storage = createSqliteRuntimeStorage<Event, State>({
    databasePath: sourcePath,
    codec,
    options: { journalMode: 'delete' },
  });
  for (const sessionId of sessionIds) {
    storage.transactions.commitDecision({
      sessionId,
      events: [{ type: 'message', content: sessionId }],
      snapshot: state(sessionId),
      metadata: [{ eventId: `${sessionId}-event`, revision: 1 }],
      ...(withReceipt ? { commandReceipt: receipt(sessionId, `${sessionId}-command`, 1) } : {}),
    });
  }
  storage.close();
}

function guardFor(
  fixtureData: ReturnType<typeof fixture>,
  generation: string,
  nonce = 'migration-nonce-1',
): SqliteRuntimeMigrationSourceGuard {
  ensureSqliteRuntimeLayoutRoot(fixtureData.layout.root);
  const sourceStoreIdentity = sqliteRuntimeStoreFingerprint(fixtureData.sourcePath);
  const sourceStoreDigest = sqliteRuntimeStoreDigest(fixtureData.sourcePath);
  const fence = {
    schema: 'kite.runtime-migration-fence.v1' as const,
    sourceStoreIdentity,
    sourceStoreDigest,
    sourceProfile: {
      stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
      storeSchemaVersion: 6,
      formatEpoch: SQLITE_RUNTIME_FORMAT_EPOCH,
    },
    targetLayoutGeneration: generation,
    migrationNonce: nonce,
    state: 'active' as const,
  };
  writeSqliteRuntimeMigrationFence(fixtureData.layout, fence);
  return { serviceAbsent: true, sourceStoreIdentity, sourceStoreDigest, fence };
}

function resolveBinding(generation: string) {
  return (identity: { readonly projectId: string; readonly workspaceDigest: string }) => ({
    layoutGeneration: generation,
    workerScopeId: 'worker-scope-1',
    workspaceIdentityDigest: 'd'.repeat(64),
    projectId: identity.projectId,
    workspaceDigest: identity.workspaceDigest,
  });
}

function fakeCatalogBuilder(): {
  readonly builder: SqliteRuntimeMigrationCatalogBuilder;
  readonly calls: SqliteRuntimeMigrationCatalogSession[][];
} {
  const calls: SqliteRuntimeMigrationCatalogSession[][] = [];
  return {
    calls,
    builder: {
      build(input) {
        calls.push(input.sessions.map((session) => ({ ...session })));
        writeFileSync(
          input.catalogPath,
          JSON.stringify({ generation: input.layoutGeneration, sessions: input.sessions }),
          { mode: 0o600 },
        );
        chmodSync(input.catalogPath, 0o600);
        return sqliteRuntimeStoreDigest(input.catalogPath);
      },
    },
  };
}

describe('offline Store 6 to Workspace Store 7 migration', () => {
  test('copies full validated Session facts, builds Catalog/manifest, and switches once', async () => {
    const testFixture = fixture();
    try {
      seedSource(testFixture.sourcePath, ['session-a', 'session-b'], true);
      const guard = guardFor(testFixture, 'generation-1');
      const catalog = fakeCatalogBuilder();
      const result = await migrateSqliteRuntimeStoreToWorkspaceLayout({
        sourceStorePath: testFixture.sourcePath,
        layout: testFixture.layout,
        targetLayoutGeneration: 'generation-1',
        sourceGuard: guard,
        codec,
        catalogBuilder: catalog.builder,
        resolveWorkspaceBinding: resolveBinding('generation-1'),
      });
      expect(result.status).toBe('committed');
      if (result.status !== 'committed') return;
      expect(readSqliteActiveLayoutPointer(testFixture.layout)?.generation).toBe('generation-1');
      expect(readSqliteRuntimeMigrationJournal(testFixture.layout)?.pointerPhase).toBe('committed');
      expect(
        canRollbackSqliteRuntimeLayout(readSqliteRuntimeMigrationJournal(testFixture.layout)!),
      ).toBe(false);
      expect(sqliteRuntimeStoreDigest(testFixture.sourcePath)).toBe(guard.sourceStoreDigest);

      const targetPath = resolveSqliteWorkspaceStorePath(
        testFixture.layout,
        'generation-1',
        'worker-scope-1',
      );
      const target = createSqliteRuntimeStorage<Event, State>({
        databasePath: targetPath,
        codec,
        workspaceBinding: {
          layoutGeneration: 'generation-1',
          workerScopeId: 'worker-scope-1',
          workspaceIdentityDigest: 'd'.repeat(64),
        },
        workspaceLayout: testFixture.layout,
        options: { journalMode: 'delete' },
      });
      expect(target.sessions.listSessions()).toHaveLength(2);
      expect(
        target.commandReceipts.lookup({
          scopeSessionId: 'session-a',
          commandId: 'session-a-command',
          requestDigest: 'a'.repeat(64),
        }),
      ).toMatchObject({ status: 'replay' });
      target.close();

      const catalogDocument = JSON.parse(
        readFileSync(join(testFixture.layout.layouts, 'generation-1', 'catalog.sqlite'), 'utf8'),
      ) as { generation: string; sessions: SqliteRuntimeMigrationCatalogSession[] };
      expect(catalogDocument.generation).toBe('generation-1');
      expect(catalogDocument.sessions).toHaveLength(2);
      expect(JSON.stringify(catalogDocument)).not.toContain('session-a-command');
      expect(catalog.calls[0]).toEqual([
        {
          sessionId: 'session-a',
          workerScopeId: 'worker-scope-1',
          directoryRevision: '1',
          updatedAt: expect.any(String),
          tombstone: false,
        },
        {
          sessionId: 'session-b',
          workerScopeId: 'worker-scope-1',
          directoryRevision: '2',
          updatedAt: expect.any(String),
          tombstone: false,
        },
      ]);
    } finally {
      testFixture.cleanup();
    }
  });

  test('blocks missing persisted ownership and leaves source/pointer untouched', async () => {
    const testFixture = fixture();
    try {
      seedSource(testFixture.sourcePath, ['session-unowned']);
      const guard = guardFor(testFixture, 'generation-unowned');
      const result = await migrateSqliteRuntimeStoreToWorkspaceLayout({
        sourceStorePath: testFixture.sourcePath,
        layout: testFixture.layout,
        targetLayoutGeneration: 'generation-unowned',
        sourceGuard: guard,
        codec,
        catalogBuilder: fakeCatalogBuilder().builder,
        resolveWorkspaceBinding: () => null,
      });
      expect(result).toMatchObject({ status: 'blocked', reason: 'unowned_session' });
      expect(readSqliteActiveLayoutPointer(testFixture.layout)).toBeUndefined();
      expect(sqliteRuntimeStoreDigest(testFixture.sourcePath)).toBe(guard.sourceStoreDigest);
    } finally {
      testFixture.cleanup();
    }
  });

  test('blocks a deleted retained receipt because Store 6 has no verifiable tombstone ownership', async () => {
    const testFixture = fixture();
    try {
      seedSource(testFixture.sourcePath, ['session-deleted']);
      const source = createSqliteRuntimeStorage<Event, State>({
        databasePath: testFixture.sourcePath,
        codec,
        options: { journalMode: 'delete' },
      });
      source.sessions.deleteSession('session-deleted', {
        expectedRevision: 1,
        commandReceipt: receipt('session-deleted', 'delete-command', 1),
      });
      source.close();
      const guard = guardFor(testFixture, 'generation-orphan');
      const result = await migrateSqliteRuntimeStoreToWorkspaceLayout({
        sourceStorePath: testFixture.sourcePath,
        layout: testFixture.layout,
        targetLayoutGeneration: 'generation-orphan',
        sourceGuard: guard,
        codec,
        catalogBuilder: fakeCatalogBuilder().builder,
        resolveWorkspaceBinding: resolveBinding('generation-orphan'),
      });
      expect(result).toMatchObject({ status: 'blocked', reason: 'orphan_receipt' });
      expect(readSqliteActiveLayoutPointer(testFixture.layout)).toBeUndefined();
    } finally {
      testFixture.cleanup();
    }
  });

  test('blocks corrupt event data before creating an active target', async () => {
    const testFixture = fixture();
    try {
      seedSource(testFixture.sourcePath, ['session-corrupt']);
      const sourceBytesBefore = readFileSync(testFixture.sourcePath);
      const database = new Database(testFixture.sourcePath);
      database.run(
        "UPDATE runtime_events SET event_json = '{broken' WHERE session_id = 'session-corrupt'",
      );
      database.close();
      const guard = guardFor(testFixture, 'generation-corrupt');
      const result = await migrateSqliteRuntimeStoreToWorkspaceLayout({
        sourceStorePath: testFixture.sourcePath,
        layout: testFixture.layout,
        targetLayoutGeneration: 'generation-corrupt',
        sourceGuard: guard,
        codec,
        catalogBuilder: fakeCatalogBuilder().builder,
        resolveWorkspaceBinding: resolveBinding('generation-corrupt'),
      });
      expect(result).toMatchObject({ status: 'blocked', reason: 'source_corrupt' });
      expect(readSqliteActiveLayoutPointer(testFixture.layout)).toBeUndefined();
      expect(readFileSync(testFixture.sourcePath)).not.toEqual(sourceBytesBefore);
    } finally {
      testFixture.cleanup();
    }
  });

  test('records a mid-copy blocked journal and never switches the pointer', async () => {
    const testFixture = fixture();
    try {
      seedSource(testFixture.sourcePath, ['session-a', 'session-b']);
      const guard = guardFor(testFixture, 'generation-interrupted');
      const result = await migrateSqliteRuntimeStoreToWorkspaceLayout({
        sourceStorePath: testFixture.sourcePath,
        layout: testFixture.layout,
        targetLayoutGeneration: 'generation-interrupted',
        sourceGuard: guard,
        codec,
        catalogBuilder: fakeCatalogBuilder().builder,
        resolveWorkspaceBinding: resolveBinding('generation-interrupted'),
        faultAfterSessionCopies: 1,
      });
      expect(result).toMatchObject({ status: 'blocked', reason: 'copy_interrupted' });
      expect(readSqliteActiveLayoutPointer(testFixture.layout)).toBeUndefined();
      expect(readSqliteRuntimeMigrationJournal(testFixture.layout)?.pointerPhase).toBe('blocked');
      expect(sqliteRuntimeStoreDigest(testFixture.sourcePath)).toBe(guard.sourceStoreDigest);
    } finally {
      testFixture.cleanup();
    }
  });

  test('permits only pre-switch/never-written rollback windows', () => {
    const testFixture = fixture();
    try {
      const paths = ensureSqliteRuntimeLayoutRoot(testFixture.layout.root);
      const journal = {
        schema: 'kite.runtime-migration-journal.v1' as const,
        sourceStoreIdentity: 'source-1',
        sourceStoreDigest: 'a'.repeat(64),
        sourceProfile: {
          stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
          storeSchemaVersion: 6,
          formatEpoch: SQLITE_RUNTIME_FORMAT_EPOCH,
        },
        targetLayoutGeneration: 'generation-rollback',
        targetCatalogDigest: 'b'.repeat(64),
        workspaceStoreDigests: [],
        pointerPhase: 'source_active' as const,
        targetWriteState: 'none' as const,
        migrationNonce: 'nonce-rollback',
      };
      const fence = {
        schema: 'kite.runtime-migration-fence.v1' as const,
        sourceStoreIdentity: journal.sourceStoreIdentity,
        sourceStoreDigest: journal.sourceStoreDigest,
        sourceProfile: journal.sourceProfile,
        targetLayoutGeneration: journal.targetLayoutGeneration,
        migrationNonce: journal.migrationNonce,
        state: 'active' as const,
      };
      const manifest: SqliteRuntimeLayoutManifest = {
        schema: 'kite.runtime-layout-manifest.v1' as const,
        generation: journal.targetLayoutGeneration,
        profile: {
          stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
          storeSchemaVersion: SQLITE_RUNTIME_WORKSPACE_STORE_SCHEMA_VERSION,
          formatEpoch: SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
        },
        catalogDigest: journal.targetCatalogDigest,
        workspaceStores: [],
      };
      writeSqliteRuntimeMigrationJournal(paths, journal);
      writeSqliteRuntimeMigrationFence(paths, fence);
      const cutover = createSqliteRuntimeLayoutCutover(paths);
      writeSqliteRuntimeLayoutManifest(paths, manifest);
      cutover.prepareTarget(manifest, journal, fence);
      expect(cutover.journal().pointerPhase).toBe('target_prepared');
      expect(canRollbackSqliteRuntimeLayout(cutover.journal())).toBe(true);
      cutover.switchPointer();
      expect(cutover.journal().pointerPhase).toBe('pointer_switched');
      expect(canRollbackSqliteRuntimeLayout(cutover.journal())).toBe(true);
      cutover.markTargetWritten();
      expect(canRollbackSqliteRuntimeLayout(cutover.journal())).toBe(false);
    } finally {
      testFixture.cleanup();
    }
  });
});
