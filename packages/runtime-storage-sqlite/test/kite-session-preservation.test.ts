import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  captureKiteSessionPreservationManifest,
  compareKiteSessionPreservationManifests,
  initializeKiteSessionStoreIfNeeded,
  KITE_SESSION_STORE_TABLE_COLUMNS,
} from '../src';

function fixture(): Database {
  const database = new Database(':memory:');
  initializeKiteSessionStoreIfNeeded(database);
  database
    .query(
      `INSERT INTO workspaces(workspace_id, canonical_path, workspace_identity_digest,
       project_id, workspace_digest, display_name, created_at, updated_at)
       VALUES ('workspace-1', '/fixture', ?, 'project-1', 'digest-1', 'Fixture', 1, 1)`,
    )
    .run(`sha256:${'a'.repeat(64)}`);
  for (const sessionId of ['session-a', 'session-b']) {
    database
      .query(
        `INSERT INTO runtime_sessions(session_id, workspace_id, project_id, workspace_digest,
         state_schema, format_epoch, revision, name, updated_at)
         VALUES (?, 'workspace-1', 'project-1', 'digest-1', 1, 'fixture', 1, '', 1)`,
      )
      .run(sessionId);
  }
  database
    .query(
      `INSERT INTO runtime_events(session_id, event_id, sequence, schema_version, event_json, created_at)
       VALUES ('session-a', 'event-1', 1, 1, ?, 1)`,
    )
    .run(JSON.stringify({ type: 'message', content: 'before' }));
  database
    .query(
      `INSERT INTO runtime_snapshots(session_id, schema_version, format_epoch, revision,
       state_json, event_position, state_checksum, created_at)
       VALUES ('session-a', 1, 'fixture', 1, ?, 1, 'checksum', 1)`,
    )
    .run(JSON.stringify({ revision: 1 }));
  database
    .query(
      `INSERT INTO runtime_runs(session_id, run_id, start_command_id, phase, status,
       created_revision, last_revision, created_at_ms)
       VALUES ('session-a', 'run-1', 'command-1', 'building', 'queued', 1, 1, 1)`,
    )
    .run();
  database
    .query(
      `INSERT INTO runtime_command_receipts(scope_session_id, command_id, workspace_id,
       project_id, workspace_digest, request_digest, target_session_id,
       original_receipt_json, committed_revision, committed_at)
       VALUES ('session-a', 'command-1', 'workspace-1', 'project-1', 'digest-1', ?,
       'session-a', '{}', 1, 1)`,
    )
    .run('b'.repeat(64));
  database
    .query(
      `INSERT INTO runtime_session_tombstones(session_id, workspace_id, project_id,
       workspace_digest, deleted_revision, deleted_at)
       VALUES ('deleted-session', 'workspace-1', 'project-1', 'digest-1', 1, 1)`,
    )
    .run();
  database
    .query(
      `INSERT INTO model_artifacts(artifact_id, kind, integrity_identifier,
       artifact_format_version, canonical_json, byte_length, created_at)
       VALUES (?, 'model_response', ?, 1, ?, ?, 1)`,
    )
    .run(`pa_${'c'.repeat(64)}`, `sha256:${'d'.repeat(64)}`, '{}', 2);
  return database;
}

describe('current Store preservation manifest', () => {
  test('covers every current table and accepts identical content', () => {
    using database = fixture();
    const before = captureKiteSessionPreservationManifest(database);
    const after = captureKiteSessionPreservationManifest(database);
    expect(Object.keys(before.tables).sort()).toEqual(
      Object.keys(KITE_SESSION_STORE_TABLE_COLUMNS).sort(),
    );
    expect(compareKiteSessionPreservationManifests(before, after)).toEqual({
      preserved: true,
      changedTables: [],
    });
  });

  test('rejects a different Session identity with the same row count', () => {
    using database = fixture();
    const before = captureKiteSessionPreservationManifest(database);
    database
      .query("UPDATE runtime_sessions SET session_id = 'session-c' WHERE session_id = 'session-b'")
      .run();
    expect(
      compareKiteSessionPreservationManifests(
        before,
        captureKiteSessionPreservationManifest(database),
      ),
    ).toMatchObject({ preserved: false, changedTables: ['runtime_sessions'] });
  });

  test('rejects changed Event and Artifact content without count changes', () => {
    using database = fixture();
    const before = captureKiteSessionPreservationManifest(database);
    database
      .query('UPDATE runtime_events SET event_json = ? WHERE event_id = ?')
      .run(JSON.stringify({ type: 'message', content: 'after' }), 'event-1');
    database.query('UPDATE model_artifacts SET canonical_json = ?').run('[]');
    const result = compareKiteSessionPreservationManifests(
      before,
      captureKiteSessionPreservationManifest(database),
    );
    expect(result.preserved).toBe(false);
    expect(result.changedTables).toContain('runtime_events');
    expect(result.changedTables).toContain('model_artifacts');
  });

  test('distinguishes adjacent SQLite integers above JavaScript safe integer range', () => {
    using database = fixture();
    database.run('UPDATE runtime_sessions SET updated_at = 9007199254740992');
    const before = captureKiteSessionPreservationManifest(database);
    database.run('UPDATE runtime_sessions SET updated_at = 9007199254740993');
    const after = captureKiteSessionPreservationManifest(database);
    expect(compareKiteSessionPreservationManifests(before, after).changedTables).toContain(
      'runtime_sessions',
    );
  });

  test('refuses unknown schema additions instead of omitting their data', () => {
    using database = fixture();
    database.run('CREATE TABLE unrecognized_user_data (id TEXT PRIMARY KEY) STRICT');
    expect(() => captureKiteSessionPreservationManifest(database)).toThrow('inventory');
  });

  test('detects changes to Workspace, Snapshot, Run, receipt, and tombstone facts', () => {
    const changes = [
      ['workspaces', "UPDATE workspaces SET display_name = 'Changed'"],
      ['runtime_snapshots', 'UPDATE runtime_snapshots SET state_json = \'{"revision":2}\''],
      ['runtime_runs', "UPDATE runtime_runs SET phase = 'planning'"],
      [
        'runtime_command_receipts',
        "UPDATE runtime_command_receipts SET original_receipt_json = '[]'",
      ],
      ['runtime_session_tombstones', 'UPDATE runtime_session_tombstones SET deleted_at = 2'],
    ] as const;
    for (const [table, mutation] of changes) {
      using database = fixture();
      const before = captureKiteSessionPreservationManifest(database);
      database.run(mutation);
      const after = captureKiteSessionPreservationManifest(database);
      expect(compareKiteSessionPreservationManifests(before, after).changedTables).toContain(table);
    }
  });
});
