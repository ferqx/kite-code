import type { Database } from 'bun:sqlite';
import {
  KITE_HISTORY_GENERATION_TRIGGER_NAMES,
  KITE_HISTORY_REVISION_TRIGGERS,
} from './kite-history-generation';
import {
  assertKiteSessionStore15Schema,
  assertKiteSessionStoreSchema,
  assertKiteStoreIntegrity,
  KITE_RESOURCE_RESERVATION_RECEIPT_DDL,
  KITE_RESOURCE_RESERVATION_RECEIPT_INDEXES,
  KITE_SESSION_STORE15_TABLE_COLUMNS,
} from './kite-home-store';
import { KITE_SESSION_STORE_FORMAT_EPOCH } from './kite-session-store-format';
import { captureSqliteTableContentDigests } from './sqlite-table-content';

/** Convert a private, verified candidate; never alter an admitted source in place. */
export function convertKiteSessionStore15CandidateTo16(input: {
  readonly database: Database;
  readonly faultBeforeCommit?: () => void;
}): void {
  const database = input.database;
  assertKiteSessionStore15Schema(database);
  assertKiteStoreIntegrity(database);
  const before = captureSqliteTableContentDigests(database, KITE_SESSION_STORE15_TABLE_COLUMNS);
  database.run('BEGIN IMMEDIATE');
  try {
    database.run(
      'ALTER TABLE runtime_sessions ADD COLUMN history_rewrite_generation INTEGER NOT NULL DEFAULT 0 CHECK (history_rewrite_generation >= 0)',
    );
    database.run(
      'ALTER TABLE runtime_sessions ADD COLUMN history_append_sequence INTEGER NOT NULL DEFAULT 0 CHECK (history_append_sequence >= 0)',
    );
    database.run(
      "ALTER TABLE runtime_sessions ADD COLUMN history_instance_id TEXT NOT NULL DEFAULT ''",
    );
    database.run(`UPDATE runtime_sessions SET history_append_sequence = COALESCE(
      (SELECT MAX(sequence) FROM runtime_events WHERE session_id = runtime_sessions.session_id), 0),
      history_instance_id = lower(hex(randomblob(16)))`);
    for (const name of KITE_HISTORY_GENERATION_TRIGGER_NAMES) database.run(`DROP TRIGGER ${name}`);
    for (const sql of KITE_HISTORY_REVISION_TRIGGERS) database.run(sql);
    database.run(KITE_RESOURCE_RESERVATION_RECEIPT_DDL);
    for (const sql of KITE_RESOURCE_RESERVATION_RECEIPT_INDEXES) database.run(sql);
    database.query('UPDATE kite_meta SET value=? WHERE key=?').run('16', 'schema_version');
    database
      .query('UPDATE kite_meta SET value=? WHERE key=?')
      .run(KITE_SESSION_STORE_FORMAT_EPOCH, 'format_epoch');
    database.run('PRAGMA user_version = 16');
    assertKiteSessionStoreSchema(database);
    assertKiteStoreIntegrity(database);
    const after = captureSqliteTableContentDigests(database, KITE_SESSION_STORE15_TABLE_COLUMNS);
    for (const table of Object.keys(KITE_SESSION_STORE15_TABLE_COLUMNS)) {
      if (table !== 'kite_meta' && JSON.stringify(before[table]) !== JSON.stringify(after[table]))
        throw new Error(`Store 15 ${table} rows changed during candidate conversion.`);
    }
    input.faultBeforeCommit?.();
    database.run('COMMIT');
  } catch (error) {
    try {
      database.run('ROLLBACK');
    } catch {
      /* SQLite may already have rolled back. */
    }
    throw error;
  }
  assertKiteSessionStoreSchema(database);
}
