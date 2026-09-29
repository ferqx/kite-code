import type { Database } from 'bun:sqlite';
import {
  assertKiteSessionStore14Schema,
  assertKiteSessionStoreSchema,
  assertKiteStoreIntegrity,
  KITE_SESSION_STORE_DDL,
  KITE_SESSION_STORE14_DDL,
  KITE_SESSION_STORE14_TABLE_COLUMNS,
  KITE_SESSION_STORE15_UNBOUNDED_TABLES,
} from './kite-home-store';
import { KITE_SESSION_STORE_FORMAT_EPOCH } from './kite-session-store-format';
import { captureSqliteTableContentDigests } from './sqlite-table-content';

/** Rebuild only the private payload tables in a verified, disposable Store 14 candidate. */
export function convertKiteSessionStore14CandidateTo15(input: {
  readonly database: Database;
  readonly faultBeforeCommit?: () => void;
}): void {
  const database = input.database;
  assertKiteSessionStore14Schema(database);
  assertKiteStoreIntegrity(database);
  for (const table of KITE_SESSION_STORE15_UNBOUNDED_TABLES) {
    const expected = KITE_SESSION_STORE14_DDL.find((sql) =>
      sql.startsWith(`CREATE TABLE ${table} (`),
    );
    const actual = database
      .query<{ sql: string }, [string]>(
        "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?",
      )
      .get(table)?.sql;
    if (!expected || actual !== expected)
      throw new Error(`Store 14 ${table} constraint layout is not the verified source format.`);
  }
  const before = captureSqliteTableContentDigests(database, KITE_SESSION_STORE14_TABLE_COLUMNS);
  // SQLite cannot drop a CHECK constraint in place. Keep the original table name
  // throughout the transaction so existing FK definitions remain identical.
  database.run('PRAGMA foreign_keys = OFF');
  database.run('BEGIN IMMEDIATE');
  try {
    for (const table of KITE_SESSION_STORE15_UNBOUNDED_TABLES) {
      const statement = KITE_SESSION_STORE_DDL.find((sql) =>
        sql.startsWith(`CREATE TABLE ${table} (`),
      );
      if (!statement) throw new Error(`Store 15 table ${table} is missing.`);
      const replacement = `store15_${table}`;
      database.run(statement.replace(`CREATE TABLE ${table} (`, `CREATE TABLE ${replacement} (`));
      const columns = KITE_SESSION_STORE14_TABLE_COLUMNS[table].join(', ');
      database.run(`INSERT INTO ${replacement} (${columns}) SELECT ${columns} FROM ${table}`);
      database.run(`DROP TABLE ${table}`);
      database.run(`ALTER TABLE ${replacement} RENAME TO ${table}`);
    }
    database.query('UPDATE kite_meta SET value=? WHERE key=?').run('15', 'schema_version');
    database
      .query('UPDATE kite_meta SET value=? WHERE key=?')
      .run(KITE_SESSION_STORE_FORMAT_EPOCH, 'format_epoch');
    database.run('PRAGMA user_version = 15');
    const foreignKeyErrors = database.query('PRAGMA foreign_key_check').all();
    if (foreignKeyErrors.length > 0) throw new Error('Store 15 candidate has broken foreign keys.');
    assertKiteSessionStoreSchema(database);
    const after = captureSqliteTableContentDigests(database, KITE_SESSION_STORE14_TABLE_COLUMNS);
    for (const table of Object.keys(KITE_SESSION_STORE14_TABLE_COLUMNS)) {
      if (table !== 'kite_meta' && JSON.stringify(before[table]) !== JSON.stringify(after[table]))
        throw new Error(`Store 14 ${table} rows changed during candidate conversion.`);
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
  } finally {
    database.run('PRAGMA foreign_keys = ON');
  }
  assertKiteSessionStoreSchema(database);
  assertKiteStoreIntegrity(database);
}
