import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  assertKiteHomeStoreSchema,
  initializeKiteHomeStoreSchema,
  KITE_HOME_STORE_FORMAT_EPOCH,
  KITE_HOME_STORE_SCHEMA_VERSION,
  KITE_HOME_STORE_TABLE_COLUMNS,
  KiteHomeStoreSchemaError,
} from '../src';

function database(): Database {
  return new Database(':memory:', { strict: true });
}

function digest(character: string): string {
  return character.repeat(64);
}

function artifactId(character: string): string {
  return `pa_${digest(character)}`;
}

function integrityIdentifier(character: string): string {
  return `sha256:${digest(character)}`;
}

describe('single Kite Home Store target', () => {
  test('creates only the exact Store 9 table inventory', () => {
    const db = database();
    try {
      initializeKiteHomeStoreSchema(db);
      const tables = db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all()
        .map((row) => row.name);
      expect(tables).toEqual(Object.keys(KITE_HOME_STORE_TABLE_COLUMNS).sort());
      expect(tables).not.toContain('runtime_artifacts');
      expect(tables).not.toContain('session_directory_outbox');
      expect(tables).not.toContain('coordinator_session_metadata');
      expect(
        db
          .query<{ value: string }, [string]>('SELECT value FROM kite_meta WHERE key = ?')
          .get('format_epoch')?.value,
      ).toBe(KITE_HOME_STORE_FORMAT_EPOCH);
      expect(
        db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version,
      ).toBe(KITE_HOME_STORE_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  test('binds Session facts and retained receipts to one Workspace', () => {
    const db = database();
    try {
      initializeKiteHomeStoreSchema(db);
      db.query(
        `INSERT INTO workspaces(
          workspace_id, canonical_path, workspace_identity_digest, project_id,
          workspace_digest, display_name, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'workspace-1',
        '/workspace/one',
        integrityIdentifier('a'),
        'project-1',
        'workspace-digest-1',
        'One',
        1,
        1,
      );
      db.query(
        `INSERT INTO runtime_sessions(
          session_id, workspace_id, project_id, workspace_digest, state_schema, format_epoch,
          revision, name, updated_at, run_index_from_revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'session-1',
        'workspace-1',
        'project-1',
        'workspace-digest-1',
        27,
        KITE_HOME_STORE_FORMAT_EPOCH,
        1,
        'Session',
        1,
        0,
      );
      db.query(
        `INSERT INTO runtime_events(
          session_id, event_id, sequence, schema_version, event_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('session-1', 'event-1', 1, 27, '{"type":"session.created"}', 1);
      db.query(
        `INSERT INTO runtime_command_receipts(
          scope_session_id, command_id, workspace_id, project_id, workspace_digest,
          request_digest, target_session_id, original_receipt_json, committed_revision, committed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'session-1',
        'command-1',
        'workspace-1',
        'project-1',
        'workspace-digest-1',
        digest('b'),
        'session-1',
        '{"status":"applied"}',
        1,
        1,
      );
      db.query('DELETE FROM runtime_sessions WHERE session_id = ?').run('session-1');
      expect(
        db.query<{ count: number }, []>('SELECT count(*) AS count FROM runtime_events').get()
          ?.count,
      ).toBe(0);
      expect(
        db
          .query<{ count: number }, []>('SELECT count(*) AS count FROM runtime_command_receipts')
          .get()?.count,
      ).toBe(1);
      expect(() =>
        db
          .query(
            `INSERT INTO runtime_sessions(
              session_id, workspace_id, project_id, workspace_digest, state_schema, format_epoch,
              revision, name, updated_at, run_index_from_revision
            ) VALUES ('session-2', 'missing', 'project', 'workspace', 27, 'epoch', 0, '', 0, 0)`,
          )
          .run(),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  test('keeps Artifact domains in separate bounded tables', () => {
    const db = database();
    try {
      initializeKiteHomeStoreSchema(db);
      db.query(
        `INSERT INTO model_artifacts(
          artifact_id, kind, integrity_identifier, artifact_format_version,
          canonical_json, byte_length, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        artifactId('c'),
        'model_response',
        integrityIdentifier('c'),
        1,
        '{"response":"ok"}',
        17,
        1,
      );
      db.query(
        `INSERT INTO subagent_lifecycle_artifacts(
          artifact_id, integrity_identifier, artifact_format_version,
          canonical_json, byte_length, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        artifactId('d'),
        integrityIdentifier('d'),
        1,
        '{"artifactFormatVersion":1,"handle":{}}',
        39,
        1,
      );
      expect(() =>
        db
          .query(
            `INSERT INTO model_artifacts(
              artifact_id, kind, integrity_identifier, artifact_format_version,
              canonical_json, byte_length, created_at
            ) VALUES (?, 'unknown', ?, 1, '{}', 2, 1)`,
          )
          .run(artifactId('e'), integrityIdentifier('e')),
      ).toThrow();
      expect(() =>
        db
          .query(
            `INSERT INTO sandbox_preparation_artifacts(
              artifact_id, integrity_identifier, preparation_digest,
              artifact_format_version, canonical_json, byte_length, expires_at_ms, created_at
            ) VALUES (?, ?, 'preparation', 1, '{}', 2097153, 1, 1)`,
          )
          .run(artifactId('f'), integrityIdentifier('f')),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  test('preserves the canonical Run lifecycle checks in Store 9 DDL', () => {
    const db = database();
    try {
      initializeKiteHomeStoreSchema(db);
      db.query(
        `INSERT INTO workspaces(
          workspace_id, canonical_path, workspace_identity_digest, project_id,
          workspace_digest, display_name, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, '', 1, 1)`,
      ).run(
        'workspace-1',
        '/workspace/one',
        integrityIdentifier('a'),
        'project-1',
        'workspace-digest-1',
      );
      db.query(
        `INSERT INTO runtime_sessions(
          session_id, workspace_id, project_id, workspace_digest, state_schema, format_epoch,
          revision, name, updated_at, run_index_from_revision
        ) VALUES ('session-1', 'workspace-1', 'project-1', 'workspace-digest-1',
          27, 'epoch', 1, '', 1, 0)`,
      ).run();
      expect(() =>
        db
          .query(
            `INSERT INTO runtime_runs(
            session_id, run_id, start_command_id, phase, status, created_revision,
            last_revision, created_at_ms, started_at_ms
          ) VALUES ('session-1', 'run-1', 'command-1', 'building', 'queued', 1, 1, 1, 1)`,
          )
          .run(),
      ).toThrow();
      expect(() =>
        db
          .query(
            `INSERT INTO runtime_runs(
            session_id, run_id, start_command_id, phase, status, created_revision,
            last_revision, created_at_ms, started_at_ms, finished_at_ms
          ) VALUES ('session-1', 'run-2', 'command-2', 'building', 'failed', 1, 1, 1, 1, 2)`,
          )
          .run(),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  test('rejects unknown tables and metadata drift during preflight', () => {
    const db = database();
    try {
      initializeKiteHomeStoreSchema(db);
      db.run('CREATE TABLE unexpected_state (value TEXT) STRICT');
      expect(() => assertKiteHomeStoreSchema(db)).toThrow(KiteHomeStoreSchemaError);
      db.run('DROP TABLE unexpected_state');
      db.query("UPDATE kite_meta SET value = 'other' WHERE key = 'format_epoch'").run();
      expect(() => assertKiteHomeStoreSchema(db)).toThrow(
        'Kite Home Store metadata is incompatible.',
      );
    } finally {
      db.close();
    }
  });

  test('rolls back a partial initialization failure', () => {
    const db = database();
    try {
      db.run('CREATE TABLE workspaces (workspace_id TEXT PRIMARY KEY) STRICT');
      expect(() => initializeKiteHomeStoreSchema(db)).toThrow();
      const tables = db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all()
        .map((row) => row.name);
      expect(tables).toEqual(['workspaces']);
    } finally {
      db.close();
    }
  });
});
