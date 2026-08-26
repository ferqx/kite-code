import type { Database } from 'bun:sqlite';
import { SqliteRuntimeFormatMismatchError } from './preflight';

export interface SqliteRuntimeFormatProfile {
  readonly stateSchemaVersion: number;
  readonly storeSchemaVersion: number;
  readonly formatEpoch: string;
}

/** Initialize and verify the one current Runtime Store schema atomically. */
export function initializeSqliteRuntimeSchema(
  db: Database,
  profile: SqliteRuntimeFormatProfile,
): void {
  db.run('BEGIN IMMEDIATE');
  try {
    db.run(
      `CREATE TABLE IF NOT EXISTS runtime_store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    );
    db.run(`CREATE TABLE IF NOT EXISTS runtime_events (
        session_id TEXT NOT NULL, event_id TEXT NOT NULL, sequence INTEGER NOT NULL,
        schema_version INTEGER NOT NULL, event_json TEXT NOT NULL,
        causation_id TEXT, occurred_at TEXT, created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, event_id), UNIQUE (session_id, sequence))`);
    db.run(`CREATE TABLE IF NOT EXISTS runtime_sessions (
        session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace_digest TEXT NOT NULL,
        state_schema INTEGER NOT NULL, format_epoch TEXT NOT NULL, revision INTEGER NOT NULL,
        name TEXT NOT NULL DEFAULT '', model_provider TEXT, model_name TEXT,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()))`);
    db.run(`CREATE TABLE IF NOT EXISTS runtime_snapshots (
        session_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, format_epoch TEXT NOT NULL,
        revision INTEGER NOT NULL, state_json TEXT NOT NULL, event_position INTEGER NOT NULL DEFAULT 0,
        state_checksum TEXT NOT NULL DEFAULT '', created_at INTEGER DEFAULT (unixepoch()))`);
    db.run(`CREATE TABLE IF NOT EXISTS runtime_named_snapshots (
        session_id TEXT NOT NULL, name TEXT NOT NULL, schema_version INTEGER NOT NULL,
        format_epoch TEXT NOT NULL, revision INTEGER NOT NULL, state_json TEXT NOT NULL,
        event_position INTEGER NOT NULL DEFAULT 0, state_checksum TEXT NOT NULL,
        created_at INTEGER DEFAULT (unixepoch()), PRIMARY KEY (session_id, name))`);
    db.run(`CREATE TABLE IF NOT EXISTS runtime_file_preimages (
        session_id TEXT NOT NULL, path TEXT NOT NULL, event_position INTEGER NOT NULL DEFAULT 0,
        content TEXT, existed INTEGER NOT NULL DEFAULT 1, post_hash TEXT, post_existed INTEGER,
        created_at INTEGER DEFAULT (unixepoch()), PRIMARY KEY (session_id, path, event_position))`);
    db.run(`CREATE TABLE IF NOT EXISTS runtime_effect_leases (
        session_id TEXT NOT NULL, effect_id TEXT NOT NULL, owner_id TEXT NOT NULL,
        lease_revision INTEGER NOT NULL DEFAULT 0, certainty TEXT NOT NULL DEFAULT 'certain',
        expires_at_ms INTEGER NOT NULL, PRIMARY KEY (session_id, effect_id))`);
    db.run(`CREATE TABLE IF NOT EXISTS runtime_command_receipts (
        scope_session_id TEXT NOT NULL, command_id TEXT NOT NULL,
        request_digest TEXT NOT NULL, target_session_id TEXT NOT NULL,
        original_receipt_json TEXT NOT NULL, committed_revision INTEGER NOT NULL,
        committed_at INTEGER NOT NULL, PRIMARY KEY (scope_session_id, command_id))`);
    db.run(
      'CREATE INDEX IF NOT EXISTS runtime_events_session_sequence ON runtime_events(session_id, sequence)',
    );
    db.run(
      'CREATE INDEX IF NOT EXISTS runtime_file_preimages_position ON runtime_file_preimages(session_id, event_position)',
    );
    db.run("INSERT OR IGNORE INTO runtime_store_meta (key, value) VALUES ('format_version', ?)", [
      String(profile.storeSchemaVersion),
    ]);
    db.run(
      "INSERT OR IGNORE INTO runtime_store_meta (key, value) VALUES ('runtime_format_epoch', ?)",
      [profile.formatEpoch],
    );
    const marker = db
      .query<{ value: string }, []>(
        "SELECT value FROM runtime_store_meta WHERE key = 'format_version'",
      )
      .get();
    const epoch = db
      .query<{ value: string }, []>(
        "SELECT value FROM runtime_store_meta WHERE key = 'runtime_format_epoch'",
      )
      .get();
    if (
      !marker ||
      Number(marker.value) !== profile.storeSchemaVersion ||
      !epoch ||
      epoch.value !== profile.formatEpoch
    ) {
      throw new SqliteRuntimeFormatMismatchError(
        Number(marker?.value) || null,
        epoch?.value ?? null,
      );
    }
    db.run('COMMIT');
  } catch (error) {
    try {
      db.run('ROLLBACK');
    } catch {
      // BEGIN may have failed.
    }
    throw error;
  }
}
