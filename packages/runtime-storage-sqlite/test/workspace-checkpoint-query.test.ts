import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  createSqliteWorkspaceCheckpointQuery,
  SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
  SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
  SQLITE_RUNTIME_WORKSPACE_STORE_SCHEMA_VERSION,
} from '../src';
import { initializeSqliteRuntimeSchema } from '../src/schema';

const binding = {
  layoutGeneration: 'generation-checkpoint-query',
  workerScopeId: 'worker-checkpoint-query',
  workspaceIdentityDigest: `sha256:${'c'.repeat(64)}`,
} as const;

function checksum(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

describe('Store 7 bounded Checkpoint metadata query', () => {
  test('uses an advancing revision keyset and rejects a corrupt selected snapshot', () => {
    const database = new Database(':memory:');
    try {
      initializeSqliteRuntimeSchema(database, {
        stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
        storeSchemaVersion: SQLITE_RUNTIME_WORKSPACE_STORE_SCHEMA_VERSION,
        formatEpoch: SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
        workspaceBinding: binding,
      });
      const insert = database.query(
        `INSERT INTO runtime_named_snapshots
           (session_id, name, schema_version, format_epoch, revision, state_json,
            event_position, state_checksum, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (let revision = 1; revision <= 3; revision += 1) {
        const state = JSON.stringify({ revision });
        insert.run(
          'session-checkpoints',
          `checkpoint-${revision}`,
          SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
          SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
          revision,
          state,
          revision * 10,
          checksum(state),
          1_777_680_000 + revision,
        );
      }
      const query = createSqliteWorkspaceCheckpointQuery({ db: database, binding });
      const first = query.list({ sessionId: 'session-checkpoints', limit: 2 });
      expect(first).toMatchObject({
        entries: [
          { checkpointId: 'checkpoint-1', revision: 1 },
          { checkpointId: 'checkpoint-2', revision: 2 },
        ],
        nextCursor: { revision: 2, checkpointId: 'checkpoint-2' },
        hasMore: true,
      });
      expect(
        query.list({
          sessionId: 'session-checkpoints',
          cursor: first.nextCursor,
          limit: 2,
        }),
      ).toMatchObject({
        entries: [{ checkpointId: 'checkpoint-3', revision: 3 }],
        hasMore: false,
      });

      database
        .query(
          'UPDATE runtime_named_snapshots SET state_checksum = ? WHERE session_id = ? AND name = ?',
        )
        .run('corrupt', 'session-checkpoints', 'checkpoint-3');
      expect(() =>
        query.list({
          sessionId: 'session-checkpoints',
          cursor: first.nextCursor,
          limit: 2,
        }),
      ).toThrow('snapshot is unavailable');
      expect(() => query.list({ sessionId: 'session-checkpoints', limit: 201 })).toThrow(
        'page limit',
      );
    } finally {
      database.close();
    }
  });
});
