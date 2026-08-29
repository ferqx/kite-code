import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertSqliteRuntimeRunStoreActive,
  canRollbackSqliteRuntimeLayout,
  createSqliteRuntimeStorage,
  ensureSqliteRuntimeGenerationRoot,
  ensureSqliteRuntimeLayoutRoot,
  ensureSqliteWorkspaceStoreDirectory,
  inspectSqliteRuntimeRunMigrationSource,
  markSqliteRuntimeRunStoreWritten,
  migrateSqliteRuntimeLayoutToRunStore,
  readSqliteActiveLayoutPointer,
  readSqliteRuntimeLayoutManifest,
  readSqliteRuntimeMigrationJournal,
  resolveSqliteCatalogPath,
  resolveSqliteWorkspaceStorePath,
  SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
  SQLITE_RUNTIME_RUN_STORE_SCHEMA_VERSION,
  SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
  SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
  SQLITE_RUNTIME_WORKSPACE_STORE_SCHEMA_VERSION,
  type SqliteRuntimeRunMigrationCatalogPort,
  type SqliteRuntimeRunMigrationMaintenanceBarrier,
  type SqliteRuntimeWorkspaceBinding,
  sqliteRuntimeStoreDigest,
  writeSqliteActiveLayoutPointer,
  writeSqliteRuntimeLayoutManifest,
  writeSqliteRuntimeMigrationFence,
  writeSqliteRuntimeMigrationJournal,
} from '../src';
import { checksum } from '../src/preflight';
import { initializeSqliteRuntimeSchema } from '../src/schema';

type Event = { readonly type: string };
type State = {
  readonly schemaVersion: number;
  readonly revision: number;
  readonly settled: boolean;
  readonly session: {
    readonly threadId: string;
    readonly projectId: string;
    readonly canonicalWorkspaceDigest: string;
  };
};

const SOURCE_GENERATION = 'generation-store-7';
const TARGET_GENERATION = 'generation-store-8';
const binding: SqliteRuntimeWorkspaceBinding = {
  layoutGeneration: SOURCE_GENERATION,
  workerScopeId: 'worker-scope-1',
  workspaceIdentityDigest: 'd'.repeat(64),
};
const barrier: SqliteRuntimeRunMigrationMaintenanceBarrier = {
  coordinatorStopped: true,
  workspaceWorkersStopped: true,
  gatewayStopped: true,
  activeTurns: 0,
  pendingInteractions: 0,
  activeEffects: 0,
  externalProcesses: 0,
};

const codec = {
  encodeEvent: JSON.stringify,
  decodeEvent: (json: string) => JSON.parse(json) as Event,
  encodeState: JSON.stringify,
  decodeState: <T>(json: string) => JSON.parse(json) as T,
  snapshotMetadata: (value: State) => ({
    stateRevision: value.revision,
    schemaVersion: value.schemaVersion,
  }),
  sessionIdentity: (value: State) => ({
    projectId: value.session.projectId,
    canonicalWorkspaceDigest: value.session.canonicalWorkspaceDigest,
  }),
  rebindForkState: (value: State, sessionId: string): State => ({
    ...value,
    session: { ...value.session, threadId: sessionId },
  }),
  validateSnapshot: ({ state: value, sessionId }: { state: State; sessionId: string }) => {
    if (value.session.threadId !== sessionId) throw new Error('Session identity drift');
  },
};

describe('offline Store 7 to Store 8 generation migration', () => {
  test('copies the whole generation, sets coverage, switches once, and fences Store 7', async () => {
    const fixture = createFixture();
    try {
      const sourceStoreDigest = sqliteRuntimeStoreDigest(fixture.sourceStorePath);
      const evidence = inspectSqliteRuntimeRunMigrationSource(fixture.layout);
      const result = await migrateSqliteRuntimeLayoutToRunStore({
        layout: fixture.layout,
        targetLayoutGeneration: TARGET_GENERATION,
        sourceGuard: guard(evidence),
        codec,
        isSessionSettled: (value) => value.settled,
        catalog: catalogPort(),
      });

      expect(result.status).toBe('committed');
      if (result.status !== 'committed') return;
      expect(result.sourceLayoutGeneration).toBe(SOURCE_GENERATION);
      expect(readSqliteActiveLayoutPointer(fixture.layout)?.generation).toBe(TARGET_GENERATION);
      expect(readSqliteRuntimeMigrationJournal(fixture.layout)).toMatchObject({
        pointerPhase: 'committed',
        targetWriteState: 'none',
        sourceProfile: {
          storeSchemaVersion: SQLITE_RUNTIME_WORKSPACE_STORE_SCHEMA_VERSION,
        },
      });
      expect(
        canRollbackSqliteRuntimeLayout(readSqliteRuntimeMigrationJournal(fixture.layout)!),
      ).toBe(false);
      expect(sqliteRuntimeStoreDigest(fixture.sourceStorePath)).toBe(sourceStoreDigest);

      const manifest = readSqliteRuntimeLayoutManifest(fixture.layout, TARGET_GENERATION);
      expect(manifest?.profile).toEqual({
        stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
        storeSchemaVersion: SQLITE_RUNTIME_RUN_STORE_SCHEMA_VERSION,
        formatEpoch: SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
      });
      const targetBinding = { ...binding, layoutGeneration: TARGET_GENERATION };
      const targetPath = resolveSqliteWorkspaceStorePath(
        fixture.layout,
        TARGET_GENERATION,
        binding.workerScopeId,
      );
      expect(() =>
        assertSqliteRuntimeRunStoreActive(fixture.layout, targetBinding, targetPath),
      ).not.toThrow();
      const target = createSqliteRuntimeStorage<Event, State>({
        databasePath: targetPath,
        codec,
        workspaceBinding: targetBinding,
        targetStore: 'run',
        options: { journalMode: 'delete' },
      });
      expect(target.sessions.loadSnapshot<State>('session-1')).toMatchObject({
        revision: 1,
        settled: true,
      });
      expect(target.runs?.list({ sessionId: 'session-1', limit: 10 }).entries).toEqual([]);
      expect(
        target.commandReceipts.lookup({
          scopeSessionId: 'session-1',
          commandId: 'start-before-coverage',
          requestDigest: 'a'.repeat(64),
        }),
      ).toMatchObject({ status: 'replay' });
      target.close();

      const targetDatabase = new Database(targetPath, { readonly: true });
      expect(
        targetDatabase
          .query<{ boundary: number }, []>(
            "SELECT run_index_from_revision AS boundary FROM runtime_sessions WHERE session_id = 'session-1'",
          )
          .get()?.boundary,
      ).toBe(1);
      expect(
        targetDatabase
          .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM runtime_runs')
          .get()?.count,
      ).toBe(0);
      expect(
        targetDatabase
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM session_workspace_tombstone WHERE session_id = 'deleted-session'",
          )
          .get()?.count,
      ).toBe(1);
      const migratedAuthority = targetDatabase
        .query<{ key: string; value: string }, []>(
          "SELECT key, value FROM runtime_store_meta WHERE key LIKE 'workspace_authority_v1:%' ORDER BY key",
        )
        .all();
      expect(migratedAuthority).toHaveLength(2);
      for (const row of migratedAuthority) {
        expect(JSON.parse(row.value)).toMatchObject({
          sessionId: 'session-1',
          layoutGeneration: TARGET_GENERATION,
          workerScopeId: binding.workerScopeId,
          workspaceIdentityDigest: binding.workspaceIdentityDigest,
        });
      }
      expect(
        targetDatabase
          .query<{ value: string }, [string]>(
            'SELECT value FROM runtime_store_meta WHERE key = ? LIMIT 1',
          )
          .get(`recovery_identity_v1:${Buffer.from('session-1', 'utf8').toString('hex')}`)?.value,
      ).toBe('c'.repeat(64));
      targetDatabase.close();

      const committedJournal = readSqliteRuntimeMigrationJournal(fixture.layout)!;
      writeSqliteRuntimeMigrationJournal(fixture.layout, {
        ...committedJournal,
        pointerPhase: 'pointer_switched',
      });
      expect(() =>
        assertSqliteRuntimeRunStoreActive(fixture.layout, targetBinding, targetPath),
      ).toThrow('transition evidence is incomplete');
      writeSqliteRuntimeMigrationJournal(fixture.layout, committedJournal);

      markSqliteRuntimeRunStoreWritten(fixture.layout, targetBinding, targetPath);
      expect(readSqliteRuntimeMigrationJournal(fixture.layout)?.targetWriteState).toBe('written');
      expect(
        canRollbackSqliteRuntimeLayout(readSqliteRuntimeMigrationJournal(fixture.layout)!),
      ).toBe(false);

      expect(() =>
        createSqliteRuntimeStorage<Event, State>({
          databasePath: fixture.sourceStorePath,
          codec,
          workspaceBinding: binding,
          workspaceLayout: fixture.layout,
          options: { journalMode: 'delete' },
        }),
      ).toThrow();
    } finally {
      fixture.cleanup();
    }
  });

  test('blocks active work and copy faults without publishing a partial generation', async () => {
    const active = createFixture({ settled: false });
    try {
      const evidence = inspectSqliteRuntimeRunMigrationSource(active.layout);
      const result = await migrateSqliteRuntimeLayoutToRunStore({
        layout: active.layout,
        targetLayoutGeneration: TARGET_GENERATION,
        sourceGuard: guard(evidence),
        codec,
        isSessionSettled: (value) => value.settled,
        catalog: catalogPort(),
      });
      expect(result).toMatchObject({ status: 'blocked', reason: 'active_work' });
      expect(readSqliteActiveLayoutPointer(active.layout)?.generation).toBe(SOURCE_GENERATION);
      expect(readSqliteRuntimeMigrationJournal(active.layout)?.pointerPhase).toBe('blocked');
      expect(() =>
        createSqliteRuntimeStorage<Event, State>({
          databasePath: active.sourceStorePath,
          codec,
          workspaceBinding: binding,
          workspaceLayout: active.layout,
          options: { journalMode: 'delete' },
        }),
      ).toThrow();
    } finally {
      active.cleanup();
    }

    const activeAuthority = createFixture({ authorityStatus: 'active' });
    try {
      const evidence = inspectSqliteRuntimeRunMigrationSource(activeAuthority.layout);
      const result = await migrateSqliteRuntimeLayoutToRunStore({
        layout: activeAuthority.layout,
        targetLayoutGeneration: TARGET_GENERATION,
        sourceGuard: guard(evidence),
        codec,
        isSessionSettled: (value) => value.settled,
        catalog: catalogPort(),
      });
      expect(result).toMatchObject({ status: 'blocked', reason: 'active_work' });
      expect(readSqliteActiveLayoutPointer(activeAuthority.layout)?.generation).toBe(
        SOURCE_GENERATION,
      );
    } finally {
      activeAuthority.cleanup();
    }

    const interrupted = createFixture();
    try {
      const evidence = inspectSqliteRuntimeRunMigrationSource(interrupted.layout);
      const result = await migrateSqliteRuntimeLayoutToRunStore({
        layout: interrupted.layout,
        targetLayoutGeneration: TARGET_GENERATION,
        sourceGuard: guard(evidence),
        codec,
        isSessionSettled: (value) => value.settled,
        catalog: catalogPort(),
        faultAfterWorkspaceCopies: 1,
      });
      expect(result).toMatchObject({ status: 'blocked', reason: 'copy_interrupted' });
      expect(readSqliteActiveLayoutPointer(interrupted.layout)?.generation).toBe(SOURCE_GENERATION);
      expect(readSqliteRuntimeMigrationJournal(interrupted.layout)?.targetWriteState).toBe('none');
    } finally {
      interrupted.cleanup();
    }
  });

  test('requires the exact maintenance barrier and rejects unmanifested Workspaces', async () => {
    const fixture = createFixture();
    try {
      const evidence = inspectSqliteRuntimeRunMigrationSource(fixture.layout);
      const result = await migrateSqliteRuntimeLayoutToRunStore({
        layout: fixture.layout,
        targetLayoutGeneration: TARGET_GENERATION,
        sourceGuard: {
          ...guard(evidence),
          maintenanceBarrier: { ...barrier, coordinatorStopped: false as never },
        },
        codec,
        isSessionSettled: (value) => value.settled,
        catalog: catalogPort(),
      });
      expect(result).toEqual({ status: 'blocked', reason: 'maintenance_required' });
      expect(readSqliteActiveLayoutPointer(fixture.layout)?.generation).toBe(SOURCE_GENERATION);

      const extraField = await migrateSqliteRuntimeLayoutToRunStore({
        layout: fixture.layout,
        targetLayoutGeneration: TARGET_GENERATION,
        sourceGuard: {
          ...guard(evidence),
          maintenanceBarrier: { ...barrier, unexpected: true } as never,
        },
        codec,
        isSessionSettled: (value) => value.settled,
        catalog: catalogPort(),
      });
      expect(extraField).toEqual({ status: 'blocked', reason: 'maintenance_required' });

      mkdirSync(join(fixture.layout.layouts, SOURCE_GENERATION, 'workers', 'extra-scope'), {
        recursive: true,
      });
      expect(() => inspectSqliteRuntimeRunMigrationSource(fixture.layout)).toThrow(
        'unmanifested or missing Workspace',
      );
    } finally {
      fixture.cleanup();
    }
  });

  test('blocks corrupt source facts and Catalog copy failure for the whole generation', async () => {
    const corrupt = createFixture();
    try {
      const journal = readSqliteRuntimeMigrationJournal(corrupt.layout)!;
      writeSqliteRuntimeMigrationJournal(corrupt.layout, {
        ...journal,
        targetWriteState: 'written',
      });
      const database = new Database(corrupt.sourceStorePath);
      database.run("UPDATE runtime_events SET event_json = '{broken'");
      database.close();
      const evidence = inspectSqliteRuntimeRunMigrationSource(corrupt.layout);
      const result = await migrateSqliteRuntimeLayoutToRunStore({
        layout: corrupt.layout,
        targetLayoutGeneration: TARGET_GENERATION,
        sourceGuard: guard(evidence),
        codec,
        isSessionSettled: (value) => value.settled,
        catalog: catalogPort(),
      });
      expect(result).toMatchObject({ status: 'blocked', reason: 'source_corrupt' });
      expect(readSqliteActiveLayoutPointer(corrupt.layout)?.generation).toBe(SOURCE_GENERATION);
    } finally {
      corrupt.cleanup();
    }

    const corruptAuthority = createFixture();
    try {
      const journal = readSqliteRuntimeMigrationJournal(corruptAuthority.layout)!;
      writeSqliteRuntimeMigrationJournal(corruptAuthority.layout, {
        ...journal,
        targetWriteState: 'written',
      });
      const database = new Database(corruptAuthority.sourceStorePath);
      database.run(
        "UPDATE runtime_store_meta SET value = '{broken' WHERE key = 'workspace_authority_v1:controller:session-1'",
      );
      database.close();
      const evidence = inspectSqliteRuntimeRunMigrationSource(corruptAuthority.layout);
      const result = await migrateSqliteRuntimeLayoutToRunStore({
        layout: corruptAuthority.layout,
        targetLayoutGeneration: TARGET_GENERATION,
        sourceGuard: guard(evidence),
        codec,
        isSessionSettled: (value) => value.settled,
        catalog: catalogPort(),
      });
      expect(result).toMatchObject({ status: 'blocked', reason: 'source_corrupt' });
    } finally {
      corruptAuthority.cleanup();
    }

    const catalogFailure = createFixture();
    try {
      const evidence = inspectSqliteRuntimeRunMigrationSource(catalogFailure.layout);
      const result = await migrateSqliteRuntimeLayoutToRunStore({
        layout: catalogFailure.layout,
        targetLayoutGeneration: TARGET_GENERATION,
        sourceGuard: guard(evidence),
        codec,
        isSessionSettled: (value) => value.settled,
        catalog: {
          copy: () => {
            throw new Error('injected Catalog copy failure');
          },
        },
      });
      expect(result).toMatchObject({ status: 'blocked', reason: 'target_invalid' });
      expect(readSqliteActiveLayoutPointer(catalogFailure.layout)?.generation).toBe(
        SOURCE_GENERATION,
      );
    } finally {
      catalogFailure.cleanup();
    }
  });

  test('reads a safe WAL source only through its isolated snapshot', async () => {
    const fixture = createFixture();
    let live: Database | undefined;
    try {
      const journal = readSqliteRuntimeMigrationJournal(fixture.layout)!;
      writeSqliteRuntimeMigrationJournal(fixture.layout, {
        ...journal,
        targetWriteState: 'written',
      });
      live = new Database(fixture.sourceStorePath);
      live.run('PRAGMA journal_mode = WAL');
      live.run(
        "INSERT OR REPLACE INTO runtime_store_meta (key, value) VALUES ('migration_wal_marker', 'present')",
      );
      const evidence = inspectSqliteRuntimeRunMigrationSource(fixture.layout);
      const result = await migrateSqliteRuntimeLayoutToRunStore({
        layout: fixture.layout,
        targetLayoutGeneration: TARGET_GENERATION,
        sourceGuard: guard(evidence),
        codec,
        isSessionSettled: (value) => value.settled,
        catalog: catalogPort(),
      });
      expect(result.status).toBe('committed');
      const targetPath = resolveSqliteWorkspaceStorePath(
        fixture.layout,
        TARGET_GENERATION,
        binding.workerScopeId,
      );
      const target = new Database(targetPath, { readonly: true });
      expect(
        target
          .query<{ value: string }, []>(
            "SELECT value FROM runtime_store_meta WHERE key = 'migration_wal_marker'",
          )
          .get()?.value,
      ).toBe('present');
      target.close();
    } finally {
      live?.close();
      fixture.cleanup();
    }
  });
});

function guard(evidence: ReturnType<typeof inspectSqliteRuntimeRunMigrationSource>) {
  return {
    ...evidence,
    maintenanceBarrier: barrier,
    fence: {
      schema: 'kite.runtime-migration-fence.v1' as const,
      sourceStoreIdentity: evidence.sourceStoreIdentity,
      sourceStoreDigest: evidence.sourceStoreDigest,
      sourceProfile: evidence.sourceProfile,
      targetLayoutGeneration: TARGET_GENERATION,
      migrationNonce: 'store-8-migration-nonce',
      state: 'active' as const,
    },
  };
}

function state(settled: boolean): State {
  return {
    schemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
    revision: 1,
    settled,
    session: {
      threadId: 'session-1',
      projectId: 'project-1',
      canonicalWorkspaceDigest: 'workspace-digest-1',
    },
  };
}

function createFixture(
  options: { readonly settled?: boolean; readonly authorityStatus?: 'idle' | 'active' } = {},
) {
  const root = mkdtempSync(join(process.cwd(), '.kite-run-migration-'));
  const layout = ensureSqliteRuntimeLayoutRoot(join(root, 'home'));
  ensureSqliteRuntimeGenerationRoot(layout, SOURCE_GENERATION);
  const sourceStorePath = ensureSqliteWorkspaceStoreDirectory(
    layout,
    SOURCE_GENERATION,
    binding.workerScopeId,
  );
  const database = new Database(sourceStorePath);
  initializeSqliteRuntimeSchema(database, {
    stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
    storeSchemaVersion: SQLITE_RUNTIME_WORKSPACE_STORE_SCHEMA_VERSION,
    formatEpoch: SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
    workspaceBinding: binding,
  });
  const sourceState = state(options.settled ?? true);
  const stateJson = JSON.stringify(sourceState);
  database.run(
    `INSERT INTO runtime_sessions (
      session_id, project_id, workspace_digest, worker_scope_id, workspace_identity_digest,
      state_schema, format_epoch, revision, name, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      'session-1',
      'project-1',
      'workspace-digest-1',
      binding.workerScopeId,
      binding.workspaceIdentityDigest,
      SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
      SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
      1,
      'Session 1',
      100,
    ],
  );
  database.run(
    'INSERT INTO runtime_events (session_id, event_id, sequence, schema_version, event_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ['session-1', 'event-1', 1, SQLITE_RUNTIME_STATE_SCHEMA_VERSION, '{"type":"settled"}', 100],
  );
  database.run(
    `INSERT INTO runtime_snapshots (
      session_id, schema_version, format_epoch, revision, state_json, event_position,
      state_checksum, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      'session-1',
      SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
      SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
      1,
      stateJson,
      1,
      checksum(stateJson),
      100,
    ],
  );
  database.run(
    `INSERT INTO runtime_command_receipts (
      scope_session_id, command_id, worker_scope_id, project_id, workspace_digest,
      request_digest, target_session_id, original_receipt_json, committed_revision, committed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      'session-1',
      'start-before-coverage',
      binding.workerScopeId,
      'project-1',
      'workspace-digest-1',
      'a'.repeat(64),
      'session-1',
      '{"status":"applied","commandId":"start-before-coverage","sessionId":"session-1","revision":1}',
      1,
      100,
    ],
  );
  const authorityBinding = {
    layoutGeneration: SOURCE_GENERATION,
    workerScopeId: binding.workerScopeId,
    workspaceIdentityDigest: binding.workspaceIdentityDigest,
  };
  const authorityStatus = options.authorityStatus ?? 'idle';
  database.query('INSERT INTO runtime_store_meta (key, value) VALUES (?, ?)').run(
    'workspace_authority_v1:controller:session-1',
    JSON.stringify({
      schema: 'kite.runtime-workspace-authority.v1',
      sessionId: 'session-1',
      ...authorityBinding,
      status: authorityStatus,
      controllerGeneration: authorityStatus === 'active' ? 1 : 0,
      connectionGeneration: authorityStatus === 'active' ? 1 : 0,
      interactionGeneration: 0,
      clientId: authorityStatus === 'active' ? 'client-1' : null,
      workerInstanceId: authorityStatus === 'active' ? 'worker-1' : null,
      resumeCapabilityHash: null,
      resumeCapabilityExpiresAtMs: null,
      updatedAt: 100,
    }),
  );
  database
    .query('INSERT INTO runtime_store_meta (key, value) VALUES (?, ?)')
    .run(
      `recovery_identity_v1:${Buffer.from('session-1', 'utf8').toString('hex')}`,
      'c'.repeat(64),
    );
  database.query('INSERT INTO runtime_store_meta (key, value) VALUES (?, ?)').run(
    'workspace_authority_v1:recovery:session-1',
    JSON.stringify({
      schema: 'kite.runtime-recovery-state.v1',
      sessionId: 'session-1',
      ...authorityBinding,
      status: 'normal',
      controllerGeneration: authorityStatus === 'active' ? 1 : 0,
      interactionGeneration: 0,
      updatedAt: 100,
    }),
  );
  database.run(
    'INSERT INTO session_workspace_tombstone (session_id, worker_scope_id, project_id, workspace_digest, deleted_revision, deleted_at) VALUES (?, ?, ?, ?, ?, ?)',
    ['deleted-session', binding.workerScopeId, 'project-1', 'workspace-digest-1', 2, 101],
  );
  database.run(
    `INSERT INTO runtime_command_receipts (
      scope_session_id, command_id, worker_scope_id, project_id, workspace_digest,
      request_digest, target_session_id, original_receipt_json, committed_revision, committed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      'deleted-session',
      'delete-session',
      binding.workerScopeId,
      'project-1',
      'workspace-digest-1',
      'b'.repeat(64),
      'deleted-session',
      '{"status":"applied","commandId":"delete-session","sessionId":"deleted-session","revision":2}',
      2,
      101,
    ],
  );
  database.run(
    'INSERT INTO session_directory_outbox (session_id, worker_scope_id, revision, updated_at, tombstone) VALUES (?, ?, ?, ?, ?)',
    ['session-1', binding.workerScopeId, 1, 100, 0],
  );
  database.run('PRAGMA journal_mode = DELETE');
  database.close();
  chmodSync(sourceStorePath, 0o600);

  const catalogPath = resolveSqliteCatalogPath(layout, SOURCE_GENERATION);
  const catalog = new Database(catalogPath);
  catalog.run('CREATE TABLE catalog_meta (generation TEXT PRIMARY KEY)');
  catalog.run('CREATE TABLE catalog_sessions (session_id TEXT PRIMARY KEY, worker_scope_id TEXT)');
  catalog.run('INSERT INTO catalog_meta VALUES (?)', [SOURCE_GENERATION]);
  catalog.run('INSERT INTO catalog_sessions VALUES (?, ?)', ['session-1', binding.workerScopeId]);
  catalog.run('PRAGMA journal_mode = DELETE');
  catalog.close();
  chmodSync(catalogPath, 0o600);

  const catalogDigest = sqliteRuntimeStoreDigest(catalogPath);
  const storeDigest = sqliteRuntimeStoreDigest(sourceStorePath);
  const journal = {
    schema: 'kite.runtime-migration-journal.v1' as const,
    sourceStoreIdentity: 'legacy-source',
    sourceStoreDigest: '0'.repeat(64),
    sourceProfile: {
      stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
      storeSchemaVersion: 6,
      formatEpoch: 'kite-runtime-server-v1-2026-08-26',
    },
    targetLayoutGeneration: SOURCE_GENERATION,
    targetCatalogDigest: catalogDigest,
    workspaceStoreDigests: [{ workerScopeId: binding.workerScopeId, digest: storeDigest }],
    pointerPhase: 'committed' as const,
    targetWriteState: 'none' as const,
    migrationNonce: 'store-7-migration-nonce',
  };
  writeSqliteRuntimeMigrationJournal(layout, journal);
  writeSqliteRuntimeMigrationFence(layout, {
    schema: 'kite.runtime-migration-fence.v1',
    sourceStoreIdentity: journal.sourceStoreIdentity,
    sourceStoreDigest: journal.sourceStoreDigest,
    sourceProfile: journal.sourceProfile,
    targetLayoutGeneration: SOURCE_GENERATION,
    migrationNonce: journal.migrationNonce,
    state: 'active',
  });
  writeSqliteRuntimeLayoutManifest(layout, {
    schema: 'kite.runtime-layout-manifest.v1',
    generation: SOURCE_GENERATION,
    profile: {
      stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
      storeSchemaVersion: SQLITE_RUNTIME_WORKSPACE_STORE_SCHEMA_VERSION,
      formatEpoch: SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
    },
    catalogDigest,
    workspaceStores: journal.workspaceStoreDigests,
  });
  writeSqliteActiveLayoutPointer(layout, {
    schema: 'kite.runtime-active-layout.v1',
    generation: SOURCE_GENERATION,
  });
  return {
    layout,
    sourceStorePath,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function catalogPort(): SqliteRuntimeRunMigrationCatalogPort {
  return {
    copy(input) {
      const source = new Database(input.sourceCatalogPath, { readonly: true });
      const sourceGeneration = source
        .query<{ generation: string }, []>('SELECT generation FROM catalog_meta')
        .get()?.generation;
      if (sourceGeneration !== input.sourceLayoutGeneration) {
        source.close();
        throw new Error('Catalog source generation mismatch');
      }
      const sessions = source
        .query<{ session_id: string; worker_scope_id: string }, []>(
          'SELECT session_id, worker_scope_id FROM catalog_sessions ORDER BY session_id',
        )
        .all();
      source.close();
      const target = new Database(input.targetCatalogPath);
      target.run('CREATE TABLE catalog_meta (generation TEXT PRIMARY KEY)');
      target.run(
        'CREATE TABLE catalog_sessions (session_id TEXT PRIMARY KEY, worker_scope_id TEXT)',
      );
      target.run('INSERT INTO catalog_meta VALUES (?)', [input.targetLayoutGeneration]);
      for (const session of sessions) {
        target.run('INSERT INTO catalog_sessions VALUES (?, ?)', [
          session.session_id,
          session.worker_scope_id,
        ]);
      }
      target.run('PRAGMA journal_mode = DELETE');
      target.close();
      chmodSync(input.targetCatalogPath, 0o600);
      return sqliteRuntimeStoreDigest(input.targetCatalogPath);
    },
  };
}
