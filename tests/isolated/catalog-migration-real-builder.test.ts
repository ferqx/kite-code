import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  createSqliteRuntimeStorage,
  ensureSqliteRuntimeLayoutRoot,
  markSqliteCoordinatorCatalogWritten,
  migrateSqliteRuntimeStoreToWorkspaceLayout,
  readSqliteRuntimeLayoutManifest,
  readSqliteRuntimeMigrationJournal,
  resolveSqliteCatalogPath,
  resolveSqliteRuntimeLayoutPaths,
  SQLITE_RUNTIME_FORMAT_EPOCH,
  SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
  SQLITE_RUNTIME_STORE_SCHEMA_VERSION,
  type SqliteRuntimeMigrationSourceGuard,
  sqliteRuntimeStoreDigest,
  sqliteRuntimeStoreFingerprint,
  writeSqliteRuntimeMigrationFence,
} from '@kite-ai/runtime-storage-sqlite';
import { createSqliteRuntimeMigrationCatalogBuilder } from '../../apps/kite-service/src/coordinator/catalog-builder';
import { openCoordinatorCatalog } from '../../packages/kite-local-runtime/src/coordinator';

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

function makeState(sessionId: string): State {
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

describe('real Store migration → Service Catalog builder', () => {
  test('independently verifies Catalog digest, metadata rows, manifest and reopen state', async () => {
    const root = mkdtempSync(join(process.cwd(), '.kite-real-catalog-migration-'));
    const home = join(root, 'home');
    const sourcePath = join(root, 'legacy.db');
    try {
      const layout = resolveSqliteRuntimeLayoutPaths(home);
      ensureSqliteRuntimeLayoutRoot(home);
      const source = createSqliteRuntimeStorage<Event, State>({
        databasePath: sourcePath,
        codec,
        options: { journalMode: 'delete' },
      });
      source.transactions.commitDecision({
        sessionId: 'session-a',
        events: [{ type: 'message', content: 'migration-a' }],
        snapshot: makeState('session-a'),
        metadata: [{ eventId: 'event-a', revision: 1 }],
      });
      source.transactions.commitDecision({
        sessionId: 'session-b',
        events: [{ type: 'message', content: 'migration-b' }],
        snapshot: makeState('session-b'),
        metadata: [{ eventId: 'event-b', revision: 1 }],
      });
      source.close();

      const fence: SqliteRuntimeMigrationSourceGuard = {
        serviceAbsent: true,
        sourceStoreIdentity: sqliteRuntimeStoreFingerprint(sourcePath),
        sourceStoreDigest: sqliteRuntimeStoreDigest(sourcePath),
        fence: {
          schema: 'kite.runtime-migration-fence.v1',
          sourceStoreIdentity: sqliteRuntimeStoreFingerprint(sourcePath),
          sourceStoreDigest: sqliteRuntimeStoreDigest(sourcePath),
          sourceProfile: {
            stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
            storeSchemaVersion: SQLITE_RUNTIME_STORE_SCHEMA_VERSION,
            formatEpoch: SQLITE_RUNTIME_FORMAT_EPOCH,
          },
          targetLayoutGeneration: 'generation-real',
          migrationNonce: 'migration-real-builder-1',
          state: 'active',
        },
      };
      writeSqliteRuntimeMigrationFence(layout, fence.fence);

      const builder = createSqliteRuntimeMigrationCatalogBuilder({
        canonicalKiteHomeRoot: realpathSync.native(home),
      });
      const result = await migrateSqliteRuntimeStoreToWorkspaceLayout({
        sourceStorePath: sourcePath,
        layout,
        targetLayoutGeneration: 'generation-real',
        sourceGuard: fence,
        codec,
        catalogBuilder: builder,
        resolveWorkspaceBinding: ({ projectId, workspaceDigest }) => ({
          layoutGeneration: 'generation-real',
          workerScopeId: 'worker-scope-real',
          workspaceIdentityDigest: 'd'.repeat(64),
          projectId,
          workspaceDigest,
        }),
      });
      expect(result.status).toBe('committed');
      if (result.status !== 'committed') return;

      const catalogPath = resolveSqliteCatalogPath(layout, 'generation-real');
      const independentDigest = sqliteRuntimeStoreDigest(catalogPath);
      expect(result.catalogDigest).toBe(independentDigest);
      expect(readSqliteRuntimeLayoutManifest(layout, 'generation-real')).toMatchObject({
        generation: 'generation-real',
        catalogDigest: independentDigest,
        workspaceStores: [{ workerScopeId: 'worker-scope-real' }],
      });
      expect(result.workspaceStoreDigests).toHaveLength(1);

      const catalog = openCoordinatorCatalog({
        canonicalKiteHomeRoot: realpathSync.native(home),
        layoutGeneration: 'generation-real',
        catalogPath,
        mode: 'open_active',
        beforeWrite: () => undefined,
      });
      expect(catalog.listSessions()).toHaveLength(2);
      expect(catalog.listSessions().map(({ sessionId }) => sessionId)).toEqual([
        'session-a',
        'session-b',
      ]);
      catalog.close();
      expect(sqliteRuntimeStoreDigest(catalogPath)).toBe(independentDigest);
      expect(existsSync(`${catalogPath}-wal`)).toBe(false);
      expect(existsSync(`${catalogPath}-shm`)).toBe(false);

      const activeWriter = openCoordinatorCatalog({
        canonicalKiteHomeRoot: realpathSync.native(home),
        layoutGeneration: 'generation-real',
        catalogPath,
        mode: 'open_active',
        beforeWrite: () =>
          markSqliteCoordinatorCatalogWritten(layout, 'generation-real', catalogPath),
      });
      const session = activeWriter.listSessions()[0]!;
      activeWriter.upsertSession({ ...session, directoryRevision: 'post-switch-1' });
      activeWriter.close();
      expect(readSqliteRuntimeMigrationJournal(layout)?.targetWriteState).toBe('written');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
