import type { Database } from 'bun:sqlite';
import { KITE_HISTORY_GENERATION_TRIGGERS } from './kite-history-generation';
import {
  assertKiteSessionStore13Schema,
  assertKiteSessionStoreSchema,
  assertKiteStoreIntegrity,
  KITE_SESSION_STORE13_TABLE_COLUMNS,
} from './kite-home-store';
import { createKiteHomeWriteTransactionPort } from './kite-home-write';
import {
  createKiteSessionExecutionAuthority,
  KITE_SESSION_EXECUTION_AUTHORITY_SCHEMA,
  type KiteSessionExecutionAuthorityRecord,
} from './kite-session-execution-authority';
import { KITE_SESSION_STORE_FORMAT_EPOCH } from './kite-session-store-format';
import { captureSqliteTableContentDigests } from './sqlite-table-content';

/** Convert only a verified private Store 13 candidate; the source remains untouched. */
export function convertKiteSessionStore13CandidateTo14(input: {
  readonly database: Database;
  readonly faultBeforeCommit?: () => void;
}): void {
  const database = input.database;
  assertKiteSessionStore13Schema(database);
  assertKiteStoreIntegrity(database);
  const before = captureSqliteTableContentDigests(database, KITE_SESSION_STORE13_TABLE_COLUMNS);
  // The caller holds exclusive maintenance and has excluded old writers. Validate every
  // persisted authority with its normal parser before changing only this private candidate.
  const authority = createKiteSessionExecutionAuthority({
    database,
    writer: createKiteHomeWriteTransactionPort(database, assertKiteSessionStore13Schema),
    assertStoreSchema: () => {},
  });
  const oldOwners: Array<{
    key: string;
    value: string;
    record: KiteSessionExecutionAuthorityRecord;
  }> = [];
  for (const row of database
    .query<{ key: string; value: string }, []>(
      "SELECT key,value FROM kite_meta WHERE key GLOB 'session_execution/*' ORDER BY key",
    )
    .all()) {
    const record = authority.read(row.key.slice('session_execution/'.length));
    if (record.status === 'active' || record.status === 'detached')
      oldOwners.push({ key: row.key, value: row.value, record });
  }
  database.run('BEGIN IMMEDIATE');
  try {
    for (const { key, value, record } of oldOwners) {
      if (
        record.controllerGeneration === Number.MAX_SAFE_INTEGER ||
        record.revision === Number.MAX_SAFE_INTEGER
      )
        throw new Error('Store 13 execution authority cannot be safely fenced.');
      const fenced = {
        ...record,
        schema: KITE_SESSION_EXECUTION_AUTHORITY_SCHEMA,
        status: 'recovery_required',
        controllerGeneration: record.controllerGeneration + 1,
        hostInstanceId: null,
        clientId: null,
        connectionGeneration: 0,
        leaseUntilMs: null,
        cleanupConfirmed: false,
        updatedAt: Math.max(Date.now(), record.updatedAt),
        revision: record.revision + 1,
      };
      const changed = database
        .query('UPDATE kite_meta SET value=? WHERE key=? AND value=?')
        .run(JSON.stringify(fenced), key, value);
      if (changed.changes !== 1)
        throw new Error('Store 13 execution authority changed during candidate conversion.');
    }
    database.run(
      'ALTER TABLE runtime_sessions ADD COLUMN history_generation INTEGER NOT NULL DEFAULT 0 CHECK (history_generation >= 0)',
    );
    for (const statement of KITE_HISTORY_GENERATION_TRIGGERS) database.run(statement);
    database.query('UPDATE kite_meta SET value=? WHERE key=?').run('14', 'schema_version');
    database
      .query('UPDATE kite_meta SET value=? WHERE key=?')
      .run(KITE_SESSION_STORE_FORMAT_EPOCH, 'format_epoch');
    database.run('PRAGMA user_version = 14');
    assertKiteSessionStoreSchema(database);
    assertKiteStoreIntegrity(database);
    const after = captureSqliteTableContentDigests(database, KITE_SESSION_STORE13_TABLE_COLUMNS);
    for (const table of Object.keys(KITE_SESSION_STORE13_TABLE_COLUMNS)) {
      if (table !== 'kite_meta' && JSON.stringify(before[table]) !== JSON.stringify(after[table]))
        throw new Error('Store 13 rows changed while converting the private Store 14 candidate.');
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
  assertKiteStoreIntegrity(database);
}
