import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCoordinatorCatalog } from '@kite-ai/kite-local-runtime/coordinator';
import {
  createKiteHomeIdentity,
  ensureLocalRuntimeServiceHome,
} from '@kite-ai/kite-local-runtime/service';
import { createRuntimeHostStateStorageBinding } from '@kite-ai/runtime-host';
import {
  createSqliteRuntimeStorage,
  ensureSqliteRuntimeLayoutRoot,
  readSqliteActiveLayoutPointer,
  readSqliteRuntimeLayoutManifest,
  readSqliteRuntimeMigrationFence,
  readSqliteRuntimeMigrationJournal,
  resolveSqliteCatalogPath,
  resolveSqliteRuntimeLayoutPaths,
  SQLITE_RUNTIME_FORMAT_EPOCH,
  SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
  SQLITE_RUNTIME_RUN_STORE_SCHEMA_VERSION,
  SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
  SQLITE_RUNTIME_STORE_SCHEMA_VERSION,
  type SqliteRuntimeMigrationSourceGuard,
  sqliteRuntimeStoreDigest,
  sqliteRuntimeStoreFingerprint,
  writeSqliteRuntimeMigrationFence,
} from '@kite-ai/runtime-storage-sqlite';
import { createSqliteRuntimeMigrationCatalogBuilder } from '../../apps/kite-service/src/coordinator/catalog-builder';
import {
  runLocalLayoutMigration,
  runLocalRunStoreMigration,
} from '../../scripts/release/local-layout-migration';
import { createLocalRunStoreMaintenance } from '../../scripts/release/local-run-store-maintenance';

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

function state(sessionId: string): State {
  return {
    schemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
    formatEpoch: SQLITE_RUNTIME_FORMAT_EPOCH,
    revision: 1,
    session: {
      threadId: sessionId,
      projectId: 'project-kite',
      canonicalWorkspaceDigest: 'sha256:workspace-digest',
    },
  };
}

function fixture(): { readonly root: string; readonly home: string; readonly source: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-layout-maintenance-')));
  const home = ensureLocalRuntimeServiceHome(createKiteHomeIdentity(join(root, 'home'))).root;
  return { root, home, source: join(root, 'legacy.sqlite') };
}

function sourceGuard(
  source: string,
  layout: ReturnType<typeof resolveSqliteRuntimeLayoutPaths>,
  generation: string,
): SqliteRuntimeMigrationSourceGuard {
  const sourceStoreIdentity = sqliteRuntimeStoreFingerprint(source);
  const sourceStoreDigest = sqliteRuntimeStoreDigest(source);
  const fence = {
    schema: 'kite.runtime-migration-fence.v1' as const,
    sourceStoreIdentity,
    sourceStoreDigest,
    sourceProfile: {
      stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
      storeSchemaVersion: SQLITE_RUNTIME_STORE_SCHEMA_VERSION,
      formatEpoch: SQLITE_RUNTIME_FORMAT_EPOCH,
    },
    targetLayoutGeneration: generation,
    migrationNonce: 'explicit-layout-migration-test',
    state: 'active' as const,
  };
  ensureSqliteRuntimeLayoutRoot(layout.root);
  writeSqliteRuntimeMigrationFence(layout, fence);
  return { serviceAbsent: true, sourceStoreIdentity, sourceStoreDigest, fence };
}

describe('explicit local Store layout maintenance', () => {
  test('initializes a genuinely fresh home with the real empty Coordinator Catalog', async () => {
    const data = fixture();
    try {
      const result = await runLocalLayoutMigration({
        home: createKiteHomeIdentity(data.home),
        sourceStorePath: data.source,
        createMigrationNonce: () => 'fresh-layout-test',
      });
      expect(result.status).toBe('initialized');
      if (result.status !== 'initialized') return;

      const layout = resolveSqliteRuntimeLayoutPaths(data.home);
      expect(readSqliteActiveLayoutPointer(layout)).toEqual({
        schema: 'kite.runtime-active-layout.v1',
        generation: 'generation-initial',
      });
      expect(readSqliteRuntimeMigrationJournal(layout)).toMatchObject({
        pointerPhase: 'committed',
        targetWriteState: 'none',
        targetLayoutGeneration: 'generation-initial',
        workspaceStoreDigests: [],
      });
      expect(readSqliteRuntimeMigrationFence(layout)).toMatchObject({
        sourceStoreIdentity: 'kite-fresh-home-no-source-v1',
        targetLayoutGeneration: 'generation-initial',
      });
      expect(readSqliteRuntimeLayoutManifest(layout, 'generation-initial')).toMatchObject({
        generation: 'generation-initial',
        profile: {
          storeSchemaVersion: SQLITE_RUNTIME_RUN_STORE_SCHEMA_VERSION,
          formatEpoch: SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
        },
        workspaceStores: [],
        catalogDigest: result.catalogDigest,
      });
      expect(result.catalogDigest).toBe(sqliteRuntimeStoreDigest(result.catalogPath));
      expect(existsSync(`${result.catalogPath}-wal`)).toBe(false);
      expect(existsSync(`${result.catalogPath}-shm`)).toBe(false);

      const catalog = openCoordinatorCatalog({
        canonicalKiteHomeRoot: realpathSync(data.home),
        layoutGeneration: 'generation-initial',
        catalogPath: result.catalogPath,
        mode: 'open_active',
      });
      expect(catalog.listSessions()).toEqual([]);
      catalog.close();
    } finally {
      rmSync(data.root, { recursive: true, force: true });
    }
  });

  test('classifies an explicit legacy source without silently migrating it', async () => {
    const data = fixture();
    try {
      writeFileSync(data.source, 'legacy-source-marker', { mode: 0o600 });
      const result = await runLocalLayoutMigration({
        home: data.home,
        sourceStorePath: data.source,
      });
      expect(result).toEqual({
        status: 'migration_required',
        sourceStorePath: data.source,
        reason: 'legacy_store_present',
      });
      expect(existsSync(join(data.home, 'active-layout'))).toBe(false);
      expect(existsSync(join(data.home, 'layouts'))).toBe(false);
      expect(readFileSync(data.source, 'utf8')).toBe('legacy-source-marker');
    } finally {
      rmSync(data.root, { recursive: true, force: true });
    }
  });

  test('requires persisted workspace identity evidence before explicit migration', async () => {
    const data = fixture();
    try {
      writeFileSync(data.source, 'legacy-source-marker', { mode: 0o600 });
      const layout = resolveSqliteRuntimeLayoutPaths(data.home);
      const guard = sourceGuard(data.source, layout, 'generation-explicit');
      const result = await runLocalLayoutMigration({
        home: data.home,
        sourceStorePath: data.source,
        allowLegacyMigration: true,
        targetLayoutGeneration: 'generation-explicit',
      });
      expect(result).toEqual({
        status: 'migration_required',
        sourceStorePath: data.source,
        reason: 'workspace_identity_required',
      });
      expect(readSqliteRuntimeMigrationFence(layout)).toEqual(guard.fence);
      expect(readSqliteActiveLayoutPointer(layout)).toBeUndefined();
    } finally {
      rmSync(data.root, { recursive: true, force: true });
    }
  });

  test('blocks fresh initialization when layout evidence already exists', async () => {
    const data = fixture();
    try {
      const layout = resolveSqliteRuntimeLayoutPaths(data.home);
      ensureSqliteRuntimeLayoutRoot(layout.root);
      writeFileSync(layout.migrationJournal, '{"not":"a migration journal"}', { mode: 0o600 });
      const result = await runLocalLayoutMigration({
        home: data.home,
        sourceStorePath: data.source,
      });
      expect(result).toEqual({ status: 'blocked', reason: 'layout_invalid' });
      expect(existsSync(resolveSqliteCatalogPath(layout, 'generation-initial'))).toBe(false);
    } finally {
      rmSync(data.root, { recursive: true, force: true });
    }
  });

  test('requires a dead/absent Service and leaves the source immutable', async () => {
    const data = fixture();
    try {
      const source = createSqliteRuntimeStorage<Event, State>({
        databasePath: data.source,
        codec,
        options: { journalMode: 'delete' },
      });
      source.transactions.commitDecision({
        sessionId: 'session-a',
        events: [{ type: 'message', content: 'migration-a' }],
        snapshot: state('session-a'),
        metadata: [{ eventId: 'event-a', revision: 1 }],
      });
      source.close();
      const sourceDigest = sqliteRuntimeStoreDigest(data.source);
      const layout = resolveSqliteRuntimeLayoutPaths(data.home);
      sourceGuard(data.source, layout, 'generation-real');

      const present = await runLocalLayoutMigration({
        home: data.home,
        sourceStorePath: data.source,
        allowLegacyMigration: true,
        targetLayoutGeneration: 'generation-real',
        inspectService: () => 'present',
        codec,
        resolveWorkspaceBinding: () => null,
      });
      expect(present).toEqual({ status: 'blocked', reason: 'service_present' });
      expect(sqliteRuntimeStoreDigest(data.source)).toBe(sourceDigest);
      expect(readSqliteActiveLayoutPointer(layout)).toBeUndefined();
    } finally {
      rmSync(data.root, { recursive: true, force: true });
    }
  });

  test('composes explicit identity, current codec, migration and real Catalog builder', async () => {
    const data = fixture();
    try {
      const source = createSqliteRuntimeStorage<Event, State>({
        databasePath: data.source,
        codec,
        options: { journalMode: 'delete' },
      });
      source.transactions.commitDecision({
        sessionId: 'session-a',
        events: [{ type: 'message', content: 'migration-a' }],
        snapshot: state('session-a'),
        metadata: [{ eventId: 'event-a', revision: 1 }],
      });
      source.close();
      const sourceDigest = sqliteRuntimeStoreDigest(data.source);
      const layout = resolveSqliteRuntimeLayoutPaths(data.home);
      sourceGuard(data.source, layout, 'generation-real');
      const result = await runLocalLayoutMigration({
        home: data.home,
        sourceStorePath: data.source,
        allowLegacyMigration: true,
        targetLayoutGeneration: 'generation-real',
        codec,
        catalogBuilder: createSqliteRuntimeMigrationCatalogBuilder({
          canonicalKiteHomeRoot: realpathSync(data.home),
        }),
        resolveWorkspaceBinding: ({ projectId, workspaceDigest }) => ({
          layoutGeneration: 'generation-real',
          workerScopeId: 'worker-scope-real',
          workspaceIdentityDigest: 'd'.repeat(64),
          projectId,
          workspaceDigest,
        }),
      });
      expect(result.status).toBe('migrated');
      if (result.status !== 'migrated') return;
      expect(result.workspaceStoreDigests).toHaveLength(1);
      expect(readSqliteRuntimeMigrationJournal(layout)?.pointerPhase).toBe('committed');
      expect(readSqliteActiveLayoutPointer(layout)?.generation).toBe('generation-real');
      expect(sqliteRuntimeStoreDigest(data.source)).toBe(sourceDigest);
      const catalogPath = resolveSqliteCatalogPath(layout, 'generation-real');
      expect(result.catalogDigest).toBe(sqliteRuntimeStoreDigest(catalogPath));
      expect(existsSync(`${catalogPath}-wal`)).toBe(false);
      expect(existsSync(`${catalogPath}-shm`)).toBe(false);
      expect(readSqliteRuntimeLayoutManifest(layout, 'generation-real')).toMatchObject({
        catalogDigest: result.catalogDigest,
        workspaceStores: [{ workerScopeId: 'worker-scope-real' }],
      });

      const runMigration = await runLocalRunStoreMigration({
        home: data.home,
        targetLayoutGeneration: 'generation-run-store',
        codec,
        isSessionSettled: () => true,
        inspectMaintenanceBarrier: () => ({
          coordinatorStopped: true,
          workspaceWorkersStopped: true,
          gatewayStopped: true,
          activeTurns: 0,
          pendingInteractions: 0,
          activeEffects: 0,
          externalProcesses: 0,
        }),
        createMigrationNonce: () => 'run-store-layout-migration-test',
      });
      expect(runMigration.status).toBe('committed');
      expect(readSqliteActiveLayoutPointer(layout)?.generation).toBe('generation-run-store');
      expect(
        readSqliteRuntimeLayoutManifest(layout, 'generation-run-store')?.profile,
      ).toMatchObject({ storeSchemaVersion: SQLITE_RUNTIME_RUN_STORE_SCHEMA_VERSION });
    } finally {
      rmSync(data.root, { recursive: true, force: true });
    }
  });

  test('runs the formal command owner only after the managed process chain is absent', async () => {
    const data = fixture();
    try {
      const currentCodec = createRuntimeHostStateStorageBinding().codec;
      createSqliteRuntimeStorage({
        databasePath: data.source,
        codec: currentCodec,
        options: { journalMode: 'delete' },
      }).close();
      const layout = resolveSqliteRuntimeLayoutPaths(data.home);
      sourceGuard(data.source, layout, 'generation-command-source');
      const sourceMigration = await runLocalLayoutMigration({
        home: data.home,
        sourceStorePath: data.source,
        allowLegacyMigration: true,
        targetLayoutGeneration: 'generation-command-source',
        codec: currentCodec,
        catalogBuilder: createSqliteRuntimeMigrationCatalogBuilder({
          canonicalKiteHomeRoot: realpathSync(data.home),
        }),
        resolveWorkspaceBinding: () => {
          throw new Error('Empty source must not request a Workspace binding.');
        },
      });
      expect(sourceMigration.status).toBe('migrated');

      const home = createKiteHomeIdentity(realpathSync(data.home));
      const result = await createLocalRunStoreMaintenance({
        home,
        coordinationHome: home,
        coordinator: {
          stop: async () => ({
            requestId: 'maintenance-stop',
            operation: 'stop',
            outcome: 'applied',
            state: 'absent',
            diagnostic: 'not_running',
          }),
          status: async () => ({
            requestId: 'maintenance-status',
            operation: 'status',
            outcome: 'applied',
            state: 'absent',
            diagnostic: 'not_running',
          }),
          acquireMaintenanceLock: async () => ({
            kind: 'lifecycle',
            identity: {
              schema: 'kite.local-coordinator-lock.v1',
              kind: 'lifecycle',
              nonce: 'maintenance-test-lock',
              pid: process.pid,
              instanceId: 'maintenance-test',
              startedAt: '2026-08-30T00:00:00.000Z',
              processStartIdentity: 'maintenance-test-start',
              buildId: 'maintenance-test-build',
              operation: 'stop',
              createdAt: '2026-08-30T00:00:00.000Z',
            },
            release: async () => undefined,
          }),
          confirmAbsentWhileLocked: async () => true,
        },
      }).migrate({ targetLayoutGeneration: 'generation-command-target' });
      if (result.status !== 'committed') {
        throw new Error(`Formal migration unexpectedly blocked: ${JSON.stringify(result)}`);
      }
      expect(result.status).toBe('committed');
      expect(readSqliteActiveLayoutPointer(layout)?.generation).toBe('generation-command-target');
    } finally {
      rmSync(data.root, { recursive: true, force: true });
    }
  });

  test('blocks the formal command when it cannot hold the Coordinator lifecycle lock', async () => {
    const data = fixture();
    try {
      const home = createKiteHomeIdentity(data.home);
      const result = await createLocalRunStoreMaintenance({
        home,
        coordinationHome: home,
        coordinator: {
          stop: async () => ({
            requestId: 'maintenance-stop-without-lock',
            operation: 'stop',
            outcome: 'applied',
            state: 'absent',
            diagnostic: 'not_running',
          }),
          status: async () => ({
            requestId: 'maintenance-status-without-lock',
            operation: 'status',
            outcome: 'applied',
            state: 'absent',
            diagnostic: 'not_running',
          }),
          acquireMaintenanceLock: async () => undefined,
          confirmAbsentWhileLocked: async () => true,
        },
      }).migrate({ targetLayoutGeneration: 'generation-without-lock' });
      expect(result).toEqual({ status: 'blocked', reason: 'maintenance_required' });
      expect(
        readSqliteActiveLayoutPointer(resolveSqliteRuntimeLayoutPaths(data.home)),
      ).toBeUndefined();
    } finally {
      rmSync(data.root, { recursive: true, force: true });
    }
  });

  test('rechecks Coordinator absence under the held lifecycle lock', async () => {
    const data = fixture();
    let released = false;
    try {
      const home = createKiteHomeIdentity(data.home);
      const result = await createLocalRunStoreMaintenance({
        home,
        coordinationHome: home,
        coordinator: {
          stop: async () => ({
            requestId: 'maintenance-stop-before-race',
            operation: 'stop',
            outcome: 'applied',
            state: 'absent',
            diagnostic: 'not_running',
          }),
          status: async () => ({
            requestId: 'maintenance-status-before-race',
            operation: 'status',
            outcome: 'applied',
            state: 'absent',
            diagnostic: 'not_running',
          }),
          acquireMaintenanceLock: async () => ({
            kind: 'lifecycle',
            identity: {
              schema: 'kite.local-coordinator-lock.v1',
              kind: 'lifecycle',
              nonce: 'maintenance-race-lock',
              pid: process.pid,
              instanceId: 'maintenance-race-test',
              startedAt: '2026-08-30T00:00:00.000Z',
              processStartIdentity: 'maintenance-race-start',
              buildId: 'maintenance-race-build',
              operation: 'stop',
              createdAt: '2026-08-30T00:00:00.000Z',
            },
            release: async () => {
              released = true;
            },
          }),
          confirmAbsentWhileLocked: async () => false,
        },
      }).migrate({ targetLayoutGeneration: 'generation-race-target' });
      expect(result).toEqual({ status: 'blocked', reason: 'maintenance_required' });
      expect(released).toBe(true);
      expect(
        readSqliteActiveLayoutPointer(resolveSqliteRuntimeLayoutPaths(data.home)),
      ).toBeUndefined();
    } finally {
      rmSync(data.root, { recursive: true, force: true });
    }
  });
});
