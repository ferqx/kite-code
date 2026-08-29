import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureSqliteRuntimeGenerationRoot,
  ensureSqliteRuntimeLayoutRoot,
  ensureSqliteWorkspaceStoreDirectory,
  SQLITE_RUNTIME_FORMAT_EPOCH,
  SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
  SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
  SQLITE_RUNTIME_WORKSPACE_STORE_SCHEMA_VERSION,
  writeSqliteActiveLayoutPointer,
  writeSqliteRuntimeLayoutManifest,
  writeSqliteRuntimeMigrationFence,
  writeSqliteRuntimeMigrationJournal,
} from '@kite-ai/runtime-storage-sqlite';
import { initializeSqliteRuntimeSchema } from '../../../../packages/runtime-storage-sqlite/src/schema';
import { createOfflineWebHistoryPort } from '../../src/web-gateway/offline-history';

describe('offline Web History', () => {
  test('reads one active Store 7 snapshot without changing the source or importing legacy data', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-offline-web-history-')));
    const home = join(root, 'home');
    const layout = ensureSqliteRuntimeLayoutRoot(home);
    const binding = {
      layoutGeneration: 'generation-offline-history',
      workerScopeId: 'scope-offline-history',
      workspaceIdentityDigest: `sha256:${'e'.repeat(64)}`,
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
          'INSERT INTO runtime_sessions (session_id, project_id, workspace_digest, worker_scope_id, workspace_identity_digest, state_schema, format_epoch, revision, name, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          'session-offline-history',
          'project-offline-history',
          `sha256:${'f'.repeat(64)}`,
          binding.workerScopeId,
          binding.workspaceIdentityDigest,
          SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
          SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
          1,
          'Offline History',
          1,
        );
      database
        .query(
          'INSERT INTO runtime_events (session_id, event_id, sequence, schema_version, event_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(
          'session-offline-history',
          'event-offline-history',
          1,
          SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
          JSON.stringify({
            type: 'user.message_appended',
            messageId: 'message-offline-history',
            content: 'Loaded while the Workspace Worker is idle.',
          }),
          1,
        );
      database.close();
      chmodSync(databasePath, 0o600);

      const storeEntry = { workerScopeId: binding.workerScopeId, digest: 'c'.repeat(64) };
      const sourceProfile = {
        stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
        storeSchemaVersion: 6,
        formatEpoch: SQLITE_RUNTIME_FORMAT_EPOCH,
      } as const;
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
        sourceStoreIdentity: 'offline-history-source',
        sourceStoreDigest: 'a'.repeat(64),
        sourceProfile,
        targetLayoutGeneration: binding.layoutGeneration,
        migrationNonce: 'offline-history-nonce',
        state: 'active',
      });
      writeSqliteRuntimeMigrationJournal(layout, {
        schema: 'kite.runtime-migration-journal.v1',
        sourceStoreIdentity: 'offline-history-source',
        sourceStoreDigest: 'a'.repeat(64),
        sourceProfile,
        targetLayoutGeneration: binding.layoutGeneration,
        targetCatalogDigest: 'd'.repeat(64),
        workspaceStoreDigests: [storeEntry],
        pointerPhase: 'committed',
        targetWriteState: 'written',
        migrationNonce: 'offline-history-nonce',
      });
      writeSqliteActiveLayoutPointer(layout, {
        schema: 'kite.runtime-active-layout.v1',
        generation: binding.layoutGeneration,
      });

      const digestBefore = createHash('sha256').update(readFileSync(databasePath)).digest('hex');
      const filesBefore = readdirSync(join(databasePath, '..')).sort();
      const port = createOfflineWebHistoryPort(home);
      await expect(
        port.loadSession({
          workerScopeId: binding.workerScopeId,
          sessionId: 'session-offline-history',
        }),
      ).resolves.toEqual({
        sessionId: 'session-offline-history',
        lastSequence: 1,
        records: [
          {
            sequence: 1,
            events: [
              {
                type: 'user.message',
                messageId: 'message-offline-history',
                kind: 'task',
                text: 'Loaded while the Workspace Worker is idle.',
              },
            ],
          },
        ],
      });
      await expect(
        port.loadSession({
          workerScopeId: 'scope-wrong-history',
          sessionId: 'session-offline-history',
        }),
      ).rejects.toThrow();
      expect(createHash('sha256').update(readFileSync(databasePath)).digest('hex')).toBe(
        digestBefore,
      );
      expect(readdirSync(join(databasePath, '..')).sort()).toEqual(filesBefore);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
